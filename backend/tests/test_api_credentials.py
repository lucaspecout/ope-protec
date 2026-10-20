"""Real encrypted database/HTTP contracts, without starting production workers."""
import ast
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Callable
import unittest
from unittest.mock import Mock, patch

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND)) if str(BACKEND) not in sys.path else None

try:
    from fastapi import Depends, FastAPI, Header, HTTPException
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from app import api_credentials as store
    from app.integration_routes import create_integration_router
    HAVE_DEPENDENCIES = True
except ImportError:
    HAVE_DEPENDENCIES = False


def real_admin_authorization():
    def identity(authorization: str | None = Header(default=None)):
        if not authorization:
            raise HTTPException(401, "Authentification requise")
        return SimpleNamespace(role=authorization.removeprefix("Bearer "))
    tree = ast.parse((BACKEND / "app/main.py").read_text(encoding="utf-8-sig"))
    validator = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "require_roles")
    namespace = {"Depends": Depends, "HTTPException": HTTPException, "Callable": Callable,
                 "User": SimpleNamespace, "get_active_user": identity}
    exec(compile(ast.Module(body=[validator], type_ignores=[]), "main.py", "exec"), namespace)
    return namespace["require_roles"]("admin")


@unittest.skipUnless(HAVE_DEPENDENCIES, "Install backend requirements and httpx")
class ApiCredentialsTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.key = Path(self.directory.name) / "private" / "api.key"
        self.settings = SimpleNamespace(api_credentials_key_path=str(self.key), meteo_france_api_key="",
                                        meteo_france_observations_api_key="", meteo_france_radar_api_key="",
                                        meteo_france_access_token="", georisques_api_token="",
                                        firms_map_key="", tomtom_api_key="environment-secret")
        patcher = patch.object(store, "settings", self.settings)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        store.AppSetting.__table__.create(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.addCleanup(self.engine.dispose)
        self.queue = Mock()
        self.tester = Mock(return_value={"ok": True, "status": "ok", "message": "Connexion réussie.",
                                       "duration_ms": 8, "tested_at": "2026-10-20T10:00:00Z"})
        def db_dependency():
            with self.sessions() as db:
                yield db
        app = FastAPI()
        app.include_router(create_integration_router(real_admin_authorization(), self.queue, db_dependency, self.tester))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.headers = {"Authorization": "Bearer admin"}

    def request(self, method, path="", **kwargs):
        return self.client.request(method, "/api/admin/integrations" + path, headers=self.headers, **kwargs)

    def test_all_endpoints_require_admin_before_access_or_outbound_test(self):
        for role, status in ((None, 401), ("ope", 403), ("visiteur", 403), ("securite", 403), ("mairie", 403)):
            for method, path in (("GET", ""), ("PUT", "/tomtom"), ("DELETE", "/tomtom"), ("POST", "/tomtom/test")):
                with self.subTest(role=role, method=method):
                    headers = {} if role is None else {"Authorization": "Bearer " + role}
                    response = self.client.request(method, "/api/admin/integrations" + path, headers=headers, json={"values": {"api_key": "never-save"}})
                    self.assertEqual(response.status_code, status)
        self.tester.assert_not_called()
        self.queue.assert_not_called()
        self.assertFalse(self.key.exists())

    def test_catalog_reports_configuration_sources_without_values_or_unimplemented_services(self):
        response = self.request("GET")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn("environment-secret", response.text)
        services = {service["id"]: service for service in response.json()["services"]}
        self.assertEqual(set(services), {"meteo_france", "georisques", "firms", "tomtom"})
        self.assertEqual(services["tomtom"]["fields"][0]["source"], "environment")
        self.assertFalse(services["meteo_france"]["configured"])
        self.assertFalse(self.key.exists())

    def test_save_is_encrypted_and_new_collector_sessions_see_updates_immediately(self):
        for secret in ("first-private-secret", "second-private-secret"):
            response = self.request("PUT", "/tomtom", json={"values": {"api_key": secret}})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertNotIn(secret, response.text)
            self.assertEqual(response.json()["fields"][0]["source"], "application")
            with self.sessions() as db:
                row = db.get(store.AppSetting, store.PREFIX + "tomtom")
                self.assertNotIn(secret, row.value)
                self.assertNotIn("api_key", row.value)
            with patch.object(store, "SessionLocal", self.sessions):
                self.assertEqual(store.resolve_credentials("tomtom")["api_key"], secret)
        self.assertTrue(self.key.is_file())

    def test_blank_preserves_and_explicit_clear_returns_to_environment(self):
        self.request("PUT", "/tomtom", json={"values": {"api_key": "saved-secret"}})
        self.request("PUT", "/tomtom", json={"values": {"api_key": " "}})
        with self.sessions() as db:
            self.assertEqual(store.read_overrides(db, "tomtom"), {"api_key": "saved-secret"})
        response = self.request("PUT", "/tomtom", json={"clear_fields": ["api_key"]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["fields"][0]["source"], "environment")
        with self.sessions() as db:
            self.assertIsNone(db.get(store.AppSetting, store.PREFIX + "tomtom"))

    def test_partial_weather_updates_keep_other_fields_and_queue_both_collectors(self):
        response = self.request("PUT", "/meteo_france", json={"values": {"api_key": "shared", "radar_api_key": "radar"}})
        self.assertEqual(response.status_code, 200)
        self.request("PUT", "/meteo_france", json={"values": {"observations_api_key": "observations"}, "clear_fields": ["radar_api_key"]})
        with self.sessions() as db:
            self.assertEqual(store.read_overrides(db, "meteo_france"), {"api_key": "shared", "observations_api_key": "observations"})
        self.assertEqual([call.args[0] for call in self.queue.call_args_list], ["meteo_observations", "meteo_radar"] * 2)

    def test_test_uses_draft_and_saved_fallback_without_persisting_or_refreshing(self):
        response = self.request("POST", "/tomtom/test", json={"values": {"api_key": "draft-only-secret"}})
        self.assertEqual(response.status_code, 200)
        self.tester.assert_called_with("tomtom", {"api_key": "draft-only-secret"})
        self.assertNotIn("draft-only-secret", response.text)
        self.request("POST", "/tomtom/test", json={})
        self.tester.assert_called_with("tomtom", {"api_key": "environment-secret"})
        self.assertFalse(self.key.exists())
        self.queue.assert_not_called()
        with self.sessions() as db:
            self.assertEqual(db.query(store.AppSetting).count(), 0)

    def test_malformed_inputs_do_not_echo_secret_in_validation_errors(self):
        bad = [
            {"values": {"api_key": ["sentinel-private"]}},
            {"values": {"api_key": "sentinel-private\nInjected: bad"}},
            {"values": {"unknown": "sentinel-private"}},
            {"values": {"unknown": ""}},
            {"values": {"api_key": "sentinel-private"}, "clear_fields": ["api_key"]},
            {"clear_fields": ["sentinel-private"]},
            {"sentinel-private": "unused"},
            ["sentinel-private"],
        ]
        for body in bad:
            with self.subTest(body=type(body).__name__):
                response = self.request("PUT", "/tomtom", json=body)
                self.assertEqual(response.status_code, 422)
                self.assertNotIn("sentinel-private", response.text)
        response = self.request("POST", "/tomtom/test", content=b'{"sentinel-private":')
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("sentinel-private", response.text)
        self.assertEqual(self.request("PUT", "/tomtom", content=b"x" * 40001).status_code, 413)
        self.tester.assert_not_called()
        self.queue.assert_not_called()

    def test_lost_key_fails_closed_and_reset_can_recover_without_decryption(self):
        self.request("PUT", "/tomtom", json={"values": {"api_key": "saved-secret"}})
        self.key.unlink()
        self.assertEqual(self.request("GET").status_code, 503)
        self.assertEqual(self.request("POST", "/tomtom/test", json={}).status_code, 503)
        self.assertEqual(self.request("PUT", "/firms", json={"values": {"map_key": "new-secret"}}).status_code, 503)
        self.assertFalse(self.key.exists(), "A missing encryption key must never be silently replaced")
        response = self.request("DELETE", "/tomtom")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["fields"][0]["source"], "environment")

    def test_ciphertext_cannot_be_reassigned_to_another_service(self):
        self.request("PUT", "/tomtom", json={"values": {"api_key": "saved-secret"}})
        with self.sessions() as db:
            encrypted = db.get(store.AppSetting, store.PREFIX + "tomtom").value
            db.add(store.AppSetting(key=store.PREFIX + "firms", value=encrypted))
            db.commit()
            with self.assertRaises(store.CredentialStoreError):
                store.read_overrides(db, "firms")

    def test_concurrent_key_creation_never_replaces_published_key(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            encrypted = list(pool.map(lambda _: store._cipher(create=True).encrypt(b"private"), range(16)))
        for value in encrypted:
            self.assertEqual(store._cipher().decrypt(value), b"private")

    def test_unknown_service_never_runs_outbound_test(self):
        for method, path in (("PUT", "/enedis"), ("DELETE", "/enedis"), ("POST", "/enedis/test")):
            self.assertEqual(self.request(method, path, json={}).status_code, 404)
        self.tester.assert_not_called()

    def test_mutations_lock_the_service_before_read_merge_and_write(self):
        # The production PostgreSQL advisory lock also covers a not-yet-created
        # record, unlike SELECT FOR UPDATE on a missing row.
        db = Mock()
        db.get_bind.return_value.dialect.name = "postgresql"
        store.lock_service(db, "meteo_france")
        statement, parameters = db.execute.call_args.args
        self.assertIn("pg_advisory_xact_lock", str(statement))
        self.assertEqual(parameters, {"scope": store.PREFIX + "meteo_france"})
        with patch.object(store, "lock_service", wraps=store.lock_service) as lock:
            self.assertEqual(self.request("PUT", "/tomtom", json={"values": {"api_key": "secret"}}).status_code, 200)
            self.assertEqual(self.request("DELETE", "/tomtom").status_code, 200)
            self.assertEqual(lock.call_count, 2)

    def test_deeply_nested_json_is_rejected_without_server_error(self):
        response = self.request("PUT", "/tomtom", content=b"[" * 1100 + b'"sentinel-private"' + b"]" * 1100)
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("sentinel-private", response.text)
