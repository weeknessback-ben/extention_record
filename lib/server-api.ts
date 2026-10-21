// Contract between the extension and the processing server (server/). Types only.
import type { ProcessMode } from './pipeline-core';
import type { MeetingSummary, Platform, Progress, RecordingStatus, TelegramStatus, TemplateId, TranscriptSegment } from './types';

/** Choices from the extension's settings that shape the minutes. */
export interface MeetingOptions {
  /** ISO-639-1 hint for speech recognition; empty = the server default. */
  language: string;
  vocabulary: string;
  outputLanguage: string;
  customInstructions: string;
  perTopic: number;
  includeTranscript: boolean;
  /** Let the vision model read the screenshots (when the server has a vision API). */
  analyze: boolean;
  /** Telegram chat for these minutes; empty = the server's default chat. */
  telegramChatId: string;
}

/** POST /v1/meetings */
export interface MeetingInput {
  title: string;
  platform: Platform;
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  hasMic: boolean;
  notes: string;
  template: TemplateId;
  options: MeetingOptions;
  /** Created when the recording starts: audio and screenshots keep arriving until /process. */
  live?: boolean;
}

/** POST /v1/meetings/{id}/process. Title, notes, template and options may have changed since the upload. */
export interface ProcessRequest {
  mode: ProcessMode;
  template?: TemplateId;
  title?: string;
  notes?: string;
  options?: MeetingOptions;
  /** Final length of a meeting that was created live. */
  durationMs?: number;
  endedAt?: number;
}

/** GET /v1/meetings/{id} */
export interface MeetingStatus {
  id: string;
  status: RecordingStatus;
  progress?: Progress;
  error?: string;
  warning?: string;
  telegram: TelegramStatus;
  telegramError?: string;
}

/** GET /v1/meetings/{id}/result */
export interface MeetingResult {
  summary?: MeetingSummary;
  transcript?: TranscriptSegment[];
  summaryModel?: string;
  processedAt?: number;
}

export interface EndpointHealth {
  configured: boolean;
  /** Whether {origin}/health answered (only checked for self-hosted servers). */
  reachable?: boolean;
  model?: string;
}

/** GET /v1/health */
export interface ServerHealth {
  ok: boolean;
  stt: EndpointHealth;
  vision: EndpointHealth;
  summary: EndpointHealth;
  telegram: {
    configured: boolean;
    bot?: string;
    /** Name of the chat that gets the minutes (from ?chat= or the server default). */
    chat?: string;
    error?: string;
  };
}

export interface TelegramChat {
  id: string;
  title: string;
}

/** GET /v1/telegram/chats: chats that recently wrote to the bot. */
export interface TelegramChats {
  chats: TelegramChat[];
}
