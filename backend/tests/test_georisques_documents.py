import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.georisques_documents import enrich_commune, identities

class CommuneDocumentsTests(unittest.TestCase):
    def test_report_identity_comes_from_official_commune_code(self):
        result = enrich_commune({'code_insee':'38310','name':'Polienas'})
        self.assertEqual(result['official_name'],'Poliénas')
        self.assertEqual(result['postal_code'],'38210')
        self.assertTrue(44 < result['latitude'] < 47)
        self.assertTrue(4 < result['longitude'] < 7)
        self.assertEqual(len(identities()),512)

    def test_municipal_dicrim_does_not_leak_into_another_commune(self):
        gieres=enrich_commune({'code_insee':'38179'})
        polienas=enrich_commune({'code_insee':'38310'})
        self.assertEqual(gieres['dicrim']['status'],'document_available')
        self.assertTrue(any('images/cadre-de-vie/dicrim.pdf' in d['url'] and d['year']=='2026' for d in gieres['documents']))
        self.assertFalse(any(d['kind']=='DICRIM' for d in polienas['documents']))
        self.assertEqual(polienas['dicrim']['status'],'not_verified')

    def test_metadata_does_not_claim_a_downloadable_pdf(self):
        result=enrich_commune({'code_insee':'38310','datasets':{'gaspar/dicrim':{'content':[{'anneePublication':'2020'}]}}})
        self.assertEqual(result['dicrim']['status'],'listed')
        self.assertFalse(any(d['format']=='pdf' and d['scope']=='commune' for d in result['documents']))

    def test_ppr_documents_require_explicit_local_membership_and_safe_identifier(self):
        result=enrich_commune({'code_insee':'38179','datasets':{'gaspar/pprn':{'content':[
            {'idGaspar':'38DDT20070001','libPpr':'Local','communes':[{'codeInsee':'38179','etat':'Opposable'}]},
            {'idGaspar':'38DDT20070002','libPpr':'Other','communes':[{'codeInsee':'38034'}]},
            {'idGaspar':'../private','communes':[{'codeInsee':'38179'}]},
        ]}}})
        plans=[d for d in result['documents'] if d['kind']=='PPRN']
        self.assertEqual(len(plans),1)
        self.assertEqual(plans[0]['state'],'Opposable')
        self.assertTrue(plans[0]['url'].endswith('/pprn/38DDT20070001'))

    def test_invalid_code_does_not_select_another_towns_documents(self):
        result=enrich_commune({'code_insee':'38179/../38436'})
        self.assertNotIn('documents',result)

    def test_nested_v2_plan_state_is_readable(self):
        result=enrich_commune({'code_insee':'38179','datasets':{'gaspar/pprn':{'content':[
            {'idGaspar':'38DDT20070001','communes':[{'codeInsee':'38179','etat':{'libelle':'Opposable','date':'2020-01-01'}}]}
        ]}}})
        plan=next(d for d in result['documents'] if d['kind']=='PPRN')
        self.assertEqual(plan['state'],'Opposable')
        self.assertEqual(plan['state_date'],'2020-01-01')

if __name__=='__main__':unittest.main()
