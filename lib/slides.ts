import type { Settings } from './settings';

declare global {
  // Chrome implements grabFrame(); TypeScript's DOM types do not list it.
  interface ImageCapture {
    grabFrame(): Promise<ImageBitmap>;
  }
}

/** Share of static pixels that must differ from the last screenshot to count as a new screen. */
const CHANGE_THRESHOLD: Record<Settings['slides']['sensitivity'], number> = { low: 0.1, medium: 0.05, high: 0.02 };
/** At most this share of static pixels may change between two samples for the screen to be "settled". */
const SETTLED_THRESHOLD = 0.02;
/** Pixels whose recent activity is above this are treated as moving video (participant tiles, playing videos). */
const MOTION_ACTIVITY = 0.45;
/** Below this share of static pixels the screen is mostly video (gallery / speaker view): nothing to capture. */
const MIN_STATIC_SHARE = 0.2;
/** Per-pixel colour difference (largest channel) that counts as changed; ignores compression noise. */
const PIXEL_DELTA = 16;
/** Large enough to keep the shape of text lines, so slides with the same layout but other words differ. */
export const THUMB_WIDTH = 160;
export const THUMB_HEIGHT = 90;
const MAX_WIDTH = 1280;

function pixelChanged(a: Uint8Array, b: Uint8Array, pixel: number, channels: number): boolean {
  for (let c = 0; c < channels; c++) {
    const i = pixel * channels + c;
    if (Math.abs(a[i]! - b[i]!) > PIXEL_DELTA) return true;
  }
  return false;
}

/** Share of (unmasked) pixels that changed between two thumbnails with `channels` bytes per pixel. */
export function changedRatio(a: Uint8Array, b: Uint8Array, mask?: Uint8Array, channels = 1): number {
  let changed = 0;
  let counted = 0;
  for (let p = 0; p < a.length / channels; p++) {
    if (mask && !mask[p]) continue;
    counted++;
    if (pixelChanged(a, b, p, channels)) changed++;
  }
  return counted ? changed / counted : 0;
}

/**
 * Decides, from small thumbnails sampled every few seconds, when the
 * shared content changed and then settled. Pixels that keep changing (video
 * tiles of participants, a playing video, scrolling) are masked out, so only
 * changes to still content such as slides or documents trigger a screenshot.
 */
export class ChangeDetector {
  private activity?: Float32Array;
  private previous?: Uint8Array;
  private lastSaved?: Uint8Array;
  private lastSavedAt = -Infinity;
  /** When the not yet captured change was first seen. */
  private changeSince?: number;

  constructor(
    private readonly threshold: number,
    private readonly minGapMs = 4000,
    /** Bytes per pixel of the thumbnails: 1 for grey, 3 for RGB. */
    private readonly channels = 1,
  ) {}

  /** Returns the time to stamp the screenshot with, or undefined to skip this sample. */
  push(thumb: Uint8Array, t: number): number | undefined {
    const previous = this.previous;
    const pixels = thumb.length / this.channels;
    const activity = (this.activity ??= new Float32Array(pixels));
    this.previous = thumb;
    if (!previous) return undefined;

    // Static mask from the history *before* this sample, so a one-off change
    // (a new slide) is not mistaken for motion.
    const mask = new Uint8Array(pixels);
    let staticCount = 0;
    for (let p = 0; p < pixels; p++) {
      if (activity[p]! < MOTION_ACTIVITY) {
        mask[p] = 1;
        staticCount++;
      }
      const moved = pixelChanged(thumb, previous, p, this.channels) ? 1 : 0;
      activity[p] = activity[p]! * 0.7 + moved * 0.3;
    }
    if (staticCount < pixels * MIN_STATIC_SHARE) return undefined;

    const changed = !this.lastSaved || changedRatio(thumb, this.lastSaved, mask, this.channels) > this.threshold;
    if (!changed) {
      this.changeSince = undefined;
      return undefined;
    }
    this.changeSince ??= t;
    const settled = changedRatio(thumb, previous, mask, this.channels) <= SETTLED_THRESHOLD;
    if (!settled || t - this.lastSavedAt < this.minGapMs) return undefined;

    const stamp = this.changeSince;
    this.lastSaved = thumb;
    this.lastSavedAt = t;
    this.changeSince = undefined;
    return stamp;
  }
}

export interface CapturedFrame {
  /** Offset from the start of the recording, in ms (when the screen changed). */
  t: number;
  blob: Blob;
  width: number;
  height: number;
}

export interface SlideCaptureOptions {
  sensitivity: Settings['slides']['sensitivity'];
  maxFrames: number;
  elapsed: () => number;
  onFrame: (frame: CapturedFrame) => void;
  intervalMs?: number;
  minGapMs?: number;
}

/**
 * Samples the captured tab every few seconds and keeps a JPEG whenever the
 * screen changed (new slide, new document page, …) and then stayed still, so
 * transitions and scrolling are not captured.
 */
export class SlideCapture {
  private timer?: ReturnType<typeof setInterval>;
  private readonly grabber: ImageCapture;
  private readonly thumb = new OffscreenCanvas(THUMB_WIDTH, THUMB_HEIGHT);
  private readonly detector: ChangeDetector;
  private busy = false;
  private stopped = false;
  count = 0;

  constructor(
    private readonly track: MediaStreamTrack,
    private readonly opts: SlideCaptureOptions,
  ) {
    this.grabber = new ImageCapture(track);
    this.detector = new ChangeDetector(CHANGE_THRESHOLD[opts.sensitivity], opts.minGapMs, 3);
  }

  start(): void {
    this.timer = setInterval(() => void this.sample(), this.opts.intervalMs ?? 2000);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private rgbThumb(bitmap: ImageBitmap): Uint8Array {
    const ctx = this.thumb.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    const rgba = ctx.getImageData(0, 0, THUMB_WIDTH, THUMB_HEIGHT).data;
    const rgb = new Uint8Array(THUMB_WIDTH * THUMB_HEIGHT * 3);
    for (let p = 0; p < THUMB_WIDTH * THUMB_HEIGHT; p++) {
      rgb[p * 3] = rgba[p * 4]!;
      rgb[p * 3 + 1] = rgba[p * 4 + 1]!;
      rgb[p * 3 + 2] = rgba[p * 4 + 2]!;
    }
    return rgb;
  }

  private async encode(bitmap: ImageBitmap): Promise<{ blob: Blob; width: number; height: number }> {
    const scale = Math.min(1, MAX_WIDTH / bitmap.width);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
    return { blob: await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }), width, height };
  }

  private async sample(): Promise<void> {
    if (this.busy || this.count >= this.opts.maxFrames || this.track.readyState !== 'live') return;
    this.busy = true;
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await this.grabber.grabFrame();
      const stamp = this.detector.push(this.rgbThumb(bitmap), this.opts.elapsed());
      if (stamp === undefined) return;
      const image = await this.encode(bitmap);
      if (this.stopped) return;
      this.count++;
      this.opts.onFrame({ t: stamp, ...image });
    } catch {
      // No frame available right now (e.g. the tab is being reloaded); try again later.
    } finally {
      bitmap?.close();
      this.busy = false;
    }
  }
}
