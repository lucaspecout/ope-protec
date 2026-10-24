"""Run the real frontend against a local fixture API in a headless browser.

No production endpoint or external website is contacted. Fixtures are confined
to this test server; application JavaScript and HTML are served unchanged.
"""
import argparse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
import json
from pathlib import Path
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
    "fuel_isere": {"status": "online", "updated_at": STAMP, "stations_total": 1, "temporary_shortage_stations": 1, "note": "Prix et ruptures déclarés ; stock non garanti.", "stations": [{"id": "38000001", "commune": "Grenoble", "address": "Station carburant test", "postal_code": "38000", "lat": 45.18, "lon": 5.72, "hours": [], "services": [], "automate_24h": True, "fuels": [{"fuel": "Gazole", "price_eur": 1.7, "updated_at": STAMP, "old_price": False, "shortage": None}, {"fuel": "E10", "price_eur": None, "shortage": "temporary", "old_price": True}]}]},
    "onde_isere": {"status": "online", "updated_at": STAMP, "stations_total": 1, "dry_stations": 1, "observed_at": "2026-09-25", "note": "Relevés de campagne OFB, pas du temps réel.", "stations": [{"id": "V150 6011", "name": "Ruisseau de test", "commune": "Grenoble", "river": "Ruisseau test", "lat": 45.18, "lon": 5.72, "flow_code": "3", "flow_label": "Assec", "observed_at": "2026-09-25"}]},
    "catnat_isere": {"status": "online", "updated_at": STAMP, "events_total": 1, "preview_limit": 150, "note": "Historique, sans alerte actuelle.", "coverage": {"communes_total": 1, "communes_checked": 1}, "events": [{"id": "TEST_ORDER", "commune": "Grenoble", "code_insee": "38185", "risk": "Inondation de test", "event_start": "1993-09-09", "event_end": "1993-09-10", "published_at": "1994-02-18"}], "communes": [{"code": "38185", "name": "Grenoble", "checked": True, "events_total": 1}]},
    "energy_aura": {"status": "online", "updated_at": STAMP, "observed_at": STAMP, "note": "Données régionales en MW, sans localisation des coupures.", "latest": {"consumption_mw": 0, "generation_mw": {"solaire": 0, "nucleaire": None}}, "generation_labels": {"solaire": "Solaire", "nucleaire": "Nucléaire"}, "series": [{"at": (NOW - timedelta(minutes=15)).isoformat(), "consumption_mw": 100}, {"at": STAMP, "consumption_mw": 0}]},
    "recalls": {"status": "online", "updated_at": STAMP, "items_total": 2, "targeted_total": 1, "unspecified_total": 1, "note": "Zone de vente déclarative.", "items": [{"id": "123", "name": "Rappel alimentaire test", "brand": "Marque test", "scope": "national", "active": None, "published_at": STAMP, "source_url": "https://rappel.conso.gouv.fr/fiche-rappel/123/interne"}, {"id": "124", "name": "Autre zone test", "scope": "unspecified", "active": True, "published_at": STAMP}]},
}
RISKS = {
    **SOURCES,
    "updated_at": STAMP,
    "meteo_france": {"status": "online", "level": "vert"},
    "vigicrues": {"status": "online", "stations": [], "troncons": [], "water_alert_level": "vert"},
    "cols_alpins_isere": {"status": "online", "cols": []},
    "meteo_forets_isere": {"status": "online", "updated_at": STAMP, "forecasts": [{"date": NOW.date().isoformat(), "danger": "Élevé", "level": "orange"}]},
    "groundwater_isere": {"status": "online", "updated_at": STAMP, "stations_total": 1, "trend_summary": {"hausse": 1, "baisse": 0, "stable": 0}, "stations": [{"name": "Nappe de test", "commune": "Grenoble", "code_bss": "BSS-TEST", "groundwater_level_m_ngf": 210, "trend": "hausse", "date_measure": NOW.date().isoformat()}]},
    "sncf_isere": {"status": "online", "updated_at": STAMP, "alerts": [{"title": "Travaux ferroviaires de test", "description": "Interruption locale de test", "level": "jaune"}]},
    "prefecture_isere": {"status": "online", "updated_at": STAMP, "items": [{"title": "Publication préfectorale de test", "link": "https://www.isere.gouv.fr/", "published_at": STAMP}]},
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
      if(typeof FLUX_SERVICES!=='undefined'&&document.getElementById('source-available-count')?.textContent!=='—'&&document.querySelectorAll('.source-choice').length===FLUX_SERVICES.length) break;
      await new Promise(r=>setTimeout(r,100));
    }
    const sourceCount=FLUX_SERVICES.length;
    check('all connected and official sources appear exactly once',document.querySelectorAll('.source-choice').length===sourceCount&&new Set([...document.querySelectorAll('.source-choice')].map(e=>e.dataset.sourceOpen)).size===sourceCount);
    check('single source navigation entry',!document.querySelector('.menu-btn[data-target="services-panel"]'));
    check('no data views initially visible',[...document.querySelectorAll('[data-source-view]')].every(e=>e.hidden));
    check('source cards are accessible buttons',[...document.querySelectorAll('.source-choice')].every(e=>e.tagName==='BUTTON'&&e.getAttribute('aria-label')));
    check('panel navigation',!document.getElementById('official-sources-panel').hidden);
    const panel=document.getElementById('official-sources-panel');
    check('source panel fits viewport',panel.scrollWidth<=panel.clientWidth+2);
    const theme=document.getElementById('source-theme');theme.value='energy';theme.dispatchEvent(new Event('change'));
    check('theme filter selects two energy sources',document.querySelectorAll('.source-choice').length===2);
    const catalogSearch=document.getElementById('source-search');catalogSearch.value='electricite';catalogSearch.dispatchEvent(new Event('input'));
    check('accent-insensitive source search',document.querySelectorAll('.source-choice').length===1&&document.querySelector('.source-choice').dataset.sourceOpen==='energy_aura');
    catalogSearch.value='introuvable';catalogSearch.dispatchEvent(new Event('input'));
    check('empty search has recovery action',!document.getElementById('source-empty').hidden);
    document.getElementById('source-clear-filters').click();
    check('clear filters restores every source',document.querySelectorAll('.source-choice').length===sourceCount);
    document.querySelector('[data-source-mode="list"]').click();
    check('list mode selected',document.getElementById('source-catalog-grid').dataset.mode==='list'&&document.querySelector('[data-source-mode="list"]').getAttribute('aria-pressed')==='true');
    check('list fits viewport',panel.scrollWidth<=panel.clientWidth+2);
    document.querySelector('[data-source-open="meteo_observations"]').click();
    check('card opens only selected source',[...document.querySelectorAll('[data-source-view]')].filter(e=>!e.hidden).length===1&&!document.querySelector('[data-source-view="meteo_observations"]').hidden);
    check('catalogue hidden in focused view',document.getElementById('source-catalog').hidden&&!document.getElementById('source-detail-switch').hidden);
    check('detail title receives keyboard focus',document.activeElement.id==='source-detail-title');
    check('observations wired',document.getElementById('official-observation-table').textContent.includes('Station test Grenoble'));
    check('forecast chart',document.querySelector('#official-forecast-chart svg'));
    check('industrial reference',document.getElementById('official-industry-table').textContent.includes('Usine test officielle'));
    check('enedis diagnostic',document.querySelector('#official-enedis-body a[href="https://www.enedis.fr/panne-et-interruption"]'));
    check('no invented outages',!document.getElementById('official-enedis-body').textContent.includes('0 coupure'));
    const sourceSelect=document.getElementById('source-select');sourceSelect.value='industrial_sites';sourceSelect.dispatchEvent(new Event('change'));
    check('source dropdown switches focused data',!document.querySelector('[data-source-view="industrial_sites"]').hidden&&document.querySelector('[data-source-view="meteo_observations"]').hidden);
    const search=document.getElementById('official-industry-search');
    search.value='introuvable';search.dispatchEvent(new Event('input'));
    check('industrial search',document.getElementById('official-industry-table').textContent.includes('Aucun établissement'));
    search.value='';search.dispatchEvent(new Event('input'));
    setActivePanel('meteo-panel',{refreshSnapshot:false});
    check('weather view integrated',document.getElementById('official-weather-inline').textContent.includes('Mesures officielles'));
    setActivePanel('official-sources-panel',{refreshSnapshot:false});
    const pop=await window.OfficialSources.estimatePopulation({type:'Polygon',coordinates:[[[5.7,45.1],[5.8,45.1],[5.8,45.2],[5.7,45.1]]]});
    check('population API integrated',pop.population_estimated===1234);
    check('all source types present in picker',sourceSelect.options.length===sourceCount);
    window.SourceExplorer.open('fuel_isere');
    check('public source opens without other tables',[...document.querySelectorAll('[data-source-view]')].filter(e=>!e.hidden).length===1&&document.getElementById('public-fuel_isere').open);
    check('fuel data rendered',document.getElementById('public-fuel-results').textContent.includes('Station carburant test'));
    check('declared shortages rendered',document.getElementById('public-fuel-results').textContent.includes('Rupture temporaire déclarée'));
    const fuelSearch=document.getElementById('public-fuel-search');fuelSearch.value='introuvable';fuelSearch.dispatchEvent(new Event('input'));
    check('fuel search works',document.getElementById('public-fuel-results').textContent.includes('Aucune station'));
    fuelSearch.value='';fuelSearch.dispatchEvent(new Event('input'));
    window.SourceExplorer.open('onde_isere');
    check('ONDE campaign date visible',document.getElementById('public-onde-results').textContent.includes('25/09/2026'));
    check('ONDE observation rendered',document.getElementById('public-onde-results').textContent.includes('Assec'));
    window.SourceExplorer.open('catnat_isere');
    const catnat=document.getElementById('public-catnat-commune');catnat.value='38185';catnat.dispatchEvent(new Event('change'));
    for(let i=0;i<50&&!document.getElementById('public-catnat-results').textContent.includes('Historique complet test');i++)await new Promise(r=>setTimeout(r,100));
    check('CatNat reads selected commune history',document.getElementById('public-catnat-results').textContent.includes('Historique complet test'));
    check('regional zero consumption retained',document.getElementById('public-energy-summary').textContent.includes('0 MW'));
    check('regional energy graph rendered',document.querySelector('#public-energy-chart svg'));
    check('recall default excludes other zones',!document.getElementById('public-recalls-results').textContent.includes('Autre zone test'));
    window.SourceExplorer.open('recalls');
    const recall=document.querySelector('[data-public-recall-id="123"]');recall.open=true;
    for(let i=0;i<50&&!document.getElementById('public-recall-detail-123').textContent.includes('LOT-CACHE-TEST');i++)await new Promise(r=>setTimeout(r,100));
    check('recall details loaded from cache',document.getElementById('public-recall-detail-123').textContent.includes('LOT-CACHE-TEST'));
    const scope=document.getElementById('public-recalls-scope');scope.value='unspecified';scope.dispatchEvent(new Event('input'));
    check('other recall scopes remain accessible',document.getElementById('public-recalls-results').textContent.includes('Autre zone test'));
    check('selected source fits viewport',panel.scrollWidth<=panel.clientWidth+2);
    for(const key of ['energy_aura','insee_population','enedis','meteo_radar','vigicrues_forecasts']){window.SourceExplorer.open(key);check('focused source opens: '+key,[...document.querySelectorAll('[data-source-view]')].filter(e=>!e.hidden).length===1&&!document.querySelector('[data-source-view="'+key+'"]').hidden);}
    document.getElementById('source-back').click();
    check('back restores list mode',!document.getElementById('source-catalog').hidden&&document.getElementById('source-catalog-grid').dataset.mode==='list');
    document.querySelector('[data-source-mode="cards"]').click();
    check('cards mode restores full catalogue',document.getElementById('source-catalog-grid').dataset.mode==='cards'&&document.querySelectorAll('.source-choice').length===sourceCount);
    window.SourceExplorer.open('fuel_isere');document.getElementById('public-fuel-search').value='Grenoble';document.getElementById('public-fuel-search').dispatchEvent(new Event('input'));
    window.SourceExplorer.open('onde_isere');window.SourceExplorer.open('fuel_isere');
    check('data filters retained across source navigation',document.getElementById('public-fuel-search').value==='Grenoble');
    for(const service of FLUX_SERVICES){
      window.SourceExplorer.open(service.key,{focus:false});
      const visible=[...document.querySelectorAll('[data-source-view]')].filter(e=>!e.hidden);
      check('single data view for '+service.key,visible.length===1&&visible[0].dataset.sourceView===service.key);
      const link=document.getElementById('source-official-link');
      check('official producer link for '+service.key,!link.hidden&&link.href.startsWith('https://')&&link.target==='_blank'&&link.rel.includes('noopener'));
      check('source detail fits viewport: '+service.key,panel.scrollWidth<=panel.clientWidth+2);
    }
    const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);
    check('source data controls have unique identifiers',ids.length===new Set(ids).size);
    window.SourceExplorer.open('groundwater_isere',{focus:false});
    check('groundwater source keeps its station table',document.getElementById('groundwater-stations').textContent.includes('Nappe de test'));
    window.SourceExplorer.open('sncf_isere',{focus:false});
    check('connected source keeps its real alerts',document.getElementById('sncf-alerts-list').textContent.includes('Travaux ferroviaires de test'));
    window.SourceExplorer.open('prefecture_isere',{focus:false});
    check('news source keeps its publications',document.getElementById('prefecture-news-list').textContent.includes('Publication préfectorale de test'));
    window.SourceExplorer.open('meteo_forets_isere',{focus:false});
    check('forest weather exposes its forecasts',document.getElementById('source-service-extra-meteo_forets_isere').textContent.includes('Élevé'));
    setActivePanel('services-panel',{refreshSnapshot:false});
    check('legacy Services navigation redirects to unified page',localStorage.getItem('activePanel')==='official-sources-panel'&&!panel.hidden);
    document.getElementById('source-back').click();
    await new Promise(r=>setTimeout(r,500));
    for(const mode of ['cards','list']){
      document.querySelector('[data-source-mode="'+mode+'"]').click();
      await new Promise(r=>setTimeout(r,500));
      const grid=document.getElementById('source-catalog-grid');
      const anchor=grid.querySelector('[data-source-open="sncf_isere"]');
      anchor.scrollIntoView({block:'center',behavior:'instant'});
      const position=scrollY, height=grid.getBoundingClientRect().height;
      const cards=[...grid.children];
      const payload={...cachedExternalRisksSnapshot.sncf_isere};
      for(let iteration=0;iteration<5;iteration++){
        window.SourceExplorer.update({sncf_isere:{...payload,updated_at:new Date(Date.now()+iteration*1000).toISOString()}});
        await new Promise(r=>requestAnimationFrame(r));
      }
      check('live updates preserve every card node in '+mode,cards.every((card,index)=>grid.children[index]===card));
      check('live updates preserve scroll position in '+mode,Math.abs(scrollY-position)<=1);
      check('live updates preserve catalogue height in '+mode,Math.abs(grid.getBoundingClientRect().height-height)<=1);
      check('live updates never hide cards in '+mode,[...grid.children].every(card=>getComputedStyle(card).opacity==='1'));
    }
    document.querySelector('[data-source-mode="cards"]').click();
    window.scrollTo({top:0,behavior:'instant'});
    await new Promise(r=>setTimeout(r,200));
    check('new map layers available',document.getElementById('filter-public-fuel')&&document.getElementById('filter-public-onde'));
    check('no uncaught JavaScript errors',window.__smokeErrors.length===0);
  } catch(e) { results.push({name:'unexpected error',pass:false,error:String(e)}); }
  const report=document.createElement('pre');report.id='smoke-results';report.hidden=true;report.textContent=JSON.stringify({results,errors:window.__smokeErrors,metrics:{innerWidth,bodyWidth:document.body.scrollWidth}});document.body.append(report);
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
        if path.startswith("/api/meteo-france/observations/") and path.endswith("/history"):
            return self.send({"history": [{"observed_at": STAMP, "temperature_c": 14.2}]})
        if path == "/dashboard":
            return self.send(BOOTSTRAP["dashboard"])
        if path == "/api/sources/isere":
            return self.send(SOURCES)
        if path == "/api/catnat/isere/history":
            return self.send({"status": "online", "events": [{"id": "TEST_FULL_ORDER", "commune": "Grenoble", "code_insee": "38185", "risk": "Historique complet test", "event_start": "1993-09-09", "event_end": "1993-09-10", "published_at": "1994-02-18"}]})
        if path == "/api/recalls/123":
            return self.send({"status": "online", "item": {"identification": "LOT-CACHE-TEST", "actions": "Consignes publiées de test", "sale_area": "France entière"}})
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
    # Device emulation avoids Edge's minimum native window width on mobile.
    import smoke_vigieau as browser
    browser.Handler = Handler
    output = ROOT / ".test-data/official-sources"
    output.mkdir(parents=True, exist_ok=True)
    if not browser.run(args.browser, args.width, output, height=args.height):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
