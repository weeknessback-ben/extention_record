import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PipelineStore, ProcessMode } from '@/lib/pipeline-core';
import type { MeetingInput, MeetingOptions } from '@/lib/server-api';
import type { AudioSegmentMeta, FrameAnalysis, Recording, TelegramStatus, TemplateId } from '@/lib/types';

export interface FrameMeta {
  id: number;
  /** Offset from the start of the recording, in ms. */
  t: number;
  width: number;
  height: number;
  analysis?: FrameAnalysis;
}

/** A recording as the server keeps it: the extension's Recording plus server bookkeeping. */
export interface Meeting extends Recording {
  /** Hash of the API key that created it; only that key can see it. */
  owner: string;
  createdAt: number;
  options: MeetingOptions;
  frames: FrameMeta[];
  /** The audio and screenshots were deleted after RETENTION_DAYS; the minutes and chosen slides are kept. */
  pruned?: boolean;
  /** Still being recorded: uploads keep coming and are processed as they arrive, until /process. */
  live?: boolean;
  /** What the queue should do next; kept so a restart can pick it up again. */
  job?: { mode: ProcessMode; template?: TemplateId; deliverOnly?: boolean };
  telegram: TelegramStatus;
  telegramError?: string;
}

const PROCESSING = new Set(['queued', 'transcribing', 'analyzing', 'summarizing']);

