// ============================================================
// app/sitemap.ts — auto-generates /sitemap.xml (Next.js convention)
// Landing (/auth) adalah halaman publik yang diindeks Google.
// Chat app (/) butuh login → tidak masuk sitemap.
// ============================================================

import type { MetadataRoute } from "next";

const SITE = "https://cyronime.web.id";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE}/auth`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
