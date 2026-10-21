import { getChunks, getFrames, getRecording, setFrameAnalysis, updateRecording } from './db';
import { runPipeline, type PipelineStore, type ProcessMode } from './pipeline-core';
import type { Settings } from './settings';
import type { TemplateId } from './types';

export { finalizeImages, visualItems, type ProcessMode } from './pipeline-core';

function indexedDbStore(recId: string): PipelineStore {
  return {
    getRecording: () => getRecording(recId),
    update: (patch) => updateRecording(recId, patch),
    getAudio: async (index) => new Blob(await getChunks(recId, 'audio', index), { type: 'audio/webm' }),
    getFrames: () => getFrames(recId),
    setFrameAnalysis,
  };
}

/** Runs the pipeline on a recording stored in IndexedDB. */
export function processRecording(
  recId: string,
  settings: Settings,
  mode: ProcessMode = 'all',
  templateOverride?: TemplateId,
): Promise<void> {
  return runPipeline(indexedDbStore(recId), settings, mode, templateOverride);
}
