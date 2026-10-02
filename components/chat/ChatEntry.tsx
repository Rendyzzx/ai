// Wrapper chat penuh — diimpor dinamis oleh ChatGate supaya
// bundle chat tidak ikut first-load pengunjung baru.
import ChatApp from "@/components/chat/ChatApp";
import MusicProvider from "@/components/music/MusicProvider";

export default function ChatEntry() {
  return (
    <MusicProvider>
      <ChatApp />
    </MusicProvider>
  );
}
