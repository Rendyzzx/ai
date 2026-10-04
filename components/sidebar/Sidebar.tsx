"use client";

/* ============================================================
   Aomi — components/sidebar/Sidebar.tsx
   Laci percakapan pribadi — bukan panel kontrol AI.
   Fungsi: chat baru, cari (judul lokal + isi via server, debounce),
   pilih/pin/arsip/hapus percakapan, Simpanan (bookmark), buka
   pengaturan, logout, pemulihan riwayat, lazy render per batch.
   Port struktur dari js/sidebar.js, visual dirombak.
   ============================================================ */

import { useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "@/lib/client-api";
import { formatTime } from "@/lib/chat-utils";
import type { ConversationItem, SearchItem } from "@/types";

const BATCH = 12;

/** Satu percakapan dikelompokkan di bawah label waktu (formatTime). */
interface Group {
  label: string;
  items: (ConversationItem & { snippet?: string })[];
}

function groupByTime(list: (ConversationItem & { snippet?: string })[]): Group[] {
  const groups: Group[] = [];
  for (const conv of list) {
    const label = conv.pinned ? "" : formatTime(conv.updated_at) || "Lainnya";
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
  onOpenSaved,
  onLogout,
  onOpen,
  onDelete,
  onRename,
  onPin,
  onArchive,
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
  onOpenSaved: () => void;
  onLogout: () => void | Promise<void>;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, value: boolean) => void;
  onArchive: (id: string, value: boolean) => void;
  onRecover: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [rendered, setRendered] = useState(BATCH);
  const [recovering, setRecovering] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [viewArchived, setViewArchived] = useState(false);
  // Hasil pencarian server (isi percakapan); null = tidak sedang mencari via server
  const [serverResults, setServerResults] = useState<SearchItem[] | null>(null);
  // Menu ⋯ per item percakapan — posisi FIXED (di luar <aside>) supaya
  // tidak terpotong overflow-y milik .sb-history / drawer transform.
  const [itemMenu, setItemMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // Rename inline (input di tempat judul)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemMenuRef = useRef<HTMLDivElement>(null);

  // Pencarian debounce 150ms lokal; query >= 2 karakter → cari juga ke server
  // (judul + ISI percakapan) dengan debounce 300ms terpisah.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (serverTimer.current) clearTimeout(serverTimer.current);
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  // Query berubah → jadwalkan pencarian server (q >= 2)
  useEffect(() => {
    if (serverTimer.current) clearTimeout(serverTimer.current);
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      setServerResults(null);
      return;
    }
    serverTimer.current = setTimeout(async () => {
      try {
        const data = await apiJson<{ items: SearchItem[] }>(
          "/api/conversations?q=" + encodeURIComponent(q)
        );
        setServerResults(Array.isArray(data.items) ? data.items : []);
      } catch {
        setServerResults(null); // gagal → fallback filter judul lokal
      }
    }, 300);
  }, [query]);

  // Mode pencarian: gabung hasil server (judul+isi, urutan server) — tanpa
  // duplikat; fallback ke filter judul lokal saat server belum balas/gagal.
  const filtered = useMemo(() => {
    if (!query) return items;
    const q = query.trim().toLowerCase();
    if (serverResults) {
      // Pertahankan urutan server (judul match dulu), tanpa duplikat
      const seen = new Set<string>();
      const merged = serverResults.filter((r) => {
        if (seen.has(r.conversation_id)) return false;
        seen.add(r.conversation_id);
        return true;
      });
      return merged;
    }
    return items.filter((c) => (c.title || "").toLowerCase().includes(q));
  }, [items, query, serverResults]);

  // Reset jumlah render saat daftar/query berubah
  useEffect(() => {
    setRendered(BATCH);
  }, [items, query, viewArchived]);

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

  // Escape → tutup drawer / menu profil / menu item
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (renaming) setRenaming(null);
      else if (itemMenu) setItemMenu(null);
      else if (menuOpen) setMenuOpen(false);
      else onCloseDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCloseDrawer, menuOpen, itemMenu, renaming]);

  // Klik di luar menu profil / menu item → tutup
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!itemMenu) return;
    const onDown = (e: MouseEvent) => {
      // Klik pada tombol ⋯ ditangani click handler-nya sendiri (toggle);
      // jangan tutup duluan di mousedown supaya toggle tetap akurat.
      if ((e.target as HTMLElement).closest?.(".sb-item-more")) return;
      if (itemMenuRef.current && !itemMenuRef.current.contains(e.target as Node)) setItemMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [itemMenu]);

  // Mode tampilan: normal (aktif, non-arsip) / arsip. Pinned tetap di atas
  // mode normal. Saat mencari → semua dicari (termasuk arsip, ditandai).
  const visible = useMemo(() => {
    if (query) return filtered.slice(0, rendered);
    const base = filtered.filter((c) =>
      viewArchived ? c.archived === true : c.archived !== true
    );
    const pinned = base.filter((c) => c.pinned);
    const rest = base.filter((c) => !c.pinned);
    return [...pinned, ...rest].slice(0, rendered);
  }, [filtered, query, viewArchived, rendered]);

  const groups = useMemo(() => groupByTime(visible), [visible]);
  const archivedCount = useMemo(() => items.filter((c) => c.archived === true).length, [items]);

  const itemMenuTarget = itemMenu ? items.find((c) => c.conversation_id === itemMenu.id) : null;

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

        {/* Tab tampilan: Semua / Arsip (arsip hanya muncul kalau ada isinya) */}
        {archivedCount > 0 && !query && (
          <div className="sb-views" role="tablist">
            <button
              type="button"
              role="tab"
              className={"sb-view" + (!viewArchived ? " active" : "")}
              onClick={() => setViewArchived(false)}
            >
              Semua
            </button>
            <button
              type="button"
              role="tab"
              className={"sb-view" + (viewArchived ? " active" : "")}
              onClick={() => setViewArchived(true)}
            >
              Arsip ({archivedCount})
            </button>
          </div>
        )}

        <nav className="sb-history" aria-label="Percakapan" ref={historyRef}>
          {visible.length === 0 ? (
            <>
              <p className="sb-empty">
                {query
                  ? "Tidak ada percakapan yang cocok."
                  : viewArchived
                    ? "Arsip kosong."
                    : "Belum pernah ngobrol di sini."}
              </p>
              {!query && !viewArchived && (
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
                <div className="sb-group-label">
                  {group.label === "" ? "Disematkan" : group.label}
                </div>
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
                    <span className="sb-item-main">
                      {renaming?.id === conv.conversation_id ? (
                        <input
                          className="sb-item-rename"
                          value={renaming.title}
                          autoFocus
                          maxLength={80}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenaming({ id: conv.conversation_id, title: e.target.value })}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") {
                              const t = renaming.title.trim();
                              setRenaming(null);
                              if (t && t !== (conv.title || "Chat baru")) onRename(conv.conversation_id, t);
                            } else if (e.key === "Escape") {
                              setRenaming(null);
                            }
                          }}
                          onBlur={() => {
                            const t = renaming.title.trim();
                            setRenaming(null);
                            if (t && t !== (conv.title || "Chat baru")) onRename(conv.conversation_id, t);
                          }}
                          aria-label="Nama percakapan baru"
                        />
                      ) : (
                        <span className="sb-item-title">{conv.title || "Chat baru"}</span>
                      )}
                      {conv.snippet && <span className="sb-item-snippet">{conv.snippet}</span>}
                    </span>
                    {renaming?.id === conv.conversation_id ? null : (
                      <button
                        className="sb-item-more"
                        aria-label="Opsi percakapan"
                        aria-expanded={itemMenu?.id === conv.conversation_id}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (itemMenu?.id === conv.conversation_id) {
                            setItemMenu(null);
                            return;
                          }
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          const W = 196, H = 178;
                          const x = Math.max(8, Math.min(rect.right - W, window.innerWidth - W - 8));
                          const y =
                            rect.bottom + 6 + H > window.innerHeight
                              ? Math.max(8, rect.top - H - 6)
                              : rect.bottom + 6;
                          setItemMenu({ id: conv.conversation_id, x, y });
                        }}
                      >
                        <svg className="icon" aria-hidden="true"><use href="/icons.svg#more" /></svg>
                      </button>
                    )}

                  </div>
                ))}
              </div>
              ))}
              {hasMore && onLoadMore && !query && (
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
                  onOpenSaved();
                }}
              >
                <svg className="icon" aria-hidden="true"><use href="/icons.svg#bookmark" /></svg>
                <span>Simpanan</span>
              </button>
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

      {/* Menu ⋯ percakapan — fixed, di luar <aside>, tidak bisa terpotong
          overflow scroll / transform drawer. Item menu memakai data target
          supaya tetap sinkron dengan daftar. */}
      {itemMenu && itemMenuTarget && (
        <div
          className="sb-item-menu"
          ref={itemMenuRef}
          role="menu"
          style={{ left: itemMenu.x, top: itemMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setItemMenu(null);
              setRenaming({ id: itemMenuTarget.conversation_id, title: itemMenuTarget.title || "Chat baru" });
            }}
          >
            <svg className="icon" aria-hidden="true"><use href="/icons.svg#edit" /></svg>
            <span>Ganti nama</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setItemMenu(null);
              onPin(itemMenuTarget.conversation_id, !itemMenuTarget.pinned);
            }}
          >
            <svg className="icon" aria-hidden="true"><use href="/icons.svg#pin" /></svg>
            <span>{itemMenuTarget.pinned ? "Lepas sematan" : "Sematkan"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setItemMenu(null);
              onArchive(itemMenuTarget.conversation_id, !itemMenuTarget.archived);
            }}
          >
            <svg className="icon" aria-hidden="true"><use href="/icons.svg#archive" /></svg>
            <span>{itemMenuTarget.archived ? "Keluarkan dari arsip" : "Arsipkan"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              setItemMenu(null);
              onDelete(itemMenuTarget.conversation_id);
            }}
          >
            <svg className="icon" aria-hidden="true"><use href="/icons.svg#trash" /></svg>
            <span>Hapus</span>
          </button>
        </div>
      )}
    </>
  );
}
