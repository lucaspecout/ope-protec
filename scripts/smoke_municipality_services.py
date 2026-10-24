"""Exercise commune-specific service tabs against local fixtures in Edge."""
import argparse
from urllib.parse import parse_qs, urlsplit

import smoke_official_sources as base
import smoke_vigieau as browser

COMMUNES = [
    {"id": 1, "name": "Grenoble", "insee_code": "38185", "postal_code": "38000", "phone": "0476000000", "email": "mairie@example.test", "manager": "Mairie", "population": 160000, "pcs_active": True, "crisis_mode": False, "vigilance_color": "vert"},
    {"id": 2, "name": "Échirolles", "insee_code": "38151", "postal_code": "38130", "phone": "0476000001", "email": "mairie2@example.test", "manager": "Mairie", "population": 37000, "pcs_active": True, "crisis_mode": False, "vigilance_color": "vert"},
]
CALLS = []
base.BOOTSTRAP["municipalities"] = COMMUNES
base.RISKS.update({
    "georisques": {"status": "online", "updated_at": base.STAMP, "monitored_communes": [{"code_insee": "38185", "name": "Grenoble", "seismic_zone": "4", "gaspar_risks": ["Inondation communale de test"], "cavities_total": 0}]},
    "industrial_sites": {"status": "online", "updated_at": base.STAMP, "sites": [{"code_insee": "38185", "nom": "ICPE Grenoble locale", "seveso_label": "Non Seveso"}, {"code_insee": "38151", "commune": "Grenoble", "nom": "ICPE AUTRE COMMUNE"}]},
    "fuel_isere": {"status": "online", "updated_at": base.STAMP, "stations": [{"commune": "Grenoble", "postal_code": "38100", "address": "Station Grenoble multi-code-postal", "fuels": [{"fuel": "Gazole", "price_eur": 1.7, "updated_at": base.STAMP}]}, {"commune": "Échirolles", "address": "Station AUTRE COMMUNE", "fuels": []}]},
    "vigieau": {"status": "online", "updated_at": base.STAMP, "complete": True, "alerts": [{"zone": "Zone Grenoble locale", "level": "alerte", "communes": [{"code": "38185", "name": "Grenoble"}], "water_type": "AEP"}, {"zone": "Zone AUTRE COMMUNE", "communes": [{"code": "38151", "name": "Échirolles"}]}]},
    "onde_isere": {"status": "online", "updated_at": base.STAMP, "stations": [{"code_insee": "38185", "river": "Ruisseau local Grenoble", "flow_label": "Assec", "observed_at": "2026-09-25"}, {"code_insee": "38151", "commune": "Grenoble", "river": "Ruisseau AUTRE COMMUNE"}]},
    "finess_isere": {"status": "online", "updated_at": base.STAMP, "resources": [{"name": "Santé Grenoble locale", "city": "Grenoble", "details": {"code_departement": "38", "code_commune": "185"}}, {"name": "Santé AUTRE COMMUNE", "city": "Échirolles"}]},
    "geodae_isere": {"status": "online", "updated_at": base.STAMP, "resources": [{"name": "DAE Grenoble local", "city": "Grenoble"}, {"name": "DAE AUTRE COMMUNE", "city": "Échirolles"}]},
})

