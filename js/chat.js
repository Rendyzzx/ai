/* ============================================================
   Aomi — chat.js
   Percakapan companion: render append-only, virtualisasi DOM,
   header karakter (avatar + status), auto-open percakapan
   terakhir untuk returning user, sapaan pertama dari personality
   (mode greeting), kirim ke /api/chat. Nama karakter dan profil
   diambil dari state (settings.js bisa mengubahnya kapan pun).
   ============================================================ */

import { $, raf, sanitizeText, renderAvatar, api, apiJson, emit, on, state, confirmDialog, getSessionId } from './app.js?v=ae957e7c85';

const RENDER_BATCH = 30;   // pesan per batch render
const DOM_CAP = 150;       // node pesan maksimum di DOM

// API edit foto — browser menembak LANGSUNG (CORS terbuka), bebas
// dari batas 60 detik runtime server. Server hanya: host gambar
// masukan (edit-start), simpan hasil (edit-save), catat kegagalan
// (edit-fail).
const EDIT_API = 'https://api-faa.my.id/faa/editfoto';
const EDIT_BROWSER_TIMEOUT = 120_000; // API eksternal terukur ±40-60s
const EDIT_RESULT_MAX = 4_000_000;   // hasil maks 4MB (aman untuk body)

// Deteksi permintaan edit foto (gambar terlampir + kata pemicu).
// SALINAN dari EDIT_TRIGGER_RE di api/chat.js — server tetap yang
// memutuskan rute; ini hanya memilih animasi loading yang tepat.
const EDIT_TRIGGER_RE = /\b(edit(?:in|kan|ed|an)?|ubah(?:in)?|ganti(?:in)?|hias(?:in)?|rapikan|perjelas(?:kan)?|perbaiki(?:k)?(?:in|kan)?|hilangkan|hapus(?:in)?|tambah(?:in|kan)?|jadikan|warnain|warnai|warna(?:kan)?|colori[sz]e|retouch|remove|restore)\b/i;

// Metadata unduh pesan hasil edit (disimpan server per pesan)
const fileOf = (m) => (m && typeof m.image_url === 'string')
  ? { url: m.image_url, name: m.image_name, expiresAt: m.expires_at }
  : null;

// Deteksi link TikTok/Instagram (SALINAN dari api/chat.js — server
// tetap yang memutuskan rute; ini hanya memilih animasi loading).
function matchDlTarget(text) {
  const urls = String(text || '').match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  for (const raw of urls) {
    let u;
    try { u = new URL(raw.replace(/[.,;!?]+$/, '')); } catch { continue; }
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    if (/(^|\.)tiktok\.com$/.test(h)) return 'tiktok';
    if (/(^|\.)instagram\.com$/.test(h)) return 'ig';
  }
  return null;
}

// Metadata kartu downloader (disimpan server di pesan assistant)
const dlOf = (m) => (m && m.dl && typeof m.dl === 'object' && (m.dl.video || m.dl.images || m.dl.music))
  ? m.dl
  : null;

const els = {};
let currentId = null;      // conversation_id aktif
let loading = false;
let pendingImage = null;   // { dataUrl: ≤1024px (untuk AI), thumb: ≤360px (untuk tampilan) }
let loaded = [];           // pesan yang sedang dirender
let firstHidden = 0;
let nearBottom = true;
let lastRole = null;       // peran pesan terakhir yang dirender (untuk header nama)

export function initChat(initialItems) {
  els.scroll = $('#chatScroll');
  els.column = $('#chatColumn');
  els.welcome = $('#welcome');
  els.earlierWrap = $('#loadEarlierWrap');
  els.title = $('#chatTitle');
  els.charAvatar = $('#charAvatar');
  els.welcomeAvatar = $('#welcomeAvatar');
  els.welcomeSub = $('#welcomeSub');
  els.input = $('#input');
  els.sendBtn = $('#sendBtn');
  els.composer = $('#composer');
  els.scrollDown = $('#scrollDownBtn');
  els.attachBtn = $('#attachBtn');
  els.attachInput = $('#attachInput');
  els.attachPreview = $('#attachPreview');
  els.attachPreviewImg = $('#attachPreviewImg');
  els.attachRemove = $('#attachRemove');
  els.menu = $('#msgMenu');
  els.toast = $('#copyToast');

  bindComposer();
  bindScroll();
  bindSuggestions();
  bindMessageActions();
  updateCharHead();

  // `greet: true` → karakter menyapa duluan (chat baru / pertama kali)
  on('chat:open', ({ id, greet }) => (id ? loadConversation(id) : resetView(!!greet)));
  on('chat:deleted', ({ id }) => {
    if (currentId === id) resetView(true); // karakter membuka chat baru lagi
  });
  // karakter / display name berubah → perbarui label yang sudah ada (bukan re-render)
  on('settings:updated', () => {
    updateCharHead();
    refreshLabels();
  });

  // Returning user: langsung buka percakapan terakhir. Belum pernah
  // ngobrol → karakter menyapa duluan (bukan welcome screen statis).
  bootstrapOpen(initialItems);
}

async function bootstrapOpen(initialItems) {
  let items = initialItems;
  if (!Array.isArray(items)) {
    // boot tidak menyertakan data (fetch conversations gagal sesaat) →
    // coba sendiri sekali; gagal lagi → welcome statis.
    try {
      const data = await apiJson('/api/conversations');
      items = data.items || [];
    } catch {
      resetView(false);
      return;
    }
  }
  if (items.length > 0) {
    loadConversation(items[0].conversation_id);
  } else {
    resetView(true);
  }
}

function updateCharHead() {
  els.title.textContent = state.bot.bot_name || 'Aomi';
  renderAvatar(els.charAvatar, state.bot.bot_avatar, 'logo');
  // welcome personal: avatar karakter, bukan judul/slogan besar
  renderAvatar(els.welcomeAvatar, state.bot.bot_avatar, 'logo');
}

/* ============================================================
   RENDER — append-only, tidak pernah render ulang semua pesan
   ============================================================ */

function labelFor(role) {
  return role === 'user'
    ? (state.user.display_name || state.user.username || 'Kamu')
    : (state.bot.bot_name || 'Aomi');
}

/**
 * Renderer pesan — SATU-satunya jalur render pesan di aplikasi ini.
 * Struktur DOM menentukan posisi (bukan CSS order-trick):
 *
 * assistant (kiri):  .message-row.assistant > [.message-avatar, .message-body]
 * user (kanan):      .message-row.user      > [.message-body, .message-avatar]
 *
 * .message-body > [.message-header (nama pengirim), .message-content]
 * Avatar & nama dari state terpusat (profile/bot dinamis, tidak hardcode).
 */
