import { describe, expect, it } from 'vitest';
import { summaryToMarkdown } from '@/lib/format';
import { finalizeImages, visualItems } from '@/lib/pipeline';
import { finalSystemPrompt, finalUserPrompt, normalizeFrameAnalyses, normalizeSummary } from '@/lib/prompts';
import { ChangeDetector, changedRatio, THUMB_HEIGHT, THUMB_WIDTH } from '@/lib/slides';
import type { FrameRecord, Recording } from '@/lib/types';

const frame = (id: number, t: number, useful: number, text = '', kind: 'slide' | 'people' = 'slide'): FrameRecord => ({
  id,
  recId: 'r',
  t,
  width: 1280,
  height: 720,
  blob: new Blob(),
  analysis: { kind, useful, caption: `caption ${id}`, text },
});

describe('changedRatio', () => {
  it('measures the share of changed pixels, ignoring small noise and masked pixels', () => {
    const a = new Uint8Array(100).fill(100);
    const noisy = a.map((v, i) => v + (i % 2 ? 10 : -10));
    expect(changedRatio(a, noisy)).toBe(0);
    const b = a.map((v, i) => (i < 25 ? 200 : v));
    expect(changedRatio(a, b)).toBe(0.25);
    const mask = new Uint8Array(100).map((_, i) => (i < 50 ? 0 : 1));
    expect(changedRatio(a, b, mask)).toBe(0);
  });

  it('notices colour changes that keep the same brightness', () => {
    // Two RGB pixels: green-ish vs blue-ish with similar luma.
    const green = new Uint8Array([40, 138, 63, 40, 138, 63]);
    const blue = new Uint8Array([40, 104, 138, 40, 104, 138]);
    expect(changedRatio(green, blue, undefined, 3)).toBe(1);
  });
});

describe('ChangeDetector', () => {
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 255;

  /** A thumbnail with a background, an optional text block and a participant tile with live video. */
  function screen(opts: { bg: number; text?: number; tile?: boolean; video?: 'all' }): Uint8Array {
    const g = new Uint8Array(THUMB_WIDTH * THUMB_HEIGHT);
    for (let y = 0; y < THUMB_HEIGHT; y++) {
      for (let x = 0; x < THUMB_WIDTH; x++) {
        let v = opts.bg;
        // A text block of ~7% of the screen, and a participant tile of ~4% in the corner.
        if (opts.text !== undefined && x >= 10 && x < 60 && y >= 30 && y < 50) v = opts.text;
        if ((opts.tile && x >= (THUMB_WIDTH * 5) / 6 && y >= (THUMB_HEIGHT * 3) / 4) || opts.video === 'all') v = random();
        g[y * THUMB_WIDTH + x] = v;
      }
    }
    return g;
  }

  function run(frames: Uint8Array[], threshold = 0.05): number[] {
    const detector = new ChangeDetector(threshold);
    const stamps: number[] = [];
    frames.forEach((f, i) => {
      const stamp = detector.push(f, i * 2000);
      if (stamp !== undefined) stamps.push(stamp);
    });
    return stamps;
  }

  it('captures each slide once while a participant tile keeps moving', () => {
    const frames = [
      ...Array.from({ length: 6 }, () => screen({ bg: 230, tile: true })),
      ...Array.from({ length: 6 }, () => screen({ bg: 120, tile: true })),
      // Same background, only a text block changes (a new bullet point).
      ...Array.from({ length: 6 }, () => screen({ bg: 120, text: 20, tile: true })),
    ];
    expect(run(frames)).toEqual([2000, 12_000, 24_000]);
  });

  it('ignores a gallery of moving video tiles', () => {
    const frames = Array.from({ length: 20 }, () => screen({ bg: 0, video: 'all' }));
    expect(run(frames)).toEqual([]);
  });

  it('waits until a transition or scroll has settled', () => {
    const frames = [
      screen({ bg: 230 }),
      screen({ bg: 230 }),
      screen({ bg: 230 }),
      // Scrolling: the content changes on every sample, then stops.
      screen({ bg: 180 }),
      screen({ bg: 140 }),
      screen({ bg: 100 }),
      screen({ bg: 60 }),
      screen({ bg: 60 }),
      screen({ bg: 60 }),
      screen({ bg: 60 }),
    ];
    const stamps = run(frames);
    expect(stamps).toHaveLength(2);
    expect(stamps[0]).toBe(2000);
    // Stamped when the change started, captured only once the screen was still.
    expect(stamps[1]).toBe(6000);
  });

  it('respects the minimum gap between screenshots', () => {
    const frames = [
      screen({ bg: 230 }),
      screen({ bg: 230 }),
      screen({ bg: 100 }),
      screen({ bg: 100 }),
      screen({ bg: 30 }),
      screen({ bg: 30 }),
    ];
    const detector = new ChangeDetector(0.05, 10_000);
    const stamps = frames.map((f, i) => detector.push(f, i * 2000)).filter((s) => s !== undefined);
    expect(stamps).toEqual([2000]);
  });
});

