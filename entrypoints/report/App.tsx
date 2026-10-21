import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { getFramesByIds, getRecording, updateRecording } from '@/lib/db';
import { saveBlob, textBlob } from '@/lib/files';
import { Minutes } from '@/components/Minutes';
import { imageFileName, isRtl, labelsFor, pdfFooterTemplate, summaryToMarkdown, transcriptToText } from '@/lib/format';
import { setUiLanguage, t } from '@/lib/i18n';
import { getSettings, type Settings } from '@/lib/settings';
import type { FrameRecord, MeetingSummary, Recording } from '@/lib/types';

type ImageMap = Map<number, { url: string; frame: FrameRecord }>;

const params = new URLSearchParams(location.search);
const recId = params.get('id') ?? '';
const autoExport = params.get('auto') === '1';

function base64ToBlob(data: string, type: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * Prints this very tab to PDF through the DevTools protocol. Unlike JS PDF
 * libraries this uses Chrome's own text engine, so every script (CJK, Arabic,
 * Thai, Devanagari, …) renders correctly.
 */
async function printTabToPdf(footerTitle: string): Promise<Blob> {
  const tab = await browser.tabs.getCurrent();
  if (tab?.id === undefined) throw new Error('This page is not in a tab');
  const target = { tabId: tab.id };
  await browser.debugger.attach(target, '1.3');
  try {
    const res = (await browser.debugger.sendCommand(target, 'Page.printToPDF', {
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: pdfFooterTemplate(footerTitle),
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginTop: 0.6,
      marginBottom: 0.75,
      marginLeft: 0.6,
      marginRight: 0.6,
    })) as { data: string };
    return base64ToBlob(res.data, 'application/pdf');
  } finally {
    await browser.debugger.detach(target).catch(() => {});
  }
}

export default function App() {
  const [rec, setRec] = useState<Recording | null | undefined>(undefined);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const started = useRef(false);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setUiLanguage(s.uiLanguage);
      setSettings(s);
      setRec((await getRecording(recId)) ?? null);
    })();
  }, []);

  const summary = rec?.summary;
  const [images, setImages] = useState<ImageMap | null>(null);

  // Screenshots the AI picked for the topics, from IndexedDB.
  useEffect(() => {
    if (!summary) return;
    const ids = summary.topics.flatMap((topic) => topic.images.map((img) => img.id));
    let urls: string[] = [];
    void getFramesByIds(ids).then((frames) => {
      const map: ImageMap = new Map();
      for (const [id, frame] of frames) map.set(id, { url: URL.createObjectURL(frame.blob), frame });
      urls = [...map.values()].map((v) => v.url);
      setImages(map);
    });
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [summary]);

  useEffect(() => {
    if (summary && rec) {
      document.title = `${summary.title || rec.title} – ${labelsFor(summary).minutes}`;
      document.documentElement.lang = summary.language;
    }
  }, [summary, rec]);

  async function savePdf(): Promise<void> {
    if (!rec || !summary) return;
    setBusy(true);
    setMessage({ kind: 'ok', text: t('report.exporting') });
    try {
      const blob = await printTabToPdf(summary.title || rec.title);
      const saved = await saveBlob(blob, `${rec.folder}/minutes.pdf`, { conflictAction: 'overwrite' });
      await updateRecording(rec.id, { pdf: { filename: saved.filename, savedAt: Date.now() } });
      setMessage({ kind: 'ok', text: t('report.saved', { path: saved.filename }) });
    } catch (err) {
      setMessage({ kind: 'warn', text: t('report.pdfFallback', { error: (err as Error).message }) });
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function saveText(kind: 'md' | 'txt'): Promise<string> {
    if (!rec || !summary || !settings) return '';
    let blob: Blob;
    if (kind === 'md') {
      // Save the chosen screenshots next to the Markdown so its image links work.
      for (const { frame } of images?.values() ?? []) {
        await saveBlob(frame.blob, `${rec.folder}/${imageFileName(frame.t)}`, { conflictAction: 'overwrite' });
      }
      const path = (id: number) => {
        const image = images?.get(id);
        return image ? imageFileName(image.frame.t) : undefined;
      };
      blob = textBlob(summaryToMarkdown(rec, summary, settings.pdfIncludeTranscript, path), 'text/markdown');
    } else {
      blob = textBlob(transcriptToText(rec));
    }
    const saved = await saveBlob(blob, `${rec.folder}/${kind === 'md' ? 'minutes.md' : 'transcript.txt'}`, {
      conflictAction: 'overwrite',
    });
    setMessage({ kind: 'ok', text: t('report.saved', { path: saved.filename }) });
    return saved.filename;
  }

  // Opened automatically after processing: export everything, then close.
  useEffect(() => {
    if (!autoExport || started.current || !rec || !summary || !settings || !images) return;
    started.current = true;
    void (async () => {
      // Let fonts, images and layout settle before printing.
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
      await new Promise((r) => setTimeout(r, 300));
      try {
        await savePdf();
        if (settings.saveTextFiles) {
          await saveText('md');
          await saveText('txt');
        }
        const tab = await browser.tabs.getCurrent();
        if (tab?.id !== undefined) await browser.tabs.remove(tab.id);
      } catch {
        // Keep the tab open; the banner explains what to do.
      }
    })();
  }, [rec, summary, settings, images]);

  if (rec === undefined || !settings) return null;
  if (rec === null)
    return (
      <div className="page">
        <div className="banner error">{t('report.notFound')}</div>
      </div>
    );
  if (!summary)
    return (
      <div className="page">
        <div className="banner warn">{t('report.noSummary')}</div>
      </div>
    );

  const copyMarkdown = async () => {
    await navigator.clipboard.writeText(summaryToMarkdown(rec, summary, settings.pdfIncludeTranscript));
    setMessage({ kind: 'ok', text: t('report.copied') });
  };

  return (
    <div className="page">
      <div className="toolbar no-print">
        <a className="btn small" href="/library.html">
          ← {t('report.back')}
        </a>
        <span className="spacer" />
        <button className="primary" disabled={busy} onClick={() => void savePdf().catch(() => {})}>
          ⬇ {busy ? t('report.exporting') : t('report.savePdf')}
        </button>
        <button onClick={() => window.print()}>{t('report.print')}</button>
        <button onClick={() => setEditing(!editing)}>{editing ? t('report.doneEditing') : t('report.edit')}</button>
        <button onClick={() => void saveText('md')}>{t('report.saveMd')}</button>
        <button onClick={() => void saveText('txt')}>{t('report.saveTxt')}</button>
        <button onClick={() => void copyMarkdown()}>{t('report.copyMd')}</button>
      </div>
      {editing && <div className="banner warn no-print">{t('report.editHint')}</div>}
      {message && <div className={`banner ${message.kind} no-print`}>{message.text}</div>}
      <article
        className="doc"
        lang={summary.language}
        dir={isRtl(summary.language) ? 'rtl' : 'ltr'}
        contentEditable={editing}
        suppressContentEditableWarning
      >
        <Minutes rec={rec} s={summary} includeTranscript={settings.pdfIncludeTranscript} images={images ?? new Map()} />
      </article>
    </div>
  );
}
