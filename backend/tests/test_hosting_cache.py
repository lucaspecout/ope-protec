"""Hosting collection caches keep complete inventories and truthful dates."""
import ast
from copy import deepcopy
from datetime import datetime, timedelta
import math
import secrets
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

try:
    from fastapi import Depends, FastAPI, Header, HTTPException, Query
    from fastapi.testclient import TestClient
    HAVE_FASTAPI = True
except ImportError:
    HAVE_FASTAPI = False


PATH = Path(__file__).resolve().parents[1] / "app/services.py"


def environment():
    names = {"_hosting_payload_age_seconds", "_hosting_successful_payload", "_hosting_response_view",
             "_hosting_unavailable_payload", "fetch_verified_hosting_isere"}
    nodes = [node for node in ast.parse(PATH.read_text(encoding="utf-8-sig")).body
             if isinstance(node, ast.FunctionDef) and node.name in names]
    namespace = {
        "datetime": datetime, "timedelta": timedelta, "math": math, "secrets": secrets, "deepcopy": deepcopy,
        "HOSTING_SOURCE_URL": "https://equipements.sports.gouv.fr/explore/dataset/data-es/",
        "collect_verified_hosting_isere": Mock(), "_redis_get": Mock(return_value=None),
        "_redis_set": Mock(), "_file_cache_load": Mock(return_value=None), "_file_cache_save": Mock(),
        "_REDIS_OK": False, "_redis": None, "_REDIS_KEY_PREFIX": "svc:",
        "_VERIFIED_HOSTING_ISERE_CACHE_TTL_SECONDS": 86400, "_PERSIST_TTL_SECONDS": 604800,
        "_VERIFIED_HOSTING_KEY": "hosting_isere_v2", "_VERIFIED_HOSTING_FILE": "hosting_isere_v2.json",
        "_verified_hosting_fetch_lock": Lock(), "_verified_hosting_isere_cache_lock": Lock(),
        "_verified_hosting_isere_cache": {"payload": None, "expires_at": datetime.min,
                                          "failure": None, "retry_at": datetime.min},
    }
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    module = ast.fix_missing_locations(ast.Module(body=[future, *nodes], type_ignores=[]))
    exec(compile(module, str(PATH), "exec"), namespace)
    return namespace


def inventory(age_hours=0, total=3):
    stamp = (datetime.utcnow() - timedelta(hours=age_hours)).isoformat() + "Z"
    return {"schema_version": 2, "status": "online", "complete": True,
            "count": total, "updated_at": stamp, "last_success_at": stamp,
            "points": [{"id": f"dataes-{index}", "lat": 45.2, "lon": 5.7,
                        "name": f"Salle {index}", "type": "gymnase", "verified": True}
                       for index in range(total)]}


