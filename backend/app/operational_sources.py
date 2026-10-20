"""Official flood forecasts and access to Enedis' electricity status services.

Forecast metadata is taken from the already collected hydrometric stations.
Only the two small lists of published simulations and the matching forecasts
are downloaded; this module never reloads the observations for every station.
Enedis does not expose a verified public outage feed. Its official tools remain
available without presenting the lack of a feed as an absence of outages.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import math
import re
from threading import Lock
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


_VIGICRUES_BASE = "https://www.vigicrues.gouv.fr"
_VIGICRUES_API = _VIGICRUES_BASE + "/services/v1.1/prevision.json"
_FORECAST_TTL_SECONDS = 300
_MAX_STALE_SECONDS = 7200
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_MAX_FORECAST_DETAILS = 80
_STATION_CODE = re.compile(r"^[A-Za-z0-9_-]{4,32}$")
_forecast_lock = Lock()
_forecast_refresh_lock = Lock()
_forecast_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min.replace(tzinfo=timezone.utc)}
_FORECAST_REDIS_KEY = "vigicrues_forecasts_isere_v1"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _datetime(value: Any) -> datetime | None:
    """Accept the documented ISO dates and JavaScript millisecond timestamps."""
    if value is None or isinstance(value, bool):
        return None
    try:
        if isinstance(value, (int, float)) or (isinstance(value, str) and value.strip().isdigit()):
            timestamp = float(value)
            if not math.isfinite(timestamp):
                return None
            if abs(timestamp) > 100_000_000_000:
                timestamp /= 1000
            return datetime.fromtimestamp(timestamp, timezone.utc)
        parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError, OverflowError):
        return None


class _OfficialRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlparse(newurl)
        if target.scheme != "https" or target.hostname != "www.vigicrues.gouv.fr" or target.port not in (None, 443):
            raise ValueError("Redirection Vigicrues non autorisée")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _forecast_json(params: dict[str, str]) -> dict[str, Any]:
    request = Request(
        _VIGICRUES_API + "?" + urlencode({"FormatDate": "iso", **params}),
        headers={"Accept": "application/json", "User-Agent": "OpeProtec/1.0 (+official-data-integration)"},
    )
    try:
        with build_opener(_OfficialRedirectHandler()).open(request, timeout=12) as response:
            if response.status == 204:
                return {"code": 204, "Simul": {"Prevs": []}}
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        if exc.code == 204:
            return {"code": 204, "Simul": {"Prevs": []}}
        raise
    if len(raw) > _MAX_RESPONSE_BYTES:
        raise ValueError("Réponse Vigicrues trop volumineuse")
    payload = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError("Format de réponse Vigicrues inattendu")
    # Vigicrues uses a JSON code of 204 for 'no published forecast'.
    if payload.get("code") not in (None, 200, 204, "200", "204"):
        raise ValueError("Erreur signalée par Vigicrues")
    if "ListEntVigiCru" not in payload and "Simul" not in payload:
        raise ValueError("Prévisions absentes de la réponse Vigicrues")
    return payload


def _services():
    # main.py already imports services. Delaying this import keeps this module
    # usable by command-line validation without opening database connections.
    from . import services
    return services


def _cached_station_metadata() -> list[dict[str, Any]]:
    services = _services()
    stations: list[dict[str, Any]] = []
    with services._vigicrues_cache_lock:
        cached = services._vigicrues_cache.get("payload") or {}
        stations = deepcopy(cached.get("stations") or [])
    if not stations:
        record = services.load_risk_service_snapshots({"vigicrues": ""}).get("vigicrues", {})
        stations = (record.get("payload") or {}).get("stations") or []
    if not stations:
        for key in ("vigicrues", "persist:vigicrues"):
            cached = services._redis_get(key) or {}
            stations = cached.get("stations") or []
            if stations:
                break
    result = []
    seen: set[str] = set()
    for row in stations:
        if not isinstance(row, dict):
            continue
        code = str(row.get("code") or "").strip()
        if not _STATION_CODE.fullmatch(code) or code in seen:
            continue
        seen.add(code)
        result.append({
            "code": code,
            "station": str(row.get("station") or code),
            "river": str(row.get("river") or ""),
            "lat": _number(row.get("lat")),
            "lon": _number(row.get("lon")),
            "commune_code": str(row.get("commune_code") or ""),
            "source_link": _VIGICRUES_BASE + "/station/" + code,
            "is_priority": bool(row.get("is_priority")),
        })
    return sorted(result, key=lambda row: (not row["is_priority"], row["station"].casefold()))


def _parse_forecast_series(payload: dict[str, Any], variable: str, station_code: str) -> dict[str, Any] | None:
    simulation = payload.get("Simul")
    if not isinstance(simulation, dict):
        raise ValueError("Simulation Vigicrues absente")
    returned_code = str(simulation.get("CdEntVigiCru") or station_code)
    returned_variable = str(simulation.get("GrdSimul") or variable)
    if returned_code != station_code or returned_variable != variable:
        raise ValueError("La simulation Vigicrues ne correspond pas à la station demandée")
    rows = simulation.get("Prevs")
    if not isinstance(rows, list):
        raise ValueError("Points de prévision Vigicrues invalides")
    points_by_date: dict[str, dict[str, Any]] = {}
    for row in rows[:2000]:
        if not isinstance(row, dict):
            continue
        at = _datetime(row.get("DtPrev"))
        central = _number(row.get("ResMoyPrev"))
        lower = _number(row.get("ResMinPrev"))
        upper = _number(row.get("ResMaxPrev"))
        if at is None or all(value is None for value in (central, lower, upper)):
            continue
        # Invalid bands must never produce a misleading uncertainty envelope.
        if lower is not None and upper is not None and lower > upper:
            lower = upper = None
        if central is not None:
            if lower is not None and lower > central:
                lower = None
            if upper is not None and upper < central:
                upper = None
        iso_at = _iso(at)
        points_by_date[iso_at] = {"at": iso_at, "lower": lower, "central": central, "upper": upper}
    points = sorted(points_by_date.values(), key=lambda point: point["at"])
    if not points:
        if rows:
            raise ValueError("Aucun point de prévision Vigicrues exploitable")
        return None
    issued_at = _datetime(simulation.get("DtProdSimul"))
    return {
        "variable": variable,
        "unit": "m" if variable == "H" else "m³/s",
        "issued_at": _iso(issued_at) if issued_at else None,
        "valid_from": points[0]["at"],
        "valid_to": points[-1]["at"],
        "expired": (_datetime(points[-1]["at"]) or _now()) <= _now(),
        "comment": str(simulation.get("CommentSimul") or "")[:6000],
        "points": points,
    }


def _published_simulations(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if payload.get("code") in (204, "204"):
        return []
    rows = payload.get("ListEntVigiCru")
    if isinstance(rows, list):
        return [row for row in rows if isinstance(row, dict)]
    simulation = payload.get("Simul")
    if isinstance(simulation, dict) and simulation.get("Prevs") == []:
        return []
    raise ValueError("Liste des simulations Vigicrues invalide")


def _empty_forecast_payload(status: str, info_state: str) -> dict[str, Any]:
    return {
        "service": "Vigicrues · Prévisions",
        "department": "Isère (38)",
        "status": status,
        "source": _VIGICRUES_BASE,
        "documentation_url": _VIGICRUES_BASE + "/services/v1.1",
        "source_type": "official_forecast",
        "updated_at": _iso(),
        "issued_at": None,
        "data_available": False,
        "info_state": info_state,
        "coverage": {"stations": 0, "with_forecasts": 0, "missing": 0, "expired": 0, "failed": 0},
        "stations": [],
    }


def _fetch_vigicrues_forecasts_live() -> dict[str, Any]:
    metadata = _cached_station_metadata()
    if not metadata:
        return _empty_forecast_payload("pending", "Les stations hydrométriques sont en cours de chargement.")
    stations = {row["code"]: {**row, "status": "no_forecast", "series": []} for row in metadata}
    failures: list[str] = []
    requests: list[tuple[str, str]] = []
    # The documented national index is small (only currently published
    # simulations). Its station codes are filtered before fetching any points.
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {executor.submit(_forecast_json, {"GrdSimul": variable}): variable for variable in ("H", "Q")}
        for future in as_completed(futures):
            variable = futures[future]
            try:
                for row in _published_simulations(future.result()):
                    code = str(row.get("CdEntVigiCru") or "")
                    if code in stations and str(row.get("TypEntVigiCru") or "7") == "7":
                        pair = (code, variable)
                        if pair not in requests:
                            requests.append(pair)
            except Exception:
                failures.append("Catalogue " + variable + " indisponible")
    # Protect service capacity even if an upstream payload unexpectedly grows.
    requests.sort(key=lambda pair: (not stations[pair[0]]["is_priority"], pair[0], pair[1]))
    truncated = len(requests) > _MAX_FORECAST_DETAILS
    if truncated:
        failures.append("Nombre de simulations supérieur à la limite de collecte")
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(_forecast_json, {
                "CdEntVigiCru": code, "TypEntVigiCru": "7", "GrdSimul": variable,
            }): (code, variable)
            for code, variable in requests[:_MAX_FORECAST_DETAILS]
        }
        for future in as_completed(futures):
            code, variable = futures[future]
            try:
                series = _parse_forecast_series(future.result(), variable, code)
                if series:
                    stations[code]["series"].append(series)
            except Exception:
                stations[code]["status"] = "unavailable"
                failures.append("Prévision " + variable + " indisponible pour " + code)
    available = expired = 0
    for station in stations.values():
        station["series"].sort(key=lambda row: row["variable"])
        if any(not series["expired"] for series in station["series"]):
            station["status"] = "available"
            available += 1
        elif station["series"]:
            station["status"] = "expired"
            expired += 1
        elif failures:
            # With a missing catalogue it is impossible to assert 'no forecast'.
            station["status"] = "unavailable"
    issued_dates = [series["issued_at"] for row in stations.values() for series in row["series"] if series["issued_at"]]
    status = "partial" if failures and (available or len(failures) < 2) else "degraded" if failures else "online"
    payload = _empty_forecast_payload(status, "")
    payload.update({
        "issued_at": max(issued_dates) if issued_dates else None,
        "data_available": available > 0,
        "coverage": {
            "stations": len(stations), "with_forecasts": available,
            "missing": sum(row["status"] == "no_forecast" for row in stations.values()),
            "expired": expired, "failed": sum(row["status"] == "unavailable" for row in stations.values()),
            "truncated": truncated,
        },
        "stations": list(stations.values()),
        "info_state": (
            " ; ".join(failures) if failures else
            f"Prévisions officielles disponibles pour {available} station(s). Couverture variable selon les publications."
            if available else
            "Aucune prévision officielle en cours de validité publiée pour les stations suivies. Les observations restent disponibles."
        ),
        "uncertainty_note": "Les tendances basse, centrale et haute et leur interprétation dépendent de la publication officielle. Consulter le commentaire de la simulation.",
    })
    return payload


def _read_forecast_cache() -> dict[str, Any] | None:
    now = _now()
    with _forecast_lock:
        if _forecast_cache["payload"] and now < _forecast_cache["expires_at"]:
            payload = deepcopy(_forecast_cache["payload"])
            fetched_at = _datetime(payload.get("updated_at"))
            if payload.get("status") != "stale" or (fetched_at and 0 <= (now - fetched_at).total_seconds() <= _MAX_STALE_SECONDS):
                return _with_current_forecast_validity(payload)
    cached = _services()._redis_get(_FORECAST_REDIS_KEY)
    if isinstance(cached, dict) and cached.get("source_type") == "official_forecast":
        fetched_at = _datetime(cached.get("updated_at"))
        if fetched_at and 0 <= (now - fetched_at).total_seconds() < _FORECAST_TTL_SECONDS:
            with _forecast_lock:
                _forecast_cache.update(payload=deepcopy(cached), expires_at=fetched_at + timedelta(seconds=_FORECAST_TTL_SECONDS))
            return _with_current_forecast_validity(cached)
    return None


def _with_current_forecast_validity(payload: dict[str, Any]) -> dict[str, Any]:
    """A cached curve cannot stay 'available' after its last predicted point."""
    now = _now()
    available = expired = 0
    for station in payload.get("stations") or []:
        for series in station.get("series") or []:
            valid_to = _datetime(series.get("valid_to"))
            series["expired"] = valid_to is None or valid_to <= now
        if any(not series["expired"] for series in station.get("series") or []):
            station["status"] = "available"
            available += 1
        elif station.get("series"):
            station["status"] = "expired"
            expired += 1
    if payload.get("stations"):
        payload["data_available"] = available > 0
        payload["coverage"].update(with_forecasts=available, expired=expired)
        if payload.get("status") == "online" and not available:
            payload["info_state"] = "Aucune prévision officielle en cours de validité publiée pour les stations suivies. Les observations restent disponibles."
    return payload


def fetch_vigicrues_forecasts_isere(force_refresh: bool = False) -> dict[str, Any]:
    """Return official H/Q curves without blocking the initial page bootstrap."""
    if not force_refresh:
        cached = _read_forecast_cache()
        if cached:
            return cached
    with _forecast_refresh_lock:
        if not force_refresh:
            cached = _read_forecast_cache()
            if cached:
                return cached
        try:
            payload = _fetch_vigicrues_forecasts_live()
        except Exception:
            payload = _empty_forecast_payload("degraded", "Le service de prévisions Vigicrues est indisponible.")
        if payload["status"] in ("degraded", "partial"):
            with _forecast_lock:
                previous = deepcopy(_forecast_cache["payload"])
            if not previous:
                previous = _services()._redis_get("persist:" + _FORECAST_REDIS_KEY)
            fetched_at = _datetime((previous or {}).get("updated_at"))
            if previous and fetched_at and 0 <= (_now() - fetched_at).total_seconds() <= _MAX_STALE_SECONDS:
                # Keep the original collection and publication dates visible.
                # Do not replace a useful live response with an empty fallback.
                if not payload.get("data_available") and previous.get("data_available"):
                    payload = deepcopy(previous)
                    payload.update(status="stale", checked_at=_iso(), stale_reason="La dernière actualisation des prévisions a échoué.")
        payload = _with_current_forecast_validity(payload)
        with _forecast_lock:
            _forecast_cache.update(payload=deepcopy(payload), expires_at=_now() + timedelta(seconds=30 if payload["status"] == "pending" else _FORECAST_TTL_SECONDS))
        if payload["status"] == "online":
            services = _services()
            services._redis_set(_FORECAST_REDIS_KEY, payload, _FORECAST_TTL_SECONDS)
            services._redis_set("persist:" + _FORECAST_REDIS_KEY, payload, _MAX_STALE_SECONDS)
        return payload


def fetch_enedis_isere_status(force_refresh: bool = False) -> dict[str, Any]:
    """Offer working official access without fabricating an automated outage API.

    No account has been provided and no public live-outage API is documented.
    None, rather than an empty list or zero, represents the unknown outage data.
    The public diagnostic accepts an address or postal code on Enedis' website;
    Enedis does not document a stable link parameter to prefill this search.
    """
    return {
        "service": "Enedis · État du réseau",
        "department": "Isère (38)",
        "status": "access_required",
        "source": "https://www.enedis.fr/panne-et-interruption",
        "source_type": "official_portal",
        "updated_at": None,
        "checked_at": _iso(),
        "data_available": False,
        "automated_feed": False,
        "outages": None,
        "outages_total": None,
        "affected_customers": None,
        "info_state": "Consultez les coupures par adresse ou code postal dans l’outil officiel Enedis. Le suivi automatisé nécessite un accès habilité ; l’absence de flux ne signifie pas l’absence de coupure.",
        "access_state": "no_authorized_account",
        "official_links": [
            {"label": "Vérifier une coupure par adresse", "url": "https://www.enedis.fr/panne-et-interruption", "access": "public", "kind": "diagnostic"},
            {"label": "Portail Collectivités (compte habilité)", "url": "https://mon-compte-collectivite.enedis.fr/", "access": "account_required", "kind": "collectivites"},
            {"label": "Réagir face à une panne", "url": "https://www.enedis.fr/gestes-adopter-panne-electricite", "access": "public", "kind": "guidance"},
        ],
    }
