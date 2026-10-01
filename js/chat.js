/* ============================================================
   Aomi — chat.js
   Logika percakapan: render pesan (append-only, tanpa re-render),
   virtualisasi DOM, kirim ke /api/chat, dan komposer.
   ============================================================ */

import { $, raf, sanitizeText, Store, emit, on } from './app.js';

const API = '/api/chat';
const INSTRUCTION =
  'Kamu adalah Aomi, asisten chat santai berbahasa Indonesia. ' +
  'Jawab singkat, jelas, dan ramah. Jangan gunakan format markdown berat.';
const RENDER_BATCH = 30;   // pesan per batch render
const DOM_CAP = 150;       // node pesan maksimum di DOM (virtualisasi)
const CONTEXT_SEND = 8;    // pesan terakhir yang dikirim ke API
const TIMEOUT_MS = 30000;

const els = {};
let chat = null;           // { id, geminiSessionId, messages: [{role, content, ts}] }
let loading = false;
let firstHidden = 0;       // pesan lama yang belum dirender (untuk "muat sebelumnya")
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

  on('chat:open', ({ id }) => loadChat(id));
  on('chat:deleted', ({ id }) => {
    if (chat && chat.id === id) {
      chat = null;
      Store.writeCurrentId(null);
      renderEmptyState();
    }
  });

  // Lanjutkan chat terakhir (restore) — hanya indeksnya yang dibaca dulu
  const lastId = Store.readCurrentId();
  if (lastId && Store.readChat(lastId)) loadChat(lastId);
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
  body.textContent = content;            // textContent: aman & murah

  msg.append(who, body);
  return msg;
}

function appendMessage(role, content, isError = false) {
  const wasNearBottom = nearBottom;
  els.welcome.hidden = true;
  els.column.appendChild(messageNode(role, content, isError));

  // Virtualisasi: buang node terlama jika DOM terlalu penuh
  const nodes = els.column.querySelectorAll(':scope > .msg');
  if (nodes.length > DOM_CAP) {
    nodes[0].remove();
    firstHidden++;
    updateEarlierButton();
  }
  if (wasNearBottom) scrollToBottom(false);
}

function renderEmptyState() {
  els.column.querySelectorAll('.msg').forEach((n) => n.remove());
  firstHidden = 0;
  els.earlierWrap.hidden = true;
  els.welcome.hidden = false;
  els.title.textContent = 'Chat baru';
}

function renderChat() {
  els.column.querySelectorAll('.msg').forEach((n) => n.remove());
  firstHidden = Math.max(0, chat.messages.length - RENDER_BATCH);

  const fragment = document.createDocumentFragment();
  for (const m of chat.messages.slice(firstHidden)) {
    fragment.appendChild(messageNode(m.role, m.content));
  }
  els.column.appendChild(fragment);
  els.welcome.hidden = chat.messages.length > 0;
  updateEarlierButton();
  scrollToBottom(true);
}

function updateEarlierButton() {
  els.earlierWrap.hidden = firstHidden === 0;
}

function prependBatch() {
  if (firstHidden === 0) return;
  const start = Math.max(0, firstHidden - RENDER_BATCH);
  const slice = chat.messages.slice(start, firstHidden);
  firstHidden = start;

  const anchor = els.column.querySelector('.msg') || null;
  const fragment = document.createDocumentFragment();
  for (const m of slice) {
    fragment.appendChild(messageNode(m.role, m.content));
  }
  // Pertahankan posisi baca setelah prepend
  const prevHeight = els.scroll.scrollHeight;
  els.column.insertBefore(fragment, anchor);
  els.scroll.scrollTop += els.scroll.scrollHeight - prevHeight;
  updateEarlierButton();
}

/* ============================================================
   SCROLL — listener pasif + rAF, tanpa jank
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
    els.scrollDown.hidden = nearBottom || !chat || chat.messages.length === 0;
  }), { passive: true });

  els.scrollDown.addEventListener('click', () => scrollToBottom(true));
  els.earlierWrap.addEventListener('click', (e) => {
    if (e.target.id === 'loadEarlierBtn') prependBatch();
  });

  // Keyboard Android: pastikan input tetap terlihat saat viewport menyusut
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

  els.input.addEventListener('input', () => {
    resize();
  });

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
   STATE CHAT
   ============================================================ */

function newChat() {
  chat = {
    id: (crypto.randomUUID && crypto.randomUUID()) ||
         Date.now().toString(36) + Math.random().toString(36).slice(2),
    geminiSessionId: null,
    messages: []
  };
  firstHidden = 0;
}

function loadChat(id) {
  const data = id ? Store.readChat(id) : null;
  if (data) {
    chat = data;
    els.title.textContent = titleFor(chat);
    Store.writeCurrentId(chat.id);
    renderChat();
    emit('chat:activated', { id: chat.id });
  } else {
    newChat();
    Store.writeCurrentId(null);
    renderEmptyState();
    emit('chat:activated', { id: null });
  }
  scrollToBottom(false);
}

function titleFor(c) {
  const first = c.messages.find((m) => m.role === 'user');
  return first ? sanitizeText(first.content, 48) : 'Chat baru';
}

function persist() {
  if (!chat) return;
  Store.writeChat(chat);
  Store.upsertIndexEntry({
    id: chat.id,
    title: titleFor(chat),
    snippet: chat.messages[chat.messages.length - 1]?.content?.slice(0, 80) || '',
    updatedAt: Date.now(),
    count: chat.messages.length
  });
  Store.writeCurrentId(chat.id);
  els.title.textContent = titleFor(chat);
  emit('chat:updated');
}

/* ============================================================
   KIRIM PESAN
   ============================================================ */

async function submit() {
  const text = sanitizeText(els.input.value, 4000);
  if (!text || loading) return;

  if (!chat) newChat();

  // 1) render optimistik + simpan
  chat.messages.push({ role: 'user', content: text, ts: Date.now() });
  appendMessage('user', text);
  persist();

  els.input.value = '';
  els.input.style.height = 'auto';
  els.input.focus();

  // 2) indikator mengetik
  loading = true;
  els.sendBtn.disabled = true;
  const typing = messageNode('assistant', '');
  typing.classList.add('typing');
  typing.querySelector('.body').innerHTML =
    '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  els.column.appendChild(typing);
  scrollToBottom(true);

  // 3) panggil proxy server
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let reply = null;
  let provider = null;

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        prompt: INSTRUCTION,
        temperature: 0.5,
        sessionId: chat.geminiSessionId,
        // hanya N pesan terakhir → request tetap kecil
        messages: chat.messages.slice(-CONTEXT_SEND)
          .map((m) => ({ role: m.role, content: m.content }))
      })
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.text) {
      throw new Error(data?.error || `Gagal (HTTP ${res.status})`);
    }
    reply = data.text;
    provider = data.provider;
    if (data.sessionId) chat.geminiSessionId = data.sessionId;
  } catch (err) {
    reply = err.name === 'AbortError'
      ? 'Waktu tunggu habis. Coba kirim ulang ya.'
      : 'Maaf, ada kendala di server. Coba lagi sebentar.';
  } finally {
    clearTimeout(timer);
  }

  // 4) selesai
  typing.remove();
  loading = false;
  els.sendBtn.disabled = els.input.value.trim() === '';

  if (reply) {
    chat.messages.push({ role: 'assistant', content: reply, ts: Date.now() });
    const isError = provider === null;
    appendMessage('assistant', reply, isError);
    persist();
  }
}
