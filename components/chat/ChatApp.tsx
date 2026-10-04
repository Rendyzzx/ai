"use client";

/* ============================================================
   Aomi — components/chat/ChatApp.tsx
   Orchestrator aplikasi chat. Port dari js/app.js + js/chat.js:
   gerbang auth bertahap, render windowed (cap DOM 150 node,
   batch 30), kirim pesan, edit foto 2-tahap, downloader,
   aksi pesan (copy/edit/regenerate/delete), keyboard mobile.
   ============================================================ */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, apiJson } from "@/lib/client-api";
import { getSessionId } from "@/lib/session";
import { sanitizeText, compressImage } from "@/lib/image";
import Sidebar from "@/components/sidebar/Sidebar";
import MessageRow, {
  IndicatorRow,
  type Indicator,
  type MessageFile,
} from "@/components/chat/MessageRow";
import MessageMenu, { type MenuState } from "@/components/chat/MessageMenu";
import { useVoiceCall, VoiceCallOverlay } from "./VoiceCall";
import { speechRecognitionSupported } from "@/lib/voice";
import ConfirmDialog from "@/components/chat/ConfirmDialog";
import SavedView from "@/components/chat/SavedView";
// Settings (±40KB) jarang dibuka → dynamic import, keluar dari
// initial chat bundle. ssr:false aman: ChatApp sendiri client-only.
import dynamic from "next/dynamic";
const SettingsView = dynamic(() => import("@/components/settings/SettingsView"), {
  ssr: false,
  loading: () => <div className="chat-gate" aria-hidden="true" />,
});
import { fileOf, dlOf, musicOf, hdOf, matchMusicRequest, matchImageGenRequest, matchHdRequest, EDIT_API, EDIT_BROWSER_TIMEOUT, EDIT_RESULT_MAX, EDIT_TRIGGER_RE, matchDlTarget, IMG_GEN_API, IMG_GEN_TIMEOUT, HD_TRIGGER_RE } from "@/lib/chat-utils";
import { isVideoFile, uploadVideo, extractVideoFrames } from "@/lib/video";
import { useMusic } from "@/components/music/MusicProvider";
import { applyAllVisualPrefs, usePref } from "@/lib/prefs";
import type { BotConfig, ChatResponse, Conversation, ConversationItem, Message, UserProfile } from "@/types";

const RENDER_BATCH = 30;
const DOM_CAP = 150;

/** Quick action (layar sambutan): isi composer, user yang kirim. */
const QUICK_ACTIONS = [
  { icon: "idea", label: "Cari ide", text: "bantu aku cari ide menarik ya" },
  { icon: "code", label: "Coding", text: "aku mau nanya soal coding, bantuin ya" },
  { icon: "edit", label: "Menulis", text: "bantuin aku bikin tulisan ya" },
  { icon: "book", label: "Jelaskan", text: "jelasin sesuatu ke aku dengan cara yang gampang dipahami ya" },
];

const DEFAULT_USER: UserProfile = {
  username: "",
  display_name: "",
  bio: "",
  avatar: null,
  email: "",
  google_linked: false,
};

const DEFAULT_BOT_STATE: BotConfig = {
  bot_name: "Aomi",
  bot_description: "",
  bot_avatar: null,
  personality: "",
  traits: ["playful", "caring"],
  speaking_style: "casual",
  relationship: "companion",
  greeting: "",
  likes: "",
  avoids: "",
  memories: [],
  system_prompt: "",
  language: "auto",
  response_length: "balanced",
  response_style: "casual",
  personality_preset: "friendly",
};

type Boot = "loading" | "ready" | "error";

interface PendingImage {
  dataUrl: string;
  thumb: string;
}

interface PendingVideo {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  progress: number; // 0..1
  url?: string;
  frames: string[];
  poster: string | null;
}

