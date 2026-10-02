"use client";

/* ============================================================
   Aomi — components/settings/SettingsView.tsx
   Settings overlay (SPA, tanpa reload). Port dari js/settings.js:
   navigasi kategori, preview karakter realtime, save parsial
   (hanya field berubah), avatar picker, memory draft, appearance.
   ============================================================ */

import { useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/client-api";
import { compressToAvatar } from "@/lib/image";
import type { BotConfig, UserProfile } from "@/types";

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

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { val: string; label: string }[];
  value: string;
  onChange: (val: string) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.val}
          type="button"
          className={"seg-btn" + (value === o.val ? " active" : "")}
          onClick={() => onChange(o.val)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function SettingsView({
  initialCategory,
  user,
  bot,
  onClose,
  onUserUpdate,
  onBotUpdate,
  onLogout,
}: {
  initialCategory: string;
  user: UserProfile;
  bot: BotConfig;
  onClose: () => void;
  onUserUpdate: (u: Partial<UserProfile>) => void;
  onBotUpdate: (b: Partial<BotConfig>) => void;
  onLogout: () => void | Promise<void>;
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
  const [fontSize, setFontSize] = useState("15");

  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setShown(true);
    });
    try {
      setFontSize(localStorage.getItem("aomi.fontSize") || "15");
    } catch { /* private */ }
    return () => cancelAnimationFrame(raf);
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
      const data = await apiJson(endpoint, {
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

  // ---------------- Save per section ----------------

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

  // ---------------- Render ----------------

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
    { id: "account", icon: "shield", label: "Akun" },
  ];

  return (
    <div className={"settings-view" + (shown ? " open" : "")} id="settingsView">
      <div className={"settings-shell" + (pageOpen ? " page-open" : "")} id="settingsShell">
        <nav className="settings-nav" id="settingsNav">
          <header className="settings-nav-head">
            <span className="avatar small">
              <svg className="icon" aria-hidden="true"><use href="/icons.svg#logo" /></svg>
            </span>
            <h2>Pengaturan</h2>
            <button className="icon-btn" aria-label="Tutup pengaturan" onClick={close}>
              <svg className="icon" aria-hidden="true"><use href="/icons.svg#close" /></svg>
            </button>
          </header>
          <div className="settings-nav-list" id="settingsNavList">
            {navItems.map((n) => (
              <button
                key={n.id}
                className={"settings-nav-item" + (cat === n.id ? " active" : "")}
                onClick={() => {
                  setCat(n.id);
                  setPageOpen(true);
                }}
              >
                <svg className="icon" aria-hidden="true"><use href={`/icons.svg#${n.icon}`} /></svg>
                <span>{n.label}</span>
              </button>
            ))}
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
            <div className="section-card">
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

              <div className="section-card">
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
              <div className="section-card">
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

              <div className="section-card">
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

              <div className="section-card">
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

              <div className="section-card">
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
              <div className="section-card">
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
              <div className="section-card">
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
              <div className="section-card">
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
              <div className="section-card">
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
                <div className="section-card">
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
                <div className="section-card">
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
                <div className="section-card">
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
              <p className="page-desc">Sesuaikan kenyamanan baca.</p>
            </header>
            <div className="section-card">
              <h4 className="card-title">Ukuran teks chat</h4>
              <Segmented
                options={[
                  { val: "15", label: "Normal" },
                  { val: "16.5", label: "Besar" },
                ]}
                value={fontSize}
                onChange={(v) => {
                  setFontSize(v);
                  document.documentElement.style.setProperty("--chat-fs", v + "px");
                  try {
                    localStorage.setItem("aomi.fontSize", v);
                  } catch { /* private mode */ }
                }}
              />
              <p className="card-desc">Langsung berlaku di percakapan.</p>
            </div>
          </section>

          {/* ========== AKUN ========== */}
          <section className={"settings-page" + (cat === "account" ? " active" : "")}>
            <header className="page-head">
              <h3>Akun</h3>
              <p className="page-desc">Informasi akun dan sesi login.</p>
            </header>
            <div className="section-card">
              <div className="account-row">
                <span className="account-label">Email</span>
                <span className="account-value">{user.email || "…"}</span>
              </div>
              <div className="account-row">
                <span className="account-label">Username</span>
                <span className="account-value">{profile.username || "…"}</span>
              </div>
            </div>
            <div className="section-card">
              <button className="btn-ghost danger" type="button" onClick={() => void onLogout()}>
                <svg className="icon" aria-hidden="true"><use href="/icons.svg#logout" /></svg>
                Keluar dari akun
              </button>
              <p className="card-desc">Sesi &quot;Ingat saya&quot; bertahan 30 hari; tanpa itu, 12 jam.</p>
            </div>
          </section>
        </main>
      </div>
    </div>
  );

  function addMemory() {
    const v = memoryInput.trim();
    if (!v) return;
    if (memDraft.length >= 12) {
      setStatus((s) => ({ ...s, memory: "Maksimal 12 hal yang bisa dia ingat sekaligus." }));
      setStatusCls((s) => ({ ...s, memory: "err" }));
      return;
    }
    setMemDraft([...memDraft, v]);
    setMemoryInput("");
    markDirty("memory");
  }
}
