"use client";

/* ============================================================
   Aomi — components/music/MusicProvider.tsx
   Provider global music player:
   - Satu elemen <audio> seumur hidup aplikasi → lagu TETAP
     berjalan di background walau pindah percakapan / buka
     settings, sampai user menekan stop.
   - Popup player melayang (bisa digeser), bisa di-minimize
     jadi mini bar. Tombol unduh ada di bawah player.
   - Link audio savetube bisa kedaluwarsa → saat error, player
     resolve ulang via /api/music?action=resolve (sekali per lagu).
   ============================================================ */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Icon from "@/components/ui/Icon";
import { api } from "@/lib/client-api";
import { getSessionId } from "@/lib/session";
import type { MusicCard } from "@/types";

/* ---------------- helpers ---------------- */

export function fmtTime(sec: number): string {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return m + ":" + String(r).padStart(2, "0");
}

function safeName(title: string): string {
  return String(title || "lagu")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50) || "lagu";
}

/** Link unduh lagu (diproxy server → attachment, nama file rapi). */
export function musicDownloadHref(card: MusicCard, sid: string | null): string {
  const name = "Aomi - " + safeName(card.title) + ".m4a";
  return (
    "/api/music?action=dl&id=" +
    encodeURIComponent(card.video_id) +
    "&name=" +
    encodeURIComponent(name) +
    (sid ? "&sid=" + sid : "")
  );
}

/* ---------------- ikon transport (inline, fill-based) ---------------- */

function PlayIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M8 5.6v12.8a.6.6 0 0 0 .92.5l10-6.4a.6.6 0 0 0 0-1l-10-6.4a.6.6 0 0 0-.92.5z" />
    </svg>
  );
}

function PauseIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <rect x="6.5" y="5" width="3.8" height="14" rx="1" />
      <rect x="13.7" y="5" width="3.8" height="14" rx="1" />
    </svg>
  );
}

function SkipIcon({ dir }: { dir: -1 | 1 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="19"
      height="19"
      aria-hidden="true"
    >
      <path d={dir === -1 ? "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" : "M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"} />
      <path d={dir === -1 ? "M3 3v5h5" : "M21 3v5h-5"} />
      <text x="12" y="16.5" fontSize="7.5" fontFamily="sans-serif" fontWeight="bold" stroke="none" fill="currentColor" textAnchor="middle">
        10
      </text>
    </svg>
  );
}

