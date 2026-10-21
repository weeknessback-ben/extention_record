// Meeting processing server: receives audio segments and screenshots from the extension, runs the
// shared pipeline (lib/pipeline-core.ts) and sends the minutes to Telegram. See server/README.md.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { setUiLanguage } from '@/lib/i18n';
import type { ProcessMode } from '@/lib/pipeline-core';
import { TEMPLATES } from '@/lib/prompts';
import type {
  EndpointHealth,
  MeetingInput,
  MeetingOptions,
  MeetingResult,
  MeetingStatus,
  ProcessRequest,
  ServerHealth,
  TelegramChats,
} from '@/lib/server-api';
import { endpointReady, isTelegramChatId, summaryEndpoint, type ApiEndpoint } from '@/lib/settings';
import type { Platform, TemplateId } from '@/lib/types';
import { Bot } from './bot';
import { loadConfig } from './config';
import { allowSlowResponses } from './http';
import { isProcessing, log, Processor } from './process';
import { isMeetingId, MeetingStore, type Meeting } from './store';
import { chatTitle, Telegram } from './telegram';

const MB = 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

allowSlowResponses();
const config = loadConfig();
setUiLanguage(config.uiLanguage);
const store = new MeetingStore(config.dataDir);
await store.init();
const telegram = new Telegram(config.telegram);
const processor = new Processor(store, config, telegram);
processor.resume();
// Answers /notulen and the buttons of the minutes cards (long polling, see bot.ts).
const bot = telegram.enabled ? new Bot(store, telegram, path.join(config.dataDir, 'telegram-chats.json')) : undefined;
void bot?.start();

const keyHashes = config.apiKeys.map((k) => createHash('sha256').update(k).digest());

