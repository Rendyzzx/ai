"use client";

/* ============================================================
   Aomi — components/sidebar/Sidebar.tsx
   Karakter + riwayat percakapan. Lazy render per batch (12) +
   IntersectionObserver, pencarian debounce, hapus via API,
   tombol pemulihan riwayat. Port dari js/sidebar.js.
   ============================================================ */

import { useEffect, useMemo, useRef, useState } from "react";
import { formatTime } from "@/lib/chat-utils";
import type { ConversationItem } from "@/types";

const BATCH = 12;

export default function Sidebar({
  items,
  activeId,
  botName,
  botAvatar,
  userAvatar,
  userLabel,
  open,
  onOpenDrawer,
  onCloseDrawer,
  onNewChat,
  onOpenCharacter,
  onOpenSettings,
  onOpen,
  onDelete,
  onRecover,
}: {
  items: ConversationItem[];
  activeId: string | null;
  botName: string;
  botAvatar: string | null;
  userAvatar: string | null;
  userLabel: string;
  open: boolean;
  onOpenDrawer: () => void;
  onCloseDrawer: () => void;
  onNewChat: () => void;
  onOpenCharacter: () => void;
  onOpenSettings: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRecover: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [rendered, setRendered] = useState(BATCH);
  const [recovering, setRecovering] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLElement>(null);

  // Pencarian debounce 150ms (ringan, tanpa efek visual aneh)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filtered = useMemo(() => {
    if (!query) return items;
    return items.filter((c) => (c.title || "").toLowerCase().includes(query));
  }, [items, query]);

  // Reset jumlah render saat daftar berubah
  useEffect(() => {
    setRendered(BATCH);
  }, [items, query]);

  // IntersectionObserver: render batch berikutnya saat sentinel terlihat
  useEffect(() => {
    const node = sentinelRef.current;
    const root = historyRef.current;
    if (!node || !root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setRendered((r) => Math.min(filtered.length, r + BATCH));
        }
      },
      { root, rootMargin: "200px" }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [filtered.length]);

  // Escape → tutup drawer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCloseDrawer]);

  const visible = filtered.slice(0, rendered);

  return (
    <>
      <aside className={"sidebar" + (open ? " open" : "")} id="sidebar">
        <header className="sidebar-head">
          <div className="brand">
            <svg className="icon brand-icon" aria-hidden="true"><use href="/icons.svg#logo" /></svg>
            <span>{botName}</span>
          </div>
          <button className="icon-btn close-btn" aria-label="Tutup sidebar" onClick={onCloseDrawer}>
            <svg className="icon" aria-hidden="true"><use href="/icons.svg#close" /></svg>
          </button>
        </header>

        <div className="side-label">Karakter</div>

        <div
          className="char-card"
          role="button"
          tabIndex={0}
          aria-label="Buka pengaturan karakter"
          onClick={onOpenCharacter}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onOpenCharacter();
          }}
        >
          <span className="avatar char-card-avatar">
            {botAvatar ? (
              <img src={botAvatar} alt="" aria-hidden="true" decoding="async" />
            ) : (
              <svg className="icon" aria-hidden="true"><use href="/icons.svg#logo" /></svg>
            )}
          </span>
          <div className="char-card-meta">
            <span className="char-card-name">{botName}</span>
          </div>
          <svg className="icon char-card-gear" aria-hidden="true"><use href="/icons.svg#gear" /></svg>
        </div>

        <button className="new-chat" onClick={onNewChat}>
          <svg className="icon" aria-hidden="true"><use href="/icons.svg#plus" /></svg>
          <span>Mulai ngobrol baru</span>
        </button>

        <div className="side-label">Chat terbaru</div>

        <div className="search-box">
          <svg className="icon" aria-hidden="true"><use href="/icons.svg#search" /></svg>
          <input
            type="search"
            placeholder="Cari riwayat…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              const v = e.target.value;
              if (searchTimer.current) clearTimeout(searchTimer.current);
              searchTimer.current = setTimeout(() => setQuery(v.trim().toLowerCase()), 150);
            }}
          />
        </div>

        <nav className="history" aria-label="Chat terbaru" ref={historyRef}>
          {filtered.length === 0 ? (
            <>
              <p className="h-empty">
                {query ? "Tidak ada hasil." : "Belum pernah ngobrol di sini."}
              </p>
              {!query && (
                <button
                  type="button"
                  className="h-recover"
                  disabled={recovering}
                  onClick={async () => {
                    setRecovering(true);
                    try {
                      await onRecover();
                    } finally {
                      setRecovering(false);
                    }
                  }}
                >
                  {recovering ? "Memulihkan..." : "Pulihkan riwayat"}
                </button>
              )}
            </>
          ) : (
            visible.map((conv) => (
              <div
                key={conv.conversation_id}
                className={"h-item" + (activeId === conv.conversation_id ? " active" : "")}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(conv.conversation_id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onOpen(conv.conversation_id);
                }}
              >
                <span className="h-title">{conv.title || "Chat baru"}</span>
                <span className="h-time">{formatTime(conv.updated_at)}</span>
                <button
                  className="h-del"
                  aria-label="Hapus percakapan"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(conv.conversation_id);
                  }}
                >
                  <svg className="icon" aria-hidden="true"><use href="/icons.svg#trash" /></svg>
                </button>
              </div>
            ))
          )}
          <div ref={sentinelRef} data-sentinel="" />
        </nav>

        <footer className="sidebar-foot">
          <button
            className="profile-btn"
            aria-label="Buka pengaturan"
            onClick={onOpenSettings}
          >
            <span className="avatar small">
              {userAvatar ? (
                <img src={userAvatar} alt="" aria-hidden="true" decoding="async" />
              ) : (
                <svg className="icon" aria-hidden="true"><use href="/icons.svg#user" /></svg>
              )}
            </span>
            <span className="user-name">{userLabel || "…"}</span>
            <svg className="icon" aria-hidden="true"><use href="/icons.svg#gear" /></svg>
          </button>
        </footer>
      </aside>
    </>
  );
}
