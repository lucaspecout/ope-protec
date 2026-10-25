"""Administrative geometry must remain accurate even without external APIs."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.boundaries import BUNDLE, isere_boundary, validate_isere_feature


class IsereBoundaryTests(unittest.TestCase):
    def test_bundled_boundary_is_official_and_detailed(self):
        data = isere_boundary()
        self.assertEqual(data['status'], 'online')
        self.assertIn('etalab-datasets.geo.data.gouv.fr', data['source'])
        self.assertEqual(data['data_vintage'], 2026)
        self.assertEqual(data['generalization_m'], 50)
        self.assertGreater(len(data['geometry']['coordinates'][0]), 1000)

    def test_geometry_contains_actual_isere_towns_and_excludes_lyon(self):
        env = {'Any': Any}
        source = Path(__file__).resolve().parents[1]/'app/services.py'
        import ast
        tree = ast.parse(source.read_text(encoding='utf-8'))
        names = {'_point_in_ring', '_point_in_polygon', '_point_in_geometry'}
        nodes = [node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
        exec(compile(ast.Module(body=nodes,type_ignores=[]),str(source),'exec'),env)
        # Verify this test uses the same point-in-polygon implementation as map filtering.
        geometry = isere_boundary()['geometry']
        inside = lambda lat,lon:env['_point_in_geometry'](lat,lon,geometry)
        for name,lat,lon in [('Grenoble',45.1885,5.7245),('Vienne',45.5256,4.8743),('Bourgoin',45.587,5.281),('Gieres',45.179,5.79)]:
            with self.subTest(town=name):self.assertTrue(inside(lat,lon))
        self.assertFalse(inside(45.764,4.8357))

    def test_network_failure_does_not_replace_boundary_with_hexagon(self):
        with patch('urllib.request.urlopen',side_effect=OSError('offline')):
            geometry = isere_boundary()['geometry']
            self.assertGreater(len(geometry['coordinates'][0]),1000)
        geometry['coordinates'][0].clear()
        self.assertGreater(len(isere_boundary()['geometry']['coordinates'][0]),1000)

    def test_wrong_department_and_schematic_fallback_are_rejected(self):
        feature = json.loads(BUNDLE.read_text(encoding='utf-8'))
        feature['properties']['code'] = '69'
        with self.assertRaises(ValueError):validate_isere_feature(feature)
        feature['properties']['code'] = '38'
        feature['geometry'] = {'type':'Polygon','coordinates':[[[5.09,45.07],[5.63,45.61],[6.45,45.28],[6.35,44.84],[5.73,44.63],[5.15,44.82],[5.09,45.07]]]}
        with self.assertRaises(ValueError):validate_isere_feature(feature)


if __name__=='__main__':unittest.main()
