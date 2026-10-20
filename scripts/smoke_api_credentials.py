"""Exercise the real administrator credentials UI with local-only fixture data.

This checks browser integration, role visibility and responsive layout. Backend
authorization and encryption are covered separately by the backend test suite.
No production service is contacted; all submitted credentials are dummy values.
"""
import argparse
from html import unescape
from http.server import ThreadingHTTPServer
import json
import re
import subprocess
import tempfile
from threading import Thread
from urllib.parse import urlsplit

from smoke_official_sources import Handler as BaseHandler, ROOT, STAMP


SERVICES = {
    "meteo_france": ("Météo-France", [("api_key", "Clé commune"), ("observations_api_key", "Clé observations"), ("radar_api_key", "Clé radar"), ("access_token", "Jeton Bearer")]),
    "georisques": ("Géorisques", [("token", "Jeton API")]),
    "firms": ("NASA FIRMS", [("map_key", "Clé MAP_KEY")]),
    "tomtom": ("TomTom", [("api_key", "Clé API")]),
}
INIT = """<script>
localStorage.clear(); localStorage.setItem('token','fixture-only');
localStorage.setItem('activePanel','api-panel');
window.__smokeErrors=[];
window.addEventListener('error',e=>window.__smokeErrors.push(e.message));
window.addEventListener('unhandledrejection',e=>window.__smokeErrors.push(String(e.reason)));
</script>"""
CHECKS = """<script>
(async()=>{
  const results=[];
  const check=(name,ok)=>results.push({name,pass:Boolean(ok)});
  const waitFor=async(fn)=>{
    for(let i=0;i<100;i++){if(fn())return true;await new Promise(r=>setTimeout(r,100));}
    return false;
  };
  const fixture=async()=>await (await fetch('/__fixture/state')).json();
  try {
    await waitFor(()=>typeof currentUser!=='undefined'&&currentUser&&document.getElementById('app-view').hidden===false);
    check('authenticated session',Boolean(currentUser));
    check('API panel navigation',!document.getElementById('api-panel').hidden);
    const admin=currentUser?.role==='admin';
    if(admin){
      await waitFor(()=>document.querySelectorAll('.api-credential-card').length===4);
      check('administrator sees four credential services',document.querySelectorAll('.api-credential-card').length===4);
      const region=document.getElementById('api-credentials');
      check('administrator settings visible',!region.hidden);
      check('credential panel fits viewport',region.scrollWidth<=region.clientWidth+2);
      check('all credential cards fit viewport',[...document.querySelectorAll('.api-credential-card')].every(c=>c.scrollWidth<=c.clientWidth+2));
      check('secrets are password inputs',[...region.querySelectorAll('input[type=password]')].length===7);
      check('secrets initially empty',[...region.querySelectorAll('input[type=password]')].every(i=>i.value===''));
      let card=document.querySelector('[data-integration="tomtom"]');
      const input=card.querySelector('input[type=password]');
      input.value='fixture-secret-only';input.dispatchEvent(new Event('input',{bubbles:true}));
      [...card.querySelectorAll('button')].find(b=>b.textContent==='Tester la connexion').click();
      await waitFor(()=>card.querySelector('.api-credential-feedback').textContent.includes('Connexion de test réussie'));
      let state=await fixture();
      check('connection test called with the draft',state.tests===1&&state.test_used_fixture_key);
      check('connection test does not save',state.saves===0&&state.tomtom_source==='environment');
      check('draft remains available for save',input.value==='fixture-secret-only');
      check('connection feedback does not echo secret',!card.querySelector('.api-credential-feedback').textContent.includes('fixture-secret-only'));
      card.querySelector('form').requestSubmit();
      await waitFor(()=>document.querySelector('[data-integration="tomtom"]').textContent.includes('Accès enregistrés.'));
      card=document.querySelector('[data-integration="tomtom"]');
      state=await fixture();
      check('save persists the application override',state.saves===1&&state.tomtom_source==='application');
      check('save clears the password input',card.querySelector('input[type=password]').value==='');
      check('saved source is displayed',card.textContent.includes('Enregistré dans l’application'));
      const clear=card.querySelector('input[type=checkbox]');
      check('explicit clear control is available',Boolean(clear));
      clear.click();card.querySelector('form').requestSubmit();
      await waitFor(()=>!document.querySelector('[data-integration="tomtom"] input[type=checkbox]'));
      card=document.querySelector('[data-integration="tomtom"]');state=await fixture();
      check('clear returns to server configuration',state.saves===2&&state.tomtom_source==='environment'&&card.textContent.includes('Fourni par la configuration serveur'));
      card.querySelector('input[type=password]').value='unsaved-fixture-only';
      logout();
      check('logout removes all credential inputs',document.querySelectorAll('#api-credentials input').length===0);
      check('logout hides administrator settings',document.getElementById('api-credentials').hidden);
      check('logout removes the session token',!localStorage.getItem('token'));
    }else{
      setActivePanel('api-panel',{refreshSnapshot:false});
      await new Promise(r=>setTimeout(r,250));
      check('operator has no credential form',document.querySelectorAll('#api-credentials input').length===0);
      check('operator cannot see administrator settings',document.getElementById('api-credentials').hidden);
      const state=await fixture();
      check('operator never requests administrator credentials',state.admin_gets===0&&state.tests===0&&state.saves===0);
      check('operator retains API monitoring',!document.getElementById('api-panel').hidden);
    }
    check('no uncaught JavaScript errors',window.__smokeErrors.length===0);
  }catch(e){results.push({name:'unexpected error',pass:false,error:String(e)});}
  const report=document.createElement('pre');report.id='smoke-results';report.textContent=JSON.stringify({results,errors:window.__smokeErrors});document.body.append(report);
})();
</script>"""


