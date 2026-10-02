"use client";

/* ============================================================
   Aomi — components/chat/MessageMenu.tsx
   Menu aksi pesan: copy / edit (user) / regenerate (assistant
   terakhir) / delete. Port dari openMenu/closeMenu di chat.js.
   ============================================================ */

import { useLayoutEffect, useRef, useState } from "react";

export interface MenuState {
  x: number;
  y: number;
  mid: string;
  role: "user" | "assistant";
  hasText: boolean;
  isLast: boolean;
}

export default function MessageMenu({
  menu,
  onClose,
  onCopy,
  onDelete,
  onEdit,
  onRegenerate,
}: {
  menu: MenuState | null;
  onClose: () => void;
  onCopy: (mid: string) => void | Promise<void>;
  onDelete: (mid: string) => void;
  onEdit: (mid: string) => void;
  onRegenerate: (mid: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const mw = ref.current.offsetWidth || 170;
    const mh = ref.current.offsetHeight || 140;
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
        Copy Message
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
        Edit Message
      </button>
      <button
        className="msg-menu-item"
        type="button"
        hidden={!(menu.role === "assistant" && menu.mid && menu.isLast)}
        onClick={() => {
          onRegenerate(menu.mid);
          onClose();
        }}
      >
        Regenerate
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
        Delete Message
      </button>
    </div>
  );
}