/* ============================================================
   KARTU DOWNLOADER (TikTok / Instagram)
   Thumbnail + tombol unduh. Link TikTok lewat proxy /api/dl
   (CDN-nya cuma mau "diputar", bukan diunduh); link Instagram
   dipakai langsung (rapidcdn sudah memaksa unduh).
   ============================================================ */

function dlDownloadHref(dl, url, name) {
  if (dl.platform === 'ig') return url;
  const sid = getSessionId();
  return '/api/dl?url=' + encodeURIComponent(url)
    + '&name=' + encodeURIComponent(name)
    + (sid ? '&sid=' + encodeURIComponent(sid) : '');
}

function dlBtnNode(dl, kind) {
  const a = document.createElement('a');
  a.className = 'dl-btn';
  a.rel = 'noopener';
  if (dl.platform === 'ig') a.target = '_blank';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<use href="components/icons.svg#download" />';
  const label = document.createElement('span');
  if (kind === 'mp4') {
    label.textContent = 'MP4';
    a.href = dlDownloadHref(dl, dl.video,
      (dl.platform === 'tiktok' ? 'tiktok-' + (dl.id || 'video') : 'instagram-video') + '.mp4');
    a.setAttribute('aria-label', 'Unduh video MP4');
  } else {
    label.textContent = 'MP3';
    a.href = dlDownloadHref(dl, dl.music, (dl.platform === 'tiktok' ? 'tiktok-audio' : 'instagram-audio') + '.mp3');
    a.setAttribute('aria-label', 'Unduh audio MP3');
  }
  a.append(icon, label);
  return a;
}

function buildDlCard(dl) {
  const card = document.createElement('div');
  card.className = 'dl-card';

  // Kepala kartu: badge platform + judul (+ penulis)
  const head = document.createElement('div');
  head.className = 'dl-head';
  const badge = document.createElement('span');
  badge.className = 'dl-badge';
  badge.textContent = dl.platform === 'tiktok' ? 'TikTok' : 'Instagram';
  const title = document.createElement('span');
  title.className = 'dl-title';
  title.textContent = dl.title || (dl.type === 'video' ? 'Video' : 'Foto');
  head.append(badge, title);
  card.appendChild(head);
  if (dl.author) {
    const sub = document.createElement('div');
    sub.className = 'dl-sub';
    sub.textContent = 'by ' + dl.author + (dl.music_title ? ' · ' + dl.music_title : '');
    card.appendChild(sub);
  }

  if (dl.type === 'video' && dl.video) {
    const thumb = document.createElement('img');
    thumb.className = 'dl-thumb';
    thumb.src = dl.cover || '';
    thumb.alt = 'Thumbnail video';
    thumb.loading = 'lazy';
    // Link CDN kedaluwarsa saat history dibuka lama → sembunyikan, kartu tetap berguna
    thumb.onerror = () => thumb.remove();
    if (dl.cover) card.appendChild(thumb);
    const btns = document.createElement('div');
    btns.className = 'dl-btns';
    btns.appendChild(dlBtnNode(dl, 'mp4'));
    if (dl.music) btns.appendChild(dlBtnNode(dl, 'mp3'));
    card.appendChild(btns);
  } else {
    // Slide foto: grid thumbnail — klik = unduh/buka ukuran asli
    const grid = document.createElement('div');
    grid.className = 'dl-imgs';
    const imgs = Array.isArray(dl.images) ? dl.images.slice(0, 12) : [];
    imgs.forEach((u, i) => {
      const a = document.createElement('a');
      a.className = 'dl-img-link';
      a.href = dlDownloadHref(dl, u,
        (dl.platform === 'tiktok' ? 'tiktok-' + (dl.id || 'img') : 'instagram-img') + '-' + (i + 1) + '.jpg');
      a.rel = 'noopener';
      if (dl.platform === 'ig') a.target = '_blank';
      const im = document.createElement('img');
      im.className = 'dl-img';
      im.src = u;
      im.alt = 'Foto ' + (i + 1);
      im.loading = 'lazy';
      im.onerror = () => a.remove();
      a.appendChild(im);
      grid.appendChild(a);
    });
    if (grid.children.length) card.appendChild(grid);
    if (dl.music) {
      const btns = document.createElement('div');
      btns.className = 'dl-btns';
      btns.appendChild(dlBtnNode(dl, 'mp3'));
      card.appendChild(btns);
    }
  }
  return card;
}

/* ============================================================
   RENDER TEKS PESAN (aman + code block)
   - Semua isi pesan (user maupun karakter) masuk lewat
     textContent / createTextNode → HTML di dalam pesan
     TIDAK PERNAH dieksekusi; <script> atau <div> tampil
     sebagai teks biasa. Ini sekaligus jawaban atas "pesan HTML
     jadi preview": sekarang jadi code block rapi + tombol salin.
   - ``` fence → code block dengan header bahasa + tombol "Salin"
   - `inline` → chip kode kecil di dalam teks
   ============================================================ */

