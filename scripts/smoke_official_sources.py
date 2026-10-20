"""Run the real frontend against a local fixture API in a headless browser.

No production endpoint or external website is contacted. Fixtures are confined
to this test server; application JavaScript and HTML are served unchanged.
"""
import argparse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import subprocess
import tempfile
from threading import Thread
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
NOW = datetime.now(timezone.utc)
STAMP = NOW.isoformat().replace("+00:00", "Z")
SOURCES = {
    "insee_population": {"status": "online", "cells_total": 133271, "data_year": 2021, "resolution_m": 200, "updated_at": STAMP},
    "meteo_observations": {"status": "online", "updated_at": STAMP, "stations": [{"id": "38185001", "name": "Station test Grenoble", "lat": 45.18, "lon": 5.72, "observed_at": STAMP, "temperature_c": 14.2, "rain_6m_mm": 0, "gust_kmh": 25, "stale": False}], "summary": {"fresh_stations": 1, "max_rain_6m_mm": 0, "max_gust_kmh": 25}},
    "vigicrues_forecasts": {"status": "online", "updated_at": STAMP, "stations": [{"code": "W141001001", "station": "Station test Isère", "river": "Isère", "series": [{"variable": "H", "unit": "m", "issued_at": STAMP, "points": [{"at": (NOW + timedelta(hours=n)).isoformat(), "central": 1 + n * 0.1, "lower": 0.8 + n * 0.1, "upper": 1.2 + n * 0.1} for n in range(4)]}]}]},
    "meteo_radar": {"status": "configuration_required", "frames": [], "message": "Accès Météo-France à configurer."},
    "industrial_sites": {"status": "online", "updated_at": STAMP, "sites_total": 1, "seveso_haut_total": 1, "sites": [{"id": "test-1", "nom": "Usine test officielle", "commune": "Grenoble", "lat": 45.18, "lon": 5.72, "seveso": "haut", "seveso_label": "Seveso seuil haut", "source_url": "https://www.georisques.gouv.fr/"}]},
    "enedis": {"status": "access_required", "outages": None, "data_available": False},
}
RISKS = {
    **SOURCES,
    "updated_at": STAMP,
    "meteo_france": {"status": "online", "level": "vert"},
    "vigicrues": {"status": "online", "stations": [], "troncons": [], "water_alert_level": "vert"},
    "cols_alpins_isere": {"status": "online", "cols": []},
}
USER = {"id": 1, "username": "smoke", "role": "admin", "must_change_password": False}
BOOTSTRAP = {"updated_at": STAMP, "dashboard": {"vigilance": "vert", "crues": "vert", "global_risk": "vert", "latest_logs": [], "communes_crise": 0}, "external_risks": RISKS, "municipalities": [], "logs": [], "events": [], "users": [], "perf": {"backend_duration_ms": 2}}

