import sys
from pathlib import Path
import unittest
import re
import unicodedata
from urllib.error import HTTPError, URLError
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.georisques_sources import collect_summary, collect_public_risks
from test_dynamic_provider_credentials import provider_namespace
from test_shared_risk_snapshots import load_definitions


class GeorisquesTests(unittest.TestCase):
    def fetch(self, endpoint, **kwargs):
        if endpoint == 'zonage_sismique':
            return {'content': [{'zoneSismicite': '4', 'typeZone': 'Moyenne'}], 'total_elements': 1}
        if endpoint == 'radon':
            return {'content': [{'codeInsee': '38185', 'classePotentiel': 2}], 'total_elements': 1}
        return {'content': [], 'total_elements': 0}

    def test_partial_failure_keeps_other_themes_and_null_unknown(self):
        def fetch(endpoint, **kwargs):
            if endpoint == 'mvt':
                raise ValueError('private-token')
            return self.fetch(endpoint, **kwargs)
        result = collect_summary({'38185': 'Grenoble'}, 'token', fetch)
        self.assertEqual(result['status'], 'degraded')
        self.assertIsNone(result['ground_movements_total'])
        self.assertEqual(result['cavities_total'], 0)
        self.assertEqual(result['monitored_communes'][0]['radon_class'], '2')
        self.assertNotIn('private-token', str(result))

    def test_seismic_dto_without_code_is_queried_per_commune(self):
        fetch = Mock(side_effect=self.fetch)
        result = collect_summary({'38185': 'Grenoble', '38563': 'Voiron'}, 'token', fetch)
        calls = [c.kwargs['extra_query'] for c in fetch.call_args_list if c.args[0] == 'zonage_sismique']
        self.assertEqual(calls, [{'codesInsee': ['38185']}, {'codesInsee': ['38563']}])
        self.assertEqual(result['highest_seismic_zone_code'], 4)

    def test_stale_data_keeps_original_timestamp_and_is_scoped(self):
        first = collect_summary({'38185': 'Grenoble'}, 'token', self.fetch)
        fail = Mock(side_effect=ValueError('offline'))
        second = collect_summary({'38185': 'Grenoble'}, 'token', fail, first)
        self.assertEqual(second['datasets']['radon']['status'], 'stale')
        self.assertEqual(second['datasets']['radon']['updated_at'], first['datasets']['radon']['updated_at'])
        other = collect_summary({'38563': 'Voiron'}, 'token', fail, first)
        self.assertNotIn('content', other['datasets']['radon'])

    def test_no_communes_never_requests_countrywide_data(self):
        fetch = Mock()
        result = collect_summary({}, 'token', fetch)
        fetch.assert_not_called()
        self.assertEqual(result['status'], 'degraded')

    def test_missing_token_does_not_call_authenticated_api(self):
        fetch = Mock()
        result = collect_summary({'38185': 'Grenoble'}, '', fetch)
        fetch.assert_not_called()
        self.assertIsNone(result['ppr_total'])

    def test_public_risks_real_nested_schema_pagination_and_batches(self):
        codes = [str(38000 + n) for n in range(11)]
        queries = []
        def get(url):
            query = parse_qs(urlsplit(url).query)
            queries.append(query)
            return {'data': [{'code_insee': c, 'risques_detail': [{'libelle_risque_long': 'Inondation'}]} for c in query['code_insee'][0].split(',')], 'total_pages': 2}
        with patch('app.georisques_sources.sleep'):
            result = collect_public_risks(codes, get)
        self.assertEqual(len(queries), 4)
        self.assertTrue(all(len(q['code_insee'][0].split(',')) <= 10 for q in queries))
        self.assertEqual([q['page'][0] for q in queries], ['1','2','1','2'])
        self.assertTrue(all(c['risks'] == ['Inondation'] and c['risk_total'] == 1 for c in result['communes']))

    def test_public_failure_never_becomes_zero_or_low_danger(self):
        with patch('app.georisques_sources.sleep'):
            result = collect_public_risks(['38185'], Mock(side_effect=ValueError('secret')))
        entry = result['communes'][0]
        self.assertIsNone(entry['risk_total'])
        self.assertEqual(entry['status'], 'unavailable')
        self.assertNotIn('secret', str(result))

    def test_v2_auth_failure_is_not_retried_with_speculative_parameters(self):
        ns = provider_namespace()
        ns['_credentialed_http_json'] = Mock(side_effect=ValueError('HTTP 403'))
        with patch('time.sleep'), self.assertRaises(ValueError):
            ns['_fetch_georisques_v2_collection']('mvt', token='token')
        self.assertEqual(ns['_credentialed_http_json'].call_count, 1)

    def test_v2_seismic_has_no_department_parameter(self):
        ns = provider_namespace()
        ns['_credentialed_http_json'] = Mock(return_value={'content': [], 'totalPages': 1, 'totalElements': 0})
        with patch('time.sleep'):
            ns['_fetch_georisques_v2_collection']('zonage_sismique', extra_query={'codesInsee': ['38185']}, token='token')
        query = parse_qs(urlsplit(ns['_credentialed_http_json'].call_args.args[0]).query)
        self.assertNotIn('departement', query)
        self.assertEqual(query['pageNumber'], ['0'])

    def test_v2_rejects_malformed_payload_and_bounds_pagination(self):
        ns = provider_namespace()
        ns['_credentialed_http_json'] = Mock(return_value={'unexpected': []})
        with patch('time.sleep'), self.assertRaises(ValueError):
            ns['_fetch_georisques_v2_collection']('mvt', token='token')
        ns['_credentialed_http_json'] = Mock(return_value={'content': [], 'totalPages': 101, 'totalElements': 101})
        with patch('time.sleep'), self.assertRaises(ValueError):
            ns['_fetch_georisques_v2_collection']('mvt', token='token')
        self.assertEqual(ns['_credentialed_http_json'].call_count, 100)

    def test_public_fallback_works_without_private_token(self):
        get = Mock(return_value={'data': [{'code_insee': '38185', 'risques_detail': [{'libelle_risque_long': 'Inondation'}]}], 'total_pages': 1})
        with patch('app.georisques_sources.sleep'):
            result = collect_summary({'38185': 'Grenoble'}, '', Mock(), public_get=get)
        self.assertEqual(result['monitored_communes'][0]['gaspar_risks'], ['Inondation'])
        self.assertEqual(result['monitored_communes'][0]['datasets']['gaspar/risques']['status'], 'online')
        get.side_effect = ValueError('offline')
        with patch('app.georisques_sources.sleep'):
            stale = collect_summary({'38185': 'Grenoble'}, '', Mock(), result, public_get=get)
        self.assertEqual(stale['monitored_communes'][0]['datasets']['gaspar/risques']['status'], 'stale')
        self.assertEqual(stale['monitored_communes'][0]['gaspar_risks'], ['Inondation'])

    def test_ppr_without_commune_identifier_is_not_attributed(self):
        def fetch(endpoint, **kwargs):
            if endpoint == 'gaspar/pprn':
                return {'content': [{'idGaspar': 'PLAN', 'libPpr': 'Plan'}], 'total_elements': 1}
            return self.fetch(endpoint, **kwargs)
        result = collect_summary({'38185': 'Grenoble'}, 'token', fetch)
        self.assertEqual(result['ppr_total'], 1)
        self.assertNotIn('gaspar/pprn', result['monitored_communes'][0]['datasets'])

    def test_geographic_resolution_is_exact_and_department_scoped(self):
        get = Mock(return_value=[{'nom': 'Grenoble-sur-Loire', 'code': '44001'}, {'nom': 'Grenoble', 'code': '38185'}])
        ns = load_definitions('services.py', {'resolve_commune_insee_code'}, {**globals(), '_http_get_json': get, 'urlencode': __import__('urllib.parse', fromlist=['urlencode']).urlencode})
        self.assertEqual(ns['resolve_commune_insee_code']('Grenoble'), '38185')
        self.assertIn('codeDepartement=38', get.call_args.args[0])
        get.return_value = [{'nom': 'Grenoble-sur-Loire', 'code': '44001'}]
        self.assertIsNone(ns['resolve_commune_insee_code']('Grenoble'))


if __name__ == '__main__':
    unittest.main()
