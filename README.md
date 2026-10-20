# Meeting Recorder & AI Minutes

Ekstensi Chrome (Manifest V3) untuk **merekam video + audio meeting Google Meet / Zoom Web**, lalu otomatis
**mentranskripsi dan merangkumnya menjadi notulen PDF lengkap** memakai API AI pilihan sendiri (base URL, model, dan
API key bebas, format OpenAI / GPT).

- 🎥 Rekam tab meeting: video, audio peserta lain, **dan mikrofon Anda sendiri** (dicampur jadi satu).
- 💾 Video **wajib tersimpan** ke folder khusus: `Downloads/<folder>/<tanggal jam> - <judul>/video.webm`.
- 🌍 **Multibahasa**: meeting boleh campur bahasa; notulen ditulis dalam bahasa utama meeting atau bahasa pilihan Anda
  (termasuk aksara non-Latin: 日本語, 中文, العربية, हिन्दी, ไทย, …). Judul bagian PDF ikut diterjemahkan.
- 🖼️ **Gambar presentasi**: setiap kali layar yang dibagikan berganti (slide baru, halaman dokumen, grafik), ekstensi
  mengambil tangkapan layar. Model vision GPT **membaca isi gambar** (teks slide, angka, diagram), isinya ikut dipakai
  dalam rangkuman, lalu AI **memilih gambar paling tepat untuk setiap topik** dan menampilkannya di notulen PDF
  lengkap dengan keterangan dan timestamp.
- 🧠 Transkripsi + rangkuman lewat API yang kompatibel dengan OpenAI (OpenAI, Azure OpenAI v1, OpenRouter, Groq,
  LiteLLM, server lokal, …).
- 📄 Notulen PDF berisi ringkasan eksekutif, poin penting, pembahasan per topik (dengan timestamp), keputusan,
  tabel tindak lanjut (PIC, tenggat, prioritas), pertanyaan terbuka, langkah berikutnya, linimasa, dan lampiran transkrip.
  Juga disimpan sebagai `minutes.md` dan `transcript.txt`.
- 🔁 Bisa diproses ulang: rangkum ulang dengan template lain, transkripsi ulang, lanjutkan proses yang gagal.

## Instalasi

Butuh Node.js 20+ dan Chrome 116+.

```bash
npm install
npm run build
```

1. Buka `chrome://extensions`, aktifkan **Developer mode**.
2. Klik **Load unpacked** → pilih folder `.output/chrome-mv3`.
3. Halaman Pengaturan terbuka otomatis. Lakukan tiga langkah di bagian atas:
   1. **Izinkan mikrofon** (agar suara Anda ikut terekam).
   2. Isi **API key** (dan base URL / model kalau tidak memakai default OpenAI), lalu **Simpan pengaturan**.
      Tombol **Tes koneksi** memeriksa kedua API.
   3. Selesai. Pin ikon ekstensi di toolbar supaya mudah diakses.

> Ekstensi meminta izin `debugger` untuk membuat PDF memakai mesin cetak Chrome. Selama PDF dibuat (±1 detik), Chrome
> menampilkan bilah "Meeting Recorder mulai men-debug browser ini". Itu normal.

## Cara pakai

1. Masuk ke meeting di **Google Meet** atau **Zoom versi web** (`app.zoom.us/wc/...`).
2. Klik ikon ekstensi → periksa judul → **Mulai rekam** (atau tekan `Alt+Shift+R`).
   Pil **● REC** muncul di halaman meeting sebagai penanda (dan tombol stop).
3. Rekaman berhenti saat Anda menekan **Berhenti rekam** (popup / pil REC / `Alt+Shift+R`), menutup tab meeting,
   atau pindah ke situs lain.
4. Setelah berhenti, ekstensi otomatis:
   1. menyimpan `video.webm`,
   2. mentranskripsi audio per segmen (default 5 menit),
   3. membaca tangkapan layar presentasi dengan model vision,
   4. merangkum transkrip (plus isi slide) menjadi notulen dan memilih gambar untuk setiap topik,
   5. menyimpan `minutes.pdf`, `minutes.md`, `transcript.txt`, lalu menampilkan notifikasi **Notulen meeting siap**.

Halaman **Rekaman** (Library) menampilkan semua rekaman beserta progresnya. Di sana Anda bisa:
mengisi **konteks untuk AI** (daftar peserta, agenda, ejaan nama), memilih **template**, menjalankan **Rangkum ulang**,
**Transkripsi ulang**, membuka notulen, membuka folder file, atau memulihkan rekaman yang terputus (misalnya browser crash).

Halaman notulen punya tombol **Simpan PDF**, **Cetak**, **Edit teks** (koreksi cepat sebelum menyimpan PDF),
**Simpan Markdown**, **Simpan transkrip**, dan **Salin Markdown**.

### Struktur file

