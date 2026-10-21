import type { ApiEndpoint } from './settings';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function endpointUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl.trim());
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  return url.toString();
}

function parseJsonObject(raw: string, error: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(error);
  return parsed as Record<string, unknown>;
}

export function parseExtraHeaders(raw: string): Record<string, string> {
  const parsed = parseJsonObject(raw, 'Extra headers must be a JSON object, e.g. {"api-key": "..."}');
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
}

/** Provider-specific request fields, e.g. {"max_tokens": 512}. */
export function parseExtraBody(raw: string): Record<string, unknown> {
  return parseJsonObject(raw, 'Extra body parameters must be a JSON object, e.g. {"max_tokens": 512}');
}

export function authHeaders(ep: ApiEndpoint): Record<string, string> {
  const headers: Record<string, string> = {};
  if (ep.apiKey.trim()) headers.Authorization = `Bearer ${ep.apiKey.trim()}`;
  return { ...headers, ...parseExtraHeaders(ep.extraHeaders) };
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const data = JSON.parse(text);
    const msg = data?.error?.message ?? data?.error ?? data?.message ?? data?.detail;
    if (msg) return `${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
  } catch {
    // not JSON
  }
  return `${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with a timeout and retries on rate limits, server errors and network failures. */
export async function request(url: string, init: () => RequestInit, timeoutMs: number, attempts = 4): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init(), signal: controller.signal });
      if (res.ok) return res;
      const message = await errorMessage(res);
      if (!RETRYABLE.has(res.status) || attempt === attempts - 1) throw new ApiError(message, res.status);
      lastError = new ApiError(message, res.status);
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 2000 * 2 ** attempt);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const aborted = controller.signal.aborted;
      lastError = new ApiError(
        aborted
          ? `Request timed out after ${Math.round(timeoutMs / 1000)} s`
          : `Network error: ${(err as Error).message}. Check the base URL and that the host permission was granted.`,
      );
      if (attempt === attempts - 1) throw lastError;
      await sleep(2000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export interface TranscriptionResult {
  text: string;
  segments?: { start: number; end: number; text: string; speaker?: string }[];
}

/** Picks the richest response format the model supports. */
export function transcriptionFormat(model: string): 'verbose_json' | 'diarized_json' | 'json' {
  const m = model.toLowerCase();
  if (m.includes('diarize')) return 'diarized_json';
  if (m.includes('whisper')) return 'verbose_json';
  return 'json';
}

/** POST {baseUrl}/audio/transcriptions (OpenAI-compatible). */
export async function transcribe(
  ep: ApiEndpoint,
  audio: Blob,
  opts: { language?: string; prompt?: string; filename?: string } = {},
): Promise<TranscriptionResult> {
  const format = transcriptionFormat(ep.model);
  const res = await request(
    endpointUrl(ep.baseUrl, '/audio/transcriptions'),
    () => {
      const form = new FormData();
      form.append('file', audio, opts.filename ?? 'audio.webm');
      form.append('model', ep.model.trim());
      form.append('response_format', format);
      if (format === 'verbose_json') form.append('timestamp_granularities[]', 'segment');
      if (format === 'diarized_json') form.append('chunking_strategy', 'auto');
      if (opts.language?.trim()) form.append('language', opts.language.trim());
      if (opts.prompt?.trim() && format !== 'diarized_json') form.append('prompt', opts.prompt.trim());
      return { method: 'POST', headers: authHeaders(ep), body: form };
    },
    // Self-hosted CPU servers can take about as long as the audio itself; 15 min is also a common proxy limit.
    15 * 60_000,
  );
  const data = (await res.json()) as {
    text?: string;
    segments?: { start?: number; end?: number; text?: string; speaker?: string }[];
  };
  const segments = Array.isArray(data.segments)
    ? data.segments
        .filter((s) => typeof s?.text === 'string' && s.text.trim())
        .map((s) => ({
          start: Number(s.start) || 0,
          end: Number(s.end) || Number(s.start) || 0,
          text: s.text!.trim(),
          speaker: s.speaker ? String(s.speaker) : undefined,
        }))
    : undefined;
  return { text: (data.text ?? segments?.map((s) => s.text).join(' ') ?? '').trim(), segments };
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** A string, or text and image parts for vision models. */
  content: string | ContentPart[];
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

/** POST {baseUrl}/chat/completions (OpenAI-compatible). Returns the reply text. */
export async function chat(
  ep: ApiEndpoint,
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: string; extraBody?: string } = {},
): Promise<string> {
  const extra = parseExtraBody(opts.extraBody ?? '');
  const send = (json: boolean) =>
    request(
      endpointUrl(ep.baseUrl, '/chat/completions'),
      () => {
        const body: Record<string, unknown> = { ...extra, model: ep.model.trim(), messages };
        if (json) body.response_format = { type: 'json_object' };
        const temperature = Number.parseFloat(opts.temperature ?? '');
        if (Number.isFinite(temperature)) body.temperature = temperature;
        return {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(ep) },
          body: JSON.stringify(body),
        };
      },
      10 * 60_000,
    );

  let res: Response;
  try {
    res = await send(Boolean(opts.json));
  } catch (err) {
    // Some OpenAI-compatible servers reject response_format; the prompt still asks for JSON.
    if (opts.json && err instanceof ApiError && err.status === 400 && /response_format|json/i.test(err.message)) {
      res = await send(false);
    } else {
      throw err;
    }
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | { type?: string; text?: string }[] }; finish_reason?: string }[];
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  const text = Array.isArray(content) ? content.map((c) => c.text ?? '').join('') : (content ?? '');
  if (!text.trim())
    throw new ApiError(`The model returned an empty reply (finish_reason: ${choice?.finish_reason ?? 'unknown'})`);
  return text;
}

/** Extracts the first JSON object from a model reply (tolerates ``` fences and prose). */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1] ?? '');
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new ApiError('The model did not return valid JSON');
}

/** One-second silent WAV, used to test the transcription endpoint. */
export function silentWav(seconds = 1, sampleRate = 16000): Blob {
  const samples = seconds * sampleRate;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples * 2, true);
  return new Blob([buf], { type: 'audio/wav' });
}
