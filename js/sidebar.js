/* ============================================================
   Aomi — sidebar.js
   Karakter + riwayat percakapan milik akun (via /api/conversations).
   Kartu karakter (klik → pengaturan karakter), chat baru →
   karakter menyapa duluan. Lazy render per batch +
   IntersectionObserver, pencarian debounce, hapus via API.
   ============================================================ */

import { $, debounce, api, apiJson, emit, on, state, renderAvatar, confirmDialog } from './app.js?v=b58dc0bf65';

const BATCH = 12;

const els = {};
let items = [];        // indeks percakapan dari server
let filtered = [];
let rendered = 0;
let query = '';

export function initSidebar(initialItems) {
  els.sidebar = $('#sidebar');
  els.backdrop = $('#backdrop');
  els.history = $('#history');
  els.input = $('#searchInput');
  els.charCard = $('#charCard');
  els.charAvatar = $('#charCardAvatar');
  els.charName = $('#charCardName');

  bindEvents();
  renderCharCard();
  on('chat:updated', refresh);
  on('settings:updated', renderCharCard);
  on('chat:activated', ({ id }) => setActive(id));
  refresh(initialItems);
}

// Kartu karakter di sidebar — identitas utama aplikasi
function renderCharCard() {
  els.charName.textContent = state.bot.bot_name || 'Aomi';
  renderAvatar(els.charAvatar, state.bot.bot_avatar, 'logo');
}

async function refresh(initialItems) {
  if (Array.isArray(initialItems)) {
    // Data dari boot (di-fetch paralel dengan me/profile/bot) — jangan
    // fetch ulang. Detail event 'chat:updated' bukan array → jalur fetch.
    items = initialItems;
  } else {
    try {
      const data = await apiJson('/api/conversations');
      items = data.items || [];
    } catch {
      // Error sesaat (cold start / server sibuk / jaringan) → PERTAHANKAN
      // daftar lama. Jangan kosongkan riwayat hanya karena 1 fetch gagal.
    }
  }
  applyFilter();
}

function applyFilter() {
  filtered = !query
    ? items
    : items.filter((c) => (c.title || '').toLowerCase().includes(query));

  rendered = 0;
  els.history.textContent = '';

  if (filtered.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'h-empty';
    empty.textContent = query ? 'Tidak ada hasil.' : 'Belum pernah ngobrol di sini.';
    els.history.appendChild(empty);
    // Index riwayat bisa hilang (terhapus karena error sesaat) padahal
    // file percakapannya masih ada → sediakan tombol pemulihan.
    if (!query) {
      const rec = document.createElement('button');
      rec.type = 'button';
      rec.className = 'h-recover';
      rec.textContent = 'Pulihkan riwayat';
      rec.addEventListener('click', async () => {
        if (rec.disabled) return;
        rec.disabled = true;
        rec.textContent = 'Memulihkan...';
        try {
          await api('/api/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'recover' })
          });
          await refresh();
        } catch { /* gagal → tetap tampil */ }
        rec.disabled = false;
        rec.textContent = 'Pulihkan riwayat';
      });
      els.history.appendChild(rec);
    }
    els.history.appendChild(sentinel());
    return;
  }
  renderBatch();
  ensureSentinel();
}

function bindEvents() {
  $('#newChatBtn').addEventListener('click', () => {
    closeDrawer();
    // greet: true → karakter menyapa duluan di chat baru
    emit('chat:open', { id: null, greet: true });
  });

  // Kartu karakter → buka pengaturan karakter
  els.charCard.addEventListener('click', () => {
    closeDrawer();
    emit('settings:openCharacter');
  });

  // Event delegation: satu listener untuk seluruh item
  els.history.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      deleteConversation(del.dataset.del);
      return;
    }
    const item = e.target.closest('[data-open]');
    if (item) {
      closeDrawer();
      emit('chat:open', { id: item.dataset.open });
    }
  });

  els.input.addEventListener('input', debounce(() => {
    query = els.input.value.trim().toLowerCase();
    applyFilter();
  }, 150));

  // Drawer (mobile)
  $('#sidebarToggle').addEventListener('click', openDrawer);
  $('#sidebarClose').addEventListener('click', closeDrawer);
  els.backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
}

/* ---------------- Render lazy ---------------- */

let observer = null;
let observerSentinel = null;

function ensureSentinel() {
  if (observerSentinel && els.history.contains(observerSentinel)) return;
  const node = sentinel();
  els.history.appendChild(node);
  observerSentinel = node;

  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) renderBatch();
  }, { root: els.history, rootMargin: '200px' });
  observer.observe(node);
}

function sentinel() {
  const div = document.createElement('div');
  div.dataset.sentinel = '';
  return div;
}

function renderBatch() {
  const slice = filtered.slice(rendered, rendered + BATCH);
  if (slice.length === 0) return;

  const fragment = document.createDocumentFragment();
  for (const conv of slice) {
    fragment.appendChild(buildItem(conv));
  }
  rendered += slice.length;

  const anchor = els.history.querySelector('[data-sentinel]');
  els.history.insertBefore(fragment, anchor || null);
}

function buildItem(conv) {
  const item = document.createElement('div');
  item.className = 'h-item';
  item.dataset.open = conv.conversation_id;
  item.setAttribute('role', 'button');
  item.tabIndex = 0;

  const title = document.createElement('span');
  title.className = 'h-title';
  title.textContent = conv.title || 'Chat baru';
  item.appendChild(title);

  const time = document.createElement('span');
  time.className = 'h-time';
  time.textContent = formatTime(conv.updated_at);
  item.appendChild(time);

  const del = document.createElement('button');
  del.className = 'h-del';
  del.dataset.del = conv.conversation_id;
  del.setAttribute('aria-label', 'Hapus percakapan');
  del.innerHTML = '<svg class="icon" aria-hidden="true"><use href="components/icons.svg#trash" /></svg>';
  item.appendChild(del);

  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      emit('chat:open', { id: conv.conversation_id });
    }
  });

  return item;
}

function setActive(id) {
  for (const el of els.history.querySelectorAll('.h-item.active')) {
    el.classList.remove('active');
  }
  if (id) {
    const current = els.history.querySelector(`[data-open="${id}"]`);
    if (current) current.classList.add('active');
  }
}

function formatTime(iso) {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  const day = 86400000;
  if (diff < day) return 'Hari ini';
  if (diff < 7 * day) return Math.ceil(diff / day) + ' hr';
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

/* ---------------- Aksi ---------------- */

async function deleteConversation(id) {
  const ok = await confirmDialog('Hapus percakapan ini?');
  if (!ok) return;
  try {
    await api('/api/conversations?id=' + encodeURIComponent(id), { method: 'DELETE' });
  } catch {
    /* 401 → sudah dialihkan ke login */
  }
  items = items.filter((c) => c.conversation_id !== id);
  emit('chat:deleted', { id });
  applyFilter();
}

/* ---------------- Drawer (mobile) ---------------- */

function openDrawer() {
  els.sidebar.classList.add('open');
  els.backdrop.hidden = false;
}

function closeDrawer() {
  els.sidebar.classList.remove('open');
  els.backdrop.hidden = true;
}
