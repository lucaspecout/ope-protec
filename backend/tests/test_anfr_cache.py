"""Keep only complete ANFR inventories, without network or application startup."""
import ast
from copy import deepcopy
from datetime import datetime, timedelta
import math
from pathlib import Path
from threading import Lock
import unittest
from unittest.mock import Mock


PATH = Path(__file__).resolve().parents[1] / "app" / "services.py"


def environment():
    names = {"_fetch_anfr_isere_antennas_live", "_anfr_payload_age_seconds",
             "_anfr_successful_payload", "fetch_anfr_isere_antennas"}
    nodes = [node for node in ast.parse(PATH.read_text(encoding="utf-8-sig")).body
             if isinstance(node, ast.FunctionDef) and node.name in names]
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    namespace = {"datetime": datetime, "timedelta": timedelta, "math": math, "deepcopy": deepcopy,
                 "ANFR_SOURCE_URL": "https://data.anfr.fr/", "collect_anfr_isere": Mock(),
                 "_redis_get": Mock(return_value=None), "_redis_set": Mock(),
                 "_ANFR_ISERE_CACHE_TTL_SECONDS": 43200, "_PERSIST_TTL_SECONDS": 604800,
                 "_anfr_isere_cache_lock": Lock(),
                 "_anfr_isere_cache": {"payload": None, "expires_at": datetime.min,
                                       "redis_key": "anfr_isere_v3"}}
    module = ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[]))
    exec(compile(module, str(PATH), "exec"), namespace)
    return namespace


def inventory(age_hours=0, total=2):
    return {"schema_version": 3, "service": "ANFR", "status": "online", "complete": True,
            "supports_total": total, "stations_total": total * 2,
            "supports_points": [{"id": "support-1", "lat": 45.2, "lon": 5.7}] if total else [],
            "updated_at": (datetime.utcnow() - timedelta(hours=age_hours)).isoformat() + "Z",
            "data_release": "Publication de test", "error": None}


