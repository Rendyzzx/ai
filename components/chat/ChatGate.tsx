/* ============================================================
   Aomi — components/chat/ChatGate.tsx
   Gerbang tipis untuk route "/" (chat):
   - Pengunjung tanpa session → redirect ke /auth SEBELUM
     bundle chat (±ratusan KB) di-download. Dulu: bundle penuh
     di-download dulu baru redirect → pemborosan besar di
     first-visit (ini salah satu penyebab LCP/payload tinggi).
   - User dengan session → ChatApp di-dynamic-import (code
     splitting; loading state = bg senyap, tanpa layout shift).
   ============================================================ */

"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { getSessionId } from "@/lib/session";

const ChatEntry = dynamic(() => import("@/components/chat/ChatEntry"), {
  ssr: false,
  loading: () => <div className="chat-gate" aria-hidden="true" />,
});

export default function ChatGate() {
  const [hasSession, setHasSession] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!getSessionId()) {
      window.location.replace("/auth");
      return; // tetap render bg senyap sampai replace jalan
    }
    setHasSession(true);
    setChecked(true);
  }, []);

  // checked dipisah supaya state redirect tidak flicker
  if (!checked) return <div className="chat-gate" aria-hidden="true" />;
  return hasSession ? <ChatEntry /> : <div className="chat-gate" aria-hidden="true" />;
}
