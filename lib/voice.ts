/**
 * Util suara (client-only) untuk mode telepon Aomi:
 * - deteksi Web Speech API (STT) & speechSynthesis (TTS)
 * - pembersih markdown → teks yang enak diucapkan
 *
 * Tidak butuh API key / server — semua jalan di browser.
 */

export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

export type SpeechRecognitionEventLike = {
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string } | undefined;
  }>;
};

/** Ambil constructor SpeechRecognition (Chrome/Edge/Safari), null bila tak ada. */
export function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function speechRecognitionSupported(): boolean {
  return getSpeechRecognition() !== null;
}

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * Markdown → kalimat lisan:
 * - blok kode diganti "(kode dilewati)", inline code dibuka tandaannya
 * - gambar dibuang, link jadi teksnya saja
 * - emphasis/heading/list/table/HTML di-markup dibersihkan
 * - emoji & URL telanjang dibuang ( tidak enak dibaca mesin )
 */
export function stripForSpeech(md: string): string {
  let s = md;
  // blok kode → placeholder pendek (jangan baca kode dengan suara)
  s = s.replace(/```[\s\S]*?```/g, " (kode dilewati) ");
  s = s.replace(/~~~[\s\S]*?~~~/g, " (kode dilewati) ");
  // inline code → isi saja
  s = s.replace(/`([^`]*)`/g, "$1");
  // gambar & link
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // URL telanjang (sebelum strip markup sisa)
  s = s.replace(/https?:\/\/\S+/g, " ");
  // emphasis / strikethrough
  s = s.replace(/(\*\*|__|\*|_|~~|=+)/g, " ");
  // heading & blockquote
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s*>\s?/gm, "");
  // list bullet & numbered → angka tetap terbaca wajar
  s = s.replace(/^\s*[-*+•]\s+/gm, "");
  s = s.replace(/^\s*\d+[.)]\s+/gm, "");
  // tabel
  s = s.replace(/\|/g, " ");
  // horizontal rule
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, " ");
  // tag html sisa
  s = s.replace(/<[^>]+>/g, " ");
  // emoji & simbol dekoratif
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, " ");
  // rapikan whitespace
  s = s.replace(/\s+/g, " ").trim();
  // spasi sisa di sekitar tanda baca
  s = s.replace(/\s+([,.!?;:])/g, "$1").trim();
  return s;
}

/** Pilih voice TTS: utamakan bahasa Indonesia, fallback voice default. */
export function pickVoice(): SpeechSynthesisVoice | null {
  try {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    const id = voices.find((v) => /^id([-_]|$)/i.test(v.lang) || /indonesia/i.test(v.name));
    if (id) return id;
    return voices.find((v) => v.default) || voices[0];
  } catch {
    return null;
  }
}
