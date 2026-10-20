"""Saved credentials are collected after busy local/remote workers finish."""

import ast
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


MAIN_PATH = Path(__file__).resolve().parents[1] / "app" / "main.py"


class ControlledStop:
    def __init__(self):
        self.stopped = False
        self.waits = []
        self.on_wait = lambda: None

    def is_set(self):
        return self.stopped

    def wait(self, duration):
        self.waits.append(duration)
        self.on_wait()
        return self.stopped


class ImmediateExecutor:
    """Run collection calls separately from coordinator waiting, without I/O."""
    def __init__(self):
        self.calls = []
        self.active = False

    def submit(self, function, *args):
        self.calls.append(args)
        future = Future()
        self.active = True
        try:
            future.set_result(function(*args))
        except Exception as error:
            future.set_exception(error)
        finally:
            self.active = False
        return future


def refresh_namespace():
    names = {"_refresh_one_service", "_run_credential_refresh", "_refresh_after_credentials_change"}
    source = ast.parse(MAIN_PATH.read_text(encoding="utf-8-sig"))
    definitions = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names]
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    ns = {
        "deepcopy": deepcopy, "datetime": datetime, "timedelta": timedelta,
        "FutureTimeoutError": FutureTimeoutError,
        "monotonic": Mock(return_value=100),
        "_service_runtime_lock": Lock(), "_service_runtime": {},
        "_external_risks_snapshot_lock": Lock(), "_external_risks_snapshot": {"payload": {}},
        "_credential_refresh_lock": Lock(), "_credential_refresh_requests": {},
        "_refresh_stop_event": ControlledStop(), "_refresh_executor": ImmediateExecutor(),
        "_REDIS_OK": False, "_redis": Mock(), "secrets": SimpleNamespace(token_hex=lambda size: "lock-token"),
        "SERVICE_CIRCUIT_BREAKER_OPEN_AFTER": 3, "SERVICE_BACKOFF_SECONDS": [30, 60, 300],
        "_update_service_slot": Mock(), "logger": Mock(), "Thread": Mock(),
        "build_external_risks_fetch_jobs": Mock(),
    }
    ns["fetcher"] = Mock(return_value={"status": "online", "stations": []})
    ns["build_external_risks_fetch_jobs"].return_value = {"meteo_observations": (ns["fetcher"], {})}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *definitions], type_ignores=[])), str(MAIN_PATH), "exec"), ns)
    return ns


class CredentialRefreshTests(unittest.TestCase):
    def setUp(self):
        self.ns = refresh_namespace()
        self.key = "meteo_observations"

    def schedule(self):
        self.ns["_refresh_after_credentials_change"](self.key)
        return self.ns["_credential_refresh_requests"][self.key]

    def run_request(self, request):
        self.ns["_run_credential_refresh"](self.key, request)

    def test_local_collection_finishing_with_old_key_is_retried_and_backoff_cleared(self):
        self.ns["_service_runtime"][self.key] = {"refreshing": True, "next_retry_mono": 1000}
        request = self.schedule()

        def previous_collection_finishes():
            self.assertFalse(self.ns["_refresh_executor"].active, "Waiting must not occupy a collection worker")
            self.ns["_service_runtime"][self.key].update(
                refreshing=False, next_retry_mono=5000, failure_count=4, circuit_open=True,
            )

        self.ns["_refresh_stop_event"].on_wait = previous_collection_finishes
        self.run_request(request)
        self.assertEqual(len(self.ns["_refresh_executor"].calls), 2)
        self.ns["fetcher"].assert_called_once()
        self.ns["_update_service_slot"].assert_called_once()
        self.assertEqual(self.ns["_service_runtime"][self.key]["next_retry_mono"], 0)
        self.assertFalse(self.ns["_service_runtime"][self.key]["circuit_open"])
        self.assertNotIn(self.key, self.ns["_credential_refresh_requests"])

    def test_remote_redis_lock_does_not_lose_new_credential_refresh(self):
        self.ns["_REDIS_OK"] = True
        self.ns["_redis"].set.side_effect = [False, True]
        self.run_request(self.schedule())
        self.assertEqual(self.ns["_redis"].set.call_count, 2)
        self.ns["fetcher"].assert_called_once()
        self.ns["_redis"].eval.assert_called_once()
        self.assertEqual(len(self.ns["_refresh_stop_event"].waits), 1)

    def test_shutdown_interrupts_lock_wait_without_another_fetch(self):
        self.ns["_service_runtime"][self.key] = {"refreshing": True}
        stop = self.ns["_refresh_stop_event"]
        stop.on_wait = lambda: setattr(stop, "stopped", True)
        self.run_request(self.schedule())
        self.assertEqual(len(self.ns["_refresh_executor"].calls), 1)
        self.ns["fetcher"].assert_not_called()
        self.assertNotIn(self.key, self.ns["_credential_refresh_requests"])

    def test_repeated_saves_share_coordinator_and_save_during_fetch_is_collected_again(self):
        request = self.schedule()
        self.schedule()
        self.assertEqual(request["revision"], 2)
        self.ns["Thread"].assert_called_once()
        self.ns["Thread"].return_value.start.assert_called_once()
        self.assertTrue(self.ns["Thread"].call_args.kwargs["daemon"])
        calls = []

        def collect():
            calls.append(True)
            if len(calls) == 1:
                self.schedule()
            return {"status": "online"}

        self.ns["fetcher"].side_effect = collect
        self.run_request(request)
        self.assertEqual(len(calls), 2)
        self.ns["Thread"].assert_called_once()
        self.assertNotIn(self.key, self.ns["_credential_refresh_requests"])

    def test_new_save_extends_deadline_and_expired_wait_does_not_loop_forever(self):
        request = self.schedule()
        self.assertEqual(request["deadline"], 430)
        self.ns["monotonic"].return_value = 420
        self.schedule()
        self.assertEqual(request["deadline"], 750)
        self.ns["monotonic"].return_value = 751
        self.run_request(request)
        self.ns["fetcher"].assert_not_called()
        self.assertEqual(self.ns["_refresh_executor"].calls, [])
        self.assertNotIn(self.key, self.ns["_credential_refresh_requests"])

    def test_shutdown_before_save_does_not_create_thread(self):
        self.ns["_refresh_stop_event"].stopped = True
        self.ns["_refresh_after_credentials_change"](self.key)
        self.ns["Thread"].assert_not_called()
        self.assertEqual(self.ns["_credential_refresh_requests"], {})

    def test_thread_creation_failure_does_not_fail_save_or_leave_debounce_stuck(self):
        self.ns["Thread"].return_value.start.side_effect = RuntimeError("process stopping")
        self.ns["_refresh_after_credentials_change"](self.key)
        self.assertEqual(self.ns["_credential_refresh_requests"], {})

    def test_shutdown_cancels_queued_collection_and_releases_coordinator(self):
        request = self.schedule()
        pending = Mock()

        def still_queued(**kwargs):
            self.ns["_refresh_stop_event"].stopped = True
            raise FutureTimeoutError()

        pending.result.side_effect = still_queued
        self.ns["_refresh_executor"].submit = Mock(return_value=pending)
        self.run_request(request)
        pending.cancel.assert_called_once()
        self.assertNotIn(self.key, self.ns["_credential_refresh_requests"])


if __name__ == "__main__":
    unittest.main()
