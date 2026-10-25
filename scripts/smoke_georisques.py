"""Exercise enriched Géorisques views with schema-shaped local fixtures."""
import argparse
import sys
from pathlib import Path
import smoke_official_sources as base
import smoke_vigieau as browser

sys.path.insert(0, str(base.ROOT / 'backend'))
from app.georisques_sources import collect_summary


def fixture(endpoint, **kwargs):
    rows = []
    if endpoint == 'mvt':
        rows = [{'codeInsee': '38185', 'type': 'Glissement de terrain', 'lieu': 'Versant de test', 'dateDebut': '2001-02-03', 'fiabilite': 'Bonne', 'identifiant': f'MVT-{i}'} for i in range(22)]
    elif endpoint == 'cavites':
        raise ValueError('Fixture unavailable')
    elif endpoint == 'radon':
        rows = [{'codeInsee': '38185', 'libelleCommune': 'Grenoble', 'classePotentiel': 2}]
    elif endpoint == 'zonage_sismique':
        rows = [{'zoneSismicite': '4' if kwargs['extra_query']['codesInsee'] == ['38185'] else '3', 'typeZone': 'Moyenne'}]
    elif endpoint == 'gaspar/pprn':
        rows = [{'idGaspar': 'PPR-TEST', 'libPpr': 'Plan de prévention de test', 'dateModification': '2024-01-01'}]
    elif endpoint.startswith('gaspar/') and endpoint != 'gaspar/dicrim':
        rows = [{'libelle': 'Dossier Grenoble de test', 'communes': [{'codeInsee': '38185', 'aleas': [{'libelle': 'Inondation'}]}]}]
    return {'content': rows, 'total_elements': len(rows)}


base.RISKS['georisques'] = collect_summary({'38185': 'Grenoble', '38563': 'Voiron'}, 'fixture', fixture)
base.BOOTSTRAP['municipalities'] = [{'id': i+1, 'name': name, 'insee_code': code, 'pcs_active': True, 'postal_code': '38000'} for i, (code, name) in enumerate([('38185', 'Grenoble'), ('38563', 'Voiron')])]
base.INIT = base.INIT.replace('official-sources-panel', 'georisques-panel')
base.CHECKS = r'''<script>
(async()=>{
 const results=[],check=(name,pass)=>results.push({name,pass:Boolean(pass)});
 const wait=async fn=>{for(let i=0;i<150;i++){if(fn())return true;await new Promise(r=>setTimeout(r,50));}return false;};
 try {
  await wait(()=>document.querySelectorAll('#georisques-pcs-select option').length===3);
  setActivePanel('georisques-panel',{refreshSnapshot:false});
  const select=document.getElementById('georisques-pcs-select'),detail=document.getElementById('georisques-pcs-detail');
  check('six scoped summary cards',document.querySelectorAll('.geo-summary .tile').length===6);
  check('partial collection error visible',document.querySelector('.geo-api-details summary').textContent.includes('source'));
  select.value='38185';select.dispatchEvent(new Event('change'));
  check('selected commune details',detail.textContent.includes('Grenoble')&&detail.textContent.includes('Versant de test'));
  check('unknown cavities are not zero', [...detail.querySelectorAll('.geo-data-section')].find(s=>s.textContent.includes('Cavités')).textContent.includes('—'));
  check('radon and individual seismic zone',detail.textContent.includes('Classe de potentiel')&&detail.textContent.includes('Zone de sismicité'));
  check('official report carries exact INSEE',detail.querySelector('a').href.includes('codeInsee=38185'));
  check('large list starts collapsed',detail.querySelectorAll('[data-geo-extra][hidden]').length===2);
  detail.querySelector('[data-geo-more]').click();
  check('all movement records accessible',detail.querySelectorAll('[data-geo-extra][hidden]').length===0);
  detail.querySelector('[data-geo-tab="prevention"]').click();
  check('PAPI TRI and TIM details',detail.textContent.includes('Programmes')&&detail.textContent.includes('Territoires')&&detail.textContent.includes('Transmission'));
  check('TIM is not dangerous-goods transport',!detail.textContent.includes('matières dangereuses'));
  check('PPR lists available with honest scope',document.getElementById('georisques-rich-overview').textContent.includes('Plan de prévention de test'));
  detail.querySelector('[data-geo-tab="history"]').click();
  check('local CatNat and industrial sites',detail.textContent.includes('Inondation de test')&&detail.textContent.includes('Usine test officielle'));
  detail.querySelector('[data-geo-history]').click();
  check('full history endpoint works',await wait(()=>detail.textContent.includes('Historique complet test')));
  select.value='38563';select.dispatchEvent(new Event('change'));
  check('other commune does not inherit sites or events',!detail.textContent.includes('Usine test officielle')&&!detail.textContent.includes('Inondation de test'));
  detail.querySelector('[data-geo-tab="natural"]').click();
  check('other commune does not inherit movements',!detail.textContent.includes('Versant de test'));
  select.value='38185';select.dispatchEvent(new Event('change'));
  check('no false low hazard label',!detail.textContent.includes('danger faible'));
  check('no horizontal overflow',document.documentElement.scrollWidth<=innerWidth+1);
  check('no runtime errors',window.__smokeErrors.length===0);
 } catch(e){results.push({name:'exception',pass:false,error:String(e.stack||e)});}
 const pre=document.createElement('pre');pre.id='smoke-results';pre.textContent=JSON.stringify({results,errors:window.__smokeErrors,metrics:{innerWidth,bodyWidth:document.body.scrollWidth}});pre.style.display='none';document.body.appendChild(pre);
})();
</script>'''


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--width', type=int, default=1440)
    parser.add_argument('--height', type=int, default=1080)
    parser.add_argument('--official-references', action='store_true')
    args = parser.parse_args()
    if args.official_references:
        import json
        from app.georisques_files import BUNDLE
        codes = {'38436':'Saint-Paul-de-Varces','38310':'Poliénas','38034':'Beaurepaire','38179':'Gières'}
        def fail(*args, **kwargs):
            raise ConnectionError('API unavailable')
        references = json.loads(BUNDLE.read_text(encoding='utf-8'))['datasets']
        base.RISKS['georisques'] = collect_summary(codes, 'fixture', fail, reference_loader=lambda: references)
        base.BOOTSTRAP['municipalities'] = [{'id':i+1,'name':name,'insee_code':code,'pcs_active':True} for i,(code,name) in enumerate(codes.items())]
        base.CHECKS = r'''<script>
(async()=>{
const results=[],check=(name,pass)=>results.push({name,pass:Boolean(pass)});
const wait=async fn=>{for(let i=0;i<150;i++){if(fn())return true;await new Promise(r=>setTimeout(r,50));}return false;};
try {
 await wait(()=>document.querySelectorAll('#georisques-pcs-select option').length===5);
 setActivePanel('georisques-panel',{refreshSnapshot:false});
 const root=document.getElementById('georisques-pcs-detail'),summary=document.getElementById('georisques-rich-overview'),select=document.getElementById('georisques-pcs-select');
 const choose=code=>{select.value=code;select.dispatchEvent(new Event('change'));};
 check('ten themes restored',summary.textContent.includes('10 / 12'));
 check('only two unavailable themes',summary.textContent.includes('2 source(s) encore'));
 check('official fallback explicitly identified',summary.textContent.includes('Mode secours actif'));
 check('first commune automatically visible',Boolean(root.querySelector('.geo-tabs')));
 choose('38436');
 check('Saint Paul real movements',root.textContent.includes('Saint-Paul-de-Varces')&&root.textContent.includes('Code BRGM'));
 check('real movement count', [...root.querySelectorAll('.geo-data-section')].some(s=>s.querySelector('h4')?.textContent.includes('Mouvements')&&s.querySelector('strong')?.textContent==='12'));
 check('geographic inventory limits visible',root.textContent.includes('non localis'));
 check('source dates do not claim recent radon data',root.textContent.includes('2019-05-06'));
 check('official source links present',root.querySelectorAll('a[target="_blank"]').length>=4);
 root.querySelector('[data-geo-tab="prevention"]').click();
 check('real risks exposed',root.textContent.includes('Inondation'));
 check('PPR visible per commune from official export',root.textContent.includes('Plans de pr'));
 choose('38179');root.querySelector('[data-geo-tab="natural"]').click();
 check('Gieres real cavities', [...root.querySelectorAll('.geo-data-section')].some(s=>s.querySelector('h4')?.textContent.includes('Cavit')&&s.querySelector('strong')?.textContent==='2'));
 choose('38034');
 check('Beaurepaire does not inherit Gieres movement count', [...root.querySelectorAll('.geo-data-section')].some(s=>s.querySelector('h4')?.textContent.includes('Mouvements')&&s.querySelector('strong')?.textContent==='0'));
 choose('38310');
 check('Polienas uses exact commune data',root.textContent.includes('38310')&&root.textContent.includes('Code BRGM'));
 check('no runtime errors',window.__smokeErrors.length===0);
 check('no horizontal overflow',document.documentElement.scrollWidth<=innerWidth+1);
}catch(e){results.push({name:'exception',pass:false,error:String(e.stack||e)});}
const pre=document.createElement('pre');pre.id='smoke-results';pre.hidden=true;pre.textContent=JSON.stringify({results,metrics:{innerWidth,bodyWidth:document.body.scrollWidth},errors:window.__smokeErrors});document.body.appendChild(pre);
})();</script>'''
    browser.Handler = base.Handler
    output = base.ROOT / ('.test-data/georisques-references' if args.official_references else '.test-data/georisques')
    output.mkdir(parents=True, exist_ok=True)
    if not browser.run('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args.width, output, height=args.height):
        raise SystemExit(1)
