# Telegram Admin Bot — Aomi

Bot Telegram webhook sebagai pusat administrasi Aomi: maintenance,
feature flags, users, database, monitoring, pengumuman, audit —
semua lewat Telegram tanpa membuka dashboard.

## 1. Membuat bot

1. Buka [@BotFather](https://t.me/BotFather) → `/newbot` → ikuti langkah → simpan **token**.
2. Cek Telegram user id kamu (bukan username) lewat [@userinfobot](https://t.me/userinfobot).
3. Set environment variables di Vercel:

   ```
   TELEGRAM_BOT_TOKEN=123456:ABC-...
   TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
   TELEGRAM_ADMIN_IDS=123456789
   ```

   - `TELEGRAM_ADMIN_IDS`: hanya **numeric user id** yang diizinkan.
     Username/nama TIDAK PERNAH dipercaya.
   - Multi-admin: `id:role` dipisah koma — role: `owner`, `admin`,
     `operator`, `viewer` (huruf kecil). Tanpa suffix = owner.

     ```
     TELEGRAM_ADMIN_IDS=123456789:owner,987654321:viewer
     ```

4. Set webhook (sekali setelah deploy):

   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://cyronime.web.id/api/telegram/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```

   Tanpa `secret_token` yang sama dengan env, webhook menolak semua
   request (403).

## 2. Permission

| Role | Bisa |
|---|---|
| OWNER | semua (termasuk revoke sesi, export) |
| ADMIN | operasional + maintenance + user |
| OPERATOR | monitoring + maintenance |
| VIEWER | read-only |

Semua aksi sensitif (maintenance, toggle fitur, suspend, cleanup,
revoke sesi, pengumuman) wajib konfirmasi dua tombol
(Batalkan / Ya). Konfirmasi terikat state sesi — bukan teks yang
bisa dipicu ulang.

## 3. Struktur menu

```
Pengaturan Website (SITE)
├── 🛠 Maintenance            → node MAINT (sudah ada)
├── 🎭 Character             → node CHAR  (upload/hapus/preview)
├── 🖼️ Login Banner          → node BANNER (upload/hapus/preview)
└── 🌐 Tampilan & Limits     → node CFG   (sudah ada)
```

`/start` atau `/menu`:

```
Aomi Admin
Status: 🟢 Website Online

[🖥 Website]      [🛠 Maintenance]
[👥 Users]        [🗄 Database]
[🤖 AI & Tools]   [📊 Monitoring]
[⚙️ Configuration][🔐 Security]
[📢 Announcement] [🧾 Audit Log]
[🔄 Refresh]
```

- **Website** — status, environment, version, storage.
- **Pengaturan Website** — 🛠 Maintenance, 🎭 Character (hero maintenance
  page), 🖼️ Login Banner (artwork hero login), 🌐 Tampilan & limits.
  Upload asset: admin kirim FOTO → validasi magic bytes (JPEG/PNG/WEBP
  saja, maks 5 MB — SVG/GIF/executable ditolak; filename Telegram tidak
  pernah dipercaya) → binary ke repo token (`assets/site/*`) →
  reference di Redis (`aomi:assets/state.json`) → audit log. Asset baru
  langsung aktif tanpa deploy; URL berversi konten-hash sehingga cache
  browser/CDN otomatis diperbarui (bukan cache-busting per render).
- **Maintenance** — on/off (konfirmasi), ubah judul/pesan/estimasi,
  jadwal (WIB, format `YYYY-MM-DD HH:mm-HH:mm`), preview.
- **Users** — cari (email/username/ID), terbaru, statistik,
  suspend/unsuspend (konfirmasi, role admin+).
- **Database** — status, Redis info (latency/memory/keys),
  cleanup state bot (konfirmasi), export JSON (owner), statistik.
- **AI & Tools** — feature flags (chat, music, image-edit, imggen,
  hd, dl, video). Dicek **di server** di route API.
- **Monitoring** — status jujur: hanya yang benar-benar diverifikasi
  (ping storage, probe AI nyata). Tidak ada status palsu.
- **Tampilan & Limits (Configuration)** — nilai penting read-only (limits, version,
  environment). Tidak ada SET ENV mentah.
- **Security** — statistik akses tanpa izin + revoke semua sesi
  (owner, konfirmasi).
- **Announcement** — banner pengumuman di website (bukan broadcast
  Telegram ke user).
- **Audit Log** — 8 aksi admin terakhir.

## 4. Cara kerja (arsitektur)

```
Telegram → POST /api/telegram/webhook
  → verifikasi secret header + rate limit per IP
  → idempotency update_id (TTL 1 jam, aksi tak pernah dobel)
  → authorization numeric id (TELEGRAM_ADMIN_IDS)
  → router state machine (lib/telegram/router.ts)
      → handler menu (lib/telegram/handlers/*)
          → service (lib/server/adminsvc, maintenance, features, audit)
              → storage (lib/server/store → Upstash Redis / fallback GitHub)
```

- Session bot: `aomi:telegram/session/<id>.json` TTL 10 menit
  (node state machine, konfirmasi pending, input menunggu).
- Prinsip: handler tidak pernah akses storage langsung — selalu
  lewat service layer yang sama dengan website (tidak duplikasi
  business logic).

## 5. Maintenance di website

- State: `aomi:maintenance/state.json`
  (`mode`: off/on/scheduled + jadwal ISO).
- Konfigurasi halaman: `aomi:maintenance/config.json`
  (judul, pesan, estimasi).
- **Middleware** (`middleware.ts`) mengarahkan semua halaman ke
  `/maintenance` saat aktif. `/maintenance` dan `/auth` dikecualikan
  (tidak ada redirect loop). Cek state: Redis REST langsung
  (env Upstash) atau fallback fetch `/api/maintenance-check`
  (mode GitHub). Cache 5 detik per instance. Cek gagal → situs
  tetap jalan (fail open); **aksi admin** tetap diverifikasi di
  service (fail closed di titik yang sensitif).
- **Route API privat** (chat, conversations, bot, profile, music,
  hd, dl, vupload) menjawab 503 saat maintenance — gerbang di
  masing-masing route. Webhook Telegram TIDAK digerbang → admin
  selalu bisa mematikan maintenance.
- Jadwal maintenance dievaluasi saat dibaca (tidak ada setTimeout
  permanen — aman untuk serverless). Selesai otomatis di jam
  end tanpa cron.

## 6. Feature flags

`aomi:features/state.json` — satu record JSON terstruktur:

```json
{ "values": { "chat": true, "music": true, "image-edit": true, "imggen": true, "hd": true, "dl": true, "video": true } }
```

Dipaksa **di server**:
- `chat` → `/api/chat` (semua aksi)
- `image-edit` → branch edit foto di `/api/chat`
- `imggen` → branch generate gambar
- `music` → `/api/chat` (trigger lagu) + `/api/music`
- `hd` → branch HD foto/video/link + `/api/hd`
- `dl` → `/api/dl`
- `video` → upload video + AI vision

Menonaktifkan flag = menolak di server dengan pesan ramah — bukan
cuma menyembunyikan tombol.

## 7. Troubleshooting

- **Bot tidak merespon** → cek log Vercel `/api/telegram/webhook`;
  pastikan `secret_token` setWebhook == `TELEGRAM_WEBHOOK_SECRET`.
- **"Akses ditolak"** → id di `TELEGRAM_ADMIN_IDS` belum cocok
  (harus numeric id, bukan username).
- **Webhook 403** → secret header salah. 503 → `TELEGRAM_WEBHOOK_SECRET`
  belum diset di Vercel.
- **Menu beku / "sesi menu kedaluwarsa"** → state sesi TTL 10 menit;
  klik tombol apa pun menyegarkan. `/menu` selalu mulai bersih.
- **Update dobel?** → idempotency via `aomi:telegram/seen/<update_id>.json`
  (TTL 1 jam). Jika storage error saat penandaan, update tetap
  diproses (lebih aman hilang daripada aksi destruktif dobel).
