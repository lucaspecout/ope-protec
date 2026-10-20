"""Exercise worker snapshot exchange without importing application startup side effects."""
import ast
from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path
from threading import Lock
import unittest
from unittest.mock import Mock


APP_DIR = Path(__file__).resolve().parents[1] / "app"


def load_definitions(filename, names, namespace):
    tree = ast.parse((APP_DIR / filename).read_text(encoding="utf-8"))
    selected = [
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in names
        or isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in names and target.id.upper() == target.id
            for target in node.targets
        )
    ]
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    module = ast.fix_missing_locations(ast.Module(body=[future, *selected], type_ignores=[]))
    exec(compile(module, str(APP_DIR / filename), "exec"), namespace)
    return namespace


class FakeRedis:
    def __init__(self):
        self.hashes = {}
        self.values = {}
        self.hmget_calls = []

    def pipeline(self):
        return FakePipeline(self)

    def hgetall(self, key):
        return dict(self.hashes.get(key, {}))

    def hmget(self, key, fields):
        self.hmget_calls.append((key, list(fields)))
        return [self.hashes.get(key, {}).get(field) for field in fields]

    def get(self, key):
        return self.values.get(key)


class FakePipeline:
    def __init__(self, redis):
        self.redis = redis
        self.commands = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def hset(self, key, field, value):
        self.commands.append((key, field, value))

    def expire(self, key, seconds):
        pass

    def execute(self):
        for key, field, value in self.commands:
            self.redis.hashes.setdefault(key, {})[field] = value


def services_namespace(redis):
    return load_definitions("services.py", {
        "_REDIS_KEY_PREFIX", "_PERSIST_TTL_SECONDS", "_RISKS_SNAPSHOT_KEY",
        "_RISKS_SERVICE_SNAPSHOTS_KEY", "_redis_get",
        "save_risk_service_snapshot", "load_risk_service_snapshots", "load_risks_snapshot",
    }, {"json": json, "_redis": redis, "_REDIS_OK": True})


def main_namespace():
    return load_definitions("main.py", {
        "_sync_shared_risk_snapshots", "_annotate_service_payload", "_update_service_slot",
        "_set_external_risks_snapshot", "_get_external_risks_snapshot",
    }, {
        "deepcopy": deepcopy, "datetime": datetime,
        "_external_risks_snapshot_lock": Lock(),
        "_external_risks_snapshot": {"payload": {}}, "_external_risks_revisions": {},
        "SERVICE_REFRESH_INTERVALS": {"meteo_france": 120, "vigicrues": 120},
        "load_risk_service_snapshots": Mock(return_value={}),
        "save_risk_service_snapshot": Mock(),
        "_broadcast_risk_update_from_thread": Mock(),
        "_is_any_service_refreshing": lambda: False,
        "_service_meta": Mock(return_value={"refreshing": False, "status": "online"}),
    })


class SharedPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.redis = FakeRedis()
        self.ns = services_namespace(self.redis)

    def test_independent_worker_updates_preserve_all_slots_and_legacy_data(self):
        self.redis.values["svc:risks_snapshot_v1"] = json.dumps({"old_feed": {"status": "online"}})
        worker_two = services_namespace(self.redis)
        self.ns["save_risk_service_snapshot"]("meteo_france", {"level": "orange"}, "2026-10-20T10:00:01Z")
        worker_two["save_risk_service_snapshot"]("vigicrues", {"level": "jaune"}, "2026-10-20T10:00:02Z")
        snapshot = self.ns["load_risks_snapshot"]()
        self.assertEqual(snapshot["meteo_france"]["level"], "orange")
        self.assertEqual(snapshot["vigicrues"]["level"], "jaune")
        self.assertEqual(snapshot["old_feed"]["status"], "online")
        self.assertEqual(snapshot["updated_at"], "2026-10-20T10:00:02Z")

    def test_poll_fetches_only_modified_payloads(self):
        save = self.ns["save_risk_service_snapshot"]
        save("meteo_france", {"level": "vert"}, "2026-10-20T10:00:01Z")
        save("vigicrues", {"level": "jaune"}, "2026-10-20T10:00:02Z")
        records = self.ns["load_risk_service_snapshots"]({"meteo_france": "2026-10-20T10:00:01Z", "vigicrues": ""})
        self.assertEqual(set(records), {"vigicrues"})
        self.assertEqual(self.redis.hmget_calls[-1][1], ["vigicrues"])
        self.redis.hmget_calls.clear()
        self.assertEqual(self.ns["load_risk_service_snapshots"]({
            "meteo_france": "2026-10-20T10:00:01Z", "vigicrues": "2026-10-20T10:00:02Z",
        }), {})
        self.assertEqual(self.redis.hmget_calls, [(
            "svc:risks_snapshot_slots_v2", ["revision:meteo_france", "revision:vigicrues"],
        )])

    def test_corrupt_slot_does_not_hide_other_services(self):
        self.ns["save_risk_service_snapshot"]("meteo_france", {"level": "vert"}, "2026-10-20T10:00:01Z")
        self.redis.hashes["svc:risks_snapshot_slots_v2"]["broken"] = "{invalid"
        self.assertEqual(set(self.ns["load_risk_service_snapshots"]()), {"meteo_france"})

    def test_redis_outage_keeps_reader_non_fatal(self):
        self.ns["_redis"] = Mock()
        self.ns["_redis"].hmget.side_effect = TimeoutError("unavailable")
        self.assertEqual(self.ns["load_risk_service_snapshots"]({"meteo_france": ""}), {})
        self.ns["_REDIS_OK"] = False
        self.assertIsNone(self.ns["load_risks_snapshot"]())


class WorkerSynchronizationTests(unittest.TestCase):
    def test_remote_updates_merge_once_and_never_replace_newer_local_values(self):
        ns = main_namespace()
        ns["_external_risks_snapshot"]["payload"] = {"meteo_france": {"level": "orange"}}
        ns["_external_risks_revisions"]["meteo_france"] = "2026-10-20T10:00:03Z"
        ns["load_risk_service_snapshots"].return_value = {
            "meteo_france": {"revision": "2026-10-20T10:00:01Z", "payload": {"level": "vert"}},
            "vigicrues": {"revision": "2026-10-20T10:00:02Z", "payload": {"level": "jaune"}},
        }
        ns["_sync_shared_risk_snapshots"]()
        ns["_sync_shared_risk_snapshots"]()
        snapshot = ns["_get_external_risks_snapshot"]()
        self.assertEqual(snapshot["meteo_france"]["level"], "orange")
        self.assertEqual(snapshot["vigicrues"]["level"], "jaune")
        ns["_broadcast_risk_update_from_thread"].assert_called_once()
        self.assertEqual(ns["_broadcast_risk_update_from_thread"].call_args.args[0]["service_key"], "vigicrues")
        ns["save_risk_service_snapshot"].assert_not_called()

    def test_local_update_persists_only_changed_feed_and_announces_delta(self):
        ns = main_namespace()
        ns["_external_risks_snapshot"]["payload"] = {"vigicrues": {"level": "jaune"}}
        ns["_update_service_slot"]("meteo_france", {"status": "online", "level": "orange"})
        key, saved, revision = ns["save_risk_service_snapshot"].call_args.args
        self.assertEqual(key, "meteo_france")
        self.assertEqual(saved["level"], "orange")
        self.assertNotIn("vigicrues", saved)
        self.assertEqual(ns["_external_risks_revisions"][key], revision)
        self.assertEqual(ns["_get_external_risks_snapshot"]()["vigicrues"]["level"], "jaune")

    def test_startup_defaults_are_not_published_over_another_worker(self):
        ns = main_namespace()
        ns["_set_external_risks_snapshot"]({"meteo_france": {"status": "pending"}})
        ns["save_risk_service_snapshot"].assert_not_called()

    def test_metadata_keeps_the_worker_that_fetched_the_feed(self):
        ns = main_namespace()
        slot = ns["_annotate_service_payload"]("meteo_france", {
            "status": "online", "meta": {"last_duration_ms": 147, "last_success_at": "2026-10-20T10:00:01Z"},
        })
        self.assertEqual(slot["meta"]["last_duration_ms"], 147)
        self.assertEqual(slot["meta"]["last_success_at"], "2026-10-20T10:00:01Z")
        self.assertFalse(slot["meta"]["refreshing"])

    def test_local_update_during_remote_read_wins_over_older_shared_record(self):
        ns = main_namespace()

        def read_remote(known):
            ns["_update_service_slot"]("meteo_france", {"status": "online", "level": "orange"})
            return {"meteo_france": {"revision": "2020-01-01T00:00:00.000000Z", "payload": {"level": "vert"}}}

        ns["load_risk_service_snapshots"].side_effect = read_remote
        ns["_sync_shared_risk_snapshots"]()
        self.assertEqual(ns["_get_external_risks_snapshot"]()["meteo_france"]["level"], "orange")

    def test_revisions_keep_fixed_precision_at_exact_second(self):
        ns = main_namespace()
        ns["datetime"] = Mock()
        ns["datetime"].utcnow.return_value = datetime(2026, 10, 20, 10, 0, 0)
        ns["_update_service_slot"]("meteo_france", {"status": "online"})
        revision = ns["_external_risks_revisions"]["meteo_france"]
        self.assertEqual(revision, "2026-10-20T10:00:00.000000Z")
        self.assertLess(revision, "2026-10-20T10:00:00.100000Z")

    def test_duplicate_refresh_does_not_clear_active_refresh_ownership(self):
        namespace = load_definitions("main.py", {"_refresh_one_service"}, {
            "datetime": datetime, "monotonic": lambda: 10,
            "_service_runtime_lock": Lock(),
            "_service_runtime": {"meteo_france": {"refreshing": True}},
            "_redis": None,
        })
        namespace["_refresh_one_service"]("meteo_france")
        self.assertTrue(namespace["_service_runtime"]["meteo_france"]["refreshing"])


if __name__ == "__main__":
    unittest.main()
