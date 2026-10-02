"use client";

/* ============================================================
   Aomi — components/auth/AuthLanding.tsx
   Landing + panel Masuk/Daftar. Port dari auth.html + js/auth.js:
   precheck session, tab Masuk/Buat akun, verifikasi angka,
   toggle password, peekaboo, tombol data-goto-register.
   ============================================================ */

import { useCallback, useEffect, useRef, useState } from "react";
import Intro from "@/components/chat/Intro";
import { getSessionId, setSessionId, clearSessionId } from "@/lib/session";

interface CapData {
  number: string;
  token: string;
}

function friendlyError(status: number, data: { error?: string }): string {
  if (status === 400)
    return data?.error?.includes("verifikasi") ? data.error : "Data belum lengkap atau tidak valid.";
  if (status === 401) return "Email/username atau password salah.";
  if (status === 409) return data?.error || "Email atau username sudah dipakai.";
  if (status === 429) return data?.error || "Terlalu banyak percobaan. Tunggu sebentar.";
  return "Tidak dapat masuk sekarang. Coba lagi sebentar.";
}

export default function AuthLanding() {
  const [panel, setPanel] = useState<"login" | "register">("login");
  const [capLogin, setCapLogin] = useState<CapData | null>(null);
  const [capRegister, setCapRegister] = useState<CapData | null>(null);
  const [err, setErr] = useState<{ login: string | null; register: string | null }>({ login: null, register: null });
  const [btnLogin, setBtnLogin] = useState("Masuk");
  const [btnRegister, setBtnRegister] = useState("Buat akun");
  const [busy, setBusy] = useState(false);
  const [peeking, setPeeking] = useState(false);
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
    showPanel("register");
    registerSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const onFieldFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setPeeking(e.target.type === "password");
  };

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
            <a href="#tentang">Tentang</a>
            <a href="#masuk">Masuk</a>
          </nav>
          <button type="button" className="btn-primary btn-sm" onClick={gotoRegister}>
            Mulai dengan Aomi
          </button>
        </div>
      </header>

      <main className="page">
        {/* ================= HERO ================= */}
        <section className="hero">
          <div className="hero-grid">
            <div className="hero-copy">
              <p className="hero-kicker">Asisten pribadi, bukan mesin</p>
              <h1 className="hero-title">Teman berpikir, kapan&nbsp;pun kamu&nbsp;butuh.</h1>
              <p className="hero-sub">
                Aomi membantu kamu berpikir, mencari, dan menyelesaikan sesuatu —
                tanpa membuat semuanya terasa rumit.
              </p>
              <div className="hero-actions">
                <button type="button" className="btn-primary" onClick={gotoRegister}>
                  Mulai menggunakan Aomi
                </button>
                <a className="btn-quiet" href="#preview">
                  Lihat cara kerjanya
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </a>
              </div>
            </div>

            {/* Artwork: crop editorial, desaturasi halus, tepi bawah melebur */}
            <figure className="hero-art" aria-hidden="true">
              <div className="hero-art-frame">
                <img className="hero-art-img" src="/assets/auth-hero.png" alt="" />
              </div>
              <figcaption className="hero-art-caption">Aomi, menunggumu di seberang sini.</figcaption>
            </figure>
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
                <span className="mock-item-title">Ide nama kucing</span>
                <span className="mock-item-time">Minggu</span>
              </div>
              <div className="mock-item">
                <span className="mock-item-title">Belajar bahasa Jepang</span>
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
            <h2>Dibuat untuk cara kamu berpikir.</h2>
            <p>Bukan daftar fitur panjang. Hanya hal-hal yang membuat obrolan terasa enak untuk kembali.</p>
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
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M12 8v4l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </div>
              <h3>Ruang untuk berpikir</h3>
              <p>Tempat tenang untuk memilah pikiran — menulis, bertanya, mencari kata yang tepat, tanpa terasa seperti mengisi formulir.</p>
            </div>
            <div className="feature">
              <div className="feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M5 13c0-4 3-6 7-6s7 2 7 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M4 13h16l-1.5 6h-13L4 13z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>
              </div>
              <h3>Bantuan tanpa mengganggu</h3>
              <p>Aomi menjawab saat diajak dan diam saat tidak. Tidak ada lencana notifikasi yang minta perhatianmu.</p>
            </div>
            <div className="feature">
              <div className="feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M5 5h14M5 10h14M5 15h9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="16.5" cy="18.5" r="1" fill="currentColor"/></svg>
              </div>
              <h3>Semua percakapanmu tetap teratur</h3>
              <p>Riwayat tersimpan rapi per akun. Mudah dicari, mudah dilanjutkan, mudah dilepas saat kamu ingin mulai dari awal.</p>
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
          <h2>Mulai percakapan dengan Aomi.</h2>
          <p>Gratis untuk dimulai. Cerita dan riwayatmu tersimpan aman di akunmu.</p>
          <button type="button" className="btn-primary" onClick={gotoRegister}>
            Buat akun
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
