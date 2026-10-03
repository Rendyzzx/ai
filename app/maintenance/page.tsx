/* ============================================================
   Aomi — app/maintenance/page.tsx
   Halaman maintenance. DESAIN: komposisi editorial full-viewport —
   tanpa card di tengah. Visual = brand mark Aomi yang sudah ada
   (speech bubble, svg inline 262 byte — bukan gambar baru).
   Data tetap dinamis dari konfigurasi admin (getMaintenanceConfig,
   diatur lewat bot Telegram) — halaman ini murni presentasi.

   Palet lewat CSS variables Aomi (styles/main.css) supaya persis
   sama dengan app dan ikut tema user. Motion: CSS only, ringan,
   hormat prefers-reduced-motion.
   ============================================================ */

import type { Metadata } from "next";
import { getMaintenanceConfig } from "@/lib/server/maintenance";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Aomi — Sebentar lagi",
  robots: { index: false, follow: false },
};

export default async function MaintenancePage() {
  const cfg = await getMaintenanceConfig().catch(() => null);
  const title = cfg?.title || "Aomi sedang dirapikan";
  const message =
    cfg?.message || "Kami sedang melakukan beberapa perbaikan. Coba lagi sebentar.";
  const eta = cfg?.eta || "";

  return (
    <main className="mn">
      {/* Atmosphere: cahaya hangat sangat lembut + garis editorial hairline */}
      <span className="mn-glow" aria-hidden />

      {/* Header — brand kiri, status meta kanan, satu hairline */}
      <header className="mn-head">
        <span className="mn-brand">Aomi</span>
        <span className="mn-status">
          <i className="mn-dot" aria-hidden />
          Maintenance
        </span>
      </header>

      {/* Komposisi utama: visual kiri (asimetris) + konten kanan di desktop;
          mobile menumpuk dengan ritme vertikal editorial, bukan center mentah */}
      <section className="mn-main">
        <div className="mn-visual" aria-hidden>
          <svg
            className="mn-mark"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3 20l1.1-5.3A8.5 8.5 0 1 1 21 11.5z" />
            <circle cx="9" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
            <circle cx="13" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
            <circle cx="17" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
          </svg>
        </div>

        <div className="mn-copy">
          <p className="mn-overline">
            <span className="mn-rule" aria-hidden />
            Tidak lama lagi
          </p>

          <h1 className="mn-title">{title}</h1>

          <p className="mn-message">{message}</p>

          <p className="mn-meta">
            {eta ? `Perkiraan selesai — ${eta}` : "Website akan kembali sebentar lagi."}
          </p>
        </div>
      </section>

      {/* Footer — echo brand, sangat kecil, hairline pemisah */}
      <footer className="mn-foot">
        <span>Aomi</span>
        <span className="mn-foot-dim">cyronime.web.id</span>
      </footer>

      <style
        dangerouslySetInnerHTML={{
          __html: `
.mn {
  min-height: 100svh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  position: relative;
  overflow-x: clip;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font, inherit);
  padding:
    max(18px, env(safe-area-inset-top))
    max(clamp(20px, 6vw, 72px), env(safe-area-inset-right))
    max(18px, env(safe-area-inset-bottom))
    max(clamp(20px, 6vw, 72px), env(safe-area-inset-left));
}

/* Cahaya hangat satu arah, opacity sangat rendah — hanya memberi depth */
.mn-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(70% 45% at 14% 8%, rgba(198, 154, 96, 0.055), transparent 62%);
}

/* ---------- Header ---------- */
.mn-head {
  position: relative;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: 14px;
  border-bottom: 1px solid rgba(232, 229, 220, 0.08);
  animation: mn-fade 0.5s ease both;
}
.mn-brand {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.mn-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--muted);
}
.mn-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  animation: mn-breathe 3.2s ease-in-out infinite;
}

/* ---------- Komposisi ---------- */
.mn-main {
  position: relative;
  display: grid;
  align-content: center;
  padding-top: clamp(4vh, 10vh, 12vh);
  min-height: 0;
}

.mn-visual {
  margin-bottom: clamp(28px, 6vh, 64px);
}
.mn-mark {
  display: block;
  width: clamp(104px, 26vw, 148px);
  height: auto;
  color: var(--accent);
  opacity: 0.5;
  animation: mn-rise 0.6s cubic-bezier(0.2, 0.6, 0.25, 1) both, mn-drift 7.5s ease-in-out 0.6s infinite;
}

/* ---------- Konten ---------- */
.mn-overline {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--muted);
  animation: mn-rise 0.6s cubic-bezier(0.2, 0.6, 0.25, 1) 0.08s both;
}
.mn-rule {
  width: 18px;
  height: 1px;
  background: var(--accent);
  opacity: 0.8;
}
.mn-title {
  margin: 14px 0 0;
  font-size: clamp(1.45rem, 4.6vw, 1.9rem);
  font-weight: 500;
  letter-spacing: 0.01em;
  line-height: 1.28;
  max-width: 24ch;
  animation: mn-rise 0.6s cubic-bezier(0.2, 0.6, 0.25, 1) 0.16s both;
}
.mn-message {
  margin: 18px 0 0;
  font-size: clamp(0.95rem, 2.6vw, 1.02rem);
  line-height: 1.75;
  color: var(--text-muted);
  max-width: 34ch;
  overflow-wrap: break-word;
  animation: mn-rise 0.6s cubic-bezier(0.2, 0.6, 0.25, 1) 0.24s both;
}
.mn-meta {
  margin: clamp(28px, 6vh, 48px) 0 0;
  padding-top: 14px;
  border-top: 1px solid rgba(232, 229, 220, 0.08);
  font-size: 12.5px;
  letter-spacing: 0.02em;
  color: var(--muted);
  max-width: 34ch;
  animation: mn-rise 0.6s cubic-bezier(0.2, 0.6, 0.25, 1) 0.32s both;
}

/* ---------- Footer ---------- */
.mn-foot {
  position: relative;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding-top: 14px;
  border-top: 1px solid rgba(232, 229, 220, 0.08);
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  animation: mn-fade 0.6s ease 0.4s both;
}
.mn-foot-dim { opacity: 0.65; }

/* ---------- Desktop: komposisi asimetris dua kolom ---------- */
@media (min-width: 900px) {
  .mn-main {
    grid-template-columns: 1.05fr 1fr;
    align-items: center;
    column-gap: clamp(32px, 5vw, 96px);
    padding-top: 0;
  }
  .mn-visual {
    margin-bottom: 0;
    align-self: stretch;
    display: flex;
    align-items: center;
  }
  /* Mark besar, opacity rendah, sedikit keluar dari grid ke kiri */
  .mn-mark {
    width: clamp(240px, 30vw, 360px);
    opacity: 0.22;
    margin-left: calc(clamp(240px, 30vw, 360px) * -0.06);
  }
  .mn-title { max-width: 20ch; }
}

/* ---------- Motion ---------- */
@keyframes mn-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes mn-rise {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes mn-drift {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-5px); }
}
@keyframes mn-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .mn-head, .mn-mark, .mn-overline, .mn-title, .mn-message, .mn-meta, .mn-foot, .mn-dot {
    animation: none;
  }
}
`,
        }}
      />
    </main>
  );
}
