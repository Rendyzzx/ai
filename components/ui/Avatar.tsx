"use client";

/* ============================================================
   Aomi — components/ui/Avatar.tsx
   Avatar dinamis: <img> bila ada dataUrl, kalau tidak → ikon
   sprite default. Port dari renderAvatar di app.js (anti-flash:
   <img> di-decode React/lazy; src sama → tanpa re-mount).
   ============================================================ */

import Icon from "./Icon";

export default function Avatar({
  src,
  fallbackIcon,
  className,
  alt = "",
}: {
  src?: string | null;
  fallbackIcon: string;
  className?: string;
  alt?: string;
}) {
  if (src) {
    return <img className={className} src={src} alt={alt} aria-hidden="true" decoding="async" />;
  }
  return <Icon id={fallbackIcon} className={className} />;
}
