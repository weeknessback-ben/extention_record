import { authHeaders, endpointUrl, request } from './ai';
import { getChunks, getFrames, getRecording, updateRecording } from './db';
import type { ProcessMode } from './pipeline-core';
import type {
  MeetingInput,
  MeetingOptions,
  MeetingResult,
  MeetingStatus,
  ProcessRequest,
  ServerHealth,
  TelegramChats,
} from './server-api';
import type { ApiEndpoint, Settings } from './settings';
import type { Recording, ServerJob, TemplateId } from './types';

const POLL_MS = 15_000;
/** The server sends the minutes to Telegram right after they are written; wait for that before finishing. */
const TELEGRAM_WAIT_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function serverEndpoint(s: Settings): ApiEndpoint {
  return { baseUrl: s.server.baseUrl, apiKey: s.server.apiKey, model: '', extraHeaders: '' };
}

async function call<T>(
  ep: ApiEndpoint,
  method: string,
  path: string,
  body?: Blob | object,
  query: Record<string, string | number> = {},
): Promise<T> {
  // endpointUrl() keeps the base URL's own query; the parameters of this call are added to it.
  const url = new URL(endpointUrl(ep.baseUrl, path));
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await request(
    url.toString(),
    () => {
      const headers: Record<string, string> = authHeaders(ep);
      if (body && !(body instanceof Blob)) headers['Content-Type'] = 'application/json';
      return {
        method,
        headers,
        body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
      };
    },
    5 * 60_000,
  );
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** GET /v1/health, for the "Test connection" button; also checks that the bot can reach the chosen chat. */
export function serverHealth(s: Settings): Promise<ServerHealth> {
  const chat = s.server.telegramChatId.trim();
  return call<ServerHealth>(serverEndpoint(s), 'GET', '/v1/health', undefined, chat ? { chat } : {});
}

/** Chats that recently wrote to the server's Telegram bot, to pick the chat id from. */
export async function telegramChats(s: Settings): Promise<TelegramChats['chats']> {
  return (await call<TelegramChats>(serverEndpoint(s), 'GET', '/v1/telegram/chats')).chats;
}

function meetingOptions(s: Settings): MeetingOptions {
  return {
    language: s.transcription.language,
    vocabulary: s.transcription.vocabulary,
    outputLanguage: s.outputLanguage,
    customInstructions: s.customInstructions,
    perTopic: s.slides.perTopic,
    includeTranscript: s.pdfIncludeTranscript,
    analyze: s.slides.analyze,
    telegramChatId: s.server.telegramChatId.trim(),
  };
}

function meetingInput(rec: Recording, s: Settings): MeetingInput {
  return {
    title: rec.title,
    platform: rec.platform,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    durationMs: rec.durationMs,
    hasMic: rec.hasMic,
    notes: rec.notes ?? '',
    template: rec.template ?? s.template,
    options: meetingOptions(s),
  };
}

/** The meeting on the server for this recording, created there when needed. */
async function ensureJob(ep: ApiEndpoint, recId: string, settings: Settings, live: boolean): Promise<ServerJob> {
  const rec = await getRecording(recId);
  if (!rec) throw new Error('Recording not found');
  if (rec.server?.baseUrl === ep.baseUrl) return rec.server;
  const input: MeetingInput = { ...meetingInput(rec, settings), live };
  const created = await call<{ id: string }>(ep, 'POST', '/v1/meetings', input);
  const job: ServerJob = { id: created.id, baseUrl: ep.baseUrl, uploadedAudio: [], uploadedFrames: [] };
  await updateRecording(recId, { server: job }, { silent: live });
  return job;
}

/** Sends the finished audio segments and the screenshots that the server does not have yet. */
async function uploadMissing(
  ep: ApiEndpoint,
  recId: string,
  onProgress: (done: number, total: number) => Promise<void> = async () => {},
): Promise<void> {
  const rec = await getRecording(recId);
  const job = rec?.server;
  if (!rec || !job) return;
  const meeting = `/v1/meetings/${encodeURIComponent(job.id)}`;
  const audio = rec.audioSegments.filter((seg) => !job.uploadedAudio.includes(seg.index));
  const images = (await getFrames(recId)).filter((f) => !job.uploadedFrames.includes(f.id!));
  const total = audio.length + images.length;
  let done = 0;
  await onProgress(done, total);
  const uploaded = async (patch: (j: ServerJob) => Partial<ServerJob>) => {
    done++;
    await updateRecording(recId, (r) => (r.server ? { server: { ...r.server, ...patch(r.server) } } : {}), {
      silent: true,
    });
    await onProgress(done, total);
  };
  for (const seg of audio) {
    const blob = new Blob(await getChunks(recId, 'audio', seg.index), { type: 'audio/webm' });
    await call(ep, 'PUT', `${meeting}/audio/${seg.index}`, blob, { startMs: seg.startMs, endMs: seg.endMs });
    await uploaded((j) => ({ uploadedAudio: [...j.uploadedAudio, seg.index] }));
  }
  for (const f of images) {
    await call(ep, 'PUT', `${meeting}/frames/${f.id}`, f.blob, { t: f.t, width: f.width, height: f.height });
    await uploaded((j) => ({ uploadedFrames: [...j.uploadedFrames, f.id!] }));
  }
}

/**
 * While recording (server mode): creates the meeting on the server and sends the audio segments and
 * screenshots finished so far, so the server transcribes and reads them during the meeting.
 */
export async function syncLive(recId: string, settings: Settings): Promise<void> {
  const ep = serverEndpoint(settings);
  await ensureJob(ep, recId, settings, true);
  await uploadMissing(ep, recId);
}

/**
 * Sends what is left of a recording to the processing server (most of it may already be there, see
 * syncLive), starts processing there and mirrors its progress until the minutes are back.
 * Uploads are idempotent and remembered, so an interrupted run continues where it stopped.
 */
export async function uploadAndProcess(
  recId: string,
  settings: Settings,
  mode: ProcessMode = 'all',
  templateOverride?: TemplateId,
  /** Called once the server has everything and processing started there. */
  onUploaded?: () => Promise<void>,
): Promise<void> {
  const ep = serverEndpoint(settings);
  const rec = await getRecording(recId);
  if (!rec) throw new Error('Recording not found');
  try {
    let job = await ensureJob(ep, recId, settings, false);
    const meeting = `/v1/meetings/${encodeURIComponent(job.id)}`;
    await updateRecording(recId, { status: 'uploading', error: undefined, warning: undefined });
    await uploadMissing(ep, recId, (done, total) =>
      updateRecording(recId, { progress: { stage: 'uploading', done, total } }).then(() => {}),
    );
    job = (await getRecording(recId))?.server ?? job;

    const latest = (await getRecording(recId)) ?? rec;
    const body: ProcessRequest = {
      mode,
      template: templateOverride ?? latest.template ?? settings.template,
      title: latest.title,
      notes: latest.notes ?? '',
      options: meetingOptions(settings),
      durationMs: latest.durationMs,
      endedAt: latest.endedAt,
    };
    await call(ep, 'POST', `${meeting}/process`, body);
    await updateRecording(recId, { status: 'queued', progress: undefined });
    await onUploaded?.();

    let doneAt = 0;
    for (;;) {
      await sleep(POLL_MS);
      const st = await call<MeetingStatus>(ep, 'GET', meeting);
      if (st.status === 'error') throw new Error(st.error || 'Processing failed on the server');
      job = { ...job, telegram: st.telegram };
      if (st.status !== 'done') {
        await updateRecording(recId, { server: job, status: st.status, progress: st.progress, warning: st.warning });
        continue;
      }
      doneAt ||= Date.now();
      const delivering = st.telegram === 'pending' || st.telegram === 'sending';
      if (delivering && Date.now() - doneAt < TELEGRAM_WAIT_MS) continue;
      const result = await call<MeetingResult>(ep, 'GET', `${meeting}/result`);
      await updateRecording(recId, {
        server: job,
        status: 'done',
        progress: undefined,
        error: undefined,
        warning: [st.warning, st.telegramError && `Telegram: ${st.telegramError}`].filter(Boolean).join(' ') || undefined,
        summary: result.summary,
        transcript: result.transcript,
        summaryModel: result.summaryModel,
        processedAt: result.processedAt ?? Date.now(),
        template: body.template,
      });
      return;
    }
  } catch (err) {
    await updateRecording(recId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      progress: undefined,
    });
    throw err;
  }
}
