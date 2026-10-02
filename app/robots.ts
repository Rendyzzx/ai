// ============================================================
// app/robots.ts — auto-generates /robots.txt (Next.js convention)
// Izinkan crawl landing; API tidak perlu diindeks.
// ============================================================

import type { MetadataRoute } from "next";

const SITE = "https://cyronime.web.id";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/"],
    },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
