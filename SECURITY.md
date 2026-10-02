# Security

Dokumen ini merangkum arsitektur keamanan Aomi: apa yang dilindungi,
di mana batasnya, dan cara memverifikasinya. Tidak ada secret di sini.

## Prinsip

Security boundary selalu di **server**. Frontend hanya UI — tombol
tersembunyi/disabled bukan security. Semua endpoint private memverifikasi
session di server, dan semua data disimpan terisolasi per akun.

## Authentication

- **Session token opaque 256-bit** (random hex, bukan JWT — tidak ada
  metadata yang bisa dibaca klien). Dikirim via header `X-Session-Id`
  (atau `Authorization: Bearer`), disimpan di `sessionStorage` browser.
  Tidak ada password/token/API key yang pernah ditulis ke localStorage.
- Sesi 12 jam (atau 30 hari dengan "Ingat saya"), refresh aktif max
  1x/6 jam, dan **hancur otomatis saat versi aplikasi naik**.
- Password: scrypt + salt, perbandingan timing-safe. Tidak pernah
  dikirim ke log, tidak pernah dikembalikan di respons API.
- Login brute force: lock 15 menit setelah 5 gagal per
  identitas+IP (persist di storage, bukan memori).
- Register/login: rate limit per IP + captcha terenkripsi AES-256-GCM
  (jawaban tidak pernah dikirim plaintext ke klien).
- Google OAuth: state + PKCE, cookie `HttpOnly; Secure; SameSite=Lax`,
  dibuang segera setelah callback.

## Authorization & isolasi data

- Semua data user disimpan di path berisi `user_id` dari session
  (`chats/<uid>/...`, `bots/<uid>.json`, `users/<uid>.json`). Server
  **tidak pernah** menerima `user_id` dari klien — ID di query/body
  hanya bisa menunjuk objek milik sendiri.
- Percakapan, bot config, profil, dan memory milik User A secara
  struktural tidak bisa diakses User B (IDOR tidak mungkin lewat
  pergantian ID — path tetap di bawah `chats/<uid>/` milik session).
- Endpoint proxy unduhan (`/api/dl`, `/api/music?action=dl`) menerima
  session via `?sid=` karena `<a>` tidak bisa set header — token tetap
  divalidasi sama, tidak ada pengecualian.

## Rate limiting

In-memory per-instance (burst limiter). Kunci:

| Endpoint scope | Kunci | Limit |
|---|---|---|
| `/api/chat` | per user | 20/menit |
| chat → musik (resolve di POST chat) | per user | 8/menit |
| `/api/conversations` list/read | per user | 120/menit |
| `/api/conversations` write | per user | 40/menit |
| `/api/conversations` delete | per user | 60/menit |
| `?export=1` (unduhan massal) | per user | **3/jam** |
| `?all=1` (hapus massal) | per user | **6/jam** |
| `/api/dl` | per user | 15/menit |
| `/api/music` resolve / unduh | per user | 20 / 15 per menit |
| `/api/bot`, `/api/profile` | per user | 20/menit |
| `/api/auth/login` | per IP (+ lock per identitas) | 10/menit |
| `/api/auth/register` | per IP | 5/10 menit |
| `/api/auth/captcha` | per IP | 30/menit |
| `/api/tempimg` (publik by design) | per IP | 120/menit |
| `/api/status` (publik) | per IP | 30/menit |

Limit berbasis **user ID** untuk endpoint ber-session: beberapa orang
di belakang NAT tidak saling terpengaruh, dan ganti IP tidak me-reset
kuota per akun. IP dipakai hanya untuk endpoint pre-auth/publik.

## Anti-scraping & abuse

- Daftar percakapan **dipaginasi server-side**: maksimum 50 item per
  request (`?limit` > 50 dikecilkan diam-diam; `?offset` = integer).
  Respons: `{ items, total, has_more }`.
- Isi satu percakapan dibatasi 100 pesan/percakapan (server-side) dan
  konteks yang dikirim ke AI hanya 8 pesan terakhir.
- Panjang input dibatasi di server: pesan 4000 char, prompt tambahan
  1000, gambar base64 ≤ 4MB, judul ≤ 48 char. `?limit=999999`
  diabaikan.
