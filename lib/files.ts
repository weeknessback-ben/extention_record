import { browser } from 'wxt/browser';
import type { BroadcastMessage } from './messages';

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Makes one path segment safe for every OS while keeping non-Latin scripts. */
export function sanitizeSegment(name: string, maxLength = 80): string {
  let out = name.replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
  out = out.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (out.length > maxLength) out = out.slice(0, maxLength).trim();
  if (!out) out = 'untitled';
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`;
  return out;
}

/** Sanitises a user-supplied relative folder such as "Work/Meetings". */
export function sanitizeFolder(folder: string): string {
  const parts = folder
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..')
    .map((p) => sanitizeSegment(p));
  return parts.length ? parts.join('/') : 'MeetingRecorder';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "<base>/2026-10-20 14.05 - Weekly sync" */
export function recordingFolder(base: string, startedAt: number, title: string): string {
  const d = new Date(startedAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  return `${sanitizeFolder(base)}/${stamp} - ${sanitizeSegment(title, 60)}`;
}

export interface SaveOptions {
  saveAs?: boolean;
  conflictAction?: 'uniquify' | 'overwrite';
}

export interface SavedFile {
  downloadId: number;
  /** Absolute path chosen by Chrome. */
  filename: string;
}

/**
 * Saves a blob below the Chrome downloads directory. Works in extension pages
 * (direct chrome.downloads access) and in the offscreen document, which has no
 * chrome.downloads and asks the background worker to start the download.
 */
export async function saveBlob(blob: Blob, path: string, opts: SaveOptions = {}): Promise<SavedFile> {
  const url = URL.createObjectURL(blob);
  try {
    if (browser.downloads) {
      const downloadId = await browser.downloads.download({
        url,
        filename: path,
        saveAs: opts.saveAs ?? false,
        conflictAction: opts.conflictAction ?? 'uniquify',
      });
      return await waitForDownload(downloadId);
    }
    const finished = collectFinishedDownloads();
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'download',
        url,
        filename: path,
        saveAs: opts.saveAs ?? false,
        conflictAction: opts.conflictAction ?? 'uniquify',
      })) as { ok: boolean; downloadId?: number; error?: string };
      if (!res?.ok || res.downloadId === undefined) throw new Error(res?.error || 'Download failed');
      return await finished.waitFor(res.downloadId);
    } finally {
      finished.dispose();
    }
  } finally {
    // Give Chrome a moment to release the blob before revoking it.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function waitForDownload(downloadId: number): Promise<SavedFile> {
  return new Promise((resolve, reject) => {
    const check = async () => {
      const [item] = await browser.downloads.search({ id: downloadId });
      if (!item) return reject(new Error('Download disappeared'));
      if (item.state === 'complete') {
        cleanup();
        resolve({ downloadId, filename: item.filename });
      } else if (item.state === 'interrupted') {
        cleanup();
        reject(new Error(`Download interrupted: ${item.error ?? 'unknown'}`));
      }
    };
    const listener = (delta: { id: number; state?: { current?: string } }) => {
      if (delta.id === downloadId && delta.state) void check();
    };
    const cleanup = () => browser.downloads.onChanged.removeListener(listener);
    browser.downloads.onChanged.addListener(listener);
    void check();
  });
}

/** Buffers download-finished broadcasts so none is missed before we know the id. */
function collectFinishedDownloads() {
  const done = new Map<number, BroadcastMessage & { type: 'download-finished' }>();
  const waiters = new Map<number, (m: BroadcastMessage & { type: 'download-finished' }) => void>();
  const listener = (msg: unknown) => {
    const m = msg as BroadcastMessage;
    if (m?.type !== 'download-finished') return;
    const waiter = waiters.get(m.downloadId);
    if (waiter) waiter(m);
    else done.set(m.downloadId, m);
  };
  browser.runtime.onMessage.addListener(listener);
  return {
    waitFor(id: number): Promise<SavedFile> {
      return new Promise((resolve, reject) => {
        const settle = (m: BroadcastMessage & { type: 'download-finished' }) =>
          m.ok ? resolve({ downloadId: id, filename: m.filename ?? '' }) : reject(new Error(m.error || 'Download failed'));
        const early = done.get(id);
        if (early) settle(early);
        else waiters.set(id, settle);
      });
    },
    dispose() {
      browser.runtime.onMessage.removeListener(listener);
    },
  };
}

export function textBlob(text: string, type = 'text/plain'): Blob {
  // BOM so Windows editors detect UTF-8 for non-Latin text.
  return new Blob(['﻿', text], { type: `${type};charset=utf-8` });
}
