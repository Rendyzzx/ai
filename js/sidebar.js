/* ============================================================
   Aomi — sidebar.js
   Riwayat chat: render lazy (batch + IntersectionObserver),
   pencarian debounce, hapus chat, dan drawer di mobile.
   Semua interaksi lewat event delegation (satu listener list).
   ============================================================ */

import { $, debounce, Store, emit, on } from './app.js';

const BATCH = 12;              // item per batch render
const els = {};

let items = [];                 // hasil filter saat ini
let rendered = 0;               // jumlah item yang sudah ada di DOM
let query = '';

export function initSidebar() {
  els.sidebar = $('#sidebar');
  els.backdrop = $('#backdrop');
  els.history = $('#history');
  els.input = $('#searchInput');

  bindEvents();
  on('chat:updated', refresh);
  on('chat:activated', ({ id }) => setActive(id));
  on('chat:deleted', ({ id }) => handleDeleted(id));
  refresh();
}

function bindEvents() {
  $('#newChatBtn').addEventListener('click', () => {
    closeDrawer();
    emit('chat:open', { id: null });
  });

  // Event delegation: satu listener untuk seluruh item riwayat
  els.history.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      deleteChat(del.dataset.del, del.closest('.h-item'));
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
    refresh();
  }, 150));

  // Drawer (mobile)
  $('#sidebarToggle').addEventListener('click', openDrawer);
  $('#sidebarClose').addEventListener('click', closeDrawer);
  els.backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // Lazy loading: render batch berikutnya saat sentinel terlihat
  const sentinel = document.createElement('div');
  sentinel.dataset.sentinel = '';
  els.history.appendChild(sentinel);
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) renderBatch();
  }, { root: els.history, rootMargin: '200px' }).observe(sentinel);
}

/* ---------------- Render ---------------- */

function refresh() {
  const all = Store.readIndex();
  items = !query
    ? all
    : all.filter((c) =>
        c.title.toLowerCase().includes(query) ||
        (c.snippet || '').toLowerCase().includes(query));

  rendered = 0;
  els.history.textContent = '';

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'h-empty';
    empty.textContent = query ? 'Tidak ada hasil.' : 'Belum ada percakapan.';
    els.history.appendChild(empty);
    return;
  }
  renderBatch();
}

function renderBatch() {
  const fragment = document.createDocumentFragment();
  const slice = items.slice(rendered, rendered + BATCH);
  if (slice.length === 0) return;

  for (const chat of slice) {
    fragment.appendChild(buildItem(chat));
  }
  rendered += slice.length;
  // sisipkan sebelum sentinel agar urutan tetap
  els.history.insertBefore(
    fragment,
    els.history.querySelector('[data-sentinel]') || null
  );
}

function buildItem(chat) {
  const item = document.createElement('div');
  item.className = 'h-item';
  item.dataset.open = chat.id;
  item.setAttribute('role', 'button');
  item.tabIndex = 0;

  const title = document.createElement('span');
  title.className = 'h-title';
  title.textContent = chat.title;          // textContent = aman XSS
  item.appendChild(title);

  const time = document.createElement('span');
  time.className = 'h-time';
  time.textContent = formatTime(chat.updatedAt);
  item.appendChild(time);

  const del = document.createElement('button');
  del.className = 'h-del';
  del.dataset.del = chat.id;
  del.setAttribute('aria-label', 'Hapus percakapan');
  del.innerHTML = '<svg class="icon" aria-hidden="true"><use href="components/icons.svg#trash" /></svg>';
  item.appendChild(del);

  // Aksesibilitas keyboard: Enter/Space membuka chat
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      emit('chat:open', { id: chat.id });
    }
  });

  return item;
}

function setActive(id) {
  for (const el of els.history.querySelectorAll('.h-item.active')) {
    el.classList.remove('active');
  }
  const current = els.history.querySelector(`[data-open="${id}"]`);
  if (current) current.classList.add('active');
}

function formatTime(ts) {
  const diff = Date.now() - ts;
  const day = 86400000;
  if (diff < day) return 'Hari ini';
  if (diff < 7 * day) {
    return Math.ceil(diff / day) + ' hr';
  }
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

/* ---------------- Aksi ---------------- */

function deleteChat(id, itemEl) {
  const title = itemEl?.querySelector('.h-title')?.textContent || 'percakapan ini';
  if (!window.confirm(`Hapus "${title}"?`)) return;
  Store.deleteChat(id);
  items = items.filter((c) => c.id !== id);
  rendered = Math.max(0, rendered - 1);
  itemEl?.remove();
  emit('chat:deleted', { id });
}

function handleDeleted(id) {
  // Jika chat yang terbuka dihapus, modul chat yang reaksi via event.
  setActive(null);
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
