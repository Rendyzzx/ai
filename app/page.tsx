import type { Metadata } from "next";
import "../styles/sidebar.css";
import "../styles/chat.css";
import "../styles/settings.css";
import "../styles/music.css";
import ChatGate from "@/components/chat/ChatGate";
import { getAnnouncement } from "@/lib/server/announce";

/** Chat app butuh login → tidak diindeks search engine.
 *  Meta google-site-verification tetap tampil (dari layout). */
export const metadata: Metadata = {
  title: "Aomi",
  robots: { index: false, follow: false },
};

/** ISR 30 detik — banner pengumuman (dikelola admin lewat bot Telegram)
 *  ikut segar tanpa membuat halaman jadi full-dynamic per request. */
export const revalidate = 30;

/** Banner pengumuman (diatur admin lewat bot Telegram) — dibaca
 *  server-side, cache pendek di service, tanpa bundle ekstra. */
export default async function ChatPage() {
  const ann = await getAnnouncement().catch(() => null);
  const showBanner = Boolean(ann?.enabled && ann.message);
  return (
    <>
      {showBanner ? (
        <div
          role="status"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 40,
            background: "#171815",
            borderBottom: "1px solid rgba(198,154,96,0.35)",
            color: "#E8E5DC",
            fontSize: "13px",
            lineHeight: 1.5,
            padding: "8px 16px",
            textAlign: "center",
          }}
        >
          <strong style={{ color: "#C69A60", fontWeight: 600 }}>{ann!.title}</strong>
          {" — "}
          {ann!.message}
        </div>
      ) : null}
      <ChatGate />
    </>
  );
}
