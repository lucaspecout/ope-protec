from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
from datetime import datetime, timedelta
from copy import deepcopy
from email.utils import parsedate_to_datetime
from html import unescape
from http.client import RemoteDisconnected
import json
from pathlib import Path
import re
import unicodedata
from time import sleep
from threading import Lock
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus, unquote, urlencode, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from sqlalchemy import delete
from sqlalchemy.orm import Session

from .config import settings
from .models import Municipality, OperationalLog, WeatherAlert


def cleanup_old_weather_alerts(db: Session) -> int:
    cutoff = datetime.utcnow() - timedelta(days=settings.weather_retention_days)
    result = db.execute(delete(WeatherAlert).where(WeatherAlert.created_at < cutoff))
    db.commit()
    return result.rowcount or 0


def generate_pdf_report(db: Session, report_name: str = "rapport_veille.pdf") -> str:
    Path(settings.report_dir).mkdir(parents=True, exist_ok=True)
    report_path = str(Path(settings.report_dir) / report_name)
    c = canvas.Canvas(report_path, pagesize=A4)
    width, height = A4

    latest_alert = db.query(WeatherAlert).order_by(WeatherAlert.created_at.desc()).first()
    crisis_count = db.query(Municipality).filter(Municipality.crisis_mode.is_(True)).count()
    logs = db.query(OperationalLog).order_by(OperationalLog.created_at.desc()).limit(20).all()

    c.setTitle("Rapport opérationnel Isère")
    c.setFont("Helvetica-Bold", 17)
    c.drawString(40, height - 45, "CRISIS38 · Rapport opérationnel")
    c.setFont("Helvetica", 10)
    c.drawString(40, height - 62, "Protection Civile de l'Isère")
    c.drawRightString(width - 40, height - 62, f"Édité le {datetime.utcnow():%d/%m/%Y à %H:%M UTC}")

    y = height - 95
    c.setLineWidth(0.8)
    c.rect(40, y - 45, width - 80, 45)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(48, y - 17, "Synthèse")
    c.setFont("Helvetica", 10)
    c.drawString(48, y - 34, f"Vigilance: {(latest_alert.level if latest_alert else 'vert').upper()}")
    c.drawString(210, y - 34, f"Communes en crise: {crisis_count}")
    c.drawString(390, y - 34, "Périmètre: Isère (38)")

    y -= 68
    c.setFont("Helvetica-Bold", 11)
    c.drawString(40, y, "Chronologie principale")
    y -= 12

    table_x = 40
    col_sizes = [88, 70, 78, width - 80 - (88 + 70 + 78)]
    row_h = 18
    c.setFont("Helvetica-Bold", 9)
    headers = ["Horodatage", "Portée", "Niveau", "Évènement"]
    x = table_x
    for head, size in zip(headers, col_sizes):
        c.rect(x, y - row_h, size, row_h)
        c.drawString(x + 4, y - 12, head)
        x += size

    y -= row_h
    c.setFont("Helvetica", 8.8)
    for log in logs:
        if y < 75:
            c.showPage()
            y = height - 60
            c.setFont("Helvetica-Bold", 11)
            c.drawString(40, y, "Chronologie principale (suite)")
            y -= 12
            c.setFont("Helvetica-Bold", 9)
            x = table_x
            for head, size in zip(headers, col_sizes):
                c.rect(x, y - row_h, size, row_h)
                c.drawString(x + 4, y - 12, head)
                x += size
            y -= row_h
            c.setFont("Helvetica", 8.8)

        when = log.event_time or log.created_at
        scope = str(log.target_scope or "departemental")[:18]
        level = str(log.danger_level or "vert")[:12]
        event = f"{log.event_type or 'MCO'} · {(log.description or '')[:90]}"
        row = [f"{when:%d/%m %H:%M}", scope, level, event]

        x = table_x
        for value, size in zip(row, col_sizes):
            c.rect(x, y - row_h, size, row_h)
            c.drawString(x + 4, y - 12, str(value))
            x += size
        y -= row_h

    c.setFont("Helvetica", 9)
    c.drawString(40, 45, "Document généré automatiquement par CRISIS38.")
    c.drawRightString(width - 40, 45, "Signature: ____________________")
    c.save()
    return report_path


_RETRYABLE_HTTP_STATUS_CODES = {429, 500, 502, 503, 504}


def _is_retryable_network_error(exc: Exception) -> bool:
    if isinstance(exc, TimeoutError):
        return True
    if isinstance(exc, HTTPError):
        return exc.code in _RETRYABLE_HTTP_STATUS_CODES
    if isinstance(exc, RemoteDisconnected):
        return True
    if isinstance(exc, URLError):
        reason = str(exc.reason).lower() if getattr(exc, "reason", None) is not None else ""
        return any(token in reason for token in ("timed out", "timeout", "temporary", "reset", "refused", "unreachable"))
    return False


def _http_get_with_retries(request: Request, timeout: int = 10, retries: int = 2, retry_delay_seconds: float = 0.7) -> bytes:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.read()
        except (HTTPError, URLError, TimeoutError, RemoteDisconnected) as exc:
            last_error = exc
            if attempt >= retries or not _is_retryable_network_error(exc):
                raise
            sleep(retry_delay_seconds * (attempt + 1))
    raise last_error or RuntimeError("Échec HTTP inattendu")


def _http_get_json(url: str, timeout: int = 12, headers: dict[str, str] | None = None) -> Any:
    request_headers = {"User-Agent": "ope-protec/1.0"}
    if headers:
        request_headers.update(headers)
    request = Request(url, headers=request_headers)
    payload = _http_get_with_retries(request=request, timeout=timeout)
    return json.loads(payload.decode("utf-8"))


def _http_get_text(url: str, timeout: int = 12) -> str:
    request = Request(url, headers={"User-Agent": "ope-protec/1.0"})
    payload = _http_get_with_retries(request=request, timeout=timeout)
    return payload.decode("utf-8", errors="ignore")


