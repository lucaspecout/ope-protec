"""Authenticated HTTP contracts using FastAPI's real routing and validation.

Run with the project's dependencies installed (or PYTHONPATH=.test-deps).
External collectors and identity lookup are replaced; authorization uses the
application's actual role validator without opening a database connection.
"""

import ast
from copy import deepcopy
import importlib
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
from typing import Callable
import unittest
from unittest.mock import Mock, patch


BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
try:
    from fastapi import Depends, FastAPI, Header, HTTPException
    from fastapi.testclient import TestClient
    HAVE_FASTAPI = True
except ImportError:
    HAVE_FASTAPI = False
if HAVE_FASTAPI:
    routes = importlib.import_module("app.source_routes")


HEADERS = {"Authorization": "Bearer operator-test-credential"}
POLYGON = {"type": "Polygon", "coordinates": [[[5.7, 45.1], [5.8, 45.1], [5.8, 45.2], [5.7, 45.1]]]}


def application_authorization():
    def identity(authorization: str | None = Header(default=None)):
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "Invalid credentials")
        return SimpleNamespace(role="unauthorized" if authorization == "Bearer forbidden" else "ope")
    tree = ast.parse((BACKEND / "app" / "main.py").read_text(encoding="utf-8-sig"))
    validator = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "require_roles")
    namespace = {"Depends": Depends, "HTTPException": HTTPException, "Callable": Callable, "User": SimpleNamespace, "get_active_user": identity}
    exec(compile(ast.Module(body=[validator], type_ignores=[]), "main.py:require_roles", "exec"), namespace)
    return namespace["require_roles"]("admin", "ope", "securite", "visiteur", "mairie")


