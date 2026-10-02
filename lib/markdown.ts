/* ============================================================
   Aomi — lib/markdown.tsx
   Parse teks pesan menjadi segmen aman (teks / inline code /
   code block) — port dari renderMessageText di chat.js.
   Semua string dirender React sebagai TEXT node → HTML di dalam
   pesan TIDAK PERNAH dieksekusi.
   ============================================================ */

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "inline"; text: string }
  | { kind: "code"; lang: string; code: string };

/** Parse ``` fence + `inline` → array segmen. */
export function parseMessageText(raw: string): Segment[] {
  const segments: Segment[] = [];
  const text = String(raw || "");

  // ```lang\n...``` — fence tanpa penutup dianggap blok sampai akhir
  const re = /```([a-zA-Z0-9+#._-]*)[^\S\n]*\r?\n([\s\S]*?)(?:```|$)/g;
  const pushText = (chunk: string) => {
    for (const part of chunk.split(/(`[^`\n]+`)/g)) {
      if (!part) continue;
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        segments.push({ kind: "inline", text: part.slice(1, -1) });
      } else {
        segments.push({ kind: "text", text: part });
      }
    }
  };

  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) pushText(text.slice(last, m.index));
    segments.push({ kind: "code", lang: m[1], code: m[2].replace(/\n+$/, "") });
    last = re.lastIndex;
  }
  if (last < text.length) pushText(text.slice(last));

  return segments;
}

/** Teks polos dari pesan (untuk copy / menu). */
export function plainText(raw: string): string {
  return String(raw || "");
}
