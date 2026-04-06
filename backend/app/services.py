from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
from datetime import datetime, timedelta
from copy import deepcopy
import io
from email.utils import parsedate_to_datetime
from html import unescape
from http.client import RemoteDisconnected
import json
from pathlib import Path
import re
import unicodedata
from random import uniform
from time import sleep
from threading import Lock
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus, unquote, urlencode, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
import zipfile

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
    grenoble_weather = _fetch_grenoble_weather_snapshot()

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
    c.drawString(40, y, "Météo Grenoble (actuelle + heure par heure)")
    y -= 12
    c.setFont("Helvetica", 9)
    weather_current = grenoble_weather.get("current") or "Données indisponibles"
    c.drawString(44, y, weather_current)
    y -= 14
    for line in grenoble_weather.get("hourly_lines") or ["Prévision horaire indisponible"]:
        c.drawString(50, y, f"• {line}")
        y -= 12

    y -= 8
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


def _http_get_with_retries(request: Request, timeout: int = 8, retries: int = 1, retry_delay_seconds: float = 0.5) -> bytes:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.read()
        except (HTTPError, URLError, TimeoutError, RemoteDisconnected) as exc:
            last_error = exc
            if attempt >= retries or not _is_retryable_network_error(exc):
                raise
            backoff = retry_delay_seconds * (2 ** attempt)
            sleep(backoff + uniform(0, 0.35))
    raise last_error or RuntimeError("Échec HTTP inattendu")


def _http_get_json(url: str, timeout: int = 12, headers: dict[str, str] | None = None) -> Any:
    request_headers = {"User-Agent": "ope-protec/1.0", "Connection": "keep-alive"}
    if headers:
        request_headers.update(headers)
    request = Request(url, headers=request_headers)
    payload = _http_get_with_retries(request=request, timeout=timeout)
    return json.loads(payload.decode("utf-8"))


def _http_get_text(url: str, timeout: int = 12) -> str:
    request = Request(url, headers={"User-Agent": "ope-protec/1.0", "Connection": "keep-alive"})
    payload = _http_get_with_retries(request=request, timeout=timeout)
    return payload.decode("utf-8", errors="ignore")


def _extract_html_title(raw_html: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", raw_html or "", flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return ""
    title = _strip_html_tags(match.group(1))
    return re.sub(r"\s+", " ", title).strip()


def _format_meteo_temperature(value: Any) -> str:
    if value is None:
        return "--"
    try:
        return f"{round(float(value))}°C"
    except (TypeError, ValueError):
        return "--"


def _map_open_meteo_weather_code(code: Any) -> str:
    labels = {
        0: "ciel clair",
        1: "peu nuageux",
        2: "partiellement nuageux",
        3: "couvert",
        45: "brouillard",
        48: "brouillard givrant",
        51: "bruine légère",
        53: "bruine",
        55: "bruine forte",
        61: "pluie faible",
        63: "pluie",
        65: "pluie forte",
        66: "pluie verglaçante",
        67: "pluie verglaçante forte",
        71: "neige faible",
        73: "neige",
        75: "neige forte",
        77: "grains de neige",
        80: "averses faibles",
        81: "averses",
        82: "averses fortes",
        85: "averses de neige",
        86: "fortes averses de neige",
        95: "orage",
        96: "orage avec grêle",
        99: "orage violent",
    }
    try:
        return labels.get(int(code), "conditions variables")
    except (TypeError, ValueError):
        return "conditions variables"


def _fetch_grenoble_weather_snapshot() -> dict[str, Any]:
    api_url = (
        "https://api.open-meteo.com/v1/forecast"
        "?latitude=45.1885&longitude=5.7245"
        "&current=temperature_2m,weather_code"
        "&hourly=temperature_2m,weather_code"
        "&forecast_days=1&timezone=Europe%2FParis"
    )
    try:
        payload = _http_get_json(api_url, timeout=12)
        current = payload.get("current") or {}
        hourly = payload.get("hourly") or {}
        hourly_times = hourly.get("time") or []
        hourly_temps = hourly.get("temperature_2m") or []
        hourly_codes = hourly.get("weather_code") or []

        current_text = (
            f"Maintenant: {_format_meteo_temperature(current.get('temperature_2m'))} · "
            f"{_map_open_meteo_weather_code(current.get('weather_code'))}"
        )

        hourly_lines: list[str] = []
        for when, temp, code in list(zip(hourly_times, hourly_temps, hourly_codes))[:8]:
            label_hour = when[11:16] if len(when) >= 16 else when
            hourly_lines.append(f"{label_hour}: {_format_meteo_temperature(temp)} · {_map_open_meteo_weather_code(code)}")

        return {
            "current": current_text,
            "hourly_lines": hourly_lines,
        }
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError, KeyError):
        return {
            "current": "Maintenant: indisponible",
            "hourly_lines": ["Prévision horaire indisponible"],
        }


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
_FINESS_ISERE_MAX_LIMIT = 20000
_FINESS_ISERE_STABLE_CSV_URL = "https://static.data.gouv.fr/resources/finess-extraction-du-fichier-des-etablissements/20260312-094547/etalab-cs1100507-stock-20260311-0343.csv"
_ISERE_OPENDATA_CACHE_TTL_SECONDS = 1800
_ANFR_ISERE_CACHE_TTL_SECONDS = 43200
_ARCEP_ISERE_CACHE_TTL_SECONDS = 900
_HUBEAU_GROUNDWATER_CACHE_TTL_SECONDS = 10800
_AVALANCHE_ISERE_CACHE_TTL_SECONDS = 3600
_APIC_ISERE_CACHE_TTL_SECONDS = 300
_VIGICRUES_FLASH_ISERE_CACHE_TTL_SECONDS = 300
_ISERE_BOUNDARY_CACHE_TTL_SECONDS = 21600
_AURA_AIRCRAFT_CACHE_TTL_SECONDS = 45

_vigicrues_cache_lock = Lock()
_vigicrues_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_itinisere_cache_lock = Lock()
_itinisere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_bison_cache_lock = Lock()
_bison_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_isere_boundary_cache_lock = Lock()
_isere_boundary_cache: dict[str, Any] = {"geometry": None, "expires_at": datetime.min}
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
_finess_isere_communes_lock = Lock()
_finess_isere_communes_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}


_institutions_isere_cache_lock = Lock()
_institutions_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_INSTITUTIONS_ISERE_CACHE_TTL_SECONDS = 86400  # 24h

_INSTITUTIONS_ISERE_BBOX = "44.70,4.70,45.95,6.60"

# Requête Overpass bbox — infra critique sécurité/secours/éducation/transport
_INSTITUTIONS_CRITICAL_QUERY = f"""[out:json][timeout:90];
(
  nwr["amenity"="school"]({_INSTITUTIONS_ISERE_BBOX});
  nwr["amenity"="college"]({_INSTITUTIONS_ISERE_BBOX});
  nwr["amenity"="university"]({_INSTITUTIONS_ISERE_BBOX});
  nwr["amenity"="kindergarten"]({_INSTITUTIONS_ISERE_BBOX});
  nwr["amenity"="police"]({_INSTITUTIONS_ISERE_BBOX});
  nwr["amenity"="fire_station"]({_INSTITUTIONS_ISERE_BBOX});
  nwr["amenity"="bus_station"]({_INSTITUTIONS_ISERE_BBOX});
  nwr["railway"="station"]({_INSTITUTIONS_ISERE_BBOX});
  nwr["aeroway"~"aerodrome|airport"]({_INSTITUTIONS_ISERE_BBOX});
);
out center tags;"""

# Requête Overpass bbox — équipements hébergement/accueil
_INSTITUTIONS_FACILITIES_QUERY = f"""[out:json][timeout:90];
(
  nwr["amenity"~"community_centre|arts_centre|theatre|cinema|concert_hall|events_venue|convention_centre|social_facility"]({_INSTITUTIONS_ISERE_BBOX});
  nwr["leisure"~"sports_hall|sports_centre|stadium|ice_rink"]({_INSTITUTIONS_ISERE_BBOX});
  nwr["building"~"sports_hall|stadium|civic|gymnasium"]({_INSTITUTIONS_ISERE_BBOX});
);
out center tags;"""


def _classify_institution_osm(tags: dict) -> str | None:
    amenity = str(tags.get("amenity") or "").lower()
    leisure = str(tags.get("leisure") or "").lower()
    building = str(tags.get("building") or "").lower()
    name = str(tags.get("name") or "").lower()
    railway = str(tags.get("railway") or "").lower()
    aeroway = str(tags.get("aeroway") or "").lower()
    police_type = str(tags.get("police") or "").lower()

    if amenity == "kindergarten":
        return "creche"
    if amenity == "university":
        return "universite"
    if amenity == "college":
        return "college"
    if amenity == "school":
        if "lyc" in name:
            return "lycee"
        if "coll" in name:
            return "college"
        return "ecole_primaire"
    if amenity == "fire_station":
        return "caserne_pompier"
    if amenity == "police":
        if "gendarmerie" in name or "gendarmerie" in police_type:
            return "gendarmerie"
        if "municipal" in name or "municipal" in police_type:
            return "police_municipale"
        return "commissariat_police_nationale"
    if amenity == "bus_station":
        return "transport_gare_routiere"
    if railway == "station":
        return "transport_gare_sncf"
    if aeroway in ("aerodrome", "airport"):
        return "transport_aeroport"
    if amenity in ("theatre", "cinema", "music_venue", "concert_hall", "events_venue"):
        return "salle_spectacle_public"
    if amenity == "convention_centre":
        return "palais_congres"
    if leisure in ("sports_hall", "sports_centre") or building in ("sports_hall", "gymnasium"):
        return "gymnase"
    if leisure == "stadium" or building == "stadium":
        return "stade"
    if amenity in ("community_centre", "arts_centre", "social_facility"):
        if any(token in name for token in ("foyer", "polyvalent", "fête", "fete", "salle")):
            return "salle_fetes"
        return "centre_culturel"
    return None


def _overpass_fetch_institutions(query: str) -> list[dict]:
    endpoints = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
    ]
    for endpoint in endpoints:
        try:
            req = Request(endpoint, data=query.encode("utf-8"), headers={"Content-Type": "text/plain;charset=UTF-8"}, method="POST")
            with urlopen(req, timeout=95) as resp:
                import json as _json
                data = _json.loads(resp.read().decode("utf-8"))
            elements = data.get("elements") or []
            if elements:
                return elements
        except Exception:
            continue
    return []


def _fetch_institutions_isere_live() -> dict[str, Any]:
    import json as _json
    from concurrent.futures import ThreadPoolExecutor, as_completed as _as_completed

    with ThreadPoolExecutor(max_workers=2) as executor:
        fut_critical = executor.submit(_overpass_fetch_institutions, _INSTITUTIONS_CRITICAL_QUERY)
        fut_facilities = executor.submit(_overpass_fetch_institutions, _INSTITUTIONS_FACILITIES_QUERY)
        critical_elements = fut_critical.result()
        facility_elements = fut_facilities.result()

    all_elements = critical_elements + facility_elements
    seen_ids: set[str] = set()
    points: list[dict[str, Any]] = []

    for element in all_elements:
        tags = element.get("tags") or {}
        osm_type = element.get("type", "node")
        osm_id = element.get("id", 0)
        uid = f"osm-{osm_type}-{osm_id}"
        if uid in seen_ids:
            continue
        seen_ids.add(uid)

        resource_type = _classify_institution_osm(tags)
        if not resource_type:
            continue

        lat = element.get("lat") or (element.get("center") or {}).get("lat")
        lon = element.get("lon") or (element.get("center") or {}).get("lon")
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            continue
        if not (44.65 <= lat <= 46.05 and 4.65 <= lon <= 6.65):
            continue

        name = str(tags.get("name") or "").strip() or "Établissement"
        address_parts = [tags.get("addr:housenumber"), tags.get("addr:street"), tags.get("addr:city")]
        address = " ".join(p for p in address_parts if p) or "Adresse non renseignée"
        amenity_tag = str(tags.get("amenity") or tags.get("leisure") or tags.get("railway") or tags.get("aeroway") or "-")
        priority = "vital" if resource_type in {
            "caserne_pompier", "gendarmerie", "commissariat_police_nationale",
            "transport_gare_sncf", "transport_aeroport",
        } else "standard"

        points.append({
            "id": uid,
            "name": name,
            "type": resource_type,
            "lat": lat,
            "lon": lon,
            "active": True,
            "address": address,
            "priority": priority,
            "info": f"Source OSM · {amenity_tag}",
            "source": f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
            "dynamic": True,
        })

    return {
        "status": "online" if points else "empty",
        "count": len(points),
        "points": points,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_institutions_isere(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_institutions_isere_cache,
        lock=_institutions_isere_cache_lock,
        ttl_seconds=_INSTITUTIONS_ISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_institutions_isere_live,
    )


_FINESS_STRATEGIC_LABEL_KEYWORDS: tuple[str, ...] = (
    "chu",
    "centre hospitalier",
    "hopital",
    "hôpital",
    "clinique",
    "urgence",
    "samu",
    "smur",
    "dialyse",
    "maternite",
    "maternité",
    "reanimation",
    "réanimation",
    "caisson hyperbare",
    "laboratoire",
    "lits halte soins sante",
    "lhss",
    "lits d accueil medicalises",
    "lam",
    "ehpad",
    "ssiad",
    "maison medicale de garde",
    "mmg",
    "centre de sante",
    "centre de vaccination",
    "centre gratuit d information, de depistage et de diagnostic",
    "cegidd",
    "centre de lutte antituberculeuse",
    "clat",
    "cmp",
    "cmpp",
    "camsp",
    "cattp",
    "csapa",
    "pharmacie d officine",
    "centre medico psychologique",
    "centre medico psycho pedagogique",
)

_FINESS_NON_STRATEGIC_LABEL_KEYWORDS: tuple[str, ...] = (
    "foyer",
    "residence",
    "résidence",
    "entreprise adaptee",
    "ecole formant",
    "service d investigation educative",
    "service d intervention educative",
    "service mandataire judiciaire",
    "centre d accueil pour demandeurs d asile",
    "c a d a",
    "aemo",
    "aed",
    "maison relais",
    "pension de famille",
    "chrs",
    "autre centre d accueil",
    "etablissement experimental",
)


def _finess_isere_is_strategic(kind: str, category_label: str, normalized_blob: str) -> bool:
    if kind in {"chu", "hopital", "hopital_public", "hopital_prive", "clinique", "ehpad", "medecin"}:
        return True
    normalized_label = _normalize_finess_text(category_label)
    if any(token in normalized_label for token in _FINESS_NON_STRATEGIC_LABEL_KEYWORDS):
        return False
    if any(token in normalized_blob for token in ("ministere", "ministère", "siege", "siège", "administratif")):
        return False
    if any(token in normalized_label for token in _FINESS_STRATEGIC_LABEL_KEYWORDS):
        return True
    return False


def _finess_precise_geocode(
    *,
    query: str,
    postcode: str | None = None,
    citycode: str | None = None,
    timeout: int = 8,
) -> tuple[float, float] | None:
    q = (query or "").strip()
    if not q:
        return None
    parts = [f"q={quote_plus(q)}", "limit=1", "autocomplete=0"]
    if postcode:
        parts.append(f"postcode={quote_plus(postcode)}")
    if citycode:
        parts.append(f"citycode={quote_plus(citycode)}")
    url = f"https://api-adresse.data.gouv.fr/search/?{'&'.join(parts)}"
    try:
        payload = _http_get_json(url, timeout=timeout)
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError):
        return None
    features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(features, list) or not features:
        return None
    coordinates = (((features[0] or {}).get("geometry") or {}).get("coordinates"))
    if not isinstance(coordinates, list) or len(coordinates) != 2:
        return None
    lon, lat = coordinates
    try:
        return float(lat), float(lon)
    except (TypeError, ValueError):
        return None
