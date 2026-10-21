# Meeting server (pemrosesan di VPS + Telegram)

Server kecil (Node.js 22) yang menerima **audio dan tangkapan layar** dari ekstensi, menjalankan pipeline yang sama
dengan ekstensi (`lib/pipeline-core.ts`: transkripsi → baca gambar → rangkuman), membuat `minutes.pdf` dengan desain yang
sama, lalu mengirim hasilnya ke **Telegram**: pesan ringkasan, album gambar slide yang dipilih AI, dan PDF notulen.
Video tetap disimpan di komputer pengguna.

```
Ekstensi ──audio + screenshot──▶ meeting-server ──▶ STT API (whisper)      ──▶ Telegram
         ◀── status + notulen ──    (antrean,      ──▶ Vision API (gambar)       pesan ringkasan
                                     1 meeting)    ──▶ LLM rangkuman             album slide
                                                   ──▶ Chromium (PDF)            minutes.pdf
```

## API

Auth: header `X-API-Key: <key>` atau `Authorization: Bearer <key>` (`API_KEYS` di `.env`). Setiap meeting hanya
terlihat oleh key yang membuatnya.

| Endpoint | Fungsi |
|---|---|
| `POST /v1/meetings` | Buat meeting (judul, waktu, durasi, template, opsi bahasa) → `{id}` |
| `PUT /v1/meetings/{id}/audio/{index}?startMs&endMs` | Satu segmen audio WebM (idempoten) |
| `PUT /v1/meetings/{id}/frames/{frameId}?t&width&height` | Satu tangkapan layar JPEG (idempoten) |
| `POST /v1/meetings/{id}/process` | `{mode: "all" \| "summarize" \| "transcribe", template?, title?, notes?}` → masuk antrean (`202`) |
| `GET /v1/meetings/{id}` | `status`, `progress`, `error`, `warning`, `telegram` (`off`/`pending`/`sending`/`sent`/`failed`) |
| `GET /v1/meetings/{id}/result` | `summary`, `transcript`, `summaryModel` |
| `POST /v1/meetings/{id}/telegram` | Kirim ulang ke Telegram |
| `GET /v1/health?chat=<id>` | Status STT, vision, rangkuman (dengan model), bot Telegram, dan nama chat tujuan |
| `GET /v1/telegram/chats` | Chat yang baru mengirim pesan ke bot (`getUpdates`, tanpa mengonsumsi update) |
| `GET /health` | Tanpa key: antrean dan meeting yang sedang diproses |

## Bot Telegram

Setelah setiap notulen (pesan ringkasan, album slide, PDF), bot mengirim **kartu** bertombol. Di chat bot:

| Perintah / tombol | Isi |
|---|---|
| `/notulen` | Daftar notulen chat ini (terbaru dulu, 8 per halaman), hanya berupa tombol nama yang membuka kartunya |
| `/cari <kata>` | Mencari di judul dan seluruh isi notulen |
| Kartu | Tombol Ringkasan, Poin penting, Topik, Keputusan, Tindak lanjut, Pertanyaan & langkah, Slide, PDF. Pesan kartu diedit menjadi bagian yang dipilih (dengan ‹ › kalau panjang) |
| Topik | Daftar topik; satu topik menampilkan isinya lalu mengirim slide topik itu |

Setiap chat hanya melihat notulen yang dikirim ke chat itu (`TELEGRAM_CHAT_ID` atau chat ID dari ekstensi). Bot
mendengarkan dengan long polling (`getUpdates`), jadi tidak perlu webhook; jangan pakai token yang sama di aplikasi lain.
Chat yang pernah mengirim pesan ke bot disimpan di `DATA_DIR/telegram-chats.json` untuk tombol **Cari chat** di
ekstensi.

Hanya satu meeting diproses dalam satu waktu (STT dan vision berbagi CPU yang sama). Pekerjaan yang terputus karena
restart dilanjutkan otomatis: segmen yang sudah ditranskripsi dan gambar yang sudah dibaca tidak diproses ulang.
Data disimpan di `DATA_DIR/meetings/<id>/` (`meeting.json`, `audio/`, `frames/`, `minutes.pdf`, `minutes.md`,
`transcript.txt`, `images/`). Audio dan screenshot dihapus setelah `RETENTION_DAYS` hari (default 7); notulen, slide
terpilih, dan PDF tetap ada untuk `/notulen` sampai `NOTES_RETENTION_DAYS` hari (default 365).

## Konfigurasi

Lihat [`.env.example`](.env.example). Yang wajib: `API_KEYS`, `STT_*`, `SUMMARY_*`. Vision dan Telegram opsional
(tanpa vision notulen dibuat tanpa gambar; tanpa Telegram hasil hanya kembali ke ekstensi).

Chat Telegram: `TELEGRAM_CHAT_ID` adalah chat default. Ekstensi boleh mengirim chat sendiri per meeting
(`options.telegramChatId`, dipilih lewat tombol **Cari chat** di Pengaturan). Untuk mencari chat ID secara manual: kirim
`/start` ke bot, lalu `curl -s https://api.telegram.org/bot<TOKEN>/getUpdates` dan ambil `message.chat.id`.
Opsi `analyze: false` dari ekstensi melewati pembacaan gambar untuk meeting itu.

## Build dan deploy

```bash
npm run build:server            # → server/dist/server.mjs (satu file, ±700 KB)
```

Di VPS (contoh: `~/proyek/meeting-server`, user `ubuntu`):

```bash
sudo apt install -y fonts-noto-core fonts-noto-cjk    # aksara non-Latin di PDF
mkdir -p ~/proyek/meeting-server/data && cd ~/proyek/meeting-server
# salin server/dist/server.mjs dan server/deploy/package.json ke folder ini, lalu:
npm install --omit=dev
npx playwright-core install chromium-headless-shell   # lewati jika revisinya sudah ada di ~/.cache/ms-playwright
cp .env.example .env && chmod 600 .env                 # isi key
sudo cp meeting-server.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now meeting-server
# tempel deploy/Caddyfile.snippet di blok site Caddy (sebelum `handle` terakhir), lalu:
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Operasional:

```bash
systemctl status meeting-server
journalctl -u meeting-server -f
curl -s -H "X-API-Key: $KEY" https://<domain>/meeting/v1/health
```

Di ekstensi: **Pengaturan → Pemrosesan → Server**, isi base URL `https://<domain>/meeting` dan API key, lalu
**Tes koneksi**.

## Tes

```bash
npm test                    # termasuk tests/unit/server.test.ts
npm run test:e2e:server     # ekstensi + server + API tiruan + Telegram tiruan
```
