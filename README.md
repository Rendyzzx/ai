# Aomi — Asisten Chat AI

Aplikasi web chat AI modern (terinspirasi ChatGPT, dengan identitas sendiri),
dioptimalkan untuk Vercel Serverless: ringan, mobile-first, hemat RAM.

## Struktur

```
.
├── index.html            # Markup, tanpa CSS/JS inline
├── vercel.json           # Cache header, security header, durasi function
├── api/
│   └── chat.js           # Serverless function: scraping + fallback AI
├── css/
│   ├── main.css          # Token desain (CSS variables), reset, kerangka
│   ├── sidebar.css       # Riwayat chat (drawer di mobile)
│   └── chat.css          # Area chat + komposer
├── js/
│   ├── app.js            # Bootstrap, utilitas, penyimpanan, event bus
│   ├── sidebar.js        # Riwayat: lazy render, cari, hapus, drawer
│   └── chat.js           # Percakapan: render, kirim, virtualisasi DOM
├── components/
│   └── icons.svg         # Sprite ikon SVG (di-cache, tanpa font ikon)
└── assets/
    └── favicon.svg
```

## Arsitektur

```
Browser → /api/chat (Vercel Serverless) → Provider AI
```

- Frontend TIDAK pernah memanggil provider AI secara langsung (bebas CORS,
  API key tidak pernah sampai ke browser).
- `api/chat.js` mencoba provider berikut (fallback otomatis):
  1. **Gemini** — scraping internal, tanpa API key. Konteks percakapan
     nyambung lewat `sessionId` yang disimpan klien.
  2. **Groq** — jika env `GROQ_API_KEY` di-set.
  3. **ChatEverywhere** — fallback terakhir.
- API key hanya hidup di **Vercel Environment Variables**.

## Deploy

1. Push repo ini ke GitHub, import di Vercel (framework: Other).
2. (Opsional, disarankan) Set `GROQ_API_KEY` di
   Settings → Environment Variables, lalu redeploy.

## Performa & keamanan

- Append-only rendering: pesan baru tidak pernah me-render ulang chat.
- Virtualisasi DOM: maks ±150 node pesan; pesan lama dimuat per 30.
- Sidebar lazy loading per 12 item (IntersectionObserver).
- Event delegation, listener pasif, `requestAnimationFrame`, debounce.
- Tanpa framework, tanpa webfont: hanya HTML/CSS/JS native.
- Rate limiting 15 req/menit/IP (best-effort in-memory per instance).
- Validasi & sanitasi semua input; timeout ketat; batas ukuran respons;
  hostname upstream fixed (cegah SSRF); error generik tanpa info internal.
- Mobile-first: sidebar jadi drawer, `100dvh`,
  `interactive-widget=resizes-content` (input tetap terlihat saat keyboard
  Android muncul), tidak ada horizontal scroll.

## Penyimpanan

- Indeks riwayat dan isi chat disimpan terpisah di `localStorage`
  (membuka aplikasi tidak memuat seluruh histori).
- Maks 200 pesan disimpan per percakapan; chat terlama otomatis
  dibersihkan jika `localStorage` penuh.
