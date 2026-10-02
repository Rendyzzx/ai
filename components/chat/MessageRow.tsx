"use client";

/* ============================================================
   Aomi — components/chat/MessageRow.tsx
   Satu baris pesan. Struktur DOM identik dengan versi lama:
   assistant (kiri): [avatar, body]; user (kanan): [body, avatar].
   Teks dirender via React text node → HTML dalam pesan tidak
   pernah dieksekusi. Port dari messageNode() di chat.js.
   ============================================================ */

import { useEffect, useRef, useState } from "react";
import Icon from "@/components/ui/Icon";
import Avatar from "@/components/ui/Avatar";
import { parseMessageText } from "@/lib/markdown";
import type { DlCard, HdCard, MusicCard, Role } from "@/types";
import MusicCardView from "@/components/music/MusicCardView";
import { api } from "@/lib/client-api";

export interface MessageFile {
  url: string;
  name?: string | null;
  expiresAt?: string | null;
}

export type Indicator = "typing" | "editing" | "downloading" | "music" | "generating" | "hdvid" | null;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback browser lama / konteks tidak aman
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* ---------------- Code block (dengan tombol Salin) ---------------- */

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const ok = await copyText(code);
    setCopied(ok);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || "code"}</span>
        <button type="button" className={"code-copy" + (copied ? " copied" : "")} onClick={onCopy}>
          <Icon id="copy" />
          <span>{copied ? "Tersalin" : "Salin"}</span>
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* ---------------- Teks pesan (inline code + code block) ---------------- */

export function MessageText({ content, showCode = true }: { content: string; showCode?: boolean }) {
  const segments = parseMessageText(content);
  // showCode=false → fence/inline code dirender sebagai teks biasa
  // (preferensi "Tampilkan blok kode" di Settings > Percakapan).
  return (
    <span className="message-text">
      {segments.map((s, i) => {
        if (s.kind === "code") {
          if (!showCode) return <span key={i}>{s.code}</span>;
          return <CodeBlock key={i} lang={s.lang} code={s.code} />;
        }
        if (s.kind === "inline") {
          if (!showCode) return <span key={i}>{s.text}</span>;
          return <code key={i} className="inline-code">{s.text}</code>;
        }
        return <span key={i}>{s.text}</span>;
      })}
    </span>
  );
}

/* ---------------- Tombol unduh kartu DL ---------------- */

function dlDownloadHref(dl: DlCard, url: string, name: string, sid: string | null): string {
  if (dl.platform === "ig") return url;
  return (
    "/api/dl?url=" +
    encodeURIComponent(url) +
    "&name=" +
    encodeURIComponent(name) +
    (sid ? "&sid=" + encodeURIComponent(sid) : "")
  );
}

function DlBtn({
  dl,
  kind,
  sid,
}: {
  dl: DlCard;
  kind: "mp4" | "mp3";
  sid: string | null;
}) {
  const url = kind === "mp4" ? dl.video! : dl.music!;
  const name =
    (dl.platform === "tiktok" ? "tiktok-" + (dl.id || (kind === "mp4" ? "video" : "audio")) : "instagram-" + kind) +
    (kind === "mp4" ? ".mp4" : ".mp3");
  return (
    <a
      className="dl-btn"
      rel="noopener"
      href={dlDownloadHref(dl, url, name, sid)}
      aria-label={kind === "mp4" ? "Unduh video MP4" : "Unduh audio MP3"}
      {...(dl.platform === "ig" ? { target: "_blank" } : {})}
    >
      <Icon id="download" />
      <span>{kind === "mp4" ? "MP4" : "MP3"}</span>
    </a>
  );
}

/* ---------------- Kartu downloader (TikTok / Instagram) ---------------- */

