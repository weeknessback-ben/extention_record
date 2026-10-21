// The Telegram bot's commands: /notulen lists the minutes of a chat as cards, /cari searches them, and
// the buttons of a card open one part (summary, topics, decisions, action items), the slides or the PDF.
import { readFile, writeFile } from 'node:fs/promises';
import { sanitizeSegment } from '@/lib/files';
import { formatDate, formatDuration, imageFileName, labelsFor, platformName } from '@/lib/format';
import { t } from '@/lib/i18n';
import { log } from './log';
import type { Meeting, MeetingStore } from './store';
import {
  chatTitle,
  escapeTelegram,
  photoCaption,
  sectionPages,
  SECTIONS,
  topicPages,
  type Keyboard,
  type Section,
  type Telegram,
  type TelegramChatInfo,
  type TelegramUpdate,
} from './telegram';

const LIST_PAGE = 8;
const TOPICS_PAGE = 10;
const BUTTON_TEXT = 60;
const POLL_SECONDS = 50;
const MAX_CHATS = 50;

type Api = Pick<
  Telegram,
  | 'chatFor'
  | 'getUpdates'
  | 'setMyCommands'
  | 'sendMessage'
  | 'editMessageText'
  | 'answerCallbackQuery'
  | 'sendPhotos'
  | 'sendDocument'
>;

