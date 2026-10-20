// End-to-end test: loads the e2e build into Chromium, records a synthetic
// "meeting" (animated canvas + tone) for ~70 s, then lets the extension
// transcribe and summarise it against a mock OpenAI-compatible server and
// checks the files written to disk (video, PDF, Markdown, transcript).
//
//   npm run test:e2e        (builds with --mode e2e first)
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionPath = path.join(root, '.output/chrome-mv3-e2e');
const tmp = path.join(root, 'tests/e2e/.tmp');
const downloads = path.join(tmp, 'downloads');
const shots = path.join(tmp, 'screenshots');
const RECORD_SECONDS = Number(process.env.RECORD_SECONDS ?? 70);
// The test records ~3 s before the timed part; segments rotate every minute.
const EXPECTED_SEGMENTS = Math.floor((RECORD_SECONDS + 3) / 60) + 1;

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(downloads, { recursive: true });
fs.mkdirSync(shots, { recursive: true });

const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible API

const SUMMARY = {
  language: 'id',
  labels: {
    minutes: 'Notulen Rapat',
    date: 'Tanggal',
    duration: 'Durasi',
    platform: 'Platform',
    spokenLanguages: 'Bahasa',
    participants: 'Peserta',
    executiveSummary: 'Ringkasan Eksekutif',
    keyPoints: 'Poin Penting',
    topics: 'Pembahasan',
    decisions: 'Keputusan',
    actionItems: 'Tindak Lanjut',
    task: 'Tugas',
    owner: 'PIC',
    deadline: 'Tenggat',
    priority: 'Prioritas',
    openQuestions: 'Pertanyaan Terbuka',
    nextSteps: 'Langkah Berikutnya',
    timeline: 'Linimasa',
    transcript: 'Transkrip',
  },
  title: 'Rapat Mingguan Tim Produk',
  spokenLanguages: ['Bahasa Indonesia', 'English', '日本語'],
  participants: [
    { name: 'Budi Santoso', role: 'Product Manager' },
    { name: '田中 太郎', role: 'Engineer' },
    { name: 'أحمد', role: 'Designer' },
  ],
  executiveSummary: 'Tim membahas rilis versi 2.0 dan menyepakati tanggal rilis.\n\nRisiko utama ada pada pengujian.',
  keyPoints: ['Rilis versi 2.0 dijadwalkan 1 November', 'Pengujian perlu ditambah'],
  topics: [{ title: 'Rilis versi 2.0', time: '00:00:05', summary: 'Jadwal rilis dibahas.', points: ['QA mulai Senin'] }],
  decisions: [{ decision: 'Rilis pada 1 November', context: 'Jika QA selesai' }],
  actionItems: [{ task: 'Kirim laporan QA', owner: 'Budi', deadline: 'Jumat', priority: 'tinggi' }],
  openQuestions: ['Siapa yang menangani dokumentasi?'],
  nextSteps: ['Rapat lanjutan minggu depan'],
  timeline: [{ time: '00:00:05', event: 'Pembukaan' }],
};

