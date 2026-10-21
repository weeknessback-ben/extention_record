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

  /** Where recordings are transcribed and summarised. */
  processing: 'local' | 'server';
  /** Processing server (see server/README.md): gets audio + screenshots, sends the minutes to Telegram. */
  server: {
    baseUrl: string;
    apiKey: string;
    /** Telegram chat for this browser's minutes; empty = the server's TELEGRAM_CHAT_ID. */
    telegramChatId: string;
  };

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
    /** Keep only the shared content (slides, documents) of each screenshot, not the meeting interface. */
    crop: boolean;
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
    /** Screenshots sent per request; 1 suits small or self-hosted models. */
    batchSize: number;
    /** JSON object merged into the request body, e.g. {"max_tokens": 512}. */
    extraBody: string;
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

/** The built-in defaults, before the build-time overrides (see buildDefaults). */
const BASE_SETTINGS: Settings = {
  uiLanguage: 'auto',
  processing: 'local',
  server: { baseUrl: '', apiKey: '', telegramChatId: '' },
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
    crop: true,
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
    batchSize: 6,
    extraBody: '',
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

export function mergeSettings(stored: StoredSettings | undefined, base: Settings = DEFAULT_SETTINGS): Settings {
  const s = stored ?? {};
  const legacy = { model: s.slides?.model, detail: s.slides?.detail };
  const { model: _model, detail: _detail, ...slides } = s.slides ?? {};
  return {
    ...base,
    ...s,
    server: { ...base.server, ...s.server },
    transcription: { ...base.transcription, ...s.transcription },
    summary: { ...base.summary, ...s.summary },
    slides: { ...base.slides, ...slides },
    vision: {
      ...base.vision,
      ...(legacy.model ? { model: legacy.model } : {}),
      ...(legacy.detail ? { detail: legacy.detail } : {}),
      ...s.vision,
    },
  };
}

/**
 * Defaults baked in at build time: WXT_DEFAULT_SETTINGS in .env.production.local holds a partial
 * Settings object as JSON, e.g. your own processing server. Only `npm run build` and `zip` read it.
 */
function buildDefaults(): StoredSettings {
  const raw: unknown = import.meta.env?.WXT_DEFAULT_SETTINGS;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StoredSettings) : {};
  } catch {
    console.warn('WXT_DEFAULT_SETTINGS is not valid JSON; using the built-in defaults');
    return {};
  }
}

export const BUILD_DEFAULTS = buildDefaults();
export const DEFAULT_SETTINGS: Settings = mergeSettings(BUILD_DEFAULTS, BASE_SETTINGS);

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

export function endpointReady(ep: ApiEndpoint): boolean {
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

/** A numeric Telegram chat id (groups and channels are negative) or a public @channel name. */
export function isTelegramChatId(v: string): boolean {
  return /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(v);
}

export function isServerConfigured(s: Settings): boolean {
  return /^https?:\/\//i.test(s.server.baseUrl.trim()) && Boolean(s.server.apiKey.trim());
}

/** Whether recordings can be processed with the chosen mode (local AI APIs or the server). */
export function isProcessingConfigured(s: Settings): boolean {
  return s.processing === 'server' ? isServerConfigured(s) : isAiConfigured(s);
}

export const RESOLUTIONS: Record<Settings['videoResolution'], { width: number; height: number; kbps: number }> = {
  '480p': { width: 854, height: 480, kbps: 1000 },
  '720p': { width: 1280, height: 720, kbps: 2500 },
  '1080p': { width: 1920, height: 1080, kbps: 4500 },
};
