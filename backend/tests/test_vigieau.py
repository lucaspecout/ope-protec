"""VigiEau's official zone/decree/usage contract and failure semantics, without I/O."""
import ast
from copy import deepcopy
from datetime import datetime, timedelta
from http.client import IncompleteRead, RemoteDisconnected
import io
import json
from pathlib import Path
from threading import Lock
import unicodedata
import unittest
from unittest.mock import Mock
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse


SERVICES_PATH = Path(__file__).resolve().parents[1] / "app" / "services.py"


def environment():
    source = ast.parse(SERVICES_PATH.read_text(encoding="utf-8-sig"))
    definitions = [node for node in source.body if isinstance(node, ast.FunctionDef)
                   and (node.name.startswith("_vigieau_") or node.name in {
                       "_normalize_vigieau_level", "_fetch_vigieau_restrictions_live",
                       "fetch_vigieau_restrictions", "_cached_external_payload"})]
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
                              *definitions], type_ignores=[])
    namespace = {"datetime": datetime, "timedelta": timedelta, "deepcopy": deepcopy,
                 "HTTPError": HTTPError, "URLError": URLError, "RemoteDisconnected": RemoteDisconnected,
                 "IncompleteRead": IncompleteRead, "json": json, "unicodedata": unicodedata,
                 "urlparse": urlparse, "_http_get_json": Mock(), "_redis_get": Mock(return_value=None),
                 "_redis_set": Mock(), "_PERSIST_TTL_SECONDS": 604800,
                 "_VIGIEAU_CACHE_TTL_SECONDS": 600, "_vigieau_cache_lock": Lock(),
                 "_vigieau_cache": {"payload": None, "expires_at": datetime.min, "redis_key": "vigieau_v2"}}
    exec(compile(ast.fix_missing_locations(module), str(SERVICES_PATH), "exec"), namespace)
    return namespace


def zone(**changes):
    return {"id": 6972116, "nom": "Bourbre (spé sout.)", "code": "84_38_0031", "type": "SOU",
            "departement": "38", "niveauGravite": "alerte_renforcee", "ressourceInfluencee": False,
            "arrete": {"id": 38195, "dateDebutValidite": "2026-09-30T00:00:00.000Z",
                       "dateFinValidite": "2026-10-31T00:00:00.000Z",
                       "cheminFichier": "https://example.gouv.fr/arrete.pdf",
                       "cheminFichierArreteCadre": "https://example.gouv.fr/cadre.pdf"},
            "usages": [{"id": 12, "nom": "Arrosage des jardins", "thematique": "Arroser",
                        "description": "Interdit entre 8 h et 20 h.\nException prévue dans l'arrêté.",
                        "concerneParticulier": True, "concerneEntreprise": False,
                        "concerneCollectivite": True, "concerneExploitation": False}], **changes}


