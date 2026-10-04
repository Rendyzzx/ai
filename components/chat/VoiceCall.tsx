"use client";

/**
 * Mode telepon suara Aomi (half-duplex, Web Speech API):
 *   dengar (STT) → kirim sebagai pesan chat → jawaban diucapkan (TTS) → dengar lagi.
 * Tanpa API key, tanpa server — semua di browser.
 * Browser tanpa SpeechRecognition: tombol tidak dirender.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureMicPermission,
  getSpeechRecognition,
  pickVoice,
  stripForSpeech,
  ttsSupported,
  type SpeechRecognitionLike,
} from "@/lib/voice";

export type VoicePhase = "idle" | "listening" | "thinking" | "speaking" | "error";

const PHASE_LABEL: Record<Exclude<VoicePhase, "idle" | "error">, string> = {
  listening: "Mendengarkan…",
  thinking: "Menyambung…",
  speaking: "Aomi menjawab…",
};

/** Pesan error ramah user per kode kegagalan mic/STT. */
const ERR_TEXT: Record<string, string> = {
  not_allowed:
    "Izin mikrofon ditolak. Klik ikon kunci/gembok di address bar → izinkan Mikrofon, lalu coba lagi.",
  no_mic: "Mikrofon tidak ditemukan. Pastikan mic terpasang & tidak dipakai aplikasi lain.",
  network: "Layanan suara terputus dari internet. Cek koneksi, lalu coba lagi.",
  service: "Browser ini memblokir layanan suara. Coba Chrome, Edge, atau Safari.",
  unsupported:
    "Browser ini tidak mendukung panggilan suara. Coba Chrome, Edge, atau Safari.",
};

/**
 * Loop telepon. `onSendText` mengirim teks user ke pipeline chat biasa
 * dan mengembalikan teks jawaban Aomi (null bila gagal).
 */
export function useVoiceCall(onSendText: (text: string) => Promise<string | null>) {
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [transcript, setTranscript] = useState("");
  const [errorText, setErrorText] = useState("");

  const stopRef = useRef(false);
  const runningRef = useRef(false);
  const sendRef = useRef(onSendText);
  sendRef.current = onSendText;

  /** Ucapkan satu balasan; resolve saat selesai (atau pengaman timeout). */
  const speak = useCallback((text: string) => {
    return new Promise<void>((resolve) => {
      const clean = stripForSpeech(text);
      if (!clean || !ttsSupported()) return resolve();
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = "id-ID";
      const v = pickVoice();
      if (v) u.voice = v;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;
      // Safari kadang tak memanggil onend → pengaman kasar per panjang teks
      const ms = Math.min(90_000, Math.max(8_000, clean.length * 90));
      setTimeout(finish, ms);
      window.speechSynthesis.speak(u);
    });
  }, []);

  /**
   * Satu sesi dengar. Resolve:
   * - string   → hasil akhir user (bisa "" kalau cuma hening)
   * - { fatal: kode } → error fatal; kode dipetakan ke pesan ramah user
   */
  const listenOnce = useCallback(() => {
    type Res = string | { fatal: string };
    return new Promise<Res>((resolve) => {
      const Ctor = getSpeechRecognition();
      if (!Ctor) return resolve({ fatal: "unsupported" });
      let rec: SpeechRecognitionLike;
      try {
        rec = new Ctor();
      } catch {
        return resolve({ fatal: "service" });
      }
      rec.lang = "id-ID";
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      let settled = false;
      let finalText = "";
      const finish = (t: Res) => {
        if (settled) return;
        settled = true;
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
        resolve(t);
      };

      rec.onresult = (e) => {
        let interim = "";
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          const t = r[0]?.transcript ?? "";
          if (r.isFinal) finalText = (finalText + " " + t).trim();
          else interim = t;
        }
        setTranscript((finalText + " " + interim).trim());
      };
      rec.onerror = (e) => {
        const err = String(e?.error || "");
        if (err === "no-speech" || err === "aborted") {
          finish(finalText);
        } else if (err === "not-allowed" || err === "service-not-allowed") {
          finish({ fatal: "not_allowed" });
        } else if (err === "audio-capture") {
          finish({ fatal: "no_mic" });
        } else if (err === "network") {
          finish({ fatal: "network" });
        } else {
          finish({ fatal: "service" });
        }
      };
      rec.onend = () => {
        // hening / selesai sendiri tanpa final result
        finish(finalText);
      };

      try {
        rec.start();
      } catch {
        finish({ fatal: "service" });
      }
    });
  }, []);

  const start = useCallback(() => {
    if (runningRef.current || !getSpeechRecognition()) return;
    runningRef.current = true;
    stopRef.current = false;
    setActive(true);
    setErrorText("");
    setPhase("listening");

    void (async () => {
      // Precheck izin mic — prompt izin muncul jelas di browser;
      // kalau ditolak, tampilkan pesan (bukan kedip senyap seperti dulu).
      const perm = await ensureMicPermission();
      if (stopRef.current) return;
      if (perm !== "granted") {
        runningRef.current = false;
        setErrorText(ERR_TEXT[perm === "denied" ? "not_allowed" : "unsupported"]);
        setPhase("error");
        return;
      }

      while (!stopRef.current) {
        const t = await listenOnce();
        if (stopRef.current) break;
        if (typeof t !== "string") {
          // error fatal → tampilkan pesan; tetap terlihat sampai user menutup
          runningRef.current = false;
          setErrorText(ERR_TEXT[t.fatal] || ERR_TEXT.service);
          setPhase("error");
          return;
        }
        const text = t.trim();
        setTranscript("");
        if (!text) continue; // cuma hening → dengar lagi
        setPhase("thinking");
        let reply: string | null = null;
        try {
          reply = await sendRef.current(text);
        } catch {
          reply = null;
        }
        if (stopRef.current) break;
        if (reply) {
          setPhase("speaking");
          await speak(reply);
        }
        if (stopRef.current) break;
        setPhase("listening");
      }
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
      runningRef.current = false;
      setActive(false);
      setPhase("idle");
      setTranscript("");
    })();
  }, [listenOnce, speak]);

  const stop = useCallback(() => {
    stopRef.current = true;
    setErrorText("");
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    setActive(false);
    setPhase("idle");
    setTranscript("");
  }, []);

  // lepas mic saat komponen unmount / ganti halaman
  useEffect(() => {
    return () => {
      stopRef.current = true;
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, []);

  return { active, phase, transcript, errorText, start, stop };
}

/** Pil melayang status telepon (fixed, atas tengah). */
export function VoiceCallOverlay({
  phase,
  transcript,
  errorText,
  onStop,
}: {
  phase: VoicePhase;
  transcript: string;
  errorText?: string;
  onStop: () => void;
}) {
  if (phase === "idle") return null;
  const isError = phase === "error";
  return (
    <div
      className="voice-call"
      data-error={isError ? "" : undefined}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
    >
      <span className="voice-dot" data-phase={phase} aria-hidden="true" />
      <div className="voice-info">
        {isError ? (
          <>
            <strong>Telepon suara gagal mulai</strong>
            <span className="voice-transcript">{errorText}</span>
          </>
        ) : (
          <>
            <strong>{PHASE_LABEL[phase]}</strong>
            {transcript && <span className="voice-transcript">“{transcript}”</span>}
          </>
        )}
      </div>
      <button type="button" className="voice-end" onClick={onStop}>
        <svg className="icon" aria-hidden="true">
          <use href="/icons.svg#phone" />
        </svg>
        {isError ? "Tutup" : "Akhiri"}
      </button>
    </div>
  );
}
