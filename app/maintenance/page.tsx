/* ============================================================
   Aomi — app/maintenance/page.tsx
   Halaman maintenance — RINGAN (tanpa chat bundle), mengikuti
   identitas visual Aomi. Pesan & estimasi dari konfigurasi admin
   (bot Telegram). Tanpa detail teknis apapun.
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
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#111210",
        color: "#E8E5DC",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        padding: "24px",
      }}
    >
      <div
        style={{
          maxWidth: "440px",
          width: "100%",
          background: "#171815",
          borderRadius: "12px",
          padding: "36px 32px",
          textAlign: "center",
        }}
      >
        <div
          aria-hidden
          style={{
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: "#C69A60",
            margin: "0 auto 20px",
          }}
        />
        <h1 style={{ margin: "0 0 12px", fontSize: "22px", fontWeight: 600, letterSpacing: "0.2px" }}>
          {title}
        </h1>
        <p style={{ margin: "0 0 20px", fontSize: "15px", lineHeight: 1.6, color: "#9B9A92" }}>
          {message}
        </p>
        {eta ? (
          <p style={{ margin: 0, fontSize: "13px", color: "#C69A60" }}>
            Perkiraan selesai: {eta}
          </p>
        ) : (
          <p style={{ margin: 0, fontSize: "13px", color: "#9B9A92" }}>
            Website akan kembali sebentar lagi.
          </p>
        )}
      </div>
    </main>
  );
}
