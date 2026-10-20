"""Small authenticated probes, without importing or starting the application.

Only fixed provider endpoints are contacted. Upstream bodies, URLs, exceptions,
and credentials must never be included in the public result or in logs.
"""

import csv
from datetime import datetime, timezone
import http.client
import io
import json
import math
import re
from time import monotonic
from urllib.parse import urlencode, urlsplit


TOTAL_TIMEOUT_SECONDS = 14.0
SOCKET_TIMEOUT_SECONDS = 6.0
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_ALLOWED_HOSTS = frozenset({
    "public-api.meteofrance.fr", "www.georisques.gouv.fr",
    "firms.modaps.eosdis.nasa.gov", "api.tomtom.com",
})
_MESSAGES = {
    "ok": "Connexion réussie : le service a accepté les accès et renvoyé une réponse valide.",
    "configuration_required": "Renseignez une clé ou un jeton pour tester ce service.",
    "auth_failed": "Accès refusé : vérifiez la clé, sa validité et les droits sur cette API.",
    "service_unavailable": "Le service ne répond pas ou son quota est temporairement dépassé. Réessayez plus tard.",
    "invalid_response": "Le service a renvoyé une réponse inattendue. La connexion n’a pas pu être validée.",
}


class _ProbeFailure(Exception):
    def __init__(self, status):
        self.status = status
        super().__init__(status)


def _remaining(deadline):
    remaining = deadline - monotonic()
    if remaining <= 0:
        raise _ProbeFailure("service_unavailable")
    return min(SOCKET_TIMEOUT_SECONDS, remaining)