class AnfrCacheTests(unittest.TestCase):
    def test_complete_success_is_persisted_and_next_read_uses_memory(self):
        env = environment()
        env["collect_anfr_isere"].return_value = inventory()
        result = env["fetch_anfr_isere_antennas"]()
        self.assertEqual(result["supports_total"], 2)
        self.assertEqual(env["_redis_set"].call_count, 2)
        again = env["fetch_anfr_isere_antennas"]()
        self.assertEqual(env["collect_anfr_isere"].call_count, 1)
        again["supports_points"].clear()
        self.assertEqual(len(env["_anfr_isere_cache"]["payload"]["supports_points"]), 1)

    def test_cold_failure_is_unknown_and_never_persisted(self):
        env = environment()
        env["collect_anfr_isere"].side_effect = ConnectionResetError("Connection reset by peer")
        result = env["fetch_anfr_isere_antennas"](force_refresh=True)
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["supports_total"])
        self.assertIsNone(result["stations_total"])
        self.assertIsNone(result["updated_at"])
        self.assertTrue(result["last_attempt_at"])
        self.assertNotIn("ConnectionReset", result["error"])
        env["_redis_set"].assert_not_called()

    def test_failed_force_refresh_restores_persistent_good_inventory_without_renewing_date(self):
        env = environment()
        prior = inventory(age_hours=48)
        env["_redis_get"].side_effect = lambda key: deepcopy(prior) if key.startswith("persist:") else None
        env["collect_anfr_isere"].return_value = {"status": "unavailable", "supports_total": None}
        result = env["fetch_anfr_isere_antennas"](force_refresh=True)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["updated_at"], prior["updated_at"])
        self.assertEqual(result["supports_total"], prior["supports_total"])
        self.assertEqual(result["supports_points"], prior["supports_points"])
        self.assertFalse(result["complete"])
        self.assertTrue(result["retained_previous"])
        env["collect_anfr_isere"].assert_called_once()
        env["_redis_set"].assert_not_called()

    def test_expired_persistent_data_is_refreshed_instead_of_promoted_as_fresh(self):
        env = environment()
        old = inventory(age_hours=48)
        env["_redis_get"].return_value = old
        env["collect_anfr_isere"].return_value = inventory(total=3)
        result = env["fetch_anfr_isere_antennas"]()
        self.assertEqual(result["supports_total"], 3)
        env["collect_anfr_isere"].assert_called_once()

    def test_failed_force_refresh_uses_newest_success_across_memory_and_shared_caches(self):
        for memory_age, shared_age, expected in ((48, 24, 3), (24, 48, 1)):
            with self.subTest(memory_age=memory_age, shared_age=shared_age):
                env = environment()
                memory = inventory(age_hours=memory_age, total=1)
                shared = inventory(age_hours=shared_age, total=3)
                env["_anfr_isere_cache"]["payload"] = memory
                env["_redis_get"].side_effect = lambda key: deepcopy(shared) if key.startswith("persist:") else None
                env["collect_anfr_isere"].return_value = {"status": "unavailable"}
                result = env["fetch_anfr_isere_antennas"](force_refresh=True)
                self.assertEqual(result["status"], "stale")
                self.assertEqual(result["supports_total"], expected)
                self.assertEqual(result["updated_at"], (shared if expected == 3 else memory)["updated_at"])
                self.assertEqual(env["_redis_get"].call_count, 2)
                env["_redis_set"].assert_not_called()

    def test_fresh_shared_cache_keeps_its_remaining_lifetime(self):
        env = environment()
        shared = inventory(age_hours=11)
        env["_redis_get"].return_value = shared
        result = env["fetch_anfr_isere_antennas"]()
        self.assertEqual(result, shared)
        env["collect_anfr_isere"].assert_not_called()
        remaining = (env["_anfr_isere_cache"]["expires_at"] - datetime.utcnow()).total_seconds()
        self.assertGreater(remaining, 3500)
        self.assertLessEqual(remaining, 3600)

    def test_old_failed_zero_or_malformed_cache_cannot_satisfy_a_request(self):
        for invalid in ({**inventory(), "status": "degraded", "supports_total": 0, "error": "raw error"},
                        {**inventory(), "schema_version": 2},
                        {**inventory(), "complete": False},
                        {**inventory(), "supports_total": None},
                        {**inventory(), "updated_at": "invalid"}):
            with self.subTest(cache=invalid):
                env = environment()
                env["_redis_get"].return_value = invalid
                env["collect_anfr_isere"].return_value = inventory(total=5)
                result = env["fetch_anfr_isere_antennas"]()
                self.assertEqual(result["supports_total"], 5)
                env["collect_anfr_isere"].assert_called_once()

    def test_complete_zero_is_real_and_replaces_previous_inventory(self):
        env = environment()
        env["_anfr_isere_cache"].update(payload=inventory(), expires_at=datetime.utcnow() + timedelta(hours=1))
        env["collect_anfr_isere"].return_value = inventory(total=0)
        result = env["fetch_anfr_isere_antennas"](force_refresh=True)
        self.assertEqual(result["status"], "online")
        self.assertEqual(result["supports_total"], 0)
        self.assertEqual(result["supports_points"], [])
        self.assertEqual(env["_anfr_isere_cache"]["payload"]["supports_total"], 0)

    def test_memory_fallback_is_not_mutated_or_written_as_a_new_success(self):
        env = environment()
        good = inventory()
        env["_anfr_isere_cache"]["payload"] = good
        env["collect_anfr_isere"].return_value = {"status": "unavailable", "error_detail": "private trace"}
        result = env["fetch_anfr_isere_antennas"](force_refresh=True)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(good["status"], "online")
        self.assertNotIn("error_detail", result)
        self.assertEqual(result["updated_at"], good["updated_at"])
        env["_redis_set"].assert_not_called()


if __name__ == "__main__":
    unittest.main()