function textSegment(text) {
  const span = document.createElement('span');
  span.className = 'message-text';
  for (const part of String(text).split(/(`[^`\n]+`)/g)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code');
      code.className = 'inline-code';
      code.textContent = part.slice(1, -1);
      span.appendChild(code);
    } else {
      span.appendChild(document.createTextNode(part));
    }
  }
  return span;
}

function codeBlockNode(lang, code) {
  const block = document.createElement('div');
  block.className = 'code-block';

  const head = document.createElement('div');
  head.className = 'code-head';
  const langEl = document.createElement('span');
  langEl.className = 'code-lang';
  langEl.textContent = lang || 'code';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-copy';
  btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="components/icons.svg#copy" /></svg><span>Salin</span>';
  btn.addEventListener('click', async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(code);
      ok = true;
    } catch {
      // Fallback browser lama / konteks tidak aman
      try {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch { ok = false; }
    }
    btn.classList.toggle('copied', ok);
    btn.querySelector('span').textContent = ok ? 'Tersalin' : 'Gagal';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.querySelector('span').textContent = 'Salin';
    }, 1600);
  });
  head.append(langEl, btn);

  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  codeEl.textContent = code;   // ← inti keamanannya: textContent
  pre.appendChild(codeEl);

  block.append(head, pre);
  return block;
}

function renderMessageText(text) {
  const frag = document.createDocumentFragment();
  const raw = String(text || '');

  // ```lang\n...``` — fence tanpa penutup dianggap blok sampai akhir
  const re = /```([a-zA-Z0-9+#._-]*)[^\S\n]*\r?\n([\s\S]*?)(?:```|$)/g;
  let last = 0, m;
  while ((m = re.exec(raw))) {
    if (m.index > last) frag.appendChild(textSegment(raw.slice(last, m.index)));
    frag.appendChild(codeBlockNode(m[1], m[2].replace(/\n+$/, '')));
    last = re.lastIndex;
  }
  if (last < raw.length) frag.appendChild(textSegment(raw.slice(last)));

  if (!frag.childNodes.length) {
    const span = document.createElement('span');
    span.className = 'message-text';
    frag.appendChild(span);
  }
  return frag;
}

function messageNode(role, content, isError, showName, imageUrl, mid, file, dl) {
  const row = document.createElement('div');
  row.className = 'message-row ' + (role === 'user' ? 'user' : 'assistant') + (isError ? ' error' : '');
  if (mid) row.dataset.mid = mid;   // id pesan server → aksi menu (copy/delete/edit/regen)

  // Avatar dinamis dari state (user: profile.avatar, bot: bot.avatar)
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  renderAvatar(
    avatar,
    role === 'user' ? state.user.avatar : state.bot.bot_avatar,
    role === 'user' ? 'user' : 'logo'
  );

  // Body: header (nama) + content
  const body = document.createElement('div');
  body.className = 'message-body';

  const header = document.createElement('div');
  header.className = 'message-header';
  header.dataset.role = role === 'user' ? 'user' : 'assistant';
  header.textContent = labelFor(role);
  // Chat natural: nama tampil hanya pada pesan karakter pertama dari
  // rangkaian beruntun — nama user sendiri tidak pernah ditampilkan.
  header.hidden = !(role === 'assistant' && showName);
  // Tanpa header → avatar harus sejajar baris pertama bubble (lihat CSS .compact)
  row.classList.toggle('compact', header.hidden);

  const contentEl = document.createElement('div');
  contentEl.className = 'message-content';

  // Gambar (opsional) di dalam bubble — teks jadi caption, boleh kosong
  if (imageUrl) {
    const img = document.createElement('img');
    img.className = 'message-image' + (file ? ' result' : '');
    img.src = imageUrl;
    img.alt = 'Gambar terlampir';
    img.loading = 'lazy';
    contentEl.appendChild(img);
  }
  if (content) {
    // Teks + code block (``` ```) + inline code (`x`) — semua isi
    // dirender via textContent/createTextNode (HTML tidak pernah
    // dieksekusi, pesan berisi kode tampil sebagai kode, bukan preview).
    contentEl.appendChild(renderMessageText(content));
  } else if (!imageUrl) {
    contentEl.textContent = content;   // pesan kosong teknis
  }

  // Tombol unduh hasil edit foto — di bawah gambar, selama masa
  // unduh (TTL) masih hidup; setelah itu cukup hint kecil.
  if (file && file.url) {
    const alive = file.expiresAt ? Date.parse(file.expiresAt) > Date.now() : true;
    if (alive) {
      const dl = document.createElement('a');
      dl.className = 'img-dl';
      dl.href = file.url + (file.url.includes('?') ? '&' : '?') + 'dl=1'
        + (file.name ? '&name=' + encodeURIComponent(file.name) : '');
      dl.setAttribute('download', file.name || 'aomi-edit.png');
      dl.innerHTML = '<svg class="icon" aria-hidden="true"><use href="components/icons.svg#download" /></svg><span>Unduh</span>';
      contentEl.appendChild(dl);
    } else {
      const hint = document.createElement('span');
      hint.className = 'img-dl-hint';
      hint.textContent = 'masa unduh sudah habis';
      contentEl.appendChild(hint);
    }
  }

  // Kartu downloader (TikTok/IG): thumbnail + tombol unduh MP4/MP3/gambar
  if (dl) contentEl.appendChild(buildDlCard(dl));

  body.append(header, contentEl);

  if (role === 'user') {
    // USER di kanan: [body][avatar] — avatar paling kanan
    row.append(body, avatar);
  } else {
    // BOT di kiri: [avatar][body] — avatar paling kiri
    row.append(avatar, body);
  }
  return row;
}

/**
 * Terapkan profile/bot terbaru ke pesan yang sudah dirender.
 * Hanya elemen avatar & label yang di-update (src swap), bukan
 * membangun ulang ribuan node — DOM cap tetap ~150.
 */
function refreshLabels() {
  for (const h of els.column.querySelectorAll('.message-header')) {
    h.textContent = h.dataset.role === 'user'
      ? labelFor('user')
      : labelFor('assistant');
  }
  for (const av of els.column.querySelectorAll('.message-row.user > .message-avatar')) {
    renderAvatar(av, state.user.avatar, 'user');
  }
  for (const av of els.column.querySelectorAll('.message-row.assistant > .message-avatar')) {
    renderAvatar(av, state.bot.bot_avatar, 'logo');
  }
}

function appendMessage(role, content, isError = false, imageUrl = null, mid = null, file = null, dl = null) {
  const wasNearBottom = nearBottom;
  els.welcome.hidden = true;
  const showName = role !== lastRole;   // nama hanya saat ganti peran
  const row = messageNode(role, content, isError, showName, imageUrl, mid, file, dl);
  els.column.appendChild(row);
  lastRole = role;

  const nodes = els.column.querySelectorAll(':scope > .message-row');
  if (nodes.length > DOM_CAP) {
    nodes[0].remove();
    firstHidden++;
    updateEarlierButton();
  }
  if (wasNearBottom) scrollToBottom(false);
  return row;
}

// Pesan yang dikirim/generate juga dicatat ke `loaded` agar aksi
// delete/edit/regenerate tetap konsisten dengan server tanpa reload.
function trackMessage(role, content, mid, image) {
  if (!mid) return;
  loaded.push({ message_id: mid, role, content, image, timestamp: new Date().toISOString() });
}

// Indikator "sedang mengetik" — satu bentuk untuk semua alur
function typingRow() {
  const typing = messageNode('assistant', '', false, false);
  typing.classList.add('typing');
  typing.querySelector('.message-content').innerHTML =
    '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  return typing;
}

// Indikator khusus "sedang mengedit foto" — proses edit butuh puluhan
// detik, jadi label eksplisit + ikon foto berdenyut supaya user tahu
// ini bukan sekadar mengetik (dan tidak mengira aplikasinya nge-hang).
function downloadingRow() {
  const row = messageNode('assistant', '', false, false);
  row.classList.add('editing');   // gaya indikator sama (ikon + label + dots)
  row.querySelector('.message-content').innerHTML =
    '<svg class="icon edit-ic" aria-hidden="true"><use href="components/icons.svg#download" /></svg>'
    + '<span class="edit-label">lagi nyariin file-nya</span>'
    + '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  return row;
}

function editingRow() {
  const editing = messageNode('assistant', '', false, false);
  editing.classList.add('editing');
  editing.querySelector('.message-content').innerHTML =
    '<svg class="icon edit-ic" aria-hidden="true"><use href="components/icons.svg#image" /></svg>'
    + '<span class="edit-label">lagi ngedit fotonya</span>'
    + '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  return editing;
}

/**
 * Setelah hasil edit tampil, klien mengompres salinannya menjadi
 * thumbnail (±540px) lalu mengirim ke server untuk disimpan permanen
 * di pesan — percakapan tetap bisa menampilkan hasil SETELAH masa
 * unduh (TTL 3 hari) berakhir. Gagal → diam-diam lewati, pesan
 * tetap punya URL unduh.
 */
async function persistEditThumb(url, messageId, convId) {
  try {
    const blob = await (await fetch(url)).blob();
    if (!blob.type.startsWith('image/')) return;
    const file = new File([blob], 'edit', { type: blob.type });
    const thumb = await compressImage(file, 540, 0.72);
    await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: convId,
        action: 'thumb',
        message_id: messageId,
        thumb
      })
    });
  } catch { /* opsional — URL unduh masih valid */ }
}

