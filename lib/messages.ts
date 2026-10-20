import { browser } from 'wxt/browser';
import type { Settings } from './settings';
import type { ActiveRecording, TemplateId } from './types';

/** Messages handled by the background service worker. */
export type BackgroundMessage =
  | { type: 'get-state' }
  | { type: 'indicator-query' }
  | { type: 'start'; tabId: number; title: string; recordMic: boolean }
  | { type: 'stop' }
  | { type: 'process'; recId: string; mode: 'all' | 'transcribe' | 'summarize'; template?: TemplateId }
  | { type: 'download'; url: string; filename: string; saveAs: boolean; conflictAction: 'uniquify' | 'overwrite' }
  | { type: 'recorder-stopped'; recId: string; reason: string }
  | { type: 'pipeline-finished'; recId: string; ok: boolean; error?: string }
  | { type: 'e2e-start'; title: string; recordMic: boolean; tabId: number };

export interface BackgroundState {
  active: ActiveRecording | null;
  configured: boolean;
  settings: Settings;
}

/** Messages handled by the offscreen document. */
export type OffscreenMessage =
  | {
      target: 'offscreen';
      type: 'start';
      recId: string;
      streamId: string;
      title: string;
      pageUrl: string;
      settings: Settings;
      recordMic: boolean;
      synthetic?: boolean;
    }
  | { target: 'offscreen'; type: 'stop'; settings: Settings }
  | {
      target: 'offscreen';
      type: 'process';
      recId: string;
      mode: 'all' | 'transcribe' | 'summarize';
      settings: Settings;
      template?: TemplateId;
    }
  | { target: 'offscreen'; type: 'ping' };

/** Fire-and-forget notifications any page may listen to. */
export type BroadcastMessage =
  | { type: 'recordings-changed'; recId: string }
  | { type: 'state-changed' }
  | { type: 'download-finished'; downloadId: number; ok: boolean; filename?: string; error?: string };

/** Messages for the content script inside the meeting tab. */
export type ContentMessage = { type: 'rec-indicator'; recording: boolean; startedAt?: number };

export function sendToBackground<T = unknown>(msg: BackgroundMessage): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>;
}

export function broadcast(msg: BroadcastMessage): void {
  // Rejects with "Receiving end does not exist" when no page listens; that is fine.
  browser.runtime.sendMessage(msg).catch(() => {});
}
