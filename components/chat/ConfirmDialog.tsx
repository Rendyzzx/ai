"use client";

/* ============================================================
   Aomi — components/chat/ConfirmDialog.tsx
   Pengganti window.confirm() bawaan browser.
   ============================================================ */

import { useLayoutEffect, useRef, useState } from "react";

export interface ConfirmState {
  message: string;
  okLabel: string;
  cancelLabel: string;
  resolve: (ok: boolean) => void;
}

export default function ConfirmDialog({
  confirm,
  onDone,
}: {
  confirm: ConfirmState | null;
  onDone: (ok: boolean) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);

  useLayoutEffect(() => {
    if (!confirm) {
      setShow(false);
      return;
    }
    const raf = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(raf);
  }, [confirm]);

  useLayoutEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirm, onDone]);

  if (!confirm) return null;

  return (
    <div
      className={"confirm-overlay" + (show ? " show" : "")}
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) onDone(false);
      }}
    >
      <div className="confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="confirmMsg">
        <p className="confirm-msg">{confirm.message}</p>
        <div className="confirm-actions">
          <button className="confirm-btn confirm-cancel" type="button" onClick={() => onDone(false)}>
            {confirm.cancelLabel}
          </button>
          <button className="confirm-btn confirm-ok" type="button" onClick={() => onDone(true)}>
            {confirm.okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
