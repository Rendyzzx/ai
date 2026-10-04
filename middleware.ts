/* ============================================================
   Aomi — middleware.ts
   Redirect user ke /maintenance saat maintenance aktif.
   - Halaman saja (API punya gerbang sendiri di route handler)
   - /maintenance dikecualikan → tidak pernah redirect loop
   - /auth JUGA digerbang (login manual tidak diperlukan — admin
     mengelola lewat bot Telegram, bukan via login saat maintenance)
   - Cek state: Redis REST langsung (env Upstash) atau fallback ke
     /api/maintenance-check. Cache in-memory 5 detik per instance
     (cache — bukan sumber kebenaran; state tetap di storage).
   - Saat cek gagal → fail open (situs tetap jalan).
   Evaluasi jadwal di sini menduplikasi logika kecil dari
   lib/server/maintenance-pure.ts (edge runtime tidak bisa pakai
   store.ts). Bentuk data sama — maintenance-pure.ts sumbernya.
   ============================================================ */

import { NextResponse, type NextRequest } from "next/server";

interface MaintState {
  mode?: string;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
}

let cache: { active: boolean; at: number } | null = null;

function evalActive(state: MaintState, now: number): boolean {
  if (state.mode === "on") return true;
  if (state.mode !== "scheduled") return false;
  const start = state.scheduled_start ? Date.parse(state.scheduled_start) : NaN;
  const end = state.scheduled_end ? Date.parse(state.scheduled_end) : NaN;
  if (!Number.isFinite(start) || now < start) return false;
  if (Number.isFinite(end) && now > end) return false;
  return true;
}

async function maintenanceActive(origin: string): Promise<boolean> {
  if (cache && Date.now() - cache.at < 5000) return cache.active;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500); // cek maintenance tidak boleh menggantungkan halaman

  let active = false;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["GET", "aomi:maintenance/state.json"]),
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (res.ok) {
        const out = (await res.json()) as { result?: string | null };
        let state: MaintState | null = null;
        if (typeof out.result === "string") {
          try {
            state = JSON.parse(out.result) as MaintState;
          } catch {
            state = null;
          }
        } else if (out.result && typeof out.result === "object") {
          state = out.result as MaintState;
        }
        active = state ? evalActive(state, Date.now()) : false;
      }
    } catch {
      active = false;
    }
  } else {
    // Mode fallback GitHub — baca lewat endpoint internal ringan.
    try {
      const res = await fetch(`${origin}/api/maintenance-check`, { cache: "no-store", signal: ctrl.signal });
      if (res.ok) {
        const d = (await res.json()) as { active?: boolean };
        active = d.active === true;
      }
    } catch {
      active = false;
    }
  }

  clearTimeout(timer);
  cache = { active, at: Date.now() };
  return active;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Hanya halaman maintenance sendiri yang tidak pernah diblokir
  // (mencegah redirect loop). /auth TIDAK dikecualikan — bug sebelumnya
  // bikin landing/login tetap kebuka penuh saat maintenance ON.
  if (pathname === "/maintenance") {
    return NextResponse.next();
  }
  // API tidak di-redirect (gerbang 503 ada di route handler masing-masing).
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  try {
    const active = await maintenanceActive(req.nextUrl.origin);
    if (active) {
      const url = req.nextUrl.clone();
      url.pathname = "/maintenance";
      url.search = "";
      return NextResponse.redirect(url);
    }
  } catch {
    // fail open — jangan pernah mematikan situs karena cek maintenance
  }

  // Pengunjung tanpa cookie hint (belum pernah login di browser ini) tidak
  // perlu mengunduh bundle chat ±340KB hanya untuk di-redirect ke /auth oleh
  // ChatGate di sisi client (dulu: redirect baru jalan SETELAH JS parse +
  // hydration → overhead ±2.8s). 302 server-side: bundle "/" tidak pernah
  // dikirim. HINT bukan autentikasi — chat tetap butuh sid valid.
  // (Browser yang blokir document.cookie: /auth punya bounce-guard supaya
  // tidak loop / ↔ /auth.)
  if (pathname === "/" && !req.cookies.get("aomi.has")) {
    return NextResponse.redirect(new URL("/auth", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Semua halaman kecuali aset statis & file publik.
    "/((?!_next/static|_next/image|favicon.ico|icons.svg|assets|robots.txt|sitemap.xml).*)",
  ],
};
