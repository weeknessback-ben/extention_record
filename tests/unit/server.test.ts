import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSummary } from '@/lib/prompts';
import type { PipelineStore } from '@/lib/pipeline-core';
import type { MeetingOptions } from '@/lib/server-api';
import type { Recording } from '@/lib/types';
import { loadConfig, meetingSettings } from '../../server/src/config';
import { allowSlowResponses } from '../../server/src/http';
import { Processor } from '../../server/src/process';
import { MeetingStore } from '../../server/src/store';
import { chatTitle, MESSAGE_LIMIT, photoCaption, splitText, summaryMessages, Telegram } from '../../server/src/telegram';

const rec = { title: 'Weekly', startedAt: Date.UTC(2026, 9, 20, 7), durationMs: 3_600_000, platform: 'meet' } as Recording;

const options: MeetingOptions = {
  language: '',
  vocabulary: 'Budi',
  outputLanguage: 'English',
  customInstructions: '',
  perTopic: 9,
  includeTranscript: false,
  analyze: true,
  telegramChatId: '',
};

describe('telegram messages', () => {
  const summary = normalizeSummary(
    {
      title: 'R&D <sync>',
      executiveSummary: 'First & second.\n\nThird.',
      keyPoints: ['a < b'],
      decisions: [{ decision: 'Ship', context: 'if QA passes' }],
      actionItems: [{ task: 'Send report', owner: 'Budi', deadline: 'Friday' }, { task: 'Plan' }],
      nextSteps: ['Next meeting'],
    },
    'Weekly',
  );

  it('formats the summary as escaped HTML sections', () => {
    const [text, ...rest] = summaryMessages(rec, summary);
    expect(rest).toEqual([]);
    expect(text).toMatch(/^<b>R&amp;D &lt;sync&gt;<\/b>\n/);
    expect(text).toContain('<b>Executive Summary</b>\nFirst &amp; second.\n\nThird.');
    expect(text).toContain('• a &lt; b');
    expect(text).toContain('1. Ship <i>(if QA passes)</i>');
    expect(text).toContain('• Send report — <i>Budi · Friday</i>\n• Plan\n');
    expect(text).not.toContain('Open Questions');
  });

  it('splits long minutes into messages under the limit without breaking tags', () => {
    const long = { ...summary, keyPoints: Array.from({ length: 400 }, (_, i) => `Point ${i} `.repeat(4)) };
    long.executiveSummary = 'word '.repeat(2000);
    const messages = summaryMessages(rec, long);
    expect(messages.length).toBeGreaterThan(2);
    for (const m of messages) {
      expect(m.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
      expect(m.split('<b>').length).toBe(m.split('</b>').length);
    }
    expect(messages.join('\n')).toContain('Point 399');
  });

  it('splits text at spaces and truncates captions', () => {
    expect(splitText('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc']);
    expect(photoCaption({ title: 'Roadmap', time: '00:01:02' }, 'Q4 plan')).toBe('[00:01:02] Roadmap\nQ4 plan');
    expect(photoCaption({ title: 'x' }, 'y'.repeat(2000))).toHaveLength(1024);
  });
});

describe('server config', () => {
  it('reads the AI endpoints and Telegram from the environment', () => {
    const c = loadConfig({
      API_KEYS: 'a, b,,',
      STT_BASE_URL: 'http://127.0.0.1:8110/v1',
      STT_LANGUAGE: 'id',
      VISION_BASE_URL: 'http://127.0.0.1:8100/v1',
      VISION_MODEL: 'quality',
      VISION_EXTRA_BODY: '{"max_tokens":512}',
      SUMMARY_API_KEY: 'sk',
      TELEGRAM_BOT_TOKEN: 't',
      TELEGRAM_CHAT_ID: '1',
      TELEGRAM_API_BASE: 'http://tg/',
    });
    expect(c.apiKeys).toEqual(['a', 'b']);
    expect(c.port).toBe(8120);
    expect(c.telegram).toEqual({ token: 't', chatId: '1', apiBase: 'http://tg' });
    expect(c.settings.transcription).toMatchObject({ model: 'whisper-1', language: 'id' });
    expect(c.settings.summary).toMatchObject({ baseUrl: 'https://api.openai.com/v1', sameAsTranscription: false });
    expect(c.settings.vision).toMatchObject({ model: 'quality', batchSize: 1, sameAsSummary: false });
    expect(c.settings.slides.analyze).toBe(true);
    expect(loadConfig({}).settings.slides.analyze).toBe(false);
  });

  it('applies the choices the extension sent for a meeting', () => {
    const base = loadConfig({ STT_LANGUAGE: 'id' }).settings;
    const s = meetingSettings(base, options);
    expect(s.transcription).toMatchObject({ language: 'id', vocabulary: 'Budi' });
    expect(s.outputLanguage).toBe('English');
    expect(s.slides.perTopic).toBe(4);
    expect(s.pdfIncludeTranscript).toBe(false);
    expect(meetingSettings(base, { ...options, language: 'en' }).transcription.language).toBe('en');
    const withVision = loadConfig({ VISION_BASE_URL: 'http://v/v1' }).settings;
    expect(meetingSettings(withVision, options).slides.analyze).toBe(true);
    expect(meetingSettings(withVision, { ...options, analyze: false }).slides.analyze).toBe(false);
  });
});

describe('telegram chats', () => {
  it('uses the chat chosen in the extension, else the server default', () => {
    const tg = new Telegram({ token: 't', chatId: '42', apiBase: 'http://tg' });
    expect(tg.chatFor('777')).toBe('777');
    expect(tg.chatFor(' ')).toBe('42');
    expect(new Telegram({ token: '', chatId: '42', apiBase: 'http://tg' }).enabled).toBe(false);
    expect(chatTitle({ first_name: 'Budi', last_name: 'S' })).toBe('Budi S');
    expect(chatTitle({ title: 'Tim', username: 'tim' })).toBe('Tim');
  });
});

describe('meeting store', () => {
  let dir = '';
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('keeps meetings, audio and screenshots on disk for the pipeline', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'meetings-'));
    const store = new MeetingStore(dir);
    await store.init();
    const m = await store.create(
      {
        title: 'Weekly',
        platform: 'zoom',
        startedAt: 1,
        durationMs: 2,
        hasMic: true,
        notes: '',
        template: 'general',
        options,
      },
      'owner',
      'pending',
    );
    await store.putAudio(m.id, { index: 1, startMs: 60_000, endMs: 90_000, bytes: 3 }, new Uint8Array([1, 2, 3]));
    await store.putAudio(m.id, { index: 0, startMs: 0, endMs: 60_000, bytes: 2 }, new Uint8Array([4, 5]));
    await store.putFrame(m.id, { id: 7, t: 5000, width: 1280, height: 720 }, new Uint8Array([0xff, 0xd8, 9]));

    const pipeline = store.pipeline(m.id);
    expect((await pipeline.getAudio(1)).size).toBe(3);
    const [frame] = await pipeline.getFrames();
    expect(frame).toMatchObject({ id: 7, t: 5000, recId: m.id });
    expect(frame!.blob.type).toBe('image/jpeg');
    await pipeline.setFrameAnalysis(7, { kind: 'slide', useful: 8, caption: 'c', text: 't' });
    await pipeline.update((r) => ({ title: `${r.title}!` }));

    const reloaded = new MeetingStore(dir);
    await reloaded.init();
    const again = reloaded.get(m.id)!;
    expect(again.title).toBe('Weekly!');
    expect(again.audioSegments.map((s) => s.index)).toEqual([0, 1]);
    expect(again.frames[0]!.analysis?.useful).toBe(8);
    expect(again.frameCount).toBe(1);
    await reloaded.remove(m.id);
    expect(reloaded.list()).toEqual([]);
  });
});

