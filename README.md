# AI Chat App (Multi-Provider)

Aplikasi chat AI open source yang **tidak terkunci ke satu penyedia**. Tinggal masukkan
**domain/base URL API** dari penyedia AI mana pun yang kompatibel dengan spesifikasi
endpoint ala OpenAI (`GET /models`, `POST /chat/completions`), tempel **API key**-nya,
dan aplikasi otomatis mencari & menampilkan semua model yang tersedia dari provider itu.

Provider bisa disimpan lebih dari satu (multi-provider) dan tinggal pindah-pindah lewat
dropdown "Provider tersimpan" di sidebar — cocok untuk Groq, OpenAI, OpenRouter,
Together AI, Mistral, DeepSeek, Fireworks, Cerebras, xAI, atau endpoint self-hosted
(mis. LM Studio / Ollama / vLLM yang expose endpoint ala OpenAI) — apa saja, tinggal isi domainnya.

## Fitur
- **Bring your own provider**: input nama + domain (base URL) + API key → auto-fetch daftar
  model dari endpoint `/models` domain tersebut
- Preset cepat (klik chip) untuk provider populer, tapi field domain tetap bisa diisi manual
  dengan domain apa pun
- Multi-provider tersimpan — pindah provider tanpa isi ulang API key
- Menu dropdown untuk memilih model aktif (per provider)
- **Dua tombol upload**: 📎 *Upload file* (kode/teks/zip) dan 🖼️ *Upload gambar* (galeri/kamera HP). Gambar otomatis dikecilkan & dikonversi ke JPEG sebelum dikirim ke model vision
- Chat streaming (server-sent events) mirip ChatGPT
- Riwayat chat, daftar provider & API key disimpan di localStorage browser (tidak disimpan di server)
- Tanpa framework frontend, tanpa build step — murni HTML/CSS/JS + Cloudflare Workers (static assets)

## Struktur Proyek
```
ai-chat-app/
├── wrangler.toml               # config Cloudflare Worker + assets + env non-rahasia
├── src/worker.js               # backend: proxy generik ke domain provider AI manapun
├── package.json
├── .dev.vars.example           # contoh secret untuk dev lokal
└── public/
    ├── _headers                # Cache-Control: no-cache
    ├── index.html
    ├── style.css
    └── app.js
```

## Jalankan di Lokal
```bash
npm run dev      # = npx wrangler dev
```
Buka `http://localhost:8788`. Di sidebar:
1. Isi **Nama provider** (bebas, mis. "OpenAI Kerja") atau klik salah satu **preset cepat**.
2. Isi/cek **Domain / base URL API** — contoh:
   - Groq: `https://api.groq.com/openai/v1`
   - OpenAI: `https://api.openai.com/v1`
   - OpenRouter: `https://openrouter.ai/api/v1`
   - Atau domain endpoint OpenAI-compatible lain, termasuk yang self-hosted
3. Tempel **API key** milik provider tersebut.
4. Klik **"Sambungkan & cari model"** — daftar model otomatis muncul di dropdown Model.
5. Pilih model, mulai chat.

Ulangi langkah di atas untuk provider lain — semua tersimpan di dropdown
**"Provider tersimpan"** dan bisa dipindah-pindah kapan saja.

## Cara Kerja Auto-Deteksi Model
Backend (`src/worker.js`) tidak hardcode ke satu provider. Saat frontend kirim `baseUrl` +
`apikey`, backend memanggil `GET {baseUrl}/models` dengan header `Authorization: Bearer <apikey>`
persis seperti spesifikasi OpenAI, lalu menormalkan hasilnya jadi daftar model. Endpoint chat
(`POST {baseUrl}/chat/completions`) juga diproksi generik dengan `stream: true` — jadi provider
apa pun yang ikut format ini otomatis kompatibel tanpa perlu ubah kode.

## Deploy ke Cloudflare (Workers + Static Assets)

Frontend statis di `public/`, backend `src/worker.js` (tanpa dependency) untuk route
`/api/models`, `/api/chat`, `/health`. Semua diatur di `wrangler.toml`.

> **Jangan** pakai drag-and-drop "Upload and deploy" di dashboard. Uploader itu cuma untuk file
> statis, menolak `wrangler.toml`, dan backend tidak akan ikut jalan.