export function DlCardView({ dl, sid }: { dl: DlCard; sid: string | null }) {
  const imgs = Array.isArray(dl.images) ? dl.images.slice(0, 12) : [];
  return (
    <div className="dl-card">
      <div className="dl-head">
        <span className="dl-badge">{dl.platform === "tiktok" ? "TikTok" : "Instagram"}</span>
        <span className="dl-title">{dl.title || (dl.type === "video" ? "Video" : "Foto")}</span>
      </div>
      {dl.author && (
        <div className="dl-sub">
          {"by " + dl.author + (dl.music_title ? " · " + dl.music_title : "")}
        </div>
      )}
      {dl.type === "video" && dl.video ? (
        <>
          {dl.cover && (
            // Link CDN kedaluwarsa → onerror sembunyikan (kartu tetap berguna)
            <img className="dl-thumb" src={dl.cover} alt="Thumbnail video" loading="lazy" />
          )}
          <div className="dl-btns">
            <DlBtn dl={dl} kind="mp4" sid={sid} />
            {dl.music && <DlBtn dl={dl} kind="mp3" sid={sid} />}
          </div>
        </>
      ) : (
        <>
          {imgs.length > 0 && (
            <div className="dl-imgs">
              {imgs.map((u, i) => (
                <a
                  key={i}
                  className="dl-img-link"
                  href={dlDownloadHref(
                    dl,
                    u,
                    (dl.platform === "tiktok" ? "tiktok-" + (dl.id || "img") : "instagram-img") +
                      "-" +
                      (i + 1) +
                      ".jpg",
                    sid
                  )}
                  rel="noopener"
                  {...(dl.platform === "ig" ? { target: "_blank" } : {})}
                >
                  <img className="dl-img" src={u} alt={"Foto " + (i + 1)} loading="lazy" />
                </a>
              ))}
            </div>
          )}
          {dl.music && (
            <div className="dl-btns">
              <DlBtn dl={dl} kind="mp3" sid={sid} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- Indikator typing / editing / downloading ---------------- */

export function IndicatorRow({ indicator }: { indicator: Exclude<Indicator, null> }) {
  return (
    <div className="message-row assistant typing editing">
      <div className="message-avatar" aria-hidden="true">
        <Icon id="logo" />
      </div>
      <div className="message-body">
        <div className="message-header" data-role="assistant" hidden>
          Aomi
        </div>
        <div className="message-content">
          {indicator === "editing" ? (
            <>
              <Icon id="image" className="edit-ic" />
              <span className="edit-label">lagi ngedit fotonya</span>
            </>
          ) : indicator === "downloading" ? (
            <>
              <Icon id="download" className="edit-ic" />
              <span className="edit-label">lagi nyariin file-nya</span>
            </>
          ) : indicator === "music" ? (
            <>
              <Icon id="music" className="edit-ic" />
              <span className="edit-label">lagi nyariin lagunya</span>
            </>
          ) : indicator === "generating" ? (
            <>
              <Icon id="image" className="edit-ic" />
              <span className="edit-label">lagi bikin gambarnya</span>
            </>
          ) : indicator === "hdvid" ? (
            <>
              <Icon id="download" className="edit-ic" />
              <span className="edit-label">lagi proses HD video-nya</span>
            </>
          ) : null}
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </div>
      </div>
    </div>
  );
}

/* ---------------- Kartu HD video (polling job + tombol unduh) ---------------- */

const HD_POLL_INTERVAL_MS = 4000;
const HD_POLL_MAX_TRIES = 90; // ~6 menit

export function HdCardView({ hd, sid }: { hd: HdCard; sid: string | null }) {
  const [state, setState] = useState<"pending" | "done" | "error">(
    hd.state === "done" ? "done" : hd.state === "error" ? "error" : "pending"
  );
  const [quality, setQuality] = useState<string>(hd.quality || "HD");
  const pollStarted = useRef(false);

  // Job masih pending -> polling /api/hd tiap beberapa detik sampai
  // done/error. Kartu di riwayat lama juga otomatis lanjut polling
  // (job_id stabil di pesan, hasil segar diambil ulang tiap buka chat).
  useEffect(() => {
    if (state !== "pending" || !hd.job_id || pollStarted.current) return;
    pollStarted.current = true;
    let stopped = false;
    (async () => {
      for (let tries = 0; tries < HD_POLL_MAX_TRIES && !stopped; tries++) {
        await new Promise((r) => setTimeout(r, HD_POLL_INTERVAL_MS));
        if (stopped) return;
        try {
          const res = await api("/api/hd?action=poll&job=" + encodeURIComponent(hd.job_id));
          const data = (await res.json().catch(() => null)) as
            | { state?: string; download_url?: string; quality?: string }
            | null;
          if (stopped) return;
          if (data?.state === "done" && data.download_url) {
            if (data.quality) setQuality(data.quality);
            setState("done");
            return;
          }
          if (data?.state === "error") {
            setState("error");
            return;
          }
        } catch (err) {
          if ((err as Error).message === "unauthorized") return;
          // gangguan sesaat -> jeda lalu coba lagi
        }
      }
      if (!stopped) setState("error");
    })();
    return () => {
      stopped = true;
    };
  }, [state, hd.job_id]);

  return (
    <div className="dl-card hd-card">
      <div className="dl-head">
        <span className="dl-badge">HD</span>
        <span className="dl-title">Video HD</span>
      </div>
      <div className="dl-sub">upgrade kualitas video</div>
      {state === "pending" && (
        <div className="hd-pending" role="status">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="hd-pending-label">lagi diproses, hasilnya muncul di sini…</span>
        </div>
      )}
      {state === "error" && (
        <div className="hd-hint">hasilnya gak bisa diambil (kedaluwarsa / gagal). coba kirim ulang link videonya ya.</div>
      )}
      {state === "done" && (
        <div className="dl-btns">
          <a
            className="dl-btn"
            rel="noopener"
            href={
              "/api/hd?action=dl&job=" +
              encodeURIComponent(hd.job_id) +
              "&name=aomi-hd" +
              (sid ? "&sid=" + encodeURIComponent(sid) : "")
            }
            aria-label="Unduh video HD"
          >
            <Icon id="download" />
            <span>{"MP4 · " + quality}</span>
          </a>
        </div>
      )}
    </div>
  );
}

/* ---------------- Baris pesan ---------------- */

export default function MessageRow({
  role,
  content,
  isError,
  showName,
  imageUrl,
  imageResult,
  mid,
  file,
  dl,
  music,
  hd,
  sid,
  userAvatar,
  botAvatar,
  userName,
  botName,
  showCode,
  editing,
  onEditText,
  onEditCancel,
  onContextMenu,
  children,
}: {
  role: Role;
  content: string;
  showCode?: boolean;
  isError?: boolean;
  showName?: boolean;
  imageUrl?: string | null;
  imageResult?: boolean;
  mid?: string | null;
  file?: MessageFile | null;
  dl?: DlCard | null;
  music?: MusicCard | null;
  hd?: HdCard | null;
  sid: string | null;
  userAvatar: string | null;
  botAvatar: string | null;
  userName: string;
  botName: string;
  editing?: boolean;
  onEditText?: (text: string) => void;
  onEditCancel?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
}) {
  const avatar = (
    <div className="message-avatar" aria-hidden="true">
      <Avatar src={role === "user" ? userAvatar : botAvatar} fallbackIcon={role === "user" ? "user" : "logo"} />
    </div>
  );

  const fileAlive = file?.url ? (file.expiresAt ? Date.parse(file.expiresAt) > Date.now() : true) : false;

  const body = (
    <div className="message-body">
      <div
        className="message-header"
        data-role={role}
        hidden={!(role === "assistant" && showName)}
      >
        {role === "user" ? userName : botName}
      </div>
      <div className="message-content">
        {imageUrl && (
          <img
            className={"message-image" + (imageResult ? " result" : "")}
            src={imageUrl}
            alt="Gambar terlampir"
            loading="lazy"
          />
        )}
        {content ? (
          <MessageText content={content} showCode={showCode} />
        ) : !imageUrl ? null : null}
        {file && file.url && fileAlive && (
          <a
            className="img-dl"
            href={
              file.url +
              (file.url.includes("?") ? "&" : "?") +
              "dl=1" +
              (file.name ? "&name=" + encodeURIComponent(file.name) : "")
            }
            download={file.name || "aomi-edit.png"}
          >
            <Icon id="download" />
            <span>Unduh</span>
          </a>
        )}
        {file && file.url && !fileAlive && (
          <span className="img-dl-hint">masa unduh sudah habis</span>
        )}
        {dl && <DlCardView dl={dl} sid={sid} />}
        {hd && <HdCardView hd={hd} sid={sid} />}
        {music && <MusicCardView music={music} />}
        {editing && (
          <div className="edit-box">
            <EditBox
              initial={content}
              onSave={onEditText || (() => {})}
              onCancel={onEditCancel || (() => {})}
            />
          </div>
        )}
        {children}
      </div>
    </div>
  );

  return (
    <div
      onContextMenu={onContextMenu}
      className={
        "message-row " +
        (role === "user" ? "user" : "assistant") +
        (isError ? " error" : "") +
        (!(role === "assistant" && showName) ? " compact" : "")
      }
      data-mid={mid || undefined}
    >
      {role === "user" ? (
        <>
          {body}
          {avatar}
        </>
      ) : (
        <>
          {avatar}
          {body}
        </>
      )}
    </div>
  );
}

/* ---------------- Inline edit box ---------------- */

function EditBox({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <textarea
        className="edit-input"
        rows={2}
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSave(value);
          }
          if (e.key === "Escape") onCancel();
        }}
        onFocus={(e) => {
          e.target.setSelectionRange(e.target.value.length, e.target.value.length);
        }}
      />
      <div className="edit-actions">
        <button type="button" className="edit-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="edit-save" onClick={() => onSave(value)}>
          Save
        </button>
      </div>
    </>
  );
}
