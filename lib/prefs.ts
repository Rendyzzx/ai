/* ============================================================
   Aomi — lib/prefs.ts
   Preferensi tampilan & perilaku chat yang bersifat LOKAL
   (bukan data sensitif, cocok di localStorage — lihat brief
   Settings §22). Satu sumber kebenaran dipakai oleh:
   - script blocking di <body> (app/layout.tsx) — anti-flash
   - SettingsView (kontrol + preview realtime)
   - ChatApp/MessageRow (komposer, auto-scroll, render kode)

   Pola CSS var ini port 1:1 dari --chat-fs yang sudah ada
   sebelumnya (set via documentElement.style.setProperty) —
   bukan sistem baru, hanya diperluas & dirapikan.
   ============================================================ */

import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "dark" | "light" | "system";
export type FontChoice = "manrope" | "dmsans" | "plusjakarta" | "instrument";
export type TextSizeChoice = "small" | "medium" | "large";
export type DensityChoice = "comfortable" | "medium" | "compact";
export type AccentChoice = "aomi" | "sand" | "olive" | "rose";

export interface Prefs {
  theme: ThemeChoice;
  font: FontChoice;
  textSize: TextSizeChoice;
  density: DensityChoice;
  accent: AccentChoice;
  animations: boolean;
  enterToSend: boolean;
  autoScroll: boolean;
  showCode: boolean; // render blok kode bergaya (false = teks mentah)
}

type VisualKey = "theme" | "font" | "textSize" | "density" | "accent" | "animations";

export const DEFAULTS: Prefs = {
  theme: "dark",
  font: "manrope",
  textSize: "medium",
  density: "comfortable",
  accent: "aomi",
  animations: true,
  enterToSend: true,
  autoScroll: true,
  showCode: true,
};

const SYS_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export const FONT_STACKS: Record<FontChoice, string> = {
  manrope: `var(--font-manrope), ${SYS_FONT}`,
  dmsans: `var(--font-dmsans), ${SYS_FONT}`,
  plusjakarta: `var(--font-plusjakarta), ${SYS_FONT}`,
  instrument: `var(--font-instrument), ${SYS_FONT}`,
};

export const FONT_LABELS: Record<FontChoice, string> = {
  manrope: "Manrope",
  dmsans: "DM Sans",
  plusjakarta: "Plus Jakarta Sans",
  instrument: "Instrument Sans",
};

export const TEXT_SIZE_PX: Record<TextSizeChoice, string> = { small: "14", medium: "15.5", large: "17" };

export const DENSITY_VALS: Record<DensityChoice, { gap: string; py: string; px: string; lh: string }> = {
  comfortable: { gap: "16px", py: "10px", px: "14px", lh: "1.5" },
  medium: { gap: "12px", py: "8px", px: "13px", lh: "1.45" },
  compact: { gap: "8px", py: "7px", px: "12px", lh: "1.4" },
};

export const ACCENT_VALS: Record<AccentChoice, { a: string; h: string; label: string }> = {
  aomi: { a: "#c69a60", h: "#d3a46c", label: "Aomi" },
  sand: { a: "#c7b38a", h: "#d2c09c", label: "Sand" },
  olive: { a: "#9ca370", h: "#a9b084", label: "Olive" },
  rose: { a: "#c98a82", h: "#d59a92", label: "Rose" },
};

const storageKey = (k: string) => "aomi.pref." + k;

function readPref<K extends keyof Prefs>(key: K): Prefs[K] {
  if (typeof window === "undefined") return DEFAULTS[key];
  try {
    const raw = window.localStorage.getItem(storageKey(key));
    if (raw === null) return DEFAULTS[key];
    if (typeof DEFAULTS[key] === "boolean") return (raw === "1") as Prefs[K];
    return raw as Prefs[K];
  } catch {
    return DEFAULTS[key];
  }
}

export function getPref<K extends keyof Prefs>(key: K): Prefs[K] {
  return readPref(key);
}

function resolveTheme(choice: ThemeChoice): "dark" | "light" {
  if (choice !== "system") return choice;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Terapkan satu preferensi visual ke <html> (CSS var / attribute). */
export function applyVisualPref(key: VisualKey, value: Prefs[VisualKey]): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  switch (key) {
    case "theme":
      root.setAttribute("data-theme", resolveTheme(value as ThemeChoice));
      break;
    case "font":
      root.style.setProperty("--font", FONT_STACKS[value as FontChoice]);
      break;
    case "textSize":
      root.style.setProperty("--chat-fs", TEXT_SIZE_PX[value as TextSizeChoice] + "px");
      break;
    case "density": {
      const d = DENSITY_VALS[value as DensityChoice];
      root.style.setProperty("--msg-gap", d.gap);
      root.style.setProperty("--msg-pad-y", d.py);
      root.style.setProperty("--msg-pad-x", d.px);
      root.style.setProperty("--msg-lh", d.lh);
      break;
    }
    case "accent": {
      const a = ACCENT_VALS[value as AccentChoice];
      root.style.setProperty("--accent", a.a);
      root.style.setProperty("--accent-hover", a.h);
      break;
    }
    case "animations":
      root.setAttribute("data-anim", value ? "on" : "off");
      break;
  }
}

const VISUAL_KEYS: VisualKey[] = ["theme", "font", "textSize", "density", "accent", "animations"];

/** Dipanggil sekali saat app mount (idempotent — script blocking sudah apply duluan). */
export function applyAllVisualPrefs(): void {
  for (const k of VISUAL_KEYS) applyVisualPref(k, getPref(k));
  if (typeof window === "undefined") return;
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    if (getPref("theme") === "system") applyVisualPref("theme", "system");
  };
  mq.addEventListener?.("change", onChange);
}

/** Simpan + broadcast + (jika visual) terapkan langsung. */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  try {
    window.localStorage.setItem(storageKey(key), typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  } catch {
    /* private mode: tetap berlaku di tab ini via event, hanya tidak persist */
  }
  if ((VISUAL_KEYS as string[]).includes(key)) applyVisualPref(key as VisualKey, value as Prefs[VisualKey]);
  window.dispatchEvent(new CustomEvent("aomi:pref", { detail: { key, value } }));
}

/** Hook reaktif: baca + ubah satu preferensi, sinkron antar bagian UI dalam tab yang sama. */
export function usePref<K extends keyof Prefs>(key: K): [Prefs[K], (v: Prefs[K]) => void] {
  const [val, setVal] = useState<Prefs[K]>(() => readPref(key));

  useEffect(() => {
    setVal(readPref(key));
    const onEvt = (e: Event) => {
      const detail = (e as CustomEvent).detail as { key: string; value: Prefs[K] } | undefined;
      if (detail?.key === key) setVal(detail.value);
    };
    window.addEventListener("aomi:pref", onEvt);
    return () => window.removeEventListener("aomi:pref", onEvt);
  }, [key]);

  const update = useCallback((v: Prefs[K]) => setPref(key, v), [key]);
  return [val, update];
}
