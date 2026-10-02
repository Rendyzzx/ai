"use client";

/* ============================================================
   Aomi — components/auth/AuthLanding.tsx
   Landing + panel Masuk/Daftar. Redesign v2 (Okt 2026):
   - navbar seimbang + drawer mobile (bug lama: semua item desktop
     dipaksa satu baris di mobile → teks CTA kepotong/tumpang tindih)
   - hero yang langsung menjelaskan kemampuan Aomi, bukan cuma mood
   - artwork Aomi jadi elemen komposisi (crop kecil + kartu chat
     overlap), bukan poster besar di bawah
   - showcase tools yang BENAR-BENAR ada di backend: AI chat
     (personality/memory), edit foto, downloader TikTok & Instagram
   - transparansi teknis: komposisi bahasa dihitung dari repo asli
     (lib/generated/lang-stats.json, dibuat ulang tiap build — lihat
     scripts/compute-lang-stats.mjs), status sistem dari /api/status
     (live, bukan angka karangan)
   Login/register logic TIDAK diubah — port dari auth.html + js/auth.js.
   ============================================================ */

import { useCallback, useEffect, useRef, useState } from "react";
import Intro from "@/components/chat/Intro";
import { getSessionId, setSessionId, clearSessionId } from "@/lib/session";
import langStats from "@/lib/generated/lang-stats.json";

interface CapData {
  number: string;
  token: string;
}

interface StatusPayload {
  status: "operational" | "degraded";
  checked_at: string;
  platform: string;
  runtime: string;
  region: string;
  version: string;
  database: { provider: string; status: "up" | "down"; latency_ms: number };
  ai_provider: { name: string; configured: boolean };
}

function friendlyError(status: number, data: { error?: string }): string {
  if (status === 400)
    return data?.error?.includes("verifikasi") ? data.error : "Data belum lengkap atau tidak valid.";
  if (status === 401) return "Email/username atau password salah.";
  if (status === 409) return data?.error || "Email atau username sudah dipakai.";
  if (status === 429) return data?.error || "Terlalu banyak percobaan. Tunggu sebentar.";
  return "Tidak dapat masuk sekarang. Coba lagi sebentar.";
}

const LANG_DOT_COLORS = ["var(--accent)", "#6f6a56", "#46453d", "var(--border)"];

