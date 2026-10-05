/* ============================================================
   Aomi — lib/vendor/scrapr/index.js
   Agregator scrapr (@coflyn/scrapr, MIT) — HANYA modul yang
   dipakai Aomi dan lolos uji output+unduhan (Okt 2026).

   Modul sengaja di-vendor (bukan npm install @coflyn/scrapr)
   karena package upstream membawa optionalDependencies
   playwright/puppeteer yang membuat build serverless bengkak.
   Yang dibutuhkan di sini cuma axios + cheerio (deps Aomi).

   Uji yang dilakukan sebelum dipakai (lihat catatan commit):
   setiap method di bawah SUDAH diverifikasi: status true + link
   unduhan benar-benar bisa diakses (Range GET 206/200).
   Method yang GAGAL uji tidak di-vendor:
     - applemusic.aplmate  → cuma balikin cover, tanpa audio
     - douyin.direct       → sample mati; duplikat fitur TikTok
     - facebook.fdown      → butuh Chrome (puppeteer) — no serverless
     - resolver.rekonise / safelinku / unshorten → 403 upstream
   ============================================================ */

module.exports = {
  twitter: {
    direct: require("./twitter/direct").scrape,
    tweeload: require("./twitter/tweeload").scrape,
    tvd: require("./twitter/tvd").scrape,
    savetwt: require("./twitter/savetwt").scrape,
  },
  facebook: {
    snapsave: require("./facebook/snapsave").scrape,
  },
  spotify: {
    spotidown: require("./spotify/spotidown").scrape,
    spotisaver: require("./spotify/spotisaver").scrape,
    spotmate: require("./spotify/spotmate").scrape,
    soundloaders: require("./spotify/soundloaders").scrape,
  },
  soundcloud: {
    klickaud: require("./soundcloud/klickaud").scrape,
  },
  bandcamp: {
    bandcampdownloader: require("./bandcamp/bandcampdownloader").scrape,
  },
  pinterest: {
    direct: require("./pinterest/direct").scrape,
    pindown: require("./pinterest/pindown").scrape,
  },
  threads: {
    threadster: require("./threads/threadster").scrape,
  },
  bilibili: {
    direct: require("./bilibili/direct").scrape,
  },
  pixiv: {
    ajax: require("./pixiv/ajax").scrape,
  },
  rednote: {
    direct: require("./rednote/direct").scrape,
  },
  reddit: {
    rapidsave: require("./reddit/rapidsave").scrape,
  },
  terabox: {
    sechno: require("./terabox/sechno").scrape,
  },
  resolver: {
    mediafire: require("./resolver/mediafire").scrape,
    sfile: require("./resolver/sfile").scrape,
    sub2unlock: require("./resolver/sub2unlock").scrape,
  },
};
