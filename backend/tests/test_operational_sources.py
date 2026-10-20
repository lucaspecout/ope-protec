"""Flood/Enedis integration contracts, executable without application services."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
from threading import Event, Lock
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.request import Request


MODULE = Path(__file__).resolve().parents[1] / "app" / "operational_sources.py"
spec = importlib.util.spec_from_file_location("operational_sources_under_test", MODULE)
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)
NOW = datetime(2026, 10, 20, 10, 0, tzinfo=timezone.utc)
STATION = {
    "code": "W141001001", "station": "Grenoble [Bastille]", "river": "Isère",
    "lat": 45.19, "lon": 5.72, "commune_code": "38185", "is_priority": True,
}
SECOND_STATION = {**STATION, "code": "W140000101", "station": "Crolles", "is_priority": False}


def station_forecast(variable="H", station_code=STATION["code"]):
    # The keys and units are the actual official v1.1 schema; values are fixtures.
    return {"Simul": {
        "CdEntVigiCru": station_code, "TypEntVigiCru": "7", "GrdSimul": variable,
        "DtProdSimul": "2026-10-20T11:30:00+02:00", "CommentSimul": "Commentaire officiel de la simulation",
        "Prevs": [
            {"DtPrev": "2026-10-20T13:00:00+02:00", "ResMinPrev": 0.4, "ResMoyPrev": 0.5, "ResMaxPrev": 0.6},
            {"DtPrev": 1792497600000, "ResMinPrev": 0, "ResMoyPrev": 0.45, "ResMaxPrev": 0.8},
        ],
    }}


def published(codes):
    return {"ListEntVigiCru": [
        {"CdEntVigiCru": code, "TypEntVigiCru": "7", "Link": "https://untrusted.example/redirect"}
        for code in codes
    ]}


class OperationalSourcesTests(unittest.TestCase):
    def setUp(self):
        self.services = SimpleNamespace(
            _vigicrues_cache={"payload": {"stations": [deepcopy(STATION), deepcopy(SECOND_STATION)]}},
            _vigicrues_cache_lock=Lock(),
            load_risk_service_snapshots=Mock(return_value={}),
            _redis_get=Mock(return_value=None),
            _redis_set=Mock(),
        )
        sources._forecast_cache.update(payload=None, expires_at=NOW - timedelta(seconds=1))
        self.patches = [patch.object(sources, "_now", return_value=NOW), patch.object(sources, "_services", return_value=self.services)]
        for replacement in self.patches:
            replacement.start()
            self.addCleanup(replacement.stop)

    def test_official_schema_normalizes_iso_and_millisecond_dates_and_keeps_zero(self):
        series = sources._parse_forecast_series(station_forecast(), "H", STATION["code"])
        self.assertEqual(series["unit"], "m")
        self.assertEqual(series["issued_at"], "2026-10-20T09:30:00Z")
        self.assertEqual(series["points"][0]["at"], "2026-10-20T11:00:00Z")
        self.assertEqual(series["points"][1]["lower"], 0)
        self.assertFalse(series["expired"])
        self.assertEqual(sources._parse_forecast_series(station_forecast("Q"), "Q", STATION["code"])["unit"], "m³/s")

    def test_invalid_or_mismatched_simulations_are_never_attributed_to_a_station(self):
        for response in (station_forecast(station_code="OTHER123"), station_forecast(variable="Q"), {"Simul": {"Prevs": "invalid"}}):
            with self.assertRaises(ValueError):
                sources._parse_forecast_series(response, "H", STATION["code"])

    def test_non_finite_points_are_omitted_and_invalid_uncertainty_bands_are_removed(self):
        response = station_forecast()
        response["Simul"]["Prevs"] = [
            {"DtPrev": "2026-10-20T11:00:00Z", "ResMoyPrev": float("nan")},
            {"DtPrev": "2026-10-20T12:00:00Z", "ResMinPrev": 5, "ResMoyPrev": 2, "ResMaxPrev": 1},
        ]
        series = sources._parse_forecast_series(response, "H", STATION["code"])
        self.assertEqual(series["points"], [{"at": "2026-10-20T12:00:00Z", "lower": None, "central": 2, "upper": None}])

    def test_collects_only_published_matching_stations_and_never_uses_upstream_links(self):
        def response(params):
            if "CdEntVigiCru" in params:
                return station_forecast(params["GrdSimul"], params["CdEntVigiCru"])
            return published([STATION["code"], "OUTSIDE123"]) if params["GrdSimul"] == "H" else published([])
        with patch.object(sources, "_forecast_json", side_effect=response) as reader:
            result = sources.fetch_vigicrues_forecasts_isere()
        self.assertEqual(reader.call_count, 3)
        self.assertEqual(result["status"], "online")
        self.assertEqual(result["coverage"]["with_forecasts"], 1)
        self.assertEqual(result["coverage"]["missing"], 1)
        self.assertEqual(result["stations"][0]["series"][0]["variable"], "H")
        self.assertEqual(result["stations"][1]["status"], "no_forecast")
        self.assertNotIn("untrusted", str(reader.call_args_list))
        self.services.load_risk_service_snapshots.assert_not_called()

    def test_official_204_means_no_published_forecast_and_is_not_a_service_outage(self):
        with patch.object(sources, "_forecast_json", return_value={"code": 204, "Simul": {"Prevs": []}}):
            result = sources.fetch_vigicrues_forecasts_isere()
        self.assertEqual(result["status"], "online")
        self.assertFalse(result["data_available"])
        self.assertEqual(result["coverage"]["missing"], 2)

    def test_missing_catalogue_is_unknown_coverage_instead_of_no_forecast(self):
        def response(params):
            if params["GrdSimul"] == "Q":
                raise TimeoutError("upstream")
            return published([])
        with patch.object(sources, "_forecast_json", side_effect=response):
            result = sources.fetch_vigicrues_forecasts_isere()
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["coverage"]["missing"], 0)
        self.assertEqual(result["coverage"]["failed"], 2)
        self.assertTrue(all(row["status"] == "unavailable" for row in result["stations"]))

    def test_cold_start_uses_shared_station_snapshot_without_downloading_observations(self):
        self.services._vigicrues_cache["payload"] = None
        self.services.load_risk_service_snapshots.return_value = {"vigicrues": {"payload": {"stations": [STATION]}}}
        with patch.object(sources, "_forecast_json", return_value=published([])) as reader:
            result = sources.fetch_vigicrues_forecasts_isere()
        self.assertEqual(result["coverage"]["stations"], 1)
        self.assertEqual(reader.call_count, 2)
        self.services.load_risk_service_snapshots.assert_called_once_with({"vigicrues": ""})

    def test_cold_start_without_stations_reports_pending_and_does_not_fetch_all_rivers(self):
        self.services._vigicrues_cache["payload"] = None
        with patch.object(sources, "_forecast_json") as reader:
            result = sources.fetch_vigicrues_forecasts_isere()
        self.assertEqual(result["status"], "pending")
        reader.assert_not_called()

    def available_payload(self):
        payload = sources._empty_forecast_payload("online", "Test")
        payload.update(
            updated_at="2026-10-20T09:00:00Z", data_available=True,
            coverage={"stations": 1, "with_forecasts": 1, "missing": 0, "expired": 0, "failed": 0},
            stations=[{**STATION, "status": "available", "series": [sources._parse_forecast_series(station_forecast(), "H", STATION["code"])]}],
        )
        return payload

    def test_temporary_failure_returns_stale_curves_with_original_dates(self):
        previous = self.available_payload()
        sources._forecast_cache["payload"] = deepcopy(previous)
        with patch.object(sources, "_forecast_json", side_effect=TimeoutError()):
            result = sources.fetch_vigicrues_forecasts_isere(force_refresh=True)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["updated_at"], previous["updated_at"])
        self.assertEqual(result["stations"][0]["series"][0]["issued_at"], "2026-10-20T09:30:00Z")
        self.assertEqual(result["checked_at"], "2026-10-20T10:00:00Z")
        self.services._redis_set.assert_not_called()

    def test_cached_curves_expire_without_waiting_for_the_next_network_refresh(self):
        payload = self.available_payload()
        sources._forecast_cache.update(payload=payload, expires_at=NOW + timedelta(hours=4))
        with patch.object(sources, "_now", return_value=NOW + timedelta(hours=3)), patch.object(sources, "_forecast_json") as reader:
            result = sources.fetch_vigicrues_forecasts_isere()
        self.assertFalse(result["data_available"])
        self.assertEqual(result["stations"][0]["status"], "expired")
        self.assertEqual(result["coverage"]["with_forecasts"], 0)
        self.assertEqual(result["coverage"]["expired"], 1)
        reader.assert_not_called()

    def test_excessively_old_cache_is_not_resurrected_as_fresh_data(self):
        payload = self.available_payload()
        payload["updated_at"] = "2026-10-20T07:00:00Z"
        sources._forecast_cache["payload"] = payload
        with patch.object(sources, "_forecast_json", side_effect=TimeoutError()):
            result = sources.fetch_vigicrues_forecasts_isere(force_refresh=True)
        self.assertEqual(result["status"], "degraded")
        self.assertFalse(result["data_available"])

    def test_concurrent_requests_share_one_live_collection(self):
        started, release = Event(), Event()
        def load():
            started.set()
            self.assertTrue(release.wait(2))
            return sources._empty_forecast_payload("online", "No forecasts")
        with patch.object(sources, "_fetch_vigicrues_forecasts_live", side_effect=load) as loader:
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(sources.fetch_vigicrues_forecasts_isere)
                self.assertTrue(started.wait(2))
                second = executor.submit(sources.fetch_vigicrues_forecasts_isere)
                release.set()
                self.assertEqual(first.result()["status"], "online")
                self.assertEqual(second.result()["status"], "online")
        self.assertEqual(loader.call_count, 1)

    def test_enedis_unknown_outages_are_never_displayed_as_zero(self):
        with patch.object(sources, "_forecast_json") as network:
            payload = sources.fetch_enedis_isere_status()
        self.assertEqual(payload["status"], "access_required")
        self.assertIsNone(payload["outages"])
        self.assertIsNone(payload["outages_total"])
        self.assertIsNone(payload["updated_at"])
        self.assertFalse(payload["automated_feed"])
        self.assertFalse(payload["data_available"])
        self.assertEqual(payload["official_links"][0]["url"], "https://www.enedis.fr/panne-et-interruption")
        self.assertEqual(payload["official_links"][0]["access"], "public")
        network.assert_not_called()

    def test_forecast_transport_rejects_redirects_off_the_official_host(self):
        handler = sources._OfficialRedirectHandler()
        for target in ("http://www.vigicrues.gouv.fr/test", "https://127.0.0.1/", "https://www.vigicrues.gouv.fr.evil.example/", "https://www.vigicrues.gouv.fr:8443/"):
            with self.assertRaises(ValueError):
                handler.redirect_request(Request(sources._VIGICRUES_API), None, 302, "Found", {}, target)

    def test_transport_rejects_malformed_payloads_and_limits_response_bytes(self):
        for raw in (b"[]", b'{"unrelated":1}', b'{"code":500,"Simul":{"Prevs":[]}}', b"x" * (sources._MAX_RESPONSE_BYTES + 1)):
            response = Mock(status=200)
            response.read.return_value = raw
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            opener = Mock()
            opener.open.return_value = response
            with patch.object(sources, "build_opener", return_value=opener), self.assertRaises(ValueError):
                sources._forecast_json({"GrdSimul": "H"})
            response.read.assert_called_once_with(sources._MAX_RESPONSE_BYTES + 1)


if __name__ == "__main__":
    unittest.main()
