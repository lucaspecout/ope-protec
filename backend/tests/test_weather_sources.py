"""Contracts and numerical radar checks without database/application startup.

The ODIM fixture is deliberately synthetic and stays inside tests. Scientific
checks run when backend requirements are installed; the rest uses stdlib only.
"""

import ast
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "app" / "weather_sources.py"
NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)


def load_module(cache_dir):
    tree = ast.parse(MODULE_PATH.read_text(encoding="utf-8-sig"))
    tree.body = [node for node in tree.body if not (
        isinstance(node, ast.ImportFrom) and node.module == "config" and node.level == 1
    )]
    module = ModuleType("weather_sources_under_test")
    module.settings = SimpleNamespace(
        static_data_dir=cache_dir,
        meteo_france_api_key="test-secret-never-send-to-client",
        meteo_france_observations_api_key="",
        meteo_france_radar_api_key="",
        meteo_france_access_token="",
        meteo_france_station_ids="",
        meteo_france_station_limit=40,
    )
    exec(compile(tree, str(MODULE_PATH), "exec"), module.__dict__)
    module._now = lambda: NOW
    return module


def observation(station_id="38472001", at="2026-10-20T11:54:00Z", **measurements):
    return json.dumps([{
        "type": "Feature", "geometry": {"type": "Point", "coordinates": [5.77, 45.2]},
        "properties": {"geo_id_insee": station_id, "validity_time": at,
                       "t": 283.15, "ff": 5, "fxi10": 10, "rr_per": 1.5,
                       "pres": 100500, "u": 70, **measurements},
    }]).encode()


class WeatherSourcesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.module = load_module(self.temporary.name)

    def test_missing_key_never_calls_network_or_returns_fake_data(self):
        self.module.settings.meteo_france_api_key = ""
        with patch.object(self.module, "_http_bytes") as http:
            for fetch in (self.module.fetch_meteo_observations_isere, self.module.fetch_meteo_radar_isere):
                payload = fetch(force_refresh=True)
                self.assertEqual(payload["status"], "configuration_required")
                self.assertIsNone(payload["observed_at"])
                self.assertEqual(payload.get("stations", payload.get("frames")), [])
        http.assert_not_called()

    def test_separate_keys_override_shared_key_and_credentials_stay_in_headers(self):
        self.module.settings.meteo_france_radar_api_key = "radar-only-secret"
        self.assertEqual(self.module._auth_headers("radar")["apikey"], "radar-only-secret")
        self.assertEqual(self.module._auth_headers("observations")["apikey"], "test-secret-never-send-to-client")
        self.module.settings.meteo_france_api_key = ""
        self.module.settings.meteo_france_access_token = "temporary-token"
        self.assertEqual(self.module._auth_headers("observations")["Authorization"], "Bearer temporary-token")

    def test_parse_official_station_catalog_and_keep_eight_digits(self):
        catalog = (
            "Id_station;Id_omm;Nom_usuel;Latitude;Longitude;Altitude;Date_ouverture;Pack\n"
            "01014002;;ARBENT;46.278167;5.669000;534;2003-10-01;RADOME\n"
            "38472001;;SAINT MARTIN;45.2;5.77;210;1990-01-01;RADOME\n"
            "38021001;;AUTRANS;45.182000;5.552167;1069;1905-01-01;ETENDU\n"
            "38000001;;INVALIDE;;;0;;\n"
        ).encode()
        stations = self.module._parse_station_catalog(catalog)
        self.assertEqual([station["id"] for station in stations], ["38021001", "38472001"])
        self.assertEqual(stations[0]["elevation_m"], 1069)

    def test_units_are_converted_without_manufacturing_missing_values(self):
        station = {"id": "38472001"}
        result = self.module._parse_observations(observation(), station)[0]
        self.assertEqual(result["temperature_c"], 10)
        self.assertEqual(result["wind_kmh"], 18)
        self.assertEqual(result["gust_kmh"], 36)
        self.assertEqual(result["rain_6m_mm"], 1.5)
        self.assertEqual(result["pressure_hpa"], 1005)
        self.assertEqual(station["lat"], 45.2)
        result = self.module._parse_observations(observation(t=None, ff=-999, rr_per=None), station)[0]
        self.assertIsNone(result["temperature_c"])
        self.assertIsNone(result["wind_kmh"])
        self.assertIsNone(result["rain_6m_mm"])

    def test_wrong_station_future_or_old_data_are_ignored(self):
        station = {"id": "38472001"}
        for raw in (
            observation("38021001"), observation(at="2026-10-20T12:30:00Z"),
            observation(at="2026-10-18T12:00:00Z"),
        ):
            self.assertEqual(self.module._parse_observations(raw, station), [])

    def test_station_without_any_usable_measurement_is_unavailable(self):
        raw = observation(t=None, ff=None, fxi10=None, rr_per=None, pres=None, u=None)
        self.assertEqual(self.module._parse_observations(raw, {"id": "38472001"}), [])
        with patch.object(self.module, "_station_catalog", return_value=[{"id": "38472001"}]), patch.object(
            self.module, "_http_bytes", return_value=raw
        ):
            payload = self.module.fetch_meteo_observations_isere()
        self.assertEqual(payload["status"], "error")
        self.assertIsNone(payload["observed_at"])
        self.assertEqual(payload["summary"]["fresh_stations"], 0)

    def test_observations_latest_snapshot_is_small_and_history_is_read_without_network(self):
        catalog = [{"id": "38472001", "name": "Station test", "lat": 45.2, "lon": 5.77}]
        with patch.object(self.module, "_station_catalog", return_value=catalog), patch.object(
            self.module, "_http_bytes", return_value=observation()
        ) as http:
            payload = self.module.fetch_meteo_observations_isere()
            self.assertEqual(payload["status"], "online")
            self.assertEqual(payload["summary"]["fresh_stations"], 1)
            self.assertNotIn("history", payload["stations"][0])
            self.assertNotIn("test-secret", json.dumps(payload))
            self.assertEqual(len(self.module.get_observation_history("38472001")["history"]), 1)
            self.module.fetch_meteo_observations_isere()
        http.assert_called_once()
        self.assertIn("format=geojson", http.call_args.args[0])
        self.assertNotIn("secret", http.call_args.args[0])

    def test_history_deduplicates_and_does_not_turn_partial_coverage_into_hourly_rain(self):
        points = [{"observed_at": "2026-10-20T11:54:00Z", "rain_6m_mm": 1},
                  {"observed_at": "2026-10-18T11:54:00Z", "rain_6m_mm": 999}]
        merged = self.module._merge_history(points, [{"observed_at": "2026-10-20T11:54:00Z", "rain_6m_mm": 2}])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["rain_6m_mm"], 2)
        self.assertNotIn("rain_1h_mm", merged[0])

    def test_403_returns_actionable_status_without_upstream_error_or_key(self):
        with patch.object(self.module, "_station_catalog", side_effect=self.module.WeatherSourceError("http_403")):
            payload = self.module.fetch_meteo_observations_isere()
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["error_code"], "http_403")
        self.assertIn("souscription", payload["message"])
        self.assertNotIn("test-secret", json.dumps(payload))

    def test_old_measurements_cannot_be_reported_as_fresh_from_cache(self):
        previous = self.module._base_payload("observations")
        previous.update(status="ok", observed_at="2026-10-20T10:00:00Z", stations=[{
            "id": "38472001", "observed_at": "2026-10-20T10:00:00Z", "temperature_c": 10,
        }])
        self.module._write_snapshot("observations", previous)
        with patch.object(self.module, "_http_bytes") as http:
            payload = self.module.fetch_meteo_observations_isere()
        http.assert_not_called()
        self.assertEqual(payload["status"], "stale")
        self.assertTrue(payload["stations"][0]["stale"])
        self.assertEqual(payload["summary"]["fresh_stations"], 0)
        self.assertIsNone(payload["summary"]["min_temperature_c"])

    def test_collection_lock_is_shared_and_nonblocking(self):
        with self.module._collection_lock("radar") as acquired:
            self.assertTrue(acquired)
            with self.module._collection_lock("radar") as second:
                self.assertFalse(second)
        with self.module._collection_lock("radar") as acquired:
            self.assertTrue(acquired)

    def test_paths_are_strictly_validated_before_access(self):
        for frame_id in ("../radar", "20261020120000.png", "a" * 14, "20261020120000/..", None):
            self.assertIsNone(self.module.get_radar_frame_path(frame_id))
        with patch.object(self.module, "_http_bytes") as http:
            result = self.module.get_observation_history("../../radar")
        self.assertEqual(result["history"], [])
        http.assert_not_called()

    def test_redirect_will_not_leak_authentication_to_other_hosts(self):
        from urllib.request import Request
        request = Request(self.module.RADAR_API, headers={"apikey": "never-forward"})
        with self.assertRaises(self.module.WeatherSourceError):
            self.module._OfficialRedirects().redirect_request(
                request, None, 302, "", {}, "https://other.example/file"
            )

    def test_http_payload_size_is_bounded(self):
        response = Mock()
        response.headers = {"Content-Length": "11"}
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(self.module, "build_opener") as opener:
            opener.return_value.open.return_value = response
            with self.assertRaisesRegex(self.module.WeatherSourceError, "response_too_large"):
                self.module._http_bytes(self.module.OBS_API, {}, limit=10)


