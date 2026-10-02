/* ============================================================
   Aomi — settings.js
   Settings view (SPA overlay): navigasi kategori, preview
   karakter, sifat/memori/advanced, save parsial (hanya field
   berubah), cache state, tanpa reload aplikasi.

   Dimuat lazy: di-import dynamic saat settings pertama dibuka.
   Semua listener dibind SEKALI (flag `bound`), tanpa leak.
   ============================================================ */

import { $, renderAvatar, api, apiJson, state, emit, clearSessionId, resetClientState } from './app.js?v=9f91c9d375';

const els = {};
let bound = false;
let pendingAvatar = { user: null, bot: null };
let dirty = { profile: false, identity: false, personality: false, behavior: false, memory: false, advanced: false };
let closing = false;

// Contoh kalimat preview per gaya bicara — suara karakter, bukan asisten
const PREVIEW_LINES = {
  casual: '"hey, akhirnya ada yang ngobrol juga."',
  short: '"hm?"',
  expressive: '"KAMU GILAA- eh, maksudku... hi!"',
  dry: '"oh. kamu lagi."',
  playful: '"tebak deh aku mikirin apa."',
  detailed: '"tumben. nggak nyangka kamu buka chat aku hari ini. ada cerita?"'
};

// Draft memori lokal (disinkronkan saat form diisi / tersimpan)
let memDraft = [];

/* ---------------- Buka / tutup view ---------------- */

export function openSettings(category) {
  if (!bound) {
    cacheEls();
    bindOnce();
    bound = true;
  }
  fillAll();
  showCategory(category || state._lastCat || 'profile', { silent: true });
  els.view.hidden = false;
  requestAnimationFrame(() => els.view.classList.add('open'));
  closing = false;
}

function closeSettings() {
  if (closing) return;
  closing = true;
  els.view.classList.remove('open');
  const done = () => {
    els.view.hidden = true;
    els.view.classList.remove('open');
    closing = false;
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    done();
  } else {
    setTimeout(done, 150);
  }
}

function cacheEls() {
  els.view = $('#settingsView');
  els.shell = $('#settingsShell');
  els.navList = $('#settingsNavList');
}

/* ---------------- Binding (sekali saja) ---------------- */