class VigieauTests(unittest.TestCase):
    def setUp(self):
        self.env = environment()

    def fetch(self, payload):
        self.env["_http_get_json"].return_value = payload
        return self.env["_fetch_vigieau_restrictions_live"]()

    def test_official_camel_case_fields_retain_full_restrictions_and_decrees(self):
        result = self.fetch([zone()])
        self.assertEqual(result["status"], "online")
        self.assertTrue(result["complete"])
        self.assertEqual(result["schema_version"], 2)
        alert = result["alerts"][0]
        self.assertEqual(alert["zone"], "Bourbre (spé sout.)")
        self.assertEqual(alert["level"], "alerte renforcée")
        self.assertEqual(result["max_level"], "orange")
        self.assertEqual(alert["code"], "84_38_0031")
        self.assertEqual(alert["water_type_label"], "Eaux souterraines")
        self.assertIs(alert["influenced_resource"], False)
        self.assertEqual(alert["start_date"], "2026-09-30T00:00:00.000Z")
        self.assertEqual(alert["end_date"], "2026-10-31T00:00:00.000Z")
        self.assertEqual(alert["arrete"]["url"], "https://example.gouv.fr/arrete.pdf")
        self.assertEqual(alert["arrete"]["framework_url"], "https://example.gouv.fr/cadre.pdf")
        self.assertEqual(alert["usages"][0]["description"], zone()["usages"][0]["description"])
        self.assertEqual(alert["usages"][0]["profiles"], ["particulier", "collectivite"])
        self.assertEqual(alert["usages"][0]["theme"], "Arroser")
        self.assertEqual(result["usages_total"], 1)
        self.assertEqual(result["water_type_counts"], {"SOU": 1})
        self.assertEqual(result["level_counts"], {"alerte renforcée": 1})

    def test_all_55_department_zones_are_retained_with_one_request(self):
        result = self.fetch([zone(id=index, code=f"38_{index}", nom=f"Zone {index}") for index in range(55)])
        self.assertEqual(len(result["alerts"]), 55)
        self.assertEqual(result["alerts_total"], 55)
        self.assertEqual(result["usages_total"], 55)
        self.assertFalse(result["truncated"])
        self.env["_http_get_json"].assert_called_once_with(
            "https://api.vigieau.beta.gouv.fr/api/zones/departement/38", timeout=18)

    def test_reinforced_level_ranks_above_alert_and_vigilance_with_accents_or_underscores(self):
        result = self.fetch([zone(id=1, niveauGravite="vigilance"), zone(id=2, niveauGravite="alerte"),
                             zone(id=3, niveauGravite="alerte renforcée")])
        self.assertEqual([row["id"] for row in result["alerts"]], [3, 2, 1])
        self.assertEqual(result["max_level"], "orange")
        result = self.fetch([zone(id=1, niveauGravite="crise"), zone(id=2)])
        self.assertEqual(result["max_level"], "rouge")

    def test_empty_success_is_complete_and_never_triggers_geographic_probes(self):
        result = self.fetch([])
        self.assertEqual(result["status"], "online")
        self.assertTrue(result["complete"])
        self.assertEqual(result["alerts"], [])
        self.assertEqual(result["alerts_total"], 0)
        self.assertEqual(result["max_level"], "vert")
        self.env["_http_get_json"].assert_called_once()

    def test_documented_department_404_is_authoritative_empty(self):
        body = json.dumps({"message": "Aucune zone d’alerte en vigueur sur ce département.", "statusCode": 404}).encode()
        self.env["_http_get_json"].side_effect = HTTPError("https://example.gouv.fr", 404, "Not Found", {}, io.BytesIO(body))
        result = self.env["_fetch_vigieau_restrictions_live"]()
        self.assertEqual(result["status"], "online")
        self.assertTrue(result["complete"])
        self.assertEqual(result["alerts"], [])

    def test_unrecognized_errors_never_establish_the_absence_of_restrictions(self):
        failures = [URLError("offline"), TimeoutError("timeout"),
                    HTTPError("https://example.gouv.fr", 404, "Not Found", {}, io.BytesIO(b'{"message":"Not found"}'))]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                self.env["_http_get_json"].side_effect = failure
                result = self.env["_fetch_vigieau_restrictions_live"]()
                self.assertEqual(result["status"], "offline")
                self.assertFalse(result["complete"])
                self.assertEqual(result["max_level"], "gris")

    def test_error_objects_and_malformed_list_are_not_accepted_as_empty_success(self):
        for payload in ({"message": "upstream error"}, None, "[]", [None], [{"id": 1}]):
            with self.subTest(payload=payload):
                result = self.fetch(payload)
                self.assertEqual(result["status"], "offline")
                self.assertFalse(result["complete"])

    def test_partial_data_keeps_valid_zones_and_exposes_incompleteness(self):
        result = self.fetch([zone(), {"id": 2}])
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["complete"])
        self.assertEqual(len(result["alerts"]), 1)
        self.assertIn("couverture incomplète", result["error"])

    def test_unknown_severity_does_not_claim_a_complete_green_situation(self):
        result = self.fetch([zone(niveauGravite="nouveau niveau")])
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["complete"])
        self.assertEqual(result["alerts"][0]["level"], "non définie")
        self.assertEqual(result["max_level"], "gris")

    def test_incomplete_envelopes_remain_incomplete_even_with_no_returned_zones(self):
        for payload in ({"data": [], "complete": False}, {"results": [], "total_count": 5},
                        {"data": [zone()], "truncated": True}):
            with self.subTest(payload=payload):
                result = self.fetch(payload)
                self.assertEqual(result["status"], "partial")
                self.assertFalse(result["complete"])
        self.assertEqual(self.fetch({"data": [], "error": "upstream failure"})["status"], "offline")

    def test_no_restriction_or_audience_is_invented_when_upstream_omits_it(self):
        result = self.fetch([zone(usages=[{"nom": "Usage officiel", "description": ""}])])
        usage = result["alerts"][0]["usages"][0]
        self.assertEqual(usage["description"], "")
        self.assertEqual(usage["profiles"], [])
        self.assertNotIn("interdit", result["alerts"][0]["measure"].lower())

    def test_departments_are_filtered_without_misattributing_foreign_restrictions(self):
        result = self.fetch([zone(), zone(id=2, departement="69", niveauGravite="crise")])
        self.assertEqual(result["alerts_total"], 1)
        self.assertEqual(result["max_level"], "orange")
        self.assertEqual(self.fetch([zone(departement="69")])["status"], "offline")

    def test_communes_are_retained_only_when_provided_and_duplicates_are_counted_once(self):
        result = self.fetch([zone(communes=[{"code": "38185", "nom": "Grenoble"}]),
                             zone(id=2, communes=[{"code": "38185", "nom": "Grenoble"}])])
        self.assertEqual(result["communes_total"], 1)
        self.assertEqual(result["alerts"][0]["communes"], [{"code": "38185", "name": "Grenoble"}])
        self.assertEqual(self.fetch([zone()])["alerts"][0]["communes"], [])

    def test_decree_links_allow_only_absolute_web_urls(self):
        result = self.fetch([zone(arrete={"cheminFichier": "javascript:alert(1)",
                                         "cheminFichierArreteCadre": "/untrusted.pdf"},
                                  arreteMunicipalCheminFichier="https://mairie.example.fr/arrete.pdf")])
        decree = result["alerts"][0]["arrete"]
        self.assertEqual(decree["url"], "")
        self.assertEqual(decree["framework_url"], "")
        self.assertEqual(decree["municipal_url"], "https://mairie.example.fr/arrete.pdf")

    def test_bounded_payload_reports_truncation_without_claiming_complete_coverage(self):
        result = self.fetch([zone(id=index, nom=f"Zone {index}") for index in range(301)])
        self.assertEqual(len(result["alerts"]), 300)
        self.assertEqual(result["alerts_total"], 301)
        self.assertTrue(result["truncated"])
        self.assertFalse(result["complete"])
        self.assertEqual(result["status"], "partial")

    def test_duplicate_zones_are_not_counted_twice(self):
        result = self.fetch([zone(), deepcopy(zone())])
        self.assertEqual(result["alerts_total"], 1)
        self.assertEqual(result["usages_total"], 1)

    def test_failed_refresh_preserves_previous_restrictions_and_observation_date(self):
        previous = self.fetch([zone()])
        previous["updated_at"] = "2026-10-20T12:00:00Z"
        self.env["_vigieau_cache"]["payload"] = previous
        self.env["_http_get_json"].side_effect = URLError("offline")
        result = self.env["fetch_vigieau_restrictions"](force_refresh=True)
        self.assertEqual(result["status"], "stale")
        self.assertFalse(result["complete"])
        self.assertEqual(result["updated_at"], previous["updated_at"])
        self.assertEqual(result["alerts"], previous["alerts"])
        self.env["_redis_set"].assert_not_called()
        self.assertEqual(self.env["_vigieau_cache"]["payload"]["status"], "online")

    def test_fresh_cache_avoids_all_external_requests_and_returns_an_independent_payload(self):
        previous = self.fetch([zone()])
        self.env["_http_get_json"].reset_mock()
        self.env["_vigieau_cache"].update(payload=previous, expires_at=datetime.utcnow() + timedelta(minutes=10))
        result = self.env["fetch_vigieau_restrictions"]()
        self.env["_http_get_json"].assert_not_called()
        self.env["_redis_get"].assert_not_called()
        result["alerts"].clear()
        self.assertEqual(len(previous["alerts"]), 1)

    def test_persistent_cache_after_restart_is_labeled_stale_without_blocking_network(self):
        previous = self.fetch([zone()])
        previous["updated_at"] = "2026-01-01T12:00:00Z"
        self.env["_http_get_json"].reset_mock()
        self.env["_redis_get"].side_effect = [None, previous]
        result = self.env["fetch_vigieau_restrictions"]()
        self.assertEqual(result["status"], "stale")
        self.assertFalse(result["complete"])
        self.assertEqual(result["updated_at"], previous["updated_at"])
        self.assertEqual(result["alerts"], previous["alerts"])
        self.assertEqual(previous["status"], "online", "Reading cache must not mutate persisted data")
        self.env["_http_get_json"].assert_not_called()


if __name__ == "__main__":
    unittest.main()
