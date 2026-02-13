const token = localStorage.getItem('token');

async function loadDashboard() {
  if (!token) return;
  const res = await fetch('/api/dashboard', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return;
  const data = await res.json();
  document.getElementById('vigilance').textContent = data.vigilance;
  document.getElementById('crues').textContent = data.crues;
  const risk = document.getElementById('risk');
  risk.textContent = data.global_risk;
  risk.className = data.global_risk;
  document.getElementById('crisis').textContent = data.communes_crise;
  document.getElementById('logs').innerHTML = data.latest_logs.map(l => `<li>${l.created_at} - ${l.event_type}</li>`).join('');
}

loadDashboard();
