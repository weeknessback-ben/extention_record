import { addChunk, putRecording, updateRecording } from './db';
import { recordingFolder } from './files';
import { detectPlatform } from './meeting';
import { RESOLUTIONS, type Settings } from './settings';

export interface RecorderStartOptions {
  recId: string;
  streamId: string;
  title: string;
  pageUrl: string;
  settings: Settings;
  recordMic: boolean;
  /** e2e builds only: record a generated stream instead of a tab. */
  synthetic?: boolean;
}

export interface RecorderStartResult {
  startedAt: number;
  mimeType: string;
  hasMic: boolean;
  micError?: string;
}

interface OpenSegment {
  recorder: MediaRecorder;
  index: number;
  startMs: number;
  bytes: number;
  stopped: Promise<void>;
}

const VIDEO_TIMESLICE_MS = 4000;
const AUDIO_TIMESLICE_MS = 10_000;
const AUDIO_MIME = 'audio/webm;codecs=opus';

function pickVideoMime(): string {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
}

function recorderDone(recorder: MediaRecorder): Promise<void> {
  return new Promise((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
}

/**
 * Records a captured tab (video + tab audio + microphone) into IndexedDB.
 *
 * Two MediaRecorders run in parallel:
 *  - video + mixed audio, the archive copy saved to disk at the end;
 *  - mixed audio only at 32 kbps, restarted every N minutes so each segment is
 *    a standalone WebM file small enough for the transcription API.
 */
export class MeetingRecorder {
  private recId?: string;
  private settings?: Settings;
  private t0 = 0;
  private streams: MediaStream[] = [];
  private audioCtx?: AudioContext;
  private mixedTrack?: MediaStreamTrack;
  private videoRecorder?: MediaRecorder;
  private segment?: OpenSegment;
  private rotationTimer?: ReturnType<typeof setTimeout>;
  private writes: Promise<void> = Promise.resolve();
  private pendingSegments = new Set<Promise<void>>();
  private writeError?: unknown;
  private stopping?: Promise<string | undefined>;
  private starting = false;

  /** Called when recording ends on its own (tab closed, capture revoked). */
  onEnded?: (recId: string, reason: string) => void;

  get recordingId(): string | undefined {
    return this.recId;
  }

  private elapsed(): number {
    return Math.round(performance.now() - this.t0);
  }

  private enqueue(task: () => Promise<unknown>): void {
    this.writes = this.writes.then(task).then(
      () => undefined,
      (err) => {
        this.writeError ??= err;
        console.error('Recorder write failed', err);
      },
    );
  }

  async start(o: RecorderStartOptions): Promise<RecorderStartResult> {
    if (this.recId || this.starting) throw new Error('A recording is already running');
    this.starting = true;
    try {
      return await this.doStart(o);
    } catch (err) {
      for (const stream of this.streams) stream.getTracks().forEach((t) => t.stop());
      await this.audioCtx?.close().catch(() => {});
      this.streams = [];
      this.audioCtx = undefined;
      this.recId = undefined;
      throw err;
    } finally {
      this.starting = false;
    }
  }

  private async doStart(o: RecorderStartOptions): Promise<RecorderStartResult> {
    const res = RESOLUTIONS[o.settings.videoResolution];

    let tabStream: MediaStream;
    if (import.meta.env.MODE === 'e2e' && o.synthetic) {
      tabStream = syntheticStream();
    } else {
      tabStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: o.streamId } },
        video: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: o.streamId,
            maxWidth: res.width,
            maxHeight: res.height,
            maxFrameRate: o.settings.videoFps,
          },
        },
      } as unknown as MediaStreamConstraints);
    }
    this.streams = [tabStream];

    let micStream: MediaStream | undefined;
    let micError: string | undefined;
    if (o.recordMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.streams.push(micStream);
      } catch (err) {
        micError = (err as Error).name || String(err);
      }
    }

    // Mix tab audio and microphone. Capturing a tab mutes it for the user, so
    // the tab audio is also routed back to the speakers. The microphone is not,
    // to avoid hearing yourself.
    const ctx = new AudioContext();
    this.audioCtx = ctx;
    await ctx.resume().catch(() => {});
    const mix = ctx.createMediaStreamDestination();
    if (tabStream.getAudioTracks().length) {
      const tabSource = ctx.createMediaStreamSource(tabStream);
      tabSource.connect(ctx.destination);
      tabSource.connect(mix);
    }
    if (micStream) ctx.createMediaStreamSource(micStream).connect(mix);
    this.mixedTrack = mix.stream.getAudioTracks()[0]!;

    const videoTrack = tabStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('The captured tab has no video track');

    const mimeType = pickVideoMime();
    const kbps = o.settings.videoBitrateKbps > 0 ? o.settings.videoBitrateKbps : res.kbps;
    const videoRecorder = new MediaRecorder(new MediaStream([videoTrack, this.mixedTrack]), {
      mimeType,
      videoBitsPerSecond: kbps * 1000,
      audioBitsPerSecond: 128_000,
    });

    this.recId = o.recId;
    this.settings = o.settings;
    this.writeError = undefined;
    const startedAt = Date.now();
    const recId = o.recId;

    await putRecording({
      id: recId,
      title: o.title,
      platform: detectPlatform(o.pageUrl),
      pageUrl: o.pageUrl,
      startedAt,
      durationMs: 0,
      folder: recordingFolder(o.settings.folder, startedAt, o.title),
      mimeType,
      hasMic: Boolean(micStream),
      micError,
      status: 'recording',
      video: { status: 'pending' },
      audioSegments: [],
      notes: '',
      template: o.settings.template,
    });

    let videoSeq = 0;
    videoRecorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      const seq = videoSeq++;
      const durationMs = this.elapsed();
      this.enqueue(async () => {
        await addChunk({ recId, kind: 'video', seg: 0, seq, blob: e.data });
        // Keeps the duration usable if the browser crashes mid-recording.
        await updateRecording(recId, { durationMs }, { silent: true });
      });
    };
    this.videoRecorder = videoRecorder;

    this.t0 = performance.now();
    videoRecorder.start(VIDEO_TIMESLICE_MS);
    this.startSegment(0, 0);
    this.scheduleRotation();

    videoTrack.addEventListener('ended', () => {
      // Only when the tab went away; stopping tracks ourselves fires no 'ended'.
      if (this.stopping || this.recId !== recId) return;
      void this.stop().then(() => this.onEnded?.(recId, 'capture-ended'));
    });

    return { startedAt, mimeType, hasMic: Boolean(micStream), micError };
  }

  private startSegment(index: number, startMs: number): void {
    const recId = this.recId!;
    const recorder = new MediaRecorder(new MediaStream([this.mixedTrack!]), {
      mimeType: AUDIO_MIME,
      audioBitsPerSecond: 32_000,
    });
    const segment: OpenSegment = { recorder, index, startMs, bytes: 0, stopped: recorderDone(recorder) };
    let seq = 0;
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      segment.bytes += e.data.size;
      const s = seq++;
      this.enqueue(() => addChunk({ recId, kind: 'audio', seg: index, seq: s, blob: e.data }));
    };
    recorder.start(AUDIO_TIMESLICE_MS);
    this.segment = segment;
  }

  private finishSegment(segment: OpenSegment, endMs: number): Promise<void> {
    const recId = this.recId!;
    const done = (async () => {
      if (segment.recorder.state !== 'inactive') segment.recorder.stop();
      await segment.stopped;
      // Queued after the segment's last chunk, so the metadata only appears
      // once all of its data is stored.
      this.enqueue(() =>
        updateRecording(recId, (r) => ({
          audioSegments: [
            ...r.audioSegments.filter((s) => s.index !== segment.index),
            { index: segment.index, startMs: segment.startMs, endMs, bytes: segment.bytes },
          ],
        })),
      );
    })();
    this.pendingSegments.add(done);
    return done.finally(() => this.pendingSegments.delete(done));
  }

  private scheduleRotation(): void {
    const minutes = Math.min(20, Math.max(1, this.settings?.segmentMinutes ?? 5));
    this.rotationTimer = setTimeout(() => void this.rotate(), minutes * 60_000);
  }

  private async rotate(): Promise<void> {
    const previous = this.segment;
    if (!previous || this.stopping) return;
    const now = this.elapsed();
    // Start the next segment first so no audio is lost between the two.
    this.startSegment(previous.index + 1, now);
    this.scheduleRotation();
    await this.finishSegment(previous, now);
  }

  /** Stops recording and flushes everything to IndexedDB. Returns the recording id. */
  stop(): Promise<string | undefined> {
    if (!this.recId) return Promise.resolve(undefined);
    this.stopping ??= this.doStop().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async doStop(): Promise<string | undefined> {
    const recId = this.recId!;
    clearTimeout(this.rotationTimer);
    const endMs = this.elapsed();

    const video = this.videoRecorder;
    const videoDone = video ? recorderDone(video) : Promise.resolve();
    if (video && video.state !== 'inactive') video.stop();
    await Promise.all([videoDone, this.segment ? this.finishSegment(this.segment, endMs) : undefined]);
    // A segment rotation may still be finishing the previous segment.
    await Promise.all([...this.pendingSegments]);
    await this.writes;

    for (const stream of this.streams) stream.getTracks().forEach((t) => t.stop());
    await this.audioCtx?.close().catch(() => {});

    await updateRecording(recId, {
      status: 'saving',
      endedAt: Date.now(),
      durationMs: endMs,
      error: this.writeError ? `Some data could not be stored: ${String(this.writeError)}` : undefined,
    });

    this.recId = undefined;
    this.streams = [];
    this.audioCtx = undefined;
    this.mixedTrack = undefined;
    this.videoRecorder = undefined;
    this.segment = undefined;
    return recId;
  }
}

/** Animated canvas + tone, used by the automated end-to-end tests. */
function syntheticStream(): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const g = canvas.getContext('2d')!;
  let frame = 0;
  setInterval(() => {
    g.fillStyle = `hsl(${(frame * 3) % 360} 60% 40%)`;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#fff';
    g.font = '48px sans-serif';
    g.fillText(`frame ${frame++}`, 40, 200);
  }, 1000 / 30);
  const video = canvas.captureStream(30);
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const dest = ctx.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  return new MediaStream([...video.getVideoTracks(), ...dest.stream.getAudioTracks()]);
}
