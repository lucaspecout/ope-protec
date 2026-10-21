"""Exercise map category navigation and source filters in a real local browser.

Application HTML and JavaScript run against deterministic localhost fixtures.
Leaflet assets reuse the hosting smoke test's local cache; --offline forbids
preparing missing assets. Tests inspect real Leaflet markers and source tables.
"""
import argparse
from datetime import timedelta
from urllib.parse import urlsplit

import smoke_hosting as hosting
import smoke_official_sources as base
import smoke_vigieau as browser


def install_fixtures():
    old = (base.NOW - timedelta(hours=5)).isoformat()
    base.SOURCES["meteo_observations"] = {
        "status": "online", "updated_at": base.STAMP,
        "stations": [
            {"id": "MF_FRESH", "name": "MF fixture récente Grenoble", "commune": "Grenoble", "lat": 45.181, "lon": 5.721, "observed_at": base.STAMP, "temperature_c": 0, "rain_6m_mm": 0, "gust_kmh": 21, "stale": False},
            {"id": "MF_OLD", "name": "MF fixture ancienne Voiron", "commune": "Voiron", "lat": 45.361, "lon": 5.591, "observed_at": old, "temperature_c": 12, "rain_6m_mm": 2, "gust_kmh": 42, "stale": True},
            {"id": "MF_MISSING", "name": "MF fixture incomplète Vienne", "commune": "Vienne", "lat": 45.521, "lon": 4.871, "observed_at": base.STAMP, "temperature_c": None, "rain_6m_mm": None, "gust_kmh": None, "stale": False},
        ],
        "summary": {"fresh_stations": 2, "max_rain_6m_mm": 2, "max_gust_kmh": 42},
    }
    base.SOURCES["industrial_sites"] = {
        "status": "online", "updated_at": base.STAMP, "sites_total": 3,
        "seveso_haut_total": 1, "seveso_bas_total": 1,
        "sites": [
            {"id": "HIGH", "nom": "ICPE fixture haut Grenoble", "commune": "Grenoble", "code_insee": "38185", "lat": 45.182, "lon": 5.722, "seveso": "haut", "seveso_label": "Seveso seuil haut", "source_url": "https://www.georisques.gouv.fr/"},
            {"id": "LOW", "nom": "ICPE fixture bas Voiron", "commune": "Voiron", "code_insee": "38563", "lat": 45.362, "lon": 5.592, "seveso": "bas", "seveso_label": "Seveso seuil bas", "source_url": "https://www.georisques.gouv.fr/"},
            {"id": "NONE", "nom": "ICPE fixture non Seveso Vienne", "commune": "Vienne", "code_insee": "38544", "lat": 45.522, "lon": 4.872, "seveso": "non", "seveso_label": "Non Seveso", "source_url": "https://www.georisques.gouv.fr/"},
        ],
    }
    base.SOURCES["fuel_isere"] = {
        "status": "online", "updated_at": base.STAMP, "stations_total": 3,
        "temporary_shortage_stations": 1,
        "stations": [
            {"id": "FUEL_GRENOBLE", "commune": "Grenoble", "address": "FUEL fixture Grenoble", "postal_code": "38000", "lat": 45.183, "lon": 5.723, "hours": [], "services": [], "automate_24h": True, "fuels": [{"fuel": "Gazole", "price_eur": 1.70, "updated_at": base.STAMP, "shortage": None}, {"fuel": "E10", "price_eur": None, "updated_at": base.STAMP, "shortage": "temporary"}]},
            {"id": "FUEL_VOIRON", "commune": "Voiron", "address": "FUEL fixture Voiron", "postal_code": "38500", "lat": 45.363, "lon": 5.593, "hours": [], "services": [], "fuels": [{"fuel": "E10", "price_eur": 1.65, "updated_at": base.STAMP, "shortage": None}]},
            {"id": "FUEL_VIENNE", "commune": "Vienne", "address": "FUEL fixture Vienne", "postal_code": "38200", "lat": 45.523, "lon": 4.873, "hours": [], "services": [], "fuels": [{"fuel": "Gazole", "price_eur": None, "updated_at": base.STAMP, "shortage": "discontinued"}]},
        ],
    }
    base.SOURCES["onde_isere"] = {
        "status": "online", "updated_at": base.STAMP, "stations_total": 3,
        "dry_stations": 1, "observed_at": "2026-10-15",
        "stations": [
            {"id": "ONDE_VISIBLE", "name": "ONDE fixture visible Grenoble", "commune": "Grenoble", "river": "Ruisseau fixture Grenoble", "lat": 45.184, "lon": 5.724, "flow_code": "1", "flow_label": "Écoulement visible", "observed_at": "2026-10-15"},
            {"id": "ONDE_NOT_VISIBLE", "name": "ONDE fixture non visible Voiron", "commune": "Voiron", "river": "Ruisseau fixture Voiron", "lat": 45.364, "lon": 5.594, "flow_code": "2", "flow_label": "Écoulement non visible", "observed_at": "2026-10-15"},
            {"id": "ONDE_DRY", "name": "ONDE fixture assec Vienne", "commune": "Vienne", "river": "Ruisseau fixture Vienne", "lat": 45.524, "lon": 4.874, "flow_code": "3", "flow_label": "Assec", "observed_at": "2026-10-15"},
        ],
    }
    base.RISKS.update(base.SOURCES)
    base.BOOTSTRAP["external_risks"] = base.RISKS


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
 const waitFor=async(fn)=>{for(let i=0;i<100;i++){if(fn())return true;await new Promise(r=>setTimeout(r,80));}return false;};
 const byId=id=>document.getElementById(id);
 const change=(id,value)=>{const element=byId(id);if(!element)throw Error('Missing filter '+id);if(element.type==='checkbox')element.checked=value;else element.value=value;element.dispatchEvent(new Event(element.tagName==='SELECT'||element.type==='checkbox'?'change':'input',{bubbles:true}));};
 const countRows=id=>byId(id).querySelectorAll('tbody tr').length;
 const markerText=()=>Object.values(leafletMap._layers).filter(layer=>layer instanceof L.CircleMarker&&layer.getPopup()).map(layer=>String(layer.getPopup().getContent()));
 const markers=needle=>markerText().filter(text=>text.includes(needle));
 const active=()=>byId('map-filter-menu').dataset.activeCategory;
 const visibleCategories=()=>[...document.querySelectorAll('[data-map-filter-category]')].filter(node=>!node.hidden);
 const open=id=>{const button=document.querySelector(`[data-map-filter-open="${id}"]`);if(!button)throw Error('Missing category '+id);button.click();};
 const expectedOrder=['basemap','weather','water','risks','resources','traffic','mountain','tools','lists'];
 try {
  await waitFor(()=>typeof currentUser!=='undefined'&&currentUser&&window.MapFilters);
  check('map libraries remain deferred before opening map',!window.L);
  const requests=await(await fetch('/__fixture/map-requests')).json();
  check('map collections remain deferred before opening map',requests.mapCollections===0);
  document.querySelectorAll('#map-controls-panel input[type="checkbox"]').forEach(element=>element.checked=false);
  ['filter-official-observations','filter-official-industries','filter-public-fuel','filter-public-onde'].forEach(id=>change(id,true));
  setActivePanel('map-panel',{refreshSnapshot:false});
  await waitFor(()=>window.L&&leafletMap&&document.querySelector('.leaflet-map-pane'));
  setMapControlsCollapsed(false);
  await waitFor(()=>markers('MF fixture').length===3&&markers('ICPE fixture').length===3&&markers('FUEL fixture').length===3&&markers('ONDE fixture').length===3);
  check('real Leaflet map initialized',Boolean(window.L&&leafletMap&&document.querySelector('.leaflet-map-pane')));
  check('all four fixture collections displayed as actual map markers',markers('MF fixture').length===3&&markers('ICPE fixture').length===3&&markers('FUEL fixture').length===3&&markers('ONDE fixture').length===3);
  const buttons=[...document.querySelectorAll('[data-map-filter-open]')];
  check('category order follows coherent map workflow',JSON.stringify(buttons.map(button=>button.dataset.mapFilterOpen))===JSON.stringify(expectedOrder));
  check('initial menu shows categories without detailed filters',!active()&&visibleCategories().length===0&&!byId('map-filter-categories').hidden);
  check('category entries are accessible named buttons',buttons.length===9&&buttons.every(button=>button.tagName==='BUTTON'&&button.type==='button'&&button.textContent.trim()&&byId(button.getAttribute('aria-controls'))));
  check('menu fits viewport horizontally',byId('map-controls-panel').getBoundingClientRect().left>=0&&byId('map-controls-panel').getBoundingClientRect().right<=innerWidth+1&&byId('map-controls-panel').scrollWidth<=byId('map-controls-panel').clientWidth+2);
  const categoryRects=buttons.map(button=>button.getBoundingClientRect());
  check('nine category choices remain compact',Math.max(...categoryRects.map(rect=>rect.bottom))-Math.min(...categoryRects.map(rect=>rect.top))<=720);
  buttons[0].focus();buttons[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  check('keyboard arrows navigate category choices',document.activeElement===buttons[1]);
  open('weather');
  check('weather category isolates its controls',active()==='weather'&&visibleCategories().length===1&&visibleCategories()[0].dataset.mapFilterCategory==='weather'&&byId('map-filter-categories').hidden);
  check('breadcrumb clearly identifies selected category',!byId('map-filter-category-header').hidden&&/météo/i.test(byId('map-filter-current-title').textContent)&&byId('map-filter-back').textContent.trim());
  check('category navigation moves keyboard focus to selected title',document.activeElement===byId('map-filter-current-title'));
  check('weather source filters are available directly in menu',['map-observation-search','map-observation-freshness','map-observation-measure'].every(id=>byId('map-filter-category-weather').contains(byId(id))));
  change('map-observation-search','Grenoble');
  check('weather search filters actual markers',markers('MF fixture').length===1&&markers('MF fixture')[0].includes('Grenoble'));
  check('weather search keeps selected category',active()==='weather'&&visibleCategories().length===1);
  change('map-observation-search','');
  change('map-observation-freshness','fresh');
  check('weather freshness excludes old observation',markers('MF fixture').length===2&&!markers('MF fixture').some(text=>text.includes('ancienne')));
  change('map-observation-freshness','stale');
  check('weather old-observation filter keeps the dated old station',markers('MF fixture').length===1&&markers('MF fixture')[0].includes('ancienne'));
  change('map-observation-freshness','all');
  change('map-observation-measure','temperature');
  check('weather measured-value filter excludes unknown and retains zero',markers('MF fixture').length===2&&markers('MF fixture').some(text=>text.includes('récente'))&&!markers('MF fixture').some(text=>text.includes('incomplète')));
  change('map-observation-measure','all');
  const weatherCount=byId('map-observation-results');
  check('weather menu shows current matching count',weatherCount&&weatherCount.textContent.includes('3'));
  setMapControlsCollapsed(true);
  byId('map-observation-search').focus();
  check('closed drawer prevents keyboard focus entering hidden filters',byId('map-controls-panel').inert&&document.activeElement!==byId('map-observation-search'));
  setMapControlsCollapsed(false);
  check('reopening drawer restores interactive filter controls',!byId('map-controls-panel').inert);
  check('closing and reopening menu retains current category',active()==='weather'&&visibleCategories()[0]?.dataset.mapFilterCategory==='weather');
  byId('map-filter-back').click();
  check('return action restores category overview and keyboard focus',!active()&&visibleCategories().length===0&&document.activeElement?.dataset.mapFilterOpen==='weather');
  open('water');
  check('ONDE controls live under water category',['map-onde-search','map-onde-flow'].every(id=>byId('map-filter-category-water').contains(byId(id))));
  change('map-onde-flow','3');
  check('ONDE assec filter updates actual markers',markers('ONDE fixture').length===1&&markers('ONDE fixture')[0].includes('assec'));
  check('ONDE map filter synchronizes source control and table',byId('public-onde-flow').value==='3'&&countRows('public-onde-results')===1&&byId('public-onde-results').textContent.includes('Vienne'));
  change('public-onde-flow','2');
  check('ONDE source control synchronizes menu and actual markers',byId('map-onde-flow').value==='2'&&markers('ONDE fixture').length===1&&markers('ONDE fixture')[0].includes('Voiron'));
  change('map-onde-flow','all');change('map-onde-search','Grenoble');
  check('ONDE local search updates actual markers and source table',markers('ONDE fixture').length===1&&countRows('public-onde-results')===1&&byId('public-onde-search').value==='Grenoble');
  change('map-onde-search','');
  change('map-onde-flow','visible');
  check('ONDE visible-flow filter selects the visible observation',markers('ONDE fixture').length===1&&markers('ONDE fixture')[0].includes('Grenoble'));
  change('map-onde-flow','all');
  check('ONDE changes retain water category',active()==='water');
  byId('map-filter-back').click();open('risks');
  check('industrial controls live under risks category',['map-industry-search','map-industry-class'].every(id=>byId('map-filter-category-risks').contains(byId(id))));
  change('map-industry-class','haut');
  check('Seveso classification updates actual markers',markers('ICPE fixture').length===1&&markers('ICPE fixture')[0].includes('haut'));
  check('Seveso map filter synchronizes source control and table',byId('official-industry-filter').value==='haut'&&countRows('official-industry-table')===1);
  change('official-industry-filter','bas');
  check('Seveso source control synchronizes menu and actual markers',byId('map-industry-class').value==='bas'&&markers('ICPE fixture').length===1&&markers('ICPE fixture')[0].includes('Voiron'));
  change('map-industry-class','all');change('map-industry-search','Vienne');
  check('industrial local search updates actual markers and source table',markers('ICPE fixture').length===1&&countRows('official-industry-table')===1&&byId('official-industry-search').value==='Vienne');
  change('map-industry-search','');
  change('map-industry-class','non_seveso');
  check('non-Seveso class uses existing source classification',markers('ICPE fixture').length===1&&markers('ICPE fixture')[0].includes('Vienne')&&byId('official-industry-filter').value==='non');
  const panel=byId('map-controls-panel');panel.scrollTop=60;
  const beforeScroll=panel.scrollTop;
  change('map-industry-class','bas');
  check('filter changes retain category scroll position',active()==='risks'&&Math.abs(panel.scrollTop-beforeScroll)<=1);
  change('map-industry-class','all');
  const previousTitle=byId('map-filter-current-title');
  window.OfficialSources.update({industrial_sites:{...cachedExternalRisksSnapshot.industrial_sites,updated_at:new Date().toISOString()}});
  check('source refresh preserves category and its existing controls',active()==='risks'&&byId('map-filter-current-title')===previousTitle&&byId('map-industry-class').value==='all'&&markers('ICPE fixture').length===3);
  byId('map-filter-back').click();open('traffic');
  check('fuel controls live under traffic category',['map-fuel-search','map-fuel-type','map-fuel-shortage'].every(id=>byId('map-filter-category-traffic').contains(byId(id))));
  change('map-fuel-type','E10');
  check('fuel type updates actual station markers',markers('FUEL fixture').length===2&&!markers('FUEL fixture').some(text=>text.includes('Vienne')));
  check('fuel map filter synchronizes source control and table',byId('public-fuel-type').value==='E10'&&countRows('public-fuel-results')===2);
  change('map-fuel-shortage','temporary');
  check('declared fuel shortage updates actual markers',markers('FUEL fixture').length===1&&markers('FUEL fixture')[0].includes('Grenoble'));
  change('public-fuel-shortage','priced');
  check('fuel source control synchronizes menu and actual markers',byId('map-fuel-shortage').value==='priced'&&markers('FUEL fixture').length===1&&markers('FUEL fixture')[0].includes('Voiron'));
  change('map-fuel-type','all');change('map-fuel-shortage','all');change('map-fuel-search','Vienne');
  check('fuel local search updates actual markers and source table',markers('FUEL fixture').length===1&&countRows('public-fuel-results')===1&&byId('public-fuel-search').value==='Vienne');
  change('map-fuel-search','');
  check('fuel changes retain traffic category',active()==='traffic');
  const controls=[...byId('map-filter-category-traffic').querySelectorAll('input:not([type="checkbox"]),select,button')].filter(element=>element.getBoundingClientRect().width>0);
  check('visible category controls fit menu width',controls.every(element=>{const rect=element.getBoundingClientRect(),outer=panel.getBoundingClientRect();return rect.left>=outer.left-1&&rect.right<=outer.right+1;}));
  check('mobile editable controls use readable font size',innerWidth>600||controls.filter(element=>element.matches('input,select')).every(element=>parseFloat(getComputedStyle(element).fontSize)>=16));
  change('map-fuel-search','Vienne');change('map-fuel-type','Gazole');change('map-fuel-shortage','temporary');
  change('map-observation-search','Grenoble');change('map-observation-freshness','fresh');change('map-observation-measure','rain');
  change('map-industry-search','Voiron');change('map-industry-class','bas');change('map-onde-search','Vienne');change('map-onde-flow','3');
  const originalReset=resetMapFilters;let resetCompletion;
  resetMapFilters=(...args)=>{resetCompletion=originalReset(...args);return resetCompletion;};
  try{byId('map-reset-filters').click();await resetCompletion;}finally{resetMapFilters=originalReset;}
  check('reset button completes its actual asynchronous operation',Boolean(resetCompletion&&typeof resetCompletion.then==='function'));
  check('reset retains the active traffic category',active()==='traffic');
  const emptyFields=['map-observation-search','map-industry-search','map-fuel-search','map-onde-search','official-industry-search','public-fuel-search','public-onde-search'];
  const allFields=['map-observation-freshness','map-observation-measure','map-industry-class','map-fuel-type','map-fuel-shortage','map-onde-flow','official-industry-filter','public-fuel-type','public-fuel-shortage','public-onde-flow'];
  check('reset clears all new source criteria and synchronized controls',emptyFields.every(id=>byId(id).value==='')&&allFields.every(id=>byId(id).value==='all'));
  check('reset restores source layer defaults and removes their markers',['filter-official-observations','filter-official-industries','filter-public-fuel','filter-public-onde'].every(id=>!byId(id).checked)&&['MF fixture','ICPE fixture','FUEL fixture','ONDE fixture'].every(needle=>markers(needle).length===0));
  check('reset also restores complete synchronized source tables',countRows('official-industry-table')===3&&countRows('public-fuel-results')===3&&countRows('public-onde-results')===3);
  check('reset updates category layer badges',[...document.querySelectorAll('[data-map-filter-open]')].every(button=>{const category=byId(button.getAttribute('aria-controls'));const layers=[...category.querySelectorAll('input[data-map-layer],select[data-map-layer]')];const count=layers.filter(input=>input.tagName==='SELECT'?Boolean(input.value)&&input.value!=='none':input.checked).length;const badge=button.querySelector('.map-filter-category-count');return badge.textContent===String(count)&&badge.hidden===(layers.length===0);}));
  ['filter-official-observations','filter-official-industries','filter-public-fuel','filter-public-onde'].forEach(id=>change(id,true));
  document.activeElement?.blur();
  byId('map-filter-current-title').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  check('Escape returns to categories',!active()&&!byId('map-filter-categories').hidden&&document.activeElement?.dataset.mapFilterOpen==='traffic');
  open('weather');
  const fixedHead=byId('map-filter-category-header');
  panel.scrollTop=100;
  check('category breadcrumb remains visible while scrolling',fixedHead.getBoundingClientRect().top>=panel.getBoundingClientRect().top-1&&fixedHead.getBoundingClientRect().bottom<=panel.getBoundingClientRect().bottom+1);
  panel.scrollTop=0;
  await itinisereWebcamsInFlight;
  const afterReset=await(await fetch('/__fixture/map-requests')).json();
  window.__mapRequestMetrics=afterReset;
  check('empty camera collection does not trigger repeated fetches',afterReset.webcams===1);
  check('all original category sections remain available',expectedOrder.every(id=>Boolean(byId('map-filter-category-'+id))));
  const mobileNav=byId('mobile-bottom-nav').getBoundingClientRect();
  check('drawer remains above the fixed mobile navigation',mobileNav.width===0||panel.getBoundingClientRect().bottom<=mobileNav.top+1);
  const rect=node=>{const value=node.getBoundingClientRect();return {top:Math.round(value.top),bottom:Math.round(value.bottom),height:Math.round(value.height)};};
  window.__mapViewportMetrics={drawer:rect(panel),workspace:rect(document.querySelector('.map-workspace')),mobileNav:rect(byId('mobile-bottom-nav'))};
  check('no uncaught JavaScript errors',window.__smokeErrors.length===0);
  if(window.__captureCategories){window.MapFilters.showCategories({focus:false});panel.scrollTop=0;}
 }catch(error){results.push({name:'unexpected error',pass:false,error:String(error),stack:error.stack});}
 const report=document.createElement('pre');report.id='smoke-results';report.hidden=true;
 report.textContent=JSON.stringify({results,metrics:{innerWidth,bodyWidth:document.body.scrollWidth,...window.__mapRequestMetrics,...window.__mapViewportMetrics},errors:window.__smokeErrors});document.body.append(report);
})();
</script>"""

REQUESTS = {"mapCollections": 0, "webcams": 0}
CAPTURE_CATEGORIES = False


class Handler(hosting.Handler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/index.html"):
            html = (base.ROOT / "web/index.html").read_text(encoding="utf-8")
            init = INIT + f"<script>window.__captureCategories={str(CAPTURE_CATEGORIES).lower()};</script>"
            return self.send(html.replace("<head>", "<head>" + init).replace("</body>", CHECKS + "</body>").encode(), "text/html; charset=utf-8")
        if path == "/__fixture/map-requests":
            return self.send(REQUESTS.copy())
        if path == "/api/itinisere/webcams":
            REQUESTS["webcams"] = REQUESTS.get("webcams", 0) + 1
            return self.send({"status": "online", "webcams": [], "count": 0})
        if path in ("/api/hosting/isere/verified", "/api/institutions/isere", "/public/isere-map"):
            REQUESTS["mapCollections"] += 1
        return super().do_GET()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", default="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
    parser.add_argument("--width", type=int, help="Single viewport width; defaults to 1440 and 390")
    parser.add_argument("--offline", action="store_true", help="Require cached Leaflet assets and make no external network requests")
    parser.add_argument("--overview", action="store_true", help="Capture category overview after running the same checks")
    args = parser.parse_args()
    install_fixtures()
    hosting.prepare_assets(args.offline)
    browser.Handler = Handler
    CAPTURE_CATEGORIES = args.overview
    output = base.ROOT / ".test-data/map-filters" / ("categories" if args.overview else "browser")
    output.mkdir(parents=True, exist_ok=True)
    success = True
    for width in [args.width] if args.width else [1440, 390]:
        REQUESTS.update(mapCollections=0, webcams=0)
        success = browser.run(args.browser, width, output) and success
    if not success:
        raise SystemExit(1)
