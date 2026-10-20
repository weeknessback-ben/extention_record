import { browser, type Browser } from 'wxt/browser';
import { getRecording, listRecordings, updateRecording } from '@/lib/db';
import { setUiLanguage, t } from '@/lib/i18n';
import {
  broadcast,
  type BackgroundMessage,
  type BackgroundState,
  type ContentMessage,
  type OffscreenMessage,
} from '@/lib/messages';
import { cleanTabTitle, siteOf } from '@/lib/meeting';
import { getSettings, isAiConfigured } from '@/lib/settings';
import type { ActiveRecording } from '@/lib/types';

const OFFSCREEN_PATH = '/offscreen.html';

export default defineBackground(() => {
  // ---------------------------------------------------------------------------
  // Active recording state lives in session storage so it survives the service
  // worker being suspended.

  async function getActive(): Promise<ActiveRecording | null> {
    const data = await browser.storage.session.get('active');
    return (data.active as ActiveRecording | undefined) ?? null;
  }

  async function setActive(active: ActiveRecording | null): Promise<void> {
    if (active) await browser.storage.session.set({ active });
    else await browser.storage.session.remove('active');
    await browser.action.setBadgeText({ text: active ? 'REC' : '' });
    await browser.action.setBadgeBackgroundColor({ color: '#d93025' });
    broadcast({ type: 'state-changed' });
  }

  function notifyTab(tabId: number, msg: ContentMessage): void {
    if (tabId >= 0) browser.tabs.sendMessage(tabId, msg).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Offscreen document

  let creating: Promise<void> | undefined;

  async function ensureOffscreen(): Promise<void> {
    const url = browser.runtime.getURL(OFFSCREEN_PATH);
    const contexts = await browser.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as Browser.runtime.ContextType],
      documentUrls: [url],
    });
    if (contexts.length) return;
    creating ??= browser.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA' as Browser.offscreen.Reason, 'BLOBS' as Browser.offscreen.Reason],
        justification: 'Record the captured meeting tab and microphone, and process recordings.',
      })
      .finally(() => {
        creating = undefined;
      });
    await creating;
  }

  async function toOffscreen<T extends { ok: boolean; error?: string }>(msg: OffscreenMessage): Promise<T> {
    await ensureOffscreen();
    const res = (await browser.runtime.sendMessage(msg)) as T | undefined;
    if (!res) throw new Error('The recording engine did not respond');
    if (!res.ok) throw new Error(res.error || 'Unknown error');
    return res;
  }

  // ---------------------------------------------------------------------------
  // Recording

  async function startRecording(tabId: number, title: string, recordMic: boolean, synthetic = false) {
    const settings = await getSettings();
    setUiLanguage(settings.uiLanguage);
    if (await getActive()) throw new Error(t('error.alreadyRecording'));

    let pageUrl = 'about:blank';
    let streamId = '';
    if (tabId >= 0) {
      const tab = await browser.tabs.get(tabId);
      if (!tab.url || !/^https?:/.test(tab.url)) throw new Error(t('error.cannotRecord'));
      pageUrl = tab.url;
    }
    if (!synthetic) {
      // Only allowed right after the user invoked the extension on this tab
      // (popup, keyboard shortcut).
      streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tabId });
    }

    const recId = crypto.randomUUID();
    const res = await toOffscreen<{ ok: boolean; startedAt: number; hasMic: boolean; micError?: string }>({
      target: 'offscreen',
      type: 'start',
      recId,
      streamId,
      title,
      pageUrl,
      settings,
      recordMic,
      synthetic,
    });
    const active: ActiveRecording = {
      recId,
      tabId,
      title,
      startedAt: res.startedAt,
      pageOrigin: tabId >= 0 ? new URL(pageUrl).origin : '',
    };
    await setActive(active);
    notifyTab(tabId, { type: 'rec-indicator', recording: true, startedAt: res.startedAt });
    return { ok: true, recId, hasMic: res.hasMic, micError: res.micError };
  }

  async function stopRecording() {
    const active = await getActive();
    if (!active) return { ok: true };
    try {
      await toOffscreen({ target: 'offscreen', type: 'stop', settings: await getSettings() });
    } finally {
      await setActive(null);
      notifyTab(active.tabId, { type: 'rec-indicator', recording: false });
    }
    return { ok: true, recId: active.recId };
  }

  /** The recorder stopped by itself (e.g. the meeting tab was closed). */
  async function onRecorderStopped(recId: string, reason: string) {
    const active = await getActive();
    if (active?.recId !== recId) return;
    await setActive(null);
    notifyTab(active.tabId, { type: 'rec-indicator', recording: false });
    if (reason !== 'user') {
      const settings = await getSettings();
      setUiLanguage(settings.uiLanguage);
      await browser.notifications.create(`library:${recId}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title: t('notify.stoppedTitle'),
        message: t('notify.stoppedBody', { title: active.title }),
      });
    }
  }

  async function onPipelineFinished(recId: string, ok: boolean, error?: string) {
    const settings = await getSettings();
    setUiLanguage(settings.uiLanguage);
    const rec = await getRecording(recId);
    const title = rec?.summary?.title || rec?.title || '';
    if (ok) {
      if (settings.autoPdf) {
        // The report page exports the PDF (and text files) itself, then closes.
        await browser.tabs.create({ url: reportUrl(recId, true), active: false });
      }
      await browser.notifications.create(`report:${recId}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title: t('notify.readyTitle'),
        message: title,
      });
    } else {
      await browser.notifications.create(`library:${recId}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title: t('notify.failedTitle'),
        message: `${title}\n${error ?? ''}`.trim(),
      });
    }
  }

  function reportUrl(recId: string, auto = false): string {
    return `${browser.runtime.getURL('/report.html')}?id=${encodeURIComponent(recId)}${auto ? '&auto=1' : ''}`;
  }

  // ---------------------------------------------------------------------------
  // Message router

  async function handle(msg: BackgroundMessage, sender: Browser.runtime.MessageSender): Promise<unknown> {
    switch (msg.type) {
      case 'indicator-query': {
        const active = await getActive();
        const mine = Boolean(active && sender.tab?.id === active.tabId);
        const reply: ContentMessage = { type: 'rec-indicator', recording: mine, startedAt: mine ? active!.startedAt : undefined };
        return reply;
      }
      case 'get-state': {
        const settings = await getSettings();
        const state: BackgroundState = { active: await getActive(), configured: isAiConfigured(settings), settings };
        return state;
      }
      case 'start':
        return startRecording(msg.tabId, msg.title, msg.recordMic);
      case 'stop':
        return stopRecording();
      case 'process': {
        const settings = await getSettings();
        return toOffscreen({
          target: 'offscreen',
          type: 'process',
          recId: msg.recId,
          mode: msg.mode,
          settings,
          template: msg.template,
        });
      }
      case 'download': {
        const downloadId = await browser.downloads.download({
          url: msg.url,
          filename: msg.filename,
          saveAs: msg.saveAs,
          conflictAction: msg.conflictAction,
        });
        return { ok: true, downloadId };
      }
      case 'recorder-stopped':
        await onRecorderStopped(msg.recId, msg.reason);
        return { ok: true };
      case 'pipeline-finished':
        await onPipelineFinished(msg.recId, msg.ok, msg.error);
        return { ok: true };
      case 'e2e-start':
        if (import.meta.env.MODE !== 'e2e') return undefined;
        return startRecording(msg.tabId, msg.title, msg.recordMic, true);
    }
  }

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const msg = message as BackgroundMessage & { target?: string };
    if (!msg || msg.target) return;
    const known = [
      'get-state',
      'indicator-query',
      'start',
      'stop',
      'process',
      'download',
      'recorder-stopped',
      'pipeline-finished',
      'e2e-start',
    ];
    if (!known.includes(msg.type)) return;
    handle(msg, sender).then(sendResponse, (err: Error) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  });

  // ---------------------------------------------------------------------------
  // Events

  browser.commands.onCommand.addListener(async (command, tab) => {
    if (command !== 'toggle-recording') return;
    if (await getActive()) {
      await stopRecording();
      return;
    }
    const target = tab ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    if (target?.id === undefined) return;
    const settings = await getSettings();
    try {
      await startRecording(target.id, cleanTabTitle(target.title ?? '', target.url ?? ''), settings.recordMic);
    } catch (err) {
      await browser.notifications.create({
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title: t('appName'),
        message: (err as Error).message,
      });
    }
  });

  browser.tabs.onRemoved.addListener(async (tabId) => {
    const active = await getActive();
    if (active?.tabId === tabId) await stopRecording().catch(() => {});
  });

  browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (!changeInfo.url) return;
    const active = await getActive();
    if (active?.tabId !== tabId || !active.pageOrigin) return;
    // Navigating away from the meeting site ends the recording.
    if (siteOf(changeInfo.url) !== siteOf(active.pageOrigin)) await stopRecording().catch(() => {});
  });

  // Tell the offscreen document when downloads it asked for are finished.
  browser.downloads.onChanged.addListener(async (delta) => {
    const state = delta.state?.current;
    if (state !== 'complete' && state !== 'interrupted') return;
    const [item] = await browser.downloads.search({ id: delta.id });
    broadcast({
      type: 'download-finished',
      downloadId: delta.id,
      ok: state === 'complete',
      filename: item?.filename,
      error: item?.error,
    });
  });

  browser.notifications.onClicked.addListener(async (notificationId) => {
    const [kind, recId = ''] = notificationId.split(':');
    const url = kind === 'report' ? reportUrl(recId) : `${browser.runtime.getURL('/library.html')}#${recId}`;
    await browser.tabs.create({ url });
    await browser.notifications.clear(notificationId);
  });

  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') void browser.tabs.create({ url: browser.runtime.getURL('/options.html#welcome') });
  });

  // After a browser restart nothing is recording or processing any more.
  browser.runtime.onStartup.addListener(async () => {
    await setActive(null);
    for (const rec of await listRecordings()) {
      if (rec.status === 'recording' || rec.status === 'saving') {
        await updateRecording(rec.id, { status: 'interrupted' });
      } else if (rec.status === 'transcribing' || rec.status === 'summarizing') {
        await updateRecording(rec.id, { status: 'error', error: 'Processing was interrupted.', progress: undefined });
      }
    }
  });
});