describe('processor lanes', () => {
  let dir = '';
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const input = {
    title: '',
    platform: 'meet' as const,
    startedAt: 1,
    durationMs: 1,
    hasMic: true,
    notes: '',
    template: 'general' as const,
    options,
  };

  /** Fake stages that log their calls and wait until the test lets them finish. */
  function fakeStages(store: MeetingStore) {
    const calls: string[] = [];
    const gates = new Map<string, () => void>();
    const step = async (name: string, s: PipelineStore) => {
      const key = `${name} ${(await s.getRecording())!.title}`;
      calls.push(key);
      await new Promise<void>((resolve) => gates.set(key, resolve));
    };
    return {
      calls,
      release: (key: string) => gates.get(key)!(),
      stages: {
        prepare: async (s: PipelineStore) => step('prepare', s),
        summarize: async (s: PipelineStore) => step('summarize', s),
        deliver: async (id: string) => void calls.push(`deliver ${store.get(id)!.title}`),
      },
    };
  }

  it('re-summarises without waiting for another meeting, and transcribes the next one meanwhile', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lanes-'));
    const store = new MeetingStore(dir);
    await store.init();
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((title) => store.create({ ...input, title }, 'o', 'off')));
    await store.update(b!.id, {
      status: 'done',
      transcript: [{ start: 0, end: 1, text: 'hi' }],
      summary: normalizeSummary({}, 'B'),
    });
    const fake = fakeStages(store);
    const processor = new Processor(store, loadConfig({}), new Telegram({ token: '', chatId: '', apiBase: '' }), fake.stages);

    await processor.enqueue(a!.id, 'all');
    await processor.enqueue(b!.id, 'summarize');
    await vi.waitFor(() => expect(fake.calls).toEqual(['prepare A', 'summarize B']));
    fake.release('summarize B');
    await vi.waitFor(() => expect(fake.calls).toContain('deliver B'));

    await processor.enqueue(c!.id, 'all');
    fake.release('prepare A');
    // A is summarised while C is already being transcribed.
    await vi.waitFor(() => expect(fake.calls.slice(-2).sort()).toEqual(['prepare C', 'summarize A']));
    expect(processor.running).toEqual({ cpu: c!.id, summary: a!.id });
    fake.release('summarize A');
    fake.release('prepare C');
    await vi.waitFor(() => expect(fake.calls).toContain('summarize C'));
    fake.release('summarize C');
    await vi.waitFor(() => expect(fake.calls.at(-1)).toBe('deliver C'));
    expect(store.get(a!.id)!.job).toBeUndefined();
  });

  it('processes a live meeting as it arrives and summarises it once the recording ends', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lanes-'));
    const store = new MeetingStore(dir);
    await store.init();
    const m = await store.create({ ...input, title: 'L', live: true }, 'o', 'off');
    const fake = fakeStages(store);
    const processor = new Processor(store, loadConfig({}), new Telegram({ token: '', chatId: '', apiBase: '' }), fake.stages);

    processor.warm(m.id);
    await vi.waitFor(() => expect(fake.calls).toEqual(['prepare L']));
    // More audio arrives while the first part is being transcribed: it is picked up right after.
    processor.warm(m.id);
    processor.warm(m.id);
    fake.release('prepare L');
    await vi.waitFor(() => expect(fake.calls).toEqual(['prepare L', 'prepare L']));
    // The recording ends during that run: once more for the last segment, then the summary.
    await store.update(m.id, { live: undefined });
    await processor.enqueue(m.id, 'all');
    fake.release('prepare L');
    await vi.waitFor(() => expect(fake.calls).toEqual(['prepare L', 'prepare L', 'prepare L']));
    fake.release('prepare L');
    await vi.waitFor(() => expect(fake.calls.at(-1)).toBe('summarize L'));
    fake.release('summarize L');
    await vi.waitFor(() => expect(fake.calls.at(-1)).toBe('deliver L'));
  });

  it('resumes each meeting in the right lane after a restart', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lanes-'));
    const store = new MeetingStore(dir);
    await store.init();
    const x = await store.create({ ...input, title: 'X' }, 'o', 'off');
    const y = await store.create({ ...input, title: 'Y' }, 'o', 'pending');
    await store.update(x.id, { status: 'transcribing', job: { mode: 'all' } });
    await store.update(y.id, { status: 'done', summary: normalizeSummary({}, 'Y') });
    const fake = fakeStages(store);
    new Processor(store, loadConfig({}), new Telegram({ token: '', chatId: '', apiBase: '' }), fake.stages).resume();
    await vi.waitFor(() => expect(fake.calls.sort()).toEqual(['deliver Y', 'prepare X']));
  });
});

describe('slow responses', () => {
  it(
    'lets fetch wait for a server that answers late (undici gives up after 5 minutes by default)',
    { timeout: 15_000 },
    async () => {
      const server = http.createServer((_req, res) => void setTimeout(() => res.end('ok'), 2500));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
      try {
        // undici checks its timeouts about once a second.
        allowSlowResponses(500);
        await expect(fetch(url)).rejects.toThrow();
        allowSlowResponses(10_000);
        expect(await (await fetch(url)).text()).toBe('ok');
      } finally {
        allowSlowResponses();
        server.close();
      }
    },
  );
});