class Handler(BaseHandler):
    def service(self, service_id):
        label, fields = SERVICES[service_id]
        saved = self.server.fixture["overrides"].get(service_id, {})
        rows = []
        for field_id, field_label in fields:
            source = "application" if saved.get(field_id) else "environment" if service_id == "tomtom" else "missing"
            rows.append({"id": field_id, "label": field_label, "configured": source != "missing", "source": source})
        return {"id": service_id, "label": label, "description": "Accès local de vérification du navigateur.", "help_url": "https://example.invalid/access", "fields": rows, "configured": any(row["configured"] for row in rows)}

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/auth/me":
            return self.send({"id": 1, "username": "smoke", "role": self.server.role, "must_change_password": False})
        if path == "/__fixture/state":
            return self.send({**{key: self.server.fixture[key] for key in ("admin_gets", "tests", "saves", "test_used_fixture_key")}, "tomtom_source": self.service("tomtom")["fields"][0]["source"]})
        if path == "/api/admin/integrations":
            self.server.fixture["admin_gets"] += 1
            if self.server.role != "admin":
                return self.send({"detail": "Forbidden"}, status=403)
            return self.send({"services": [self.service(service_id) for service_id in SERVICES]})
        if path == "/" or path == "/index.html":
            html = (ROOT / "web/index.html").read_text(encoding="utf-8")
            html = html.replace("<head>", "<head>" + INIT).replace("</body>", CHECKS + "</body>")
            return self.send(html.encode(), "text/html; charset=utf-8")
        return super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path == "/api/admin/integrations/tomtom/test":
            draft = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            if self.server.role != "admin":
                return self.send({"detail": "Forbidden"}, status=403)
            self.server.fixture["tests"] += 1
            self.server.fixture["test_used_fixture_key"] = draft.get("values", {}).get("api_key") == "fixture-secret-only"
            return self.send({"ok": True, "status": "online", "message": "Connexion de test réussie.", "duration_ms": 20, "tested_at": STAMP})
        return super().do_POST()

    def do_PUT(self):
        path = urlsplit(self.path).path
        draft = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
        if self.server.role != "admin":
            return self.send({"detail": "Forbidden"}, status=403)
        service_id = path.rsplit("/", 1)[-1]
        if service_id not in SERVICES:
            return self.send({"detail": "Not found"}, status=404)
        values = self.server.fixture["overrides"].setdefault(service_id, {})
        values.update(draft.get("values", {}))
        for field in draft.get("clear_fields", []):
            values.pop(field, None)
        self.server.fixture["saves"] += 1
        return self.send(self.service(service_id))


def run_browser(browser, width, height, role):
    output = ROOT / ".test-data"
    output.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.role = role
    server.fixture = {"overrides": {}, "admin_gets": 0, "tests": 0, "saves": 0, "test_used_fixture_key": False}
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="edge-api-smoke-", dir=output) as profile:
            prefix = f"api-credentials-{role}-{width}"
            command = [browser, "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost", f"--user-data-dir={profile}", f"--window-size={width},{height}", "--virtual-time-budget=18000", "--dump-dom", f"--screenshot={output / (prefix + '.png')}", f"http://127.0.0.1:{server.server_port}/"]
            result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=50)
            (output / (prefix + ".html")).write_text(result.stdout, encoding="utf-8")
            match = re.search(r'<pre id="smoke-results">(.*?)</pre>', result.stdout, re.DOTALL)
            if not match:
                raise RuntimeError(f"No browser report for {role}/{width}: " + result.stderr[-2000:])
            report = {"role": role, "width": width, **json.loads(unescape(match[1]))}
            print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
            return all(item["pass"] for item in report["results"])
    finally:
        server.shutdown()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", default="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
    parser.add_argument("--width", type=int, help="Run only this viewport; default: desktop 1440 and mobile 390")
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--role", choices=("admin", "ope", "all"), default="all")
    args = parser.parse_args()
    success = True
    for width in [args.width] if args.width else [1440, 390]:
        for role in ["admin", "ope"] if args.role == "all" else [args.role]:
            success = run_browser(args.browser, width, args.height, role) and success
    if not success:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
