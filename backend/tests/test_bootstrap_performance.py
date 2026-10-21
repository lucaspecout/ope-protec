"""Behavioral regressions runnable with Python's standard library only.

Loading selected functions through AST avoids importing the application, whose
module initialization connects to PostgreSQL, Redis and external services.
Framework dependencies and serializers are replaced at the function boundary.
"""

import ast
import asyncio
import copy
from datetime import datetime
import json
from pathlib import Path
import threading
from time import monotonic
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock


MAIN_PATH = Path(__file__).resolve().parents[1] / "app" / "main.py"


def load_functions(names, namespace):
    source = ast.parse(MAIN_PATH.read_text(encoding="utf-8-sig"))
    definitions = {node.name: node for node in source.body
                   if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    functions = []
    for name in names:
        node = copy.deepcopy(definitions[name])
        node.decorator_list = []
        # FastAPI evaluates Depends/Query defaults while defining a route.
        node.args.defaults = [ast.Constant(None) if isinstance(value, ast.Call)
                              else value for value in node.args.defaults]
        functions.append(node)
    module = ast.Module(body=[ast.ImportFrom(
        module="__future__", names=[ast.alias(name="annotations")], level=0
    ), *functions], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(MAIN_PATH), "exec"), namespace)
    return namespace


class PayloadSchema:
    @staticmethod
    def model_validate(record):
        return SimpleNamespace(model_dump=lambda: dict(record))


class BootstrapTests(unittest.TestCase):
    def bootstrap_environment(self, role):
        db = object()
        user = SimpleNamespace(role=role, municipality_name="Grenoble")
        risks = {"meteo_france": {"status": "pending", "level": "gris"}}
        dashboard = {"latest_logs": []}
        readers = {
            "list_municipalities": Mock(return_value=[{"id": 1}]),
            "list_events": Mock(return_value=[{"id": 2}]),
            "list_logs": Mock(return_value=[{"id": 3}]),
            "list_users": Mock(return_value=[{"id": 4}]),
        }
        namespace = {
            "monotonic": monotonic,
            "utc_timestamp": lambda: "2026-10-20T10:00:00Z",
            "get_external_risks_payload": Mock(return_value=risks),
            "build_dashboard_payload": Mock(return_value=dashboard),
            "SessionLocal": Mock(side_effect=AssertionError(
                "A bootstrap must reuse its existing database session")),
            **readers,
            **{name: PayloadSchema for name in (
                "MunicipalityOut", "IncidentEventOut", "OperationalLogOut", "UserOut")},
        }
        load_functions(["operations_bootstrap"], namespace)
        return namespace, readers, db, user, risks, dashboard

    def test_admin_bootstrap_reuses_the_request_session(self):
        env, readers, db, user, risks, dashboard = self.bootstrap_environment("admin")
        payload = env["operations_bootstrap"](refresh=True, db=db, user=user)

        env["get_external_risks_payload"].assert_called_once_with(refresh=False, db=db)
        env["build_dashboard_payload"].assert_called_once_with(db, user, external_risks=risks)
        for name in ("list_municipalities", "list_events", "list_logs"):
            readers[name].assert_called_once_with(db=db, user=user)
        readers["list_users"].assert_called_once_with(db=db, _=user)
        env["SessionLocal"].assert_not_called()
        self.assertIs(payload["external_risks"], risks)
        self.assertIs(payload["dashboard"], dashboard)
        self.assertEqual(payload["municipalities"], [{"id": 1}])
        self.assertEqual(payload["events"], [{"id": 2}])
        self.assertEqual(payload["logs"], [{"id": 3}])
        self.assertEqual(payload["users"], [{"id": 4}])
        self.assertGreaterEqual(payload["perf"]["backend_duration_ms"], 0)

    def test_non_admin_bootstrap_does_not_read_the_user_directory(self):
        for role in ("mairie", "ope", "visiteur", "securite"):
            with self.subTest(role=role):
                env, readers, db, user, _, _ = self.bootstrap_environment(role)
                payload = env["operations_bootstrap"](db=db, user=user)
                readers["list_users"].assert_not_called()
                env["SessionLocal"].assert_not_called()
                self.assertEqual(payload["users"], [])
                for name in ("list_municipalities", "list_events", "list_logs"):
                    readers[name].assert_called_once_with(db=db, user=user)