_isere_opendata_cache_lock = Lock()
_isere_opendata_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_anfr_isere_cache_lock = Lock()
_anfr_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_arcep_isere_cache_lock = Lock()
_arcep_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_hubeau_groundwater_cache_lock = Lock()
_hubeau_groundwater_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_avalanche_isere_cache_lock = Lock()
_avalanche_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_apic_isere_cache_lock = Lock()
_apic_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_vigicrues_flash_isere_cache_lock = Lock()
_vigicrues_flash_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_aura_aircraft_cache_lock = Lock()
_aura_aircraft_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
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
    """Fetch latest water height (in meters) and delta for a Vigicrues station.

    Tries the documented v1 API first, falls back to legacy /index.php path.
    Returns (height_m, delta_m, observed_at_iso) – all zeros on failure.
    """
    urls = [
        f"https://www.vigicrues.gouv.fr/services/observations.json?CdStationHydro={quote_plus(station_code)}&GrdSerie=H&FormatDate=iso",
        f"https://www.vigicrues.gouv.fr/services/observations.json/index.php?CdStationHydro={quote_plus(station_code)}&FormatDate=iso",
    ]
    payload: Any = None
    for url in urls:
        try:
            payload = _http_get_json(url, timeout=8)
            break
        except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError):
            continue
    if payload is None:
        return 0.0, 0.0, ""

    serie = payload.get("Serie") or {}
    observations = serie.get("ObssHydro") or []
    valid = [item for item in observations if item.get("ResObsHydro") not in (None, "")]
    if not valid:
        return 0.0, 0.0, ""

    # Vigicrues observations are returned oldest-first; take the last two.
    latest = valid[-1]
    previous = valid[-2] if len(valid) >= 2 else latest
    latest_height = float(latest.get("ResObsHydro") or 0.0)
    previous_height = float(previous.get("ResObsHydro") or latest_height)
    # Values are in meters (Vigicrues convention).
    delta = latest_height - previous_height
    observed_at = str(latest.get("DtObsHydro") or "")
    return latest_height, delta, observed_at


def _fetch_vigicrues_vigicru_levels() -> dict[str, str]:
    """Fetch ALL Vigicrues tronçon vigilance levels in a single GeoJSON call.

    Returns dict: tronçon_code (e.g. "AN12") → level ("vert"|"jaune"|"orange"|"rouge").
    Much faster and more reliable than one RSS call per tronçon.
    """
    payload = _http_get_json(
        "https://www.vigicrues.gouv.fr/services/1/InfoVigiCru.geojson",
        timeout=10,
    )
    niveau_map = {0: "vert", 1: "jaune", 2: "orange", 3: "rouge"}
    result: dict[str, str] = {}
    for feature in (payload.get("features") or []):
        props = feature.get("properties") or {}
        code = str(props.get("CdEntVigiCru") or "").strip()
        niveau = props.get("NivSituVigiCruEnt")
        if code and niveau is not None:
            result[code] = niveau_map.get(int(niveau), "vert")
    return result


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
            f"https://hubeau.eaufrance.fr/api/v2/hydrometrie/referentiel/stations?code_departement=38&size={page_size}&page={page}",
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


def _fetch_hubeau_isere_stations_full() -> list[dict[str, Any]]:
    """Fetch all Isère hydrometric stations from HuBEAU with full metadata (1–2 HTTP calls)."""
    stations: list[dict[str, Any]] = []
    page = 1
    page_size = 1000
    while True:
        payload = _http_get_json(
            f"https://hubeau.eaufrance.fr/api/v2/hydrometrie/referentiel/stations"
            f"?code_departement=38&size={page_size}&page={page}",
            timeout=12,
        )
        data = payload.get("data") or []
        if not data:
            break
        stations.extend(data)
        if len(data) < page_size:
            break
        page += 1
    return stations


def _fetch_hubeau_stations_by_codes(codes: list[str]) -> dict[str, dict[str, Any]]:
    """Fetch station metadata from HuBEAU for a specific list of station codes (1 HTTP call)."""
    if not codes:
        return {}
    codes_param = ",".join(codes)
    try:
        payload = _http_get_json(
            f"https://hubeau.eaufrance.fr/api/v2/hydrometrie/referentiel/stations"
            f"?code_station={codes_param}&size={len(codes)}",
            timeout=12,
        )
    except Exception:
        return {}
    result: dict[str, dict[str, Any]] = {}
    for s in payload.get("data") or []:
        code = str(s.get("code_station") or "").strip()
        if code:
            result[code] = s
    return result


