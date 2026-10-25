import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.georisques_files import BUNDLE, load_references, parse_gaspar, parse_radon, parse_seismic, load_brgm
from app.georisques_sources import collect_summary, failure_message


class OfficialReferencesTests(unittest.TestCase):
    def archive(self, files):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as z:
            for name, body in files.items():
                z.writestr(name, body)
        return buffer.getvalue()

    def test_gaspar_scopes_and_deduplicates_plans(self):
        raw = self.archive({'pprn_gaspar_2026-10-05.csv':
            'CODE INSEE COMMUNE;NOM COMMUNE;CODE PROCEDURE;LIBELLE PROCEDURE;LIBELLE RISQUE 1\n'
            '38185;Grenoble;P1;Plan Isere;Inondation\n38179;Gieres;P1;Plan Isere;Inondation\n69000;Lyon;P2;Autre;Inondation\n'})
        result = parse_gaspar(raw)
        plan = result['gaspar/pprn']
        self.assertEqual(plan['total_elements'], 1)
        self.assertEqual(len(plan['content'][0]['communes']), 2)
        self.assertEqual(plan['data_date'], '2026-10-05')
        self.assertNotIn('gaspar/pprt', result)

    def test_invalid_csv_does_not_become_successful_empty_collection(self):
        with self.assertRaises(ValueError):
            parse_gaspar(self.archive({'pprn_gaspar_2026-10-05.csv': 'wrong;columns\nx;y\n'}))
        with self.assertRaises(ValueError):
            parse_radon(b'wrong;columns\nx;y\n')

    def test_radon_preserves_published_reference_date(self):
        result = parse_radon(b'nom_comm;insee_com;classe_potentiel\nGrenoble;38185;1\nLyon;69000;3\n')
        self.assertEqual(result['radon']['total_elements'], 1)
        self.assertEqual(result['radon']['data_date'], '2019-05-06')

    def test_missing_seismic_feature_is_not_invented(self):
        with self.assertRaises(ValueError):
            parse_seismic(b'<FeatureCollection numberMatched="0"/>')

    def test_brgm_reads_next_page_and_requires_stable_unique_features(self):
        def raw(start, size):
            return ('<FeatureCollection>' + ''.join(f'<MVT_LOCALISE><num_insee>38185</num_insee><id_mvt>{n}</id_mvt><type_mvt>1</type_mvt></MVT_LOCALISE>' for n in range(start, start+size)) + '</FeatureCollection>').encode()
        get = Mock(side_effect=[raw(0,500), raw(500,1)])
        data = load_brgm('MVT_LOCALISE', get)['mvt']
        self.assertEqual(data['total_elements'],501)
        self.assertIn('STARTINDEX=500',get.call_args.args[0])
        self.assertIn('SORTBY=id_mvt',get.call_args.args[0])
        self.assertIn('non localis',data['coverage_note'])
        with self.assertRaises(ValueError):
            load_brgm('MVT_LOCALISE',Mock(side_effect=[raw(0,500),raw(0,1)]))

    def test_offline_start_has_real_bundled_references(self):
        save = Mock()
        result = load_references(lambda _: None, save, get=Mock(side_effect=ConnectionError()))
        self.assertGreater(result['mvt']['total_elements'],1000)
        self.assertGreater(result['cavites']['total_elements'],1000)
        self.assertEqual(result['zonage_sismique']['total_elements'],512)
        self.assertEqual(result['mvt']['status'],'fallback')
        save.assert_called_once()

    def test_screenshot_communes_have_data_even_when_v2_is_refused(self):
        references = json.loads(BUNDLE.read_text(encoding='utf-8'))['datasets']
        fetch = Mock(side_effect=ValueError('API fournisseur indisponible (HTTP 403)'))
        loader = Mock(return_value=references)
        codes = {'38436':'Saint-Paul-de-Varces','38310':'Polienas','38034':'Beaurepaire','38179':'Gieres'}
        result = collect_summary(codes, 'secret-token', fetch, reference_loader=loader)
        self.assertEqual(fetch.call_count,1)
        self.assertEqual(loader.call_count,1)
        self.assertEqual(sum(d['status']=='fallback' for d in result['datasets'].values()),10)
        self.assertEqual(len(result['errors']),2)
        communes = {c['code_insee']:c for c in result['monitored_communes']}
        self.assertEqual(communes['38436']['ground_movements_total'],12)
        self.assertEqual(communes['38179']['cavities_total'],2)
        self.assertEqual(communes['38034']['seismic_zone'],'3')
        self.assertTrue(all(c['gaspar_risks'] for c in communes.values()))
        self.assertNotIn('secret-token',str(result))
        # Fallback PPR records carry commune codes, so local plans are attributable.
        self.assertIn('gaspar/pprn', communes['38179']['datasets'])
        for data in result['datasets'].values():
            for row in data.get('content',[]):
                self.assertTrue(not row.get('codeInsee') or row['codeInsee'] in codes)
                self.assertTrue(all(c['codeInsee'] in codes for c in row.get('communes',[])))

    def test_error_reason_is_actionable_and_does_not_echo_private_data(self):
        self.assertIn('Jeton refus', failure_message(ValueError('HTTP 401 https://provider/?key=secret')))
        self.assertNotIn('secret', failure_message(ValueError('HTTP 401 https://provider/?key=secret')))
        self.assertIn('Quota', failure_message(ValueError('HTTP 429')))
        self.assertIn('Connexion', failure_message(ConnectionError()))


if __name__ == '__main__':
    unittest.main()
