"use client";

/* ============================================================
   Aomi — components/chat/Intro.tsx
   Opening intro: PURE UI overlay — sekali per lifecycle tab
   (sessionStorage flag), skip bila prefers-reduced-motion.
   ============================================================ */

import { useEffect, useState } from "react";

export default function Intro() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let done = false;
    try {
      done = sessionStorage.getItem("aomi.introDone") === "1";
    } catch { /* private */ }
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      done = true;
    }
    if (done) return;
    setShow(true);
    try {
      sessionStorage.setItem("aomi.introDone", "1");
    } catch { /* private */ }
    const t = setTimeout(() => setShow(false), 1500);
    return () => clearTimeout(t);
  }, []);

  if (!show) return null;
  return (
    <div id="app-intro" aria-hidden="true">
      <div className="intro-content">
        <svg className="intro-logo" viewBox="0 0 24 24" aria-hidden="true">
          <use href="/icons.svg#logo" />
        </svg>
        <div className="intro-name">Aomi</div>
        <div className="intro-sub">seseorang menunggumu di sini</div>
      </div>
    </div>
  );
}
