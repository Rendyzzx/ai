/* ============================================================
   Aomi — chat.js
   Percakapan companion: render append-only, virtualisasi DOM,
   header karakter (avatar + status), auto-open percakapan
   terakhir untuk returning user, sapaan pertama dari personality
   (mode greeting), kirim ke /api/chat. Nama karakter dan profil
   diambil dari state (settings.js bisa mengubahnya kapan pun).
   ============================================================ */

import { $, raf, sanitizeText, renderAvatar, api, apiJson, emit, on, state } from './app.js?v=e9aa0007bd';

const RENDER_BATCH = 30;   // pesan per batch render
const DOM_CAP = 150;       // node pesan maksimum di DOM

const els = {};
let currentId = null;      // conversation_id aktif
let loading = false;
let loaded = [];           // pesan yang sedang dirender
let firstHidden = 0;
let nearBottom = true;
let lastRole = null;       // peran pesan terakhir yang dirender (untuk header nama)

export function initChat() {
  els.scroll = $('#chatScroll');
  els.column = $('#chatColumn');
  els.welcome = $('#welcome');
  els.earlierWrap = $('#loadEarlierWrap');
  els.title = $('#chatTitle');
  els.charAvatar = $('#charAvatar');
  els.charStatus = $('#charStatus');
  els.welcomeTitle = $('#welcomeTitle');
  els.welcomeSub = $('#welcomeSub');
  els.input = $('#input');
  els.sendBtn = $('#sendBtn');
  els.composer = $('#composer');
  els.scrollDown = $('#scrollDownBtn');

  bindComposer();
  bindScroll();
  bindSuggestions();
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
  bootstrapOpen();
}

async function bootstrapOpen() {
  try {
    const data = await apiJson('/api/conversations');
    const items = data.items || [];
    if (items.length > 0) {
      loadConversation(items[0].conversation_id);
    } else {
      resetView(true);
    }
  } catch {
    // gagal memuat indeks → welcome statis (tetap bisa ketik via suggestion)
    resetView(false);
  }
}

// Status pendek dari personality — terasa hidup, bukan "AI ready"
const STATUS_BY_TRAIT = {
  playful: 'iseng mode',
  teasing: 'ngerjain rencana iseng…',
  caring: 'mikirin kamu',
  shy: 'ngetik pelan-pelan…',
  calm: 'online',
  energetic: 'brimming energi',
  sarcastic: 'nahan komentar',
  affectionate: 'thinking about you',
  reserved: 'online'
};

function statusText(traits) {
  const list = Array.isArray(traits) && traits.length ? traits : ['calm'];
  // ambil status pertama yang punya teks khas; fallback 'online'
  for (const t of list) {
    if (STATUS_BY_TRAIT[t] && STATUS_BY_TRAIT[t] !== 'online') return STATUS_BY_TRAIT[t];
  }
  return 'online';
}

function updateCharHead() {
  els.title.textContent = state.bot.bot_name || 'Aomi';
  renderAvatar(els.charAvatar, state.bot.bot_avatar, 'logo');
  els.charStatus.textContent = statusText(state.bot.traits);
  // welcome terpersonalisasi dengan nama karakter
  const name = state.bot.bot_name || 'dia';
  els.welcomeTitle.textContent = `${name} nungguin kamu nih.`;
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
function messageNode(role, content, isError, showName) {
  const row = document.createElement('div');
  row.className = 'message-row ' + (role === 'user' ? 'user' : 'assistant') + (isError ? ' error' : '');

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

  const contentEl = document.createElement('div');
  contentEl.className = 'message-content';
  contentEl.textContent = content;

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

function appendMessage(role, content, isError = false) {
  const wasNearBottom = nearBottom;
  els.welcome.hidden = true;
  const showName = role !== lastRole;   // nama hanya saat ganti peran
  els.column.appendChild(messageNode(role, content, isError, showName));
  lastRole = role;

  const nodes = els.column.querySelectorAll(':scope > .message-row');
  if (nodes.length > DOM_CAP) {
    nodes[0].remove();
    firstHidden++;
    updateEarlierButton();
  }
  if (wasNearBottom) scrollToBottom(false);
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
  const typing = messageNode('assistant', '', false, false);
  typing.classList.add('typing');
  typing.querySelector('.message-content').innerHTML =
    '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
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
      appendMessage('assistant', data.text);
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
    els.sendBtn.disabled = els.input.value.trim() === '';
  }
  if (nearBottom) scrollToBottom(true);
}

async function loadConversation(id) {
  try {
    const data = await apiJson('/api/conversations?id=' + encodeURIComponent(id));
    const conv = data.conversation;
    currentId = conv.conversation_id;
    loaded = conv.messages || [];
    // Header selalu identitas karakter; judul percakapan cukup di sidebar
    updateCharHead();

    els.column.querySelectorAll('.message-row').forEach((n) => n.remove());
    firstHidden = Math.max(0, loaded.length - RENDER_BATCH);
    lastRole = null;

    const fragment = document.createDocumentFragment();
    let prev = firstHidden > 0 ? loaded[firstHidden - 1].role : null;
    for (const m of loaded.slice(firstHidden)) {
      const showName = m.role === 'assistant' && m.role !== prev;
      fragment.appendChild(messageNode(m.role, m.content, false, showName));
      prev = m.role;
    }
    els.column.appendChild(fragment);
    lastRole = loaded.length ? loaded[loaded.length - 1].role : null;
    els.welcome.hidden = loaded.length > 0;
    updateEarlierButton();
    scrollToBottom(false);
    emit('chat:activated', { id: currentId });
  } catch {
    resetView();
  }
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
    fragment.appendChild(messageNode(m.role, m.content, false, showName));
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
   KOMPOSER — tetap di bawah Main Chat, tidak ikut scroll
   ============================================================ */

function bindComposer() {
  const resize = raf(() => {
    els.input.style.height = 'auto';
    els.input.style.height = els.input.scrollHeight + 'px';
    els.sendBtn.disabled = loading || els.input.value.trim() === '';
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
  if (!text || loading) return;

  loading = true;
  els.sendBtn.disabled = true;

  // Render optimistik untuk pesan user
  appendMessage('user', text);

  els.input.value = '';
  els.input.style.height = 'auto';
  els.input.focus();

  // Indikator mengetik (dengan avatar bot, tanpa nama)
  const typing = messageNode('assistant', '', false, false);
  typing.classList.add('typing');
  typing.querySelector('.message-content').innerHTML =
    '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  els.column.appendChild(typing);
  scrollToBottom(true);

  let ok = false;
  try {
    const res = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: currentId,
        message: text
      })
    });
    const data = await res.json().catch(() => null);

    if (res.ok && data?.text) {
      ok = true;
      currentId = data.conversation_id || currentId;
      updateCharHead();
      typing.remove();
      appendMessage('assistant', data.text, false);
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
