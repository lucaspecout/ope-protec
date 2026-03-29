const tokenKey = "crisis38_token";

const authSection = document.getElementById("auth");
const appSection = document.getElementById("app");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const sourcesEl = document.getElementById("sources");
const citiesEl = document.getElementById("cities");
const cityForm = document.getElementById("city-form");
const metaEl = document.getElementById("meta");

function authHeaders() {
  const token = localStorage.getItem(tokenKey);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function api(path, options = {}) {
  const resp = await fetch(path, options);
  if (!resp.ok) {
    const message = await resp.text();
    throw new Error(message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function loadSituation(refresh = false) {
  const data = await api(`/situation?refresh=${refresh}`, { headers: authHeaders() });
  metaEl.textContent = `Mis à jour: ${new Date(data.generated_at).toLocaleString()} · Communes en crise: ${data.municipalities_in_crisis}`;
  sourcesEl.innerHTML = data.sources.map((s) => `<li><strong>${s.source}</strong> - ${s.status}${s.message ? ` (${s.message})` : ""}</li>`).join("");
}

async function loadCities() {
  const rows = await api("/municipalities", { headers: authHeaders() });
  citiesEl.innerHTML = rows.map((r) => `<li>${r.name}${r.insee_code ? ` (${r.insee_code})` : ""}${r.crisis_mode ? " - CRISE" : ""}</li>`).join("");
}

async function startApp() {
  authSection.classList.add("hidden");
  appSection.classList.remove("hidden");
  await Promise.all([loadSituation(false), loadCities()]);
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  try {
    const form = new FormData(loginForm);
    const payload = { username: form.get("username"), password: form.get("password") };
    const data = await api("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    localStorage.setItem(tokenKey, data.access_token);
    await startApp();
  } catch (err) {
    loginError.textContent = `Erreur de connexion: ${err.message}`;
  }
});

document.getElementById("refresh").addEventListener("click", async () => {
  await loadSituation(true);
});

document.getElementById("logout").addEventListener("click", () => {
  localStorage.removeItem(tokenKey);
  location.reload();
});

cityForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(cityForm);
  const payload = { name: form.get("name"), insee_code: form.get("insee") || null };
  await api("/municipalities", { method: "POST", headers: authHeaders(), body: JSON.stringify(payload) });
  cityForm.reset();
  await loadCities();
});

if (localStorage.getItem(tokenKey)) {
  startApp().catch(() => localStorage.removeItem(tokenKey));
}
