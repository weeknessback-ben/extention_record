import { useCallback, useEffect, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { formatClock, platformName } from '@/lib/format';
import { setUiLanguage, t } from '@/lib/i18n';
import { cleanTabTitle, detectPlatform } from '@/lib/meeting';
import { sendToBackground, type BackgroundState } from '@/lib/messages';
import { useMicPermission, useNow, useRuntimeMessage } from '@/components/hooks';

type Tab = Browser.tabs.Tab;

export default function App() {
  const [state, setState] = useState<BackgroundState | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [title, setTitle] = useState('');
  const [mic, setMic] = useState(true);
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [shortcut, setShortcut] = useState('');
  const micPermission = useMicPermission();
  const now = useNow(state?.active ? 1000 : null);

  const refresh = useCallback(async () => {
    const s = await sendToBackground<BackgroundState>({ type: 'get-state' });
    setUiLanguage(s.settings.uiLanguage);
    setState(s);
    return s;
  }, []);

  useEffect(() => {
    void (async () => {
      const [current] = await browser.tabs.query({ active: true, currentWindow: true });
      setTab(current ?? null);
      const s = await refresh();
      setMic(s.settings.recordMic);
      if (current) setTitle(cleanTabTitle(current.title ?? '', current.url ?? ''));
      const commands = await browser.commands.getAll();
      setShortcut(commands.find((c) => c.name === 'toggle-recording')?.shortcut ?? '');
    })();
  }, [refresh]);

  useRuntimeMessage((msg) => {
    if (msg.type === 'state-changed') void refresh();
  });

  if (!state) return <div className="popup" />;

  const active = state.active;
  const url = tab?.url ?? '';
  const recordable = /^https?:/.test(url);
  const platform = detectPlatform(url);
  const recordingThisTab = active && active.tabId === tab?.id;

  async function start() {
    if (!tab?.id) return;
    setBusy('start');
    setError('');
    setNotice('');
    try {
      const res = await sendToBackground<{ ok: boolean; error?: string; micError?: string }>({
        type: 'start',
        tabId: tab.id,
        title: title.trim() || cleanTabTitle(tab.title ?? '', url),
        recordMic: mic,
      });
      if (!res.ok) throw new Error(res.error);
      if (mic && res.micError) setNotice(t('popup.micFailed', { error: res.micError }));
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    setBusy('stop');
    setError('');
    try {
      const res = await sendToBackground<{ ok: boolean; error?: string }>({ type: 'stop' });
      if (!res.ok) throw new Error(res.error);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const openPage = (path: string) => {
    void browser.tabs.create({ url: browser.runtime.getURL(path as '/library.html') });
    window.close();
  };

  return (
    <div className="popup">
      <header>
        <img className="logo" src="/icon/48.png" alt="" />
        <h1>{t('appName')}</h1>
        <span className="spacer" />
        {active && (
          <span className="badge recording">
            <span className="dot live" /> REC
          </span>
        )}
      </header>

      {active ? (
        <>
          <div className="timer">{formatClock((now - active.startedAt) / 1000)}</div>
          <div className="muted" style={{ textAlign: 'center' }}>
            {active.title}
          </div>
          {!recordingThisTab && active.tabId >= 0 && (
            <div className="banner warn row">
              {t('popup.otherTab')}
              <button className="link" onClick={() => void browser.tabs.update(active.tabId, { active: true })}>
                {t('popup.goToTab')}
              </button>
            </div>
          )}
          <button className="rec big" disabled={busy !== null} onClick={stop}>
            ■ {busy === 'stop' ? t('popup.stopping') : t('popup.stop')}
          </button>
        </>
      ) : recordable ? (
        <>
          <div className="small muted">
            {platform === 'other' ? t('popup.notMeeting') : t('popup.detected', { platform: platformName(platform) })}
          </div>
          <label>
            <div className="field-label">{t('popup.title')}</div>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={mic} onChange={(e) => setMic(e.target.checked)} />
            <span>{t('popup.mic')}</span>
          </label>
          {mic && micPermission !== 'granted' && (
            <div className="banner warn">
              {t('popup.micNeeded')}{' '}
              <button className="link" onClick={() => openPage('/options.html#welcome')}>
                {t('popup.grantMic')}
              </button>
            </div>
          )}
          <button className="rec big" disabled={busy !== null} onClick={start}>
            <span className="dot" style={{ background: '#fff' }} /> {busy === 'start' ? t('popup.starting') : t('popup.start')}
          </button>
          <div className="small muted">{t('popup.consent')}</div>
        </>
      ) : (
        <div className="banner warn">{t('popup.cannotRecord')}</div>
      )}

      {!state.configured && (
        <div className="banner warn">
          {t('popup.notConfigured')}{' '}
          <button className="link" onClick={() => openPage('/options.html')}>
            {t('popup.openSettings')}
          </button>
        </div>
      )}
      {notice && <div className="banner warn">{notice}</div>}
      {error && <div className="banner error">{error}</div>}

      <footer>
        <button className="link" onClick={() => openPage('/library.html')}>
          {t('popup.library')}
        </button>
        {shortcut && <span className="small muted">{t('popup.shortcut', { key: shortcut })}</span>}
        <button className="link" onClick={() => openPage('/options.html')}>
          {t('popup.settings')}
        </button>
      </footer>
    </div>
  );
}
