"""Provider contracts, cache semantics and bounded public snapshots without I/O."""
from datetime import datetime, timedelta, timezone
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

PATH = Path(__file__).resolve().parents[1] / "app/public_sources.py"
SPEC = importlib.util.spec_from_file_location("public_sources_under_test", PATH)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
NOW = datetime(2026, 10, 20, 14, 0, tzinfo=timezone.utc)


def ods(rows):
    return {"total_count": len(rows), "results": rows}


def fuel(**changes):
    return {"id": 38000001, "code_departement": "38", "ville": "Grenoble", "adresse": "Rue test",
            "cp": "38000", "geom": {"lat": 45.18, "lon": 5.72}, "gazole_prix": 1.7,
            "gazole_maj": "2026-10-20T12:00:00Z", "carburants_disponibles": ["Gazole"],
            "horaires_automate_24_24": "Oui", **changes}


def onde(**changes):
    return {"code_departement": "38", "code_station": "V150 6011", "libelle_station": "Ruisseau test",
            "libelle_commune": "Grenoble", "code_commune": "38185", "libelle_cours_eau": "Ruisseau",
            "date_observation": "2026-09-25", "code_ecoulement": "3", "latitude": 45.18, "longitude": 5.72, **changes}


def energy(**changes):
    return {"code_insee_region": "84", "date_heure": "2026-10-20T13:45:00Z", "consommation": 4500,
            "nucleaire": 3000, "hydraulique": 1000, "thermique": 0, "eolien": 0, "solaire": 500,
            "bioenergies": 100, **changes}


def recall(**changes):
    return {"id": 123, "numero_fiche": "2026-10-001", "numero_version": 1, "libelle": "Produit test",
            "date_publication": "2026-10-20T12:00:00Z", "zone_geographique_de_vente": "France entière",
            "identification_produits": ["123456789", "lot1"], "motif_rappel": "Motif publié",
            "conduites_a_tenir_par_le_consommateur": "Consigne officielle", **changes}


class PublicSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = Path(self.temp.name)
        self.patches = [patch.object(module, "_cache_dir", return_value=self.cache), patch.object(module, "_now", return_value=NOW)]
        for patcher in self.patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_fuel_preserves_declarations_price_dates_and_separates_discontinued_fuel(self):
        row = fuel(e10_prix=1.8, e10_maj="2026-10-01T10:00:00Z", e10_rupture_type="temporaire",
                   e85_rupture_type="definitive", horaires=json.dumps({"jour": [{"@nom": "Lundi", "@ferme": "0", "horaire": {"@ouverture": "08.00", "@fermeture": "18.00"}}]}))
        with patch.object(module, "_json", return_value=ods([row])):
            result = module.fetch_fuel_isere(True)
        self.assertEqual(result["status"], "online")
        self.assertEqual(result["temporary_shortage_stations"], 1)
        station = result["stations"][0]
        fuels = {row["fuel"]: row for row in station["fuels"]}
        self.assertEqual(fuels["Gazole"]["price_eur"], 1.7)
        self.assertFalse(fuels["Gazole"]["old_price"])
        self.assertEqual(fuels["E10"]["shortage"], "temporary")
        self.assertTrue(fuels["E10"]["old_price"])
        self.assertEqual(fuels["E85"]["shortage"], "discontinued")
        self.assertIsNone(fuels["E85"]["price_eur"])
        self.assertTrue(station["automate_24h"])
        self.assertEqual(station["hours"][0]["slots"][0]["from"], "08.00")

    def test_fuel_rejects_foreign_department_and_missing_coordinates_are_not_zero(self):
        rows = [fuel(), fuel(id=69000001, code_departement="69"), fuel(id=38000002, geom={}, latitude=None, longitude=None)]
        with patch.object(module, "_json", return_value=ods(rows)):
            result = module.fetch_fuel_isere(True)
        self.assertEqual(result["stations_total"], 2)
        self.assertIsNone(next(row for row in result["stations"] if row["id"] == "38000002")["lat"])

    def test_fuel_converts_legacy_integer_coordinates(self):
        with patch.object(module, "_json", return_value=ods([fuel(geom={}, latitude="4518000", longitude="572000")])):
            result = module._fuel_loader()
        self.assertEqual(result["stations"][0]["lat"], 45.18)
        self.assertEqual(result["stations"][0]["lon"], 5.72)

    def test_ods_follows_fixed_pagination_and_detects_incomplete_pages(self):
        with patch.object(module, "_json", side_effect=[{"total_count": 2, "results": [{"id": 1}]}, {"total_count": 2, "results": [{"id": 2}]}]) as fetch:
            rows, truncated, total = module._ods(module.ECONOMY + module.FUEL_DATASET + "/records", "code_departement='38'")
        self.assertEqual(len(rows), 2)
        self.assertFalse(truncated)
        self.assertEqual(fetch.call_args_list[1].args[1]["offset"], 100)
        with patch.object(module, "_json", return_value={"total_count": 1, "results": []}), self.assertRaises(module.SourceError):
            module._ods(module.ENERGY_API, "x")

    def test_ods_reports_truncation_and_does_not_treat_missing_schema_as_empty(self):
        with patch.object(module, "_json", return_value={"total_count": 500, "results": [{"id": 1}]}):
            self.assertTrue(module._ods(module.ENERGY_API, "x", max_pages=1)[1])
        with patch.object(module, "_json", return_value={"error": "bad query"}), self.assertRaises(module.SourceError):
            module._ods(module.ENERGY_API, "x")

    def test_onde_latest_per_station_future_and_foreign_rows_ignored(self):
        rows = [onde(), onde(date_observation="2026-08-01", code_ecoulement="1"), onde(code_departement="69", code_station="other"),
                onde(code_station="future", date_observation="2026-12-01"), onde(code_station="zero", code_ecoulement="1a")]
        with patch.object(module, "_json", return_value={"count": len(rows), "data": rows}) as fetch:
            result = module.fetch_onde_isere(True)
        self.assertEqual(result["stations_total"], 2)
        self.assertEqual(result["dry_stations"], 1)
        self.assertEqual(result["observed_at"], "2026-09-25")
        self.assertIn("date_observation_min", fetch.call_args.args[1])
        self.assertIn("pas", result["note"])

    def test_catnat_french_dates_and_compact_snapshot_with_full_history_on_demand(self):
        communes = [{"code": "38185", "name": "Grenoble"}]
        rows = [{"code_insee": "38185", "libelle_commune": "Grenoble", "code_national_catnat": str(index),
                 "libelle_risque_jo": "Inondations", "date_debut_evt": "09/09/1993", "date_fin_evt": "10/09/1993", "date_publication_jo": "18/02/1994"}
                for index in range(180)]
        with patch.object(module, "_communes", return_value=communes), patch.object(module, "_catnat_batch", return_value=(rows, True)):
            result = module.fetch_catnat_isere(True)
        self.assertEqual(result["events_total"], 180)
        self.assertEqual(len(result["events"]), 150)
        history = module.read_catnat_history("38185")
        self.assertEqual(len(history["events"]), 180)
        self.assertEqual(history["events"][0]["event_start"], "1993-09-09")
        self.assertEqual(history["events"][0]["published_at"], "1994-02-18")
        with self.assertRaises(ValueError):
            module.read_catnat_history("../private")

    def test_catnat_groups_at_most_ten_codes_and_keeps_failed_communes_old_history(self):
        communes = [{"code": f"38{index:03}", "name": str(index)} for index in range(12)]
        previous = {"id": "old", "code_insee": "38010", "risk": "Ancien", "event_start": "2000-01-01", "published_at": "2001-01-01", "commune": "10"}
        module._write("catnat_history", {"events": [previous]})
        def batch(codes, deadline):
            self.assertLessEqual(len(codes), 10)
            if "38010" in codes:
                raise module.SourceError("provider_unavailable")
            return [], True
        with patch.object(module, "_communes", return_value=communes), patch.object(module, "_catnat_batch", side_effect=batch):
            result = module.fetch_catnat_isere(True)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["coverage"]["communes_checked"], 10)
        self.assertEqual(result["events_total"], 1)
        self.assertEqual(module.read_catnat_history("38010")["status"], "partial")
        self.assertIn("échoué", module.read_catnat_history("38010")["coverage_warning"])

    def test_catnat_does_not_follow_insecure_provider_next_link(self):
        response = {"response_code": 200, "total_pages": 2, "data": [], "next": "http://private.example/internal"}
        with patch.object(module, "_json", side_effect=[response, {**response, "total_pages": 2}]) as fetch:
            self.assertTrue(module._catnat_batch(["38185"])[1])
        self.assertEqual([call.args[0] for call in fetch.call_args_list], [module.CATNAT_API] * 2)
        with patch.object(module, "_json", return_value={"response_code": 200, "total_pages": 1, "data": [{"code_insee": "69000"}]}), self.assertRaises(module.SourceError):
            module._catnat_batch(["38185"])

    def test_catnat_missing_cache_is_pending_and_does_not_fetch(self):
        with patch.object(module, "_json") as fetch:
            self.assertEqual(module.read_catnat_history("38185")["status"], "pending")
        fetch.assert_not_called()

    def test_energy_discards_placeholders_future_and_foreign_regions_preserves_zero(self):
        rows = [energy(), energy(date_heure="2026-10-20T23:45:00Z", consommation=None), energy(date_heure="2026-10-20T23:30:00Z"),
                energy(code_insee_region="11"), energy(date_heure="2026-10-20T13:30:00Z", consommation=0)]
        with patch.object(module, "_json", return_value=ods(rows)):
            result = module.fetch_energy_aura(True)
        self.assertEqual(len(result["series"]), 2)
        self.assertEqual(result["series"][0]["consumption_mw"], 0)
        self.assertEqual(result["latest"]["generation_mw"]["thermique"], 0)
        self.assertEqual(result["unit"], "MW")
        self.assertEqual(result["observed_at"], "2026-10-20T13:45:00Z")

    def test_energy_missing_generation_is_unknown_and_old_measurement_is_stale(self):
        with patch.object(module, "_json", return_value=ods([energy(date_heure="2026-10-19T13:45:00Z", hydraulique=None)])):
            result = module.fetch_energy_aura(True)
        self.assertEqual(result["status"], "stale")
        self.assertIsNone(result["latest"]["production_mw"])
        self.assertIsNone(result["latest"]["generation_mw"]["hydraulique"])

    def test_energy_only_placeholders_is_unavailable_not_zero_consumption(self):
        with patch.object(module, "_json", return_value=ods([energy(consommation=None)])):
            result = module.fetch_energy_aura(True)
        self.assertEqual(result["status"], "unavailable")
        self.assertNotIn("latest", result)

    def test_recall_scope_is_declarative_and_unknown_zones_are_retained(self):
        zones = [("Isère (38)", "isere"), ("Auvergne-Rhône-Alpes", "region"), ("France entière", "national"),
                 ("voir liste des magasins en pièce jointe", "unspecified"), ("Bretagne", "unspecified")]
        for zone, expected in zones:
            self.assertEqual(module._recall_scope(zone), expected)
        with patch.object(module, "_json", return_value=ods([recall(zone_geographique_de_vente="voir pièce jointe")])):
            result = module.fetch_recalls(True)
        self.assertEqual(result["unspecified_total"], 1)
        self.assertEqual(len(result["items"]), 1)

    def test_recall_versions_dates_and_details_are_not_in_bootstrap(self):
        rows = [recall(numero_version=1), recall(numero_version=2, id=124, date_de_fin_de_la_procedure_de_rappel="2026-10-19"),
                recall(id=125, numero_fiche="other", date_de_fin_de_la_procedure_de_rappel=None),
                recall(id=126, numero_fiche="future", date_publication="2026-12-01T00:00:00Z")]
        with patch.object(module, "_json", return_value=ods(rows)):
            result = module.fetch_recalls(True)
        self.assertEqual(len(result["items"]), 2)
        selected = next(row for row in result["items"] if row["id"] == "124")
        self.assertFalse(selected["active"])
        self.assertNotIn("identification", selected)
        detail = module.read_recall_detail("124")["item"]
        self.assertEqual(detail["identification"], "123456789 · lot1")
        self.assertEqual(detail["actions"], "Consigne officielle")
        self.assertIsNone(module.read_recall_detail("999"))
        with self.assertRaises(ValueError):
            module.read_recall_detail("../1")

    def test_cached_feed_never_refetches_until_interval_and_force_bypasses(self):
        with patch.object(module, "_json", return_value=ods([fuel()])) as fetch:
            module.fetch_fuel_isere(True)
            module.fetch_fuel_isere(False)
            self.assertEqual(fetch.call_count, 1)
            module.fetch_fuel_isere(True)
            self.assertEqual(fetch.call_count, 2)

    def test_failure_preserves_data_success_date_and_redacts_upstream_error(self):
        with patch.object(module, "_json", return_value=ods([fuel()])):
            previous = module.fetch_fuel_isere(True)
        with patch.object(module, "_json", side_effect=RuntimeError("private upstream body")):
            result = module.fetch_fuel_isere(True)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["stations"], previous["stations"])
        self.assertEqual(result["updated_at"], previous["updated_at"])
        self.assertNotIn("private", json.dumps(result))

    def test_catnat_annual_summary_uses_full_history_and_paris_year(self):
        events = [{"published_at": "2027-01-01", "id": str(i)} for i in range(175)]
        events.append({"published_at": "2026-12-31", "id": "old"})
        module._write("catnat_history", {"events": events})
        with patch.object(module, "_now", return_value=datetime(2026, 12, 31, 23, 30, tzinfo=timezone.utc)), patch.object(module, "_collected", return_value={"status": "partial", "events": events[:150]}):
            result = module.fetch_catnat_isere()
        self.assertEqual(result["current_year"], 2027)
        self.assertEqual(result["current_year_total"], 175)
        self.assertEqual(len(result["current_year_events"]), 175)
        self.assertEqual(result["status"], "partial")

    def test_first_failure_does_not_fabricate_zero_counts(self):
        with patch.object(module, "_json", side_effect=module.SourceError("rate_limited")):
            result = module.fetch_fuel_isere(True)
        self.assertEqual(result["status"], "unavailable")
        self.assertNotIn("stations_total", result)
        self.assertIn("Quota", result["error"])

    def test_transport_decompresses_gzip_and_limits_decompressed_size(self):
        response = Mock()
        response.read1.side_effect = [gzip.compress(b'{"data": []}'), b'']
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock()
        opener = Mock()
        opener.open.return_value = response
        with patch.object(module, "build_opener", return_value=opener):
            self.assertEqual(module._json(module.ONDE_API), {"data": []})
        response.read1.side_effect = [gzip.compress(b'x' * 100), b'']
        with patch.object(module, "build_opener", return_value=opener), patch.object(module, "MAX_BYTES", 40), self.assertRaises(module.SourceError):
            module._json(module.ONDE_API)

    def test_transport_rejects_untrusted_hosts_and_cross_host_redirects(self):
        for url in ("http://www.georisques.gouv.fr/api", "https://internal.example/api"):
            with self.assertRaises(module.SourceError):
                module._json(url)
        request = module.Request(module.CATNAT_API)
        with self.assertRaises(module.SourceError):
            module._Redirects().redirect_request(request, None, 302, 'Found', {}, "http://private.example/api")


if __name__ == '__main__':
    unittest.main()
