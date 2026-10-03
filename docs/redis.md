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

## Keamanan

- Kredensial hanya di env server-side; tidak pernah dikirim ke
  browser maupun chat Telegram.
- Menu Redis hanya menampilkan latency, jumlah key, memory, versi —
  tanpa URL/host/token.
