"use client";

/* ============================================================
   Aomi — components/settings/SettingsView.tsx
   Settings overlay: "ini tempat gue mengatur bagaimana Aomi
   bekerja dan terlihat buat gue."

   Kategori (semua nyata, tidak ada menu kosong):
   - Profil      → /api/profile (save parsial per section)
   - Karakter    → /api/bot (identitas, personality, perilaku,
                   memory, advanced — lengkap dengan preview)
   - Tampilan    → lib/prefs.ts: tema, font, ukuran teks,
                   kerapatan, accent, animasi + preview live
   - Percakapan → enter-to-send, auto-scroll, blok kode
   - Data        → ekspor JSON & hapus semua percakapan
                   (dengan konfirmasi dua-langkah)
   - Akun        → identitas, status Google, logout

   Persistence:
   - Profil/Karakter → akun (database), tombol Simpan + status kecil
   - Tampilan/Percakapan → lokal per perangkat (lihat lib/prefs.ts),
     tersimpan otomatis, feedback "Tersimpan" kecil
   ============================================================ */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/client-api";
import { compressToAvatar } from "@/lib/image";
import {
  ACCENT_VALS,
  DENSITY_VALS,
  FONT_LABELS,
  FONT_STACKS,
  type AccentChoice,
  type DensityChoice,
  type FontChoice,
  type ThemeChoice,
  usePref,
} from "@/lib/prefs";
import type { BotConfig, UserProfile } from "@/types";
import TelegramAuth from "@/components/auth/TelegramAuth";

type Section = "profile" | "identity" | "personality" | "behavior" | "memory" | "advanced";

const PREVIEW_LINES: Record<string, string> = {
  casual: '"hey, akhirnya ada yang ngobrol juga."',
  short: '"hm?"',
  expressive: '"KAMU GILAA- eh, maksudku... hi!"',
  dry: '"oh. kamu lagi."',
  playful: '"tebak deh aku mikirin apa."',
  detailed: '"tumben. nggak nyangka kamu buka chat aku hari ini. ada cerita?"',
};

const TRAITS = [
  { id: "calm", label: "Tenang" },
  { id: "playful", label: "Playful" },
  { id: "teasing", label: "Suka menggoda" },
  { id: "caring", label: "Perhatian" },
  { id: "shy", label: "Pemalu" },
  { id: "energetic", label: "Energik" },
  { id: "sarcastic", label: "Sarkastis" },
  { id: "affectionate", label: "Mesra" },
  { id: "reserved", label: "Pendiam" },
];

const RELATIONSHIPS = [
  { val: "close_friend", label: "Sahabat dekat" },
  { val: "companion", label: "Companion" },
  { val: "fictional", label: "Karakter fiksi" },
  { val: "romantic", label: "Romantic" },
];

const SPEAKING_STYLES = [
  { val: "casual", label: "Santai" },
  { val: "short", label: "Singkat banget" },
  { val: "expressive", label: "Ekspresif" },
  { val: "dry", label: "Datar" },
  { val: "playful", label: "Playful" },
  { val: "detailed", label: "Cerewet" },
];

const LENGTHS = [
  { val: "concise", label: "Singkat" },
  { val: "balanced", label: "Santai" },
  { val: "detailed", label: "Panjang" },
];

const TONES = [
  { val: "casual", label: "Santai" },
  { val: "neutral", label: "Netral" },
  { val: "formal", label: "Formal" },
];

const LANGS = [
  { val: "auto", label: "Otomatis" },
  { val: "id", label: "Indonesia" },
  { val: "en", label: "English" },
];

type SavePhase = "idle" | "saving" | "saved" | "failed";

/* ---------------- Kontrol dasar ---------------- */