```
Downloads/
└── MeetingRecorder/
    └── 2026-10-20 14.05 - Weekly sync/
        ├── video.webm        ← video + audio (VP9/Opus), durasi terbaca di pemutar video
        ├── minutes.pdf       ← notulen
        ├── minutes.md
        ├── transcript.txt
        └── images/           ← gambar yang dipilih AI (dipakai minutes.md)
            ├── slide-00-03-12.jpg
            └── slide-00-17-40.jpg
```

Ekstensi Chrome hanya boleh menulis di dalam direktori unduhan. Pilihan untuk memakai lokasi lain:
- ubah lokasi unduhan Chrome di `chrome://settings/downloads`, atau
- aktifkan **"Tanya lokasi penyimpanan setiap video"** di Pengaturan (muncul dialog *Save as* untuk setiap video).

## Pengaturan AI

| Bagian | Default | Catatan |
|---|---|---|
| Transkripsi – Base URL | `https://api.openai.com/v1` | Memanggil `POST {baseUrl}/audio/transcriptions` |
| Transkripsi – Model | `gpt-4o-transcribe` | Terbaik untuk meeting multibahasa. `whisper-1` memberi timestamp per kalimat. `gpt-4o-transcribe-diarize` menambah label pembicara. |
| Petunjuk bahasa | kosong | Kosongkan agar bahasa dideteksi otomatis (disarankan untuk meeting campur bahasa) |
| Kosakata | kosong | Nama orang, produk, singkatan: membantu akurasi transkripsi |
| Rangkuman – Model | `gpt-4.1-mini` | Model chat apa saja (`gpt-4.1`, `gpt-4o`, `gpt-5-mini`, …). Memanggil `POST {baseUrl}/chat/completions` |
| Temperature | kosong | Kosongkan untuk model reasoning (gpt-5, o-series) yang tidak menerima temperature |
| Mode JSON | aktif | Otomatis dimatikan kalau server menolak `response_format` |
| Maks. karakter per permintaan | 120.000 | Transkrip lebih panjang dirangkum per bagian lalu digabung (map-reduce) |
| Bahasa notulen | kosong | Kosong = bahasa utama meeting. Bisa diisi bahasa apa saja: `English`, `Bahasa Indonesia`, `日本語`, … |
| Header tambahan | kosong | JSON, misalnya `{"api-key": "…"}` untuk Azure |
| Tangkapan layar presentasi | aktif | Diambil saat layar berganti lalu diam; area yang terus bergerak (video peserta, video yang diputar, scroll) diabaikan |
| Sensitivitas | Sedang | Tinggi = perubahan kecil (poin baru muncul) juga ditangkap; Rendah = hanya slide/halaman baru |
| Maks. tangkapan layar | 150 | Per meeting |
| Baca gambar dengan AI | aktif | Memakai URL dan API key API rangkuman |
| Model vision | kosong | Kosong = model rangkuman. Harus bisa menerima gambar (`gpt-4.1-mini`, `gpt-4.1`, `gpt-4o`, `gpt-5-mini`, …) |
| Detail gambar | `auto` | `high` lebih baik membaca teks kecil, `low` lebih hemat token |
| Gambar per topik | 2 | 0 = tanpa gambar di notulen (isi slide tetap dipakai untuk rangkuman) |

Untuk server selain `api.openai.com`, Chrome meminta izin akses ke domain tersebut saat Anda menyimpan pengaturan.

**Template**: Notulen rapat lengkap, Daily stand-up, Kuliah/kelas/webinar, Wawancara klien, Sales call,
Brainstorming/workshop. Ditambah kolom **Instruksi tambahan** untuk aturan Anda sendiri.

## Arsitektur

```
 Popup / shortcut ──start/stop──▶ Service worker ──streamId──▶ Offscreen document (mesin)
                                   │  status, badge REC,         ├─ getUserMedia(tab) + mic → Web Audio mix
                                   │  notifikasi, unduhan        ├─ MediaRecorder #1: video+audio → IndexedDB
 Content script (Meet/Zoom) ◀──────┘                             ├─ MediaRecorder #2: audio 32 kbps, segmen 5 menit
   pil "● REC"                                                   ├─ SlideCapture: JPEG saat layar berganti → IndexedDB
                                                                 ├─ simpan video.webm (patch durasi WebM)
                                                                 └─ pipeline: transkripsi → baca gambar (vision)
                                                                    → rangkuman + pilih gambar per topik
 Library (daftar rekaman) ◀── IndexedDB ──▶ Halaman notulen ── Page.printToPDF ──▶ minutes.pdf
```

