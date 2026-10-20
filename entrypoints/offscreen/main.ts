// The offscreen document is the extension's engine: it owns the media streams
// and MediaRecorders (service workers cannot) and runs the AI pipeline, so
// processing keeps going even when no extension page is open.
import { browser } from 'wxt/browser';
import { getRecording, updateRecording } from '@/lib/db';
import type { BackgroundMessage, OffscreenMessage } from '@/lib/messages';
import { processRecording, type ProcessMode } from '@/lib/pipeline';
import { MeetingRecorder } from '@/lib/recorder';
import { isAiConfigured, type Settings } from '@/lib/settings';
import type { TemplateId } from '@/lib/types';
import { saveVideo } from '@/lib/video';

const recorder = new MeetingRecorder();
const pipelines = new Set<string>();
const finished = new Set<string>();
let lastSettings: Settings | undefined;

function notifyBackground(msg: BackgroundMessage): Promise<unknown> {
  return browser.runtime.sendMessage(msg).catch(() => undefined);
}

async function runPipeline(recId: string, settings: Settings, mode: ProcessMode, template?: TemplateId) {
  if (pipelines.has(recId)) return;
  pipelines.add(recId);
  try {
    await processRecording(recId, settings, mode, template);
    await notifyBackground({ type: 'pipeline-finished', recId, ok: true });
  } catch (err) {
    await notifyBackground({ type: 'pipeline-finished', recId, ok: false, error: (err as Error).message });
  } finally {
    pipelines.delete(recId);
  }
}

/** Runs once per recording after the recorders stopped: save the video, then process. */
async function finishRecording(recId: string, settings: Settings, reason: string) {
  if (finished.has(recId)) return;
  finished.add(recId);
  await notifyBackground({ type: 'recorder-stopped', recId, reason });
  await saveVideo(recId, settings.askWhereToSave);
  await updateRecording(recId, (r) => (r.status === 'saving' ? { status: 'recorded' } : {}));
  const rec = await getRecording(recId);
  if (rec && settings.autoProcess && isAiConfigured(settings) && rec.audioSegments.length) {
    await runPipeline(recId, settings, 'all');
  }
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
