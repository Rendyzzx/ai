import type { Metadata } from "next";
import "../styles/sidebar.css";
import "../styles/chat.css";
import "../styles/settings.css";
import "../styles/music.css";
import ChatApp from "@/components/chat/ChatApp";
import MusicProvider from "@/components/music/MusicProvider";

/** Chat app butuh login → tidak diindeks search engine.
 *  Meta google-site-verification tetap tampil (dari layout). */
export const metadata: Metadata = {
  title: "Aomi",
  robots: { index: false, follow: false },
};

export default function ChatPage() {
  return (
    <MusicProvider>
      <ChatApp />
    </MusicProvider>
  );
}
