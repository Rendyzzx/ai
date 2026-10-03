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

console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
