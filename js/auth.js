/* ============================================================
   Aomi — auth.js
   Halaman Masuk/Daftar: verifikasi angka, toggle password, state
   tombol, pesan error ramah. Setelah login: session id OPAQUE
   (bukan credential) disimpan di sessionStorage — tanpa cookie,
   tanpa data sensitif di browser. Server selalu memvalidasi.
   ============================================================ */

const $ = (sel) => document.querySelector(sel);

const SID_KEY = 'aomi.sid';

function getSessionId() {
  try { return sessionStorage.getItem(SID_KEY); } catch { return null; }
}

function setSessionId(sid) {
  try { sessionStorage.setItem(SID_KEY, sid); } catch { /* private */ }
}

function clearSid() {
  try { sessionStorage.removeItem(SID_KEY); } catch { /* private */ }
}

const captcha = { login: {}, register: {} };

// ---------------- Session valid di tab ini → langsung buka chat ----------------
// Redirect GUARDED: maksimal satu navigasi keluar dari halaman ini,
// tidak peduli berapa banyak trigger (precheck, login, dsb.).

let isRedirecting = false;
function goToApp() {
  if (isRedirecting) return;
  isRedirecting = true;
  location.replace('/');
}

(async () => {
  const sid = getSessionId();
  if (!sid) return; // tanpa sid: halaman login TIDAK pernah redirect — tidak ada bounce
  try {
    const res = await fetch('/api/auth/me', { headers: { 'X-Session-Id': sid } });
    if (res.status === 401) {
      clearSid(); // session memang invalid → tetap di login
    } else if (res.ok) {
      goToApp();  // session valid → satu kali ke chat
    }
    // status lain (500/429/offline): error sesaat — JANGAN buang sid
    // yang masih valid; tampilkan form login saja.
  } catch { /* offline: tampilkan halaman login */ }
})();

// ---------------- Tab Masuk / Daftar ----------------

const panels = { login: $('#formLogin'), register: $('#formRegister') };

function showPanel(name) {
  for (const btn of document.querySelectorAll('.auth-tab')) {
    const active = btn.dataset.panel === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active);
  }
  panels.login.hidden = name !== 'login';
  panels.register.hidden = name !== 'register';
  $('#authHeading').textContent = name === 'login'
    ? 'Selamat datang kembali'
    : 'Buat akun baru';
  $('#authSubtitle').textContent = name === 'login'
    ? 'Masuk untuk melanjutkan percakapanmu.'
    : 'Daftar untuk mulai mengobrol dengan Aomi.';
}

document.querySelector('.auth-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.auth-tab');
  if (tab) showPanel(tab.dataset.panel);
});

// ---------------- Toggle show/hide password ----------------

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.pw-toggle');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.target);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Tampilkan password');
  btn.querySelector('use').setAttribute(
    'href', 'components/icons.svg#' + (show ? 'eye-off' : 'eye')
  );
});

// ---------------- Verifikasi angka acak ----------------

async function loadCaptcha(which) {
  const numEl = which === 'login' ? $('#capNumLogin') : $('#capNumRegister');
  const ansEl = which === 'login' ? $('#capAnsLogin') : $('#capAnsRegister');
  try {
    const res = await fetch('/api/auth/captcha');
    const data = await res.json();
    captcha[which] = data;
    numEl.textContent = data.number;
    ansEl.value = '';
  } catch {
    numEl.textContent = '····';
  }
}

document.querySelectorAll('.verify-refresh').forEach((btn) => {
  btn.addEventListener('click', () => loadCaptcha(btn.dataset.which));
});

loadCaptcha('login');
loadCaptcha('register');

// ---------------- State tombol & error ----------------

function setBtn(btn, text, disabled) {
  btn.textContent = text;
  btn.disabled = disabled;
}

function showError(kind, message) {
  (kind === 'login' ? $('#errLogin') : $('#errRegister')).textContent = message;
  (kind === 'login' ? $('#errLogin') : $('#errRegister')).hidden = false;
}

function hideError(kind) {
  (kind === 'login' ? $('#errLogin') : $('#errRegister')).hidden = true;
}

/** Pesan error ramah — tidak pernah menampilkan detail teknis. */
function friendlyError(status, data) {
  if (status === 400) return data?.error?.includes('verifikasi')
    ? data.error : 'Data belum lengkap atau tidak valid.';
  if (status === 401) return 'Email/username atau password salah.';
  if (status === 409) return data?.error || 'Email atau username sudah dipakai.';
  if (status === 429) return data?.error || 'Terlalu banyak percobaan. Tunggu sebentar.';
  return 'Tidak dapat masuk sekarang. Coba lagi sebentar.';
}

// ---------------- Submit ----------------

async function submitAuth(kind, url, body) {
  const btn = kind === 'login' ? $('#loginSubmit') : $('#registerSubmit');
  hideError(kind);
  setBtn(btn, kind === 'login' ? 'Memproses…' : 'Membuat akun…', true);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.session_id) {
      setBtn(btn, kind === 'login' ? 'Berhasil masuk' : 'Akun dibuat', true);
      // Simpan HANYA session id opaque — bukan password/token/API key.
      // sessionStorage mati saat tab ditutup: tidak ada auth persisten.
      setSessionId(data.session_id);
      goToApp(); // SATU kali navigasi ke chat (guarded, tanpa reload loop)
      return;
    }

    setBtn(btn, 'Coba lagi', false);
    showError(kind, friendlyError(res.status, data));
    loadCaptcha(kind);
  } catch {
    setBtn(btn, kind === 'login' ? 'Masuk' : 'Buat akun', false);
    showError(kind, 'Tidak dapat terhubung ke server. Periksa koneksimu.');
    loadCaptcha(kind);
  }
}

$('#formLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await submitAuth('login', '/api/auth/login', {
    identifier: f.identifier.value.trim(),
    password: f.password.value,
    remember: f.remember.checked,
    captchaToken: captcha.login.token,
    captchaAnswer: $('#capAnsLogin').value.trim()
  });
});

$('#formRegister').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  hideError('register');

  // Validasi frontend untuk UX (backend tetap memvalidasi ulang)
  if (f.password.value !== $('#regPw2').value) {
    showError('register', 'Konfirmasi password tidak sama.');
    return;
  }
  if (f.password.value.length < 8) {
    showError('register', 'Password minimal 8 karakter.');
    return;
  }

  await submitAuth('register', '/api/auth/register', {
    username: f.username.value.trim(),
    email: f.email.value.trim(),
    password: f.password.value,
    captchaToken: captcha.register.token,
    captchaAnswer: $('#capAnsRegister').value.trim()
  });
});
