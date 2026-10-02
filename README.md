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
│       └── tempimg/         # host gambar sementara (maxDuration 30)
├── components/
│   ├── chat/                # ChatApp (orchestrator), MessageRow, MessageMenu,
│   │                        # ConfirmDialog, Intro
│   ├── sidebar/             # Sidebar + lazy conversation list
│   ├── settings/            # SettingsView (overlay SPA)
│   ├── auth/                # AuthLanding (landing + form Masuk/Daftar)
│   └── ui/                  # Icon, Avatar
├── lib/
│   ├── server/              # store.ts, github.ts, auth.ts, ratelimit.ts,
│   │                        # bot-config.ts, http.ts, version.ts
│   ├── session.ts           # session id opaque di sessionStorage
│   ├── client-api.ts        # helper fetch + gerbang 401
│   ├── image.ts             # kompresi gambar client-side
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
