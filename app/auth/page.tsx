import type { Metadata, Viewport } from "next";
import "../../styles/auth.css";
import AuthLanding from "@/components/auth/AuthLanding";
import { getAssetInfo } from "@/lib/server/siteassets";

const SITE = "https://cyronime.web.id";

export const metadata: Metadata = {
  title: "Aomi — Ngobrol. Bikin. Cari tahu.",
  description:
    "Teman ngobrol AI yang siap bantu kapan aja — ngobrol santai, bantu ngoding, edit foto, sampai download video TikTok & Instagram. Gratis, langsung pakai.",
  robots: { index: true, follow: true },
  alternates: { canonical: `${SITE}/auth` },
  openGraph: {
    type: "website",
    url: `${SITE}/auth`,
    siteName: "Aomi",
    locale: "id_ID",
    title: "Aomi — Ngobrol. Bikin. Cari tahu.",
    description:
      "Teman ngobrol AI yang siap bantu kapan aja — ngobrol santai, bantu ngoding, edit foto, sampai download video TikTok & Instagram. Gratis, langsung pakai.",
    images: [
      {
        url: "/assets/og-banner.png",
        width: 1200,
        height: 630,
        alt: "Aomi — asisten chat AI dengan karakter yang siap menemanimu ngobrol",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Aomi — Ngobrol. Bikin. Cari tahu.",
    description:
      "Teman ngobrol AI yang siap bantu kapan aja — ngobrol santai, bantu ngoding, edit foto, sampai download video TikTok & Instagram. Gratis, langsung pakai.",
    images: ["/assets/og-banner.png"],
  },
  icons: { icon: { url: "/assets/favicon.svg", type: "image/svg+xml" } },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#111210",
};

// Tanpa ini, Next.js nge-prerender halaman ini jadi STATIC di build time —
// asset yang diupload admin lewat bot TIDAK PERNAH kebaca ulang (bug: upload
// baru "sukses" tapi gambar di web tidak pernah berubah).
export const dynamic = "force-dynamic";

export default async function AuthPage() {
  // Peekaboo (karakter di atas form login) bisa diganti admin lewat bot
  // Telegram (fallback: artwork default auth-banner-open/closed).
  const peekaboo = await getAssetInfo("loginBanner").catch(() => null);
  return (
    <>
      {/* Font non-blocking: display=swap, FOUT singkat ok */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600&family=IBM+Plex+Sans:wght@400;500&display=swap"
      />
      <AuthLanding peekSrc={peekaboo?.url} />
    </>
  );
}
