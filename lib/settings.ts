import { browser } from 'wxt/browser';
import type { TemplateId } from './types';

export interface ApiEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** JSON object with extra HTTP headers, e.g. {"api-key": "..."} for Azure. */
  extraHeaders: string;
}

export interface Settings {
  uiLanguage: 'auto' | 'en' | 'id';

  // Storage
  /** Folder (relative to the Chrome downloads directory) where everything is saved. */
  folder: string;
  /** Show the "Save as" dialog for the video so it can go anywhere on disk. */
  askWhereToSave: boolean;

  // Recording
  videoResolution: '480p' | '720p' | '1080p';
  videoFps: 15 | 30;
  /** 0 = automatic, based on the resolution. */
  videoBitrateKbps: number;
  recordMic: boolean;
  /** Length of each audio piece sent to the transcription API. */
  segmentMinutes: number;

  // AI
  transcription: ApiEndpoint & {
    /** ISO-639-1 hint. Empty = auto-detect (best for multilingual meetings). */
    language: string;
    /** Names, jargon and acronyms that help recognition. */
    vocabulary: string;
  };
  summary: ApiEndpoint & {
    /** Reuse base URL, API key and headers from the transcription endpoint. */
    sameAsTranscription: boolean;
    /** Empty = provider default (required for reasoning models). */
    temperature: string;
    jsonMode: boolean;
    /** Transcripts longer than this are summarised in parts first (map-reduce). */
    maxCharsPerRequest: number;
  };

  // Screenshots of the shared screen
  slides: {
    /** Take a screenshot whenever the shared screen changes. */
    capture: boolean;
    sensitivity: 'low' | 'medium' | 'high';
    maxFrames: number;
    /** Let a vision model read the screenshots and pick images per topic. */
    analyze: boolean;
    /** Maximum images shown under each topic of the minutes. */
    perTopic: number;
  };

  /** API that reads the screenshots; its model must accept image input. */
  vision: ApiEndpoint & {
    /** Reuse base URL, API key and headers from the summary endpoint (empty model = summary model). */
    sameAsSummary: boolean;
    detail: 'auto' | 'low' | 'high';
    /** Empty = provider default. */
    temperature: string;
    jsonMode: boolean;
  };

  // Output
  /** Empty = same as the dominant language of the meeting. */
  outputLanguage: string;
  template: TemplateId;
  customInstructions: string;
  autoProcess: boolean;
  autoPdf: boolean;
  pdfIncludeTranscript: boolean;
  saveTextFiles: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  uiLanguage: 'auto',
  folder: 'MeetingRecorder',
  askWhereToSave: false,
  videoResolution: '720p',
  videoFps: 30,
  videoBitrateKbps: 0,
  recordMic: true,
  segmentMinutes: 5,
  transcription: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-transcribe',
    extraHeaders: '',
    language: '',
    vocabulary: '',
  },
  summary: {
    sameAsTranscription: true,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4.1-mini',
    extraHeaders: '',
    temperature: '',
    jsonMode: true,
    maxCharsPerRequest: 120000,
  },
  slides: {
    capture: true,
    sensitivity: 'medium',
    maxFrames: 150,
    analyze: true,
    perTopic: 2,
  },
  vision: {
    sameAsSummary: true,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    extraHeaders: '',
    detail: 'auto',
    temperature: '',
    jsonMode: true,
  },
  outputLanguage: '',
  template: 'general',
  customInstructions: '',
  autoProcess: true,
  autoPdf: true,
  pdfIncludeTranscript: true,
  saveTextFiles: true,
};

const KEY = 'settings';

type StoredSettings = Partial<Settings> & {
  // Before the vision API had its own settings (0.1.x).
  slides?: Partial<Settings['slides']> & { model?: string; detail?: Settings['vision']['detail'] };
};

export function mergeSettings(stored: StoredSettings | undefined): Settings {
  const s = stored ?? {};
  const legacy = { model: s.slides?.model, detail: s.slides?.detail };
  const { model: _model, detail: _detail, ...slides } = s.slides ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    transcription: { ...DEFAULT_SETTINGS.transcription, ...s.transcription },
    summary: { ...DEFAULT_SETTINGS.summary, ...s.summary },
    slides: { ...DEFAULT_SETTINGS.slides, ...slides },
    vision: {
      ...DEFAULT_SETTINGS.vision,
      ...(legacy.model ? { model: legacy.model } : {}),
      ...(legacy.detail ? { detail: legacy.detail } : {}),
      ...s.vision,
    },
  };
}

export async function getSettings(): Promise<Settings> {
  const data = await browser.storage.local.get(KEY);
  return mergeSettings(data[KEY] as StoredSettings | undefined);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [KEY]: settings });
}

/** The endpoint actually used for summarisation, after applying "same as transcription". */
export function summaryEndpoint(s: Settings): ApiEndpoint {
  if (!s.summary.sameAsTranscription) return s.summary;
  return {
    baseUrl: s.transcription.baseUrl,
    apiKey: s.transcription.apiKey,
    extraHeaders: s.transcription.extraHeaders,
    model: s.summary.model,
  };
}

function endpointReady(ep: ApiEndpoint): boolean {
  if (!ep.baseUrl.trim() || !ep.model.trim()) return false;
  // Self-hosted servers may not need a key; api.openai.com always does.
  const needsKey = /(^|\.)openai\.com$/i.test(safeHost(ep.baseUrl));
  return !needsKey || Boolean(ep.apiKey.trim() || ep.extraHeaders.trim());
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** The endpoint that reads screenshots, after applying "same as summary". */
export function visionEndpoint(s: Settings): ApiEndpoint {
  if (!s.vision.sameAsSummary) return s.vision;
  const ep = summaryEndpoint(s);
  return { ...ep, model: s.vision.model.trim() || ep.model };
}

export function isVisionConfigured(s: Settings): boolean {
  return endpointReady(visionEndpoint(s));
}

export function isAiConfigured(s: Settings): boolean {
  return endpointReady(s.transcription) && endpointReady(summaryEndpoint(s));
}

export const RESOLUTIONS: Record<Settings['videoResolution'], { width: number; height: number; kbps: number }> = {
  '480p': { width: 854, height: 480, kbps: 1000 },
  '720p': { width: 1280, height: 720, kbps: 2500 },
  '1080p': { width: 1920, height: 1080, kbps: 4500 },
};
