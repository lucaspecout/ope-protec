"""Bounded collection of the official ANFR mobile-network observatory.

The department-filtered API avoids downloading the national all-radio archive.
Only complete, validated pagination may produce a new successful snapshot.
"""
from __future__ import annotations

from datetime import datetime, timezone
from http.client import IncompleteRead
import json
import math
import re
import socket
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ANFR_SOURCE_URL = "https://data.anfr.fr/visualisation/information/?id=observatoire_2g_3g_4g"
ANFR_RECORDS_URL = "https://data.anfr.fr/d4c/api/records/1.0/search/"
ANFR_DATASET = "observatoire_2g_3g_4g"
_ANFR_FIELDS = "id,sup_id,sta_nm_anfr,sta_nm_dpt,adm_lb_nom,generation,emr_lb_systeme,coordonnees,sup_nm_haut,date_maj"
SCHEMA_VERSION = 3
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_PAGES = 40
MAX_ROWS = 50_000
MAX_DURATION_SECONDS = 60
SOCKET_TIMEOUT_SECONDS = 12
_SERVICES = ("2G", "3G", "4G", "5G")
_SAFE_ERROR = "Source ANFR temporairement indisponible ; nouvelle tentative automatique prévue."


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_json(url: str, *, timeout: float) -> dict[str, Any]:
    """Read at most one small API page with a deadline and a socket timeout."""
    deadline = time.monotonic() + timeout
    request = Request(url, headers={
        "Accept": "application/json", "Accept-Encoding": "identity",
        "User-Agent": "OpeProtec/1.0 (official ANFR mobile observatory)",
    })
    with urlopen(request, timeout=timeout) as response:
        declared = response.headers.get("Content-Length")
        if declared and int(declared) > MAX_PAGE_BYTES:
            raise ValueError("ANFR page too large")
        chunks: list[bytes] = []
        size = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("ANFR page deadline")
            # urllib's timeout is normally an inactivity timeout. Recompute it
            # between read1 calls so a trickling response cannot run forever.
            raw_socket = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
            if raw_socket is not None:
                raw_socket.settimeout(min(remaining, SOCKET_TIMEOUT_SECONDS))
            read = getattr(response, "read1", response.read)
            chunk = read(min(64 * 1024, MAX_PAGE_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_PAGE_BYTES:
                raise ValueError("ANFR page too large")
        value = json.loads(b"".join(chunks))
    if not isinstance(value, dict):
        raise ValueError("Invalid ANFR response")
    return value


def _retryable(exc: Exception) -> bool:
    if isinstance(exc, HTTPError):
        return exc.code in {408, 429, 500, 502, 503, 504}
    return isinstance(exc, (URLError, TimeoutError, ConnectionError, socket.timeout, IncompleteRead))


def _get_page(read_json: Callable[..., Any], url: str, deadline: float) -> dict[str, Any]:
    for attempt in range(2):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("ANFR collection deadline")
        try:
            page = read_json(url, timeout=min(SOCKET_TIMEOUT_SECONDS, remaining))
            if time.monotonic() > deadline:
                raise TimeoutError("ANFR collection deadline")
            if not isinstance(page, dict):
                raise ValueError("Invalid ANFR page")
            return page
        except Exception as exc:
            if attempt or not _retryable(exc):
                raise
    raise ValueError("Missing ANFR response")


def _identifier(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, (str, int)):
        return str(value).strip()
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return str(int(value))
    return ""


def _number(value: Any) -> float | None:
    try:
        number = float(str(value).strip().replace(",", "."))
        return number if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None


def _coordinates(value: Any) -> tuple[float, float] | None:
    values = value.split(",") if isinstance(value, str) else value
    if not isinstance(values, (list, tuple)) or len(values) != 2:
        return None
    latitude, longitude = (_number(part) for part in values)
    if latitude is None or longitude is None or not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return None
    # A null-island placeholder cannot be an antenna in Isère.
    if latitude == 0 and longitude == 0:
        return None
    return latitude, longitude


def _services(fields: dict[str, Any]) -> set[str]:
    generation = str(fields.get("generation") or "").upper().strip()
    found = {generation} if generation in _SERVICES else set()
    system = str(fields.get("emr_lb_systeme") or "").upper()
    for service, expression in (("2G", r"\b(?:2G|GSM)\b"), ("3G", r"\b(?:3G|UMTS)\b"),
                                ("4G", r"\b(?:4G|LTE)\b"), ("5G", r"\b(?:5G|NR)\b")):
        if re.search(expression, system):
            found.add(service)
    return found


def _release_date(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value
    except ValueError:
        return None


def collect_anfr_isere(*, read_json: Callable[..., Any] | None = None, page_size: int = 4000) -> dict[str, Any]:
    """Return a complete Isère mobile-support snapshot, or a safe unavailable result.

    ``read_json(url, timeout=...)`` can be injected without importing application
    settings, starting background tasks, or opening databases.
    """
    attempted_at = _utcnow()
    base: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION, "service": "ANFR", "source": ANFR_SOURCE_URL,
        "department": "Isère (38)", "last_attempt_at": attempted_at,
    }
    try:
        if isinstance(page_size, bool) or not isinstance(page_size, int) or not 1 <= page_size <= 4000:
            raise ValueError("Invalid ANFR page size")
        reader = read_json or _read_json
        deadline = time.monotonic() + MAX_DURATION_SECONDS
        total: int | None = None
        offset = 0
        seen: set[str] = set()
        supports: dict[str, dict[str, Any]] = {}
        stations: set[str] = set()
        operators: set[str] = set()
        releases: set[str] = set()
        for _ in range(MAX_PAGES):
            url = ANFR_RECORDS_URL + "?" + urlencode({
                "dataset": ANFR_DATASET, "refine.sta_nm_dpt": "038",
                "rows": page_size, "start": offset, "sort": "id", "fields": _ANFR_FIELDS,
            }, safe=",")
            page = _get_page(reader, url, deadline)
            page_total, records = page.get("nhits"), page.get("records")
            if page.get("status") != "success" or isinstance(page_total, bool) or not isinstance(page_total, int):
                raise ValueError("Unsuccessful ANFR page")
            if not 0 <= page_total <= MAX_ROWS or not isinstance(records, list) or len(records) > page_size:
                raise ValueError("Invalid ANFR pagination")
            if total is None:
                total = page_total
            elif page_total != total:
                raise ValueError("ANFR dataset changed during collection")
            if offset + len(records) > total or (not records and offset < total):
                raise ValueError("Incomplete ANFR pagination")
            for record in records:
                if not isinstance(record, dict) or not isinstance(record.get("fields"), dict):
                    raise ValueError("Invalid ANFR record")
                fields = record["fields"]
                row_id = _identifier(record.get("recordid")) or _identifier(fields.get("_id")) or _identifier(fields.get("id"))
                support_id, station_id = _identifier(fields.get("sup_id")), _identifier(fields.get("sta_nm_anfr"))
                if not row_id or row_id in seen or not support_id or not station_id:
                    raise ValueError("Missing or duplicate ANFR identifiers")
                if str(fields.get("sta_nm_dpt") or "").strip().zfill(3) != "038":
                    raise ValueError("ANFR department filter was not respected")
                seen.add(row_id)
                stations.add(station_id)
                operator = str(fields.get("adm_lb_nom") or "").strip()
                if operator:
                    operators.add(operator)
                support = supports.setdefault(support_id, {"stations": set(), "operators": set(), "services": set(),
                                                           "heights": set(), "coordinates": None})
                support["stations"].add(station_id)
                if operator:
                    support["operators"].add(operator)
                support["services"].update(_services(fields))
                coordinate = _coordinates(fields.get("coordonnees"))
                if coordinate is not None and support["coordinates"] is None:
                    support["coordinates"] = coordinate
                height = _number(fields.get("sup_nm_haut"))
                if height is not None and 0 <= height <= 1000:
                    support["heights"].add(height)
                release = _release_date(fields.get("date_maj"))
                if release:
                    releases.add(release)
            offset += len(records)
            if offset == total:
                break
        else:
            raise ValueError("ANFR pagination limit")
        if len(seen) != total:
            raise ValueError("Incomplete ANFR collection")
        points: list[dict[str, Any]] = []
        heights: list[float] = []
        for support_id, support in sorted(supports.items()):
            if support["heights"]:
                heights.append(sum(support["heights"]) / len(support["heights"]))
            if support["coordinates"] is None:
                continue
            latitude, longitude = support["coordinates"]
            points.append({
                "id": support_id, "lat": latitude, "lon": longitude,
                "station_name": ", ".join(sorted(support["stations"])),
                "operator": ", ".join(sorted(support["operators"])) or "non renseigné (ANFR)",
                "operators": sorted(support["operators"]), "voice_service": "non vérifié",
                "data_services": [service for service in _SERVICES if service in support["services"]],
            })
        collected_at = _utcnow()
        release = max(releases) if releases else None
        return {
            **base, "status": "online", "complete": True, "data_available": True,
            "supports_total": len(supports), "stations_total": len(stations),
            "operators_total": len(operators), "operators": sorted(operators), "records_total": total,
            "average_support_height_m": round(sum(heights) / len(heights), 1) if heights else None,
            "supports_points": points, "supports_without_coordinates": len(supports) - len(points),
            "data_release": f"Observatoire des réseaux mobiles · {release[:10]}" if release else "Observatoire des réseaux mobiles",
            "resource_updated_at": release, "published_at": release,
            "updated_at": collected_at, "last_success_at": collected_at, "error": None,
        }
    except Exception:
        return {
            **base, "status": "unavailable", "complete": False, "data_available": False,
            "supports_total": None, "stations_total": None, "operators_total": None,
            "operators": [], "records_total": None, "average_support_height_m": None,
            "supports_points": [], "data_release": None, "resource_updated_at": None, "published_at": None,
            "updated_at": None, "last_success_at": None, "error": _SAFE_ERROR,
        }
