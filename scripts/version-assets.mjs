// ============================================================
// Aomi — scripts/version-assets.mjs
// Build step (dijalankan Vercel saat deploy):
// 1. Hitung content-hash dari semua static asset (css/js/icons/assets)
// 2. Stempel ?v=<hash> pada setiap referensi di index.html & auth.html
//
// Efek: deployment baru → referensi asset baru → browser WAJIB
// mengambil file baru (URL berubah). Entry cache lama dengan header
// lama tidak pernah dipakai lagi → tidak ada stale JS/CSS.
// File identik antar deploy → hash sama → cache immutable dipakai
// ulang (tetap cepat).
// ============================================================

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const ASSET_DIRS = ['css', 'js', 'components', 'assets'];
const HTML_FILES = ['index.html', 'auth.html'];

function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// 1. Hash dari seluruh isi asset (urutan stabil)
const files = ASSET_DIRS.flatMap((d) => walk(join(ROOT, d))).sort();
const hasher = createHash('sha256');
for (const f of files) {
  hasher.update(f);
  hasher.update(readFileSync(f));
}
const VERSION = hasher.digest('hex').slice(0, 10);
console.log(`[version-assets] ${files.length} asset, versi: ${VERSION}`);

// 2. Stempel referensi di HTML: css/main.css → css/main.css?v=VERSION
// Perhatikan fragment (#logo): query harus SEBELUM fragment.
const REF_RE = /((?:href|src)=")((?:css|js|components|assets)\/[^"?#]+)([^"]*)(")/g;

let touched = 0;
for (const html of HTML_FILES) {
  let content;
  try { content = readFileSync(join(ROOT, html), 'utf8'); } catch { continue; }
  const next = content.replace(REF_RE, (m, open, path, rest, close) => {
    if (rest.startsWith('?v=')) return m; // idempotent
    return `${open}${path}?v=${VERSION}${rest}${close}`;
  });
  if (next !== content) {
    writeFileSync(join(ROOT, html), next);
    touched++;
    console.log(`[version-assets] ${html} → asset ?v=${VERSION}`);
  }
}
console.log(`[version-assets] selesai (${touched} file HTML diperbarui)`);
