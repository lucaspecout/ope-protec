"""Exercise hosting collection, filters and recovery in the real map UI.

The fixture server supplies all application data and local copies of the app's
Leaflet dependencies. Missing public library files are downloaded once into the
ignored test artifact directory; browser traffic stays on localhost. Production
JavaScript is unchanged except for mapping those dependency URLs to local files.
"""
import argparse
import base64
import json
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen

import smoke_official_sources as base
import smoke_vigieau as browser


ASSETS = {
    "leaflet.js": "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "leaflet.css": "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "leaflet.draw.js": "https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js",
    "leaflet.draw.css": "https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css",
    "leaflet-heat.js": "https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js",
    "turf.min.js": "https://cdn.jsdelivr.net/npm/@turf/turf@7.4.0/turf.min.js",
    "chart.umd.min.js": "https://cdn.jsdelivr.net/npm/chart.js@4.6.1/dist/chart.umd.min.js",
}
ASSET_DIR = base.ROOT / ".test-data/hosting/assets-2026-10"
SOURCE = "https://equipements.sports.gouv.fr/explore/dataset/data-es/"


def sample_payload():
    common = {
        "active": True, "verified": True, "dynamic": True,
        "priority": "standard", "capacity": None,
        "hosting_status": "à confirmer",
        "hosting_note": "Aptitude et capacité de mise à l’abri à confirmer auprès du gestionnaire.",
        "source_url": SOURCE, "updated_at": "2026-10-15T10:00:00Z",
    }
    points = [
        {
            **common, "id": "dataes-TEST_E001", "installation_id": "TEST_I001",
            "installation_name": "Installation municipale test",
            "name": "Gymnase des Tilleuls test", "type": "gymnase",
            "lat": 45.185, "lon": 5.72,
            "address": "10 rue des Tilleuls, 38000 Grenoble", "municipality": "Grenoble", "postal_code": "38000",
            "surface_m2": 1200, "erp_category": "4", "erp_capacity_min": None, "erp_capacity_max": 300,
            "erp_capacity_label": "4e catégorie : 300 personnes au plus",
            "accessibility": "yes", "sanitary": "yes", "parking": "yes", "heating": None,
            "owner": "Commune de Grenoble", "operator": "Service des sports test",
            "phone": "04 76 00 00 00", "email": "accueil@example.test",
            "website": "https://commune.example.test/gymnase",
            "activities": ["Basket-ball", "Handball"], "spectator_capacity": 150,
            "source": SOURCE + "?id=TEST_E001",
        },
        {
            **common, "id": "dataes-TEST_E002", "installation_id": "TEST_I002",
            "name": "Gymnase sans données techniques test", "type": "gymnase",
            "lat": 45.19, "lon": 5.73, "address": "Rue de test, Grenoble", "municipality": "Grenoble",
            "surface_m2": None, "accessibility": None, "sanitary": None, "parking": None, "heating": None,
            "source": SOURCE + "?id=TEST_E002",
        },
        {
            **common, "id": "dataes-TEST_E003", "installation_id": "TEST_I003",
            "name": "Salle omnisports du Parc test", "type": "salle_omnisports",
            "lat": 45.195, "lon": 5.74, "address": "20 rue du Parc, Grenoble", "municipality": "Grenoble",
            "capacity": 600, "capacity_source": "Capacité d’accueil public publiée par le gestionnaire",
            "surface_m2": 1800, "accessibility": "no", "sanitary": "no", "parking": "no", "heating": "yes",
            "source": SOURCE + "?id=TEST_E003",
        },
    ]
    return {
        "schema_version": 2, "status": "online", "complete": True,
        "count": len(points), "points": points,
        "records_total": len(points), "equipment_total": len(points), "installations_total": 3,
        "source_url": SOURCE, "updated_at": base.STAMP, "last_success_at": base.STAMP,
        "note": "Équipements publics recensés ; ouverture et couchages à confirmer auprès du gestionnaire.",
    }