function resetView(greet) {
  els.column.querySelectorAll('.message-row').forEach((n) => n.remove());
  loaded = [];
  firstHidden = 0;
  lastRole = null;
  currentId = null;
  els.earlierWrap.hidden = true;
  els.welcome.hidden = false;
  updateCharHead();
  emit('chat:activated', { id: null });
  if (greet) requestGreeting();
}

/**
 * Sapaan pertama karakter: buat percakapan baru (server-side) lalu
 * render pesan pembuka dari personality. Server menolak bila
 * percakapan sudah berisi pesan → tidak pernah dobel.
 */
async function requestGreeting() {
  if (loading) return;
  loading = true;
  els.sendBtn.disabled = true;

  // indikator "dia sedang mengetik" (welcome disembunyikan)
  els.welcome.hidden = true;
  const typing = typingRow();
  els.column.appendChild(typing);
  scrollToBottom(true);

  try {
    const res = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ greeting: true })
    });
    const data = await res.json().catch(() => null);

    typing.remove();
    if (res.ok && data?.text && !data.already) {
      currentId = data.conversation_id || null;
      trackMessage('assistant', data.text, data.message_id);
      appendMessage('assistant', data.text, false, null, data.message_id);
      emit('chat:updated');        // sidebar: percakapan baru muncul
      emit('chat:activated', { id: currentId });
    } else if (data?.already) {
      // sudah ada isinya (race) → buka percakapan itu
      if (data.conversation_id) loadConversation(data.conversation_id);
    } else {
      appendMessage('assistant', data?.error || 'Dia sepertinya sedang sibuk sebentar. Coba lagi nanti.', true);
    }
  } catch (err) {
    typing.remove();
    if (err.message !== 'unauthorized') {
      appendMessage('assistant', 'Koneksi sedang bermasalah. Coba lagi nanti ya.', true);
    }
  } finally {
    loading = false;
    updateSendState();
  }
  if (nearBottom) scrollToBottom(true);
}

async function loadConversation(id) {
  // Muat via api() (bukan apiJson) supaya status HTTP jelas —
  // HANYA 404 (data memang tidak ada) yang boleh menghapus percakapan
  // dari riwayat. Error lain (cold start, server sibuk, jaringan)
  // hanya menampilkan pesan; riwayat TETAP AMAN.
  let res = null, data = null;
  try {
    res = await api('/api/conversations?id=' + encodeURIComponent(id));
    data = await res.json().catch(() => null);
  } catch (err) {
    if (err.message === 'unauthorized') return; // sudah dialihkan ke login
    resetView();
    els.welcome.hidden = true;
    appendMessage('assistant', 'Gagal memuat percakapan (koneksi/server sedang sibuk). Riwayatmu aman — coba buka lagi sebentar.', true);
    return;
  }

  if (!res.ok) {
    if (res.status === 404) {
      // File percakapan memang tidak ada (pindah akun / peninggalan lama)
      // → satu-satunya kasus yang boleh membersihkan entrinya.
      resetView();
      els.welcome.hidden = true;
      appendMessage('assistant', 'Percakapan ini sudah tidak tersedia (datanya hilang/rusak). Sudah dihapus dari riwayat.', true);
      api('/api/conversations?id=' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
      emit('chat:deleted', { id });
    } else {
      // 5xx dsb. → JANGAN hapus; coba lagi nanti.
      resetView();
      els.welcome.hidden = true;
      appendMessage('assistant', 'Server sedang sibuk, percakapan belum bisa dimuat. Riwayatmu aman — coba buka lagi sebentar.', true);
    }
    return;
  }

  const conv = data?.conversation;
  if (!conv || !conv.conversation_id) {
    resetView();
    els.welcome.hidden = true;
    appendMessage('assistant', 'Data percakapan tidak valid. Coba muat ulang halaman.', true);
    return;
  }

  currentId = conv.conversation_id;
  loaded = (Array.isArray(conv.messages) ? conv.messages : [])
    .filter((m) => m && typeof m === 'object');
  updateCharHead();

  els.column.querySelectorAll('.message-row').forEach((n) => n.remove());
  firstHidden = Math.max(0, loaded.length - RENDER_BATCH);
  lastRole = null;

  const fragment = document.createDocumentFragment();
  let prev = firstHidden > 0 ? loaded[firstHidden - 1].role : null;
  for (const m of loaded.slice(firstHidden)) {
    const showName = m.role === 'assistant' && m.role !== prev;
    let row = null;
    try {
      row = messageNode(m.role, m.content, false, showName, m.image || m.image_url || null, m.message_id, fileOf(m), dlOf(m));
    } catch {
      // Satu pesan rusak TIDAK BOLEH menggagalkan seluruh riwayat.
      row = messageNode(m.role, String(m.content ?? ''), false, showName, null, m.message_id);
    }
    fragment.appendChild(row);
    prev = m.role;
  }
  els.column.appendChild(fragment);
  lastRole = loaded.length ? loaded[loaded.length - 1].role : null;
  els.welcome.hidden = loaded.length > 0;
  updateEarlierButton();
  scrollToBottom(false);
  emit('chat:activated', { id: currentId });
}

function prependBatch() {
  if (firstHidden === 0) return;
  const start = Math.max(0, firstHidden - RENDER_BATCH);
  const slice = loaded.slice(start, firstHidden);
  firstHidden = start;

  const anchor = els.column.querySelector('.message-row') || null;
  const fragment = document.createDocumentFragment();
  let prev = start > 0 ? loaded[start - 1].role : null;
  for (const m of slice) {
    const showName = m.role === 'assistant' && m.role !== prev;
    let row = null;
    try {
      row = messageNode(m.role, m.content, false, showName, m.image || m.image_url || null, m.message_id, fileOf(m), dlOf(m));
    } catch {
      row = messageNode(m.role, String(m.content ?? ''), false, showName, null, m.message_id);
    }
    fragment.appendChild(row);
    prev = m.role;
  }
  const prevHeight = els.scroll.scrollHeight;
  els.column.insertBefore(fragment, anchor);
  els.scroll.scrollTop += els.scroll.scrollHeight - prevHeight;
  updateEarlierButton();
}

function updateEarlierButton() {
  els.earlierWrap.hidden = firstHidden === 0;
}

/* ============================================================
   SCROLL — hanya area chat yang scroll; body terkunci (main.css)
   ============================================================ */

function scrollToBottom(smooth) {
  requestAnimationFrame(() => {
    els.scroll.scrollTo({
      top: els.scroll.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    });
  });
}

function bindScroll() {
  els.scroll.addEventListener('scroll', raf(() => {
    const max = els.scroll.scrollHeight - els.scroll.clientHeight;
    nearBottom = max - els.scroll.scrollTop < 80;
    els.scrollDown.hidden = nearBottom || loaded.length === 0;
  }), { passive: true });

  els.scrollDown.addEventListener('click', () => scrollToBottom(true));
  els.earlierWrap.addEventListener('click', (e) => {
    if (e.target.id === 'loadEarlierBtn') prependBatch();
  });

  // Keyboard mobile: setelah viewport menyusut (visualViewport di app.js
  // menyesuaikan --app-h), pertahankan posisi baca bila sedang di bawah.
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', raf(() => {
      if (nearBottom) scrollToBottom(false);
    }));
  }
}

