"""ANFR retry deadlines and last good data survive failed collections without I/O."""

import ast
from concurrent.futures import Future
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from threading import Lock
import unittest
from unittest.mock import Mock


MAIN_PATH = Path(__file__).resolve().parents[1] / "app" / "main.py"
SUCCESS_AT = "2026-10-20T10:00:00Z"
ATTEMPT_AT = "2026-10-21T10:00:00Z"
RAW_ERROR = "('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))"


def load_functions(names, namespace):
    tree = ast.parse(MAIN_PATH.read_text(encoding="utf-8-sig"))
    definitions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *definitions], type_ignores=[])),
                 str(MAIN_PATH), "exec"), namespace)
    return namespace


def good_payload(supports=42):
    return {"schema_version": 3, "status": "online", "complete": True, "supports_total": supports,
            "stations_total": supports * 2, "supports_points": [{"id": "38-test", "lat": 45.1, "lon": 5.7}] if supports else [],
            "updated_at": SUCCESS_AT, "last_success_at": SUCCESS_AT, "error": None}


def refresh_namespace(previous=None, result=None, error=None):
    namespace = {
        "datetime": datetime, "timedelta": timedelta, "deepcopy": deepcopy,
        "monotonic": Mock(return_value=100), "utc_timestamp": lambda: ATTEMPT_AT,
        "_service_runtime_lock": Lock(), "_service_runtime": {},
        "_external_risks_snapshot_lock": Lock(),
        "_external_risks_snapshot": {"payload": {"anfr_isere": previous} if previous else {}},
        "_REDIS_OK": False, "_redis": None,
        "_service_meta": Mock(return_value={"refreshing": True}),
        "_broadcast_risk_update_from_thread": Mock(), "_update_service_slot": Mock(),
        "SERVICE_BACKOFF_SECONDS": (60, 180, 300, 900), "SERVICE_CIRCUIT_BREAKER_OPEN_AFTER": 3,
    }
    fetcher = Mock(side_effect=error) if error else Mock(return_value=result)
    namespace["fetcher"] = fetcher
    namespace["build_external_risks_fetch_jobs"] = Mock(return_value={
        "anfr_isere": (fetcher, {"status": "pending", "supports_total": None, "updated_at": None}),
    })
    return load_functions({"_normalise_anfr_service_payload", "_anfr_history_preference", "_refresh_one_service"}, namespace)


