import { useEffect, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { blobToDataUrl, chat, parseJsonLoose, silentWav, transcribe } from '@/lib/ai';
import { sanitizeFolder } from '@/lib/files';
import { setUiLanguage, t, type I18nKey } from '@/lib/i18n';
import { normalizeFrameAnalyses, TEMPLATES, VISION_SYSTEM_PROMPT } from '@/lib/prompts';
import { getSettings, saveSettings, summaryEndpoint, visionEndpoint, type Settings } from '@/lib/settings';
import type { TemplateId } from '@/lib/types';
import { useMicPermission } from '@/components/hooks';

const TRANSCRIPTION_MODELS = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe-diarize', 'whisper-1'];
const SUMMARY_MODELS = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5-mini', 'o4-mini'];
const VISION_MODELS = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'gpt-5-mini', 'gpt-5'];
const LANGUAGES = [
  'English',
  'Bahasa Indonesia',
  'Bahasa Melayu',
  '中文（简体）',
  '中文（繁體）',
  '日本語',
  '한국어',
  'ภาษาไทย',
  'Tiếng Việt',
  'Tagalog',
  'हिन्दी',
  'বাংলা',
  'العربية',
  'فارسی',
  'עברית',
  'Türkçe',
  'Русский',
  'Українська',
  'Deutsch',
  'Français',
  'Español',
  'Português',
  'Italiano',
  'Nederlands',
  'Polski',
  'Svenska',
];
const OPENAI_ORIGIN = 'https://api.openai.com';

function Field(props: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{props.label}</span>
      {props.children}
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
}

function Check(props: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

function Secret(props: { value: string; onChange: (v: string) => void }) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="secret">
      <input
        type={visible ? 'text' : 'password'}
        value={props.value}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <button type="button" className="small" onClick={() => setVisible(!visible)}>
        {visible ? '🙈' : '👁'}
      </button>
    </span>
  );
}

function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || u.origin === OPENAI_ORIGIN) return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/** Asks Chrome for access to custom API hosts. Must run directly in a click handler. */
function requestHostAccess(s: Settings): Promise<string[]> {
  const origins = [
    ...new Set(
      [s.transcription.baseUrl, summaryEndpoint(s).baseUrl, visionEndpoint(s).baseUrl].map(originPattern).filter(Boolean),
    ),
  ] as string[];
  if (!origins.length) return Promise.resolve([]);
  return browser.permissions.request({ origins }).then(
    (granted) => (granted ? [] : origins),
    () => origins,
  );
}

type TestState = { status: 'idle' | 'running' | 'ok' | 'error'; message?: string };

/** A small slide with known text, to check that the vision model really reads images. */
const TEST_SLIDE_TEXT = 'Q4 ROADMAP 2026';

async function testSlide(): Promise<Blob> {
  const canvas = new OffscreenCanvas(640, 360);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#1a56db';
  g.fillRect(0, 0, 640, 360);
  g.fillStyle = '#fff';
  g.font = 'bold 56px sans-serif';
  g.fillText(TEST_SLIDE_TEXT, 40, 190);
  return canvas.convertToBlob({ type: 'image/png' });
}

