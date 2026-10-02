"use client";

/* ============================================================
   Aomi — components/brand/BrandSplash.tsx
   Brand intro sinematik ±3 detik (bukan loading screen):
   objek 3D keramik matte muncul dari kegelapan → sapuan
   cahaya hangat → berevolusi menjadi mark Aomi (bubble + ekor
   + tiga titik) → wordmark "Aomi" + tagline → fade-out.

   Implementasi: WebGL raymarching shader (SDF) TANPA dependency
   (three.js ±150KB gzip hanya untuk intro 3 detik = tidak worth;
   brief: "jangan menambahkan library besar hanya untuk efek
   sederhana", "jangan melakukan network request hanya untuk
   animation"). Fallback premium (mark SVG + wordmark, fade
   sederhana) bila WebGL tidak tersedia / gagal / reduced-motion.

   HANYA di /auth (pintu depan brand). Sekali per tab
   (sessionStorage). User yang punya session aktif di-skip —
   mereka akan di-redirect ke chat, jangan potong intro-nya.

   Scroll safety: overlay position:fixed — TIDAK menyentuh
   scroll (tidak ada scrollTo/scrollIntoView). Body hanya di-lock
   selama splash (body.splash-on) supaya halaman bawahnya tidak
   bisa discroll saat tertutup — lalu dilepas lagi.
   ============================================================ */

import { useEffect, useRef, useState } from "react";
import { getSessionId } from "@/lib/session";

/** Total durasi intro (ms) — ±3 detik sesuai brief. */
const DURATION_MS = 3000;
/** Jeda kecil setelah fade-out sebelum unmount (ms). */
const UNMOUNT_GRACE_MS = 150;
/** Sekali per lifecycle tab. */
const FLAG = "aomi.splashDone";
/** Fallback (WebGL gagal / tidak tersedia) — tetap premium, lebih singkat. */
const STATIC_MS = 2000;

const VERT_SRC = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/* Raymarcher SDF — WebGL1 (GLSL ES 1.00) untuk kompatibilitas maksimal.
   Scene: satu objek — ellipsoid keramik ("pebble") yang ber-morph halus
   menjadi mark Aomi: bubble chat + ekor kecil kiri-bawah + tiga titik.
   Material: matte ceramic (diffuse lembut + spekuler rendah + fresnel emas).
   Lighting: key light hangat dengan azimut bergerak (sapuan permukaan),
   rim light emas #C69A60 dari belakang-kanan, ambient charcoal hangat. */
const FRAG_SRC = `
precision highp float;

uniform vec2  u_res;
uniform float u_time;
uniform float u_reveal;  // 0..1 — muncul dari kegelapan (eksposur + scale)
uniform float u_morph;   // 0..1 — pebble -> mark Aomi (ekor + titik tumbuh)
uniform float u_spin;    // rotasi objek Y (rad), berakhir menghadap kamera
uniform float u_orbit;   // orbit kamera sangat halus (rad)
uniform float u_dist;    // jarak kamera (slow push-in)
uniform float u_keyaz;   // azimut key light (sapuan cahaya, rad)

const vec3 BG      = vec3(0.067, 0.071, 0.063);  // #111210 hangat
const vec3 CERAMIC = vec3(0.898, 0.892, 0.856);  // off-white hangat
const vec3 GOLD    = vec3(0.776, 0.604, 0.376);  // #C69A60
const vec3 AMBIENT = vec3(0.085, 0.083, 0.078);  // charcoal hangat
const vec3 KEYCOL  = vec3(1.02, 0.98, 0.90);     // off-white hangat

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float sdSphere(vec3 p, float r) { return length(p) - r; }

float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / k1;
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float map(vec3 p) {
  // scale halus saat muncul dari kegelapan (0.93 -> 1.0)
  p /= (0.93 + 0.07 * u_reveal);
  p.xz = rot(u_spin) * p.xz;
  vec3 q = p;
  q.yz = rot(0.06) * q.yz; // tilt statis sangat halus
  float bubble = sdEllipsoid(q, vec3(1.0, 1.0, 0.74));
  // ekor bubble (kiri-bawah) — tumbuh mengikuti morph
  vec3 t = q - vec3(-0.94, -0.74, 0.18);
  t.xy = rot(-0.55) * t.xy;
  float tail = sdSphere(t, 0.001 + 0.36 * u_morph);
  float d = smin(bubble, tail, 0.16 + 0.16 * u_morph);
  // tiga titik Aomi — dimple dangkal, muncul mengikuti morph
  float dr = 0.11 * u_morph;
  float dots = min(
    sdSphere(q - vec3(-0.42, 0.02, 0.68), dr),
    min(sdSphere(q - vec3( 0.00, 0.02, 0.68), dr),
        sdSphere(q - vec3( 0.42, 0.02, 0.68), dr))
  );
  return max(d, -dots);
}

vec3 calcNormal(vec3 p) {
  const vec2 e = vec2(0.0015, 0.0);
  return normalize(vec3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)
  ));
}

// ambient occlusion 4-tap (murah, cukup untuk 1 objek)
float ao(vec3 p, vec3 n) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 4; i++) {
    float h = 0.02 + 0.14 * float(i) / 3.0;
    occ += (h - map(p + n * h)) * sca;
    sca *= 0.82;
  }
  return clamp(1.0 - 2.2 * occ, 0.0, 1.0);
}

void main() {
  vec2 uv = (2.0 * gl_FragCoord.xy - u_res) / u_res.y;

  // kamera: dolly + orbit sangat halus, lensa agak sempit (sinematik)
  vec3 ro = vec3(sin(u_orbit) * u_dist, 0.14, cos(u_orbit) * u_dist);
  vec3 f = normalize(-ro);                          // forward: ke pusat objek
  vec3 r = normalize(cross(f, vec3(0.0, 1.0, 0.0))); // right
  vec3 u = cross(r, f);                              // up
  vec3 rd = normalize(uv.x * r + uv.y * u + 1.62 * f);

  // raymarch
  float t = 0.0;
  float hit = 0.0;
  for (int i = 0; i < 80; i++) {
    vec3 pos = ro + rd * t;
    float d = map(pos);
    if (d < 0.0012 * t + 0.0006) { hit = 1.0; break; }
    t += d;
    if (t > 7.0) break;
  }

  // background: charcoal hangat + vignette lembut (tanpa gradient mencolok)
  vec3 col = BG * (1.0 - 0.16 * length(uv));

  if (hit > 0.5) {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p);
    float occ = ao(p, n);

    // key light: azimut bergerak -> cahaya menyapu permukaan
    vec3 keyDir = normalize(vec3(cos(u_keyaz) * 0.85, 0.72, sin(u_keyaz) * 0.85 + 0.30));
    float diff = max(dot(n, keyDir), 0.0);

    // rim emas dari belakang-kanan (fresnel)
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 2.6);

    // spekuler keramik rendah
    vec3 hv = normalize(keyDir - rd);
    float spec = pow(max(dot(n, hv), 0.0), 42.0);

    vec3 obj =
      CERAMIC * AMBIENT * (0.7 + 0.3 * occ) * 2.4 +
      CERAMIC * KEYCOL * diff * (0.55 + 0.45 * occ) +
      GOLD * fres * (0.30 + 0.22 * u_morph) +
      KEYCOL * spec * 0.30 * (0.4 + 0.6 * occ);

    // reveal: eksposur naik dari 0 -> objek muncul dari kegelapan
    col = obj * u_reveal;
  }

  // tone lembut + gamma sederhana
  col = clamp(col, 0.0, 1.0);
  col = pow(col, vec3(0.92));
  gl_FragColor = vec4(col, 1.0);
}
`;

