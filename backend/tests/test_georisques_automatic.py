"""Adding a commune triggers collection; no predefined report list is required."""
import ast
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.georisques_documents import resolve_identity, enrich_commune
from app.georisques_reports import BUNDLE, load_report, discover_dicrim
from test_shared_risk_snapshots import load_definitions

MAIN=Path(__file__).resolve().parents[1]/'app/main.py'
def main_functions(names, namespace):
    tree=ast.parse(MAIN.read_text(encoding='utf-8-sig'))
    nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
    for n in nodes:n.decorator_list=[]
    future=ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future,*nodes],type_ignores=[])),str(MAIN),'exec'),namespace)
    return namespace

class Municipality:
    name='name'
    def __init__(self,**values):self.__dict__.update({'insee_code':None,'postal_code':None,**values})
class Database:
    def __init__(self):self.rows=[];self.events=[]
    def add(self,row):self.rows.append(row)
    def commit(self):self.events.append('commit')
    def refresh(self,row):self.events.append('refresh')
    def get(self,*args):return self.rows[0]
    def query(self,*args):return self
    def order_by(self,*args):return self
    def all(self):return self.rows

class AutomaticCommuneTests(unittest.TestCase):
    def test_creation_and_identity_change_queue_collection_after_commit(self):
        db=Database()
        ns=main_functions({'create_municipality','update_municipality','_georisques_commune_records'}, {
            'Municipality':Municipality,'Depends':lambda _:None,'get_db':lambda:None,'require_roles':lambda *args:None,'EDIT_ROLES':('admin',),
            'resolve_commune_insee_code':Mock(return_value='38563'), '_queue_georisques_collection':lambda:db.events.append('queued')})
        data=Mock();data.model_dump.return_value={'name':'Voiron','postal_code':'38500','pcs_active':False}
        created=ns['create_municipality'](data,db,None)
        self.assertEqual(db.events,['commit','refresh','queued'])
        self.assertEqual(created.insee_code,'38563')
        self.assertEqual(ns['_georisques_commune_records'](db),[{'name':'Voiron','insee_code':'38563','postal_code':'38500'}])
        db.events.clear();data.model_dump.return_value={'name':'Voiron corrigée'}
        ns['update_municipality'](1,data,db,None)
        self.assertEqual(db.events,['commit','refresh','queued'])
        db.events.clear();data.model_dump.return_value={'population':20000}
        ns['update_municipality'](1,data,db,None)
        self.assertEqual(db.events,['commit','refresh'])

    def test_registered_insee_is_used_without_fuzzy_name_search(self):
        result={'monitored_communes':[{'name':'Voiron','code_insee':'38563'}],'errors':[]}
        collect=Mock(return_value=result)
        ns=load_definitions('services.py',{'_fetch_georisques_isere_summary_live'}, {
            '__name__':'app.services', '__package__':'app',
            're':re,'resolve_credentials':lambda _: {'token':''},'CredentialStoreError':ValueError,
            '_resolve_commune_insee_codes':Mock(side_effect=AssertionError('Must use registered INSEE')),
            'resolve_commune_insee_code':Mock(side_effect=AssertionError('Must use registered INSEE')),
            '_file_cache_load':Mock(return_value=None),'_file_cache_save':Mock(),
            '_http_get_json':Mock(),'_fetch_georisques_v2_collection':Mock()})
        identity={'name':'Voiron','postal_code':'38500','latitude':45.36,'longitude':5.59}
        report={'code_insee':'38563','scope':'commune','natural_total':6,'technological_total':2}
        with patch('app.georisques_sources.collect_summary',collect), patch('app.georisques_documents.resolve_identity',return_value=identity), patch('app.georisques_reports.load_report',return_value=report):
            got=ns['_fetch_georisques_isere_summary_live'](commune_records=[{'name':'Voiron','insee_code':'38563','postal_code':'38500'}])
        self.assertEqual(collect.call_args.args[0],{'38563':'Voiron'})
        self.assertEqual(got['monitored_communes'][0]['official_report'],report)

    def test_new_commune_without_bundled_report_is_fetched_and_cached(self):
        self.assertNotIn('38563',json.loads(BUNDLE.read_text(encoding='utf-8')))
        report={'schema_version':2,'code_insee':'38563','scope':'commune','status':'online','natural_total':6,'technological_total':2,'updated_at':datetime.now(timezone.utc).isoformat()}
        get=Mock(return_value=report);save=Mock()
        self.assertEqual(load_report('38563',{'name':'Voiron','postal_code':'38500'},lambda _:None,save,fetch=get),report)
        get.assert_called_once_with('38563',{'name':'Voiron','postal_code':'38500'})
        self.assertEqual(load_report('38563',{},lambda _:report,save,fetch=get),report)
        self.assertEqual(get.call_count,1)

    def test_live_identity_is_requested_before_static_reference(self):
        fresh={'name':'Voiron','postal_code':'38500','updated_at':datetime.now(timezone.utc).isoformat()}
        fetch=Mock(return_value=fresh);save=Mock()
        self.assertEqual(resolve_identity('38563',lambda _:None,save,fetch=fetch),fresh)
        fetch.assert_called_once_with('38563')

    def test_dicrim_is_discovered_from_new_communes_official_page(self):
        response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock();response.read.return_value=b'%PDF-'
        opener=Mock();opener.open.return_value=response
        page='<a href="/DICRIM/38563">DICRIM Voiron</a><a href="/DICRIM/38179">Other commune</a><a href="http://localhost/private.pdf">Bad</a>'
        documents=discover_dicrim(page,'38563',opener)
        self.assertEqual(len(documents),1)
        self.assertEqual(documents[0]['code_insee'],'38563')
        self.assertEqual(documents[0]['discovery'],'official_report')
        self.assertTrue(documents[0]['url'].endswith('/DICRIM/38563'))
        enriched=enrich_commune({'code_insee':'38563','official_report':{'documents':documents}})
        self.assertEqual(enriched['dicrim']['status'],'document_available')
        self.assertTrue(any(d['url'].endswith('/DICRIM/38563') for d in enriched['documents']))

    def test_refresh_is_coalesced_through_existing_coordinator(self):
        queue=Mock()
        ns=main_functions({'_queue_georisques_collection'},{'_refresh_after_credentials_change':queue})
        ns['_queue_georisques_collection']()
        queue.assert_called_once_with('georisques')

if __name__=='__main__':unittest.main()
