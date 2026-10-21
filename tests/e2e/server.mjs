// End-to-end test of server processing: the extension records a synthetic meeting, uploads the
// audio and screenshots to the processing server (server/dist/server.mjs), the server runs the
// pipeline against the mock API and sends the minutes to a mock Telegram Bot API.
//
//   npm run test:e2e:server   (builds the e2e extension and the server first)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startMockApi } from './mock-api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionPath = path.join(root, '.output/chrome-mv3-e2e');
const tmp = path.join(root, 'tests/e2e/.tmp');
const downloads = path.join(tmp, 'downloads');
const shots = path.join(tmp, 'screenshots');
const dataDir = path.join(tmp, 'server-data');
const RECORD_SECONDS = Number(process.env.RECORD_SECONDS ?? 70);
const EXPECTED_SEGMENTS = Math.floor((RECORD_SECONDS + 3) / 60) + 1;

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(downloads, { recursive: true });
fs.mkdirSync(shots, { recursive: true });

const log = (...a) => console.log(`[e2e-server ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (what, check, ms) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
};

const { origin, apiBase, requests, server: mock, pushUpdate } = await startMockApi();
log('mock API at', apiBase);

// ---------------------------------------------------------------------------
// Processing server

const port = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const serverLog = [];
const proc = spawn(process.execPath, [path.join(root, 'server/dist/server.mjs')], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    API_KEYS: 'other-key,server-key',
    UI_LANGUAGE: 'id',
    STT_BASE_URL: apiBase,
    STT_API_KEY: 'test-key',
    STT_MODEL: 'whisper-1',
    VISION_BASE_URL: `${origin}/vision/v1`,
    VISION_API_KEY: 'vision-key',
    VISION_MODEL: 'vision-test',
    VISION_BATCH_SIZE: '1',
    VISION_EXTRA_BODY: '{"max_tokens": 512}',
    SUMMARY_BASE_URL: apiBase,
    SUMMARY_API_KEY: 'test-key',
    SUMMARY_MODEL: 'gpt-test',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_ID: '4242',
    TELEGRAM_API_BASE: origin,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
proc.stdout.on('data', (d) => serverLog.push(d.toString()));
proc.stderr.on('data', (d) => serverLog.push(d.toString()));
const serverBase = `http://127.0.0.1:${port}`;
await waitFor('the processing server', () => serverLog.join('').includes('listening'), 10_000);
log('processing server at', serverBase);

// ---------------------------------------------------------------------------
// Browser

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
const page = await context.newPage();
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${page.url()}: ${m.text()}`));
const cdp = await context.newCDPSession(page);
await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });

const telegram = (method) => requests.telegram.filter((r) => r.method === method);

let failed = false;
try {
  await page.goto(ext('options.html'));
  await page.waitForSelector('text=Base URL');
  await page.evaluate(async (serverBase) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: {
        ...settings,
        uiLanguage: 'id',
        folder: 'E2E Meetings',
        processing: 'server',
        server: { baseUrl: serverBase, apiKey: 'server-key' },
        // Not used in server mode: an unreachable API proves the browser does not call it.
        transcription: {
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: '',
          model: 'whisper-1',
          extraHeaders: '',
          language: 'id',
          vocabulary: 'Budi',
        },
        segmentMinutes: 1,
        autoProcess: true,
        autoPdf: false,
        pdfIncludeTranscript: true,
      },
    });
  }, serverBase);
  await page.reload();

  // In server mode the local API cards are hidden; language and vocabulary have their own card.
  await page.getByRole('heading', { name: 'Bahasa & istilah meeting' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'API Transkripsi (speech-to-text)' }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'API Vision (membaca gambar)' }).count(), 0);

  // "Find chat" lists the chats that wrote to the bot; picking one fills in the chat id.
  const card = page.locator('section', { hasText: 'Pemrosesan' });
  await card.getByRole('button', { name: 'Cari chat' }).click();
  await card.getByRole('button', { name: 'Budi Santoso · 777' }).click();
  assert.equal(await card.getByPlaceholder('123456789').inputValue(), '777');
  await page.getByRole('button', { name: 'Simpan pengaturan' }).click();
  await page.getByText('Pengaturan tersimpan.').waitFor();

  // "Test connection" reports the server's APIs with their models, the bot and the chosen chat.
  await card.getByRole('button', { name: 'Tes koneksi' }).click();
  await card
    .getByText(
      'Server OK — transkripsi: ok (whisper-1) · vision: ok (vision-test) · rangkuman: ok (gpt-test) · Telegram: @test_bot → Budi Santoso',
    )
    .waitFor({ timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, 'options-server.png'), fullPage: true });
  log('server test connection OK');

  await context.route('https://meet.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Meet - abc-defg-hij</title><h1>Fake meeting</h1>' }),
  );
  const meet = await context.newPage();
  await meet.goto('https://meet.google.com/abc-defg-hij');
  await page.goto(ext('library.html'));
  const meetTabId = await page.evaluate(async () => (await chrome.tabs.query({ url: 'https://meet.google.com/*' }))[0].id);
  const start = await page.evaluate(
    (tabId) => chrome.runtime.sendMessage({ type: 'e2e-start', title: 'E2E Weekly Sync', recordMic: true, tabId }),
    meetTabId,
  );
  assert.equal(start.ok, true, `start failed: ${start.error}`);
  log(`recording for ${RECORD_SECONDS}s…`);
  await sleep(RECORD_SECONDS * 1000 + 3000);
  const stopAt = Date.now();
  await meet.close();
  log('stopped by closing the meeting tab');

  // Once uploaded, the library shows that the server does the work.
  await page.getByText('Diproses di VPS').waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(shots, 'library-on-server.png'), fullPage: true });

  // The server processes the meeting and sends it to Telegram: messages, album, then the PDF.
  await waitFor('the PDF on Telegram', () => telegram('sendDocument').length > 0, 180_000);
  log(
    'telegram calls',
    requests.telegram.map((r) => r.method),
  );

  const meetings = fs.readdirSync(path.join(dataDir, 'meetings'));
  assert.equal(meetings.length, 1, 'one meeting on the server');
  const dir = path.join(dataDir, 'meetings', meetings[0]);
  const meeting = JSON.parse(fs.readFileSync(path.join(dir, 'meeting.json'), 'utf8'));
  log('server meeting', meeting.status, `${meeting.audioSegments.length} audio, ${meeting.frames.length} frames`);
  assert.equal(meeting.audioSegments.length, EXPECTED_SEGMENTS);
  assert.ok(meeting.frames.length >= 5, `expected screenshots on the server, got ${meeting.frames.length}`);
  for (const f of ['minutes.pdf', 'minutes.md', 'transcript.txt']) assert.ok(fs.existsSync(path.join(dir, f)), `${f} missing`);
  assert.equal(fs.readdirSync(path.join(dir, 'images')).length, 2);
  assert.equal(meeting.options.language, 'id');
  assert.equal(meeting.live, undefined, 'the meeting is no longer live once processed');

  // Live upload: the first segment and screenshots reached the server and were processed during the meeting.
  log(
    'processed before the recording stopped:',
    requests.transcriptions.filter((r) => r.at < stopAt).length,
    'segment(s),',
    requests.vision.filter((v) => v.at < stopAt).length,
    'screenshot(s)',
  );
  assert.ok(requests.transcriptions[0].at < stopAt, 'the first segment is transcribed while recording');
  assert.ok(
    requests.vision.some((v) => v.at < stopAt),
    'screenshots are read while recording',
  );
  // Screenshots are cropped to the part of the 640x360 screen that changes (the slide), not the whole tab.
  const cropped = meeting.frames.filter((f) => f.width < 640 && f.height < 360);
  log(
    'cropped screenshots',
    cropped.length,
    'of',
    meeting.frames.length,
    cropped[0] && `${cropped[0].width}x${cropped[0].height}`,
  );
  // The region is known once the slide area changed twice, so the first screenshots are whole.
  assert.ok(cropped.length >= meeting.frames.length - 3, 'the later screenshots are cropped');
  for (const f of cropped) assert.ok(f.width <= 480 && f.height <= 330, `crop ${f.width}x${f.height} should be the slide area`);

  // The server, not the browser, called the AI APIs: one image per vision request, with the extra body.
  assert.equal(requests.transcriptions.length, EXPECTED_SEGMENTS);
  assert.equal(requests.vision.length, meeting.frames.length);
  for (const v of requests.vision) {
    assert.equal(v.images.length, 1);
    assert.equal(v.maxTokens, 512);
  }
  assert.equal(requests.chats.length, 1);
  assert.equal(requests.chats[0].model, 'gpt-test');

  // Telegram: the summary as HTML, the two chosen slides as an album, and the PDF.
  // The chat chosen in the extension, not the server's default (4242).
  for (const r of requests.telegram) assert.equal(String(r.fields.chat_id), '777');
  const text = telegram('sendMessage')
    .map((r) => r.fields.text)
    .join('\n');
  assert.equal(telegram('sendMessage')[0].fields.parse_mode, 'HTML');
  for (const s of [
    '<b>Rapat Mingguan Tim Produk</b>',
    '<b>Ringkasan Eksekutif</b>',
    'Kirim laporan QA — <i>Budi · Jumat · tinggi</i>',
  ]) {
    assert.ok(text.includes(s), `Telegram message should contain ${s}`);
  }
  const [album] = telegram('sendMediaGroup');
  assert.ok(album, 'the chosen slides are sent as an album');
  const media = JSON.parse(album.fields.media);
  assert.equal(media.length, 2);
  assert.match(media[0].caption, /^\[00:00:05\] Rilis versi 2\.0\nSlide roadmap #\d+$/);
  for (const m of media) assert.equal(album.files[m.media.replace('attach://', '')].data.subarray(0, 2).toString('hex'), 'ffd8');
  const doc = telegram('sendDocument')[0].files.document;
  assert.equal(doc.filename, 'Rapat Mingguan Tim Produk.pdf');
  const pdfPath = path.join(tmp, 'telegram.pdf');
  fs.writeFileSync(pdfPath, doc.data);
  const pdfText = execFileSync('pdftotext', ['-layout', pdfPath, '-']).toString();
  for (const s of [
    'Rapat Mingguan Tim Produk',
    'Ringkasan Eksekutif',
    'Kirim laporan QA',
    'Transkrip',
    'Dibuat oleh Meeting Recorder',
  ]) {
    assert.ok(pdfText.includes(s), `PDF should contain "${s}"`);
  }
  const pdfImages = execFileSync('pdfimages', ['-list', pdfPath]).toString().trim().split('\n').length - 2;
  assert.ok(pdfImages >= 2, 'the PDF should contain the chosen screenshots');

  // The extension gets the minutes back; the video stayed on this computer.
  await page.reload();
  await page.waitForSelector('.badge.done', { timeout: 60_000 });
  await page.screenshot({ path: path.join(shots, 'library-server-done.png'), fullPage: true });
  const rec = await page.evaluate(async (recId) => {
    const db = await new Promise((resolve) => {
      const req = indexedDB.open('meeting-recorder');
      req.onsuccess = () => resolve(req.result);
    });
    return new Promise((resolve) => {
      const req = db.transaction('recordings').objectStore('recordings').get(recId);
      req.onsuccess = () => resolve(req.result);
    });
  }, start.recId);
  assert.equal(rec.summary?.title, 'Rapat Mingguan Tim Produk');
  assert.equal(rec.server?.telegram, 'sent');
  assert.equal(rec.server?.uploadedAudio.length, EXPECTED_SEGMENTS);
  const folders = fs.readdirSync(path.join(downloads, 'E2E Meetings'));
  assert.ok(fs.existsSync(path.join(downloads, 'E2E Meetings', folders[0], 'video.webm')), 'video saved locally');
  const report = await context.newPage();
  await report.goto(ext(`report.html?id=${start.recId}`));
  await report.waitForSelector('.doc figure img');
  await report.close();

  // Through the API, a second meeting with slow speech-to-text keeps the server's CPU lane busy. It has
  // "read the screenshots" switched off (no vision requests) and no chat id (the server's default chat).
  const api = (p, init = {}) => fetch(`${serverBase}${p}`, { ...init, headers: { 'X-API-Key': 'server-key', ...init.headers } });
  const visionBefore = requests.vision.length;
  const options = { ...meeting.options, analyze: false, telegramChatId: '' };
  const created = await api('/v1/meetings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'API meeting', platform: 'zoom', startedAt: Date.now(), durationMs: 60_000, options }),
  });
  const { id: apiId } = await created.json();
  await api(`/v1/meetings/${apiId}/audio/0?startMs=0&endMs=60000`, {
    method: 'PUT',
    body: fs.readFileSync(path.join(dir, 'audio/0.webm')),
  });
  const frameFile = fs.readdirSync(path.join(dir, 'frames'))[0];
  await api(`/v1/meetings/${apiId}/frames/1?t=1000&width=1280&height=720`, {
    method: 'PUT',
    body: fs.readFileSync(path.join(dir, 'frames', frameFile)),
  });
  const bad = await api('/v1/meetings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', options: { telegramChatId: 'not a chat' } }),
  });
  assert.equal(bad.status, 400, 'an invalid chat id is rejected');
  requests.transcriptionDelayMs = 30_000;
  await api(`/v1/meetings/${apiId}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'all' }),
  });
  await waitFor('the API meeting to be transcribing', () => requests.transcriptions.length > EXPECTED_SEGMENTS, 10_000);

  // Re-summarise from the library goes straight to the summary lane: new minutes while the CPU lane is busy.
  const toExtensionChat = () => telegram('sendDocument').filter((r) => String(r.fields.chat_id) === '777');
  await page.click('text=Rangkum ulang');
  await waitFor('the re-summarised PDF on Telegram', () => toExtensionChat().length > 1, 20_000);
  const busy = await (await api(`/v1/meetings/${apiId}`)).json();
  assert.equal(busy.status, 'transcribing', 're-summarise must not wait for the other meeting');
  assert.equal(requests.chats.length, 2, 're-summarise calls the chat API again');
  log('re-summarised while another meeting was transcribing');

  requests.transcriptionDelayMs = 0;
  await waitFor(
    'the API meeting on Telegram',
    () => telegram('sendDocument').some((r) => String(r.fields.chat_id) === '4242'),
    60_000,
  );
  assert.equal(requests.vision.length, visionBefore, 'no vision requests when reading screenshots is off');
  assert.equal(requests.transcriptions.length, EXPECTED_SEGMENTS + 1, 're-summarise must not transcribe again');

  // The bot: a card follows the minutes, /notulen lists them as name buttons, the buttons open the parts.
  const minutesCard = telegram('sendMessage').find(
    (r) => String(r.fields.chat_id) === '777' && r.fields.reply_markup && r.fields.text.includes('Rapat Mingguan'),
  );
  assert.ok(minutesCard, 'a card with buttons follows the minutes');
  const cardButtons = minutesCard.fields.reply_markup.inline_keyboard.flat();
  for (const label of ['Ringkasan Eksekutif', 'Pembahasan (1)', 'Tindak Lanjut (1)', 'Slide (2)', 'PDF']) {
    assert.ok(
      cardButtons.some((b) => b.text === label),
      `card button ${label}`,
    );
  }
  let mark = requests.telegram.length;
  const replies = () => requests.telegram.slice(mark);
  const ask = async (update, what, done) => {
    mark = requests.telegram.length;
    pushUpdate(update);
    await waitFor(what, () => done(replies()), 15_000);
    return replies();
  };
  const press = (data, what, done) =>
    ask({ callback_query: { id: `q${mark}`, data, message: { message_id: 500, chat: { id: 777 } } } }, what, done);
  const edited = (rs) => rs.find((r) => r.method === 'editMessageText');

  const listed = await ask(
    { message: { message_id: 100, text: '/notulen', chat: { id: 777, type: 'private', first_name: 'Budi' } } },
    'the list of minutes',
    (rs) => rs.some((r) => r.method === 'sendMessage' && r.fields.reply_markup),
  );
  const entries = listed.find((r) => r.fields.reply_markup).fields.reply_markup.inline_keyboard.flat();
  assert.equal(entries.length, 1, 'only the minutes sent to this chat');
  assert.match(entries[0].text, /Rapat Mingguan Tim Produk/);

  const opened = await press(entries[0].callback_data, 'the card', (rs) => Boolean(edited(rs)));
  const buttonsOf = (r) => r.fields.reply_markup.inline_keyboard.flat();
  const find = (label) => buttonsOf(edited(opened)).find((b) => b.text.startsWith(label));
  const actions = await press(find('Tindak Lanjut').callback_data, 'the action items', (rs) => Boolean(edited(rs)));
  assert.ok(edited(actions).fields.text.includes('Kirim laporan QA'));
  const topics = await press(find('Pembahasan').callback_data, 'the topics', (rs) => Boolean(edited(rs)));
  const topic = buttonsOf(edited(topics))[0];
  assert.match(topic.text, /Rilis versi 2\.0/);
  const shown = await press(topic.callback_data, 'a topic with its slides', (rs) =>
    rs.some((r) => r.method === 'sendMediaGroup'),
  );
  assert.ok(edited(shown).fields.text.includes('Jadwal rilis dibahas.'));
  assert.equal(JSON.parse(shown.find((r) => r.method === 'sendMediaGroup').fields.media).length, 2);
  await press(find('PDF').callback_data, 'the PDF', (rs) => rs.some((r) => r.method === 'sendDocument'));

  // Another chat sees none of it.
  const stranger = await ask(
    { message: { message_id: 101, text: '/notulen', chat: { id: 555, type: 'private', first_name: 'X' } } },
    'the answer to another chat',
    (rs) => rs.some((r) => String(r.fields.chat_id) === '555'),
  );
  assert.ok(!stranger[0].fields.reply_markup && stranger[0].fields.text.includes('555'));
  log('telegram bot: list, card, action items, topic + slides, PDF; other chats see nothing');

  // Another API key cannot see the meeting.
  const other = await fetch(`${serverBase}/v1/meetings/${meetings[0]}`, { headers: { 'X-API-Key': 'other-key' } });
  assert.equal(other.status, 404);

  const relevantErrors = consoleErrors.filter((e) => !/favicon|Receiving end does not exist/.test(e));
  assert.deepEqual(relevantErrors, [], 'no console errors expected');
  log('✅ all checks passed; screenshots in', path.relative(root, shots));
} catch (err) {
  failed = true;
  console.error(err);
  console.error('console errors:', consoleErrors);
  console.error('server log:\n' + serverLog.join(''));
  await page.screenshot({ path: path.join(shots, 'failure-server.png'), fullPage: true }).catch(() => {});
} finally {
  await context.close();
  proc.kill();
  mock.close();
}
process.exit(failed ? 1 : 0);
