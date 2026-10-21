"""Check VigiEau in the real frontend against a local fixture API.

Uses a built-in test observation by default; --payload can verify a saved API
observation. Browser traffic is confined to the local test server. The browser's
debugging protocol sets an exact mobile viewport, avoiding Edge's window minimum.
"""
import argparse
import base64
import os
from pathlib import Path
import smoke_official_sources as base
from http.server import ThreadingHTTPServer
from threading import Thread
from urllib.parse import urlsplit
from urllib.request import urlopen
import json
import socket
import struct
import subprocess
import tempfile
import time


def sample_payload():
    """Deterministic fixture data, served only by this test server."""
    alerts = []
    for index in range(55):
        level = "crise" if index < 9 else "alerte renforcée" if index < 47 else "alerte" if index < 52 else "vigilance"
        resource = ("AEP", "SUP", "SOU")[index % 3]
        alerts.append({
            "zone": f"Bassin de test {index + 1}", "code": f"TEST_38_{index:04}",
            "level": level, "water_type": resource,
            "water_type_label": {"AEP": "Eau potable", "SUP": "Eaux superficielles", "SOU": "Eaux souterraines"}[resource],
            "measure": "Mesures de test du navigateur", "start_date": "2026-10-01", "end_date": "2026-10-31",
            "communes": [{"code": f"38{index:03}", "name": f"Commune de test {index + 1}"}],
            "usages": [{"name": "Arrosage de test", "theme": "Arroser", "description": "Description publiée dans la fixture de test.", "profiles": ["particulier", "collectivite"]}],
            "arrete": {"id": 1, "url": "https://regleau.example.test/decree.pdf"},
        })
    return {"status": "online", "complete": True, "max_level": "rouge", "alerts_total": len(alerts), "alerts": alerts, "updated_at": base.STAMP}