def _http_bytes(url, headers, deadline):
    """No redirects, proxy forwarding, retries, cookies, or body diagnostics."""
    target = urlsplit(url)
    if (target.scheme != "https" or target.hostname not in _ALLOWED_HOSTS
            or target.port not in (None, 443) or target.username or target.password):
        raise _ProbeFailure("invalid_response")
    connection = http.client.HTTPSConnection(target.hostname, timeout=_remaining(deadline))
    response = None
    try:
        path = target.path + ("?" + target.query if target.query else "")
        connection.request("GET", path, headers={
            "Accept": "application/json, text/csv;q=0.9, */*;q=0.1",
            "User-Agent": "ope-protec/1.0 (test de connexion administrateur)",
            "Connection": "close",
            **headers,
        })
        # Retain the transport socket: getresponse() detaches it from the
        # connection when a server chooses Connection: close.
        transport_socket = connection.sock
        if transport_socket is not None:
            transport_socket.settimeout(_remaining(deadline))
        response = connection.getresponse()
        if response.status in (401, 403):
            raise _ProbeFailure("auth_failed")
        if response.status == 429 or response.status >= 500:
            raise _ProbeFailure("service_unavailable")
        if response.status != 200:
            raise _ProbeFailure("invalid_response")
        declared = response.getheader("Content-Length")
        if declared is not None and (int(declared) < 0 or int(declared) > MAX_RESPONSE_BYTES):
            raise _ProbeFailure("invalid_response")
        chunks, size = [], 0
        while True:
            timeout = _remaining(deadline)
            if transport_socket is not None:
                transport_socket.settimeout(timeout)
            # read1 performs at most one buffered/raw read, so a server slowly
            # streaming a response cannot repeatedly restart the total budget.
            chunk = response.read1(min(65536, MAX_RESPONSE_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                raise _ProbeFailure("invalid_response")
        _remaining(deadline)
        return b"".join(chunks)
    except _ProbeFailure:
        raise
    except (OSError, http.client.HTTPException):
        raise _ProbeFailure("service_unavailable") from None
    except (ValueError, UnicodeError):
        raise _ProbeFailure("invalid_response") from None
    finally:
        if response is not None:
            response.close()
        connection.close()


def _credential(credentials, name):
    value = credentials.get(name, "")
    if not isinstance(value, str):
        raise _ProbeFailure("configuration_required")
    value = value.strip()
    if len(value) > 16384 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise _ProbeFailure("configuration_required")
    return value


def _json(raw):
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise _ProbeFailure("invalid_response") from None


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _observations_valid(raw):
    text = raw.decode("utf-8-sig")
    lines = text.splitlines()
    if not lines:
        return False
    delimiter = ";" if ";" in lines[0] else ","
    for original in csv.DictReader(io.StringIO(text), delimiter=delimiter):
        row = {str(key or "").strip().lower(): value for key, value in original.items()}
        identifier = row.get("id_station") or row.get("geo_id_insee") or ""
        if not re.fullmatch(r"[0-9]{8}", str(identifier).strip()):
            continue
        try:
            latitude = float(row.get("latitude") or row.get("lat") or "")
            longitude = float(row.get("longitude") or row.get("lon") or "")
        except (ValueError, TypeError):
            continue
        if -90 <= latitude <= 90 and -180 <= longitude <= 180:
            return True
    return False


def _radar_valid(raw):
    payload = _json(raw)
    links = payload.get("links") if isinstance(payload, dict) else payload
    if not isinstance(links, list):
        return False
    for link in links:
        if not isinstance(link, dict) or not isinstance(link.get("href"), str):
            continue
        target = urlsplit(link["href"])
        if (target.scheme == "https" and target.hostname == "public-api.meteofrance.fr"
                and "/mosaiques/METROPOLE/observations/LAME_D_EAU/produit" in target.path):
            return True
    return False


def _provider_probe(service_id, credentials, deadline):
    if service_id == "meteo_france":
        raise _ProbeFailure("invalid_response")  # Each subscription is checked separately below.
    if service_id == "georisques":
        key = _credential(credentials, "token")
        if not key:
            raise _ProbeFailure("configuration_required")
        raw = _http_bytes(
            "https://www.georisques.gouv.fr/api/v2/mvt?departement=38&pageSize=1&pageNumber=0",
            {"Authorization": f"Bearer {key}"}, deadline,
        )
        payload = _json(raw)
        valid = (isinstance(payload, dict) and isinstance(payload.get("content"), list)
                 and _number(payload.get("totalElements")) and payload["totalElements"] >= 0)
    elif service_id == "firms":
        key = _credential(credentials, "map_key")
        if not key:
            raise _ProbeFailure("configuration_required")
        raw = _http_bytes(
            "https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?" + urlencode({"MAP_KEY": key}),
            {}, deadline,
        )
        # FIRMS can answer HTTP 200 with an invalid-key message instead of data.
        normalized = raw.decode("utf-8", errors="replace").lower()
        if ("invalid" in normalized or "not valid" in normalized) and ("key" in normalized):
            raise _ProbeFailure("auth_failed")
        payload = _json(raw)
        valid = (isinstance(payload, dict) and _number(payload.get("transaction_limit"))
                 and payload["transaction_limit"] > 0 and _number(payload.get("current_transactions"))
                 and payload["current_transactions"] >= 0)
        if valid and payload["current_transactions"] >= payload["transaction_limit"]:
            raise _ProbeFailure("service_unavailable")
    elif service_id == "tomtom":
        key = _credential(credentials, "api_key")
        if not key:
            raise _ProbeFailure("configuration_required")
        raw = _http_bytes(
            "https://api.tomtom.com/routing/1/calculateRoute/45.1885,5.7245:45.1900,5.7280/json?"
            + urlencode({"key": key, "routeRepresentation": "summaryOnly", "traffic": "true"}),
            {}, deadline,
        )
        payload = _json(raw)
        routes = payload.get("routes") if isinstance(payload, dict) else None
        summary = routes[0].get("summary") if isinstance(routes, list) and routes and isinstance(routes[0], dict) else None
        valid = (isinstance(summary, dict) and _number(summary.get("lengthInMeters"))
                 and summary["lengthInMeters"] > 0 and _number(summary.get("travelTimeInSeconds"))
                 and summary["travelTimeInSeconds"] >= 0)
    else:
        raise _ProbeFailure("invalid_response")
    if not valid:
        raise _ProbeFailure("invalid_response")


def _weather_probe(kind, credentials, deadline):
    key = _credential(credentials, f"{kind}_api_key") or _credential(credentials, "api_key")
    token = _credential(credentials, "access_token")
    if key:
        headers = {"apikey": key}
    elif token:
        headers = {"Authorization": f"Bearer {token}"}
    else:
        raise _ProbeFailure("configuration_required")
    if kind == "observations":
        raw = _http_bytes("https://public-api.meteofrance.fr/public/DPObs/v2/liste-stations", headers, deadline)
        valid = _observations_valid(raw)
    else:
        raw = _http_bytes(
            "https://public-api.meteofrance.fr/public/DPRadar/v1/mosaiques/METROPOLE/observations/LAME_D_EAU",
            headers, deadline,
        )
        valid = _radar_valid(raw)
    if not valid:
        raise _ProbeFailure("invalid_response")


def _check(probe):
    try:
        probe()
        return "ok"
    except _ProbeFailure as failure:
        return failure.status
    except (ValueError, TypeError, UnicodeError, csv.Error, RecursionError):
        return "invalid_response"
    except Exception:
        # Do not serialize unexpected transport exceptions: they can contain
        # the URL (FIRMS/TomTom include their key in the query).
        return "service_unavailable"


def test_integration(service_id, credentials):
    """Check supplied effective credentials; this function never stores them.

    Météo-France reports both subscription checks, including an unconfigured
    subscription when only an observations/radar-specific key is supplied.
    """
    started = monotonic()
    deadline = started + TOTAL_TIMEOUT_SECONDS
    credentials = credentials if isinstance(credentials, dict) else {}
    checks = []
    if service_id == "meteo_france":
        for kind, label in (("observations", "Observations Météo-France"), ("radar", "Radar Météo-France")):
            status = _check(lambda: _weather_probe(kind, credentials, deadline))
            checks.append({"id": kind, "label": label, "ok": status == "ok", "status": status, "message": _MESSAGES[status]})
        status = next((candidate for candidate in (
            "auth_failed", "service_unavailable", "invalid_response", "configuration_required",
        ) if any(check["status"] == candidate for check in checks)), "ok")
    else:
        status = _check(lambda: _provider_probe(service_id, credentials, deadline))
    result = {
        "ok": status == "ok", "status": status, "message": _MESSAGES[status],
        "duration_ms": max(0, round((monotonic() - started) * 1000)),
        "tested_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if checks:
        result["checks"] = checks
    return result
