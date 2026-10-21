import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { imageFileName } from '@/lib/format';
import { normalizeSummary } from '@/lib/prompts';
import type { MeetingOptions } from '@/lib/server-api';
import { Bot, cardKeyboard } from '../../server/src/bot';
import { MeetingStore, type Meeting } from '../../server/src/store';
import { MESSAGE_LIMIT, sectionPages, type Keyboard } from '../../server/src/telegram';

const options: MeetingOptions = {
  language: 'id',
  vocabulary: '',
  outputLanguage: '',
  customInstructions: '',
  perTopic: 2,
  includeTranscript: true,
  analyze: true,
  telegramChatId: '',
};
const jpeg = new Uint8Array([0xff, 0xd8, 1, 2]);

const raw = {
  executiveSummary: 'Ringkasan rapat.',
  keyPoints: ['Grey box'],
  topics: [
    { title: 'Jadwal', time: '00:07:00', summary: 'Jadwal dibahas.', points: ['21 Okt'], images: [{ id: 1, caption: 'Gantt' }] },
    { title: 'Scope', time: '00:08:53', summary: 'Dua scope.', points: [], images: [] },
  ],
  decisions: [{ decision: 'Grey box' }],
  actionItems: [{ task: 'Kirim akun', owner: 'Pak Adi' }],
  nextSteps: ['Mulai 21 Oktober'],
};

type Call = { method: string; chat: string; text?: string; keyboard?: Keyboard; photos?: number; filename?: string };

/** A Telegram API that records what the bot sends; the server's default chat is 42. */
function fakeApi() {
  const calls: Call[] = [];
  const api = {
    chatFor: (override?: string) => override?.trim() || '42',
    getUpdates: async () => [],
    setMyCommands: async () => {},
    answerCallbackQuery: async () => {},
    sendMessage: async (chat: string, text: string, keyboard?: Keyboard) =>
      void calls.push({ method: 'send', chat, text, keyboard }),
    editMessageText: async (chat: string, _id: number, text: string, keyboard?: Keyboard) =>
      void calls.push({ method: 'edit', chat, text, keyboard }),
    sendPhotos: async (chat: string, photos: unknown[]) => void calls.push({ method: 'photos', chat, photos: photos.length }),
    sendDocument: async (chat: string, _data: Uint8Array, filename: string) =>
      void calls.push({ method: 'document', chat, filename }),
  };
  return { calls, api: api as unknown as ConstructorParameters<typeof Bot>[1] };
}

const buttons = (call?: Call) => (call?.keyboard ?? []).flat();
const message = (chat: number, text: string) => ({ update_id: 1, message: { message_id: 1, text, chat: { id: chat } } });
const press = (chat: number, data: string) => ({
  update_id: 2,
  callback_query: { id: 'q', data, message: { message_id: 9, chat: { id: chat } } },
});