/* ============================================================
   LAMPIRAN GAMBAR (tombol + di kiri komposer)
   Dua versi dikompres di klien biar upload & penyimpanan ringan:
   - dataUrl ≤1024px JPEG (dikirim ke AI vision)
   - thumb   ≤360px JPEG (pratinjau + disimpan ke percakapan)
   ============================================================ */

function compressImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Gambar tidak bisa dibaca.')); };
    img.src = url;
  });
}

function clearPendingImage() {
  pendingImage = null;
  els.attachPreview.hidden = true;
  els.attachPreviewImg.removeAttribute('src');
  els.attachInput.value = '';
  updateSendState();
}

async function handleFilePicked() {
  const file = els.attachInput.files?.[0];
  if (!file) return;
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
    clearPendingImage();
    return;
  }
  try {
    pendingImage = {
      dataUrl: await compressImage(file, 1024, 0.82),
      thumb: await compressImage(file, 360, 0.68)
    };
    els.attachPreviewImg.src = pendingImage.thumb;
    els.attachPreview.hidden = false;
    updateSendState();
  } catch {
    clearPendingImage();
    appendMessage('assistant', 'Gagal memproses gambar. Coba file lain ya.', true);
  }
}

function bindAttach() {
  els.attachBtn.addEventListener('click', () => els.attachInput.click());
  els.attachInput.addEventListener('change', handleFilePicked);
  els.attachRemove.addEventListener('click', clearPendingImage);
}

/* ============================================================
   KOMPOSER — tetap di bawah Main Chat, tidak ikut scroll
   ============================================================ */

function updateSendState() {
  els.sendBtn.disabled = loading || (!els.input.value.trim() && !pendingImage);
}

function bindComposer() {
  const resize = raf(() => {
    els.input.style.height = 'auto';
    els.input.style.height = els.input.scrollHeight + 'px';
    updateSendState();
  });

  els.input.addEventListener('input', resize);

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.composer.requestSubmit();
    }
  });

  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  bindAttach();
}

function bindSuggestions() {
  $('#suggestions').addEventListener('click', (e) => {
    const btn = e.target.closest('.suggestion');
    if (!btn) return;
    els.input.value = btn.dataset.q;
    els.composer.requestSubmit();
  });
}

/* ============================================================
   KIRIM PESAN (server menyimpan ke percakapan akun)
   ============================================================ */

