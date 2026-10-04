/* ============================================================
   Aomi — lib/telegram/handlers/site.ts
   ⚙️ Pengaturan Website: pintasan ke Maintenance/Tampilan +
   dua manager asset yang bisa diganti TANPA deploy:
     🎭 Character    → hero maintenance page
     🖼️ Login Banner  → artwork hero halaman login
   Upload: admin kirim foto → validasi magic bytes → binary ke
   repo token → reference ke Redis → audit log. Tidak pernah
   dipercaya: filename, MIME Telegram, file non-gambar.
   ============================================================ */

import { can } from "../admin";
import { siteMenu, assetMenu, awaitingPhotoMenu, bannerMenu, mainMenu } from "../keyboards";
import {
  ASSET_KINDS,
  describeAsset,
  readAssetBytes,
  saveAsset,
  deleteAsset,
  type AssetKind,
} from "@/lib/server/siteassets";
import { auditLog } from "@/lib/server/audit";
import { getFile, downloadTgFile, sendPhotoBytes } from "../api";
import type { TgPhotoSize } from "../types";
import type { Ctx, MenuHandler, View } from "./types";
import { fmtWIB } from "../format";

/** Konfigurasi node asset: char ↔ character, banner ↔ loginBanner. */
const ASSET_NODES = {
  char: { kind: "character" as AssetKind, prefix: "char" as const, title: "🎭 Character Aomi", where: "• Maintenance page (hero utama)" },
  banner: { kind: "loginBanner" as AssetKind, prefix: "banner" as const, title: "🖼️ Login Banner Desktop", where: "• Halaman login desktop (kolom artwork split layout, ≥860px)" },
  bannerm: { kind: "loginBannerMobile" as AssetKind, prefix: "bannerm" as const, title: "📱 Login Banner Mobile", where: "• Halaman login mobile (banner pendek di atas form, <860px)" },
};


function renderAssetView(node: keyof typeof ASSET_NODES, desc: string): View {
  const cfg = ASSET_NODES[node];
  return {
    text: [
      cfg.title,
      "",
      "Character saat ini:",
      desc,
      "",
      `Digunakan pada:`,
      cfg.where,
      "",
      "📤 Ganti — kirim foto baru, langsung aktif tanpa deploy.",
    ].join("\n"),
    kb: assetMenu(cfg.prefix),
  };
}

/** Proses upload foto untuk satu asset. Dipakai CHAR & BANNER. */
async function processPhotoUpload(
  node: keyof typeof ASSET_NODES,
  photo: TgPhotoSize[],
  ctx: Ctx,
  chatId: number
): Promise<View | null> {
  const cfg = ASSET_NODES[node];
  if (!can(ctx.admin, "manage")) {
    return { text: "⛔ Mengganti asset butuh role admin ke atas.", kb: assetMenu(cfg.prefix) };
  }

  // Ambil ukuran terbesar yang dikirim Telegram
  const best = [...photo].sort((a, b) => (b.file_size ?? b.width) - (a.file_size ?? a.width))[0];
  const filePath = await getFile(best.file_id);
  if (!filePath) {
    return { text: "❌ Telegram tidak merespons (getFile). Coba kirim ulang.", kb: awaitingPhotoMenu(cfg.prefix) };
  }
  const raw = await downloadTgFile(filePath);
  if (!raw) {
    return { text: "❌ Gagal mengunduh file dari Telegram. Coba kirim ulang.", kb: awaitingPhotoMenu(cfg.prefix) };
  }

  try {
    const rec = await saveAsset(cfg.kind, {
      bytes: raw,
      width: best.width,
      height: best.height,
      uploadedBy: ctx.admin.id,
    });
    await auditLog({ admin_id: ctx.admin.id, role: ctx.admin.role, action: `set_asset:${cfg.kind}`, target: "asset", result: "ok", detail: `v${rec.version.slice(0, 6)} (${rec.ext}, ${(rec.size / 1_048_576).toFixed(2)} MB)` });

    // Kirim konfirmasi + preview langsung (bytes yang barusan tersimpan)
    const sent = await sendPhotoBytes(chatId, raw, rec.contentType, `✅ ${cfg.title} diperbarui (v${rec.version.slice(0, 6)}).`);
    const view: View = {
      text: [
        sent ? "" : `✅ ${cfg.title} berhasil diperbarui.`,
        "",
        "Asset baru dipakai pada:",
        cfg.where,
        "Langsung aktif — tanpa deploy ulang. Browser mengambil versi baru otomatis (URL berubah).",
        "",
        `Diperbarui ${fmtWIB(rec.updatedAt)}`,
      ]
        .filter((l) => l !== "")
        .join("\n"),
      kb: assetMenu(cfg.prefix),
    };
    return view;
  } catch (err) {
    const msg = (err as Error).message || "File tidak valid.";
    await auditLog({ admin_id: ctx.admin.id, role: ctx.admin.role, action: `set_asset:${cfg.kind}`, target: "asset", result: "fail", detail: msg }).catch(() => {});
    return { text: `❌ ${msg}`, kb: awaitingPhotoMenu(cfg.prefix) };
  }
}