describe('telegram bot', () => {
  let dir = '';
  let store: MeetingStore;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bot-'));
    store = new MeetingStore(dir);
    await store.init();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function minutes(title: string, chat = '', startedAt = Date.UTC(2026, 9, 20, 7)): Promise<Meeting> {
    const m = await store.create(
      {
        title,
        platform: 'meet',
        startedAt,
        durationMs: 1_800_000,
        hasMic: true,
        notes: '',
        template: 'general',
        options: { ...options, telegramChatId: chat },
      },
      'owner',
      'sent',
    );
    await store.putFrame(m.id, { id: 1, t: 420_000, width: 1280, height: 720 }, jpeg);
    await store.writeOutput(m.id, imageFileName(420_000), jpeg);
    await store.writeOutput(m.id, 'minutes.pdf', '%PDF-1.4');
    await store.update(m.id, { status: 'done', summary: normalizeSummary({ ...raw, title }, title) });
    return store.get(m.id)!;
  }

  it('lists only the minutes sent to the chat, as name buttons that open their card', async () => {
    const a = await minutes('Kick Off <M-Gate>');
    await minutes('Other team', '777');
    const { calls, api } = fakeApi();
    const bot = new Bot(store, api, path.join(dir, 'chats.json'));

    await bot.handle(message(42, '/notulen'));
    expect(calls[0]!.chat).toBe('42');
    expect(buttons(calls[0]).map((b) => b.callback_data)).toEqual([`c:${a.id}`]);
    expect(buttons(calls[0])[0]!.text).toContain('Kick Off <M-Gate>');

    await bot.handle(press(42, `c:${a.id}`));
    expect(calls[1]).toMatchObject({ method: 'edit', chat: '42' });
    expect(calls[1]!.text).toContain('<b>Kick Off &lt;M-Gate&gt;</b>');
    expect(buttons(calls[1]).map((b) => b.text)).toEqual(
      cardKeyboard(a)
        .flat()
        .map((b) => b.text),
    );
    expect(buttons(calls[1]).map((b) => b.text)).toContain('Action Items (1)');
  });

  it('opens the parts of a card, a topic with its slides, the slides and the PDF', async () => {
    const a = await minutes('Kick Off');
    const { calls, api } = fakeApi();
    const bot = new Bot(store, api, path.join(dir, 'chats.json'));

    await bot.handle(press(42, `s:${a.id}:actions:0`));
    expect(calls.at(-1)!.text).toContain('• Kirim akun — <i>Pak Adi</i>');
    expect(buttons(calls.at(-1)).map((b) => b.callback_data)).toEqual([`c:${a.id}`]);

    await bot.handle(press(42, `T:${a.id}:0`));
    expect(buttons(calls.at(-1)).map((b) => b.text)).toEqual(['00:07:00 · Jadwal', '00:08:53 · Scope', '« Card']);

    await bot.handle(press(42, `t:${a.id}:0:0`));
    expect(calls.at(-2)!.text).toContain('Jadwal dibahas.');
    expect(calls.at(-1)).toMatchObject({ method: 'photos', chat: '42', photos: 1 });

    await bot.handle(press(42, `i:${a.id}`));
    expect(calls.at(-1)).toMatchObject({ method: 'photos', photos: 1 });
    await bot.handle(press(42, `p:${a.id}`));
    expect(calls.at(-1)).toMatchObject({ method: 'document', filename: 'Kick Off.pdf' });
  });

  it('shows nothing of other chats', async () => {
    const a = await minutes('Kick Off');
    const { calls, api } = fakeApi();
    const bot = new Bot(store, api, path.join(dir, 'chats.json'));

    await bot.handle(message(999, '/notulen'));
    expect(calls[0]!.text).toContain('999');
    expect(calls[0]!.keyboard).toBeUndefined();
    await bot.handle(press(999, `c:${a.id}`));
    expect(calls[1]!.text).not.toContain('Kick Off');
    await bot.handle(press(999, `p:${a.id}`));
    expect(calls.some((c) => c.method === 'document')).toBe(false);
  });

  it('pages the list and searches the minutes', async () => {
    for (let i = 0; i < 10; i++) await minutes(`Meeting ${i}`, '', Date.UTC(2026, 9, i + 1));
    const { calls, api } = fakeApi();
    const bot = new Bot(store, api, path.join(dir, 'chats.json'));

    await bot.handle(message(42, '/notulen'));
    const first = buttons(calls[0]);
    expect(first).toHaveLength(9);
    expect(first[0]!.text).toContain('Meeting 9');
    expect(first.at(-1)).toMatchObject({ text: '›', callback_data: 'l:1' });
    await bot.handle(press(42, 'l:1'));
    expect(buttons(calls[1]).map((b) => b.text)).toEqual([
      expect.stringContaining('Meeting 1'),
      expect.stringContaining('Meeting 0'),
      '‹',
    ]);

    await bot.handle(message(42, '/cari meeting 3'));
    expect(buttons(calls[2])).toHaveLength(1);
    await bot.handle(message(42, '/cari pak adi'));
    expect(buttons(calls[3])).toHaveLength(8);
    await bot.handle(message(42, '/cari nothing-like-this'));
    expect(calls[4]!.keyboard).toBeUndefined();
  });

  it('remembers the chats that wrote to it, for picking the chat id in the extension', async () => {
    const { api } = fakeApi();
    const file = path.join(dir, 'chats.json');
    const bot = new Bot(store, api, file);
    await bot.handle({ update_id: 1, message: { message_id: 1, text: '/start', chat: { id: 5, title: 'Group' } } });
    await bot.handle({ update_id: 2, message: { message_id: 2, text: '/start', chat: { id: 777, first_name: 'Budi' } } });
    expect(bot.recentChats()).toEqual([
      { id: '777', title: 'Budi' },
      { id: '5', title: 'Group' },
    ]);
    expect(existsSync(file)).toBe(true);
  });

  it('splits long parts into pages that fit in a message', async () => {
    const a = await minutes('Long');
    const s = { ...a.summary!, actionItems: Array.from({ length: 300 }, (_, i) => ({ task: `Task ${i} `.repeat(5) })) };
    const pages = sectionPages(a, s, 'actions');
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
  });
});

describe('retention', () => {
  let dir = '';
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('keeps the minutes after the audio and screenshots are gone, then deletes them too', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'retention-'));
    const store = new MeetingStore(dir);
    await store.init();
    const day = 86_400_000;
    const make = async (title: string, ageDays: number, withMinutes: boolean) => {
      const m = await store.create(
        { title, platform: 'meet', startedAt: 1, durationMs: 1, hasMic: true, notes: '', template: 'general', options },
        'owner',
        'off',
      );
      await store.putAudio(m.id, { index: 0, startMs: 0, endMs: 1, bytes: 1 }, new Uint8Array([1]));
      await store.writeOutput(m.id, 'images/slide.jpg', jpeg);
      await store.update(m.id, {
        createdAt: Date.now() - ageDays * day,
        status: withMinutes ? 'done' : 'error',
        summary: withMinutes ? normalizeSummary({}, title) : undefined,
      });
      return m.id;
    };
    const fresh = await make('fresh', 1, true);
    const old = await make('old', 8, true);
    const failed = await make('failed', 8, false);
    const ancient = await make('ancient', 400, true);
    const busy = await make('busy', 400, true);

    const done = await store.expire(7, 365, (id) => id === busy);
    expect(done).toEqual({ pruned: [old], removed: [failed, ancient] });
    expect(store.get(old)!.pruned).toBe(true);
    expect(existsSync(store.path(old, 'audio'))).toBe(false);
    expect(existsSync(store.path(old, 'images/slide.jpg'))).toBe(true);
    expect(store.get(fresh)!.pruned).toBeUndefined();
    expect(store.get(busy)).toBeDefined();
  });
});