class Column:
    def __init__(self, name):
        self.name = name

    def __eq__(self, value):
        return lambda row: getattr(row, self.name) == value

    def is_(self, value):
        return self == value

    def desc(self):
        return self


class MemoryQuery:
    """Minimal in-memory query supporting equality, false and row limits."""

    def __init__(self, rows):
        self.rows = list(rows)

    def filter(self, predicate):
        self.rows = [row for row in self.rows
                     if predicate(row)] if callable(predicate) else (
                         self.rows if predicate else [])
        return self

    def order_by(self, *_):
        return self

    def limit(self, count):
        self.rows = self.rows[:count]
        return self

    def first(self):
        return self.rows[0] if self.rows else None

    def count(self):
        return len(self.rows)

    def all(self):
        return self.rows


class DashboardTests(unittest.TestCase):
    def dashboard_environment(self, role="ope", municipality_id=None):
        river = SimpleNamespace(updated_at=Column("updated_at"))
        municipality = SimpleNamespace(crisis_mode=Column("crisis_mode"))
        log = SimpleNamespace(municipality_id=Column("municipality_id"),
                              created_at=Column("created_at"))
        records = [SimpleNamespace(id=1, municipality_id=None),
                   SimpleNamespace(id=2, municipality_id=38)]

        def query(model):
            if model is log:
                return MemoryQuery(records)
            return MemoryQuery([])

        db = SimpleNamespace(query=query, get=lambda *_: SimpleNamespace(crisis_mode=False))
        env = {
            "RiverStation": river, "Municipality": municipality, "OperationalLog": log,
            "get_user_municipality_id": lambda *_: municipality_id,
            "fetch_meteo_france_isere": Mock(side_effect=AssertionError(
                "A dashboard must never fetch weather over the network")),
            "compute_global_risk_details": Mock(return_value={
                "level": "vert", "score": 0, "percent": 0, "label": "faible", "factors": []}),
            "OperationalLogOut": SimpleNamespace(model_validate=lambda row: SimpleNamespace(
                model_dump=lambda: {"id": row.id, "municipality_id": row.municipality_id})),
        }
        load_functions(["build_dashboard_payload"], env)
        return env, db, SimpleNamespace(role=role)

    def test_empty_or_invalid_weather_snapshot_does_not_fetch_the_network(self):
        for snapshot in (None, {}, {"meteo_france": {}}, {"meteo_france": "invalid"}):
            with self.subTest(snapshot=snapshot):
                env, db, user = self.dashboard_environment()
                result = env["build_dashboard_payload"](db, user, external_risks=snapshot)
                env["fetch_meteo_france_isere"].assert_not_called()
                self.assertEqual(result["vigilance"], "gris")
                self.assertEqual(result["global_risk"], "gris")

    def test_mairie_with_missing_municipality_cannot_read_departmental_logs(self):
        env, db, user = self.dashboard_environment(role="mairie")
        result = env["build_dashboard_payload"](db, user, external_risks={})
        self.assertEqual(result["latest_logs"], [])
        self.assertEqual(result["communes_crise"], 0)

    def test_mairie_with_resolved_municipality_only_reads_its_own_logs(self):
        env, db, user = self.dashboard_environment(role="mairie", municipality_id=38)
        result = env["build_dashboard_payload"](db, user, external_risks={})
        self.assertEqual(result["latest_logs"], [{"id": 2, "municipality_id": 38}])


class FakeHTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code


class RecordingSession:
    def __init__(self):
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True