function TestButton(props: { run: () => Promise<string | void> }) {
  const [state, setState] = useState<TestState>({ status: 'idle' });
  const onClick = async () => {
    setState({ status: 'running' });
    try {
      const detail = await props.run();
      setState({ status: 'ok', message: detail || undefined });
    } catch (err) {
      setState({ status: 'error', message: (err as Error).message });
    }
  };
  return (
    <div className="row">
      <button type="button" onClick={onClick} disabled={state.status === 'running'}>
        {state.status === 'running' ? t('options.testing') : t('options.test')}
      </button>
      {state.status === 'ok' && (
        <span className="banner ok small">
          {state.message ? t('options.testOkRead', { text: state.message }) : t('options.testOk')}
        </span>
      )}
      {state.status === 'error' && (
        <span className="banner error small">{t('options.testFailed', { error: state.message ?? '' })}</span>
      )}
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [, setLang] = useState('');
  const mic = useMicPermission();
  const [micError, setMicError] = useState('');

  useEffect(() => {
    void getSettings().then((s) => {
      setUiLanguage(s.uiLanguage);
      setSettings(s);
    });
  }, []);

  if (!settings) return null;
  const s = settings;

  function update(patch: Partial<Settings>) {
    setSettings((prev) => ({ ...prev!, ...patch }));
    setDirty(true);
    setMessage(null);
  }
  const updateTranscription = (patch: Partial<Settings['transcription']>) =>
    update({ transcription: { ...s.transcription, ...patch } });
  const updateSummary = (patch: Partial<Settings['summary']>) => update({ summary: { ...s.summary, ...patch } });
  const updateSlides = (patch: Partial<Settings['slides']>) => update({ slides: { ...s.slides, ...patch } });
  const updateVision = (patch: Partial<Settings['vision']>) => update({ vision: { ...s.vision, ...patch } });

  function save() {
    // Permission prompt first, while the click still counts as a user gesture.
    const pending = requestHostAccess(s);
    void pending.then(async (denied) => {
      const cleaned: Settings = {
        ...s,
        folder: sanitizeFolder(s.folder),
        segmentMinutes: Math.min(20, Math.max(1, Math.round(s.segmentMinutes) || 5)),
        summary: { ...s.summary, maxCharsPerRequest: Math.max(4000, Math.round(s.summary.maxCharsPerRequest) || 120000) },
        slides: {
          ...s.slides,
          maxFrames: Math.min(500, Math.max(1, Math.round(s.slides.maxFrames) || 150)),
          perTopic: Math.min(4, Math.max(0, Math.round(s.slides.perTopic) || 0)),
        },
      };
      await saveSettings(cleaned);
      setSettings(cleaned);
      setDirty(false);
      setMessage(
        denied.length
          ? { kind: 'warn', text: t('options.permissionDenied', { origin: denied.join(', ') }) }
          : { kind: 'ok', text: t('options.saved') },
      );
    });
  }

  async function grantMic() {
    setMicError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((tr) => tr.stop());
    } catch (err) {
      setMicError((err as Error).name);
    }
  }

  const testTranscription = async () => {
    await requestHostAccess(s);
    await transcribe(s.transcription, silentWav(), { filename: 'test.wav' });
  };
  const testSummary = async () => {
    await requestHostAccess(s);
    const reply = await chat(
      summaryEndpoint(s),
      [{ role: 'user', content: 'Reply with the JSON object {"ok": true} and nothing else.' }],
      {
        json: s.summary.jsonMode,
        temperature: s.summary.temperature,
      },
    );
    parseJsonLoose(reply);
  };
  const testVision = async () => {
    await requestHostAccess(s);
    const reply = await chat(
      visionEndpoint(s),
      [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Image #1 at [00:00:00]' },
            { type: 'image_url', image_url: { url: await blobToDataUrl(await testSlide()), detail: s.vision.detail } },
          ],
        },
      ],
      { json: s.vision.jsonMode, temperature: s.vision.temperature },
    );
    const analysis = normalizeFrameAnalyses(parseJsonLoose(reply)).get(1);
    if (!analysis) throw new Error('The reply did not describe the test image');
    return analysis.text || analysis.caption;
  };

  return (
    <div className="page">
      <header>
        <img src="/icon/48.png" alt="" />
        <h1>
          {t('appName')} · {t('options.title')}
        </h1>
        <span className="spacer" />
        <a className="btn small" href="/library.html">
          {t('popup.library')}
        </a>
      </header>

      <section className="card welcome" id="welcome">
        <h2>{t('options.welcome')}</h2>
        <ol>
          <li>{t('options.step1')}</li>
          <li>{t('options.step2')}</li>
          <li>{t('options.step3')}</li>
        </ol>
        {mic === 'granted' ? (
          <div className="banner ok">✓ {t('options.micGranted')}</div>
        ) : (
          <div className="stack">
            <div>
              <button className="primary" onClick={grantMic}>
                🎙 {t('options.micGrant')}
              </button>
            </div>
            {(mic === 'denied' || micError) && <div className="banner error">{t('options.micDenied')}</div>}
          </div>
        )}
      </section>

      <section className="card stack">
        <h2>{t('options.section.storage')}</h2>
        <Field label={t('options.folder')} hint={t('options.folderHint')}>
          <input type="text" value={s.folder} onChange={(e) => update({ folder: e.target.value })} />
        </Field>
        <Check label={t('options.askWhere')} checked={s.askWhereToSave} onChange={(v) => update({ askWhereToSave: v })} />
      </section>

      <section className="card stack">
        <h2>{t('options.section.recording')}</h2>
        <div className="grid2">
          <Field label={t('options.resolution')}>
            <select
              value={s.videoResolution}
              onChange={(e) => update({ videoResolution: e.target.value as Settings['videoResolution'] })}
            >
              <option value="480p">480p</option>
              <option value="720p">720p (HD)</option>
              <option value="1080p">1080p (Full HD)</option>
            </select>
          </Field>
          <Field label={t('options.fps')}>
            <select value={s.videoFps} onChange={(e) => update({ videoFps: Number(e.target.value) as Settings['videoFps'] })}>
              <option value={15}>15</option>
              <option value={30}>30</option>
            </select>
          </Field>
          <Field label={t('options.bitrate')}>
            <input
              type="number"
              min={0}
              step={100}
              value={s.videoBitrateKbps}
              onChange={(e) => update({ videoBitrateKbps: Number(e.target.value) })}
            />
          </Field>
          <Field label={t('options.segment')} hint={t('options.segmentHint')}>
            <input
              type="number"
              min={1}
              max={20}
              value={s.segmentMinutes}
              onChange={(e) => update({ segmentMinutes: Number(e.target.value) })}
            />
          </Field>
        </div>
        <Check label={t('options.recordMic')} checked={s.recordMic} onChange={(v) => update({ recordMic: v })} />
      </section>

      <section className="card stack">
        <h2>{t('options.section.transcription')}</h2>
        <Field label={t('options.baseUrl')} hint={t('options.baseUrlHint')}>
          <input type="url" value={s.transcription.baseUrl} onChange={(e) => updateTranscription({ baseUrl: e.target.value })} />
        </Field>
        <div className="grid2">
          <Field label={t('options.apiKey')}>
            <Secret value={s.transcription.apiKey} onChange={(v) => updateTranscription({ apiKey: v })} />
          </Field>
          <Field label={t('options.model')}>
            <input
              type="text"
              list="transcription-models"
              value={s.transcription.model}
              onChange={(e) => updateTranscription({ model: e.target.value })}
            />
            <datalist id="transcription-models">
              {TRANSCRIPTION_MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
        </div>
        <div className="hint small muted">{t('options.transcriptionModelHint')}</div>
        <div className="grid2">
          <Field label={t('options.language')} hint={t('options.languageHint')}>
            <input
              type="text"
              placeholder="auto"
              value={s.transcription.language}
              onChange={(e) => updateTranscription({ language: e.target.value })}
            />
          </Field>
          <Field label={t('options.extraHeaders')} hint={t('options.extraHeadersHint')}>
            <input
              type="text"
              placeholder="{}"
              value={s.transcription.extraHeaders}
              onChange={(e) => updateTranscription({ extraHeaders: e.target.value })}
            />
          </Field>
        </div>
        <Field label={t('options.vocabulary')}>
          <textarea value={s.transcription.vocabulary} onChange={(e) => updateTranscription({ vocabulary: e.target.value })} />
        </Field>
        <TestButton run={testTranscription} />
      </section>

      <section className="card stack">
        <h2>{t('options.section.summary')}</h2>
        <Check
          label={t('options.sameAsTranscription')}
          checked={s.summary.sameAsTranscription}
          onChange={(v) => updateSummary({ sameAsTranscription: v })}
        />
        {!s.summary.sameAsTranscription && (
          <>
            <Field label={t('options.baseUrl')}>
              <input type="url" value={s.summary.baseUrl} onChange={(e) => updateSummary({ baseUrl: e.target.value })} />
            </Field>
            <div className="grid2">
              <Field label={t('options.apiKey')}>
                <Secret value={s.summary.apiKey} onChange={(v) => updateSummary({ apiKey: v })} />
              </Field>
              <Field label={t('options.extraHeaders')}>
                <input
                  type="text"
                  placeholder="{}"
                  value={s.summary.extraHeaders}
                  onChange={(e) => updateSummary({ extraHeaders: e.target.value })}
                />
              </Field>
            </div>
          </>
        )}
        <div className="grid2">
          <Field label={t('options.model')} hint={t('options.summaryModelHint')}>
            <input
              type="text"
              list="summary-models"
              value={s.summary.model}
              onChange={(e) => updateSummary({ model: e.target.value })}
            />
            <datalist id="summary-models">
              {SUMMARY_MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <Field label={t('options.temperature')}>
            <input
              type="text"
              inputMode="decimal"
              placeholder="—"
              value={s.summary.temperature}
              onChange={(e) => updateSummary({ temperature: e.target.value })}
            />
          </Field>
          <Field label={t('options.maxChars')} hint={t('options.maxCharsHint')}>
            <input
              type="number"
              min={4000}
              step={1000}
              value={s.summary.maxCharsPerRequest}
              onChange={(e) => updateSummary({ maxCharsPerRequest: Number(e.target.value) })}
            />
          </Field>
        </div>
        <Check label={t('options.jsonMode')} checked={s.summary.jsonMode} onChange={(v) => updateSummary({ jsonMode: v })} />
        <TestButton run={testSummary} />
      </section>

      <section className="card stack">
        <h2>{t('options.section.vision')}</h2>
        <div className="small muted">{t('options.visionIntro')}</div>
        {!s.slides.analyze && <div className="banner warn">{t('options.visionDisabled')}</div>}
        <Check
          label={t('options.sameAsSummary')}
          checked={s.vision.sameAsSummary}
          onChange={(v) => updateVision({ sameAsSummary: v })}
        />
        {!s.vision.sameAsSummary && (
          <>
            <Field label={t('options.baseUrl')} hint={t('options.baseUrlHint')}>
              <input type="url" value={s.vision.baseUrl} onChange={(e) => updateVision({ baseUrl: e.target.value })} />
            </Field>
            <div className="grid2">
              <Field label={t('options.apiKey')}>
                <Secret value={s.vision.apiKey} onChange={(v) => updateVision({ apiKey: v })} />
              </Field>
              <Field label={t('options.extraHeaders')} hint={t('options.extraHeadersHint')}>
                <input
                  type="text"
                  placeholder="{}"
                  value={s.vision.extraHeaders}
                  onChange={(e) => updateVision({ extraHeaders: e.target.value })}
                />
              </Field>
            </div>
          </>
        )}
        <div className="grid2">
          <Field
            label={t('options.model')}
            hint={s.vision.sameAsSummary ? t('options.visionModelHintSame') : t('options.visionModelHint')}
          >
            <input
              type="text"
              list="vision-models"
              placeholder={s.vision.sameAsSummary ? s.summary.model : ''}
              value={s.vision.model}
              onChange={(e) => updateVision({ model: e.target.value })}
            />
            <datalist id="vision-models">
              {VISION_MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <Field label={t('options.slidesDetail')} hint={t('options.slidesDetailHint')}>
            <select
              value={s.vision.detail}
              onChange={(e) => updateVision({ detail: e.target.value as Settings['vision']['detail'] })}
            >
              <option value="auto">auto</option>
              <option value="low">low</option>
              <option value="high">high</option>
            </select>
          </Field>
          <Field label={t('options.temperature')}>
            <input
              type="text"
              inputMode="decimal"
              placeholder="—"
              value={s.vision.temperature}
              onChange={(e) => updateVision({ temperature: e.target.value })}
            />
          </Field>
        </div>
        <Check label={t('options.jsonMode')} checked={s.vision.jsonMode} onChange={(v) => updateVision({ jsonMode: v })} />
        <TestButton run={testVision} />
      </section>

      <section className="card stack">
        <h2>{t('options.section.slides')}</h2>
        <Check label={t('options.slidesCapture')} checked={s.slides.capture} onChange={(v) => updateSlides({ capture: v })} />
        {s.slides.capture && (
          <div className="grid2">
            <Field label={t('options.slidesSensitivity')} hint={t('options.slidesSensitivityHint')}>
              <select
                value={s.slides.sensitivity}
                onChange={(e) => updateSlides({ sensitivity: e.target.value as Settings['slides']['sensitivity'] })}
              >
                <option value="low">{t('options.sensitivity.low')}</option>
                <option value="medium">{t('options.sensitivity.medium')}</option>
                <option value="high">{t('options.sensitivity.high')}</option>
              </select>
            </Field>
            <Field label={t('options.slidesMax')}>
              <input
                type="number"
                min={1}
                max={500}
                value={s.slides.maxFrames}
                onChange={(e) => updateSlides({ maxFrames: Number(e.target.value) })}
              />
            </Field>
          </div>
        )}
        <Check label={t('options.slidesAnalyze')} checked={s.slides.analyze} onChange={(v) => updateSlides({ analyze: v })} />
        {s.slides.analyze && (
          <div className="grid2">
            <Field label={t('options.slidesPerTopic')}>
              <input
                type="number"
                min={0}
                max={4}
                value={s.slides.perTopic}
                onChange={(e) => updateSlides({ perTopic: Number(e.target.value) })}
              />
            </Field>
          </div>
        )}
      </section>

      <section className="card stack">
        <h2>{t('options.section.output')}</h2>
        <div className="grid2">
          <Field label={t('options.outputLanguage')} hint={t('options.outputLanguageHint')}>
            <input
              type="text"
              list="languages"
              placeholder="auto"
              value={s.outputLanguage}
              onChange={(e) => update({ outputLanguage: e.target.value })}
            />
            <datalist id="languages">
              {LANGUAGES.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </Field>
          <Field label={t('options.template')}>
            <select value={s.template} onChange={(e) => update({ template: e.target.value as TemplateId })}>
              {(Object.keys(TEMPLATES) as TemplateId[]).map((id) => (
                <option key={id} value={id}>
                  {t(`template.${id}` as I18nKey)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t('options.customInstructions')}>
          <textarea value={s.customInstructions} onChange={(e) => update({ customInstructions: e.target.value })} />
        </Field>
        <Check label={t('options.autoProcess')} checked={s.autoProcess} onChange={(v) => update({ autoProcess: v })} />
        <Check label={t('options.autoPdf')} checked={s.autoPdf} onChange={(v) => update({ autoPdf: v })} />
        <Check
          label={t('options.includeTranscript')}
          checked={s.pdfIncludeTranscript}
          onChange={(v) => update({ pdfIncludeTranscript: v })}
        />
        <Check label={t('options.saveTextFiles')} checked={s.saveTextFiles} onChange={(v) => update({ saveTextFiles: v })} />
      </section>

      <section className="card stack">
        <h2>{t('options.section.interface')}</h2>
        <Field label={t('options.uiLanguage')}>
          <select
            value={s.uiLanguage}
            onChange={(e) => {
              const v = e.target.value as Settings['uiLanguage'];
              setUiLanguage(v);
              setLang(v);
              update({ uiLanguage: v });
            }}
          >
            <option value="auto">{t('options.auto')}</option>
            <option value="en">English</option>
            <option value="id">Bahasa Indonesia</option>
          </select>
        </Field>
      </section>

      <div className="savebar">
        <div>
          <button className="primary" onClick={save}>
            {t('options.save')}
          </button>
          {message ? (
            <span className={`banner ${message.kind}`}>{message.text}</span>
          ) : (
            dirty && <span className="muted">{t('options.unsaved')}</span>
          )}
        </div>
      </div>
    </div>
  );
}