function bindOnce() {
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#settingsBack').addEventListener('click', () => {
    els.shell.classList.remove('page-open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.view.hidden) closeSettings();
  });

  // Navigasi kategori (delegasi)
  els.navList.addEventListener('click', (e) => {
    const item = e.target.closest('.settings-nav-item');
    if (item) showCategory(item.dataset.cat);
  });

  // Sub-navigasi bot
  $('#botSubnav').addEventListener('click', (e) => {
    const item = e.target.closest('.subnav-item');
    if (item) showBotPage(item.dataset.botpage);
  });

  // Avatar: pilih file → kompres → preview (belum simpan)
  $('#profileAvatarBtn').addEventListener('click', () => $('#profileAvatarFile').click());
  $('#botAvatarBtn').addEventListener('click', () => $('#botAvatarFile').click());
  $('#profileAvatarFile').addEventListener('change', (e) => onAvatarPick(e, 'user'));
  $('#botAvatarFile').addEventListener('change', (e) => onAvatarPick(e, 'bot'));

  // Profil
  for (const id of ['profileUsername', 'profileDisplay', 'profileBio']) {
    $('#' + id).addEventListener('input', () => markDirty('profile'));
  }
  $('#profileSave').addEventListener('click', saveProfile);

  // Identitas bot
  for (const id of ['botName', 'botDescription']) {
    $('#' + id).addEventListener('input', () => {
      markDirty('identity');
      updatePreview();
    });
  }
  $('#identitySave').addEventListener('click', saveIdentity);

  // Identitas: sapaan pertama
  $('#botGreeting').addEventListener('input', () => markDirty('identity'));

  // Personality karakter
  $('#botPersonality').addEventListener('input', () => {
    markDirty('personality');
    $('#personalityCounter').textContent = $('#botPersonality').value.length + '/3000';
  });
  $('#traitGrid').addEventListener('click', (e) => {
    const chip = e.target.closest('.trait-chip');
    if (!chip) return;
    chip.classList.toggle('active');
    markDirty('personality');
    updatePreview();
  });
  $('#personalitySave').addEventListener('click', savePersonality);

  // Perilaku
  $('#botLikes').addEventListener('input', () => markDirty('behavior'));
  $('#botAvoids').addEventListener('input', () => markDirty('behavior'));
  $('#behaviorSave').addEventListener('click', saveBehavior);

  // Memory — hal-hal yang dia ingat tentang user
  $('#memoryAdd').addEventListener('click', addMemory);
  $('#memoryInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addMemory(); }
  });
  $('#memoryList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-memdel]');
    if (del) removeMemory(Number(del.dataset.memdel));
  });
  $('#memorySave').addEventListener('click', saveMemory);

  // Advanced (teknis)
  $('#botPrompt').addEventListener('input', () => {
    markDirty('advanced');
    $('#promptCounter').textContent = $('#botPrompt').value.length + '/1000';
  });
  $('#advancedSave').addEventListener('click', saveAdvanced);

  // Perilaku/Personality/Advanced (segmented) — section dirty sesuai field
  const SEG_SECTION = {
    relationship: 'personality', speaking_style: 'personality',
    response_length: 'behavior',
    response_style: 'advanced', language: 'advanced'
  };
  for (const seg of document.querySelectorAll('.settings-page .seg[data-field]')) {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      for (const b of seg.querySelectorAll('.seg-btn')) {
        b.classList.toggle('active', b === btn);
      }
      markDirty(SEG_SECTION[seg.dataset.field] || 'behavior');
      updatePreview();
    });
  }

  // Tampilan (instan, client-only)
  $('#segFont').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    for (const b of $('#segFont').querySelectorAll('.seg-btn')) {
      b.classList.toggle('active', b === btn);
    }
    document.documentElement.style.setProperty('--chat-fs', btn.dataset.val + 'px');
    try { localStorage.setItem('aomi.fontSize', btn.dataset.val); } catch { /* private mode */ }
  });

  // Akun: logout = hapus session server + bersihkan SELURUH state klien
  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* lanjut teardown lokal */ }
    clearSessionId();
    resetClientState();
    location.replace('/auth.html');
  });
}

/* ---------------- Navigasi kategori ---------------- */

function showCategory(cat, { silent } = {}) {
  state._lastCat = cat;
  for (const item of els.navList.querySelectorAll('.settings-nav-item')) {
    item.classList.toggle('active', item.dataset.cat === cat);
  }
  for (const page of document.querySelectorAll('.settings-page')) {
    page.classList.toggle('active', page.dataset.page === cat);
  }
  if (!silent) els.shell.classList.add('page-open'); // mobile: buka halaman
}

function showBotPage(name) {
  for (const item of document.querySelectorAll('#botSubnav .subnav-item')) {
    item.classList.toggle('active', item.dataset.botpage === name);
  }
  for (const page of document.querySelectorAll('.bot-page')) {
    page.classList.toggle('active', page.dataset.botpage === name);
  }
}

/* ---------------- Isi form dari cache (tanpa fetch ulang) ---------------- */