def _extract_html_title(raw_html: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", raw_html or "", flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return ""
    title = _strip_html_tags(match.group(1))
    return re.sub(r"\s+", " ", title).strip()


def _strip_html_tags(raw_html: str) -> str:
    if not raw_html:
        return ""
    no_script = re.sub(r"<script[^>]*>.*?</script>", " ", raw_html, flags=re.IGNORECASE | re.DOTALL)
    no_style = re.sub(r"<style[^>]*>.*?</style>", " ", no_script, flags=re.IGNORECASE | re.DOTALL)
    no_tags = re.sub(r"<[^>]+>", " ", no_style)
    return unescape(re.sub(r"\s+", " ", no_tags)).strip()


def _resolve_prefecture_news_title(raw_title: str, link: str) -> str:
    cleaned_title = unescape(re.sub(r"\s+", " ", (raw_title or "").strip()))
    if cleaned_title:
        return cleaned_title

    parsed = urlparse(link or "")
    slug = (parsed.path or "").rstrip("/").split("/")[-1]
    slug = re.sub(r"\.[a-zA-Z0-9]+$", "", slug)
    slug = unquote(slug)
    slug = re.sub(r"[-_]+", " ", slug)
    slug = re.sub(r"\s+", " ", slug).strip(" /")
    return slug.capitalize() if slug else "Actualité Préfecture"


def _parse_prefecture_published_date(raw_date: str) -> datetime:
    value = (raw_date or "").strip()
    if not value:
        return datetime.min
    try:
        parsed = parsedate_to_datetime(value)
        return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed
    except (TypeError, ValueError):
        pass

    for date_format in (
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%d %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%Y-%m-%d",
    ):
        try:
            parsed = datetime.strptime(value, date_format)
            return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed
        except ValueError:
            continue
    return datetime.min




def _extract_meteo_hazards(*chunks: str) -> list[str]:
    blob = " ".join((chunk or "").lower() for chunk in chunks)
    hazard_map = {
        "inondation": ["inondation", "pluie-inondation", "pluie"],
        "vent violent": ["vent"],
        "neige-verglas": ["neige", "verglas"],
        "orages": ["orage"],
        "canicule": ["canicule", "chaleur"],
        "grand froid": ["froid", "grand froid"],
        "avalanches": ["avalanche"],
    }
    hazards = [label for label, keywords in hazard_map.items() if any(keyword in blob for keyword in keywords)]
    return hazards


def _rot13_letters(value: str) -> str:
    transformed: list[str] = []
    for char in value:
        if "a" <= char <= "z":
            transformed.append(chr((ord(char) - ord("a") + 13) % 26 + ord("a")))
        elif "A" <= char <= "Z":
            transformed.append(chr((ord(char) - ord("A") + 13) % 26 + ord("A")))
        else:
            transformed.append(char)
    return "".join(transformed)


def _extract_mf_token_from_page() -> str:
    request = Request("https://vigilance.meteofrance.fr/fr/isere", headers={"User-Agent": "ope-protec/1.0"})
    cookie_headers: list[str] = []
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urlopen(request, timeout=20) as response:
                cookie_headers = response.headers.get_all("Set-Cookie") or []
            break
        except (HTTPError, URLError, TimeoutError, RemoteDisconnected) as exc:
            last_error = exc
            if attempt >= 2 or not _is_retryable_network_error(exc):
                raise
            sleep(0.7 * (attempt + 1))

    if not cookie_headers and last_error:
        raise last_error

    joined = "; ".join(cookie_headers)
    match = re.search(r"mfsession=([^;]+)", joined)
    if not match:
        raise ValueError("Cookie mfsession introuvable")
    return _rot13_letters(match.group(1))


def _meteo_france_wsft_get(path: str, token: str, params: dict[str, Any], version: str = "v3") -> dict[str, Any]:
    query = urlencode(params)
    url = f"https://rwg.meteofrance.com/wsft/{version}/{path}?{query}"
    request = Request(url, headers={"User-Agent": "ope-protec/1.0", "Authorization": f"Bearer {token}"})
    payload = _http_get_with_retries(request=request, timeout=20)
    return json.loads(payload.decode("utf-8"))


def _meteo_france_wsft_get_optional(
    path: str,
    token: str,
    params: dict[str, Any],
    *,
    version: str = "v3",
    fallback: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        return _meteo_france_wsft_get(path, token, params, version=version)
    except HTTPError as exc:
        if exc.code == 404:
            return fallback or {}
        raise
    except json.JSONDecodeError:
        return fallback or {}


def _parse_mf_bulletin_items(bulletin_payload: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for block in bulletin_payload.get("text_bloc_item") or []:
        for bloc_item in block.get("bloc_items") or []:
            for text_item in bloc_item.get("text_items") or []:
                details: list[str] = []
                for term in text_item.get("term_items") or []:
                    for subdivision in term.get("subdivision_text") or []:
                        snippets = subdivision.get("text") or []
                        if snippets:
                            details.append(" ".join(str(part).strip() for part in snippets if str(part).strip()))

                cleaned_details = " ".join(chunk for chunk in details if chunk).strip()
                if not cleaned_details:
                    continue

                items.append(
                    {
                        "section": bloc_item.get("type_name") or "Information",
                        "phenomenon": text_item.get("hazard_name") or "Tous aléas",
                        "detail": cleaned_details,
                    }
                )
    return items


def _build_mf_alerts(
    warning_payload: dict[str, Any],
    phenomenon_names: dict[str, str],
    color_names: dict[int, str],
    bulletin_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    bulletin_by_phenomenon: dict[str, list[str]] = {}
    for entry in bulletin_items:
        key = str(entry.get("phenomenon") or "").lower()
        if key:
            bulletin_by_phenomenon.setdefault(key, []).append(entry.get("detail", ""))

    alerts: list[dict[str, Any]] = []
    for item in warning_payload.get("phenomenons_max_colors") or []:
        phenomenon_id = str(item.get("phenomenon_id") or "")
        color_id = int(item.get("phenomenon_max_color_id") or 1)
        phenomenon_name = phenomenon_names.get(phenomenon_id, f"Phénomène {phenomenon_id}")
        color_name = color_names.get(color_id, "inconnu").lower()
        details = bulletin_by_phenomenon.get(phenomenon_name.lower(), [])
        alerts.append(
            {
                "phenomenon": phenomenon_name,
                "level": color_name,
                "is_warning": color_id >= 2,
                "details": details[:2],
            }
        )

    alerts.sort(key=lambda alert: {"rouge": 4, "orange": 3, "jaune": 2, "vert": 1}.get(alert["level"], 0), reverse=True)
    return alerts


_MF_CACHE_TTL_SECONDS = 180
_meteo_cache_lock = Lock()
_meteo_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}

_VIGICRUES_CACHE_TTL_SECONDS = 300
_ITINISERE_CACHE_TTL_SECONDS = 180
_BISON_CACHE_TTL_SECONDS = 600
_GEORISQUES_CACHE_TTL_SECONDS = 900
_PREFECTURE_CACHE_TTL_SECONDS = 120
_DAUPHINE_CACHE_TTL_SECONDS = 300
_VIGIEAU_CACHE_TTL_SECONDS = 900
_ATMO_AURA_CACHE_TTL_SECONDS = 900
_SNCF_ISERE_CACHE_TTL_SECONDS = 180
_RTE_ELECTRICITY_CACHE_TTL_SECONDS = 300
_FINESS_ISERE_CACHE_TTL_SECONDS = 43200
_MOBILITES_BERGES_CACHE_TTL_SECONDS = 180

_vigicrues_cache_lock = Lock()
_vigicrues_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_itinisere_cache_lock = Lock()
_itinisere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_bison_cache_lock = Lock()
_bison_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_georisques_cache_lock = Lock()
_georisques_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_prefecture_cache_lock = Lock()
_prefecture_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_dauphine_cache_lock = Lock()
_dauphine_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_vigieau_cache_lock = Lock()
_vigieau_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_atmo_aura_cache_lock = Lock()
_atmo_aura_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_sncf_isere_cache_lock = Lock()
_sncf_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_rte_electricity_cache_lock = Lock()
_rte_electricity_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_finess_isere_cache_lock = Lock()
_finess_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_mobilites_berges_cache_lock = Lock()
_mobilites_berges_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_isere_aval_polyline_cache_lock = Lock()
_isere_aval_polyline_cache: dict[str, Any] = {"points": None, "expires_at": datetime.min}
_ISERE_AVAL_GRENOBLE_CUTOFF_LON = 5.67526671768763
_ISERE_AVAL_END_POINT = [45.21599236499436, 5.67526671768763]


def _point_distance_meters(start: list[float], end: list[float]) -> float:
    lat_delta = (end[0] - start[0]) * 111_000
    lon_delta = (end[1] - start[1]) * 80_000
    return (lat_delta**2 + lon_delta**2) ** 0.5


def _nearest_polyline_point(reference: list[float], polyline: list[list[float]]) -> list[float] | None:
    """Return the nearest point on a polyline (vertex-based) from a reference lat/lon."""
    if (
        not isinstance(reference, list)
        or len(reference) < 2
        or not isinstance(polyline, list)
        or not polyline
    ):
        return None

    ref = [float(reference[0]), float(reference[1])]
    best_point: list[float] | None = None
    best_distance: float | None = None
    for point in polyline:
        if not isinstance(point, list) or len(point) < 2:
            continue
        if not isinstance(point[0], (int, float)) or not isinstance(point[1], (int, float)):
            continue
        candidate = [float(point[0]), float(point[1])]
        distance = _point_distance_meters(ref, candidate)
        if best_distance is None or distance < best_distance:
            best_distance = distance
            best_point = candidate

    return best_point


def _match_station_to_troncon(station: dict[str, Any], troncons: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """List traced tronçons compatible with the station river name."""
    river = str(station.get("river") or "").lower()
    if not river:
        return []

    if "drac" in river:
        match = troncons.get("AN30 Drac aval")
        return [match] if match else []
    if "romanche" in river:
        match = troncons.get("AN31 Romanche aval")
        return [match] if match else []
    if "is" in river and "re" in river:
        return [
            troncons.get("AN12 Isère grenobloise"),
            troncons.get("AN11 Isère moyenne"),
            troncons.get("AN20 Isère aval"),
        ]
    return []


def _relocate_station_on_traced_troncon(station: dict[str, Any], troncons: dict[str, dict[str, Any]]) -> None:
    """Snap station to existing tronçon near the station commune when possible."""
    candidates = [candidate for candidate in _match_station_to_troncon(station, troncons) if isinstance(candidate, dict)]
    if not candidates:
        return

    commune_code = str(station.get("commune_code") or "")
    commune_center = _commune_center(commune_code) if commune_code else None
    lat = station.get("lat")
    lon = station.get("lon")
    reference = None
    if isinstance(commune_center, tuple) and len(commune_center) == 2:
        reference = [float(commune_center[0]), float(commune_center[1])]
    elif isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
        reference = [float(lat), float(lon)]

    if reference is None:
        return

    selected_troncon: dict[str, Any] | None = None
    selected_point: list[float] | None = None
    selected_distance: float | None = None
    for troncon in candidates:
        polyline = troncon.get("polyline")
        if not isinstance(polyline, list) or not polyline:
            continue
        snapped = _nearest_polyline_point(reference, polyline)
        if not snapped:
            continue
        distance = _point_distance_meters(reference, snapped)
        if selected_distance is None or distance < selected_distance:
            selected_distance = distance
            selected_troncon = troncon
            selected_point = snapped

    if not selected_troncon or not selected_point:
        return

    station["lat"] = selected_point[0]
    station["lon"] = selected_point[1]
    station["troncon"] = selected_troncon.get("name") or station.get("troncon") or ""
    station["troncon_code"] = selected_troncon.get("code") or station.get("troncon_code") or ""


def _truncate_isere_aval_before_grenoble(points: list[list[float]]) -> list[list[float]]:
    """Trim AN20 to stop at the requested Grenoble-end point on the Isère."""
    if not isinstance(points, list) or len(points) < 2:
        return points

    trimmed = [
        [float(lat), float(lon)]
        for lat, lon in points
        if isinstance(lat, (int, float))
        and isinstance(lon, (int, float))
        and float(lon) <= _ISERE_AVAL_GRENOBLE_CUTOFF_LON
    ]
    if len(trimmed) < 2:
        return points

    endpoint = [float(_ISERE_AVAL_END_POINT[0]), float(_ISERE_AVAL_END_POINT[1])]
    if trimmed[0] != endpoint and trimmed[-1] != endpoint:
        if _point_distance_meters(trimmed[0], endpoint) <= _point_distance_meters(trimmed[-1], endpoint):
            trimmed.insert(0, endpoint)
        else:
            trimmed.append(endpoint)
    return trimmed


def _has_polyline_large_gap(points: list[list[float]], max_gap_meters: float = 5_000) -> bool:
    if not isinstance(points, list) or len(points) < 2:
        return False
    for idx in range(1, len(points)):
        if _point_distance_meters(points[idx - 1], points[idx]) > max_gap_meters:
            return True
    return False


def _load_isere_aval_polyline_online() -> list[list[float]]:
    now = datetime.utcnow()
    with _isere_aval_polyline_cache_lock:
        cached = _isere_aval_polyline_cache.get("points")
        expires_at = _isere_aval_polyline_cache.get("expires_at") or datetime.min
        if cached and now < expires_at:
            return deepcopy(cached)

    geojson = _http_get_json(
        "https://nominatim.openstreetmap.org/lookup?osm_ids=R1067839&format=geojson&polygon_geojson=1",
        timeout=18,
    )
    features = geojson.get("features") if isinstance(geojson, dict) else None
    if not isinstance(features, list) or not features:
        raise ValueError("Géométrie OSM Isère indisponible")

    geometry = features[0].get("geometry") if isinstance(features[0], dict) else None
    if not isinstance(geometry, dict):
        raise ValueError("Géométrie OSM Isère absente")

    geom_type = geometry.get("type")
    if geom_type == "LineString":
        lines = [geometry.get("coordinates")]
    elif geom_type == "MultiLineString":
        lines = geometry.get("coordinates")
    else:
        raise ValueError("Type de géométrie OSM non supporté")

    valid_lines = [line for line in lines if isinstance(line, list) and len(line) >= 2]
    if not valid_lines:
        raise ValueError("Aucune ligne OSM exploitable pour l'Isère")

    main_line = max(valid_lines, key=len)
    segment = [
        [float(lat), float(lon)]
        for lon, lat in main_line
        if isinstance(lat, (int, float))
        and isinstance(lon, (int, float))
        and 44.95 <= float(lat) <= 45.23
        and 4.84 <= float(lon) <= 5.83
    ]
    if len(segment) < 30:
        raise ValueError("Segment OSM insuffisant pour AN20")

    simplified = [segment[0]]
    for point in segment[1:]:
        if _point_distance_meters(simplified[-1], point) >= 250:
            simplified.append(point)
    if simplified[-1] != segment[-1]:
        simplified.append(segment[-1])

    if len(simplified) > 340:
        step = max(1, len(simplified) // 340)
        reduced = simplified[::step]
        if reduced[-1] != simplified[-1]:
            reduced.append(simplified[-1])
        simplified = reduced

    simplified = _truncate_isere_aval_before_grenoble(simplified)
    if _has_polyline_large_gap(simplified):
        raise ValueError("Tracé OSM AN20 discontinu")

    with _isere_aval_polyline_cache_lock:
        _isere_aval_polyline_cache["points"] = deepcopy(simplified)
        _isere_aval_polyline_cache["expires_at"] = now + timedelta(hours=12)

    return simplified


def _cached_external_payload(
    *,
    cache: dict[str, Any],
    lock: Lock,
    ttl_seconds: int,
    force_refresh: bool,
    loader: Any,
) -> dict[str, Any]:
    now = datetime.utcnow()
    with lock:
        cached_payload = cache.get("payload")
        expires_at = cache.get("expires_at") or datetime.min
        if not force_refresh and cached_payload and now < expires_at:
            return deepcopy(cached_payload)

    payload = loader()
    if payload.get("status") in {"online", "partial", "stale"}:
        with lock:
            cache["payload"] = deepcopy(payload)
            cache["expires_at"] = datetime.utcnow() + timedelta(seconds=ttl_seconds)
        return payload

    with lock:
        cached_payload = cache.get("payload")
        if cached_payload:
            stale_payload = deepcopy(cached_payload)
            stale_payload["status"] = "stale"
            stale_payload["stale_reason"] = payload.get("error") or payload.get("info_state") or "service indisponible"
            stale_payload["updated_at"] = datetime.utcnow().isoformat() + "Z"
            return stale_payload
    return payload


def _highest_vigilance_level(alerts: list[dict[str, Any]]) -> str:
    priority = {"vert": 1, "jaune": 2, "orange": 3, "rouge": 4}
    highest = "vert"
    highest_score = priority[highest]
    for alert in alerts:
        level = str(alert.get("level") or "vert").lower()
        score = priority.get(level, 0)
        if score > highest_score:
            highest = level
            highest_score = score
    return highest


def _vigicrues_extract_level_from_text(text: str) -> str | None:
    normalized = unescape(text or "").lower()
    match = re.search(r"\b(vert|verte|jaune|orange|rouge)\b", normalized)
    if not match:
        return None
    value = match.group(1)
    return "vert" if value == "verte" else value


def _fetch_vigicrues_troncon_rss_level(troncon_code: str) -> tuple[str | None, str | None]:
    rss_url = f"https://www.vigicrues.gouv.fr/territoire/rss?CdEntVigiCru={quote_plus(troncon_code)}"
    content = _http_get_text(rss_url)
    root = ET.fromstring(content)
    item = root.find("./channel/item")
    if item is None:
        return None, rss_url

    candidates = [
        item.findtext("title") or "",
        item.findtext("description") or "",
    ]
    for candidate in candidates:
        level = _vigicrues_extract_level_from_text(candidate)
        if level:
            return level, rss_url
    return None, rss_url


def _fetch_meteo_france_isere_live() -> dict[str, Any]:
    source_url = "https://vigilance.meteofrance.fr/fr/isere"
    html = _http_get_text(source_url)
    title_match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    desc_match = re.search(r'<meta name="description" content="(.*?)"', html, re.IGNORECASE)
    color_match = re.search(r"vigilance (verte|jaune|orange|rouge)", html, re.IGNORECASE)
    level = color_match.group(1).lower() if color_match else "inconnu"
    level = "vert" if level == "verte" else level
    bulletin_title = title_match.group(1).strip() if title_match else "Vigilance Météo Isère"
    info_state = desc_match.group(1).replace("&#039;", "'") if desc_match else "Informations disponibles"
    hazards = _extract_meteo_hazards(bulletin_title, info_state)

    try:
        token = _extract_mf_token_from_page()
        dictionary = _meteo_france_wsft_get("warning/dictionary", token, {"domain": "FRA", "warning_type": "vigilance"})
        warning_today = _meteo_france_wsft_get(
            "warning/currentphenomenons",
            token,
            {"domain": "38", "warning_type": "vigilance", "formatDate": "timestamp", "echeance": "J0", "depth": 1},
        )
        warning_tomorrow = _meteo_france_wsft_get_optional(
            "warning/currentphenomenons",
            token,
            {"domain": "38", "warning_type": "vigilance", "formatDate": "timestamp", "echeance": "J1", "depth": 1},
            fallback={"phenomenons_max_colors": []},
        )
        bulletin_today = _meteo_france_wsft_get(
            "report",
            token,
            {"domain": "38", "report_type": "vigilanceV6", "report_subtype": "Bulletin de suivi", "echeance": "J0"},
            version="v2",
        )
        bulletin_tomorrow = _meteo_france_wsft_get_optional(
            "report",
            token,
            {"domain": "38", "report_type": "vigilanceV6", "report_subtype": "Bulletin de suivi", "echeance": "J1"},
            version="v2",
            fallback={"text_bloc_item": []},
        )
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError) as exc:
        return {
            "service": "Météo-France Vigilance",
            "department": "Isère (38)",
            "status": "partial",
            "source": source_url,
            "level": level,
            "bulletin_title": bulletin_title,
            "info_state": f"Données de synthèse disponibles (API WSFT indisponible: {exc})",
            "hazards": hazards,
            "current_alerts": [],
            "tomorrow_alerts": [],
            "bulletin_today": [],
            "bulletin_tomorrow": [],
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }

    phenomenon_names = {str(item.get("id")): item.get("name", "") for item in dictionary.get("phenomenons") or []}
    color_names = {int(item.get("id")): item.get("name", "inconnu") for item in dictionary.get("colors") or []}
    today_bulletin_items = _parse_mf_bulletin_items(bulletin_today)
    tomorrow_bulletin_items = _parse_mf_bulletin_items(bulletin_tomorrow)
    current_alerts = _build_mf_alerts(warning_today, phenomenon_names, color_names, today_bulletin_items)
    tomorrow_alerts = _build_mf_alerts(warning_tomorrow, phenomenon_names, color_names, tomorrow_bulletin_items)
    monitored_hazards = [alert["phenomenon"].lower() for alert in current_alerts + tomorrow_alerts]
    hazards = sorted(set(hazards + [hazard for hazard in monitored_hazards if hazard]))
    if current_alerts:
        level = _highest_vigilance_level(current_alerts)
    elif tomorrow_alerts:
        level = _highest_vigilance_level(tomorrow_alerts)

    return {
        "service": "Météo-France Vigilance",
        "department": "Isère (38)",
        "status": "online",
        "source": source_url,
        "level": level,
        "bulletin_title": bulletin_title,
        "info_state": info_state,
        "hazards": hazards,
        "current_alerts": current_alerts,
        "tomorrow_alerts": tomorrow_alerts,
        "bulletin_today": today_bulletin_items[:4],
        "bulletin_tomorrow": tomorrow_bulletin_items[:4],
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_meteo_france_isere(force_refresh: bool = False) -> dict[str, Any]:
    now = datetime.utcnow()
    with _meteo_cache_lock:
        cached_payload = _meteo_cache.get("payload")
        expires_at = _meteo_cache.get("expires_at") or datetime.min
        if not force_refresh and cached_payload and now < expires_at:
            return deepcopy(cached_payload)

    try:
        payload = _fetch_meteo_france_isere_live()
        with _meteo_cache_lock:
            _meteo_cache["payload"] = deepcopy(payload)
            _meteo_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_MF_CACHE_TTL_SECONDS)
        return payload
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        with _meteo_cache_lock:
            cached_payload = _meteo_cache.get("payload")
            if cached_payload:
                degraded_payload = deepcopy(cached_payload)
                degraded_payload["status"] = "stale"
                degraded_payload["info_state"] = f"Données mises en cache (dernière tentative indisponible: {exc})"
                return degraded_payload
        return {
            "service": "Météo-France Vigilance",
            "department": "Isère (38)",
            "status": "degraded",
            "source": "https://vigilance.meteofrance.fr/fr/isere",
            "level": "inconnu",
            "info_state": f"indisponible ({exc})",
            "hazards": [],
            "current_alerts": [],
            "tomorrow_alerts": [],
            "bulletin_today": [],
            "bulletin_tomorrow": [],
        }


def fetch_isere_boundary_geojson() -> dict[str, Any]:
    source_url = "https://france-geojson.gregoiredavid.fr/repo/departements/38-isere/departement-38-isere.geojson"
    try:
        data = _http_get_json(source_url)
        geometry = data.get("geometry", {})
        if geometry.get("type") not in {"Polygon", "MultiPolygon"}:
            raise ValueError("Format géométrique inattendu")

        return {
            "status": "online",
            "source": source_url,
            "geometry": geometry,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError) as exc:
        return {
            "status": "degraded",
            "source": source_url,
            "error": str(exc),
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [5.09, 45.07], [5.63, 45.61], [6.45, 45.28], [6.35, 44.84], [5.73, 44.63], [5.15, 44.82], [5.09, 45.07],
                ]],
            },
        }


def _vigicrues_level_from_delta(delta_m: float) -> str:
    if delta_m >= 1:
        return "rouge"
    if delta_m >= 0.5:
        return "orange"
    if delta_m >= 0.2:
        return "jaune"
    return "vert"


def normalize_level(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    aliases = {
        "green": "vert",
        "yellow": "jaune",
        "orange": "orange",
        "red": "rouge",
    }
    normalized = aliases.get(normalized, normalized)
    return normalized if normalized in {"vert", "jaune", "orange", "rouge"} else "vert"


def _vigicrues_extract_observation(station_code: str) -> tuple[float, float, str]:
    try:
        payload = _http_get_json(
            f"https://www.vigicrues.gouv.fr/services/observations.json/index.php?CdStationHydro={quote_plus(station_code)}&FormatDate=iso",
            timeout=6,
        )
    except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
        return 0.0, 0.0, ""

    observations = ((payload.get("Serie") or {}).get("ObssHydro") or [])
    valid = [item for item in observations if item.get("ResObsHydro") not in (None, "")]
    if not valid:
        return 0.0, 0.0, ""

    latest = valid[-1]
    previous = valid[-2] if len(valid) >= 2 else latest
    latest_height = float(latest.get("ResObsHydro") or 0.0)
    previous_height = float(previous.get("ResObsHydro") or latest_height)
    delta = latest_height - previous_height
    observed_at = str(latest.get("DtObsHydro") or "")
    return latest_height, delta, observed_at


def _normalize_vigicrues_coordinates(coord_x: Any, coord_y: Any, commune_code: str) -> tuple[float | None, float | None]:
    try:
        lon = float(coord_x) if coord_x not in (None, "") else None
        lat = float(coord_y) if coord_y not in (None, "") else None
    except (TypeError, ValueError):
        lon = None
        lat = None

    if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180:
        return lat, lon

    fallback_center = _commune_center(commune_code) if commune_code else None
    if fallback_center:
        return fallback_center
    return None, None


def _commune_center(code_insee: str) -> tuple[float, float] | None:
    try:
        payload = _http_get_json(f"https://geo.api.gouv.fr/communes/{quote_plus(code_insee)}?fields=centre")
        coordinates = payload.get("centre", {}).get("coordinates")
        if not coordinates or len(coordinates) != 2:
            return None
        lon, lat = coordinates
        return float(lat), float(lon)
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError):
        return None


def _vigicrues_station_control(details: dict[str, Any]) -> str:
    direct_candidates = [
        "EtatStationHydro",
        "EtatControleStationHydro",
        "EtatStation",
        "EtatCapteur",
        "LibelleEtatStationHydro",
    ]
    nested_candidates = [
        ("VigilanceCrues", "EtatStationHydro"),
        ("VigilanceCrues", "EtatControleStationHydro"),
        ("VigilanceCrues", "LibelleEtatStationHydro"),
    ]

    for key in direct_candidates:
        value = details.get(key)
        if value not in (None, ""):
            return str(value)

    for parent_key, child_key in nested_candidates:
        parent_value = details.get(parent_key)
        if not isinstance(parent_value, dict):
            continue
        value = parent_value.get(child_key)
        if value not in (None, ""):
            return str(value)

    for key, value in details.items():
        if "controle" not in str(key).lower() and "control" not in str(key).lower():
            continue
        if isinstance(value, (str, int, float)) and value not in (None, ""):
            return str(value)

    return "inconnu"


def _normalize_station_search_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value or "")
    without_diacritics = "".join(char for char in normalized if not unicodedata.combining(char))
    lowered = without_diacritics.lower()
    lowered = lowered.replace("saint", "st")
    lowered = lowered.replace("'", " ")
    lowered = re.sub(r"[^a-z0-9]+", " ", lowered)
    return re.sub(r"\s+", " ", lowered).strip()


