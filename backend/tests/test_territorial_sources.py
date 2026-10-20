"""Territorial feeds: real geometry math and offline official-format fixtures."""
import io
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import territorial_sources as sources


HAS_GEO = all(importlib.util.find_spec(name) for name in ("pyproj", "shapely"))


class SourceTestCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.settings = SimpleNamespace(static_data_dir=self.directory.name)
        self.mock_settings = patch.object(sources, "_settings", return_value=self.settings)
        self.mock_settings.start()
        sources._grid_memory.clear()
        sources._industrial_memory.clear()

    def tearDown(self):
        self.mock_settings.stop()
        self.directory.cleanup()

    def save_grid(self, cells=None, bounds=None):
        payload = {"schema_version": 1, "updated_at": sources._now(), "projected_bounds": bounds or [4000000, 2400000, 4000400, 2400400],
                   "cells": cells or [[4000000, 2400000, 100, 40, 20, 30, 5, 1]], "imputed_cells_total": 1}
        sources._write_json(sources._path(sources._GRID_FILENAME), payload)
        return payload


class GridImportTests(SourceTestCase):
    def test_stream_parser_filters_coordinates_and_retains_imputation_and_ages(self):
        stream = io.StringIO("idcar_200m;ind;men;ind_0_3;ind_4_5;ind_6_10;ind_11_17;ind_65_79;ind_80p;i_est_200\n"
                             "CRS3035RES200mN2400000E4000000;100;40;1;2;3;4;12;8;1\n"
                             "CRS3035RES200mN2400400E4000000;90;30;1;2;3;4;10;5;0\n"
                             "CRS2975RES200mN2400000E4000000;90;30;1;2;3;4;10;5;0\n")
        cells, imputed = sources._parse_grid_csv(stream, [4000000, 2400000, 4000400, 2400400])
        self.assertEqual(cells, [[4000000, 2400000, 100, 40, 10, 20, 8, 1]])
        self.assertEqual(imputed, 1)

    def test_incomplete_local_population_is_rejected_instead_of_silently_missing_people(self):
        stream = io.StringIO("idcar_200m;ind\nCRS3035RES200mN2400000E4000000;100\n")
        with self.assertRaisesRegex(ValueError, "démographiques"):
            sources._parse_grid_csv(stream, [4000000, 2400000, 4000400, 2400400])

    def test_zip_import_uses_local_archive_and_publishes_metadata_only(self):
        path = Path(self.directory.name) / "source.zip"
        content = "idcar_200m;ind;men;ind_0_3;ind_4_5;ind_6_10;ind_11_17;ind_65_79;ind_80p;i_est_200\nCRS3035RES200mN2400000E4000000;100;40;1;2;3;4;12;8;1\n"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("Filosofi2021_carreaux_200m_metropole.csv", content)
        self.settings.insee_population_local_path = str(path)
        with patch.object(sources, "_projected_import_bounds", return_value=[4000000, 2400000, 4000400, 2400400]), patch.object(sources, "_download") as download:
            result = sources.fetch_insee_population_grid()
        self.assertEqual(result["status"], "online")
        self.assertEqual(result["cells_total"], 1)
        self.assertNotIn("cells", result)
        download.assert_not_called()
        self.assertTrue(path.exists(), "A user-supplied source must never be deleted")

    def test_cold_analysis_has_no_network_and_does_not_claim_zero_population(self):
        with patch.object(sources, "_download") as download, patch.object(sources, "fetch_insee_population_grid") as importer:
            result = sources.estimate_insee_population({"type": "Polygon", "coordinates": []})
        self.assertEqual(result["status"], "pending")
        self.assertNotIn("population_estimated", result)
        download.assert_not_called()
        importer.assert_not_called()

    def test_fresh_grid_is_loaded_by_another_worker_without_download(self):
        self.save_grid()
        with patch.object(sources, "_download") as download:
            first = sources.fetch_insee_population_grid()
            sources._grid_memory.clear()
            second = sources.fetch_insee_population_grid()
        self.assertEqual(first, second)
        self.assertEqual(first["status"], "online")
        download.assert_not_called()

    def test_failed_refresh_retains_previous_data_and_timestamp(self):
        saved = self.save_grid()
        with patch.object(sources, "_projected_import_bounds", side_effect=OSError("offline")):
            result = sources.fetch_insee_population_grid(force_refresh=True)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["cells_total"], 1)
        self.assertEqual(result["updated_at"], saved["updated_at"])

    def test_import_lock_does_not_block_a_second_worker(self):
        path = sources._path(sources._GRID_FILENAME)
        with sources._import_lock(path) as first:
            self.assertTrue(first)
            with sources._import_lock(path) as second:
                self.assertFalse(second)
        self.assertFalse(path.with_suffix(".lock").exists())