const e = escapeTelegram;
const short = (s: string) => (s.length > BUTTON_TEXT ? `${s.slice(0, BUTTON_TEXT - 1)}…` : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const button = (text: string, data: string) => ({ text: short(text), callback_data: data });

/** Previous / next page buttons, when there is more than one page. */
function pager(page: number, pages: number, data: (page: number) => string): Keyboard {
  const row = [];
  if (page > 0) row.push(button('‹', data(page - 1)));
  if (page < pages - 1) row.push(button('›', data(page + 1)));
  return row.length ? [row] : [];
}

function pairs<T>(items: T[]): T[][] {
  return items.flatMap((item, i) => (i % 2 ? [] : [items.slice(i, i + 2)]));
}

/** The card of a meeting: title, date, length and how much there is in each part. */
export function cardText(m: Meeting): string {
  const s = m.summary!;
  return [
    `<b>${e(s.title || m.title)}</b>`,
    e(`${formatDate(m.startedAt, s.language)} · ${formatDuration(m.durationMs)} · ${platformName(m.platform)}`),
    e(
      t('telegram.counts', {
        topics: s.topics.length,
        decisions: s.decisions.length,
        actions: s.actionItems.length,
        slides: s.topics.reduce((n, topic) => n + topic.images.length, 0),
      }),
    ),
  ].join('\n');
}

/** The buttons of a card; parts without content are left out. */
export function cardKeyboard(m: Meeting, withList = true): Keyboard {
  const s = m.summary!;
  const L = labelsFor(s);
  const id = m.id;
  const slides = s.topics.reduce((n, topic) => n + topic.images.length, 0);
  const buttons = [
    button(L.executiveSummary, `s:${id}:summary:0`),
    s.keyPoints.length && button(L.keyPoints, `s:${id}:keyPoints:0`),
    s.topics.length && button(`${L.topics} (${s.topics.length})`, `T:${id}:0`),
    s.decisions.length && button(`${L.decisions} (${s.decisions.length})`, `s:${id}:decisions:0`),
    s.actionItems.length && button(`${L.actionItems} (${s.actionItems.length})`, `s:${id}:actions:0`),
    (s.openQuestions.length || s.nextSteps.length) && button(t('telegram.more'), `s:${id}:more:0`),
    slides && button(`${t('telegram.slides')} (${slides})`, `i:${id}`),
    button('PDF', `p:${id}`),
  ].filter((b) => typeof b === 'object');
  return [...pairs(buttons), ...(withList ? [[button(t('telegram.backList'), 'l:0')]] : [])];
}

/** Everything a search looks at: titles and the text of every part. */
function searchText(m: Meeting): string {
  const s = m.summary!;
  return [
    m.title,
    s.title,
    s.executiveSummary,
    ...s.keyPoints,
    ...s.topics.flatMap((topic) => [topic.title, topic.summary, ...topic.points]),
    ...s.decisions.flatMap((d) => [d.decision, d.context ?? '']),
    ...s.actionItems.flatMap((a) => [a.task, a.owner ?? '', a.deadline ?? '']),
    ...s.openQuestions,
    ...s.nextSteps,
    ...s.participants.map((p) => p.name),
  ]
    .join('\n')
    .toLowerCase();
}

/** Answers commands and card buttons, by long polling (no public webhook needed). */
export class Bot {
  private offset = 0;
  private stopped = false;
  /** Chats that wrote to the bot, oldest first, for picking the chat id in the extension. */
  private chats = new Map<string, string>();

  constructor(
    private store: MeetingStore,
    private api: Api,
    private chatsFile: string,
  ) {}

  async start(): Promise<void> {
    try {
      this.chats = new Map(JSON.parse(await readFile(this.chatsFile, 'utf8')) as [string, string][]);
    } catch {
      // First start: no chats yet.
    }
    await this.api
      .setMyCommands([
        { command: 'notulen', description: t('telegram.cmdList') },
        { command: 'cari', description: t('telegram.cmdSearch') },
        { command: 'help', description: t('telegram.cmdHelp') },
      ])
      .catch((err: Error) => log('bot: setMyCommands failed', err.message));
    while (!this.stopped) {
      try {
        const updates = await this.api.getUpdates(this.offset, POLL_SECONDS);
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handle(update).catch((err: Error) => log('bot error', err.message));
        }
      } catch (err) {
        if (this.stopped) break;
        log('bot polling error', (err as Error).message);
        await sleep(5000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** Chats that wrote to the bot, newest first. */
  recentChats(): { id: string; title: string }[] {
    return [...this.chats].reverse().map(([id, title]) => ({ id, title }));
  }

  async handle(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      const { chat, text = '' } = update.message;
      await this.remember(chat);
      await this.command(String(chat.id), text.trim());
      return;
    }
    const q = update.callback_query;
    if (!q) return;
    // Answered first, so the button stops spinning even while a PDF is being sent.
    await this.api.answerCallbackQuery(q.id).catch(() => {});
    if (q.message) await this.press(String(q.message.chat.id), q.message.message_id, q.data ?? '');
  }

  private async remember(chat: TelegramChatInfo): Promise<void> {
    const id = String(chat.id);
    this.chats.delete(id);
    this.chats.set(id, chatTitle(chat) || id);
    while (this.chats.size > MAX_CHATS) this.chats.delete(this.chats.keys().next().value!);
    await writeFile(this.chatsFile, JSON.stringify([...this.chats])).catch(() => {});
  }

  /** The minutes a chat may see: those that were sent to it, newest first. */
  private minutes(chatId: string): Meeting[] {
    return this.store
      .list()
      .filter((m) => m.summary && this.api.chatFor(m.options.telegramChatId) === chatId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  private visible(chatId: string, id: string): Meeting | undefined {
    const m = this.store.get(id);
    return m?.summary && this.api.chatFor(m.options.telegramChatId) === chatId ? m : undefined;
  }

  /** The server's default chat, or a chat that already has minutes. */
  private known(chatId: string): boolean {
    return this.api.chatFor('') === chatId || this.minutes(chatId).length > 0;
  }

  private reply(chatId: string, messageId: number | undefined, html: string, keyboard?: Keyboard): Promise<void> {
    return messageId === undefined
      ? this.api.sendMessage(chatId, html, keyboard)
      : this.api.editMessageText(chatId, messageId, html, keyboard);
  }

  private async command(chatId: string, text: string): Promise<void> {
    const [first = '', ...rest] = text.split(/\s+/);
    const name = first.replace(/@\w+$/, '').toLowerCase();
    if (name === '/notulen' || name === '/list') return this.list(chatId, 0);
    if (name === '/cari' || name === '/search') return this.search(chatId, rest.join(' ').trim());
    const help = t('telegram.help');
    await this.api.sendMessage(chatId, this.known(chatId) ? help : `${help}\n\n${e(t('telegram.unknownChat', { id: chatId }))}`);
  }

  private async list(chatId: string, page: number, messageId?: number): Promise<void> {
    const all = this.minutes(chatId);
    if (!all.length) {
      const text = this.known(chatId) ? t('telegram.listEmpty') : t('telegram.unknownChat', { id: chatId });
      return this.reply(chatId, messageId, e(text));
    }
    const pages = Math.ceil(all.length / LIST_PAGE);
    page = Math.min(Math.max(0, page), pages - 1);
    const shown = all.slice(page * LIST_PAGE, (page + 1) * LIST_PAGE);
    const text = t('telegram.list', { from: page * LIST_PAGE + 1, to: page * LIST_PAGE + shown.length, total: all.length });
    const keyboard = [...shown.map((m) => [this.entry(m)]), ...pager(page, pages, (p) => `l:${p}`)];
    return this.reply(chatId, messageId, e(text), keyboard);
  }

  /** A list entry: just the date and the name of the minutes. */
  private entry(m: Meeting) {
    let day = '';
    try {
      day = new Date(m.startedAt).toLocaleDateString(m.summary!.language || undefined, { day: 'numeric', month: 'short' });
    } catch {
      day = new Date(m.startedAt).toISOString().slice(0, 10);
    }
    return button(`${day} · ${m.summary!.title || m.title}`, `c:${m.id}`);
  }

  private async search(chatId: string, query: string): Promise<void> {
    if (!query) return this.api.sendMessage(chatId, e(t('telegram.searchUsage')));
    const q = query.toLowerCase();
    const hits = this.minutes(chatId).filter((m) => searchText(m).includes(q));
    if (!hits.length) return this.api.sendMessage(chatId, e(t('telegram.searchNone', { q: query })));
    const keyboard = hits.slice(0, LIST_PAGE).map((m) => [this.entry(m)]);
    return this.api.sendMessage(chatId, e(t('telegram.searchResults', { n: hits.length, q: query })), keyboard);
  }

  private async press(chatId: string, messageId: number, data: string): Promise<void> {
    const [kind = '', id = '', a = '', b = ''] = data.split(':');
    if (kind === 'l') return this.list(chatId, Number(id) || 0, messageId);
    const m = this.visible(chatId, id);
    if (!m) return this.reply(chatId, messageId, e(t('telegram.gone')));
    const s = m.summary!;
    const backToCard = [button(t('telegram.backCard'), `c:${id}`)];

    switch (kind) {
      case 'c':
        return this.reply(chatId, messageId, cardText(m), cardKeyboard(m));
      case 's': {
        if (!SECTIONS.includes(a as Section)) return;
        const pages = sectionPages(m, s, a as Section);
        const page = Math.min(Math.max(0, Number(b) || 0), pages.length - 1);
        const nav = pager(page, pages.length, (p) => `s:${id}:${a}:${p}`);
        return this.reply(chatId, messageId, pages[page]!, [...nav, backToCard]);
      }
      case 'T': {
        const pages = Math.ceil(s.topics.length / TOPICS_PAGE);
        const page = Math.min(Math.max(0, Number(a) || 0), Math.max(0, pages - 1));
        const topics = s.topics
          .slice(page * TOPICS_PAGE, (page + 1) * TOPICS_PAGE)
          .map((topic, i) => [
            button(`${topic.time ? `${topic.time} · ` : ''}${topic.title}`, `t:${id}:${page * TOPICS_PAGE + i}:0`),
          ]);
        const text = `<b>${e(s.title || m.title)}</b>\n\n${e(t('telegram.topicsTitle'))}`;
        return this.reply(chatId, messageId, text, [...topics, ...pager(page, pages, (p) => `T:${id}:${p}`), backToCard]);
      }
      case 't': {
        const index = Number(a) || 0;
        const pages = topicPages(m, s, index);
        if (!pages.length) return;
        const page = Math.min(Math.max(0, Number(b) || 0), pages.length - 1);
        const back = [button(t('telegram.backTopics'), `T:${id}:${Math.floor(index / TOPICS_PAGE)}`), ...backToCard];
        await this.reply(chatId, messageId, pages[page]!, [...pager(page, pages.length, (p) => `t:${id}:${index}:${p}`), back]);
        // The slides of the topic follow the text (only when the topic is opened, not when paging).
        if (page === 0) await this.sendSlides(chatId, m, [index]);
        return;
      }
      case 'i':
        if (
          !(await this.sendSlides(
            chatId,
            m,
            s.topics.map((_, i) => i),
          ))
        ) {
          await this.api.sendMessage(chatId, e(t('telegram.noSlides')));
        }
        return;
      case 'p': {
        const pdf = await readFile(this.store.path(id, 'minutes.pdf')).catch(() => undefined);
        if (!pdf) return this.api.sendMessage(chatId, e(t('telegram.noPdf')));
        const title = s.title || m.title;
        return this.api.sendDocument(chatId, pdf, `${sanitizeSegment(title)}.pdf`, title);
      }
    }
  }

  /** Sends the slides chosen for some topics; false when there are none. */
  private async sendSlides(chatId: string, m: Meeting, topics: number[]): Promise<boolean> {
    const frames = new Map(m.frames.map((f) => [f.id, f]));
    const photos = [];
    for (const i of topics) {
      const topic = m.summary!.topics[i];
      for (const img of topic?.images ?? []) {
        const frame = frames.get(img.id);
        const data = frame && (await readFile(this.store.path(m.id, imageFileName(frame.t))).catch(() => undefined));
        if (data) photos.push({ data, caption: photoCaption(topic!, img.caption) });
      }
    }
    if (photos.length) await this.api.sendPhotos(chatId, photos);
    return photos.length > 0;
  }
}
