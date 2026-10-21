import type { MeetingOptions } from '@/lib/server-api';
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '@/lib/settings';

export interface TelegramConfig {
  token: string;
  /** Chat, group or channel that receives the minutes. */
  chatId: string;
  apiBase: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  apiKeys: string[];
  /** Days the audio and screenshots are kept. */
  retentionDays: number;
  /** Days the minutes, chosen slides and PDF are kept (for /notulen in Telegram). */
  notesRetentionDays: number;
  uiLanguage: 'auto' | 'en' | 'id';
  /** Empty = the Chromium that playwright-core installed. */
  chromiumPath: string;
  telegram: TelegramConfig;
  /** AI endpoints and defaults shared by every meeting (the extension sends the per-meeting choices). */
  settings: Settings;
}

type Env = Record<string, string | undefined>;

function bool(v: string | undefined, fallback: boolean): boolean {
  return v === undefined || v.trim() === '' ? fallback : /^(1|true|yes|on)$/i.test(v.trim());
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v?.trim() && Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const d = DEFAULT_SETTINGS;
  const visionBase = env.VISION_BASE_URL?.trim() ?? '';
  const settings = mergeSettings({
    transcription: {
      ...d.transcription,
      baseUrl: env.STT_BASE_URL?.trim() ?? '',
      apiKey: env.STT_API_KEY?.trim() ?? '',
      model: env.STT_MODEL?.trim() || 'whisper-1',
      language: env.STT_LANGUAGE?.trim() ?? '',
    },
    summary: {
      ...d.summary,
      sameAsTranscription: false,
      baseUrl: env.SUMMARY_BASE_URL?.trim() || 'https://api.openai.com/v1',
      apiKey: env.SUMMARY_API_KEY?.trim() ?? '',
      model: env.SUMMARY_MODEL?.trim() || d.summary.model,
      extraHeaders: env.SUMMARY_EXTRA_HEADERS?.trim() ?? '',
      temperature: env.SUMMARY_TEMPERATURE?.trim() ?? '',
      jsonMode: bool(env.SUMMARY_JSON_MODE, true),
      maxCharsPerRequest: Math.max(4000, num(env.SUMMARY_MAX_CHARS, d.summary.maxCharsPerRequest)),
    },
    vision: {
      ...d.vision,
      sameAsSummary: false,
      baseUrl: visionBase,
      apiKey: env.VISION_API_KEY?.trim() ?? '',
      model: env.VISION_MODEL?.trim() ?? '',
      detail: (['auto', 'low', 'high'] as const).find((v) => v === env.VISION_DETAIL?.trim()) ?? 'auto',
      temperature: env.VISION_TEMPERATURE?.trim() ?? '',
      jsonMode: bool(env.VISION_JSON_MODE, true),
      batchSize: Math.max(1, Math.round(num(env.VISION_BATCH_SIZE, 1))),
      extraBody: env.VISION_EXTRA_BODY?.trim() ?? '',
    },
    slides: { ...d.slides, analyze: Boolean(visionBase) && bool(env.VISION_ENABLED, true) },
  });
  const ui = env.UI_LANGUAGE?.trim();
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: num(env.PORT, 8120),
    dataDir: env.DATA_DIR?.trim() || './data',
    apiKeys: (env.API_KEYS ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    retentionDays: num(env.RETENTION_DAYS, 7),
    notesRetentionDays: num(env.NOTES_RETENTION_DAYS, 365),
    uiLanguage: ui === 'en' || ui === 'id' ? ui : 'auto',
    chromiumPath: env.CHROMIUM_PATH?.trim() ?? '',
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN?.trim() ?? '',
      chatId: env.TELEGRAM_CHAT_ID?.trim() ?? '',
      apiBase: (env.TELEGRAM_API_BASE?.trim() || 'https://api.telegram.org').replace(/\/+$/, ''),
    },
    settings,
  };
}

/** The server defaults combined with what the extension sent for one meeting. */
export function meetingSettings(base: Settings, o: MeetingOptions): Settings {
  return {
    ...base,
    transcription: {
      ...base.transcription,
      language: o.language.trim() || base.transcription.language,
      vocabulary: o.vocabulary,
    },
    outputLanguage: o.outputLanguage,
    customInstructions: o.customInstructions,
    slides: {
      ...base.slides,
      analyze: base.slides.analyze && o.analyze !== false,
      perTopic: Math.min(4, Math.max(0, Math.round(o.perTopic) || 0)),
    },
    pdfIncludeTranscript: o.includeTranscript,
  };
}