| File | Isi |
|---|---|
| `entrypoints/background.ts` | Orkestrasi: mulai/stop, offscreen document, badge, notifikasi, unduhan |
| `entrypoints/offscreen/` | Perekaman dan pipeline AI (jalan di latar, tidak bergantung tab yang terbuka) |
| `entrypoints/popup/` | Tombol rekam, timer, peringatan setup |
| `entrypoints/options/` | Pengaturan + izin mikrofon |
| `entrypoints/library/` | Daftar rekaman, proses ulang, pemulihan |
| `entrypoints/report/` | Tampilan notulen + ekspor PDF/Markdown/TXT |
| `entrypoints/meeting.content.ts` | Pil REC di halaman Meet/Zoom |
| `lib/recorder.ts` | Capture tab + mic, mixing, dua MediaRecorder, rotasi segmen |
| `lib/slides.ts` | Deteksi pergantian layar (thumbnail 160×90, area bergerak di-mask) dan tangkapan layar JPEG |
| `lib/pipeline.ts`, `lib/prompts.ts`, `lib/ai.ts` | Transkripsi, prompt multibahasa, klien API OpenAI-compatible (retry, timeout) |
| `lib/webm.ts` | Menambahkan durasi ke file WebM dari MediaRecorder |
| `lib/db.ts` | IndexedDB: metadata rekaman + potongan video/audio |

Beberapa keputusan desain:
- **Dua recorder paralel**: video untuk arsip, audio ringan (±14 MB/jam) untuk AI, jadi file yang dikirim ke API selalu
  kecil (jauh di bawah batas 25 MB) dan tidak perlu memisahkan audio dari video.
- **Audio tab diputar ulang ke speaker**: Chrome membisukan tab yang direkam; ekstensi mengembalikan suaranya.
- **PDF via mesin cetak Chrome** (bukan library JS) supaya semua aksara dan teks kanan-ke-kiri tampil benar.
- **Gambar dipilih dalam dua tahap**: model vision membaca setiap tangkapan layar (jenis, teks yang terlihat, skor
  kegunaan 0–10) dalam batch berisi 6 gambar. Model rangkuman lalu memilih gambar per topik berdasarkan waktu dan isinya.
  Hasil baca gambar disimpan, jadi "Rangkum ulang" tidak membaca ulang gambar.
- **Data tersimpan bertahap ke IndexedDB** setiap beberapa detik, jadi rekaman panjang tidak memenuhi RAM dan bisa
  dipulihkan kalau browser crash.

## Keterbatasan

- **Zoom aplikasi desktop tidak didukung**. Gunakan Zoom di browser (`app.zoom.us/wc/...`; di halaman undangan pilih
  *Join from your browser*).
- Setelah klik "Leave" di Google Meet, tab tetap di meet.google.com, jadi rekaman tetap berjalan sampai Anda menekan stop
  atau menutup tab.
- Nama pembicara hanya diketahui kalau disebut dalam percakapan, diisi di "Konteks untuk AI", atau memakai model
  `gpt-4o-transcribe-diarize` (label A/B/…).
- Mulai rekam butuh klik ikon ekstensi atau shortcut, karena aturan keamanan Chrome untuk `tabCapture`. Ekstensi tidak bisa
  mulai merekam sendiri.
- Tangkapan layar berisi seluruh tab meeting (termasuk antarmuka Meet/Zoom di sekitar layar yang dibagikan); belum
  dipotong otomatis ke area presentasi saja.
- Membaca gambar menambah biaya API sesuai jumlah tangkapan layar. Pakai detail `low`, sensitivitas Rendah, atau
  batasi jumlah tangkapan layar untuk menghemat.
- API key disimpan di `chrome.storage.local` di komputer Anda (tidak disinkronkan, tidak dienkripsi).

## Privasi & etika

Rekaman dan notulen hanya disimpan di komputer Anda. Audio dan transkrip dikirim hanya ke API yang Anda konfigurasi.
Merekam percakapan menyangkut data pribadi orang lain (di Indonesia diatur UU PDP No. 27/2022). Beri tahu peserta bahwa
meeting direkam. Pil REC di halaman meeting membantu agar hal ini tetap jelas.

## Pengembangan

```bash
npm run dev        # Chrome dengan hot reload
npm run compile    # cek TypeScript
npm test           # unit test (Vitest)
npm run test:e2e   # uji end-to-end di Chromium (Playwright) dengan server API tiruan
npm run zip        # paket .zip
```

`npm run test:e2e` membangun varian khusus (`--mode e2e`) yang bisa merekam stream sintetis, lalu memuatnya di Chromium,
merekam ±70 detik "presentasi" sintetis (slide berganti tiap 8 detik + tile video bergerak) dengan mikrofon palsu dari
tab Meet tiruan, menutup tab, lalu memeriksa video (durasi, codec, volume), jumlah segmen transkripsi, jumlah tangkapan
layar dan permintaan vision, isi prompt, gambar di PDF, folder `images/`, Markdown, dan transkrip yang tersimpan di disk. Butuh browser Playwright
(`npx playwright install chromium`), `ffprobe`, dan `pdftotext`.