describe('normalizeFrameAnalyses', () => {
  it('parses and clamps the vision reply', () => {
    const map = normalizeFrameAnalyses({
      images: [
        { id: 3, kind: 'Slide', useful: 14, caption: 'Roadmap', text: 'Q4 • Beta' },
        { id: '4', kind: 'selfie', useful: '2' },
        { kind: 'slide' },
      ],
    });
    expect(map.get(3)).toEqual({ kind: 'slide', useful: 10, caption: 'Roadmap', text: 'Q4 • Beta' });
    expect(map.get(4)).toEqual({ kind: 'other', useful: 2, caption: '', text: '' });
    expect(map.size).toBe(2);
  });
});

describe('image selection', () => {
  it('offers useful, distinct screenshots in time order', () => {
    const items = visualItems([
      frame(1, 1000, 1),
      frame(2, 2000, 8, 'Agenda'),
      frame(3, 3000, 7, 'Agenda'),
      frame(4, 4000, 9, '', 'people'),
      frame(5, 5000, 6, 'Budget'),
      { ...frame(6, 6000, 0), analysis: undefined },
    ]);
    expect(items.map((i) => i.id)).toEqual([2, 5]);
    expect(items[0]!.time).toBe('00:00:02');
  });

  it('drops unknown or reused images and applies the per-topic limit', () => {
    const items = visualItems([frame(2, 2000, 8, 'A'), frame(5, 5000, 6, 'B'), frame(7, 7000, 6, 'C')]);
    const summary = normalizeSummary(
      {
        topics: [
          { title: 'One', images: [{ id: 2, caption: 'Agenda slide' }, { id: 99 }, { id: 5 }, { id: 7 }] },
          { title: 'Two', images: [2, '7'] },
        ],
      },
      'x',
    );
    const out = finalizeImages(summary, items, 2);
    expect(out.topics[0]!.images).toEqual([
      { id: 2, caption: 'Agenda slide' },
      { id: 5, caption: 'caption 5' },
    ]);
    expect(out.topics[1]!.images).toEqual([{ id: 7, caption: 'caption 7' }]);
  });
});

describe('prompts with screenshots', () => {
  const ctx = {
    title: 't',
    platform: 'Zoom',
    date: 'd',
    duration: '1m',
    notes: '',
    template: 'general' as const,
    outputLanguage: '',
    customInstructions: '',
    hasScreenshots: true,
    imagesPerTopic: 2,
  };

  it('asks for images only when screenshots exist', () => {
    expect(finalSystemPrompt(ctx)).toContain('"images": [{ "id": 0');
    expect(finalSystemPrompt(ctx)).toContain('up to 2 screenshot(s)');
    // Without picking, the slide content is still used.
    expect(finalSystemPrompt({ ...ctx, imagesPerTopic: 0 })).not.toContain('"images"');
    expect(finalSystemPrompt({ ...ctx, imagesPerTopic: 0 })).toContain('Use their content');
    expect(finalSystemPrompt({ ...ctx, hasScreenshots: false })).not.toContain('Screenshots');
  });

  it('lists screenshots before the transcript', () => {
    const items = visualItems([frame(2, 62_000, 8, 'Roadmap\n Q4')]);
    const prompt = finalUserPrompt(ctx, '[00:00:01] hello', items);
    expect(prompt).toContain('Screenshots:\n#2 [00:01:02] slide, useful 8/10: caption 2 | text: "Roadmap Q4"');
    expect(prompt.indexOf('Screenshots:')).toBeLessThan(prompt.indexOf('Transcript:'));
  });
});

describe('markdown with images', () => {
  it('links saved screenshots under their topic', () => {
    const rec = { id: '1', title: 'T', platform: 'zoom', startedAt: 0, durationMs: 1000 } as unknown as Recording;
    const s = normalizeSummary({ topics: [{ title: 'Roadmap', images: [{ id: 2, caption: 'Q4 [plan]' }] }] }, 'x');
    const md = summaryToMarkdown(rec, s, false, (id) => (id === 2 ? 'images/slide-00-01-02.jpg' : undefined));
    expect(md).toContain('![Q4 plan](images/slide-00-01-02.jpg)\n*Q4 [plan]*');
  });
});
