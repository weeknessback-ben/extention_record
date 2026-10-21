// Mock OpenAI-compatible API (speech-to-text, chat, vision) and Telegram Bot API for the e2e tests.
import http from 'node:http';

export const SUMMARY = {
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

/** Telegram calls arrive as JSON or multipart; keep the fields and the uploaded files. */
async function parseTelegram(method, req, body) {
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) return { method, fields: JSON.parse(body.toString('utf8') || '{}'), files: {} };
  const form = await new Request('http://mock', { method: 'POST', headers: { 'content-type': type }, body }).formData();
  const fields = {};
  const files = {};
  for (const [name, value] of form) {
    if (typeof value === 'string') fields[name] = value;
    else files[name] = { filename: value.name, type: value.type, data: Buffer.from(await value.arrayBuffer()) };
  }
  return { method, fields, files };
}

export async function startMockApi() {
  // transcriptionDelayMs makes speech-to-text slow, e.g. to keep the server's CPU lane busy.
  const requests = { transcriptions: [], chats: [], vision: [], telegram: [], transcriptionDelayMs: 0 };
  // Somebody sent /start to the bot from chat 777; the server's default chat is 4242.
  const updates = [
    {
      update_id: 1,
      message: { message_id: 1, text: '/start', chat: { id: 777, type: 'private', first_name: 'Budi', last_name: 'Santoso' } },
    },
  ];
  /** A message or button press sent to the bot. */
  const pushUpdate = (update) => updates.push({ update_id: updates.length + 1, ...update });
  const telegramCall = async (method, req, body) => {
    if (method === 'getMe') return { id: 1, is_bot: true, username: 'test_bot' };
    // The bot long-polls: updates from pushUpdate(), from the requested offset on (a short wait when none).
    if (method === 'getUpdates') {
      const { fields } = await parseTelegram(method, req, body);
      const pending = () => updates.filter((u) => u.update_id >= Number(fields.offset ?? 0));
      for (let i = 0; i < 10 && !pending().length; i++) await new Promise((r) => setTimeout(r, 50));
      return pending();
    }
    if (method === 'setMyCommands') return true;
    if (method === 'answerCallbackQuery') return true;
    if (method === 'getChat') {
      const { fields } = await parseTelegram(method, req, body);
      return String(fields.chat_id) === '777'
        ? { id: 777, first_name: 'Budi', last_name: 'Santoso' }
        : { id: -4242, title: 'Tim Produk' };
    }
    requests.telegram.push(await parseTelegram(method, req, body));
    return { message_id: requests.telegram.length };
  };
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
      // Telegram Bot API (bot token "test-token"), used by the processing server.
      const tg = /^\/bottest-token\/(\w+)$/.exec(req.url);
      if (tg) {
        void telegramCall(tg[1], req, body).then((result) => json(200, { ok: true, result }));
        return;
      }
      // The vision API is configured as a separate endpoint with its own key.
      const isVisionApi = req.url.startsWith('/vision/');
      if (req.headers.authorization !== (isVisionApi ? 'Bearer vision-key' : 'Bearer test-key')) {
        return json(401, { error: { message: 'bad key' } });
      }
      if (isVisionApi && req.url !== '/vision/v1/chat/completions') return json(404, { error: { message: req.url } });

      if (req.url === '/v1/audio/transcriptions') {
        const text = body.toString('latin1');
        const n = requests.transcriptions.length;
        requests.transcriptions.push({
          at: Date.now(),
          bytes: body.length,
          model: /name="model"\r\n\r\n([^\r]+)/.exec(text)?.[1],
          format: /name="response_format"\r\n\r\n([^\r]+)/.exec(text)?.[1],
          isWebm: text.includes('\x1aE\xdf\xa3'),
        });
        const reply = {
          text: `Segment ${n + 1}: Halo semua, mari mulai. Let's discuss the release.`,
          segments: [
            { start: 1, end: 4, text: `Segment ${n + 1}: Halo semua, mari mulai.` },
            { start: 5, end: 9, text: "Let's discuss the release." },
          ],
        };
        return setTimeout(() => json(200, reply), requests.transcriptionDelayMs);
      }
      if (req.url === '/v1/chat/completions' || req.url === '/vision/v1/chat/completions') {
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
          const times = parts.flatMap((p) =>
            p.type === 'text' ? [...p.text.matchAll(/at \[([\d:]+)\]/g)].map((m) => m[1]) : [],
          );
          requests.vision.push({
            at: Date.now(),
            url: req.url,
            model: data.model,
            maxTokens: data.max_tokens,
            ids,
            images,
            times,
          });
          return reply({
            images: ids.map((id) => ({
              id,
              kind: 'slide',
              useful: 8,
              caption: `Roadmap slide ${id}`,
              text: `Roadmap item ${id}`,
            })),
          });
        }
        if (isVisionApi) return json(400, { error: { message: 'summary sent to the vision API' } });
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
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, apiBase: `${origin}/v1`, requests, server, pushUpdate };
}
