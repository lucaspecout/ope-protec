"""Bound summary downloads without changing paginated RNB zone calculations."""

import ast
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from threading import Lock
import unittest
from unittest.mock import Mock
from urllib.parse import quote_plus


SERVICE_PATH = Path(__file__).resolve().parents[1] / "app" / "services.py"


def rnb_namespace():
    names = {
        "_safe_float", "_safe_int", "_rnb_bbox_cache_key", "_store_bounded_cache_entry",
        "fetch_rnb_buildings_bbox", "fetch_rnb_isere_summary",
    }
    tree = ast.parse(SERVICE_PATH.read_text(encoding="utf-8-sig"))
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    namespace = {
        "deepcopy": deepcopy,
        "datetime": datetime,
        "timedelta": timedelta,
        "quote_plus": quote_plus,
        "_rnb_buildings_cache": {"by_bbox": {}, "expires_at": datetime.min},
        "_rnb_buildings_cache_lock": Lock(),
        "_RNB_BUILDINGS_CACHE_TTL_SECONDS": 1800,
        "_http_get_json": Mock(),
    }
    module = ast.fix_missing_locations(ast.Module(body=[future, *selected], type_ignores=[]))
    exec(compile(module, str(SERVICE_PATH), "exec"), namespace)
    return namespace


def building(index):
    return {"rnb_id": str(index), "status": "constructed", "point": {"coordinates": [5.72, 45.18]}}


def first_page():
    return {"count": 123456, "results": [building(index) for index in range(100)], "next": "https://rnb.test/page2"}


def second_page():
    return {"count": 123456, "results": [building(index) for index in range(100, 120)], "next": None}


class RnbPerformanceTests(unittest.TestCase):
    def setUp(self):
        self.env = rnb_namespace()
        self.request = self.env["_http_get_json"]

    def fetch_zone(self, **kwargs):
        return self.env["fetch_rnb_buildings_bbox"](44.4, 4.9, 45.7, 6.4, **kwargs)

    def test_summary_reads_one_page_and_preserves_reported_total_and_eight_samples(self):
        self.request.return_value = first_page()
        result = self.env["fetch_rnb_isere_summary"]()
        self.assertEqual(self.request.call_count, 1)
        self.assertEqual(result["status"], "online")
        self.assertEqual(result["buildings_total"], 123456)
        self.assertEqual([item["rnb_id"] for item in result["sample"]], [str(index) for index in range(8)])
        self.assertTrue(result["updated_at"])

    def test_summary_stops_after_one_page_even_when_coordinates_are_invalid(self):
        self.request.return_value = {"count": 123456, "results": [{"rnb_id": "invalid"}], "next": "https://rnb.test/page2"}
        result = self.env["fetch_rnb_isere_summary"]()
        self.assertEqual(self.request.call_count, 1)
        self.assertEqual(result["sample"], [])
        self.assertEqual(result["buildings_total"], 123456)

    def test_zone_keeps_following_pages_and_preserves_available_total(self):
        self.request.side_effect = [first_page(), second_page()]
        result = self.fetch_zone()
        self.assertEqual(self.request.call_count, 2)
        self.assertEqual(self.request.call_args_list[1].args[0], "https://rnb.test/page2")
        self.assertEqual(result["pages_fetched"], 2)
        self.assertEqual(result["buildings_total"], 120)
        self.assertEqual(result["available_total"], 123456)
        self.assertFalse(result["truncated"])

    def test_summary_falls_back_to_full_pagination_when_provider_total_is_missing(self):
        for invalid_total in (None, "unknown"):
            with self.subTest(total=invalid_total):
                env = rnb_namespace()
                page_one = {**first_page(), "count": invalid_total}
                page_two = {**second_page(), "count": invalid_total}
                env["_http_get_json"].side_effect = [page_one, page_one, page_two]
                result = env["fetch_rnb_isere_summary"]()
                self.assertEqual(env["_http_get_json"].call_count, 3)
                self.assertEqual(result["status"], "online")
                self.assertEqual(result["buildings_total"], 120)
                self.assertEqual(len(result["sample"]), 8)

    def test_summary_cache_does_not_truncate_a_later_zone_request(self):
        self.request.side_effect = [first_page(), first_page(), second_page()]
        self.env["fetch_rnb_isere_summary"]()
        zone = self.fetch_zone()
        self.assertEqual(zone["buildings_total"], 120)
        self.assertEqual(self.request.call_count, 3)
        self.assertEqual(len(self.env["_rnb_buildings_cache"]["by_bbox"]), 2)
        self.env["fetch_rnb_isere_summary"]()
        self.fetch_zone()
        self.assertEqual(self.request.call_count, 3)

    def test_zone_still_obeys_requested_limit_and_reports_truncation(self):
        self.request.return_value = first_page()
        result = self.fetch_zone(limit=20)
        self.assertEqual(self.request.call_count, 1)
        self.assertEqual(result["buildings_total"], 20)
        self.assertEqual(result["available_total"], 123456)
        self.assertTrue(result["truncated"])

    def test_forced_summary_refresh_bypasses_memory_cache(self):
        self.request.return_value = first_page()
        self.env["fetch_rnb_isere_summary"]()
        self.env["fetch_rnb_isere_summary"]()
        self.assertEqual(self.request.call_count, 1)
        self.env["fetch_rnb_isere_summary"](force_refresh=True)
        self.assertEqual(self.request.call_count, 2)

    def test_unavailable_provider_keeps_error_contract(self):
        self.request.side_effect = TimeoutError("provider timeout")
        result = self.env["fetch_rnb_isere_summary"](force_refresh=True)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["buildings_total"], 0)
        self.assertEqual(result["sample"], [])
        self.assertEqual(result["error"], "provider timeout")


if __name__ == "__main__":
    unittest.main()
