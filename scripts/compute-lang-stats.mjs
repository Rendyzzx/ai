#!/usr/bin/env node
/* ============================================================
   Aomi — scripts/compute-lang-stats.mjs
   Hitung komposisi bahasa dari file SUMBER yang benar-benar
   dilacak git (bukan angka manual). Mirip pendekatan GitHub
   Linguist yang disederhanakan: byte per ekstensi, exclude
   node_modules/lock/generated/aset biner. Dijalankan di setiap
   build (lihat package.json → "build") sehingga statistik ikut
   berubah seiring project berkembang.
   Output: lib/generated/lang-stats.json (di-gitignore, hasil build).
   ============================================================ */
import { execSync } from "node:child_process";
import { statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXT_LANG = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".css": "CSS",
};

// Dikeluarkan: lock file, data/konfigurasi non-kode, aset biner,
// dokumentasi — sejalan dengan konvensi Linguist (vendored/documentation/data).
const EXCLUDE_RE =
  /(^|\/)(node_modules|\.next|public|package-lock\.json|next-env\.d\.ts)(\/|$)/;

function listTrackedFiles() {
  const out = execSync("git ls-files", { cwd: root, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function main() {
  const files = listTrackedFiles();
  const bytesByLang = {};
  let totalBytes = 0;

  for (const rel of files) {
    if (EXCLUDE_RE.test(rel)) continue;
    const ext = extname(rel);
    const lang = EXT_LANG[ext];
    if (!lang) continue;
    let size = 0;
    try {
      size = statSync(join(root, rel)).size;
    } catch {
      continue;
    }
    bytesByLang[lang] = (bytesByLang[lang] || 0) + size;
    totalBytes += size;
  }

  const languages = Object.entries(bytesByLang)
    .map(([name, bytes]) => ({
      name,
      bytes,
      percent: totalBytes ? Math.round((bytes / totalBytes) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const payload = {
    generated_at: new Date().toISOString(),
    total_bytes: totalBytes,
    languages,
  };

  const outDir = join(root, "lib", "generated");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "lang-stats.json"), JSON.stringify(payload, null, 2) + "\n");
  console.log(
    "[lang-stats] " +
      languages.map((l) => `${l.name} ${l.percent}%`).join(", ") +
      ` (total ${totalBytes} bytes dari ${files.length - 0} file terlacak)`
  );
}

main();
