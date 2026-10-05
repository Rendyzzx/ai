#!/usr/bin/env node
/* ============================================================
   Aomi — scripts/test-downloader.mjs
   Test unit matcher platform downloader tambahan (logika murni,
   tanpa jaringan). Menjalankan: npm test (dijalankan setelah
   test-telegram.mjs).
   ============================================================ */
import {
  dlPlatformFromHost,
  matchExtraDlTarget,
  dlPlatformLabel,
  dlFilePrefix,
} from "../lib/server/dl-platforms.ts";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log("  ok -", name);
  } else {
    fail++;
    console.error("  FAIL -", name);
  }
}

// ---------- dlPlatformFromHost ----------
console.log("dlPlatformFromHost:");
check("x.com → twitter", dlPlatformFromHost("x.com") === "twitter");
check("www.twitter.com → twitter", dlPlatformFromHost("www.twitter.com") === "twitter");
check("open.spotify.com → spotify", dlPlatformFromHost("open.spotify.com") === "spotify");
check("subdomain bandcamp → bandcamp", dlPlatformFromHost("tycho.bandcamp.com") === "bandcamp");
check("bilibili.tv → bilibili", dlPlatformFromHost("bilibili.tv") === "bilibili");
check("xiaohongshu.com → rednote", dlPlatformFromHost("xiaohongshu.com") === "rednote");
check("1024tera.com → terabox", dlPlatformFromHost("1024tera.com") === "terabox");
check("mediafire.com → mediafire", dlPlatformFromHost("mediafire.com") === "mediafire");
check("sub2unlock.com → sub2unlock", dlPlatformFromHost("sub2unlock.com") === "sub2unlock");
check("tiktok.com → null (ditangani mode lama)", dlPlatformFromHost("tiktok.com") === null);
check("instagram.com → null (ditangani mode lama)", dlPlatformFromHost("instagram.com") === null);
check("evil-twitter.com → null", dlPlatformFromHost("evil-twitter.com") === null);
check("twitter.com.evil.net → null", dlPlatformFromHost("twitter.com.evil.net") === null);
check("host kosong → null", dlPlatformFromHost("") === null);

// ---------- matchExtraDlTarget ----------
console.log("matchExtraDlTarget:");
const t = matchExtraDlTarget("tolong unduh ini https://x.com/Interior/status/1854917015758921720 ya");
check("link twitter ketemu", t !== null && t.platform === "twitter");
check("url utuh", t && t.url === "https://x.com/Interior/status/1854917015758921720");
check("link+url pertama menang", matchExtraDlTarget("coba https://open.spotify.com/track/1 dan https://x.com/a/status/1").platform === "spotify");
check("koma di akhir dibuang", matchExtraDlTarget("https://www.facebook.com/watch/?v=123,") !== null);
check("teks tanpa link → null", matchExtraDlTarget("halo gimana kabar") === null);
check("link lain diabaikan", matchExtraDlTarget("baca https://example.com/artikel ya") === null);
check("tiktok tidak ikut mode baru", matchExtraDlTarget("https://www.tiktok.com/@a/video/123") === null);
check("instagram tidak ikut mode baru", matchExtraDlTarget("https://www.instagram.com/p/abc/") === null);
check("threads.com → threads", matchExtraDlTarget("https://www.threads.com/@a/post/ABC")?.platform === "threads");
check("reddit share link → reddit", matchExtraDlTarget("https://www.reddit.com/r/x/s/FhrWISKmrS")?.platform === "reddit");
check("sfile.mobi → sfile", matchExtraDlTarget("https://sfile.mobi/f/abc")?.platform === "sfile");

// ---------- label & prefix ----------
console.log("Label & prefix:");
check("label twitter", dlPlatformLabel("twitter") === "X (Twitter)");
check("label tiktok tetap", dlPlatformLabel("tiktok") === "TikTok");
check("label platform asing → stringnya", dlPlatformLabel("zzz") === "zzz");
check("prefix soundcloud", dlFilePrefix("soundcloud") === "soundcloud");
check("prefix default", dlFilePrefix("apa") === "aomi");

console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