INIT = """<script>
localStorage.clear(); localStorage.setItem('token','fixture-only');
localStorage.setItem('activePanel','official-sources-panel');
window.__smokeErrors=[];
window.addEventListener('error', e => window.__smokeErrors.push(e.message));
window.addEventListener('unhandledrejection', e => window.__smokeErrors.push(String(e.reason)));
</script>"""
CHECKS = """<script>
(async()=>{
  const results=[];
  const check=(name,ok)=>results.push({name,pass:Boolean(ok)});
  try {
    for(let i=0;i<100;i++) {
      if(document.querySelectorAll('.official-source-card').length===6) break;
      await new Promise(r=>setTimeout(r,100));
    }
    check('six source cards',document.querySelectorAll('.official-source-card').length===6);
    check('panel navigation',!document.getElementById('official-sources-panel').hidden);
    const panel=document.getElementById('official-sources-panel');
    check('source panel fits viewport',panel.scrollWidth<=panel.clientWidth+2);
    check('observations wired',document.getElementById('official-observation-table').textContent.includes('Station test Grenoble'));
    check('forecast chart',document.querySelector('#official-forecast-chart svg'));
    check('industrial reference',document.getElementById('official-industry-table').textContent.includes('Usine test officielle'));
    check('enedis diagnostic',document.querySelector('#official-enedis-body a[href="https://www.enedis.fr/panne-et-interruption"]'));
    check('no invented outages',!document.getElementById('official-enedis-body').textContent.includes('0 coupure'));
    const search=document.getElementById('official-industry-search');
    search.value='introuvable';search.dispatchEvent(new Event('input'));
    check('industrial search',document.getElementById('official-industry-table').textContent.includes('Aucun établissement'));
    search.value='';search.dispatchEvent(new Event('input'));
    setActivePanel('meteo-panel',{refreshSnapshot:false});
    check('weather view integrated',document.getElementById('official-weather-inline').textContent.includes('Mesures officielles'));
    setActivePanel('official-sources-panel',{refreshSnapshot:false});
    const pop=await window.OfficialSources.estimatePopulation({type:'Polygon',coordinates:[[[5.7,45.1],[5.8,45.1],[5.8,45.2],[5.7,45.1]]]});
    check('population API integrated',pop.population_estimated===1234);
    check('no uncaught JavaScript errors',window.__smokeErrors.length===0);
  } catch(e) { results.push({name:'unexpected error',pass:false,error:String(e)}); }
  const report=document.createElement('pre');report.id='smoke-results';report.textContent=JSON.stringify({results,errors:window.__smokeErrors});document.body.append(report);
})();
</script>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, content, media="application/json", status=200):
        body = content if isinstance(content, bytes) else json.dumps(content).encode()
        self.send_response(status)
        self.send_header("Content-Type", media)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/auth/me":
            return self.send(USER)
        if path == "/operations/bootstrap":
            return self.send(BOOTSTRAP)
        if path == "/external/isere/risks":
            return self.send(RISKS)
        if path == "/external/isere/risks/stream":
            return self.send(f"data: {json.dumps(RISKS)}\n\n".encode(), "text/event-stream")
        if path.endswith("/history"):
            return self.send({"history": [{"observed_at": STAMP, "temperature_c": 14.2}]})
        if path == "/dashboard":
            return self.send(BOOTSTRAP["dashboard"])
        if path == "/api/sources/isere":
            return self.send(SOURCES)
        if path == "/" or path == "/index.html":
            html = (ROOT / "web/index.html").read_text(encoding="utf-8")
            html = html.replace("<head>", "<head>" + INIT).replace("</body>", CHECKS + "</body>")
            return self.send(html.encode(), "text/html; charset=utf-8")
        candidate = (ROOT / "web" / path.lstrip("/")).resolve()
        if candidate.is_relative_to((ROOT / "web").resolve()) and candidate.is_file():
            media = {".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml"}.get(candidate.suffix, "application/octet-stream")
            return self.send(candidate.read_bytes(), media)
        return self.send([])

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/api/population/isere/estimate":
            return self.send({"status": "online", "population_estimated": 1234, "scope_coverage_ratio": 1})
        return self.send({"status": "queued"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", default="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=1080)
    args = parser.parse_args()
    output = ROOT / ".test-data"
    output.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="edge-smoke-", dir=output) as profile:
            command = [args.browser, "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost", f"--user-data-dir={profile}", f"--window-size={args.width},{args.height}", "--virtual-time-budget=15000", "--dump-dom", f"--screenshot={output / ('official-sources-smoke-' + str(args.width) + '.png')}", f"http://127.0.0.1:{server.server_port}/"]
            result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=50)
            (output / "official-sources-smoke.html").write_text(result.stdout, encoding="utf-8")
            match = re.search(r'<pre id="smoke-results">(.*?)</pre>', result.stdout, re.DOTALL)
            if not match:
                raise RuntimeError("No browser test report: " + result.stderr[-2000:])
            from html import unescape
            report = json.loads(unescape(match[1]))
            print(json.dumps(report, ensure_ascii=False, indent=2))
            if not all(item["pass"] for item in report["results"]):
                raise SystemExit(1)
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
