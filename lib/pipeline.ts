import { chat, parseJsonLoose, transcribe } from './ai';
import { getChunks, getRecording, updateRecording } from './db';
import { chunkLines, formatDuration, platformName, transcriptLines } from './format';
import {
  finalSystemPrompt,
  finalUserPrompt,
  mergeSystemPrompt,
  mergeUserPrompt,
  normalizeSummary,
  partSystemPrompt,
  partUserPrompt,
  type PromptContext,
} from './prompts';
import { summaryEndpoint, type Settings } from './settings';
import type { Recording, TemplateId, TranscriptSegment } from './types';

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

function promptContext(rec: Recording, settings: Settings, template: TemplateId): PromptContext {
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
  };
}

async function summarize(rec: Recording, transcript: TranscriptSegment[], settings: Settings, template: TemplateId) {
  const lines = transcriptLines(transcript);
  if (!lines.length) throw new Error('No speech was recognised in this recording, so there is nothing to summarise.');

  const ep = summaryEndpoint(settings);
  const opts = { json: settings.summary.jsonMode, temperature: settings.summary.temperature };
  const ctx = promptContext(rec, settings, template);
  const chunks = chunkLines(lines, Math.max(4000, settings.summary.maxCharsPerRequest));
  const total = chunks.length === 1 ? 1 : chunks.length + 1;

  await updateRecording(rec.id, { status: 'summarizing', progress: { stage: 'summarizing', done: 0, total } });

  let raw: unknown;
  if (chunks.length === 1) {
    raw = parseJsonLoose(
      await chat(
        ep,
        [
          { role: 'system', content: finalSystemPrompt(ctx) },
          { role: 'user', content: finalUserPrompt(ctx, chunks[0]!) },
        ],
        opts,
      ),
    );
  } else {
    const notes: unknown[] = [];
    for (let i = 0; i < chunks.length; i++) {
      notes.push(
        parseJsonLoose(
          await chat(
            ep,
            [
              { role: 'system', content: partSystemPrompt(ctx, i + 1, chunks.length) },
              { role: 'user', content: partUserPrompt(ctx, chunks[i]!) },
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
          { role: 'user', content: mergeUserPrompt(ctx, notes) },
        ],
        opts,
      ),
    );
  }

  await updateRecording(rec.id, {
    summary: normalizeSummary(raw, rec.title),
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
    await summarize(latest, transcript, settings, template);
  } catch (err) {
    await updateRecording(recId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      progress: undefined,
    });
    throw err;
  }
}
