"""Verify real Leaflet flood layers, zoom guidance, failures and recovery.

Default mode serves only local fixtures. --live permits the browser to request
images from the two configured official WMS hosts, while app APIs stay local.
"""
import argparse
import base64
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import smoke_hosting as hosting
import smoke_official_sources as base
import smoke_vigieau as browser


LIVE = False
STATE = {"mode": "success", "ppr_requests": 0, "tri_requests": 0}
TILE = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+XjdH4AAAAABJRU5ErkJggg==")
INIT = """<script>
localStorage.clear();localStorage.setItem('token','fixture-only');
localStorage.setItem('activePanel','situation-panel');
window.__smokeErrors=[];
window.addEventListener('error',e=>{if(e.message)window.__smokeErrors.push(e.message);});
window.addEventListener('unhandledrejection',e=>window.__smokeErrors.push(String(e.reason)));
</script>"""
CHECKS = r"""<script>
(async()=>{
 const results=[];
 const check=(name,ok)=>{results.push({name,pass:Boolean(ok)});if(!ok)throw Error(name+'; status='+status());};
 const waitFor=async(fn)=>{for(let i=0;i<160;i++){if(fn())return true;await new Promise(r=>setTimeout(r,75));}return false;};
 const el=id=>document.getElementById(id);
 const status=()=>el('flood-zone-status').textContent;
 const enabled=value=>{el('filter-flood-zones').checked=value;el('filter-flood-zones').dispatchEvent(new Event('change',{bubbles:true}));};
 const mode=async value=>fetch('/__fixture/flood-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:value})});
 try {
  await waitFor(()=>typeof currentUser!=='undefined'&&currentUser&&window.MapFilters);
  check('no flood/map libraries downloaded at login',!window.L&&!floodZoneWmsLayer);
  document.querySelectorAll('#map-controls-panel input[type="checkbox"]').forEach(input=>input.checked=false);
  setActivePanel('map-panel',{refreshSnapshot:false});
  await waitFor(()=>window.L&&leafletMap);
  await mapBootstrapPromise;
  // Opening the map schedules its initial sizing/department centering after 100 ms.
  await new Promise(resolve=>setTimeout(resolve,250));
  setMapControlsCollapsed(false);MapFilters.openCategory('water');
  leafletMap.setView([45.19,5.72],9,{animate:false});
  enabled(true);
  check('small-scale view asks to zoom instead of reporting failure',status().includes('Zoomez')&&el('flood-zone-retry').hidden);
  if(!window.__floodLive){const state=await(await fetch('/__fixture/flood-state')).json();check('no WMS requests below the published scales',state.ppr_requests===0&&state.tri_requests===0);}
  leafletMap.setZoom(11,{animate:false});
  check('TRI loads before PPR details at its own scale',await waitFor(()=>status().includes('Surfaces TRI chargées.')));
  if(!window.__floodLive){const state=await(await fetch('/__fixture/flood-state')).json();check('PPR is not requested before detailed zoom',state.ppr_requests===0&&state.tri_requests>0);}
  leafletMap.setZoom(14,{animate:false});
  check('both official raster sources load at detailed zoom',await waitFor(()=>status().includes('Zonages PPR et surfaces TRI chargés')));
  const sources=floodZoneWmsLayer.getLayers();
  check('both sources contain actual decoded image tiles',sources.length===2&&sources.every(layer=>Object.values(layer._tiles).some(tile=>tile.el.complete&&tile.el.naturalWidth>0)));
  if(window.__floodLive){
   check('live PPR uses the official BRGM service',sources.some(layer=>layer._url==='https://mapsref.brgm.fr/wxs/georisques/risques'));
   check('live TRI uses the official GeoRisques service',sources.some(layer=>layer._url==='https://www.georisques.gouv.fr/services'));
  }else{
   await mode('ppr_error');retryFloodZoneLayer();
   check('PPR failure retains the available TRI layer',await waitFor(()=>status().includes('Affichage partiel')&&status().includes('PPR')));
   check('partial failure exposes a retry action',!el('flood-zone-retry').hidden);
   check('load completion cannot hide a failed source',!status().includes('Zonages PPR et surfaces TRI chargés'));
   await mode('all_error');el('flood-zone-retry').click();
   check('complete outage reports a failed load',await waitFor(()=>status().includes('ne peut pas être chargé')));
   await mode('success');el('flood-zone-retry').click();
   check('retry restores both layers after an outage',await waitFor(()=>status().includes('Zonages PPR et surfaces TRI chargés')));
   check('recovery hides the retry action',el('flood-zone-retry').hidden);
  }
  check('flood interactions preserve the selected category',el('map-filter-menu').dataset.activeCategory==='water');
  enabled(false);
  check('disabling removes the group and hides source status',!floodZoneWmsLayer&&el('flood-zone-status').hidden&&el('flood-zone-retry').hidden);
  enabled(true);
  check('enabling again restores the layer',await waitFor(()=>status().includes('Zonages PPR et surfaces TRI chargés')));
  const group=floodZoneWmsLayer;
  applyBasemap('light');
  check('changing the basemap preserves the flood overlay',floodZoneWmsLayer===group&&leafletMap.hasLayer(group));
  await resetMapFilters();
  check('reset removes the flood overlay and restores its disabled default',!el('filter-flood-zones').checked&&!floodZoneWmsLayer&&el('flood-zone-status').hidden&&el('flood-zone-retry').hidden&&!leafletMap.hasLayer(group));
  setMapControlsCollapsed(true);
  check('no uncaught JavaScript errors',window.__smokeErrors.length===0);
 }catch(error){results.push({name:'unexpected error',pass:false,error:String(error),stack:error.stack});}
 const report=document.createElement('pre');report.id='smoke-results';report.hidden=true;
 report.textContent=JSON.stringify({results,metrics:{innerWidth,bodyWidth:document.body.scrollWidth,live:window.__floodLive},errors:window.__smokeErrors});document.body.append(report);
})();
</script>"""