/** Equalizer 3 bar kecil — id-indikator lagu lagi jalan. */
function Eq({ on }: { on: boolean }) {
  return (
    <span className={"music-eq" + (on ? " on" : "")} aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

/* ---------------- context ---------------- */

interface MusicApi {
  track: MusicCard | null;
  playing: boolean;
  minimized: boolean;
  /** Putar kartu lagu + buka popup. */
  playMusic: (card: MusicCard) => void;
  togglePlay: () => void;
  stopMusic: () => void;
  minimize: () => void;
  expand: () => void;
  /** Seek absolut (detik). */
  seek: (sec: number) => void;
}

const Ctx = createContext<MusicApi | null>(null);

export function useMusic(): MusicApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMusic harus di dalam <MusicProvider>");
  return ctx;
}

/* ---------------- provider ---------------- */

export default function MusicProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const refreshTriedRef = useRef<string | null>(null); // video_id yang sudah dicoba resolve ulang
  const [track, setTrack] = useState<MusicCard | null>(null);
  const [playing, setPlaying] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);

  // Salinan track terbaru untuk listener — hindari stale closure
  const trackRef = useRef<MusicCard | null>(null);
  useEffect(() => {
    trackRef.current = track;
  }, [track]);

  /** Elemen audio tunggal (dibuat sekali, dipakai sepanjang sesi). */
  const getAudio = useCallback((): HTMLAudioElement => {
    if (audioRef.current) return audioRef.current;
    const a = new Audio();
    a.preload = "auto";
    a.addEventListener("timeupdate", () => setTime(a.currentTime));
    a.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(a.duration)) setDur(a.duration);
    });
    a.addEventListener("durationchange", () => {
      if (Number.isFinite(a.duration)) setDur(a.duration);
    });
    a.addEventListener("play", () => setPlaying(true));
    a.addEventListener("pause", () => setPlaying(false));
    a.addEventListener("ended", () => {
      setPlaying(false);
      setTime(0);
    });
    a.addEventListener("error", () => {
      setPlaying(false);
      // Link savetube kedaluwarsa → resolve ulang (sekali per lagu)
      const card = trackRef.current;
      if (!card || refreshTriedRef.current === card.video_id) return;
      refreshTriedRef.current = card.video_id;
      api("/api/music?action=resolve&id=" + encodeURIComponent(card.video_id))
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { audio_url?: string } | null) => {
          if (!data?.audio_url) return;
          setTrack((t) => (t ? { ...t, audio_url: data.audio_url! } : t));
          a.src = data.audio_url;
          a.play().catch(() => setPlaying(false));
        })
        .catch(() => {});
    });
    audioRef.current = a;
    return a;
  }, []);

  const playMusic = useCallback(
    (card: MusicCard) => {
      const a = getAudio();
      const isNew = trackRef.current?.video_id !== card.video_id;
      setTrack(card);
      setMinimized(false);
      if (isNew) {
        refreshTriedRef.current = null;
        setTime(0);
        setDur(card.duration || 0);
      }
      if (isNew || !a.src || a.src !== card.audio_url) {
        if (card.audio_url) {
          a.src = card.audio_url;
          a.play().catch(() => setPlaying(false));
          return;
        }
        // Tanpa audio_url (riwayat lama) → langsung resolve
        refreshTriedRef.current = card.video_id;
        api("/api/music?action=resolve&id=" + encodeURIComponent(card.video_id))
          .then((res) => (res.ok ? res.json() : null))
          .then((data: { audio_url?: string } | null) => {
            if (!data?.audio_url) return;
            setTrack((t) => (t ? { ...t, audio_url: data.audio_url! } : t));
            a.src = data.audio_url;
            a.play().catch(() => setPlaying(false));
          })
          .catch(() => {});
        return;
      }
      a.play().catch(() => setPlaying(false));
    },
    [getAudio]
  );

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    const card = trackRef.current;
    if (!a || !card) return;
    if (a.paused) {
      if (!a.src) return playMusic(card);
      a.play().catch(() => setPlaying(false));
    } else {
      a.pause();
    }
  }, [playMusic]);

  const seek = useCallback((sec: number) => {
    const a = audioRef.current;
    if (!a) return;
    const total =
      Number.isFinite(a.duration) && a.duration > 0
        ? a.duration
        : trackRef.current?.duration || 0;
    if (total <= 0) return;
    const t = Math.max(0, Math.min(total, Number(sec) || 0));
    a.currentTime = t;
    setTime(t);
  }, []);

  const stopMusic = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    setTrack(null);
    setPlaying(false);
    setTime(0);
    setDur(0);
    setMinimized(false);
  }, []);

  const minimize = useCallback(() => setMinimized(true), []);
  const expand = useCallback(() => setMinimized(false), []);

  const value = useMemo<MusicApi>(
    () => ({ track, playing, minimized, playMusic, togglePlay, stopMusic, minimize, expand, seek }),
    [track, playing, minimized, playMusic, togglePlay, stopMusic, minimize, expand, seek]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {track && (
        <MusicPopup
          track={track}
          playing={playing}
          minimized={minimized}
          time={time}
          dur={dur || track.duration}
        />
      )}
    </Ctx.Provider>
  );
}

/* ---------------- popup player ---------------- */

