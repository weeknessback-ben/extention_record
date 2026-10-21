import { formatDate, formatDuration, labelsFor, platformName } from '@/lib/format';
import type { MeetingSummary, Recording } from '@/lib/types';
import type { TelegramConfig } from './config';

export const MESSAGE_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;
const ALBUM_SIZE = 10;

/** Inline buttons under a message: rows of (label, data sent back when pressed). */
export type Keyboard = { text: string; callback_data: string }[][];

export interface TelegramChatInfo {
  id: number;
  type?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; text?: string; chat: TelegramChatInfo };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: TelegramChatInfo } };
}

/** Display name of a Telegram chat: group or channel title, or a person's name. */
export function chatTitle(chat: { title?: string; first_name?: string; last_name?: string; username?: string }): string {
  return chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : '');
}

/** Telegram's HTML parse mode only needs these three escaped. */
export function escapeTelegram(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Splits text into pieces of at most `max` characters, at line breaks or spaces when possible. */
export function splitText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Packs HTML lines into messages under the limit; a line that is too long on its own is sent as plain text. */
function pack(lines: string[], max = MESSAGE_LIMIT): string[] {
  const messages: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) messages.push(current.trim());
    current = '';
  };
  for (const line of lines) {
    const pieces = line.length > max ? splitText(line.replace(/<\/?[bi]>/g, ''), max) : [line];
    for (const piece of pieces) {
      if (current && current.length + 1 + piece.length > max) flush();
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  flush();
  return messages;
}

/** The parts of the minutes that can be opened one by one from a card. */
export const SECTIONS = ['summary', 'keyPoints', 'decisions', 'actions', 'more'] as const;
export type Section = (typeof SECTIONS)[number];

const e = escapeTelegram;
const bullets = (items: string[]) => items.map((i) => `• ${e(i)}`);
const block = (title: string, body: string[]) => (body.length ? ['', `<b>${e(title)}</b>`, ...body] : []);

/** Title, date · duration · platform, and the participants. */
function headerLines(rec: Recording, s: MeetingSummary): string[] {
  const L = labelsFor(s);
  const lines = [
    `<b>${e(s.title || rec.title)}</b>`,
    e(`${formatDate(rec.startedAt, s.language)} · ${formatDuration(rec.durationMs)} · ${platformName(rec.platform)}`),
  ];
  if (s.participants.length) {
    lines.push(e(`${L.participants}: ${s.participants.map((p) => (p.role ? `${p.name} (${p.role})` : p.name)).join(', ')}`));
  }
  return lines;
}

/** HTML lines of one part of the minutes, starting with an empty line and its heading. */
function sectionBody(s: MeetingSummary, section: Section): string[] {
  const L = labelsFor(s);
  switch (section) {
    case 'summary':
      return block(
        L.executiveSummary,
        s.executiveSummary
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean)
          .flatMap((p, i) => (i ? ['', e(p)] : [e(p)])),
      );
    case 'keyPoints':
      return block(L.keyPoints, bullets(s.keyPoints));
    case 'decisions':
      return block(
        L.decisions,
        s.decisions.map((d, i) => `${i + 1}. ${e(d.decision)}${d.context ? ` <i>(${e(d.context)})</i>` : ''}`),
      );
    case 'actions':
      return block(
        L.actionItems,
        s.actionItems.map((a) => {
          const meta = [a.owner, a.deadline, a.priority].filter(Boolean).join(' · ');
          return `• ${e(a.task)}${meta ? ` — <i>${e(meta)}</i>` : ''}`;
        }),
      );
    case 'more':
      return [...block(L.openQuestions, bullets(s.openQuestions)), ...block(L.nextSteps, bullets(s.nextSteps))];
  }
}

/** The minutes as Telegram HTML messages: header, summary, key points, decisions, action items, next steps. */
export function summaryMessages(rec: Recording, s: MeetingSummary): string[] {
  return pack([...headerLines(rec, s), ...SECTIONS.flatMap((section) => sectionBody(s, section))]);
}

/** One part of the minutes as pages (one message each), under the meeting title; the summary keeps the full header. */
export function sectionPages(rec: Recording, s: MeetingSummary, section: Section): string[] {
  const head = section === 'summary' ? headerLines(rec, s) : [`<b>${e(s.title || rec.title)}</b>`];
  return pack([...head, ...sectionBody(s, section)]);
}