def _fetch_hubeau_observations_batch(
    station_codes: list[str],
    batch_size: int = 40,
) -> dict[str, tuple[float, float, str | None]]:
    """Fetch latest water-height observations for a list of stations via HuBEAU batch API.

    Returns dict: code_station -> (height_m, delta_window_m, observed_at_iso).
    Makes ceil(len(station_codes) / batch_size) HTTP calls total.
    """
    results: dict[str, tuple[float, float, str | None]] = {}
    for i in range(0, len(station_codes), batch_size):
        batch = station_codes[i : i + batch_size]
        codes_param = ",".join(batch)
        per_batch_size = min(len(batch) * 20, 2000)  # ~20 obs/station pour couvrir tout le batch
        try:
            payload = _http_get_json(
                f"https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr"
                f"?code_entite={codes_param}&grandeur_hydro=H"
                f"&size={per_batch_size}&sort=desc",
                timeout=15,
            )
        except Exception:
            continue
        obs_by_station: dict[str, list[dict]] = {}
        for obs in payload.get("data") or []:
            code = str(obs.get("code_station") or "").strip()
            if code:
                obs_by_station.setdefault(code, []).append(obs)
        for code, obs_list in obs_by_station.items():
            if not obs_list:
                continue
            latest = obs_list[0]
            val = latest.get("resultat_obs")
            if val is None:
                continue
            height_m = float(val) / 1000.0  # HuBEAU returns mm
            observed_at = latest.get("date_obs")
            delta_m = 0.0
            if len(obs_list) >= 2:
                prev_val = obs_list[1].get("resultat_obs")
                if prev_val is not None:
                    delta_m = height_m - float(prev_val) / 1000.0
            results[code] = (height_m, delta_m, observed_at)
    return results


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
        isere_stations: list[dict[str, Any]] = []

        # ═══════════════════════════════════════════════════════════════════════
        # PHASE 1 – Métadonnées stations  (HuBEAU batch → Vigicrues fallback)
        # ═══════════════════════════════════════════════════════════════════════
        hubeau_stations: list[dict[str, Any]] = []
        try:
            hubeau_stations = _fetch_hubeau_isere_stations_full()
        except Exception:
            pass

        if hubeau_stations:
            # ── PHASE 2A : observations HuBEAU en batch ──────────────────────
            station_codes_all = [
                str(s.get("code_station") or "").strip()
                for s in hubeau_stations
                if s.get("code_station")
            ]
            obs_map: dict[str, tuple[float, float, str | None]] = {}
            try:
                obs_map = _fetch_hubeau_observations_batch(station_codes_all)
            except Exception:
                pass

            for s in hubeau_stations:
                code = str(s.get("code_station") or "").strip()
                if not code:
                    continue
                commune_code = str(s.get("code_commune_station") or "")
                try:
                    lat = float(s["latitude_station"]) if s.get("latitude_station") is not None else None
                    lon = float(s["longitude_station"]) if s.get("longitude_station") is not None else None
                except (TypeError, ValueError):
                    lat = lon = None
                station_name = (
                    s.get("libelle_station")
                    or s.get("libelle_cours_eau")
                    or "Station"
                )
                river_name = s.get("libelle_cours_eau") or ""
                text_blob = f"{station_name} {river_name}".lower()
                height_m, delta_m, observed_at = obs_map.get(code, (0.0, 0.0, None))
                level = _vigicrues_level_from_delta(abs(delta_m))
                isere_stations.append({
                    "code": code,
                    "station": station_name,
                    "river": river_name,
                    "height_m": round(height_m, 2),
                    "delta_window_m": round(delta_m, 3),
                    "level": level,
                    "control_status": "Fonctionnel",
                    "is_priority": (
                        "grenoble" in text_blob
                        or any(name in text_blob for name in priority_names)
                    ),
                    "observed_at": observed_at,
                    "lat": lat,
                    "lon": lon,
                    "commune_code": commune_code,
                    "troncon": "",
                    "troncon_code": "",
                    "source_link": f"{source}/station/{code}",
                })

        # ═══════════════════════════════════════════════════════════════════════
        # PHASE 2B – Fallback Vigicrues : stations connues en parallèle
        # (utilisé quand HuBEAU est indisponible)
        # Chaque appel Vigicrues donne le vrai nom + les observations
        # en 2 requêtes légères par station, 24 en parallèle → ~3-5 secondes.
        # ═══════════════════════════════════════════════════════════════════════
        if not isere_stations:
            fallback_codes = [
                c for c in fallback_isere_codes
                if c.startswith("W")  # Seuls les vrais codes hydro SANDRE
            ]
            force_include = set(fallback_codes)
            catalog = set(fallback_codes)
            worker_count = min(len(fallback_codes), 12)
            fb_executor = ThreadPoolExecutor(max_workers=worker_count)
            fb_futures = [
                fb_executor.submit(
                    _vigicrues_build_station_entry,
                    source,
                    code,
                    priority_names,
                    force_include,
                    catalog,
                    None,
                )
                for code in fallback_codes
            ]
            try:
                for fut in as_completed(fb_futures, timeout=20):
                    try:
                        station = fut.result()
                    except Exception:
                        station = None
                    if station:
                        isere_stations.append(station)
            except TimeoutError:
                pass
            finally:
                fb_executor.shutdown(wait=False, cancel_futures=True)

        if not isere_stations:
            return {
                "service": "Vigicrues",
                "status": "stale",
                "source": source,
                "water_alert_level": "vert",
                "stations": [],
                "troncons": [],
                "alerts": [],
                "station_count": 0,
                "updated_at": datetime.utcnow().isoformat() + "Z",
                "stale_reason": "Aucune station résolue (HuBEAU et Vigicrues indisponibles)",
            }

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

        # ── Niveaux officiels Vigicrues : 1 seul appel GeoJSON ──────────────
        vigicru_levels: dict[str, str] = {}
        try:
            vigicru_levels = _fetch_vigicrues_vigicru_levels()
        except Exception:
            pass

        def _troncon_level(code: str) -> str:
            return vigicru_levels.get(code, "vert")

        def _troncon_rss(code: str) -> str:
            return f"https://www.vigicrues.gouv.fr/territoire/rss?CdEntVigiCru={code}"

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
        isere_grenobloise_level = _troncon_level("AN12")
        isere_grenobloise_rss = _troncon_rss("AN12")

        troncons_index["AN12 Isère grenobloise"] = {
            "code": "AN12",
            "name": "Isère grenobloise",
            "level": isere_grenobloise_level,
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

        isere_moyenne_level = _troncon_level("AN11")
        isere_moyenne_rss = _troncon_rss("AN11")

        troncons_index["AN11 Isère moyenne"] = {
            "code": "AN11",
            "name": "Isère moyenne",
            "level": isere_moyenne_level,
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
        drac_aval_level = _troncon_level("AN30")
        drac_aval_rss = _troncon_rss("AN30")

        troncons_index["AN30 Drac aval"] = {
            "code": "AN30",
            "name": "Drac aval",
            "level": drac_aval_level,
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
        romanche_aval_level = _troncon_level("AN31")
        romanche_aval_rss = _troncon_rss("AN31")

        troncons_index["AN31 Romanche aval"] = {
            "code": "AN31",
            "name": "Romanche aval",
            "level": romanche_aval_level,
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

        isere_aval_level = _troncon_level("AN20")
        isere_aval_rss = _troncon_rss("AN20")

        troncons_index["AN20 Isère aval"] = {
            "code": "AN20",
            "name": "Isère aval",
            "level": isere_aval_level,
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


_ROAD_ALIASES_PY: dict[str, str] = {
    "D532": "D1532", "RD532": "D1532", "CD532": "D1532",
    "RD520": "D520", "CD520": "D520",
    "RD525": "D525", "CD525": "D525",
    "RD531": "D531", "CD531": "D531",
    "RD512": "D512", "CD512": "D512",
    "RD91": "D91", "CD91": "D91",
    "RD94": "D94", "CD94": "D94",
    "RD15": "D15", "CD15": "D15",
    "RD1090": "D1090", "CD1090": "D1090",
    "RD1091": "D1091", "CD1091": "D1091",
    "RD1075": "D1075", "CD1075": "D1075",
}

def _itinisere_extract_roads(text: str) -> list[str]:
    # Capture: D15, D 15, RD15, CD15, D1075, D520B, N85, A48, etc.
    raw = re.findall(r"\b(?:(?:RD|CD|RN)\s*)?([ADNR]\s*\d{1,4}[A-Z]?)\b", text or "", flags=re.IGNORECASE)
    roads: set[str] = set()
    for r in raw:
        code = re.sub(r"\s+", "", r).upper()
        code = re.sub(r"^R([DN])", r"\1", code)   # RD15 → D15, RN85 → N85
        if re.match(r"^[ADN]\d{1,4}[A-Z]?$", code):
            resolved = _ROAD_ALIASES_PY.get(code, code)
            roads.add(resolved)
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
        "isère", "isere", "38",
        "grenoble", "voiron", "vienne", "bourgoin", "pontcharra",
        "la mure", "rives", "le touvet", "villard-de-lans", "vizille",
        "corps", "tullins", "moirans", "meylan", "domène", "sassenage",
        "échirolles", "echirolles", "pont-de-claix", "claix", "seyssins",
        "crolles", "allevard", "la tour-du-pin", "saint-marcellin",
        "belledonne", "vercors", "oisans", "chartreuse", "matheysine",
        "bourg-d'oisans", "lautaret", "galibier", "chambon", "ornon",
        "alpe d'huez", "deux alpes", "chamrousse",
    )
    if any(token in text for token in isere_tokens):
        return True

    isere_roads = {
        "A41", "A48", "A49", "A43", "A480", "A7", "A516",
        "N85", "N87", "N75",
        "D1075", "D1090", "D1091", "D1532", "D520", "D525", "D531",
        "D518", "D526", "D111", "D523", "D524", "D530",
    }
    return bool(set(roads or []) & isere_roads)


def _itinisere_is_road_closure_pass_or_camera_event(title: str, description: str, category: str, roads: list[str] | None = None) -> bool:
    """Keep any road-relevant disruption: closures, works, accidents, incidents, passes, cameras."""
    # Any event with detected road codes is kept
    if roads:
        return True
    text = f"{title} {description}".lower()
    keep_tokens = (
        "fermet", "route coup", "interdit", "barr", "réouvert", "reouvert", "ouvert",
        "col ", "cols ", "col du", "col de", "col des",
        "caméra", "camera", "webcam",
        "travaux", "chantier", "basculement", "alternat", "neutralis",
        "accident", "collision", "carambolage", "obstacle", "panne",
        "verglas", "neige", "intemp", "crue", "glissement",
    )
    return any(token in text for token in keep_tokens)


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
    if any(token in text for token in ("accident", "collision", "carambolage", "fort", "gros ralent", "très perturb", "dév")) or category == "incident":
        return "orange"
    if category in {"travaux", "évènement"} or any(token in text for token in ("travaux", "chantier", "retard", "ralenti", "manifest", "alternat")):
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

def _cityway_fetch_isere_disruptions() -> list[dict[str, Any]]:
    """Try the Cityway crowdsourcing API (Isère bbox). Returns list of events with lat/lon or []."""
    url = "https://api.ppp38v2.cityway.fr/api/crowdsourcing/v1/GetRoadDisruptionsByBoundingBox/json"
    params = (
        "BottomLeftLatitude=44.70&BottomLeftLongitude=4.70"
        "&UpperRightLatitude=45.95&UpperRightLongitude=6.55&Lang=fr"
    )
    full_url = f"{url}?{params}"
    try:
        raw = _http_get_text(full_url, timeout=10)
        import json as _json
        data = _json.loads(raw)
        items = data if isinstance(data, list) else (data.get("Data") or data.get("data") or data.get("items") or [])
        events: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            lat = item.get("Latitude") or item.get("latitude") or item.get("lat")
            lon = item.get("Longitude") or item.get("longitude") or item.get("lon") or item.get("lng")
            try:
                lat = float(lat)
                lon = float(lon)
            except (TypeError, ValueError):
                continue
            if not _is_isere_coordinate(lat, lon):
                continue
            title = str(item.get("Title") or item.get("title") or item.get("Name") or "Perturbation").strip()
            description = str(item.get("Description") or item.get("description") or "").strip()
            category_raw = str(item.get("Type") or item.get("type") or item.get("DisruptionType") or "").lower()
            category = _itinisere_category(title, description) if not category_raw else (
                "fermeture" if "ferm" in category_raw or "clos" in category_raw
                else "travaux" if "trav" in category_raw or "work" in category_raw
                else "incident" if "accid" in category_raw or "incid" in category_raw
                else _itinisere_category(title, description)
            )
            roads = _itinisere_extract_roads(f"{title} {description}")
            events.append({
                "title": title,
                "description": description[:550],
                "published_at": str(item.get("StartDate") or item.get("start_date") or ""),
                "link": str(item.get("Link") or item.get("Url") or "https://www.itinisere.fr"),
                "roads": roads,
                "category": category,
                "severity": _itinisere_severity(title, description, category),
                "period_start": str(item.get("StartDate") or ""),
                "period_end": str(item.get("EndDate") or item.get("end_date") or ""),
                "locations": _itinisere_extract_locations(title, description),
                "lat": lat,
                "lon": lon,
                "source_api": "cityway",
            })
        return events
    except Exception:
        return []


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
        # Merge Cityway events (have lat/lon) — add only those not already in RSS
        cityway_events = _cityway_fetch_isere_disruptions()
        rss_titles = {e["title"].lower()[:60] for e in events}
        for cw_event in cityway_events:
            if cw_event["title"].lower()[:60] not in rss_titles:
                if not _itinisere_is_public_transport_event(cw_event["title"], cw_event["description"]):
                    events.append(cw_event)

        # Also enrich RSS events that match a Cityway event with coordinates
        cityway_by_title = {e["title"].lower()[:60]: e for e in cityway_events}
        for event in events:
            if event.get("lat") is None:
                match = cityway_by_title.get(event["title"].lower()[:60])
                if match and match.get("lat") is not None:
                    event["lat"] = match["lat"]
                    event["lon"] = match["lon"]
                    event["source_api"] = "cityway"

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
        # If RSS fails, try Cityway only
        cityway_events = _cityway_fetch_isere_disruptions()
        if cityway_events:
            insights = _itinisere_insights(cityway_events)
            insights["severity_breakdown"] = {
                level: len([e for e in cityway_events if e.get("severity") == level])
                for level in ("rouge", "orange", "jaune", "vert")
            }
            return {
                "service": "Itinisère",
                "status": "degraded_rss",
                "source": "cityway",
                "events": cityway_events,
                "events_total": len(cityway_events),
                "insights": insights,
                "updated_at": datetime.utcnow().isoformat() + "Z",
            }
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


def _atmo_label_from_index(index_value: float | int | None) -> str:
    if index_value is None:
        return "inconnu"
    if index_value < 3:
        return "bon"
    if index_value < 4:
        return "modéré"
    if index_value < 5:
        return "dégradé"
    if index_value < 6:
        return "mauvais"
    return "très mauvais"


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
                "label": _atmo_label_from_index(today_index),
                "comment": comments.get(today_date, ""),
                "sub_indices": today_payload.get("sous_indices") or [],
            },
            "tomorrow": {
                "date": tomorrow_date,
                "index": tomorrow_index,
                "level": _atmo_level_from_index(tomorrow_index),
                "label": _atmo_label_from_index(tomorrow_index),
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



def _fetch_dauphine_isere_news_live(limit: int = 10) -> dict[str, Any]:
    source = "https://www.ledauphine.com/isere/rss"
    try:
        xml_payload = _http_get_text(source)
        root = ET.fromstring(xml_payload)
        items: list[dict[str, Any]] = []
        for item in root.findall(".//item"):
            title = unescape((item.findtext("title") or "").strip()) or "Article Le Dauphiné Libéré"
            link = (item.findtext("link") or "https://www.ledauphine.com/isere").strip()
            parsed_link = urlparse(link)
            if parsed_link.scheme not in {"http", "https"}:
                continue
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


def fetch_dauphine_isere_news(limit: int = 10, force_refresh: bool = False) -> dict[str, Any]:
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


def _finess_isere_slug(value: str) -> str:
    cleaned = unicodedata.normalize("NFKD", value or "")
    cleaned = "".join(ch for ch in cleaned if not unicodedata.combining(ch))
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", cleaned).strip("_").lower()
    return cleaned or "autre"


def _normalize_finess_text(value: str) -> str:
    cleaned = unicodedata.normalize("NFKD", value or "")
    cleaned = "".join(ch for ch in cleaned if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", cleaned).strip().lower()


_FINESS_ISERE_REQUESTED_CATEGORIES: list[tuple[str, tuple[str, ...]]] = [
    ("Service autonomie aide (SAA)", ("service autonomie aide", " saa ")),
    ("Appartement de Coordination Thérapeutique (ACT)", ("appartement de coordination therapeutique", " act ")),
    ("Maisons Relais – Pensions de Famille", ("maison relais", "pension de famille")),
    ("Centre d’Accueil et d’Accompagnement à la Réduction des Risques pour Usagers de Drogues (CAARUD)", ("caarud",)),
    ("Centre d’Action Médico-Sociale Précoce (CAMSP)", ("camsp",)),
    ("Centre d’Accueil Thérapeutique à Temps Partiel (CATTP)", ("cattp",)),
    ("Centre gratuit d’information, de dépistage et de diagnostic", ("cegidd", "centre gratuit d information, de depistage et de diagnostic")),
    ("Centre d’Hébergement et de Réinsertion Sociale (CHRS)", ("chrs", "centre d hebergement et de reinsertion sociale")),
    ("Centre d’examens de santé", ("centre d examens de sante",)),
    ("Centre de santé", ("centre de sante",)),
    ("Centre de santé sexuelle", ("centre de sante sexuelle",)),
    ("Centre de vaccination", ("centre de vaccination",)),
    ("Centre de vaccination internationale", ("centre de vaccination internationale",)),
    ("Autre centre d’accueil", ("autre centre d accueil",)),
    ("Centre de lutte antituberculeuse (CLAT)", ("clat",)),
    ("Centre Médico-Psychologique (CMP)", ("cmp ", "centre medico psychologique")),
    ("Centre Médico-Psycho-Pédagogique (CMPP)", ("cmpp", "centre medico psycho pedagogique")),
    ("Communautés Professionnelles Territoriales de Santé (CPTS)", ("cpts", "communaute professionnelle territoriale de sante")),
    ("Centre de soins, d’accompagnement et de prévention en addictologie (CSAPA)", ("csapa",)),
    ("Établissement expérimental (enfance protégée / handicap)", ("etablissement experimental",)),
    ("Établissement d’hébergement pour personnes âgées dépendantes (EHPAD)", ("ehpad", "hebergement pour personnes agees dependantes")),
    ("Maison de santé pour maladies mentales", ("maison de sante pour maladies mentales",)),
    ("Espaces de vie affective, relationnelle et sexuelle (EVARS)", ("evars",)),
    ("Structure contribuant au Service d’Accès aux Soins", ("service d acces aux soins",)),
    ("Foyer de vie pour adultes handicapés", ("foyer de vie pour adultes handicapes",)),
    ("Pharmacie d’officine", ("pharmacie d officine",)),
    ("Centre hospitalier spécialisé (santé mentale)", ("centre hospitalier specialise", "sante mentale")),
    ("Écoles formant aux professions sociales", ("ecole formant aux professions sociales", "ecoles formant aux professions sociales")),
    ("Lits d’Accueil Médicalisés (LAM)", ("lam ", "lits d accueil medicalises")),
    ("Laboratoire de biologie médicale", ("laboratoire de biologie medicale",)),
    ("Lits Halte Soins Santé (LHSS)", ("lhss", "lits halte soins sante")),
    ("Maison de naissance", ("maison de naissance",)),
    ("Maison de santé", ("maison de sante",)),
    ("Maison médicale de garde (MMG)", ("maison medicale de garde", "mmg")),
    ("Résidence autonomie", ("residence autonomie",)),
    ("Résidence sociale", ("residence sociale",)),
    ("Service mandataire judiciaire à la protection des majeurs", ("service mandataire judiciaire a la protection des majeurs",)),
    ("Services de prévention et de santé au travail (SPST)", ("spst", "service de prevention et de sante au travail")),
    ("Service de soins infirmiers à domicile (SSIAD)", ("ssiad", "service de soins infirmiers a domicile")),
    ("Service d’éducation spéciale et de soins à domicile (SESSAD)", ("sessad",)),
    ("Service d’intervention éducative en milieu ouvert", ("service d intervention educative en milieu ouvert",)),
    ("Établissement et service d’aide par le travail (ESAT)", ("esat",)),
    ("Maisons départementales des personnes handicapées (MDPH)", ("mdph",)),
    ("Protection maternelle et infantile (PMI)", ("pmi", "protection maternelle et infantile")),
    ("Établissement de soins pluridisciplinaire", ("etablissement de soins pluridisciplinaire",)),
    ("Maison d’accueil spécialisée (MAS)", ("mas ", "maison d accueil specialisee")),
    ("Foyer d’hébergement adultes handicapés", ("foyer d hebergement adultes handicapes",)),
    ("Établissement d’accueil médicalisé (handicap)", ("etablissement d accueil medicalise",)),
    ("Foyer de l’enfance", ("foyer de l enfance",)),
    ("Foyer de jeunes travailleurs", ("foyer de jeunes travailleurs",)),
    ("Établissement d’accueil mère-enfant", ("etablissement d accueil mere enfant",)),
    ("Services AEMO / AED", ("aemo", "aed")),
    ("Service d’investigation éducative", ("service d investigation educative",)),
    ("Centre d’accueil pour demandeurs d’asile (CADA)", ("cada", "centre d accueil pour demandeurs d asile")),
    ("Entreprise adaptée", ("entreprise adaptee",)),
    ("Centre de jour pour personnes âgées", ("centre de jour pour personnes agees",)),
]


def _finess_isere_kind(row: list[str]) -> tuple[str, str]:
    lib_cat_etab = str(row[21] if len(row) > 21 else "").strip()
    cat_etab = str(row[19] if len(row) > 19 else "").strip()
    lib_cat_agregat = str(row[20] if len(row) > 20 else "").strip()
    cat_agregat_code = str(row[20] if len(row) > 20 else "").strip()
    blob = " ".join(
        (
            str(row[3] if len(row) > 3 else ""),
            str(row[4] if len(row) > 4 else ""),
            cat_etab,
            lib_cat_agregat,
            lib_cat_etab,
        )
    )
    normalized_blob = f" {_normalize_finess_text(blob)} "

    if any(token in normalized_blob for token in (" medecin ", " medecins ", "cabinet medical", "cabinet de medecine", "medecine generale", "medecin generaliste", "maison medicale", "maison de sante", "centre de sante")):
        return "medecin", (lib_cat_etab or "Médecins / cabinet médical")

    if any(token in normalized_blob for token in (" ehpad ", "hebergement pour personnes agees dependantes")):
        return "ehpad", (lib_cat_etab or "EHPAD")
    if any(token in normalized_blob for token in (" chu ", " c.h.u ", "centre hospitalier universitaire", "centres hospitaliers regionaux", "centre hospitalier regional")):
        return "chu", (lib_cat_etab or "CHU")
    if any(token in normalized_blob for token in (" clinique ", "cliniques", "clinique medicale", "clinique chirurgicale", "centre de dialyse")):
        return "clinique", (lib_cat_etab or "Clinique")
    if (
        cat_agregat_code in {"1107"}
        or any(token in normalized_blob for token in (" hospitalisation privee ", "etablissement de sante prive", "etablissement prive", "etablissements de sante prive"))
    ):
        return "hopital_prive", (lib_cat_etab or "Hôpital privé")
    if (
        cat_agregat_code in {"1101", "1102", "1103", "1106", "1109", "1110"}
        or any(token in normalized_blob for token in (" hospitalisation publique ", "etablissement public de sante", "centre hospitalier public", "centre hospitalier"))
    ):
        return "hopital_public", (lib_cat_etab or "Hôpital public")
    if any(token in normalized_blob for token in ("hopital", "hopitaux", "hospital", "centre hospitalier", "centres hospitaliers", "hospitalier")):
        return "hopital", (lib_cat_etab or "Hôpital")

    for label, keywords in _FINESS_ISERE_REQUESTED_CATEGORIES:
        if any(keyword in normalized_blob for keyword in keywords):
            return f"finess_{_finess_isere_slug(label)}", label

    category_label = lib_cat_etab or lib_cat_agregat or cat_etab or "Autre établissement FINESS"
    return f"finess_{_finess_isere_slug(category_label)}", category_label


def _normalize_finess_commune_code(code_commune: str, departement_code: str) -> str:
    normalized = str(code_commune or "").strip()
    department = str(departement_code or "").strip()
    if not normalized:
        return ""
    if re.fullmatch(r"\d{5}", normalized):
        return normalized
    if department and re.fullmatch(r"\d{2}", department) and re.fullmatch(r"\d{3}", normalized):
        return f"{department}{normalized}"
    return normalized


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


def _fetch_isere_commune_centers() -> dict[str, tuple[float, float]]:
    payload = _http_get_json(
        "https://geo.api.gouv.fr/departements/38/communes?fields=code,nom,centre&format=json",
        timeout=12,
    )
    rows = payload if isinstance(payload, list) else []
    centers: dict[str, tuple[float, float]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        code = str(row.get("code") or "").strip()
        coordinates = ((row.get("centre") or {}).get("coordinates") if isinstance(row.get("centre"), dict) else None)
        if not code or not isinstance(coordinates, list) or len(coordinates) != 2:
            continue
        lon, lat = coordinates
        try:
            centers[code] = (float(lat), float(lon))
        except (TypeError, ValueError):
            continue
    return centers


def _get_isere_commune_centers(force_refresh: bool = False) -> dict[str, tuple[float, float]]:
    def loader() -> dict[str, tuple[float, float]]:
        return _fetch_isere_commune_centers()
    return _cached_external_payload(
        cache=_finess_isere_communes_cache,
        lock=_finess_isere_communes_lock,
        ttl_seconds=86400,
        force_refresh=force_refresh,
        loader=loader,
    )


def _finess_batch_geocode(candidates: list[dict]) -> dict[str, tuple[float, float]]:
    """
    Géocode en une seule requête CSV vers api-adresse.data.gouv.fr/search/csv/.
    candidates : liste de {'key': str, 'q': str, 'postcode': str, 'citycode': str}
    Retourne dict key → (lat, lon).
    """
    if not candidates:
        return {}
    import io as _io
    # Construire le CSV d'entrée
    lines = ["id,adresse,postcode,citycode"]
    for i, c in enumerate(candidates):
        q = str(c.get("q") or "").replace('"', " ").replace("\n", " ")
        pc = str(c.get("postcode") or "")
        cc = str(c.get("citycode") or "")
        lines.append(f'{i},"{q}",{pc},{cc}')
    csv_body = "\n".join(lines).encode("utf-8")

    url = "https://api-adresse.data.gouv.fr/search/csv/"
    try:
        req = Request(url, data=csv_body, headers={
            "Content-Type": "text/csv; charset=utf-8",
            "User-Agent": "ope-protec/1.0",
        }, method="POST")
        with urlopen(req, timeout=60) as resp:
            result_csv = resp.read().decode("utf-8", errors="ignore")
    except Exception:
        return {}

    results: dict[str, tuple[float, float]] = {}
    reader = csv.DictReader(_io.StringIO(result_csv))
    for row in reader:
        try:
            idx = int(row.get("id", -1))
        except (ValueError, TypeError):
            continue
        if idx < 0 or idx >= len(candidates):
            continue
        try:
            lat = float(row.get("latitude") or row.get("result_latitude") or "")
            lon = float(row.get("longitude") or row.get("result_longitude") or "")
        except (ValueError, TypeError):
            continue
        score_str = row.get("result_score") or row.get("score") or "0"
        try:
            score = float(score_str)
        except ValueError:
            score = 0.0
        if score >= 0.4 and -90 <= lat <= 90 and -180 <= lon <= 180:
            results[candidates[idx]["key"]] = (lat, lon)
    return results


def _fetch_finess_isere_resources_live(limit: int = 5000) -> dict[str, Any]:
    csv_url = _FINESS_ISERE_STABLE_CSV_URL
    request = Request(csv_url, headers={"User-Agent": "ope-protec/1.0"})
    csv_bytes = _http_get_with_retries(request=request, timeout=60)
    decoded = csv_bytes.decode("utf-8", errors="ignore").splitlines()
    rows_raw = list(csv.reader(decoded, delimiter=";"))
    if rows_raw:
        rows_raw = rows_raw[1:]  # sauter l'en-tête

    # Précharger les centres de communes Isère (1 seul appel API)
    centers_by_code = _get_isere_commune_centers()

    # --- Passe 1 : filtrer les lignes stratégiques Isère ---
    strategic_rows: list[tuple[list[str], str, str]] = []  # (row, kind, category_label)
    hospitals_total = chu_total = medecins_total = 0
    hospitals_public_total = hospitals_private_total = ehpad_total = clinics_total = 0
    categories: dict[str, int] = {}
    max_points = max(200, min(limit, _FINESS_ISERE_MAX_LIMIT))

    for row in rows_raw:
        if len(row) < 22 or row[13].strip() != "38":
            continue
        kind, category_label = _finess_isere_kind(row)
        if kind == "hopital":      hospitals_total += 1
        if kind == "chu":          chu_total += 1
        if kind == "medecin":      medecins_total += 1
        if kind == "hopital_public":   hospitals_public_total += 1
        if kind == "hopital_prive":    hospitals_private_total += 1
        if kind == "clinique":     clinics_total += 1
        if kind == "ehpad":        ehpad_total += 1
        strategic_rows.append((row, kind, category_label))

    # --- Passe 2 : résoudre coords par code commune INSEE (instantané, pas d'appel réseau) ---
    # Pour les établissements sans coords par code, préparer batch geocoding
    pre_resolved: dict[int, tuple[float, float]] = {}  # index → coords
    batch_candidates: list[dict] = []
    batch_idx_map: list[int] = []  # position dans batch → index dans strategic_rows

    for i, (row, kind, category_label) in enumerate(strategic_rows):
        postal_code, city = _extract_city_from_finess_address_line(row[15] if len(row) > 15 else "")
        code_commune = _normalize_finess_commune_code(
            row[12] if len(row) > 12 else "",
            row[13] if len(row) > 13 else "",
        )
        # Essai immédiat par code commune INSEE
        coords = centers_by_code.get(code_commune) if code_commune else None
        if coords:
            pre_resolved[i] = coords
        else:
            address_parts = [row[7] if len(row) > 7 else "", row[8] if len(row) > 8 else "", row[9] if len(row) > 9 else "", row[15] if len(row) > 15 else ""]
            full_address = re.sub(r"\s+", " ", " ".join(p for p in address_parts if p).strip())
            batch_candidates.append({"key": str(i), "q": full_address or f"{category_label} {city}", "postcode": postal_code or "", "citycode": code_commune or ""})
            batch_idx_map.append(i)

    # Batch geocoding en une seule requête pour les non-résolus
    batch_results: dict[str, tuple[float, float]] = {}
    if batch_candidates:
        # Traiter par tranches de 500 (limite API)
        CHUNK = 500
        for start in range(0, len(batch_candidates), CHUNK):
            chunk = batch_candidates[start:start + CHUNK]
            chunk_results = _finess_batch_geocode(chunk)
            # Remettre les clés à l'index global
            for c, result_coords in chunk_results.items():
                original_idx = batch_idx_map[start + int(c)]
                batch_results[str(original_idx)] = result_coords

    # --- Passe 3 : construire les points ---
    points: list[dict[str, Any]] = []
    commune_center_cache: dict[str, tuple[float, float] | None] = {}

    for i, (row, kind, category_label) in enumerate(strategic_rows):
        if len(points) >= max_points:
            break
        postal_code, city = _extract_city_from_finess_address_line(row[15] if len(row) > 15 else "")
        if not city:
            continue
        categories[category_label] = categories.get(category_label, 0) + 1

        # Résolution coords : pre_resolved > batch_results > commune name fallback
        coords = pre_resolved.get(i) or batch_results.get(str(i))
        if not coords and city:
            if city not in commune_center_cache:
                commune_center_cache[city] = _finess_commune_center(city)
            coords = commune_center_cache.get(city)
        if not coords:
            continue

        lat, lon = coords
        code_commune = _normalize_finess_commune_code(row[12] if len(row) > 12 else "", row[13] if len(row) > 13 else "")
        address_parts = [row[7] if len(row) > 7 else "", row[8] if len(row) > 8 else "", row[9] if len(row) > 9 else "", row[15] if len(row) > 15 else ""]
        full_address = re.sub(r"\s+", " ", " ".join(p for p in address_parts if p).strip())
        points.append(
            {
                "id": f"finess-{row[1] if len(row) > 1 else len(points)}",
                "name": str((row[4] if len(row) > 4 else "") or (row[3] if len(row) > 3 else "")).strip() or "Établissement FINESS",
                "short_name": str(row[3] if len(row) > 3 else "").strip() or "",
                "type": kind,
                "category": category_label,
                "health_kind": kind,
                "health_category": category_label,
                "lat": lat,
                "lon": lon,
                "city": city,
                "postal_code": postal_code,
                "address": full_address,
                "finess_id": str(row[1] if len(row) > 1 else "").strip(),
                "source": "https://www.data.gouv.fr/fr/datasets/finess-extraction-du-fichier-des-etablissements/",
                "info": f"Source FINESS data.gouv.fr · {category_label} · {city}",
                "active": True,
                "priority": "critical" if kind in ("hopital", "clinique") else "vital",
                "dynamic": True,
                "details": {
                    "finess_et": str(row[1] if len(row) > 1 else "").strip(),
                    "finess_ej": str(row[2] if len(row) > 2 else "").strip(),
                    "raison_sociale_courte": str(row[3] if len(row) > 3 else "").strip(),
                    "raison_sociale": str(row[4] if len(row) > 4 else "").strip(),
                    "numero_voie": str(row[7] if len(row) > 7 else "").strip(),
                    "type_voie": str(row[8] if len(row) > 8 else "").strip(),
                    "voie": str(row[9] if len(row) > 9 else "").strip(),
                    "complement_voie": str(row[10] if len(row) > 10 else "").strip(),
                    "distribution": str(row[11] if len(row) > 11 else "").strip(),
                    "code_commune": code_commune,
                    "code_departement": str(row[13] if len(row) > 13 else "").strip(),
                    "departement": str(row[14] if len(row) > 14 else "").strip(),
                    "ligne_acheminement": str(row[15] if len(row) > 15 else "").strip(),
                    "telephone": str(row[16] if len(row) > 16 else "").strip(),
                    "fax": str(row[17] if len(row) > 17 else "").strip(),
                    "categorie_code": str(row[19] if len(row) > 19 else "").strip(),
                    "categorie_agregat_code": str(row[20] if len(row) > 20 else "").strip(),
                    "categorie_libelle": str(row[21] if len(row) > 21 else "").strip(),
                    "siret": str(row[22] if len(row) > 22 else "").strip(),
                    "naf": str(row[23] if len(row) > 23 else "").strip(),
                    "type_etablissement_code": str(row[24] if len(row) > 24 else "").strip(),
                    "type_etablissement_libelle": str(row[25] if len(row) > 25 else "").strip(),
                    "statut_juridique_code": str(row[26] if len(row) > 26 else "").strip(),
                    "statut_juridique_libelle": str(row[27] if len(row) > 27 else "").strip(),
                    "date_ouverture": str(row[28] if len(row) > 28 else "").strip(),
                    "date_autorisation": str(row[29] if len(row) > 29 else "").strip(),
                    "date_maj": str(row[30] if len(row) > 30 else "").strip(),
                },
            }
        )

    return {
        "status": "online",
        "source": "FINESS data.gouv.fr",
        "dataset_url": "https://www.data.gouv.fr/fr/datasets/finess-extraction-du-fichier-des-etablissements/",
        "csv_url": csv_url,
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "hospitals_total": hospitals_total,
        "chu_total": chu_total,
        "medecins_total": medecins_total,
        "hospitals_public_total": hospitals_public_total,
        "hospitals_private_total": hospitals_private_total,
        "clinics_total": clinics_total,
        "ehpad_total": ehpad_total,
        "categories_total": len(categories),
        "categories": [
            {"label": label, "count": count}
            for label, count in sorted(categories.items(), key=lambda item: (-item[1], item[0].lower()))
        ],
        "resources_total": len(points),
        "resources": points,
    }


def fetch_finess_isere_resources(force_refresh: bool = False, limit: int = 5000) -> dict[str, Any]:
    safe_limit = max(200, min(limit, _FINESS_ISERE_MAX_LIMIT))

    def loader() -> dict[str, Any]:
        try:
            return _fetch_finess_isere_resources_live(limit=safe_limit)
        except Exception as exc:
            return {
                "status": "degraded",
                "source": "FINESS data.gouv.fr",
                "updated_at": datetime.utcnow().isoformat() + "Z",
                "hospitals_total": 0,
                "chu_total": 0,
                "medecins_total": 0,
                "hospitals_public_total": 0,
                "hospitals_private_total": 0,
                "clinics_total": 0,
                "ehpad_total": 0,
                "categories_total": 0,
                "categories": [],
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




def _isere_opendata_fetch_dataset_records(dataset_id: str, select_fields: str, limit: int = 1) -> dict[str, Any]:
    encoded_fields = quote_plus(select_fields)
    url = (
        f"https://opendata.isere.fr/api/explore/v2.1/catalog/datasets/{dataset_id}/records"
        f"?select={encoded_fields}&limit={max(1, min(limit, 100))}"
    )
    payload = _http_get_json(url, timeout=15)
    return payload if isinstance(payload, dict) else {}


def _fetch_isere_opendata_resilience_live(limit: int = 80) -> dict[str, Any]:
    safe_limit = max(20, min(limit, 200))

    food = _isere_opendata_fetch_dataset_records(
        "aide-alimentaire",
        "commune,code_postal,structure,telephone,mail,manger_pas_cher_ou_gratuitement,distribution_de_colis_alimentaires_ou_pas_chers",
        limit=safe_limit,
    )
    health = _isere_opendata_fetch_dataset_records(
        "d38_sante_maisons_sante_pluriprofessionnelles",
        "commune,code_postal,nom,type_structure,adresse",
        limit=safe_limit,
    )
    schools = _isere_opendata_fetch_dataset_records(
        "adresse-et-geolocalisation-des-etablissements-denseignement-du-premier-et-second",
        "libelle_commune,code_postal_uai,appellation_officielle,denomination_principale,secteur_public_prive_libe",
        limit=safe_limit,
    )

    food_results = food.get("results") if isinstance(food.get("results"), list) else []
    health_results = health.get("results") if isinstance(health.get("results"), list) else []
    school_results = schools.get("results") if isinstance(schools.get("results"), list) else []

    structures_with_contacts = sum(
        1
        for item in food_results
        if str(item.get("telephone") or "").strip() or str(item.get("mail") or "").strip()
    )
    food_distribution_points = sum(
        1
        for item in food_results
        if str(item.get("distribution_de_colis_alimentaires_ou_pas_chers") or "").strip().lower() == "oui"
    )

    return {
        "status": "online",
        "source": "opendata.isere.fr",
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "datasets": [
            {"id": "aide-alimentaire", "label": "Aide alimentaire", "total": int(food.get("total_count") or len(food_results))},
            {"id": "d38_sante_maisons_sante_pluriprofessionnelles", "label": "Maisons de santé", "total": int(health.get("total_count") or len(health_results))},
            {"id": "adresse-et-geolocalisation-des-etablissements-denseignement-du-premier-et-second", "label": "Établissements scolaires", "total": int(schools.get("total_count") or len(school_results))},
        ],
        "totals": {
            "food_aid_points": int(food.get("total_count") or len(food_results)),
            "health_centers": int(health.get("total_count") or len(health_results)),
            "schools": int(schools.get("total_count") or len(school_results)),
            "food_distribution_points_in_sample": food_distribution_points,
            "food_points_with_contact_in_sample": structures_with_contacts,
        },
        "sample": {
            "food_aid": food_results[:6],
            "health_centers": health_results[:6],
            "schools": school_results[:6],
        },
        "insights": [
            f"{int(food.get('total_count') or len(food_results))} points d'aide alimentaire identifiés en Isère.",
            f"{int(health.get('total_count') or len(health_results))} maisons/pôles de santé disponibles pour l'accès aux soins de proximité.",
            f"{int(schools.get('total_count') or len(school_results))} établissements scolaires géolocalisés pour préparer des plans d'accueil/évacuation.",
        ],
    }


def fetch_isere_opendata_resilience(force_refresh: bool = False, limit: int = 80) -> dict[str, Any]:
    safe_limit = max(20, min(limit, 200))

    def loader() -> dict[str, Any]:
        try:
            return _fetch_isere_opendata_resilience_live(limit=safe_limit)
        except Exception as exc:
            return {
                "status": "degraded",
                "source": "opendata.isere.fr",
                "updated_at": datetime.utcnow().isoformat() + "Z",
                "datasets": [],
                "totals": {
                    "food_aid_points": 0,
                    "health_centers": 0,
                    "schools": 0,
                    "food_distribution_points_in_sample": 0,
                    "food_points_with_contact_in_sample": 0,
                },
                "sample": {"food_aid": [], "health_centers": [], "schools": []},
                "insights": [],
                "error": str(exc),
            }

    return _cached_external_payload(
        cache=_isere_opendata_cache,
        lock=_isere_opendata_cache_lock,
        ttl_seconds=_ISERE_OPENDATA_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=loader,
    )


# ── Massifs avalanche Isère (BRA Météo-France via GDSS) ─────────────────────

# OPP IDs depuis mf_map_layers_v2_sub_zone sur la page risques-avalanche Alpes du Nord
# Seuls les massifs présents en Isère (38)
_ISERE_MASSIFS_BRA = [
    {"opp_id": 7,  "nom": "Chartreuse",     "alt_max": 2082, "secteurs": ["Massif de Chartreuse", "Gorges du Guiers"]},
    {"opp_id": 8,  "nom": "Belledonne",     "alt_max": 2978, "secteurs": ["Chamrousse", "Sept-Laux", "Pleynet"]},
    {"opp_id": 12, "nom": "Grandes-Rousses","alt_max": 3491, "secteurs": ["Alpe d'Huez", "Les 2 Alpes", "Glacier de Sarenne"]},
    {"opp_id": 14, "nom": "Vercors",        "alt_max": 2341, "secteurs": ["Villard-de-Lans", "Hauts Plateaux", "Coulmes"]},
    {"opp_id": 15, "nom": "Oisans",         "alt_max": 4102, "secteurs": ["La Grave", "Meije-Galibier", "Écrins"]},
]

_BRA_RISK_LABELS = {1: "Faible", 2: "Limité", 3: "Marqué", 4: "Fort", 5: "Très fort"}
_BRA_RISK_COLORS = {1: "vert", 2: "jaune", 3: "orange", 4: "rouge", 5: "violet"}
_BRA_GDSS_BASE = "https://rwg.meteofrance.com/gdss/v1/metronome_bra/blob"
_BRA_PAGE_URL = "https://meteofrance.com/meteo-montagne/alpes-du-nord/risques-avalanche"


def _bra_get_mfsession_token() -> str:
    """Récupère le token JWT depuis le cookie mfsession de Météo-France (ROT13 sur le cookie brut)."""
    req = Request(_BRA_PAGE_URL, headers={
        "User-Agent": "Mozilla/5.0 (compatible; ope-protec/1.0)",
        "Accept-Language": "fr-FR,fr;q=0.9",
    })
    with urlopen(req, timeout=15) as resp:
        cookies = resp.headers.get_all("Set-Cookie") or []
    for cookie in cookies:
        if "mfsession=" in cookie:
            raw = cookie.split("mfsession=")[1].split(";")[0]
            return "".join(
                chr((ord(c) - (65 if c <= "Z" else 97) + 13) % 26 + (65 if c <= "Z" else 97))
                if c.isalpha() else c
                for c in raw
            )
    raise ValueError("Cookie mfsession introuvable sur la page BRA Météo-France")


def _bra_fetch_massif_xml(opp_id: int, token: str) -> dict[str, Any] | None:
    """Récupère et parse le BRA XML d'un massif via l'API GDSS Météo-France."""
    import xml.etree.ElementTree as XMLTree
    url = (
        f"{_BRA_GDSS_BASE}?token={token}"
        f"&sort-results-by=-blob_creation_time"
        f"&blob_filename=BRA_{opp_id}.xml"
    )
    req = Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; ope-protec/1.0)",
        "Authorization": f"Bearer {token}",
    })
    try:
        with urlopen(req, timeout=12) as resp:
            raw = resp.read()
    except Exception:
        return None
    try:
        root = XMLTree.fromstring(raw.decode("utf-8", errors="replace"))
    except Exception:
        return None
    if root.tag != "BULLETINS_NEIGE_AVALANCHE":
        return None
    # Premier élément RISQUE sans attribut DATE = bulletin courant
    risque_maxi: int | None = None
    commentaire = ""
    evol = ""
    for elem in root.iter("RISQUE"):
        if "DATE" not in elem.attrib:
            val = elem.get("RISQUEMAXI", "")
            if val.isdigit():
                risque_maxi = int(val)
            commentaire = elem.get("COMMENTAIRE", "")
            evol = elem.get("EVOLURISQUE1", "") or elem.get("EVOLURISQUE2", "")
            break
    return {
        "massif": root.get("MASSIF", ""),
        "date_bulletin": root.get("DATEBULLETIN", "")[:10],
        "date_echeance": root.get("DATEECHEANCE", "")[:10],
        "niveau_bra": risque_maxi,
        "commentaire": commentaire,
        "evolution": evol,
    }


def _fetch_avalanche_isere_live() -> dict[str, Any]:
    try:
        token = _bra_get_mfsession_token()
    except Exception as exc:
        return {
            "service": "Risque Avalanche — Massifs Isère (BRA)",
            "status": "unavailable",
            "source": _BRA_PAGE_URL,
            "error": f"Impossible d'obtenir le token Météo-France: {exc}",
            "massifs": [],
            "massifs_total": len(_ISERE_MASSIFS_BRA),
            "niveau_global": "gris",
            "niveau_max_bra": None,
            "saison_active": True,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }

    massifs_out = []
    max_level = 0
    errors = []

    for massif_def in _ISERE_MASSIFS_BRA:
        bra = _bra_fetch_massif_xml(massif_def["opp_id"], token)
        niveau = bra["niveau_bra"] if bra else None
        massifs_out.append({
            "nom": massif_def["nom"],
            "opp_id": massif_def["opp_id"],
            "alt_max": massif_def["alt_max"],
            "secteurs": massif_def["secteurs"],
            "bra_url": f"https://meteofrance.com/meteo-montagne/alpes-du-nord/{massif_def['nom'].lower().replace('-', '-')}",
            "niveau_bra": niveau,
            "niveau_label": _BRA_RISK_LABELS.get(niveau, "Indisponible"),
            "niveau_couleur": _BRA_RISK_COLORS.get(niveau, "gris"),
            "commentaire": bra.get("commentaire", "") if bra else "",
            "date_bulletin": bra.get("date_bulletin", "") if bra else "",
            "date_echeance": bra.get("date_echeance", "") if bra else "",
        })
        if not bra:
            errors.append(massif_def["nom"])
        if niveau and niveau > max_level:
            max_level = niveau

    niveau_global = _BRA_RISK_COLORS.get(max_level, "gris") if max_level else "gris"
    status = "online" if not errors else ("partial" if len(errors) < len(_ISERE_MASSIFS_BRA) else "unavailable")

    result: dict[str, Any] = {
        "service": "Risque Avalanche — Massifs Isère (BRA)",
        "status": status,
        "source": _BRA_PAGE_URL,
        "massifs_total": len(_ISERE_MASSIFS_BRA),
        "niveau_global": niveau_global,
        "niveau_max_bra": max_level or None,
        "saison_active": True,
        "massifs": massifs_out,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    if errors:
        result["errors"] = errors
    return result


def fetch_avalanche_isere(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_avalanche_isere_cache,
        lock=_avalanche_isere_cache_lock,
        ttl_seconds=_AVALANCHE_ISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_avalanche_isere_live,
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


def _cached_isere_boundary_geometry() -> dict[str, Any] | None:
    now = datetime.utcnow()
    with _isere_boundary_cache_lock:
        cached_geometry = _isere_boundary_cache.get("geometry")
        expires_at = _isere_boundary_cache.get("expires_at") or datetime.min
        if cached_geometry and now < expires_at:
            return deepcopy(cached_geometry)

    payload = fetch_isere_boundary_geojson()
    geometry = payload.get("geometry") if isinstance(payload, dict) else None
    if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        return None

    with _isere_boundary_cache_lock:
        _isere_boundary_cache["geometry"] = deepcopy(geometry)
        _isere_boundary_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_ISERE_BOUNDARY_CACHE_TTL_SECONDS)
    return geometry


def _point_in_ring(lat: float, lon: float, ring: list[list[float]]) -> bool:
    if len(ring) < 3:
        return False

    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        if len(ring[i]) < 2 or len(ring[j]) < 2:
            j = i
            continue
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        intersects = ((yi > lat) != (yj > lat)) and (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) or 1e-12) + xi)
        if intersects:
            inside = not inside
        j = i
    return inside


def _point_in_polygon(lat: float, lon: float, polygon: list[list[list[float]]]) -> bool:
    if not polygon:
        return False
    outer_ring = polygon[0]
    if not isinstance(outer_ring, list) or not _point_in_ring(lat, lon, outer_ring):
        return False

    for hole in polygon[1:]:
        if isinstance(hole, list) and hole and _point_in_ring(lat, lon, hole):
            return False
    return True


def _point_in_geometry(lat: float, lon: float, geometry: dict[str, Any]) -> bool:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list):
        return False
    if geometry_type == "Polygon":
        return _point_in_polygon(lat, lon, coordinates)
    if geometry_type == "MultiPolygon":
        return any(_point_in_polygon(lat, lon, polygon) for polygon in coordinates if isinstance(polygon, list))
    return False


def _is_isere_coordinate(lat: float, lon: float) -> bool:
    if not (44.6 <= lat <= 46.0 and 4.2 <= lon <= 6.8):
        return False

    geometry = _cached_isere_boundary_geometry()
    if not geometry:
        return True
    return _point_in_geometry(lat=lat, lon=lon, geometry=geometry)


def _bison_event_category(value: str) -> str:
    text = str(value or "").lower()
    if any(token in text for token in ("travaux", "chantier", "work", "maintenance")):
        return "travaux"
    if any(token in text for token in ("accident", "collision", "crash")):
        return "accident"
    if any(token in text for token in ("panne", "obstacle", "incident")):
        return "incident"
    if any(token in text for token in ("danger", "chaussée glissante", "visibilit", "contresens", "weather", "verglas", "neige", "fermeture", "ferm")):
        return "danger"
    if any(token in text for token in ("bouchon", "ralent", "congestion")):
        return "ralentissement"
    if any(token in text for token in ("voie", "réduction", "alternat", "neutralis", "circulation")):
        return "reduction_voie"
    return "info"


def _bison_event_severity(category: str) -> str:
    return {
        "accident": "orange",
        "incident": "orange",
        "travaux": "jaune",
        "reduction_voie": "jaune",
        "ralentissement": "jaune",
        "danger": "orange",
    }.get(category, "vert")


def _bison_dataset_events_url() -> str:
    dataset_api = "https://www.data.gouv.fr/api/1/datasets/evenements-routiers-sur-le-reseau-routier-national-non-concede/"
    default_url = "http://tipi.bison-fute.gouv.fr/bison-fute-ouvert/publicationsDIR/Evenementiel-DIR/grt/RRN/content.xml"
    try:
        payload = _http_get_json(dataset_api)
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, json.JSONDecodeError):
        return default_url

    resources = payload.get("resources") if isinstance(payload, dict) else []
    if not isinstance(resources, list):
        return default_url

    for resource in resources:
        if not isinstance(resource, dict):
            continue
        candidate_url = str(resource.get("url") or "").strip()
        if not candidate_url:
            continue
        if "content.xml" in candidate_url:
            return candidate_url

    for resource in resources:
        if not isinstance(resource, dict):
            continue
        if str(resource.get("format") or "").lower() != "xml":
            continue
        candidate_url = str(resource.get("url") or "").strip()
        if candidate_url:
            return candidate_url

    return default_url


def _bison_comment_values(record: ET.Element, allowed_types: set[str] | None = None) -> list[str]:
    values: list[str] = []
    for comment in record.findall(".//{*}generalPublicComment"):
        comment_type = str(comment.findtext("{*}commentType", default="") or "").strip().lower()
        if allowed_types and comment_type and comment_type not in allowed_types:
            continue
        for value_node in comment.findall(".//{*}value"):
            text_value = str(value_node.text or "").strip()
            if text_value:
                values.append(text_value)
    return values


def _bison_datex_coordinates(record: ET.Element) -> tuple[float, float] | None:
    latitude_text = record.findtext(".//{*}pointCoordinates/{*}latitude")
    longitude_text = record.findtext(".//{*}pointCoordinates/{*}longitude")
    if latitude_text is None or longitude_text is None:
        return None
    try:
        latitude = float(latitude_text)
        longitude = float(longitude_text)
    except ValueError:
        return None
    if not _is_isere_coordinate(latitude, longitude):
        return None
    return (latitude, longitude)


def _bison_datex_severity(category: str, overall_severity: str) -> str:
    mapped = {
        "verylow": "vert",
        "low": "jaune",
        "medium": "orange",
        "high": "rouge",
        "veryhigh": "rouge",
    }.get((overall_severity or "").strip().lower())
    return mapped or _bison_event_severity(category)


def _bison_datex_first_text(record: ET.Element, *paths: str) -> str:
    for path in paths:
        value = str(record.findtext(path) or "").strip()
        if value:
            return value
    return ""


def _bison_datex_vehicle_restriction(record: ET.Element) -> str:
    groups = []
    for group in record.findall(".//{*}groupOfVehicles"):
        labels = [
            str(group.findtext("{*}vehicleType") or "").strip(),
            str(group.findtext("{*}vehicleEquipment") or "").strip(),
            str(group.findtext("{*}vehicleStatus") or "").strip(),
        ]
        text = ", ".join([label for label in labels if label])
        if text:
            groups.append(text)
    return " · ".join(groups)


def _bison_datex_location_summary(record: ET.Element) -> str:
    details = [
        _bison_datex_first_text(record, ".//{*}specificLocation"),
        _bison_datex_first_text(record, ".//{*}fromLocation/{*}descriptor/{*}values/{*}value"),
        _bison_datex_first_text(record, ".//{*}toLocation/{*}descriptor/{*}values/{*}value"),
    ]
    cleaned = [detail for detail in details if detail]
    return " → ".join(cleaned)


def _fetch_bison_fute_isere_live_events() -> dict[str, Any]:
    events_url = _bison_dataset_events_url()
    try:
        xml_payload = _http_get_text(events_url, timeout=18)
        root = ET.fromstring(xml_payload)
        publication_time = str(root.findtext(".//{*}publicationTime") or "").strip()
        situations = root.findall(".//{*}situation")

        events: list[dict[str, Any]] = []
        for situation in situations:
            overall_severity = str(situation.findtext("{*}overallSeverity") or "").strip().lower()
            situation_id = str(situation.attrib.get("id") or "").strip()
            records = situation.findall("{*}situationRecord")
            for record in records:
                coords = _bison_datex_coordinates(record)
                if not coords:
                    continue

                description_values = _bison_comment_values(record, {"description", "publiceventdescription"})
                location_values = _bison_comment_values(record, {"locationdescriptor"})
                road_label = str(record.findtext(".//{*}name/{*}descriptor/{*}values/{*}value") or "").strip()
                title = location_values[0] if location_values else (road_label or "Évènement trafic")
                description = " · ".join(description_values[:3])

                xsi_type = str(record.attrib.get("{http://www.w3.org/2001/XMLSchema-instance}type") or "")
                cause_type = str(record.findtext(".//{*}causeType") or "")
                category = _bison_event_category(f"{xsi_type} {cause_type} {title} {description}")
                event_id = str(record.attrib.get("id") or f"{situation_id}-{len(events)+1}" or f"bison-{len(events)+1}")
                validity_start = _bison_datex_first_text(record, ".//{*}overallStartTime")
                validity_end = _bison_datex_first_text(record, ".//{*}overallEndTime")
                direction = _bison_datex_first_text(record, ".//{*}affectedDirection")
                carriageway = _bison_datex_first_text(record, ".//{*}carriageway")
                lane_status = _bison_datex_first_text(record, ".//{*}laneStatus")
                mobility = _bison_datex_first_text(record, ".//{*}mobility")
                road_name = road_label or _bison_datex_first_text(record, ".//{*}roadNumber")
                location_summary = _bison_datex_location_summary(record)
                vehicle_restriction = _bison_datex_vehicle_restriction(record)
                mandatory = any((
                    str(record.findtext(".//{*}complianceOption") or "").strip().lower() in {"mandatory", "obligatory"},
                    str(record.findtext(".//{*}forVehiclesWithCharacteristicsOf/hazardousGoodsType") or "").strip(),
                ))

                events.append(
                    {
                        "id": event_id,
                        "title": title,
                        "description": description,
                        "category": category,
                        "severity": _bison_datex_severity(category, overall_severity),
                        "lat": coords[0],
                        "lon": coords[1],
                        "link": events_url,
                        "road": road_name,
                        "location_summary": location_summary,
                        "validity_start": validity_start,
                        "validity_end": validity_end,
                        "direction": direction,
                        "carriageway": carriageway,
                        "lane_status": lane_status,
                        "mobility": mobility,
                        "vehicle_restriction": vehicle_restriction,
                        "mandatory": mandatory,
                    }
                )

        return {
            "status": "online",
            "source": events_url,
            "events_total": len(events),
            "events": events[:120],
            "updated_at": publication_time or (datetime.utcnow().isoformat() + "Z"),
        }
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError, ET.ParseError) as exc:
        return {
            "status": "degraded",
            "source": events_url,
            "events_total": 0,
            "events": [],
            "error": str(exc),
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
            "live": _fetch_bison_fute_isere_live_events(),
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
            "live": _fetch_bison_fute_isere_live_events(),
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


def fetch_bison_fute_live_events(
    *,
    categories: list[str] | None = None,
    limit: int = 120,
    force_refresh: bool = False,
) -> dict[str, Any]:
    payload = fetch_bison_fute_traffic(force_refresh=force_refresh)
    live = deepcopy(payload.get("live") if isinstance(payload, dict) else {})
    events = live.get("events") if isinstance(live, dict) else []
    if not isinstance(events, list):
        events = []

    normalized_categories = {str(item or "").strip().lower() for item in (categories or []) if str(item or "").strip()}
    if normalized_categories:
        events = [event for event in events if str((event or {}).get("category") or "").lower() in normalized_categories]

    safe_limit = max(1, min(limit, 250))
    if len(events) > safe_limit:
        events = events[:safe_limit]

    if isinstance(live, dict):
        live["events"] = events
        live["events_total"] = len(events)
    else:
        live = {
            "status": "degraded",
            "events_total": len(events),
            "events": events,
        }

    live["categories"] = sorted({str((event or {}).get("category") or "info") for event in events})
    return live


def _fetch_aura_live_aircraft_raw() -> dict[str, Any]:
    source_adsbexchange = "https://globe.adsbexchange.com/"
    source_opensky = "https://opensky-network.org/api/states/all"
    bbox = {"lamin": 44.0, "lomin": 3.0, "lamax": 46.7, "lomax": 7.3}
    query = urlencode(bbox)

    try:
        payload = _http_get_json(f"{source_opensky}?{query}", timeout=14)
        states = payload.get("states") if isinstance(payload, dict) else []
        if not isinstance(states, list):
            states = []

        aircraft: list[dict[str, Any]] = []
        for row in states:
            if not isinstance(row, list) or len(row) < 14:
                continue
            lon = row[5]
            lat = row[6]
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                continue
            aircraft.append(
                {
                    "icao24": str(row[0] or "").strip(),
                    "callsign": str(row[1] or "").strip(),
                    "origin_country": str(row[2] or "").strip(),
                    "last_contact": row[4],
                    "lon": float(lon),
                    "lat": float(lat),
                    "baro_altitude_m": row[7],
                    "on_ground": bool(row[8]),
                    "velocity_ms": row[9],
                    "heading_deg": row[10],
                    "vertical_rate_ms": row[11],
                    "geo_altitude_m": row[13],
                }
            )

        return {
            "service": "Trafic aérien AURA",
            "status": "online",
            "source": source_adsbexchange,
            "provider": "OpenSky Network",
            "provider_source": source_opensky,
            "region": "Auvergne-Rhône-Alpes",
            "bbox": bbox,
            "aircraft_total": len(aircraft),
            "aircraft": aircraft,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (HTTPError, URLError, TimeoutError, RemoteDisconnected, ValueError, json.JSONDecodeError) as exc:
        return {
            "service": "Trafic aérien AURA",
            "status": "degraded",
            "source": source_adsbexchange,
            "provider": "OpenSky Network",
            "provider_source": source_opensky,
            "region": "Auvergne-Rhône-Alpes",
            "bbox": bbox,
            "aircraft_total": 0,
            "aircraft": [],
            "error": str(exc),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }


def fetch_aura_live_aircraft(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_aura_aircraft_cache,
        lock=_aura_aircraft_cache_lock,
        ttl_seconds=_AURA_AIRCRAFT_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_aura_live_aircraft_raw,
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


def _apic_level_from_raw(value: Any) -> str:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return "inconnu"
    if numeric <= 0:
        return "vert"
    if numeric == 1:
        return "jaune"
    if numeric >= 2:
        return "orange"
    return "inconnu"


def _fetch_apic_family_isere_live(mode: str, service_label: str) -> dict[str, Any]:
    base_url = f"https://apic.meteofrance.fr/static/carto/{mode}/fr"
    reseaux_url = f"{base_url}/{mode}_fr_reseaux.json"
    source_page = "https://apic.meteofrance.fr"
    try:
        reseaux_payload = _http_get_json(reseaux_url, timeout=16)
        reseaux = reseaux_payload.get("reseaux") if isinstance(reseaux_payload, dict) else []
        latest = reseaux[0] if isinstance(reseaux, list) and reseaux else {}
        latest_date = str(latest.get("date") or "").strip()
        if not latest_date:
            raise ValueError("Date réseau APIC/Vigicrues Flash introuvable")

        data_url = f"{base_url}/{mode}_fr_{latest_date}.json"
        payload = _http_get_json(data_url, timeout=16)
        deps = payload.get("deps") if isinstance(payload, dict) else {}
        grains = payload.get("grains") if isinstance(payload, dict) else {}
        troncons = payload.get("troncons") if isinstance(payload, dict) else {}

        dep38 = deps.get("38") if isinstance(deps, dict) else None
        dep38_level = _apic_level_from_raw((dep38 or {}).get("alert_level")) if isinstance(dep38, dict) else "vert"

        alerts: list[dict[str, Any]] = []
        if isinstance(dep38, dict) and dep38_level in {"jaune", "orange", "rouge"}:
            alerts.append(
                {
                    "zone": "Département Isère (38)",
                    "level": dep38_level,
                    "new_alerts": int(dep38.get("nb_new_alerts") or 0),
                }
            )

        if isinstance(grains, dict):
            for code, grain in grains.items():
                if not str(code).startswith("38") or not isinstance(grain, dict):
                    continue
                grain_level = _apic_level_from_raw(grain.get("alert_level"))
                if grain_level not in {"jaune", "orange", "rouge"}:
                    continue
                alerts.append(
                    {
                        "zone": f"Commune INSEE {code}",
                        "level": grain_level,
                        "first_alert_at": grain.get("date_frst_alrt") or "",
                        "last_change_at": grain.get("date_alrt_inc") or "",
                    }
                )

        if isinstance(troncons, dict):
            for code, troncon in troncons.items():
                if not isinstance(troncon, dict):
                    continue
                depts = str(troncon.get("depts") or troncon.get("dep") or "")
                if "38" not in depts:
                    continue
                troncon_level = _apic_level_from_raw(troncon.get("alert_level"))
                if troncon_level not in {"jaune", "orange", "rouge"}:
                    continue
                alerts.append(
                    {
                        "zone": str(troncon.get("name") or troncon.get("nom") or code),
                        "level": troncon_level,
                        "new_alerts": int(troncon.get("nb_new_alerts") or 0),
                    }
                )

        levels = [normalize_level(item.get("level") or "vert") for item in alerts]
        max_level = "rouge" if "rouge" in levels else "orange" if "orange" in levels else "jaune" if "jaune" in levels else "vert"

        return {
            "service": service_label,
            "department": "Isère (38)",
            "status": "online",
            "source": source_page,
            "source_reseaux": reseaux_url,
            "source_data": data_url,
            "network_date": latest_date,
            "network_date_label": latest.get("date_str") or "",
            "level": max_level,
            "alerts_total": len(alerts),
            "alerts": alerts[:20],
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError, TypeError) as exc:
        return {
            "service": service_label,
            "department": "Isère (38)",
            "status": "degraded",
            "source": source_page,
            "level": "inconnu",
            "alerts_total": 0,
            "alerts": [],
            "error": str(exc),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }


def fetch_apic_isere_alerts(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_apic_isere_cache,
        lock=_apic_isere_cache_lock,
        ttl_seconds=_APIC_ISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_apic_family_isere_live("apic", "APIC"),
    )


def fetch_vigicrues_flash_isere_alerts(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_vigicrues_flash_isere_cache,
        lock=_vigicrues_flash_isere_cache_lock,
        ttl_seconds=_VIGICRUES_FLASH_ISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_apic_family_isere_live("vf", "Vigicrues Flash"),
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

    content = list(first_page.get("content") or first_page.get("data") or [])
    total_pages = int(first_page.get("totalPages") or first_page.get("total_pages") or 1)
    current_page = int(first_page.get("pageNumber") or first_page.get("page") or 0)

    if page_config and total_pages > 1:
        _, page_key = page_config
        if current_page == 0:
            page_numbers = range(1, total_pages)
        else:
            page_numbers = range(current_page + 1, total_pages + 1)

        for page_number in page_numbers:
            selected_query[page_key] = page_number
            page_payload = _http_get_json(
                f"https://www.georisques.gouv.fr/api/v2/{endpoint}?{urlencode(selected_query, doseq=True)}",
                headers=headers,
            )
            content.extend(page_payload.get("content") or page_payload.get("data") or [])

    return {
        "total_elements": int(first_page.get("totalElements") or first_page.get("total_elements") or first_page.get("results") or len(content)),
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
        code = str(item.get("codeInsee") or item.get("code_insee") or "")
        if not code:
            continue
        year = str(item.get("anneePublication") or item.get("annee_publication") or "").strip()
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
            direct_url = (
                doc.get("urlDocument")
                or doc.get("url_document")
                or doc.get("lienDocument")
                or doc.get("lien_document")
                or None
            )
            monitored_flood_documents[code].append(
                {
                    "code": doc.get("idGaspar"),
                    "title": doc.get("libelle"),
                    "river_basin": doc.get("libBassinRisques"),
                    "published_at": (commune.get("aleas") or [{}])[0].get("dateDiffusion"),
                    "url": direct_url,
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
        center = _commune_center(code)
        latitude = center[0] if center else None
        longitude = center[1] if center else None
        monitored.append(
            {
                "name": name,
                "code_insee": code,
                "latitude": latitude,
                "longitude": longitude,
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
    gaspar_error = str(gaspar_payload.get("error") or "").strip()
    for commune in monitored:
        details = gaspar_by_code.get(commune.get("code_insee")) or {}
        commune["gaspar_risks"] = details.get("risks", [])
        commune["gaspar_risk_total"] = details.get("risk_total", 0)
        commune["gaspar_danger_level"] = details.get("danger_level", "Faible")
        detail_errors = details.get("errors") if isinstance(details, dict) else None
        if isinstance(detail_errors, list):
            commune["errors"].extend(str(err) for err in detail_errors if err)
        if gaspar_error:
            commune["errors"].append(f"GASPAR: {gaspar_error}")

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


def _fetch_anfr_isere_antennas_live() -> dict[str, Any]:
    dataset_id = "551d4ff3c751df55da0cd89f"
    source = "https://www.data.gouv.fr/fr/datasets/donnees-sur-les-installations-radioelectriques-de-plus-de-5-watts-1/"
    try:
        dataset = _http_get_json(f"https://www.data.gouv.fr/api/1/datasets/{dataset_id}/")
        resources = dataset.get("resources") or []
        candidates = [
            resource for resource in resources
            if "supports antennes" in str(resource.get("title") or "").lower() and str(resource.get("url") or "").startswith("http")
        ]
        if not candidates:
            raise ValueError("Aucune ressource ANFR exploitable")

        latest_resource = sorted(
            candidates,
            key=lambda item: str(item.get("last_modified") or item.get("created_at") or ""),
            reverse=True,
        )[0]

        archive_bytes = _http_get_with_retries(
            Request(str(latest_resource.get("url")), headers={"User-Agent": "ope-protec/1.0"}),
            timeout=80,
            retries=1,
            retry_delay_seconds=1.2,
        )
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            with archive.open("SUP_SUPPORT.txt") as handle:
                rows = handle.read().decode("latin-1", errors="ignore").splitlines()
            with archive.open("SUP_EMETTEUR.txt") as handle:
                emetteur_rows = handle.read().decode("latin-1", errors="ignore").splitlines()

        if not rows:
            raise ValueError("Archive ANFR vide")

        header = rows[0].split(";")
        insee_idx = header.index("COM_CD_INSEE") if "COM_CD_INSEE" in header else -1
        support_idx = header.index("SUP_ID") if "SUP_ID" in header else -1
        station_idx = header.index("STA_NM_ANFR") if "STA_NM_ANFR" in header else -1
        height_idx = header.index("SUP_NM_HAUT") if "SUP_NM_HAUT" in header else -1

        station_systems: dict[str, set[str]] = {}
        if emetteur_rows:
            emetteur_header = emetteur_rows[0].split(";")
            emetteur_station_idx = emetteur_header.index("STA_NM_ANFR") if "STA_NM_ANFR" in emetteur_header else -1
            emetteur_system_idx = emetteur_header.index("EMR_LB_SYSTEME") if "EMR_LB_SYSTEME" in emetteur_header else -1
            if emetteur_station_idx >= 0 and emetteur_system_idx >= 0:
                for emetteur_line in emetteur_rows[1:]:
                    values = emetteur_line.split(";")
                    if len(values) <= max(emetteur_station_idx, emetteur_system_idx):
                        continue
                    station = str(values[emetteur_station_idx] or "").strip()
                    system_label = str(values[emetteur_system_idx] or "").strip()
                    if not station or not system_label:
                        continue
                    station_systems.setdefault(station, set()).add(system_label)

        def _dms_to_decimal(deg: str | None, minute: str | None, second: str | None, direction: str | None) -> float | None:
            try:
                d = float(str(deg or "0").replace(",", "."))
                m = float(str(minute or "0").replace(",", "."))
                s = float(str(second or "0").replace(",", "."))
            except ValueError:
                return None
            value = d + (m / 60.0) + (s / 3600.0)
            cardinal = str(direction or "").strip().upper()
            if cardinal in {"S", "W", "O"}:
                value *= -1
            return round(value, 7)

        def _extract_data_services(labels: set[str]) -> list[str]:
            services: set[str] = set()
            for label in labels:
                lower = label.lower()
                if "5g" in lower or "nr" in lower:
                    services.add("5G")
                if "4g" in lower or "lte" in lower:
                    services.add("4G")
                if "3g" in lower or "umts" in lower:
                    services.add("3G")
                if "2g" in lower or "gsm" in lower:
                    services.add("2G")
            ordered = [item for item in ("2G", "3G", "4G", "5G") if item in services]
            return ordered

        lat_deg_idx = header.index("COR_NB_DG_LAT") if "COR_NB_DG_LAT" in header else -1
        lat_min_idx = header.index("COR_NB_MN_LAT") if "COR_NB_MN_LAT" in header else -1
        lat_sec_idx = header.index("COR_NB_SC_LAT") if "COR_NB_SC_LAT" in header else -1
        lat_dir_idx = header.index("COR_CD_NS_LAT") if "COR_CD_NS_LAT" in header else -1
        lon_deg_idx = header.index("COR_NB_DG_LON") if "COR_NB_DG_LON" in header else -1
        lon_min_idx = header.index("COR_NB_MN_LON") if "COR_NB_MN_LON" in header else -1
        lon_sec_idx = header.index("COR_NB_SC_LON") if "COR_NB_SC_LON" in header else -1
        lon_dir_idx = header.index("COR_CD_EW_LON") if "COR_CD_EW_LON" in header else -1

        supports: set[str] = set()
        stations: set[str] = set()
        heights: list[float] = []
        support_points: list[dict[str, Any]] = []
        seen_support_ids: set[str] = set()
        support_station_ids: dict[str, set[str]] = {}
        for line in rows[1:]:
            parts = line.split(";")
            support_id = ""
            if insee_idx < 0 or len(parts) <= insee_idx:
                continue
            insee_code = str(parts[insee_idx] or "").strip()
            if not insee_code.startswith("38"):
                continue
            if support_idx >= 0 and len(parts) > support_idx and parts[support_idx]:
                support_id = str(parts[support_idx]).strip()
                supports.add(support_id)
            if station_idx >= 0 and len(parts) > station_idx and parts[station_idx]:
                station_id = str(parts[station_idx]).strip()
                stations.add(station_id)
                if support_id:
                    support_station_ids.setdefault(support_id, set()).add(station_id)
            if height_idx >= 0 and len(parts) > height_idx:
                try:
                    heights.append(float(str(parts[height_idx]).replace(",", ".")))
                except ValueError:
                    pass

            if not support_id or support_id in seen_support_ids:
                continue

            if min(lat_deg_idx, lat_min_idx, lat_sec_idx, lat_dir_idx, lon_deg_idx, lon_min_idx, lon_sec_idx, lon_dir_idx) < 0:
                continue
            if len(parts) <= max(lat_deg_idx, lat_min_idx, lat_sec_idx, lat_dir_idx, lon_deg_idx, lon_min_idx, lon_sec_idx, lon_dir_idx):
                continue

            lat = _dms_to_decimal(parts[lat_deg_idx], parts[lat_min_idx], parts[lat_sec_idx], parts[lat_dir_idx])
            lon = _dms_to_decimal(parts[lon_deg_idx], parts[lon_min_idx], parts[lon_sec_idx], parts[lon_dir_idx])
            if lat is None or lon is None:
                continue

            station_name = str(parts[station_idx]).strip() if station_idx >= 0 and len(parts) > station_idx else ""
            systems = set()
            for station_ref in support_station_ids.get(support_id, set()):
                systems.update(station_systems.get(station_ref, set()))
            data_services = _extract_data_services(systems)

            support_points.append({
                "id": support_id,
                "lat": lat,
                "lon": lon,
                "station_name": station_name,
                "operator": "non renseigné (ANFR)",
                "voice_service": "possible" if systems else "inconnu",
                "data_services": data_services,
            })
            seen_support_ids.add(support_id)

        avg_height = round(sum(heights) / len(heights), 1) if heights else None
        return {
            "service": "ANFR",
            "status": "online",
            "source": source,
            "department": "Isère (38)",
            "supports_total": len(supports),
            "stations_total": len(stations),
            "average_support_height_m": avg_height,
            "supports_points": support_points,
            "data_release": latest_resource.get("title") or "publication mensuelle",
            "resource_updated_at": latest_resource.get("last_modified") or latest_resource.get("created_at"),
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "error": None,
        }
    except Exception as exc:
        return {
            "service": "ANFR",
            "status": "degraded",
            "source": source,
            "department": "Isère (38)",
            "supports_total": 0,
            "stations_total": 0,
            "average_support_height_m": None,
            "supports_points": [],
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "error": str(exc),
        }


def _fetch_arcep_isere_mobile_outages_live() -> dict[str, Any]:
    dataset_id = "5f7c7fae9cd6c79b58da3e20"
    source = "https://www.data.gouv.fr/fr/datasets/sites-indisponibles/"
    try:
        dataset = _http_get_json(f"https://www.data.gouv.fr/api/1/datasets/{dataset_id}/")
        resources = dataset.get("resources") or []
        candidates = [resource for resource in resources if str(resource.get("url") or "").endswith(".geojson")]
        if not candidates:
            raise ValueError("Aucune ressource ARCEP GeoJSON")

        latest_resource = sorted(
            candidates,
            key=lambda item: str(item.get("title") or ""),
            reverse=True,
        )[0]
        payload = _http_get_json(str(latest_resource.get("url")), timeout=45)
        features = payload.get("features") or []

        isere_features: list[dict[str, Any]] = []
        for feature in features:
            props = feature.get("properties") or {}
            dept = str(props.get("departement") or "").strip()
            if dept == "38":
                geometry = feature.get("geometry") or {}
                coords = geometry.get("coordinates") if geometry.get("type") == "Point" else None
                if isinstance(coords, list) and len(coords) >= 2:
                    props = {**props, "lon": coords[0], "lat": coords[1]}
                isere_features.append(props)

        operator_counts: dict[str, int] = {}
        communes: set[str] = set()
        data_impacted = 0
        voice_impacted = 0
        for props in isere_features:
            operator = str(props.get("operateur") or "inconnu")
            operator_counts[operator] = operator_counts.get(operator, 0) + 1
            commune = str(props.get("commune") or "").strip()
            if commune:
                communes.add(commune)
            if str(props.get("data") or "").upper() == "HS":
                data_impacted += 1
            if str(props.get("voix") or "").upper() == "HS":
                voice_impacted += 1

        outages_points = []
        for props in isere_features:
            lat = props.get("lat")
            lon = props.get("lon")
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                continue
            outages_points.append({
                "id": str(props.get("id") or props.get("gid") or f"{props.get('commune', 'site')}-{props.get('operateur', 'operateur')}-{len(outages_points)+1}"),
                "lat": round(float(lat), 7),
                "lon": round(float(lon), 7),
                "commune": str(props.get("commune") or "").strip(),
                "operator": str(props.get("operateur") or "inconnu"),
                "voice": str(props.get("voix") or "").strip(),
                "data": str(props.get("data") or "").strip(),
            })

        top_operators = [
            {"operator": name, "outages": count}
            for name, count in sorted(operator_counts.items(), key=lambda item: item[1], reverse=True)[:4]
        ]

        level = "vert"
        if len(isere_features) >= 25:
            level = "orange"
        elif len(isere_features) >= 8:
            level = "jaune"

        return {
            "service": "ARCEP",
            "status": "online",
            "source": source,
            "department": "Isère (38)",
            "level": level,
            "outages_total": len(isere_features),
            "communes_total": len(communes),
            "voice_impacted_total": voice_impacted,
            "data_impacted_total": data_impacted,
            "outages_points": outages_points,
            "top_operators": top_operators,
            "resource_date": latest_resource.get("title"),
            "resource_updated_at": latest_resource.get("last_modified") or latest_resource.get("created_at"),
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "error": None,
        }
    except Exception as exc:
        return {
            "service": "ARCEP",
            "status": "degraded",
            "source": source,
            "department": "Isère (38)",
            "level": "inconnu",
            "outages_total": 0,
            "communes_total": 0,
            "voice_impacted_total": 0,
            "data_impacted_total": 0,
            "outages_points": [],
            "top_operators": [],
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "error": str(exc),
        }


def fetch_anfr_isere_antennas(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_anfr_isere_cache,
        lock=_anfr_isere_cache_lock,
        ttl_seconds=_ANFR_ISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_anfr_isere_antennas_live,
    )


def fetch_arcep_isere_mobile_outages(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_arcep_isere_cache,
        lock=_arcep_isere_cache_lock,
        ttl_seconds=_ARCEP_ISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_arcep_isere_mobile_outages_live,
    )


def _groundwater_trend(current: dict[str, Any], previous: dict[str, Any] | None) -> str:
    if not previous:
        return "stable"
    try:
        current_level = float(current.get("niveau_nappe_eau"))
        previous_level = float(previous.get("niveau_nappe_eau"))
    except (TypeError, ValueError):
        return "stable"

    delta = current_level - previous_level
    if delta > 0.03:
        return "hausse"
    if delta < -0.03:
        return "baisse"
    return "stable"


def _fetch_hubeau_isere_groundwater_live(station_limit: int = 8) -> dict[str, Any]:
    stations_url = f"https://hubeau.eaufrance.fr/api/v1/niveaux_nappes/stations?code_departement=38&size={max(5, min(station_limit, 30))}"
    stations_payload = _http_get_json(stations_url, timeout=18)
    stations = stations_payload.get("data") if isinstance(stations_payload, dict) else []
    if not isinstance(stations, list) or not stations:
        return {
            "status": "degraded",
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "source": stations_url,
            "error": "Aucune station piézométrique renvoyée pour l'Isère",
            "stations": [],
            "stations_total": 0,
            "trend_summary": {"hausse": 0, "baisse": 0, "stable": 0},
        }

    prioritized = sorted(
        [row for row in stations if isinstance(row, dict)],
        key=lambda row: str(row.get("date_fin_mesure") or ""),
        reverse=True,
    )

    station_rows: list[dict[str, Any]] = []
    trend_summary = {"hausse": 0, "baisse": 0, "stable": 0}
    for station in prioritized[: max(3, min(station_limit, 20))]:
        code_bss = str(station.get("code_bss") or "").strip()
        if not code_bss:
            continue

        chronicles_url = f"https://hubeau.eaufrance.fr/api/v1/niveaux_nappes/chroniques?code_bss={quote_plus(code_bss)}&size=2&sort=desc"
        chronicles_payload = _http_get_json(chronicles_url, timeout=18)
        chroniques = chronicles_payload.get("data") if isinstance(chronicles_payload, dict) else []
        if not isinstance(chroniques, list) or not chroniques:
            continue

        current = chroniques[0] if isinstance(chroniques[0], dict) else {}
        previous = chroniques[1] if len(chroniques) > 1 and isinstance(chroniques[1], dict) else None
        trend = _groundwater_trend(current, previous)
        trend_summary[trend] += 1

        station_rows.append(
            {
                "code_bss": code_bss,
                "name": station.get("libelle_pe") or station.get("nom_commune") or code_bss,
                "commune": station.get("nom_commune"),
                "insee_code": station.get("code_commune_insee"),
                "date_measure": current.get("date_mesure"),
                "groundwater_level_m_ngf": current.get("niveau_nappe_eau"),
                "depth_m": current.get("profondeur_nappe"),
                "trend": trend,
                "source": chronicles_url,
            }
        )

    if not station_rows:
        return {
            "status": "degraded",
            "updated_at": datetime.utcnow().isoformat() + "Z",
            "source": stations_url,
            "error": "Aucune chronique piézométrique exploitable pour les stations Isère",
            "stations": [],
            "stations_total": 0,
            "trend_summary": trend_summary,
        }

    return {
        "status": "online",
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "source": "https://hubeau.eaufrance.fr/api/v1/niveaux_nappes",
        "stations_total": len(station_rows),
        "trend_summary": trend_summary,
        "stations": station_rows,
    }


def fetch_hubeau_isere_groundwater(force_refresh: bool = False, station_limit: int = 8) -> dict[str, Any]:
    safe_limit = max(3, min(station_limit, 20))

    def loader() -> dict[str, Any]:
        return _fetch_hubeau_isere_groundwater_live(station_limit=safe_limit)

    return _cached_external_payload(
        cache=_hubeau_groundwater_cache,
        lock=_hubeau_groundwater_cache_lock,
        ttl_seconds=_HUBEAU_GROUNDWATER_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=loader,
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