export default function AuthLanding() {
  const [panel, setPanel] = useState<"login" | "register">("login");
  const [capLogin, setCapLogin] = useState<CapData | null>(null);
  const [capRegister, setCapRegister] = useState<CapData | null>(null);
  const [err, setErr] = useState<{ login: string | null; register: string | null }>({ login: null, register: null });
  const [btnLogin, setBtnLogin] = useState("Masuk");
  const [btnRegister, setBtnRegister] = useState("Buat akun");
  const [busy, setBusy] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [demoTab, setDemoTab] = useState<"chat" | "edit" | "dl">("chat");
  const [status, setStatus] = useState<{ loading: boolean; data: StatusPayload | null; error: boolean }>({
    loading: true,
    data: null,
    error: false,
  });
  const redirectingRef = useRef(false);

  const registerSectionRef = useRef<HTMLElement>(null);
  const registerTabRef = useRef<HTMLButtonElement>(null);

  // ---------------- Session valid di tab ini → langsung buka chat ----------------
  useEffect(() => {
    (async () => {
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

  return (
    <>
      <Intro />

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
            <button type="button" onClick={gotoLogin}>Masuk</button>
            <div className="nav-drawer-cta">
              <button type="button" className="btn-primary" onClick={gotoRegister}>
                Mulai ngobrol dengan Aomi
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
              <p className="hero-kicker">Asisten pribadi, bukan mesin layanan</p>
              <h1 className="hero-title">Ngobrol. Bikin. Cari tahu.</h1>
              <p className="hero-sub">
                Aomi bisa diajak ngobrol soal apa aja, bantu beresin tulisan atau ide,
                edit foto, sampai download video TikTok dan Instagram. Tinggal bilang
                kamu butuh apa.
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
              <div className="hero-tools">
                <span className="hero-tool-pill">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16v11H8l-4 3V6z"/></svg>
                  Ngobrol bebas
                </span>
                <span className="hero-tool-pill">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/><circle cx="12" cy="12" r="3.2"/></svg>
                  Edit foto
                </span>
                <span className="hero-tool-pill">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><use href="/icons.svg#download" /></svg>
                  Download TikTok &amp; IG
                </span>
              </div>
            </div>

            {/* Artwork sebagai komposisi: crop portrait kecil + kartu chat
                mengambang overlap di tepinya — bukan poster penuh. */}
            <div className="hero-visual">
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
        </section>

        {/* ================= PREVIEW PRODUK ================= */}
        <section className="preview" id="preview" aria-label="Tampilan aplikasi Aomi">
          <div className="section-head">
            <h2>Satu ruang, sepenuhnya milikmu.</h2>
            <p>Tidak ada antrean notifikasi. Hanya kamu, Aomi, dan obrolan yang berlanjut dari terakhir kali.</p>
          </div>

          <div className="mock" role="img" aria-label="Pratinjau antarmuka obrolan Aomi">
            <aside className="mock-side">
              <div className="mock-side-label">Riwayat</div>
              <div className="mock-item">
                <span className="mock-item-title">Rencana liburan akhir tahun</span>
                <span className="mock-item-time">Selasa</span>
              </div>
              <div className="mock-item active">
                <span className="mock-item-title">Curhat minggu ini</span>
                <span className="mock-item-time">Hari ini</span>
              </div>
              <div className="mock-item">
                <span className="mock-item-title">Edit foto buat profil</span>
                <span className="mock-item-time">Minggu</span>
              </div>
              <div className="mock-item">
                <span className="mock-item-title">Download reel buat referensi</span>
                <span className="mock-item-time">3 Okt</span>
              </div>
            </aside>
            <div className="mock-main">
              <div className="mock-head">
                <span className="mock-dot" aria-hidden="true"></span>
                <span className="mock-head-name">Aomi</span>
                <span className="mock-head-sub">companion</span>
              </div>
              <div className="mock-chat">
                <div className="mock-msg bot">
                  <p>hey, kamu datang. aku udah nungguin dari tadi tau.</p>
                </div>
                <div className="mock-msg user">
                  <p>baru selesai kerjaan. capek banget hari ini</p>
                </div>
                <div className="mock-msg bot">
                  <p>duduk dulu sana. cerita ke aku pelan-pelan.</p>
                </div>
              </div>
              <div className="mock-input">
                <span>Tulis pesan…</span>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
            </div>
          </div>
        </section>

        {/* ================= FITUR ================= */}
        <section className="features" id="fitur">
          <div className="section-head">
            <p className="eyebrow" style={{ justifyContent: "center" }}>Yang bisa Aomi bantu</p>
            <h2>Bukan cuma obrolan.</h2>
            <p>Empat hal yang paling sering dipakai orang di Aomi.</p>
          </div>

          <div className="feature-grid">
            <div className="feature">
              <div className="feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M4 6h16v11H8l-4 3V6z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M8 10h8M8 13h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </div>
              <h3>Percakapan yang mengingat konteks</h3>
              <p>Aomi menyimpan alur ceritamu. Lanjutkan obrolan lama kapan pun — konteksnya tetap ikut, meski kamu pindah perangkat.</p>
            </div>
            <div className="feature">
              <div className="feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/><circle cx="12" cy="12" r="3.2"/></svg>
              </div>
              <h3>Edit foto, tinggal bilang maunya gimana</h3>
              <p>Upload gambar, kasih instruksi (&ldquo;perjelas&rdquo;, &ldquo;ganti warna&rdquo;, &ldquo;rapikan&rdquo;) — Aomi yang proses, hasilnya bisa langsung diunduh.</p>
            </div>
            <div className="feature">
              <div className="feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><use href="/icons.svg#download" /></svg>
              </div>
              <h3>Download TikTok &amp; Instagram</h3>
              <p>Tempel link video atau foto dari TikTok/Instagram di chat, Aomi ambil versi unduhnya buat kamu — video, audio, atau slide foto.</p>
            </div>
            <div className="feature">
              <div className="feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><use href="/icons.svg#sliders" /></svg>
              </div>
              <h3>Karakternya bisa kamu atur</h3>
              <p>Sifat, gaya bicara, dan hal-hal yang dia ingat tentangmu — semua bisa disetel lewat pengaturan karakter, bukan default yang kaku.</p>
            </div>
          </div>
        </section>

        {/* ================= PRATINJAU INTERAKTIF ================= */}
        <section className="demo" id="tools" aria-label="Pratinjau cara kerja tools Aomi">
          <div className="section-head">
            <p className="eyebrow" style={{ justifyContent: "center" }}>Lebih dari sekadar chatbot</p>
            <h2>Begini kira-kira cara kerjanya.</h2>
            <p>Pratinjau singkat tiga hal yang paling sering dipakai di Aomi.</p>
          </div>

          <div className="demo-tabs" role="tablist" aria-label="Pilih pratinjau tool">
            <button type="button" role="tab" aria-selected={demoTab === "chat"} className={"demo-tab" + (demoTab === "chat" ? " active" : "")} onClick={() => setDemoTab("chat")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16v11H8l-4 3V6z"/></svg>
              Ngobrol
            </button>
            <button type="button" role="tab" aria-selected={demoTab === "edit"} className={"demo-tab" + (demoTab === "edit" ? " active" : "")} onClick={() => setDemoTab("edit")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/><circle cx="12" cy="12" r="3.2"/></svg>
              Edit Foto
            </button>
            <button type="button" role="tab" aria-selected={demoTab === "dl"} className={"demo-tab" + (demoTab === "dl" ? " active" : "")} onClick={() => setDemoTab("dl")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><use href="/icons.svg#download" /></svg>
              Downloader
            </button>
          </div>

          <div className="demo-stage">
            <div className="demo-stage-head">
              <span className="mock-dot" aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)" }}></span>
              Pratinjau — bukan chat sungguhan
            </div>
            <div className="demo-stage-body">
              {demoTab === "chat" && (
                <>
                  <p className="demo-bubble user">lagi overthinking soal kerjaan, bisa nggak sih dibantu urutin pikirannya</p>
                  <p className="demo-bubble bot">bisa. coba ceritain dari yang paling ganggu dulu, kita beresin satu-satu.</p>
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
              <h2>Aomi bisa menyesuaikan cara ngobrolnya.</h2>
              <p>
                Mau yang santai dan jahil, atau tenang dan kalem — tinggal atur
                di pengaturan karakter. Hal-hal kecil yang kamu certain juga coba
                diingat Aomi buat obrolan berikutnya.
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
                    <div className="personal-item-sub">Hal kecil yang kamu certain bisa diingat untuk obrolan selanjutnya.</div>
                  </div>
                </div>
                <div className="personal-item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h7M4 12h16M4 19h10"/></svg>
                  <div>
                    <div className="personal-item-title">Bahasa &amp; formalitas</div>
                    <div className="personal-item-sub">Santai atau sedikit lebih sopan — kamu yang nentuin.</div>
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

        {/* ================= TRANSPARANSI TEKNIS ================= */}
        <section className="tech">
          <div className="tech-grid">
            <div className="tech-copy">
              <p className="eyebrow">Bukan landing page kosong</p>
              <h2>Aomi aplikasi yang beneran jalan.</h2>
              <p>
                Angka di samping ini dihitung langsung dari kode sumber Aomi
                saat website ini di-build — bukan ditulis manual. Kalau
                project-nya berkembang, komposisinya ikut berubah.
              </p>
            </div>
            <div>
              <div className="lang-bar" role="img" aria-label="Komposisi bahasa kode Aomi">
                {langStats.languages.map((l: { name: string; percent: number }, i: number) => (
                  <span
                    key={l.name}
                    className="lang-bar-seg"
                    style={{ width: l.percent + "%", background: LANG_DOT_COLORS[Math.min(i, LANG_DOT_COLORS.length - 1)] }}
                  />
                ))}
                {langOther > 0 && <span className="lang-bar-seg" style={{ width: langOther + "%" }} />}
              </div>
              <div className="lang-legend">
                {langStats.languages.map((l: { name: string; percent: number }, i: number) => (
                  <div className="lang-legend-row" key={l.name}>
                    <span className="lang-legend-dot" style={{ background: LANG_DOT_COLORS[Math.min(i, LANG_DOT_COLORS.length - 1)] }}></span>
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

        {/* ================= TOOLS DIRECTORY ================= */}
        <section className="tools">
          <div className="section-head">
            <h2>Tools yang tersedia sekarang.</h2>
            <p>Tiga kemampuan inti — bakal nambah seiring Aomi berkembang.</p>
          </div>
          <div className="tools-grid">
            <div className="tool-row">
              <div className="tool-row-head">
                <span className="tool-row-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M4 6h16v11H8l-4 3V6z"/></svg>
                </span>
                <div>
                  <div className="tool-row-name">AI Chat</div>
                  <div className="tool-row-cat">Obrolan</div>
                </div>
              </div>
              <p>Ngobrol bebas, tanya sesuatu, atau sekadar cari teman cerita. Konteks obrolan tersimpan per akun.</p>
            </div>
            <div className="tool-row">
              <div className="tool-row-head">
                <span className="tool-row-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>
                </span>
                <div>
                  <div className="tool-row-name">Edit Foto</div>
                  <div className="tool-row-cat">Kreatif</div>
                </div>
              </div>
              <p>Upload gambar dan kasih instruksi — Aomi bantu edit, lalu kirim hasilnya balik untuk diunduh.</p>
            </div>
            <div className="tool-row">
              <div className="tool-row-head">
                <span className="tool-row-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><use href="/icons.svg#download" /></svg>
                </span>
                <div>
                  <div className="tool-row-name">Downloader</div>
                  <div className="tool-row-cat">Utilitas</div>
                </div>
              </div>
              <p>Tempel link TikTok atau Instagram, Aomi ambil versi unduhnya — video, audio, atau foto.</p>
            </div>
          </div>
        </section>

        {/* ================= STATUS SISTEM (real-time) ================= */}
        <section className="status" aria-label="Status sistem Aomi">
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
                  ? "Semua sistem normal"
                  : "Ada gangguan"}
              </span>
              <span className="status-label">
                {status.data ? "Diperbarui " + new Date(status.data.checked_at).toLocaleTimeString("id-ID") : ""}
              </span>
            </div>
            <div className="status-metrics">
              <div>
                <div className="status-metric-label">Database</div>
                <div className={"status-metric-value" + (status.data ? "" : " pending")}>
                  {status.data ? (status.data.database.status === "up" ? "Operational" : "Gangguan") : "—"}
                </div>
              </div>
              <div>
                <div className="status-metric-label">Latensi</div>
                <div className={"status-metric-value" + (status.data ? "" : " pending")}>
                  {status.data ? status.data.database.latency_ms + " ms" : "—"}
                </div>
              </div>
              <div>
                <div className="status-metric-label">Region</div>
                <div className={"status-metric-value" + (status.data ? "" : " pending")}>
                  {status.data?.region || "—"}
                </div>
              </div>
              <div>
                <div className="status-metric-label">Versi</div>
                <div className={"status-metric-value" + (status.data ? "" : " pending")}>
                  {status.data?.version || "—"}
                </div>
              </div>
            </div>
            <div className="status-updated">
              {status.data
                ? `Platform ${status.data.platform} · ${status.data.runtime} · provider AI ${status.data.ai_provider.name} (${status.data.ai_provider.configured ? "terkonfigurasi" : "belum dikonfigurasi"})`
                : status.error
                ? "Tidak bisa menghubungi /api/status sekarang. Coba muat ulang halaman."
                : "Mengambil data langsung dari server…"}
            </div>
          </div>
        </section>

        {/* ================= TENTANG ================= */}
        <section className="about" id="tentang">
          <div className="about-grid">
            <div className="about-copy">
              <p className="about-quote">&ldquo;Aomi bukan alat yang sibuk membuktikan diri.&rdquo;</p>
              <p className="about-text">
                Dia teman yang tenang: mendengarkan dulu, menjawab kemudian.
                Bisa diajak berpikir serius, bisa juga cuma ditemani di akhir hari yang panjang.
                Karakternya bisa kamu atur — dari sapaan, sifat, sampai hal-hal kecil yang dia ingat tentangmu.
              </p>
            </div>
            <figure className="about-art" aria-hidden="true">
              <img src="/assets/auth-banner-open.png" alt="" />
            </figure>
          </div>
        </section>

        {/* ================= CTA PENUTUP ================= */}
        <section className="closing" id="closing">
          <h2>Udah ada yang mau diobrolin?</h2>
          <p>Gratis untuk dimulai. Cerita dan riwayatmu tersimpan aman di akunmu.</p>
          <button type="button" className="btn-primary" onClick={gotoRegister}>
            Mulai ngobrol dengan Aomi
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
          <span className="foot-line">Dibuat pelan-pelan, untuk yang butuh teman berpikir.</span>
          <span className="foot-year">© 2026</span>
        </div>
      </footer>
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
