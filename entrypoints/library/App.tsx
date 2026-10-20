import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { deleteRecording, listRecordings, updateRecording } from '@/lib/db';
import { formatBytes, formatDuration, platformName } from '@/lib/format';
import { setUiLanguage, t, uiLanguage, type I18nKey } from '@/lib/i18n';
import { sendToBackground, type BackgroundState } from '@/lib/messages';
import { TEMPLATES } from '@/lib/prompts';
import type { ActiveRecording, Recording, RecordingStatus, TemplateId } from '@/lib/types';
import { recoverRecording, saveVideo } from '@/lib/video';
import { useRuntimeMessage } from '@/components/hooks';

const BUSY: RecordingStatus[] = ['recording', 'saving', 'transcribing', 'analyzing', 'summarizing'];

function effectiveStatus(rec: Recording, active: ActiveRecording | null): RecordingStatus {
  // A "recording" entry that is not the live one was cut off (crash, browser closed).
  if (rec.status === 'recording' && active?.recId !== rec.id) return 'interrupted';
  return rec.status;
}

function RecordingCard(props: { rec: Recording; state: BackgroundState; highlight: boolean }) {
  const { rec, state } = props;
  const [title, setTitle] = useState(rec.title);
  const [notes, setNotes] = useState(rec.notes);
  const [working, setWorking] = useState(false);
  const [localError, setLocalError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setTitle(rec.title), [rec.title]);
  useEffect(() => setNotes(rec.notes), [rec.notes]);
  useEffect(() => {
    if (props.highlight) ref.current?.scrollIntoView({ block: 'center' });
  }, [props.highlight]);

  const status = effectiveStatus(rec, state.active);
  const busy = BUSY.includes(status) || working;
  const hasAudio = rec.audioSegments.length > 0;
  const partial = rec.transcriptParts && Object.keys(rec.transcriptParts).length > 0 && !rec.transcript;

  async function run(fn: () => Promise<unknown>) {
    setWorking(true);
    setLocalError('');
    try {
      await fn();
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  const process = (mode: 'all' | 'transcribe' | 'summarize') =>
    run(async () => {
      const res = await sendToBackground<{ ok: boolean; error?: string }>({
        type: 'process',
        recId: rec.id,
        mode,
        template: rec.template,
      });
      if (!res.ok) throw new Error(res.error);
    });

  const openReport = () =>
    browser.tabs.create({ url: `${browser.runtime.getURL('/report.html')}?id=${encodeURIComponent(rec.id)}` });

  const progress = rec.progress;
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div ref={ref} className={`card rec-card${props.highlight ? ' highlight' : ''}`}>
      <div className="rec-head">
        <div className="stack" style={{ gap: 4, flex: 1, minWidth: 0 }}>
          {rec.summary ? (
            <span className="title" onClick={openReport}>
              {rec.summary.title || rec.title}
            </span>
          ) : (
            <span className="title">{rec.title}</span>
          )}
          <div className="rec-meta">
            <span>{new Date(rec.startedAt).toLocaleString(uiLanguage())}</span>
            <span>{formatDuration(rec.durationMs)}</span>
            <span>{platformName(rec.platform)}</span>
            {!rec.hasMic && <span>{t('library.noMic')}</span>}
            <span>{t('library.segments', { n: rec.audioSegments.length })}</span>
            {(rec.frameCount ?? 0) > 0 && <span>{t('library.frames', { n: rec.frameCount ?? 0 })}</span>}
          </div>
        </div>
        <span className={`badge ${status}`}>
          {status === 'recording' && <span className="dot live" />}
          {t(`status.${status}` as I18nKey)}
        </span>
      </div>

      {progress && (
        <div className="stack" style={{ gap: 4 }}>
          <div className="small muted">
            {t(`library.stage.${progress.stage}` as I18nKey)} {progress.done}/{progress.total}
          </div>
          <div className="progress">
            <div style={{ width: `${Math.max(4, pct)}%` }} />
          </div>
        </div>
      )}

      {rec.summary?.executiveSummary && <div className="summary-preview">{rec.summary.executiveSummary}</div>}

      <div className="small muted">
        {t('library.folder')}: <code>{rec.folder}</code>
        {' · '}
        {rec.video.status === 'saved' && `${t('library.videoSaved')} (${formatBytes(rec.video.bytes ?? 0)})`}
        {rec.video.status === 'saving' && t('library.videoSaving')}
        {rec.video.status === 'pending' && t('library.videoPending')}
        {rec.video.status === 'failed' && (
          <span style={{ color: 'var(--rec)' }}>{t('library.videoFailed', { error: rec.video.error ?? '' })}</span>
        )}
      </div>

      {(rec.error || localError) && status !== 'recording' && <div className="banner error">{localError || rec.error}</div>}
      {rec.warning && !rec.error && <div className="banner warn">{rec.warning}</div>}

      {status !== 'recording' && (
        <div className="rec-details">
          <label className="field">
            <span className="small muted">{t('library.notes')}</span>
            <textarea
              placeholder={t('library.notesHint')}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => notes !== rec.notes && void updateRecording(rec.id, { notes })}
            />
          </label>
          <div className="stack" style={{ gap: 8 }}>
            <label className="field">
              <span className="small muted">{t('library.titleLabel')}</span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => title.trim() && title !== rec.title && void updateRecording(rec.id, { title: title.trim() })}
              />
            </label>
            <label className="field">
              <span className="small muted">{t('library.template')}</span>
              <select
                value={rec.template ?? state.settings.template}
                onChange={(e) => void updateRecording(rec.id, { template: e.target.value as TemplateId })}
              >
                {(Object.keys(TEMPLATES) as TemplateId[]).map((id) => (
                  <option key={id} value={id}>
                    {t(`template.${id}` as I18nKey)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}

      <div className="rec-actions">
        {rec.summary && (
          <button className="primary" onClick={openReport}>
            📄 {t('library.openReport')}
          </button>
        )}
        {status === 'interrupted' && (
          <button disabled={busy} onClick={() => run(() => recoverRecording(rec.id, state.settings.askWhereToSave))}>
            {t('library.recover')}
          </button>
        )}
        {hasAudio && !busy && status !== 'interrupted' && state.configured && (
          <>
            {!rec.transcript && (
              <button className={rec.summary ? '' : 'primary'} onClick={() => process('all')}>
                {partial || status === 'error' ? t('library.resume') : t('library.process')}
              </button>
            )}
            {rec.transcript && (
              <button onClick={() => process(rec.summary ? 'summarize' : 'all')}>
                {rec.summary ? t('library.resummarize') : t('library.resume')}
              </button>
            )}
            {rec.transcript && <button onClick={() => process('transcribe')}>{t('library.retranscribe')}</button>}
          </>
        )}
        {rec.video.status === 'failed' && status !== 'interrupted' && (
          <button disabled={busy} onClick={() => run(() => saveVideo(rec.id, state.settings.askWhereToSave))}>
            {t('library.saveVideo')}
          </button>
        )}
        {rec.video.status === 'saved' && rec.video.downloadId !== undefined && (
          <button onClick={() => browser.downloads.show(rec.video.downloadId!)}>{t('library.showFile')}</button>
        )}
        <span className="spacer" />
        {status !== 'recording' && (
          <button
            className="danger"
            disabled={busy}
            onClick={() => window.confirm(t('library.confirmDelete', { title: rec.title })) && void deleteRecording(rec.id)}
          >
            {t('library.delete')}
          </button>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [recs, setRecs] = useState<Recording[] | null>(null);
  const [state, setState] = useState<BackgroundState | null>(null);
  const [highlight] = useState(() => decodeURIComponent(location.hash.slice(1)));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback(async () => {
    const [list, s] = await Promise.all([listRecordings(), sendToBackground<BackgroundState>({ type: 'get-state' })]);
    setUiLanguage(s.settings.uiLanguage);
    setState(s);
    setRecs(list);
  }, []);

  const scheduleReload = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void reload(), 150);
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useRuntimeMessage((msg) => {
    if (msg.type === 'recordings-changed' || msg.type === 'state-changed') scheduleReload();
  });

  // Safety net in case a broadcast was missed while something is running.
  const anyBusy = recs?.some((r) => BUSY.includes(r.status)) ?? false;
  useEffect(() => {
    if (!anyBusy) return;
    const id = setInterval(() => void reload(), 5000);
    return () => clearInterval(id);
  }, [anyBusy, reload]);

  if (!recs || !state) return null;

  return (
    <div className="page">
      <header>
        <img src="/icon/48.png" alt="" />
        <h1>{t('library.title')}</h1>
        <span className="spacer" />
        <a className="btn small" href="/options.html">
          {t('library.settings')}
        </a>
      </header>
      <div className="small muted">{t('library.downloadsHint', { folder: state.settings.folder })}</div>
      {!state.configured && (
        <div className="banner warn">
          {t('library.notConfigured')} <a href="/options.html">{t('popup.openSettings')}</a>
        </div>
      )}
      {recs.length === 0 && <div className="card muted">{t('library.empty')}</div>}
      {recs.map((rec) => (
        <RecordingCard key={rec.id} rec={rec} state={state} highlight={rec.id === highlight} />
      ))}
    </div>
  );
}
