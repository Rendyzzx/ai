/* ============================================================
   Aomi — lib/telegram/format.ts
   Helper format tampilan bot (WIB eksplisit, tidak tergantung
   timezone server).
   ============================================================ */

const MONTHS_ID = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** ISO string → "03 Okt 2026, 14:05 WIB" (Asia/Jakarta, UTC+7). */
export function fmtWIB(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms + 7 * 3600_000); // geser ke WIB, lalu pakai UTC getter
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS_ID[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} WIB`;
}

export function fmtMs(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n} ms`;
}