class Handler(hosting.Handler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/index.html"):
            html = (base.ROOT / "web/index.html").read_text(encoding="utf-8")
            init = INIT + f"<script>window.__floodLive={str(LIVE).lower()};</script>"
            return self.send(html.replace("<head>", "<head>" + init).replace("</body>", CHECKS + "</body>").encode(), "text/html; charset=utf-8")
        if path == "/script.js":
            script = (base.ROOT / "web/script.js").read_text(encoding="utf-8")
            for filename, url in hosting.ASSETS.items():
                script = script.replace(url, "/__fixture/assets/" + filename)
            script = script.replace("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", "/__fixture/tile.png")
            if not LIVE:
                script = script.replace("https://www.georisques.gouv.fr/services", "/__fixture/flood/tri")
                script = script.replace("https://mapsref.brgm.fr/wxs/georisques/risques", "/__fixture/flood/ppr")
            return self.send(script.encode(), "application/javascript; charset=utf-8")
        if path == "/__fixture/flood-state":
            return self.send(STATE.copy())
        if path in ("/__fixture/flood/ppr", "/__fixture/flood/tri"):
            key = path.rsplit("/", 1)[-1]
            STATE[key + "_requests"] += 1
            params = {name.lower(): value[0] for name, value in parse_qs(urlsplit(self.path).query).items()}
            expected = "PPRN_ZONE_INOND" if key == "ppr" else "ALEA_SYNT_01_01FOR_FXX,ALEA_SYNT_01_02MOY_FXX,ALEA_SYNT_01_04FAI_FXX"
            failed = STATE["mode"] == "all_error" or key == "ppr" and STATE["mode"] == "ppr_error"
            valid = params.get("request", "").lower() == "getmap" and params.get("layers") == expected and params.get("crs") == "EPSG:3857"
            content = TILE if valid and not failed else b"WMS unavailable"
            self.send_response(200 if valid and not failed else 503)
            self.send_header("Content-Type", "image/png" if valid and not failed else "text/plain")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(content)
        return super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path == "/__fixture/flood-mode":
            STATE["mode"] = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))["mode"]
            return self.send(STATE.copy())
        return super().do_POST()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", default="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
    parser.add_argument("--width", type=int, help="Single viewport; defaults to 1440 and 390")
    parser.add_argument("--offline", action="store_true", help="Require cached browser libraries")
    parser.add_argument("--live", action="store_true", help="Allow requests to the two official WMS image hosts")
    parser.add_argument("--tile", type=Path, help="PNG fixture, such as a saved WMS response")
    args = parser.parse_args()
    LIVE = args.live
    if args.tile:
        TILE = args.tile.read_bytes()
        if not TILE.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("The tile fixture must be a PNG")
    hosting.prepare_assets(args.offline)
    browser.Handler = Handler
    if LIVE:
        original_popen = browser.subprocess.Popen

        def live_browser(command, **kwargs):
            command = [argument + ", EXCLUDE www.georisques.gouv.fr, EXCLUDE mapsref.brgm.fr"
                       if argument.startswith("--host-resolver-rules=") else argument for argument in command]
            return original_popen(command, **kwargs)

        browser.subprocess.Popen = live_browser
    output = base.ROOT / ".test-data/flood" / ("browser-live" if LIVE else "browser")
    output.mkdir(parents=True, exist_ok=True)
    success = True
    for width in [args.width] if args.width else [1440, 390]:
        STATE.update(mode="success", ppr_requests=0, tri_requests=0)
        success = browser.run(args.browser, width, output) and success
    if not success:
        raise SystemExit(1)