def _station_matches_focus_filters(station: dict[str, Any], focus_filters: list[tuple[str, ...]]) -> bool:
    haystack = _normalize_station_search_text(
        f"{station.get('LbStationHydro') or ''} {station.get('LbCoursEau') or ''}"
    )
    if not haystack:
        return False

    for required_tokens in focus_filters:
        if all(token in haystack for token in required_tokens):
            return True
    return False


def _vigicrues_build_station_entry(
    source: str,
    station_code: str,
    priority_names: list[str],
    force_include_codes: set[str] | None = None,
    isere_catalog_codes: set[str] | None = None,
    station_seed: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    details = station_seed or {}
    if not details:
        try:
            details = _http_get_json(
                f"{source}/services/station.json?CdStationHydro={quote_plus(station_code)}",
                timeout=6,
            )
        except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError):
            return None

    commune_code = str(details.get("CdCommune") or "")
    force_include_codes = force_include_codes or set()
    isere_catalog_codes = isere_catalog_codes or set()
    if not commune_code.startswith("38") and station_code not in force_include_codes and station_code not in isere_catalog_codes:
        return None

    lat, lon = _normalize_vigicrues_coordinates(
        details.get("CoordYStationHydro"),
        details.get("CoordXStationHydro"),
        commune_code,
    )
    station_name = details.get("LbStationHydro") or details.get("LbEntVigiCru") or "Station Vigicrues"
    river_name = details.get("LbCoursEau") or details.get("NomEntiteHydrographique") or ""
    text_blob = f"{station_name} {river_name}".lower()
    height_m, delta_window_m, observed_at = _vigicrues_extract_observation(station_code)
    level = _vigicrues_level_from_delta(abs(delta_window_m))

    return {
        "code": station_code,
        "station": station_name,
        "river": river_name,
        "height_m": round(height_m, 2),
        "delta_window_m": round(delta_window_m, 3),
        "level": level,
        "control_status": _vigicrues_station_control(details),
        "is_priority": ("grenoble" in text_blob or any(name in text_blob for name in priority_names)),
        "observed_at": observed_at,
        "lat": lat,
        "lon": lon,
        "commune_code": commune_code,
        "troncon": "",
        "troncon_code": "",
        "source_link": f"{source}/station/{station_code}",
    }



def _fetch_hubeau_isere_station_codes() -> set[str]:
    station_codes: set[str] = set()
    page = 1
    page_size = 1000

    while True:
        payload = _http_get_json(
            f"https://hubeau.eaufrance.fr/api/v1/hydrometrie/referentiel/stations?code_departement=38&size={page_size}&page={page}",
            timeout=10,
        )
        stations = payload.get("data") or []
        if not stations:
            break

        for station in stations:
            code = str(station.get("code_station") or "").strip()
            if code:
                station_codes.add(code)

        if len(stations) < page_size:
            break
        page += 1

    return station_codes


