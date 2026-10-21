// The offscreen document is the extension's engine: it owns the media streams
// and MediaRecorders (service workers cannot) and runs the AI pipeline, so
// processing keeps going even when no extension page is open.
import { browser } from 'wxt/browser';
import { getRecording, updateRecording } from '@/lib/db';
import type { BackgroundMessage, OffscreenMessage } from '@/lib/messages';
import { processRecording, type ProcessMode } from '@/lib/pipeline';
import { MeetingRecorder } from '@/lib/recorder';
import { isProcessingConfigured, isServerConfigured, type Settings } from '@/lib/settings';
import type { TemplateId } from '@/lib/types';
import { syncLive, uploadAndProcess } from '@/lib/upload';
import { saveVideo } from '@/lib/video';

const recorder = new MeetingRecorder();
const pipelines = new Set<string>();
const finished = new Set<string>();
let lastSettings: Settings | undefined;

/** How often finished audio segments and new screenshots are sent while recording (server mode). */
const LIVE_SYNC_MS = 5000;
let live: { recId: string; timer: ReturnType<typeof setInterval>; busy?: Promise<void> } | undefined;

/**
 * Server mode: sends finished audio segments and screenshots during the meeting, so the server
 * transcribes it meanwhile and the minutes are ready soon after it ends. Failures are retried on the
 * next tick and, in the end, by the upload after the recording stops.
 */
function startLiveUpload(recId: string, settings: Settings) {
  if (settings.processing !== 'server' || !settings.autoProcess || !isServerConfigured(settings)) return;
  let warned = false;
  const state: NonNullable<typeof live> = {
    recId,
    timer: setInterval(() => {
      state.busy ??= syncLive(recId, settings)
        .catch((err: Error) => {
          if (!warned) console.warn('Live upload to the processing server failed; retrying:', err.message);
          warned = true;
        })
        .finally(() => {
          state.busy = undefined;
        });
    }, LIVE_SYNC_MS),
  };
  live = state;
}

async function stopLiveUpload(recId: string) {
  const state = live;
  if (state?.recId !== recId) return;
  clearInterval(state.timer);
  live = undefined;
  await state.busy;
}

function notifyBackground(msg: BackgroundMessage): Promise<unknown> {
  return browser.runtime.sendMessage(msg).catch(() => undefined);
}

async function runPipeline(recId: string, settings: Settings, mode: ProcessMode, template?: TemplateId) {
  if (pipelines.has(recId)) return;
  pipelines.add(recId);
  try {
    if (settings.processing === 'server') {
      await uploadAndProcess(recId, settings, mode, template, () => notifyBackground({ type: 'uploaded', recId }).then(() => {}));
    } else await processRecording(recId, settings, mode, template);
    await notifyBackground({ type: 'pipeline-finished', recId, ok: true });
  } catch (err) {
    await notifyBackground({ type: 'pipeline-finished', recId, ok: false, error: (err as Error).message });
  } finally {
    pipelines.delete(recId);
  }
}

/**
 * Runs once per recording after the recorders stopped: save the video and process. The server only
 * needs the audio and screenshots, so in server mode they are sent right away while the video is saved.
 */
async function finishRecording(recId: string, settings: Settings, reason: string) {
  if (finished.has(recId)) return;
  finished.add(recId);
  await stopLiveUpload(recId);
  await notifyBackground({ type: 'recorder-stopped', recId, reason });
  const save = async () => {
    await saveVideo(recId, settings.askWhereToSave);
    await updateRecording(recId, (r) => (r.status === 'saving' ? { status: 'recorded' } : {}));
  };
  const rec = await getRecording(recId);
  const process = Boolean(rec && settings.autoProcess && isProcessingConfigured(settings) && rec.audioSegments.length);
  if (process && settings.processing === 'server') {
    await Promise.all([save(), runPipeline(recId, settings, 'all')]);
    return;
  }
  await save();
  if (process) await runPipeline(recId, settings, 'all');
}

recorder.onEnded = (recId, reason) => {
  if (lastSettings) void finishRecording(recId, lastSettings, reason);
};

async function handle(msg: OffscreenMessage): Promise<unknown> {
  switch (msg.type) {
    case 'ping':
      return { ok: true, recording: recorder.recordingId ?? null, processing: [...pipelines] };
    case 'start': {
      lastSettings = msg.settings;
      const result = await recorder.start({
        recId: msg.recId,
        streamId: msg.streamId,
        title: msg.title,
        pageUrl: msg.pageUrl,
        settings: msg.settings,
        recordMic: msg.recordMic,
        synthetic: msg.synthetic,
      });
      startLiveUpload(msg.recId, msg.settings);
      return { ok: true, ...result };
    }
    case 'stop': {
      lastSettings = msg.settings;
      const recId = await recorder.stop();
      if (recId) void finishRecording(recId, msg.settings, 'user');
      return { ok: true, recId };
    }
    case 'process':
      void runPipeline(msg.recId, msg.settings, msg.mode, msg.template);
      return { ok: true };
  }
}

browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as OffscreenMessage;
  if (msg?.target !== 'offscreen') return;
  handle(msg).then(sendResponse, (err: Error) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});
