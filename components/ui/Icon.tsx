/* ============================================================
   Aomi — components/ui/Icon.tsx
   Ikon SVG via sprite publik /icons.svg (sama dengan sistem lama).
   ============================================================ */

export default function Icon({ id, className }: { id: string; className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} aria-hidden="true">
      <use href={`/icons.svg#${id}`} />
    </svg>
  );
}
