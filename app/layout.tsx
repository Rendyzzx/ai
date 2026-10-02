import type { Metadata, Viewport } from "next";
import "../styles/main.css";

export const metadata: Metadata = {
  title: "Aomi — Ngobrol Sama Mereka",
  description:
    "Aomi — tempat ngobrol dengan companion pilihanmu. Personal, privat, dan selalu menunggumu.",
  icons: { icon: { url: "/assets/favicon.svg", type: "image/svg+xml" } },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#151413",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
