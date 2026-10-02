/* ============================================================
   Aomi — lib/session.ts
   Session id OPAQUE, sessionStorage only (port dari app.js).
   Tidak ada credential/password/token/API key di browser.
   ============================================================ */

const SID_KEY = "aomi.sid";

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
}

export function clearSessionId(): void {
  try {
    sessionStorage.removeItem(SID_KEY);
  } catch {
    /* private */
  }
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