export default function ChatApp() {
  const { playMusic } = useMusic();
  const [boot, setBoot] = useState<Boot>("loading");
  const [user, setUser] = useState<UserProfile>(DEFAULT_USER);
  const [bot, setBot] = useState<BotConfig>(DEFAULT_BOT_STATE);

  const [items, setItems] = useState<ConversationItem[]>([]);
  const [itemsHasMore, setItemsHasMore] = useState(false);
  const itemsOffsetRef = useRef(0);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Message[]>([]);
  const [firstHidden, setFirstHidden] = useState(0);

  const [indicator, setIndicator] = useState<Indicator>(null);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [pendingVideo, setPendingVideo] = useState<PendingVideo | null>(null);
  const [input, setInput] = useState("");
  const [nearBottom, setNearBottom] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editMid, setEditMid] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    message: string;
    okLabel: string;
    cancelLabel: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCat, setSettingsCat] = useState("profile");
  // Notifikasi hasil hubungkan provider (redirect balik dari OAuth callback)
  const [linkedNotice, setLinkedNotice] = useState<string | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);

  const loadingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastCheckRef = useRef(Date.now());
  const nearBottomRef = useRef(true);
  const currentIdRef = useRef<string | null>(null);
  const loadedRef = useRef<Message[]>([]);
  const firstHiddenRef = useRef(0);

  // keep refs in sync for async flows
  useEffect(() => {
    currentIdRef.current = currentId;
    loadedRef.current = loaded;
    firstHiddenRef.current = firstHidden;
  });
  useEffect(() => {
    nearBottomRef.current = nearBottom;
  }, [nearBottom]);

  const botName = bot.bot_name || "Aomi";
  const userName = user.display_name || user.username || "Kamu";
  const sid = typeof window === "undefined" ? null : getSessionId();

  const confirmDialog = useCallback(
    (message: string, okLabel = "Hapus", cancelLabel = "Batal") =>
      new Promise<boolean>((resolve) => {
        setConfirm({ message, okLabel, cancelLabel, resolve });
      }),
    []
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1500);
  }, []);

  // Preferensi chat (Settings > Percakapan) — sinkron lintas komponen
  // dalam tab yang sama via event "aomi:pref" (lihat lib/prefs.ts).
  const [enterToSend] = usePref("enterToSend");
  const [autoScroll] = usePref("autoScroll");
  const [showCode] = usePref("showCode");

  const scrollToBottom = useCallback((smooth: boolean) => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    });
  }, []);

  /* ---------------- Windowed message helpers ---------------- */

  const pushMessages = useCallback((msgs: Message[], scrollIfNear = true) => {
    setLoaded((prev) => {
      const next = [...prev, ...msgs];
      let fh = firstHiddenRef.current;
      if (next.length - fh > DOM_CAP) fh = next.length - DOM_CAP;
      setFirstHidden(fh);
      return next;
    });
    if (scrollIfNear && nearBottomRef.current) scrollToBottom(false);
  }, [scrollToBottom]);

  const resetView = useCallback(() => {
    setLoaded([]);
    setFirstHidden(0);
    setCurrentId(null);
  }, []);

  /** Baris pesan error lokal (tanpa mid server, gak bisa dimodifikasi). */
  const pushError = useCallback(
    (text: string) => {
      pushMessages([
        { message_id: "", role: "assistant", content: text, timestamp: new Date().toISOString(), isErrorHint: true } as Message,
      ]);
    },
    [pushMessages]
  );

  /* ---------------- Boot ---------------- */

  const runBoot = useCallback(async () => {
    if (!getSessionId()) {
      window.location.replace("/auth");
      return;
    }

    try {
      const convPromise = apiJson<{ items: ConversationItem[]; has_more?: boolean }>("/api/conversations?limit=50").catch(
        () => null
      );
      const [meRes, profileRes, botRes] = await Promise.all([
        api("/api/auth/me"),
        api("/api/profile"),
        api("/api/bot"),
      ]);
      const [me, profile, botCfg] = await Promise.all([
        meRes.json(),
        profileRes.json(),
        botRes.json(),
      ]);

      try {
        localStorage.setItem("aomi.appVersion", me.app_version || "");
        if (botCfg.bot.bot_avatar) localStorage.setItem("aomi.cache.botAvatar", botCfg.bot.bot_avatar);
        else localStorage.removeItem("aomi.cache.botAvatar");
        if (profile.avatar) localStorage.setItem("aomi.cache.userAvatar", profile.avatar);
        else localStorage.removeItem("aomi.cache.userAvatar");
      } catch { /* private mode / quota */ }

      setUser({
        ...DEFAULT_USER,
        ...profile,
        email: me.user?.email || "",
        google_linked: Boolean(me.user?.google_linked),
        providers: me.user?.providers || {
          google: Boolean(me.user?.google_linked),
          discord: false,
          facebook: false,
          telegram: false,
        },
      });
      setBot({ ...DEFAULT_BOT_STATE, ...botCfg.bot });

      // Migrasi satu-kali: key lama "aomi.fontSize" (2 level) → preferensi
      // baru "aomi.pref.textSize" (3 level, lihat lib/prefs.ts), lalu
      // terapkan SEMUA preferensi visual (tema/font/ukuran/kerapatan/accent/animasi).
      try {
        const legacy = localStorage.getItem("aomi.fontSize");
        if (legacy && !localStorage.getItem("aomi.pref.textSize")) {
          localStorage.setItem("aomi.pref.textSize", legacy === "16.5" ? "large" : "medium");
          localStorage.removeItem("aomi.fontSize");
        }
      } catch { /* private mode */ }
      applyAllVisualPrefs();

      const convData = await convPromise;
      const bootItems: ConversationItem[] = convData ? convData.items || [] : [];
      setItems(bootItems);
      itemsOffsetRef.current = bootItems.length;
      setItemsHasMore(Boolean((convData as { has_more?: boolean } | null)?.has_more));

      // Returning user: langsung buka percakapan terakhir. Belum ada
      // percakapan → biarkan kosong, user yang mulai ngobrol duluan.
      if (bootItems.length > 0) {
        void loadConversation(bootItems[0].conversation_id);
      }
      setBoot("ready");
    } catch (err) {
      if ((err as Error).message === "unauthorized") return;
      setBoot("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    runBoot();
  }, [runBoot]);

  // Ukuran font chat (dipasang ulang setelah settings berubah pun tetap)
  useEffect(() => {
    const syncViewport = () => {
      const vv = window.visualViewport;
      if (!vv || vv.scale !== 1) return;
      document.documentElement.style.setProperty("--app-h", Math.round(vv.height) + "px");
    };
    if (window.visualViewport) window.visualViewport.addEventListener("resize", syncViewport);
    syncViewport();
    return () => window.visualViewport?.removeEventListener("resize", syncViewport);
  }, []);

  // Redirect balik dari OAuth link (?linked=<provider> / ?linked=<provider>_taken
  // / ?linked=<provider>_failed) → buka Pengaturan > Akun dengan notice.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get("linked");
    if (!linked) return;
    window.history.replaceState(null, "", window.location.pathname);
    const [provider, outcome] = linked.split("_");
    const names: Record<string, string> = {
      google: "Google",
      discord: "Discord",
      facebook: "Facebook",
      telegram: "Telegram",
    };
    const name = names[provider] || "Provider";
    setLinkedNotice(
      outcome === "taken"
        ? `${name} sudah terhubung ke akun lain.`
        : outcome === "failed"
          ? `Gagal menghubungkan ${name}. Coba lagi.`
          : `${name} berhasil dihubungkan.`
    );
    setSettingsCat("account");
    setSettingsOpen(true);
  }, []);

  // Validasi sesi ringan saat tab kembali aktif (1x/menit)
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCheckRef.current < 60_000) return;
      lastCheckRef.current = Date.now();
      fetch("/api/auth/me", { headers: { "X-Session-Id": getSessionId() || "" } })
        .then((r) => {
          if (r.status === 401) {
            import("@/lib/client-api").then((m) => m.handleAuthInvalid());
          }
        })
        .catch(() => { /* offline: abaikan */ });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  /* ---------------- Refresh sidebar ---------------- */

  const handleLogout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch { /* lanjut teardown lokal */ }
    const m = await import("@/lib/session");
    m.clearSessionId();
    m.resetClientState();
    window.location.replace("/auth");
  }, []);

  const refreshSidebar = useCallback(async () => {
    try {
      const data = await apiJson<{ items: ConversationItem[]; has_more?: boolean }>(
        "/api/conversations?limit=50"
      );
      setItems(data.items || []);
      itemsOffsetRef.current = (data.items || []).length;
      setItemsHasMore(Boolean(data.has_more));
    } catch {
      // Error sesaat → PERTAHANKAN daftar lama.
    }
  }, []);

  // Halaman berikutnya (sidebar: "Muat yang lebih lama")
  const loadMoreItems = useCallback(async () => {
    try {
      const data = await apiJson<{ items: ConversationItem[]; has_more?: boolean }>(
        "/api/conversations?limit=50&offset=" + itemsOffsetRef.current
      );
      const page = data.items || [];
      setItems((prev) => {
        const seen = new Set(prev.map((c) => c.conversation_id));
        const merged = [...prev, ...page.filter((c) => !seen.has(c.conversation_id))];
        itemsOffsetRef.current = merged.length;
        return merged;
      });
      setItemsHasMore(Boolean(data.has_more));
    } catch {
      /* gagal load lebih → biarkan tombol tetap ada */
    }
  }, []);

  /* ---------------- Muat percakapan ---------------- */

  const loadConversation = useCallback(
    async (id: string) => {
      let res: Response | null = null;
      let data: { conversation?: Conversation } | null = null;
      try {
        res = await api("/api/conversations?id=" + encodeURIComponent(id));
        data = await res.json().catch(() => null);
      } catch (err) {
        if ((err as Error).message === "unauthorized") return;
        resetView();
        pushMessages([
          {
            message_id: "",
            role: "assistant",
            content: "Gagal memuat percakapan (koneksi/server sedang sibuk). Riwayatmu aman — coba buka lagi sebentar.",
            timestamp: new Date().toISOString(),
          },
        ]);
        return;
      }

      if (!res!.ok) {
        if (res!.status === 404) {
          // Satu-satunya kasus yang boleh membersihkan entrinya.
          resetView();
          pushMessages([
            {
              message_id: "",
              role: "assistant",
              content: "Percakapan ini sudah tidak tersedia (datanya hilang/rusak). Sudah dihapus dari riwayat.",
              timestamp: new Date().toISOString(),
            },
          ]);
          api("/api/conversations?id=" + encodeURIComponent(id), { method: "DELETE" }).catch(() => {});
          setItems((prev) => prev.filter((c) => c.conversation_id !== id));
        } else {
          resetView();
          pushMessages([
            {
              message_id: "",
              role: "assistant",
              content: "Server sedang sibuk, percakapan belum bisa dimuat. Riwayatmu aman — coba buka lagi sebentar.",
              timestamp: new Date().toISOString(),
            },
          ]);
        }
        return;
      }

      const conv = data?.conversation;
      if (!conv || !conv.conversation_id) {
        resetView();
        pushMessages([
          {
            message_id: "",
            role: "assistant",
            content: "Data percakapan tidak valid. Coba muat ulang halaman.",
            timestamp: new Date().toISOString(),
          },
        ]);
        return;
      }

      const msgs = (Array.isArray(conv.messages) ? conv.messages : []).filter(
        (m) => m && typeof m === "object"
      );
      setCurrentId(conv.conversation_id);
      setLoaded(msgs);
      setFirstHidden(Math.max(0, msgs.length - RENDER_BATCH));
      requestAnimationFrame(() => scrollToBottom(false));
    },
    [pushMessages, resetView, scrollToBottom]
  );

  /* ---------------- Scroll handling ---------------- */

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const max = el.scrollHeight - el.clientHeight;
        const nb = max - el.scrollTop < 80;
        nearBottomRef.current = nb;
        setNearBottom(nb);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [boot]);

  // Keyboard mobile: pertahankan posisi baca saat viewport menyusut
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (nearBottomRef.current) scrollToBottom(false);
      });
    };
    vv.addEventListener("resize", onResize);
    return () => {
      vv.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, [scrollToBottom]);

  /* ---------------- Edit foto (tahap 2 browser → tahap 3 simpan) ---------------- */

  const runEditJob = useCallback(
    async (job: { input_url: string; prompt: string }, cid: string | null) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), EDIT_BROWSER_TIMEOUT);
      let blob: Blob | null = null;
      // Fix 2026-10: API eksternal (Rin API/xrina) balas JSON "Insufficient
      // credits" saat kuota gratisnya habis — itu bukan soal fotonya, jadi
      // dibedakan dari pesan generik supaya user tidak disuruh kirim ulang
      // foto sia-sia.
      let quotaIssue = false;
      try {
        const r = await fetch(
          `${EDIT_API}?image=${encodeURIComponent(job.input_url)}&prompt=${encodeURIComponent(job.prompt)}`,
          { signal: ctrl.signal }
        );
        clearTimeout(timer);
        const ct = r.headers.get("content-type") || "";
        // Fix 2026-10: xrina kadang balas error JSON walau HTTP 200 (bukan
        // cuma saat !r.ok) — cek content-type dulu, bukan cuma status, biar
        // "Insufficient credits" selalu kedeteksi dan tidak jatuh ke pesan
        // generik yang menyuruh user kirim ulang foto sia-sia.
        if (!r.ok || !ct.startsWith("image/")) {
          const bodyText = await r.text().catch(() => "");
          if (/insufficient\s*credit/i.test(bodyText)) quotaIssue = true;
          throw new Error("edit http " + r.status);
        }
        blob = await r.blob();
        if (!blob.type.startsWith("image/")) throw new Error("bukan gambar: " + blob.type);
        if (blob.size > EDIT_RESULT_MAX) throw new Error("hasil terlalu besar");
      } catch {
        clearTimeout(timer);
        setIndicator(null);
        pushMessages([
          {
            message_id: "",
            role: "assistant",
            content: quotaIssue
              ? "Fitur edit foto lagi nggak bisa dipakai — kuota API provider-nya habis (bukan karena fotonya). Coba lagi nanti ya."
              : "Ngeditnya kelamaan atau gagal. Kirim ulang fotonya bareng instruksinya ya.",
            timestamp: new Date().toISOString(),
          },
        ]);
        api("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "edit-fail",
            conversation_id: cid,
            message: quotaIssue
              ? "edit foto tadi gagal — kuota API provider habis, coba lagi nanti ya."
              : "edit foto tadi gagal (kelamaan/gangguan) — kirim ulang fotonya ya.",
          }),
        }).catch(() => {});
        refreshSidebar();
        return;
      }

      // Tahap 3: kirim hasil ke server → URL unduh 3 hari.
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = reject;
        fr.readAsDataURL(blob!);
      });
      const res2 = await api("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit-save", conversation_id: cid, image: dataUrl }),
      });
      const data2 = (await res2.json().catch(() => null)) as ChatResponse | null;
      setIndicator(null);
      if (res2.ok && data2?.image_url) {
        const msg: Message = {
          message_id: data2.assistant_message_id || "",
          role: "assistant",
          content: data2.text || "",
          image_url: data2.image_url,
          image_name: data2.image_name,
          expires_at: data2.expires_at,
          timestamp: new Date().toISOString(),
        };
        pushMessages([msg]);
        persistEditThumb(data2.image_url, data2.assistant_message_id || "", data2.conversation_id || cid);
        refreshSidebar();
      } else {
        pushMessages([
          {
            message_id: "",
            role: "assistant",
            content: data2?.error || "Gagal menyimpan hasil edit. Coba lagi ya.",
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    },
    [pushMessages, refreshSidebar]
  );

  /** Thumbnail permanen supaya riwayat tetap menampilkan hasil setelah TTL. */
  const persistEditThumb = useCallback(async (url: string, messageId: string, convId: string | null) => {
    try {
      const blob = await (await fetch(url)).blob();
      if (!blob.type.startsWith("image/")) return;
      const file = new File([blob], "edit", { type: blob.type });
      const thumb = await compressImage(file, 540, 0.72);
      await api("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: convId, action: "thumb", message_id: messageId, thumb }),
      });
    } catch { /* opsional — URL unduh masih valid */ }
  }, []);

  /* ---------------- Generate gambar (tahap 2 browser -> tahap 3 simpan) ---------------- */

  const runImgGenJob = useCallback(
    async (job: { prompt: string }, cid: string | null) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), IMG_GEN_TIMEOUT);
      let blob: Blob | null = null;
      try {
        const r = await fetch(
          IMG_GEN_API + "?prompt=" + encodeURIComponent(job.prompt),
          { signal: ctrl.signal }
        );
        clearTimeout(timer);
        if (!r.ok) throw new Error("imggen http " + r.status);
        blob = await r.blob();
        if (!blob.type.startsWith("image/") || blob.size > EDIT_RESULT_MAX) throw new Error("hasil tidak valid");
      } catch {
        clearTimeout(timer);
        setIndicator(null);
        pushMessages([
          {
            message_id: "",
            role: "assistant",
            content: "Generate-nya kelamaan atau gagal. Coba lagi pakai prompt yang sama ya.",
            timestamp: new Date().toISOString(),
          },
        ]);
        api("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "imggen-fail",
            conversation_id: cid,
            message: "generate gambar tadi gagal (kelamaan/gangguan) — coba kirim ulang ya.",
          }),
        }).catch(() => {});
        refreshSidebar();
        return;
      }

      // Tahap 3: kirim hasil ke server -> URL unduh 3 hari.
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = reject;
        fr.readAsDataURL(blob!);
      });
      const res2 = await api("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "imggen-save", conversation_id: cid, image: dataUrl }),
      });
      const data2 = (await res2.json().catch(() => null)) as ChatResponse | null;
      setIndicator(null);
      if (res2.ok && data2?.image_url) {
        const msg: Message = {
          message_id: data2.assistant_message_id || "",
          role: "assistant",
          content: data2.text || "",
          image_url: data2.image_url,
          image_name: data2.image_name,
          expires_at: data2.expires_at,
          timestamp: new Date().toISOString(),
        };
        pushMessages([msg]);
        persistEditThumb(data2.image_url, data2.assistant_message_id || "", data2.conversation_id || cid);
        refreshSidebar();
      } else {
        pushMessages([
          {
            message_id: "",
            role: "assistant",
            content: data2?.error || "Gagal menyimpan hasil generate. Coba lagi ya.",
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    },
    [pushMessages, refreshSidebar, persistEditThumb]
  );

  /** Satu jalur lampiran (dipakai tombol +, drag&drop, paste):
   *  validasi → preview → untuk video: upload + ekstrak frame. */
  const handleFileSelected = useCallback(
    async (file: File) => {
      if (isVideoFile(file)) {
        if (file.size > 50 * 1024 * 1024) {
          pushError("Video maksimal 50MB ya.");
          return;
        }
        const id = Math.random().toString(36).slice(2);
        setPendingVideo({
          id,
          name: file.name,
          size: file.size,
          status: "uploading",
          progress: 0,
          frames: [],
          poster: null,
        });
        // frame diekstrak paralel dengan upload
        void extractVideoFrames(file).then(({ frames, poster }) => {
          setPendingVideo((v) => (v && v.id === id ? { ...v, frames, poster } : v));
        });
        try {
          const url = await uploadVideo(file, (r) => {
            setPendingVideo((v) => (v && v.id === id ? { ...v, progress: r } : v));
          });
          setPendingVideo((v) => (v && v.id === id ? { ...v, status: "ready", url } : v));
        } catch (err) {
          setPendingVideo((v) => (v && v.id === id ? { ...v, status: "error" } : v));
          pushError((err as Error).message || "Gagal mengunggah video. Coba lagi ya.");
        }
        return;
      }
      if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
        pushError("Tipe file ini belum didukung. Pakai gambar atau video ya.");
        return;
      }
      try {
        const dataUrl = await compressImage(file, 1024, 0.82);
        const thumb = await compressImage(file, 360, 0.68);
        setPendingImage({ dataUrl, thumb });
      } catch {
        pushError("Gagal memproses gambar. Coba file lain ya.");
      }
    },
    [pushError]
  );

  /* ---------------- Kirim pesan ---------------- */

  const send = useCallback(
    async (rawText: string): Promise<string | null> => {
      const text = sanitizeText(rawText, 4000);
      const img = pendingImage;
      const vid = pendingVideo;
      if ((!text && !img && !vid) || loadingRef.current) return null;
      if (vid && vid.status === "uploading") {
        pushError("Video masih diunggah nih, tunggu sebentar ya~");
        return null;
      }
      const vidReady = vid && vid.status === "ready" && vid.url ? vid : null;

      loadingRef.current = true;
      setInput("");
      // Reset tinggi textarea manual — kalau pesan sebelumnya multi-baris,
      // style.height masih "nempel" tinggi lama (diset imperatif di
      // onChange, React gak nyentuh balik pas value dikosongkan via
      // setInput), bikin kotak kosong tetep tinggi & placeholder
      // nongkrong di atas (gak center sama tombol +/kirim).
      if (inputRef.current) inputRef.current.style.height = "auto";

      // Render optimistik untuk pesan user
      const optimistic: Message = {
        message_id: "",
        role: "user",
        content: text,
        image: img?.thumb || undefined,
        video: vidReady && vidReady.url ? { url: vidReady.url, name: vidReady.name } : undefined,
        timestamp: new Date().toISOString(),
      };
      pushMessages([optimistic]);
      setPendingImage(null);
      setPendingVideo(null);

      // Indikator: edit foto → label khusus; downloader → label file
      const wantsGen = !img && !vid && !!matchImageGenRequest(text);
      const wantsHdVideo = !!(vidReady && HD_TRIGGER_RE.test(text));
      const wantsHd = !img && !vid && !wantsGen && !!matchHdRequest(text);
      const wantsEdit = !!(img && text && EDIT_TRIGGER_RE.test(text));
      const wantsHdFoto = !!(img && text && HD_TRIGGER_RE.test(text));
      const wantsMusic = !img && !vid && !wantsGen && !wantsHd && !wantsEdit && !!matchMusicRequest(text);
      const wantsDl = !img && !vid && !wantsGen && !wantsHd && !wantsEdit && !wantsMusic && !!matchDlTarget(text);
      setIndicator(
        wantsGen
          ? "generating"
          : wantsHd || wantsHdVideo
            ? "hdvid"
            : wantsEdit || wantsHdFoto
              ? "editing"
              : wantsMusic
                ? "music"
                : wantsDl
                  ? "downloading"
                  : "typing"
      );
      scrollToBottom(true);

      try {
        const res = await api("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: currentIdRef.current,
            message: text,
            ...(img ? { image: img.dataUrl, thumb: img.thumb } : {}),
            ...(vidReady
              ? {
                  video: { url: vidReady.url, name: vidReady.name, size: vidReady.size },
                  ...(wantsHdVideo ? {} : { frames: vidReady.frames }),
                }
              : {}),
          }),
        });
        const data = (await res.json().catch(() => null)) as ChatResponse | null;

        if (res.ok && data?.imggen_job) {
          // Tahap 1 selesai (server simpan pesan user). Browser lanjut
          // menembak API faa text2img sendiri (CORS terbuka).
          setCurrentId(data.conversation_id || currentIdRef.current);
          if (data.user_message_id) {
            setLoaded((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "user") next[next.length - 1] = { ...last, message_id: data.user_message_id! };
              return next;
            });
          }
          await runImgGenJob(data.imggen_job, data.conversation_id || currentIdRef.current);
          return null;
        }

        if (res.ok && data?.edit_job) {
          // Tahap 1 selesai (server simpan pesan user + host gambar).
          setCurrentId(data.conversation_id || currentIdRef.current);
          // id pesan user dari server → aktifkan aksi menu
          if (data.user_message_id) {
            setLoaded((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "user") next[next.length - 1] = { ...last, message_id: data.user_message_id! };
              return next;
            });
          }
          await runEditJob(data.edit_job, data.conversation_id || currentIdRef.current);
          return null;
        }

        setIndicator(null);
        if (res.ok && data?.text) {
          setCurrentId(data.conversation_id || currentIdRef.current);
          if (data.user_message_id) {
            setLoaded((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === "user") next[next.length - 1] = { ...last, message_id: data.user_message_id! };
              return next;
            });
          }
          const msg: Message = {
            message_id: data.assistant_message_id || "",
            role: "assistant",
            content: data.text,
            timestamp: new Date().toISOString(),
          };
          if (data.dl) {
            msg.dl = data.dl;
          } else if (data.music) {
            msg.music = data.music;
          } else if (data.hd) {
            msg.hd = data.hd;
          } else if (data.image_url) {
            msg.image_url = data.image_url;
            msg.image_name = data.image_name;
            msg.expires_at = data.expires_at;
            persistEditThumb(data.image_url, data.assistant_message_id || "", data.conversation_id || currentIdRef.current);
          }
          pushMessages([msg]);
          refreshSidebar();
          // Kartu lagu → langsung buka player & putar
          if (data.music) playMusic(data.music);
          return data.text;
        } else {
          pushMessages([
            {
              message_id: "",
              role: "assistant",
              content: data?.error || "Gagal mengirim. Coba lagi.",
              timestamp: new Date().toISOString(),
            },
          ]);
          return null;
        }
      } catch (err) {
        setIndicator(null);
        if ((err as Error).message !== "unauthorized") {
          pushMessages([
            {
              message_id: "",
              role: "assistant",
              content: "Tidak bisa menghubungi server. Cek koneksi.",
              timestamp: new Date().toISOString(),
            },
          ]);
          return null;
        }
        return null;
      } finally {
        loadingRef.current = false;
      }
    },
    [pendingImage, pendingVideo, pushMessages, refreshSidebar, runEditJob, scrollToBottom, persistEditThumb, playMusic]
  );

  /* ---------------- Mode telepon suara ---------------- */

  // STT hanya ada di browser (Chrome/Edge/Safari) — cek setelah mount
  // supaya render server & client konsisten (tanpa hydration mismatch).
  const [voiceOk, setVoiceOk] = useState(false);
  useEffect(() => {
    setVoiceOk(speechRecognitionSupported());
  }, []);

  // send didefinisikan di atas → bungkus via ref agar hook-nya stabil
  const sendVoiceRef = useRef(send);
  sendVoiceRef.current = send;
  const voice = useVoiceCall(useCallback((t: string) => sendVoiceRef.current(t), []));

  /* ---------------- Aksi pesan ---------------- */

  const openMenu = useCallback(
    (e: React.MouseEvent, m: Message) => {
      e.preventDefault();
      if (!m.message_id) return; // pesan optimistik/error lokal belum ada di server
      const isLast =
        loadedRef.current[loadedRef.current.length - 1]?.message_id === m.message_id &&
        loadedRef.current[loadedRef.current.length - 1]?.role === m.role;
      setMenu({
        x: e.clientX,
        y: e.clientY,
        mid: m.message_id,
        role: m.role,
        hasText: !!m.content,
        isLast: m.role === "assistant" && isLast,
        hasMedia: Boolean(m.image || m.image_url || m.video || m.dl || m.music || m.hd),
        feedback: typeof m.feedback === "number" ? m.feedback : 0,
        bookmarked: Boolean(m.bookmarked),
      });
    },
    []
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  const doCopy = useCallback(
    async (text: string) => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
        document.body.appendChild(ta);
        ta.select();
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
        ta.remove();
      }
      if (ok) showToast("Tersalin");
    },
    [showToast]
  );

  const doDelete = useCallback(
    async (mid: string) => {
      const cid = currentIdRef.current;
      if (!mid || !cid || loadingRef.current) return;
      const ok = await confirmDialog("Delete this message?", "Delete", "Cancel");
      if (!ok) return;

      // update state lokal dulu (instan), lalu sinkron ke server
      setLoaded((prev) => {
        const idx = prev.findIndex((m) => m && m.message_id === mid);
        if (idx < 0) return prev;
        return prev.filter((_, i) => i !== idx);
      });

      let serverOk = false;
      try {
        const res = await api(
          "/api/conversations?id=" + encodeURIComponent(cid) + "&message_id=" + encodeURIComponent(mid),
          { method: "DELETE" }
        );
        serverOk = res.ok;
      } catch {
        serverOk = false;
      }

      if (!serverOk) {
        void loadConversation(cid);
        return;
      }
      setLoaded((prev) => {
        if (prev.length === 0) resetView();
        return prev;
      });
    },
    [confirmDialog, loadConversation, resetView]
  );

  const saveEdit = useCallback(
    async (mid: string, text: string) => {
      const cid = currentIdRef.current;
      const clean = sanitizeText(text, 4000);
      if (!mid || !cid || loadingRef.current || !clean) return;
      setEditMid(null);
      loadingRef.current = true;
      setIndicator("typing");

      // terapkan teks baru + buang semua pesan SETELAH pesan ini
      setLoaded((prev) => {
        const idx = prev.findIndex((m) => m && m.message_id === mid);
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], content: clean };
        next.length = idx + 1;
        return next;
      });

      scrollToBottom(true);
      let ok = false;
      try {
        const res = await api("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "edit", conversation_id: cid, message_id: mid, text: clean }),
        });
        const data = (await res.json().catch(() => null)) as ChatResponse | null;
        setIndicator(null);
        if (res.ok && data?.edit_job) {
          ok = true;
          setCurrentId(data.conversation_id || cid);
          await runEditJob(data.edit_job, data.conversation_id || cid);
          return;
        }
        if (res.ok && data?.text) {
          ok = true;
          pushMessages([
            { message_id: data.assistant_message_id || "", role: "assistant", content: data.text, timestamp: new Date().toISOString() },
          ]);
          refreshSidebar();
        } else {
          void loadConversation(cid);
        }
      } catch (err) {
        setIndicator(null);
        if ((err as Error).message !== "unauthorized") void loadConversation(cid);
      } finally {
        loadingRef.current = false;
      }
      if (ok && autoScroll && nearBottomRef.current) scrollToBottom(true);
    },
    [loadConversation, pushMessages, refreshSidebar, runEditJob, scrollToBottom, autoScroll]
  );

  const doRegenerate = useCallback(
    async (mid: string, variant: string = "") => {
      const cid = currentIdRef.current;
      if (!mid || !cid || loadingRef.current) return;
      loadingRef.current = true;
      setIndicator("typing");

      // buang bubble lama (selalu baris terakhir) → jawaban baru menggantikan
      setLoaded((prev) => {
        const idx = prev.findIndex((m) => m && m.message_id === mid);
        if (idx < 0) return prev;
        return prev.slice(0, idx);
      });
      scrollToBottom(true);

      let ok = false;
      try {
        const res = await api("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "regenerate", conversation_id: cid, ...(variant ? { variant } : {}) }),
        });
        const data = (await res.json().catch(() => null)) as ChatResponse | null;
        setIndicator(null);
        if (res.ok && data?.edit_job) {
          ok = true;
          await runEditJob(data.edit_job, cid);
          return;
        }
        if (res.ok && data?.text) {
          ok = true;
          pushMessages([
            { message_id: data.assistant_message_id || "", role: "assistant", content: data.text, timestamp: new Date().toISOString() },
          ]);
          refreshSidebar();
        } else {
          void loadConversation(cid);
        }
      } catch (err) {
        setIndicator(null);
        if ((err as Error).message !== "unauthorized") void loadConversation(cid);
      } finally {
        loadingRef.current = false;
      }
      if (ok && autoScroll && nearBottomRef.current) scrollToBottom(true);
    },
    [loadConversation, pushMessages, refreshSidebar, runEditJob, scrollToBottom, autoScroll]
  );

  /* ---------------- Feedback / Simpan / Kirim ulang / Pin / Arsip ---------------- */

  /** Feedback suka/tidak suka: toggle server-side, update lokal instan. */
  const doFeedback = useCallback(
    async (mid: string, value: 1 | -1) => {
      const cid = currentIdRef.current;
      if (!mid || !cid) return;
      const current =
        loadedRef.current.find((m) => m.message_id === mid)?.feedback ?? 0;
      const next = current === value ? 0 : value; // klik ulang = hapus
      setLoaded((prev) =>
        prev.map((m) => (m.message_id === mid ? { ...m, feedback: next } : m))
      );
      try {
        await api("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "feedback",
            conversation_id: cid,
            message_id: mid,
            value: next,
          }),
        });
        if (next !== 0) showToast(next === 1 ? "Makasih masukannya~" : "Noted, aku coba lebih baik.");
      } catch {
        setLoaded((prev) =>
          prev.map((m) => (m.message_id === mid ? { ...m, feedback: current } : m))
        );
      }
    },
    [showToast]
  );

  /** Simpan jawaban Aomi ke Simpanan (atau hapus dari sana). */
  const doBookmark = useCallback(
    async (mid: string, bookmarked: boolean) => {
      const cid = currentIdRef.current;
      if (!mid || !cid) return;
      setLoaded((prev) =>
        prev.map((m) => (m.message_id === mid ? { ...m, bookmarked: !bookmarked } : m))
      );
      try {
        const res = await api("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: bookmarked ? "unbookmark" : "bookmark",
            conversation_id: cid,
            message_id: mid,
          }),
        });
        if (res.ok) {
          showToast(bookmarked ? "Dihapus dari Simpanan" : "Disimpan ke Simpanan");
        } else {
          throw new Error("gagal");
        }
      } catch {
        setLoaded((prev) =>
          prev.map((m) => (m.message_id === mid ? { ...m, bookmarked } : m))
        );
        showToast("Gagal. Coba lagi ya.");
      }
    },
    [showToast]
  );

  /** Kirim ulang pesan user (hanya teks) sebagai pesan baru. */
  const doRetry = useCallback(
    (mid: string) => {
      const msg = loadedRef.current.find((m) => m.message_id === mid);
      if (!msg || loadingRef.current || !msg.content) return;
      void send(msg.content);
    },
    [send]
  );

  /** Pin / arsip percakapan (state index, update lokal + server). */
  const doConvFlag = useCallback(
    async (id: string, action: "pin" | "archive", value: boolean) => {
      setItems((prev) =>
        prev.map((c) =>
          c.conversation_id === id
            ? { ...c, [action === "pin" ? "pinned" : "archived"]: value }
            : c
        )
      );
      try {
        const res = await api("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, conversation_id: id, value }),
        });
        if (!res.ok) throw new Error("gagal");
        if (action === "archive" && value && currentIdRef.current === id) {
          // Arsipkan yang sedang terbuka → tutup view-nya
          resetView();
        }
      } catch {
        void refreshSidebar(); // gagal → sinkron ulang dari server
      }
    },
    [refreshSidebar, resetView]
  );

  /** Ganti judul percakapan (optimistik + server). */
  const doRename = useCallback(
    async (id: string, title: string) => {
      setItems((prev) => prev.map((c) => (c.conversation_id === id ? { ...c, title } : c)));
      try {
        const res = await api("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "rename", conversation_id: id, title }),
        });
        if (!res.ok) throw new Error("gagal");
      } catch {
        void refreshSidebar();
      }
    },
    [refreshSidebar]
  );

  /* ---------------- Long-press (mobile) untuk menu pesan ---------------- */

  useEffect(() => {
    const column = columnRef.current;
    if (!column) return;
    let lpTimer: ReturnType<typeof setTimeout> | null = null;
    let lpX = 0;
    let lpY = 0;
    let lpTarget: HTMLElement | null = null;
    const LP_MS = 480;
    const cancelLp = () => {
      if (lpTimer) {
        clearTimeout(lpTimer);
        lpTimer = null;
      }
    };
    const onTouchStart = (e: TouchEvent) => {
      if (editMid) return;
      const t = e.touches[0];
      const row = (e.target as HTMLElement).closest(".message-row") as HTMLElement | null;
      if (!row || row.classList.contains("typing")) return;
      lpTarget = row;
      lpX = t.clientX;
      lpY = t.clientY;
      lpTimer = setTimeout(() => {
        lpTimer = null;
        try {
          window.getSelection()?.removeAllRanges();
        } catch { /* ios lama */ }
        navigator.vibrate?.(8);
        const mid = lpTarget?.dataset.mid || "";
        const msg = loadedRef.current.find((m) => m.message_id === mid);
        if (msg && msg.message_id) {
          setMenu({
            x: lpX,
            y: lpY,
            mid: msg.message_id,
            role: msg.role,
            hasText: !!msg.content,
            isLast:
              msg.role === "assistant" &&
              loadedRef.current[loadedRef.current.length - 1]?.message_id === mid,
            hasMedia: Boolean(msg.image || msg.image_url || msg.video || msg.dl || msg.music || msg.hd),
            feedback: typeof msg.feedback === "number" ? msg.feedback : 0,
            bookmarked: Boolean(msg.bookmarked),
          });
        }
      }, LP_MS);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!lpTimer) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - lpX) > 8 || Math.abs(t.clientY - lpY) > 8) cancelLp();
    };
    column.addEventListener("touchstart", onTouchStart, { passive: true });
    column.addEventListener("touchmove", onTouchMove, { passive: true });
    column.addEventListener("touchend", cancelLp, { passive: true });
    column.addEventListener("touchcancel", cancelLp, { passive: true });
    return () => {
      cancelLp();
      column.removeEventListener("touchstart", onTouchStart);
      column.removeEventListener("touchmove", onTouchMove);
      column.removeEventListener("touchend", cancelLp);
      column.removeEventListener("touchcancel", cancelLp);
    };
  }, [boot, editMid]);

  /* ---------------- Render windowed ---------------- */

  const rendered = loaded.slice(firstHidden);
  let prevRole: string | null = firstHidden > 0 ? loaded[firstHidden - 1]?.role ?? null : null;
  const rows = rendered.map((m, i) => {
    const showName = m.role === "assistant" && m.role !== prevRole;
    prevRole = m.role;
    const file: MessageFile | null = fileOf(m);
    return (
      <MessageRow
        key={(m.message_id || "m") + "-" + i + "-" + (m.timestamp || "")}
        role={m.role}
        content={m.content || ""}
        showCode={showCode}
        isError={Boolean((m as Message & { isErrorHint?: boolean }).isErrorHint)}
        showName={showName}
        imageUrl={m.image || m.image_url || null}
        imageResult={!!file}
        mid={m.message_id || null}
        file={file}
        dl={dlOf(m)}
        music={musicOf(m)}
        hd={hdOf(m)}
        video={m.video || null}
        sid={sid}
        userAvatar={user.avatar}
        botAvatar={bot.bot_avatar}
        userName={userName}
        botName={botName}
        editing={editMid === m.message_id}
        onEditText={(text) => m.message_id && void saveEdit(m.message_id, text)}
        onEditCancel={() => setEditMid(null)}
        onContextMenu={(e) => openMenu(e, m)}
        onMenuButton={(e) => openMenu(e, m)}
      />
    );
  });

  /* ---------------- Boot states ---------------- */

  if (boot === "loading") {
    // Loading state normal & fungsional (tanpa splash animasi):
    // hanya terlihat sekilas sebelum session dicek / redirect ke /auth.
    return (
      <div className="boot-loading" aria-busy="true">
        Memuat…
      </div>
    );
  }

  if (boot === "error") {
    return (
      <div className="boot-error">
        <div>
          <p>Tidak bisa menghubungi server. Periksa koneksimu.</p>
          <button className="boot-retry" onClick={() => window.location.reload()}>
            Coba lagi
          </button>
        </div>
      </div>
    );
  }

  const hasMessages = loaded.length > 0;
  const emptyFirst = firstHidden === 0;

  return (
    <>
      <div className="app">
        <Sidebar
          items={items}
          hasMore={itemsHasMore}
          onLoadMore={() => void loadMoreItems()}
          activeId={currentId}
          botName={botName}
          botAvatar={bot.bot_avatar}
          userAvatar={user.avatar}
          userLabel={userName}
          open={sidebarOpen}
          onOpenDrawer={() => setSidebarOpen(true)}
          onCloseDrawer={() => setSidebarOpen(false)}
          onNewChat={() => {
            setSidebarOpen(false);
            resetView();
          }}
          onOpenCharacter={() => {
            setSidebarOpen(false);
            setSettingsCat("bot");
            setSettingsOpen(true);
          }}
          onOpenSettings={(cat) => {
            setSidebarOpen(false);
            setSettingsCat(cat);
            setSettingsOpen(true);
          }}
          onLogout={handleLogout}
          onOpen={(id) => {
            setSidebarOpen(false);
            void loadConversation(id);
          }}
          onDelete={async (id) => {
            const ok = await confirmDialog("Hapus percakapan ini?");
            if (!ok) return;
            setItems((prev) => prev.filter((c) => c.conversation_id !== id));
            try {
              await api("/api/conversations?id=" + encodeURIComponent(id), { method: "DELETE" });
            } catch { /* sudah dialihkan bila 401 */ }
            if (currentIdRef.current === id) resetView();
          }}
          onRecover={async () => {
            try {
              await api("/api/conversations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "recover" }),
              });
              await refreshSidebar();
            } catch { /* gagal → tetap tampil */ }
          }}
          onPin={(id, value) => void doConvFlag(id, "pin", value)}
          onArchive={(id, value) => void doConvFlag(id, "archive", value)}
          onRename={(id, title) => void doRename(id, title)}
          onOpenSaved={() => {
            setSidebarOpen(false);
            setSavedOpen(true);
          }}
        />

        <div className="backdrop" hidden={!sidebarOpen} onClick={() => setSidebarOpen(false)} />

        <main className="main">
          <header className="topbar">
            <button className="icon-btn menu-btn" aria-label="Buka sidebar" onClick={() => setSidebarOpen(true)}>
              <svg className="icon" aria-hidden="true"><use href="/icons.svg#menu" /></svg>
            </button>
            <div className="char-head">
              <span className="avatar char-avatar">
                {bot.bot_avatar ? (
                  <img src={bot.bot_avatar} alt="" aria-hidden="true" decoding="async" />
                ) : (
                  <svg className="icon" aria-hidden="true"><use href="/icons.svg#logo" /></svg>
                )}
              </span>
              <div className="char-meta">
                <div className="char-name">{botName}</div>
              </div>
            </div>
            <button
              className="icon-btn"
              aria-label="Gulir ke bawah"
              hidden={nearBottom || !hasMessages}
              onClick={() => scrollToBottom(true)}
            >
              <svg className="icon" aria-hidden="true"><use href="/icons.svg#chevron-down" /></svg>
            </button>
          </header>

          <section
            className="chat-scroll"
            ref={scrollRef}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) e.preventDefault();
            }}
            onDrop={(e) => {
              const file = e.dataTransfer.files?.[0];
              if (!file) return;
              e.preventDefault();
              void handleFileSelected(file);
            }}
          >
            <div className="chat-column" ref={columnRef}>
              {/* Layar sambutan */}
              {!hasMessages && !indicator && (
                <div className="welcome">
                  <span className="avatar welcome-avatar">
                    {bot.bot_avatar ? (
                      <img src={bot.bot_avatar} alt="" aria-hidden="true" decoding="async" />
                    ) : (
                      <svg className="icon" aria-hidden="true"><use href="/icons.svg#logo" /></svg>
                    )}
                  </span>
                  <div className="welcome-lines">
                    <p className="w-line">hey.</p>
                    <p className="w-line">you&apos;re back.</p>
                    <p className="w-line">i was waiting.</p>
                  </div>
                  <p className="welcome-hint">Ketik sesuatu, atau mulai dari salah satu ini.</p>
                  <div className="suggestions">
                    {[
                      "heyo, kabarmu gimana hari ini?",
                      "aku bosen nih. hiburin dong",
                      "ceritain sesuatu yang random deh",
                      "aku mau cerita soal hariku, dengarkan ya",
                    ].map((q) => (
                      <button key={q} className="suggestion" onClick={() => void send(q)}>
                        {q}
                      </button>
                    ))}
                  </div>
                  {/* Quick actions ringan: isi composer (gak auto-kirim) —
                      memakai kemampuan chat yang sudah ada, bukan fitur palsu. */}
                  <div className="quick-actions" aria-label="Aksi cepat">
                    {QUICK_ACTIONS.map((a) => (
                      <button
                        key={a.label}
                        type="button"
                        className="quick-action"
                        onClick={() => {
                          setInput(a.text);
                          inputRef.current?.focus();
                        }}
                      >
                        <svg className="icon" aria-hidden="true"><use href={`/icons.svg#${a.icon}`} /></svg>
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Muat pesan sebelumnya */}
              <div className="load-earlier-wrap" hidden={emptyFirst}>
                <button onClick={() => {
                  const el = scrollRef.current;
                  const prevHeight = el?.scrollHeight || 0;
                  const prevTop = el?.scrollTop || 0;
                  setFirstHidden((fh) => Math.max(0, fh - RENDER_BATCH));
                  requestAnimationFrame(() => {
                    const el2 = scrollRef.current;
                    if (el2) el2.scrollTop = prevTop + (el2.scrollHeight - prevHeight);
                  });
                }}>
                  Muat pesan sebelumnya
                </button>
              </div>

              {rows}
              {indicator && <IndicatorRow indicator={indicator} />}
            </div>
          </section>

          <VoiceCallOverlay phase={voice.phase} transcript={voice.transcript} onStop={voice.stop} />
          <div className="composer-wrap">
            {/* Smart scroll: user lagi baca pesan lama → jangan paksa gulir;
                kasih jalan pintas ke pesan terbaru (di atas komposer). */}
            {hasMessages && !nearBottom && (
              <div className="jump-row">
                <button
                  type="button"
                  className="jump-latest"
                  onClick={() => scrollToBottom(true)}
                >
                  <svg className="icon" aria-hidden="true"><use href="/icons.svg#chevron-down" /></svg>
                  Lanjut ke pesan terbaru
                </button>
              </div>
            )}
            {pendingImage && (
              <div className="attach-preview">
                <img src={pendingImage.thumb} alt="Pratinjau gambar" />
                <button
                  className="attach-remove"
                  type="button"
                  aria-label="Hapus gambar"
                  onClick={() => setPendingImage(null)}
                >
                  <svg className="icon" aria-hidden="true"><use href="/icons.svg#close" /></svg>
                </button>
                <span className="attach-hint">Gambar siap dikirim</span>
              </div>
            )}
            {pendingVideo && (
              <div className="attach-preview attach-preview-video">
                <img
                  src={pendingVideo.poster || undefined}
                  alt=""
                  className="attach-video-thumb"
                  onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }}
                />
                <button
                  className="attach-remove"
                  type="button"
                  aria-label="Hapus video"
                  onClick={() => setPendingVideo(null)}
                >
                  <svg className="icon" aria-hidden="true"><use href="/icons.svg#close" /></svg>
                </button>
                <div className="attach-video-meta">
                  <span className="attach-video-name">{pendingVideo.name}</span>
                  {pendingVideo.status === "uploading" && (
                    <span className="attach-video-progress">
                      <span className="attach-video-bar">
                        <span className="attach-video-bar-fill" style={{ width: Math.round(pendingVideo.progress * 100) + "%" }} />
                      </span>
                      Mengunggah {Math.round(pendingVideo.progress * 100)}%
                    </span>
                  )}
                  {pendingVideo.status === "ready" && <span className="attach-hint">Video siap dikirim</span>}
                  {pendingVideo.status === "error" && <span className="attach-video-err">Gagal — coba upload ulang</span>}
                </div>
              </div>
            )}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
            >
              <button
                className="attach"
                type="button"
                aria-label="Lampirkan gambar atau video"
                onClick={() => fileRef.current?.click()}
              >
                <svg className="icon" aria-hidden="true"><use href="/icons.svg#plus" /></svg>
              </button>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
                hidden
                ref={fileRef}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void handleFileSelected(file);
                }}
              />
              <textarea
                id="input"
                rows={1}
                placeholder="Tulis sesuatu…"
                autoComplete="off"
                enterKeyHint="send"
                aria-label="Pesan"
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  const ta = e.target;
                  ta.style.height = "auto";
                  ta.style.height = ta.scrollHeight + "px";
                }}
                onPaste={(e) => {
                  // Paste gambar dari clipboard (screenshot/copy image)
                  const file = Array.from(e.clipboardData.files || []).find((f) =>
                    /^image\/(png|jpe?g|webp|gif)$/.test(f.type)
                  );
                  if (file) {
                    e.preventDefault();
                    void handleFileSelected(file);
                  }
                }}
                onKeyDown={(e) => {
                  // Ctrl/Cmd+Enter selalu kirim (shortcut, apa pun preferensi enter)
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void send(input);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    if (enterToSend) {
                      e.preventDefault();
                      void send(input);
                    }
                    // OFF → perilaku default textarea: baris baru.
                  }
                }}
              />
              {voiceOk && (
                <button
                  className="voice-btn"
                  type="button"
                  aria-label={voice.active ? "Akhiri telepon suara" : "Telepon suara dengan Aomi"}
                  aria-pressed={voice.active}
                  title={voice.active ? "Akhiri telepon suara" : "Telepon suara dengan Aomi"}
                  onClick={() => (voice.active ? voice.stop() : voice.start())}
                >
                  <svg className="icon" aria-hidden="true"><use href="/icons.svg#phone" /></svg>
                </button>
              )}
              <button
                className="send"
                type="submit"
                aria-label="Kirim"
                disabled={
                  loadingRef.current ||
                  (!input.trim() && !pendingImage && !pendingVideo) ||
                  pendingVideo?.status === "uploading"
                }
              >
                <svg className="icon" aria-hidden="true"><use href="/icons.svg#send" /></svg>
              </button>
            </form>
            <footer className="app-foot">
              Developed by{" "}
              <a
                className="foot-link"
                href="https://whatsapp.com/channel/0029Vb8AgskLY6dCvnTjxU3c"
                target="_blank"
                rel="noopener noreferrer"
              >
                Akira
              </a>
            </footer>
          </div>
        </main>
      </div>

      {/* Menu aksi pesan */}
      <MessageMenu
        menu={menu}
        onClose={closeMenu}
        onCopy={async (mid) => {
          const msg = loadedRef.current.find((m) => m.message_id === mid);
          if (msg?.content) await doCopy(msg.content);
        }}
        onDelete={(mid) => void doDelete(mid)}
        onEdit={(mid) => setEditMid(mid)}
        onRetry={(mid) => doRetry(mid)}
        onRegenerate={(mid, variant) => void doRegenerate(mid, variant)}
        onBookmark={(mid, bookmarked) => void doBookmark(mid, bookmarked)}
        onFeedback={(mid, value) => void doFeedback(mid, value)}
      />

      {/* Simpanan (bookmark jawaban Aomi) */}
      {savedOpen && (
        <SavedView
          onClose={() => setSavedOpen(false)}
          onToast={showToast}
          onOpenConversation={(cid) => {
            setSavedOpen(false);
            void loadConversation(cid);
          }}
        />
      )}

      {/* Toast */}
      {toast && <div className="copy-toast show">{toast}</div>}

      {/* Dialog konfirmasi */}
      <ConfirmDialog
        confirm={confirm}
        onDone={(ok) => {
          confirm?.resolve(ok);
          setConfirm(null);
        }}
      />

      {/* Settings (SPA overlay) */}
      {settingsOpen && (
        <SettingsView
          initialCategory={settingsCat}
          linkedNotice={linkedNotice}
          user={user}
          bot={bot}
          onClose={() => setSettingsOpen(false)}
          onConversationsCleared={() => {
            resetView();                 // kosongkan jendela chat aktif
            void refreshSidebar();       // sinkronkan daftar di sidebar
          }}
          onUserUpdate={(u) => setUser((prev) => ({ ...prev, ...u }))}
          onBotUpdate={(b) => setBot((prev) => ({ ...prev, ...b }))}
          onLogout={handleLogout}
        />
      )}

    </>
  );
}
