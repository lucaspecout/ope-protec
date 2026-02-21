from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from copy import deepcopy
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
_WAZE_CACHE_TTL_SECONDS = 120
_GEORISQUES_CACHE_TTL_SECONDS = 900
_PREFECTURE_CACHE_TTL_SECONDS = 600
_VIGIEAU_CACHE_TTL_SECONDS = 900
_ATMO_AURA_CACHE_TTL_SECONDS = 900
_SNCF_ISERE_CACHE_TTL_SECONDS = 180

_vigicrues_cache_lock = Lock()
_vigicrues_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_itinisere_cache_lock = Lock()
_itinisere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_bison_cache_lock = Lock()
_bison_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_waze_cache_lock = Lock()
_waze_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_georisques_cache_lock = Lock()
_georisques_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_prefecture_cache_lock = Lock()
_prefecture_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_vigieau_cache_lock = Lock()
_vigieau_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_atmo_aura_cache_lock = Lock()
_atmo_aura_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_sncf_isere_cache_lock = Lock()
_sncf_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}


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
        warning_tomorrow = _meteo_france_wsft_get(
            "warning/currentphenomenons",
            token,
            {"domain": "38", "warning_type": "vigilance", "formatDate": "timestamp", "echeance": "J1", "depth": 1},
        )
        bulletin_today = _meteo_france_wsft_get(
            "report",
            token,
            {"domain": "38", "report_type": "vigilanceV6", "report_subtype": "Bulletin de suivi", "echeance": "J0"},
            version="v2",
        )
        bulletin_tomorrow = _meteo_france_wsft_get(
            "report",
            token,
            {"domain": "38", "report_type": "vigilanceV6", "report_subtype": "Bulletin de suivi", "echeance": "J1"},
            version="v2",
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
        focused_codes = [code for code in fallback_isere_codes if code]
        remaining_codes = [code for code in fallback_isere_codes if code]

        target_isere_count = max(station_limit or 0, len(focus_station_filters), len(remaining_codes))
        max_lookups = max(220, target_isere_count * 12)
        if sample_size > 0:
            max_lookups = min(max_lookups, sample_size)

        candidate_codes = (focused_codes + remaining_codes + list(fallback_isere_codes))[:max_lookups]
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

        target_isere_count = station_limit if station_limit is not None else len(unique_candidate_codes)
        worker_count = min(10, max(4, min(max(target_isere_count, 1), 24)))
        executor = ThreadPoolExecutor(max_workers=worker_count)
        force_include_codes = set(focused_codes)
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

        troncons = list(troncons_index.values())

        isere_stations.sort(key=lambda station: (not station["is_priority"], station["station"] or ""))
        troncons.sort(key=lambda troncon: troncon.get("name") or "")

        if station_limit is not None:
            isere_stations = isere_stations[:station_limit]

        levels = [s["level"] for s in isere_stations]
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


def _itinisere_is_road_closure_pass_or_camera_event(title: str, description: str, category: str) -> bool:
    text = f"{title} {description}".lower()
    closure_tokens = ("fermet", "route coup", "interdit", "barr", "réouvert", "reouvert", "ouvert")
    pass_tokens = ("col ", "cols ", "col du", "col de", "col des")
    camera_tokens = ("caméra", "camera", "webcam", "vidéo", "video")

    has_closure_signal = category == "fermeture" or any(token in text for token in closure_tokens)
    has_pass_signal = any(token in text for token in pass_tokens)
    has_camera_signal = any(token in text for token in camera_tokens)
    return has_closure_signal or has_pass_signal or has_camera_signal


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
            if not _itinisere_is_road_closure_pass_or_camera_event(final_title, final_description, category):
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


def _fetch_waze_isere_traffic_live() -> dict[str, Any]:
    source = "https://www.waze.com/live-map/api/georss"
    params = {
        "top": 46.05,
        "bottom": 44.55,
        "left": 4.1,
        "right": 6.9,
        "env": "row",
        "types": "alerts,traffic",
    }
    try:
        url = f"{source}?{urlencode(params)}"
        payload = _http_get_json(url, timeout=12)
        alerts = payload.get("alerts") or []
        jams = payload.get("jams") or payload.get("traffic") or []

        incidents: list[dict[str, Any]] = []
        incident_keys: set[tuple[Any, ...]] = set()
        for alert in alerts[:250]:
            subtype = str(alert.get("subtype") or alert.get("type") or "incident").lower()
            if subtype in {"jam", "road_closed"}:
                severity = "rouge" if subtype == "road_closed" else "orange"
            else:
                severity = "jaune"
            incident = {
                "kind": "alert",
                "title": alert.get("title") or alert.get("street") or "Signalement trafic",
                "description": alert.get("reportDescription") or alert.get("description") or "",
                "subtype": subtype,
                "severity": severity,
                "lat": alert.get("location", {}).get("y"),
                "lon": alert.get("location", {}).get("x"),
                "reliability": alert.get("reliability"),
            }
            key = (
                incident["kind"],
                incident.get("subtype"),
                incident.get("title"),
                incident.get("lat"),
                incident.get("lon"),
                incident.get("description"),
            )
            if key in incident_keys:
                continue
            incident_keys.add(key)
            incidents.append(incident)

        for jam in jams[:250]:
            line = jam.get("line") or []
            if not line:
                continue
            first = line[0]
            speed = float(jam.get("speed") or 0)
            delay = float(jam.get("delay") or 0)
            if delay >= 900 or speed < 12:
                severity = "rouge"
            elif delay >= 420 or speed < 25:
                severity = "orange"
            else:
                severity = "jaune"
            incident = {
                "kind": "jam",
                "title": jam.get("street") or "Ralentissement",
                "description": f"Vitesse {int(speed)} km/h · retard {int(delay // 60)} min",
                "severity": severity,
                "lat": first.get("y"),
                "lon": first.get("x"),
                "line": [{"lat": point.get("y"), "lon": point.get("x")} for point in line[:80]],
                "length": jam.get("length"),
            }
            key = (
                incident["kind"],
                incident.get("title"),
                incident.get("lat"),
                incident.get("lon"),
                incident.get("description"),
            )
            if key in incident_keys:
                continue
            incident_keys.add(key)
            incidents.append(incident)

        return {
            "service": "Waze",
            "status": "online",
            "source": source,
            "incidents": incidents,
            "incidents_total": len(incidents),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError) as exc:
        return {
            "service": "Waze",
            "status": "degraded",
            "source": source,
            "incidents": [],
            "incidents_total": 0,
            "error": str(exc),
        }


def fetch_itinisere_disruptions(limit: int = 60, force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_itinisere_cache,
        lock=_itinisere_cache_lock,
        ttl_seconds=_ITINISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_itinisere_disruptions_live(limit=limit),
    )


def _sncf_isere_alert_type(text: str) -> str:
    lowered = (text or "").lower()
    if any(token in lowered for token in ("accident", "collision", "heurt", "obstacle")):
        return "accident"
    if any(token in lowered for token in ("travaux", "chantier", "maintenance", "voie")):
        return "travaux"
    return "autre"


def _fetch_sncf_isere_alerts_live(limit: int = 25) -> dict[str, Any]:
    source = "https://www.itinisere.fr/fr/rss/Disruptions"
    base_payload = _fetch_itinisere_disruptions_live(limit=80)
    if base_payload.get("status") not in {"online", "partial"}:
        return {
            "service": "SNCF Isère",
            "status": "degraded",
            "source": source,
            "alerts": [],
            "alerts_total": 0,
            "error": base_payload.get("error") or "Flux indisponible",
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }

    alerts: list[dict[str, Any]] = []
    for event in base_payload.get("events") or []:
        title = str(event.get("title") or "")
        description = str(event.get("description") or "")
        text = f"{title} {description}".lower()
        if not any(token in text for token in ("sncf", "ter", "train", "ferroviaire", "gare")):
            continue
        alert_type = _sncf_isere_alert_type(text)
        if alert_type not in {"accident", "travaux"}:
            continue
        alerts.append(
            {
                "title": title or "Alerte SNCF",
                "description": description[:400],
                "type": alert_type,
                "severity": event.get("severity") or "jaune",
                "locations": event.get("locations") or [],
                "roads": event.get("roads") or [],
                "link": event.get("link") or source,
                "published_at": event.get("published_at") or "",
            }
        )

    return {
        "service": "SNCF Isère",
        "status": "online",
        "source": source,
        "alerts": alerts[:limit],
        "alerts_total": len(alerts),
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_sncf_isere_alerts(limit: int = 25, force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_sncf_isere_cache,
        lock=_sncf_isere_cache_lock,
        ttl_seconds=_SNCF_ISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_sncf_isere_alerts_live(limit=limit),
    )


def _strip_html_tags(value: str) -> str:
    return re.sub(r"<[^>]+>", " ", value or "")


def _extract_html_title(value: str) -> str:
    if not value:
        return ""

    patterns = (
        r"<title[^>]*>(?P<content>.*?)</title>",
        r"<h1[^>]*>(?P<content>.*?)</h1>",
        r'<meta[^>]+property=(["\'])og:title\1[^>]+content=(["\'])(?P<content>.*?)\2',
        r'<meta[^>]+content=(["\'])(?P<content>.*?)\1[^>]+property=(["\'])og:title\3',
    )
    for pattern in patterns:
        match = re.search(pattern, value, flags=re.IGNORECASE | re.DOTALL)
        if not match:
            continue
        candidate = unescape(re.sub(r"\s+", " ", _strip_html_tags(match.group("content")))).strip()
        if candidate:
            cleaned = re.sub(r"\s*[\|\-–]\s*isere\.gouv\.fr$", "", candidate, flags=re.IGNORECASE).strip()
            if "Les services de l'État en Isère" in cleaned and " - " in cleaned:
                cleaned = cleaned.split(" - ", 1)[0].strip()
            return cleaned

    return ""


def _title_from_link_slug(link: str) -> str:
    path = urlparse(link or "").path.rstrip("/")
    slug = path.split("/")[-1] if path else ""
    if not slug:
        return ""
    return unescape(unquote(slug)).replace("-", " ").strip()


def _resolve_prefecture_news_title(title: str, link: str) -> str:
    cleaned_title = (title or "").strip()
    if cleaned_title:
        return unescape(cleaned_title)

    try:
        article_html = _http_get_text(link, timeout=10)
        extracted_title = _extract_html_title(article_html)
        if extracted_title:
            return extracted_title
    except (HTTPError, URLError, TimeoutError, ValueError):
        pass

    slug_title = _title_from_link_slug(link)
    if slug_title:
        return slug_title
    return "Actualité Préfecture"


def _parse_prefecture_published_date(value: str) -> datetime:
    raw = (value or "").strip()
    if not raw:
        return datetime.min

    normalized = re.sub(r"\s*\([^)]*\)$", "", raw)
    parsed_formats = (
        "%a, %d %b %Y %H:%M:%S %z",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    )
    for fmt in parsed_formats:
        try:
            parsed = datetime.strptime(normalized, fmt)
            return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed
        except ValueError:
            continue

    try:
        parsed_iso = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        return parsed_iso.replace(tzinfo=None) if parsed_iso.tzinfo else parsed_iso
    except ValueError:
        return datetime.min


def _fetch_prefecture_isere_news_live(limit: int = 6) -> dict[str, Any]:
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


def fetch_prefecture_isere_news(limit: int = 6, force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_prefecture_cache,
        lock=_prefecture_cache_lock,
        ttl_seconds=_PREFECTURE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_prefecture_isere_news_live(limit=limit),
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


def fetch_waze_isere_traffic(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_waze_cache,
        lock=_waze_cache_lock,
        ttl_seconds=_WAZE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_waze_isere_traffic_live,
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
