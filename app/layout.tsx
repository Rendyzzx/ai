import type { Metadata, Viewport } from "next";
import "../styles/main.css";

const SITE = "https://cyronime.web.id";

/** Verifikasi Google Search Console — dari env (bukan hardcode). */
const googleVerification = process.env.GOOGLE_SITE_VERIFICATION || "";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "Aomi — AI yang siap bantu kapan aja",
  description:
    "Aomi — teman ngobrol AI yang personal: ngobrol santai, bantu ngoding, edit foto, sampai download video TikTok & Instagram. Gratis, langsung pakai.",
  icons: { icon: { url: "/assets/favicon.svg", type: "image/svg+xml" } },
  ...(googleVerification
    ? { verification: { google: googleVerification } }
    : {}),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#111210",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
