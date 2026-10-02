/* ============================================================
   Aomi — types bersama (client & server)
   ============================================================ */

export type Role = "user" | "assistant";

/** Satu pesan dalam percakapan (format penyimpanan di database). */
export interface Message {
  message_id: string;
  role: Role;
  content: string;
  image?: string | null;        // dataURL thumbnail (pesan user)
  image_url?: string | null;    // URL hasil edit foto (pesan assistant)
  image_name?: string | null;
  image_mime?: string | null;
  expires_at?: string | null;    // masa unduh hasil edit
  edit?: boolean;
  dl?: DlCard | null;            // kartu downloader TikTok/IG
  music?: MusicCard | null;      // kartu lagu (mode musik)
  timestamp: string;
}

/** Enri indeks riwayat percakapan. */
export interface ConversationItem {
  conversation_id: string;
  title: string;
  updated_at: string;
}

/** Percakapan penuh (GET /api/conversations?id=). */
export interface Conversation {
  conversation_id: string;
  user_id: string;
  title: string;
  created_at?: string;
  updated_at: string;
  messages: Message[];
}

/** Metadata unduhan TikTok/IG yang tersimpan di pesan assistant. */
export interface DlCard {
  platform: "tiktok" | "ig";
  type: "video" | "image";
  id?: string;
  title?: string;
  cover?: string;
  author?: string;
  music?: string;
  music_title?: string;
  video?: string;
  images?: string[];
}

/** Satu baris lirik sinkron (time = detik dari awal lagu). */
export interface MusicLyricLine {
  time: number;
  text: string;
}

/** Kartu lagu yang tersimpan di pesan assistant (mode musik). */
export interface MusicCard {
  video_id: string;        // ID video YouTube (stabil, untuk resolve ulang)
  title: string;
  artist: string;
  duration: number;        // detik
  thumbnail: string;      // thumbnail YouTube (i.ytimg.com, stabil)
  audio_url: string;      // URL audio savetube — bisa kedaluwarsa,
                          // refresh via /api/music?action=resolve
  lyrics: MusicLyricLine[];
  lyrics_estimated?: boolean; // true = lirik plain disebar (sinkron perkiraan)
}

/** Profil user. */
export interface UserProfile {
  username: string;
  display_name: string;
  bio: string;
  avatar: string | null;
  email?: string;
}

/** Konfigurasi karakter companion. */
export interface BotConfig {
  bot_name: string;
  bot_description: string;
  bot_avatar: string | null;
  personality: string;
  traits: string[];
  speaking_style: string;
  relationship: string;
  greeting: string;
  likes: string;
  avoids: string;
  memories: string[];
  system_prompt: string;
  language: "auto" | "id" | "en";
  response_length: "concise" | "balanced" | "detailed";
  response_style: "casual" | "neutral" | "formal";
  personality_preset: string;
}

/** Respons POST /api/chat (mode normal). */
export interface ChatResponse {
  text: string;
  user_message_id?: string;
  assistant_message_id?: string;
  conversation_id: string;
  title?: string;
  message_id?: string;      // mode greeting
  provider?: string;
  bot_name?: string;
  error?: string;
  already?: boolean;
  greeting?: boolean;
  edit_job?: { input_url: string; prompt: string };
  image_url?: string;
  image_name?: string;
  expires_at?: string;
  dl?: DlCard;
  music?: MusicCard;
}

/** State pesan yang dirender di UI (pesan lokal yang belum punya id server). */
export interface UiMessage extends Message {
  /** null → pesan optimistik (belum dikonfirmasi server). */
  pending?: boolean;
}
