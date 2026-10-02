import type { NextConfig } from "next";

/**
 * Aomi — Next.js config
 * Header keamanan/cache dipindah dari vercel.json lama;
 * redirect kompatibilitas untuk URL /auth.html lama.
 */
const nextConfig: NextConfig = {
  async redirects() {
    return [
      // URL lama (plain HTML) → route Next
      { source: "/auth.html", destination: "/auth", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        // Artwork & aset visual — nama file stabil, jarang berubah.
        // 30 hari: repeat visit tidak download ulang ±967KB aset.
        source: "/assets/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=2592000, stale-while-revalidate=86400" },
        ],
      },
      {
        source: "/icons.svg",
        headers: [
          { key: "Cache-Control", value: "public, max-age=2592000, stale-while-revalidate=86400" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Vary", value: "X-Session-Id" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          {
            key: "X-DNS-Prefetch-Control",
            value: "off",
          },
          // CSP moderat: inline script diperlukan (Next hydration + script
          // anti-flash tema di layout) — jangan dibuat lebih ketat dari ini
          // tanpa test menyeluruh. Resource eksternal dibatasi per-tipe:
          // gambar/audio dari CDN (thumbnail, proxy unduhan), fetch hanya
          // same-origin + API eksternal TIDAK pernah dari browser.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "media-src 'self' blob: https:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