class AnfrRefreshTests(unittest.TestCase):
    def collected(self, namespace):
        self.assertTrue(namespace["_refresh_one_service"]("anfr_isere"))
        namespace["_update_service_slot"].assert_called_once()
        return namespace["_update_service_slot"].call_args.args[1]

    def test_unavailable_result_preserves_previous_counts_points_and_collection_date(self):
        previous = good_payload()
        ns = refresh_namespace(previous, {"status": "unavailable", "supports_total": 0,
                                         "updated_at": ATTEMPT_AT, "error": RAW_ERROR,
                                         "error_detail": RAW_ERROR, "last_attempt_at": ATTEMPT_AT})
        result = self.collected(ns)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["supports_total"], 42)
        self.assertEqual(result["supports_points"], previous["supports_points"])
        self.assertEqual(result["updated_at"], SUCCESS_AT)
        self.assertEqual(result["last_attempt_at"], ATTEMPT_AT)
        runtime = ns["_service_runtime"]["anfr_isere"]
        self.assertEqual(runtime["last_success_at"], SUCCESS_AT)
        self.assertEqual(runtime["failure_count"], 1)
        self.assertEqual(runtime["next_retry_mono"], 160)
        self.assertNotIn(RAW_ERROR, str(result))
        self.assertEqual(previous, good_payload(), "A failed collection must not mutate the previous snapshot")

    def test_exception_preserves_a_verified_zero_result_and_its_original_date(self):
        ns = refresh_namespace(good_payload(0), error=ConnectionResetError(RAW_ERROR))
        result = self.collected(ns)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["supports_total"], 0)
        self.assertEqual(result["stations_total"], 0)
        self.assertEqual(result["updated_at"], SUCCESS_AT)
        self.assertTrue(result["data_available"])
        self.assertNotIn(RAW_ERROR, str(result))
        self.assertNotIn(RAW_ERROR, str(ns["_service_runtime"]))

    def test_more_recent_retained_cache_wins_over_an_older_local_snapshot(self):
        previous = good_payload(42)
        more_recent = "2026-10-20T12:00:00Z"
        stale = {**good_payload(43), "status": "stale", "complete": False, "retained_previous": True,
                 "updated_at": more_recent, "last_success_at": more_recent, "last_attempt_at": ATTEMPT_AT}
        ns = refresh_namespace(previous, stale)
        ns["_service_runtime"]["anfr_isere"] = {"last_success_at": SUCCESS_AT}
        result = self.collected(ns)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["supports_total"], 43)
        self.assertEqual(result["updated_at"], more_recent)
        self.assertEqual(result["last_attempt_at"], ATTEMPT_AT)
        self.assertEqual(ns["_service_runtime"]["anfr_isere"]["last_success_at"], more_recent)
        self.assertEqual(ns["_service_runtime"]["anfr_isere"]["failure_count"], 1)

    def test_more_recent_local_snapshot_wins_over_an_older_retained_cache(self):
        previous = {**good_payload(43), "updated_at": "2026-10-20T12:00:00Z",
                    "last_success_at": "2026-10-20T12:00:00Z"}
        stale = {**good_payload(42), "status": "stale", "complete": False, "retained_previous": True,
                 "last_attempt_at": ATTEMPT_AT}
        result = self.collected(refresh_namespace(previous, stale))
        self.assertEqual(result["supports_total"], 43)
        self.assertEqual(result["updated_at"], previous["updated_at"])
        self.assertEqual(result["last_attempt_at"], ATTEMPT_AT)

    def test_equal_collection_dates_prefer_verified_v3_history_over_legacy_in_both_directions(self):
        legacy = {"status": "online", "supports_total": 42, "stations_total": 84, "updated_at": SUCCESS_AT}
        verified = {**good_payload(43), "status": "stale", "complete": False, "retained_previous": True,
                    "last_attempt_at": ATTEMPT_AT}
        for previous, fetched in ((legacy, verified), (good_payload(43), legacy)):
            with self.subTest(previous_schema=previous.get("schema_version")):
                result = self.collected(refresh_namespace(previous, fetched))
                self.assertEqual(result["supports_total"], 43)
                self.assertEqual(result["schema_version"], 3)
                self.assertNotIn("legacy_unverified", result)
                self.assertEqual(result["updated_at"], SUCCESS_AT)

    def test_history_dates_are_compared_in_utc(self):
        previous = {**good_payload(43), "updated_at": "2026-10-20T11:00:00+02:00",
                    "last_success_at": "2026-10-20T11:00:00+02:00"}
        stale = {**good_payload(42), "status": "stale", "complete": False, "retained_previous": True}
        result = self.collected(refresh_namespace(previous, stale))
        self.assertEqual(result["supports_total"], 42)
        self.assertEqual(result["updated_at"], SUCCESS_AT)

    def test_cold_failure_never_claims_a_zero_census_or_a_fresh_collection(self):
        for error in (None, ConnectionResetError(RAW_ERROR)):
            with self.subTest(raised=bool(error)):
                ns = refresh_namespace(result={"status": "unavailable", "error": RAW_ERROR,
                                               "supports_total": 0, "updated_at": ATTEMPT_AT}, error=error)
                result = self.collected(ns)
                self.assertEqual(result["status"], "unavailable")
                self.assertIsNone(result["supports_total"])
                self.assertIsNone(result["stations_total"])
                self.assertIsNone(result["updated_at"])
                self.assertEqual(result["last_attempt_at"], ATTEMPT_AT)
                self.assertFalse(result["data_available"])
                self.assertEqual(ns["_service_runtime"]["anfr_isere"]["failure_count"], 1)

    def test_stale_cache_with_no_error_is_still_a_failed_attempt(self):
        stale = {**good_payload(), "status": "stale", "complete": False, "retained_previous": True,
                 "last_attempt_at": ATTEMPT_AT}
        ns = refresh_namespace(result=stale)
        result = self.collected(ns)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["updated_at"], SUCCESS_AT)
        runtime = ns["_service_runtime"]["anfr_isere"]
        self.assertEqual(runtime["failure_count"], 1)
        self.assertEqual(runtime["last_success_at"], SUCCESS_AT)

    def test_incomplete_online_result_cannot_reset_backoff(self):
        ns = refresh_namespace(result={**good_payload(), "complete": False})
        result = self.collected(ns)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(ns["_service_runtime"]["anfr_isere"]["failure_count"], 1)

    def test_complete_online_result_clears_backoff_and_uses_actual_collection_date(self):
        ns = refresh_namespace(result=good_payload())
        ns["_service_runtime"]["anfr_isere"] = {"failure_count": 4, "next_retry_mono": 99, "circuit_open": True}
        self.assertEqual(self.collected(ns)["status"], "online")
        runtime = ns["_service_runtime"]["anfr_isere"]
        self.assertEqual(runtime["failure_count"], 0)
        self.assertEqual(runtime["next_retry_mono"], 0)
        self.assertEqual(runtime["last_success_at"], SUCCESS_AT)
        self.assertFalse(runtime["circuit_open"])

    def test_legacy_real_counts_are_retained_but_old_false_zero_errors_are_rejected(self):
        ns = refresh_namespace()
        normalise = ns["_normalise_anfr_service_payload"]
        for count, expected_status in ((42, "stale"), (0, "unavailable")):
            with self.subTest(count=count):
                legacy = {"status": "online", "supports_total": count, "stations_total": count * 2,
                          "updated_at": SUCCESS_AT, "error": RAW_ERROR, "error_detail": RAW_ERROR,
                          "meta": {"last_error": RAW_ERROR}}
                result = normalise(legacy)
                self.assertEqual(result["status"], expected_status)
                self.assertNotIn(RAW_ERROR, str(result))
                self.assertNotIn("error_detail", result)
                if count:
                    self.assertTrue(result["legacy_unverified"])
                    self.assertEqual(result["updated_at"], SUCCESS_AT)
                else:
                    self.assertIsNone(result["supports_total"])
                    self.assertIsNone(result["updated_at"])

    def test_persisted_legacy_error_is_sanitised_before_snapshot_reads(self):
        ns = refresh_namespace()
        legacy = {"status": "online", "supports_total": 0, "updated_at": SUCCESS_AT,
                  "error": RAW_ERROR, "meta": {"last_error": RAW_ERROR, "last_success_at": SUCCESS_AT}}
        ns["_external_risks_snapshot"]["payload"]["anfr_isere"] = legacy
        load_functions({"_get_external_risks_snapshot"}, ns)
        result = ns["_get_external_risks_snapshot"]()["anfr_isere"]
        self.assertNotIn(RAW_ERROR, str(result))
        self.assertIsNone(result["supports_total"])
        self.assertIsNone(result["updated_at"])
        self.assertIsNone(result["meta"]["last_success_at"])
        self.assertEqual(legacy["error"], RAW_ERROR, "Reading a snapshot must not mutate its shared root")

    def test_remote_legacy_error_is_sanitised_before_a_direct_sse_publication(self):
        ns = refresh_namespace()
        ns.update({"SERVICE_REFRESH_INTERVALS": {"anfr_isere": 21600},
                   "_external_risks_revisions": {}, "_is_any_service_refreshing": lambda: False,
                   "load_risk_service_snapshots": Mock(return_value={
                       "anfr_isere": {"revision": ATTEMPT_AT, "payload": {
                           "status": "online", "supports_total": 0, "error": RAW_ERROR,
                           "updated_at": SUCCESS_AT}},
                   })})
        load_functions({"_sync_shared_risk_snapshots"}, ns)
        ns["_sync_shared_risk_snapshots"]()
        published = ns["_broadcast_risk_update_from_thread"].call_args.args[0]["payload"]
        self.assertNotIn(RAW_ERROR, str(published))
        self.assertIsNone(published["supports_total"])
        self.assertEqual(published["status"], "unavailable")

    def test_other_legacy_providers_keep_their_existing_success_policy(self):
        ns = refresh_namespace(result={"status": "stale", "error": "temporary"})
        ns["build_external_risks_fetch_jobs"].return_value = {"meteo_france": (ns["fetcher"], {})}
        self.assertTrue(ns["_refresh_one_service"]("meteo_france"))
        self.assertEqual(ns["_service_runtime"]["meteo_france"]["failure_count"], 0)


class SchedulerStop:
    def __init__(self, clock, ticks):
        self.clock = clock
        self.ticks = iter(ticks)
        self.stopped = False
        self.on_tick = lambda: None

    def is_set(self):
        return self.stopped

    def wait(self, _duration):
        try:
            self.clock.return_value = next(self.ticks)
            self.on_tick()
        except StopIteration:
            self.stopped = True
        return self.stopped


class AnfrSchedulerTests(unittest.TestCase):
    def scheduler(self, ticks, intervals=None, queued=False):
        clock = Mock(return_value=0)
        stop = SchedulerStop(clock, ticks)
        calls = []
        futures = []
        runtime = {}

        def submit(function, key):
            calls.append((clock(), key))
            future = Future()
            futures.append(future)
            if not queued:
                future.set_result(function(key))
            return future

        ns = {"monotonic": clock, "_refresh_stop_event": stop,
              "_refresh_executor": Mock(submit=Mock(side_effect=submit)),
              "_service_runtime_lock": Lock(), "_service_runtime": runtime,
              "SERVICE_REFRESH_INTERVALS": intervals or {"anfr_isere": 21600},
              "_refresh_one_service": Mock()}
        load_functions({"_service_scheduler"}, ns)
        return ns, stop, calls, futures

    def test_anfr_retries_at_60_then_180_seconds_and_returns_to_six_hours_after_success(self):
        ns, _, calls, _ = self.scheduler([59, 60, 61, 239, 240, 241, 21839, 21840])
        failures = iter((60, 240, 0, 0))

        def collect(key):
            ns["_service_runtime"][key] = {"next_retry_mono": next(failures)}

        ns["_refresh_one_service"].side_effect = collect
        ns["_service_scheduler"]()
        self.assertEqual(calls, [(0, "anfr_isere"), (60, "anfr_isere"), (240, "anfr_isere"), (21840, "anfr_isere")])

    def test_expired_retry_does_not_fill_the_queue_while_its_future_is_pending(self):
        ns, stop, calls, futures = self.scheduler([60, 61, 62, 63, 64, 65], queued=True)
        ns["_service_runtime"]["anfr_isere"] = {"next_retry_mono": 60}

        def tick():
            if ns["monotonic"]() == 63:
                futures[0].set_result(True)

        stop.on_tick = tick
        ns["_service_scheduler"]()
        self.assertEqual(calls, [(60, "anfr_isere"), (65, "anfr_isere")])
        self.assertEqual(len(futures), 2)

    def test_a_declined_remote_lock_does_not_retry_the_same_expired_deadline_every_tick(self):
        ns, _, calls, _ = self.scheduler([10, 10.5, 11, 14.9, 15, 20])
        ns["_service_runtime"]["anfr_isere"] = {"next_retry_mono": 10}
        ns["_service_scheduler"]()
        self.assertEqual(calls, [(10, "anfr_isere"), (15, "anfr_isere"), (20, "anfr_isere")])

    def test_an_active_manual_collection_is_not_queued_by_scheduler(self):
        ns, stop, calls, _ = self.scheduler([1, 2, 3], queued=True)
        ns["_service_runtime"]["anfr_isere"] = {"refreshing": True}

        def finish_manual():
            if ns["monotonic"]() == 2:
                ns["_service_runtime"]["anfr_isere"]["refreshing"] = False

        stop.on_tick = finish_manual
        ns["_service_scheduler"]()
        self.assertEqual(calls, [(2, "anfr_isere")])

    def test_other_services_keep_normal_intervals_even_when_anfr_retries(self):
        ns, _, calls, _ = self.scheduler([0.4, 60, 90, 180], {"meteo_france": 90, "anfr_isere": 21600})

        def collect(key):
            if key == "anfr_isere":
                ns["_service_runtime"][key] = {"next_retry_mono": 60}

        ns["_refresh_one_service"].side_effect = collect
        ns["_service_scheduler"]()
        self.assertEqual([time for time, key in calls if key == "meteo_france"], [0, 90, 180])
        self.assertIn((60, "anfr_isere"), calls)


if __name__ == "__main__":
    unittest.main()