function fillAll() {
  // Profil
  $('#profileUsername').value = state.user.username;
  $('#profileDisplay').value = state.user.display_name;
  $('#profileBio').value = state.user.bio;
  renderAvatar($('#profileAvatarPrev'), state.user.avatar, 'user');

  // Identitas karakter
  $('#botName').value = state.bot.bot_name;
  $('#botDescription').value = state.bot.bot_description || '';
  $('#botGreeting').value = state.bot.greeting || '';
  renderAvatar($('#botAvatarPrev'), state.bot.bot_avatar, 'logo');

  // Personality karakter
  $('#botPersonality').value = state.bot.personality || '';
  $('#personalityCounter').textContent = (state.bot.personality || '').length + '/3000';
  const traits = Array.isArray(state.bot.traits) ? state.bot.traits : [];
  for (const chip of document.querySelectorAll('#traitGrid .trait-chip')) {
    chip.classList.toggle('active', traits.includes(chip.dataset.trait));
  }
  setSeg('#segRelationship', state.bot.relationship || 'companion');
  setSeg('#segSpeaking', state.bot.speaking_style || 'casual');

  // Perilaku
  $('#botLikes').value = state.bot.likes || '';
  $('#botAvoids').value = state.bot.avoids || '';
  setSeg('#segLength', state.bot.response_length || 'balanced');

  // Memory
  memDraft = Array.isArray(state.bot.memories) ? [...state.bot.memories] : [];
  renderMemories();

  // Advanced
  $('#botPrompt').value = state.bot.system_prompt || '';
  $('#promptCounter').textContent = (state.bot.system_prompt || '').length + '/1000';
  setSeg('#segTone', state.bot.response_style || 'casual');
  setSeg('#segLanguage', state.bot.language || 'auto');

  // Akun
  $('#accountEmail').textContent = state.user.email || '…';
  $('#accountUsername').textContent = state.user.username;

  // Tampilan
  const size = (() => {
    try { return localStorage.getItem('aomi.fontSize') || '15'; } catch { return '15'; }
  })();
  setSeg('#segFont', size);

  pendingAvatar = { user: null, bot: null };
  dirty = { profile: false, identity: false, personality: false, behavior: false, memory: false, advanced: false };
  for (const sec of ['profile', 'identity', 'personality', 'behavior', 'memory', 'advanced']) {
    setSaveBtn(sec, 'idle');
    setStatus(sec, '');
  }
  updatePreview();
}

function setSeg(sel, val) {
  for (const b of document.querySelectorAll(sel + ' .seg-btn')) {
    b.classList.toggle('active', b.dataset.val === val);
  }
}

/* ---------------- State tombol Save ---------------- */
/* Normal: "Simpan perubahan" → Saving: "Menyimpan…" (disabled + dot halus)
   Sukses: "Tersimpan ✓" → 1.6 dtk kembali ke normal.
   Gagal: "Gagal menyimpan" → 1.8 dtk kembali (edit lokal tetap ada). */

const revertTimers = {};

function setSaveBtn(sec, phase) {
  const btn = $('#' + sec + 'Save');
  clearTimeout(revertTimers[sec]);
  btn.classList.remove('saving');
  switch (phase) {
    case 'saving':
      btn.textContent = 'Menyimpan…';
      btn.classList.add('saving');
      btn.disabled = true;
      break;
    case 'saved':
      btn.textContent = 'Tersimpan ✓';
      btn.disabled = true;
      revertTimers[sec] = setTimeout(() => {
        btn.textContent = 'Simpan perubahan';
      }, 1600);
      break;
    case 'failed':
      btn.textContent = 'Gagal menyimpan';
      btn.disabled = false;
      revertTimers[sec] = setTimeout(() => {
        btn.textContent = 'Simpan perubahan';
      }, 1800);
      break;
    default:
      btn.textContent = 'Simpan perubahan';
      btn.disabled = !dirty[sec];
  }
}

/* ---------------- Dirty tracking & status ---------------- */

function markDirty(sec) {
  dirty[sec] = true;
  setSaveBtn(sec, 'idle');
  setStatus(sec, 'Belum disimpan');
}

function setStatus(sec, text, cls = '') {
  const el = $('#' + sec + 'Status');
  el.className = 'save-status ' + cls;
  el.textContent = text;
}

/* ---------------- Preview realtime (tanpa API) ---------------- */

function updatePreview() {
  const name = $('#botName').value.trim() || 'Aomi';
  const desc = $('#botDescription').value.trim() || 'Companion pribadimu.';
  const style = $('#segSpeaking .seg-btn.active')?.dataset.val || 'casual';
  $('#previewName').textContent = name;
  $('#previewDesc').textContent = desc;
  renderAvatar($('#previewAvatar'), pendingAvatar.bot || state.bot.bot_avatar, 'logo');
  // contoh kalimat mengikuti gaya bicara — suara karakter, bukan asisten
  $('#previewLine').textContent = PREVIEW_LINES[style] || PREVIEW_LINES.casual;
}

/* ---------------- Avatar: pilih + kompres + preview ---------------- */

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const AVATAR_SIZE = 256;

