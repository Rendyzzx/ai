/* ============================================================
   Aomi — auth.js
   Halaman login & registrasi: tab, soal verifikasi manusia,
   submit ke /api/auth/*. Redirect ke app bila sudah login.
   ============================================================ */

const $ = (sel) => document.querySelector(sel);

const captchaState = { login: {}, register: {} };

// ---------- Tab ----------

const panels = {
  login: $('#formLogin'),
  register: $('#formRegister')
};

function showTab(name) {
  for (const btn of document.querySelectorAll('.auth-tab')) {
    const active = btn.dataset.panel === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active);
  }
  panels.login.hidden = name !== 'login';
  panels.register.hidden = name !== 'register';
}

document.querySelector('.auth-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.auth-tab');
  if (tab) showTab(tab.dataset.panel);
});

// ---------- Verifikasi manusia ----------

async function loadCaptcha(which) {
  const qEl = which === 'login' ? $('#captchaQLogin') : $('#captchaQRegister');
  const aEl = which === 'login' ? $('#captchaALogin') : $('#captchaARegister');
  try {
    const res = await fetch('/api/auth/captcha');
    const data = await res.json();
    captchaState[which] = data;
    qEl.textContent = data.question;
    aEl.value = '';
  } catch {
    qEl.textContent = 'Gagal memuat soal. Klik tombol segarkan.';
  }
}

$('#refreshLogin').addEventListener('click', () => loadCaptcha('login'));
$('#refreshRegister').addEventListener('click', () => loadCaptcha('register'));
loadCaptcha('login');
loadCaptcha('register');

// ---------- Submit ----------

function showError(which, message) {
  const el = which === 'login' ? $('#errLogin') : $('#errRegister');
  el.textContent = message;
  el.hidden = false;
}

async function submitAuth(kind, body) {
  const errEl = kind === 'login' ? $('#errLogin') : $('#errRegister');
  errEl.hidden = true;
  const btn = panels[kind].querySelector('.auth-submit');
  btn.disabled = true;

  try {
    const res = await fetch(kind === 'login' ? '/api/auth/login' : '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      location.replace('/');
      return true;
    }
    if (res.status === 401) {
      location.replace('/auth.html');
      return false;
    }
    showError(kind, data.error || 'Terjadi kesalahan. Coba lagi.');
    loadCaptcha(kind);
    return false;
  } catch {
    showError(kind, 'Tidak bisa menghubungi server. Cek koneksi.');
    loadCaptcha(kind);
    return false;
  } finally {
    btn.disabled = false;
  }
}

$('#formLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await submitAuth('login', {
    identifier: f.identifier.value.trim(),
    password: f.password.value,
    remember: f.remember.checked,
    captchaToken: captchaState.login.token,
    captchaAnswer: $('#captchaALogin').value
  });
});

$('#formRegister').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await submitAuth('register', {
    username: f.username.value.trim(),
    email: f.email.value.trim(),
    password: f.password.value,
    captchaToken: captchaState.register.token,
    captchaAnswer: $('#captchaARegister').value
  });
});
