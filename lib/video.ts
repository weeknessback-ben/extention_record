import { countChunks, deleteChunks, getChunks, getRecording, updateRecording } from './db';
import { saveBlob } from './files';
import { patchWebmDuration } from './webm';

/**
 * Writes the recorded video from IndexedDB into the recording folder, then
 * frees the space. On failure the chunks are kept so saving can be retried.
 */
export async function saveVideo(recId: string, askWhereToSave: boolean): Promise<boolean> {
  const rec = await getRecording(recId);
  if (!rec) return false;
  const chunks = await getChunks(recId, 'video');
  if (!chunks.length) {
    if (rec.video.status !== 'saved') {
      await updateRecording(recId, { video: { status: 'failed', error: 'No video data was recorded' } });
    }
    return rec.video.status === 'saved';
  }

  await updateRecording(recId, { video: { status: 'saving' } });
  const first = await patchWebmDuration(chunks[0]!, rec.durationMs);
  const blob = new Blob([first, ...chunks.slice(1)], { type: rec.mimeType.split(';')[0] || 'video/webm' });
  try {
    const saved = await saveBlob(blob, `${rec.folder}/video.webm`, {
      saveAs: askWhereToSave,
      conflictAction: 'uniquify',
    });
    await updateRecording(recId, {
      video: { status: 'saved', filename: saved.filename, downloadId: saved.downloadId, bytes: blob.size },
    });
    await deleteChunks(recId, 'video');
    return true;
  } catch (err) {
    await updateRecording(recId, {
      video: { status: 'failed', bytes: blob.size, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

/**
 * Makes an interrupted recording (browser closed or crashed while recording)
 * usable again: registers the audio segment that was still open, then saves.
 */
export async function recoverRecording(recId: string, askWhereToSave: boolean): Promise<void> {
  const rec = await getRecording(recId);
  if (!rec) return;
  const lastIndex = rec.audioSegments.reduce((max, s) => Math.max(max, s.index), -1);
  const openIndex = lastIndex + 1;
  if (await countChunks(recId, 'audio', openIndex)) {
    const blobs = await getChunks(recId, 'audio', openIndex);
    const startMs = rec.audioSegments.find((s) => s.index === lastIndex)?.endMs ?? 0;
    await updateRecording(recId, (r) => ({
      audioSegments: [
        ...r.audioSegments,
        {
          index: openIndex,
          startMs,
          endMs: Math.max(startMs, r.durationMs),
          bytes: blobs.reduce((n, b) => n + b.size, 0),
        },
      ],
    }));
  }
  await updateRecording(recId, { status: 'recorded', endedAt: rec.endedAt ?? rec.startedAt + rec.durationMs });
  await saveVideo(recId, askWhereToSave);
}