/** Whether a meeting is queued or being processed. */
export function isProcessing(status: string): boolean {
  return PROCESSING.has(status);
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isMeetingId(id: string): boolean {
  return ID.test(id);
}

function blob(data: Uint8Array, type: string): Blob {
  return new Blob([data as Uint8Array<ArrayBuffer>], { type });
}

/**
 * Meetings on disk, one folder each: meeting.json, audio/<index>.webm, frames/<id>.jpg and
 * the outputs. meeting.json is the source of truth; it is cached in memory and rewritten atomically.
 */
export class MeetingStore {
  private meetings = new Map<string, Meeting>();
  private writes = new Map<string, Promise<void>>();

  constructor(readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.root(), { recursive: true });
    for (const id of await readdir(this.root())) {
      if (!isMeetingId(id)) continue;
      try {
        this.meetings.set(id, JSON.parse(await readFile(this.path(id, 'meeting.json'), 'utf8')) as Meeting);
      } catch {
        // A folder whose meeting.json was never written: nothing to resume.
      }
    }
  }

  private root(): string {
    return join(this.dir, 'meetings');
  }

  path(id: string, ...parts: string[]): string {
    return join(this.root(), id, ...parts);
  }

  list(): Meeting[] {
    return [...this.meetings.values()];
  }

  get(id: string): Meeting | undefined {
    return this.meetings.get(id);
  }

  async create(input: MeetingInput, owner: string, telegram: TelegramStatus): Promise<Meeting> {
    const id = randomUUID();
    const meeting: Meeting = {
      id,
      owner,
      createdAt: Date.now(),
      title: input.title,
      platform: input.platform,
      pageUrl: '',
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMs: input.durationMs,
      folder: '',
      mimeType: 'audio/webm',
      hasMic: input.hasMic,
      status: input.live ? 'recording' : 'recorded',
      live: input.live || undefined,
      video: { status: 'pending' },
      audioSegments: [],
      notes: input.notes,
      template: input.template,
      options: input.options,
      frames: [],
      frameCount: 0,
      telegram,
    };
    await mkdir(this.path(id, 'audio'), { recursive: true });
    await mkdir(this.path(id, 'frames'), { recursive: true });
    this.meetings.set(id, meeting);
    await this.persist(id);
    return meeting;
  }

  async update(id: string, patch: Partial<Meeting> | ((m: Meeting) => Partial<Meeting> | void)): Promise<Meeting | undefined> {
    const current = this.meetings.get(id);
    if (!current) return undefined;
    const next = { ...current, ...((typeof patch === 'function' ? patch(current) : patch) ?? {}) };
    this.meetings.set(id, next);
    await this.persist(id);
    return next;
  }

  /** Writes are chained per meeting so an older snapshot never lands after a newer one. */
  private persist(id: string): Promise<void> {
    const write = async () => {
      const meeting = this.meetings.get(id);
      if (!meeting) return;
      const file = this.path(id, 'meeting.json');
      await writeFile(`${file}.tmp`, JSON.stringify(meeting));
      await rename(`${file}.tmp`, file);
    };
    const next = (this.writes.get(id) ?? Promise.resolve()).then(write);
    this.writes.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }

  async putAudio(id: string, seg: AudioSegmentMeta, data: Uint8Array): Promise<void> {
    await writeFile(this.path(id, 'audio', `${seg.index}.webm`), data);
    await this.update(id, (m) => ({
      audioSegments: [...m.audioSegments.filter((s) => s.index !== seg.index), seg].sort((a, b) => a.index - b.index),
    }));
  }

  async putFrame(id: string, frame: Omit<FrameMeta, 'analysis'>, data: Uint8Array): Promise<void> {
    await writeFile(this.path(id, 'frames', `${frame.id}.jpg`), data);
    await this.update(id, (m) => {
      const frames = [...m.frames.filter((f) => f.id !== frame.id), frame].sort((a, b) => a.t - b.t);
      return { frames, frameCount: frames.length };
    });
  }

  readFrame(id: string, frameId: number): Promise<Uint8Array> {
    return readFile(this.path(id, 'frames', `${frameId}.jpg`));
  }

  async writeOutput(id: string, name: string, data: string | Uint8Array): Promise<void> {
    const file = this.path(id, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async remove(id: string): Promise<void> {
    this.meetings.delete(id);
    await this.writes.get(id);
    this.writes.delete(id);
    await rm(this.path(id), { recursive: true, force: true });
  }

  /** Deletes the audio and screenshots but keeps the minutes, the chosen slides (images/) and the outputs. */
  async prune(id: string): Promise<void> {
    await rm(this.path(id, 'audio'), { recursive: true, force: true });
    await rm(this.path(id, 'frames'), { recursive: true, force: true });
    await this.update(id, { pruned: true });
  }

  /**
   * Applies the retention: after `rawDays` the audio and screenshots go (meetings without minutes go
   * entirely), after `notesDays` the minutes too. Meetings that are being worked on are skipped.
   */
  async expire(
    rawDays: number,
    notesDays: number,
    busy: (id: string) => boolean,
    now = Date.now(),
  ): Promise<{ pruned: string[]; removed: string[] }> {
    const done = { pruned: [] as string[], removed: [] as string[] };
    for (const m of this.list()) {
      if (busy(m.id) || m.live || isProcessing(m.status)) continue;
      const age = (now - m.createdAt) / 86_400_000;
      if ((notesDays > 0 && age > notesDays) || (rawDays > 0 && age > rawDays && !m.summary)) {
        await this.remove(m.id);
        done.removed.push(m.id);
      } else if (rawDays > 0 && age > rawDays && !m.pruned) {
        await this.prune(m.id);
        done.pruned.push(m.id);
      }
    }
    return done;
  }

  /** The meeting as the shared pipeline (lib/pipeline-core.ts) sees it. */
  pipeline(id: string): PipelineStore {
    return {
      getRecording: async () => this.get(id),
      update: (patch) => this.update(id, patch),
      getAudio: async (index) => blob(await readFile(this.path(id, 'audio', `${index}.webm`)), 'audio/webm'),
      getFrames: () =>
        Promise.all(
          (this.get(id)?.frames ?? []).map(async (f) => ({
            ...f,
            recId: id,
            blob: blob(await this.readFrame(id, f.id), 'image/jpeg'),
          })),
        ),
      setFrameAnalysis: async (frameId, analysis) => {
        await this.update(id, (m) => ({ frames: m.frames.map((f) => (f.id === frameId ? { ...f, analysis } : f)) }));
      },
    };
  }
}
