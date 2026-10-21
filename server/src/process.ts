import { blobToDataUrl } from '@/lib/ai';
import { sanitizeSegment } from '@/lib/files';
import { imageFileName, summaryToMarkdown, transcriptToText } from '@/lib/format';
import { t } from '@/lib/i18n';
import { prepareRecording, summarizeRecording, type ProcessMode } from '@/lib/pipeline-core';
import type { TemplateId } from '@/lib/types';
import { meetingSettings, type ServerConfig } from './config';
import { htmlToPdf, minutesHtml } from './pdf';
import { isProcessing, type FrameMeta, type MeetingStore } from './store';
import { cardKeyboard, cardText } from './bot';
import { escapeTelegram, photoCaption, summaryMessages, type Telegram } from './telegram';

import { log } from './log';

export { log };

export { isProcessing };

/** A queue that runs one job at a time. */
class Lane {
  private queue: string[] = [];
  running?: string;

  constructor(
    readonly name: string,
    private work: (id: string) => Promise<void>,
  ) {}

  get waiting(): number {
    return this.queue.length;
  }

  has(id: string): boolean {
    return this.running === id || this.queue.includes(id);
  }

  /** Queues a job; with `again`, also when it is running right now (it then runs once more afterwards). */
  add(id: string, again = false): void {
    if (this.queue.includes(id) || (this.running === id && !again)) return;
    this.queue.push(id);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    while (this.queue.length) {
      const id = this.queue.shift()!;
      this.running = id;
      try {
        await this.work(id);
      } catch (err) {
        log(`${this.name} job failed`, id, (err as Error).message);
      } finally {
        this.running = undefined;
      }
    }
  }
}

/** The pipeline stages, replaceable in tests. */
export interface Stages {
  prepare: typeof prepareRecording;
  summarize: typeof summarizeRecording;
  deliver: (id: string) => Promise<void>;
}

/**
 * Two lanes, one job each: the CPU lane transcribes and reads screenshots (the speech-to-text and vision
 * servers share two cores), the summary lane calls the external LLM, prints the PDF and sends to Telegram.
 * A meeting moves to the summary lane when its CPU work is done, so the next meeting's transcription starts
 * meanwhile, and "re-summarise" never waits behind another meeting's transcription.
 */
export class Processor {
  private cpu = new Lane('cpu', (id) => (this.store.get(id)?.live ? this.warmUp(id) : this.prepare(id)));
  private summary = new Lane('summary', (id) => this.finish(id));
  private stages: Stages;

  constructor(
    private store: MeetingStore,
    private config: ServerConfig,
    private telegram: Telegram,
    stages: Partial<Stages> = {},
  ) {
    this.stages = { prepare: prepareRecording, summarize: summarizeRecording, deliver: (id) => this.deliver(id), ...stages };
  }

  /** Meetings being worked on, per lane. */
  get running(): { cpu: string | null; summary: string | null } {
    return { cpu: this.cpu.running ?? null, summary: this.summary.running ?? null };
  }

  get waiting(): number {
    return this.cpu.waiting + this.summary.waiting;
  }

  isBusy(id: string): boolean {
    return this.cpu.has(id) || this.summary.has(id);
  }

  async enqueue(id: string, mode: ProcessMode, template?: TemplateId): Promise<void> {
    await this.store.update(id, {
      job: { mode, template },
      status: 'queued',
      error: undefined,
      progress: undefined,
      telegram: this.chat(id) ? 'pending' : 'off',
      telegramError: undefined,
    });
    this.route(id);
  }

  /** A live meeting got new audio or screenshots: process what has arrived so far. */
  warm(id: string): void {
    this.cpu.add(id, true);
  }

  async redeliver(id: string): Promise<void> {
    await this.store.update(id, (m) => ({ job: { mode: m.job?.mode ?? 'all', deliverOnly: true }, telegram: 'pending' }));
    this.route(id);
  }

  /** Picks up work that was cut short by a restart. */
  resume(): void {
    for (const m of this.store.list().sort((a, b) => a.createdAt - b.createdAt)) {
      if (isProcessing(m.status) || (m.status === 'done' && (m.telegram === 'pending' || m.telegram === 'sending'))) {
        log('resuming', m.id, m.status);
        this.route(m.id);
      }
    }
  }

  /** Re-summarising with a transcript, or only delivering, needs no CPU work. */
  private route(id: string): void {
    const m = this.store.get(id);
    if (!m) return;
    const summaryOnly =
      (m.job?.deliverOnly && m.summary) ||
      (m.status === 'done' && !m.job && m.summary) ||
      (m.job?.mode === 'summarize' && m.transcript);
    // A finished recording whose early processing is still running must be prepared once more after it.
    if (summaryOnly) this.summary.add(id);
    else this.cpu.add(id, true);
  }

  /** The Telegram chat of a meeting, or '' when nothing should be sent. */
  private chat(id: string): string {
    return this.telegram.enabled ? this.telegram.chatFor(this.store.get(id)?.options.telegramChatId) : '';
  }

  private settingsFor(id: string) {
    return meetingSettings(this.config.settings, this.store.get(id)!.options);
  }

