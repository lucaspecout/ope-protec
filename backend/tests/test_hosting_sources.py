"""Official Data ES contract, safe shelter metadata and complete pagination."""
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import hosting_sources as sources


def equipment(identifier="E001I380010001", **fields):
    return {"equip_numero": identifier, "inst_numero": "I380010001", "inst_nom": "Complexe communal",
            "equip_nom": "Salle polyvalente", "equip_type_name": "Salles polyvalentes / des fêtes / non spécialisées",
            "dep_code": "38", "equip_nature": "Intérieur", "inst_hs_bool": "Non",
            "equip_coordonnees": {"lat": 45.2, "lon": 5.7}, "inst_adresse": "1 rue de la Mairie",
            "inst_cp": "38000", "new_name": "Grenoble", "new_code": "38185",
            "equip_erp_cat": 4, "equip_maj_date": "2026-10-12", **fields}


def reader_for(rows, calls=None):
    def read(url, *, timeout):
        if calls is not None:
            calls.append((url, timeout))
        query = parse_qs(urlparse(url).query)
        offset, limit = int(query["offset"][0]), int(query["limit"][0])
        return {"total_count": len(rows), "results": rows[offset:offset + limit]}
    return read


class CollectionTests(unittest.TestCase):
    def test_complete_pagination_keeps_rooms_distinct_and_counts_shared_installation_once(self):
        rows = [equipment(), equipment("E002I380010001", equip_nom="Gymnase", equip_type_name="Salle multisports (gymnase)"),
                equipment("E001I380020001", inst_numero="I380020001", equip_type_name="Dojo / Salle d'arts martiaux")]
        calls = []
        result = sources.collect_verified_hosting_isere(read_json=reader_for(rows, calls), page_size=1)
        self.assertEqual(result["status"], "online")
        self.assertTrue(result["complete"])
        self.assertEqual(result["schema_version"], 2)
        self.assertEqual(result["records_total"], 3)
        self.assertEqual(result["count"], 3)
        self.assertEqual(result["equipment_total"], 3)
        self.assertEqual(result["installations_total"], 2)
        self.assertEqual({point["type"] for point in result["points"]}, {"salle_fetes", "gymnase", "salle_omnisports"})
        self.assertEqual(result["updated_at"], result["last_success_at"])
        self.assertEqual(result["resource_updated_at"], "2026-10-12")
        for offset, (url, timeout) in enumerate(calls):
            self.assertTrue(url.startswith(sources.HOSTING_RECORDS_URL))
            query = parse_qs(urlparse(url).query)
            self.assertEqual(query["offset"], [str(offset)])
            self.assertEqual(query["order_by"], ["equip_numero"])
            self.assertIn('dep_code="38"', query["where"][0])
            self.assertIn('equip_nature="Intérieur"', query["where"][0])
            self.assertNotIn("equip_erp_cat is not null", query["where"][0])
            self.assertIn("equip_sanit", query["select"][0])
            self.assertLessEqual(timeout, 10)

    def test_erp_and_spectator_seats_never_become_beds_or_shelter_capacity(self):
        result = sources.collect_verified_hosting_isere(read_json=reader_for([equipment(equip_erp_cat=1, equip_trib_nb=2500)]))
        point = result["points"][0]
        self.assertIsNone(point["capacity"])
        self.assertIsNone(point["capacity_source"])
        self.assertIsNone(point["erp_capacity_max"])
        self.assertEqual(point["erp_category"], 1)
        self.assertEqual(point["spectator_capacity"], 2500)
        self.assertEqual(point["hosting_status"], "à confirmer")
        self.assertIn("confirmer", point["hosting_note"])

    def test_missing_erp_surface_and_accessibility_are_retained_as_unknown(self):
        result = sources.collect_verified_hosting_isere(read_json=reader_for([equipment(equip_erp_cat=None)]))
        self.assertEqual(result["count"], 1)
        point = result["points"][0]
        for field in ("erp_category", "surface_m2", "capacity", "accessibility", "sanitary", "heating", "parking"):
            self.assertIsNone(point[field], field)

    def test_room_characteristics_are_published_values_and_website_is_separate_from_provenance(self):
        row = equipment(equip_surf=500, equip_long=25, equip_larg=20, equip_haut=6, equip_sol="Parquet",
                        equip_sanit="true", equip_douche="Oui", equip_vest_sport=4, equip_energie='["Gaz"]',
                        equip_prop_nom="Ville de Grenoble", equip_prop_type="Commune", equip_gest_type="Commune",
                        equip_url="https://www.grenoble.fr/equipement", equip_ouv_public_bool="false",
                        equip_loc_type='["Infirmerie", "Réception / Accueil"]', aps_name=["Basket", "Badminton"])
        point = sources.collect_verified_hosting_isere(read_json=reader_for([row]))["points"][0]
        self.assertEqual((point["surface_m2"], point["length_m"], point["width_m"], point["height_m"]), (500, 25, 20, 6))
        self.assertEqual((point["sanitary"], point["shower"], point["locker_rooms"]), ("yes", "yes", 4))
        self.assertEqual(point["owner"], "Ville de Grenoble")
        self.assertEqual(point["energy_sources"], ["Gaz"])
        self.assertIsNone(point["heating"], "Energy also covers cooling, so it does not prove heating")
        self.assertEqual(point["opening_authorization"], "no", "No opening order is not an exclusion")
        self.assertEqual(point["activities"], ["Basket", "Badminton"])
        self.assertEqual(point["additional_rooms"], ["Infirmerie", "Réception / Accueil"])
        self.assertEqual(point["website"], "https://www.grenoble.fr/equipement")
        self.assertIn("/pages/fiche/?refine.equip_numero=", point["source"])
        self.assertEqual(point["source"], point["record_url"])
        self.assertEqual(point["source_url"], sources.HOSTING_SOURCE_URL)

    def test_partial_pmr_amenity_does_not_claim_accessible_route(self):
        rows = [equipment(equip_pmr_acc="true", equip_pmr_aire="true", equip_pmr_chem=None, equip_pmr_sanit="true"),
                equipment("E002I380010001", equip_pmr_acc="true", equip_pmr_aire="true", equip_pmr_chem="false"),
                equipment("E003I380010001", equip_pmr_acc="true", equip_pmr_aire="true", equip_pmr_chem="true")]
        result = sources.collect_verified_hosting_isere(read_json=reader_for(rows))
        points = {point["equipment_id"]: point for point in result["points"]}
        self.assertIsNone(points[rows[0]["equip_numero"]]["accessibility"])
        self.assertEqual(points[rows[1]["equip_numero"]]["accessibility"], "no")
        self.assertEqual(points[rows[2]["equip_numero"]]["accessibility"], "yes")
        self.assertEqual(points[rows[0]["equip_numero"]]["accessibility_details"]["sanitary"], "yes")

    def test_out_of_service_and_unsuitable_indoor_equipment_are_excluded(self):
        rows = [equipment(), equipment("E2", inst_hs_bool="Oui"),
                equipment("E3", equip_type_name="Salle de musculation/cardiotraining"),
                equipment("E4", equip_type_name="Salle de blocs artificiels d'escalade"),
                equipment("E5", equip_type_name="Salle ou terrain de squash")]
        result = sources.collect_verified_hosting_isere(read_json=reader_for(rows))
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["excluded_records_total"], 4)

    def test_invalid_coordinates_do_not_publish_null_island_or_non_finite_points(self):
        rows = [equipment(), equipment("E2", equip_coordonnees={"lat": 0, "lon": 0}),
                equipment("E3", equip_coordonnees={"lat": float("nan"), "lon": 5.7}),
                equipment("E4", equip_coordonnees={"lat": 95, "lon": 5.7}),
                equipment("E5", equip_coordonnees=None, equip_y="45.3", equip_x="5.8")]
        result = sources.collect_verified_hosting_isere(read_json=reader_for(rows))
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["missing_coordinates_total"], 3)

    def test_identical_equipment_in_same_page_is_deduplicated(self):
        row = equipment()
        result = sources.collect_verified_hosting_isere(read_json=reader_for([row, dict(row)]))
        self.assertEqual((result["records_total"], result["count"], result["duplicate_records_total"]), (2, 1, 1))

    def test_repeated_page_changing_total_or_truncated_page_cannot_be_published(self):
        for scenario in ("repeated", "changed", "truncated"):
            with self.subTest(scenario=scenario):
                calls = []
                def read(url, *, timeout):
                    calls.append(url)
                    if len(calls) == 1:
                        return {"total_count": 2, "results": [equipment()]}
                    return {"total_count": 3 if scenario == "changed" else 2,
                            "results": [] if scenario == "truncated" else [equipment()]}
                result = sources.collect_verified_hosting_isere(read_json=read, page_size=1)
                self.assertEqual(result["status"], "unavailable")
                self.assertFalse(result["complete"])
                self.assertIsNone(result["count"])
                self.assertEqual(result["points"], [])
                self.assertEqual(len(calls), 2)

    def test_schema_errors_and_ignored_department_or_indoor_filters_are_not_success(self):
        invalid = [{}, {"total_count": True, "results": []}, {"total_count": 1, "results": [{}]},
                   {"total_count": 1, "results": [equipment(dep_code="69")]},
                   {"total_count": 1, "results": [equipment(equip_nature="Extérieur")]},
                   {"total_count": sources.MAX_ROWS + 1, "results": []}]
        for payload in invalid:
            with self.subTest(payload=payload):
                result = sources.collect_verified_hosting_isere(read_json=lambda *args, **kwargs: payload)
                self.assertEqual(result["status"], "unavailable")

    def test_network_failure_is_safe_and_unknown_instead_of_successful_zero(self):
        def read(url, *, timeout):
            raise RuntimeError("ConnectionResetError token=secret internal-host")
        result = sources.collect_verified_hosting_isere(read_json=read)
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["count"])
        self.assertIsNone(result["updated_at"])
        self.assertIsNone(result["last_success_at"])
        self.assertNotIn("secret", json.dumps(result))
        self.assertNotIn("ConnectionReset", json.dumps(result))
        self.assertTrue(result["last_attempt_at"])

    def test_transient_http_failure_retries_once_but_404_does_not(self):
        for status, expected in ((503, 2), (404, 1)):
            calls = []
            def read(url, *, timeout):
                calls.append(url)
                if len(calls) == 1:
                    raise HTTPError(url, status, "error", {}, None)
                return {"total_count": 1, "results": [equipment()]}
            result = sources.collect_verified_hosting_isere(read_json=read)
            self.assertEqual(len(calls), expected)
            self.assertEqual(result["status"], "online" if status == 503 else "unavailable")

    def test_valid_empty_source_is_confirmed_zero(self):
        result = sources.collect_verified_hosting_isere(read_json=reader_for([]))
        self.assertEqual(result["status"], "online")
        self.assertTrue(result["complete"])
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["installations_total"], 0)

    def test_invalid_page_size_and_deadline_are_bounded(self):
        for page_size in (True, 0, 101, "100"):
            result = sources.collect_verified_hosting_isere(read_json=lambda *args, **kwargs: self.fail("Unexpected request"), page_size=page_size)
            self.assertEqual(result["status"], "unavailable")
        with patch.object(sources.time, "monotonic", side_effect=[0, 61]):
            result = sources.collect_verified_hosting_isere(read_json=lambda *args, **kwargs: self.fail("Unexpected request"))
        self.assertEqual(result["status"], "unavailable")

    def test_boolean_normalization_preserves_unknown_and_handles_provider_variants(self):
        for value in (True, 1, 1.0, "true", "Oui", "yes", "1"):
            self.assertEqual(sources._bool(value), "yes")
        for value in (False, 0, 0.0, "false", "Non", "no", "0"):
            self.assertEqual(sources._bool(value), "no")
        for value in (None, "", "inconnu", 4):
            self.assertIsNone(sources._bool(value))
        self.assertEqual(sources._list("null"), [])
        self.assertIsNone(sources._website("javascript:alert(1)"))
        self.assertIsNone(sources._website("https://username:password@example.com"))


class ReaderTests(unittest.TestCase):
    def test_bounded_reader_handles_partial_chunks_and_rejects_oversized_body(self):
        class Response:
            def __init__(self, data):
                self.body = io.BytesIO(data)
                self.headers = {}
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self, size):
                return self.body.read(min(7, size))
        with patch.object(sources, "urlopen", return_value=Response(b'{"total_count":0,"results":[]}')):
            self.assertEqual(sources._read_json("https://example.com", timeout=2)["total_count"], 0)
        with patch.object(sources, "MAX_PAGE_BYTES", 20), patch.object(sources, "urlopen", return_value=Response(b"x" * 30)):
            with self.assertRaises(ValueError):
                sources._read_json("https://example.com", timeout=2)


if __name__ == "__main__":
    unittest.main()