async function onAvatarPick(e, kind) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    setStatus(kind === 'user' ? 'profile' : 'identity', 'Format harus JPG, PNG, atau WebP.', 'err');
    return;
  }
  if (file.size > MAX_INPUT_BYTES) {
    setStatus(kind === 'user' ? 'profile' : 'identity', 'File terlalu besar (maks 5 MB).', 'err');
    return;
  }

  try {
    const dataUrl = await compressToAvatar(file);
    pendingAvatar[kind] = dataUrl;
    renderAvatar(
      kind === 'user' ? $('#profileAvatarPrev') : $('#botAvatarPrev'),
      dataUrl, kind === 'user' ? 'user' : 'logo'
    );
    markDirty(kind === 'user' ? 'profile' : 'identity');
    if (kind === 'bot') updatePreview();
  } catch {
    setStatus(kind === 'user' ? 'profile' : 'identity', 'Gagal memproses gambar.', 'err');
  }
}

/** Kompres ke avatar persegi 256px (crop cover) → JPEG, object URL dilepas. */
function compressToAvatar(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode gagal')); };
    img.onload = () => {
      requestAnimationFrame(() => URL.revokeObjectURL(url)); // lepas object URL
      const canvas = document.createElement('canvas');
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const ctx = canvas.getContext('2d');
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - side) / 2;
      const sy = (img.naturalHeight - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.src = url;
  });
}

/* ---------------- Simpan (hanya field yang berubah) ---------------- */

function diff(body, reference, fields) {
  const out = {};
  let changed = false;
  for (const f of fields) {
    if (body[f] !== undefined && String(body[f] ?? '') !== String(reference[f] ?? '')) {
      out[f] = body[f];
      changed = true;
    }
  }
  return changed ? out : null;
}

