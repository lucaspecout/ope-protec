"""Reproduce synthetic SSE/loading microbenchmarks without network or app startup.

Run: python scripts/benchmark_loading.py [--resources 12000] [--clients 10]
The baseline models the previous deepcopy + per-client JSON encoding. Current
functions are extracted through AST to avoid PostgreSQL/Redis initialization.
These timings describe local CPU work, not deployed page load times.
"""

import argparse
import ast
from copy import deepcopy
import json
from pathlib import Path
from statistics import median
from threading import Lock
from time import perf_counter


class TimedLock:
    def __init__(self):
        self.lock = Lock()
        self.hold_ms = []

    def __enter__(self):
        self.lock.acquire()
        self.started = perf_counter()
        return self

    def __exit__(self, *_):
        self.hold_ms.append((perf_counter() - self.started) * 1000)
        self.lock.release()


def load_current_functions(namespace):
    path = Path(__file__).resolve().parents[1] / "backend" / "app" / "main.py"
    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                 and node.name in {"_serialize_risk_event", "_get_external_risks_snapshot"}]
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(path), "exec"), namespace)
    return namespace


def measure(function, repeats):
    durations = []
    for _ in range(repeats):
        started = perf_counter()
        result = function()
        durations.append((perf_counter() - started) * 1000)
    return median(durations), result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", type=int, default=12000)
    parser.add_argument("--clients", type=int, default=10)
    parser.add_argument("--repeats", type=int, default=7)
    args = parser.parse_args()
    if min(args.resources, args.clients, args.repeats) < 1:
        parser.error("resources, clients and repeats must all be positive")

    payload = {"type": "service_update", "service_key": "finess_isere", "payload": {
        "status": "online", "resources": [{
            "id": i, "name": "Etablissement de sant\u00e9 num\u00e9ro " + str(i),
            "category": "hospital", "lat": 45.1234 + i / 1000000,
            "lon": 5.4321 + i / 1000000,
            "address": "10 avenue de la R\u00e9publique, Grenoble", "source": "FINESS",
        } for i in range(args.resources)],
    }}
    snapshot = {"finess_isere": payload["payload"],
                "geodae_isere": deepcopy(payload["payload"])}
    lock = TimedLock()
    namespace = load_current_functions({
        "json": json, "deepcopy": deepcopy,
        "_external_risks_snapshot_lock": lock,
        "_external_risks_snapshot": {"payload": snapshot},
    })

    def old_broadcast():
        detached = deepcopy(payload)
        return [f"data: {json.dumps(detached)}\n\n" for _ in range(args.clients)]

    def new_broadcast():
        frame = namespace["_serialize_risk_event"](payload)
        return [frame] * args.clients

    old_ms, old_frames = measure(old_broadcast, args.repeats)
    old_frame_bytes = len(old_frames[0].encode("utf-8"))
    del old_frames
    new_ms, new_frames = measure(new_broadcast, args.repeats)
    # Encoding options change the bytes, but the parsed event stays identical.
    assert json.loads(new_frames[0].removeprefix("data: ")) == payload

    def old_snapshot_read():
        with lock:
            return deepcopy(snapshot)

    measure(old_snapshot_read, args.repeats)
    old_lock_ms = median(lock.hold_ms)
    lock.hold_ms.clear()
    _, copied = measure(namespace["_get_external_risks_snapshot"], args.repeats)
    assert copied == snapshot and copied is not snapshot

    print(json.dumps({
        "synthetic": True, "resources_per_feed": args.resources,
        "sse_clients": args.clients, "median_runs": args.repeats,
        "broadcast_before_ms": round(old_ms, 3),
        "broadcast_after_ms": round(new_ms, 3),
        "broadcast_speedup": round(old_ms / new_ms, 2),
        "frame_before_bytes": old_frame_bytes,
        "frame_after_bytes": len(new_frames[0].encode("utf-8")),
        "snapshot_feeds": 2,
        "snapshot_lock_before_ms": round(old_lock_ms, 4),
        "snapshot_lock_after_ms": round(median(lock.hold_ms), 4),
    }, indent=2))


if __name__ == "__main__":
    main()
