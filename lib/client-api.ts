/* ============================================================
   Aomi — lib/client-api.ts
   Helper fetch client: session via header X-Session-Id, 401 →
   teardown state + redirect ke /auth (port dari app.js).
   ============================================================ */

import { getSessionId, clearSessionId, resetClientState } from "./session";

/** Teardown total saat server menolak session. Guard: sekali per page load. */
let tearingDown = false;
export function handleAuthInvalid(): void {
  if (tearingDown) return;
  tearingDown = true;
  clearSessionId();
  resetClientState();
  window.location.replace("/auth");
}

export async function api(path: string, options: RequestInit = {}): Promise<Response> {
  const sid = getSessionId();
  const headers = new Headers(options.headers || {});
  if (sid) headers.set("X-Session-Id", sid);
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    handleAuthInvalid();
    throw new Error("unauthorized");
  }
  return res;
}

export async function apiJson<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await api(path, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data as { error?: string })?.error || "Gagal memuat data");
  return data as T;
}