function Segmented({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { val: string; label: string }[];
  value: string;
  onChange: (val: string) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.val}
          type="button"
          className={"seg-btn" + (value === o.val ? " active" : "")}
          aria-pressed={value === o.val}
          onClick={() => onChange(o.val)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Toggle on/off — role="switch" agar screen reader benar. */
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={"switch" + (checked ? " on" : "")}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

/** Baris setting: label + deskripsi kiri, kontrol kanan. */
function Row({
  title,
  desc,
  children,
  id,
}: {
  title: string;
  desc?: string;
  children?: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="set-row" id={id}>
      <div className="set-row-text">
        <span className="set-row-title">{title}</span>
        {desc && <span className="set-row-desc">{desc}</span>}
      </div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  );
}

const LINKED_PROVIDERS = [
  {
    id: "google" as const,
    label: "Google",
    color: "#4285F4",
    svg: "M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z",
  },
  {
    id: "discord" as const,
    label: "Discord",
    color: "#5865F2",
    svg: "M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03ZM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z",
  },
  {
    id: "telegram" as const,
    label: "Telegram",
    color: "#26A5E4",
    svg: "M23.91 3.79 20.69 20.6c-.25 1.21-.98 1.5-2 .94l-5.5-4.07-2.66 2.57c-.3.3-.55.56-1.1.56-.72 0-.6-.27-.84-.95L6.3 13.7l-5.45-1.7c-1.18-.35-1.19-1.16.26-1.71l21.26-8.2c.97-.43 1.9.24 1.53 1.7Z",
  },
];

export default function SettingsView({
  initialCategory,
  linkedNotice,
  user,
  bot,
  onClose,
  onUserUpdate,
  onBotUpdate,
  onLogout,
  onConversationsCleared,
}: {
  initialCategory: string;
  linkedNotice?: string | null;
  user: UserProfile;
  bot: BotConfig;
  onClose: () => void;
  onUserUpdate: (u: Partial<UserProfile>) => void;
  onBotUpdate: (b: Partial<BotConfig>) => void;
  onLogout: () => void | Promise<void>;
  onConversationsCleared?: () => void;
}) {
  const [cat, setCat] = useState(initialCategory);
  const [pageOpen, setPageOpen] = useState(false);
  const [botPage, setBotPage] = useState("identity");

  // form state
  const [profile, setProfile] = useState({
    username: user.username || "",
    display_name: user.display_name || "",
    bio: user.bio || "",
  });
  const [identity, setIdentity] = useState({
    bot_name: bot.bot_name || "",
    bot_description: bot.bot_description || "",
    greeting: bot.greeting || "",
  });
  const [personality, setPersonality] = useState({
    traits: bot.traits || [],
    speaking_style: bot.speaking_style || "casual",
    relationship: bot.relationship || "companion",
    personality: bot.personality || "",
  });
  const [behavior, setBehavior] = useState<{
    likes: string;
    avoids: string;
    response_length: BotConfig["response_length"];
  }>({
    likes: bot.likes || "",
    avoids: bot.avoids || "",
    response_length: bot.response_length || "balanced",
  });
  const [advanced, setAdvanced] = useState<{
    system_prompt: string;
    response_style: BotConfig["response_style"];
    language: BotConfig["language"];
  }>({
    system_prompt: bot.system_prompt || "",
    response_style: bot.response_style || "casual",
    language: bot.language || "auto",
  });
  // ---- Akun terhubung (provider OAuth/OTP) ----
  const [linkedStatus, setLinkedStatus] = useState<string | null>(linkedNotice || null);
  const [linkedBusy, setLinkedBusy] = useState<string | null>(null);
  const [tgLinkOpen, setTgLinkOpen] = useState(false);
  const [enabledProviders, setEnabledProviders] = useState<Record<string, boolean>>({
    google: false,
    discord: false,
    telegram: false,
  });
  const [botUsername, setBotUsername] = useState<string | null>(null);

  // Provider aktif di-load saat settings dibuka (publik, tanpa session).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/auth/config");
        if (!res.ok) return;
        const data = (await res.json()) as {
          providers?: Record<string, boolean>;
          telegram_bot?: string | null;
        };
        if (data.providers) setEnabledProviders(data.providers);
        if (data.telegram_bot) setBotUsername(data.telegram_bot);
      } catch {
        /* fallback: hanya yang sudah terhubung yang tampil */
      }
    })();
  }, []);

  const refreshLinked = useCallback(async () => {
    try {
      const me = (await apiJson("/api/auth/me")) as {
        user?: { providers?: Record<string, boolean> };
      };
      if (me.user?.providers) {
        onUserUpdate({
          providers: {
            google: Boolean(me.user.providers.google),
            discord: Boolean(me.user.providers.discord),
            telegram: Boolean(me.user.providers.telegram),
          },
        });
      }
    } catch {
      /* session invalid sudah ditangani api() */
    }
  }, [onUserUpdate]);

  const connectProvider = useCallback(
    async (provider: "google" | "discord") => {
      setLinkedBusy(provider);
      setLinkedStatus(null);
      try {
        // Fetch dengan header session → server pasang cookie state signed,
        // lalu kita redirect ke URL consent lewat window.location (cookie ikut).
        const data = (await apiJson(`/api/auth/${provider}?link=1&json=1`)) as { url?: string };
        if (data.url) window.location.href = data.url;
      } catch (e) {
        setLinkedStatus((e as Error).message);
        setLinkedBusy(null);
      }
    },
    []
  );

  const disconnectProvider = useCallback(
    async (provider: "google" | "discord" | "telegram") => {
      setLinkedBusy(provider);
      setLinkedStatus(null);
      try {
        await apiJson("/api/auth/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, action: "disconnect" }),
        });
        await refreshLinked();
        setLinkedStatus("Provider dilepas.");
      } catch (e) {
        setLinkedStatus((e as Error).message);
      } finally {
        setLinkedBusy(null);
      }
    },
    [refreshLinked]
  );

  const [memDraft, setMemDraft] = useState<string[]>(bot.memories || []);
  const [memoryInput, setMemoryInput] = useState("");
  const [pendingUserAvatar, setPendingUserAvatar] = useState<string | null>(null);
  const [pendingBotAvatar, setPendingBotAvatar] = useState<string | null>(null);

  const [dirty, setDirty] = useState<Record<Section, boolean>>({
    profile: false, identity: false, personality: false, behavior: false, memory: false, advanced: false,
  });
  const [phase, setPhase] = useState<Record<Section, SavePhase>>({
    profile: "idle", identity: "idle", personality: "idle", behavior: "idle", memory: "idle", advanced: "idle",
  });
  const [status, setStatus] = useState<Record<Section, string>>({
    profile: "", identity: "", personality: "", behavior: "", memory: "", advanced: "",
  });
  const [statusCls, setStatusCls] = useState<Record<Section, string>>({
    profile: "", identity: "", personality: "", behavior: "", memory: "", advanced: "",
  });

  // Preferensi lokal (Settings > Tampilan & Percakapan) — lib/prefs.ts
  const [theme, setTheme] = usePref("theme");
  const [font, setFont] = usePref("font");
  const [textSize, setTextSize] = usePref("textSize");
  const [density, setDensity] = usePref("density");
  const [accent, setAccent] = usePref("accent");
  const [animations, setAnimations] = usePref("animations");
  const [enterToSend, setEnterToSend] = usePref("enterToSend");
  const [autoScroll, setAutoScroll] = usePref("autoScroll");
  const [showCode, setShowCode] = usePref("showCode");

  // Feedback kecil "Tersimpan" untuk perubahan preferensi instan
  const [prefSaved, setPrefSaved] = useState(false);
  const prefTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteSaved = () => {
    setPrefSaved(true);
    if (prefTimer.current) clearTimeout(prefTimer.current);
    prefTimer.current = setTimeout(() => setPrefSaved(false), 1500);
  };

  // Data page state
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const [wipeArmed, setWipeArmed] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeMsg, setWipeMsg] = useState("");

  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setShown(true);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (prefTimer.current) clearTimeout(prefTimer.current);
    };
  }, []);

  // Escape → tutup
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    setShown(false);
    setTimeout(onClose, 150);
  };

  /* ---------------- Save per section (database) ---------------- */

  const markDirty = (sec: Section) => {
    setDirty((d) => ({ ...d, [sec]: true }));
    setPhase((p) => ({ ...p, [sec]: "idle" }));
    setStatus((s) => ({ ...s, [sec]: "Belum disimpan" }));
    setStatusCls((s) => ({ ...s, [sec]: "" }));
  };

  const diff = (
    body: Record<string, unknown>,
    reference: Record<string, unknown>,
    fields: string[]
  ): Record<string, unknown> | null => {
    const out: Record<string, unknown> = {};
    let changed = false;
    for (const f of fields) {
      if (body[f] !== undefined && String(body[f] ?? "") !== String(reference[f] ?? "")) {
        out[f] = body[f];
        changed = true;
      }
    }
    return changed ? out : null;
  };

  const persist = async (
    sec: Section,
    endpoint: string,
    body: Record<string, unknown>,
    apply: () => void
  ) => {
    if (phase[sec] === "saving") return; // cegah double-submit
    setPhase((p) => ({ ...p, [sec]: "saving" }));
    setStatus((s) => ({ ...s, [sec]: "Menyimpan…" }));
    setStatusCls((s) => ({ ...s, [sec]: "" }));
    try {
      await apiJson(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      apply();
      setDirty((d) => ({ ...d, [sec]: false }));
      setPhase((p) => ({ ...p, [sec]: "saved" }));
      setStatus((s) => ({ ...s, [sec]: "Tersimpan" }));
      setStatusCls((s) => ({ ...s, [sec]: "ok" }));
      setTimeout(() => setPhase((p) => ({ ...p, [sec]: "idle" })), 1600);
    } catch (err) {
      if ((err as Error).message === "unauthorized") return; // sudah dialihkan
      setDirty((d) => ({ ...d, [sec]: true }));
      setPhase((p) => ({ ...p, [sec]: "failed" }));
      setStatus((s) => ({ ...s, [sec]: (err as Error).message || "Gagal menyimpan. Perubahanmu tetap ada." }));
      setStatusCls((s) => ({ ...s, [sec]: "err" }));
      setTimeout(() => setPhase((p) => ({ ...p, [sec]: "idle" })), 1800);
    }
  };

  const saveProfile = () => {
    if (!dirty.profile) return;
    const body = {
      username: profile.username.trim(),
      display_name: profile.display_name.trim(),
      bio: profile.bio.trim(),
      ...(pendingUserAvatar !== null ? { avatar: pendingUserAvatar } : {}),
    };
    const payload = diff(body, user as unknown as Record<string, unknown>, ["username", "display_name", "bio"]);
    if (pendingUserAvatar !== null && payload) payload.avatar = pendingUserAvatar;
    if (!payload || Object.keys(payload).length === 0) {
      setStatus((s) => ({ ...s, profile: "Tidak ada perubahan." }));
      return;
    }
    void persist("profile", "/api/profile", payload, () => {
      const data = body as unknown as UserProfile;
      onUserUpdate({
        username: data.username,
        display_name: data.display_name,
        bio: data.bio,
        ...(pendingUserAvatar !== null ? { avatar: pendingUserAvatar } : {}),
      });
      setPendingUserAvatar(null);
    });
  };

  const saveIdentity = () => {
    if (!dirty.identity) return;
    const body = {
      bot_name: identity.bot_name.trim(),
      bot_description: identity.bot_description.trim(),
      greeting: identity.greeting.trim(),
    };
    const payload = diff(body, bot as unknown as Record<string, unknown>, ["bot_name", "bot_description", "greeting"]);
    if (pendingBotAvatar !== null && payload) payload.bot_avatar = pendingBotAvatar;
    if (!payload || Object.keys(payload).length === 0) {
      setStatus((s) => ({ ...s, identity: "Tidak ada perubahan." }));
      return;
    }
    void persist("identity", "/api/bot", payload, () => {
      onBotUpdate({ ...(payload as Partial<BotConfig>) });
      setPendingBotAvatar(null);
    });
  };

  const savePersonality = () => {
    if (!dirty.personality) return;
    const payload = diff(
      personality as unknown as Record<string, unknown>,
      bot as unknown as Record<string, unknown>,
      ["traits", "speaking_style", "relationship", "personality"]
    );
    if (!payload) {
      setStatus((s) => ({ ...s, personality: "Tidak ada perubahan." }));
      return;
    }
    void persist("personality", "/api/bot", payload, () => {
      onBotUpdate(payload as Partial<BotConfig>);
    });
  };

  const saveBehavior = () => {
    if (!dirty.behavior) return;
    const payload = diff(
      behavior as unknown as Record<string, unknown>,
      bot as unknown as Record<string, unknown>,
      ["likes", "avoids", "response_length"]
    );
    if (!payload) {
      setStatus((s) => ({ ...s, behavior: "Tidak ada perubahan." }));
      return;
    }
    void persist("behavior", "/api/bot", payload, () => {
      onBotUpdate(payload as Partial<BotConfig>);
    });
  };

  const saveMemory = () => {
    if (!dirty.memory) return;
    if (JSON.stringify(memDraft) === JSON.stringify(bot.memories || [])) {
      setStatus((s) => ({ ...s, memory: "Tidak ada perubahan." }));
      return;
    }
    void persist("memory", "/api/bot", { memories: memDraft }, () => {
      onBotUpdate({ memories: memDraft });
    });
  };

  const saveAdvanced = () => {
    if (!dirty.advanced) return;
    const payload = diff(
      advanced as unknown as Record<string, unknown>,
      bot as unknown as Record<string, unknown>,
      ["system_prompt", "response_style", "language"]
    );
    if (!payload) {
      setStatus((s) => ({ ...s, advanced: "Tidak ada perubahan." }));
      return;
    }
    void persist("advanced", "/api/bot", payload, () => {
      onBotUpdate(payload as Partial<BotConfig>);
    });
  };

  // ---------------- Avatar picker ----------------

  const pickAvatar = async (file: File | undefined, kind: "user" | "bot") => {
    if (!file) return;
    const sec: Section = kind === "user" ? "profile" : "identity";
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setStatus((s) => ({ ...s, [sec]: "Format harus JPG, PNG, atau WebP." }));
      setStatusCls((s) => ({ ...s, [sec]: "err" }));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setStatus((s) => ({ ...s, [sec]: "File terlalu besar (maks 5 MB)." }));
      setStatusCls((s) => ({ ...s, [sec]: "err" }));
      return;
    }
    try {
      const dataUrl = await compressToAvatar(file);
      if (kind === "user") setPendingUserAvatar(dataUrl);
      else setPendingBotAvatar(dataUrl);
      markDirty(sec);
    } catch {
      setStatus((s) => ({ ...s, [sec]: "Gagal memproses gambar." }));
      setStatusCls((s) => ({ ...s, [sec]: "err" }));
    }
  };

  // ---------------- Data page actions ----------------

  const exportData = async () => {
    if (exporting) return;
    setExporting(true);
    setExportMsg("");
    try {
      const data = await apiJson<Record<string, unknown>>("/api/conversations?export=1");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "aomi-data-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportMsg("Tersimpan di unduhanmu.");
    } catch (err) {
      if ((err as Error).message !== "unauthorized") {
        setExportMsg((err as Error).message || "Gagal mengekspor. Coba lagi.");
      }
      setExporting(false);
      return;
    }
    setExporting(false);
  };

  const wipeAll = async () => {
    if (wiping) return;
    setWiping(true);
    try {
      await apiJson("/api/conversations?all=1", { method: "DELETE" });
      setWipeArmed(false);
      setWipeMsg("");
      onConversationsCleared?.();
      noteSaved();
    } catch (err) {
      if ((err as Error).message !== "unauthorized") {
        setWipeMsg((err as Error).message || "Gagal menghapus. Coba lagi.");
      }
    }
    setWiping(false);
  };

  // ---------------- Render helpers ----------------

  const saveBtn = (sec: Section) => {
    const p = phase[sec];
    const label =
      p === "saving" ? "Menyimpan…" : p === "saved" ? "Tersimpan" : p === "failed" ? "Gagal menyimpan" : "Simpan perubahan";
    return (
      <button
        className={"btn-primary" + (p === "saving" ? " saving" : "")}
        type="button"
        disabled={p === "saving" || p === "saved" || !dirty[sec]}
        onClick={() => {
          if (sec === "profile") saveProfile();
          else if (sec === "identity") saveIdentity();
          else if (sec === "personality") savePersonality();
          else if (sec === "behavior") saveBehavior();
          else if (sec === "memory") saveMemory();
          else saveAdvanced();
        }}
      >
        {label}
      </button>
    );
  };

  const statusEl = (sec: Section) => (
    <span className={"save-status " + statusCls[sec]}>{status[sec]}</span>
  );

  const previewLine = PREVIEW_LINES[personality.speaking_style] || PREVIEW_LINES.casual;

  const navItems = [
    { id: "profile", icon: "user", label: "Profil" },
    { id: "bot", icon: "logo", label: "Karakter" },
    { id: "appearance", icon: "sliders", label: "Tampilan" },
    { id: "conversation", icon: "message", label: "Percakapan" },
    { id: "data", icon: "archive", label: "Data" },
    { id: "account", icon: "shield", label: "Akun" },
  ];

  const goCat = (id: string) => {
    setCat(id);
    setPageOpen(true);
    if (id !== "bot") setBotPage("identity");
  };

  // Pembantu perubahan preferensi instan: simpan + feedback kecil
  const change = <T,>(setter: (v: T) => void, v: T) => {
    setter(v);
    noteSaved();
  };

  const themeOptions: { val: ThemeChoice; label: string; mock: "dark" | "light" | "auto" }[] = [
    { val: "dark", label: "Gelap", mock: "dark" },
    { val: "light", label: "Terang", mock: "light" },
    { val: "system", label: "Sistem", mock: "auto" },
  ];

  const sizeIdx = (["small", "medium", "large"] as const).indexOf(textSize);

  return (
    <div className={"settings-view" + (shown ? " open" : "")} id="settingsView">
      <div className={"settings-shell" + (pageOpen ? " page-open" : "")} id="settingsShell">
        <nav className="settings-nav" id="settingsNav" aria-label="Kategori pengaturan">
          <header className="settings-nav-head">
            <div className="settings-nav-titles">
              <h2>Pengaturan</h2>
              <p>Atur pengalaman Aomi sesuai keinginanmu.</p>
            </div>
            <button className="icon-btn" aria-label="Tutup pengaturan" onClick={close}>
              <svg className="icon" aria-hidden="true"><use href="/icons.svg#close" /></svg>
            </button>
          </header>
          <div className="settings-nav-list" id="settingsNavList">
            {navItems.map((n) => (
              <button
                key={n.id}
                className={"settings-nav-item" + (cat === n.id ? " active" : "")}
                onClick={() => goCat(n.id)}
              >
                <svg className="icon" aria-hidden="true"><use href={`/icons.svg#${n.icon}`} /></svg>
                <span>{n.label}</span>
                <svg className="icon nav-chev" aria-hidden="true"><use href="/icons.svg#chevron-left" /></svg>
              </button>
            ))}
          </div>
          <div className="settings-nav-foot">
            <span className="avatar small">
              {user.avatar ? (
                <img src={user.avatar} alt="" aria-hidden="true" />
              ) : (
                <svg className="icon" aria-hidden="true"><use href="/icons.svg#user" /></svg>
              )}
            </span>
            <div className="nav-foot-meta">
              <span className="nav-foot-name">{user.display_name || user.username || "Kamu"}</span>
              <span className="nav-foot-sub">{user.email || "Tersimpan di akunmu"}</span>
            </div>
          </div>
        </nav>

        <main className="settings-main" id="settingsMain">
          <button className="settings-back" onClick={() => setPageOpen(false)}>
            <svg className="icon" aria-hidden="true"><use href="/icons.svg#chevron-left" /></svg>
            <span>Pengaturan</span>
          </button>

          {/* ========== PROFIL ========== */}
          <section className={"settings-page" + (cat === "profile" ? " active" : "")}>
            <header className="page-head">
              <h3>Profil</h3>
              <p className="page-desc">Identitasmu di aplikasi ini.</p>
            </header>
            <div className="panel">
              <div className="avatar-edit">
                <span className="avatar big">
                  {pendingUserAvatar || user.avatar ? (
                    <img src={pendingUserAvatar || user.avatar || ""} alt="" aria-hidden="true" />
                  ) : (
                    <svg className="icon" aria-hidden="true"><use href="/icons.svg#user" /></svg>
                  )}
                </span>
                <div className="meta">
                  <label className="link-btn" htmlFor="profileAvatarFile">
                    <svg className="icon" aria-hidden="true"><use href="/icons.svg#image" /></svg>
                    Ganti foto profil
                  </label>
                  <span className="hint">JPG/PNG/WebP, otomatis dikecilkan ke 256×256.</span>
                </div>
                <input
                  id="profileAvatarFile"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={(e) => {
                    void pickAvatar(e.target.files?.[0], "user");
                    e.target.value = "";
                  }}
                />
              </div>
              <div className="form-rows">
                <label className="field">
                  <span>Username</span>
                  <input
                    type="text"
                    maxLength={20}
                    autoComplete="username"
                    value={profile.username}
                    onChange={(e) => {
                      setProfile({ ...profile, username: e.target.value });
                      markDirty("profile");
                    }}
                  />
                  <small className="field-hint">3-20 karakter: huruf, angka, underscore.</small>
                </label>
                <label className="field">
                  <span>Nama tampilan</span>
                  <input
                    type="text"
                    maxLength={40}
                    value={profile.display_name}
                    onChange={(e) => {
                      setProfile({ ...profile, display_name: e.target.value });
                      markDirty("profile");
                    }}
                  />
                  <small className="field-hint">Tampil di samping pesanmu.</small>
                </label>
                <label className="field">
                  <span>Bio</span>
                  <textarea
                    maxLength={200}
                    rows={2}
                    value={profile.bio}
                    onChange={(e) => {
                      setProfile({ ...profile, bio: e.target.value });
                      markDirty("profile");
                    }}
                  />
                </label>
              </div>
            </div>
            <div className="save-row">
              {saveBtn("profile")}
              {statusEl("profile")}
            </div>
          </section>

          {/* ========== KARAKTER ========== */}
          <section className={"settings-page" + (cat === "bot" ? " active" : "")}>
            <header className="page-head">
              <h3>Karakter</h3>
              <p className="page-desc">Siapa dia, bagaimana ia bicara, dan apa yang ia ingat.</p>
            </header>

            <div className="subnav">
              {[
                ["identity", "Identitas"],
                ["personality", "Personality"],
                ["behavior", "Perilaku"],
                ["memory", "Memory"],
                ["advanced", "Advanced"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={"subnav-item" + (botPage === id ? " active" : "")}
                  onClick={() => setBotPage(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* --- Identitas --- */}
            <div className={"bot-page" + (botPage === "identity" ? " active" : "")}>
              <div className="bot-preview">
                <span className="avatar">
                  {pendingBotAvatar || bot.bot_avatar ? (
                    <img src={pendingBotAvatar || bot.bot_avatar || ""} alt="" aria-hidden="true" />
                  ) : (
                    <svg className="icon" aria-hidden="true"><use href="/icons.svg#logo" /></svg>
                  )}
                </span>
                <div className="bp-body">
                  <div className="bp-name">{identity.bot_name.trim() || "Aomi"}</div>
                  <div className="bp-desc">{identity.bot_description.trim() || "Companion pribadimu."}</div>
                  <div className="bp-line">{previewLine}</div>
                </div>
              </div>

              <div className="panel">
                <div className="avatar-edit">
                  <span className="avatar big">
                    {pendingBotAvatar || bot.bot_avatar ? (
                      <img src={pendingBotAvatar || bot.bot_avatar || ""} alt="" aria-hidden="true" />
                    ) : (
                      <svg className="icon" aria-hidden="true"><use href="/icons.svg#logo" /></svg>
                    )}
                  </span>
                  <div className="meta">
                    <label className="link-btn" htmlFor="botAvatarFile">
                      <svg className="icon" aria-hidden="true"><use href="/icons.svg#image" /></svg>
                      Ganti avatar
                    </label>
                    <span className="hint">Wajah karakter — tampil di header chat dan pesannya.</span>
                  </div>
                  <input
                    id="botAvatarFile"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    hidden
                    onChange={(e) => {
                      void pickAvatar(e.target.files?.[0], "bot");
                      e.target.value = "";
                    }}
                  />
                </div>
                <div className="form-rows">
                  <label className="field">
                    <span>Nama karakter</span>
                    <input
                      type="text"
                      maxLength={40}
                      value={identity.bot_name}
                      onChange={(e) => {
                        setIdentity({ ...identity, bot_name: e.target.value });
                        markDirty("identity");
                      }}
                    />
                    <small className="field-hint">Nama panggilan yang kamu pakai untuk dia.</small>
                  </label>
                  <label className="field">
                    <span>Deskripsi singkat</span>
                    <input
                      type="text"
                      maxLength={120}
                      placeholder="Companion pribadimu."
                      value={identity.bot_description}
                      onChange={(e) => {
                        setIdentity({ ...identity, bot_description: e.target.value });
                        markDirty("identity");
                      }}
                    />
                    <small className="field-hint">Satu kalimat tentang siapa dia untukmu.</small>
                  </label>
                  <label className="field">
                    <span>Sapaan pertama (opsional)</span>
                    <input
                      type="text"
                      maxLength={200}
                      placeholder="Kosongkan agar dia menyapa dengan caranya sendiri."
                      value={identity.greeting}
                      onChange={(e) => {
                        setIdentity({ ...identity, greeting: e.target.value });
                        markDirty("identity");
                      }}
                    />
                    <small className="field-hint">Pesan pertamanya setiap kali kamu mulai chat baru.</small>
                  </label>
                </div>
              </div>
              <div className="save-row">
                {saveBtn("identity")}
                {statusEl("identity")}
              </div>
            </div>

            {/* --- Personality --- */}
            <div className={"bot-page" + (botPage === "personality" ? " active" : "")}>
              <div className="panel">
                <h4 className="card-title">Sifatnya</h4>
                <p className="card-desc">Pilih sifat — cara dia memperlakukanmu mengikuti ini.</p>
                <div className="trait-grid">
                  {TRAITS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={"trait-chip" + (personality.traits.includes(t.id) ? " active" : "")}
                      onClick={() => {
                        setPersonality({
                          ...personality,
                          traits: personality.traits.includes(t.id)
                            ? personality.traits.filter((x) => x !== t.id)
                            : [...personality.traits, t.id],
                        });
                        markDirty("personality");
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="panel">
                <h4 className="card-title">Hubungan kalian</h4>
                <Segmented
                  options={RELATIONSHIPS}
                  value={personality.relationship}
                  onChange={(v) => {
                    setPersonality({ ...personality, relationship: v });
                    markDirty("personality");
                  }}
                />
              </div>

              <div className="panel">
                <h4 className="card-title">Cara dia bicara</h4>
                <Segmented
                  options={SPEAKING_STYLES}
                  value={personality.speaking_style}
                  onChange={(v) => {
                    setPersonality({ ...personality, speaking_style: v });
                    markDirty("personality");
                  }}
                />
              </div>

              <div className="panel">
                <h4 className="card-title">Tulis kepribadiannya sendiri</h4>
                <p className="card-desc">Bebas — cara kamu mendeskripsikan dia ke teman.</p>
                <label className="field">
                  <textarea
                    maxLength={3000}
                    rows={4}
                    placeholder="Mis. Dia pendiem pada awal, tapi jadi usil begitu dekat. Suka iseng dan balas chat dengan singkat."
                    value={personality.personality}
                    onChange={(e) => {
                      setPersonality({ ...personality, personality: e.target.value });
                      markDirty("personality");
                    }}
                  />
                  <small className="field-hint counter">{personality.personality.length}/3000</small>
                </label>
              </div>
              <div className="save-row">
                {saveBtn("personality")}
                {statusEl("personality")}
              </div>
            </div>

            {/* --- Perilaku --- */}
            <div className={"bot-page" + (botPage === "behavior" ? " active" : "")}>
              <div className="panel">
                <h4 className="card-title">Hal yang dia suka</h4>
                <p className="card-desc">Topik, kebiasaan, atau hal kecil yang bikin dia semangat.</p>
                <label className="field">
                  <textarea
                    maxLength={300}
                    rows={2}
                    placeholder="Mis. ngobrol di tengah malam, cerita random kamu, musik lo-fi."
                    value={behavior.likes}
                    onChange={(e) => {
                      setBehavior({ ...behavior, likes: e.target.value });
                      markDirty("behavior");
                    }}
                  />
                </label>
              </div>
              <div className="panel">
                <h4 className="card-title">Hal yang dia hindari</h4>
                <p className="card-desc">Biar dia tahu batas dan nyaman-nya di mana.</p>
                <label className="field">
                  <textarea
                    maxLength={300}
                    rows={2}
                    placeholder="Mis. dibanding-bandingkan, small talk formal, spoiler film."
                    value={behavior.avoids}
                    onChange={(e) => {
                      setBehavior({ ...behavior, avoids: e.target.value });
                      markDirty("behavior");
                    }}
                  />
                </label>
              </div>
              <div className="panel">
                <h4 className="card-title">Panjang balasan</h4>
                <Segmented
                  options={LENGTHS}
                  value={behavior.response_length}
                  onChange={(v) => {
                    setBehavior({ ...behavior, response_length: v as BotConfig["response_length"] });
                    markDirty("behavior");
                  }}
                />
              </div>
              <div className="save-row">
                {saveBtn("behavior")}
                {statusEl("behavior")}
              </div>
            </div>

            {/* --- Memory --- */}
            <div className={"bot-page" + (botPage === "memory" ? " active" : "")}>
              <div className="panel">
                <h4 className="card-title">Yang dia ingat tentang kamu</h4>
                <p className="card-desc">Tulis hal-hal penting — dia akan menyebutnya secara alami saat relevan.</p>
                <div className="memory-add">
                  <input
                    type="text"
                    maxLength={200}
                    placeholder="Mis. Aku ada ujian besok pagi."
                    value={memoryInput}
                    onChange={(e) => setMemoryInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addMemory();
                      }
                    }}
                  />
                  <button className="btn-ghost" type="button" onClick={addMemory}>
                    Ingatkan
                  </button>
                </div>
                <ul className="memory-list">
                  {memDraft.length === 0 ? (
                    <li className="memory-empty">Belum ada. Tulis sesuatu di atas — hal yang kamu mau Aomi inget terus, misalnya sifat atau kebiasaanmu.</li>
                  ) : (
                    memDraft.map((text, i) => (
                      <li key={i} className="memory-item">
                        <span>{text}</span>
                        <button
                          className="memory-del"
                          aria-label="Hapus dari memori"
                          onClick={() => {
                            setMemDraft(memDraft.filter((_, j) => j !== i));
                            markDirty("memory");
                          }}
                        >
                          <svg className="icon" aria-hidden="true"><use href="/icons.svg#close" /></svg>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </div>
              <div className="save-row">
                {saveBtn("memory")}
                {statusEl("memory")}
              </div>
            </div>

            {/* --- Advanced --- */}
            <div className={"bot-page" + (botPage === "advanced" ? " active" : "")}>
              <details className="advanced-box">
                <summary>Pengaturan lanjutan</summary>
                <div className="panel">
                  <h4 className="card-title">Instruksi teknis tambahan</h4>
                  <p className="card-desc">Untuk yang paham prompt. Karakter tetap menaati kepribadiannya.</p>
                  <label className="field">
                    <textarea
                      maxLength={1000}
                      rows={4}
                      placeholder="Mis. Jangan pernah pakai emoji. Selalu balas dalam satu paragraf."
                      value={advanced.system_prompt}
                      onChange={(e) => {
                        setAdvanced({ ...advanced, system_prompt: e.target.value });
                        markDirty("advanced");
                      }}
                    />
                    <small className="field-hint counter">{advanced.system_prompt.length}/1000</small>
                  </label>
                </div>
                <div className="panel">
                  <h4 className="card-title">Formalitas bahasa</h4>
                  <Segmented
                    options={TONES}
                    value={advanced.response_style}
                    onChange={(v) => {
                      setAdvanced({ ...advanced, response_style: v as BotConfig["response_style"] });
                      markDirty("advanced");
                    }}
                  />
                </div>
                <div className="panel">
                  <h4 className="card-title">Bahasa</h4>
                  <Segmented
                    options={LANGS}
                    value={advanced.language}
                    onChange={(v) => {
                      setAdvanced({ ...advanced, language: v as BotConfig["language"] });
                      markDirty("advanced");
                    }}
                  />
                  <p className="card-desc">Otomatis: mengikuti bahasa pesanmu.</p>
                </div>
                <div className="save-row">
                  {saveBtn("advanced")}
                  {statusEl("advanced")}
                </div>
              </details>
            </div>
          </section>

          {/* ========== TAMPILAN ========== */}
          <section className={"settings-page" + (cat === "appearance" ? " active" : "")}>
            <header className="page-head">
              <h3>Tampilan</h3>
              <p className="page-desc">
                Sesuaikan kenyamanan baca.{" "}
                <span className={"pref-saved" + (prefSaved ? " show" : "")} aria-live="polite">
                  Tersimpan
                </span>
              </p>
            </header>

            {/* Preview live — refleksi real-time semua pilihan di bawah */}
            <div className="chat-preview" aria-hidden="true">
              <div className="cp-title">Tampilan percakapan</div>
              <div className="cp-body">
                <div className="cp-row bot">
                  <span className="cp-bubble">{identity.bot_name.trim() || "Aomi"}</span>
                </div>
                <div className="cp-row user">
                  <span className="cp-bubble">Ini contoh pesanmu.</span>
                </div>
              </div>
            </div>

            <div className="panel">
              <Row title="Tema" desc="Pilih tampilan Aomi.">
                <div className="theme-cards" role="group" aria-label="Tema">
                  {themeOptions.map((t) => (
                    <button
                      key={t.val}
                      type="button"
                      className={"theme-card" + (theme === t.val ? " active" : "")}
                      aria-pressed={theme === t.val}
                      onClick={() => change<ThemeChoice>(setTheme, t.val)}
                    >
                      <span className={"tc-mock tc-" + t.mock}>
                        <span className="tc-line a" />
                        <span className="tc-line b" />
                      </span>
                      <span className="tc-label">{t.label}</span>
                    </button>
                  ))}
                </div>
              </Row>

              <Row title="Font" desc="Pilih font yang digunakan.">
                <div className="font-list" role="group" aria-label="Font">
                  {(Object.keys(FONT_STACKS) as FontChoice[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={"font-opt" + (font === f ? " active" : "")}
                      aria-pressed={font === f}
                      style={{ fontFamily: FONT_STACKS[f] }}
                      onClick={() => change<FontChoice>(setFont, f)}
                    >
                      {FONT_LABELS[f]}
                      <span className="font-sample">Contoh teks Aomi.</span>
                    </button>
                  ))}
                </div>
              </Row>

              <Row title="Ukuran teks" desc="Sesuaikan ukuran tulisan di percakapan.">
                <div className="size-slider">
                  <span className="size-a" aria-hidden="true">A</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={1}
                    value={sizeIdx}
                    aria-label="Ukuran teks"
                    aria-valuetext={["Kecil", "Sedang", "Besar"][sizeIdx]}
                    onChange={(e) => {
                      const v = (["small", "medium", "large"] as const)[Number(e.target.value)];
                      if (v !== textSize) change(setTextSize, v);
                    }}
                  />
                  <span className="size-a big" aria-hidden="true">A</span>
                  <span className="size-label">{["Kecil", "Sedang", "Besar"][sizeIdx]}</span>
                </div>
              </Row>

              <Row title="Kerapatan" desc="Jarak antar pesan dan padatnya ruang chat.">
                <Segmented
                  ariaLabel="Kerapatan percakapan"
                  options={(Object.keys(DENSITY_VALS) as DensityChoice[]).map((d) => ({
                    val: d,
                    label: d === "comfortable" ? "Nyaman" : d === "medium" ? "Sedang" : "Padat",
                  }))}
                  value={density}
                  onChange={(v) => change<DensityChoice>(setDensity, v as DensityChoice)}
                />
              </Row>

              <Row title="Accent" desc="Satu warna aksen — semuanya masih hangat.">
                <div className="accent-row" role="group" aria-label="Warna aksen">
                  {(Object.keys(ACCENT_VALS) as AccentChoice[]).map((a) => (
                    <button
                      key={a}
                      type="button"
                      className={"accent-opt" + (accent === a ? " active" : "")}
                      aria-pressed={accent === a}
                      title={ACCENT_VALS[a].label}
                      onClick={() => change<AccentChoice>(setAccent, a)}
                    >
                      <span className="dot" style={{ background: ACCENT_VALS[a].a }} />
                      <span className="accent-name">{ACCENT_VALS[a].label}</span>
                    </button>
                  ))}
                </div>
              </Row>

              <Row title="Animasi antarmuka" desc="Transisi drawer, pesan masuk, dan interaksi tombol.">
                <Switch
                  checked={animations}
                  onChange={(v) => change(setAnimations, v)}
                  label="Animasi antarmuka"
                />
              </Row>
            </div>
            <p className="pref-note">
              Tersimpan otomatis di perangkat ini — tetap aktif setelah kamu menutup Aomi.
            </p>
          </section>

          {/* ========== PERCAKAPAN ========== */}
          <section className={"settings-page" + (cat === "conversation" ? " active" : "")}>
            <header className="page-head">
              <h3>Percakapan</h3>
              <p className="page-desc">
                Cara chatmu berperilaku.{" "}
                <span className={"pref-saved" + (prefSaved ? " show" : "")} aria-live="polite">
                  Tersimpan
                </span>
              </p>
            </header>
            <div className="panel">
              <Row title="Enter untuk mengirim" desc="Jika mati, Enter membuat baris baru — kirim lewat tombol.">
                <Switch checked={enterToSend} onChange={(v) => change(setEnterToSend, v)} label="Enter untuk mengirim" />
              </Row>
              <Row title="Auto-scroll saat respons" desc="Jika mati, tampilan tidak mengikuti balasan baru — kamu bebas membaca pesan lama.">
                <Switch checked={autoScroll} onChange={(v) => change(setAutoScroll, v)} label="Auto-scroll saat respons" />
              </Row>
              <Row title="Tampilkan blok kode" desc="Balasan berformat kode ditampilkan rapi. Jika mati, tampil sebagai teks biasa.">
                <Switch checked={showCode} onChange={(v) => change(setShowCode, v)} label="Tampilkan blok kode" />
              </Row>
            </div>
          </section>

          {/* ========== DATA ========== */}
          <section className={"settings-page" + (cat === "data" ? " active" : "")}>
            <header className="page-head">
              <h3>Data</h3>
              <p className="page-desc">Riwayat percakapanmu tersimpan di akunmu — milikmu sepenuhnya.</p>
            </header>
            <div className="panel">
              <Row title="Ekspor data" desc={exportMsg || "Unduh seluruh percakapanmu sebagai satu file JSON."}>
                <button
                  className="btn-ghost"
                  type="button"
                  disabled={exporting}
                  onClick={() => void exportData()}
                >
                  <svg className="icon" aria-hidden="true"><use href="/icons.svg#download" /></svg>
                  {exporting ? "Menyiapkan…" : "Unduh"}
                </button>
              </Row>

              <Row
                title="Hapus semua percakapan"
                desc="Tindakan ini tidak dapat dibatalkan."
              >
                {wipeArmed ? (
                  <span className="confirm-inline" role="alertdialog" aria-label="Konfirmasi hapus semua percakapan">
                    <button
                      className="btn-ghost"
                      type="button"
                      disabled={wiping}
                      onClick={() => {
                        setWipeArmed(false);
                        setWipeMsg("");
                      }}
                    >
                      Batal
                    </button>
                    <button
                      className="btn-danger"
                      type="button"
                      disabled={wiping}
                      onClick={() => void wipeAll()}
                    >
                      {wiping ? "Menghapus…" : "Hapus semua"}
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn-ghost danger"
                    type="button"
                    onClick={() => setWipeArmed(true)}
                  >
                    <svg className="icon" aria-hidden="true"><use href="/icons.svg#trash" /></svg>
                    Hapus
                  </button>
                )}
              </Row>
              {wipeMsg && <p className="wipe-msg err">{wipeMsg}</p>}
              {prefSaved && (
                <p className="wipe-msg ok" aria-live="polite">Semua percakapan dihapus.</p>
              )}

              <Row title="Memory Aomi" desc="Hal-hal yang dia ingat tentang kamu — dikelola di Karakter.">
                <button
                  className="btn-ghost"
                  type="button"
                  onClick={() => {
                    setBotPage("memory");
                    goCat("bot");
                  }}
                >
                  Kelola
                </button>
              </Row>
            </div>
          </section>

          {/* ========== AKUN ========== */}
          <section className={"settings-page" + (cat === "account" ? " active" : "")}>
            <header className="page-head">
              <h3>Akun</h3>
              <p className="page-desc">Informasi akun dan sesi login.</p>
            </header>
            <div className="panel">
              <div className="account-hero">
                <span className="avatar big">
                  {user.avatar ? (
                    <img src={user.avatar} alt="" aria-hidden="true" />
                  ) : (
                    <svg className="icon" aria-hidden="true"><use href="/icons.svg#user" /></svg>
                  )}
                </span>
                <div className="account-hero-meta">
                  <span className="account-hero-name">{user.display_name || user.username || "…"}</span>
                  <span className="account-hero-mail">{user.email || "…"}</span>
                </div>
              </div>
              <div className="account-rows">
                <div className="account-row">
                  <span className="account-label">Username</span>
                  <span className="account-value">{profile.username || "…"}</span>
                </div>
                <div className="account-row">
                  <span className="account-label">Email</span>
                  <span className="account-value">{user.email || "…"}</span>
                </div>
                <div className="account-row">
                  <span className="account-label">Metode login</span>
                  <span className="account-value">
                    {user.google_linked ? "Google (terhubung)" : "Email & kata sandi"}
                  </span>
                </div>
              </div>
            </div>
            <div className="panel">
              <h4 className="linked-title">Akun terhubung</h4>
              <p className="card-desc">
                Hubungkan cara masuk lain biar gampang — satu akun Aomi, banyak pintu.
              </p>
              <div className="linked-rows">
                {LINKED_PROVIDERS.map((p) => {
                  const connected = user.providers?.[p.id] || false;
                  const enabled = enabledProviders[p.id] || connected;
                  const busy = linkedBusy === p.id;
                  return (
                    <div className={"linked-row" + (connected ? " on" : "")} key={p.id}>
                      <svg className="linked-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path fill={p.color} d={p.svg} />
                      </svg>
                      <div className="linked-meta">
                        <span className="linked-name">{p.label}</span>
                        <span className="linked-state">
                          {connected ? "Terhubung" : enabled ? "Belum terhubung" : "Belum tersedia"}
                        </span>
                      </div>
                      {!enabled ? null : connected ? (
                        <button
                          className="btn-mini ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => void disconnectProvider(p.id)}
                        >
                          {busy ? "…" : "Putuskan"}
                        </button>
                      ) : p.id === "telegram" ? (
                        <button
                          className="btn-mini"
                          type="button"
                          disabled={busy}
                          onClick={() => setTgLinkOpen(true)}
                        >
                          Hubungkan
                        </button>
                      ) : (
                        <button
                          className="btn-mini"
                          type="button"
                          disabled={busy}
                          onClick={() => void connectProvider(p.id)}
                        >
                          {busy ? "…" : "Hubungkan"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {linkedStatus && <p className="linked-status" role="status">{linkedStatus}</p>}
              {tgLinkOpen && (
                <div className="linked-tg-modal">
                  <TelegramAuth
                    mode="link"
                    botUsername={botUsername}
                    onLoginSuccess={() => setTgLinkOpen(false)}
                    onLinked={() => {
                      setTgLinkOpen(false);
                      setLinkedStatus("Telegram berhasil dihubungkan.");
                      void refreshLinked();
                    }}
                    onCancel={() => setTgLinkOpen(false)}
                  />
                </div>
              )}
              <p className="card-desc">
                Kamu tidak bisa melepas satu-satunya cara masuk — pastikan masih ada
                password atau minimal satu provider lain.
              </p>
            </div>
            <div className="panel">
              <button className="btn-ghost danger" type="button" onClick={() => void onLogout()}>
                <svg className="icon" aria-hidden="true"><use href="/icons.svg#logout" /></svg>
                Keluar dari akun
              </button>
              <p className="card-desc">Sesi &quot;Ingat saya&quot; bertahan 30 hari; tanpa itu, 12 jam.</p>
            </div>
            <p className="app-credit">
              Aomi dikembangkan oleh{" "}
              <a
                href="https://whatsapp.com/channel/0029Vb8AgskLY6dCvnTjxU3c"
                target="_blank"
                rel="noopener noreferrer"
              >
                Akira
              </a>
              .
            </p>
          </section>
        </main>
      </div>
    </div>
  );

  function addMemory() {
    const v = memoryInput.trim();
    if (!v) return;
    if (memDraft.length >= 12) {
      setStatus((s) => ({ ...s, memory: "Maksimal 12 hal yang bisa dia inget sekaligus." }));
      setStatusCls((s) => ({ ...s, memory: "err" }));
      return;
    }
    setMemDraft([...memDraft, v]);
    setMemoryInput("");
    markDirty("memory");
  }
}
