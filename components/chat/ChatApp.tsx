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
import ConfirmDialog from "@/components/chat/ConfirmDialog";
import Intro from "@/components/chat/Intro";
import SettingsView from "@/components/settings/SettingsView";
import { fileOf, dlOf, EDIT_API, EDIT_BROWSER_TIMEOUT, EDIT_RESULT_MAX, EDIT_TRIGGER_RE, matchDlTarget } from "@/lib/chat-utils";
import type { BotConfig, ChatResponse, Conversation, ConversationItem, Message, UserProfile } from "@/types";

const RENDER_BATCH = 30;
const DOM_CAP = 150;

const DEFAULT_USER: UserProfile = {
  username: "",
  display_name: "",
  bio: "",
  avatar: null,
  email: "",
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

export default function ChatApp() {
  const [boot, setBoot] = useState<Boot>("loading");
  const [user, setUser] = useState<UserProfile>(DEFAULT_USER);
  const [bot, setBot] = useState<BotConfig>(DEFAULT_BOT_STATE);

  const [items, setItems] = useState<ConversationItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Message[]>([]);
  const [firstHidden, setFirstHidden] = useState(0);

  const [indicator, setIndicator] = useState<Indicator>(null);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
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

  /* ---------------- Boot ---------------- */

  const runBoot = useCallback(async () => {
    if (!getSessionId()) {
      window.location.replace("/auth");
      return;
    }

    try {
      const convPromise = apiJson<{ items: ConversationItem[] }>("/api/conversations").catch(
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

      setUser({ ...DEFAULT_USER, ...profile, email: me.user?.email || "" });
      setBot({ ...DEFAULT_BOT_STATE, ...botCfg.bot });

      try {
        const fs = localStorage.getItem("aomi.fontSize");
        if (fs) document.documentElement.style.setProperty("--chat-fs", fs + "px");
      } catch { /* private mode */ }

      const convData = await convPromise;
      const bootItems: ConversationItem[] = convData ? convData.items || [] : [];
      setItems(bootItems);

      // Returning user: langsung buka percakapan terakhir; kosong → sapaan.
      if (bootItems.length > 0) {
        void loadConversation(bootItems[0].conversation_id);
      } else {
        void requestGreeting(true);
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

  /* ---------------- Greeting (karakter menyapa duluan) ---------------- */

  const requestGreeting = useCallback(
    async (greet: boolean) => {
      if (!greet || loadingRef.current) return;
      loadingRef.current = true;
      setIndicator("typing");

      try {
        const res = await api("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ greeting: true }),
        });
        const data = (await res.json().catch(() => null)) as ChatResponse | null;
        setIndicator(null);

        if (res.ok && data?.text && !data.already) {
          setCurrentId(data.conversation_id || null);
          pushMessages([
            { message_id: data.message_id!, role: "assistant", content: data.text, timestamp: new Date().toISOString() },
          ]);
          refreshSidebar();
        } else if (data?.already) {
          if (data.conversation_id) void loadConversation(data.conversation_id);
        } else {
          pushMessages([
            {
              message_id: "",
              role: "assistant",
              content: data?.error || "Dia sepertinya sedang sibuk sebentar. Coba lagi nanti.",
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      } catch (err) {
        setIndicator(null);
        if ((err as Error).message !== "unauthorized") {
          pushMessages([
            {
              message_id: "",
              role: "assistant",
              content: "Koneksi sedang bermasalah. Coba lagi nanti ya.",
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      } finally {
        loadingRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pushMessages]
  );

  /* ---------------- Refresh sidebar ---------------- */

  const refreshSidebar = useCallback(async () => {
    try {
      const data = await apiJson<{ items: ConversationItem[] }>("/api/conversations");
      setItems(data.items || []);
    } catch {
      // Error sesaat → PERTAHANKAN daftar lama.
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
      try {
        const r = await fetch(
          `${EDIT_API}?url=${encodeURIComponent(job.input_url)}&prompt=${encodeURIComponent(job.prompt)}`,
          { signal: ctrl.signal }
        );
        clearTimeout(timer);
        if (!r.ok) throw new Error("edit http " + r.status);
        blob = await r.blob();
        if (blob.size > EDIT_RESULT_MAX) throw new Error("hasil terlalu besar");
      } catch {
        clearTimeout(timer);
        setIndicator(null);
        pushMessages([
          {
            message_id: "",
            role: "assistant",
            content: "Ngeditnya kelamaan atau gagal. Kirim ulang fotonya bareng instruksinya ya.",
            timestamp: new Date().toISOString(),
          },
        ]);
        api("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "edit-fail",
            conversation_id: cid,
            message: "edit foto tadi gagal (kelamaan/gangguan) — kirim ulang fotonya ya.",
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

  /* ---------------- Kirim pesan ---------------- */

  const send = useCallback(
    async (rawText: string) => {
      const text = sanitizeText(rawText, 4000);
      const img = pendingImage;
      if ((!text && !img) || loadingRef.current) return;

      loadingRef.current = true;
      setInput("");

      // Render optimistik untuk pesan user
      const optimistic: Message = {
        message_id: "",
        role: "user",
        content: text,
        image: img?.thumb || undefined,
        timestamp: new Date().toISOString(),
      };
      pushMessages([optimistic]);
      setPendingImage(null);

      // Indikator: edit foto → label khusus; downloader → label file
      const wantsEdit = !!(img && text && EDIT_TRIGGER_RE.test(text));
      const wantsDl = !img && !wantsEdit && !!matchDlTarget(text);
      setIndicator(wantsEdit ? "editing" : wantsDl ? "downloading" : "typing");
      scrollToBottom(true);

      try {
        const res = await api("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: currentIdRef.current,
            message: text,
            ...(img ? { image: img.dataUrl, thumb: img.thumb } : {}),
          }),
        });
        const data = (await res.json().catch(() => null)) as ChatResponse | null;

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
          return;
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
          } else if (data.image_url) {
            msg.image_url = data.image_url;
            msg.image_name = data.image_name;
            msg.expires_at = data.expires_at;
            persistEditThumb(data.image_url, data.assistant_message_id || "", data.conversation_id || currentIdRef.current);
          }
          pushMessages([msg]);
          refreshSidebar();
        } else {
          pushMessages([
            {
              message_id: "",
              role: "assistant",
              content: data?.error || "Gagal mengirim. Coba lagi.",
              timestamp: new Date().toISOString(),
            },
          ]);
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
        }
      } finally {
        loadingRef.current = false;
      }
    },
    [pendingImage, pushMessages, refreshSidebar, runEditJob, scrollToBottom, persistEditThumb]
  );

  /* ---------------- Aksi pesan ---------------- */

  const openMenu = useCallback(
    (e: React.MouseEvent, m: Message) => {
      e.preventDefault();
      if (!m.content) return;
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
      if (ok) showToast("Copied ✓");
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
        if (prev.length === 0) {
          resetView();
          void requestGreeting(true);
        }
        return prev;
      });
    },
    [confirmDialog, loadConversation, resetView, requestGreeting]
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
      if (ok && nearBottomRef.current) scrollToBottom(true);
    },
    [loadConversation, pushMessages, refreshSidebar, runEditJob, scrollToBottom]
  );

  const doRegenerate = useCallback(
    async (mid: string) => {
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
          body: JSON.stringify({ action: "regenerate", conversation_id: cid }),
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
      if (ok && nearBottomRef.current) scrollToBottom(true);
    },
    [loadConversation, pushMessages, refreshSidebar, runEditJob, scrollToBottom]
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
        if (msg) {
          setMenu({
            x: lpX,
            y: lpY,
            mid: msg.message_id,
            role: msg.role,
            hasText: !!msg.content,
            isLast:
              msg.role === "assistant" &&
              loadedRef.current[loadedRef.current.length - 1]?.message_id === mid,
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
        isError={Boolean((m as Message & { isErrorHint?: boolean }).isErrorHint)}
        showName={showName}
        imageUrl={m.image || m.image_url || null}
        imageResult={!!file}
        mid={m.message_id || null}
        file={file}
        dl={dlOf(m)}
        sid={sid}
        userAvatar={user.avatar}
        botAvatar={bot.bot_avatar}
        userName={userName}
        botName={botName}
        editing={editMid === m.message_id}
        onEditText={(text) => m.message_id && void saveEdit(m.message_id, text)}
        onEditCancel={() => setEditMid(null)}
        onContextMenu={(e) => openMenu(e, m)}
      />
    );
  });

  // Tandai pesan error lokal (content tanpa mid yang dibuat flow error)
  // dilakukan via prop isErrorHint di atas; error rows dibuat dengan helper:
  const pushError = useCallback(
    (text: string) => {
      pushMessages([
        { message_id: "", role: "assistant", content: text, timestamp: new Date().toISOString(), isErrorHint: true } as Message,
      ]);
    },
    [pushMessages]
  );

  /* ---------------- Boot states ---------------- */

  if (boot === "loading") {
    return (
      <>
        <Intro />
        <div className="app" aria-busy="true" />
      </>
    );
  }

  if (boot === "error") {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
        <div>
          <p style={{ marginBottom: 14, color: "#a3a099", fontSize: 14 }}>
            Tidak bisa menghubungi server. Periksa koneksimu.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "10px 20px",
              borderRadius: 10,
              background: "#d29763",
              color: "#1d150d",
              border: 0,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
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
      <Intro />
      <div className="app">
        <Sidebar
          items={items}
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
            void requestGreeting(true);
          }}
          onOpenCharacter={() => {
            setSidebarOpen(false);
            setSettingsCat("bot");
            setSettingsOpen(true);
          }}
          onOpenSettings={() => {
            setSidebarOpen(false);
            setSettingsCat("profile");
            setSettingsOpen(true);
          }}
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
            if (currentIdRef.current === id) {
              resetView();
              void requestGreeting(true);
            }
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

          <section className="chat-scroll" ref={scrollRef}>
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

          <div className="composer-wrap">
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
                aria-label="Lampirkan gambar"
                onClick={() => fileRef.current?.click()}
              >
                <svg className="icon" aria-hidden="true"><use href="/icons.svg#plus" /></svg>
              </button>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                ref={fileRef}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) return;
                  try {
                    const dataUrl = await compressImage(file, 1024, 0.82);
                    const thumb = await compressImage(file, 360, 0.68);
                    setPendingImage({ dataUrl, thumb });
                  } catch {
                    pushError("Gagal memproses gambar. Coba file lain ya.");
                  }
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
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
              />
              <button
                className="send"
                type="submit"
                aria-label="Kirim"
                disabled={loadingRef.current || (!input.trim() && !pendingImage)}
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
        onRegenerate={(mid) => void doRegenerate(mid)}
      />

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
          user={user}
          bot={bot}
          onClose={() => setSettingsOpen(false)}
          onUserUpdate={(u) => setUser((prev) => ({ ...prev, ...u }))}
          onBotUpdate={(b) => setBot((prev) => ({ ...prev, ...b }))}
          onLogout={async () => {
            try {
              await api("/api/auth/logout", { method: "POST" });
            } catch { /* lanjut teardown lokal */ }
            import("@/lib/session").then((m) => {
              m.clearSessionId();
              m.resetClientState();
            });
            window.location.replace("/auth");
          }}
        />
      )}

    </>
  );
}
