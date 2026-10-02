"use client";

/* ============================================================
   Aomi — components/auth/AuthLanding.tsx
   Landing + panel Masuk/Daftar. Redesign v3 (Okt 2026, anti-AI-slop):
   - copy Indonesia natural, langsung nunjukin kemampuan — tanpa
     kalimat defensif ("bukan sekadar AI", "lebih dari chatbot", dll)
   - daftar kemampuan gaya editorial (bukan grid kartu seragam)
   - data project JUJUR: komposisi bahasa dihitung otomatis dari repo
     (lib/generated/lang-stats.json, regenerasi tiap build), status
     sistem dari /api/status yang beneran nge-ping database + cek
     live provider AI. Stack teknologi TIDAK ditampilkan di landing.
   - contact Akira: hanya channel yang beneran ada di codebase
     (WhatsApp channel, dipakai footer chat app "Developed by Akira")
   - fitur yang ditulis = fitur yang beneran ada di backend
     (diverifikasi dari app/api/chat/route.ts & app/api/dl/route.ts)
   Login/register logic TIDAK diubah — port dari auth.html + js/auth.js.
   ============================================================ */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import BrandSplash from "@/components/brand/BrandSplash";
import { getSessionId, setSessionId, clearSessionId } from "@/lib/session";
import langStats from "@/lib/generated/lang-stats.json";

interface CapData {
  number: string;
  token: string;
}

interface StatusPayload {
  status: "operational" | "degraded";
  checked_at: string;
  version: string;
  services: { api: string; database: string; ai: string };
  database: { provider: string; latency_ms: number };
}

/** Channel contact Akira — SATU-SATUNYA yang ditemukan di codebase
 *  (footer chat app: "Developed by Akira"). Jangan tambah yang lain. */
const AKIRA_WA = "https://whatsapp.com/channel/0029Vb8AgskLY6dCvnTjxU3c";

function friendlyError(status: number, data: { error?: string }): string {
  if (status === 400)
    return data?.error?.includes("verifikasi") ? data.error : "Data belum lengkap atau tidak valid.";
  if (status === 401) return "Email/username atau password salah.";
  if (status === 409) return data?.error || "Email atau username sudah dipakai.";
  if (status === 429) return data?.error || "Terlalu banyak percobaan. Tunggu sebentar.";
  return "Tidak dapat masuk sekarang. Coba lagi sebentar.";
}

const LANG_COLORS = ["var(--accent)", "#6f6a56", "#46453d", "var(--border)"];

/* Layout effect isomorfik: jalankan SEBELUM paint di client supaya
   section [data-reveal] tidak pernah flash terlihat lalu menghilang. */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const GOOGLE_ERRORS: Record<string, string> = {
  google_cancelled: "Login Google dibatalkan.",
  google_error: "Gagal masuk dengan Google. Coba lagi.",
  google_invalid_callback: "Callback Google tidak valid. Coba lagi.",
  google_state_mismatch: "Verifikasi keamanan Google gagal. Coba lagi.",
  google_token_failed: "Gagal masuk dengan Google. Coba lagi.",
  google_userinfo_failed: "Gagal mengambil data Google. Coba lagi.",
  google_email_not_verified: "Email Google belum terverifikasi.",
  google_user_not_found: "Akun tidak ditemukan. Coba lagi.",
  google_session_failed: "Session gagal dibuat. Coba lagi sebentar.",
};