/** One topic: time and title, what was discussed and its points. */
export function topicPages(rec: Recording, s: MeetingSummary, index: number): string[] {
  const topic = s.topics[index];
  if (!topic) return [];
  return pack([
    `<b>${e(s.title || rec.title)}</b>`,
    '',
    `<b>${e(`${topic.time ? `${topic.time} · ` : ''}${topic.title}`)}</b>`,
    ...(topic.summary ? [e(topic.summary)] : []),
    ...bullets(topic.points),
  ]);
}

/** Plain-text caption of a slide in the album: topic, time and what the image shows. */
export function photoCaption(topic: { title: string; time?: string }, caption: string): string {
  const text = [`${topic.time ? `[${topic.time}] ` : ''}${topic.title}`, caption].filter(Boolean).join('\n');
  return text.length > CAPTION_LIMIT ? `${text.slice(0, CAPTION_LIMIT - 1)}…` : text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TelegramReply<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export class Telegram {
  constructor(private cfg: TelegramConfig) {}

  /** A bot token is set; each meeting may still lack a chat (see chatFor). */
  get enabled(): boolean {
    return Boolean(this.cfg.token);
  }

  /** The chat a meeting's minutes go to: the one chosen in the extension, else the server default. */
  chatFor(override?: string): string {
    return override?.trim() || this.cfg.chatId;
  }

  /** Bot API call with retries on rate limits and server errors. Errors never contain the token. */
  private async call<T>(method: string, body: FormData | Record<string, unknown>, attempts = 4): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      let failure = '';
      try {
        res = await fetch(`${this.cfg.apiBase}/bot${this.cfg.token}/${method}`, {
          method: 'POST',
          ...(body instanceof FormData
            ? { body }
            : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        failure = `network error (${(err as Error).name})`;
      }
      const data = res ? ((await res.json().catch(() => ({}))) as TelegramReply<T>) : undefined;
      if (data?.ok) return data.result as T;
      const retryable = !res || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= attempts) {
        throw new Error(`Telegram ${method}: ${data?.description ?? (failure || `HTTP ${res?.status}`)}`);
      }
      await sleep((data?.parameters?.retry_after ?? 2 ** attempt) * 1000);
    }
  }

  getMe(): Promise<{ username?: string }> {
    return this.call('getMe', {}, 1);
  }

  getChat(chatId: string): Promise<{ title?: string; first_name?: string; last_name?: string; username?: string }> {
    return this.call('getChat', { chat_id: chatId }, 1);
  }

  /** Long-polls for messages and button presses; confirms everything before `offset`. */
  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.call('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] }, 1);
  }

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.call('setMyCommands', { commands }, 1);
  }

  async sendMessage(chatId: string, html: string, keyboard?: Keyboard): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  /** Replaces the text and buttons of a message the bot sent (an unchanged message is fine). */
  async editMessageText(chatId: string, messageId: number, html: string, keyboard?: Keyboard): Promise<void> {
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }).catch((err: Error) => {
      if (!/message is not modified/i.test(err.message)) throw err;
    });
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }, 1);
  }

  /** Sends photos as albums of up to ten (a single photo on its own). */
  async sendPhotos(chatId: string, photos: { data: Uint8Array; caption: string }[]): Promise<void> {
    for (let i = 0; i < photos.length; i += ALBUM_SIZE) {
      const album = photos.slice(i, i + ALBUM_SIZE);
      const form = new FormData();
      form.append('chat_id', chatId);
      const file = (data: Uint8Array) => new Blob([data as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
      if (album.length === 1) {
        form.append('photo', file(album[0]!.data), 'slide.jpg');
        form.append('caption', album[0]!.caption);
        await this.call('sendPhoto', form);
        continue;
      }
      album.forEach((p, n) => form.append(`p${n}`, file(p.data), `slide-${n}.jpg`));
      form.append('media', JSON.stringify(album.map((p, n) => ({ type: 'photo', media: `attach://p${n}`, caption: p.caption }))));
      await this.call('sendMediaGroup', form);
    }
  }

  async sendDocument(chatId: string, data: Uint8Array, filename: string, caption: string): Promise<void> {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), filename);
    form.append('caption', caption.slice(0, CAPTION_LIMIT));
    await this.call('sendDocument', form);
  }
}