async function submit() {
  const text = sanitizeText(els.input.value, 4000);
  const img = pendingImage;
  if ((!text && !img) || loading) return;

  loading = true;
  els.sendBtn.disabled = true;

  // Render optimistik untuk pesan user (gambar + caption)
  const userRow = appendMessage('user', text, false, img?.thumb || null);

  els.input.value = '';
  els.input.style.height = 'auto';
  clearPendingImage();
  els.input.focus();

  // Indikator: permintaan edit foto → "lagi ngedit fotonya" (proses
  // ±40 detik), selain itu titik mengetik biasa. Deteksi regex sama
  // dengan server (server tetap pemutus rute).
  const wantsEdit = !!(img && text && EDIT_TRIGGER_RE.test(text));
  const wantsDl = !img && !wantsEdit && !!matchDlTarget(text);
  const typing = wantsEdit ? editingRow() : (wantsDl ? downloadingRow() : typingRow());
  els.column.appendChild(typing);
  scrollToBottom(true);

  let ok = false;
  try {
    const res = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: currentId,
        message: text,
        ...(img ? { image: img.dataUrl, thumb: img.thumb } : {})
      })
    });
    const data = await res.json().catch(() => null);

    if (res.ok && data?.edit_job) {
      // Tahap 1 selesai (server simpan pesan user + host gambar, cepat).
      // Tahap 2: browser menembak API edit — lama (±40-60 detik) tapi
      // tidak lagi dibatasi timeout runtime server.
      ok = true;
      currentId = data.conversation_id || currentId;
      updateCharHead();
      if (data.user_message_id) {
        userRow.dataset.mid = data.user_message_id;
        trackMessage('user', text, data.user_message_id, img?.thumb || null);
      }

      const job = data.edit_job;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), EDIT_BROWSER_TIMEOUT);
      let blob = null;
      try {
        const r = await fetch(
          `${EDIT_API}?url=${encodeURIComponent(job.input_url)}&prompt=${encodeURIComponent(job.prompt)}`,
          { signal: ctrl.signal }
        );
        clearTimeout(timer);
        if (!r.ok) throw new Error('edit http ' + r.status);
        blob = await r.blob();
        if (blob.size > EDIT_RESULT_MAX) throw new Error('hasil terlalu besar');
      } catch {
        clearTimeout(timer);
        typing.remove();
        appendMessage('assistant', 'Ngeditnya kelamaan atau gagal. Kirim ulang fotonya bareng instruksinya ya.', true);
        api('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'edit-fail',
            conversation_id: currentId,
            message: 'edit foto tadi gagal (kelamaan/gangguan) — kirim ulang fotonya ya.'
          })
        }).catch(() => {});
        emit('chat:updated');
        if (nearBottom) scrollToBottom(true);
        return;
      }

      // Tahap 3: kirim hasil ke server untuk disimpan → URL unduh 3 hari.
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      const res2 = await api('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'edit-save', conversation_id: currentId, image: dataUrl })
      });
      const data2 = await res2.json().catch(() => null);
      typing.remove();
      if (res2.ok && data2?.image_url) {
        const file = { url: data2.image_url, name: data2.image_name, expiresAt: data2.expires_at };
        appendMessage('assistant', data2.text, false, data2.image_url, data2.assistant_message_id, file);
        persistEditThumb(data2.image_url, data2.assistant_message_id, data2.conversation_id || currentId);
        trackMessage('assistant', data2.text, data2.assistant_message_id);
        emit('chat:updated');
        emit('chat:activated', { id: currentId });
      } else {
        appendMessage('assistant', data2?.error || 'Gagal menyimpan hasil edit. Coba lagi ya.', true);
      }
      if (nearBottom) scrollToBottom(true);
      return;
    }

    if (res.ok && data?.text) {
      ok = true;
      currentId = data.conversation_id || currentId;
      updateCharHead();
      typing.remove();
      // id pesan baru dari server → aktifkan aksi menu pada kedua bubble
      if (data.user_message_id) {
        userRow.dataset.mid = data.user_message_id;
        trackMessage('user', text, data.user_message_id, img?.thumb || null);
      }
      trackMessage('assistant', data.text, data.assistant_message_id);
      // Hasil downloader: kartu thumbnail + tombol unduh MP4/MP3/gambar
      if (data.dl) {
        appendMessage('assistant', data.text, false, null, data.assistant_message_id, null, data.dl);
      } else if (data.image_url) {
        const file = {
          url: data.image_url,
          name: data.image_name,
          expiresAt: data.expires_at
        };
        appendMessage('assistant', data.text, false, data.image_url, data.assistant_message_id, file);
        persistEditThumb(data.image_url, data.assistant_message_id, data.conversation_id || currentId);
      } else {
        appendMessage('assistant', data.text, false, null, data.assistant_message_id);
      }
      emit('chat:updated');   // sidebar refresh (judul/urutan baru)
      emit('chat:activated', { id: currentId });
    } else {
      typing.remove();
      appendMessage('assistant', data?.error || 'Gagal mengirim. Coba lagi.', true);
    }
  } catch (err) {
    if (err.message === 'unauthorized') return; // sudah dialihkan
    typing.remove();
    appendMessage('assistant', 'Tidak bisa menghubungi server. Cek koneksi.', true);
  } finally {
    loading = false;
    els.sendBtn.disabled = els.input.value.trim() === '';
  }
  if (ok && nearBottom) scrollToBottom(true);
}

/* ============================================================
   AKSI PESAN — menu konteks: klik kanan (desktop) / long-press
   (mobile). SATU set listener delegated di #chatColumn untuk semua
   pesan (tanpa listener per-bubble); menu DOM tunggal dipakai ulang.
   Aksi: Copy, Edit (user), Regenerate (assistant terakhir), Delete —
   semua konsisten dengan history server via message_id.
   ============================================================ */

let menuRow = null;      // baris pemilik menu yang sedang terbuka
let editBoxOpen = null;  // baris yang sedang diedit inline
let toastTimer = null;

function bindMessageActions() {
  // --- Desktop: klik kanan pada bubble ---
  els.column.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.message-row');
    if (!row || row.classList.contains('typing')) return;
    e.preventDefault();               // ganti menu native browser
    openMenu(row, e.clientX, e.clientY);
  });

  // --- Mobile: long-press ~480ms; batal saat jari bergeser (scroll
  //     tetap lancar). Listener passive — tidak mengganggu scroll. ---
  let lpTimer = null, lpRow = null, lpX = 0, lpY = 0;
  const LP_MS = 480;
  const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  els.column.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    lpRow = e.target.closest('.message-row');
    if (!lpRow || lpRow.classList.contains('typing') || editBoxOpen) return;
    lpX = t.clientX; lpY = t.clientY;
    lpTimer = setTimeout(() => {
      lpTimer = null;
      try { window.getSelection()?.removeAllRanges(); } catch { /* ios lama */ }
      navigator.vibrate?.(8);
      openMenu(lpRow, lpX, lpY);
    }, LP_MS);
  }, { passive: true });
  els.column.addEventListener('touchmove', (e) => {
    if (!lpTimer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - lpX) > 8 || Math.abs(t.clientY - lpY) > 8) cancelLp();
  }, { passive: true });
  els.column.addEventListener('touchend', cancelLp, { passive: true });
  els.column.addEventListener('touchcancel', cancelLp, { passive: true });

  // --- Aksi menu: delegation satu listener ---
  els.menu.addEventListener('click', (e) => {
    const btn = e.target.closest('.msg-menu-item');
    if (!btn || !menuRow) return;
    const row = menuRow;
    closeMenu();
    const act = btn.dataset.act;
    if (act === 'copy') doCopy(row);
    else if (act === 'delete') doDelete(row);
    else if (act === 'edit') startEdit(row);
    else if (act === 'regenerate') doRegenerate(row);
  });

  // --- Tutup menu: sentuh/klik di luar, Escape, scroll, resize ---
  document.addEventListener('pointerdown', (e) => {
    if (!els.menu.hidden && !els.menu.contains(e.target)) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.menu.hidden) closeMenu();
  });
  els.scroll.addEventListener('scroll', () => {
    if (!els.menu.hidden) closeMenu();
  }, { passive: true, capture: true });
  window.addEventListener('resize', () => {
    if (!els.menu.hidden) closeMenu();
  });
}