/* ---------------- ⚙️ Pengaturan Website ---------------- */

export async function renderSite(): Promise<View> {
  return {
    text: [
      "⚙️ Pengaturan Website",
      "",
      "Atur maintenance, character, dan tampilan — semua perubahan langsung aktif tanpa deploy ulang.",
    ].join("\n"),
    kb: siteMenu(),
  };
}

export const siteHandler: MenuHandler = {
  node: "SITE",

  async render(): Promise<View> {
    return renderSite();
  },

  async onAction(): Promise<View | null> {
    return null;
  },

  async onInput(): Promise<View | null> {
    return null;
  },
};

/* ---------------- 🎭 Character ---------------- */

export const characterHandler: MenuHandler = {
  node: "CHAR",

  async render(): Promise<View> {
    return renderAssetView("char", await describeAsset(ASSET_NODES.char.kind));
  },

  async onAction(action, ctx, confirmed): Promise<View | null> {
    if (action === "char:replace") {
      if (!can(ctx.admin, "manage")) return { text: "⛔ Akses ditolak.", kb: assetMenu("char") };
      ctx.session.input = "char_photo";
      return {
        text: [
          "📤 Ganti Character Aomi",
          "",
          "Kirim foto character baru di chat ini (sebagai gambar).",
          "",
          "• Format: JPEG / PNG / WEBP, maks 5 MB",
          "• Disarankan portrait ~900×1120 (rasio artwork hero sekarang)",
          "• Langsung aktif di maintenance page — tanpa deploy",
          "",
          "Tekan ❌ Batalkan untuk membatalkan.",
        ].join("\n"),
        kb: awaitingPhotoMenu("char"),
      };
    }
    if (action === "char:view") {
      if (!can(ctx.admin, "read")) return { text: "⛔ Akses ditolak.", kb: assetMenu("char") };
      const asset = await readAssetBytes(ASSET_NODES.char.kind).catch(() => null);
      if (asset) {
        const ok = await sendPhotoBytes(ctx.admin.id, asset.data, asset.contentType, "🎭 Character saat ini");
        if (ok) return null; // foto terkirim — menu biarkan
      }
      return {
        text: "Belum ada upload — maintenance page memakai character default Aomi (auth-hero).",
        kb: assetMenu("char"),
      };
    }
    if (action !== "char:delete") return null;
    if (!can(ctx.admin, "manage")) return { text: "⛔ Akses ditolak.", kb: siteMenu() };
    if (!confirmed) {
      return {
        text: "Hapus character yang sudah diupload dan kembali ke asset default Aomi?",
        kb: { inline_keyboard: [
          [{ text: "❌ Batalkan", callback_data: "cancel" }],
          [{ text: "🗑 Ya, hapus", callback_data: "yes" }],
        ] },
      };
    }
    const deleted = await deleteAsset(ASSET_NODES.char.kind).catch(() => false);
    if (deleted) {
      await auditLog({ admin_id: ctx.admin.id, role: ctx.admin.role, action: "delete_asset:character", target: "asset", result: "ok", detail: "kembali ke default" });
    }
    return {
      text: deleted
        ? "✅ Character dihapus. Maintenance page kembali memakai asset default Aomi."
        : "Tidak ada upload yang perlu dihapus (memakai default).",
      kb: siteMenu(),
    };
  },

  async onInput(text, ctx): Promise<View | null> {
    if (ctx.session.input !== "char_photo") return null;
    ctx.session.input = null;
    // Teks dikirim saat menunggu foto → anggap batal/salah, jelaskan ulang
    if (text.toLowerCase() === "batal") return renderSite();
    return {
      text: "Kirim fotonya sebagai gambar (bukan teks, bukan file) ya 📸",
      kb: awaitingPhotoMenu("char"),
    };
  },

  async onPhoto(photo, ctx, chatId): Promise<View | null> {
    if (ctx.session.input !== "char_photo") return null;
    ctx.session.input = null;
    return processPhotoUpload("char", photo, ctx, chatId);
  },
};

/* ---------------- 🖼️ Login Banner ---------------- */

