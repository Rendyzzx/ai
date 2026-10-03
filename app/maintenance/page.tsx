/* ============================================================
   Aomi — app/maintenance/page.tsx
   "Aomi sedang berhenti sebentar." — bukan "website maintenance".

   Character Aomi adalah visual utama:
   - default: artwork character yang sudah ada (auth-hero.png)
   - custom:  asset yang diupload admin via bot Telegram
     (getAssetInfo — fallback otomatis, tanpa deploy ulang)

   Data (title/message/eta) tetap dinamis dari konfigurasi admin.
   Ringan: server component murni, satu <Image>, CSS kecil inline,
   tanpa client JS, animasi CSS saja (hormat reduced-motion).
   ============================================================ */

import type { Metadata } from "next";
import Image from "next/image";
import { getMaintenanceConfig } from "@/lib/server/maintenance";
import { getAssetInfo } from "@/lib/server/siteassets";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Aomi — Sebentar lagi",
  robots: { index: false, follow: false },
};

export default async function MaintenancePage() {
  const [cfg, character] = await Promise.all([
    getMaintenanceConfig().catch(() => null),
    getAssetInfo("character"),
  ]);
  const title = cfg?.title || "Aomi sedang dirapikan";
  const message =
    cfg?.message || "Kami sedang melakukan beberapa perbaikan. Coba lagi sebentar.";
  const eta = cfg?.eta || "";

  return (
    <main className="mnt">
      <div className="mnt-air" aria-hidden />

      <header className="mnt-top">
        <span className="mnt-brand">Aomi</span>
        <span className="mnt-status">
          <i className="mnt-dot" aria-hidden />
          berhenti sebentar
        </span>
      </header>

      <section className="mnt-body">
        <figure className="mnt-art">
          <Image
            src={character.url}
            alt="Character Aomi"
            width={character.width}
            height={character.height}
            priority
            quality={80}
            sizes="(max-width: 899px) min(64vw, 300px), min(36vw, 460px)"
          />
        </figure>

        <div className="mnt-copy">
          <h1 className="mnt-title">{title}</h1>
          <p className="mnt-msg">{message}</p>
          <p className="mnt-meta">
            {eta ? `Perkiraan selesai ${eta}.` : "Website akan kembali sebentar lagi."}
          </p>
        </div>
      </section>

      <style
        dangerouslySetInnerHTML={{
          __html: `
.mnt {
  min-height: 100svh;
  display: grid;
  grid-template-rows: auto 1fr;
  align-content: stretch;
  position: relative;
  overflow-x: clip;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font, inherit);
  padding:
    max(22px, env(safe-area-inset-top))
    max(clamp(22px, 6vw, 76px), env(safe-area-inset-right))
    max(22px, env(safe-area-inset-bottom))
    max(clamp(22px, 6vw, 76px), env(safe-area-inset-left));
}

/* Cahaya hangat sangat lembut di sisi character — depth saja */
.mnt-air {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(52% 42% at 26% 34%, rgba(198, 154, 96, 0.05), transparent 70%);
}

/* ---------- Brand row ---------- */
.mnt-top {
  position: relative;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  animation: mnt-fade 0.55s ease both;
}
.mnt-brand {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-muted);
}
.mnt-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--muted);
}
.mnt-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  animation: mnt-breathe 3.4s ease-in-out infinite;
}

/* ---------- Komposisi mobile: character dulu, lalu cerita ---------- */
.mnt-body {
  position: relative;
  display: grid;
  align-content: center;
  min-height: 0;
  padding-top: clamp(3vh, 7vh, 9vh);
}
.mnt-art {
  margin: 0 0 clamp(6px, 2vh, 28px) clamp(-14px, -4vw, -6px);
  width: min(64vw, 300px);
  justify-self: start;
  line-height: 0;
  animation: mnt-rise 0.65s cubic-bezier(0.2, 0.6, 0.25, 1) 0.05s both,
             mnt-drift 7s ease-in-out 0.8s infinite;
}
.mnt-art img { width: 100%; height: auto; }

.mnt-copy {
  display: grid;
  gap: 0;
  justify-items: start;
}
.mnt-title {
  margin: 0;
  font-size: clamp(1.5rem, 6vw, 1.9rem);
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: 1.25;
  max-width: 21ch;
  animation: mnt-rise 0.6s cubic-bezier(0.2, 0.6, 0.25, 1) 0.14s both;
}
.mnt-msg {
  margin: clamp(12px, 2.4vh, 20px) 0 0;
  font-size: clamp(0.98rem, 2.8vw, 1.05rem);
  line-height: 1.72;
  color: var(--text-muted);
  max-width: 33ch;
  overflow-wrap: break-word;
  animation: mnt-rise 0.6s cubic-bezier(0.2, 0.6, 0.25, 1) 0.22s both;
}
.mnt-meta {
  margin: clamp(26px, 5vh, 44px) 0 0;
  font-size: 13px;
  color: var(--muted);
  animation: mnt-rise 0.6s cubic-bezier(0.2, 0.6, 0.25, 1) 0.3s both;
}

/* ---------- Desktop: character berdiri di kiri, cerita di kanan ---------- */
@media (min-width: 900px) {
  .mnt-body {
    grid-template-columns: 1.1fr 1fr;
    align-items: end;
    column-gap: clamp(28px, 5vw, 88px);
    padding-top: 0;
  }
  .mnt-art {
    width: min(36vw, 460px);
    /* berdiri menapak lantai halaman, sedikit maju dari grid */
    margin: 0 0 clamp(-8px, -1.2vh, 0px) clamp(-24px, -2vw, -8px);
    animation-name: mnt-rise, mnt-drift;
  }
  .mnt-copy {
    align-content: center;
    padding-bottom: 9vh;
  }
  .mnt-title { max-width: 17ch; font-size: clamp(1.7rem, 2.4vw, 2.05rem); }
  .mnt-msg { max-width: 30ch; }
}

/* ---------- Motion (transform+opacity saja) ---------- */
@keyframes mnt-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes mnt-rise {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes mnt-drift {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}
@keyframes mnt-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .mnt-top, .mnt-art, .mnt-title, .mnt-msg, .mnt-meta, .mnt-dot {
    animation: none;
  }
}
`,
        }}
      />
    </main>
  );
}