function openMenu(row, x, y) {
  const textEl = row.querySelector('.message-text');
  const text = textEl ? textEl.textContent : '';
  const isUser = row.classList.contains('user');
  const isErr = row.classList.contains('error');
  const mid = row.dataset.mid || '';
  const rows = els.column.querySelectorAll(':scope > .message-row');
  const isLast = rows.length > 0 && rows[rows.length - 1] === row;

  // Susun item sesuai jenis pesan
  els.menu.querySelector('[data-act="copy"]').hidden = !text;
  els.menu.querySelector('[data-act="edit"]').hidden = !(isUser && mid && !isErr);
  els.menu.querySelector('[data-act="regenerate"]').hidden = !(!isUser && mid && !isErr && isLast);
  els.menu.querySelector('[data-act="delete"]').hidden = !(mid && !isErr);

  menuRow = row;
  els.menu.hidden = false;

  // Posisikan dekat titik tekan, selalu dalam viewport
  const mw = els.menu.offsetWidth, mh = els.menu.offsetHeight;
  const left = Math.min(Math.max(8, x - mw / 2), window.innerWidth - mw - 8);
  const above = y - mh - 10;
  const top = above >= 8 ? above : Math.min(y + 14, window.innerHeight - mh - 8);
  els.menu.style.left = left + 'px';
  els.menu.style.top = top + 'px';
}

function closeMenu() {
  els.menu.hidden = true;
  menuRow = null;
}

/* ---------------- Copy + toast "Copied ✓" ---------------- */

async function doCopy(row) {
  const textEl = row.querySelector('.message-text');
  const text = textEl ? textEl.textContent : '';
  if (!text) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // fallback konteks non-secure / browser lama
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { /* gagal total */ }
    ta.remove();
  }
  if (ok) showToast('Copied ✓');
}

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => { els.toast.hidden = true; }, 220);
  }, 1500);
}

/* ---------------- Delete (UI + history server) ---------------- */

async function doDelete(row) {
  const mid = row.dataset.mid;
  const cid = currentId;
  if (!mid || !cid || loading) return;
  const ok = await confirmDialog('Delete this message?', 'Delete', 'Cancel');
  if (!ok) return;

  // update state lokal dulu (instan), lalu sinkron ke server
  const idx = loaded.findIndex((m) => m && m.message_id === mid);
  if (idx >= 0) {
    loaded.splice(idx, 1);
    if (idx < firstHidden) firstHidden = Math.max(0, firstHidden - 1);
  }
  row.remove();
  updateEarlierButton();

  let serverOk = false;
  try {
    const res = await api('/api/conversations?id=' + encodeURIComponent(cid) +
      '&message_id=' + encodeURIComponent(mid), { method: 'DELETE' });
    serverOk = res.ok;
  } catch { serverOk = false; }

  if (!serverOk) {
    loadConversation(cid);   // gagal sinkron → muat ulang state server
    return;
  }
  if (loaded.length === 0 && firstHidden === 0) resetView(false);
}

/* ---------------- Edit (user) — inline, re-run dari titik itu ---------------- */

function startEdit(row) {
  if (loading || !currentId) return;
  if (editBoxOpen) cancelEdit(editBoxOpen);
  const textEl = row.querySelector('.message-text');
  const contentEl = row.querySelector('.message-content');
  if (!textEl || !contentEl) return;

  textEl.hidden = true;

  const box = document.createElement('div');
  box.className = 'edit-box';
  const ta = document.createElement('textarea');
  ta.className = 'edit-input';
  ta.value = textEl.textContent;
  ta.rows = 2;
  const actions = document.createElement('div');
  actions.className = 'edit-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'edit-cancel';
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'edit-save';
  save.textContent = 'Save';
  actions.append(cancel, save);
  box.append(ta, actions);
  contentEl.appendChild(box);
  editBoxOpen = row;

  const autoSize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  ta.addEventListener('input', autoSize);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save.click(); }
    if (e.key === 'Escape') cancelEdit(row);
  });
  cancel.addEventListener('click', () => cancelEdit(row));
  save.addEventListener('click', () => saveEdit(row));
  requestAnimationFrame(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    autoSize();
  });
}

function cancelEdit(row) {
  const box = row.querySelector('.edit-box');
  if (box) box.remove();
  const textEl = row.querySelector('.message-text');
  if (textEl) textEl.hidden = false;
  if (editBoxOpen === row) editBoxOpen = null;
}

