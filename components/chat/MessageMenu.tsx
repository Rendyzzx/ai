"use client";

/* ============================================================
   Aomi — components/chat/MessageMenu.tsx
   Menu aksi pesan — kecil & dekat pesan, BUKAN panel besar.
   Assistant: Salin, Regenerate (opsi gaya), Simpan, Feedback, Hapus.
   User: Salin, Kirim ulang, Ubah, Hapus.
   Semua icon dari sprite (/icons.svg) — tidak ada emoji.
   ============================================================ */

import { useLayoutEffect, useRef, useState } from "react";
import Icon from "@/components/ui/Icon";

export interface MenuState {
  x: number;
  y: number;
  mid: string;
  role: "user" | "assistant";
  hasText: boolean;
  isLast: boolean;
  /** Pesan punya gambar/video → "Kirim ulang" tidak relevan. */
  hasMedia?: boolean;
  /** Feedback tersimpan: 1 (suka) / -1 (tidak suka) / 0 (belum). */
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
  { variant: "", label: "Biasa saja" },
  { variant: "shorter", label: "Lebih singkat" },
  { variant: "detailed", label: "Lebih detail" },
  { variant: "casual", label: "Lebih santai" },
  { variant: "formal", label: "Lebih formal" },
  { variant: "simpler", label: "Jelaskan lebih mudah" },
  { variant: "indonesian", label: "Bahasa Indonesia" },
];

const MENU_W = 190;

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
    const mw = ref.current.offsetWidth || MENU_W;
    const mh = ref.current.offsetHeight || 120;
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

  // ---- Submenu opsi regenerate ----
  if (regenOpen) {
    return (
      <div
        className="msg-menu"
        ref={ref}
        style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden", left: 0, top: 0 }}
      >
        <button className="msg-menu-item msg-menu-back" type="button" onClick={() => setRegenOpen(false)}>
          <Icon id="chevron-left" />
          <span>Kembali</span>
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
        <Icon id="copy" />
        <span>Salin</span>
      </button>

      {/* Pesan user: kirim ulang (hanya teks) + ubah */}
      <button
        className="msg-menu-item"
        type="button"
        hidden={!(menu.role === "user" && menu.mid && menu.hasText && !menu.hasMedia)}
        onClick={() => {
          onRetry(menu.mid);
          onClose();
        }}
      >
        <Icon id="refresh" />
        <span>Kirim ulang</span>
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
        <Icon id="edit" />
        <span>Ubah pesan</span>
      </button>

      {/* Jawaban Aomi: regenerate, simpan, feedback */}
      <button
        className="msg-menu-item"
        type="button"
        hidden={!(assistant && menu.mid && menu.isLast)}
        onClick={() => setRegenOpen(true)}
      >
        <Icon id="refresh" />
        <span>Regenerate</span>
      </button>
      <button
        className="msg-menu-item"
        type="button"
        hidden={!(assistant && menu.mid)}
        onClick={() => {
          onBookmark(menu.mid, Boolean(menu.bookmarked));
          onClose();
        }}
      >
        <Icon id="bookmark" className={menu.bookmarked ? "fill" : undefined} />
        <span>{menu.bookmarked ? "Hapus dari Simpanan" : "Simpan"}</span>
      </button>
      {assistant && menu.mid && (
        <div className="msg-menu-row">
          <button
            type="button"
            className={"msg-menu-fb" + (menu.feedback === 1 ? " active" : "")}
            aria-label="Jawaban membantu"
            onClick={() => {
              onFeedback(menu.mid, 1);
              onClose();
            }}
          >
            <Icon id="thumb-up" />
          </button>
          <button
            type="button"
            className={"msg-menu-fb" + (menu.feedback === -1 ? " active" : "")}
            aria-label="Jawaban kurang membantu"
            onClick={() => {
              onFeedback(menu.mid, -1);
              onClose();
            }}
          >
            <Icon id="thumb-down" />
          </button>
        </div>
      )}

      <button
        className="msg-menu-item danger"
        type="button"
        hidden={!menu.mid}
        onClick={() => {
          onDelete(menu.mid);
          onClose();
        }}
      >
        <Icon id="trash" />
        <span>Hapus pesan</span>
      </button>
    </div>
  );
}
