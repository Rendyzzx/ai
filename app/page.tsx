import type { Metadata } from "next";
import "../styles/sidebar.css";
import "../styles/chat.css";
import "../styles/settings.css";
import "../styles/music.css";
import ChatGate from "@/components/chat/ChatGate";

/** Chat app butuh login → tidak diindeks search engine.
 *  Meta google-site-verification tetap tampil (dari layout). */
export const metadata: Metadata = {
  title: "Aomi",
  robots: { index: false, follow: false },
};

export default function ChatPage() {
  return <ChatGate />;
}
