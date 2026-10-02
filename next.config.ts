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
        ],
      },
    ];
  },
};

export default nextConfig;
