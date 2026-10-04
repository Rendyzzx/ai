"use client";

/* ============================================================
   Aomi — components/chat/MessageMenu.tsx
   Menu aksi pesan (contextual menu, bukan tombol besar):
   copy / kirim ulang / edit (user), regenerate (+ opsi gaya),
   simpan (bookmark), feedback 👍/👎, ke awal pesan, delete.
   Konfirmasi & submenu ada di sini; aksi di ChatApp.
   ============================================================ */

import { useLayoutEffect, useRef, useState } from "react";

export interface MenuState {
  x: number;
  y: number;
  mid: string;
  role: "user" | "assistant";
  hasText: boolean;
  isLast: boolean;
  /** Panjang isi (karakter) → tampil "Ke awal pesan" kalau panjang. */
  contentLen?: number;
  /** Pesan punya gambar/video → "Kirim ulang" tidak relevan. */
  hasMedia?: boolean;
  /** Feedback tersimpan: 1 (👍) / -1 (👎) / 0 (belum). */
  feedback?: number;
  /** Sudah ada di "Simpanan". */
  bookmarked?: boolean;
}

export type RegenVariant =
  | ""
  | "shorter"
  | "detailed"
  | "casual"
  | "formal"
  | "simpler"
  | "indonesian";

const REGEN_OPTIONS: { variant: RegenVariant; label: string }[] = [
  { variant: "", label: "↻ Biasa saja" },
  { variant: "shorter", label: "Lebih singkat" },
  { variant: "detailed", label: "Lebih detail" },
  { variant: "casual", label: "Lebih santai" },
  { variant: "formal", label: "Lebih formal" },
  { variant: "simpler", label: "Jelaskan lebih mudah" },
  { variant: "indonesian", label: "Bahasa Indonesia" },
];

/** Batas "pesan panjang" → opsi "Ke awal pesan" muncul di menu. */
const LONG_MESSAGE = 900;

export default function MessageMenu({
  menu,
  onClose,
  onCopy,
  onDelete,
  onEdit,
  onRetry,
  onRegenerate,
  onBookmark,
  onFeedback,
  onJumpTop,
}: {
  menu: MenuState | null;
  onClose: () => void;
  onCopy: (mid: string) => void | Promise<void>;
  onDelete: (mid: string) => void;
  onEdit: (mid: string) => void;
  onRetry: (mid: string) => void;
  onRegenerate: (mid: string, variant: RegenVariant) => void;
  onBookmark: (mid: string, bookmarked: boolean) => void;
  onFeedback: (mid: string, value: 1 | -1) => void;
  onJumpTop: (mid: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [regenOpen, setRegenOpen] = useState(false);

  useLayoutEffect(() => {
    setRegenOpen(false);
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const mw = ref.current.offsetWidth || 180;
    const mh = ref.current.offsetHeight || 150;
    const left = Math.min(Math.max(8, menu.x - mw / 2), window.innerWidth - mw - 8);
    const above = menu.y - mh - 10;
    const top =
      above >= 8 ? above : Math.min(menu.y + 14, window.innerHeight - mh - 8);
    setPos({ left, top });
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const assistant = menu.role === "assistant";
  const canSave = assistant && !!menu.mid;
  const showFeedback = assistant && !!menu.mid;
  const showJump = (menu.contentLen || 0) > LONG_MESSAGE;

  // ---- Submenu opsi regenerate (request baru BARU setelah user memilih) ----
  if (regenOpen) {
    return (
      <div
        className="msg-menu"
        ref={ref}
        style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden", left: 0, top: 0 }}
      >
        <button
          className="msg-menu-item msg-menu-back"
          type="button"
          onClick={() => setRegenOpen(false)}
        >
          ‹ Kembali
        </button>
        {REGEN_OPTIONS.map((opt) => (
          <button
            key={opt.variant || "plain"}
            className="msg-menu-item"
            type="button"
            onClick={() => {
              onRegenerate(menu.mid, opt.variant);
              onClose();
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div
      className="msg-menu"
      ref={ref}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden", left: 0, top: 0 }}
    >
      <button
        className="msg-menu-item"
        type="button"
        hidden={!menu.hasText}
        onClick={() => {
          onCopy(menu.mid);
          onClose();
        }}
      >
        Salin pesan
      </button>

      {/* Pesan user: kirim ulang (hanya teks) + edit */}
      <button
        className="msg-menu-item"
        type="button"
        hidden={!(menu.role === "user" && menu.mid && menu.hasText && !menu.hasMedia)}
        onClick={() => {
          onRetry(menu.mid);
          onClose();
        }}
      >
        Kirim ulang
      </button>
      <button
        className="msg-menu-item"
        type="button"
        hidden={!(menu.role === "user" && menu.mid)}
        onClick={() => {
          onEdit(menu.mid);
          onClose();
        }}
      >
        Ubah pesan
      </button>

      {/* Jawaban Aomi: regenerate (dengan opsi), simpan, feedback */}
      <button
        className="msg-menu-item"
        type="button"
        hidden={!(assistant && menu.mid && menu.isLast)}
        onClick={() => setRegenOpen(true)}
      >
        ↻ Regenerate…
      </button>
      <button
        className="msg-menu-item"
        type="button"
        hidden={!canSave}
        onClick={() => {
          onBookmark(menu.mid, Boolean(menu.bookmarked));
          onClose();
        }}
      >
        {menu.bookmarked ? "Hapus dari Simpanan" : "🔖 Simpan"}
      </button>
      {showFeedback && (
        <div className="msg-menu-row">
          <button
            className={"msg-menu-item msg-menu-fb" + (menu.feedback === 1 ? " active" : "")}
            type="button"
            onClick={() => {
              onFeedback(menu.mid, 1);
              onClose();
            }}
          >
            👍
          </button>
          <button
            className={"msg-menu-item msg-menu-fb" + (menu.feedback === -1 ? " active" : "")}
            type="button"
            onClick={() => {
              onFeedback(menu.mid, -1);
              onClose();
            }}
          >
            👎
          </button>
        </div>
      )}

      <button
        className="msg-menu-item"
        type="button"
        hidden={!showJump}
        onClick={() => {
          onJumpTop(menu.mid);
          onClose();
        }}
      >
        Ke awal pesan ini
      </button>

      <button
        className="msg-menu-item danger"
        type="button"
        hidden={!menu.mid}
        onClick={() => {
          onDelete(menu.mid);
          onClose();
        }}
      >
        Hapus pesan
      </button>
    </div>
  );
}
