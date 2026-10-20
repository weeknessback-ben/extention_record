import { blobToDataUrl, chat, parseJsonLoose, transcribe, type ContentPart } from './ai';
import { getChunks, getFrames, getRecording, setFrameAnalysis, updateRecording } from './db';
import { chunkTranscript, formatClock, formatDuration, platformName } from './format';
import {
  finalSystemPrompt,
  finalUserPrompt,
  mergeSystemPrompt,
  mergeUserPrompt,
  normalizeFrameAnalyses,
  normalizeSummary,
  partSystemPrompt,
  partUserPrompt,
  VISION_SYSTEM_PROMPT,
  type PromptContext,
  type VisualItem,
} from './prompts';
import { isVisionConfigured, summaryEndpoint, visionEndpoint, type Settings } from './settings';
import type { FrameRecord, MeetingSummary, Recording, TemplateId, TranscriptSegment } from './types';

export type ProcessMode = 'all' | 'transcribe' | 'summarize';

/** Whisper only reads the last ~224 tokens of the prompt; keep it short. */
function buildPrompt(vocabulary: string, previousText: string): string {
  const tail = previousText.slice(-400);
  return [vocabulary.trim().slice(0, 400), tail].filter(Boolean).join('\n');
}

async function transcribeAll(rec: Recording, settings: Settings, fresh: boolean): Promise<TranscriptSegment[]> {
  const segments = [...rec.audioSegments].sort((a, b) => a.index - b.index);
  const parts: Record<number, TranscriptSegment[]> = fresh ? {} : { ...(rec.transcriptParts ?? {}) };
  const doneCount = () => segments.filter((s) => parts[s.index]).length;

  await updateRecording(rec.id, {
    status: 'transcribing',
    error: undefined,
    warning: undefined,
    transcriptParts: parts,
    progress: { stage: 'transcribing', done: doneCount(), total: segments.length },
  });

  let previousText = '';
  for (const seg of segments) {
    const existing = parts[seg.index];
    if (existing) {
      previousText = existing.map((s) => s.text).join(' ') || previousText;
      continue;
    }
    const blob = new Blob(await getChunks(rec.id, 'audio', seg.index), { type: 'audio/webm' });
    let result: TranscriptSegment[] = [];
    // Skip slivers (e.g. stopping right after a segment rotation): nothing to recognise.
    if (blob.size > 2000 && seg.endMs - seg.startMs > 1500) {
      const res = await transcribe(settings.transcription, blob, {
        language: settings.transcription.language,
        prompt: buildPrompt(settings.transcription.vocabulary, previousText),
        filename: `segment-${seg.index + 1}.webm`,
      });
      const offset = seg.startMs / 1000;
      if (res.segments?.length) {
        result = res.segments.map((s) => ({ ...s, start: offset + s.start, end: offset + s.end }));
      } else if (res.text) {
        result = [{ start: offset, end: seg.endMs / 1000, text: res.text }];
      }
      if (res.text) previousText = res.text;
    }
    parts[seg.index] = result;
    await updateRecording(rec.id, (r) => ({
      transcriptParts: { ...(r.transcriptParts ?? {}), [seg.index]: result },
      progress: { stage: 'transcribing', done: doneCount(), total: segments.length },
    }));
  }

  const transcript = segments.flatMap((s) => parts[s.index] ?? []).sort((a, b) => a.start - b.start);
  await updateRecording(rec.id, { transcript });
  return transcript;
}

const VISION_BATCH_SIZE = 6;
/** Screenshots scoring lower than this are not offered to the summary model. */
const MIN_USEFUL = 3;
const MAX_VISUALS = 60;

/**
 * Lets a vision model read every screenshot that has not been analysed yet:
 * what it shows, its visible text and how useful it is for the minutes.
 * Returns a warning instead of failing, so the minutes are still written.
 */
