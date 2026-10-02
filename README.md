# Aomi — Asisten Chat AI

Aplikasi web chat AI modern dengan sistem login lengkap (register, login,
logout, remember me, session management, verifikasi manusia, anti brute force),
dioptimalkan untuk Vercel Serverless. Riwayat percakapan tersimpan per akun.

## Arsitektur

```
Browser → /api/* (Vercel Serverless, session via header X-Session-Id)
              ├── Provider AI (Gemini scraping → Groq → ChatEverywhere)
              └── GitHub private repo sebagai database JSON
```

- Frontend **tidak pernah** mengakses GitHub atau provider AI langsung.
- Token GitHub hanya hidup di **Vercel Environment Variables** (`GITHUB_TOKEN`),
  tidak pernah muncul di browser maupun source code.
- Database: repo private [Rendyzzx/token](https://github.com/Rendyzzx/token) —
  hanya file JSON yang dibutuhkan yang dibaca (per file via Contents API),
  tidak pernah memuat seluruh database.

## Struktur

```
.
├── index.html            # Aplikasi chat (wajib login)
├── auth.html             # Halaman login & registrasi
├── vercel.json
├── api/
│   ├── lib/
│   │   ├── github.js     # Contents API: read/put/update/delete JSON
│   │   ├── auth.js       # scrypt, session, captcha terenkripsi, lock login
│   │   └── ratelimit.js  # rate limiter in-memory per instance
│   ├── auth/
│   │   ├── captcha.js    # GET  soal verifikasi manusia
│   │   ├── register.js   # POST registrasi (+ auto login)
│   │   ├── login.js      # POST login (remember me, lock brute force)
│   │   ├── logout.js     # POST logout
│   │   └── me.js          # GET  info user dari session
│   ├── conversations.js  # CRUD riwayat percakapan per user
│   └── chat.js           # proxy AI + simpan pesan ke percakapan user
├── css/                  # main, sidebar, chat, auth
├── js/                   # app (gerbang auth), sidebar, chat, auth
├── components/icons.svg
└── assets/favicon.svg
```

## Data yang disimpan (repo database)

```
users/_index.json          { emails: {…}, usernames: {…} }
users/<user_id>.json       { id, username, email, password_hash, created_at }
sessions/<session_id>.json { session_id, user_id, last_activity, expires_at }
chats/<user_id>/_index.json [ { conversation_id, title, updated_at } ]
chats/<user_id>/<conversation_id>.json
                          { messages: [ { message_id, role, content, timestamp } ] }
locks/login-<hash>.json   { fails, locked_until }   # anti brute force
```

## Environment Variables (Vercel — WAJIB)

| Nama | Keterangan |
|------|------------|
| `GITHUB_TOKEN` | Token GitHub dengan akses repo `Rendyzzx/token` |
| `SESSION_SECRET` | String acak bebas (untuk enkripsi captcha & verifikasi token). Jika tidak di-set, fallback ke `GITHUB_TOKEN` |
| `GROQ_API_KEY` | Opsional. Fallback AI bila scraping Gemini gagal |

Set di: **Settings → Environment Variables** → isi Production, Preview,
Development → **Redeploy**.

## Keamanan

- Password di-hash **scrypt** + salt, verifikasi timing-safe.
- Session: token acak 256-bit dikirim via header **X-Session-Id** (tidak ada cookie auth
  persisten; client hanya menyimpan session id opaque di sessionStorage — tanpa
  password/token/API key di browser).
- Setiap deployment baru (APP_VERSION / SHA commit berubah) otomatis meng-invalid-kan
  SEMUA session versi lama → semua user logout → login ulang dengan UI versi terbaru.
- Asset JS/CSS distempel hash versi saat build (?v=…) + HTML no-cache → browser tidak
  pernah memakai JS/CSS lama setelah redeploy.
- Masa berlaku session: 12 jam, atau 30 hari dengan "Remember Me"
  (server-side expiry + refresh lazy tiap 6 jam).
- Verifikasi manusia: soal matematika acak, jawaban dikirim ke browser
  dalam bentuk terenkripsi AES-256-GCM → bot tidak bisa membaca jawaban
  dari token. Tanpa layanan pihak ketiga.
- Login gagal 5x dalam 15 menit → akun+IP terkunci 15 menit (persist di repo).
- Rate limit register/login/chat per IP.
- Validasi & sanitasi semua input; timeout ketat; hostname upstream fixed
  (cegah SSRF); error generik tanpa path/env/debug; geminiSessionId tidak
  pernah dikirim ke browser.

## Performa

- Append-only rendering; virtualisasi DOM (maks ±150 node, muat per 30).
- Sidebar lazy render per 12 item (IntersectionObserver), pencarian debounce.
- Indeks riwayat dipisah dari isi percakapan → daftar chat tetap ringan
  walau percakapan panjang.
- Tanpa framework, tanpa webfont, tanpa dependency eksternal.
- Mobile-first: drawer, `100dvh`, keyboard-safe, tanpa horizontal scroll.

## Forgot Password

Belum diimplementasikan (butuh layanan email untuk mengirim tautan reset).
Bisa ditambahkan nanti.