class StreamTests(unittest.IsolatedAsyncioTestCase):
    def stream_environment(self, role="ope", auth_error=None):
        session = RecordingSession()
        auth_thread_ids = []

        def authenticate(token, db):
            self.assertEqual(token, "test-token")
            self.assertIs(db, session)
            self.assertFalse(db.closed)
            auth_thread_ids.append(threading.get_ident())
            if auth_error:
                raise auth_error
            return SimpleNamespace(role=role)

        def streaming_response(content, **kwargs):
            self.assertTrue(session.closed, "Close authentication before starting the stream")
            return SimpleNamespace(body_iterator=content, **kwargs)

        env = {
            "asyncio": asyncio, "json": json, "HTTPException": FakeHTTPException,
            "SessionLocal": Mock(return_value=session),
            "get_user_from_token_value": Mock(side_effect=authenticate),
            "READ_ROLES": {"admin", "ope", "securite", "visiteur", "mairie"},
            "StreamingResponse": Mock(side_effect=streaming_response),
            "_map_annotations_revision_lock": threading.Lock(),
            "_map_annotations_revision": 7,
            "_sse_risk_clients_lock": threading.Lock(),
            "_sse_risk_clients": set(),
            "_get_external_risks_snapshot": lambda: {"meteo_france": {"level": "vert"}},
        }
        load_functions(["_authorize_stream_token", "stream_map_annotations",
                        "_serialize_risk_event", "_broadcast_risk_update_from_thread",
                        "stream_external_risks"], env)
        return env, session, auth_thread_ids

    async def test_streams_release_authentication_session_before_first_event(self):
        for handler in ("stream_map_annotations", "stream_external_risks"):
            with self.subTest(handler=handler):
                env, session, auth_threads = self.stream_environment()
                request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
                response = await env[handler](request, token="test-token")
                self.assertTrue(session.closed)
                self.assertNotEqual(auth_threads[0], threading.get_ident())
                self.assertEqual(response.media_type, "text/event-stream")
                first_event = await anext(response.body_iterator)
                self.assertTrue(first_event.startswith("data: "))
                await response.body_iterator.aclose()
                self.assertEqual(env["_sse_risk_clients"], set())

    async def test_streams_release_authentication_session_when_access_is_denied(self):
        for handler in ("stream_map_annotations", "stream_external_risks"):
            for role, auth_error, status in (
                ("unauthorized", None, 403),
                ("ope", FakeHTTPException(401, "Invalid credentials"), 401),
            ):
                with self.subTest(handler=handler, status=status):
                    env, session, _ = self.stream_environment(role, auth_error)
                    with self.assertRaises(FakeHTTPException) as error:
                        await env[handler](object(), token="test-token")
                    self.assertEqual(error.exception.status_code, status)
                    self.assertTrue(session.closed)
                    env["StreamingResponse"].assert_not_called()
                    self.assertEqual(env["_sse_risk_clients"], set())

    async def test_initial_risk_encoding_runs_outside_the_request_loop(self):
        env, _, _ = self.stream_environment()
        encoding_threads = []

        def encode(payload, **options):
            encoding_threads.append(threading.get_ident())
            return json.dumps(payload, **options)

        env["json"] = SimpleNamespace(dumps=encode)
        request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
        response = await env["stream_external_risks"](request, token="test-token")
        frame = await anext(response.body_iterator)
        self.assertEqual(json.loads(frame.removeprefix("data: ")),
                         {"meteo_france": {"level": "vert"}})
        self.assertEqual(len(encoding_threads), 1)
        self.assertNotEqual(encoding_threads[0], threading.get_ident())
        await response.body_iterator.aclose()

    async def test_risk_broadcast_encodes_once_for_all_clients_and_preserves_events(self):
        env, _, _ = self.stream_environment()
        env["_sse_risk_loop"] = asyncio.get_running_loop()
        clients = [asyncio.Queue(maxsize=1) for _ in range(5)]
        env["_sse_risk_clients"].update(clients)
        env["json"] = SimpleNamespace(dumps=Mock(side_effect=json.dumps))
        event = {"type": "service_update", "service_key": "meteo_france",
                 "payload": {"title": "Vigilance météo", "level": "orange"}}
        expected = copy.deepcopy(event)
        await asyncio.to_thread(env["_broadcast_risk_update_from_thread"], event)
        event["payload"]["level"] = "vert"
        await asyncio.sleep(0)
        frames = [client.get_nowait() for client in clients]
        env["json"].dumps.assert_called_once()
        self.assertTrue(all(frame is frames[0] for frame in frames))
        self.assertEqual(json.loads(frames[0].removeprefix("data: ")), expected)

    async def test_risk_stream_yields_preencoded_updates_and_skips_full_clients(self):
        env, _, _ = self.stream_environment()
        env["_sse_risk_loop"] = asyncio.get_running_loop()
        request = SimpleNamespace(is_disconnected=AsyncMock(return_value=False))
        response = await env["stream_external_risks"](request, token="test-token")
        await anext(response.body_iterator)
        full_client = asyncio.Queue(maxsize=1)
        full_client.put_nowait("older update")
        env["_sse_risk_clients"].add(full_client)
        event = {"type": "refresh_status", "refresh": {"in_progress": False}}
        await asyncio.to_thread(env["_broadcast_risk_update_from_thread"], event)
        frame = await anext(response.body_iterator)
        self.assertEqual(json.loads(frame.removeprefix("data: ")), event)
        self.assertEqual(full_client.get_nowait(), "older update")
        await response.body_iterator.aclose()
        env["_sse_risk_clients"].remove(full_client)

    async def test_risk_broadcast_skips_serialization_without_subscribers(self):
        env, _, _ = self.stream_environment()
        env["_sse_risk_loop"] = asyncio.get_running_loop()
        env["_serialize_risk_event"] = Mock()
        await asyncio.to_thread(env["_broadcast_risk_update_from_thread"], {"level": "vert"})
        env["_serialize_risk_event"].assert_not_called()

    async def test_encoding_failure_does_not_interrupt_the_service_refresh(self):
        env, _, _ = self.stream_environment()
        env["_sse_risk_loop"] = asyncio.get_running_loop()
        env["_sse_risk_clients"].add(asyncio.Queue())
        env["logger"] = Mock()
        # Invalid data previously failed inside the subscriber, after the
        # background refresh had already completed its notification hooks.
        await asyncio.to_thread(env["_broadcast_risk_update_from_thread"], {"bad": object()})
        env["logger"].exception.assert_called_once()
        queue = next(iter(env["_sse_risk_clients"]))
        self.assertTrue(queue.empty())
        await asyncio.to_thread(env["_broadcast_risk_update_from_thread"], {"status": "online"})
        await asyncio.sleep(0)
        self.assertEqual(json.loads(queue.get_nowait().removeprefix("data: ")), {"status": "online"})


class NotificationTests(unittest.IsolatedAsyncioTestCase):
    async def test_notification_delivery_does_not_block_the_asyncio_thread(self):
        delivery_threads = []

        def deliver(webhook_url, payload):
            self.assertEqual(webhook_url, "https://example.invalid/test-webhook")
            self.assertEqual(payload["username"], "CRISIS38")
            self.assertTrue(payload["embeds"])
            delivery_threads.append(threading.get_ident())
            return True, "HTTP 204"

        env = {
            "asyncio": asyncio, "datetime": datetime, "HTTPException": FakeHTTPException,
            "_send_discord_webhook": Mock(side_effect=deliver),
        }
        load_functions(["test_notif"], env)
        request = SimpleNamespace(json=AsyncMock(return_value={
            "webhook_url": "https://example.invalid/test-webhook",
        }))
        result = await env["test_notif"](request, _=SimpleNamespace(role="admin"))
        self.assertEqual(result, {"success": True, "detail": "HTTP 204"})
        env["_send_discord_webhook"].assert_called_once()
        self.assertNotEqual(delivery_threads[0], threading.get_ident())


if __name__ == "__main__":
    unittest.main()
