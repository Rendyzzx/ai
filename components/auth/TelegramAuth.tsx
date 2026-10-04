"use client";

/* ============================================================
   Aomi — components/auth/TelegramAuth.tsx
   Panel kecil "Masuk dengan Telegram" / "Hubungkan Telegram".

   Flow (client-nya ringan; semua verifikasi di server):
   1. Buka attempt  → POST /api/auth/telegram/start
   2. Buka bot      → t.me/<bot>?start=auth_<id> (deep link)
   3. Masukkan kode → POST /api/auth/telegram/verify

   Dipakai di dua tempat:
   - AuthLanding  (mode "login")  → sukses: simpan session, ke "/"
   - SettingsView (mode "link")   → sukses: refresh status provider
   ============================================================ */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client-api";

export type TgMode = "login" | "link";

interface Props {
  mode: TgMode;
  /** Attempt id dari URL (?tg=... tombol "Buka Aomi" dari bot). */
  initialAttemptId?: string | null;
  /** Nama bot (untuk deep link) — sudah di-fetch oleh pemanggil. */
  botUsername: string | null;
  onLoginSuccess: (sessionId: string) => void;
  onLinked: () => void;
  onCancel: () => void;
}

export default function TelegramAuth({
  mode,
  initialAttemptId,
  botUsername,
  onLoginSuccess,
  onLinked,
  onCancel,
}: Props) {
  const [attemptId, setAttemptId] = useState<string | null>(initialAttemptId || null);
  const [starting, setStarting] = useState(!initialAttemptId);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const expiredRef = useRef(false);

  // Buka attempt saat panel muncul (kecuali sudah datang dari ?tg=)
  useEffect(() => {
    if (initialAttemptId || expiredRef.current) return;
    let cancelled = false;
    (async () => {
      setStarting(true);
      setStartErr(null);
      try {
        // api() → header X-Session-Id ikut (mode link butuh session valid)
        const res = await api("/api/auth/telegram/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mode === "link" ? { link: true } : {}),
        });
        const data = (await res.json().catch(() => null)) as { attempt_id?: string; error?: string };
        if (!res.ok || !data?.attempt_id) throw new Error(data?.error || "Gagal memulai. Coba lagi.");
        if (!cancelled) setAttemptId(data.attempt_id);
      } catch (e) {
        if (!cancelled) setStartErr((e as Error).message);
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, initialAttemptId]);

  // Hitungan mundur kirim ulang
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (attemptId && !starting && !startErr) inputRef.current?.focus();
  }, [attemptId, starting, startErr]);

  const restart = useCallback(() => {
    expiredRef.current = false;
    setAttemptId(null);
    setCode("");
    setErr(null);
    setNotice(null);
    setCooldown(0);
    setStartErr(null);
    setStarting(true);
    // trigger start ulang
    setTimeout(() => {
      (async () => {
        try {
          const res = await api("/api/auth/telegram/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(mode === "link" ? { link: true } : {}),
          });
          const data = (await res.json().catch(() => null)) as { attempt_id?: string; error?: string };
          if (!res.ok || !data?.attempt_id) throw new Error(data?.error || "Gagal memulai. Coba lagi.");
          setAttemptId(data.attempt_id);
        } catch (e) {
          setStartErr((e as Error).message);
        } finally {
          setStarting(false);
        }
      })();
    }, 0);
  }, [mode]);

  const submitCode = useCallback(async () => {
    if (!attemptId || !/^\d{6}$/.test(code) || verifying) return;
    setVerifying(true);
    setErr(null);
    setNotice(null);
    try {
      const res = await api("/api/auth/telegram/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attempt_id: attemptId, code }),
      });
      const data = (await res.json().catch(() => null)) as {
        session_id?: string;
        linked?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data?.error || "Kode salah atau kedaluwarsa.");
      if (data.linked) {
        setNotice("Telegram terhubung.");
        onLinked();
        return;
      }
      if (data.session_id) {
        onLoginSuccess(data.session_id);
        return;
      }
      throw new Error("Kode salah atau kedaluwarsa.");
    } catch (e) {
      setErr((e as Error).message);
      setCode("");
      inputRef.current?.focus();
    } finally {
      setVerifying(false);
    }
  }, [attemptId, code, verifying, onLinked, onLoginSuccess]);

  const resend = useCallback(async () => {
    if (!attemptId || resending || cooldown > 0) return;
    setResending(true);
    setErr(null);
    setNotice(null);
    try {
      const res = await api("/api/auth/telegram/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attempt_id: attemptId }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string };
      if (!res.ok) throw new Error(data?.error || "Gagal mengirim ulang. Coba lagi.");
      setNotice("Kode baru dikirim ke bot.");
      setCooldown(60);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setResending(false);
    }
  }, [attemptId, resending, cooldown]);

  const deepLink = attemptId && botUsername ? `https://t.me/${botUsername}?start=auth_${attemptId}` : null;

  return (
    <div className="tg-panel" role="dialog" aria-label="Masuk dengan Telegram">
      <div className="tg-head">
        <h4>{mode === "login" ? "Masuk dengan Telegram" : "Hubungkan Telegram"}</h4>
        <p>
          Kirim pesan ke bot Aomi untuk mendapatkan kode login. Kode berlaku 5 menit dan
          hanya bisa dipakai sekali.
        </p>
      </div>

      <ol className="tg-steps">
        <li>Buka bot Aomi lewat tombol di bawah</li>
        <li>Bot mengirim kode 6 digit ke kamu</li>
        <li>Masukkan kodenya di sini</li>
      </ol>

      {starting ? (
        <p className="tg-status">Menyiapkan…</p>
      ) : startErr ? (
        <div className="tg-status error">
          <p>{startErr}</p>
          <div className="tg-actions">
            <button type="button" className="tg-btn ghost" onClick={restart}>
              Coba lagi
            </button>
            <button type="button" className="tg-btn ghost" onClick={onCancel}>
              Kembali
            </button>
          </div>
        </div>
      ) : (
        <>
          <a
            className="tg-btn primary"
            href={deepLink || "https://t.me/"}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Buka Telegram untuk menerima kode"
          >
            Buka Telegram
          </a>

          <label className="tg-code-label" htmlFor="tg-code">
            Kode dari bot
          </label>
          <input
            id="tg-code"
            ref={inputRef}
            className="tg-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="••••••"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitCode();
            }}
            aria-describedby={err ? "tg-err" : undefined}
          />

          {err && (
            <p className="tg-status error" id="tg-err" role="alert">
              {err}
            </p>
          )}
          {notice && !err && <p className="tg-status ok">{notice}</p>}

          <div className="tg-actions">
            <button
              type="button"
              className="tg-btn primary"
              disabled={!/^\d{6}$/.test(code) || verifying}
              onClick={() => void submitCode()}
            >
              {verifying ? "Memeriksa…" : "Verifikasi"}
            </button>
            <button
              type="button"
              className="tg-btn ghost"
              disabled={resending || cooldown > 0}
              onClick={() => void resend()}
            >
              {cooldown > 0 ? `Kirim ulang (${cooldown}s)` : "Kirim ulang kode"}
            </button>
          </div>

          <button type="button" className="tg-back" onClick={onCancel}>
            Kembali ke form
          </button>
        </>
      )}
    </div>
  );
}