export default function AuthLanding() {
  const [panel, setPanel] = useState<"login" | "register">("login");
  const [capLogin, setCapLogin] = useState<CapData | null>(null);
  const [capRegister, setCapRegister] = useState<CapData | null>(null);
  const [err, setErr] = useState<{ login: string | null; register: string | null }>({ login: null, register: null });
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [btnLogin, setBtnLogin] = useState("Masuk");
  const [btnRegister, setBtnRegister] = useState("Buat akun");
  const [busy, setBusy] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [demoTab, setDemoTab] = useState<"chat" | "code" | "edit" | "dl">("chat");
  const [status, setStatus] = useState<{ loading: boolean; data: StatusPayload | null; error: boolean }>({
    loading: true,
    data: null,
    error: false,
  });
  const redirectingRef = useRef(false);

  // Hero entry — di-set saat splash selesai (BrandSplash.onDone).
  // Tanpa JS / SSR murni: class tidak pernah ditambah, konten tetap terlihat.
  const [entered, setEntered] = useState(false);
  const parallaxRef = useRef<HTMLDivElement>(null);

  const registerSectionRef = useRef<HTMLElement>(null);
  const registerTabRef = useRef<HTMLButtonElement>(null);

  // ---------------- Google OAuth callback: sid atau error dari query param ----------------

  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const sidParam = params.get("sid");
      const errorParam = params.get("error");

      // Google OAuth sukses → simpan session, redirect ke app
      if (sidParam && /^[a-f0-9]{64}$/.test(sidParam)) {
        setSessionId(sidParam);
        // Bersihkan query param
        window.history.replaceState(null, "", "/auth");
        redirectingRef.current = true;
        window.location.replace("/");
        return;
      }

      // Google OAuth error → tampilkan pesan
      if (errorParam && GOOGLE_ERRORS[errorParam]) {
        setGoogleError(GOOGLE_ERRORS[errorParam]);
        window.history.replaceState(null, "", "/auth");
      }

      // Session valid di tab ini → langsung buka chat
      const sid = getSessionId();
      if (!sid) return; // tanpa sid: halaman login TIDAK pernah redirect
      try {
        const res = await fetch("/api/auth/me", { headers: { "X-Session-Id": sid } });
        if (res.status === 401) {
          clearSessionId(); // session invalid → tetap di login
        } else if (res.ok && !redirectingRef.current) {
          redirectingRef.current = true;
          window.location.replace("/");
        }
      } catch { /* offline: tampilkan halaman login */ }
    })();
  }, []);

  // ---------------- Scroll reveal: IntersectionObserver ----------------
  // Section di bawah fold muncul dengan opacity + translateY kecil —
  // SATU grup per section, bukan tiap card satu-satu (maks stagger 60ms).
  useIsoLayoutEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    els.forEach((el) => el.classList.add("revealable"));
    if (!("IntersectionObserver" in window)) return; // browser tua: langsung terlihat
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("inview");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -48px 0px" }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // ---------------- Mouse parallax desktop: sangat halus ----------------
  // Maksimum pergerakan X ±6px / Y ±4px / rotasi ±0.5deg, dilerp pelan.
  // Hanya transform (GPU). Mobile / reduced-motion / pointer kasar: mati.
  useEffect(() => {
    const el = parallaxRef.current;
    if (!el) return;
    const fine = window.matchMedia("(pointer: fine)").matches;
    const wide = window.matchMedia("(min-width: 901px)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || !wide || reduced) return;

    let raf = 0;
    let tx = 0, ty = 0, cx = 0, cy = 0, wrote = false;
    const onMove = (e: MouseEvent) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1; // -1..1
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      tx = nx * 6; // maks ±6px
      ty = ny * 4; // maks ±4px
      // CATATAN: tanpa rotate — kartu chat berisi text ada di dalam
      // wrapper ini; rotasi kecil pun bikin text terlihat miring.
    };
    const tick = () => {
      const dx = tx - cx, dy = ty - cy;
      if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
        cx += dx * 0.07;
        cy += dy * 0.07;
        el.style.transform =
          "translate3d(" + cx.toFixed(2) + "px," + cy.toFixed(2) + "px,0)";
        wrote = true;
      } else if (wrote) {
        el.style.transform = "translate3d(0,0,0) rotate(0deg)";
        wrote = false;
      }
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  // ---------------- Verifikasi angka ----------------
  const loadCaptcha = useCallback(async (which: "login" | "register") => {
    try {
      const res = await fetch("/api/auth/captcha");
      const data = (await res.json()) as CapData;
      if (which === "login") setCapLogin(data);
      else setCapRegister(data);
    } catch {
      if (which === "login") setCapLogin(null);
      else setCapRegister(null);
    }
  }, []);

  useEffect(() => {
    void loadCaptcha("login");
    void loadCaptcha("register");
  }, [loadCaptcha]);

  // ---------------- Status sistem (real, dari /api/status) ----------------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/status");
        if (!res.ok) throw new Error("status http " + res.status);
        const data = (await res.json()) as StatusPayload;
        if (alive) setStatus({ loading: false, data, error: false });
      } catch {
        if (alive) setStatus({ loading: false, data: null, error: true });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ---------------- Drawer mobile: scroll-lock SEMENTARA selagi terbuka ----------------
  useEffect(() => {
    document.body.classList.toggle("nav-open", navOpen);
    return () => document.body.classList.remove("nav-open");
  }, [navOpen]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const goToApp = () => {
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    window.location.replace("/");
  };

  // ---------------- Submit ----------------
  const submitAuth = async (
    kind: "login" | "register",
    url: string,
    body: Record<string, unknown>
  ) => {
    setErr((e) => ({ ...e, [kind]: null }));
    setBusy(true);
    setBtnLogin(kind === "login" ? "Memproses…" : "Masuk");
    setBtnRegister(kind === "register" ? "Membuat akun…" : "Buat akun");

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.session_id) {
        // Simpan HANYA session id opaque — bukan password/token/API key.
        setSessionId(data.session_id);
        goToApp();
        return;
      }

      setErr((e) => ({ ...e, [kind]: friendlyError(res.status, data) }));
      void loadCaptcha(kind);
    } catch {
      setErr((e) => ({ ...e, [kind]: "Tidak dapat terhubung ke server. Periksa koneksimu." }));
      void loadCaptcha(kind);
    } finally {
      setBusy(false);
      setBtnLogin("Masuk");
      setBtnRegister("Buat akun");
    }
  };

  // ---------------- Render ----------------
  const showPanel = (name: "login" | "register") => {
    setPanel(name);
    setErr({ login: null, register: null });
  };

  const gotoRegister = () => {
    setNavOpen(false);
    showPanel("register");
    registerSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const gotoLogin = () => {
    setNavOpen(false);
    showPanel("login");
    registerSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const onFieldFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setPeeking(e.target.type === "password");
  };

  const langTotalKnown = langStats.languages.reduce((sum: number, l: { percent: number }) => sum + l.percent, 0);
  const langOther = Math.max(0, Math.round((100 - langTotalKnown) * 10) / 10);
  const buildDate = new Date(langStats.generated_at).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <>
      {/* Brand intro sinematik — sekali per tab, hanya untuk pengunjung baru.
          onDone → hero masuk serembut dengan fade-out splash. */}
      <BrandSplash onDone={() => setEntered(true)} />

      <div className={"landing" + (entered ? " entered" : "")}>
      {/* ================= NAVIGASI ================= */}
      <header className="nav" id="top">
        <div className="nav-inner">
          <a className="nav-wordmark" href="#top" aria-label="Aomi — kembali ke atas">
            <svg className="nav-logo" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#logo" /></svg>
            <span>Aomi</span>
          </a>
          <nav className="nav-links" aria-label="Navigasi utama">
            <a href="#fitur">Fitur</a>
            <a href="#tools">Tools</a>
            <a href="#tentang">Tentang</a>
          </nav>
          <div className="nav-right">
            <a className="nav-signin" href="#masuk" onClick={gotoLogin}>Masuk</a>
            <button type="button" className="btn-primary btn-sm" onClick={gotoRegister}>
              Mulai ngobrol
            </button>
          </div>
          <button
            type="button"
            className="nav-burger"
            aria-label={navOpen ? "Tutup menu" : "Buka menu"}
            aria-expanded={navOpen}
            onClick={() => setNavOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              {navOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
            </svg>
          </button>
        </div>

        <div className={"nav-drawer" + (navOpen ? " open" : "")} role="dialog" aria-modal="true" aria-label="Menu navigasi">
          <nav className="nav-drawer-links">
            <a href="#fitur" onClick={() => setNavOpen(false)}>Fitur</a>
            <a href="#tools" onClick={() => setNavOpen(false)}>Tools</a>
            <a href="#tentang" onClick={() => setNavOpen(false)}>Tentang</a>
            <a href={AKIRA_WA} target="_blank" rel="noopener noreferrer">Hubungi Akira</a>
            <button type="button" onClick={gotoLogin}>Masuk</button>
            <div className="nav-drawer-cta">
              <button type="button" className="btn-primary" onClick={gotoRegister}>
                Mulai ngobrol
              </button>
            </div>
          </nav>
        </div>
      </header>

      <main className="page">
        {/* ================= HERO ================= */}
        <section className="hero">
          <div className="hero-grid">
            <div className="hero-copy">
              <h1 className="hero-title">Ngobrol. Bikin. Cari tahu.</h1>
              <p className="hero-sub">
                Mau ngobrol, cari ide, ngoding, edit gambar, atau pakai salah satu tools?
                Tinggal bilang ke Aomi.
              </p>
              <div className="hero-actions">
                <button type="button" className="btn-primary" onClick={gotoRegister}>
                  Mulai ngobrol
                </button>
                <a className="btn-quiet" href="#fitur">
                  Lihat fitur
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </a>
              </div>
            </div>

            {/* Artwork = bagian dari hero, tiga lapis motion ringan:
                entry (CSS animation) -> parallax desktop (transform via rAF)
                -> idle float halus (CSS infinite). Tanpa WebGL, tanpa layout props. */}
            <div className="hero-visual">
              <div className="hero-visual-move" ref={parallaxRef}>
                <div className="hero-visual-idle">
                  <figure className="hero-visual-art" aria-hidden="true">
                    <img src="/assets/auth-hero.png" alt="" />
                  </figure>
                  <div className="hero-chat-card" aria-hidden="true">
                    <div className="hero-chat-card-head">
                      <span className="hero-chat-dot"></span>
                      <span className="hero-chat-card-name">Aomi</span>
                    </div>
                    <p className="hero-chat-bubble user">bantu aku bikin caption buat foto ini</p>
                    <p className="hero-chat-bubble bot">boleh. kirim fotonya, aku liat dulu ya~</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Navigasi fitur ringkas — informasi produk, bukan pill dekoratif.
                Mobile: muncul SETELAH artwork, mengantar ke section fitur. */}
            <nav className="hero-feats" aria-label="Navigasi fitur Aomi">
              <span className="hero-feats-label">Langsung coba:</span>
              <div className="hero-feats-items">
                <a href="#feat-chat">Ngobrol</a>
                <a href="#feat-coding">Coding</a>
                <a href="#feat-edit">Edit foto</a>
                <a href="#feat-tiktok">Download TikTok &amp; Instagram</a>
              </div>
            </nav>
          </div>
        </section>

        {/* ================= YANG BISA KAMU LAKUKAN ================= */}
        <section className="cando" id="fitur" data-reveal>
          <div className="section-head">
            <h2>Yang bisa kamu lakukan di Aomi</h2>
            <p>Enam hal ini bisa langsung kamu pakai sekarang.</p>
          </div>

          {/* Editorial list, hairline per baris — bukan grid kartu */}
          <div className="cando-list">
            <div className="cando-row" id="feat-chat">
              <h3 className="cando-name">AI Chat</h3>
              <p className="cando-desc">
                Ngobrol bebas, tanya apa aja, atau brainstorming bareng. Riwayatnya
                tersimpan di akunmu — bisa dilanjut kapan pun, pindah perangkat juga bisa.
              </p>
            </div>
            <div className="cando-row" id="feat-coding">
              <h3 className="cando-name">Coding</h3>
              <p className="cando-desc">
                Tempel kode yang error, minta dijelasin, atau minta dibikinin function.
                Aomi bantu debug sampai jelas masalahnya di mana.
              </p>
            </div>
            <div className="cando-row" id="feat-edit">
              <h3 className="cando-name">Edit Foto</h3>
              <p className="cando-desc">
                Upload gambar, kasih instruksi — perjelas, ganti warna, rapikan.
                Hasilnya dikirim balik ke chat, tinggal diunduh.
              </p>
            </div>
            <div className="cando-row" id="feat-tiktok">
              <h3 className="cando-name">Downloader TikTok</h3>
              <p className="cando-desc">
                Tempel link video atau foto TikTok di chat. Aomi ambil versi unduhnya,
                audionya sekalian kalau ada.
              </p>
            </div>
            <div className="cando-row">
              <h3 className="cando-name">Downloader Instagram</h3>
              <p className="cando-desc">
                Sama seperti TikTok — khusus video dan foto Instagram.
              </p>
            </div>
            <div className="cando-row">
              <h3 className="cando-name">Karakter &amp; memori</h3>
              <p className="cando-desc">
                Sifat, gaya bicara, bahasa, sampai hal-hal kecil yang Aomi ingat
                tentangmu — semuanya bisa kamu atur sendiri.
              </p>
            </div>
          </div>
        </section>

        {/* ================= PRATINJAU INTERAKTIF ================= */}
        <section className="demo" id="tools" aria-label="Pratinjau cara pakai Aomi" data-reveal>
          <div className="section-head">
            <h2>Begini kira-kira cara pakainya.</h2>
            <p>Pilih salah satu, lihat sendiri cara kerjanya.</p>
          </div>

          <div className="demo-tabs" role="tablist" aria-label="Pilih pratinjau">
            <button type="button" role="tab" aria-selected={demoTab === "chat"} className={"demo-tab" + (demoTab === "chat" ? " active" : "")} onClick={() => setDemoTab("chat")}>
              Ngobrol
            </button>
            <button type="button" role="tab" aria-selected={demoTab === "code"} className={"demo-tab" + (demoTab === "code" ? " active" : "")} onClick={() => setDemoTab("code")}>
              Coding
            </button>
            <button type="button" role="tab" aria-selected={demoTab === "edit"} className={"demo-tab" + (demoTab === "edit" ? " active" : "")} onClick={() => setDemoTab("edit")}>
              Edit Foto
            </button>
            <button type="button" role="tab" aria-selected={demoTab === "dl"} className={"demo-tab" + (demoTab === "dl" ? " active" : "")} onClick={() => setDemoTab("dl")}>
              Downloader
            </button>
          </div>

          <div className="demo-stage">
            <div className="demo-stage-head">
              <span className="demo-dot" aria-hidden="true"></span>
              Pratinjau — bukan chat sungguhan
            </div>
            <div className="demo-stage-body">
              {demoTab === "chat" && (
                <>
                  <p className="demo-bubble user">lagi overthinking soal kerjaan, bisa nggak sih dibantu urutin pikirannya</p>
                  <p className="demo-bubble bot">bisa. coba ceritain dari yang paling ganggu dulu, kita beresin satu-satu.</p>
                </>
              )}
              {demoTab === "code" && (
                <>
                  <p className="demo-bubble user">bantu aku cari bug di kode ini dong</p>
                  <p className="demo-bubble bot">masalahnya di baris terakhir — kamu pakai <code>hasil</code> tapi belum dideklarasi. tambahin dulu di atasnya, harusnya aman.</p>
                </>
              )}
              {demoTab === "edit" && (
                <div className="demo-card">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>
                  <div className="demo-card-title">foto.jpg — &ldquo;perjelas &amp; rapikan warnanya&rdquo;</div>
                  <div className="demo-card-sub">diproses, lalu dikirim balik ke chat buat diunduh</div>
                </div>
              )}
              {demoTab === "dl" && (
                <div className="demo-dl-row">
                  <span className="demo-dl-thumb">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
                  </span>
                  <span className="demo-dl-text">
                    <span className="demo-dl-title">tiktok.com/@...</span>
                    <span className="demo-dl-sub">video + audio siap diunduh</span>
                  </span>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ================= PERSONALISASI ================= */}
        <section className="personal">
          <div className="personal-grid">
            <div className="personal-copy">
              <h2>Ngobrolnya bisa kamu atur.</h2>
              <p>
                Mau yang santai dan jahil, atau tenang dan kalem — tinggal atur di
                pengaturan. Hal-hal kecil yang kamu ceritain juga coba diingat Aomi
                buat obrolan berikutnya.
              </p>
              <div className="personal-list">
                <div className="personal-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><use href="/icons.svg#sliders" /></svg>
                  <div>
                    <div className="personal-item-title">Sifat &amp; gaya bicara</div>
                    <div className="personal-item-sub">Dari tenang sampai jahil, dari singkat sampai ekspresif.</div>
                  </div>
                </div>
                <div className="personal-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2.5"/></svg>
                  <div>
                    <div className="personal-item-title">Memori obrolan</div>
                    <div className="personal-item-sub">Hal kecil yang kamu ceritain bisa diingat untuk obrolan selanjutnya.</div>
                  </div>
                </div>
                <div className="personal-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h7M4 12h16M4 19h10"/></svg>
                  <div>
                    <div className="personal-item-title">Bahasa &amp; panjang jawaban</div>
                    <div className="personal-item-sub">Santai atau sedikit lebih sopan, ringkas atau detail — kamu yang nentuin.</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="personal-panel" aria-hidden="true">
              <div className="personal-row">
                <span className="personal-row-label">Sifat</span>
                <span className="personal-chip">tenang &amp; perhatian</span>
              </div>
              <div className="personal-row">
                <span className="personal-row-label">Gaya bicara</span>
                <span className="personal-chip">santai</span>
              </div>
              <div className="personal-row">
                <span className="personal-row-label">Bahasa</span>
                <span className="personal-chip">Indonesia</span>
              </div>
              <div className="personal-row">
                <span className="personal-row-label">Panjang balasan</span>
                <span className="personal-chip">ringkas</span>
              </div>
            </div>
          </div>
        </section>

        {/* ================= CODING + DATA PROJECT ================= */}
        <section className="coding" data-reveal>
          <div className="coding-grid">
            <div className="coding-copy">
              <h2>Kalau soal coding juga bisa.</h2>
              <p>
                Debug error, jelasin kode, bikin function, atau bantu mulai project.
                Tempel aja kodenya ke chat.
              </p>
              <p className="coding-note">
                Aomi sendiri ditulis dan dikembangkan terus — komposisi bahasanya
                dihitung otomatis dari repository setiap kali website ini di-build,
                jadi angkanya selalu yang terbaru.
              </p>
              <p className="coding-updated">Terakhir di-build: {buildDate}</p>
            </div>
            <div>
              <div className="lang-bar" role="img" aria-label="Komposisi bahasa kode Aomi">
                {langStats.languages.map((l: { name: string; percent: number }, i: number) => (
                  <span
                    key={l.name}
                    className="lang-bar-seg"
                    style={{ width: l.percent + "%", background: LANG_COLORS[Math.min(i, LANG_COLORS.length - 1)] }}
                  />
                ))}
                {langOther > 0 && <span className="lang-bar-seg" style={{ width: langOther + "%" }} />}
              </div>
              <div className="lang-legend">
                {langStats.languages.map((l: { name: string; percent: number }, i: number) => (
                  <div className="lang-legend-row" key={l.name}>
                    <span className="lang-legend-dot" style={{ background: LANG_COLORS[Math.min(i, LANG_COLORS.length - 1)] }}></span>
                    <span className="lang-legend-name">{l.name}</span>
                    <span className="lang-legend-pct">{l.percent}%</span>
                  </div>
                ))}
                {langOther > 0 && (
                  <div className="lang-legend-row">
                    <span className="lang-legend-dot" style={{ background: "var(--border)" }}></span>
                    <span className="lang-legend-name">Lainnya</span>
                    <span className="lang-legend-pct">{langOther}%</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ================= STATUS SISTEM (real-time) ================= */}
        <section className="status" aria-label="Status sistem Aomi" data-reveal>
          <div className="status-panel">
            <div className="status-head">
              <span className="status-title">
                <span
                  className={
                    "status-dot" +
                    (status.loading ? "" : status.error || status.data?.status !== "operational" ? " down" : " up")
                  }
                  aria-hidden="true"
                ></span>
                {status.loading
                  ? "Mengecek status…"
                  : status.error
                  ? "Status tidak dapat diambil"
                  : status.data?.status === "operational"
                  ? "Semua sistem berjalan normal"
                  : "Ada gangguan"}
              </span>
              <span className="status-label">
                {status.data ? "Diperbarui " + new Date(status.data.checked_at).toLocaleTimeString("id-ID") : ""}
              </span>
            </div>
            <div className="status-metrics">
              <div>
                <div className="status-metric-label">API</div>
                <div className={"status-metric-value" + (status.data ? "" : " pending")}>
                  {status.data ? (status.data.services.api === "operational" ? "Online" : "Gangguan") : "—"}
                </div>
              </div>
              <div>
                <div className="status-metric-label">Database</div>
                <div className={"status-metric-value" + (status.data ? "" : " pending")}>
                  {status.data ? (status.data.services.database === "operational" ? "Online" : "Gangguan") : "—"}
                </div>
              </div>
              <div>
                <div className="status-metric-label">AI</div>
                <div className={"status-metric-value" + (status.data ? "" : " pending")}>
                  {status.data ? (status.data.services.ai === "operational" ? "Online" : "Gangguan") : "—"}
                </div>
              </div>
              <div>
                <div className="status-metric-label">Latensi</div>
                <div className={"status-metric-value" + (status.data ? "" : " pending")}>
                  {status.data ? status.data.database.latency_ms + " ms" : "—"}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ================= TENTANG ================= */}
        <section className="about" id="tentang" data-reveal>
          <div className="about-grid">
            <div className="about-copy">
              <h2>Tentang Aomi</h2>
              <p>
                Aomi masih terus dikembangkan. Fitur baru, perbaikan, dan eksperimen
                bakal terus masuk seiring waktu. Kalau ada yang kurang pas, bilang aja.
              </p>
            </div>
            <figure className="about-art" aria-hidden="true">
              <img src="/assets/auth-banner-open.png" alt="" />
            </figure>
          </div>
        </section>

        {/* ================= CONTACT AKIRA ================= */}
        <section className="contact" aria-label="Hubungi Akira" data-reveal>
          <div className="contact-inner">
            <h2>Punya sesuatu buat Aomi?</h2>
            <p>Kalau nemu bug, punya saran, atau mau ngobrol soal Aomi, hubungi Akira.</p>
            <a className="btn-ghost btn-contact" href={AKIRA_WA} target="_blank" rel="noopener noreferrer">
              Hubungi Akira
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </a>
          </div>
        </section>

        {/* ================= CTA PENUTUP ================= */}
        <section className="closing" id="closing" data-reveal>
          <h2>Udah kepikiran mau nanya apa?</h2>
          <p>Gratis buat mulai. Cerita dan riwayatmu tersimpan aman di akunmu.</p>
          <button type="button" className="btn-primary" onClick={gotoRegister}>
            Mulai ngobrol
          </button>
        </section>

        {/* ================= MASUK / DAFTAR ================= */}
        <section className="auth-section" id="masuk" ref={registerSectionRef}>
          <section className="auth-panel">
            {/* Peekaboo: mata terbuka saat isi username/email, nutup saat fokus password */}
            <div className={"peekaboo" + (peeking ? " peeking" : "")} id="peekaboo" aria-hidden="true">
              <img className="peek-img peek-open" src="/assets/auth-banner-open.png" alt="" />
              <img className="peek-img peek-closed" src="/assets/auth-banner-closed.png" alt="" />
            </div>

            <div className="auth-body">
              <header className="auth-head">
                <svg className="icon auth-mobile-logo"><use href="/icons.svg#logo" /></svg>
                <h2 id="authHeading">
                  {panel === "login" ? "Selamat datang kembali" : "Buat akun baru"}
                </h2>
                <p id="authSubtitle">
                  {panel === "login"
                    ? "Masuk untuk melanjutkan percakapanmu."
                    : "Daftar untuk mulai mengobrol dengan Aomi."}
                </p>
              </header>

              <div className="auth-tabs" role="tablist">
                <button
                  className={"auth-tab" + (panel === "login" ? " active" : "")}
                  id="tabLogin"
                  aria-selected={panel === "login"}
                  onClick={() => showPanel("login")}
                >
                  Masuk
                </button>
                <button
                  className={"auth-tab" + (panel === "register" ? " active" : "")}
                  id="tabRegister"
                  ref={registerTabRef}
                  aria-selected={panel === "register"}
                  onClick={() => showPanel("register")}
                >
                  Buat akun
                </button>
              </div>

              {/* ===== GOOGLE OAUTH ===== */}
              <a
                className="google-btn"
                href="/api/auth/google"
                aria-label={panel === "login" ? "Masuk dengan Google" : "Lanjutkan dengan Google"}
              >
                <svg className="google-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
                </svg>
                {panel === "login" ? "Masuk dengan Google" : "Lanjutkan dengan Google"}
              </a>
              <p className="google-error" hidden={!googleError}>{googleError}</p>
              <div className="auth-divider" role="separator" aria-label="atau">atau</div>

              {/* ===== LOGIN ===== */}
              <form
                className="auth-form"
                hidden={panel !== "login"}
                noValidate
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = e.target as HTMLFormElement & {
                    identifier: HTMLInputElement;
                    password: HTMLInputElement;
                    remember: HTMLInputElement;
                  };
                  const ans = document.getElementById("capAnsLogin") as HTMLInputElement | null;
                  await submitAuth("login", "/api/auth/login", {
                    identifier: f.identifier.value.trim(),
                    password: f.password.value,
                    remember: f.remember.checked,
                    captchaToken: capLogin?.token,
                    captchaAnswer: ans?.value.trim() || "",
                  });
                }}
              >
                <label className="auth-field">
                  <span>Email atau username</span>
                  <div className="input-pill">
                    <svg className="icon input-pill-icon" aria-hidden="true"><use href="/icons.svg#mail" /></svg>
                    <input
                      type="text"
                      name="identifier"
                      autoComplete="username"
                      required
                      onFocus={onFieldFocus}
                    />
                  </div>
                </label>

                <label className="auth-field">
                  <span>Password</span>
                  <div className="input-pill">
                    <svg className="icon input-pill-icon" aria-hidden="true"><use href="/icons.svg#key" /></svg>
                    <PasswordInput id="loginPw" name="password" autoComplete="current-password" onFocus={onFieldFocus} />
                  </div>
                </label>

                <label className="auth-check">
                  <input type="checkbox" name="remember" className="auth-check-input" />
                  <span className="auth-check-box" aria-hidden="true">
                    <svg className="icon"><use href="/icons.svg#check" /></svg>
                  </span>
                  <span>Ingat saya selama 30 hari</span>
                </label>

                <div className="verify">
                  <div className="verify-label">Verifikasi manusia</div>
                  <div className="verify-row">
                    <span className="verify-num" id="capNumLogin">{capLogin?.number || "····"}</span>
                    <span className="verify-divider" aria-hidden="true"></span>
                    <input
                      type="text"
                      id="capAnsLogin"
                      inputMode="numeric"
                      maxLength={4}
                      autoComplete="off"
                      placeholder="Ketik angka"
                      aria-label="Ketik angka verifikasi"
                    />
                    <button
                      type="button"
                      className="verify-refresh"
                      aria-label="Angka baru"
                      onClick={() => void loadCaptcha("login")}
                    >
                      <svg className="icon"><use href="/icons.svg#chevron-down" /></svg>
                    </button>
                  </div>
                </div>

                <button className="auth-submit" id="loginSubmit" type="submit" disabled={busy}>
                  {btnLogin}
                </button>
                <p className="auth-error" id="errLogin" hidden={!err.login}>{err.login}</p>
              </form>

              {/* ===== REGISTER ===== */}
              <form
                className="auth-form"
                hidden={panel !== "register"}
                noValidate
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = e.target as HTMLFormElement & {
                    username: HTMLInputElement;
                    email: HTMLInputElement;
                    password: HTMLInputElement;
                  };
                  const pw2 = document.getElementById("regPw2") as HTMLInputElement | null;
                  const ans = document.getElementById("capAnsRegister") as HTMLInputElement | null;
                  setErr((er) => ({ ...er, register: null }));

                  // Validasi frontend untuk UX (backend tetap memvalidasi ulang)
                  if (f.password.value !== pw2?.value) {
                    setErr((er) => ({ ...er, register: "Konfirmasi password tidak sama." }));
                    return;
                  }
                  if (f.password.value.length < 8) {
                    setErr((er) => ({ ...er, register: "Password minimal 8 karakter." }));
                    return;
                  }

                  await submitAuth("register", "/api/auth/register", {
                    username: f.username.value.trim(),
                    email: f.email.value.trim(),
                    password: f.password.value,
                    captchaToken: capRegister?.token,
                    captchaAnswer: ans?.value.trim() || "",
                  });
                }}
              >
                <label className="auth-field">
                  <span>Username</span>
                  <div className="input-pill">
                    <svg className="icon input-pill-icon" aria-hidden="true"><use href="/icons.svg#user" /></svg>
                    <input
                      type="text"
                      name="username"
                      autoComplete="username"
                      maxLength={20}
                      placeholder="3-20 karakter"
                      required
                      onFocus={onFieldFocus}
                    />
                  </div>
                </label>

                <label className="auth-field">
                  <span>Email</span>
                  <div className="input-pill">
                    <svg className="icon input-pill-icon" aria-hidden="true"><use href="/icons.svg#mail" /></svg>
                    <input type="email" name="email" autoComplete="email" required onFocus={onFieldFocus} />
                  </div>
                </label>

                <label className="auth-field">
                  <span>Password</span>
                  <div className="input-pill">
                    <svg className="icon input-pill-icon" aria-hidden="true"><use href="/icons.svg#key" /></svg>
                    <PasswordInput id="regPw" name="password" autoComplete="new-password" placeholder="Minimal 8 karakter" onFocus={onFieldFocus} />
                  </div>
                </label>

                <label className="auth-field">
                  <span>Konfirmasi password</span>
                  <div className="input-pill">
                    <svg className="icon input-pill-icon" aria-hidden="true"><use href="/icons.svg#key" /></svg>
                    <PasswordInput id="regPw2" autoComplete="new-password" onFocus={onFieldFocus} />
                  </div>
                </label>

                <div className="verify">
                  <div className="verify-label">Verifikasi manusia</div>
                  <div className="verify-row">
                    <span className="verify-num" id="capNumRegister">{capRegister?.number || "····"}</span>
                    <span className="verify-divider" aria-hidden="true"></span>
                    <input
                      type="text"
                      id="capAnsRegister"
                      inputMode="numeric"
                      maxLength={4}
                      autoComplete="off"
                      placeholder="Ketik angka"
                      aria-label="Ketik angka verifikasi"
                    />
                    <button
                      type="button"
                      className="verify-refresh"
                      aria-label="Angka baru"
                      onClick={() => void loadCaptcha("register")}
                    >
                      <svg className="icon"><use href="/icons.svg#chevron-down" /></svg>
                    </button>
                  </div>
                </div>

                <button className="auth-submit" id="registerSubmit" type="submit" disabled={busy}>
                  {btnRegister}
                </button>
                <p className="auth-error" id="errRegister" hidden={!err.register}>{err.register}</p>
              </form>

              <p className="auth-note">
                Sesi tersimpan aman di perangkatmu. Riwayat percakapan tersimpan di akunmu.
              </p>
            </div>
          </section>
        </section>
      </main>

      <footer className="foot">
        <div className="foot-inner">
          <span className="foot-mark">Aomi</span>
          <span className="foot-year">© 2026</span>
          <nav className="foot-links" aria-label="Navigasi footer">
            <a href="#fitur">Fitur</a>
            <a href="#tools">Tools</a>
            <a href="#tentang">Tentang</a>
            <a href={AKIRA_WA} target="_blank" rel="noopener noreferrer">Hubungi Akira</a>
          </nav>
        </div>
      </footer>
      </div>
    </>
  );
}

/* ---------------- Toggle show/hide password ---------------- */

function PasswordInput({
  id,
  name,
  autoComplete,
  placeholder,
  onFocus,
}: {
  id: string;
  name?: string;
  autoComplete?: string;
  placeholder?: string;
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <>
      <input
        type={show ? "text" : "password"}
        id={id}
        name={name}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required
        onFocus={onFocus}
      />
      <button
        type="button"
        className="pw-toggle"
        aria-label={show ? "Sembunyikan password" : "Tampilkan password"}
        onClick={() => setShow((s) => !s)}
      >
        <svg className="icon">
          <use href={show ? "/icons.svg#eye-off" : "/icons.svg#eye"} />
        </svg>
      </button>
    </>
  );
}