function MusicPopup({
  track,
  playing,
  minimized,
  time,
  dur,
}: {
  track: MusicCard;
  playing: boolean;
  minimized: boolean;
  time: number;
  dur: number;
}) {
  const { togglePlay, stopMusic, minimize, expand, seek } = useMusic();
  const sid = getSessionId();

  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const dragRef = useRef<{ x: number; y: number; dx: number; dy: number; rect: DOMRect } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const lyricsRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const seekingRef = useRef(false);

  // ---- lirik aktif (binary search) ----
  const lines = track.lyrics || [];
  const activeIdx = useMemo(() => {
    if (!lines.length) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    let res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= time) {
        res = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return res;
  }, [lines, time]);

  // auto-scroll lirik ke baris aktif.
  // Posisi dihitung relatif ke KOTAK LIRIK (bukan parent luar) —
  // inilah yang dulu bikin lirik loncat ke bawah.
  useEffect(() => {
    if (minimized) return;
    const cont = lyricsRef.current;
    if (!cont) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduce ? "auto" : "smooth";
    if (activeIdx < 0) {
      cont.scrollTo({ top: 0, behavior }); // intro — tetap di atas
      return;
    }
    const el = lineRefs.current[activeIdx];
    if (!el) return;
    const top =
      el.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop;
    const target = top - cont.clientHeight / 2 + el.offsetHeight / 2;
    cont.scrollTo({ top: Math.max(0, target), behavior });
  }, [activeIdx, minimized]);

  // ---- geser popup (pointer di header) ----
  const onDragStart = (e: React.PointerEvent) => {
    const box = boxRef.current;
    if (!box || e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, dx: drag.dx, dy: drag.dy, rect: box.getBoundingClientRect() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ndx = Math.max(-d.rect.left, Math.min(vw - d.rect.right, d.dx + (e.clientX - d.x)));
    const ndy = Math.max(-d.rect.top, Math.min(vh - d.rect.bottom, d.dy + (e.clientY - d.y)));
    setDrag({ dx: ndx, dy: ndy });
  };
  const onDragEnd = () => {
    dragRef.current = null;
  };

  // ---- seek via bar ----
  const seekFromX = (clientX: number) => {
    const el = barRef.current;
    if (!el || dur <= 0) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - r.left, r.width));
    seek((x / r.width) * dur);
  };
  const onSeekDown = (e: React.PointerEvent) => {
    seekingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seekFromX(e.clientX);
  };
  const onSeekMove = (e: React.PointerEvent) => {
    if (seekingRef.current) seekFromX(e.clientX);
  };
  const onSeekUp = () => {
    seekingRef.current = false;
  };

  // ---------------- mini bar (minimize — musik tetap jalan) ----------------
  if (minimized) {
    return (
      <div className="music-mini" role="complementary" aria-label="Musik diputar">
        <button type="button" className="music-mini-main" onClick={expand} title="Buka player">
          <img className="music-mini-cover" src={track.thumbnail} alt="" loading="lazy" />
          <span className="music-mini-meta">
            <span className="music-mini-title">{track.title}</span>
            <span className="music-mini-artist">{track.artist}</span>
          </span>
        </button>
        <Eq on={playing} />
        <button type="button" className="music-mini-btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Putar"}>
          {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
        </button>
        <button type="button" className="music-mini-btn" onClick={stopMusic} aria-label="Stop musik">
          <Icon id="close" />
        </button>
      </div>
    );
  }

  // ---------------- popup penuh ----------------
  const pct = dur > 0 ? Math.min(100, (time / dur) * 100) : 0;

  return (
    <div
      ref={boxRef}
      className="music-player"
      style={{ transform: `translate(${drag.dx}px, ${drag.dy}px)` }}
      role="complementary"
      aria-label="Music player"
    >
      {/* header — area drag */}
      <div
        className="music-head"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <span className="music-head-label">
          <Icon id="music" />
          Now playing
        </span>
        <span className="music-head-actions">
          <button type="button" className="music-head-btn" onClick={minimize} aria-label="Kecilkan (musik tetap jalan)" title="Kecilkan — musik tetap jalan">
            <Icon id="chevron-down" />
          </button>
          <button type="button" className="music-head-btn" onClick={stopMusic} aria-label="Stop musik" title="Stop">
            <Icon id="close" />
          </button>
        </span>
      </div>

      {/* lagu — cover kecil + judul (layout pendek, flat) */}
      <div className="music-track">
        <img className="music-cover" src={track.thumbnail} alt={track.title} />
        <div className="music-track-meta">
          <div className="music-title">{track.title}</div>
          <div className="music-artist">
            {track.artist}
            {track.duration ? " · " + fmtTime(track.duration) : ""}
          </div>
          <Eq on={playing} />
        </div>
      </div>

      {/* lirik sinkron — klik baris untuk lompat ke waktunya */}
      <div className="music-lyrics" ref={lyricsRef}>
        {lines.length ? (
          <>
            {lines.map((l, i) => (
              <button
                key={i}
                type="button"
                ref={(el) => { lineRefs.current[i] = el; }}
                className={"music-lyric" + (i === activeIdx ? " active" : "")}
                onClick={() => seek(l.time)}
              >
                {l.text}
              </button>
            ))}
            {track.lyrics_estimated ? (
              <div className="music-lyrics-note">sinkronisasi lirik perkiraan</div>
            ) : null}
          </>
        ) : (
          <div className="music-lyrics-empty">lirik belum tersedia untuk lagu ini.</div>
        )}
      </div>

      {/* progres */}
      <div
        className="music-bar"
        ref={barRef}
        onPointerDown={onSeekDown}
        onPointerMove={onSeekMove}
        onPointerUp={onSeekUp}
        onPointerCancel={onSeekUp}
        role="slider"
        aria-label="Posisi lagu"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(time)}
      >
        <div className="music-bar-fill" style={{ width: pct + "%" }} />
        <div className="music-bar-dot" style={{ left: pct + "%" }} />
      </div>
      <div className="music-time">
        <span>{fmtTime(time)}</span>
        <span>{fmtTime(dur)}</span>
      </div>

      {/* kontrol */}
      <div className="music-controls">
        <button type="button" className="music-ctrl" onClick={() => seek(time - 10)} aria-label="Mundur 10 detik" title="Mundur 10 detik">
          <SkipIcon dir={-1} />
        </button>
        <button type="button" className="music-play" onClick={togglePlay} aria-label={playing ? "Pause" : "Putar"}>
          {playing ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
        </button>
        <button type="button" className="music-ctrl" onClick={() => seek(time + 10)} aria-label="Maju 10 detik" title="Maju 10 detik">
          <SkipIcon dir={1} />
        </button>
      </div>

      {/* unduh — di bawah player */}
      <a className="music-dl" href={musicDownloadHref(track, sid)} download>
        <Icon id="download" />
        <span>Unduh lagu</span>
      </a>
    </div>
  );
}