async function saveEdit(row) {
  const ta = row.querySelector('.edit-input');
  const mid = row.dataset.mid;
  const cid = currentId;
  if (!ta || !mid || !cid || loading) return;
  const text = sanitizeText(ta.value, 4000);
  if (!text) return;

  loading = true;
  els.sendBtn.disabled = true;

  // terapkan teks baru + buang semua baris SETELAH pesan ini
  const textEl = row.querySelector('.message-text');
  textEl.textContent = text;
  textEl.hidden = false;
  const box = row.querySelector('.edit-box');
  if (box) box.remove();
  if (editBoxOpen === row) editBoxOpen = null;

  let sib = row.nextElementSibling;
  while (sib) {
    const next = sib.nextElementSibling;
    if (sib.classList && sib.classList.contains('message-row')) sib.remove();
    sib = next;
  }

  // sinkronkan loaded: isi berubah, sisanya dibuang
  const idx = loaded.findIndex((m) => m && m.message_id === mid);
  if (idx >= 0) {
    loaded[idx].content = text;
    loaded.length = idx + 1;
  }
  firstHidden = Math.min(firstHidden, loaded.length);
  lastRole = 'user';   // jawaban baru menampilkan nama karakter lagi

  const typing = typingRow();
  els.column.appendChild(typing);
  scrollToBottom(true);

  let ok = false;
  try {
    const res = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'edit', conversation_id: cid, message_id: mid, text })
    });
    const data = await res.json().catch(() => null);
    typing.remove();
    if (res.ok && data?.edit_job) {
      // Tahap 1 selesai (server simpan pesan user + host gambar, cepat).
      // Tahap 2: browser menembak API edit — lama (±40-60 detik) tapi
      // tidak lagi dibatasi timeout runtime server.
      ok = true;
      currentId = data.conversation_id || currentId;
      updateCharHead();
      if (data.user_message_id) {
        userRow.dataset.mid = data.user_message_id;
        trackMessage('user', text, data.user_message_id, img?.thumb || null);
      }

      const job = data.edit_job;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), EDIT_BROWSER_TIMEOUT);
      let blob = null;
      try {
        const r = await fetch(
          `${EDIT_API}?url=${encodeURIComponent(job.input_url)}&prompt=${encodeURIComponent(job.prompt)}`,
          { signal: ctrl.signal }
        );
        clearTimeout(timer);
        if (!r.ok) throw new Error('edit http ' + r.status);
        blob = await r.blob();
        if (blob.size > EDIT_RESULT_MAX) throw new Error('hasil terlalu besar');
      } catch {
        clearTimeout(timer);
        typing.remove();
        appendMessage('assistant', 'Ngeditnya kelamaan atau gagal. Kirim ulang fotonya bareng instruksinya ya.', true);
        api('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'edit-fail',
            conversation_id: currentId,
            message: 'edit foto tadi gagal (kelamaan/gangguan) — kirim ulang fotonya ya.'
          })
        }).catch(() => {});
        emit('chat:updated');
        if (nearBottom) scrollToBottom(true);
        return;
      }

      // Tahap 3: kirim hasil ke server untuk disimpan → URL unduh 3 hari.
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      const res2 = await api('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'edit-save', conversation_id: currentId, image: dataUrl })
      });
      const data2 = await res2.json().catch(() => null);
      typing.remove();
      if (res2.ok && data2?.image_url) {
        const file = { url: data2.image_url, name: data2.image_name, expiresAt: data2.expires_at };
        appendMessage('assistant', data2.text, false, data2.image_url, data2.assistant_message_id, file);
        persistEditThumb(data2.image_url, data2.assistant_message_id, data2.conversation_id || currentId);
        trackMessage('assistant', data2.text, data2.assistant_message_id);
        emit('chat:updated');
        emit('chat:activated', { id: currentId });
      } else {
        appendMessage('assistant', data2?.error || 'Gagal menyimpan hasil edit. Coba lagi ya.', true);
      }
      if (nearBottom) scrollToBottom(true);
      return;
    }

    if (res.ok && data?.text) {
      ok = true;
      updateCharHead();
      trackMessage('assistant', data.text, data.assistant_message_id);
      appendMessage('assistant', data.text, false, null, data.assistant_message_id);
      emit('chat:updated');
    } else {
      loadConversation(cid);   // server tidak berubah → muat ulang
    }
  } catch (err) {
    typing.remove();
    if (err.message === 'unauthorized') return;
    loadConversation(cid);
  } finally {
    loading = false;
    updateSendState();
  }
  if (ok && nearBottom) scrollToBottom(true);
}

/* ---------------- Regenerate (assistant) — ganti, tanpa duplikat ---------------- */

async function doRegenerate(row) {
  const mid = row.dataset.mid;
  const cid = currentId;
  if (!mid || !cid || loading) return;

  loading = true;
  els.sendBtn.disabled = true;

  // buang bubble lama (selalu baris terakhir) → jawaban baru menggantikan
  row.remove();
  const idx = loaded.findIndex((m) => m && m.message_id === mid);
  if (idx >= 0) loaded.length = idx;
  firstHidden = Math.min(firstHidden, loaded.length);
  lastRole = 'user';   // jawaban baru menampilkan nama karakter lagi

  const typing = typingRow();
  els.column.appendChild(typing);
  scrollToBottom(true);

  let ok = false;
  try {
    const res = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'regenerate', conversation_id: cid })
    });
    const data = await res.json().catch(() => null);
    typing.remove();
    if (res.ok && data?.edit_job) {
      // Tahap 1 selesai (server simpan pesan user + host gambar, cepat).
      // Tahap 2: browser menembak API edit — lama (±40-60 detik) tapi
      // tidak lagi dibatasi timeout runtime server.
      ok = true;
      currentId = data.conversation_id || currentId;
      updateCharHead();
      if (data.user_message_id) {
        userRow.dataset.mid = data.user_message_id;
        trackMessage('user', text, data.user_message_id, img?.thumb || null);
      }

      const job = data.edit_job;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), EDIT_BROWSER_TIMEOUT);
      let blob = null;
      try {
        const r = await fetch(
          `${EDIT_API}?url=${encodeURIComponent(job.input_url)}&prompt=${encodeURIComponent(job.prompt)}`,
          { signal: ctrl.signal }
        );
        clearTimeout(timer);
        if (!r.ok) throw new Error('edit http ' + r.status);
        blob = await r.blob();
        if (blob.size > EDIT_RESULT_MAX) throw new Error('hasil terlalu besar');
      } catch {
        clearTimeout(timer);
        typing.remove();
        appendMessage('assistant', 'Ngeditnya kelamaan atau gagal. Kirim ulang fotonya bareng instruksinya ya.', true);
        api('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'edit-fail',
            conversation_id: currentId,
            message: 'edit foto tadi gagal (kelamaan/gangguan) — kirim ulang fotonya ya.'
          })
        }).catch(() => {});
        emit('chat:updated');
        if (nearBottom) scrollToBottom(true);
        return;
      }

      // Tahap 3: kirim hasil ke server untuk disimpan → URL unduh 3 hari.
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      const res2 = await api('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'edit-save', conversation_id: currentId, image: dataUrl })
      });
      const data2 = await res2.json().catch(() => null);
      typing.remove();
      if (res2.ok && data2?.image_url) {
        const file = { url: data2.image_url, name: data2.image_name, expiresAt: data2.expires_at };
        appendMessage('assistant', data2.text, false, data2.image_url, data2.assistant_message_id, file);
        persistEditThumb(data2.image_url, data2.assistant_message_id, data2.conversation_id || currentId);
        trackMessage('assistant', data2.text, data2.assistant_message_id);
        emit('chat:updated');
        emit('chat:activated', { id: currentId });
      } else {
        appendMessage('assistant', data2?.error || 'Gagal menyimpan hasil edit. Coba lagi ya.', true);
      }
      if (nearBottom) scrollToBottom(true);
      return;
    }

    if (res.ok && data?.text) {
      ok = true;
      updateCharHead();
      trackMessage('assistant', data.text, data.assistant_message_id);
      appendMessage('assistant', data.text, false, null, data.assistant_message_id);
      emit('chat:updated');
    } else {
      loadConversation(cid);   // server tidak berubah → muat ulang
    }
  } catch (err) {
    typing.remove();
    if (err.message === 'unauthorized') return;
    loadConversation(cid);
  } finally {
    loading = false;
    updateSendState();
  }
  if (ok && nearBottom) scrollToBottom(true);
}