def _fetch_vigicrues_isere_live(
    sample_size: int = 1200,
    station_limit: int | None = None,
    priority_names: list[str] | None = None,
) -> dict[str, Any]:
    source = "https://www.vigicrues.gouv.fr"
    sandre_reference = "https://www.sandre.eaufrance.fr/definition/VIC/1.1/EntVigiCru"
    # Filet de sécurité: stations iséroises connues (dépt 38), pour éviter "0 station"
    # si le catalogue change ou si certains appels détaillés échouent.
    fallback_isere_codes = (
        "W141001001", "W140000101", "W130001002", "W131001002", "W320001002",
        "W283201001", "W283201102", "W114402001", "W274601201", "W274601302",
        "W141001201", "W331501001", "W334000102", "W280402001", "W275000302",
        "W276721102", "W276721401", "W273000102", "W240501001", "W233521001",
        "V150401002", "V151501001", "V340431001", "V342431001",
    )
    focus_station_filters = [
        ("pontcharra", "breda"),
        ("chamousset", "pont", "royal", "isere"),
        ("crolles", "isere"),
        ("la", "gache", "isere"),
        ("cheylas", "isere"),
        ("montmelian", "debitmetre", "isere"),
        ("grenoble", "bastille", "isere"),
        ("st", "gervais", "isere"),
        ("domene", "domenon"),
        ("fontaine", "drac"),
        ("pont", "de", "claix", "drac"),
        ("gresse", "vercors", "gresse"),
        ("st", "just", "claix", "bourne"),
        ("meaudre", "meaudret"),
    ]
    priority_names = [name.lower() for name in (priority_names or [])]

    try:
        stations_by_code: dict[str, dict[str, Any]] = {}
        isere_catalog_codes = set(fallback_isere_codes)
        try:
            hubeau_codes = sorted(_fetch_hubeau_isere_station_codes())
        except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError):
            hubeau_codes = []

        candidate_codes = [*hubeau_codes, *fallback_isere_codes]
        candidate_codes = [code for code in candidate_codes if code]
        if not candidate_codes:
            raise ValueError("Aucune station candidate détectée pour l'Isère")

        isere_stations: list[dict[str, Any]] = []
        seen_codes = set()
        unique_candidate_codes: list[str] = []
        for code in candidate_codes:
            if code in seen_codes:
                continue
            seen_codes.add(code)
            unique_candidate_codes.append(code)

        target_isere_count = station_limit if station_limit is not None else max(13, len(hubeau_codes), len(fallback_isere_codes))
        max_lookups = max(220, target_isere_count * 16)
        if sample_size > 0:
            max_lookups = min(max_lookups, sample_size)
        unique_candidate_codes = unique_candidate_codes[:max_lookups]
        worker_count = min(10, max(4, min(max(target_isere_count, 1), 24)))
        executor = ThreadPoolExecutor(max_workers=worker_count)
        force_include_codes = set(fallback_isere_codes)
        futures = [
            executor.submit(
                _vigicrues_build_station_entry,
                source,
                code,
                priority_names,
                force_include_codes,
                isere_catalog_codes,
                stations_by_code.get(code),
            )
            for code in unique_candidate_codes
        ]
        try:
            for future in as_completed(futures):
                station = future.result()
                if not station:
                    continue
                isere_stations.append(station)
                if station_limit is not None and len(isere_stations) >= target_isere_count:
                    break
        finally:
            executor.shutdown(wait=False, cancel_futures=True)

        if not isere_stations:
            raise ValueError("Aucune station du département de l'Isère trouvée")

        troncons_index: dict[str, dict[str, Any]] = {}
        for station in isere_stations:
            key = station.get("river") or "Cours d'eau non précisé"
            group = troncons_index.setdefault(
                key,
                {
                    "code": re.sub(r"[^A-Z0-9]", "", key.upper())[:12] or "ISERE",
                    "name": key,
                    "level": "vert",
                    "territory": "18",
                    "rss": None,
                    "stations": [],
                },
            )
            group["stations"].append({"code": station["code"], "station": station["station"], "river": station["river"]})
            group["level"] = _highest_vigilance_level([{"level": group["level"]}, {"level": station["level"]}])

        # Tracé du tronçon Vigicrues AN12 (Isère grenobloise) recalé sur le
        # lit principal de l'Isère entre Saint-Martin-le-Vinoux et Domène.
        isere_grenobloise_points = [
            [45.209849574592646, 5.694562489185509],
            [45.208926300000000, 5.697844100000000],
            [45.205802000000000, 5.706549900000000],
            [45.203510700000000, 5.712306500000000],
            [45.200446700000000, 5.715250100000000],
            [45.196757000000000, 5.715152000000000],
            [45.194381900000000, 5.715854200000000],
            [45.192885900000000, 5.718939400000000],
            [45.192734100000000, 5.720501000000000],
            [45.193483800000000, 5.725675600000000],
            [45.194428600000000, 5.729312300000000],
            [45.197058800000000, 5.732877300000000],
            [45.199771700000000, 5.733927400000000],
            [45.201623600000000, 5.735491100000000],
            [45.202131300000000, 5.737228100000000],
            [45.201058200000000, 5.740596600000000],
            [45.200399800000000, 5.741501900000000],
            [45.198400700000000, 5.742895400000000],
            [45.193386700000000, 5.742094200000000],
            [45.190824600000000, 5.742117600000000],
            [45.188946200000000, 5.745391400000000],
            [45.188707900000000, 5.747888400000000],
            [45.189215500000000, 5.750044600000000],
            [45.192623500000000, 5.752326500000000],
            [45.196570700000000, 5.754233100000000],
            [45.197211800000000, 5.756481900000000],
            [45.196147300000000, 5.759279900000000],
            [45.195845300000000, 5.763325700000000],
            [45.198215900000000, 5.769330100000000],
            [45.200251600000000, 5.771635200000000],
            [45.200912500000000, 5.774148000000000],
            [45.199515800000000, 5.778028400000000],
            [45.196528400000000, 5.779560200000000],
            [45.194137300000000, 5.780137600000000],
            [45.192007300000000, 5.780984100000000],
            [45.190566900000000, 5.783782700000000],
            [45.189397000000000, 5.789661000000000],
            [45.189370700000000, 5.794952500000000],
            [45.188866800000000, 5.798020100000000],
            [45.188349000000000, 5.798994900000000],
            [45.186955600000000, 5.802476100000000],
            [45.187135100000000, 5.804657500000000],
            [45.188222100000000, 5.806016300000000],
            [45.189860000000000, 5.806196300000000],
            [45.190882300000000, 5.805476800000000],
            [45.191813800000000, 5.803151900000000],
            [45.192219500000000, 5.801116900000000],
            [45.192757500000000, 5.798622100000000],
            [45.193509200000000, 5.795224800000000],
            [45.194256700000000, 5.793031700000000],
            [45.195401600000000, 5.792313800000000],
            [45.196483200000000, 5.793729700000000],
            [45.197463300000000, 5.796094100000000],
            [45.198707000000000, 5.798526000000000],
            [45.199233600000000, 5.799196500000000],
            [45.200065300000000, 5.799466300000000],
            [45.201201000000000, 5.798955100000000],
            [45.202450800000000, 5.797552500000000],
            [45.203563100000000, 5.796319800000000],
            [45.204406600000000, 5.796476500000000],
            [45.205857800000000, 5.799658400000000],
            [45.206387400000000, 5.803525700000000],
            [45.206419200000000, 5.806850700000000],
            [45.206443400000000, 5.810823000000000],
            [45.206161700000000, 5.813288000000000],
            [45.203853100000000, 5.816708600000000],
            [45.203029700000000, 5.818190400000000],
            [45.202967006933470, 5.818678565323601],
        ]
        isere_grenobloise_level, isere_grenobloise_rss = (None, None)
        try:
            isere_grenobloise_level, isere_grenobloise_rss = _fetch_vigicrues_troncon_rss_level("AN12")
        except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError):
            isere_grenobloise_level, isere_grenobloise_rss = (None, "https://www.vigicrues.gouv.fr/territoire/rss?CdEntVigiCru=AN12")

        troncons_index["AN12 Isère grenobloise"] = {
            "code": "AN12",
            "name": "Isère grenobloise",
            "level": isere_grenobloise_level or "vert",
            "territory": "19",
            "rss": isere_grenobloise_rss,
            "stations": [
                {"code": s["code"], "station": s["station"], "river": s["river"]}
                for s in isere_stations
                if "isère" in str(s.get("river") or "").lower()
            ],
            "geometry": {
                "type": "LineString",
                "coordinates": [[point[1], point[0]] for point in isere_grenobloise_points],
            },
            "polyline": isere_grenobloise_points,
        }

        # Tracé du tronçon Vigicrues AN11 (Isère moyenne), recalé sur le
        # lit principal de l'Isère entre Gières et Albertville.
        isere_moyenne_points = [
            [45.2062307, 5.8242196],
            [45.2084370, 5.8265340],
            [45.2100936, 5.8283294],
            [45.2122402, 5.8303380],
            [45.2141565, 5.8323870],
            [45.2158936, 5.8350628],
            [45.2180628, 5.8391707],
            [45.2197946, 5.8415545],
            [45.2221755, 5.8438819],
            [45.2235761, 5.8459066],
            [45.2273758, 5.8508306],
            [45.2294681, 5.8535201],
            [45.2318526, 5.8556525],
            [45.2354449, 5.8558595],
            [45.2373414, 5.8582174],
            [45.2371626, 5.8618094],
            [45.2362227, 5.8645247],
            [45.2353934, 5.8673104],
            [45.2347428, 5.8699933],
            [45.2344600, 5.8729470],
            [45.2343129, 5.8762213],
            [45.2349221, 5.8788673],
            [45.2369763, 5.8806457],
            [45.2389070, 5.8818623],
            [45.2411361, 5.8825852],
            [45.2432849, 5.8831626],
            [45.2458359, 5.8838693],
            [45.2479235, 5.8844688],
            [45.2504590, 5.8862813],
            [45.2525145, 5.8868710],
            [45.2549431, 5.8881446],
            [45.2568381, 5.8892132],
            [45.2595096, 5.8917068],
            [45.2614130, 5.8939347],
            [45.2637100, 5.8973364],
            [45.2655182, 5.8998623],
            [45.2671621, 5.9028509],
            [45.2673376, 5.9056426],
            [45.2674349, 5.9084294],
            [45.2690948, 5.9110127],
            [45.2724281, 5.9132453],
            [45.2743604, 5.9141452],
            [45.2765688, 5.9154843],
            [45.2787112, 5.9180495],
            [45.2812758, 5.9192702],
            [45.2837762, 5.9177777],
            [45.2857838, 5.9169114],
            [45.2888409, 5.9199126],
            [45.2901687, 5.9220635],
            [45.2922845, 5.9258761],
            [45.2949880, 5.9284162],
            [45.2984143, 5.9296782],
            [45.3008265, 5.9304276],
            [45.3030461, 5.9311787],
            [45.3052790, 5.9317440],
            [45.3079869, 5.9334696],
            [45.3107163, 5.9365526],
            [45.3132025, 5.9407835],
            [45.3148525, 5.9435057],
            [45.3168484, 5.9467942],
            [45.3183367, 5.9490357],
            [45.3207519, 5.9525273],
            [45.3231239, 5.9557137],
            [45.3251065, 5.9574356],
            [45.3269017, 5.9588136],
            [45.3286428, 5.9602619],
            [45.3308496, 5.9620981],
            [45.3371980, 5.9658710],
            [45.3392822, 5.9671734],
            [45.3415848, 5.9683969],
            [45.3450076, 5.9696763],
            [45.3475252, 5.9701532],
            [45.3499619, 5.9709244],
            [45.3557228, 5.9732223],
            [45.3580628, 5.9740298],
            [45.3610566, 5.9745747],
            [45.3631104, 5.9756199],
            [45.3668754, 5.9803198],
            [45.3692047, 5.9819097],
            [45.3722246, 5.9819440],
            [45.3744991, 5.9818209],
            [45.3782634, 5.9816543],
            [45.3808695, 5.9822292],
            [45.3990447, 5.9940942],
            [45.4021721, 5.9961726],
            [45.4052598, 5.9987551],
            [45.4079263, 6.0004663],
            [45.4110220, 6.0008955],
            [45.4211875, 6.0006517],
            [45.4242014, 6.0004219],
            [45.4264714, 6.0006326],
            [45.4307376, 6.0033621],
            [45.4332185, 6.0042118],
            [45.4373490, 6.0045341],
            [45.4406428, 6.0044431],
            [45.4426694, 6.0049054],
            [45.4458289, 6.0049841],
            [45.4478293, 6.0051334],
            [45.4508523, 6.0069655],
            [45.4535675, 6.0088288],
            [45.4582307, 6.0111933],
            [45.4613949, 6.0132337],
            [45.4665500, 6.0155335],
            [45.4699443, 6.0178561],
            [45.4718097, 6.0190122],
            [45.4746367, 6.0210213],
            [45.4763641, 6.0230666],
            [45.4794719, 6.0283330],
        ]

        isere_moyenne_level, isere_moyenne_rss = (None, None)
        try:
            isere_moyenne_level, isere_moyenne_rss = _fetch_vigicrues_troncon_rss_level("AN11")
        except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError):
            isere_moyenne_level, isere_moyenne_rss = (None, "https://www.vigicrues.gouv.fr/territoire/rss?CdEntVigiCru=AN11")

        troncons_index["AN11 Isère moyenne"] = {
            "code": "AN11",
            "name": "Isère moyenne",
            "level": isere_moyenne_level or "vert",
            "territory": "19",
            "rss": isere_moyenne_rss,
            "stations": [
                {"code": s["code"], "station": s["station"], "river": s["river"]}
                for s in isere_stations
                if "isère" in str(s.get("river") or "").lower()
            ],
            "geometry": {
                "type": "LineString",
                "coordinates": [[point[1], point[0]] for point in isere_moyenne_points],
            },
            "polyline": isere_moyenne_points,
        }

        # Tracé du tronçon Vigicrues AN30 (Drac aval) sur l'axe principal
        # du Drac entre Fontaine et Le Pont-de-Claix.
        drac_aval_points = [
            [45.20619481759856, 5.687024836831473],
            [45.205426000000000, 5.687932300000000],
            [45.203543000000000, 5.690597900000000],
            [45.202854100000000, 5.692720800000000],
            [45.201045300000000, 5.695231600000000],
            [45.199878900000000, 5.697143100000000],
            [45.197875700000000, 5.698271600000000],
            [45.196417800000000, 5.699670200000000],
            [45.194242100000000, 5.700885300000000],
            [45.192116500000000, 5.701357100000000],
            [45.190335900000000, 5.701432200000000],
            [45.188460600000000, 5.701941800000000],
            [45.186887800000000, 5.701893600000000],
            [45.185235600000000, 5.701046000000000],
            [45.183322400000000, 5.700734800000000],
            [45.181481000000000, 5.701217600000000],
            [45.179902300000000, 5.701190800000000],
            [45.177941700000000, 5.701303500000000],
            [45.176054800000000, 5.701443000000000],
            [45.174474000000000, 5.701496600000000],
            [45.172106700000000, 5.701475100000000],
            [45.170680900000000, 5.700686600000000],
            [45.168400400000000, 5.700461300000000],
            [45.166229500000000, 5.700869000000000],
            [45.164618200000000, 5.700831400000000],
            [45.163041000000000, 5.700767000000000],
            [45.160800600000000, 5.699890900000000],
            [45.159264400000000, 5.699312500000000],
            [45.156988700000000, 5.698619100000000],
            [45.155081300000000, 5.697580600000000],
            [45.153664200000000, 5.694800300000000],
            [45.152760400000000, 5.692758800000000],
            [45.151194800000000, 5.690646000000000],
            [45.149585700000000, 5.689680400000000],
            [45.147544300000000, 5.689161400000000],
            [45.146004200000000, 5.688765000000000],
            [45.143669600000000, 5.687379900000000],
            [45.141968700000000, 5.687487700000000],
            [45.139783100000000, 5.687726000000000],
            [45.138264600000000, 5.686971100000000],
            [45.135500800000000, 5.688211000000000],
            [45.133725400000000, 5.688921100000000],
            [45.130233600000000, 5.689175600000000],
            [45.127877500000000, 5.688898300000000],
            [45.126056000000000, 5.689179900000000],
            [45.124791400000000, 5.691365800000000],
            [45.123557900000000, 5.693369500000000],
            [45.122127100000000, 5.694179500000000],
            [45.121005000000000, 5.695992200000000],
            [45.120207400000000, 5.696663400000000],
            [45.12021175849194, 5.696691586043316],
        ]
        drac_aval_level, drac_aval_rss = (None, None)
        try:
            drac_aval_level, drac_aval_rss = _fetch_vigicrues_troncon_rss_level("AN30")
        except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError):
            drac_aval_level, drac_aval_rss = (None, "https://www.vigicrues.gouv.fr/territoire/rss?CdEntVigiCru=AN30")

        troncons_index["AN30 Drac aval"] = {
            "code": "AN30",
            "name": "Drac aval",
            "level": drac_aval_level or "vert",
            "territory": "19",
            "rss": drac_aval_rss,
            "stations": [
                {"code": s["code"], "station": s["station"], "river": s["river"]}
                for s in isere_stations
                if "drac" in str(s.get("river") or "").lower()
            ],
            "geometry": {
                "type": "LineString",
                "coordinates": [[point[1], point[0]] for point in drac_aval_points],
            },
            "polyline": drac_aval_points,
        }

        # Tracé du tronçon Vigicrues AN31 (Romanche aval) entre la
        # confluence Drac/Romanche et Allemond.
        romanche_aval_points = [
            [45.120491400000000, 5.696554600000000],
            [45.120207400000000, 5.696663400000000],
            [45.116740300000000, 5.697357200000000],
            [45.111703500000000, 5.696915000000000],
            [45.107544700000000, 5.699195900000000],
            [45.103675200000000, 5.704465900000000],
            [45.101625000000000, 5.703039900000000],
            [45.099210900000000, 5.705995200000000],
            [45.098002900000000, 5.711759600000000],
            [45.093251000000000, 5.719997600000000],
            [45.089083100000000, 5.728059600000000],
            [45.085178900000000, 5.737059000000000],
            [45.082969100000000, 5.743482800000000],
            [45.084313900000000, 5.752162400000000],
            [45.084397100000000, 5.757381200000000],
            [45.082233900000000, 5.762647800000000],
            [45.078964800000000, 5.765826200000000],
            [45.074045600000000, 5.764023500000000],
            [45.071212200000000, 5.762632700000000],
            [45.065141900000000, 5.761443400000000],
            [45.057876500000000, 5.767417300000000],
            [45.053648200000000, 5.775020600000000],
            [45.050083800000000, 5.780165400000000],
            [45.049511500000000, 5.784834100000000],
            [45.049038200000000, 5.789915000000000],
            [45.053275900000000, 5.796875900000000],
            [45.056312400000000, 5.804641000000000],
            [45.054990100000000, 5.815121700000000],
            [45.052875500000000, 5.821623100000000],
            [45.051130700000000, 5.833827600000000],
            [45.053347600000000, 5.840324300000000],
            [45.053089600000000, 5.848136500000000],
            [45.054986200000000, 5.853727900000000],
            [45.057384800000000, 5.857974100000000],
            [45.059882700000000, 5.860559200000000],
            [45.062664300000000, 5.863611200000000],
            [45.064968400000000, 5.866528000000000],
            [45.067323300000000, 5.868178300000000],
            [45.071334600000000, 5.871482700000000],
            [45.073082900000000, 5.872906700000000],
            [45.074702400000000, 5.873314100000000],
            [45.076134400000000, 5.879308800000000],
            [45.079000700000000, 5.885519400000000],
            [45.081668200000000, 5.892009400000000],
            [45.083807600000000, 5.895405300000000],
            [45.085825200000000, 5.898904700000000],
            [45.088438900000000, 5.899080500000000],
            [45.092918200000000, 5.900757400000000],
            [45.095324300000000, 5.905019000000000],
            [45.097480900000000, 5.912566900000000],
            [45.099534900000000, 5.915924200000000],
            [45.102135700000000, 5.918539100000000],
            [45.105261200000000, 5.920799600000000],
            [45.105743800000000, 5.925052200000000],
            [45.106544900000000, 5.929425100000000],
            [45.107018600000000, 5.935747400000000],
            [45.106999300000000, 5.940708500000000],
            [45.107310000000000, 5.944330000000000],
            [45.109513000000000, 5.947069300000000],
            [45.112723200000000, 5.954121500000000],
            [45.113741600000000, 5.957912700000000],
            [45.116984800000000, 5.960764800000000],
            [45.116797100000000, 5.965373100000000],
            [45.118223600000000, 5.969944000000000],
            [45.118010000000000, 5.976127400000000],
            [45.118020800000000, 5.981909400000000],
            [45.120423900000000, 6.002731600000000],
            [45.117220400000000, 6.010548700000000],
            [45.102515600000000, 6.021286800000000],
            [45.087625000000000, 6.018324500000000],
            [45.078134900000000, 6.023095400000000],
            [45.067248900000000, 6.027096500000000],
            [45.056187500000000, 6.040127500000000],
            [45.046262700000000, 6.055023200000000],
            [45.037744100000000, 6.054796000000000],
            [45.035064000000000, 6.055737000000000],
            [45.031805900000000, 6.057737600000000],
            [45.027829300000000, 6.061059300000000],
            [45.027666300000000, 6.061342700000000],
        ]
        romanche_aval_level, romanche_aval_rss = (None, None)
        try:
            romanche_aval_level, romanche_aval_rss = _fetch_vigicrues_troncon_rss_level("AN31")
        except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError):
            romanche_aval_level, romanche_aval_rss = (None, "https://www.vigicrues.gouv.fr/territoire/rss?CdEntVigiCru=AN31")

        troncons_index["AN31 Romanche aval"] = {
            "code": "AN31",
            "name": "Romanche aval",
            "level": romanche_aval_level or "vert",
            "territory": "19",
            "rss": romanche_aval_rss,
            "stations": [
                {"code": s["code"], "station": s["station"], "river": s["river"]}
                for s in isere_stations
                if "romanche" in str(s.get("river") or "").lower()
            ],
            "geometry": {
                "type": "LineString",
                "coordinates": [[point[1], point[0]] for point in romanche_aval_points],
            },
            "polyline": romanche_aval_points,
        }

        # Tracé du tronçon Vigicrues AN20 (Isère aval).
        # Priorité au tracé en ligne (OSM/Nominatim), avec fallback local.
        isere_aval_points_fallback = _truncate_isere_aval_before_grenoble([
            [45.192742, 5.720049],
            [45.196913, 5.715904],
            [45.201077, 5.711098],
            [45.206842, 5.703633],
            [45.211234, 5.691706],
            [45.217251, 5.672787],
            [45.229594, 5.659204],
            [45.241317, 5.651372],
            [45.251863, 5.644286],
            [45.264684, 5.631807],
            [45.277327, 5.619103],
            [45.289901, 5.611094],
            [45.302241, 5.604425],
            [45.299431, 5.583602],
            [45.296397, 5.561819],
            [45.289828, 5.544882],
            [45.280496, 5.525988],
            [45.267145, 5.516251],
            [45.252306, 5.508979],
            [45.239415, 5.497551],
            [45.226758, 5.486298],
            [45.218921, 5.479958],
            [45.212167, 5.473645],
            [45.206327, 5.464817],
            [45.202350, 5.455610],
            [45.200944, 5.447422],
            [45.199289, 5.439137],
            [45.197088, 5.431329],
            [45.194998, 5.424278],
            [45.192022, 5.421816],
            [45.190110, 5.420185],
            [45.184983, 5.417978],
            [45.180661, 5.415909],
            [45.177549, 5.406518],
            [45.174636, 5.393739],
            [45.171848, 5.389218],
            [45.168977, 5.384745],
            [45.165361, 5.377966],
            [45.161916, 5.371167],
            [45.157641, 5.366801],
            [45.153272, 5.362820],
            [45.147996, 5.361713],
            [45.142324, 5.360823],
            [45.137601, 5.356721],
            [45.132696, 5.352811],
            [45.129779, 5.347468],
            [45.127379, 5.342799],
            [45.127183, 5.338712],
            [45.127172, 5.334868],
            [45.124126, 5.328338],
            [45.121460, 5.321617],
            [45.119652, 5.314023],
            [45.118260, 5.306793],
            [45.117094, 5.300965],
            [45.115968, 5.295162],
            [45.113886, 5.287776],
            [45.111472, 5.280445],
            [45.107384, 5.276157],
            [45.102455, 5.272477],
            [45.096917, 5.272344],
            [45.091423, 5.272402],
            [45.085894, 5.271113],
            [45.080409, 5.269849],
            [45.074578, 5.266168],
            [45.068838, 5.262774],
            [45.067098, 5.257344],
            [45.066465, 5.251642],
            [45.066771, 5.247093],
            [45.067256, 5.242671],
            [45.070144, 5.235861],
            [45.073257, 5.229234],
            [45.076619, 5.226205],
            [45.079992, 5.222998],
            [45.082107, 5.211261],
            [45.083637, 5.198930],
            [45.084262, 5.190655],
            [45.084675, 5.182364],
            [45.080613, 5.177657],
            [45.076013, 5.172771],
            [45.071624, 5.170451],
            [45.067283, 5.168274],
            [45.059467, 5.161814],
            [45.051601, 5.155182],
            [45.044394, 5.139642],
            [45.037207, 5.122742],
            [45.038009, 5.101343],
            [45.039407, 5.080372],
            [45.040292, 5.062638],
            [45.041306, 5.045120],
            [45.034689, 5.043573],
            [45.028236, 5.041771],
            [45.030146, 5.020693],
            [45.032738, 5.000246],
            [45.036266, 4.974828],
            [45.039306, 4.950251],
            [45.033371, 4.946905],
            [45.027484, 4.943982],
            [45.024672, 4.944854],
            [45.021887, 4.945380],
            [45.019346, 4.936508],
            [45.017191, 4.928028],
            [45.016407, 4.919229],
            [45.015669, 4.910498],
            [45.011754, 4.900274],
            [45.006422, 4.891335],
            [45.002356, 4.886462],
            [44.998560, 4.880949],
            [44.994975, 4.874635],
            [44.991277, 4.868133],
            [44.987609, 4.862758],
            [44.983718, 4.857392],
            [44.982721, 4.855238],
            [44.981814, 4.852909],
        ])
        try:
            isere_aval_points = _load_isere_aval_polyline_online()
        except (HTTPError, URLError, TimeoutError, ValueError, KeyError, TypeError):
            isere_aval_points = isere_aval_points_fallback

        isere_aval_level, isere_aval_rss = (None, None)
        try:
            isere_aval_level, isere_aval_rss = _fetch_vigicrues_troncon_rss_level("AN20")
        except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError):
            isere_aval_level, isere_aval_rss = (None, "https://www.vigicrues.gouv.fr/territoire/rss?CdEntVigiCru=AN20")

        troncons_index["AN20 Isère aval"] = {
            "code": "AN20",
            "name": "Isère aval",
            "level": isere_aval_level or "vert",
            "territory": "19",
            "rss": isere_aval_rss,
            "stations": [
                {"code": s["code"], "station": s["station"], "river": s["river"]}
                for s in isere_stations
                if "isère" in str(s.get("river") or "").lower()
            ],
            "geometry": {
                "type": "LineString",
                "coordinates": [[point[1], point[0]] for point in isere_aval_points],
            },
            "polyline": isere_aval_points,
        }

        for station in isere_stations:
            _relocate_station_on_traced_troncon(station, troncons_index)

        troncons = list(troncons_index.values())

        isere_stations.sort(key=lambda station: (not station["is_priority"], station["station"] or "", station["code"] or ""))
        troncons.sort(key=lambda troncon: troncon.get("name") or "")

        if station_limit is not None:
            isere_stations = isere_stations[:station_limit]

        troncon_levels = [normalize_level(troncon.get("level") or "vert") for troncon in troncons if troncon.get("level")]
        levels = troncon_levels or [normalize_level(s["level"]) for s in isere_stations]
        global_level = "rouge" if "rouge" in levels else "orange" if "orange" in levels else "jaune" if "jaune" in levels else "vert"
        return {
            "service": "Vigicrues",
            "department": "Isère (38)",
            "status": "online",
            "source": source,
            "sandre_reference": sandre_reference,
            "water_alert_level": global_level,
            "stations": isere_stations,
            "troncons": troncons,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {
            "service": "Vigicrues",
            "department": "Isère (38)",
            "status": "degraded",
            "source": source,
            "sandre_reference": sandre_reference,
            "water_alert_level": "inconnu",
            "stations": [],
            "troncons": [],
            "error": str(exc),
        }


def fetch_vigicrues_isere(
    sample_size: int = 1200,
    station_limit: int | None = None,
    priority_names: list[str] | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_vigicrues_cache,
        lock=_vigicrues_cache_lock,
        ttl_seconds=_VIGICRUES_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_vigicrues_isere_live(
            sample_size=sample_size,
            station_limit=station_limit,
            priority_names=priority_names,
        ),
    )



def _itinisere_category(title: str, description: str) -> str:
    text = f"{title} {description}".lower()
    if any(word in text for word in ("fermeture", "coup", "interdit", "impossible")):
        return "fermeture"
    if any(word in text for word in ("travaux", "chantier", "alternat")):
        return "travaux"
    if any(word in text for word in ("accident", "collision", "panne", "obstacle")):
        return "incident"
    if any(word in text for word in ("neige", "verglas", "intemp", "pluie", "crue")):
        return "météo"
    if any(word in text for word in ("manifest", "évènement", "course", "marché")):
        return "évènement"
    return "trafic"


def _itinisere_extract_roads(text: str) -> list[str]:
    roads = {road.upper() for road in re.findall(r"\b([ADNMCR]\d{1,4})\b", text or "")}
    return sorted(roads)


def _itinisere_is_public_transport_event(title: str, description: str) -> bool:
    text = f"{title} {description}".lower()
    transport_tokens = (
        "transport en commun",
        "ligne",
        "tram",
        "bus",
        "cars",
        "car scolaire",
        "arrêt",
        "gare routière",
        "tag ",
        "transisère",
    )
    road_hint_tokens = ("autoroute", "route", "échangeur", "sortie", "rocade", "déviation")
    has_transport_token = any(token in text for token in transport_tokens)
    if not has_transport_token:
        return False
    has_road_hint = bool(_itinisere_extract_roads(text)) or any(token in text for token in road_hint_tokens)
    return not has_road_hint


def _itinisere_is_isere_event(title: str, description: str, roads: list[str] | None = None, locations: list[str] | None = None) -> bool:
    text = f"{title} {description} {' '.join(locations or [])}".lower()
    isere_tokens = (
        "isère",
        "isere",
        "grenoble",
        "voiron",
        "vienne",
        "bourgoin",
        "pontcharra",
        "la mure",
        "rives",
        "le touvet",
        "villard-de-lans",
    )
    if any(token in text for token in isere_tokens):
        return True

    isere_roads = {
        "A41",
        "A43",
        "A48",
        "A49",
        "N85",
        "N87",
        "D1075",
        "D1090",
        "D1532",
        "D520",
    }
    return bool(set(roads or []) & isere_roads)


def _itinisere_is_road_closure_pass_or_camera_event(title: str, description: str, category: str, roads: list[str] | None = None) -> bool:
    text = f"{title} {description}".lower()
    closure_tokens = ("fermet", "route coup", "interdit", "barr", "réouvert", "reouvert", "ouvert")
    pass_tokens = ("col ", "cols ", "col du", "col de", "col des")
    camera_tokens = ("caméra", "camera", "webcam", "vidéo", "video")
    works_tokens = ("travaux", "chantier", "basculement", "alternat", "neutralis")

    has_closure_signal = category == "fermeture" or any(token in text for token in closure_tokens)
    has_pass_signal = any(token in text for token in pass_tokens)
    has_camera_signal = any(token in text for token in camera_tokens)
    has_road_works_signal = category == "travaux" and (bool(roads) or any(token in text for token in works_tokens))
    return has_closure_signal or has_pass_signal or has_camera_signal or has_road_works_signal


def _itinisere_extract_locations(*chunks: str) -> list[str]:
    blob = " ".join(chunk or "" for chunk in chunks)
    cleaned = re.sub(r"<[^>]+>", " ", blob)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return []

    patterns = [
        r"\b(?:secteur|zone|quartier|arr[êe]t|gare|pont|avenue|rue|route|boulevard|place|sortie|échangeur)\s+[A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\- ]{2,60}",
        r"\b[A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+(?:\s+[A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+){0,3}\b",
    ]
    candidates: list[str] = []
    for pattern in patterns:
        candidates.extend(re.findall(pattern, cleaned))

    banlist = {
        "Ligne",
        "Perturbation",
        "Isère",
        "Infos",
        "Du",
        "Le",
        "Les",
        "Route",
        "Routes",
        "Infos route",
        "Coupure",
        "Fermeture",
        "Signaler",
        "Détail",
        "Detail",
        "Itinisère",
        "Itinisere",
    }
    normalized: list[str] = []
    for candidate in candidates:
        label = re.sub(r"\s+", " ", candidate).strip(" -·,.")
        normalized_label = re.sub(r"\s+", " ", label).strip()
        if len(normalized_label) < 4 or normalized_label in banlist:
            continue
        lowered = normalized_label.lower()
        if lowered.startswith("ligne "):
            continue
        if lowered.startswith(("lieux", "lieu", "signaler", "détail", "detail")):
            continue
        if lowered in {"coupure", "fermeture", "travaux", "perturbation"}:
            continue
        if normalized_label not in normalized:
            normalized.append(normalized_label)
    return normalized[:8]


def _itinisere_severity(title: str, description: str, category: str) -> str:
    text = f"{title} {description}".lower()
    if any(token in text for token in ("route coup", "fermet", "interdit", "impossible", "bloqu", "suspendu", "annul")):
        return "rouge"
    if any(token in text for token in ("accident", "collision", "fort", "gros ralent", "très perturb", "dév")):
        return "orange"
    if category in {"travaux", "incident", "évènement"} or any(token in text for token in ("travaux", "chantier", "retard", "ralenti", "manifest")):
        return "jaune"
    return "vert"


def _itinisere_extract_period(text: str) -> tuple[str | None, str | None]:
    compact = re.sub(r"\s+", " ", text or "")
    interval = re.search(r"Du\s+([^,]+?)\s+au\s+([^,]+?)(?:,|\.|$)", compact, flags=re.IGNORECASE)
    if interval:
        return interval.group(1).strip(), interval.group(2).strip()
    single = re.search(r"(?:Jusqu['’]au|jusqu['’]au)\s+([^,]+?)(?:,|\.|$)", compact)
    if single:
        return None, single.group(1).strip()
    return None, None


def _itinisere_fetch_detail(link: str, fallback_title: str) -> dict[str, Any]:
    safe_link = link if str(link).startswith("http") else "https://www.itinisere.fr"
    try:
        html_payload = _http_get_text(safe_link, timeout=10)
    except (HTTPError, URLError, TimeoutError, ValueError):
        return {}

    title = _extract_html_title(html_payload) or fallback_title
    content = re.sub(r"<script[\s\S]*?</script>", " ", html_payload, flags=re.IGNORECASE)
    content = re.sub(r"<style[\s\S]*?</style>", " ", content, flags=re.IGNORECASE)
    content = unescape(re.sub(r"<[^>]+>", "\n", content))
    lines = [re.sub(r"\s+", " ", line).strip() for line in content.splitlines()]
    lines = [line for line in lines if line and "itinisère" not in line.lower() and "plan du site" not in line.lower()]

    description = ""
    for line in lines:
        lowered = line.lower()
        if len(line) < 20:
            continue
        if any(token in lowered for token in ("ligne", "travaux", "arrêt", "accident", "perturb", "route", "ralent", "dévi", "bus")):
            description = line
            break
    if not description:
        description = next((line for line in lines if len(line) > 30), "")

    period_start, period_end = _itinisere_extract_period(description)
    published = ""
    for line in lines:
        if re.search(r"\b\d{1,2}/\d{1,2}/\d{2,4}\b", line):
            published = line
            break

    return {
        "title": title,
        "description": description,
        "published_at": published,
        "period_start": period_start,
        "period_end": period_end,
        "locations": _itinisere_extract_locations(title, description),
    }


def _itinisere_insights(events: list[dict[str, Any]]) -> dict[str, Any]:
    category_counts: dict[str, int] = {}
    road_counts: dict[str, int] = {}

    for event in events:
        category = str(event.get("category") or "trafic")
        category_counts[category] = category_counts.get(category, 0) + 1
        for road in event.get("roads") or []:
            road_counts[road] = road_counts.get(road, 0) + 1

    dominant_category = max(category_counts.items(), key=lambda item: item[1])[0] if category_counts else "aucune"
    top_roads = sorted(road_counts.items(), key=lambda item: item[1], reverse=True)[:5]

    return {
        "dominant_category": dominant_category,
        "category_breakdown": category_counts,
        "top_roads": [{"road": road, "count": count} for road, count in top_roads],
    }

def _fetch_itinisere_disruptions_live(limit: int = 60) -> dict[str, Any]:
    source = "https://www.itinisere.fr/fr/rss/Disruptions"
    try:
        xml_payload = _http_get_text(source)
        root = ET.fromstring(xml_payload)
        events: list[dict[str, Any]] = []
        raw_items = root.findall(".//item")[: max(1, min(limit, 120))]
        normalized_items = [
            {
                "title": re.sub(r"\s+", " ", (item.findtext("title") or "Perturbation").strip()),
                "description": re.sub(r"\s+", " ", (item.findtext("description") or "").strip()),
                "published": re.sub(r"\s+", " ", (item.findtext("pubDate") or "").strip()),
                "link": (item.findtext("link") or "https://www.itinisere.fr").strip(),
            }
            for item in raw_items
        ]

        details_by_link: dict[str, dict[str, Any]] = {}
        with ThreadPoolExecutor(max_workers=6) as executor:
            future_map = {
                executor.submit(_itinisere_fetch_detail, payload["link"], payload["title"]): payload["link"]
                for payload in normalized_items
                if payload["link"].startswith("http")
            }
            for future in as_completed(future_map):
                link = future_map[future]
                try:
                    details_by_link[link] = future.result() or {}
                except Exception:
                    details_by_link[link] = {}

        for item in normalized_items:
            title = item["title"]
            description = item["description"]
            published = item["published"]
            link = item["link"]

            detail = details_by_link.get(link) or {}
            final_title = detail.get("title") or title
            final_description = detail.get("description") or description
            roads = _itinisere_extract_roads(f"{final_title} {final_description}")
            category = _itinisere_category(final_title, final_description)
            severity = _itinisere_severity(final_title, final_description, category)
            locations = detail.get("locations") or _itinisere_extract_locations(final_title, final_description)
            if _itinisere_is_public_transport_event(final_title, final_description):
                continue
            if not _itinisere_is_isere_event(final_title, final_description, roads=roads, locations=locations):
                continue
            if not _itinisere_is_road_closure_pass_or_camera_event(final_title, final_description, category, roads=roads):
                continue
            events.append(
                {
                    "title": final_title,
                    "description": final_description[:550],
                    "published_at": detail.get("published_at") or published,
                    "link": link,
                    "roads": roads,
                    "category": category,
                    "severity": severity,
                    "period_start": detail.get("period_start"),
                    "period_end": detail.get("period_end"),
                    "locations": locations,
                }
            )
        insights = _itinisere_insights(events)
        insights["severity_breakdown"] = {
            level: len([event for event in events if event.get("severity") == level])
            for level in ("rouge", "orange", "jaune", "vert")
        }
        return {
            "service": "Itinisère",
            "status": "online",
            "source": source,
            "events": events,
            "events_total": len(events),
            "insights": insights,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {
            "service": "Itinisère",
            "status": "degraded",
            "source": source,
            "events": [],
            "events_total": 0,
            "insights": {"dominant_category": "aucune", "category_breakdown": {}, "top_roads": []},
            "error": str(exc),
        }


def fetch_itinisere_disruptions(limit: int = 60, force_refresh: bool = False) -> dict[str, Any]:
    safe_limit = max(1, min(limit, 120))
    return _cached_external_payload(
        cache=_itinisere_cache,
        lock=_itinisere_cache_lock,
        ttl_seconds=_ITINISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_itinisere_disruptions_live(limit=safe_limit),
    )


def _fetch_prefecture_isere_news_live(limit: int = 7) -> dict[str, Any]:
    source = "https://www.isere.gouv.fr/syndication/flux/actualites"
    try:
        xml_payload = _http_get_text(source)
        root = ET.fromstring(xml_payload)
        namespace = {"atom": "http://www.w3.org/2005/Atom"}
        items: list[dict[str, Any]] = []

        for item in root.findall(".//item"):
            link = (item.findtext("link") or "https://www.isere.gouv.fr").strip()
            title = _resolve_prefecture_news_title(item.findtext("title") or "", link)
            description_html = (item.findtext("description") or "").strip()
            description = unescape(re.sub(r"\s+", " ", _strip_html_tags(description_html))).strip()
            published = (item.findtext("pubDate") or "").strip()
            items.append(
                {
                    "title": title,
                    "description": description[:400],
                    "published_at": published,
                    "link": link,
                }
            )

        if not items:
            for entry in root.findall(".//atom:entry", namespace):
                link_tag = entry.find("atom:link", namespace)
                link = (link_tag.get("href") if link_tag is not None else "") or "https://www.isere.gouv.fr"
                title = _resolve_prefecture_news_title(entry.findtext("atom:title", namespaces=namespace) or "", link)
                summary_html = (entry.findtext("atom:summary", namespaces=namespace) or "").strip()
                summary = unescape(re.sub(r"\s+", " ", _strip_html_tags(summary_html))).strip()
                published = (entry.findtext("atom:published", namespaces=namespace) or "").strip()
                items.append(
                    {
                        "title": title,
                        "description": summary[:400],
                        "published_at": published,
                        "link": link,
                    }
                )

        items.sort(key=lambda article: _parse_prefecture_published_date(article.get("published_at") or ""), reverse=True)

        return {
            "service": "Préfecture de l'Isère",
            "status": "online",
            "source": source,
            "items": items[:limit],
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {
            "service": "Préfecture de l'Isère",
            "status": "degraded",
            "source": source,
            "items": [],
            "error": str(exc),
        }

def _extract_drupal_settings_json(page_html: str) -> dict[str, Any]:
    match = re.search(
        r'<script type="application/json" data-drupal-selector="drupal-settings-json">(.*?)</script>',
        page_html,
        flags=re.DOTALL,
    )
    if not match:
        raise ValueError("Configuration Drupal introuvable")
    return json.loads(match.group(1))


def _atmo_level_from_index(index_value: float | int | None) -> str:
    if index_value is None:
        return "inconnu"
    if index_value <= 2:
        return "vert"
    if index_value <= 4:
        return "jaune"
    if index_value <= 6:
        return "orange"
    return "rouge"


def _fetch_atmo_aura_isere_air_quality_live() -> dict[str, Any]:
    source = "https://www.atmo-auvergnerhonealpes.fr/air-commune/grenoble/38185/indice-atmo"
    try:
        page_html = _http_get_text(source, timeout=16)
        settings_payload = _extract_drupal_settings_json(page_html)
        dataviz = settings_payload.get("dataviz") or {}
        indices = dataviz.get("indices") or {}
        comments = dataviz.get("comments") or {}

        available_dates = sorted(indices.keys())
        if not available_dates:
            raise ValueError("Indices ATMO indisponibles")

        today_date = available_dates[0]
        tomorrow_date = available_dates[1] if len(available_dates) > 1 else None
        today_payload = indices.get(today_date) or {}
        tomorrow_payload = indices.get(tomorrow_date) or {}

        today_index = today_payload.get("indice_atmo")
        tomorrow_index = tomorrow_payload.get("indice_atmo")

        return {
            "service": "Atmo Auvergne-Rhône-Alpes",
            "status": "online",
            "department": "Isère",
            "city": "Grenoble",
            "source": source,
            "today": {
                "date": today_date,
                "index": today_index,
                "level": _atmo_level_from_index(today_index),
                "comment": comments.get(today_date, ""),
                "sub_indices": today_payload.get("sous_indices") or [],
            },
            "tomorrow": {
                "date": tomorrow_date,
                "index": tomorrow_index,
                "level": _atmo_level_from_index(tomorrow_index),
                "comment": comments.get(tomorrow_date, ""),
                "sub_indices": tomorrow_payload.get("sous_indices") or [],
            },
            "has_pollution_episode": bool(dataviz.get("hasEpisodeInProgress")),
            "updated_at": comments.get("date_maj") or (datetime.utcnow().isoformat() + "Z"),
        }
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError) as exc:
        return {
            "service": "Atmo Auvergne-Rhône-Alpes",
            "status": "degraded",
            "department": "Isère",
            "city": "Grenoble",
            "source": source,
            "today": {},
            "tomorrow": {},
            "has_pollution_episode": False,
            "error": str(exc),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }


def fetch_prefecture_isere_news(limit: int = 7, force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_prefecture_cache,
        lock=_prefecture_cache_lock,
        ttl_seconds=_PREFECTURE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_prefecture_isere_news_live(limit=limit),
    )



def _fetch_dauphine_isere_news_live(limit: int = 7) -> dict[str, Any]:
    source = "https://www.ledauphine.com/isere/rss"
    try:
        xml_payload = _http_get_text(source)
        root = ET.fromstring(xml_payload)
        items: list[dict[str, Any]] = []
        for item in root.findall(".//item"):
            title = unescape((item.findtext("title") or "").strip()) or "Article Le Dauphiné Libéré"
            link = (item.findtext("link") or "https://www.ledauphine.com/isere").strip()
            description_html = (item.findtext("description") or "").strip()
            description = unescape(re.sub(r"\s+", " ", _strip_html_tags(description_html))).strip()
            published = (item.findtext("pubDate") or "").strip()
            items.append({
                "title": title,
                "description": description[:400],
                "published_at": published,
                "link": link,
            })

        items.sort(key=lambda article: _parse_prefecture_published_date(article.get("published_at") or ""), reverse=True)
        return {
            "service": "Le Dauphiné Libéré · Isère",
            "status": "online",
            "source": source,
            "items": items[:limit],
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {
            "service": "Le Dauphiné Libéré · Isère",
            "status": "degraded",
            "source": source,
            "items": [],
            "error": str(exc),
        }


def fetch_dauphine_isere_news(limit: int = 7, force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_dauphine_cache,
        lock=_dauphine_cache_lock,
        ttl_seconds=_DAUPHINE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_dauphine_isere_news_live(limit=limit),
    )


def _sncf_extract_links(detail_html: str) -> list[str]:
    links = re.findall(r'href=["\'](.*?)["\']', detail_html or '', flags=re.IGNORECASE)
    normalized: list[str] = []
    for link in links:
        if link.startswith("http") and link not in normalized:
            normalized.append(link)
    return normalized


def _sncf_extract_axes(text: str) -> list[str]:
    matches = re.findall(r"axe\s+([A-Za-zÀ-ÿ']+(?:[ -][A-Za-zÀ-ÿ']+){0,2}\s*-\s*[A-Za-zÀ-ÿ']+(?:[ -][A-Za-zÀ-ÿ']+){0,2})", text, flags=re.IGNORECASE)
    axes: list[str] = []
    for match in matches:
        normalized = re.sub(r"\s+", " ", match).strip(" .")
        if "-" in normalized:
            left, right = [chunk.strip() for chunk in normalized.split("-", 1)]
            right = re.split(r"\b(?:le|la|les|du|des|suite|est|sont)\b", right, maxsplit=1, flags=re.IGNORECASE)[0].strip(" .")
            normalized = f"{left} - {right}" if left and right else normalized
        if normalized and normalized not in axes:
            axes.append(normalized)
    return axes


def _sncf_level(lower_blob: str, severity: str) -> str:
    if any(token in lower_blob for token in ("interrompu", "accident", "supprim", "glissement")):
        return "orange"
    severity_map = {
        "verySevere": "rouge",
        "severe": "orange",
        "normal": "jaune",
        "slight": "jaune",
    }
    return severity_map.get((severity or "").strip(), "jaune")


def _fetch_sncf_isere_alerts_live() -> dict[str, Any]:
    source = "https://proxy.transport.data.gouv.fr/resource/sncf-siri-lite-situation-exchange"
    try:
        xml_payload = _http_get_text(source, timeout=18)
        root = ET.fromstring(xml_payload)
        namespace = {"siri": "http://www.siri.org.uk/siri"}
        situations = root.findall(".//siri:PtSituationElement", namespace)

        keyword_scope = (
            "isere", "isère", "grenoble", "bourgoin", "vienne", "voiron", "rives", "poliénas", "saint-andre-le-gaz", "pont-de-beauvoisin",
        )
        keyword_type = ("accident", "travaux", "voie", "perturb", "interrompu", "ralenti", "glissement")

        alerts: list[dict[str, Any]] = []
        for situation in situations:
            summary = re.sub(r"\s+", " ", (situation.findtext("siri:Summary", default="", namespaces=namespace) or "").strip())
            description = re.sub(r"\s+", " ", (situation.findtext("siri:Description", default="", namespaces=namespace) or "").strip())
            detail_html = (situation.findtext("siri:Detail", default="", namespaces=namespace) or "").strip()
            detail_text = re.sub(r"\s+", " ", _strip_html_tags(unescape(detail_html))).strip()
            text_blob = f"{summary} {description} {detail_text}".strip()
            lower_blob = text_blob.lower()
            if not lower_blob:
                continue
            if not any(token in lower_blob for token in keyword_scope):
                continue
            if not any(token in lower_blob for token in keyword_type):
                continue

            severity_raw = (situation.findtext("siri:Severity", default="", namespaces=namespace) or "").strip()
            level = _sncf_level(lower_blob, severity_raw)
            situation_number = (situation.findtext("siri:SituationNumber", default="", namespaces=namespace) or "").strip()
            publication_window = (situation.findtext("siri:PublicationWindow/siri:StartTime", default="", namespaces=namespace) or "").strip()
            validity_start = (situation.findtext("siri:ValidityPeriod/siri:StartTime", default="", namespaces=namespace) or "").strip()
            validity_end = (situation.findtext("siri:ValidityPeriod/siri:EndTime", default="", namespaces=namespace) or "").strip()
            links = _sncf_extract_links(detail_html)
            axes = _sncf_extract_axes(text_blob)
            alerts.append({
                "title": summary or "Alerte trafic SNCF Isère",
                "description": (description or detail_text or text_blob)[:600],
                "type": "accident" if "accident" in lower_blob else "travaux",
                "level": level,
                "severity_raw": severity_raw,
                "locations": ["Isère"],
                "axes": axes,
                "link": links[0] if links else source,
                "links": links,
                "situation_number": situation_number,
                "published_at": publication_window,
                "valid_from": validity_start,
                "valid_until": validity_end,
            })

        deduplicated: list[dict[str, Any]] = []
        seen_descriptions: set[str] = set()
        for alert in alerts:
            fingerprint = f"{(alert.get('title') or '').lower()}::{(alert.get('description') or '').lower()}"
            if fingerprint in seen_descriptions:
                continue
            seen_descriptions.add(fingerprint)
            deduplicated.append(alert)

        return {
            "service": "SNCF TER Auvergne-Rhône-Alpes",
            "status": "online",
            "source": source,
            "alerts": deduplicated[:10],
            "alerts_total": len(deduplicated),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (ET.ParseError, HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError) as exc:
        return {
            "service": "SNCF TER Auvergne-Rhône-Alpes",
            "status": "degraded",
            "source": source,
            "alerts": [],
            "alerts_total": 0,
            "error": str(exc),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }


def fetch_sncf_isere_alerts(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_sncf_isere_cache,
        lock=_sncf_isere_cache_lock,
        ttl_seconds=_SNCF_ISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_sncf_isere_alerts_live,
    )


def _rte_electricity_risk_level(supply_margin_mw: int | float | None) -> str:
    if supply_margin_mw is None:
        return "inconnu"
    if supply_margin_mw >= 1000:
        return "vert"
    if supply_margin_mw >= 300:
        return "jaune"
    if supply_margin_mw >= 0:
        return "orange"
    return "rouge"


def _fetch_rte_isere_electricity_live() -> dict[str, Any]:
    dataset_api = "https://www.data.gouv.fr/api/1/datasets/donnees-eco2mix-regionales-temps-reel-1/"
    records_api = (
        "https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets/eco2mix-regional-tr/records"
        "?select=code_insee_region,libelle_region,date_heure,consommation,thermique,nucleaire,eolien,solaire,hydraulique,bioenergies,ech_physiques"
        "&where=code_insee_region%3D%2784%27%20and%20consommation%20is%20not%20null"
        "&order_by=date_heure%20desc&limit=1"
    )

    try:
        dataset_payload = _http_get_json(dataset_api)
        records_payload = _http_get_json(records_api)
        records = records_payload.get("results") or []
        if not records:
            raise ValueError("Aucune donnée éCO2mix disponible pour la région ARA")

        latest = records[0]
        consumption = int(latest.get("consommation") or 0)
        production_breakdown = {
            "nucleaire": int(latest.get("nucleaire") or 0),
            "hydraulique": int(latest.get("hydraulique") or 0),
            "solaire": int(latest.get("solaire") or 0),
            "eolien": int(latest.get("eolien") or 0),
            "thermique": int(latest.get("thermique") or 0),
            "bioenergies": int(latest.get("bioenergies") or 0),
        }
        regional_generation = sum(production_breakdown.values())
        supply_margin_mw = regional_generation - consumption
        exchange = int(latest.get("ech_physiques") or 0)
        level = _rte_electricity_risk_level(supply_margin_mw)

        return {
            "service": "RTE éCO2mix régional",
            "status": "online",
            "department": "Isère (38)",
            "scope": "Proxy régional Auvergne-Rhône-Alpes (code INSEE 84)",
            "source": records_api,
            "dataset": {
                "title": dataset_payload.get("title", "Données éCO2mix régionales temps réel"),
                "page": dataset_payload.get("page", "https://www.data.gouv.fr/datasets/donnees-eco2mix-regionales-temps-reel-1"),
            },
            "observed_at": latest.get("date_heure"),
            "level": level,
            "consumption_mw": consumption,
            "regional_generation_mw": regional_generation,
            "supply_margin_mw": supply_margin_mw,
            "exchange_mw": exchange,
            "production_breakdown_mw": production_breakdown,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError) as exc:
        return {
            "service": "RTE éCO2mix régional",
            "status": "degraded",
            "department": "Isère (38)",
            "scope": "Proxy régional Auvergne-Rhône-Alpes (code INSEE 84)",
            "source": records_api,
            "level": "inconnu",
            "error": str(exc),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }


def fetch_rte_isere_electricity_status(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_rte_electricity_cache,
        lock=_rte_electricity_cache_lock,
        ttl_seconds=_RTE_ELECTRICITY_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_rte_isere_electricity_live,
    )


def _extract_city_from_finess_address_line(value: str) -> tuple[str | None, str | None]:
    blob = re.sub(r"\s+", " ", (value or "").strip())
    if not blob:
        return None, None
    match = re.match(r"^(\d{5})\s+(.+)$", blob)
    if not match:
        return None, blob.title()
    postal_code = match.group(1)
    city = match.group(2).strip().title()
    return postal_code, city


def _finess_isere_kind(row: list[str]) -> str | None:
    blob = " ".join((row[3] if len(row) > 3 else "", row[4] if len(row) > 4 else "", row[19] if len(row) > 19 else "", row[21] if len(row) > 21 else "")).lower()
    if any(token in blob for token in ("ehpad", "hebergement pour personnes agees dependantes", "hébergement pour personnes âgées dépendantes")):
        return "ehpad"
    if any(token in blob for token in ("hopital", "hôpital", "hospital", "clinique", "chu", "centre hospitalier")):
        return "hopital"
    return None


def _finess_commune_center(city: str) -> tuple[float, float] | None:
    try:
        payload = _http_get_json(
            f"https://geo.api.gouv.fr/communes?nom={quote_plus(city)}&codeDepartement=38&fields=centre&boost=population&limit=1",
            timeout=8,
        )
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, list) or not payload:
        return None
    coordinates = ((payload[0] or {}).get("centre") or {}).get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) != 2:
        return None
    lon, lat = coordinates
    try:
        return float(lat), float(lon)
    except (TypeError, ValueError):
        return None


def _fetch_finess_isere_resources_live(limit: int = 250) -> dict[str, Any]:
    dataset_url = "https://www.data.gouv.fr/api/1/datasets/finess-extraction-du-fichier-des-etablissements/"
    dataset = _http_get_json(dataset_url, timeout=12)
    resources = dataset.get("resources") if isinstance(dataset, dict) else []
    csv_url = ""
    for resource in resources or []:
        title = str(resource.get("title") or "").lower()
        if "géolocalis" in title and str(resource.get("url") or "").endswith(".csv"):
            csv_url = str(resource.get("url") or "")
            break
    if not csv_url:
        raise RuntimeError("Ressource FINESS géolocalisée introuvable sur data.gouv.fr")

    request = Request(csv_url, headers={"User-Agent": "ope-protec/1.0"})
    csv_bytes = _http_get_with_retries(request=request, timeout=45)
    decoded = csv_bytes.decode("utf-8", errors="ignore").splitlines()
    rows = csv.reader(decoded, delimiter=";")
    next(rows, None)  # ligne métadonnées

    commune_center_cache: dict[str, tuple[float, float] | None] = {}
    points: list[dict[str, Any]] = []
    hospitals_total = 0
    ehpad_total = 0
    for row in rows:
        if len(row) < 22 or row[13].strip() != "38":
            continue
        kind = _finess_isere_kind(row)
        if not kind:
            continue
        if kind == "hopital":
            hospitals_total += 1
        if kind == "ehpad":
            ehpad_total += 1
        if len(points) >= max(20, min(limit, 400)):
            continue

        postal_code, city = _extract_city_from_finess_address_line(row[15] if len(row) > 15 else "")
        if not city:
            continue
        if city not in commune_center_cache:
            commune_center_cache[city] = _finess_commune_center(city)
        coords = commune_center_cache.get(city)
        if not coords:
            continue
        lat, lon = coords
        address_parts = [row[8] if len(row) > 8 else "", row[9] if len(row) > 9 else "", row[15] if len(row) > 15 else ""]
        points.append(
            {
                "id": f"finess-{row[1] if len(row) > 1 else len(points)}",
                "name": str((row[4] if len(row) > 4 else "") or (row[3] if len(row) > 3 else "")).strip() or "Établissement FINESS",
                "short_name": str(row[3] if len(row) > 3 else "").strip() or "",
                "type": kind,
                "category": str(row[21] if len(row) > 21 else "").strip(),
                "lat": lat,
                "lon": lon,
                "city": city,
                "postal_code": postal_code,
                "address": re.sub(r"\s+", " ", " ".join(part for part in address_parts if part).strip()),
                "finess_id": str(row[1] if len(row) > 1 else "").strip(),
                "source": "https://www.data.gouv.fr/fr/datasets/finess-extraction-du-fichier-des-etablissements/",
                "info": f"Source FINESS data.gouv.fr · {kind.upper()}",
                "active": True,
                "priority": "critical" if kind == "hopital" else "vital",
                "dynamic": True,
            }
        )

    return {
        "status": "online",
        "source": "FINESS data.gouv.fr",
        "dataset_url": "https://www.data.gouv.fr/fr/datasets/finess-extraction-du-fichier-des-etablissements/",
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "hospitals_total": hospitals_total,
        "ehpad_total": ehpad_total,
        "resources_total": len(points),
        "resources": points,
    }


def fetch_finess_isere_resources(force_refresh: bool = False, limit: int = 250) -> dict[str, Any]:
    safe_limit = max(20, min(limit, 400))

    def loader() -> dict[str, Any]:
        try:
            return _fetch_finess_isere_resources_live(limit=safe_limit)
        except Exception as exc:
            return {
                "status": "degraded",
                "source": "FINESS data.gouv.fr",
                "updated_at": datetime.utcnow().isoformat() + "Z",
                "hospitals_total": 0,
                "ehpad_total": 0,
                "resources_total": 0,
                "resources": [],
                "error": str(exc),
            }

    return _cached_external_payload(
        cache=_finess_isere_cache,
        lock=_finess_isere_cache_lock,
        ttl_seconds=_FINESS_ISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=loader,
    )


def fetch_atmo_aura_isere_air_quality(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_atmo_aura_cache,
        lock=_atmo_aura_cache_lock,
        ttl_seconds=_ATMO_AURA_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_atmo_aura_isere_air_quality_live,
    )


def _bison_color_label(code: str) -> str:
    mapping = {
        "V": "vert",
        "J": "jaune",
        "O": "orange",
        "R": "rouge",
        "N": "noir",
    }
    return mapping.get((code or "").strip().upper(), "inconnu")


def _parse_bison_segment(segment: str) -> dict[str, str]:
    departure_code, _, return_code = (segment or "V,V").partition(",")
    return {
        "departure": _bison_color_label(departure_code),
        "return": _bison_color_label(return_code),
    }


def _fetch_bison_fute_traffic_live() -> dict[str, Any]:
    source = "https://www.bison-fute.gouv.fr/previsions/previsions.json"
    try:
        payload = _http_get_json(source)
        days = payload.get("days") or []
        national = payload.get("national") or []
        depts = payload.get("deptsLine") or []
        values = payload.get("values") or []

        if not days or not national:
            raise ValueError("Prévisions Bison Futé vides")

        today = datetime.utcnow().strftime("%d/%m/%Y")
        day_index = days.index(today) if today in days else 0
        tomorrow_index = min(day_index + 1, len(days) - 1)

        isere_index = depts.index("38") if "38" in depts else None

        def pick_entry(index: int) -> dict[str, Any]:
            national_segment = _parse_bison_segment(national[index] if index < len(national) else "V,V")
            isere_segment = {"departure": "inconnu", "return": "inconnu"}
            if isere_index is not None and index < len(values) and isere_index < len(values[index]):
                isere_segment = _parse_bison_segment(values[index][isere_index])
            return {
                "date": days[index],
                "national": national_segment,
                "isere": isere_segment,
            }

        return {
            "service": "Bison Futé",
            "status": "online",
            "source": source,
            "today": pick_entry(day_index),
            "tomorrow": pick_entry(tomorrow_index),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError) as exc:
        return {
            "service": "Bison Futé",
            "status": "degraded",
            "source": source,
            "today": {
                "date": "-",
                "national": {"departure": "inconnu", "return": "inconnu"},
                "isere": {"departure": "inconnu", "return": "inconnu"},
            },
            "tomorrow": {
                "date": "-",
                "national": {"departure": "inconnu", "return": "inconnu"},
                "isere": {"departure": "inconnu", "return": "inconnu"},
            },
            "error": str(exc),
        }


def fetch_bison_fute_traffic(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_bison_cache,
        lock=_bison_cache_lock,
        ttl_seconds=_BISON_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_bison_fute_traffic_live,
    )


def _extract_voies_sur_berges_status(raw_comment: str) -> tuple[str, str]:
    text = re.sub(r"\s+", " ", str(raw_comment or "")).strip().lower()
    if not text:
        return "unknown", "information indisponible"

    berge_tokens = ("voie sur berge", "voies sur berges", "berges")
    closure_tokens = ("ferm", "coup", "interdit", "inaccess", "barri")
    open_tokens = ("ouvert", "accessible", "réouvert", "ouverte")

    if any(token in text for token in berge_tokens):
        if any(token in text for token in closure_tokens):
            return "closed", "fermée"
        if any(token in text for token in open_tokens):
            return "open", "ouverte"

    return "unknown", "non renseignée"


def _fetch_mobilites_grenoble_berges_live() -> dict[str, Any]:
    source = "https://data.mobilites-m.fr/api/dyn/vh/json"
    payload = _http_get_json(source, timeout=12)

    data = payload.get("data") if isinstance(payload, dict) else {}
    if not isinstance(data, dict):
        data = {}

    commentaire_interne = str(data.get("commentaire_interne") or "").strip()
    commentaire_public = str(data.get("commentaire") or "").strip()
    status, label = _extract_voies_sur_berges_status(f"{commentaire_interne} {commentaire_public}")

    return {
        "status": "online",
        "source": source,
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "grenoble_berges": {
            "status": status,
            "label": label,
            "details": commentaire_public or commentaire_interne or "Aucun commentaire voirie transmis.",
            "time": payload.get("time") if isinstance(payload, dict) else None,
            "publisher": data.get("valideur") or data.get("createur") or "mobilites-m",
        },
    }


def fetch_mobilites_grenoble_berges(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_mobilites_berges_cache,
        lock=_mobilites_berges_cache_lock,
        ttl_seconds=_MOBILITES_BERGES_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_mobilites_grenoble_berges_live,
    )


def _vigieau_level_rank(level: str) -> int:
    return {
        "vigilance": 1,
        "alerte": 2,
        "alerte renforcee": 3,
        "crise": 4,
    }.get(str(level or "").strip().lower(), 0)


def _normalize_vigieau_level(value: str) -> str:
    raw = str(value or "").strip().lower()
    if "crise" in raw:
        return "crise"
    if "renforc" in raw:
        return "alerte renforcée"
    if "alerte" in raw:
        return "alerte"
    if "vigilance" in raw:
        return "vigilance"
    return "non définie"


def _vigieau_level_to_color(level: str) -> str:
    normalized = str(level or "").lower()
    if "crise" in normalized:
        return "rouge"
    if "renforc" in normalized:
        return "orange"
    if "alerte" in normalized:
        return "jaune"
    if "vigilance" in normalized:
        return "vert"
    return "vert"


def _vigieau_list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("restrictions", "data", "results", "items", "records"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _vigieau_collect_zone_alerts() -> list[dict[str, Any]]:
    probe_points = [
        (45.1885, 5.7245),  # Grenoble
        (45.3640, 5.5920),  # Voiron
        (45.3930, 5.5050),  # Rives
        (45.2100, 5.6800),  # Échirolles
        (45.6110, 5.1500),  # Bourgoin-Jallieu
        (45.5270, 4.8740),  # Vienne
        (45.2980, 5.6360),  # Saint-Égrève
    ]

    entries: list[dict[str, Any]] = []
    for lat, lon in probe_points:
        query = urlencode({"lat": lat, "lon": lon})
        payload = _http_get_json(f"https://api.vigieau.beta.gouv.fr/api/zones?{query}", timeout=18)
        entries.extend(_vigieau_list(payload))

    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in entries:
        key = "|".join(
            [
                str(item.get("id") or ""),
                str(item.get("nom_zone") or item.get("nom") or item.get("name") or ""),
                str(item.get("niveau_gravite") or item.get("niveau") or item.get("niveauAlerte") or ""),
            ]
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _fetch_vigieau_restrictions_live() -> dict[str, Any]:
    source_page = "https://www.vigieau.gouv.fr"
    candidates = [
        "https://www.vigieau.gouv.fr/api/v1/restrictions?code_departement=38",
        "https://www.vigieau.gouv.fr/api/v1/restrictions?departement=38",
        "https://www.vigieau.gouv.fr/api/restrictions?code_departement=38",
    ]
    last_error: Exception | None = None

    for candidate in candidates:
        try:
            payload = _http_get_json(candidate, timeout=18)
            restrictions = _vigieau_list(payload)
            alerts: list[dict[str, Any]] = []
            for item in restrictions:
                dept = str(
                    item.get("code_departement")
                    or item.get("departement")
                    or item.get("codeDepartement")
                    or ""
                ).strip()
                if dept and dept != "38":
                    continue
                level = _normalize_vigieau_level(
                    item.get("niveau_gravite")
                    or item.get("niveau")
                    or item.get("niveauAlerte")
                    or item.get("libelle_niveau_gravite")
                    or item.get("severity")
                    or ""
                )
                alerts.append(
                    {
                        "zone": item.get("nom_zone")
                        or item.get("zone")
                        or item.get("nomZoneAlerte")
                        or item.get("nom_alerte")
                        or "Zone Isère",
                        "level": level,
                        "level_color": _vigieau_level_to_color(level),
                        "measure": item.get("mesure")
                        or item.get("restriction")
                        or item.get("libelle_mesure")
                        or item.get("mesurePrincipale")
                        or "Mesure de restriction d'eau active",
                        "start_date": item.get("date_debut")
                        or item.get("debut_validite")
                        or item.get("dateDebut")
                        or "",
                        "end_date": item.get("date_fin")
                        or item.get("fin_validite")
                        or item.get("dateFin")
                        or "",
                    }
                )

            alerts.sort(key=lambda alert: _vigieau_level_rank(alert.get("level", "")), reverse=True)
            max_level = alerts[0]["level_color"] if alerts else "vert"
            return {
                "service": "Vigieau",
                "status": "online",
                "source": candidate,
                "department": "Isère",
                "alerts": alerts[:20],
                "max_level": max_level,
                "updated_at": datetime.utcnow().isoformat() + "Z",
            }
        except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError) as exc:
            last_error = exc

    try:
        restrictions = _vigieau_collect_zone_alerts()
        alerts: list[dict[str, Any]] = []
        for item in restrictions:
            level = _normalize_vigieau_level(
                item.get("niveau_gravite")
                or item.get("niveau")
                or item.get("niveauAlerte")
                or item.get("libelle_niveau_gravite")
                or item.get("severity")
                or ""
            )
            alerts.append(
                {
                    "zone": item.get("nom_zone")
                    or item.get("zone")
                    or item.get("nom")
                    or item.get("name")
                    or "Zone Isère",
                    "level": level,
                    "level_color": _vigieau_level_to_color(level),
                    "measure": item.get("mesure")
                    or item.get("restriction")
                    or item.get("libelle_mesure")
                    or item.get("description")
                    or "Mesure de restriction d'eau active",
                    "start_date": item.get("date_debut")
                    or item.get("debut_validite")
                    or item.get("dateDebut")
                    or "",
                    "end_date": item.get("date_fin")
                    or item.get("fin_validite")
                    or item.get("dateFin")
                    or "",
                }
            )
        alerts.sort(key=lambda alert: _vigieau_level_rank(alert.get("level", "")), reverse=True)
        max_level = alerts[0]["level_color"] if alerts else "vert"
        return {
            "service": "Vigieau",
            "status": "online",
            "source": "https://api.vigieau.beta.gouv.fr/api/zones",
            "department": "Isère",
            "alerts": alerts[:20],
            "max_level": max_level,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError) as exc:
        last_error = exc

    return {
        "service": "Vigieau",
        "status": "degraded",
        "source": source_page,
        "department": "Isère",
        "alerts": [],
        "max_level": "vert",
        "error": str(last_error or "Service Vigieau indisponible"),
    }



def fetch_vigieau_restrictions(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_vigieau_cache,
        lock=_vigieau_cache_lock,
        ttl_seconds=_VIGIEAU_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_vigieau_restrictions_live,
    )



def _fetch_georisques_v2_collection(
    endpoint: str,
    departement: str = "38",
    page_size: int = 1000,
    extra_query: dict[str, Any] | None = None,
) -> dict[str, Any]:
    token = settings.georisques_api_token.strip()
    if not token:
        raise ValueError("Clé API Géorisques absente")

    headers = {"Authorization": f"Bearer {token}"}
    base_query = deepcopy(extra_query) if extra_query else {}

    if not any(key in base_query for key in ("departement", "department", "codeDepartement")):
        base_query["departement"] = departement

    query_candidates: list[tuple[dict[str, Any], tuple[str, str] | None]] = []
    pagination_variants = [
        ("pageSize", "pageNumber"),
        ("size", "page"),
        ("page_size", "page"),
    ]

    for dept_key in ("departement", "department", "codeDepartement"):
        candidate_base = deepcopy(base_query)
        if "departement" in candidate_base and dept_key != "departement":
            candidate_base[dept_key] = candidate_base.pop("departement")
        elif dept_key != "departement" and "departement" not in candidate_base and dept_key not in candidate_base and "department" in candidate_base:
            candidate_base[dept_key] = candidate_base.pop("department")
        for size_key, page_key in pagination_variants:
            candidate = deepcopy(candidate_base)
            candidate[size_key] = page_size
            candidate[page_key] = 0
            query_candidates.append((candidate, (size_key, page_key)))
        query_candidates.append((candidate_base, None))

    deduped_candidates: list[tuple[dict[str, Any], tuple[str, str] | None]] = []
    seen: set[str] = set()
    for candidate, pagination in query_candidates:
        candidate_key = json.dumps(candidate, sort_keys=True, default=str)
        if candidate_key in seen:
            continue
        seen.add(candidate_key)
        deduped_candidates.append((candidate, pagination))

    last_error: Exception | None = None
    first_page: dict[str, Any] | None = None
    page_config: tuple[str, str] | None = None
    selected_query: dict[str, Any] | None = None

    for candidate_query, pagination in deduped_candidates:
        try:
            payload = _http_get_json(
                f"https://www.georisques.gouv.fr/api/v2/{endpoint}?{urlencode(candidate_query, doseq=True)}",
                headers=headers,
            )
            first_page = payload if isinstance(payload, dict) else {}
            selected_query = deepcopy(candidate_query)
            page_config = pagination
            break
        except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError) as exc:
            last_error = exc

    if first_page is None or selected_query is None:
        raise last_error or ValueError(f"Réponse Géorisques vide pour {endpoint}")

    content = list(first_page.get("content") or [])
    total_pages = int(first_page.get("totalPages") or first_page.get("total_pages") or 1)

    if page_config:
        _, page_key = page_config
        for page_number in range(1, total_pages):
            selected_query[page_key] = page_number
            page_payload = _http_get_json(
                f"https://www.georisques.gouv.fr/api/v2/{endpoint}?{urlencode(selected_query, doseq=True)}",
                headers=headers,
            )
            content.extend(page_payload.get("content") or [])

    return {
        "total_elements": int(first_page.get("totalElements") or len(content)),
        "content": content,
    }


def _resolve_commune_insee_codes(names: list[str], departement: str = "38") -> dict[str, str]:
    resolved: dict[str, str] = {}
    for name in names:
        label = (name or "").strip()
        if not label:
            continue
        try:
            payload = _http_get_json(
                f"https://geo.api.gouv.fr/communes?nom={quote_plus(label)}&departement={quote_plus(departement)}&fields=nom,code&boost=population&limit=1"
            )
            if isinstance(payload, list) and payload:
                code = str(payload[0].get("code") or "").strip()
                if code:
                    resolved[code] = label
        except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
            continue
    return resolved


def resolve_commune_insee_code(name: str, postal_code: str | None = None, departement: str = "38") -> str | None:
    label = (name or "").strip()
    if not label:
        return None
    query = f"https://geo.api.gouv.fr/communes?nom={quote_plus(label)}&fields=nom,code&boost=population&limit=1"
    if postal_code:
        query = f"https://geo.api.gouv.fr/communes?nom={quote_plus(label)}&codePostal={quote_plus(str(postal_code))}&fields=nom,code&boost=population&limit=1"
    elif departement:
        query = f"https://geo.api.gouv.fr/communes?nom={quote_plus(label)}&departement={quote_plus(departement)}&fields=nom,code&boost=population&limit=1"
    try:
        payload = _http_get_json(query)
        if isinstance(payload, list) and payload:
            code = str(payload[0].get("code") or "").strip()
            return code or None
    except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
        return None
    return None


def _georisques_danger_label(risk_total: int) -> str:
    if risk_total >= 8:
        return "Très élevé"
    if risk_total >= 5:
        return "Élevé"
    if risk_total >= 2:
        return "Modéré"
    return "Faible"


def fetch_georisques_commune_risks(codes_insee: list[str]) -> dict[str, Any]:
    normalized_codes = []
    for code in codes_insee:
        candidate = str(code or "").strip()
        if candidate and candidate.isdigit() and len(candidate) == 5 and candidate not in normalized_codes:
            normalized_codes.append(candidate)

    if not normalized_codes:
        return {"service": "Géorisques", "source": "https://georisques.gouv.fr/api/v1/gaspar/risques", "communes": [], "updated_at": datetime.utcnow().isoformat() + "Z"}

    query = urlencode({"code_insee": ",".join(normalized_codes), "page_size": 100}, doseq=True)
    try:
        payload = _http_get_json(f"https://www.georisques.gouv.fr/api/v1/gaspar/risques?{query}")
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError) as exc:
        return {
            "service": "Géorisques",
            "source": "https://georisques.gouv.fr/api/v1/gaspar/risques",
            "communes": [{"code_insee": code, "risks": [], "risk_total": 0, "danger_level": "Faible", "errors": [str(exc)]} for code in normalized_codes],
            "error": str(exc),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }

    content = payload.get("data") or payload.get("content") or payload.get("items") or []
    by_commune = {code: [] for code in normalized_codes}

    for item in content:
        communes = item.get("communes") if isinstance(item, dict) else None
        risk_name = str(item.get("libelle_risque") or item.get("libelle") or item.get("risque") or "Risque non précisé").strip()
        if communes:
            for commune in communes:
                code = str(commune.get("code_insee") or commune.get("codeInsee") or "").strip()
                if code in by_commune and risk_name:
                    by_commune[code].append(risk_name)
            continue
        code = str(item.get("code_insee") or item.get("codeInsee") or "").strip()
        if code in by_commune and risk_name:
            by_commune[code].append(risk_name)

    communes_payload = []
    for code in normalized_codes:
        risks = sorted({risk for risk in by_commune.get(code, []) if risk})
        communes_payload.append({
            "code_insee": code,
            "risks": risks,
            "risk_total": len(risks),
            "danger_level": _georisques_danger_label(len(risks)),
        })

    return {
        "service": "Géorisques",
        "source": "https://www.georisques.gouv.fr/api/v1/gaspar/risques",
        "communes": communes_payload,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def _fetch_georisques_isere_summary_live(commune_names: list[str] | None = None) -> dict[str, Any]:
    source = "https://georisques.gouv.fr/api/v2"
    if not settings.georisques_api_token.strip():
        return {
            "service": "Géorisques",
            "status": "degraded",
            "source": source,
            "api_mode": "v2-token-required",
            "department": "Isère (38)",
            "highest_seismic_zone_code": 0,
            "highest_seismic_zone_label": "inconnue",
            "flood_documents_total": 0,
            "ppr_total": 0,
            "ground_movements_total": 0,
            "cavities_total": 0,
            "communes_with_radon_moderate_or_high": 0,
            "movement_types": {},
            "movement_reliability": {},
            "cavity_types": {},
            "ppr_categories": {"pprn": 0, "pprm": 0, "pprt": 0},
            "dicrim_total": 0,
            "tim_total": 0,
            "risques_information_total": 0,
            "seismic_zone_distribution": {},
            "radon_distribution": {"faible": 0, "moyen": 0, "eleve": 0},
            "recent_ground_movements": [],
            "monitored_communes": [],
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "errors": ["Clé API Géorisques v2 absente"],
            "error": "Clé API Géorisques v2 absente",
        }

    monitored_names = commune_names or ["Grenoble", "Bourgoin-Jallieu", "Vienne", "Voiron"]
    monitored_codes = _resolve_commune_insee_codes(monitored_names)
    if not monitored_codes:
        return {
            "service": "Géorisques",
            "status": "degraded",
            "source": source,
            "api_mode": "v2-token",
            "department": "Isère (38)",
            "highest_seismic_zone_code": 0,
            "highest_seismic_zone_label": "inconnue",
            "flood_documents_total": 0,
            "ppr_total": 0,
            "ground_movements_total": 0,
            "cavities_total": 0,
            "communes_with_radon_moderate_or_high": 0,
            "movement_types": {},
            "movement_reliability": {},
            "cavity_types": {},
            "ppr_categories": {"pprn": 0, "pprm": 0, "pprt": 0},
            "dicrim_total": 0,
            "tim_total": 0,
            "risques_information_total": 0,
            "seismic_zone_distribution": {},
            "radon_distribution": {"faible": 0, "moyen": 0, "eleve": 0},
            "recent_ground_movements": [],
            "monitored_communes": [],
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "errors": ["Aucun code INSEE trouvé pour les communes PCS"],
            "error": "Aucun code INSEE trouvé pour les communes PCS",
        }

    filters = {"codesInsee": sorted(monitored_codes.keys())}
    radon_labels = {"1": "Faible", "2": "Moyen", "3": "Élevé"}

    try:
        mvt_payload = _fetch_georisques_v2_collection("mvt", extra_query=filters)
        cavites_payload = _fetch_georisques_v2_collection("cavites", extra_query=filters)
        radon_payload = _fetch_georisques_v2_collection("radon", extra_query=filters)
        azi_payload = _fetch_georisques_v2_collection("gaspar/azi", extra_query=filters)
        pprn_payload = _fetch_georisques_v2_collection("gaspar/pprn", extra_query=filters)
        pprm_payload = _fetch_georisques_v2_collection("gaspar/pprm", extra_query=filters)
        pprt_payload = _fetch_georisques_v2_collection("gaspar/pprt", extra_query=filters)
        dicrim_payload = _fetch_georisques_v2_collection("gaspar/dicrim", extra_query=filters)
        tim_payload = _fetch_georisques_v2_collection("gaspar/tim", extra_query=filters)
        risques_payload = _fetch_georisques_v2_collection("gaspar/risques", extra_query=filters)
        zonage_payload = _fetch_georisques_v2_collection("zonage_sismique", extra_query=filters)
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError) as exc:
        return {
            "service": "Géorisques",
            "status": "degraded",
            "source": source,
            "api_mode": "v2-token",
            "department": "Isère (38)",
            "highest_seismic_zone_code": 0,
            "highest_seismic_zone_label": "inconnue",
            "flood_documents_total": 0,
            "ppr_total": 0,
            "ground_movements_total": 0,
            "cavities_total": 0,
            "communes_with_radon_moderate_or_high": 0,
            "movement_types": {},
            "movement_reliability": {},
            "cavity_types": {},
            "ppr_categories": {"pprn": 0, "pprm": 0, "pprt": 0},
            "dicrim_total": 0,
            "tim_total": 0,
            "risques_information_total": 0,
            "seismic_zone_distribution": {},
            "radon_distribution": {"faible": 0, "moyen": 0, "eleve": 0},
            "recent_ground_movements": [],
            "monitored_communes": [],
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "errors": [f"API Géorisques v2 indisponible: {exc}"],
            "error": f"API Géorisques v2 indisponible: {exc}",
        }

    movements = mvt_payload["content"]
    movement_types: dict[str, int] = {}
    movement_reliability: dict[str, int] = {}
    recent_movements: list[dict[str, Any]] = []
    for item in movements:
        movement_type = str(item.get("type") or "Type non renseigné").strip()
        movement_types[movement_type] = movement_types.get(movement_type, 0) + 1
        reliability = str(item.get("fiabilite") or "Non précisée").strip()
        movement_reliability[reliability] = movement_reliability.get(reliability, 0) + 1
        recent_movements.append(
            {
                "commune": monitored_codes.get(str(item.get("codeInsee") or ""), item.get("codeInsee") or "Commune inconnue"),
                "type": movement_type,
                "date": item.get("dateDebut") or item.get("dateMaj"),
                "location": item.get("lieu") or item.get("commentaireLieu"),
                "identifier": item.get("identifiant"),
                "reliability": item.get("fiabilite"),
            }
        )

    cavities = cavites_payload["content"]
    cavity_types: dict[str, int] = {}
    for item in cavities:
        cavity_type = str(item.get("type") or "Non renseigné").strip()
        cavity_types[cavity_type] = cavity_types.get(cavity_type, 0) + 1

    radon_entries = radon_payload["content"]
    radon_distribution = {"1": 0, "2": 0, "3": 0}
    radon_by_commune: dict[str, str] = {}
    for item in radon_entries:
        code = str(item.get("codeInsee") or "")
        classe = str(item.get("classePotentiel") or "")
        if classe in radon_distribution:
            radon_distribution[classe] += 1
        if code:
            radon_by_commune[code] = classe

    flood_documents_total = azi_payload["total_elements"]

    zonage_entries = zonage_payload["content"]
    seismic_zone_distribution: dict[str, int] = {}
    highest_seismic_zone_code = 0
    for item in zonage_entries:
        zone_label = str(item.get("zoneSismicite") or item.get("typeZone") or "inconnue").strip()
        seismic_zone_distribution[zone_label] = seismic_zone_distribution.get(zone_label, 0) + 1
        zone_match = re.search(r"(\d+)", zone_label)
        if zone_match:
            highest_seismic_zone_code = max(highest_seismic_zone_code, int(zone_match.group(1)))

    ppr_total = pprn_payload["total_elements"] + pprm_payload["total_elements"] + pprt_payload["total_elements"]
    ppr_categories = {
        "pprn": pprn_payload["total_elements"],
        "pprm": pprm_payload["total_elements"],
        "pprt": pprt_payload["total_elements"],
    }

    tim_by_commune: dict[str, int] = {}
    for item in tim_payload["content"]:
        for commune in item.get("communes") or []:
            code = str(commune.get("codeInsee") or "")
            if code:
                tim_by_commune[code] = tim_by_commune.get(code, 0) + 1

    risques_by_commune: dict[str, int] = {}
    for item in risques_payload["content"]:
        for commune in item.get("communes") or []:
            code = str(commune.get("codeInsee") or "")
            if code:
                risques_by_commune[code] = risques_by_commune.get(code, 0) + 1

    dicrim_by_commune: dict[str, str] = {}
    for item in dicrim_payload["content"]:
        code = str(item.get("codeInsee") or "")
        if not code:
            continue
        year = str(item.get("anneePublication") or "").strip()
        if year:
            best = dicrim_by_commune.get(code)
            if not best or year > best:
                dicrim_by_commune[code] = year

    monitored_flood_documents = {code: [] for code in monitored_codes}
    for doc in azi_payload["content"]:
        for commune in doc.get("communes") or []:
            code = str(commune.get("codeInsee") or "")
            if code not in monitored_flood_documents:
                continue
            monitored_flood_documents[code].append(
                {
                    "code": doc.get("idGaspar"),
                    "title": doc.get("libelle"),
                    "river_basin": doc.get("libBassinRisques"),
                    "published_at": (commune.get("aleas") or [{}])[0].get("dateDiffusion"),
                }
            )

    zone_by_commune = {
        str(item.get("codeInsee") or ""): str(item.get("zoneSismicite") or "inconnue")
        for item in zonage_entries
        if item.get("codeInsee")
    }

    monitored = []
    for code, name in monitored_codes.items():
        radon_class = radon_by_commune.get(code, "")
        docs = monitored_flood_documents.get(code) or []
        zone_label = zone_by_commune.get(code, "inconnue")
        monitored.append(
            {
                "name": name,
                "code_insee": code,
                "seismic_zone": zone_label,
                "flood_documents": len(docs),
                "flood_documents_details": docs,
                "ppr_total": sum(
                    1
                    for dataset in (pprn_payload["content"], pprm_payload["content"], pprt_payload["content"])
                    for item in dataset
                    if any(str(commune.get("codeInsee") or "") == code for commune in item.get("communes") or [])
                ),
                "ppr_by_risk": {
                    "pprn": sum(
                        1
                        for item in pprn_payload["content"]
                        if any(str(commune.get("codeInsee") or "") == code for commune in item.get("communes") or [])
                    ),
                    "pprm": sum(
                        1
                        for item in pprm_payload["content"]
                        if any(str(commune.get("codeInsee") or "") == code for commune in item.get("communes") or [])
                    ),
                    "pprt": sum(
                        1
                        for item in pprt_payload["content"]
                        if any(str(commune.get("codeInsee") or "") == code for commune in item.get("communes") or [])
                    ),
                },
                "ground_movements_total": sum(1 for item in movements if str(item.get("codeInsee") or "") == code),
                "cavities_total": sum(1 for item in cavities if str(item.get("codeInsee") or "") == code),
                "radon_class": radon_class,
                "radon_label": radon_labels.get(radon_class, "inconnu"),
                "dicrim_publication_year": dicrim_by_commune.get(code),
                "tim_total": tim_by_commune.get(code, 0),
                "risques_information_total": risques_by_commune.get(code, 0),
                "gaspar_risks": [],
                "gaspar_risk_total": 0,
                "gaspar_danger_level": "Faible",
                "errors": [],
            }
        )

    gaspar_payload = fetch_georisques_commune_risks(list(monitored_codes.keys()))
    gaspar_by_code = {item.get("code_insee"): item for item in gaspar_payload.get("communes") or []}
    for commune in monitored:
        details = gaspar_by_code.get(commune.get("code_insee")) or {}
        commune["gaspar_risks"] = details.get("risks", [])
        commune["gaspar_risk_total"] = details.get("risk_total", 0)
        commune["gaspar_danger_level"] = details.get("danger_level", "Faible")

    return {
        "service": "Géorisques",
        "status": "online",
        "source": source,
        "api_mode": "v2-token",
        "department": "Isère (38)",
        "highest_seismic_zone_code": highest_seismic_zone_code,
        "highest_seismic_zone_label": f"Zone {highest_seismic_zone_code}" if highest_seismic_zone_code else "inconnue",
        "flood_documents_total": flood_documents_total,
        "ppr_total": ppr_total,
        "ground_movements_total": mvt_payload["total_elements"],
        "cavities_total": cavites_payload["total_elements"],
        "communes_with_radon_moderate_or_high": radon_distribution["2"] + radon_distribution["3"],
        "movement_types": movement_types,
        "movement_reliability": movement_reliability,
        "cavity_types": cavity_types,
        "ppr_categories": ppr_categories,
        "dicrim_total": dicrim_payload["total_elements"],
        "tim_total": tim_payload["total_elements"],
        "risques_information_total": risques_payload["total_elements"],
        "seismic_zone_distribution": seismic_zone_distribution,
        "radon_distribution": {
            "faible": radon_distribution["1"],
            "moyen": radon_distribution["2"],
            "eleve": radon_distribution["3"],
        },
        "recent_ground_movements": sorted(recent_movements, key=lambda item: item.get("date") or "", reverse=True)[:12],
        "monitored_communes": monitored,
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "errors": [],
        "error": None,
    }


def fetch_georisques_isere_summary(force_refresh: bool = False, commune_names: list[str] | None = None) -> dict[str, Any]:
    if commune_names:
        return _fetch_georisques_isere_summary_live(commune_names=commune_names)
    return _cached_external_payload(
        cache=_georisques_cache,
        lock=_georisques_cache_lock,
        ttl_seconds=_GEORISQUES_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_georisques_isere_summary_live(commune_names=commune_names),
    )


def vigicrues_geojson_from_stations(stations: list[dict[str, Any]]) -> dict[str, Any]:
    features = []
    for station in stations:
        if station.get("lat") is None or station.get("lon") is None:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [station["lon"], station["lat"]],
                },
                "properties": {
                    "code": station.get("code"),
                    "station": station.get("station"),
                    "river": station.get("river"),
                    "level": station.get("level"),
                    "height_m": station.get("height_m"),
                    "control_status": station.get("control_status", "inconnu"),
                    "is_priority": station.get("is_priority", False),
                    "observed_at": station.get("observed_at"),
                },
            }
        )

    return {
        "type": "FeatureCollection",
        "features": features,
        "source": "https://www.vigicrues.gouv.fr",
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }
