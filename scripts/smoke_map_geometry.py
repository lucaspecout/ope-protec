"""Inspect the real bundled Isere geometry in Leaflet, using local fixture tiles only."""
import argparse
from pathlib import Path
import sys
from urllib.parse import urlsplit

import smoke_hosting as hosting
import smoke_official_sources as base
import smoke_vigieau as browser

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
from app.boundaries import isere_boundary

CHECKS = r'''<script>
(async()=>{
 const results=[],check=(name,pass)=>results.push({name,pass:Boolean(pass)});
 const waitFor=async fn=>{for(let i=0;i<120;i++){if(fn())return true;await new Promise(r=>setTimeout(r,80));}return false;};
 try {
  await waitFor(()=>typeof currentUser!=='undefined'&&currentUser);
  document.querySelectorAll('#map-controls-panel input[type="checkbox"]').forEach(el=>el.checked=false);
  setActivePanel('map-panel',{refreshSnapshot:false});
  await waitFor(()=>window.L&&leafletMap);
  await loadIsereBoundary();
  check('real Leaflet geometry is loaded',Boolean(boundaryLayer&&isereBoundaryGeometry));
  const coordinates=isereBoundaryGeometry.coordinates[0];
  check('official detailed shape replaces schematic hexagon',coordinates.length>1000);
  check('northern Isere is included',boundaryLayer.getBounds().getNorth()>45.8);
  check('western Isere is included',boundaryLayer.getBounds().getWest()<4.9);
  check('Gieres is inside the department',isPointInsideGeometry({lat:45.179,lon:5.79},isereBoundaryGeometry));
  check('Vienne is inside the department',isPointInsideGeometry({lat:45.5256,lon:4.8743},isereBoundaryGeometry));
  check('Lyon is outside the department',!isPointInsideGeometry({lat:45.764,lon:4.8357},isereBoundaryGeometry));
  check('official source and vintage are visible',document.getElementById('map-source').textContent.includes('Etalab')&&document.getElementById('map-source').textContent.includes('2026'));
  await waitFor(()=>document.querySelector('.leaflet-tile-loaded'));
  const tiles=[...document.querySelectorAll('.leaflet-tile')];
  check('local basemap tiles load',tiles.some(tile=>tile.complete&&tile.naturalWidth>0));
  check('tile images explicitly preserve the provider referrer',tiles.length&&tiles.every(tile=>tile.referrerPolicy==='strict-origin-when-cross-origin'));
  check('native tile zoom is capped at 19',mapTileLayer.options.maxNativeZoom===19);
  check('no runtime errors',window.__smokeErrors.length===0);
  setMapControlsCollapsed(true);
 }catch(e){results.push({name:'exception',pass:false,error:String(e.stack||e)});}
 const pre=document.createElement('pre');pre.id='smoke-results';pre.hidden=true;
 pre.textContent=JSON.stringify({results,metrics:{innerWidth,bodyWidth:document.body.scrollWidth},errors:window.__smokeErrors});
 document.body.append(pre);
})();</script>'''

class Handler(hosting.Handler):
    def end_headers(self):
        self.send_header('Referrer-Policy','strict-origin-when-cross-origin')
        super().end_headers()

    def do_GET(self):
        if urlsplit(self.path).path=='/public/isere-map':
            return self.send(isere_boundary())
        return super().do_GET()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--width',type=int,default=1440)
    args=parser.parse_args()
    hosting.prepare_assets(offline=True)
    hosting.CHECKS=CHECKS
    browser.Handler=Handler
    output=base.ROOT/'.test-data/map-geometry';output.mkdir(parents=True,exist_ok=True)
    if not browser.run('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args.width,output):
        raise SystemExit(1)
