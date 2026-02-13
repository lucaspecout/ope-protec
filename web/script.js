const STORAGE_KEYS = {
  token: 'token',
  users: 'vo_users',
  logs: 'vo_logs',
  municipalities: 'vo_municipalities',
  vigilance: 'vo_vigilance',
};

let token = localStorage.getItem(STORAGE_KEYS.token);

const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const passwordForm = document.getElementById('password-form');
const loginError = document.getElementById('login-error');
const passwordError = document.getElementById('password-error');

function seedData() {
  if (!localStorage.getItem(STORAGE_KEYS.users)) {
    localStorage.setItem(STORAGE_KEYS.users, JSON.stringify([
      { username: 'admin', password: 'admin', mustChangePassword: true },
    ]));
  }

  if (!localStorage.getItem(STORAGE_KEYS.logs)) {
    localStorage.setItem(STORAGE_KEYS.logs, JSON.stringify([]));
  }

  if (!localStorage.getItem(STORAGE_KEYS.municipalities)) {
    localStorage.setItem(STORAGE_KEYS.municipalities, JSON.stringify([]));
  }

  if (!localStorage.getItem(STORAGE_KEYS.vigilance)) {
    localStorage.setItem(STORAGE_KEYS.vigilance, JSON.stringify({
      vigilance: 'Vert',
      crues: 'Normal',
      global_risk: 'green',
    }));
  }
}

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function currentUser() {
  if (!token) return null;
  const users = readJson(STORAGE_KEYS.users, []);
  return users.find((u) => u.username === token) || null;
}

function setVisibility(element, isVisible) {
  element.classList.toggle('hidden', !isVisible);
  element.hidden = !isVisible;
}

function showApp() {
  setVisibility(loginView, false);
  setVisibility(appView, true);
}

function showLogin() {
  setVisibility(appView, false);
  setVisibility(loginView, true);
  setVisibility(passwordForm, false);
  setVisibility(loginForm, true);
}

function loadDashboard() {
  const logs = readJson(STORAGE_KEYS.logs, []);
  const municipalities = readJson(STORAGE_KEYS.municipalities, []);
  const vigilance = readJson(STORAGE_KEYS.vigilance, {
    vigilance: 'Vert',
    crues: 'Normal',
    global_risk: 'green',
  });

  document.getElementById('vigilance').textContent = vigilance.vigilance;
  document.getElementById('crues').textContent = vigilance.crues;
  const risk = document.getElementById('risk');
  risk.textContent = vigilance.global_risk;
  risk.className = vigilance.global_risk;
  document.getElementById('crisis').textContent = municipalities.filter((m) => m.crisis_mode).length;
  document.getElementById('logs').innerHTML = logs
    .slice(-10)
    .reverse()
    .map((l) => `<li>${new Date(l.created_at).toLocaleString()} - ${l.event_type}</li>`)
    .join('');
}

function loadMunicipalities() {
  const municipalities = readJson(STORAGE_KEYS.municipalities, []);
  const list = document.getElementById('municipalities-list');
  list.innerHTML = municipalities.map((m) => `
    <li>
      <strong>${m.name}</strong> — ${m.manager} (${m.phone})
      <button data-id="${m.id}" class="crisis-toggle">${m.crisis_mode ? 'Retirer crise' : 'Mode crise'}</button>
    </li>
  `).join('');

  document.querySelectorAll('.crisis-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const items = readJson(STORAGE_KEYS.municipalities, []);
      const next = items.map((m) => (
        m.id === Number(button.dataset.id) ? { ...m, crisis_mode: !m.crisis_mode } : m
      ));
      writeJson(STORAGE_KEYS.municipalities, next);
      loadMunicipalities();
      loadDashboard();
    });
  });
}

function login(username, password) {
  const users = readJson(STORAGE_KEYS.users, []);
  const user = users.find((u) => u.username === username && u.password === password);

  if (!user) {
    loginError.textContent = 'Identifiants invalides.';
    return;
  }

  loginError.textContent = '';
  token = user.username;
  localStorage.setItem(STORAGE_KEYS.token, token);

  if (user.mustChangePassword) {
    setVisibility(loginForm, false);
    setVisibility(passwordForm, true);
    return;
  }

  showApp();
  loadDashboard();
  loadMunicipalities();
}

function updatePassword(currentPassword, newPassword) {
  const user = currentUser();
  const users = readJson(STORAGE_KEYS.users, []);

  if (!user || user.password !== currentPassword) {
    passwordError.textContent = 'Mot de passe actuel incorrect.';
    return;
  }

  const nextUsers = users.map((u) => (
    u.username === user.username
      ? { ...u, password: newPassword, mustChangePassword: false }
      : u
  ));

  writeJson(STORAGE_KEYS.users, nextUsers);
  passwordError.textContent = '';
  showApp();
  loadDashboard();
  loadMunicipalities();
}

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  login(formData.get('username'), formData.get('password'));
});

passwordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(passwordForm);
  updatePassword(formData.get('current_password'), formData.get('new_password'));
});

document.getElementById('municipality-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const items = readJson(STORAGE_KEYS.municipalities, []);
  items.push({
    id: Date.now(),
    name: formData.get('name'),
    phone: formData.get('phone'),
    email: formData.get('email'),
    manager: formData.get('manager'),
    crisis_mode: false,
  });
  writeJson(STORAGE_KEYS.municipalities, items);
  event.target.reset();
  loadMunicipalities();
  loadDashboard();
});

document.getElementById('log-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const logs = readJson(STORAGE_KEYS.logs, []);
  logs.push({
    id: Date.now(),
    event_type: formData.get('event_type'),
    description: formData.get('description'),
    created_at: new Date().toISOString(),
  });
  writeJson(STORAGE_KEYS.logs, logs);
  event.target.reset();
  loadDashboard();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEYS.token);
  token = null;
  showLogin();
});

document.querySelectorAll('.menu-btn').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.menu-btn').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');

    document.querySelectorAll('.panel').forEach((panel) => setVisibility(panel, false));
    setVisibility(document.getElementById(button.dataset.target), true);
  });
});

seedData();
if (token) {
  const user = currentUser();
  if (user && !user.mustChangePassword) {
    showApp();
    loadDashboard();
    loadMunicipalities();
  } else {
    showLogin();
  }
} else {
  showLogin();
}
