# Storage & Redis — Aomi

## Arsitektur

```
Website API + Bot Telegram (service layer sama)
  → lib/server/store.ts  (satu abstraksi untuk SEMUA data)
      → Upstash Redis REST  (utama — env UPSTASH_REDIS_REST_URL/TOKEN)
      → GitHub repo Rendyzzx/token (fallback otomatis jika env kosong)
```

- Frontend **tidak pernah** mengakses storage langsung.
- `store.ts` otomatis menambahkan prefix `aomi:` pada semua key.
- Operasi: `readJson`, `putJson`, `putJsonIfAbsent` (SET NX EX),
  `updateJson`, `deleteJson`, `deleteMany`, `expireJson`,
  `listJsonPaths` (SCAN), `redisCommand` (Redis-only).

## Namespace & key

| Key | Isi | TTL |
|---|---|---|
| `aomi:users/<uid>.json` | akun user | — |
| `aomi:users/_index.json` | indeks email→id, username→id | — |
| `aomi:users/suspended.json` | daftar id user dibekukan | — |
| `aomi:sessions/<sid>.json` | sesi login | s.d. expiry sesi |
| `aomi:locks/login-<hash>.json` | lock brute-force login | sisa window |
| `aomi:chats/<uid>/_index.json` | indeks percakapan | — |
| `aomi:chats/<uid>/<cid>.json` | isi percakapan | — |
| `aomi:tempimg/<id>.json` | gambar sementara (b64) | input 1 jam / hasil 3 hari |
| `aomi:maintenance/state.json` | mode off/on/scheduled + jadwal ISO | — |
| `aomi:maintenance/config.json` | judul/pesan/estimasi halaman | — |
| `aomi:announcement/state.json` | banner pengumuman website | — |
| `aomi:features/state.json` | feature flags (1 record) | — |
| `aomi:audit/log.json` | aksi admin (cap 100 entri) | — |
| `aomi:telegram/session/<id>.json` | state bot per admin | 10 menit |
| `aomi:telegram/seen/<upid>.json` | update Telegram terproses | 1 jam |
| `aomi:telegram/security.json` | statistik akses tanpa izin | — |
| `aomi:assets/state.json` | reference asset situs (character, login banner) — **tanpa binary** | — |
| `aomi:status/_healthcheck.json` | (tidak pernah dibuat) probe | — |

Definisi key terpusat di `lib/redis/keys.ts` — jangan menulis
string key acak di luar file itu (untuk fitur baru).

## Cache strategy

- **State maintenance** dibaca tiap request halaman → cache
  in-memory 15 detik per instance di service (bukan sumber
  kebenaran). Middleware cache 5 detik.
- **Feature flags** cache 30 detik per instance.
- **Announcement** cache 30 detik.
- **Daftar suspended** cache 30 detik (gate login/chat).
- Cache hanya mempercepat — nilai sumber selalu di storage;
  setiap tulisan langsung menghapus cache instance itu.

## Mode fallback GitHub

Tanpa env Upstash, semua operasi diteruskan ke repo `Rendyzzx/token`
(file JSON, konflik via sha). Catatan penting:

- `expireJson` no-op → penanda idempotency Telegram tidak otomatis
  kedaluwarsa (paling tidak efisien, tapi tetap benar; Redis
  direkomendasikan untuk bot admin).
- `putJsonIfAbsent` read-then-write (race kecil mungkin).
- Info Redis / DBSIZE tidak tersedia (menu Database jujur
  menampilkan mode fallback).

## Asset gambar (upload dari bot)

Binary gambar TIDAK disimpan di Redis. Flow:

```
admin kirim foto di Telegram
  → validasi magic bytes (JPEG/PNG/WEBP, maks 5 MB)
  → binary → repo token Rendyzzx/token, path assets/site/<kind>-<hash>.<ext>
  → Redis aomi:assets/state.json: { storageKey, version=sha256[:12],
    contentType, size, width, height, updatedAt, uploadedBy }
  → disajikan via /api/assets/<kind>?v=<version> (proxy — repo private)
```

- `kind`: `character` (hero maintenance page), `login-banner` (peekaboo — karakter di atas form login "Selamat datang kembali", BUKAN hero marketing landing page).
- Version = content hash → URL berubah hanya saat gambar berubah; browser
  boleh cache permanen per URL (immutable), upload baru otomatis
  mengganti tanpa deploy ulang.
- Proxy route mengembalikan `Cache-Control: public, max-age=31536000, immutable`.
- Fallback sebelum ada upload: `/assets/auth-hero.png` (artwork statis repo).

## Keamanan

- Kredensial hanya di env server-side; tidak pernah dikirim ke
  browser maupun chat Telegram.
- Menu Redis hanya menampilkan latency, jumlah key, memory, versi —
  tanpa URL/host/token.
