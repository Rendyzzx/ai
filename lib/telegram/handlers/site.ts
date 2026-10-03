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
import { siteMenu, assetMenu, awaitingPhotoMenu, mainMenu } from "../keyboards";
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
  banner: { kind: "loginBanner" as AssetKind, prefix: "banner" as const, title: "🖼️ Login Banner", where: "• Panel \"Masuk/Daftar\" di halaman login (karakter peekaboo di atas form)" },
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
    return renderAssetView("banner", await describeAsset(ASSET_NODES.banner.kind));
  },

  async onAction(action, ctx, confirmed): Promise<View | null> {
    if (action === "banner:replace") {
      if (!can(ctx.admin, "manage")) return { text: "⛔ Akses ditolak.", kb: assetMenu("banner") };
      ctx.session.input = "banner_photo";
      return {
        text: [
          "📤 Ganti Login Banner",
          "",
          "Kirim foto baru di chat ini (sebagai gambar) — dipakai untuk",
          "karakter \"peekaboo\" di atas form Masuk/Daftar (bukan hero besar",
          "di landing page).",
          "",
          "• Format: JPEG / PNG / WEBP, maks 5 MB",
          "• Disarankan portrait ~260×340",
          "• Satu foto dipakai utk kedua ekspresi (mata buka/tutup)",
          "• Langsung aktif — tanpa deploy",
          "",
          "Tekan ❌ Batalkan untuk membatalkan.",
        ].join("\n"),
        kb: awaitingPhotoMenu("banner"),
      };
    }
    if (action === "banner:view") {
      if (!can(ctx.admin, "read")) return { text: "⛔ Akses ditolak.", kb: assetMenu("banner") };
      const asset = await readAssetBytes(ASSET_NODES.banner.kind).catch(() => null);
      if (asset) {
        const ok = await sendPhotoBytes(ctx.admin.id, asset.data, asset.contentType, "🖼️ Login banner saat ini");
        if (ok) return null;
      }
      return {
        text: "Belum ada upload — halaman login memakai artwork default Aomi (auth-hero).",
        kb: assetMenu("banner"),
      };
    }
    if (action !== "banner:delete") return null;
    if (!can(ctx.admin, "manage")) return { text: "⛔ Akses ditolak.", kb: siteMenu() };
    if (!confirmed) {
      return {
        text: "Hapus login banner yang sudah diupload dan kembali ke artwork default?",
        kb: { inline_keyboard: [
          [{ text: "❌ Batalkan", callback_data: "cancel" }],
          [{ text: "🗑 Ya, hapus", callback_data: "yes" }],
        ] },
      };
    }
    const deleted = await deleteAsset(ASSET_NODES.banner.kind).catch(() => false);
    if (deleted) {
      await auditLog({ admin_id: ctx.admin.id, role: ctx.admin.role, action: "delete_asset:loginBanner", target: "asset", result: "ok", detail: "kembali ke default" });
    }
    return {
      text: deleted
        ? "✅ Login banner dihapus. Halaman login kembali memakai artwork default Aomi."
        : "Tidak ada upload yang perlu dihapus (memakai default).",
      kb: siteMenu(),
    };
  },

  async onInput(text, ctx): Promise<View | null> {
    if (ctx.session.input !== "banner_photo") return null;
    ctx.session.input = null;
    if (text.toLowerCase() === "batal") return renderSite();
    return {
      text: "Kirim fotonya sebagai gambar (bukan teks, bukan file) ya 📸",
      kb: awaitingPhotoMenu("banner"),
    };
  },

  async onPhoto(photo, ctx, chatId): Promise<View | null> {
    if (ctx.session.input !== "banner_photo") return null;
    ctx.session.input = null;
    return processPhotoUpload("banner", photo, ctx, chatId);
  },
};
