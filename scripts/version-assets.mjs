// ============================================================
// Aomi — scripts/version-assets.mjs
// Build step (dijalankan Vercel saat deploy):
// 1. Normalisasi: buang stempel ?v= lama dari import specifier js/ (idempoten)
// 2. Hitung content-hash dari semua static asset (css/js/icons/assets)
// 3. Stempel ?v=<hash> pada:
//    a. referensi asset di index.html & auth.html (link/script/use)
//    b. import specifier relatif ANTAR MODUL js/ (from './x.js' / import('./x.js'))
//
// Mengapa (b) WAJIB — akar bug login↔chatbox loop:
// Menstempel <script src="js/app.js?v=…"> saja TIDAK cukup.
// app.js memuat './sidebar.js' → URL /js/sidebar.js (polos) →
// browser berhak memakai cache immutable lama → modul LAMA ikut
// dieksekusi; sidebar.js lama memuat './app.js' (URL polos) →
// app.js LAMA ikut ter-load sebagai instance KEDUA → logika
// redirect versi lama (yang sudah dihapus dari source) tetap
// berjalan → loop bertahan meski semua fix sudah di-deploy.
// Dengan semua URL modul distempel, deploy baru memaksa seluruh
// modul diambil ulang; cache lama tidak pernah terpakai lagi.
// ============================================================

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

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

// Import specifier relatif antar modul js/ (dengan/lama ?v= — opsional group 3)
const JS_FROM_RE = /(from\s+')(\.\/[a-zA-Z0-9._-]+\.js)(\?v=[a-f0-9]+)?(')/g;
const JS_DYN_RE = /(import\(\s*')(\.\/[a-zA-Z0-9._-]+\.js)(\?v=[a-f0-9]+)?(')/g;

function jsFiles() {
  return walk(join(ROOT, 'js')).filter((p) => p.endsWith('.js'));
}

// ---- 1. Normalisasi: kembalikan import specifier ke bentuk polos ----
for (const f of jsFiles()) {
  const src = readFileSync(f, 'utf8');
  const next = src
    .replace(JS_FROM_RE, (m, a, p, _old, z) => `${a}${p}${z}`)
    .replace(JS_DYN_RE, (m, a, p, _old, z) => `${a}${p}${z}`);
  if (next !== src) {
    writeFileSync(f, next);
    console.log(`[version-assets] normalisasi import: ${f}`);
  }
}

// ---- 2. Hash dari seluruh isi asset (urutan stabil, pasca-normalisasi) ----
const files = ASSET_DIRS.flatMap((d) => walk(join(ROOT, d))).sort();
const hasher = createHash('sha256');
for (const f of files) {
  hasher.update(f);
  hasher.update(readFileSync(f));
}
const VERSION = hasher.digest('hex').slice(0, 10);
console.log(`[version-assets] ${files.length} asset, versi: ${VERSION}`);

// ---- 3a. Stempel referensi di HTML: css/main.css → css/main.css?v=VERSION ----
// Perhatikan fragment (#logo): query harus SEBELUM fragment.
const REF_RE = /((?:href|src)=")((?:css|js|components|assets)\/[^"?#]+)([^"]*)(")/g;

let touched = 0;
for (const html of HTML_FILES) {
  let content;
  try { content = readFileSync(join(ROOT, html), 'utf8'); } catch { continue; }
  const next = content.replace(REF_RE, (m, open, path, rest, close) => {
    // Buang stamp LAMA dulu (jika ada) lalu pasang versi baru.
    // Tanpa ini stamp HTML beku di versi pertama selamanya → browser
    // terus memakai JS/CSS lama dari cache immutable → "belum keupdate".
    const tail = rest.replace(/^\?v=[a-f0-9]+/, '');
    return `${open}${path}?v=${VERSION}${tail}${close}`;
  });
  if (next !== content) {
    writeFileSync(join(ROOT, html), next);
    touched++;
    console.log(`[version-assets] ${html} → asset ?v=${VERSION}`);
  }
}

// ---- 3b. Stempel import specifier antar modul js/ ----
for (const f of jsFiles()) {
  const src = readFileSync(f, 'utf8');
  const next = src
    .replace(JS_FROM_RE, (m, a, p, _old, z) => `${a}${p}?v=${VERSION}${z}`)
    .replace(JS_DYN_RE, (m, a, p, _old, z) => `${a}${p}?v=${VERSION}${z}`);
  if (next !== src) {
    writeFileSync(f, next);
    console.log(`[version-assets] stamp import: ${f}`);
  }
}

console.log(`[version-assets] selesai (${touched} file HTML diperbarui)`);