@unittest.skipUnless(HAVE_FASTAPI, "Install project FastAPI/httpx dependencies to exercise HTTP contracts")
class SourceRouteTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = {
            key: {"status": "online", "source": "https://official.example/" + key, "value": key}
            for key in routes.SOURCE_KEYS
        }
        self.snapshot["enedis"] = {"status": "access_required", "outages": None, "data_available": False}
        self.snapshot["unrelated_private_settings"] = {"api_key": "internal-secret-must-not-leak"}
        self.reader = Mock(side_effect=lambda: deepcopy(self.snapshot))
        self.queue = Mock()
        self.territorial = ModuleType("app.territorial_sources")
        self.territorial.estimate_insee_population = Mock(return_value={"status": "pending", "population": None})
        self.weather = ModuleType("app.weather_sources")
        self.weather.get_observation_history = Mock(return_value={"status": "online", "points": []})
        self.weather.get_radar_frame_path = Mock(return_value=None)
        self.public = importlib.import_module("app.public_sources")
        self.history_patcher = patch.object(self.public, "read_catnat_history", return_value={"status": "online", "events": []})
        self.recall_patcher = patch.object(self.public, "read_recall_detail", return_value={"status": "online", "item": {"id": "123"}})
        self.history_reader = self.history_patcher.start()
        self.recall_reader = self.recall_patcher.start()
        self.addCleanup(self.history_patcher.stop)
        self.addCleanup(self.recall_patcher.stop)
        self.module_patch = patch.dict(sys.modules, {"app.territorial_sources": self.territorial, "app.weather_sources": self.weather})
        self.module_patch.start()
        self.addCleanup(self.module_patch.stop)
        self.app = FastAPI()
        self.app.include_router(routes.create_source_router(application_authorization(), self.reader, self.queue))
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def source_urls(self):
        return {
            "/api/population/isere/grid": "insee_population",
            "/api/industries/isere": "industrial_sites",
            "/api/meteo-france/observations": "meteo_observations",
            "/api/meteo-france/radar": "meteo_radar",
            "/api/vigicrues/forecasts": "vigicrues_forecasts",
            "/api/enedis/isere": "enedis",
            "/api/fuel/isere": "fuel_isere",
            "/api/onde/isere": "onde_isere",
            "/api/catnat/isere": "catnat_isere",
            "/api/energy/aura": "energy_aura",
            "/api/recalls": "recalls",
        }

    def test_every_source_route_requires_authentication_before_reading_or_importing_collectors(self):
        urls = [*self.source_urls(), "/api/sources/isere", "/api/meteo-france/observations/38473001/history", "/api/meteo-france/radar/frames/20261020100000.png", "/api/catnat/isere/history?code_insee=38185", "/api/recalls/123"]
        for url in urls:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 401)
        self.assertEqual(self.client.post("/api/population/isere/estimate", json={"geometry": POLYGON}).status_code, 401)
        self.reader.assert_not_called()
        self.queue.assert_not_called()
        self.territorial.estimate_insee_population.assert_not_called()
        self.weather.get_radar_frame_path.assert_not_called()
        self.history_reader.assert_not_called()
        self.recall_reader.assert_not_called()

    def test_application_role_validator_denies_forbidden_role(self):
        for url in [*self.source_urls(), "/api/sources/isere", "/api/meteo-france/radar/frames/20261020100000.png", "/api/catnat/isere/history?code_insee=38185", "/api/recalls/123"]:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url, headers={"Authorization": "Bearer forbidden"}).status_code, 403)
        self.reader.assert_not_called()
        self.queue.assert_not_called()

    def test_all_source_contracts_are_cache_reads_and_exclude_unrelated_settings(self):
        for url, key in self.source_urls().items():
            with self.subTest(url=url):
                response = self.client.get(url, headers=HEADERS)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), self.snapshot[key])
                self.assertNotIn("operator-test-credential", response.text)
                self.assertNotIn("internal-secret-must-not-leak", response.text)
        combined = self.client.get("/api/sources/isere", headers=HEADERS)
        self.assertEqual(set(combined.json()), set(routes.SOURCE_KEYS))
        self.assertEqual(set(combined.json()), set(self.source_urls().values()))
        self.assertIsNone(combined.json()["enedis"]["outages"])
        self.assertNotIn("internal-secret-must-not-leak", combined.text)
        self.queue.assert_not_called()
        self.territorial.estimate_insee_population.assert_not_called()
        self.weather.get_observation_history.assert_not_called()

    def test_refresh_queues_work_and_returns_existing_snapshot_without_collecting(self):
        # The queue API accepts work; the HTTP handler must not execute a source
        # loader, join a future, poll until updated, or make upstream requests.
        for url, key in self.source_urls().items():
            if key == "enedis":
                continue
            with self.subTest(url=url):
                response = self.client.get(url + "?refresh=true", headers=HEADERS)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), self.snapshot[key])
                self.queue.assert_called_with(key)
        self.assertEqual(self.queue.call_count, 10)
        self.weather.get_observation_history.assert_not_called()
        self.territorial.estimate_insee_population.assert_not_called()

    def test_absent_snapshot_returns_pending_without_synchronous_fetch(self):
        self.snapshot.clear()
        for url in self.source_urls():
            with self.subTest(url=url):
                response = self.client.get(url, headers=HEADERS)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["status"], "pending")
        self.queue.assert_not_called()

    def test_population_accepts_closed_polygon_and_feature_and_keeps_population_unknown(self):
        for geometry in (POLYGON, {"type": "Feature", "geometry": POLYGON, "properties": {"untrusted": "not forwarded"}}):
            response = self.client.post("/api/population/isere/estimate", json={"geometry": geometry}, headers=HEADERS)
            self.assertEqual(response.status_code, 200)
            self.assertIsNone(response.json()["population"])
            self.territorial.estimate_insee_population.assert_called_with(POLYGON)

    def test_population_rejects_empty_nonpolygon_unclosed_and_oversized_geometry(self):
        invalid = [
            {}, {"type": "Point", "coordinates": [5.7, 45.1]},
            {"type": "Polygon", "coordinates": []},
            {"type": "MultiPolygon", "coordinates": []},
            {"type": "Polygon", "coordinates": [[ [5, 45], [6, 45], [6, 46], [5, 46] ]]},
            {"type": "Polygon", "coordinates": [[ [5, 45] ] * 2501]},
            {"type": "Polygon", "coordinates": [[ [True, 45], [6, 45], [6, 46], [True, 45] ]]},
            {"type": "Polygon", "coordinates": [[ [181, 45], [6, 45], [6, 46], [181, 45] ]]},
            {"type": "Feature", "geometry": None},
            {"type": "Feature", "geometry": "invalid"},
            {"type": "Feature", "geometry": [POLYGON]},
        ]
        for geometry in invalid:
            with self.subTest(geometry=str(geometry)[:120]):
                response = self.client.post("/api/population/isere/estimate", json={"geometry": geometry}, headers=HEADERS)
                self.assertEqual(response.status_code, 422)
        self.territorial.estimate_insee_population.assert_not_called()

    def test_population_rejects_non_finite_coordinates_without_server_error(self):
        # JSON's nonstandard NaN/Infinity inputs may reach Python's decoder even
        # when a browser's JSON.stringify would produce null instead.
        for value in ("NaN", "Infinity", "-Infinity", "1e999"):
            body = '{"geometry":{"type":"Polygon","coordinates":[[[' + value + ',45],[6,45],[6,46],[' + value + ',45]]]}}'
            with self.subTest(value=value):
                response = self.client.post("/api/population/isere/estimate", content=body, headers={**HEADERS, "Content-Type": "application/json"})
                self.assertEqual(response.status_code, 422)
        self.territorial.estimate_insee_population.assert_not_called()

    def test_population_engine_validation_errors_return_422(self):
        self.territorial.estimate_insee_population.side_effect = ValueError("Géométrie invalide")
        response = self.client.post("/api/population/isere/estimate", json={"geometry": POLYGON}, headers=HEADERS)
        self.assertEqual(response.status_code, 422)
        self.assertIn("Géométrie invalide", response.json()["detail"])

    def test_history_validates_station_identifier_before_requesting_cached_history(self):
        response = self.client.get("/api/meteo-france/observations/38473001/history", headers=HEADERS)
        self.assertEqual(response.status_code, 200)
        self.weather.get_observation_history.assert_called_once_with("38473001")
        self.weather.get_observation_history.reset_mock()
        for station_id in ("bad-code", "12345678901234567", "NaN"):
            with self.subTest(station_id=station_id):
                self.assertEqual(self.client.get("/api/meteo-france/observations/" + station_id + "/history", headers=HEADERS).status_code, 422)
        self.weather.get_observation_history.assert_not_called()
        # A URL client normalizes the parent-directory segment before routing.
        self.assertEqual(self.client.get("/api/meteo-france/observations/../history", headers=HEADERS).status_code, 404)

    def test_missing_radar_frame_returns_404_without_disclosing_filesystem(self):
        response = self.client.get("/api/meteo-france/radar/frames/20261020100000.png", headers=HEADERS)
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("C:\\", response.text)

    def test_radar_frame_is_authenticated_private_png(self):
        png = b"\x89PNG\r\n\x1a\n" + b"test-fixture"
        with TemporaryDirectory() as temp:
            path = Path(temp) / "radar_20261020100000.png"
            path.write_bytes(png)
            self.weather.get_radar_frame_path.return_value = path
            response = self.client.get("/api/meteo-france/radar/frames/20261020100000.png", headers=HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, png)
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertEqual(response.headers["cache-control"], "private, max-age=300")
        self.assertNotIn("authorization", response.text.lower())

    def test_public_details_read_cache_only_and_validate_identifiers(self):
        response = self.client.get("/api/catnat/isere/history?code_insee=38185", headers=HEADERS)
        self.assertEqual(response.status_code, 200)
        self.history_reader.assert_called_once_with("38185")
        for value in ("69000", "bad-code", "123456789", "38../"):
            self.assertEqual(self.client.get("/api/catnat/isere/history", params={"code_insee": value}, headers=HEADERS).status_code, 422)
        self.assertEqual(self.client.get("/api/recalls/123", headers=HEADERS).status_code, 200)
        self.recall_reader.assert_called_once_with("123")
        self.assertEqual(self.client.get("/api/recalls/not-an-id", headers=HEADERS).status_code, 422)
        self.recall_reader.return_value = None
        self.assertEqual(self.client.get("/api/recalls/999", headers=HEADERS).status_code, 404)
        self.queue.assert_not_called()


if __name__ == "__main__":
    unittest.main()