class HostingCacheTests(unittest.TestCase):
    def test_success_persists_and_memory_returns_isolated_copies(self):
        env = environment()
        env["collect_verified_hosting_isere"].return_value = inventory()
        result = env["fetch_verified_hosting_isere"]()
        self.assertEqual(result["count"], 3)
        self.assertTrue(result["complete"])
        self.assertFalse(result["truncated"])
        self.assertEqual(env["_redis_set"].call_count, 2)
        env["_file_cache_save"].assert_called_once()
        result["points"].clear()
        again = env["fetch_verified_hosting_isere"]()
        self.assertEqual(len(again["points"]), 3)
        env["collect_verified_hosting_isere"].assert_called_once()

    def test_preview_limit_does_not_poison_the_full_cache(self):
        env = environment()
        env["collect_verified_hosting_isere"].return_value = inventory()
        preview = env["fetch_verified_hosting_isere"](limit=1)
        self.assertEqual(preview["count"], 1)
        self.assertEqual(preview["total_count"], 3)
        self.assertEqual(preview["returned_count"], 1)
        self.assertTrue(preview["collection_complete"])
        self.assertFalse(preview["complete"])
        self.assertTrue(preview["truncated"])
        full = env["fetch_verified_hosting_isere"](limit=5000)
        self.assertEqual(full["count"], 3)
        self.assertTrue(full["complete"])
        self.assertEqual(env["_file_cache_save"].call_args.args[1]["count"], 3)

    def test_cold_failure_is_unavailable_and_does_not_cache_an_empty_success(self):
        env = environment()
        env["collect_verified_hosting_isere"].side_effect = ConnectionResetError("private exception details")
        result = env["fetch_verified_hosting_isere"]()
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["count"])
        self.assertIsNone(result["updated_at"])
        self.assertEqual(result["points"], [])
        self.assertTrue(result["last_attempt_at"])
        self.assertNotIn("private", result["error"])
        env["_redis_set"].assert_not_called()
        env["_file_cache_save"].assert_not_called()

    def test_failed_refresh_keeps_newest_good_data_across_memory_redis_and_file(self):
        for newest in ("memory", "shared", "file"):
            with self.subTest(newest=newest):
                env = environment()
                copies = {name: inventory(age_hours=25 if name == newest else 48, total=index + 1)
                          for index, name in enumerate(("memory", "shared", "file"))}
                env["_verified_hosting_isere_cache"]["payload"] = copies["memory"]
                env["_redis_get"].side_effect = lambda key: deepcopy(copies["shared"]) if key.startswith("persist:") else None
                env["_file_cache_load"].return_value = copies["file"]
                env["collect_verified_hosting_isere"].return_value = {"status": "unavailable"}
                result = env["fetch_verified_hosting_isere"](force_refresh=True)
                self.assertEqual(result["status"], "stale")
                self.assertTrue(result["retained_previous"])
                self.assertEqual(result["points"], copies[newest]["points"])
                self.assertEqual(result["updated_at"], copies[newest]["updated_at"])
                self.assertFalse(result["complete"])
                self.assertEqual(copies["memory"]["status"], "online")
                env["_file_cache_save"].assert_not_called()

    def test_failure_cooldown_prevents_repeated_downloads_and_manual_retry_bypasses_it(self):
        env = environment()
        env["collect_verified_hosting_isere"].return_value = {"status": "unavailable"}
        env["fetch_verified_hosting_isere"]()
        env["fetch_verified_hosting_isere"]()
        env["collect_verified_hosting_isere"].assert_called_once()
        env["collect_verified_hosting_isere"].return_value = inventory()
        result = env["fetch_verified_hosting_isere"](force_refresh=True)
        self.assertEqual(result["status"], "online")
        self.assertEqual(env["collect_verified_hosting_isere"].call_count, 2)
        self.assertIsNone(env["_verified_hosting_isere_cache"]["failure"])

    def test_expired_persistent_inventory_is_refreshed_instead_of_rejuvenated(self):
        env = environment()
        old = inventory(age_hours=48)
        env["_file_cache_load"].return_value = old
        env["collect_verified_hosting_isere"].return_value = inventory(total=4)
        result = env["fetch_verified_hosting_isere"]()
        self.assertEqual(result["count"], 4)
        self.assertNotEqual(result["updated_at"], old["updated_at"])
        env["collect_verified_hosting_isere"].assert_called_once()

    def test_shared_inventory_uses_its_remaining_lifetime(self):
        env = environment()
        shared = inventory(age_hours=23)
        env["_redis_get"].return_value = shared
        result = env["fetch_verified_hosting_isere"]()
        self.assertEqual(result["updated_at"], shared["updated_at"])
        env["collect_verified_hosting_isere"].assert_not_called()
        remaining = (env["_verified_hosting_isere_cache"]["expires_at"] - datetime.utcnow()).total_seconds()
        self.assertGreater(remaining, 3500)
        self.assertLessEqual(remaining, 3600)

    def test_legacy_and_incomplete_snapshots_cannot_be_reused_as_success(self):
        for changed in ({"schema_version": 1}, {"complete": False}, {"truncated": True},
                        {"updated_at": "invalid"}, {"count": 5}, {"status": "unavailable"}):
            with self.subTest(changed=changed):
                env = environment()
                env["_file_cache_load"].return_value = {**inventory(), **changed}
                env["collect_verified_hosting_isere"].return_value = inventory(total=4)
                self.assertEqual(env["fetch_verified_hosting_isere"]()["count"], 4)

    def test_complete_empty_result_clears_old_sites(self):
        env = environment()
        env["_verified_hosting_isere_cache"]["payload"] = inventory()
        env["collect_verified_hosting_isere"].return_value = inventory(total=0)
        result = env["fetch_verified_hosting_isere"](force_refresh=True)
        self.assertEqual(result["status"], "online")
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["points"], [])
        self.assertTrue(result["complete"])

    def test_simultaneous_cold_read_is_pending_without_starting_a_duplicate_collection(self):
        env = environment()
        env["_verified_hosting_fetch_lock"].acquire()
        try:
            result = env["fetch_verified_hosting_isere"]()
        finally:
            env["_verified_hosting_fetch_lock"].release()
        self.assertEqual(result["status"], "pending")
        self.assertEqual(result["retry_after_seconds"], 5)
        self.assertIsNone(result["count"])
        env["collect_verified_hosting_isere"].assert_not_called()

    def test_another_worker_collecting_returns_pending_without_a_duplicate_download(self):
        env = environment()
        redis = Mock()
        redis.set.return_value = False
        env.update(_REDIS_OK=True, _redis=redis)
        result = env["fetch_verified_hosting_isere"]()
        self.assertEqual(result["status"], "pending")
        self.assertFalse(env["_verified_hosting_fetch_lock"].locked())
        env["collect_verified_hosting_isere"].assert_not_called()
        redis.eval.assert_not_called()

    def test_owned_distributed_lock_is_released_after_success_or_failure(self):
        for success in (True, False):
            with self.subTest(success=success):
                env = environment()
                redis = Mock()
                redis.set.return_value = True
                env.update(_REDIS_OK=True, _redis=redis)
                env["collect_verified_hosting_isere"].return_value = inventory() if success else {"status": "unavailable"}
                env["fetch_verified_hosting_isere"]()
                self.assertFalse(env["_verified_hosting_fetch_lock"].locked())
                redis.eval.assert_called_once()
                self.assertEqual(redis.set.call_args.kwargs, {"nx": True, "ex": 90})
                self.assertEqual(redis.eval.call_args.args[-1], redis.set.call_args.args[1])

    def test_distributed_lock_outage_still_allows_a_bounded_local_collection(self):
        env = environment()
        redis = Mock()
        redis.set.side_effect = ConnectionError("redis unreachable")
        env.update(_REDIS_OK=True, _redis=redis)
        env["collect_verified_hosting_isere"].return_value = inventory()
        self.assertEqual(env["fetch_verified_hosting_isere"]()["status"], "online")
        self.assertFalse(env["_verified_hosting_fetch_lock"].locked())
        redis.eval.assert_not_called()