const requests = { transcriptions: [], chats: [], vision: [] };

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const json = (status, data) =>
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    if (req.headers.authorization !== 'Bearer test-key') return json(401, { error: { message: 'bad key' } });

    if (req.url === '/v1/audio/transcriptions') {
      const text = body.toString('latin1');
      const n = requests.transcriptions.length;
      requests.transcriptions.push({
        bytes: body.length,
        model: /name="model"\r\n\r\n([^\r]+)/.exec(text)?.[1],
        format: /name="response_format"\r\n\r\n([^\r]+)/.exec(text)?.[1],
        isWebm: text.includes('\x1aE\xdf\xa3'),
      });
      return json(200, {
        text: `Segment ${n + 1}: Halo semua, mari mulai. Let's discuss the release.`,
        segments: [
          { start: 1, end: 4, text: `Segment ${n + 1}: Halo semua, mari mulai.` },
          { start: 5, end: 9, text: "Let's discuss the release." },
        ],
      });
    }
    if (req.url === '/v1/chat/completions') {
      const data = JSON.parse(body.toString('utf8'));
      const reply = (content) =>
        json(200, { choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }] });
      const parts = data.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
      if (parts.some((p) => p.type === 'image_url')) {
        // Vision request: describe every screenshot as a slide.
        const ids = parts.flatMap((p) =>
          p.type === 'text' ? [...p.text.matchAll(/Image #(\d+) at/g)].map((m) => Number(m[1])) : [],
        );
        const images = parts.filter((p) => p.type === 'image_url').map((p) => p.image_url);
        const times = parts.flatMap((p) => (p.type === 'text' ? [...p.text.matchAll(/at \[([\d:]+)\]/g)].map((m) => m[1]) : []));
        requests.vision.push({ model: data.model, ids, images, times });
        return reply({
          images: ids.map((id) => ({ id, kind: 'slide', useful: 8, caption: `Roadmap slide ${id}`, text: `Roadmap item ${id}` })),
        });
      }
      requests.chats.push(data);
      // Pick the first two screenshots offered in the prompt for the first topic.
      const prompt = data.messages.find((m) => m.role === 'user').content;
      const offered = [...prompt.matchAll(/^#(\d+) \[/gm)].map((m) => Number(m[1]));
      const summary = structuredClone(SUMMARY);
      summary.topics[0].images = offered.slice(0, 2).map((id) => ({ id, caption: `Slide roadmap #${id}` }));
      return reply(summary);
    }
    json(404, { error: { message: `unknown path ${req.url}` } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiBase = `http://127.0.0.1:${server.address().port}/v1`;
log('mock API at', apiBase);

// ---------------------------------------------------------------------------
// Browser

// Let Chrome itself handle downloads (Playwright would rename them to GUIDs),
// so the folder structure the extension asks for can be checked.
const profile = path.join(tmp, 'profile');
fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
fs.writeFileSync(
  path.join(profile, 'Default/Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }),
);

const context = await chromium.launchPersistentContext(profile, {
  acceptDownloads: false,
  headless: true,
  channel: 'chromium',
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});

const consoleErrors = [];
context.on('page', (p) => p.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${p.url()}: ${m.text()}`)));

let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent('serviceworker');
const extId = new URL(worker.url()).host;
const ext = (p) => `chrome-extension://${extId}/${p}`;
log('extension', extId);

const page = await context.newPage();
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${page.url()}: ${m.text()}`));
const cdp = await context.newCDPSession(page);
await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });

let failed = false;
try {
  // Options page: renders, and store test settings.
  await page.goto(ext('options.html'));
  await page.waitForSelector('text=Base URL');
  await page.evaluate(async (apiBase) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: {
        ...settings,
        uiLanguage: 'id',
        folder: 'E2E Meetings',
        transcription: {
          baseUrl: apiBase,
          apiKey: 'test-key',
          model: 'whisper-1',
          extraHeaders: '',
          language: '',
          vocabulary: 'Budi',
        },
        summary: {
          sameAsTranscription: true,
          baseUrl: '',
          apiKey: '',
          model: 'gpt-test',
          extraHeaders: '',
          temperature: '',
          jsonMode: true,
          maxCharsPerRequest: 120000,
        },
        segmentMinutes: 1,
        autoProcess: true,
        autoPdf: true,
        pdfIncludeTranscript: true,
        saveTextFiles: true,
      },
    });
  }, apiBase);
  await page.reload();
  await page.screenshot({ path: path.join(shots, 'options.png'), fullPage: true });

  // Popup renders (opened as a normal tab here).
  const popup = await context.newPage();
  await popup.goto(ext('popup.html'));
  await popup.waitForSelector('footer');
  await popup.screenshot({ path: path.join(shots, 'popup.png') });
  await popup.close();

  // A fake Google Meet page: the content script runs on it, and closing the
  // tab must end the recording.
  await context.route('https://meet.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Meet - abc-defg-hij</title><h1>Fake meeting</h1>' }),
  );
  const meet = await context.newPage();
  await meet.goto('https://meet.google.com/abc-defg-hij');

  // Record a synthetic stream "from" that tab.
  await page.goto(ext('library.html'));
  const meetTabId = await page.evaluate(async () => (await chrome.tabs.query({ url: 'https://meet.google.com/*' }))[0].id);
  const start = await page.evaluate(
    (tabId) => chrome.runtime.sendMessage({ type: 'e2e-start', title: 'E2E Weekly Sync', recordMic: true, tabId }),
    meetTabId,
  );
  log('start', start);
  assert.equal(start.ok, true, `start failed: ${start.error}`);
  assert.equal(start.hasMic, true, `microphone should be mixed in (${start.micError})`);

  await sleep(3000);
  const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }));
  assert.equal(state.active?.recId, start.recId, 'background should report the active recording');
  await page.reload();
  await page.waitForSelector('.badge.recording');
  await page.screenshot({ path: path.join(shots, 'library-recording.png'), fullPage: true });

  await meet.waitForSelector('[data-meeting-recorder="indicator"]', { state: 'attached', timeout: 5000 });
  await meet.screenshot({ path: path.join(shots, 'meet-indicator.png') });

  log(`recording for ${RECORD_SECONDS}s…`);
  await sleep(RECORD_SECONDS * 1000);
  // The meeting ends: closing its tab stops the recording.
  await meet.close();
  const stopDeadline = Date.now() + 10_000;
  while ((await page.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }))).active && Date.now() < stopDeadline) {
    await sleep(250);
  }
  assert.equal(
    (await page.evaluate(() => chrome.runtime.sendMessage({ type: 'get-state' }))).active,
    null,
    'closing the tab should stop',
  );
  log('stopped by closing the meeting tab');

  // Wait for the pipeline and the automatic PDF export.
  const folderRoot = path.join(downloads, 'E2E Meetings');
  const deadline = Date.now() + 120_000;
  let folder;
  while (Date.now() < deadline) {
    const dirs = fs.existsSync(folderRoot) ? fs.readdirSync(folderRoot) : [];
    folder = dirs[0] && path.join(folderRoot, dirs[0]);
    const files = folder ? fs.readdirSync(folder) : [];
    if (['video.webm', 'minutes.pdf', 'minutes.md', 'transcript.txt'].every((f) => files.includes(f))) break;
    await sleep(1000);
  }
  assert.ok(folder, 'recording folder should exist');
  const files = fs.readdirSync(folder);
  log('files in', path.relative(downloads, folder), files);
  for (const f of ['video.webm', 'minutes.pdf', 'minutes.md', 'transcript.txt']) assert.ok(files.includes(f), `${f} missing`);
  assert.match(path.basename(folder), /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2} - E2E Weekly Sync$/);

  // Video: playable with a real duration (WebM duration patch).
  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      path.join(folder, 'video.webm'),
    ]).toString(),
  );
  const duration = Number(probe.format.duration);
  log(
    'video duration',
    duration,
    'streams',
    probe.streams.map((s) => `${s.codec_type}:${s.codec_name}`),
  );
  assert.ok(Math.abs(duration - RECORD_SECONDS - 3) < 6, `unexpected video duration ${duration}`);
  assert.deepEqual(probe.streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
  // The mixed audio must not be silent (AudioContext running without a user gesture).
  const volume = spawnSync('ffmpeg', [
    '-hide_banner',
    '-i',
    path.join(folder, 'video.webm'),
    '-af',
    'volumedetect',
    '-vn',
    '-f',
    'null',
    '-',
  ]).stderr.toString();
  const maxVolume = Number(/max_volume: (-?[\d.]+) dB/.exec(volume)?.[1]);
  log('audio max volume', maxVolume, 'dB');
  assert.ok(maxVolume > -30, `recorded audio is silent (max ${maxVolume} dB)`);

  // Transcription: one request per audio segment, WebM files, timestamps requested.
  log('transcription requests', requests.transcriptions);
  assert.equal(requests.transcriptions.length, EXPECTED_SEGMENTS, `expected ${EXPECTED_SEGMENTS} one-minute segment(s)`);
  for (const r of requests.transcriptions) {
    assert.equal(r.model, 'whisper-1');
    assert.equal(r.format, 'verbose_json');
    assert.ok(r.isWebm && r.bytes > 20_000, 'segment should be a WebM file with audio');
  }

  // Screenshots: captured when the slide changed, read by the vision model in batches.
  const visionImages = requests.vision.flatMap((v) => v.images);
  log(
    'vision requests',
    requests.vision.length,
    'screenshots',
    visionImages.length,
    requests.vision.flatMap((v) => v.times),
  );
  const expectedSlides = Math.ceil((RECORD_SECONDS + 3) / 8);
  assert.ok(
    visionImages.length >= Math.max(1, expectedSlides - 2) && visionImages.length <= expectedSlides + 2,
    `expected about ${expectedSlides} screenshots, got ${visionImages.length}`,
  );
  for (const v of requests.vision) {
    assert.equal(v.model, 'gpt-test');
    assert.ok(v.images.length <= 6 && v.ids.length === v.images.length);
    for (const img of v.images) {
      assert.match(img.url, /^data:image\/jpeg;base64,\/9j\//);
      assert.equal(img.detail, 'auto');
    }
  }

  // Summary request carries the transcript with offsets for the second segment.
  assert.equal(requests.chats.length, 1);
  const chat = requests.chats[0];
  assert.equal(chat.model, 'gpt-test');
  assert.deepEqual(chat.response_format, { type: 'json_object' });
  const userPrompt = chat.messages.find((m) => m.role === 'user').content;
  assert.match(userPrompt, /\[00:00:01\] Segment 1: Halo semua/);
  if (EXPECTED_SEGMENTS > 1) assert.match(userPrompt, /\[00:01:0\d\] Segment 2: Halo semua/);
  assert.match(userPrompt, /Meeting title \(from the browser tab\): E2E Weekly Sync/);
  assert.match(userPrompt, /Screenshots:\n#\d+ \[00:00:0\d\] slide, useful 8\/10: Roadmap slide \d+ \| text: "Roadmap item \d+"/);
  assert.match(chat.messages[0].content, /"images": \[\{ "id": 0/);

  // PDF contents.
  const pdfText = execFileSync('pdftotext', ['-layout', path.join(folder, 'minutes.pdf'), '-']).toString();
  for (const s of [
    'Rapat Mingguan Tim Produk',
    'Google Meet',
    'Ringkasan Eksekutif',
    'Tindak Lanjut',
    'Kirim laporan QA',
    'Transkrip',
    `Segment ${EXPECTED_SEGMENTS}`,
  ]) {
    assert.ok(pdfText.includes(s), `PDF should contain "${s}"`);
  }
  const pdfImages =
    execFileSync('pdfimages', ['-list', path.join(folder, 'minutes.pdf')])
      .toString()
      .trim()
      .split('\n').length - 2;
  log('images in PDF', pdfImages);
  assert.ok(pdfImages >= 2, 'the PDF should contain the chosen screenshots');
  assert.ok(pdfText.includes('Slide roadmap #'), 'screenshot captions should be in the PDF');
  const savedImages = fs.readdirSync(path.join(folder, 'images'));
  log('images folder', savedImages);
  assert.equal(savedImages.length, 2);
  const md = fs.readFileSync(path.join(folder, 'minutes.md'), 'utf8');
  assert.ok(md.includes(`![Slide roadmap #`) && md.includes(`](images/${savedImages[0]})`), 'markdown should link the images');
  assert.ok(md.includes('# Rapat Mingguan Tim Produk') && md.includes('田中 太郎') && md.includes('أحمد'));
  const txt = fs.readFileSync(path.join(folder, 'transcript.txt'), 'utf8');
  assert.ok(txt.includes('Segment 1') && txt.includes(`Segment ${EXPECTED_SEGMENTS}`));

  // Recording state in the library.
  await page.reload();
  await page.waitForSelector('.badge.done');
  await page.screenshot({ path: path.join(shots, 'library-done.png'), fullPage: true });

  // Report page.
  const report = await context.newPage();
  await report.goto(ext(`report.html?id=${start.recId}`));
  await report.waitForSelector('.doc figure img');
  await report.screenshot({ path: path.join(shots, 'report.png'), fullPage: true });

  // Re-summarise from the library uses the stored transcript (no new transcription calls).
  await page.click('text=Rangkum ulang');
  const deadline2 = Date.now() + 30_000;
  while (requests.chats.length < 2 && Date.now() < deadline2) await sleep(500);
  assert.equal(requests.chats.length, 2, 're-summarise should call the chat API again');
  assert.equal(requests.transcriptions.length, EXPECTED_SEGMENTS, 're-summarise must not transcribe again');
  assert.equal(requests.vision.flatMap((v) => v.images).length, visionImages.length, 're-summarise must not re-read the images');

  const relevantErrors = consoleErrors.filter((e) => !/favicon|Receiving end does not exist/.test(e));
  assert.deepEqual(relevantErrors, [], 'no console errors expected');
  log('✅ all checks passed; screenshots in', path.relative(root, shots));
} catch (err) {
  failed = true;
  console.error(err);
  console.error('console errors:', consoleErrors);
  const diag = await page
    .evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('meeting-recorder');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const recs = await new Promise((resolve) => {
        const req = db.transaction('recordings').objectStore('recordings').getAll();
        req.onsuccess = () => resolve(req.result);
      });
      const downloads = await chrome.downloads.search({});
      return {
        recs: recs.map(({ transcript, transcriptParts, summary, ...r }) => ({ ...r, hasSummary: !!summary })),
        downloads: downloads.map((d) => ({ filename: d.filename, state: d.state, error: d.error })),
      };
    })
    .catch((e) => String(e));
  console.error('diagnostics:', JSON.stringify(diag, null, 2));
  await page.screenshot({ path: path.join(shots, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await context.close();
  server.close();
}
process.exit(failed ? 1 : 0);