@unittest.skipUnless(HAS_GEO, "pyproj and shapely installed in the application image")
class PopulationGeometryTests(SourceTestCase):
    def setUp(self):
        super().setUp()
        from pyproj import Transformer
        from shapely.geometry import mapping, box
        from shapely.ops import transform
        self.inverse = Transformer.from_crs("EPSG:3035", "EPSG:4326", always_xy=True)
        self.geojson = lambda rectangle: mapping(transform(self.inverse.transform, box(*rectangle)))
        self.save_grid(cells=[[4000000, 2400000, 100, 40, 20, 30, 5, 1], [4000200, 2400000, 60, 20, 10, 12, 3, 0]])

    def test_half_cell_uses_area_weight_not_centroid_or_communal_average(self):
        result = sources.estimate_insee_population(self.geojson([4000000, 2400000, 4000100, 2400200]))
        self.assertEqual(result["population_estimated"], 50)
        self.assertEqual(result["households_estimated"], 20)
        self.assertEqual(result["children_under_18"], 10)
        self.assertEqual(result["elderly_65_plus"], 15)
        self.assertEqual(result["cells_intersected"], 1)
        self.assertEqual(result["imputed_cells"], 1)
        self.assertAlmostEqual(result["scope_coverage_ratio"], 1, places=5)

    def test_polygon_hole_is_removed_from_population(self):
        from shapely.geometry import Polygon, mapping
        from shapely.ops import transform
        geometry = Polygon([(4000000, 2400000), (4000400, 2400000), (4000400, 2400400), (4000000, 2400400)],
                           holes=[[(4000000.01, 2400000.01), (4000199.99, 2400000.01), (4000199.99, 2400199.99), (4000000.01, 2400199.99)]])
        result = sources.estimate_insee_population(mapping(transform(self.inverse.transform, geometry)))
        self.assertEqual(result["population_estimated"], 60)

    def test_partial_import_never_claims_complete_zone_population(self):
        result = sources.estimate_insee_population(self.geojson([3999800, 2400000, 4000200, 2400200]))
        self.assertEqual(result["status"], "partial")
        self.assertAlmostEqual(result["scope_coverage_ratio"], .5, places=5)
        self.assertEqual(result["population_estimated"], 100)
        self.assertIn("partiellement", result["limitations"][-1])

    def test_duplicate_overlapping_features_are_unioned_not_counted_twice(self):
        geometry = self.geojson([4000000, 2400000, 4000200, 2400200])
        result = sources.estimate_insee_population({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": geometry}] * 2})
        self.assertEqual(result["population_estimated"], 100)

    def test_self_intersecting_polygon_is_rejected(self):
        with self.assertRaises(ValueError):
            sources.estimate_insee_population({"type": "Polygon", "coordinates": [[[5, 45], [6, 46], [5, 46], [6, 45], [5, 45]]]})


class IndustrialTests(SourceTestCase):
    def test_csv_filters_department_missing_coordinates_and_duplicate_sites(self):
        text = "code_aiot;nom_ets;num_dep;cd_insee;commune;longitude;latitude;seveso;lib_seveso;lib_regime\n1;Usine A;38;38185;Grenoble;5.7;45.2;1;Seveso seuil haut;Autorisation\n1;Duplicate;38;38185;Grenoble;5.7;45.2;1;Seveso seuil haut;Autorisation\n2;Voisin;69;69001;Lyon;4.8;45.7;3;Non Seveso;Autorisation\n3;Inconnue;38;38185;Grenoble;;;2;Seveso seuil bas;Autorisation\n"
        sites, skipped = sources._parse_industrial_csv(io.StringIO(text))
        self.assertEqual(len(sites), 1)
        self.assertEqual(sites[0]["nom"], "Usine A")
        self.assertEqual(sites[0]["seveso"], "haut")
        self.assertEqual(skipped, 2)
        self.assertTrue(sites[0]["source_url"].endswith("/1"))

    @unittest.skipUnless(HAS_GEO, "Projection dependencies unavailable")
    def test_official_lambert93_coordinates_are_reprojected(self):
        from pyproj import Transformer
        x, y = Transformer.from_crs(4326, 2154, always_xy=True).transform(5.7, 45.2)
        text = f"code_aiot;nom_ets;num_dep;cd_insee;x;y;code_epsg;lib_seveso\n1;Usine;38;38185;{x};{y};2154;Non Seveso\n"
        sites, skipped = sources._parse_industrial_csv(io.StringIO(text))
        self.assertEqual(skipped, 0)
        self.assertAlmostEqual(sites[0]["lat"], 45.2, places=6)
        self.assertAlmostEqual(sites[0]["lon"], 5.7, places=6)

    def test_failed_refresh_preserves_persisted_sites_and_their_date(self):
        saved = {"status": "online", "sites": [{"id": "1"}], "sites_total": 1, "updated_at": sources._now()}
        sources._write_json(sources._path(sources._INDUSTRIAL_FILENAME), saved)
        with patch.object(sources, "_download", side_effect=TimeoutError("offline")):
            result = sources.fetch_industrial_sites_isere(force_refresh=True)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["sites"], saved["sites"])
        self.assertEqual(result["updated_at"], saved["updated_at"])

    def test_empty_source_is_degraded_never_replaces_a_successful_reference(self):
        def empty_download(url, path, limit):
            path.write_text("code_aiot;num_dep\n", encoding="utf-8")
        with patch.object(sources, "_download", side_effect=empty_download):
            result = sources.fetch_industrial_sites_isere(force_refresh=True)
        self.assertEqual(result["status"], "degraded")
        self.assertFalse(sources._path(sources._INDUSTRIAL_FILENAME).exists())


if __name__ == "__main__":
    unittest.main()