@unittest.skipUnless(HAVE_FASTAPI, "Install project FastAPI/httpx dependencies to exercise HTTP contracts")
class HostingRouteTests(unittest.TestCase):
    def setUp(self):
        self.collector = Mock(return_value=inventory())
        app = FastAPI()

        def identity(authorization: str | None = Header(default=None)):
            if authorization != "Bearer fixture-user":
                raise HTTPException(401, "Invalid credentials")
            return SimpleNamespace(id=1)

        main_path = PATH.with_name("main.py")
        node = next(node for node in ast.parse(main_path.read_text(encoding="utf-8-sig")).body
                    if isinstance(node, ast.FunctionDef) and node.name == "api_verified_hosting_isere")
        namespace = {"app": app, "Depends": Depends, "Query": Query, "User": SimpleNamespace,
                     "get_current_user": identity, "fetch_verified_hosting_isere": self.collector}
        future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[future, node], type_ignores=[])), str(main_path), "exec"), namespace)
        # FastAPI resolves future annotations in the registered endpoint globals.
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_unauthenticated_request_does_not_collect(self):
        response = self.client.get("/api/hosting/isere/verified")
        self.assertEqual(response.status_code, 401)
        self.collector.assert_not_called()

    def test_authenticated_refresh_and_limit_reach_the_cache(self):
        response = self.client.get("/api/hosting/isere/verified?refresh=true&limit=5000",
                                   headers={"Authorization": "Bearer fixture-user"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["count"], 3)
        self.collector.assert_called_once_with(force_refresh=True, limit=5000)

    def test_invalid_limits_are_rejected_without_a_collection(self):
        for limit in (0, 5001, "invalid"):
            response = self.client.get(f"/api/hosting/isere/verified?limit={limit}",
                                       headers={"Authorization": "Bearer fixture-user"})
            self.assertEqual(response.status_code, 422)
        self.collector.assert_not_called()

if __name__ == "__main__":
    unittest.main()
