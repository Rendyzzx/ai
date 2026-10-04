/* ============================================================
   Aomi — lib/session.ts
   Session id OPAQUE, sessionStorage only (port dari app.js).
   Tidak ada credential/password/token/API key di browser.
   ============================================================ */

const SID_KEY = "aomi.sid";

/* Cookie hint NON-SEKRET ("aomi.has=1"): petunjuk untuk middleware bahwa
   browser ini kemungkinan punya session, supaya "/" tidak mengirim seluruh
   bundle chat (±340KB) dulu baru redirect client-side ke /auth (dulu
   menunda redirect ±2.8s di kunjungan pertama). HINT INI BUKAN bukti
   autentikasi — server tetap memvalidasi sid sungguhan per-request;
   middleware hanya mengarahkan pengunjung TANPA hint ke halaman login. */
const HINT_COOKIE = "aomi.has";

function writeHint(present: boolean): void {
  try {
    document.cookie = present
      ? HINT_COOKIE + "=1; path=/; max-age=2592000; samesite=lax"
      : HINT_COOKIE + "=; path=/; max-age=0; samesite=lax";
  } catch {
    /* cookie diblokir → hint gagal senyap, perilaku lama (client redirect) */
  }
}

export function getSessionId(): string | null {
  try {
    return sessionStorage.getItem(SID_KEY);
  } catch {
    return null;
  }
}

export function setSessionId(sid: string): void {
  try {
    sessionStorage.setItem(SID_KEY, sid);
  } catch {
    /* private mode */
  }
  writeHint(true);
}

export function clearSessionId(): void {
  try {
    sessionStorage.removeItem(SID_KEY);
  } catch {
    /* private */
  }
  writeHint(false);
}

/** Bersihkan seluruh cache klien milik aplikasi (prefiks aomi.*). */
export function resetClientState(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("aomi.")) localStorage.removeItem(k);
    }
  } catch {
    /* private mode */
  }
}
