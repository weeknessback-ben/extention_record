// Replays a recorded meeting (a folder with video.webm) through the processing server the way the
// extension does when a recording stops: 5-minute Opus audio segments, plus the screenshots that the
// extension's own ChangeDetector would have taken, then waits for the minutes and logs each stage.
//
//   npm run qa:replay -- "<recording folder>" [--out DIR] [--server URL] [--key KEY]
//
// Server URL, key and the options default to WXT_DEFAULT_SETTINGS in .env.production.local.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MeetingInput, MeetingResult, MeetingStatus } from '@/lib/server-api';
import { ChangeDetector, THUMB_HEIGHT, THUMB_WIDTH } from '@/lib/slides';

const SEGMENT_SECONDS = 300;
/** SlideCapture samples every 2 s; CHANGE_THRESHOLD.low in lib/slides.ts. */
const SAMPLE_MS = 2000;
const THRESHOLDS = { low: 0.1, medium: 0.05, high: 0.02 } as const;
const POLL_MS = 5000;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const folder = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!folder) throw new Error('Usage: npm run qa:replay -- "<recording folder>" [--out DIR]');

const defaults = (() => {
  const env = fs.existsSync('.env.production.local') ? fs.readFileSync('.env.production.local', 'utf8') : '';
  const raw = /^WXT_DEFAULT_SETTINGS='(.*)'$/m.exec(env)?.[1];
  return (raw ? JSON.parse(raw) : {}) as {
    server?: { baseUrl?: string; apiKey?: string; telegramChatId?: string };
    transcription?: { language?: string; vocabulary?: string };
    slides?: { sensitivity?: keyof typeof THRESHOLDS; maxFrames?: number; perTopic?: number };
    outputLanguage?: string;
  };
})();
const server = (flag('server') ?? defaults.server?.baseUrl ?? '').replace(/\/+$/, '');
const key = flag('key') ?? defaults.server?.apiKey ?? '';
if (!server || !key) throw new Error('No server URL / API key (use --server/--key or .env.production.local)');
const sensitivity = defaults.slides?.sensitivity ?? 'low';
const maxFrames = defaults.slides?.maxFrames ?? 40;
const out = path.resolve(flag('out') ?? path.join('tests/qa/.tmp', path.basename(folder)));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'audio'), { recursive: true });
fs.mkdirSync(path.join(out, 'frames'), { recursive: true });