### Cara A — via GitHub (paling mudah, bisa dari HP)
1. Push isi folder ini ke repo GitHub:
   ```bash
   git init && git add . && git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/USERNAME/NAMA-REPO.git
   git push -u origin main
   ```
2. Dashboard Cloudflare → **Workers & Pages → Create application → Import a repository** → pilih repo.
3. Nama project: `ai-chat-app` (harus sama dengan `name` di `wrangler.toml`). Build command kosong,
   Deploy command `npx wrangler deploy`. **Deploy**.
4. Setiap `git push` otomatis ter-deploy.

### Cara B — via terminal
```bash
npx wrangler login
npx wrangler deploy
```

### Provider bawaan (opsional)
- `DEFAULT_BASE_URL` & `DEFAULT_KEY_DAILY_LIMIT` ada di `wrangler.toml` → `[vars]`.
- `DEFAULT_API_KEY` wajib sebagai **Secret**: Worker → **Settings → Variables and Secrets → Add → Secret**
  (atau `npx wrangler secret put DEFAULT_API_KEY`).

Catatan:
- Streaming SSE didukung penuh; tidak ada batas 6 MB body seperti Netlify.
- Kuota harian key bawaan dihitung di memori per isolate, jadi hanya perkiraan kasar — set juga limit di dashboard provider.
- Variabel non-rahasia diatur dari `wrangler.toml`; secret tetap lewat dashboard/CLI.

## Jadi APK
Aplikasi ini PWA (ada `manifest.json` + service worker). Setelah live di Cloudflare, buka URL-nya di
https://www.pwabuilder.com → Package for Android, atau di Chrome HP: ⋮ → *Install app*.

## Provider Bawaan untuk Visitor Baru (opsional)

Secara default, visitor baru harus isi provider + API key sendiri sebelum bisa chat.
Kalau mau visitor baru **langsung bisa chat tanpa isi API key** (pakai kuota kamu):

1. Di `public/config.js`, cek/atur `app.defaultProvider` — `baseUrl`-nya sudah default ke
   Groq (`https://api.groq.com/openai/v1`), boleh diganti provider lain kalau mau.
2. Di server (**bukan** `config.js`):
   - `wrangler.toml` → `[vars]`: `DEFAULT_BASE_URL` (harus SAMA PERSIS dengan config.js) & `DEFAULT_KEY_DAILY_LIMIT`
   - `DEFAULT_API_KEY` sebagai **Secret** di dashboard Cloudflare (atau `.dev.vars` untuk lokal)
3. Deploy ulang.

`config.js` cuma tahu **baseUrl** (file itu publik, dikirim ke semua browser yang buka
situsnya). Kunci API asli **hanya** hidup sebagai Secret sisi server dan tidak pernah dikirim
ke frontend — visitor cuma bisa *memakainya* lewat proxy `/api/chat`, tidak bisa
*melihat* kuncinya. Kalau `DEFAULT_API_KEY` dikosongkan, visitor baru tetap dapat
baseUrl Groq otomatis terisi, tapi tetap harus tempel API key mereka sendiri.

## Catatan Keamanan
- Nama provider, domain, dan API key disimpan di **browser (localStorage)**, bukan di
  server — cocok untuk pemakaian pribadi. Jika mau dipakai banyak orang, tambahkan sistem
  login + penyimpanan key per-user di database sebelum dipublikasikan luas.
- Backend hanya meneruskan (proxy) request ke domain yang kamu isi sendiri — pastikan
  domain yang diisi memang endpoint provider AI tepercaya.
- Jangan commit file `.dev.vars` berisi key ke repo publik (sudah di `.gitignore`).
- Kalau mengaktifkan provider bawaan (`DEFAULT_API_KEY` Secret), kunci itu bisa dipakai
  **siapa saja yang membuka situsnya** (lewat proxy, bukan dilihat langsung) — set
  `DEFAULT_KEY_DAILY_LIMIT` yang wajar dan/atau atur limit pemakaian resmi di dashboard
  provider-nya (Groq dkk biasanya punya rate-limit/budget alert sendiri).

## Lisensi
MIT — bebas dipakai, dimodifikasi, dan disebarluaskan.