PAYLOAD = sample_payload()
INVENTORY = None
STATE = {"mode": "error", "requests": 0}
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
 const check=(name,ok)=>results.push({name,pass:Boolean(ok)});
 const waitFor=async(fn)=>{for(let i=0;i<120;i++){if(fn())return true;await new Promise(r=>setTimeout(r,80));}return false;};
 const mode=async value=>fetch('/__fixture/hosting-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:value})});
 const hostings=()=>getDisplayedResources().filter(p=>HOSTING_RESOURCE_TYPES.has(p.type));
 const input=(id,value)=>{const el=document.getElementById(id);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));};
 const reset=()=>{input('filter-resources-hosting-type','all');input('filter-resources-hosting-capacity','0');input('filter-resources-hosting-surface','0');input('filter-resources-hosting-accessibility','all');['sanitary','heating','parking'].forEach(key=>input('filter-resources-hosting-'+key,false));input('filter-resources-hosting-unknown',true);document.getElementById('map-search').value='';renderResources();};
 try {
  await waitFor(()=>typeof currentUser!=='undefined'&&currentUser);
  const initial=await(await fetch('/__fixture/hosting-state')).json();
  check('login does not download hosting collection',initial.requests===0&&!verifiedHostingLoaded);
  check('map libraries are deferred before opening map',!window.L);
  document.querySelectorAll('#map-controls-panel input[type="checkbox"]').forEach(el=>el.checked=false);
  input('filter-resources-hosting',true);
  input('filter-resources-hosting-unknown',true);
  setActivePanel('map-panel',{refreshSnapshot:false});
  await waitFor(()=>window.L&&leafletMap&&document.getElementById('hosting-data-status').textContent.includes('indisponib'));
  check('real Leaflet map initialized',Boolean(window.L&&leafletMap&&document.querySelector('.leaflet-map-pane')));
  const originalGeometryLoader=loadIsereCommunesGeometry;
  try {
   const commune={type:'Polygon',coordinates:[[[5,45],[6,45],[6,46],[5,46],[5,45]]]};
   const half={type:'Polygon',coordinates:[[[5,45],[5.5,45],[5.5,46],[5,46],[5,45]]]};
   loadIsereCommunesGeometry=async()=>[{code:'38185',name:'Commune test',population:1000,geometry:commune}];
   const estimate=await estimatePopulationInZoneByArea(half,[],new Map([['38185',1000]]));
   check('Turf 7 intersection preserves population estimate',Math.abs(estimate.estimatedPopulation-500)<1);
   const breakdown=await computeZoneMunicipalityBreakdown(half,[],new Map([['38185',1000]]));
   check('Turf 7 intersection preserves commune breakdown',breakdown.length===1&&breakdown[0].estimatedPopulation===500);
  } finally { loadIsereCommunesGeometry=originalGeometryLoader; }
  await ensureChartAssets();
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const chart=new Chart(canvas,{type:'line',data:{labels:['J0','J1'],datasets:[{data:[0,10]}]},options:{animation:false,responsive:false}});
  check('Chart.js 4.6.1 renders a real canvas chart',Chart.version==='4.6.1'&&chart.getDatasetMeta(0).data.length===2);
  chart.destroy();canvas.remove();
  check('cold failure does not become successful empty collection',!verifiedHostingLoaded&&verifiedHostingPointsCache.length===0);
  check('cold failure displays actionable status',document.getElementById('hosting-data-status').textContent.toLowerCase().includes('indisponib'));
  const retry=document.getElementById('hosting-data-retry');
  check('retry action available after failure',Boolean(retry&&!retry.hidden));
  await mode('fresh');retry.click();
  await waitFor(()=>verifiedHostingLoaded&&verifiedHostingPointsCache.length===3);
  renderResources();
  check('retry recovers complete collection',verifiedHostingLoaded&&hostings().length===3);
  check('successful observation saved locally',Boolean(readSnapshot(STORAGE_KEYS.staticHostingCache)));
  check('source status reports recovered count',document.getElementById('hosting-data-status').textContent.includes('3'));
  check('all recovered places receive real map markers',resourceLayer.getLayers().filter(marker=>String(marker.getPopup()?.getContent()).includes(' test')).length===3);
  const first=verifiedHostingPointsCache.find(p=>p.id==='dataes-TEST_E001');
  const unknown=verifiedHostingPointsCache.find(p=>p.id==='dataes-TEST_E002');
  const profile=buildHostingProfile(unknown);
  check('missing capacity stays unknown',profile.capacity===null);
  check('unknown facilities are not inferred from venue type',profile.heating===null&&profile.sanitary===null&&profile.parking===null);
  const details=formatHostingDetailsHtml(first);
  check('published surface displayed',details.includes('1')&&details.includes('200')&&details.includes('m²'));
  check('published operator displayed',details.includes('Service des sports test'));
  check('source website linked',details.includes('https://commune.example.test/gymnase'));
  check('published activity displayed',details.includes('Basket-ball'));
  check('ERP threshold identified separately from sleeping capacity',details.includes('ERP')&&!/300\s*(?:couchages|lits)/i.test(details));
  check('emergency opening remains to confirm',/confirmer/i.test(details));
  input('filter-resources-hosting-type','gymnase');
  check('venue type filter works',hostings().length===2&&hostings().every(p=>p.type==='gymnase'));
  reset();input('filter-resources-hosting-capacity','500');
  check('unknown capacity remains visible by default',hostings().some(p=>p.id===unknown.id));
  input('filter-resources-hosting-unknown',false);
  check('strict minimum capacity excludes unknown values',hostings().length===1&&hostings()[0].id==='dataes-TEST_E003');
  reset();input('filter-resources-hosting-surface','1000');input('filter-resources-hosting-unknown',false);
  check('published surface filter works',hostings().length===2&&!hostings().some(p=>p.id===unknown.id));
  reset();input('filter-resources-hosting-accessibility','accessible');
  check('unknown accessibility remains visible by default',hostings().some(p=>p.id===unknown.id));
  input('filter-resources-hosting-unknown',false);
  check('strict accessibility requires published confirmation',hostings().length===1&&hostings()[0].id===first.id);
  reset();input('filter-resources-hosting-sanitary',true);input('filter-resources-hosting-unknown',false);
  check('sanitary filter uses published value',hostings().length===1&&hostings()[0].id===first.id);
  reset();document.getElementById('map-search').value='Tilleuls';renderResources();
  check('local venue search works',hostings().length===1&&hostings()[0].id===first.id);
  reset();
  await mode('partial');await loadVerifiedHostingIsere(true);renderResources();
  check('partial collection does not discard previously observed places',hostings().length===3&&verifiedHostingPointsCache.some(p=>p.id===unknown.id));
  check('partial collection remains eligible for completion',!verifiedHostingLoaded);
  check('partial collection clearly marked incomplete',/incomplète/i.test(document.getElementById('hosting-data-status').textContent));
  const stamp=readSnapshot(STORAGE_KEYS.staticHostingCache).updated_at;
  await mode('error');await loadVerifiedHostingIsere(true);renderResources();
  check('failed refresh retains last reliable places',verifiedHostingPointsCache.length===3&&hostings().length===3);
  check('failed refresh keeps original observation date',readSnapshot(STORAGE_KEYS.staticHostingCache).updated_at===stamp);
  check('failed refresh stays eligible for retry',!verifiedHostingLoaded);
  check('retained observation visibly stale',/conserv|ancienne|dernière|actualis|indisponib/i.test(document.getElementById('hosting-data-status').textContent));
  await mode('empty');await loadVerifiedHostingIsere(true);renderResources();
  check('confirmed empty collection clears old places',verifiedHostingLoaded&&verifiedHostingPointsCache.length===0&&hostings().length===0);
  await mode('fresh');await loadVerifiedHostingIsere(true);renderResources();
  check('later successful collection restores markers',verifiedHostingLoaded&&hostings().length===3);
  const marker=resourceLayer.getLayers().find(item=>String(item.getPopup()?.getContent()).includes('Gymnase des Tilleuls test'));
  leafletMap.setView([first.lat,first.lon],13);setMapControlsCollapsed(true);
  await new Promise(r=>setTimeout(r,250));marker.openPopup();
  await new Promise(r=>setTimeout(r,350));
  check('real popup displays enriched details',document.querySelector('.leaflet-popup-content').textContent.includes('Service des sports test'));
  check('popup fits available viewport',document.querySelector('.leaflet-popup-content-wrapper').scrollWidth<=document.querySelector('.leaflet-popup-content-wrapper').clientWidth+2);
  const popupRect=document.querySelector('.leaflet-popup-content-wrapper').getBoundingClientRect();
  const summaryRect=document.querySelector('#map-panel .map-summary').getBoundingClientRect();
  check('popup remains inside viewport horizontally',popupRect.left>=0&&popupRect.right<=innerWidth);
  check('popup title remains below map counters',popupRect.top>=summaryRect.bottom||popupRect.right<=summaryRect.left||popupRect.left>=summaryRect.right);
  if(window.__hasSavedInventory){
   const inventory=await(await fetch('/__fixture/hosting-inventory')).json();
   // Start an independent observation: saved inventory predates this run's synthetic fixtures.
   verifiedHostingPointsCache=[];verifiedHostingState={status:'pending',updated_at:null};verifiedHostingLoaded=false;
   localStorage.removeItem(STORAGE_KEYS.staticHostingCache);
   await mode('inventory');
   const started=performance.now();await loadVerifiedHostingIsere(true);renderResources();
   window.__hostingInventoryMetrics={points:verifiedHostingPointsCache.length,renderDurationMs:Math.round(performance.now()-started)};
   check('saved official inventory fully rendered',verifiedHostingLoaded&&hostings().length===inventory.points.length);
   check('saved inventory creates all real map markers',resourceLayer.getLayers().length===inventory.points.length);
   const sites=new Set(verifiedHostingPointsCache.map(p=>p.installation_id));
   check('saved inventory preserves distinct installation count',sites.size===inventory.installations_total);
   const point=verifiedHostingPointsCache[0];
   const liveMarker=resourceLayer.getLayers().find(item=>{const pos=item.getLatLng();return pos.lat===Number(point.lat)&&pos.lng===Number(point.lon);});
   leafletMap.setView([point.lat,point.lon],13);liveMarker.openPopup();
   await new Promise(r=>setTimeout(r,350));
   check('saved inventory popup links actual official record',[...document.querySelectorAll('.leaflet-popup-content a')].some(link=>link.href===point.source));
   const savedRect=document.querySelector('.leaflet-popup-content-wrapper').getBoundingClientRect();
   check('saved inventory popup fits viewport',savedRect.left>=0&&savedRect.right<=innerWidth&&document.querySelector('.leaflet-popup-content-wrapper').scrollWidth<=document.querySelector('.leaflet-popup-content-wrapper').clientWidth+2);
  }
  check('no uncaught JavaScript errors',window.__smokeErrors.length===0);
 }catch(e){results.push({name:'unexpected error',pass:false,error:String(e),stack:e.stack});}
 const report=document.createElement('pre');report.id='smoke-results';report.hidden=true;
 report.textContent=JSON.stringify({results,metrics:{innerWidth,bodyWidth:document.body.scrollWidth,...window.__hostingInventoryMetrics},errors:window.__smokeErrors});document.body.append(report);
})();
</script>"""


class Handler(base.Handler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/index.html"):
            html = (base.ROOT / "web/index.html").read_text(encoding="utf-8")
            init = INIT + f"<script>window.__hasSavedInventory={json.dumps(INVENTORY is not None)};</script>"
            return self.send(html.replace("<head>", "<head>" + init).replace("</body>", CHECKS + "</body>").encode(), "text/html; charset=utf-8")
        if path == "/script.js":
            script = (base.ROOT / "web/script.js").read_text(encoding="utf-8")
            for filename, url in ASSETS.items():
                script = script.replace(url, "/__fixture/assets/" + filename)
            script = script.replace("https://tile.openstreetmap.org/{z}/{x}/{y}.png", "/__fixture/tile.png")
            return self.send(script.encode(), "application/javascript; charset=utf-8")
        if path.startswith("/__fixture/assets/"):
            filename = path.rsplit("/", 1)[-1]
            if filename in ASSETS:
                media = "text/css" if filename.endswith(".css") else "application/javascript"
                return self.send((ASSET_DIR / filename).read_bytes(), media)
            return self.send(b"", "application/octet-stream", 404)
        if path == "/__fixture/tile.png":
            return self.send(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+XjdH4AAAAABJRU5ErkJggg=="), "image/png")
        if path == "/__fixture/hosting-state":
            return self.send(STATE.copy())
        if path == "/__fixture/hosting-inventory":
            return self.send(INVENTORY)
        if path == "/api/hosting/isere/verified":
            STATE["requests"] += 1
            if STATE["mode"] == "error":
                return self.send({"schema_version": 2, "status": "error", "complete": False, "count": None, "points": [], "error": "Collecte temporairement indisponible."})
            if STATE["mode"] == "empty":
                return self.send({**PAYLOAD, "count": 0, "points": [], "records_total": 0, "equipment_total": 0, "installations_total": 0})
            if STATE["mode"] == "partial":
                return self.send({**PAYLOAD, "status": "partial", "complete": False, "count": 1, "points": PAYLOAD["points"][:1]})
            if STATE["mode"] == "inventory":
                return self.send(INVENTORY)
            return self.send(PAYLOAD)
        if path == "/public/isere-map":
            return self.send({"source": "Contour de test local", "geometry": {"type": "Polygon", "coordinates": [[[5.0, 44.8], [6.4, 44.8], [6.4, 45.8], [5.0, 45.8], [5.0, 44.8]]]}})
        if path == "/api/institutions/isere":
            return self.send({"status": "online", "points": []})
        return super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path == "/__fixture/hosting-mode":
            data = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
            STATE["mode"] = data["mode"]
            return self.send(STATE.copy())
        return super().do_POST()


def prepare_assets(offline=False):
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    for filename, url in ASSETS.items():
        path = ASSET_DIR / filename
        if path.is_file():
            continue
        if offline:
            raise FileNotFoundError(f"Missing browser dependency: {path}. Run once without --offline to prepare it.")
        with urlopen(url, timeout=25) as response:
            path.write_bytes(response.read())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", default="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
    parser.add_argument("--width", type=int, help="Single viewport width; defaults to 1440 and 390")
    parser.add_argument("--payload", type=Path, help="Also verify the complete saved official inventory")
    parser.add_argument("--offline", action="store_true", help="Require cached library assets and make no network requests")
    args = parser.parse_args()
    if args.payload:
        INVENTORY = json.loads(args.payload.read_text(encoding="utf-8"))
        if INVENTORY.get("status") != "online" or INVENTORY.get("complete") is not True or not INVENTORY.get("points"):
            raise ValueError("--payload requires a complete nonempty official observation")
    prepare_assets(args.offline)
    browser.Handler = Handler
    output = base.ROOT / ".test-data/hosting/browser"
    output.mkdir(parents=True, exist_ok=True)
    success = True
    for width in [args.width] if args.width else [1440, 390]:
        STATE.update(mode="error", requests=0)
        success = browser.run(args.browser, width, output) and success
    if not success:
        raise SystemExit(1)