const video = path.join(folder, 'video.webm');
const started = Date.now();
const timeline: { at: number; event: string; detail?: unknown }[] = [];
const log = (event: string, detail?: unknown) => {
  timeline.push({ at: Date.now() - started, event, detail });
  const s = ((Date.now() - started) / 1000).toFixed(0).padStart(5);
  console.log(`[qa ${s}s] ${event}`, detail === undefined ? '' : JSON.stringify(detail));
};
const ffmpeg = (...a: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
const duration = Number(
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString(),
);

// --- Audio: what the extension's audio-only recorder produces.
const segments: { index: number; startMs: number; endMs: number; file: string }[] = [];
for (let start = 0, index = 0; start < duration; start += SEGMENT_SECONDS, index++) {
  const file = path.join(out, 'audio', `${index}.webm`);
  const len = Math.min(SEGMENT_SECONDS, duration - start);
  ffmpeg('-ss', String(start), '-t', String(len), '-i', video, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', file);
  segments.push({ index, startMs: Math.round(start * 1000), endMs: Math.round((start + len) * 1000), file });
}
log(
  'audio segments',
  segments.map((s) => `${s.index}: ${(fs.statSync(s.file).size / 1024).toFixed(0)} KB`),
);

// --- Screenshots: thumbnails every 2 s through the extension's ChangeDetector.
const stamps = await new Promise<{ t: number; sampleT: number }[]>((resolve, reject) => {
  const detector = new ChangeDetector(THRESHOLDS[sensitivity], 4000, 3);
  const frameBytes = THUMB_WIDTH * THUMB_HEIGHT * 3;
  const found: { t: number; sampleT: number }[] = [];
  const proc = spawn('ffmpeg', [
    '-v',
    'error',
    '-i',
    video,
    '-vf',
    `fps=${1000 / SAMPLE_MS},scale=${THUMB_WIDTH}:${THUMB_HEIGHT}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ]);
  let buffer = Buffer.alloc(0);
  let n = 0;
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= frameBytes) {
      const thumb = new Uint8Array(buffer.subarray(0, frameBytes));
      buffer = buffer.subarray(frameBytes);
      const sampleT = n++ * SAMPLE_MS;
      const stamp = found.length < maxFrames ? detector.push(thumb, sampleT) : undefined;
      if (stamp !== undefined) found.push({ t: stamp, sampleT });
    }
  });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve(found) : reject(new Error(`ffmpeg exited with ${code}`))));
});
const frames = stamps.map((s, i) => {
  const file = path.join(out, 'frames', `${i + 1}.jpg`);
  ffmpeg(
    '-ss',
    (s.sampleT / 1000).toFixed(3),
    '-i',
    video,
    '-frames:v',
    '1',
    '-vf',
    "scale='min(1280,iw)':-2",
    '-q:v',
    '3',
    file,
  );
  return { id: i + 1, t: s.t, file };
});
log('screenshots', { count: frames.length, times: frames.map((f) => Math.round(f.t / 1000)) });

// --- Upload and process, like lib/upload.ts.
async function api<T>(method: string, p: string, body?: Buffer | object): Promise<T> {
  const res = await fetch(`${server}${p}`, {
    method,
    headers: {
      'X-API-Key': key,
      ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

const name = path.basename(folder);
const when = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2}) - (.+)$/.exec(name);
const input: MeetingInput = {
  title: when?.[6] ?? name,
  platform: 'meet',
  startedAt: when ? new Date(+when[1]!, +when[2]! - 1, +when[3]!, +when[4]!, +when[5]!).getTime() : Date.now(),
  durationMs: Math.round(duration * 1000),
  hasMic: true,
  notes: '',
  template: 'general',
  options: {
    language: defaults.transcription?.language ?? '',
    vocabulary: defaults.transcription?.vocabulary ?? '',
    outputLanguage: defaults.outputLanguage ?? '',
    customInstructions: '',
    perTopic: defaults.slides?.perTopic ?? 2,
    includeTranscript: true,
    analyze: true,
    telegramChatId: defaults.server?.telegramChatId ?? '',
  },
};
const { id } = await api<{ id: string }>('POST', '/v1/meetings', input);
log('meeting created', { id, title: input.title });
let bytes = 0;
for (const s of segments) {
  const data = fs.readFileSync(s.file);
  bytes += data.length;
  await api('PUT', `/v1/meetings/${id}/audio/${s.index}?startMs=${s.startMs}&endMs=${s.endMs}`, data);
}
for (const f of frames) {
  const data = fs.readFileSync(f.file);
  bytes += data.length;
  await api('PUT', `/v1/meetings/${id}/frames/${f.id}?t=${f.t}&width=1280&height=720`, data);
}
log('uploaded', { megabytes: +(bytes / 1024 / 1024).toFixed(1) });
await api('POST', `/v1/meetings/${id}/process`, {
  mode: 'all',
  template: 'general',
  title: input.title,
  notes: '',
  options: input.options,
});
log('processing requested');

let last = '';
for (;;) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  const st = await api<MeetingStatus>('GET', `/v1/meetings/${id}`).catch((err: Error) => {
    log('poll error', err.message);
    return undefined;
  });
  if (!st) continue;
  const now = `${st.status} ${st.progress ? `${st.progress.done}/${st.progress.total}` : ''} telegram=${st.telegram}`;
  if (now !== last)
    log('status', { status: st.status, progress: st.progress, telegram: st.telegram, warning: st.warning, error: st.error });
  last = now;
  if (st.status === 'error' || (st.status === 'done' && !['pending', 'sending'].includes(st.telegram))) break;
}
const result = await api<MeetingResult>('GET', `/v1/meetings/${id}/result`);
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ id, input, result }, null, 2));
fs.writeFileSync(path.join(out, 'timeline.json'), JSON.stringify(timeline, null, 2));
log('finished', { id, out });
