import type { Metadata, Viewport } from "next";
import { Manrope, DM_Sans, Plus_Jakarta_Sans, Instrument_Sans } from "next/font/google";
import "../styles/main.css";

const SITE = "https://cyronime.web.id";

/** Verifikasi Google Search Console — dari env (bukan hardcode). */
const googleVerification = process.env.GOOGLE_SITE_VERIFICATION || "";

// Font pilihan Settings → Tampilan. Di-self-host oleh Next (next/font),
// bukan dimuat dari CDN runtime — aman & tanpa request eksternal tambahan.
// Dipasang sebagai CSS var di <html>; var --font aktif dipilih oleh
// lib/prefs.ts (lihat FONT_STACKS) sesuai preferensi user.
const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dmsans", display: "swap" });
const plusJakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-plusjakarta", display: "swap" });
const instrumentSans = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "Aomi — AI yang siap bantu kapan aja",
  description:
    "Aomi — teman ngobrol AI yang personal: ngobrol santai, bantu ngoding, edit foto, putar lagu, sampai download video TikTok & Instagram. Gratis, langsung pakai.",
  icons: { icon: { url: "/assets/favicon.svg", type: "image/svg+xml" } },
  ...(googleVerification
    ? { verification: { google: googleVerification } }
    : {}),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#111210",
};

// ---------------------------------------------------------------
// Anti-flash: terapkan tema/font/ukuran teks/kerapatan/accent/animasi
// SEBELUM paint pertama, dibaca dari localStorage (lib/prefs.ts adalah
// sumber kebenaran reaktif setelah mount — script ini cuma snapshot
// awal, logikanya sengaja diduplikasi minimal karena inline script
// tidak bisa impor modul TS).
// ---------------------------------------------------------------
const INIT_SCRIPT = `(function(){try{
var ls=localStorage,root=document.documentElement;
var theme=ls.getItem('aomi.pref.theme')||'dark';
if(theme==='system'){theme=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}
root.setAttribute('data-theme',theme);
var SYS="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
var FONTS={manrope:'var(--font-manrope), '+SYS,dmsans:'var(--font-dmsans), '+SYS,plusjakarta:'var(--font-plusjakarta), '+SYS,instrument:'var(--font-instrument), '+SYS};
var font=ls.getItem('aomi.pref.font')||'manrope';
root.style.setProperty('--font',FONTS[font]||FONTS.manrope);
var SIZES={small:'14',medium:'15.5',large:'17'};
var ts=ls.getItem('aomi.pref.textSize')||'medium';
root.style.setProperty('--chat-fs',(SIZES[ts]||'15.5')+'px');
var DENS={comfortable:['16px','10px','14px','1.5'],medium:['12px','8px','13px','1.45'],compact:['8px','7px','12px','1.4']};
var dz=ls.getItem('aomi.pref.density')||'comfortable';
var d=DENS[dz]||DENS.comfortable;
root.style.setProperty('--msg-gap',d[0]);
root.style.setProperty('--msg-pad-y',d[1]);
root.style.setProperty('--msg-pad-x',d[2]);
root.style.setProperty('--msg-lh',d[3]);
var ACC={aomi:['#c69a60','#d3a46c'],sand:['#c7b38a','#d2c09c'],olive:['#9ca370','#a9b084'],rose:['#c98a82','#d59a92']};
var ac=ls.getItem('aomi.pref.accent')||'aomi';
var a=ACC[ac]||ACC.aomi;
root.style.setProperty('--accent',a[0]);
root.style.setProperty('--accent-hover',a[1]);
var anim=ls.getItem('aomi.pref.animations');
root.setAttribute('data-anim',anim==='0'?'off':'on');
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="id"
      className={`${manrope.variable} ${dmSans.variable} ${plusJakarta.variable} ${instrumentSans.variable}`}
    >
      <body>
        {/* Tanpa async/defer: sengaja blocking, jalan sebelum konten di
            bawahnya dicat → tidak ada "kedipan" tema/font salah. */}
        <script dangerouslySetInnerHTML={{ __html: INIT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
