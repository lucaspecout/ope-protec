"""Credential reload and redaction at real collector boundaries, without I/O."""

import ast
from copy import deepcopy
import csv
from datetime import datetime, timedelta
from http.client import IncompleteRead, RemoteDisconnected
import io
import json
from pathlib import Path
import re
import unittest
from unittest.mock import Mock
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request


SERVICE_PATH = Path(__file__).resolve().parents[1] / "app" / "services.py"


def provider_namespace():
    names = {
        "_CredentialRedirects", "_credentialed_http_bytes", "_credentialed_http_json",
        "_fetch_georisques_v2_collection", "_fetch_firms_france_detections",
        "_fetch_feux_foret_live", "_tomtom_route_estimate", "fetch_route_estimate",
    }
    tree = ast.parse(SERVICE_PATH.read_text(encoding="utf-8-sig"))
    selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    namespace = {name: value for name, value in globals().items() if not name.startswith("__")}
    namespace.update(
        CredentialStoreError=type("CredentialStoreError", (ValueError,), {}),
        resolve_credentials=Mock(return_value={}),
        build_opener=Mock(),
        _validate_route_coord=lambda lat, lon: (lat, lon),
        _osrm_route_estimate=Mock(return_value={"provider": "osrm"}),
        _local_route_estimate=Mock(side_effect=lambda *args, **kwargs: {"provider": "local", **kwargs}),
        _FIRMS_SOURCES=("VIIRS_SNPP_NRT",),
        _FIRMS_FRANCE_BBOXES=("4,44,7,46",),
        _FIRMS_AREA_API="https://firms.modaps.eosdis.nasa.gov/api/area/csv",
        _FEUXDEFORET_ISERE_URL="https://feuxdeforet.fr/auvergne-rhone-alpes/isere/",
        _FEUXDEFORET_FIRES_WINDOW_DAYS=2,
        _fetch_feuxdeforet_isere_page=Mock(return_value={"recent_incidents": []}),
        _fetch_effis_france_perimeters=Mock(return_value={"type": "FeatureCollection", "features": []}),
    )
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *selected], type_ignores=[])), str(SERVICE_PATH), "exec"), namespace)
    return namespace


class DynamicCredentialProviderTests(unittest.TestCase):
    def setUp(self):
        self.ns = provider_namespace()

    def test_georisques_resolves_once_for_all_pages_and_reloads_next_collection(self):
        self.ns["resolve_credentials"].side_effect = [{"token": "first-secret"}, {"token": "replacement-secret"}]
        http = self.ns["_credentialed_http_json"] = Mock(side_effect=[
            {"content": [{"id": 1}], "totalPages": 2, "totalElements": 2},
            {"content": [{"id": 2}]},
            {"content": [], "totalPages": 1},
        ])
        result = self.ns["_fetch_georisques_v2_collection"]("mvt")
        self.assertEqual(result["total_elements"], 2)
        self.assertEqual(len(result["content"]), 2)
        self.ns["_fetch_georisques_v2_collection"]("mvt")
        self.assertEqual(self.ns["resolve_credentials"].call_count, 2)
        self.assertEqual([call.kwargs["headers"]["Authorization"] for call in http.call_args_list], [
            "Bearer first-secret", "Bearer first-secret", "Bearer replacement-secret",
        ])
        self.assertNotIn("secret", http.call_args.args[0])

    def test_tomtom_key_changes_apply_to_next_route_without_restart(self):
        self.ns["resolve_credentials"].side_effect = [{"api_key": "old-secret"}, {"api_key": "new-secret"}]
        http = self.ns["_credentialed_http_json"] = Mock(return_value={"routes": [{"summary": {"lengthInMeters": 100}}]})
        for _ in range(2):
            result = self.ns["fetch_route_estimate"](45, 5, 46, 6)
            self.assertEqual(result["provider"], "tomtom")
            self.assertNotIn("secret", json.dumps(result))
        self.assertEqual(self.ns["resolve_credentials"].call_count, 2)
        self.assertIn("key=old-secret", http.call_args_list[0].args[0])
        self.assertIn("key=new-secret", http.call_args_list[1].args[0])

    def test_tomtom_error_url_and_echoed_key_never_enter_fallback_payload(self):
        self.ns["resolve_credentials"].return_value = {"api_key": "private-key"}
        self.ns["_credentialed_http_json"] = Mock(side_effect=ValueError("https://api.tomtom.com/?key=private-key"))
        result = self.ns["fetch_route_estimate"](45, 5, 46, 6)
        self.assertEqual(result["provider"], "osrm")
        self.assertIn("tomtom_error", result)
        self.assertNotIn("private-key", json.dumps(result))
        self.ns["_osrm_route_estimate"].side_effect = ValueError("private-key")
        result = self.ns["fetch_route_estimate"](45, 5, 46, 6)
        self.assertEqual(result["provider"], "local")
        self.assertNotIn("private-key", json.dumps(result))

    def test_storage_failure_keeps_open_route_fallback_available(self):
        self.ns["resolve_credentials"].side_effect = self.ns["CredentialStoreError"]("private-db-url")
        result = self.ns["fetch_route_estimate"](45, 5, 46, 6)
        self.assertEqual(result["provider"], "osrm")
        self.assertNotIn("private-db-url", json.dumps(result))

    def test_firms_resolves_new_key_and_redacts_echoed_body_in_fire_snapshot(self):
        self.ns["resolve_credentials"].side_effect = [{"map_key": "first-secret"}, {"map_key": "second-secret"}]
        http = self.ns["_credentialed_http_bytes"] = Mock(return_value=b"Invalid MAP_KEY: first-secret")
        result = self.ns["_fetch_feux_foret_live"]()
        self.assertIn("firms_error", result)
        self.assertNotIn("first-secret", json.dumps(result))
        self.ns["_fetch_feux_foret_live"]()
        self.assertIn("/first-secret/", http.call_args_list[0].args[0])
        self.assertIn("/second-secret/", http.call_args_list[1].args[0])

    def test_firms_key_is_escaped_in_upstream_path(self):
        self.ns["resolve_credentials"].return_value = {"map_key": "key/with?characters"}
        http = self.ns["_credentialed_http_bytes"] = Mock(return_value=b"latitude,longitude,acq_date,acq_time\n")
        self.assertEqual(self.ns["_fetch_firms_france_detections"](), [])
        self.assertIn("/key%2Fwith%3Fcharacters/", http.call_args.args[0])

    def test_credentialed_transport_never_exposes_error_body_reason_or_url(self):
        failures = [
            URLError("https://provider/?key=private-key"),
            HTTPError("https://provider/?key=private-key", 403, "private-key", {}, None),
            ValueError("header private-key invalid"),
        ]
        opener = self.ns["build_opener"].return_value
        for failure in failures:
            opener.open.side_effect = failure
            with self.subTest(failure=type(failure).__name__), self.assertRaises(ValueError) as raised:
                self.ns["_credentialed_http_bytes"]("https://provider/?key=private-key")
            self.assertNotIn("private-key", str(raised.exception))

    def test_redirect_handler_refuses_all_redirects_before_forwarding_auth(self):
        handler = self.ns["_CredentialRedirects"]()
        for target in ("http://provider/", "https://attacker.invalid/", "https://provider/next"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                handler.redirect_request(Request("https://provider/", headers={"Authorization": "Bearer private-key"}), None, 302, "Found", {}, target)


if __name__ == "__main__":
    unittest.main()
