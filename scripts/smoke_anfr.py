"""Exercise ANFR recovery in the real frontend on desktop and mobile.

Only the local fixture server is contacted. --payload optionally supplies a
complete observation saved from the official collector, including map points.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit

import smoke_official_sources as base
import smoke_vigieau as browser


PAYLOAD = {
    "schema_version": 3, "status": "online", "complete": True,
    "supports_total": 2, "stations_total": 3, "average_support_height_m": 28.1,
    "updated_at": base.STAMP, "last_success_at": base.STAMP,
    "source": "https://data.anfr.fr/visualisation/information/?id=observatoire_2g_3g_4g",
    "data_release": "Observatoire des réseaux mobiles · 2026-10-15",
    "supports_points": [
        {"id": "fixture-1", "lat": 45.18, "lon": 5.72, "operator": "Opérateur test", "data_services": ["4G", "5G"]},
        {"id": "fixture-2", "lat": 45.20, "lon": 5.73, "operator": "Opérateur test", "data_services": ["3G"]},
    ],
}
INIT = """<script>
localStorage.clear();localStorage.setItem('token','fixture-only');
localStorage.setItem('activePanel','api-panel');
window.__smokeErrors=[];
window.addEventListener('error',e=>window.__smokeErrors.push(e.message));
window.addEventListener('unhandledrejection',e=>window.__smokeErrors.push(String(e.reason)));
</script>"""
CHECKS = """<script>
(async()=>{
 const results=[];
 const check=(name,ok)=>results.push({name,pass:Boolean(ok)});
 const waitFor=async(fn)=>{for(let i=0;i<100;i++){if(fn())return true;await new Promise(r=>setTimeout(r,100));}return false;};
 const row=()=>document.querySelector('.flux-row[data-key="anfr_isere"]');
 const render=payload=>{renderExternalRisks({anfr_isere:payload});renderApiInterconnections(cachedExternalRisksSnapshot);};
 try {
  await waitFor(()=>row());
  check('API view active',!document.getElementById('api-panel').hidden);
  check('historical failed zero is unavailable',row().querySelector('.flux-row-metric').textContent.includes('indisponibles'));
  check('raw network exception hidden',!row().textContent.includes('ConnectionResetError'));
  check('failed collection has no observation date',!cachedExternalRisksSnapshot.anfr_isere.updated_at);
  check('hidden map not eagerly loaded',!telecomLoaded);
  const fresh=await (await fetch('/__fixture/anfr-success')).json();
  render(fresh);
  check('complete collection has correct support total',row().querySelector('.flux-row-metric').textContent.startsWith(`${fresh.supports_total} support(s)`));
  check('successful source has online status',row().classList.contains('status-online'));
  check('official mobile source linked',row().querySelector('a.flux-source-link').href===fresh.source);
  check('complete map points retained',cachedExternalRisksSnapshot.anfr_isere.supports_points.length===fresh.supports_points.length);
  setActivePanel('services-panel',{refreshSnapshot:false});
  const card=document.querySelector('details[data-svc-key="anfr_isere"]');card.open=true;
  check('service summary displays actual stations',document.getElementById('anfr-info').textContent.includes(`${fresh.stations_total} station(s)`));
  check('source publication displayed',document.getElementById('anfr-list').textContent.includes('2026-10-15'));
  check('expanded summary fits viewport',card.scrollWidth<=card.clientWidth+2&&card.getBoundingClientRect().right<=innerWidth);
  render({status:'unavailable',complete:false,supports_total:0,stations_total:0,supports_points:[],error:'ConnectionResetError(104)',updated_at:new Date(Date.now()+1000).toISOString()});
  check('failed refresh preserves real support count',cachedExternalRisksSnapshot.anfr_isere.supports_total===fresh.supports_total);
  check('failed refresh preserves observation date',cachedExternalRisksSnapshot.anfr_isere.updated_at===fresh.updated_at);
  check('failed refresh preserves map points',cachedExternalRisksSnapshot.anfr_isere.supports_points.length===fresh.supports_points.length);
  check('failure clearly marks retained collection',document.getElementById('anfr-list').textContent.includes('dernière collecte conservée'));
  render({...fresh,supports_total:0,stations_total:0,supports_points:[]});
  check('confirmed empty clears old supports',cachedExternalRisksSnapshot.anfr_isere.supports_total===0&&cachedExternalRisksSnapshot.anfr_isere.supports_points.length===0);
  render(fresh);
  setActivePanel('api-panel',{refreshSnapshot:false});
  row().scrollIntoView({block:'center'});
  check('API row fits viewport',row().scrollWidth<=row().clientWidth+2&&row().getBoundingClientRect().right<=innerWidth);
  check('no uncaught JavaScript errors',window.__smokeErrors.length===0);
 }catch(e){results.push({name:'unexpected error',pass:false,error:String(e),stack:e.stack});}
 const report=document.createElement('pre');report.id='smoke-results';report.hidden=true;
 report.textContent=JSON.stringify({results,metrics:{innerWidth,bodyWidth:document.body.scrollWidth},errors:window.__smokeErrors});document.body.append(report);
})();
</script>"""


class Handler(base.Handler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/index.html"):
            html = (base.ROOT / "web/index.html").read_text(encoding="utf-8")
            return self.send(html.replace("<head>", "<head>" + INIT).replace("</body>", CHECKS + "</body>").encode(), "text/html; charset=utf-8")
        if path == "/__fixture/anfr-success":
            return self.send(PAYLOAD)
        return super().do_GET()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", default="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
    parser.add_argument("--payload", type=Path, help="Saved successful ANFR observation; otherwise uses a fixture")
    parser.add_argument("--width", type=int, help="Single viewport width; defaults to 1440 and 390")
    args = parser.parse_args()
    if args.payload:
        PAYLOAD = json.loads(args.payload.read_text(encoding="utf-8"))
    base.RISKS["anfr_isere"] = {
        "status": "degraded", "supports_total": 0, "stations_total": 0,
        "supports_points": [], "updated_at": "2026-07-20T00:00:00Z",
        "meta": {"last_success_at": "2026-07-20T00:00:00Z"},
        "error": "('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))",
    }
    base.BOOTSTRAP["external_risks"] = base.RISKS
    browser.Handler = Handler
    output = base.ROOT / ".test-data/anfr/browser"
    output.mkdir(parents=True, exist_ok=True)
    success = True
    for width in [args.width] if args.width else [1440, 390]:
        success = browser.run(args.browser, width, output) and success
    if not success:
        raise SystemExit(1)
