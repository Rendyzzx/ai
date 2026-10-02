import type { Metadata, Viewport } from "next";
import "../../styles/auth.css";
import AuthLanding from "@/components/auth/AuthLanding";

export const metadata: Metadata = {
  title: "Aomi — AI yang siap bantu kapan aja",
  description:
    "Ngobrol dengan AI, edit foto, dan download video TikTok/Instagram dalam satu tempat.",
  robots: { index: false },
  icons: { icon: { url: "/assets/favicon.svg", type: "image/svg+xml" } },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#111210",
};

export default function AuthPage() {
  return (
    <>
      {/* Font non-blocking: display=swap, FOUT singkat ok */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600&family=IBM+Plex+Sans:wght@400;500&family=Newsreader:ital,opsz,wght@1,6..72,400&display=swap"
      />
      <AuthLanding />
    </>
  );
}
