# Aomi — Asisten Chat AI

Aplikasi web chat AI modern dengan sistem login lengkap (register, login,
logout, remember me, session management, verifikasi manusia, anti brute force),
dibangun dengan **Next.js 15 (App Router) + TypeScript**, dioptimalkan untuk
Vercel. Riwayat percakapan tersimpan per akun.

## Arsitektur

```
Browser → Route Handler /api/* (session via header X-Session-Id)
              ├── Provider AI (Gemini scraping)
              └── lib/server/store.ts → Upstash Redis (utama; fallback: GitHub repo)
```

- Frontend (React client components) **tidak pernah** mengakses database
  atau provider AI langsung.
- Database utama: **Upstash Redis** (free tier, REST API — 500K command/bulan,
  tanpa 'abuse rate limit' seperti GitHub Contents API). Semua operasi lewat
  `lib/server/store.ts` (interface readJson/putJson/updateJson/deleteJson + TTL).
- **Fallback otomatis**: selama env Upstash belum diset, `store.ts` meneruskan
  semua operasi ke GitHub (repo private
  [Rendyzzx/token](https://github.com/Rendyzzx/token)) — situs tetap jalan
  selama transisi. Migrasi data: `scripts/migrate-github-to-redis.mjs`.
- Session ber-TTL otomatis di Redis (kedaluwarsa terhapus sendiri, tanpa GC manual).

## Struktur

```
.
├── app/
│   ├── page.tsx             # Aplikasi chat (wajib login)
│   ├── auth/page.tsx        # Landing + login & registrasi
│   ├── layout.tsx
│   └── api/                 # Route Handler — contract identik dengan versi lama
│       ├── auth/            # captcha, register, login, logout, me
│       ├── chat/            # proxy AI + simpan pesan (maxDuration 60)
│       ├── conversations/   # CRUD riwayat percakapan per user
│       ├── bot/             # konfigurasi karakter per user
│       ├── profile/         # profil user (username, display name, avatar)
│       ├── dl/              # proxy unduhan TikTok/IG (anti SSRF allowlist)
│       ├── music/           # fitur musik: resolve link audio + proxy unduh lagu
│       ├── hd/              # fitur HD video: poll job + proxy unduh hasil (maxDuration 60)
│       └── tempimg/         # host gambar sementara (maxDuration 30)
├── components/
│   ├── chat/                # ChatApp (orchestrator), MessageRow, MessageMenu,
│   │                        # ConfirmDialog
│   ├── sidebar/             # Sidebar + lazy conversation list
│   ├── settings/            # SettingsView (overlay SPA)
│   ├── music/               # MusicProvider (player global popup + mini bar),
│   │                        # MusicCardView (kartu lagu di bubble)
│   ├── auth/                # AuthLanding (landing + form Masuk/Daftar)
│   ├── brand/               # BrandSplash (splash WebGL raymarch di /auth)
│   └── ui/                  # Icon, Avatar
├── lib/
│   ├── server/              # store.ts, github.ts, auth.ts, ratelimit.ts,
│   │                        # bot-config.ts, http.ts, music.ts, version.ts
│   ├── session.ts           # session id opaque di sessionStorage
│   ├── client-api.ts        # helper fetch + gerbang 401
│   ├── image.ts             # kompresi gambar client-side
│   ├── video.ts             # upload video chunked + ekstraksi frame (client)
│   └── chat-utils.ts        # konstanta edit foto + helper pesan
├── styles/                  # main, sidebar, chat, auth, settings (CSS asli)
├── public/                  # icons.svg, assets/ (favicon, artwork)
├── types/                   # tipe bersama (Message, BotConfig, dll.)
├── scripts/                 # migrate-github-to-redis.mjs
├── next.config.ts           # header keamanan/cache + redirect /auth.html → /auth
└── .env.example
```

## Pengembangan lokal

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # build production (type-check strict)
```

## Fitur musik (putar lagu)

Ketik di chat: **"tolong putarkan lagu X"**, **"playkan lagu X"**, **"nyanyiin lagu X"**,
"ganti lagu X", atau "putar <link YouTube>".

Alur:

```
pesan → deteksi trigger (regex di lib/chat-utils.ts)
      → lib/server/music.ts: cari di YouTube (scrape) → savetube (audio 128kbps)
        → LRCLIB (lirik sinkron, fallback plain → perkiraan)
      → kartu lagu (music) disimpan di pesan assistant
      → client: kartu lagu + MusicProvider (popup player)
```

- Player popup melayang (bisa digeser), lirik auto-scroll sinkron, seek, ±10 detik,
  minimize jadi mini bar — **musik tetap jalan di background** sampai user stop.
- Tombol **Unduh lagu** ada di bawah player → `/api/music?action=dl` (proxy savetube,
  attachment, nama file rapi, allowlist hostname ketat).
- Link audio savetube kedaluwarsa → player otomatis resolve ulang via
  `/api/music?action=resolve` (sekali per lagu), jadi kartu lagu di riwayat lama tetap bisa diputar.
- Key dekripsi savetube sudah built-in (key publik dari scraper komunitas); env `SAVETUBE_KEY`
  opsional untuk override tanpa redeploy.

## Fitur generate gambar (AI text2img)

Ketik di chat: **"buatkan gambar X"**, "bikin gambar X", "generate gambar X", "gambarin X".

Alur (pola sama seperti edit foto — API faa CORS terbuka, browser yang menembak
langsung supaya bebas dari limit 60 detik runtime server; generate terukur ±30-60s):

```
pesan → deteksi trigger (regex di lib/chat-utils.ts)
      → server: simpan pesan user, balas cepat { imggen_job: { prompt } }
      → browser: fetch api-faa.my.id/faa/ai-text2img-pro?prompt=…
        (hasil biner → blob image/png|jpg, di-snip saat disimpan)
      → POST /api/chat action=imggen-save → sniff + simpan ke tempimg (TTL 3 hari)
      → pesan assistant: gambar + tombol Unduh (image_url + expires_at)
```

- Objek wajib ada kata "gambar"/"image"/"poster"/dll untuk buat/bikin/generate
  (menghindari false positive seperti "bikin kopi"); "gambarin" cukup verb-nya.
- Hasil generate tersimpan sama seperti hasil edit foto: URL unduh 3 hari +
  thumbnail permanen di riwayat (action thumb).
- Gagal (timeout/klar) → pesan kesalahan di chat + tersimpan via action imggen-fail.

## Fitur HD video (upgrade kualitas)

Ketik di chat: **"hdkan <link video>"**, "jadiin hd <link>", "bikin hd <link>", "hd kan video ini <link>".

Alur (job asynchronous, pola 2 API: submit → poll hasil):

```
pesan → deteksi trigger (HD_TRIGGER_RE + URL, localhost/IP lokal ditolak)
      → server: POST api-faa.my.id/faa/hdvid?url=… → { job_id }
      → kartu HD (hd) state "pending" disimpan di pesan assistant, balas cepat
      → client: kartu polling /api/hd?action=poll&job=… tiap 4 detik
        sampai state "done" (download_url + quality muncul)
      → tombol Unduh → /api/hd?action=dl (proxy hasil, attachment,
        allowlist hostname ketat: uguu.se / api-faa.my.id, cap 80MB)
```

- Kartu TIDAK di-update di storage saat selesai — job_id stabil, jadi kartu di
  riwayat lama otomatis poll ulang dan tetap bisa unduh selama job masih ada
  di sisi layanan faa (pola sama seperti resolve musik).
- URL localhost / jaringan lokal ditolak; hanya link video publik yang disubmit.

## Fitur HD foto (upscale gambar)

Kirim FOTO di chat + bilang **"hdkan foto ini"** (trigger HD sama seperti
video, tapi yang dilampirkan gambar). Alur server-side (API sinkron ±7 detik):

```
gambar terlampir + trigger HD
  → server host input di /api/tempimg (URL publik, hdv4 butuh URL)
  → GET api-faa.my.id/faa/hdv4?image=<url>  (sinkron, hasil 4x resolusi)
  → unduh image_upscaled → rehost di tempimg (TTL unduh 3 hari)
  → balas image_url + tombol unduh (pola sama seperti hasil edit foto)
```

- hdv4 teruji: 720x796 → 2880x3184 (4x upscale).
- Gagal upscale → error ramah ke user, percakapan tetap tersimpan.

## API edit foto (DIGANTI 2026-10)

Edit foto sekarang pakai API baru (yang lama api-faa editfoto dibuang):

```
browser: GET apiii-xrina.vercel.app/ai-image/editimg?image=<input_url>&prompt=<p>
       → balasan: gambar binary langsung (image/png)
       → error: HTTP 500 JSON { status:false, message } (mis. "Insufficient credits")
```

- Param input ganti dari `url=` ke `image=`.
- Balasan binary → client cek `blob.type.startsWith("image/")`; error JSON
  masuk jalur gagal yang ramah (kirim ulang fotonya).
- Catatan: API ini balas cepat saat sukses; error "Insufficient credits"
  berarti kredit backend xrina habis (di luar kendali kita).

## Fitur upload video (HD + AI vision)

Klik ikon + di composer → pilih video (MP4/WebM/MOV, maks 50MB). Dua mode
otomatis, tanpa menu:

- **"hdkan video ini"** (atau trigger HD lain) → video diupload, job HD
  di-submit pakai URL hasil upload, kartu HD seperti mode link.
- **Pesan bebas** ("apa isi videoku?") → AI vision melihat isi video:
  browser mengekstrak 6 frame secara merata (canvas), frame dikirim ke
  Gemini vision sebagai lampiran gambar — AI menjawab tentang isi video.

Alur upload (uguu.se CORS-nya tertutup → server jadi perantara; batas body
Vercel ±4.5MB → file dipecah chunk):

```
browser: init → POST /api/vupload {action:init,name,mime,size} → upload_id
        chunk → POST /api/vupload {action:chunk,upload_id,index,data(b64)}
                (berulang per ±2MB, progress bar di preview)
       finish → POST /api/vupload {action:finish,upload_id,total}
              → server rakit → upload ke uguu.se → { url publik }
```

- Server merakit chunk, mengupload sekali ke uguu, lalu menghapus chunk dari
  store (sisa chunk kedaluwarsa lewat TTL 1 jam).
- URL video di /api/chat divalidasi host uguu.se saja (UPLOAD_HOST_RE).
- Upload video LANGSUNG ke Google content-push ternyata butuh akun login —
  makanya vision pakai frame (teruji: AI menjawab isi video dari frame).

## Fix Gemini vision upload (2026-10)

Endpoint lama `content-push.upload.googleapis.com` (X-Tenant-Id gemini,
POST tunggal) sudah MATI — chat gambar di produksi diam-diam jalan teks
saja ("gambar ga kebawa"). Alur baru (pola resumable 2 langkah):

```
POST content-push.googleapis.com/upload/
     headers: Authorization Basic <fixed>, push-id feeds/mcudyrk2a4khkz,
              x-goog-upload-protocol resumable, x-tenant-id bard-storage
     body: "File name: <nama>"
  → header x-goog-upload-url  (URL sekali pakai)
POST <upload_url>  bytes file (command upload, finalize)
  → media key (teks) → dipasang di posisi 4 array pesan
```

Sama untuk gambar dan frame video. Gagal upload → chat tetap jalan teks
(graceful fallback), dengan catatan di pesan.

## Data yang disimpan (database)

```
users/_index.json          { emails: {…}, usernames: {…} }
users/<user_id>.json       { id, username, email, password_hash, created_at }
sessions/<session_id>.json { session_id, user_id, last_activity, expires_at }
chats/<user_id>/_index.json [ { conversation_id, title, updated_at } ]
chats/<user_id>/<conversation_id>.json
                          { messages: [ { message_id, role, content, timestamp } ] }
bots/<user_id>.json        { bot_name, personality, traits, memories, … }
locks/login-<hash>.json   { fails, locked_until }   # anti brute force
vupload/<id>/…            # chunk upload video (TTL 1 jam, dihapus saat finish)
```

## Environment Variables (Vercel — WAJIB)

| Nama | Keterangan |
|------|------------|
| `UPSTASH_REDIS_REST_URL` | URL REST database Upstash Redis (database utama; jika kosong → otomatis fallback ke GitHub) |
| `UPSTASH_REDIS_REST_TOKEN` | Token REST Upstash |
| `GITHUB_TOKEN` | Token GitHub dengan akses repo `Rendyzzx/token` (fallback + migrasi data) |
| `SESSION_SECRET` | String acak bebas (untuk enkripsi captcha & verifikasi token). Jika tidak di-set, fallback ke `GITHUB_TOKEN` |
| `APP_VERSION` | String versi bebas, contoh: `2026.10.02.001` — HANYA dari env, jangan fallback ke SHA commit |
| `GOOGLE_CLIENT_ID` | Client ID Google OAuth (buat di [Google Cloud Console](https://console.cloud.google.com/apis/credentials)) |
| `GOOGLE_CLIENT_SECRET` | Client Secret Google OAuth (server-side only, jangan expose) |
| `GOOGLE_REDIRECT_URI` | Opsional — override redirect URI auto-detect. Default: `<origin>/api/auth/google/callback` |
| `GOOGLE_SITE_VERIFICATION` | Token verifikasi Google Search Console (content dari meta tag). Opsional — bila kosong, meta tag verifikasi tidak dirender |
| `SAVETUBE_KEY` | Opsional — override key dekripsi metadata savetube (default sudah built-in dari scraper publik) |

Set di: **Settings → Environment Variables** → isi Production, Preview,
Development → **Redeploy**.

## Login dengan Google (Opsional)

1. Buka [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Buat **OAuth 2.0 Client ID** (type: Web application).
3. Tambahkan **Authorized redirect URI**:
   - Production: `https://cyronime.web.id/api/auth/google/callback`
   - Development: `http://localhost:3000/api/auth/google/callback`
4. Salin Client ID dan Client Secret → set `GOOGLE_CLIENT_ID` dan
   `GOOGLE_CLIENT_SECRET` di Environment Variables Vercel → Redeploy.

Flow: klik "Masuk dengan Google" → consent Google → callback → email
dicocokkan dengan akun yang sudah ada (auto-link via email) atau akun
baru dibuat → session dibuat → masuk ke Aomi. User existing tetap bisa
login dengan password seperti biasa.

## SEO & Google Search Console

- Landing (`/auth`) diindeks Google; chat app (`/`) noindex (butuh login).
- Sitemap otomatis: `/sitemap.xml` — robots.txt di `/robots.txt`.
- Banner Open Graph: `/assets/og-banner.png` (1200×630, karakter Aomi).
- Meta `google-site-verification` dirender dari env `GOOGLE_SITE_VERIFICATION`
  (set di Vercel → Environment Variables → Redeploy).

Cara daftar ke Google Search Console:

1. Buka [Google Search Console](https://search.google.com/search-console) → tambah properti `https://cyronime.web.id` (URL prefix).
2. Pilih verifikasi **HTML tag** → salin nilai `content` dari tag yang diberikan.
3. Set nilai itu sebagai `GOOGLE_SITE_VERIFICATION` di Vercel → Redeploy.
4. Klik **Verify** di Search Console.
5. Submit `https://cyronime.web.id/sitemap.xml` di menu **Sitemaps**.

## Keamanan

- Password di-hash **scrypt** + salt, verifikasi timing-safe.
- Session: token acak 256-bit dikirim via header **X-Session-Id** (tidak ada cookie auth
  persisten; client hanya menyimpan session id opaque di sessionStorage — tanpa
  password/token/API key di browser).
- APP_VERSION HANYA dari Environment Variables Vercel.
  Deploy baru TIDAK mematikan session; naikkan APP_VERSION secara manual saat
  memang ingin force-logout semua user versi lama (satu kali logout, by design).
  JANGAN fallback ke SHA commit — tiap push akan me-logout semua user dan
  terlihat seperti login loop saat deploy beruntun.
- Masa berlaku session: 12 jam, atau 30 hari dengan "Remember Me"
  (server-side expiry + refresh lazy tiap 6 jam).
- Verifikasi manusia: soal matematika acak, jawaban dikirim ke browser
  dalam bentuk terenkripsi AES-256-GCM → bot tidak bisa membaca jawaban
  dari token. Tanpa layanan pihak ketiga.
- Login gagal 5x dalam 15 menit → akun+IP terkunci 15 menit (persist di storage).
- Rate limit register/login/chat per IP.
- Validasi & sanitasi semua input; timeout ketat; hostname upstream fixed
  (cegah SSRF); error generik tanpa path/env/debug; geminiSessionId tidak
  pernah dikirim ke browser.
- Teks pesan dirender sebagai React text node → HTML di dalam pesan
  tidak pernah dieksekusi (XSS-safe tanpa sanitizier manual).

## Performa

- Append-only rendering; virtualisasi DOM (maks ±150 node, muat per 30).
- Sidebar lazy render per 12 item (IntersectionObserver), pencarian debounce.
- Indeks riwayat dipisah dari isi percakapan → daftar chat tetap ringan
  walau percakapan panjang.
- Tanpa webfont eksternal di halaman chat; CSS asli tanpa framework CSS.
- Mobile-first: drawer, `100dvh`, keyboard-safe, tanpa horizontal scroll.

## Forgot Password

Belum diimplementasikan (butuh layanan email untuk mengirim tautan reset).
Bisa ditambahkan nanti.
