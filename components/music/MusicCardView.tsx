"use client";

/* ============================================================
   Aomi — components/music/MusicCardView.tsx
   Kartu lagu di dalam bubble chat. Klik → putar / pause lewat
   player global (MusicProvider). Ada tombol unduh kecil.
   ============================================================ */

import { useMusic, musicDownloadHref, fmtTime } from "@/components/music/MusicProvider";
import { getSessionId } from "@/lib/session";
import type { MusicCard } from "@/types";

export default function MusicCardView({ music }: { music: MusicCard }) {
  const { track, playing, playMusic, togglePlay } = useMusic();
  const sid = getSessionId();
  const isCurrent = track?.video_id === music.video_id;
  const isPlaying = isCurrent && playing;

  return (
    <div className="music-card">
      <button type="button" className="music-card-main" onClick={() => (isCurrent ? togglePlay() : playMusic(music))}>
        <span className="music-card-cover">
          <img src={music.thumbnail} alt="" loading="lazy" />
          <span className={"music-card-play" + (isPlaying ? " on" : "")} aria-hidden="true">
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <rect x="6.5" y="5" width="3.8" height="14" rx="1" />
                <rect x="13.7" y="5" width="3.8" height="14" rx="1" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M8 5.6v12.8a.6.6 0 0 0 .92.5l10-6.4a.6.6 0 0 0 0-1l-10-6.4a.6.6 0 0 0-.92.5z" />
              </svg>
            )}
          </span>
        </span>
        <span className="music-card-meta">
          <span className="music-card-title">{music.title}</span>
          <span className="music-card-sub">
            {music.artist} · {fmtTime(music.duration)}
            {isCurrent ? (isPlaying ? " · diputar" : " · dijeda") : ""}
          </span>
        </span>
      </button>
      <a className="music-card-dl" href={musicDownloadHref(music, sid)} download aria-label="Unduh lagu">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </a>
    </div>
  );
}