export const bannerHandler: MenuHandler = {
  node: "BANNER",

  async render(): Promise<View> {
    const [desk, mob] = await Promise.all([
      describeAsset(ASSET_NODES.banner.kind),
      describeAsset(ASSET_NODES.bannerm.kind),
    ]);
    const hasMob = !mob.startsWith("Belum ada upload") && !mob.startsWith("Status tidak");
    return {
      text: [
        "🖼️ Login Banner",
        "",
        "Dua komposisi terpisah — ganti satu tidak menyentuh yang lain:",
        "",
        "🖥 Desktop:",
        desk,
        "",
        "📱 Mobile:",
        mob,
        hasMob ? "" : "⚠️ Belum diatur — mobile memakai komposisi desktop sebagai fallback.",
        "",
        "📤 Ganti — kirim foto, langsung aktif tanpa deploy.",
      ].filter((l) => l !== "").join("\n"),
      kb: bannerMenu(),
    };
  },

  async onAction(action, ctx, confirmed): Promise<View | null> {
    // Ganti banner: DESKTOP (komposisi split layout ≥860px)
    if (action === "banner:replace") {
      if (!can(ctx.admin, "manage")) return { text: "⛔ Akses ditolak.", kb: bannerMenu() };
      ctx.session.input = "banner_photo";
      return {
        text: [
          "📤 Ganti Login Banner Desktop",
          "",
          "Kirim foto baru di chat ini (sebagai gambar) — dipakai di kolom",
          "artwork split layout halaman login desktop (≥860px).",
          "",
          "• Format: JPEG / PNG / WEBP, maks 5 MB",
          "• Disarankan portrait ~300×460 (mengikuti tinggi form)",
          "• Komposisi MOBILE tidak tersentuh",
          "• Langsung aktif — tanpa deploy",
          "",
          "Tekan ❌ Batalkan untuk membatalkan.",
        ].join("\n"),
        kb: awaitingPhotoMenu("banner"),
      };
    }
    // Ganti banner: MOBILE (banner pendek di atas form <860px)
    if (action === "bannerm:replace") {
      if (!can(ctx.admin, "manage")) return { text: "⛔ Akses ditolak.", kb: bannerMenu() };
      ctx.session.input = "bannerm_photo";
      return {
        text: [
          "📤 Ganti Login Banner Mobile",
          "",
          "Kirim foto baru di chat ini (sebagai gambar) — dipakai sebagai",
          "banner pendek di atas form Masuk/Daftar di mobile (<860px).",
          "",
          "• Format: JPEG / PNG / WEBP, maks 5 MB",
          "• Disarankan landscape lebar ~620×400 (area tampil pendek)",
          "• Subjek utama di bagian atas-tengah agar tidak terpotong",
          "• Komposisi DESKTOP tidak tersentuh",
          "• Langsung aktif — tanpa deploy",
          "",
          "Tekan ❌ Batalkan untuk membatalkan.",
        ].join("\n"),
        kb: awaitingPhotoMenu("bannerm"),
      };
    }
    // Lihat: preview masing-masing
    if (action === "banner:view" || action === "bannerm:view") {
      const isMob = action === "bannerm:view";
      if (!can(ctx.admin, "read")) return { text: "⛔ Akses ditolak.", kb: bannerMenu() };
      const asset = await readAssetBytes((isMob ? ASSET_NODES.bannerm : ASSET_NODES.banner).kind).catch(() => null);
      if (asset) {
        const ok = await sendPhotoBytes(
          ctx.admin.id,
          asset.data,
          asset.contentType,
          isMob ? "📱 Login banner mobile saat ini" : "🖥 Login banner desktop saat ini"
        );
        if (ok) return null;
      }
      return {
        text: isMob
          ? "Belum ada upload — mobile memakai komposisi desktop / artwork default Aomi."
          : "Belum ada upload — halaman login memakai artwork default Aomi.",
        kb: bannerMenu(),
      };
    }
    // Hapus: masing-masing, dengan konfirmasi
    if (action === "banner:delete" || action === "bannerm:delete") {
      const isMob = action === "bannerm:delete";
      const cfg = isMob ? ASSET_NODES.bannerm : ASSET_NODES.banner;
      if (!can(ctx.admin, "manage")) return { text: "⛔ Akses ditolak.", kb: siteMenu() };
      if (!confirmed) {
        return {
          text: isMob
            ? "Hapus Login Banner Mobile? (mobile kembali memakai komposisi desktop / default)"
            : "Hapus Login Banner Desktop? (desktop kembali memakai artwork default)",
          kb: { inline_keyboard: [
            [{ text: "❌ Batalkan", callback_data: "cancel" }],
            [{ text: "🗑 Ya, hapus", callback_data: "yes" }],
          ] },
        };
      }
      const deleted = await deleteAsset(cfg.kind).catch(() => false);
      if (deleted) {
        await auditLog({ admin_id: ctx.admin.id, role: ctx.admin.role, action: `delete_asset:${cfg.kind}`, target: "asset", result: "ok", detail: "kembali ke default" });
      }
      return {
        text: deleted
          ? `✅ Login banner ${isMob ? "mobile" : "desktop"} dihapus.`
          : "Tidak ada upload yang perlu dihapus (memakai default).",
        kb: bannerMenu(),
      };
    }
    return null;
  },

  async onInput(text, ctx): Promise<View | null> {
    if (ctx.session.input !== "banner_photo" && ctx.session.input !== "bannerm_photo") return null;
    const mob = ctx.session.input === "bannerm_photo";
    ctx.session.input = null;
    if (text.toLowerCase() === "batal") return renderSite();
    return {
      text: "Kirim fotonya sebagai gambar (bukan teks, bukan file) ya 📸",
      kb: awaitingPhotoMenu(mob ? "bannerm" : "banner"),
    };
  },

  async onPhoto(photo, ctx, chatId): Promise<View | null> {
    if (ctx.session.input === "banner_photo") {
      ctx.session.input = null;
      return processPhotoUpload("banner", photo, ctx, chatId);
    }
    if (ctx.session.input === "bannerm_photo") {
      ctx.session.input = null;
      return processPhotoUpload("bannerm", photo, ctx, chatId);
    }
    return null;
  },
};
