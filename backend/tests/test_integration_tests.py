"""Credential probes never need real credentials or network access in tests."""

import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


PATH = Path(__file__).resolve().parents[1] / "app" / "integration_tests.py"
SPEC = importlib.util.spec_from_file_location("integration_tests_under_test", PATH)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
SECRET = "test-secret-never-return"
STATIONS = b"Id_station;Nom_usuel;Latitude;Longitude\n38472001;ST MARTIN;45.2;5.77\n"
RADAR = json.dumps({"links": [{"href": "https://public-api.meteofrance.fr/public/DPRadar/mosaiques/METROPOLE/observations/LAME_D_EAU/produit?maille=1000"}]}).encode()


class IntegrationTestsTests(unittest.TestCase):
    def assert_safe(self, result):
        encoded = json.dumps(result)
        self.assertNotIn(SECRET, encoded)
        self.assertNotIn("https://", encoded)
        self.assertIn("tested_at", result)
        self.assertGreaterEqual(result["duration_ms"], 0)

    def test_missing_credentials_do_not_contact_any_provider(self):
        with patch.object(module, "_http_bytes") as request:
            for service in ("meteo_france", "georisques", "firms", "tomtom"):
                result = module.test_integration(service, {})
                self.assertEqual(result["status"], "configuration_required")
                self.assertFalse(result["ok"])
                self.assert_safe(result)
        request.assert_not_called()

    def test_weather_checks_two_subscriptions_and_preserves_key_priority(self):
        with patch.object(module, "_http_bytes", side_effect=[STATIONS, RADAR]) as request:
            result = module.test_integration("meteo_france", {
                "api_key": SECRET, "radar_api_key": "radar-secret", "access_token": "token-secret",
            })
        self.assertTrue(result["ok"])
        self.assertEqual([check["status"] for check in result["checks"]], ["ok", "ok"])
        self.assertEqual(request.call_args_list[0].args[1], {"apikey": SECRET})
        self.assertEqual(request.call_args_list[1].args[1], {"apikey": "radar-secret"})
        self.assert_safe(result)

    def test_weather_token_is_sent_in_authorization_header(self):
        with patch.object(module, "_http_bytes", side_effect=[STATIONS, RADAR]) as request:
            result = module.test_integration("meteo_france", {"access_token": SECRET})
        self.assertTrue(result["ok"])
        self.assertEqual(request.call_args_list[0].args[1], {"Authorization": "Bearer " + SECRET})

    def test_one_weather_key_does_not_claim_other_subscription_works(self):
        with patch.object(module, "_http_bytes", return_value=STATIONS) as request:
            result = module.test_integration("meteo_france", {"observations_api_key": SECRET})
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "configuration_required")
        self.assertTrue(result["checks"][0]["ok"])
        self.assertEqual(result["checks"][1]["status"], "configuration_required")
        self.assertEqual(request.call_count, 1)

    def test_georisques_uses_authenticated_small_page_and_accepts_empty_collection(self):
        with patch.object(module, "_http_bytes", return_value=b'{"content": [], "totalElements": 0}') as request:
            result = module.test_integration("georisques", {"token": SECRET})
        self.assertTrue(result["ok"])
        self.assertIn("pageSize=1", request.call_args.args[0])
        self.assertEqual(request.call_args.args[1], {"Authorization": "Bearer " + SECRET})
        self.assert_safe(result)

    def test_firms_checks_actual_key_status_and_quota(self):
        with patch.object(module, "_http_bytes", return_value=b'{"transaction_limit":5000,"current_transactions":3}') as request:
            result = module.test_integration("firms", {"map_key": SECRET})
        self.assertTrue(result["ok"])
        self.assertIn("/mapserver/mapkey_status/?MAP_KEY=", request.call_args.args[0])
        with patch.object(module, "_http_bytes", return_value=b'{"transaction_limit":5000,"current_transactions":5000}'):
            self.assertEqual(module.test_integration("firms", {"map_key": SECRET})["status"], "service_unavailable")
        self.assert_safe(result)

    def test_firms_invalid_key_with_http_200_is_not_success(self):
        for body in (b"Invalid MAP_KEY", b'{"error":"MAP_KEY is not valid"}'):
            with patch.object(module, "_http_bytes", return_value=body):
                result = module.test_integration("firms", {"map_key": SECRET})
            self.assertEqual(result["status"], "auth_failed")
            self.assert_safe(result)

    def test_tomtom_validates_route_summary(self):
        with patch.object(module, "_http_bytes", return_value=b'{"routes":[{"summary":{"lengthInMeters":450,"travelTimeInSeconds":75}}]}') as request:
            result = module.test_integration("tomtom", {"api_key": SECRET})
        self.assertTrue(result["ok"])
        self.assertIn("routeRepresentation=summaryOnly", request.call_args.args[0])
        self.assert_safe(result)

    def test_html_error_empty_objects_and_malformed_provider_data_are_not_success(self):
        for service, credentials in (("georisques", {"token": SECRET}), ("firms", {"map_key": SECRET}), ("tomtom", {"api_key": SECRET})):
            for body in (b"<html>login</html>", b"{}", b"null", b'{"error":"failure"}'):
                with patch.object(module, "_http_bytes", return_value=body):
                    result = module.test_integration(service, credentials)
                self.assertEqual(result["status"], "invalid_response")
                self.assert_safe(result)

    def test_unexpected_exception_containing_key_never_reaches_result(self):
        with patch.object(module, "_http_bytes", side_effect=RuntimeError("https://host/?key=" + SECRET)):
            result = module.test_integration("tomtom", {"api_key": SECRET})
        self.assertEqual(result["status"], "service_unavailable")
        self.assert_safe(result)

    def test_header_injection_and_unknown_service_never_make_network_request(self):
        with patch.object(module, "_http_bytes") as request:
            self.assertEqual(module.test_integration("georisques", {"token": "x\r\nInjected: true"})["status"], "configuration_required")
            self.assertEqual(module.test_integration("https://evil.invalid", {"api_key": SECRET})["status"], "invalid_response")
        request.assert_not_called()

    def test_transport_rejects_redirects_without_following_them(self):
        response = Mock(status=302)
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(module.http.client, "HTTPSConnection", return_value=connection) as create:
            with self.assertRaises(module._ProbeFailure) as caught:
                module._http_bytes("https://api.tomtom.com/test", {}, module.monotonic() + 14)
        self.assertEqual(caught.exception.status, "invalid_response")
        self.assertEqual(create.call_count, 1)
        response.read1.assert_not_called()
        connection.close.assert_called_once()

    def test_transport_classifies_status_without_reading_or_returning_error_body(self):
        for status, expected in ((401, "auth_failed"), (403, "auth_failed"), (429, "service_unavailable"), (503, "service_unavailable"), (404, "invalid_response")):
            response = Mock(status=status)
            connection = Mock()
            connection.getresponse.return_value = response
            with patch.object(module.http.client, "HTTPSConnection", return_value=connection):
                with self.assertRaises(module._ProbeFailure) as caught:
                    module._http_bytes("https://www.georisques.gouv.fr/test", {}, module.monotonic() + 14)
            self.assertEqual(caught.exception.status, expected)
            response.read1.assert_not_called()

    def test_transport_bounds_response_size_and_rejects_nonofficial_destinations(self):
        response = Mock(status=200)
        response.getheader.return_value = str(module.MAX_RESPONSE_BYTES + 1)
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(module.http.client, "HTTPSConnection", return_value=connection) as create:
            for url in ("http://api.tomtom.com/test", "https://evil.invalid/", "https://api.tomtom.com:8443/test", "https://user:pass@api.tomtom.com/test"):
                with self.assertRaises(module._ProbeFailure):
                    module._http_bytes(url, {}, module.monotonic() + 14)
            create.assert_not_called()
            with self.assertRaises(module._ProbeFailure):
                module._http_bytes("https://api.tomtom.com/test", {}, module.monotonic() + 14)
        response.read1.assert_not_called()

    def test_transport_checks_shared_deadline_between_response_chunks(self):
        response = Mock(status=200)
        response.getheader.return_value = None
        response.read1.return_value = b"data"
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(module.http.client, "HTTPSConnection", return_value=connection), patch.object(module, "monotonic", side_effect=[0, 0, 0, 15]):
            with self.assertRaises(module._ProbeFailure) as caught:
                module._http_bytes("https://api.tomtom.com/test", {}, 14)
        self.assertEqual(caught.exception.status, "service_unavailable")
        self.assertEqual(response.read1.call_count, 1)

    def test_transport_bounds_stream_without_content_length_and_closes_response(self):
        response = Mock(status=200)
        response.getheader.return_value = None
        response.read1.return_value = b"12345"
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(module.http.client, "HTTPSConnection", return_value=connection), patch.object(module, "MAX_RESPONSE_BYTES", 4):
            with self.assertRaises(module._ProbeFailure) as caught:
                module._http_bytes("https://api.tomtom.com/test", {}, module.monotonic() + 14)
        self.assertEqual(caught.exception.status, "invalid_response")
        response.close.assert_called_once()

    def test_expired_deadline_never_opens_another_connection(self):
        with patch.object(module.http.client, "HTTPSConnection") as connection:
            with self.assertRaises(module._ProbeFailure) as caught:
                module._http_bytes("https://api.tomtom.com/test", {}, module.monotonic() - 1)
        self.assertEqual(caught.exception.status, "service_unavailable")
        connection.assert_not_called()

    def test_socket_deadline_is_updated_even_when_server_detaches_connection(self):
        response = Mock(status=200)
        response.getheader.return_value = None
        response.read1.side_effect = [b"{}", b""]
        connection = Mock()
        transport_socket = connection.sock

        def detach_socket():
            connection.sock = None
            return response

        connection.getresponse.side_effect = detach_socket
        with patch.object(module.http.client, "HTTPSConnection", return_value=connection):
            self.assertEqual(module._http_bytes("https://api.tomtom.com/test", {}, module.monotonic() + 14), b"{}")
        self.assertGreaterEqual(transport_socket.settimeout.call_count, 3)


if __name__ == "__main__":
    unittest.main()
