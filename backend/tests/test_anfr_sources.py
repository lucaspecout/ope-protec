"""Official ANFR-format fixtures: completeness and mobile-support aggregation."""
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import anfr_sources as sources


def record(row_id, support="101", station="0380000001", **fields):
    return {"datasetid": sources.ANFR_DATASET, "recordid": row_id, "fields": {
        "id": row_id, "sup_id": support, "sta_nm_anfr": station, "sta_nm_dpt": "038",
        "adm_lb_nom": "ORANGE", "generation": "4G", "emr_lb_systeme": "LTE 800",
        "coordonnees": "45.2 , 5.7", "sup_nm_haut": "10", "date_maj": "2026-10-15T15:15:24",
        **fields,
    }}


def fixture_reader(rows, calls=None):
    def read(url, *, timeout):
        if calls is not None:
            calls.append((url, timeout))
        query = parse_qs(urlparse(url).query)
        start, limit = int(query["start"][0]), int(query["rows"][0])
        return {"status": "success", "nhits": len(rows), "records": rows[start:start + limit]}
    return read


class CollectionTests(unittest.TestCase):
    def test_all_pages_aggregate_every_station_operator_and_technology_on_one_support(self):
        rows = [record(1, generation="2G", emr_lb_systeme="GSM 900"),
                record(2, station="0380000002", adm_lb_nom="FREE MOBILE", generation="5G", emr_lb_systeme="5G NR 3500"),
                record(3, support="102", station="0380000003", generation="3G", emr_lb_systeme="UMTS 900", sup_nm_haut="30")]
        calls = []
        result = sources.collect_anfr_isere(read_json=fixture_reader(rows, calls), page_size=1)
        self.assertEqual(result["status"], "online")
        self.assertTrue(result["complete"])
        self.assertEqual(result["schema_version"], 3)
        self.assertEqual(result["supports_total"], 2)
        self.assertEqual(result["stations_total"], 3)
        self.assertEqual(result["operators_total"], 2)
        self.assertEqual(result["records_total"], 3)
        self.assertEqual(result["average_support_height_m"], 20, "Repeated systems must not give a support more weight")
        point = result["supports_points"][0]
        self.assertEqual(point["data_services"], ["2G", "5G"])
        self.assertEqual(point["operators"], ["FREE MOBILE", "ORANGE"])
        self.assertEqual(point["station_name"], "0380000001, 0380000002")
        self.assertEqual(point["voice_service"], "non vérifié")
        self.assertEqual((point["lat"], point["lon"]), (45.2, 5.7))
        self.assertEqual(result["resource_updated_at"], "2026-10-15T15:15:24")
        self.assertEqual(result["last_success_at"], result["updated_at"])
        self.assertEqual(len(calls), 3)
        for index, (url, timeout) in enumerate(calls):
            self.assertTrue(url.startswith(sources.ANFR_RECORDS_URL))
            query = parse_qs(urlparse(url).query)
            self.assertEqual(query["dataset"], [sources.ANFR_DATASET])
            self.assertEqual(query["refine.sta_nm_dpt"], ["038"])
            self.assertEqual(query["sort"], ["id"])
            self.assertIn("coordonnees", query["fields"][0])
            self.assertNotIn("%2C", url, "ANFR double-encodes escaped field separators")
            self.assertEqual(query["start"], [str(index)])
            self.assertLessEqual(timeout, 12)

    def test_projection_with_null_recordid_uses_the_official_id_field(self):
        row = record(1)
        row["recordid"] = None
        result = sources.collect_anfr_isere(read_json=fixture_reader([row]))
        self.assertEqual(result["status"], "online")
        self.assertEqual(result["records_total"], 1)

    def test_missing_coordinates_keep_count_and_later_valid_row_restores_point(self):
        rows = [record(1, coordonnees=None), record(2),
                record(3, support="102", coordonnees="nan , 5.7"),
                record(4, support="103", coordonnees="95 , 5.7"),
                record(5, support="104", coordonnees="0 , 0")]
        result = sources.collect_anfr_isere(read_json=fixture_reader(rows))
        self.assertEqual(result["supports_total"], 4)
        self.assertEqual(len(result["supports_points"]), 1)
        self.assertEqual(result["supports_without_coordinates"], 3)

    def test_explicit_failure_does_not_echo_network_error_or_claim_zero(self):
        def read(url, *, timeout):
            raise RuntimeError("ConnectionResetError private host user:password api-key")
        result = sources.collect_anfr_isere(read_json=read)
        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result["complete"])
        self.assertIsNone(result["supports_total"])
        self.assertIsNone(result["stations_total"])
        self.assertIsNone(result["updated_at"])
        self.assertIsNone(result["last_success_at"])
        self.assertIsNotNone(result["last_attempt_at"])
        self.assertEqual(result["supports_points"], [])
        self.assertNotIn("ConnectionResetError", json.dumps(result))
        self.assertNotIn("api-key", json.dumps(result))

    def test_one_transient_reset_is_retried_without_skipping_a_page(self):
        calls = []
        delegate = fixture_reader([record(1)])
        def read(url, *, timeout):
            calls.append(url)
            if len(calls) == 1:
                raise ConnectionResetError("reset")
            return delegate(url, timeout=timeout)
        result = sources.collect_anfr_isere(read_json=read)
        self.assertEqual(result["status"], "online")
        self.assertEqual(calls, [calls[0], calls[0]])

    def test_http_404_is_not_retried(self):
        calls = []
        def read(url, *, timeout):
            calls.append(url)
            raise HTTPError(url, 404, "missing", {}, None)
        self.assertEqual(sources.collect_anfr_isere(read_json=read)["status"], "unavailable")
        self.assertEqual(len(calls), 1)

    def test_second_page_failure_discards_first_page_counts(self):
        calls = []
        def read(url, *, timeout):
            calls.append(url)
            if len(calls) > 1:
                raise ValueError("bad JSON")
            return {"status": "success", "nhits": 2, "records": [record(1)]}
        result = sources.collect_anfr_isere(read_json=read, page_size=1)
        self.assertFalse(result["complete"])
        self.assertIsNone(result["supports_total"])
        self.assertEqual(result["supports_points"], [])

    def test_unstable_total_duplicate_and_premature_empty_page_are_rejected(self):
        variants = [{"status": "success", "nhits": 3, "records": [record(2)]},
                    {"status": "success", "nhits": 2, "records": [record(1)]},
                    {"status": "success", "nhits": 2, "records": []}]
        for second in variants:
            with self.subTest(second=second):
                pages = iter([{"status": "success", "nhits": 2, "records": [record(1)]}, second])
                result = sources.collect_anfr_isere(read_json=lambda *args, **kwargs: next(pages), page_size=1)
                self.assertEqual(result["status"], "unavailable")
                self.assertIsNone(result["records_total"])

    def test_bad_schema_or_ignored_department_cannot_publish_counts(self):
        bad_rows = [{"recordid": 1}, record(1, sta_nm_dpt="069"), record(1, sup_id=None), record(1, sta_nm_anfr=None)]
        for row in bad_rows:
            with self.subTest(row=row):
                result = sources.collect_anfr_isere(read_json=fixture_reader([row]))
                self.assertFalse(result["complete"])
                self.assertIsNone(result["supports_total"])

    def test_error_status_and_unreasonable_totals_are_rejected(self):
        pages = [{"status": "error", "nhits": 0, "records": []},
                 {"status": "success", "nhits": True, "records": []},
                 {"status": "success", "nhits": 50_001, "records": []}]
        for page in pages:
            with self.subTest(page=page):
                result = sources.collect_anfr_isere(read_json=lambda *args, **kwargs: page)
                self.assertEqual(result["status"], "unavailable")

    def test_page_limit_rejects_truncation(self):
        with patch.object(sources, "MAX_PAGES", 2):
            result = sources.collect_anfr_isere(read_json=fixture_reader([record(1), record(2), record(3)]), page_size=1)
        self.assertFalse(result["complete"])
        self.assertIsNone(result["supports_total"])

    def test_collection_deadline_prevents_a_new_request(self):
        elapsed = [0]
        calls = []
        def read(url, *, timeout):
            calls.append(url)
            elapsed[0] = 61
            return {"status": "success", "nhits": 1, "records": [record(1)]}
        with patch.object(sources.time, "monotonic", side_effect=lambda: elapsed[0]):
            result = sources.collect_anfr_isere(read_json=read)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(len(calls), 1)


class ReaderTests(unittest.TestCase):
    class Response(io.BytesIO):
        def __init__(self, content, headers=None):
            super().__init__(content)
            self.headers = headers or {}

    def test_reader_rejects_declared_and_actual_oversize_bodies(self):
        with patch.object(sources, "MAX_PAGE_BYTES", 64):
            for response in (self.Response(b"{}", {"Content-Length": "65"}), self.Response(b" " * 65)):
                with self.subTest(response=response), patch.object(sources, "urlopen", return_value=response):
                    with self.assertRaises(ValueError):
                        sources._read_json(sources.ANFR_RECORDS_URL, timeout=1)

    def test_reader_requires_json_object(self):
        with patch.object(sources, "urlopen", return_value=self.Response(b"[]")):
            with self.assertRaises(ValueError):
                sources._read_json(sources.ANFR_RECORDS_URL, timeout=1)


if __name__ == "__main__":
    unittest.main()