type Mode = "pending" | "webgl" | "static" | "skip";

/* ---------------- easing helpers ---------------- */
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOutSine = (x: number) => -(Math.cos(Math.PI * x) - 1) / 2;
const easeInOutCubic = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** Parameter animasi pada detik t (0..3) — timeline sinematik. */
function timeline(t: number) {
  const s = Math.min(t, 3.0);
  // 0.0-0.5: muncul dari kegelapan (scale + eksposur)
  const reveal = easeOutCubic(seg(s, 0.0, 0.5));
  // 0.15-1.5: rotasi pelan; 1.5-2.2: berakhir menghadap kamera
  const spin =
    s < 1.5
      ? lerp(-0.95, 0.55, easeInOutSine(seg(s, 0.15, 1.5)))
      : lerp(0.55, 0.05, easeOutCubic(seg(s, 1.5, 2.2)));
  // kamera: orbit sangat halus + slow push-in
  const orbit = lerp(-0.20, 0.08, easeInOutSine(clamp01(s / 2.2)));
  const dist = lerp(3.35, 2.85, easeOutCubic(seg(s, 0.3, 2.3)));
  // key light menyapu permukaan lalu tenang
  const keyaz =
    s < 1.7
      ? lerp(-1.25, 0.95, easeInOutSine(seg(s, 0.4, 1.7)))
      : lerp(0.95, 0.80, easeOutCubic(seg(s, 1.7, 2.4)));
  // 1.5-2.2: pebble -> mark Aomi
  const morph = easeInOutCubic(seg(s, 1.5, 2.2));
  return { reveal, spin, orbit, dist, keyaz, morph };
}

/** Cek WebGL + validasi shader di canvas lepas (sebelum render apapun). */
function probeWebgl(): boolean {
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl", { alpha: false });
    if (!gl) return false;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) return false;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
      gl.deleteShader(sh);
      return ok === true;
    };
    return compile(gl.VERTEX_SHADER, VERT_SRC) && compile(gl.FRAGMENT_SHADER, FRAG_SRC);
  } catch {
    return false;
  }
}