PAYLOAD = sample_payload()
INIT = """<script>
localStorage.clear(); localStorage.setItem('token','fixture-only');
localStorage.setItem('activePanel','water-panel');
window.__smokeErrors=[];
window.addEventListener('error',e=>window.__smokeErrors.push(e.message));
window.addEventListener('unhandledrejection',e=>window.__smokeErrors.push(String(e.reason)));
</script>"""
CHECKS = """<script>
(async()=>{
 const results=[];
 const check=(name,ok)=>results.push({name,pass:Boolean(ok)});
 const waitFor=async(fn)=>{for(let i=0;i<100;i++){if(fn())return true;await new Promise(r=>setTimeout(r,100));}return false;};
 const setFilter=(prefix,key,value)=>{const input=document.querySelector(`#${prefix}-content [data-vigieau-filter="${key}"]`);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
 try {
  await waitFor(()=>document.querySelectorAll('#water-vigieau-list .water-restriction-card').length>0);
  const root=document.getElementById('water-vigieau-content');
  const alerts=root._vigieauAlerts||[];
  check('water view active',!document.getElementById('water-panel').hidden);
  check('all departmental zones received',alerts.length===window.__fixtureZoneCount);
  check('first page bounded to 12 zone cards',document.querySelectorAll('#water-vigieau-list .water-restriction-card').length===Math.min(12,window.__fixtureZoneCount));
  check('zone count shows entire department',document.getElementById('water-vigieau-count').textContent.includes(`sur ${window.__fixtureZoneCount}`));
  check('real maximum severity shown',document.getElementById('water-vigieau-status').textContent.includes('crise'));
  check('usage DOM deferred until expanded',root.querySelectorAll('.vigieau-usage').length===0);
  const details=root.querySelector('[data-vigieau-zone]');details.open=true;
  await waitFor(()=>details.querySelectorAll('.vigieau-usage').length>0);
  check('usage descriptions load on expansion',details.querySelectorAll('.vigieau-usage').length>0);
  const first=alerts[Number(details.dataset.vigieauZone)];
  check('actual published usage text displayed',details.textContent.includes(first.usages[0].description));
  check('audiences displayed',details.textContent.includes('Particuliers'));
  check('decree PDF linked',Boolean(root.querySelector('.vigieau-documents a[href^="https:"]')));
  check('validity dates displayed',root.textContent.includes('fin prévue le'));
  root.querySelector('[data-vigieau-page="1"]').click();
  check('next page renders remaining zones',root._vigieauState.page===1&&root.querySelector('[data-vigieau-zone]').dataset.vigieauZone==='12');
  setFilter('water-vigieau','search','__no_such_zone__');
  check('unknown search yields filtered empty state',document.getElementById('water-vigieau-list').textContent.includes('Aucune zone ne correspond'));
  check('filtered absence does not claim all clear',!document.getElementById('water-vigieau-list').textContent.includes('Aucune restriction'));
  setFilter('water-vigieau','search',alerts[0].code);
  check('zone code search finds official zone',document.getElementById('water-vigieau-list').textContent.includes(alerts[0].zone));
  setFilter('water-vigieau','search','');
  setFilter('water-vigieau','level','crise');
  check('severity filter works',[...root.querySelectorAll('.water-restriction-card__head span')].every(el=>el.textContent==='crise'));
  setFilter('water-vigieau','level','');
  setFilter('water-vigieau','water','AEP');
  check('resource filter works',[...root.querySelectorAll('.vigieau-zone-meta')].every(el=>el.textContent.includes('Eau potable'))&&root.querySelectorAll('.water-restriction-card').length>0);
  setFilter('water-vigieau','water','');
  setFilter('water-vigieau','profile','particulier');
  const personal=root.querySelector('[data-vigieau-zone]');personal.open=true;
  await waitFor(()=>personal.querySelectorAll('.vigieau-usage').length>0);
  check('profile filter keeps only matching detailed measures',[...personal.querySelectorAll('.vigieau-usage')].every(el=>el.textContent.includes('Particuliers')));
  check('water panel fits viewport',root.scrollWidth<=root.clientWidth+2&&root.getBoundingClientRect().right<=innerWidth);
  check('expanded cards fit viewport',[...root.querySelectorAll('.water-restriction-card')].every(el=>el.scrollWidth<=el.clientWidth+2));
  setFilter('water-vigieau','profile','');
  setActivePanel('services-panel',{refreshSnapshot:false});
  renderVigieauAlerts(cachedExternalRisksSnapshot.vigieau);
  const serviceRoot=document.getElementById('vigieau-content');
  const serviceCard=serviceRoot.closest('details[data-svc-key="vigieau"]');
  serviceCard.open=true;
  check('services view visible',!document.getElementById('services-panel').hidden&&serviceRoot.getBoundingClientRect().width>0&&serviceCard.open);
  check('services view also receives rich controls',Boolean(document.getElementById('vigieau-search')));
  check('services view renders zones',document.querySelectorAll('#vigieau-list .water-restriction-card').length===12);
  check('services card fits available width',serviceCard.scrollWidth<=serviceCard.clientWidth+2&&serviceCard.getBoundingClientRect().right<=innerWidth);
  check('services filters fit card width',[...serviceRoot.querySelectorAll('.vigieau-controls input,.vigieau-controls select')].every(el=>el.getBoundingClientRect().right<=serviceRoot.getBoundingClientRect().right+1));
  setFilter('vigieau','search','__no_such_zone__');
  check('visible services search filters zones',document.getElementById('vigieau-list').textContent.includes('Aucune zone ne correspond'));
  setFilter('vigieau','search','');
  const previous=cachedExternalRisksSnapshot.vigieau;
  const offline=mergeVigieauSlot(previous,{status:'offline',alerts:[],complete:false});
  renderVigieauAlerts(offline);
  check('failed refresh retains last observed zones',document.querySelectorAll('#vigieau-list .water-restriction-card').length===12);
  check('failed refresh explicitly uncertain',document.getElementById('vigieau-notice').textContent.includes('indisponibles'));
  const empty=mergeVigieauSlot(offline,{status:'online',alerts:[],max_level:'vert',complete:true});
  renderVigieauAlerts(empty);
  check('authoritative empty clears old zones',document.querySelectorAll('#vigieau-list .water-restriction-card').length===0);
  check('authoritative empty gets all clear',document.getElementById('vigieau-status').textContent.includes('Aucune restriction'));
  renderVigieauAlerts(previous);
  setActivePanel('water-panel',{refreshSnapshot:false});
  check('no uncaught JavaScript errors',window.__smokeErrors.length===0);
 }catch(e){results.push({name:'unexpected error',pass:false,error:String(e),stack:e.stack});}
 const metrics={innerWidth,docWidth:document.documentElement.clientWidth,bodyWidth:document.body.scrollWidth,contentWidth:document.querySelector('.content').clientWidth,panelWidth:document.getElementById('water-panel').clientWidth,rootWidth:document.getElementById('water-vigieau-content').clientWidth};
 const report=document.createElement('pre');report.id='smoke-results';report.hidden=true;report.textContent=JSON.stringify({results,metrics,errors:window.__smokeErrors});document.body.append(report);
})();
</script>"""

class Handler(base.Handler):
    def do_GET(self):
        path=urlsplit(self.path).path
        if path in ("/", "/index.html"):
            html=(base.ROOT / "web/index.html").read_text(encoding="utf-8")
            init = INIT + f"<script>window.__fixtureZoneCount={len(PAYLOAD['alerts'])};</script>"
            return self.send(html.replace("<head>", "<head>"+init).replace("</body>",CHECKS+"</body>").encode(),"text/html; charset=utf-8")
        if path=="/api/vigieau/alerts":
            return self.send(PAYLOAD)
        return super().do_GET()