class RadarNumericalTests(unittest.TestCase):
    def setUp(self):
        WeatherSourcesTests.setUp(self)
        try:
            self.h5py, self.np, self.Image, self.Transformer = self.module._radar_dependencies()
            if not hasattr(self.h5py, "File"):
                self.skipTest("Radar dependencies inaccessible in this sandbox")
        except self.module.WeatherSourceError:
            self.skipTest("Install backend requirements to run numerical radar checks")
        self.module.RADAR_BOUNDS = [[45.0, 5.0], [45.01, 5.01]]

    def fixture(self, *, quantity="ACRR", quality=None):
        target = io.BytesIO()
        transform = self.Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
        west, south = transform.transform(5, 45)
        east, north = transform.transform(5.01, 45.01)
        with self.h5py.File(target, "w") as hdf:
            what = hdf.create_group("what")
            what.attrs.update(date="20261020", time="115500")
            where = hdf.create_group("where")
            where.attrs.update(projdef="EPSG:3857", UL_lon=5, UL_lat=45.01,
                               xsize=2, ysize=2, xscale=(east - west) / 2,
                               yscale=(north - south) / 2)
            group = hdf.create_group("dataset1/data1")
            group.create_group("what").attrs.update(quantity=quantity, gain=0.01, offset=0, nodata=65535, undetect=0)
            group.create_dataset("data", data=self.np.array([[0, 100], [65535, 2000]], dtype="uint16"))
            if quality is not None:
                qgroup = hdf.create_group("dataset1/data2")
                qgroup.create_group("what").attrs.update(quantity="QIND", gain=0.01, offset=0, nodata=255)
                qgroup.create_dataset("data", data=self.np.array(quality, dtype="uint8"))
        return target.getvalue()

    def test_odim_reprojection_gain_nodata_and_orientation(self):
        png, frame = self.module._render_radar_hdf(self.fixture())
        image = self.Image.open(io.BytesIO(png))
        width, height = image.size
        self.assertEqual(image.getpixel((width // 4, height // 4)), (0, 0, 0, 0))
        self.assertEqual(image.getpixel((width * 3 // 4, height // 4)), (250, 204, 21, 210))
        self.assertEqual(image.getpixel((width // 4, height * 3 // 4)), (100, 116, 139, 45))
        self.assertEqual(image.getpixel((width * 3 // 4, height * 3 // 4)), (217, 70, 239, 210))
        self.assertEqual(frame["summary"]["max_rain_5m_mm"], 20)
        self.assertEqual(frame["id"], "20261020115500")
        self.assertEqual(frame["bounds"], self.module.RADAR_BOUNDS)

    def test_zero_quality_is_not_reported_as_precipitation(self):
        png, frame = self.module._render_radar_hdf(self.fixture(quality=[[100, 100], [100, 0]]))
        image = self.Image.open(io.BytesIO(png))
        width, height = image.size
        self.assertEqual(image.getpixel((width * 3 // 4, height * 3 // 4)), (100, 116, 139, 45))
        self.assertEqual(frame["summary"]["max_rain_5m_mm"], 1)

    def test_non_rain_quantity_is_rejected_instead_of_using_reflectivity_as_rain(self):
        with self.assertRaisesRegex(self.module.WeatherSourceError, "unsupported_radar_quantity"):
            self.module._render_radar_hdf(self.fixture(quantity="DBZH"))

    def test_radar_collection_returns_internal_png_urls_and_reuses_identical_frame(self):
        catalog = json.dumps({"links": [{
            "href": f"{self.module.RADAR_API}/mosaiques/METROPOLE/observations/LAME_D_EAU/produit?maille=500",
            "validity_time": "2026-10-20T11:55:00Z",
        }]}).encode()
        with patch.object(self.module, "_http_bytes", side_effect=[catalog, self.fixture()]) as http:
            payload = self.module.fetch_meteo_radar_isere(force_refresh=True)
        self.assertEqual(payload["status"], "online")
        self.assertEqual(http.call_count, 2)
        self.assertEqual(len(payload["frames"]), 1)
        frame = payload["frames"][0]
        self.assertEqual(frame["url"], "/api/meteo-france/radar/frames/20261020115500.png")
        self.assertTrue(self.module.get_radar_frame_path(frame["id"]).is_file())
        self.assertNotIn("test-secret", json.dumps(payload))
        with patch.object(self.module, "_http_bytes", return_value=catalog) as http:
            again = self.module.fetch_meteo_radar_isere(force_refresh=True)
        http.assert_called_once()
        self.assertEqual(len(again["frames"]), 1)

    def test_radar_network_failure_preserves_the_last_frame_with_stale_status(self):
        png, frame = self.module._render_radar_hdf(self.fixture())
        self.module._atomic_bytes(self.module._cache_dir() / f"radar_{frame['id']}.png", png)
        previous = self.module._base_payload("radar")
        previous.update(status="ok", frames=[frame], observed_at=frame["observed_at"])
        self.module._write_snapshot("radar", previous)
        with patch.object(self.module, "_http_bytes", side_effect=self.module.WeatherSourceError("network_error")):
            payload = self.module.fetch_meteo_radar_isere(force_refresh=True)
        self.assertEqual(payload["status"], "stale")
        self.assertEqual(len(payload["frames"]), 1)
        self.assertEqual(payload["frames"][0]["id"], frame["id"])


if __name__ == "__main__":
    unittest.main()
