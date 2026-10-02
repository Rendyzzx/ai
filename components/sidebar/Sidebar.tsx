"use client";

/* ============================================================
   Aomi — components/sidebar/Sidebar.tsx
   Laci percakapan pribadi — bukan panel kontrol AI.
   Fungsi dipertahankan: chat baru, cari, pilih/hapus percakapan,
   buka pengaturan Aomi/akun, logout, pemulihan riwayat.
   Lazy render per batch (12) + IntersectionObserver, pencarian
   debounce. Port struktur dari js/sidebar.js, visual dirombak.
   ============================================================ */

import { useEffect, useMemo, useRef, useState } from "react";
import { formatTime } from "@/lib/chat-utils";
import type { ConversationItem } from "@/types";

const BATCH = 12;

/** Satu percakapan dikelompokkan di bawah label waktu (formatTime). */
interface Group {
  label: string;
  items: ConversationItem[];
}

function groupByTime(list: ConversationItem[]): Group[] {
  const groups: Group[] = [];
  for (const conv of list) {
    const label = formatTime(conv.updated_at) || "Lainnya";
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(conv);
    else groups.push({ label, items: [conv] });
  }
  return groups;
}

export default function Sidebar({
  items,
  hasMore,
  onLoadMore,
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
  onLogout,
  onOpen,
  onDelete,
  onRecover,
}: {
  items: ConversationItem[];
  hasMore?: boolean;
  onLoadMore?: () => void;
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
  onOpenSettings: (category: "profile" | "account") => void;
  onLogout: () => void | Promise<void>;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRecover: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [rendered, setRendered] = useState(BATCH);
  const [recovering, setRecovering] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Escape → tutup drawer / menu profil
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menuOpen) setMenuOpen(false);
      else onCloseDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCloseDrawer, menuOpen]);

  // Klik di luar menu profil → tutup
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const visible = filtered.slice(0, rendered);
  const groups = useMemo(() => groupByTime(visible), [visible]);

  return (
    <>
      <aside className={"sidebar" + (open ? " open" : "")} id="sidebar">
        <header className="sb-head">
          <span className="sb-head-title">{botName}</span>
          <button className="icon-btn sb-close" aria-label="Tutup sidebar" onClick={onCloseDrawer}>
            <svg className="icon" aria-hidden="true"><use href="/icons.svg#close" /></svg>
          </button>
        </header>

        {/* Identitas Aomi — satu baris tenang, bukan kartu */}
        <button type="button" className="sb-identity" onClick={onOpenCharacter}>
          <span className="avatar sb-identity-avatar">
            {botAvatar ? (
              <img src={botAvatar} alt="" aria-hidden="true" decoding="async" />
            ) : (
              <svg className="icon" aria-hidden="true"><use href="/icons.svg#logo" /></svg>
            )}
          </span>
          <span className="sb-identity-name">{botName}</span>
        </button>

        <button type="button" className="sb-newchat" onClick={onNewChat}>
          <svg className="icon" aria-hidden="true"><use href="/icons.svg#plus" /></svg>
          <span>Chat baru</span>
        </button>

        <div className="sb-search">
          <svg className="icon" aria-hidden="true"><use href="/icons.svg#search" /></svg>
          <input
            type="search"
            placeholder="Cari percakapan..."
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              const v = e.target.value;
              if (searchTimer.current) clearTimeout(searchTimer.current);
              searchTimer.current = setTimeout(() => setQuery(v.trim().toLowerCase()), 150);
            }}
          />
        </div>

        <nav className="sb-history" aria-label="Percakapan" ref={historyRef}>
          {filtered.length === 0 ? (
            <>
              <p className="sb-empty">
                {query ? "Tidak ada hasil." : "Belum pernah ngobrol di sini."}
              </p>
              {!query && (
                <button
                  type="button"
                  className="sb-recover"
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
            <>
              {groups.map((group) => (
              <div className="sb-group" key={group.label + group.items[0].conversation_id}>
                <div className="sb-group-label">{group.label}</div>
                {group.items.map((conv) => (
                  <div
                    key={conv.conversation_id}
                    className={"sb-item" + (activeId === conv.conversation_id ? " active" : "")}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(conv.conversation_id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onOpen(conv.conversation_id);
                    }}
                  >
                    <span className="sb-item-title">{conv.title || "Chat baru"}</span>
                    <button
                      className="sb-item-del"
                      aria-label="Hapus percakapan"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(conv.conversation_id);
                      }}
                    >
                      <svg className="icon" aria-hidden="true"><use href="/icons.svg#trash" /></svg>
                    </button>
                  </div>
                ))}
              </div>
              ))}
              {hasMore && onLoadMore && (
                <button
                  type="button"
                  className="sb-loadmore"
                  onClick={onLoadMore}
                >
                  Muat yang lebih lama
                </button>
              )}
            </>
          )}
          <div ref={sentinelRef} data-sentinel="" />
        </nav>

        <footer className="sb-foot" ref={menuRef}>
          {menuOpen && (
            <div className="sb-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSettings("profile");
                }}
              >
                Pengaturan
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSettings("account");
                }}
              >
                Akun
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  setMenuOpen(false);
                  void onLogout();
                }}
              >
                Keluar
              </button>
            </div>
          )}
          <div className="sb-profile">
            <button type="button" className="sb-profile-main" onClick={() => onOpenSettings("profile")}>
              <span className="avatar small">
                {userAvatar ? (
                  <img src={userAvatar} alt="" aria-hidden="true" decoding="async" />
                ) : (
                  <svg className="icon" aria-hidden="true"><use href="/icons.svg#user" /></svg>
                )}
              </span>
              <span className="sb-profile-name">{userLabel || "…"}</span>
            </button>
            <button
              type="button"
              className="sb-profile-menu-btn"
              aria-label="Menu akun"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <svg className="icon" aria-hidden="true"><use href="/icons.svg#more" /></svg>
            </button>
          </div>
        </footer>
      </aside>
    </>
  );
}