/** Returns the owner id (a hash of the API key) or throws 401. */
function authenticate(req: IncomingMessage): string {
  if (!keyHashes.length) throw new HttpError(503, 'API_KEYS is not set on the server');
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const key = (req.headers['x-api-key'] as string | undefined) ?? bearer ?? '';
  const hash = createHash('sha256').update(key.trim()).digest();
  if (!keyHashes.some((h) => timingSafeEqual(h, hash))) throw new HttpError(401, 'Invalid or missing API key');
  return hash.toString('hex').slice(0, 16);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `Request body larger than ${Math.round(limit / MB)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const data = JSON.parse((await readBody(req, MB)).toString('utf8')) as unknown;
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
  }
  throw new HttpError(400, 'Expected a JSON object');
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

const str = (v: unknown, max = 20_000) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v: unknown, name: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `Invalid ${name}`);
  return Math.round(n);
};
const template = (v: unknown): TemplateId | undefined =>
  typeof v === 'string' && v in TEMPLATES ? (v as TemplateId) : undefined;

function meetingOptions(raw: unknown): MeetingOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const telegramChatId = str(o.telegramChatId, 64).trim();
  if (telegramChatId && !isTelegramChatId(telegramChatId))
    throw new HttpError(400, `Invalid Telegram chat id: ${telegramChatId}`);
  return {
    language: str(o.language, 20),
    vocabulary: str(o.vocabulary, 2000),
    outputLanguage: str(o.outputLanguage, 100),
    customInstructions: str(o.customInstructions),
    perTopic: Number.isFinite(Number(o.perTopic)) ? Number(o.perTopic) : 2,
    includeTranscript: o.includeTranscript !== false,
    analyze: o.analyze !== false,
    telegramChatId,
  };
}

function meetingInput(body: Record<string, unknown>): MeetingInput {
  const platform = (['meet', 'zoom', 'other'] as Platform[]).find((p) => p === body.platform) ?? 'other';
  return {
    title: str(body.title, 300).trim() || 'Meeting',
    platform,
    startedAt: int(body.startedAt ?? Date.now(), 'startedAt'),
    endedAt: body.endedAt === undefined ? undefined : int(body.endedAt, 'endedAt'),
    durationMs: int(body.durationMs ?? 0, 'durationMs'),
    hasMic: Boolean(body.hasMic),
    notes: str(body.notes),
    template: template(body.template) ?? 'general',
    options: meetingOptions(body.options),
    live: body.live === true,
  };
}

function statusOf(m: Meeting): MeetingStatus {
  return {
    id: m.id,
    status: m.status,
    progress: m.progress,
    error: m.error,
    warning: m.warning,
    telegram: m.telegram,
    telegramError: m.telegramError,
  };
}

function owned(id: string, owner: string): Meeting {
  const m = isMeetingId(id) ? store.get(id) : undefined;
  if (!m || m.owner !== owner) throw new HttpError(404, 'Meeting not found');
  return m;
}

function notBusy(m: Meeting): void {
  if (isProcessing(m.status)) throw new HttpError(409, 'The meeting is being processed');
}

/** Whether a self-hosted API answers at {origin}/health; hosted APIs are only reported as configured. */
async function endpointHealth(ep: ApiEndpoint, probe: boolean): Promise<EndpointHealth> {
  const configured = endpointReady(ep);
  if (!configured || !probe) return { configured, model: ep.model || undefined };
  try {
    const res = await fetch(new URL('/health', ep.baseUrl), { signal: AbortSignal.timeout(3000) });
    return { configured, reachable: res.status < 500, model: ep.model };
  } catch {
    return { configured, reachable: false, model: ep.model };
  }
}

/** The bot, and whether it can reach the chat (?chat= from the extension, else the server default). */
async function telegramHealth(chatOverride: string): Promise<ServerHealth['telegram']> {
  if (!telegram.enabled) return { configured: false };
  if (chatOverride && !isTelegramChatId(chatOverride)) return { configured: false, error: `Invalid chat id ${chatOverride}` };
  const chat = telegram.chatFor(chatOverride);
  try {
    const bot = (await telegram.getMe()).username;
    if (!chat) return { configured: false, bot };
    return { configured: true, bot, chat: chatTitle(await telegram.getChat(chat)) || chat };
  } catch (err) {
    return { configured: Boolean(chat), error: (err as Error).message };
  }
}

async function health(chat: string): Promise<ServerHealth> {
  const s = config.settings;
  const [stt, vision, summary, tg] = await Promise.all([
    endpointHealth(s.transcription, true),
    s.slides.analyze ? endpointHealth(s.vision, true) : Promise.resolve({ configured: false }),
    endpointHealth(s.summary, false),
    telegramHealth(chat),
  ]);
  return { ok: stt.configured && summary.configured, stt, vision, summary, telegram: tg };
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  if (path === '/health' && method === 'GET') {
    return send(res, 200, { status: 'ok', processing: processor.running, queue: processor.waiting });
  }
  if (!path.startsWith('/v1/')) throw new HttpError(404, 'Not found');
  const owner = authenticate(req);

  if (path === '/v1/health' && method === 'GET') {
    return send(res, 200, await health(url.searchParams.get('chat')?.trim() ?? ''));
  }

  if (path === '/v1/telegram/chats' && method === 'GET') {
    if (!telegram.enabled) throw new HttpError(400, 'Telegram is not set up on the server (TELEGRAM_BOT_TOKEN)');
    const result: TelegramChats = { chats: bot?.recentChats() ?? [] };
    return send(res, 200, result);
  }

  if (path === '/v1/meetings' && method === 'POST') {
    const input = meetingInput(await readJson(req));
    const meeting = await store.create(
      input,
      owner,
      telegram.enabled && telegram.chatFor(input.options.telegramChatId) ? 'pending' : 'off',
    );
    log('created', meeting.id, JSON.stringify(meeting.title));
    return send(res, 201, { id: meeting.id });
  }

  const match = /^\/v1\/meetings\/([^/]+)(?:\/(audio|frames|process|result|telegram)(?:\/(\d+))?)?$/.exec(path);
  if (!match) throw new HttpError(404, 'Not found');
  const [, id = '', part, index] = match;
  const meeting = owned(id, owner);

  if (!part && method === 'GET') return send(res, 200, statusOf(meeting));

  if (meeting.pruned && (part === 'audio' || part === 'frames' || part === 'process')) {
    throw new HttpError(
      409,
      `The audio and screenshots of this meeting were deleted after ${config.retentionDays} days; only the minutes are kept`,
    );
  }

  if (part === 'audio' && index && method === 'PUT') {
    if (!meeting.live) notBusy(meeting);
    const data = await readBody(req, 40 * MB);
    const seg = {
      index: int(index, 'index'),
      startMs: int(url.searchParams.get('startMs'), 'startMs'),
      endMs: int(url.searchParams.get('endMs'), 'endMs'),
      bytes: data.length,
    };
    await store.putAudio(id, seg, data);
    if (store.get(id)?.live) processor.warm(id);
    return send(res, 204);
  }

  if (part === 'frames' && index && method === 'PUT') {
    if (!meeting.live) notBusy(meeting);
    const data = await readBody(req, 10 * MB);
    if (data[0] !== 0xff || data[1] !== 0xd8) throw new HttpError(400, 'Screenshots must be JPEG images');
    const frame = {
      id: int(index, 'frame id'),
      t: int(url.searchParams.get('t'), 't'),
      width: int(url.searchParams.get('width'), 'width'),
      height: int(url.searchParams.get('height'), 'height'),
    };
    await store.putFrame(id, frame, data);
    if (store.get(id)?.live) processor.warm(id);
    return send(res, 204);
  }

  if (part === 'process' && !index && method === 'POST') {
    const body = (await readJson(req)) as Partial<ProcessRequest>;
    const mode: ProcessMode = body.mode === 'transcribe' || body.mode === 'summarize' ? body.mode : 'all';
    // Asking again for a meeting that is already queued, running or done (e.g. after a browser restart) is a no-op.
    if (!meeting.live && (isProcessing(meeting.status) || (meeting.status === 'done' && mode === 'all'))) {
      return send(res, 202, statusOf(meeting));
    }
    if (!meeting.audioSegments.length) throw new HttpError(400, 'No audio was uploaded');
    if (!endpointReady(config.settings.transcription) || !endpointReady(summaryEndpoint(config.settings))) {
      throw new HttpError(503, 'The speech-to-text or summary API is not set up on the server (STT_* / SUMMARY_* in .env)');
    }
    await store.update(id, {
      title: str(body.title, 300).trim() || meeting.title,
      notes: typeof body.notes === 'string' ? str(body.notes) : meeting.notes,
      template: template(body.template) ?? meeting.template,
      options: body.options ? meetingOptions(body.options) : meeting.options,
      // The recording has ended: what is still missing gets processed now, then the summary.
      live: undefined,
      durationMs: body.durationMs === undefined ? meeting.durationMs : int(body.durationMs, 'durationMs'),
      endedAt: body.endedAt === undefined ? meeting.endedAt : int(body.endedAt, 'endedAt'),
    });
    await processor.enqueue(id, mode, template(body.template));
    return send(res, 202, statusOf(store.get(id)!));
  }

  if (part === 'result' && !index && method === 'GET') {
    const result: MeetingResult = {
      summary: meeting.summary,
      transcript: meeting.transcript,
      summaryModel: meeting.summaryModel,
      processedAt: meeting.processedAt,
    };
    return send(res, 200, result);
  }

  if (part === 'telegram' && !index && method === 'POST') {
    if (!telegram.enabled || !telegram.chatFor(meeting.options.telegramChatId)) {
      throw new HttpError(400, 'Telegram is not set up for this meeting (bot token or chat id missing)');
    }
    if (!meeting.summary) throw new HttpError(409, 'The minutes are not ready yet');
    await processor.redeliver(id);
    return send(res, 202, statusOf(store.get(id)!));
  }

  throw new HttpError(405, 'Method not allowed');
}

const server = createServer((req, res) => {
  route(req, res).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) log('error', req.method, req.url?.split('?')[0], (err as Error).message);
    if (!res.headersSent) send(res, status, { error: { message: (err as Error).message } });
    else res.end();
  });
});
server.requestTimeout = 10 * 60_000;

/** Deletes audio and screenshots after RETENTION_DAYS, and the minutes after NOTES_RETENTION_DAYS. */
async function cleanup(): Promise<void> {
  const { pruned, removed } = await store.expire(config.retentionDays, config.notesRetentionDays, (id) => processor.isBusy(id));
  for (const id of pruned) log('kept only the minutes of', id, '(retention)');
  for (const id of removed) log('deleted', id, '(retention)');
}
if (config.retentionDays > 0 || config.notesRetentionDays > 0) {
  void cleanup();
  setInterval(() => void cleanup(), 3_600_000).unref();
}

server.listen(config.port, config.host, () => {
  log(`meeting-server listening on http://${config.host}:${config.port}`);
  log(
    `stt: ${config.settings.transcription.baseUrl || '-'} · vision: ${config.settings.slides.analyze ? config.settings.vision.baseUrl : 'off'} · summary: ${config.settings.summary.baseUrl} (${config.settings.summary.model}) · telegram: ${telegram.enabled ? `on (default chat ${config.telegram.chatId || 'none'})` : 'off'}`,
  );
});