class BrowserSession:
    """Small localhost-only WebSocket client for Chrome's debugging protocol."""
    def __init__(self, url):
        parsed = urlsplit(url)
        if parsed.hostname not in {"127.0.0.1", "localhost"}:
            raise ValueError("Browser debugging must stay local")
        self.socket = socket.create_connection((parsed.hostname, parsed.port), timeout=10)
        self.socket.settimeout(10)
        key = base64.b64encode(os.urandom(16)).decode()
        self.socket.sendall((f"GET {parsed.path} HTTP/1.1\r\nHost: {parsed.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        response = b""
        while not response.endswith(b"\r\n\r\n"):
            response += self.socket.recv(1)
        if not response.startswith(b"HTTP/1.1 101"):
            raise RuntimeError("Browser debugging handshake failed")
        self.sequence = 0

    def read_exact(self, length):
        data = b""
        while len(data) < length:
            chunk = self.socket.recv(length - len(data))
            if not chunk:
                raise ConnectionError("Browser debugging connection closed")
            data += chunk
        return data

    def command(self, method, params=None):
        self.sequence += 1
        data = json.dumps({"id": self.sequence, "method": method, "params": params or {}}).encode()
        length = len(data)
        header = bytes([0x81, 0x80 | length]) if length < 126 else bytes([0x81, 0xFE]) + struct.pack("!H", length) if length < 65536 else bytes([0x81, 0xFF]) + struct.pack("!Q", length)
        mask = os.urandom(4)
        self.socket.sendall(header + mask + bytes(byte ^ mask[index % 4] for index, byte in enumerate(data)))
        while True:
            opcode, length = self.read_exact(2)
            if opcode & 0x0F == 8:
                raise ConnectionError("Browser debugging connection closed")
            masked, length = length & 0x80, length & 0x7F
            if length == 126:
                length = struct.unpack("!H", self.read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self.read_exact(8))[0]
            mask = self.read_exact(4) if masked else None
            message = self.read_exact(length)
            if mask:
                message = bytes(byte ^ mask[index % 4] for index, byte in enumerate(message))
            response = json.loads(message)
            if response.get("id") == self.sequence:
                if "error" in response:
                    raise RuntimeError(response["error"])
                return response.get("result", {})


def run(browser, width, output):
    server=ThreadingHTTPServer(("127.0.0.1",0), Handler)
    Thread(target=server.serve_forever,daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="edge-vigieau-", dir=output) as profile:
            process=subprocess.Popen([
                browser,
                "--headless=new", "--disable-gpu", "--force-device-scale-factor=1", "--no-first-run", "--disable-extensions",
                "--disable-background-networking", "--no-proxy-server",
                "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
                f"--user-data-dir={profile}", f"--window-size={width},1080",
                "--remote-debugging-port=0", "about:blank",
            ],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            session = None
            try:
                port_file = Path(profile) / "DevToolsActivePort"
                deadline = time.monotonic() + 15
                while not port_file.exists():
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Browser debugging did not start")
                    time.sleep(0.1)
                port = int(port_file.read_text().splitlines()[0])
                with urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5) as response:
                    pages = json.load(response)
                session = BrowserSession(next(page["webSocketDebuggerUrl"] for page in pages if page["type"] == "page"))
                session.command("Emulation.setDeviceMetricsOverride", {"width": width, "height": 1080, "deviceScaleFactor": 1, "mobile": False})
                session.command("Page.navigate", {"url": f"http://127.0.0.1:{server.server_port}/"})
                report_text = None
                deadline = time.monotonic() + 20
                while not report_text and time.monotonic() < deadline:
                    result = session.command("Runtime.evaluate", {"expression": "document.getElementById('smoke-results')?.textContent", "returnByValue": True})
                    report_text = result.get("result", {}).get("value")
                    if not report_text:
                        time.sleep(0.1)
                screenshot = session.command("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
                (output / f"ui-{width}.png").write_bytes(base64.b64decode(screenshot["data"]))
                dom = session.command("Runtime.evaluate", {"expression": "document.documentElement.outerHTML", "returnByValue": True})
                (output / f"ui-{width}.html").write_text(dom["result"]["value"], encoding="utf-8")
                if not report_text:
                    raise RuntimeError("Browser checks did not produce a report")
                report = json.loads(report_text)
                report["results"].append({"name": "exact viewport width", "pass": report["metrics"]["innerWidth"] == width})
                report["results"].append({"name": "document fits viewport", "pass": report["metrics"]["bodyWidth"] <= width})
                (output / f"ui-{width}.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
                print(json.dumps({"width":width,**report},ensure_ascii=False,indent=2),flush=True)
                return all(item["pass"] for item in report["results"])
            finally:
                if session:
                    try:
                        session.command("Browser.close")
                    except (OSError, ConnectionError):
                        pass
                    session.socket.close()
                if process.poll() is None:
                    process.terminate()
                process.communicate(timeout=10)
    finally:
        server.shutdown()

if __name__=="__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", default="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
    parser.add_argument("--payload", type=Path, help="Saved /api/vigieau/alerts payload; otherwise uses test fixture")
    parser.add_argument("--width", type=int, help="Single viewport width; defaults to 1440 and 390")
    args = parser.parse_args()
    if args.payload:
        PAYLOAD = json.loads(args.payload.read_text(encoding="utf-8"))
    base.RISKS["vigieau"] = PAYLOAD
    base.BOOTSTRAP["external_risks"] = base.RISKS
    output = base.ROOT / ".test-data" / "vigieau"
    output.mkdir(parents=True, exist_ok=True)
    success=True
    for width in [args.width] if args.width else [1440,390]:
        success=run(args.browser, width, output) and success
    if not success:
        raise SystemExit(1)
