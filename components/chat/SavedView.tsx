"use client";

/* ============================================================
   Aomi — components/chat/SavedView.tsx
   Panel "Simpanan": jawaban Aomi yang user tandai 🔖.
   Overlay ringan gaya settings — bukan halaman baru. Data dari
   GET /api/conversations?bookmarks=1 (snapshot, tetap ada walau
   percakapan sumbernya dihapus).
   ============================================================ */

import { useCallback, useEffect, useState } from "react";
import { api, apiJson } from "@/lib/client-api";
import type { BookmarkEntry } from "@/types";

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "baru saja";
  if (s < 3600) return Math.floor(s / 60) + " mnt lalu";
  if (s < 86400) return Math.floor(s / 3600) + " jam lalu";
  if (s < 7 * 86400) return Math.floor(s / 86400) + " hari lalu";
  return new Date(t).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

export default function SavedView({
  onClose,
  onOpenConversation,
  onToast,
}: {
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
  onToast: (msg: string) => void;
}) {
  const [items, setItems] = useState<BookmarkEntry[] | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ items: BookmarkEntry[] }>("/api/conversations?bookmarks=1");
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Escape → tutup
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast("Tersalin");
    } catch { /* abaikan */ }
  };

  const remove = async (mid: string, cid: string) => {
    // Optimistik
    setItems((prev) => (prev ? prev.filter((b) => b.message_id !== mid) : prev));
    try {
      await api(
        "/api/conversations?bookmark_id=" +
          encodeURIComponent(mid) +
          "&conversation_id=" +
          encodeURIComponent(cid),
        { method: "DELETE" }
      );
    } catch {
      void load(); // gagal → muat ulang daftar sebenarnya
    }
  };

  return (
    <div className="saved-overlay" role="dialog" aria-label="Simpanan">
      <div className="saved-panel">
        <header className="saved-head">
          <span className="saved-title">🔖 Simpanan</span>
          <button className="icon-btn" aria-label="Tutup Simpanan" onClick={onClose}>
            <svg className="icon" aria-hidden="true"><use href="/icons.svg#close" /></svg>
          </button>
        </header>

        <div className="saved-list">
          {items === null && <p className="saved-empty">Memuat…</p>}
          {items !== null && items.length === 0 && (
            <div className="saved-empty">
              <p>Belum ada jawaban yang disimpan.</p>
              <p className="saved-empty-hint">
                Buka menu ⋯ di sebuah jawaban Aomi lalu pilih “Simpan”.
              </p>
            </div>
          )}
          {items?.map((b) => (
            <article key={b.message_id} className="saved-item">
              <div className="saved-item-head">
                <span className="saved-item-conv">{b.conversation_title || "Chat baru"}</span>
                <span className="saved-item-time">{relTime(b.saved_at)}</span>
              </div>
              <p className="saved-item-text">{b.content}</p>
              <div className="saved-item-actions">
                <button type="button" onClick={() => copyText(b.content)}>Salin</button>
                <button type="button" onClick={() => onOpenConversation(b.conversation_id)}>Buka chat</button>
                <button type="button" className="danger" onClick={() => void remove(b.message_id, b.conversation_id)}>Hapus</button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