export default function BrandSplash() {
  const [mode, setMode] = useState<Mode>("pending");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /* ---- Gate: sekali per tab; skip bila user punya session (akan ke chat) ---- */
  useEffect(() => {
    try {
      if (sessionStorage.getItem(FLAG) === "1") {
        setMode("skip");
        return;
      }
      // tandai SEKARANG supaya StrictMode/remount tidak replay
      sessionStorage.setItem(FLAG, "1");
    } catch {
      setMode("skip"); // private mode tanpa storage: lebih baik skip daripada replay tiap load
      return;
    }
    if (getSessionId()) {
      setMode("skip");
      return;
    }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced || !probeWebgl()) {
      setMode("static");
    } else {
      setMode("webgl");
    }
  }, []);

  /* ---- Jalankan intro sesuai mode ---- */
  useEffect(() => {
    if (mode !== "webgl" && mode !== "static") return;

    const body = document.body;
    body.classList.add("splash-on"); // lock scroll selama overlay menutupi halaman

    let raf = 0;
    let resize = () => {};
    let glCtx: WebGLRenderingContext | null = null;
    let timer = 0;

    if (mode === "webgl") {
      const canvas = canvasRef.current;
      glCtx =
        (canvas?.getContext("webgl", {
          alpha: false,
          antialias: true,
          powerPreference: "low-power",
        }) as WebGLRenderingContext | null) ?? null;

      if (glCtx && canvas) {
        const gl = glCtx;
        const compile = (type: number, src: string) => {
          const sh = gl.createShader(type);
          if (!sh) return null;
          gl.shaderSource(sh, src);
          gl.compileShader(sh);
          if (gl.getShaderParameter(sh, gl.COMPILE_STATUS) !== true) return null;
          return sh;
        };
        const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
        const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
        const prog = vs && fs ? gl.createProgram() : null;
        if (prog && vs && fs) {
          gl.attachShader(prog, vs);
          gl.attachShader(prog, fs);
          gl.linkProgram(prog);
          if (gl.getProgramParameter(prog, gl.LINK_STATUS) === true) {
            gl.useProgram(prog);

            // fullscreen triangle
            const buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(
              gl.ARRAY_BUFFER,
              new Float32Array([-1, -1, 3, -1, -1, 3]),
              gl.STATIC_DRAW
            );
            const loc = gl.getAttribLocation(prog, "a_pos");
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

            const U = {
              res: gl.getUniformLocation(prog, "u_res"),
              time: gl.getUniformLocation(prog, "u_time"),
              reveal: gl.getUniformLocation(prog, "u_reveal"),
              morph: gl.getUniformLocation(prog, "u_morph"),
              spin: gl.getUniformLocation(prog, "u_spin"),
              orbit: gl.getUniformLocation(prog, "u_orbit"),
              dist: gl.getUniformLocation(prog, "u_dist"),
              keyaz: gl.getUniformLocation(prog, "u_keyaz"),
            };

            // DPR rendah di perangkat mobile / low-end
            const coarse =
              window.matchMedia?.("(pointer: coarse)").matches || window.innerWidth < 768;
            const dprCap = coarse ? 1.5 : 2;
            const size = () => {
              const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
              canvas.width = Math.round(window.innerWidth * dpr);
              canvas.height = Math.round(window.innerHeight * dpr);
              gl.viewport(0, 0, canvas.width, canvas.height);
            };
            size();
            resize = size;
            window.addEventListener("resize", resize);

            const t0 = performance.now();
            const draw = (now: number) => {
              const t = (now - t0) / 1000;
              const p = timeline(t);
              gl.uniform2f(U.res, canvas.width, canvas.height);
              gl.uniform1f(U.time, t);
              gl.uniform1f(U.reveal, p.reveal);
              gl.uniform1f(U.morph, p.morph);
              gl.uniform1f(U.spin, p.spin);
              gl.uniform1f(U.orbit, p.orbit);
              gl.uniform1f(U.dist, p.dist);
              gl.uniform1f(U.keyaz, p.keyaz);
              gl.drawArrays(gl.TRIANGLES, 0, 3);
              // render berhenti di 3.0s — frame terakhir menahan fade-out CSS
              if (t < 3.0) raf = requestAnimationFrame(draw);
            };
            raf = requestAnimationFrame(draw);
          }
        }
      }

      timer = window.setTimeout(() => setMode("skip"), DURATION_MS + UNMOUNT_GRACE_MS);
    } else {
      timer = window.setTimeout(() => setMode("skip"), STATIC_MS + 200);
    }

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      window.removeEventListener("resize", resize);
      body.classList.remove("splash-on");
      // lepaskan context WebGL (hemat memori setelah intro)
      try {
        glCtx?.getExtension("WEBGL_lose_context")?.loseContext();
      } catch { /* abaikan */ }
    };
  }, [mode]);

  if (mode === "pending" || mode === "skip") return null;

  return (
    <div
      className={"brand-splash" + (mode === "webgl" ? " gl" : " static")}
      aria-hidden="true"
    >
      {mode === "webgl" ? (
        <canvas ref={canvasRef} className="brand-splash-canvas" />
      ) : (
        <svg className="brand-splash-mark" viewBox="0 0 24 24">
          <use href="/icons.svg#logo" />
        </svg>
      )}
      <div className="brand-splash-text">
        <div className="brand-splash-name">Aomi</div>
        <div className="brand-splash-tag">Ngobrol. Bikin. Cari tahu.</div>
      </div>
    </div>
  );
}
