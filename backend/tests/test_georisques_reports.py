from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.georisques_reports import BUNDLE, normalize_report, load_report, fetch_report, canonical_report

def payload():
    return {'nat':{'count':1},'techno':{'count':0},'risks':{'cityCode':'38179','type':'commune','hasAdresse':False,'listRisqueType':[
        {'title':'Risques naturels identifiés','sizeList':1,'listRisqueResume':[{'code':'INOND','title':'INONDATION','libelleStatusMunicipality':'Risque Existant','description':'Une description'}]},
        {'title':'Risques technologiques identifiés','sizeList':0,'listRisqueResume':[]}
    ]}}

class OfficialReportTests(unittest.TestCase):
    def test_real_gieres_snapshot_contains_the_seven_natural_and_three_technological_families(self):
        data=json.loads(BUNDLE.read_text(encoding='utf-8'))['38179']
        self.assertEqual(data['natural_total'],7)
        self.assertEqual({r['code'] for r in data['natural']},{'INOND','REMNAPPE','SEISM','MVT','SEC','AVAL','RADON'})
        self.assertEqual(data['technological_total'],3)
        self.assertEqual({r['code'] for r in data['technological']},{'CANA','SSP','RUPTBARR'})
        self.assertNotIn('CAVITE',{r['code'] for r in data['natural']})

    def test_scope_identity_counts_and_duplicate_codes_are_checked(self):
        self.assertEqual(normalize_report(payload(),'38179','source')['natural_total'],1)
        for key,value in [('cityCode','38034'),('type','adresse'),('hasAdresse',True)]:
            data=payload();data['risks'][key]=value
            with self.subTest(key=key), self.assertRaises(ValueError):normalize_report(data,'38179','source')
        data=payload();data['nat']['count']=7
        with self.assertRaises(ValueError):normalize_report(data,'38179','source')
        data=payload();group=data['risks']['listRisqueType'][0];group['listRisqueResume']*=2;group['sizeList']=2;data['nat']['count']=2
        with self.assertRaises(ValueError):normalize_report(data,'38179','source')

    def test_old_snapshot_survives_outage_without_becoming_zero(self):
        save=Mock();get=Mock(side_effect=ConnectionError())
        result=load_report('38179',{},lambda _:None,save,fetch=get)
        self.assertEqual(result['status'],'stale')
        self.assertEqual(result['natural_total'],7)
        self.assertEqual(result['technological_total'],3)
        again=load_report('38179',{},lambda _:result,save,fetch=get)
        self.assertEqual(again,result)
        self.assertEqual(get.call_count,1)

    def test_no_snapshot_does_not_claim_no_risks(self):
        result=load_report('38001',{},lambda _:None,Mock(),fetch=Mock(side_effect=ConnectionError()))
        self.assertEqual(result['status'],'unavailable')
        self.assertNotIn('natural_total',result)

    def test_canonical_redirect_stays_on_the_same_commune_and_host(self):
        def response(raw):
            obj=Mock();obj.__enter__=Mock(return_value=obj);obj.__exit__=Mock();obj.read.return_value=raw;return obj
        page=response(b'<div data-risks-api-params="codeInsee=38179&amp;type=commune"></div>')
        opener=Mock();opener.open.side_effect=[page,response(json.dumps({'redirectUrl':'https://example.org/steal'}).encode())]
        with self.assertRaises(ValueError):fetch_report('38179',{'name':'Gières','postal_code':'38610'},opener=opener,pause=Mock())
        opener.open.side_effect=[page,response(json.dumps({'redirectUrl':'/mes-risques/connaitre-les-risques-pres-de-chez-moi/rapport2/38034/Beaurepaire/commune/38270'}).encode())]
        with self.assertRaises(ValueError):fetch_report('38179',{'name':'Gières','postal_code':'38610'},opener=opener,pause=Mock())

    def test_structured_summary_is_read_without_rendering_upstream_html(self):
        def response(raw):
            obj=Mock();obj.__enter__=Mock(return_value=obj);obj.__exit__=Mock();obj.read.return_value=raw;return obj
        opener=Mock();opener.open.side_effect=[response(b'<div data-risks-api-params="codeInsee=38179"></div>'),response(json.dumps(payload()).encode())]
        result=fetch_report('38179',{'name':'Gières','postal_code':'38610'},opener=opener,pause=Mock())
        self.assertEqual(result['natural_total'],1)
        self.assertNotIn('html',str(result.keys()))

if __name__=='__main__':unittest.main()