  /** CPU lane, while the meeting is still recorded: transcribe and read what has arrived. Errors wait for the end. */
  private async warmUp(id: string): Promise<void> {
    try {
      await this.stages.prepare(this.store.pipeline(id), this.settingsFor(id), 'all');
    } catch (err) {
      log('early processing failed, retried when the recording ends', id, (err as Error).message);
    }
  }

  /** CPU lane: transcription and screenshots, then hand over to the summary lane. */
  private async prepare(id: string): Promise<void> {
    const meeting = this.store.get(id);
    if (!meeting) return;
    const mode = meeting.job?.mode ?? 'all';
    log('processing', id, mode, `${meeting.audioSegments.length} audio, ${meeting.frames.length} frames`);
    try {
      await this.stages.prepare(this.store.pipeline(id), this.settingsFor(id), mode);
    } catch (err) {
      return this.failed(id, err as Error);
    }
    if (this.summary.running) await this.store.update(id, { status: 'queued', progress: undefined });
    this.summary.add(id);
  }

  /** Summary lane: the minutes (unless only delivering again), then the files and Telegram. */
  private async finish(id: string): Promise<void> {
    const meeting = this.store.get(id);
    if (!meeting) return;
    const deliverOnly = (meeting.job?.deliverOnly || (meeting.status === 'done' && !meeting.job)) && meeting.summary;
    if (!deliverOnly) {
      try {
        await this.stages.summarize(this.store.pipeline(id), this.settingsFor(id), meeting.job?.template);
      } catch (err) {
        return this.failed(id, err as Error);
      }
    }
    await this.store.update(id, { job: undefined });
    await this.stages.deliver(id);
  }

  private async failed(id: string, err: Error): Promise<void> {
    log('pipeline error', id, err.message);
    await this.store.update(id, { telegram: 'off' });
    const chat = this.chat(id);
    const title = this.store.get(id)?.title ?? '';
    if (chat) {
      await this.telegram
        .sendMessage(chat, `<b>${escapeTelegram(title)}</b>\n${escapeTelegram(t('telegram.failed', { error: err.message }))}`)
        .catch((e: Error) => log('telegram error', id, e.message));
    }
  }

  /** Writes minutes.pdf, minutes.md and transcript.txt, then sends the minutes to Telegram. */
  private async deliver(id: string): Promise<void> {
    const meeting = this.store.get(id);
    const summary = meeting?.summary;
    if (!meeting || !summary) return;
    const frames = new Map(meeting.frames.map((f) => [f.id, f]));
    const chosen = summary.topics.flatMap((topic) =>
      topic.images.flatMap((img) => {
        const frame = frames.get(img.id);
        return frame ? [{ topic, caption: img.caption, frame }] : [];
      }),
    );

    const images = new Map<number, { url: string; frame: FrameMeta }>();
    for (const { frame } of chosen) {
      const data = await this.store.readFrame(id, frame.id);
      images.set(frame.id, {
        url: await blobToDataUrl(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })),
        frame,
      });
      await this.store.writeOutput(id, imageFileName(frame.t), data);
    }
    const title = summary.title || meeting.title;
    const includeTranscript = meeting.options.includeTranscript;
    let pdf: Uint8Array | undefined;
    try {
      pdf = await htmlToPdf(minutesHtml(meeting, summary, includeTranscript, images), title, this.config.chromiumPath);
      await this.store.writeOutput(id, 'minutes.pdf', pdf);
    } catch (err) {
      log('pdf error', id, (err as Error).message);
      await this.store.update(id, (m) => ({
        warning: [m.warning, `The PDF could not be created (${(err as Error).message}).`].filter(Boolean).join(' '),
      }));
    }
    await this.store.writeOutput(
      id,
      'minutes.md',
      summaryToMarkdown(meeting, summary, includeTranscript, (fid) => {
        const frame = frames.get(fid);
        return frame && images.has(fid) ? imageFileName(frame.t) : undefined;
      }),
    );
    await this.store.writeOutput(id, 'transcript.txt', transcriptToText(meeting));

    const chat = this.chat(id);
    if (!chat) {
      await this.store.update(id, { telegram: 'off' });
      return;
    }
    await this.store.update(id, { telegram: 'sending' });
    try {
      for (const text of summaryMessages(meeting, summary)) await this.telegram.sendMessage(chat, text);
      if (chosen.length) {
        const photos = [];
        for (const c of chosen) {
          photos.push({ data: await this.store.readFrame(id, c.frame.id), caption: photoCaption(c.topic, c.caption) });
        }
        await this.telegram.sendPhotos(chat, photos);
      }
      if (pdf) await this.telegram.sendDocument(chat, pdf, `${sanitizeSegment(title)}.pdf`, title);
      // A card to open the parts of these minutes again later (see bot.ts).
      await this.telegram.sendMessage(chat, cardText(meeting), cardKeyboard(meeting, false));
      await this.store.update(id, { telegram: 'sent', telegramError: undefined });
      log('sent to telegram', id);
    } catch (err) {
      log('telegram error', id, (err as Error).message);
      await this.store.update(id, { telegram: 'failed', telegramError: (err as Error).message });
    }
  }
}
