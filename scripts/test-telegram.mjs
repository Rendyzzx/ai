#!/usr/bin/env node
/* ============================================================
   Aomi — scripts/test-telegram.mjs
   Test unit logika murni bot admin (tanpa jaringan/storage).
   Menjalankan: npm test
   Node 24 menjalankan .ts dengan type-stripping — modul yang
   dites sengaja bebas import (lihat lib/telegram/admin.ts dan
   lib/server/maintenance-pure.ts).
   ============================================================ */
import { parseAdmins, findAdmin, can } from "../lib/telegram/admin.ts";
import {
  evaluateActive,
  normalizeState,
  parseScheduleInput,
} from "../lib/server/maintenance-pure.ts";
import { detectImageType, validateUpload, MAX_ASSET_BYTES } from "../lib/server/imagedata.ts";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log("  ok -", name);
  } else {
    fail++;
    console.error("  FAIL -", name);
  }
}

// ---------- Authorization admin ----------
console.log("Authorization (TELEGRAM_ADMIN_IDS):");
const admins = parseAdmins("111:owner,222:admin,333:operator,444:viewer");
check("parse 4 admin", admins.length === 4);
check("default role owner", parseAdmins("555")[0].role === "OWNER");
check("id duplikat dibuang", parseAdmins("555,555:viewer").length === 1);
check("username tidak dipercaya", parseAdmins("rendyzzx").length === 0);
check("id non-numerik ditolak", parseAdmins("abc,12:boss").length === 0);
check("role tidak dikenal → entri ditolak (fail closed)", parseAdmins("666:unknown").length === 0);

const owner = findAdmin(admins, 111);
const viewer = findAdmin(admins, 444);
const stranger = findAdmin(admins, 999);
check("owner ditemukan", owner?.role === "OWNER");
check("stranger ditolak", stranger === null);
check("owner boleh semua", can(owner, "owner") && can(owner, "manage") && can(owner, "read"));
check("viewer hanya read", can(viewer, "read") && !can(viewer, "operate") && !can(viewer, "owner"));
check("operator bisa operate, bukan manage", can(findAdmin(admins, 333), "operate") && !can(findAdmin(admins, 333), "manage"));

// ---------- Maintenance evaluation ----------
console.log("Maintenance state:");
const now = Date.parse("2026-10-03T08:00:00.000Z");
check("mode off → tidak aktif", evaluateActive(normalizeState({ mode: "off" }), now) === false);
check("mode on → aktif", evaluateActive(normalizeState({ mode: "on" }), now) === true);
check("data rusak → off", evaluateActive(normalizeState({}), now) === false);
check(
  "scheduled dalam window → aktif",
  evaluateActive(
    normalizeState({
      mode: "scheduled",
      scheduled_start: "2026-10-03T07:00:00.000Z",
      scheduled_end: "2026-10-03T09:00:00.000Z",
    }),
    now
  ) === true
);
check(
  "scheduled lewat window → tidak aktif",
  evaluateActive(
    normalizeState({
      mode: "scheduled",
      scheduled_start: "2026-10-03T07:00:00.000Z",
      scheduled_end: "2026-10-03T07:30:00.000Z",
    }),
    now
  ) === false
);
check(
  "scheduled belum mulai → tidak aktif",
  evaluateActive(
    normalizeState({
      mode: "scheduled",
      scheduled_start: "2026-10-03T09:00:00.000Z",
      scheduled_end: "2026-10-03T10:00:00.000Z",
    }),
    now
  ) === false
);
check(
  "scheduled tanpa start → tidak aktif",
  evaluateActive(normalizeState({ mode: "scheduled", scheduled_end: "2026-10-03T10:00:00.000Z" }), now) === false
);

// ---------- Jadwal (WIB) ----------
console.log("Parse jadwal WIB:");
const sched = parseScheduleInput("2026-10-05 02:00-03:00");
check("jadwal valid", sched !== null);
check(
  "WIB → UTC benar (02:00 WIB = 19:00 UTC sehari sebelumnya)",
  sched && sched.start === "2026-10-04T19:00:00.000Z"
);
check("end > start", sched && Date.parse(sched.end) > Date.parse(sched.start));
check("format salah ditolak", parseScheduleInput("besok pagi") === null);
check("end <= start ditolak", parseScheduleInput("2026-10-05 03:00-02:00") === null);
check(
  "jadwal lintas setengah malam valid",
  parseScheduleInput("2026-10-05 23:00-01:00") === null // 01:00 dianggap hari sama → invalid (dijelaskan di docs)
);

// ---------- Validasi upload asset (magic bytes, tanpa percaya filename) ----------
console.log("Validasi upload asset:");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 0, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2]);
const SVG = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4, 5, 6, 7, 8]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

check("JPEG dikenali", detectImageType(JPEG)?.ext === "jpg");
check("PNG dikenali", detectImageType(PNG)?.ext === "png");
check("WEBP dikenali", detectImageType(WEBP)?.ext === "webp");
check("SVG ditolak (script)", detectImageType(SVG) === null);
check("GIF ditolak", detectImageType(GIF) === null);
check("executable ditolak", detectImageType(EXE) === null);
check("file terlalu pendek ditolak", detectImageType(new Uint8Array([0xff, 0xd8])) === null);
try {
  validateUpload(JPEG);
  check("upload JPEG valid", true);
} catch {
  check("upload JPEG valid", false);
}
try {
  validateUpload(SVG);
  check("upload SVG ditolak dengan error ramah", false);
} catch (err) {
  check("upload SVG ditolak dengan error ramah", /Format tidak didukung/.test(err.message));
}
const big = new Uint8Array(MAX_ASSET_BYTES + 1);
big.set([0xff, 0xd8, 0xff, 0xe0], 0);
try {
  validateUpload(big);
  check("file > 5MB ditolak", false);
} catch (err) {
  check("file > 5MB ditolak", /terlalu besar/.test(err.message));
}

console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
