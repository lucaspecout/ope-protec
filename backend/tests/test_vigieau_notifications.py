"""Check water-restriction notification decisions without startup or network."""

import ast
from copy import deepcopy
from datetime import datetime
import hashlib
import json
from pathlib import Path
from typing import Any
import unittest
from unittest.mock import Mock


MAIN = Path(__file__).resolve().parents[1] / "app" / "main.py"


class FakeRedis:
    def __init__(self):
        self.values = {}

    def get(self, key):
        return self.values.get(key)

    def setex(self, key, ttl, value):
        self.values[key] = value


def notification_namespace(threshold="orange"):
    names = {
        "_LEVEL_ORDER", "_NOTIF_VOLATILE_FIELDS", "_extract_service_level",
        "_notification_content_fingerprint", "_check_and_send_notifications",
    }
    tree = ast.parse(MAIN.read_text(encoding="utf-8"))
    selected = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            selected.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in names for target in node.targets
        ):
            selected.append(node)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id in names:
            selected.append(node)
    namespace = {
        "Any": Any, "json": json, "hashlib": hashlib, "datetime": datetime,
        "_REDIS_OK": True, "_redis": FakeRedis(),
        "_SERVICE_LABELS": {"vigieau": "VigiEau"},
        "_load_notif_rules": Mock(return_value=[{
            "id": "water", "enabled": True, "discord_webhook": "mock://unused",
            "services": {"vigieau": {"enabled": True, "threshold": threshold}},
        }]),
        "_check_notif_quiet": Mock(return_value=False),
        "_build_discord_embed": Mock(return_value={"mocked": True}),
        "_send_discord_webhook": Mock(return_value=(True, "mocked")),
        "_save_notif_log": Mock(),
    }
    module = ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[]))
    exec(compile(module, str(MAIN), "exec"), namespace)
    return namespace


def restrictions():
    return {
        "status": "online", "max_level": "rouge", "complete": True,
        "updated_at": "2026-10-20T12:00:00Z", "source": "https://example.test/api",
        "alerts": [{
            "id": 100, "code": "38_01", "zone": "Bassin test", "level": "crise",
            "level_color": "rouge", "measure": "Restrictions détaillées",
            "start_date": "2026-10-01", "end_date": "2026-10-31",
            "water_type": "SUP", "influenced_resource": False,
            "communes": [{"code": "38185", "name": "Grenoble"}],
            "usages": [{
                "id": 200, "name": "Arrosage", "theme": "Arroser",
                "description": "Interdit de 8 h à 20 h",
                "profiles": ["particulier", "collectivite"],
            }],
            "arrete": {
                "id": 300, "number": "38-2026-01", "start_date": "2026-10-01",
                "end_date": "2026-10-31", "url": "https://example.test/decree.pdf",
            },
        }],
    }


class VigiEauNotificationTests(unittest.TestCase):
    def setUp(self):
        self.namespace = notification_namespace()
        self.fingerprint = self.namespace["_notification_content_fingerprint"]
        self.level = self.namespace["_extract_service_level"]

    def test_severity_uses_actual_water_level(self):
        cases = [
            ({"max_level": "rouge", "alerts": [{}]}, "rouge"),
            ({"alerts": [{"level": "alerte renforcée"}]}, "orange"),
            ({"alerts": [{"level": "alerte_renforcee"}]}, "orange"),
            ({"alerts": [{"level": "alerte"}]}, "jaune"),
            ({"alerts": [{"level": "vigilance"}]}, "vert"),
            ({"max_level": "vert", "alerts": [{"level": "crise"}]}, "rouge"),
            ({"alerts": [{"zone": "Legacy unknown level"}]}, "jaune"),
            ({"alerts": []}, "vert"),
            ({"status": "pending", "max_level": "rouge"}, "vert"),
        ]
        for payload, expected in cases:
            with self.subTest(payload=payload):
                self.assertEqual(self.level("vigieau", payload), expected)

    def test_legacy_payload_retains_its_fingerprint(self):
        legacy = {"max_level": "jaune", "alerts": [{
            "zone": "Bassin test", "level": "alerte", "measure": "Économiser",
            "start_date": "2026-10-01", "end_date": "2026-10-31",
        }]}
        canonical = json.dumps(legacy, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        self.assertEqual(self.fingerprint(legacy, "vigieau"), hashlib.sha256(canonical.encode()).hexdigest())

    def test_changes_to_actual_rules_change_the_fingerprint(self):
        original = restrictions()
        changes = [
            ("description", lambda data: data["alerts"][0]["usages"][0].update(description="Interdit toute la journée")),
            ("profiles", lambda data: data["alerts"][0]["usages"][0].update(profiles=["entreprise"])),
            ("communes", lambda data: data["alerts"][0]["communes"].append({"code": "38563", "name": "Voiron"})),
            ("decree", lambda data: data["alerts"][0]["arrete"].update(id=301)),
            ("validity", lambda data: data["alerts"][0]["arrete"].update(end_date="2026-11-30")),
            ("resource", lambda data: data["alerts"][0].update(water_type="SOU")),
        ]
        previous = self.fingerprint(original, "vigieau")
        for name, change in changes:
            with self.subTest(change=name):
                updated = deepcopy(original)
                change(updated)
                self.assertNotEqual(previous, self.fingerprint(updated, "vigieau"))

    def test_transport_refresh_and_regenerated_usage_ids_are_ignored(self):
        original = restrictions()
        refreshed = deepcopy(original)
        refreshed.update(status="stale", source="https://example.test/other-api", updated_at="2026-10-21T12:00:00Z", alerts_total=99, complete=False)
        refreshed["alerts"][0].update(id=101, updated_at="2026-10-21", usage_count=99)
        refreshed["alerts"][0]["usages"][0].update(id=201, source="changed")
        refreshed["alerts"][0]["arrete"].update(url="https://example.test/moved.pdf", framework_url="https://example.test/framework.pdf")
        self.assertEqual(self.fingerprint(original, "vigieau"), self.fingerprint(refreshed, "vigieau"))

    def test_alert_usage_commune_and_profile_order_is_ignored(self):
        original = restrictions()
        original["alerts"].append({"zone": "Autre bassin", "level": "alerte"})
        original["alerts"][0]["communes"].append({"code": "38563", "name": "Voiron"})
        original["alerts"][0]["usages"].append({"name": "Lavage", "description": "Interdit", "profiles": ["entreprise"]})
        reordered = deepcopy(original)
        reordered["alerts"][0]["usages"][0]["profiles"].reverse()
        reordered["alerts"][0]["usages"].reverse()
        reordered["alerts"][0]["communes"].reverse()
        reordered["alerts"].reverse()
        self.assertEqual(self.fingerprint(original, "vigieau"), self.fingerprint(reordered, "vigieau"))

    def test_unconfirmed_snapshots_never_send_or_replace_notification_state(self):
        check = self.namespace["_check_and_send_notifications"]
        redis = self.namespace["_redis"]
        redis.values["notif:state:water:vigieau"] = '{"last_seen_level":"rouge"}'
        for status in ("offline", "degraded", "pending", "stale", "partial", "error", ""):
            payload = restrictions()
            payload["status"] = status
            check("vigieau", payload)
        self.namespace["_send_discord_webhook"].assert_not_called()
        self.assertEqual(redis.values["notif:state:water:vigieau"], '{"last_seen_level":"rouge"}')

    def test_crisis_passes_orange_threshold_and_unchanged_refresh_does_not_repeat(self):
        check = self.namespace["_check_and_send_notifications"]
        payload = restrictions()
        check("vigieau", payload)
        refreshed = deepcopy(payload)
        refreshed["updated_at"] = "2026-10-21T12:00:00Z"
        refreshed["alerts"][0]["usages"][0]["id"] += 1
        check("vigieau", refreshed)
        self.assertEqual(self.namespace["_send_discord_webhook"].call_count, 1)
        self.assertEqual(self.namespace["_build_discord_embed"].call_args.args[1], "rouge")
        refreshed["alerts"][0]["usages"][0]["description"] = "Interdit toute la journée"
        check("vigieau", refreshed)
        check("vigieau", refreshed)
        self.assertEqual(self.namespace["_send_discord_webhook"].call_count, 2)

    def test_online_empty_snapshot_clears_observed_level_without_an_alert(self):
        check = self.namespace["_check_and_send_notifications"]
        check("vigieau", restrictions())
        check("vigieau", {"status": "online", "alerts": [], "max_level": "vert"})
        state = json.loads(self.namespace["_redis"].get("notif:state:water:vigieau"))
        self.assertEqual(state["last_seen_level"], "vert")
        self.assertTrue(state["seen_below"])
        self.assertEqual(self.namespace["_send_discord_webhook"].call_count, 1)


if __name__ == "__main__":
    unittest.main()