async function persist(sec, endpoint, body, apply) {
  const btn = $('#' + sec + 'Save');
  if (btn.classList.contains('saving')) return; // cegah double-submit
  setSaveBtn(sec, 'saving');
  setStatus(sec, 'Menyimpan…');
  try {
    const data = await apiJson(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    apply(data);
    dirty[sec] = false;
    setSaveBtn(sec, 'saved');
    setStatus(sec, 'Tersimpan ✓', 'ok');
    emit('settings:updated');
  } catch (err) {
    if (err.message === 'unauthorized') return; // sudah dialihkan ke login
    // gagal: pertahankan edit lokal, tampilkan error jelas
    dirty[sec] = true;
    setSaveBtn(sec, 'failed');
    setStatus(sec, err.message || 'Gagal menyimpan. Perubahanmu tetap ada.', 'err');
  }
}

function saveProfile() {
  if (!dirty.profile) return;
  const body = {
    username: $('#profileUsername').value.trim(),
    display_name: $('#profileDisplay').value.trim(),
    bio: $('#profileBio').value.trim()
  };
  if (pendingAvatar.user !== null) body.avatar = pendingAvatar.user;

  const ref = { ...state.user };
  const payload = diff(body, ref, ['username', 'display_name', 'bio']);
  if (pendingAvatar.user !== null) payload.avatar = pendingAvatar.user;

  if (!payload || Object.keys(payload).length === 0) {
    setStatus('profile', 'Tidak ada perubahan.');
    return;
  }

  persist('profile', '/api/profile', payload, (data) => {
    Object.assign(state.user, data);
    pendingAvatar.user = null;
    $('#userBox').textContent = data.display_name;
    renderAvatar($('#sidebarAvatar'), data.avatar, 'user');
    $('#accountUsername').textContent = data.username;
  });
}

function saveIdentity() {
  if (!dirty.identity) return;
  const body = {
    bot_name: $('#botName').value.trim(),
    bot_description: $('#botDescription').value.trim(),
    greeting: $('#botGreeting').value.trim()
  };
  const payload = diff(body, state.bot, ['bot_name', 'bot_description', 'greeting']);
  if (pendingAvatar.bot !== null) payload.bot_avatar = pendingAvatar.bot;

  if (!payload || Object.keys(payload).length === 0) {
    setStatus('identity', 'Tidak ada perubahan.');
    return;
  }

  persist('identity', '/api/bot', payload, (data) => {
    Object.assign(state.bot, data.bot);
    pendingAvatar.bot = null;
    $('#brandName').textContent = data.bot.bot_name;
    // header chat = identitas karakter (selalu nama terbaru)
    $('#chatTitle').textContent = data.bot.bot_name;
  });
}

function savePersonality() {
  if (!dirty.personality) return;
  const body = {
    traits: [...document.querySelectorAll('#traitGrid .trait-chip.active')].map((c) => c.dataset.trait),
    speaking_style: $('#segSpeaking .seg-btn.active')?.dataset.val || 'casual',
    relationship: $('#segRelationship .seg-btn.active')?.dataset.val || 'companion',
    personality: $('#botPersonality').value.trim()
  };
  const payload = diff(body, state.bot, ['traits', 'speaking_style', 'relationship', 'personality']);
  if (!payload) {
    setStatus('personality', 'Tidak ada perubahan.');
    return;
  }
  persist('personality', '/api/bot', payload, (data) => {
    Object.assign(state.bot, data.bot);
  });
}

function saveBehavior() {
  if (!dirty.behavior) return;
  const body = {
    likes: $('#botLikes').value.trim(),
    avoids: $('#botAvoids').value.trim(),
    response_length: $('#segLength .seg-btn.active')?.dataset.val
  };
  const payload = diff(body, state.bot, ['likes', 'avoids', 'response_length']);
  if (!payload) {
    setStatus('behavior', 'Tidak ada perubahan.');
    return;
  }
  persist('behavior', '/api/bot', payload, (data) => {
    Object.assign(state.bot, data.bot);
  });
}

/* ---------------- Memory: hal yang dia ingat ---------------- */

function renderMemories() {
  const list = $('#memoryList');
  list.textContent = '';
  if (memDraft.length === 0) {
    const li = document.createElement('li');
    li.className = 'memory-empty';
    li.textContent = 'Belum ada apa-apa yang dia ingat.';
    list.appendChild(li);
    return;
  }
  memDraft.forEach((text, i) => {
    const li = document.createElement('li');
    li.className = 'memory-item';
    const span = document.createElement('span');
    span.textContent = text;
    const del = document.createElement('button');
    del.className = 'memory-del';
    del.dataset.memdel = i;
    del.setAttribute('aria-label', 'Hapus dari memori');
    del.innerHTML = '<svg class="icon" aria-hidden="true"><use href="components/icons.svg#close" /></svg>';
    li.append(span, del);
    list.appendChild(li);
  });
}

function addMemory() {
  const input = $('#memoryInput');
  const v = input.value.trim();
  if (!v) return;
  if (memDraft.length >= 12) {
    setStatus('memory', 'Maksimal 12 hal yang bisa dia ingat sekaligus.', 'err');
    return;
  }
  memDraft.push(v);
  input.value = '';
  renderMemories();
  markDirty('memory');
}

function removeMemory(i) {
  if (i < 0 || i >= memDraft.length) return;
  memDraft.splice(i, 1);
  renderMemories();
  markDirty('memory');
}

function saveMemory() {
  if (!dirty.memory) return;
  if (JSON.stringify(memDraft) === JSON.stringify(state.bot.memories || [])) {
    setStatus('memory', 'Tidak ada perubahan.');
    return;
  }
  persist('memory', '/api/bot', { memories: memDraft }, (data) => {
    Object.assign(state.bot, data.bot);
    memDraft = [...(state.bot.memories || [])];
    renderMemories();
  });
}

/* ---------------- Advanced (teknis) ---------------- */

function saveAdvanced() {
  if (!dirty.advanced) return;
  const body = {
    system_prompt: $('#botPrompt').value.trim(),
    response_style: $('#segTone .seg-btn.active')?.dataset.val || 'casual',
    language: $('#segLanguage .seg-btn.active')?.dataset.val || 'auto'
  };
  const payload = diff(body, state.bot, ['system_prompt', 'response_style', 'language']);
  if (!payload) {
    setStatus('advanced', 'Tidak ada perubahan.');
    return;
  }
  persist('advanced', '/api/bot', payload, (data) => {
    Object.assign(state.bot, data.bot);
  });
}