INIT = base.INIT.replace("official-sources-panel", "municipalities-panel")
CHECKS = r"""<script>
(async()=>{
 const results=[],check=(name,pass)=>results.push({name,pass:Boolean(pass)});
 const wait=async fn=>{for(let i=0;i<150;i++){if(fn())return true;await new Promise(r=>setTimeout(r,50));}return false;};
 try{
  await wait(()=>typeof currentUser!=='undefined'&&currentUser&&typeof cachedMunicipalities!=='undefined'&&cachedMunicipalities.length===2);
  setActivePanel('municipalities-panel',{refreshSnapshot:false});
  const view=document.querySelector('[data-muni-view="1"], [data-muni-detail="1"]');
  check('commune is accessible from the real municipality page',Boolean(view));
  if(view)view.click();else await openMunicipalityDetailsModal(cachedMunicipalities[0]);
  const modal=document.getElementById('municipality-details-modal'),content=document.getElementById('municipality-details-content');
  await wait(()=>modal.open&&content.querySelector('[data-muni-tab="water"]'));
  check('commune dialog opens',modal.open);
  check('four service tabs added',content.querySelectorAll('[data-muni-service-body]').length===4);
  const initial=await(await fetch('/__fixture/commune-calls')).json();
  check('service APIs are lazy before a service tab is selected',initial.length===0);
  const tab=key=>content.querySelector('[data-muni-tab="'+key+'"]').click();
  const body=key=>content.querySelector('[data-muni-service-body="'+key+'"]');
  tab('risks');await wait(()=>body('risks').textContent.includes('ICPE Grenoble locale'));
  check('communal Georisques details displayed',body('risks').textContent.includes('Inondation communale de test'));
  check('communal industrial reference displayed',body('risks').textContent.includes('ICPE Grenoble locale'));
  check('other commune ICPE excluded even with same text name',!body('risks').textContent.includes('AUTRE COMMUNE'));
  tab('water');await wait(()=>body('water').textContent.includes('Analyse Grenoble locale'));
  check('communal drinking water analysis loaded',body('water').textContent.includes('Analyse Grenoble locale'));
  check('numerical zero analysis retained',body('water').textContent.includes('0 mg/L'));
  check('communal annual water service loaded',body('water').textContent.includes('Réseau Grenoble local'));
  check('local VigiEau restriction displayed',body('water').textContent.includes('Zone Grenoble locale'));
  check('local ONDE observation displayed',body('water').textContent.includes('Ruisseau local Grenoble'));
  check('local groundwater observation displayed',body('water').textContent.includes('Nappe de test'));
  check('other commune water data excluded',!body('water').textContent.includes('AUTRE COMMUNE'));
  const before=await(await fetch('/__fixture/commune-calls')).json();
  tab('fiche');tab('water');
  const after=await(await fetch('/__fixture/commune-calls')).json();
  check('revisiting a loaded tab does not duplicate requests',before.length===after.length);
  tab('resources');await wait(()=>body('resources').textContent.includes('Station Grenoble multi-code-postal'));
  check('commune with several postal codes keeps its stations',body('resources').textContent.includes('Station Grenoble multi-code-postal'));
  check('communal FINESS resource displayed',body('resources').textContent.includes('Santé Grenoble locale'));
  check('communal DAE displayed',body('resources').textContent.includes('DAE Grenoble local'));
  check('other commune resources excluded',!body('resources').textContent.includes('AUTRE COMMUNE'));
  tab('catnat');await wait(()=>body('catnat').textContent.includes('Inondation Grenoble historique'));
  check('full communal CatNat read from local endpoint',body('catnat').textContent.includes('Inondation Grenoble historique'));
  check('other commune CatNat records excluded',!body('catnat').textContent.includes('AUTRE COMMUNE'));
  check('each data section links to its official source',body('catnat').querySelector('a[rel="noopener noreferrer"]'));
  check('dialog fits viewport',modal.getBoundingClientRect().width<=innerWidth+2);
  check('tab buttons fit available width',content.querySelector('.muni-detail-tabs').scrollWidth<=content.querySelector('.muni-detail-tabs').clientWidth+2);
  check('service content fits dialog',content.scrollWidth<=content.clientWidth+2);
  check('original operational tabs remain available',['fiche','events','mco'].every(key=>content.querySelector('[data-muni-tab="'+key+'"]')));
  await openMunicipalityDetailsModal(cachedMunicipalities.find(m=>m.id===2));tab('water');
  await wait(()=>body('water').textContent.includes('Analyse Échirolles locale'));
  check('changing commune loads its own water data',body('water').textContent.includes('Analyse Échirolles locale')&&!body('water').textContent.includes('Analyse Grenoble locale'));
  closeMunicipalityDetailsModal();await wait(()=>!modal.open);
  check('dialog still closes normally',!modal.open);
  const pendingA=openMunicipalityDetailsModal(cachedMunicipalities.find(m=>m.id===1));
  const pendingB=openMunicipalityDetailsModal(cachedMunicipalities.find(m=>m.id===2));
  await Promise.all([pendingA,pendingB]);
  check('latest selected commune wins overlapping openings',content.querySelector('.muni-detail-hero h4').textContent==='Échirolles');
  closeMunicipalityDetailsModal();await wait(()=>!modal.open);
  await openMunicipalityDetailsModal(cachedMunicipalities.find(m=>m.id===1));tab('water');
  await wait(()=>body('water').textContent.includes('Analyse Grenoble locale'));
  content.scrollTop=0;
  check('no uncaught JavaScript errors',window.__smokeErrors.length===0);
 }catch(e){results.push({name:'unexpected error',pass:false,error:String(e),stack:e.stack});}
 const report=document.createElement('pre');report.id='smoke-results';report.hidden=true;
 report.textContent=JSON.stringify({results,metrics:{innerWidth,bodyWidth:document.body.scrollWidth},errors:window.__smokeErrors});document.body.append(report);
})();</script>"""


class Handler(base.Handler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/index.html"):
            html = (base.ROOT / "web/index.html").read_text(encoding="utf-8")
            return self.send(html.replace("<head>", "<head>" + INIT).replace("</body>", CHECKS + "</body>").encode(), "text/html; charset=utf-8")
        if path == "/__fixture/commune-calls":
            return self.send(CALLS)
        if path == "/municipalities":
            return self.send(COMMUNES)
        if path.startswith("/municipalities/") and path.endswith("/public-services"):
            return self.send({"municipality_contacts": [], "emergency_numbers": []})
        if path.startswith("/municipalities/") and path.endswith(("/water-quality", "/water-services", "/georisques-risks")):
            CALLS.append(self.path)
            commune = COMMUNES[int(path.split("/")[2]) - 1]
            common = {"status": "online", "updated_at": base.STAMP, "code_commune": commune["insee_code"]}
            if path.endswith("/water-quality"):
                return self.send({**common, "items": [{"libelle_parametre": f"Analyse {commune['name']} locale", "resultat_numerique": 0, "libelle_unite": "mg/L", "date_prelevement": base.STAMP}]})
            if path.endswith("/water-services"):
                return self.send({**common, "items": [{"nom_service": f"Réseau {commune['name']} local", "annee": 2025, "prix_ttc_m3": 3.5}]})
            return self.send({**common, "code_insee": commune["insee_code"], "risks": ["Risque communal de test"]})
        if path == "/api/catnat/isere/history":
            CALLS.append(self.path)
            query = parse_qs(urlsplit(self.path).query)
            return self.send({"status": "online", "code_insee": query.get("code_insee", [""])[0], "checked_at": base.STAMP, "events": [{"code_insee": "38185", "risk": "Inondation Grenoble historique", "published_at": "2026-10-01", "id": "TEST-CATNAT"}, {"code_insee": "38151", "risk": "AUTRE COMMUNE"}]})
        return super().do_GET()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', default='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
    parser.add_argument('--width', type=int)
    args = parser.parse_args()
    browser.Handler = Handler
    output = base.ROOT / '.test-data/municipality-services'
    output.mkdir(parents=True, exist_ok=True)
    success = True
    for width in [args.width] if args.width else [1440, 390]:
        CALLS.clear()
        success = browser.run(args.browser, width, output) and success
    if not success:
        raise SystemExit(1)
