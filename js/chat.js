/* ============================================================
   Aomi — chat.js
   Percakapan milik akun: render append-only, virtualisasi DOM,
   kirim ke /api/chat (server menyimpan riwayat & konteks).
   ============================================================ */

import { $, raf, sanitizeText, api, apiJson, emit, on } from './app.js';

const RENDER_BATCH = 30;   // pesan per batch render
const DOM_CAP = 150;       // node pesan maksimum di DOM

const els = {};
let currentId = null;      // conversation_id aktif
let loading = false;
let loaded = [];           // pesan yang sedang dirender dari server
let firstHidden = 0;
let nearBottom = true;

export function initChat() {
  els.scroll = $('#chatScroll');
  els.column = $('#chatColumn');
  els.welcome = $('#welcome');
  els.earlierWrap = $('#loadEarlierWrap');
  els.title = $('#chatTitle');
  els.input = $('#input');
  els.sendBtn = $('#sendBtn');
  els.composer = $('#composer');
  els.scrollDown = $('#scrollDownBtn');

  bindComposer();
  bindScroll();
  bindSuggestions();

  on('chat:open', ({ id }) => (id ? loadConversation(id) : resetView()));
  on('chat:deleted', ({ id }) => {
    if (currentId === id) resetView();
  });
}

/* ============================================================
   RENDER — append-only, tidak pernah render ulang semua pesan
   ============================================================ */

function messageNode(role, content, isError) {
  const msg = document.createElement('div');
  msg.className = 'msg ' + (role === 'user' ? 'user' : 'ai') + (isError ? ' error' : '');

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'user' ? 'Kamu' : 'Aomi';

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = content;

  msg.append(who, body);
  return msg;
}

function appendMessage(role, content, isError = false) {
  const wasNearBottom = nearBottom;
  els.welcome.hidden = true;
  els.column.appendChild(messageNode(role, content, isError));

  const nodes = els.column.querySelectorAll(':scope > .msg');
  if (nodes.length > DOM_CAP) {
    nodes[0].remove();
    firstHidden++;
    updateEarlierButton();
  }
  if (wasNearBottom) scrollToBottom(false);
}

function resetView() {
  els.column.querySelectorAll('.msg').forEach((n) => n.remove());
  loaded = [];
  firstHidden = 0;
  currentId = null;
  els.earlierWrap.hidden = true;
  els.welcome.hidden = false;
  els.title.textContent = 'Chat baru';
  emit('chat:activated', { id: null });
}

async function loadConversation(id) {
  try {
    const data = await apiJson('/api/conversations?id=' + encodeURIComponent(id));
    const conv = data.conversation;
    currentId = conv.conversation_id;
    loaded = conv.messages || [];
    els.title.textContent = conv.title || 'Chat baru';

    els.column.querySelectorAll('.msg').forEach((n) => n.remove());
    firstHidden = Math.max(0, loaded.length - RENDER_BATCH);

    const fragment = document.createDocumentFragment();
    for (const m of loaded.slice(firstHidden)) {
      fragment.appendChild(messageNode(m.role, m.content));
    }
    els.column.appendChild(fragment);
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

  const anchor = els.column.querySelector('.msg') || null;
  const fragment = document.createDocumentFragment();
  for (const m of slice) {
    fragment.appendChild(messageNode(m.role, m.content));
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
   SCROLL
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

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', raf(() => {
      if (nearBottom) scrollToBottom(false);
    }));
  }
}

/* ============================================================
   KOMPOSER
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

  // Indikator mengetik
  const typing = messageNode('assistant', '');
  typing.classList.add('typing');
  typing.querySelector('.body').innerHTML =
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
      els.title.textContent = data.title || els.title.textContent;
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