async function analyzeFrames(rec: Recording, settings: Settings): Promise<{ frames: FrameRecord[]; warning?: string }> {
  const frames = await getFrames(rec.id);
  const todo = frames.filter((f) => !f.analysis);
  if (!settings.slides.analyze || !todo.length) return { frames };
  if (!isVisionConfigured(settings)) {
    return { frames, warning: 'The vision API is not set up (Settings → Vision API), so the screenshots were not used.' };
  }

  const ep = visionEndpoint(settings);
  let done = frames.length - todo.length;
  await updateRecording(rec.id, {
    status: 'analyzing',
    progress: { stage: 'analyzing', done, total: frames.length },
  });
  try {
    for (let i = 0; i < todo.length; i += VISION_BATCH_SIZE) {
      const batch = todo.slice(i, i + VISION_BATCH_SIZE);
      const content: ContentPart[] = [{ type: 'text', text: `${batch.length} screenshot(s) from the meeting "${rec.title}".` }];
      for (const frame of batch) {
        content.push({ type: 'text', text: `Image #${frame.id} at [${formatClock(frame.t / 1000)}]` });
        content.push({ type: 'image_url', image_url: { url: await blobToDataUrl(frame.blob), detail: settings.vision.detail } });
      }
      const reply = await chat(
        ep,
        [
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        { json: settings.vision.jsonMode, temperature: settings.vision.temperature },
      );
      const analyses = normalizeFrameAnalyses(parseJsonLoose(reply));
      for (const frame of batch) {
        // An image the model skipped is treated as not useful, so it is not retried forever.
        frame.analysis = analyses.get(frame.id!) ?? { kind: 'other', useful: 0, caption: '', text: '' };
        await setFrameAnalysis(frame.id!, frame.analysis);
      }
      done += batch.length;
      await updateRecording(rec.id, { progress: { stage: 'analyzing', done, total: frames.length } });
    }
    return { frames };
  } catch (err) {
    return {
      frames,
      warning: `The screenshots could not be analysed (${(err as Error).message}). The minutes were written without images.`,
    };
  }
}

/** The screenshots worth offering to the summary model, most useful first, then in time order. */
export function visualItems(frames: FrameRecord[]): VisualItem[] {
  const useful = frames.filter((f) => f.analysis && f.analysis.useful >= MIN_USEFUL && f.analysis.kind !== 'people');
  const best = [...useful].sort((a, b) => b.analysis!.useful - a.analysis!.useful).slice(0, MAX_VISUALS);
  const items: VisualItem[] = [];
  for (const f of best.sort((a, b) => a.t - b.t)) {
    const previous = items[items.length - 1];
    // The same slide captured twice (e.g. after a pop-up) only needs to be offered once.
    if (previous && f.analysis!.text && previous.analysis.text === f.analysis!.text) continue;
    items.push({ id: f.id!, time: formatClock(f.t / 1000), analysis: f.analysis! });
  }
  return items;
}

/** Keeps only images that exist, are used once, and respects the per-topic limit. */
export function finalizeImages(summary: MeetingSummary, items: VisualItem[], perTopic: number): MeetingSummary {
  const known = new Map(items.map((i) => [i.id, i]));
  const used = new Set<number>();
  for (const topic of summary.topics) {
    topic.images = topic.images
      .filter((img) => known.has(img.id) && !used.has(img.id))
      .slice(0, perTopic)
      .map((img) => ({ id: img.id, caption: img.caption || known.get(img.id)!.analysis.caption }));
    topic.images.forEach((img) => used.add(img.id));
  }
  return summary;
}

function promptContext(rec: Recording, settings: Settings, template: TemplateId, hasScreenshots: boolean): PromptContext {
  const d = new Date(rec.startedAt);
  return {
    title: rec.title,
    platform: platformName(rec.platform),
    date: `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)} (local time)`,
    duration: formatDuration(rec.durationMs),
    notes: rec.notes ?? '',
    template,
    outputLanguage: settings.outputLanguage,
    customInstructions: settings.customInstructions,
    hasScreenshots,
    imagesPerTopic: settings.slides.perTopic,
  };
}

async function summarize(
  rec: Recording,
  transcript: TranscriptSegment[],
  frames: FrameRecord[],
  settings: Settings,
  template: TemplateId,
) {
  const chunks = chunkTranscript(transcript, Math.max(4000, settings.summary.maxCharsPerRequest));
  if (!chunks.length) throw new Error('No speech was recognised in this recording, so there is nothing to summarise.');

  const visuals = visualItems(frames);
  const ep = summaryEndpoint(settings);
  const opts = { json: settings.summary.jsonMode, temperature: settings.summary.temperature };
  const ctx = promptContext(rec, settings, template, visuals.length > 0);
  const total = chunks.length === 1 ? 1 : chunks.length + 1;

  await updateRecording(rec.id, { status: 'summarizing', progress: { stage: 'summarizing', done: 0, total } });

  let raw: unknown;
  if (chunks.length === 1) {
    raw = parseJsonLoose(
      await chat(
        ep,
        [
          { role: 'system', content: finalSystemPrompt(ctx) },
          { role: 'user', content: finalUserPrompt(ctx, chunks[0]!.text, visuals) },
        ],
        opts,
      ),
    );
  } else {
    const notes: unknown[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const from = i === 0 ? -Infinity : chunks[i]!.start;
      const to = chunks[i + 1]?.start ?? Infinity;
      const partVisuals = visuals.filter((v) => {
        const t = frames.find((f) => f.id === v.id)!.t / 1000;
        return t >= from && t < to;
      });
      notes.push(
        parseJsonLoose(
          await chat(
            ep,
            [
              { role: 'system', content: partSystemPrompt(ctx, i + 1, chunks.length) },
              { role: 'user', content: partUserPrompt(ctx, chunks[i]!.text, partVisuals) },
            ],
            opts,
          ),
        ),
      );
      await updateRecording(rec.id, { progress: { stage: 'summarizing', done: i + 1, total } });
    }
    raw = parseJsonLoose(
      await chat(
        ep,
        [
          { role: 'system', content: mergeSystemPrompt(ctx) },
          { role: 'user', content: mergeUserPrompt(ctx, notes, visuals) },
        ],
        opts,
      ),
    );
  }

  await updateRecording(rec.id, {
    summary: finalizeImages(normalizeSummary(raw, rec.title), visuals, settings.slides.perTopic),
    summaryModel: ep.model,
    template,
    processedAt: Date.now(),
    status: 'done',
    progress: undefined,
    error: undefined,
  });
}

/**
 * Transcribes the recorded audio segments and summarises the transcript.
 * Already transcribed segments are kept, so a failed run can be resumed.
 */
export async function processRecording(
  recId: string,
  settings: Settings,
  mode: ProcessMode = 'all',
  templateOverride?: TemplateId,
): Promise<void> {
  const rec = await getRecording(recId);
  if (!rec) throw new Error('Recording not found');
  const template = templateOverride ?? rec.template ?? settings.template;
  try {
    let transcript = rec.transcript;
    if (mode !== 'summarize' || !transcript) {
      transcript = await transcribeAll(rec, settings, mode === 'transcribe');
    }
    const latest = (await getRecording(recId)) ?? rec;
    const { frames, warning } = await analyzeFrames(latest, settings);
    await updateRecording(recId, { warning });
    await summarize(latest, transcript, frames, settings, template);
  } catch (err) {
    await updateRecording(recId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      progress: undefined,
    });
    throw err;
  }
}