- Ekspor massal (`?export=1`) dibatasi ketat — hanya jalan keluar
  massal yang sah, untuk pemilik akun sendiri.
- Saat limit terlampaui: respons 429 + `Retry-After` + security log
  `RATE_LIMIT_EXCEEDED` (endpoint + uid + IP + waktu; **tanpa** isi
  pesan/kredensial). Tidak ada auto permanent-ban dari satu sinyal;
  pola berulang dianalisis dari log sebelum tindakan manual.

## Input validation & SSRF

- Semua input server tervalidasi: tipe, panjang, format (regex ketat),
  dan enum (segmented options dibandingkan terhadap allowlist server).
- Proxy unduhan (`/api/dl`, `/api/music`): **allowlist hostname ketat**
  (hanya CDN TikTok / savetube), wajib https, cap 30MB, timeout 55-60s.
  URL ke localhost/private IP/metadata cloud ditolak karena tidak
  match allowlist — blocklist tidak dipakai, allowlist yang jadi default-deny.
- Upload gambar: hanya dataURL `image/(png|jpeg|webp|gif)` via regex
  ketat, ≤ 4MB, dimensi dikecilkan klien lalu disimpan sebagai objek
  terisolasi; tidak ada file yang ditulis ke filesystem server.

## Error handling & minimisasi respons

- Error ke klien selalu pesan generik ("Gagal menyimpan. Coba lagi.");
  detail error hanya ke log server. Tidak ada stack trace, path, nama
  provider mentah, atau environment yang bocor ke respons.
- `geminiSessionId` (session id provider AI) dihapus dari setiap
  respons percakapan; API tidak pernah mengembalikan objek storage mentah.

## Security headers

`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy`, `Permissions-Policy`, `HSTS`, `X-DNS-Prefetch-Control`,
dan CSP moderat (`default-src 'self'`, `connect-src 'self'`,
`object-src 'none'`, `frame-ancestors 'none'`). Inline script diizinkan
(hydration Next + script anti-flash tema); resource eksternal dibatasi
per-tipe (img/media CDN). CSP ini sengaja tidak lebih ketat —
per ketat lagi hanya setelah test menyeluruh.

## CSRF / origin

Sesi dikirim via header kustom (bukan cookie) sehingga request
cross-origin dari site lain tidak bisa memasang session. Sebagai
defense-in-depth, semua endpoint state-changing menolak request yang
menyertakan `Origin` dari host berbeda.

## Secret management

- Semua secret hanya di environment variable server
  (`SESSION_SECRET`, `GITHUB_TOKEN`, `REDIS_URL`, `GOOGLE_*`).
- Tidak ada `NEXT_PUBLIC_*` secret; client bundle tidak berisi
  kredensial apapun (verifikasi: grep `NEXT_PUBLIC` / `process.env`
  di `components/` dan `lib/` non-server → kosong).
- `SAVETUBE_KEY_DEFAULT` di `lib/server/music.ts` adalah kunci
  publik yang memang didistribusikan bersama scraper savetube
  (bukan kredensial privat); env `SAVETUBE_KEY` tetap bisa dipakai
  untuk override. Modul itu hanya di-import dari server route.

## Dependency

`npm audit`: advisory postcss (high, dev/build-time — dieksploitasi
hanya bila memproses CSS pihak ketiga saat build; Aomi tidak).
Fix resminya mengharuskan Next.js 16 (major) — ditunda sampai
kompatibilitas dites, bukan di-upgrade membabi buta.

## Cara menjalankan security checks

```bash
npm run lint && npx tsc --noEmit && npm run build
```

Test manual cepat (staging/lokal, JANGAN di production):

1. `curl /api/conversations` tanpa header session → 401.
2. `curl "/api/conversations?id=<uuid-user-lain>"` dengan session
   user lain → 404 (bukan 200).
3. `curl "/api/conversations?limit=9999"` → respons maksimal 50 item.
4. Hammer login 11x → 429 / lock.
5. `/api/dl?url=http://127.0.0.1/...` → ditolak (bukan https/allowlist).
6. Build lalu grep string secret di `.next/static/` → kosong.
7. Logout → session lama ditolak (`sessions/<sid>.json` dihapus).
