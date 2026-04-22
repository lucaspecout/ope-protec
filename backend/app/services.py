from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
from datetime import datetime, timedelta
from copy import deepcopy
import io
from email.utils import parsedate_to_datetime
from html import unescape
from http.client import RemoteDisconnected, IncompleteRead
import requests as _requests
import json
from pathlib import Path
import re
import ssl
import unicodedata
from random import uniform
from time import sleep
from threading import Lock, Thread
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus, unquote, urlencode, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
import zipfile

import warnings as _warnings
# Supprimer les avertissements de version urllib3/requests (conflit de packaging)
_warnings.filterwarnings("ignore", message="urllib3.*doesn't match a supported version", category=Warning)
_warnings.filterwarnings("ignore", message="charset_normalizer.*doesn't match", category=Warning)
# Supprimer les avertissements SSL pour les hôtes externes sans cert valide
try:
    import urllib3 as _urllib3
    _urllib3.disable_warnings(_urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass

try:
    import requests as _requests
    _REQUESTS_OK = True
except ImportError:
    _requests = None  # type: ignore[assignment]
    _REQUESTS_OK = False

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from sqlalchemy import delete
from sqlalchemy.orm import Session

import redis as _redis_lib

from .config import settings
from .database import SessionLocal
from .models import Municipality, OperationalLog, WeatherAlert

# ---------------------------------------------------------------------------
# Cache fichier JSON – persistance sur volume Docker (/data/static)
# ---------------------------------------------------------------------------

def _static_data_path(filename: str) -> Path:
    """Retourne le chemin absolu d'un fichier de cache statique."""
    d = Path(settings.static_data_dir)
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return d / filename


def _file_cache_load(filename: str) -> dict[str, Any] | None:
    """Charge un fichier JSON de cache statique. Retourne None si absent ou corrompu."""
    try:
        p = _static_data_path(filename)
        if not p.exists():
            return None
        with p.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _file_cache_save(filename: str, data: dict[str, Any]) -> None:
    """Écrit un fichier JSON de cache statique de façon atomique (écriture temp + rename)."""
    try:
        p = _static_data_path(filename)
        tmp = p.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, default=str)
        tmp.replace(p)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Cache Redis partagé entre tous les workers gunicorn
# ---------------------------------------------------------------------------
try:
    _redis: _redis_lib.Redis = _redis_lib.from_url(settings.redis_url, decode_responses=True, socket_connect_timeout=2)
    _redis.ping()
    _REDIS_OK = True
except Exception:
    _redis = None  # type: ignore[assignment]
    _REDIS_OK = False

_REDIS_KEY_PREFIX = "svc:"


def _redis_get(key: str) -> dict[str, Any] | None:
    if not _REDIS_OK or _redis is None:
        return None
    try:
        raw = _redis.get(_REDIS_KEY_PREFIX + key)
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _redis_set(key: str, data: dict[str, Any], ttl_seconds: int) -> None:
    if not _REDIS_OK or _redis is None:
        return
    try:
        _redis.setex(_REDIS_KEY_PREFIX + key, ttl_seconds, json.dumps(data, default=str))
    except Exception:
        pass


def _redis_delete(key: str) -> None:
    if not _REDIS_OK or _redis is None:
        return
    try:
        _redis.delete(_REDIS_KEY_PREFIX + key)
    except Exception:
        pass


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
    if isinstance(exc, (RemoteDisconnected, IncompleteRead)):
        return True
    if isinstance(exc, URLError):
        reason = str(exc.reason).lower() if getattr(exc, "reason", None) is not None else ""
        return any(token in reason for token in ("timed out", "timeout", "temporary", "reset", "refused", "unreachable"))
    return False


def _make_permissive_ssl_context() -> ssl.SSLContext:
    """Contexte SSL assoupli pour les serveurs gouv avec config TLS stricte.
    Maintient la vérification des certificats mais élargit les suites de chiffrement."""
    ctx = ssl.create_default_context()
    ctx.set_ciphers("DEFAULT:@SECLEVEL=1")
    return ctx


def _make_legacy_ssl_context() -> ssl.SSLContext:
    """Contexte SSL pour serveurs avec TLS legacy (ex. opendata.isere.fr).
    - Désactive la vérification de certificat
    - Force TLS 1.2 exactement (min=max=TLS1.2) pour éviter TLSV1_ALERT_INTERNAL_ERROR
    - Autorise la renégociation legacy (OpenSSL 3.0+)
    - SECLEVEL=0 + suites larges pour accepter les chiffrement faibles des vieux serveurs"""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    ctx.set_ciphers("ALL:@SECLEVEL=0")
    try:
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.maximum_version = ssl.TLSVersion.TLSv1_2
    except AttributeError:
        pass
    legacy_flag = getattr(ssl, "OP_LEGACY_SERVER_CONNECT", 0)
    if legacy_flag:
        ctx.options |= legacy_flag
    no_tls13_flag = getattr(ssl, "OP_NO_TLSv1_3", 0)
    if no_tls13_flag:
        ctx.options |= no_tls13_flag
    return ctx


class _TLS12Adapter(_requests.adapters.HTTPAdapter):
    """HTTPAdapter qui force TLS 1.2 exactement + SECLEVEL=0.
    Nécessaire pour les serveurs gouv (opendata.isere.fr) qui rejettent TLS 1.3
    avec TLSV1_ALERT_INTERNAL_ERROR depuis Docker/Linux OpenSSL 3.x."""
    def init_poolmanager(self, *args: Any, **kwargs: Any) -> None:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.set_ciphers("ALL:@SECLEVEL=0")
        try:
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.maximum_version = ssl.TLSVersion.TLSv1_2
        except AttributeError:
            pass
        legacy_flag = getattr(ssl, "OP_LEGACY_SERVER_CONNECT", 0)
        if legacy_flag:
            ctx.options |= legacy_flag
        no_tls13_flag = getattr(ssl, "OP_NO_TLSv1_3", 0)
        if no_tls13_flag:
            ctx.options |= no_tls13_flag
        kwargs["ssl_context"] = ctx
        super().init_poolmanager(*args, **kwargs)  # type: ignore[misc]


def _requests_get_tls12(url: str, *, headers: dict[str, str] | None = None, timeout: int = 15) -> Any:
    """GET via requests en forçant TLS 1.2 max. Pour serveurs legacy gouv."""
    session = _requests.Session()
    session.mount("https://", _TLS12Adapter())
    resp = session.get(url, headers=headers or {}, timeout=timeout, verify=False)
    resp.raise_for_status()
    return resp


def _http_get_with_retries(
    request: Request,
    timeout: int = 8,
    retries: int = 1,
    retry_delay_seconds: float = 0.5,
    ssl_context: ssl.SSLContext | None = None,
    chunk_size: int = 1024 * 1024,
) -> bytes:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urlopen(request, timeout=timeout, context=ssl_context) as response:
                chunks: list[bytes] = []
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    chunks.append(chunk)
                return b"".join(chunks)
        except (HTTPError, URLError, TimeoutError, RemoteDisconnected, IncompleteRead) as exc:
            last_error = exc
            if attempt >= retries or not _is_retryable_network_error(exc):
                raise
            backoff = retry_delay_seconds * (2 ** attempt)
            sleep(backoff + uniform(0, 0.35))
    raise last_error or RuntimeError("Échec HTTP inattendu")


def _http_stream_large_file(url: str, timeout: int = 120, retries: int = 3, headers: dict[str, str] | None = None) -> bytes:
    request_headers = {"User-Agent": "ope-protec/1.0"}
    if headers:
        request_headers.update(headers)
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with _requests.get(url, headers=request_headers, stream=True, timeout=timeout) as resp:
                resp.raise_for_status()
                chunks: list[bytes] = []
                for chunk in resp.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        chunks.append(chunk)
                return b"".join(chunks)
        except Exception as exc:
            last_error = exc
            if attempt >= retries:
                raise
            backoff = 2.0 * (2 ** attempt) + uniform(0, 0.5)
            sleep(backoff)
    raise last_error or RuntimeError("Échec téléchargement fichier volumineux")


def _http_get_json(url: str, timeout: int = 12, headers: dict[str, str] | None = None, ssl_context: ssl.SSLContext | None = None) -> Any:
    request_headers = {"User-Agent": "ope-protec/1.0", "Connection": "keep-alive"}
    if headers:
        request_headers.update(headers)
    request = Request(url, headers=request_headers)
    payload = _http_get_with_retries(request=request, timeout=timeout, ssl_context=ssl_context)
    return json.loads(payload.decode("utf-8"))


def _http_get_text(url: str, timeout: int = 12, ssl_context: ssl.SSLContext | None = None, retries: int = 1, headers: dict[str, str] | None = None) -> str:
    default_headers: dict[str, str] = {"User-Agent": "ope-protec/1.0", "Connection": "keep-alive"}
    if headers:
        default_headers.update(headers)
    request = Request(url, headers=default_headers)
    payload = _http_get_with_retries(request=request, timeout=timeout, ssl_context=ssl_context, retries=retries)
    return payload.decode("utf-8", errors="ignore")


_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


def _http_get_text_quick(url: str, timeout: int = 8) -> str:
    """Scraping rapide sans retry, User-Agent navigateur. Pour sites tiers peu fiables."""
    request = Request(url, headers={
        "User-Agent": _BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Connection": "keep-alive",
    })
    payload = _http_get_with_retries(request=request, timeout=timeout, retries=0)
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
_meteo_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "meteo_france"}

_VIGICRUES_CACHE_TTL_SECONDS = 300
_ITINISERE_CACHE_TTL_SECONDS = 180
_BISON_CACHE_TTL_SECONDS = 600
_GEORISQUES_CACHE_TTL_SECONDS = 900
_PREFECTURE_CACHE_TTL_SECONDS = 120
_DAUPHINE_CACHE_TTL_SECONDS = 300
_VIGIEAU_CACHE_TTL_SECONDS = 900
_ATMO_AURA_CACHE_TTL_SECONDS = 900
_SNCF_ISERE_CACHE_TTL_SECONDS = 180
_RTE_ELECTRICITY_CACHE_TTL_SECONDS = 1800  # Ecowatt = signal journalier ; 30 min pour récupérer les vraies données sans surcharger l'API
_FINESS_ISERE_CACHE_TTL_SECONDS = 43200
_FINESS_ISERE_MAX_LIMIT = 20000
_FINESS_ISERE_STABLE_CSV_URL = "https://static.data.gouv.fr/resources/finess-extraction-du-fichier-des-etablissements/20260312-094547/etalab-cs1100507-stock-20260311-0343.csv"
_ISERE_OPENDATA_CACHE_TTL_SECONDS = 1800
_ANFR_ISERE_CACHE_TTL_SECONDS = 43200
_ARCEP_ISERE_CACHE_TTL_SECONDS = 900
_HUBEAU_GROUNDWATER_CACHE_TTL_SECONDS = 10800
_APIC_ISERE_CACHE_TTL_SECONDS = 300
_VIGICRUES_FLASH_ISERE_CACHE_TTL_SECONDS = 300
_ISERE_BOUNDARY_CACHE_TTL_SECONDS = 21600
_AURA_AIRCRAFT_CACHE_TTL_SECONDS = 45

_vigicrues_cache_lock = Lock()
_vigicrues_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "vigicrues"}
_itinisere_cache_lock = Lock()
_itinisere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "itinisere"}
_bison_cache_lock = Lock()
_bison_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "bison_fute"}
_isere_boundary_cache_lock = Lock()
_isere_boundary_cache: dict[str, Any] = {"geometry": None, "expires_at": datetime.min}
_georisques_cache_lock = Lock()
_georisques_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "georisques"}
_prefecture_cache_lock = Lock()
_prefecture_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "prefecture"}
_dauphine_cache_lock = Lock()
_dauphine_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "dauphine"}
_FRANCE_BLEU_ISERE_CACHE_TTL_SECONDS = 300
_france_bleu_cache_lock = Lock()
_france_bleu_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "france_bleu_isere", "max_stale_hours": 4}
_PLACEGRENET_CACHE_TTL_SECONDS = 300
_placegrenet_cache_lock = Lock()
_placegrenet_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "placegrenet"}
_GRENOBLE_METRO_CACHE_TTL_SECONDS = 300
_grenoble_metro_cache_lock = Lock()
_grenoble_metro_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "grenoble_metro"}
_ARS_AURA_CACHE_TTL_SECONDS = 300
_ars_aura_cache_lock = Lock()
_ars_aura_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "ars_aura"}
_SEISMES_ISERE_CACHE_TTL_SECONDS = 600
_seismes_isere_cache_lock = Lock()
_seismes_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "seismes_isere"}
_vigieau_cache_lock = Lock()
_vigieau_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "vigieau"}
_atmo_aura_cache_lock = Lock()
_atmo_aura_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "atmo_aura"}
_sncf_isere_cache_lock = Lock()
_sncf_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "sncf_isere"}
_rte_electricity_cache_lock = Lock()
_rte_electricity_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "rte_electricity"}
# Cache des tokens OAuth2 RTE (valides ~2h, on les renouvelle 5min avant expiry)
_rte_oauth_tokens: dict[str, dict[str, Any]] = {}
_rte_oauth_lock = Lock()
_finess_isere_cache_lock = Lock()
_finess_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "finess_isere"}
_finess_isere_communes_lock = Lock()
_finess_isere_communes_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}


_institutions_isere_cache_lock = Lock()
_institutions_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_INSTITUTIONS_ISERE_CACHE_TTL_SECONDS = 86400  # 24h

_INSTITUTIONS_ISERE_BBOX = "44.70,4.70,45.95,6.60"

# Requête Overpass bbox Isère — nodes uniquement (rapide, couvre ~95% des établissements)
# On récupère aussi les ways/relations pour les bâtiments importants (gares, stades…)
_INSTITUTIONS_CRITICAL_QUERY = f"""[out:json][timeout:60];
(
  node["amenity"="school"]({_INSTITUTIONS_ISERE_BBOX});
  node["amenity"="college"]({_INSTITUTIONS_ISERE_BBOX});
  node["amenity"="university"]({_INSTITUTIONS_ISERE_BBOX});
  node["amenity"="kindergarten"]({_INSTITUTIONS_ISERE_BBOX});
  node["amenity"="police"]({_INSTITUTIONS_ISERE_BBOX});
  node["amenity"="fire_station"]({_INSTITUTIONS_ISERE_BBOX});
  node["amenity"="bus_station"]({_INSTITUTIONS_ISERE_BBOX});
  node["railway"="station"]({_INSTITUTIONS_ISERE_BBOX});
  node["aeroway"~"aerodrome|airport"]({_INSTITUTIONS_ISERE_BBOX});
  way["amenity"~"school|college|university|police|fire_station"]({_INSTITUTIONS_ISERE_BBOX});
  way["railway"="station"]({_INSTITUTIONS_ISERE_BBOX});
);
out center tags;"""

# Requête Overpass bbox Isère — équipements hébergement/accueil
_INSTITUTIONS_FACILITIES_QUERY = f"""[out:json][timeout:90];
(
  node["amenity"~"community_centre|arts_centre|theatre|cinema|concert_hall|events_venue|convention_centre|conference_centre|social_facility"]({_INSTITUTIONS_ISERE_BBOX});
  node["leisure"~"sports_hall|sports_centre|stadium|ice_rink|arena"]({_INSTITUTIONS_ISERE_BBOX});
  node["building"~"gymnasium|sports_hall|civic|hall"]({_INSTITUTIONS_ISERE_BBOX});
  node["amenity"="gym"]({_INSTITUTIONS_ISERE_BBOX});
  way["amenity"~"community_centre|theatre|cinema|social_facility|conference_centre|convention_centre"]({_INSTITUTIONS_ISERE_BBOX});
  way["leisure"~"sports_hall|sports_centre|stadium|ice_rink|arena"]({_INSTITUTIONS_ISERE_BBOX});
  way["building"~"gymnasium|sports_hall|civic|hall"]({_INSTITUTIONS_ISERE_BBOX});
  relation["leisure"~"sports_hall|stadium"]({_INSTITUTIONS_ISERE_BBOX});
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
    sport = str(tags.get("sport") or "").lower()

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
    if amenity in ("convention_centre", "conference_centre"):
        return "palais_congres"
    # Gymnases : plusieurs tags possibles en France
    if (
        leisure in ("sports_hall", "sports_centre", "arena", "ice_rink")
        or building in ("sports_hall", "gymnasium")
        or amenity == "gym"
        or any(kw in name for kw in ("gymnase", "salle sport", "complexe sport", "piscine", "patinoire"))
    ):
        return "gymnase"
    if leisure == "stadium" or building == "stadium" or "stade" in name:
        return "stade"
    if amenity in ("community_centre", "arts_centre", "social_facility") or building in ("civic", "hall"):
        if any(token in name for token in ("foyer", "polyvalent", "fête", "fetes", "salle", "maison du peuple", "espace")):
            return "salle_fetes"
        return "centre_culturel"
    return None


_OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
]

def _overpass_fetch_institutions(query: str) -> list[dict]:
    import json as _json
    for endpoint in _OVERPASS_ENDPOINTS:
        try:
            req = Request(
                endpoint,
                data=query.encode("utf-8"),
                headers={"Content-Type": "text/plain;charset=UTF-8"},
                method="POST",
            )
            with urlopen(req, timeout=120) as resp:
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
        # Bbox Isère stricte (double-sécurité après le filtre area Overpass)
        if not (44.70 <= lat <= 45.95 and 4.70 <= lon <= 6.60):
            continue
        # Rejet si le code postal est renseigné et ne commence pas par 38
        postcode = str(tags.get("addr:postcode") or "").strip()
        if postcode and not postcode.startswith("38"):
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

    if not points:
        raise RuntimeError("Overpass n'a retourné aucun établissement pour l'Isère")
    return {
        "status": "online",
        "count": len(points),
        "points": points,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


_INSTITUTIONS_DB_REFRESH_DAYS = 7  # Rafraîchissement hebdomadaire
_institutions_bg_refresh_running = False
_institutions_bg_refresh_lock = Lock()


def _institutions_save_to_db(points: list[dict[str, Any]]) -> None:
    """Upsert les points dans la DB — ne supprime jamais les existants."""
    from .models import InstitutionPoint
    try:
        db = SessionLocal()
        try:
            now = datetime.utcnow()
            for p in points:
                existing = db.get(InstitutionPoint, p["id"])
                if existing:
                    existing.name = p["name"]
                    existing.type = p["type"]
                    existing.lat = p["lat"]
                    existing.lon = p["lon"]
                    existing.address = p["address"]
                    existing.priority = p["priority"]
                    existing.info = p["info"]
                    existing.source = p["source"]
                    existing.updated_at = now
                else:
                    db.add(InstitutionPoint(
                        osm_id=p["id"],
                        name=p["name"],
                        type=p["type"],
                        lat=p["lat"],
                        lon=p["lon"],
                        address=p["address"],
                        priority=p["priority"],
                        info=p["info"],
                        source=p["source"],
                        updated_at=now,
                    ))
            db.commit()
        finally:
            db.close()
    except Exception:
        pass


def _institutions_load_from_db() -> list[dict[str, Any]] | None:
    """Charge les points depuis la DB. Retourne None si vide."""
    from .models import InstitutionPoint
    try:
        db = SessionLocal()
        try:
            rows = db.query(InstitutionPoint).all()
            if not rows:
                return None
            return [
                {
                    "id": r.osm_id,
                    "name": r.name,
                    "type": r.type,
                    "lat": r.lat,
                    "lon": r.lon,
                    "active": True,
                    "address": r.address,
                    "priority": r.priority,
                    "info": r.info,
                    "source": r.source,
                    "dynamic": True,
                    "updated_at": r.updated_at.isoformat() + "Z" if r.updated_at else None,
                }
                for r in rows
            ]
        finally:
            db.close()
    except Exception:
        return None


def _institutions_bg_refresh() -> None:
    """Récupère les données Overpass en arrière-plan et met à jour la DB (sans effacer)."""
    global _institutions_bg_refresh_running
    with _institutions_bg_refresh_lock:
        if _institutions_bg_refresh_running:
            return
        _institutions_bg_refresh_running = True
    try:
        live = _fetch_institutions_isere_live()
        points = live.get("points") or []
        if points:
            _institutions_save_to_db(points)
            # Mettre aussi à jour le cache mémoire
            with _institutions_isere_cache_lock:
                _institutions_isere_cache["payload"] = live
                _institutions_isere_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_INSTITUTIONS_ISERE_CACHE_TTL_SECONDS)
    except Exception:
        pass
    finally:
        _institutions_bg_refresh_running = False


_INSTITUTIONS_FILE = "institutions_isere.json"


def fetch_institutions_isere(force_refresh: bool = False) -> dict[str, Any]:
    """
    Stratégie :
    1. Cache mémoire (expire en 24h)
    2. Fichier JSON sur volume Docker  (/data/static/institutions_isere.json) — toujours disponible
    3. DB PostgreSQL (persistant, mis à jour 1x/semaine en arrière-plan)
    4. Si fichier et DB vides → fetch Overpass immédiat + sauvegarde fichier + DB
    """
    # 1. Cache mémoire
    with _institutions_isere_cache_lock:
        if not force_refresh and _institutions_isere_cache["payload"] and datetime.utcnow() < _institutions_isere_cache["expires_at"]:
            return _institutions_isere_cache["payload"]

    # 2. Fichier JSON (lecture ultra-rapide, indépendant de la DB et d'Overpass)
    if not force_refresh:
        file_data = _file_cache_load(_INSTITUTIONS_FILE)
        if file_data and file_data.get("points"):
            result = file_data
            with _institutions_isere_cache_lock:
                _institutions_isere_cache["payload"] = result
                _institutions_isere_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_INSTITUTIONS_ISERE_CACHE_TTL_SECONDS)
            # Vérifier si le fichier est trop vieux (> 30 jours) → refresh en arrière-plan
            try:
                updated_at = result.get("updated_at") or ""
                age_days = (datetime.utcnow() - datetime.fromisoformat(updated_at.rstrip("Z"))).days if updated_at else 999
                if age_days >= 30:
                    Thread(target=_institutions_bg_refresh, daemon=True).start()
            except Exception:
                pass
            return result

    # 3. DB PostgreSQL
    db_points = _institutions_load_from_db()
    if db_points:
        oldest = min((p.get("updated_at") or "") for p in db_points) if db_points else ""
        needs_refresh = force_refresh
        if oldest:
            try:
                age_days = (datetime.utcnow() - datetime.fromisoformat(oldest.rstrip("Z"))).days
                if age_days >= _INSTITUTIONS_DB_REFRESH_DAYS:
                    needs_refresh = True
            except Exception:
                pass
        if needs_refresh:
            Thread(target=_institutions_bg_refresh, daemon=True).start()

        result = {
            "status": "online",
            "count": len(db_points),
            "points": db_points,
            "updated_at": db_points[0].get("updated_at") if db_points else datetime.utcnow().isoformat() + "Z",
        }
        # Sauvegarder dans le fichier pour les prochains démarrages
        _file_cache_save(_INSTITUTIONS_FILE, result)
        with _institutions_isere_cache_lock:
            _institutions_isere_cache["payload"] = result
            _institutions_isere_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_INSTITUTIONS_ISERE_CACHE_TTL_SECONDS)
        return result

    # 4. Fichier et DB vides → fetch Overpass + sauvegarde
    live = _fetch_institutions_isere_live()
    points = live.get("points") or []
    if points:
        _institutions_save_to_db(points)
        _file_cache_save(_INSTITUTIONS_FILE, live)
    with _institutions_isere_cache_lock:
        _institutions_isere_cache["payload"] = live
        _institutions_isere_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_INSTITUTIONS_ISERE_CACHE_TTL_SECONDS)
    return live


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
_isere_opendata_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "isere_opendata"}
_anfr_isere_cache_lock = Lock()
_anfr_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "anfr_isere"}
_arcep_isere_cache_lock = Lock()
_arcep_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "arcep_isere"}
_hubeau_groundwater_cache_lock = Lock()
_hubeau_groundwater_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "hubeau_groundwater"}
_AVALANCHE_ISERE_CACHE_TTL_SECONDS = 1800
_avalanche_isere_cache_lock = Lock()
_avalanche_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "avalanche_isere"}
_apic_isere_cache_lock = Lock()
_apic_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "apic_isere"}
_vigicrues_flash_isere_cache_lock = Lock()
_vigicrues_flash_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "vigicrues_flash"}
_aura_aircraft_cache_lock = Lock()
_aura_aircraft_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "aura_aircraft"}
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


_PERSIST_TTL_SECONDS = 7 * 24 * 3600  # 7 jours — conserve la dernière bonne valeur entre redémarrages


def _cached_external_payload(
    *,
    cache: dict[str, Any],
    lock: Lock,
    ttl_seconds: int,
    force_refresh: bool,
    loader: Any,
) -> dict[str, Any]:
    now = datetime.utcnow()
    redis_key: str | None = cache.get("redis_key")  # clé Redis stockée dans le dict de cache
    persist_key = f"persist:{redis_key}" if redis_key else None

    # 1. Cache mémoire local (le plus rapide, par worker)
    with lock:
        cached_payload = cache.get("payload")
        expires_at = cache.get("expires_at") or datetime.min
        if not force_refresh and cached_payload and now < expires_at:
            return deepcopy(cached_payload)

    # 2. Cache Redis court terme (partagé entre workers)
    if not force_refresh and redis_key:
        redis_data = _redis_get(redis_key)
        if redis_data:
            with lock:
                cache["payload"] = redis_data
                cache["expires_at"] = datetime.utcnow() + timedelta(seconds=ttl_seconds)
            return redis_data

    # 3. Cache Redis persistant (7 jours) — fallback au démarrage quand le cache court est expiré
    if not force_refresh and persist_key:
        persist_data = _redis_get(persist_key)
        if persist_data:
            # Remettre en cache mémoire et court terme pour les prochains accès
            with lock:
                cache["payload"] = persist_data
                cache["expires_at"] = datetime.utcnow() + timedelta(seconds=ttl_seconds)
            if redis_key:
                _redis_set(redis_key, persist_data, ttl_seconds)
            return persist_data

    payload = loader()
    if payload.get("status") in {"online", "partial", "stale"}:
        with lock:
            cache["payload"] = deepcopy(payload)
            cache["expires_at"] = datetime.utcnow() + timedelta(seconds=ttl_seconds)
        if redis_key:
            _redis_set(redis_key, payload, ttl_seconds)
        if persist_key:
            # Toujours mettre à jour le cache persistant avec la dernière bonne valeur
            _redis_set(persist_key, payload, _PERSIST_TTL_SECONDS)
        return payload

    # Fetch échoué — retourner la dernière valeur connue en mémoire (stale)
    with lock:
        cached_payload = cache.get("payload")
        max_stale_hours: float = cache.get("max_stale_hours", 0)  # 0 = illimité
        if cached_payload:
            if max_stale_hours > 0:
                try:
                    raw_ts = str(cached_payload.get("updated_at") or "").rstrip("Z")
                    age_hours = (datetime.utcnow() - datetime.fromisoformat(raw_ts)).total_seconds() / 3600
                except Exception:
                    age_hours = 0.0
                if age_hours > max_stale_hours:
                    # Données trop vieilles : purger le cache mémoire et retourner l'erreur
                    cache["payload"] = None
                    cache["expires_at"] = datetime.min
                    return payload
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
    page = 0
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
    """Fetch all Isère hydrometric stations from HuBEAU with full metadata (1–2 HTTP calls).

    HuBEAU v2 utilise une pagination 0-indexée (page=0 = première page).
    """
    stations: list[dict[str, Any]] = []
    page = 0
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
        # PHASE 2B – Fallback HuBEAU par codes connus
        # (utilisé quand _fetch_hubeau_isere_stations_full échoue ou renvoie [])
        # Utilise les codes Isère hardcodés + HuBEAU pour métadonnées/observations.
        # L'ancienne API vigicrues.gouv.fr/services/ est hors ligne depuis 2024.
        # ═══════════════════════════════════════════════════════════════════════
        if not isere_stations:
            fallback_codes_list = list(fallback_isere_codes)
            meta_map: dict[str, dict[str, Any]] = {}
            try:
                meta_map = _fetch_hubeau_stations_by_codes(fallback_codes_list)
            except Exception:
                pass

            obs_fallback: dict[str, tuple[float, float, str | None]] = {}
            try:
                obs_fallback = _fetch_hubeau_observations_batch(fallback_codes_list)
            except Exception:
                pass

            for code in fallback_codes_list:
                meta = meta_map.get(code, {})
                try:
                    lat = float(meta["latitude_station"]) if meta.get("latitude_station") is not None else None
                    lon = float(meta["longitude_station"]) if meta.get("longitude_station") is not None else None
                except (TypeError, ValueError):
                    lat = lon = None
                station_name = meta.get("libelle_station") or meta.get("libelle_cours_eau") or code
                river_name = meta.get("libelle_cours_eau") or ""
                text_blob = f"{station_name} {river_name}".lower()
                height_m, delta_m, observed_at = obs_fallback.get(code, (0.0, 0.0, None))
                level = _vigicrues_level_from_delta(abs(delta_m))
                isere_stations.append({
                    "code": code,
                    "station": station_name,
                    "river": river_name,
                    "height_m": round(height_m, 2),
                    "delta_window_m": round(delta_m, 3),
                    "level": level,
                    "control_status": "Fonctionnel",
                    "is_priority": "grenoble" in text_blob or any(name in text_blob for name in priority_names),
                    "observed_at": observed_at,
                    "lat": lat,
                    "lon": lon,
                    "commune_code": str(meta.get("code_commune_station") or ""),
                    "troncon": "",
                    "troncon_code": "",
                    "source_link": f"{source}/station/{code}",
                })

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
                "error": "Aucune station résolue — HuBEAU (referentiel/stations + observations_tr) et fallback indisponibles",
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


def _fetch_gtfsrt_service_alerts() -> list[dict[str, Any]]:
    """Fetch Itinisère GTFS-RT service alerts (bus/tram service disruptions, no auth required).
    Source: transport.data.gouv.fr resource 82300 — 100 % availability, updates every 2 min.
    Falls back to [] on any error or if gtfs-realtime-bindings is not installed.
    """
    _GTFSRT_URL = "https://www.itinisere.fr/ftp/gtfsrt/GtfsRT.Disruptions.CG38.pb"
    try:
        from google.transit import gtfs_realtime_pb2  # type: ignore
    except ImportError:
        return []
    try:
        req = Request(_GTFSRT_URL, headers={"User-Agent": _UA})
        with urlopen(req, timeout=12) as resp:
            pb_bytes = resp.read()
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(pb_bytes)

        # GTFS-RT cause → category label
        _CAUSE_CATEGORY: dict[int, str] = {
            1: "transport",   # UNKNOWN_CAUSE
            2: "transport",   # OTHER_CAUSE
            3: "travaux",     # TECHNICAL_PROBLEM
            4: "travaux",     # STRIKE
            5: "evenement",   # DEMONSTRATION
            6: "incident",    # ACCIDENT
            7: "evenement",   # HOLIDAY
            8: "meteo",       # WEATHER
            9: "travaux",     # MAINTENANCE
            10: "incident",   # POLICE_ACTIVITY
            11: "incident",   # MEDICAL_EMERGENCY
            12: "travaux",    # CONSTRUCTION
        }
        # GTFS-RT effect → severity
        _EFFECT_SEVERITY: dict[int, str] = {
            1: "rouge",   # NO_SERVICE
            2: "orange",  # REDUCED_SERVICE
            3: "orange",  # SIGNIFICANT_DELAYS
            4: "jaune",   # DETOUR
            5: "vert",    # ADDITIONAL_SERVICE
            6: "jaune",   # MODIFIED_SERVICE
            7: "vert",    # OTHER_EFFECT
            8: "vert",    # UNKNOWN_EFFECT
            9: "jaune",   # STOP_MOVED
            10: "vert",   # NO_EFFECT
            11: "jaune",  # ACCESSIBILITY_ISSUE
        }

        def _get_fr_text(translated_string) -> str:
            if not translated_string.translation:
                return ""
            for t in translated_string.translation:
                if t.language in ("fr", "fr-FR", ""):
                    return t.text
            return translated_string.translation[0].text

        now_ts = int(datetime.utcnow().timestamp())
        events: list[dict[str, Any]] = []
        for entity in feed.entity:
            if not entity.HasField("alert"):
                continue
            alert = entity.alert
            # Skip non-active periods
            if alert.active_period:
                active = any(
                    (p.start == 0 or p.start <= now_ts) and (p.end == 0 or p.end >= now_ts)
                    for p in alert.active_period
                )
                if not active:
                    continue

            title = _get_fr_text(alert.header_text).strip()
            description = _get_fr_text(alert.description_text).strip()
            if not title:
                title = description[:80] if description else "Perturbation réseau"

            # Affected routes (bus line IDs)
            routes = list({ie.route_id for ie in alert.informed_entity if ie.route_id})

            category = _CAUSE_CATEGORY.get(alert.cause, "transport")
            severity = _EFFECT_SEVERITY.get(alert.effect, "jaune")

            period_start, period_end = "", ""
            if alert.active_period:
                p = alert.active_period[0]
                if p.start:
                    period_start = datetime.utcfromtimestamp(p.start).strftime("%Y-%m-%dT%H:%M:%SZ")
                if p.end:
                    period_end = datetime.utcfromtimestamp(p.end).strftime("%Y-%m-%dT%H:%M:%SZ")

            events.append({
                "title": title[:200],
                "description": description[:550],
                "published_at": period_start,
                "link": "https://itinisere.fr/fr/disruptions/17/Disruption/Index",
                "roads": routes,
                "category": category,
                "severity": severity,
                "period_start": period_start,
                "period_end": period_end,
                "locations": _itinisere_extract_locations(title, description),
                "source_api": "gtfsrt",
            })
        return events
    except Exception:
        return []


def _fetch_itinisere_disruptions_live(limit: int = 60) -> dict[str, Any]:
    # itinisere.fr a refondu son site en avril 2026 : plus de flux RSS.
    # Les perturbations sont maintenant intégrées directement dans le HTML de la page principale.
    source = "https://itinisere.fr"
    try:
        html = _http_get_text(source, timeout=15)
        events: list[dict[str, Any]] = []

        # Chaque événement suit le schéma :
        # <a href="#">TITRE</a>  ... <p>DESCRIPTION avec dates et routes</p>
        # On cherche des paires (ancre href="#", paragraphe descriptif) proches
        pattern = re.compile(
            r'<a\s[^>]*href\s*=\s*["\']#["\'][^>]*>([\s\S]{10,250}?)</a>'
            r'[\s\S]{0,600}?'
            r'<p[^>]*>([\s\S]{30,900}?)</p>',
            re.IGNORECASE,
        )
        seen_titles: set[str] = set()
        for m in pattern.finditer(html):
            title = unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
            title = re.sub(r"\s+", " ", title)
            description = unescape(re.sub(r"<[^>]+>", " ", m.group(2))).strip()
            description = re.sub(r"\s+", " ", description)

            if len(title) < 10 or len(description) < 25:
                continue
            # Filtre de contenu : doit parler de routes/travaux/isère
            desc_lower = f"{title} {description}".lower()
            if not any(tok in desc_lower for tok in (
                "route", "rd ", "département", "travaux", "fermeture", "coupure",
                "col ", "chantier", "accident", "déviation", "alternat",
                "jusqu'au", "jusqu'à", "depuis le", "a compter",
            )):
                continue
            title_key = title.lower()[:60]
            if title_key in seen_titles:
                continue
            seen_titles.add(title_key)

            roads = _itinisere_extract_roads(f"{title} {description}")
            category = _itinisere_category(title, description)
            severity = _itinisere_severity(title, description, category)
            locations = _itinisere_extract_locations(title, description)
            period_start, period_end = _itinisere_extract_period(description)

            if not _itinisere_is_isere_event(title, description, roads=roads, locations=locations):
                continue

            events.append({
                "title": title[:200],
                "description": description[:550],
                "published_at": "",
                "link": source,
                "roads": roads,
                "category": category,
                "severity": severity,
                "period_start": period_start,
                "period_end": period_end,
                "locations": locations,
            })
            if len(events) >= limit:
                break

        # Fallback Cityway (perturbations crowdsourcées avec lat/lon)
        cityway_events = _cityway_fetch_isere_disruptions()
        seen_titles_full = {e["title"].lower()[:60] for e in events}
        for cw in cityway_events:
            if cw["title"].lower()[:60] not in seen_titles_full:
                if not _itinisere_is_public_transport_event(cw["title"], cw["description"]):
                    events.append(cw)

        # Enrichir les événements sans coordonnées via Cityway
        cityway_by_title = {e["title"].lower()[:60]: e for e in cityway_events}
        for event in events:
            if event.get("lat") is None:
                match = cityway_by_title.get(event["title"].lower()[:60])
                if match and match.get("lat") is not None:
                    event["lat"] = match["lat"]
                    event["lon"] = match["lon"]

        # GTFS-RT service alerts (bus/transport disruptions — structured feed, no auth)
        gtfsrt_events = _fetch_gtfsrt_service_alerts()
        seen_titles_full = {e["title"].lower()[:60] for e in events}
        for ge in gtfsrt_events:
            if ge["title"].lower()[:60] not in seen_titles_full:
                events.append(ge)

        insights = _itinisere_insights(events)
        insights["severity_breakdown"] = {
            level: len([e for e in events if e.get("severity") == level])
            for level in ("rouge", "orange", "jaune", "vert")
        }
        insights["transport_alerts"] = len(gtfsrt_events)
        return {
            "service": "Inforoute Isère",
            "status": "online" if events else "degraded",
            "source": source,
            "events": events[:limit],
            "events_total": len(events),
            "insights": insights,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        # Si le scraping HTML échoue, on tente GTFS-RT + Cityway
        cityway_events = _cityway_fetch_isere_disruptions()
        gtfsrt_events = _fetch_gtfsrt_service_alerts()
        fallback_events = cityway_events + gtfsrt_events
        if fallback_events:
            insights = _itinisere_insights(fallback_events)
            insights["severity_breakdown"] = {
                level: len([e for e in fallback_events if e.get("severity") == level])
                for level in ("rouge", "orange", "jaune", "vert")
            }
            insights["transport_alerts"] = len(gtfsrt_events)
            return {
                "service": "Inforoute Isère",
                "status": "degraded_html",
                "source": "gtfsrt+cityway",
                "events": fallback_events[:limit],
                "events_total": len(fallback_events),
                "insights": insights,
                "updated_at": datetime.utcnow().isoformat() + "Z",
            }
        return {
            "service": "Inforoute Isère",
            "status": "offline",
            "source": source,
            "events": [],
            "events_total": 0,
            "insights": {"dominant_category": "aucune", "category_breakdown": {}, "top_roads": []},
            "error": str(exc)[:200],
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }


# ----- DEAD CODE REMOVED -----
# _itinisere_fetch_detail() et la logique RSS sont supprimés.
# Le scraping HTML remplace le RSS depuis la refonte du site (avril 2026).

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
    # Essaie plusieurs variantes du sélecteur Drupal (les sites peuvent changer le format des attributs)
    patterns = [
        r'<script[^>]+data-drupal-selector=["\']drupal-settings-json["\'][^>]*>(.*?)</script>',
        r'<script[^>]+type=["\']application/json["\'][^>]+data-drupal-selector=["\']drupal-settings-json["\'][^>]*>(.*?)</script>',
        r'jQuery\.extend\(Drupal\.settings,\s*(.*?)\);\s*</script>',
    ]
    for pattern in patterns:
        match = re.search(pattern, page_html, flags=re.DOTALL)
        if match:
            return json.loads(match.group(1))
    raise ValueError("Configuration Drupal introuvable")


def _atmo_level_from_index(index_value: float | int | None) -> str:
    """Indice ATMO France 1-6 : 1-2=Bon, 3=Modéré, 4=Dégradé, 5=Mauvais, 6=Très mauvais."""
    if index_value is None:
        return "inconnu"
    if index_value <= 2:
        return "vert"
    if index_value <= 3:
        return "jaune"
    if index_value <= 4:
        return "orange"
    return "rouge"  # indices 5-6 : Mauvais / Très mauvais


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


_ATMO_BROWSER_HEADERS = {
    "User-Agent": _BROWSER_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
}


def _atmo_build_success(source: str, today_index, today_date, tomorrow_index, tomorrow_date,
                        today_comment: str = "", tomorrow_comment: str = "",
                        today_sub: list | None = None, tomorrow_sub: list | None = None,
                        has_episode: bool = False,
                        level_fn=None, label_fn=None) -> dict[str, Any]:
    lf = level_fn or _atmo_level_from_index
    lb = label_fn or _atmo_label_from_index
    return {
        "service": "Atmo Auvergne-Rhône-Alpes",
        "status": "online",
        "department": "Isère",
        "city": "Grenoble",
        "source": source,
        "today": {
            "date": today_date,
            "index": today_index,
            "level": lf(today_index),
            "label": lb(today_index),
            "comment": today_comment,
            "sub_indices": today_sub or [],
        },
        "tomorrow": {
            "date": tomorrow_date,
            "index": tomorrow_index,
            "level": lf(tomorrow_index),
            "label": lb(tomorrow_index),
            "comment": tomorrow_comment,
            "sub_indices": tomorrow_sub or [],
        },
        "has_pollution_episode": has_episode,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def _euaqi_level(aqi: float | int | None) -> str:
    """Convertit un European AQI (0-100+) en niveau de vigilance."""
    if aqi is None:
        return "inconnu"
    if aqi <= 20:
        return "vert"
    if aqi <= 40:
        return "jaune"
    if aqi <= 80:
        return "orange"
    return "rouge"


def _euaqi_label(aqi: float | int | None) -> str:
    if aqi is None:
        return "inconnu"
    if aqi <= 20:
        return "bon"
    if aqi <= 40:
        return "modéré"
    if aqi <= 60:
        return "dégradé"
    if aqi <= 80:
        return "mauvais"
    return "très mauvais"


def _fetch_atmo_aura_isere_air_quality_live() -> dict[str, Any]:
    source_page = "https://www.atmo-auvergnerhonealpes.fr/air-commune/grenoble/38185/indice-atmo"
    today_str = datetime.utcnow().date().isoformat()
    tomorrow_str = (datetime.utcnow().date() + timedelta(days=1)).isoformat()

    # ── Source 1 : Open-Meteo AQI — API gratuite, sans auth, très fiable ─────
    # Grenoble : lat=45.1885, lon=5.7245
    try:
        openmeteo_url = (
            "https://air-quality-api.open-meteo.com/v1/air-quality"
            "?latitude=45.1885&longitude=5.7245"
            "&hourly=european_aqi"
            "&timezone=Europe%2FParis&forecast_days=2"
        )
        om = _http_get_json(
            openmeteo_url,
            timeout=12,
            headers={"Accept": "application/json", "User-Agent": _BROWSER_UA},
        )
        hourly = om.get("hourly") or {}
        times = hourly.get("time") or []
        aqis = hourly.get("european_aqi") or []
        # Chercher la valeur de l'heure courante (ou la plus récente du jour)
        now_hour = datetime.utcnow().strftime("%Y-%m-%dT%H:00")
        today_aqi: int | None = None
        tomorrow_aqi: int | None = None
        for t, v in zip(times, aqis):
            if v is None:
                continue
            if str(t).startswith(today_str) and today_aqi is None:
                today_aqi = int(v)
            if str(t).startswith(tomorrow_str) and tomorrow_aqi is None:
                tomorrow_aqi = int(v)
        if today_aqi is not None:
            return _atmo_build_success(
                source="https://open-meteo.com/en/docs/air-quality-api",
                today_index=today_aqi,
                today_date=today_str,
                tomorrow_index=tomorrow_aqi,
                tomorrow_date=tomorrow_str if tomorrow_aqi is not None else None,
                today_comment=f"Indice européen AQI ({today_aqi}/100)",
                tomorrow_comment=f"Prévision AQI ({tomorrow_aqi}/100)" if tomorrow_aqi else "",
                level_fn=_euaqi_level,
                label_fn=_euaqi_label,
            )
    except Exception:
        pass

    # ── Source 2 : API Recosante (beta.gouv.fr) ───────────────────────────────
    for reco_url in [
        "https://api.recosante.beta.gouv.fr/v1/?insee=38185",
        "https://api.recosante.beta.gouv.fr/v1/?commune=38185",
    ]:
        try:
            reco = _http_get_json(
                reco_url,
                timeout=15,
                headers={"Accept": "application/json", "User-Agent": _BROWSER_UA},
            )
            # Plusieurs structures possibles selon la version de l'API
            atmo_raw = (
                reco.get("indice_atmo")
                or (reco.get("data") or {}).get("indice_atmo")
                or {}
            )
            atmo_j1 = (
                reco.get("indice_atmo_J1") or reco.get("indice_atmo_j1")
                or reco.get("indice_atmo_tomorrow") or {}
            )
            today_index = (
                atmo_raw.get("indice") or atmo_raw.get("value")
                or atmo_raw.get("valeur") or atmo_raw.get("code_qual")
            )
            if today_index is not None:
                return _atmo_build_success(
                    source=source_page,
                    today_index=today_index,
                    today_date=atmo_raw.get("date") or atmo_raw.get("date_ech") or today_str,
                    tomorrow_index=atmo_j1.get("indice") or atmo_j1.get("value"),
                    tomorrow_date=atmo_j1.get("date") or atmo_j1.get("date_ech"),
                    today_comment=str(atmo_raw.get("qualificatif") or atmo_raw.get("label") or ""),
                    tomorrow_comment=str(atmo_j1.get("qualificatif") or ""),
                    today_sub=atmo_raw.get("sous_indices") or [],
                    tomorrow_sub=atmo_j1.get("sous_indices") or [],
                    has_episode=bool(reco.get("episode_pollution")),
                )
        except Exception:
            continue

    # ── Source 3 : endpoint JSON natif Drupal (?_format=json) ────────────────
    try:
        drupal_json = _http_get_json(
            source_page + "?_format=json",
            timeout=20,
            headers={"Accept": "application/json", "User-Agent": _BROWSER_UA},
        )
        dataviz = drupal_json.get("dataviz") or drupal_json
        indices = dataviz.get("indices") or {}
        available_dates = sorted(indices.keys())
        if available_dates:
            d0, d1 = available_dates[0], (available_dates[1] if len(available_dates) > 1 else None)
            p0, p1 = indices.get(d0) or {}, (indices.get(d1) or {} if d1 else {})
            comments = dataviz.get("comments") or {}
            return _atmo_build_success(
                source=source_page, today_index=p0.get("indice_atmo"), today_date=d0,
                tomorrow_index=p1.get("indice_atmo"), tomorrow_date=d1,
                today_comment=comments.get(d0, ""), tomorrow_comment=comments.get(d1, "") if d1 else "",
                today_sub=p0.get("sous_indices") or [], tomorrow_sub=p1.get("sous_indices") or [],
                has_episode=bool(dataviz.get("hasEpisodeInProgress")),
            )
    except Exception:
        pass

    # ── Source 4 : scraping HTML Drupal avec patterns étendus ────────────────
    try:
        page_html = _http_get_text(source_page, timeout=30, headers=_ATMO_BROWSER_HEADERS)
        # Patterns Drupal classiques + variantes
        extra_patterns = [
            r'drupalSettings\s*=\s*({.*?});\s*(?:\/\/|</script>)',
            r'window\.drupalSettings\s*=\s*({.*?});\s*(?:\/\/|</script>)',
            r'"dataviz"\s*:\s*\{.*?"indices"\s*:\s*\{.*?\}\s*\}',
        ]
        settings_payload = None
        try:
            settings_payload = _extract_drupal_settings_json(page_html)
        except ValueError:
            for pat in extra_patterns:
                m = re.search(pat, page_html, re.DOTALL)
                if m:
                    try:
                        settings_payload = json.loads(m.group(1))
                        break
                    except Exception:
                        pass
        if settings_payload:
            dataviz = settings_payload.get("dataviz") or {}
            indices = dataviz.get("indices") or {}
            available_dates = sorted(indices.keys())
            if available_dates:
                d0, d1 = available_dates[0], (available_dates[1] if len(available_dates) > 1 else None)
                p0, p1 = indices.get(d0) or {}, (indices.get(d1) or {} if d1 else {})
                comments = dataviz.get("comments") or {}
                return _atmo_build_success(
                    source=source_page, today_index=p0.get("indice_atmo"), today_date=d0,
                    tomorrow_index=p1.get("indice_atmo"), tomorrow_date=d1,
                    today_comment=comments.get(d0, ""),
                    tomorrow_comment=comments.get(d1, "") if d1 else "",
                    today_sub=p0.get("sous_indices") or [], tomorrow_sub=p1.get("sous_indices") or [],
                    has_episode=bool(dataviz.get("hasEpisodeInProgress")),
                )
    except Exception:
        pass

    return {
        "service": "Atmo Auvergne-Rhône-Alpes",
        "status": "degraded",
        "department": "Isère",
        "city": "Grenoble",
        "source": source_page,
        "today": {},
        "tomorrow": {},
        "has_pollution_episode": False,
        "error": "Toutes les sources Atmo AURA indisponibles (Open-Meteo, Recosante, Drupal JSON, HTML)",
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


def _fetch_france_bleu_isere_news_live(limit: int = 12) -> dict[str, Any]:
    """Récupère les dernières actualités Isère via flux RSS (plusieurs sources)."""
    # france3-regions en tête : RSS le plus frais (articles du jour).
    # francetvinfo en secours. Les URLs France Bleu sont mortes depuis leur migration Radio France.
    rss_sources = [
        "https://france3-regions.francetvinfo.fr/auvergne-rhone-alpes/isere/rss",
        "https://www.francetvinfo.fr/france/auvergne-rhone-alpes/isere.rss",
    ]
    _rss_headers = {
        "User-Agent": _BROWSER_UA,
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Referer": "https://www.google.com/",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    source_errors: list[str] = []
    for source in rss_sources:
        try:
            resp = _requests.get(source, headers=_rss_headers, timeout=15, allow_redirects=True)
            resp.raise_for_status()
            xml_payload = resp.content.decode(resp.encoding or "utf-8", errors="ignore")
            root = ET.fromstring(xml_payload)
            items: list[dict[str, Any]] = []
            ns = {"media": "http://search.yahoo.com/mrss/", "dc": "http://purl.org/dc/elements/1.1/"}
            for item in root.findall(".//item"):
                title_raw = unescape((item.findtext("title") or "").strip()) or "Article France Bleu Isère"
                link = (item.findtext("link") or source).strip()
                pub_date_raw = (item.findtext("pubDate") or item.findtext("dc:date", namespaces=ns) or "").strip()
                description_raw = unescape(re.sub(r"<[^>]+>", " ", item.findtext("description") or "").strip())[:300]
                published_at = ""
                if pub_date_raw:
                    try:
                        published_at = parsedate_to_datetime(pub_date_raw).isoformat()
                    except Exception:
                        published_at = pub_date_raw
                items.append({
                    "title": title_raw[:200],
                    "link": link,
                    "description": description_raw,
                    "published_at": published_at,
                    "source": "France Bleu Isère",
                })
                if len(items) >= limit:
                    break
            if not items:
                source_errors.append(f"{source} → 0 articles trouvés (XML valide)")
                continue
            return {
                "service": "France Bleu Isère",
                "status": "online",
                "source": source,
                "items": items,
                "updated_at": datetime.utcnow().isoformat() + "Z",
            }
        except Exception as exc:
            source_errors.append(f"{source} → {type(exc).__name__}: {exc}")
            continue

    return {
        "service": "France Bleu Isère",
        "status": "degraded",
        "source": rss_sources[0],
        "items": [],
        "error": "Flux RSS France Bleu Isère indisponible — " + " | ".join(source_errors),
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_france_bleu_isere_news(limit: int = 12, force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_france_bleu_cache,
        lock=_france_bleu_cache_lock,
        ttl_seconds=_FRANCE_BLEU_ISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_france_bleu_isere_news_live(limit=limit),
    )


def _fetch_placegrenet_news_live(limit: int = 10) -> dict[str, Any]:
    source = "https://www.placegrenet.fr/feed/rss"
    try:
        xml_payload = _http_get_text(source)
        root = ET.fromstring(xml_payload)
        items: list[dict[str, Any]] = []
        for item in root.findall(".//item"):
            title = unescape((item.findtext("title") or "").strip()) or "Article Place Gre'net"
            link = (item.findtext("link") or "https://www.placegrenet.fr").strip()
            parsed_link = urlparse(link)
            if parsed_link.scheme not in {"http", "https"}:
                continue
            description_html = (item.findtext("description") or "").strip()
            description = unescape(re.sub(r"\s+", " ", _strip_html_tags(description_html))).strip()
            published = (item.findtext("pubDate") or "").strip()
            items.append({"title": title, "description": description[:400], "published_at": published, "link": link})
        items.sort(key=lambda a: _parse_prefecture_published_date(a.get("published_at") or ""), reverse=True)
        return {"service": "Place Gre'net", "status": "online", "source": source, "items": items[:limit], "updated_at": datetime.utcnow().isoformat() + "Z"}
    except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {"service": "Place Gre'net", "status": "degraded", "source": source, "items": [], "error": str(exc)}


def fetch_placegrenet_news(limit: int = 10, force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_placegrenet_cache,
        lock=_placegrenet_cache_lock,
        ttl_seconds=_PLACEGRENET_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_placegrenet_news_live(limit=limit),
    )


def _fetch_grenoble_metro_news_live(limit: int = 8) -> dict[str, Any]:
    source = "https://www.grenoblealpesmetropole.fr/rss_actualite.rss"
    try:
        xml_payload = _http_get_text(source)
        root = ET.fromstring(xml_payload)
        items: list[dict[str, Any]] = []
        for item in root.findall(".//item"):
            title = unescape((item.findtext("title") or "").strip()) or "Actualité Grenoble Alpes Métropole"
            link = (item.findtext("link") or "https://www.grenoblealpesmetropole.fr").strip()
            parsed_link = urlparse(link)
            if parsed_link.scheme not in {"http", "https"}:
                continue
            description_html = (item.findtext("description") or "").strip()
            description = unescape(re.sub(r"\s+", " ", _strip_html_tags(description_html))).strip()
            published = (item.findtext("pubDate") or "").strip()
            items.append({"title": title, "description": description[:400], "published_at": published, "link": link})
        items.sort(key=lambda a: _parse_prefecture_published_date(a.get("published_at") or ""), reverse=True)
        return {"service": "Grenoble Alpes Métropole", "status": "online", "source": source, "items": items[:limit], "updated_at": datetime.utcnow().isoformat() + "Z"}
    except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {"service": "Grenoble Alpes Métropole", "status": "degraded", "source": source, "items": [], "error": str(exc)}


def fetch_grenoble_metro_news(limit: int = 8, force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_grenoble_metro_cache,
        lock=_grenoble_metro_cache_lock,
        ttl_seconds=_GRENOBLE_METRO_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_grenoble_metro_news_live(limit=limit),
    )


def _fetch_ars_aura_health_alerts_live(limit: int = 8) -> dict[str, Any]:
    sources = [
        "https://www.auvergne-rhone-alpes.ars.sante.fr/rss.xml?type=ars_alerte_sanitaire",
        "https://www.auvergne-rhone-alpes.ars.sante.fr/rss.xml?type=ars_actualite",
    ]
    items: list[dict[str, Any]] = []
    source_used = sources[0]
    for source in sources:
        try:
            xml_payload = _http_get_text(source)
            root = ET.fromstring(xml_payload)
            for item in root.findall(".//item"):
                title = unescape((item.findtext("title") or "").strip()) or "Alerte sanitaire ARS"
                link = (item.findtext("link") or "https://www.auvergne-rhone-alpes.ars.sante.fr").strip()
                parsed_link = urlparse(link)
                if parsed_link.scheme not in {"http", "https"}:
                    continue
                description_html = (item.findtext("description") or "").strip()
                description = unescape(re.sub(r"\s+", " ", _strip_html_tags(description_html))).strip()
                published = (item.findtext("pubDate") or "").strip()
                entry = {"title": title, "description": description[:400], "published_at": published, "link": link}
                if entry not in items:
                    items.append(entry)
            source_used = source
            if items:
                break
        except Exception:
            continue
    items.sort(key=lambda a: _parse_prefecture_published_date(a.get("published_at") or ""), reverse=True)
    if items:
        return {"service": "ARS AURA · Alertes sanitaires", "status": "online", "source": source_used, "items": items[:limit], "updated_at": datetime.utcnow().isoformat() + "Z"}
    return {"service": "ARS AURA · Alertes sanitaires", "status": "degraded", "source": source_used, "items": [], "error": "Aucune alerte disponible"}


def fetch_ars_aura_health_alerts(limit: int = 8, force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_ars_aura_cache,
        lock=_ars_aura_cache_lock,
        ttl_seconds=_ARS_AURA_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_ars_aura_health_alerts_live(limit=limit),
    )


def _fetch_seismes_isere_live(limit: int = 6) -> dict[str, Any]:
    # Bounding box Isère : lat 44.7-45.5, lon 4.8-6.5 — retourne QuakeML XML
    url = (
        "https://api.franceseisme.fr/fdsnws/event/1/query"
        "?minlatitude=44.7&maxlatitude=45.5"
        "&minlongitude=4.8&maxlongitude=6.5"
        f"&limit={limit}&orderby=time"
    )
    # QuakeML : root = q:quakeml (xmlns:q=quakeml/1.2), fils = bed/1.2 (default ns)
    NS = {
        "q": "http://quakeml.org/xmlns/quakeml/1.2",
        "b": "http://quakeml.org/xmlns/bed/1.2",
    }
    try:
        raw = _http_get_text(url)
        root = ET.fromstring(raw)
        event_nodes = root.findall("b:eventParameters/b:event", NS)
        events: list[dict[str, Any]] = []
        for ev in event_nodes:
            def _txt(path: str) -> str | None:
                node = ev.find(path, NS)
                return node.text.strip() if node is not None and node.text else None
            mag_raw = _txt("b:magnitude/b:mag/b:value")
            mag = round(float(mag_raw), 1) if mag_raw else None
            place = _txt("b:description/b:text") or "Isère"
            time_val = _txt("b:origin/b:time/b:value")
            depth_raw = _txt("b:origin/b:depth/b:value")
            depth_km = round(float(depth_raw) / 1000, 1) if depth_raw else None
            # Formater la date ISO "2024-02-12T08:23:45.000000Z" → "12/02/2024 08:23"
            date_label = ""
            if time_val:
                try:
                    dt = datetime.fromisoformat(time_val.replace("Z", "").split(".")[0])
                    date_label = dt.strftime("%d/%m/%Y %H:%M")
                except Exception:
                    date_label = time_val[:16]
            events.append({
                "title": f"Séisme M{mag} — {place}",
                "magnitude": mag,
                "place": place,
                "depth_km": depth_km,
                "published_at": time_val,
                "date_label": date_label,
                "description": f"Magnitude {mag} · Profondeur {depth_km} km" if depth_km else f"Magnitude {mag}",
                "link": "https://www.franceseisme.fr/",
            })
        return {"service": "Séismes Isère (BCSF-RéNaSS)", "status": "online", "source": url, "items": events, "updated_at": datetime.utcnow().isoformat() + "Z"}
    except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError, KeyError) as exc:
        return {"service": "Séismes Isère (BCSF-RéNaSS)", "status": "degraded", "source": url, "items": [], "error": str(exc)}


def fetch_seismes_isere(limit: int = 10, force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_seismes_isere_cache,
        lock=_seismes_isere_cache_lock,
        ttl_seconds=_SEISMES_ISERE_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=lambda: _fetch_seismes_isere_live(limit=limit),
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


def _rte_get_oauth_token(b64_creds: str, cache_key: str) -> str:
    """Récupère (ou renouvelle) un token OAuth2 RTE.
    Priorité : Redis (partagé entre workers) → mémoire locale → fetch réseau.
    Les tokens RTE sont valides 2h ; on les renouvelle 10min avant expiry."""
    redis_key = f"rte_oauth_token:{cache_key}"

    # 1. Redis — partagé entre tous les workers Gunicorn
    if _REDIS_OK and _redis is not None:
        try:
            cached_token = _redis.get(redis_key)
            if cached_token:
                return cached_token.decode() if isinstance(cached_token, bytes) else str(cached_token)
        except Exception:
            pass

    # 2. Mémoire locale (fallback si Redis KO)
    with _rte_oauth_lock:
        cached = _rte_oauth_tokens.get(cache_key)
        if cached and datetime.utcnow() < cached["expires_at"]:
            return str(cached["token"])

    if not (_REQUESTS_OK and _requests is not None):
        raise RuntimeError("requests non disponible pour l'auth RTE")

    resp = _requests.post(
        "https://digital.iservices.rte-france.com/token/oauth/",
        headers={
            "Authorization": f"Basic {b64_creds}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data="grant_type=client_credentials",
        timeout=15,
        verify=True,
    )
    resp.raise_for_status()
    data = resp.json()
    token = str(data["access_token"])
    expires_in = int(data.get("expires_in", 7200))
    ttl = max(expires_in - 600, 300)  # renouvelle 10min avant expiry

    # Stocker dans Redis (partagé) et en mémoire locale
    if _REDIS_OK and _redis is not None:
        try:
            _redis.setex(redis_key, ttl, token)
        except Exception:
            pass
    with _rte_oauth_lock:
        _rte_oauth_tokens[cache_key] = {
            "token": token,
            "expires_at": datetime.utcnow() + timedelta(seconds=ttl),
        }
    return token


def _fetch_rte_isere_electricity_live() -> dict[str, Any]:
    from app.config import settings as _settings  # import local pour éviter le circular

    _RTE_BASE = "https://digital.iservices.rte-france.com"
    ecowatt_b64 = (_settings.rte_ecowatt_b64 or "").strip()
    consumption_b64 = (_settings.rte_consumption_b64 or "").strip()

    if not ecowatt_b64:
        return {
            "service": "RTE · Ecowatt & Consommation",
            "status": "degraded",
            "department": "France (national)",
            "scope": "Signal Ecowatt RTE",
            "source": "https://data.rte-france.com",
            "level": "inconnu",
            "error": "RTE_ECOWATT_B64 non configuré",
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }

    errors: list[str] = []

    # ── 1. Signal Ecowatt (vert / orange / rouge) ──────────────────────────
    # Le 429 propage jusqu'à _refresh_one_service qui conservera alors le slot précédent.
    ecowatt_level = "inconnu"
    ecowatt_message = ""
    ecowatt_today: dict[str, Any] = {}
    token = _rte_get_oauth_token(ecowatt_b64, "ecowatt")
    resp_ecowatt = _requests.get(
        f"{_RTE_BASE}/open_api/ecowatt/v5/signals",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
        verify=True,
    )
    if resp_ecowatt.status_code == 429:
        retry_after = max(int(resp_ecowatt.headers.get("Retry-After", 120)), 60)
        # Priorité 1 : retourner le cache stale s'il contient de vraies données Ecowatt
        with _rte_electricity_cache_lock:
            stale = _rte_electricity_cache.get("payload")
        _ecowatt_is_real = lambda p: isinstance(p, dict) and isinstance(p.get("ecowatt"), dict)
        if stale and stale.get("status") == "online" and _ecowatt_is_real(stale):
            return stale
        # Priorité 2 : fallback dégradé avec TTL court pour réessayer rapidement
        fallback = {
            "service": "RTE · Ecowatt & Consommation",
            "status": "degraded",
            "department": "France (national)",
            "scope": "Signal Ecowatt RTE",
            "source": "https://data.rte-france.com",
            "level": "inconnu",
            "ecowatt": {},
            "ecowatt_message": "Données temporairement indisponibles (limite API RTE)",
            "consumption_mw": None,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
        short_ttl = min(retry_after + 30, 300)  # max 5 min d'attente
        redis_key = _rte_electricity_cache.get("redis_key")
        if redis_key:
            _redis_set(redis_key, fallback, short_ttl)
        with _rte_electricity_cache_lock:
            _rte_electricity_cache["payload"] = deepcopy(fallback)
            _rte_electricity_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=short_ttl)
        return fallback
    resp_ecowatt.raise_for_status()
    signals = resp_ecowatt.json().get("signals") or []
    if signals:
        today_sig = signals[0]
        dval = int(today_sig.get("dvalue") or 1)
        ecowatt_level = {1: "vert", 2: "orange", 3: "rouge"}.get(dval, "inconnu")
        ecowatt_message = str(today_sig.get("message") or "")
        ecowatt_today = {
            "jour": today_sig.get("Jour") or today_sig.get("jour"),
            "dvalue": dval,
            "level": ecowatt_level,
            "message": ecowatt_message,
            "generation_forecast_mw": today_sig.get("GenerationForecast"),
        }

    # ── 2. Consommation nationale temps réel ───────────────────────────────
    consumption_mw: int | None = None
    consumption_observed_at: str | None = None
    if consumption_b64:
        try:
            from datetime import timezone as _tz
            token2 = _rte_get_oauth_token(consumption_b64, "consumption")
            resp2 = _requests.get(
                f"{_RTE_BASE}/open_api/consumption/v1/short_term",
                headers={"Authorization": f"Bearer {token2}"},
                timeout=15,
                verify=True,
            )
            resp2.raise_for_status()
            short_terms = resp2.json().get("short_term") or []
            # Prendre la valeur non-nulle la plus récente (max start_date) qui ne soit
            # pas dans le futur et pas vieille de plus de 4h.
            now_utc = datetime.utcnow()
            best_value: int | None = None
            best_dt: str | None = None
            best_ts: datetime | None = None
            for bloc in short_terms:
                for val in (bloc.get("values") or []):
                    try:
                        start = val.get("start_date") or ""
                        v = val.get("value")
                        if v is None or not start:
                            continue
                        ts = datetime.fromisoformat(start.replace("Z", "+00:00"))
                        ts_utc = ts.astimezone(_tz.utc).replace(tzinfo=None)
                        # Ignorer les valeurs futures et les valeurs trop anciennes (>4h)
                        if ts_utc > now_utc:
                            continue
                        if (now_utc - ts_utc).total_seconds() > 4 * 3600:
                            continue
                        if best_ts is None or ts_utc > best_ts:
                            best_value = int(v)
                            best_dt = start
                            best_ts = ts_utc
                    except Exception:
                        pass
            consumption_mw = best_value
            consumption_observed_at = best_dt
        except Exception as exc:
            errors.append(f"Consumption: {exc}")

    status = "online" if ecowatt_level != "inconnu" else "degraded"

    result: dict[str, Any] = {
        "service": "RTE · Ecowatt & Consommation",
        "status": status,
        "department": "France (national)",
        "scope": "Signal Ecowatt RTE + Consommation nationale temps réel",
        "source": f"{_RTE_BASE}/open_api/ecowatt/v5/signals",
        "level": ecowatt_level,
        "ecowatt": ecowatt_today,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    if consumption_mw is not None:
        result["consumption_mw"] = consumption_mw
        result["observed_at"] = consumption_observed_at
    if errors:
        result["warnings"] = errors
    return result


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


_FINESS_FILE = "finess_isere.json"


def fetch_finess_isere_resources(force_refresh: bool = False, limit: int = 5000) -> dict[str, Any]:
    safe_limit = max(200, min(limit, _FINESS_ISERE_MAX_LIMIT))

    # Vérifier d'abord le cache fichier (avant Redis/CSV) si pas de force_refresh
    if not force_refresh:
        with _finess_isere_cache_lock:
            cached_payload = _finess_isere_cache.get("payload")
            if cached_payload and datetime.utcnow() < (_finess_isere_cache.get("expires_at") or datetime.min):
                return deepcopy(cached_payload)

        file_data = _file_cache_load(_FINESS_FILE)
        if file_data and file_data.get("resources"):
            # Tronquer si la limite est inférieure au nombre de ressources stockées
            resources = file_data.get("resources") or []
            if len(resources) > safe_limit:
                file_data = dict(file_data)
                file_data["resources"] = resources[:safe_limit]
                file_data["resources_total"] = len(file_data["resources"])
            with _finess_isere_cache_lock:
                _finess_isere_cache["payload"] = file_data
                _finess_isere_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_FINESS_ISERE_CACHE_TTL_SECONDS)
            return file_data

    def loader() -> dict[str, Any]:
        try:
            result = _fetch_finess_isere_resources_live(limit=safe_limit)
            # Sauvegarder dans le fichier dès qu'on a de vraies données
            if result.get("status") == "online" and result.get("resources"):
                _file_cache_save(_FINESS_FILE, result)
            return result
        except Exception as exc:
            # Fallback : retourner le fichier si disponible
            file_data = _file_cache_load(_FINESS_FILE)
            if file_data and file_data.get("resources"):
                return file_data
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




_opendata_isere_ssl_ctx = _make_legacy_ssl_context()


def _isere_opendata_fetch_dataset_records(dataset_id: str, select_fields: str, limit: int = 1) -> dict[str, Any]:
    encoded_fields = quote_plus(select_fields)
    url = (
        f"https://opendata.isere.fr/api/explore/v2.1/catalog/datasets/{dataset_id}/records"
        f"?select={encoded_fields}&limit={max(1, min(limit, 100))}"
    )
    hdrs = {"Accept": "application/json", "User-Agent": _BROWSER_UA}

    # requests + TLS12Adapter : force TLS 1.2 max pour éviter TLSV1_ALERT_INTERNAL_ERROR
    # sur opendata.isere.fr depuis Docker/Linux OpenSSL 3.x
    try:
        resp = _requests_get_tls12(url, headers=hdrs, timeout=15)
        payload = resp.json()
        return payload if isinstance(payload, dict) else {}
    except Exception:
        pass  # Fallback urllib ci-dessous

    # Fallback : urllib avec contexte SSL legacy (TLS 1.2 max + SECLEVEL=0)
    payload = _http_get_json(url, timeout=15, ssl_context=_opendata_isere_ssl_ctx, headers=hdrs)
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
        dataset = _http_get_json(
            f"https://www.data.gouv.fr/api/1/datasets/{dataset_id}/",
            headers={"Accept": "application/json", "User-Agent": _BROWSER_UA},
        )
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

        archive_bytes = _http_stream_large_file(
            str(latest_resource.get("url")),
            timeout=120,
            retries=2,
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
        dataset = _http_get_json(
            f"https://www.data.gouv.fr/api/1/datasets/{dataset_id}/",
            headers={"Accept": "application/json", "User-Agent": _BROWSER_UA},
        )
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


# ---------------------------------------------------------------------------
# Réseaux sociaux — flux RSS via Nitter (sans clé API)
# ---------------------------------------------------------------------------

# ===========================================================================
# Flux transport Isère — autoroutes, TER, cars
# ===========================================================================

_ISERE_ROAD_COORDS: dict[str, tuple[float, float]] = {
    "A41": (45.374, 5.786),   # Grenoble N – Crolles
    "A43": (45.420, 5.624),   # Bourgoin-Jallieu
    "A48": (45.176, 5.668),   # Grenoble O – Voreppe
    "A51": (44.877, 5.697),   # Grenoble S – Monestier
    "A40": (45.897, 6.118),   # Haute-Savoie / limite
    "A42": (45.762, 5.169),   # Ain / Pont-d'Ain
}
_ISERE_ROAD_KEYWORDS: frozenset[str] = frozenset({
    "a41", "a43", "a48", "a51", "isère", "isere", "grenoble",
    "voiron", "bourgoin", "vienne", "crolles", "meylan", "sassenage",
    "fontaine", "seyssins", "claix", "varces", "vizille", "vif",
    "pont-de-claix", "echirolles", "échirolles",
})


def _parse_road_from_text(text: str) -> str | None:
    m = re.search(r'\bA(41|43|48|51|40|42)\b', text, re.IGNORECASE)
    return f"A{m.group(1).upper()}" if m else None


# ══════════════════════════════════════════════════════════════════════════════
# PR AUTOROUTES — Bornage RRN (data.gouv.fr) + fallback Overpass (Feature 20)
# ══════════════════════════════════════════════════════════════════════════════
import math as _math
import csv as _csv_mod
import io as _io_mod

_PR_AUTOROUTES_TTL = 86400  # 24h
_pr_autoroutes_cache_lock = Lock()
_pr_autoroutes_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "pr_autoroutes_rrn_region"}

# Dataset officiel IGN/CEREMA — bornage du réseau routier national
_DATAGOUV_BORNAGE_URL = "https://www.data.gouv.fr/api/1/datasets/r/1543c04e-13bb-45b3-8da3-1b47a66c4541"
_PR_NEARBY_DEPARTMENTS = {"01", "26", "38", "42", "69", "73", "74"}
_PR_MAJOR_MOTORWAYS = {"A7", "A40", "A41", "A42", "A43", "A46", "A47", "A48", "A49", "A51", "A89", "A432", "A480"}

# Config Overpass (fallback)
_OSM_MOTORWAY_PR_CONFIG: dict[str, dict[str, Any]] = {
    "A41":  {"ref": "A 41",  "start_lat": 45.215, "start_lon": 5.840, "start_pr": 0,  "step": 5},
    "A43":  {"ref": "A 43",  "start_lat": 45.713, "start_lon": 5.052, "start_pr": 28, "step": 4},
    "A48":  {"ref": "A 48",  "start_lat": 45.182, "start_lon": 5.730, "start_pr": 0,  "step": 5},
    "A49":  {"ref": "A 49",  "start_lat": 45.138, "start_lon": 5.683, "start_pr": 0,  "step": 5},
    "A51":  {"ref": "A 51",  "start_lat": 45.140, "start_lon": 5.765, "start_pr": 0,  "step": 5},
    "A480": {"ref": "A 480", "start_lat": 45.156, "start_lon": 5.690, "start_pr": 0,  "step": 1},
}
_PR_ISERE_BBOX = "44.7,4.8,45.75,6.5"


def _lambert93_to_wgs84(x_l93: float, y_l93: float) -> tuple[float, float]:
    """Convertit des coordonnées Lambert-93 (EPSG:2154) en WGS84 (lat, lon degrés).
    RGF93 ≈ WGS84 à <1cm — aucun changement de datum nécessaire."""
    # Ellipsoïde GRS80 (Lambert93 / RGF93)
    a = 6378137.0
    e = 0.08181919084262149   # excentricité = sqrt(2f - f²), f = 1/298.257222101

    # Paramètres de projection Lambert93 (EPSG:2154)
    lam0 = _math.radians(3.0)     # méridien central
    phi0 = _math.radians(46.5)    # latitude d'origine
    phi1 = _math.radians(44.0)    # 1er parallèle standard
    phi2 = _math.radians(49.0)    # 2e parallèle standard
    E0, N0 = 700000.0, 6600000.0  # faux-est, faux-nord

    def _m(phi: float) -> float:
        return _math.cos(phi) / _math.sqrt(1.0 - e**2 * _math.sin(phi)**2)

    def _t(phi: float) -> float:
        sp = _math.sin(phi)
        return _math.tan(_math.pi / 4.0 - phi / 2.0) * ((1.0 + e * sp) / (1.0 - e * sp)) ** (e / 2.0)

    m1, m2 = _m(phi1), _m(phi2)
    t0, t1, t2 = _t(phi0), _t(phi1), _t(phi2)

    n  = (_math.log(m1) - _math.log(m2)) / (_math.log(t1) - _math.log(t2))
    F  = m1 / (n * t1 ** n)
    r0 = a * F * t0 ** n

    dE = x_l93 - E0
    dN = y_l93 - N0
    r_prime = _math.copysign(_math.sqrt(dE**2 + (r0 - dN)**2), n)
    theta   = _math.atan2(dE, r0 - dN)
    t_prime = abs(r_prime / (a * F)) ** (1.0 / n)

    lam = theta / n + lam0

    # Itération convergente pour la latitude géodésique
    phi = _math.pi / 2.0 - 2.0 * _math.atan(t_prime)
    for _ in range(15):
        sp = _math.sin(phi)
        phi_new = _math.pi / 2.0 - 2.0 * _math.atan(
            t_prime * ((1.0 - e * sp) / (1.0 + e * sp)) ** (e / 2.0)
        )
        if abs(phi_new - phi) < 1e-12:
            phi = phi_new
            break
        phi = phi_new

    return _math.degrees(phi), _math.degrees(lam)


def _fetch_pr_from_datagouv() -> dict[str, list[dict[str, Any]]]:
    """Télécharge le CSV bornage RRN (data.gouv.fr) et extrait les PR des autoroutes isèroises."""
    resp = _requests.get(
        _DATAGOUV_BORNAGE_URL,
        timeout=60,
        headers={"User-Agent": _BROWSER_UA, "Accept": "text/csv,*/*"},
        allow_redirects=True,
    )
    resp.raise_for_status()

    # Détecter l'encodage et le séparateur
    raw = resp.content
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1", errors="replace")

    # Détecter le séparateur (;  ou ,)
    first_line = text.split("\n")[0]
    sep = ";" if first_line.count(";") > first_line.count(",") else ","

    import re as _re_mod

    roads: dict[str, list[dict[str, Any]]] = {}
    seen: set[tuple[str, float]] = set()  # (route, pr) pour éviter les doublons (cote D/G)

    reader = _csv_mod.DictReader(_io_mod.StringIO(text), delimiter=sep)
    for row in reader:
        # Normaliser les noms de colonnes
        row = {k.strip(): v.strip() if isinstance(v, str) else v for k, v in row.items()}

        # Couvrir l'Isère et les grands axes autoroutiers régionaux à proximité.
        dep = (row.get("depPr") or row.get("DEPPR") or "").strip()
        if dep not in _PR_NEARBY_DEPARTMENTS:
            continue

        # Extraire le nom de la route depuis le code complexe (ex: "38A048..." → "A48")
        route_code = (row.get("route") or row.get("Route") or "").strip().upper()
        m = _re_mod.search(r'A(\d{2,3})', route_code)
        if not m:
            continue
        digits = m.group(1).lstrip("0") or "0"
        route = "A" + digits  # "048" → "A48", "480" → "A480"
        if route not in _PR_MAJOR_MOTORWAYS:
            continue

        # Utiliser le vrai numéro de PR routier pour pouvoir interpoler correctement
        # les événements du type "PR 75+363". `cumul` sert au chaînage interne mais
        # ne correspond pas au repère affiché sur le terrain sur certains axes (A48…).
        pr_raw = (row.get("pr") or row.get("PR") or "").replace(",", ".").strip()
        try:
            pr_val = float(pr_raw)
        except (ValueError, TypeError):
            continue

        key = (route, round(pr_val, 3))
        if key in seen:
            continue  # ignorer les doublons (côté G si côté D déjà présent)
        seen.add(key)

        # Coordonnées Lambert93
        x_raw = (row.get("x") or row.get("X") or "").replace(",", ".").strip()
        y_raw = (row.get("y") or row.get("Y") or "").replace(",", ".").strip()
        try:
            x_val = float(x_raw)
            y_val = float(y_raw)
        except (ValueError, TypeError):
            continue
        if x_val == 0.0 or y_val == 0.0:
            continue

        # Conversion Lambert93 → WGS84
        try:
            lat, lon = _lambert93_to_wgs84(x_val, y_val)
        except Exception:
            continue

        if route not in roads:
            roads[route] = []
        roads[route].append({"k": round(pr_val, 1), "lat": round(lat, 6), "lon": round(lon, 6)})

    # Trier par numéro de PR croissant
    for road in roads:
        roads[road].sort(key=lambda p: p["k"])

    return roads


def _hav_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = _math.radians(lat2 - lat1)
    dlon = _math.radians(lon2 - lon1)
    a = _math.sin(dlat / 2) ** 2 + _math.cos(_math.radians(lat1)) * _math.cos(_math.radians(lat2)) * _math.sin(dlon / 2) ** 2
    return R * 2 * _math.asin(_math.sqrt(a))


def _sample_polyline_km(coords: list[tuple[float, float]], start_pr: float, step: float) -> list[dict[str, Any]]:
    """Échantillonne une polyligne (lat, lon) tous les `step` km à partir de `start_pr`."""
    pts: list[dict[str, Any]] = []
    traveled = 0.0
    next_mark = float(start_pr)
    for i in range(len(coords) - 1):
        lat0, lon0 = coords[i]
        lat1, lon1 = coords[i + 1]
        seg = _hav_km(lat0, lon0, lat1, lon1)
        while next_mark <= traveled + seg + 1e-9:
            t = (next_mark - traveled) / seg if seg > 1e-9 else 0.0
            pts.append({
                "k": round(next_mark, 1),
                "lat": round(lat0 + t * (lat1 - lat0), 6),
                "lon": round(lon0 + t * (lon1 - lon0), 6),
            })
            next_mark += step
        traveled += seg
    return pts


def _chain_osm_ways(ways: list[list[tuple[float, float]]], start_lat: float, start_lon: float) -> list[tuple[float, float]]:
    """Ordonne et chaîne les segments OSM en une polyligne continue depuis (start_lat, start_lon)."""
    if not ways:
        return []

    def _d(la1: float, lo1: float, la2: float, lo2: float) -> float:
        return _hav_km(la1, lo1, la2, lo2)

    # Trouver le segment le plus proche du point de départ
    def _min_dist_to_start(nodes: list[tuple[float, float]]) -> float:
        return min(_d(start_lat, start_lon, nodes[0][0], nodes[0][1]),
                   _d(start_lat, start_lon, nodes[-1][0], nodes[-1][1]))

    remaining = [list(w) for w in ways]
    remaining.sort(key=_min_dist_to_start)
    first = remaining.pop(0)

    # Orienter le premier segment (l'extrémité la plus proche du point de départ = début)
    if (_d(start_lat, start_lon, first[-1][0], first[-1][1]) <
            _d(start_lat, start_lon, first[0][0], first[0][1])):
        first = list(reversed(first))

    chain: list[list[tuple[float, float]]] = [first]

    MAX_GAP_KM = 1.0  # tolérance pour connecter deux segments
    while remaining:
        end_lat, end_lon = chain[-1][-1]
        best_i, best_d, best_rev = -1, float("inf"), False
        for i, seg in enumerate(remaining):
            d_start = _d(end_lat, end_lon, seg[0][0], seg[0][1])
            d_end   = _d(end_lat, end_lon, seg[-1][0], seg[-1][1])
            d = min(d_start, d_end)
            if d < best_d:
                best_d, best_i, best_rev = d, i, d_end < d_start
        if best_i < 0 or best_d > MAX_GAP_KM:
            break
        nxt = remaining.pop(best_i)
        if best_rev:
            nxt = list(reversed(nxt))
        chain.append(nxt)

    # Aplatir (éviter les doublons aux jonctions)
    flat: list[tuple[float, float]] = []
    for seg in chain:
        if flat:
            flat.extend(seg[1:])
        else:
            flat.extend(seg)
    return flat


def _fetch_pr_one_road(road: str, cfg: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """Requête Overpass pour une autoroute — retourne (road, pts) ou (road, [])."""
    query = f"""[out:json][timeout:60];
(way["highway"="motorway"]["ref"="{cfg['ref']}"]({_PR_ISERE_BBOX}););
out geom;
"""
    try:
        elements = _overpass_fetch_institutions(query)
        ways: list[list[tuple[float, float]]] = []
        for el in elements:
            if el.get("type") != "way":
                continue
            geom = el.get("geometry") or []
            nodes = [(n["lat"], n["lon"]) for n in geom if "lat" in n and "lon" in n]
            if len(nodes) >= 2:
                ways.append(nodes)
        if not ways:
            return road, []
        coords = _chain_osm_ways(ways, cfg["start_lat"], cfg["start_lon"])
        if len(coords) < 2:
            return road, []
        pts = _sample_polyline_km(coords, cfg["start_pr"], cfg["step"])
        return road, pts
    except Exception:
        return road, []


def _fetch_pr_autoroutes_live() -> dict[str, Any]:
    """Récupère les positions PR :
    1) data.gouv.fr — Bornage RRN (source officielle, coordonnées Lambert93 converties en WGS84)
    2) Overpass OSM (fallback si data.gouv.fr inaccessible)
    """
    # ── Source 1 : data.gouv.fr Bornage RRN ──────────────────────────────────
    try:
        roads = _fetch_pr_from_datagouv()
        if roads and len(roads) >= 3:  # au moins 3 routes trouvées = succès
            return {
                "roads": roads,
                "source": "data.gouv.fr / Bornage RRN (IGN)",
                "updated_at": datetime.utcnow().isoformat() + "Z",
            }
    except Exception:
        pass

    # ── Source 2 : Overpass OSM (fallback) ───────────────────────────────────
    result: dict[str, list[dict[str, Any]]] = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(_fetch_pr_one_road, road, cfg): road
                   for road, cfg in _OSM_MOTORWAY_PR_CONFIG.items()}
        for fut in futures:
            try:
                road, pts = fut.result(timeout=90)
                if pts:
                    result[road] = pts
            except Exception:
                continue
    return {
        "roads": result,
        "source": "OpenStreetMap / Overpass (fallback)",
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_pr_autoroutes(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_pr_autoroutes_cache,
        lock=_pr_autoroutes_cache_lock,
        ttl_seconds=_PR_AUTOROUTES_TTL,
        force_refresh=force_refresh,
        loader=_fetch_pr_autoroutes_live,
    )


# ─── 1. APRR/AREA · Autoroutes Isère (A41, A43, A48, A51) ────────────────────
_APRR_ISERE_CACHE_TTL = 180
_aprr_isere_cache_lock = Lock()
_aprr_isere_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "aprr_isere"}
_APRR_ISERE_ROUTES = ["A41", "A43", "A48", "A51"]

# Points de repère (PR) → (lat, lon) par autoroute pour interpolation linéaire.
# Snapshot officiel issu du bornage RRN data.gouv.fr (mise à jour 2025-07-22).
_APRR_PR_ROAD_COORDS: dict[str, list[tuple[float, float, float]]] = {
    "A41": [
        (0, 45.200545, 5.759221), (1, 45.202649, 5.771386), (2, 45.204464, 5.783846),
        (3, 45.206932, 5.796071), (4, 45.210893, 5.807473), (5, 45.217223, 5.816476),
        (6, 45.224641, 5.823679), (7, 45.231565, 5.831715), (8, 45.237508, 5.841266),
        (9, 45.241611, 5.852545), (10, 45.245236, 5.86407), (11, 45.250451, 5.874709),
        (12, 45.256732, 5.883685), (13, 45.263619, 5.89194), (14, 45.270526, 5.899549),
        (15, 45.278176, 5.906883), (16, 45.285815, 5.913552), (17, 45.293749, 5.91973),
        (18, 45.301773, 5.925282), (19, 45.30955, 5.93176), (20, 45.316281, 5.940161),
        (21, 45.322525, 5.949307), (22, 45.32966, 5.957152), (23, 45.33768, 5.962869),
        (24, 45.346308, 5.966313), (25, 45.355153, 5.968739), (26, 45.363852, 5.97195),
        (27, 45.372367, 5.97604), (28, 45.380734, 5.980736), (29, 45.388889, 5.985983),
        (30, 45.39702, 5.991438), (31, 45.405143, 5.997033), (32, 45.413855, 5.999419),
        (33, 45.422841, 5.99786), (34, 45.431444, 6.000984), (35, 45.440252, 6.003791),
        (36, 45.449179, 6.003475), (37, 45.457535, 6.007851),
    ],
    "A43": [
        (16, 45.6651, 5.059739), (17, 45.660979, 5.071127), (18, 45.657073, 5.082681),
        (19, 45.654498, 5.094645), (20, 45.651816, 5.107528), (21, 45.64809, 5.119882),
        (22, 45.646129, 5.131696), (23, 45.642743, 5.143248), (24, 45.637087, 5.153157),
        (25, 45.631234, 5.162912), (26, 45.626202, 5.173669), (27, 45.620761, 5.183961),
        (28, 45.616082, 5.19477), (29, 45.613322, 5.20697), (30, 45.611554, 5.219811),
        (31, 45.608327, 5.23149), (32, 45.605817, 5.24368), (33, 45.603323, 5.256067),
        (34, 45.600743, 5.26836), (35, 45.596484, 5.279678), (36, 45.593416, 5.291409),
        (37, 45.587436, 5.300846), (38, 45.578842, 5.304404), (39, 45.572987, 5.313573),
        (40, 45.571709, 5.326201), (41, 45.569064, 5.338171), (42, 45.565409, 5.349892),
        (43, 45.563998, 5.362646), (44, 45.562081, 5.374925), (45, 45.560015, 5.387367),
        (46, 45.559546, 5.400248), (47, 45.560266, 5.412966), (48, 45.560764, 5.425689),
        (49, 45.560941, 5.438832), (50, 45.558992, 5.450815), (51, 45.557642, 5.463252),
        (52, 45.561338, 5.474963), (53, 45.563542, 5.487273), (54, 45.563827, 5.499945),
        (55, 45.564204, 5.512424), (56, 45.56524, 5.52529), (57, 45.566735, 5.538154),
        (58, 45.568938, 5.550082), (59, 45.570519, 5.562604), (60, 45.569425, 5.575475),
        (61, 45.570327, 5.587745), (62, 45.571945, 5.600771), (63, 45.576624, 5.611629),
        (64, 45.578944, 5.623965), (65, 45.576897, 5.636276), (66, 45.573497, 5.647994),
    ],
    "A48": [
        (41, 45.566344, 5.346575), (42, 45.564058, 5.348311), (43, 45.556394, 5.354566),
        (44, 45.550937, 5.364705), (45, 45.545858, 5.374697), (46, 45.542202, 5.386217),
        (47, 45.537194, 5.396623), (48, 45.532328, 5.407076), (49, 45.523864, 5.410492),
        (50, 45.515281, 5.407277), (51, 45.507243, 5.401478), (52, 45.498447, 5.399077),
        (53, 45.489389, 5.398917), (54, 45.480465, 5.398321), (55, 45.471523, 5.400019),
        (56, 45.46253, 5.401759), (57, 45.45379, 5.400484), (58, 45.445251, 5.401381),
        (59, 45.439444, 5.411119), (60, 45.434261, 5.421329), (61, 45.427762, 5.430137),
        (62, 45.424485, 5.441948), (63, 45.419447, 5.452431), (64, 45.413183, 5.461263),
        (65, 45.40457, 5.46411), (66, 45.395701, 5.466577), (67, 45.387644, 5.471981),
        (68, 45.380293, 5.479419), (69, 45.372778, 5.486336), (70, 45.36972, 5.498137),
        (71, 45.365005, 5.509051), (72, 45.358665, 5.518), (73, 45.354428, 5.528632),
        (74, 45.351217, 5.540758), (75, 45.347075, 5.551837), (76, 45.344953, 5.56422),
        (77, 45.340185, 5.574933), (78, 45.334396, 5.584839), (79, 45.328365, 5.594161),
        (80, 45.322535, 5.603928), (81, 45.315765, 5.612214), (82, 45.308044, 5.618745),
        (83, 45.29939, 5.621541), (84, 45.290486, 5.619992), (85, 45.281677, 5.621881),
        (86, 45.273054, 5.62561), (87, 45.26496, 5.630944), (88, 45.25824, 5.639576),
        (89, 45.252358, 5.649169), (90, 45.245078, 5.656488), (91, 45.236962, 5.661991),
        (92, 45.228734, 5.666766), (93, 45.220753, 5.67277),
    ],
    "A49": [
        (0, 45.290875, 5.620164), (1, 45.298814, 5.619243), (2, 45.303933, 5.608772),
        (3, 45.304657, 5.596264), (4, 45.300462, 5.585094), (5, 45.298585, 5.573242),
        (6, 45.297835, 5.561022), (7, 45.29421, 5.549697), (8, 45.293294, 5.537035),
        (9, 45.288897, 5.526285), (10, 45.280285, 5.523314), (11, 45.27151, 5.520551),
        (12, 45.263094, 5.516374), (13, 45.255633, 5.50926), (14, 45.247826, 5.503037),
        (15, 45.240243, 5.496326), (16, 45.234464, 5.486706), (17, 45.226408, 5.481441),
        (18, 45.217986, 5.477235), (19, 45.211502, 5.468605), (20, 45.208901, 5.456587),
        (21, 45.205901, 5.444573), (22, 45.202684, 5.4327), (23, 45.19779, 5.422083),
        (24, 45.191121, 5.413584), (25, 45.184509, 5.405087), (26, 45.177794, 5.39675),
        (27, 45.173008, 5.386039), (28, 45.167614, 5.37585), (29, 45.162153, 5.365775),
        (30, 45.154975, 5.358333), (31, 45.148091, 5.350436), (32, 45.142889, 5.340121),
        (33, 45.137831, 5.32969), (34, 45.133525, 5.318547), (35, 45.12999, 5.306961),
        (36, 45.125094, 5.296414), (37, 45.124019, 5.283884), (38, 45.120712, 5.272157),
        (39, 45.11545, 5.261848), (40, 45.108322, 5.254398), (41, 45.103178, 5.244203),
        (42, 45.099762, 5.232474), (43, 45.094171, 5.222666), (44, 45.086292, 5.216565),
    ],
    "A51": [
        (0, 45.115561, 5.683907), (1, 45.107525, 5.67857), (2, 45.09907, 5.674041),
        (3, 45.090991, 5.669034), (4, 45.08404, 5.6759), (5, 45.075827, 5.679466),
        (6, 45.066945, 5.681188), (7, 45.058429, 5.684915), (8, 45.049762, 5.684957),
        (9, 45.04493, 5.67509), (10, 45.039603, 5.665347), (11, 45.030855, 5.662378),
        (12, 45.022061, 5.661403), (13, 45.0133, 5.658195), (14, 45.004556, 5.655462),
        (15, 44.995951, 5.652125), (16, 44.987286, 5.648963), (17, 44.978592, 5.646041),
        (18, 44.969781, 5.64341), (19, 44.961828, 5.648211), (20, 44.955017, 5.655644),
        (21, 44.946762, 5.651194), (22, 44.939097, 5.644513), (23, 44.931388, 5.638998),
        (24, 44.924768, 5.630682), (25, 44.9173, 5.624934), (26, 44.909011, 5.625768),
    ],
    "A480": [
        (0, 45.217774, 5.67611), (1, 45.211622, 5.684988), (2, 45.204559, 5.691199),
        (3, 45.197843, 5.70074), (4, 45.189302, 5.702644), (5, 45.180286, 5.702359),
        (6, 45.171168, 5.701954), (7, 45.16219, 5.701546), (8, 45.153591, 5.698247),
        (9, 45.14521, 5.694262), (10, 45.136651, 5.690554), (11, 45.127678, 5.690999),
        (12, 45.119404, 5.686422), (13, 45.110393, 5.681475),
    ],
}


def _aprr_pr_to_coords(road: str, pr_str: str) -> tuple[float, float] | None:
    """Convertit un PR type '75+363' ou '75' en (lat, lon) par interpolation linéaire.
    Utilise les données OSM Overpass si disponibles, sinon les coordonnées statiques."""
    try:
        parts = pr_str.split("+")
        km = float(parts[0])
        m = float(parts[1]) / 1000 if len(parts) > 1 else 0.0
        pr_km = km + m
    except (ValueError, IndexError):
        return None

    # Essayer d'abord les données OSM (plus précises)
    osm_payload = _pr_autoroutes_cache.get("payload")
    osm_pts = (osm_payload or {}).get("roads", {}).get(road)
    if osm_pts:
        if pr_km <= osm_pts[0]["k"]:
            return osm_pts[0]["lat"], osm_pts[0]["lon"]
        if pr_km >= osm_pts[-1]["k"]:
            return osm_pts[-1]["lat"], osm_pts[-1]["lon"]
        for i in range(len(osm_pts) - 1):
            k0, k1 = osm_pts[i]["k"], osm_pts[i + 1]["k"]
            if k0 <= pr_km <= k1:
                t = (pr_km - k0) / (k1 - k0) if k1 > k0 else 0.0
                return (osm_pts[i]["lat"] + t * (osm_pts[i + 1]["lat"] - osm_pts[i]["lat"]),
                        osm_pts[i]["lon"] + t * (osm_pts[i + 1]["lon"] - osm_pts[i]["lon"]))

    # Fallback : coordonnées statiques
    coords = _APRR_PR_ROAD_COORDS.get(road)
    if not coords:
        return None

    if pr_km <= coords[0][0]:
        return coords[0][1], coords[0][2]
    if pr_km >= coords[-1][0]:
        return coords[-1][1], coords[-1][2]

    for i in range(len(coords) - 1):
        k0, lat0, lon0 = coords[i]
        k1, lat1, lon1 = coords[i + 1]
        if k0 <= pr_km <= k1:
            t = (pr_km - k0) / (k1 - k0)
            return lat0 + t * (lat1 - lat0), lon0 + t * (lon1 - lon0)
    return None

# Routes APRR/AREA passant par ou desservant l'Isère
_APRR_ISERE_ROAD_SET: frozenset[str] = frozenset({
    "A41", "A43", "A48", "A51", "A480", "A49",
})
_APRR_ROAD_PATTERN = re.compile(r'\b(A41|A43|A48|A51|A480|A49)\b', re.IGNORECASE)

# URL de la synthèse nationale Bison Futé — inclut DATEX2 de APRR/AREA/Escota (réseau concédé)
_BISON_RECAP_URL = (
    "http://tipi.bison-fute.gouv.fr/bison-fute-ouvert/publicationsDIR/"
    "Evenementiel-DIR/cnir/RecapTraficFranceEntiere.html"
)


def _parse_bison_recap_aprr(html: str) -> list[dict[str, Any]]:
    """Extrait les événements APRR/AREA depuis la page HTML récapitulative Bison Futé.

    La page contient des blocs <div class="interligne"> structurés avec des <span qname="...">
    pour chaque champ (axe, nature, commune, commentaire, origine…).
    Elle agrège tous les opérateurs y compris les réseaux concédés (SCA APRR/AREA DATEXII).
    """
    events: list[dict[str, Any]] = []

    def _span(block: str, qname: str) -> str:
        m = re.search(rf'qname="{re.escape(qname)}"[^>]*>(.*?)</span>', block, re.DOTALL)
        return re.sub(r"<[^>]+>", "", m.group(1)).strip() if m else ""

    def _importance_to_level(stars: str) -> str:
        s = stars.strip()
        if s.count("*") >= 3:
            return "rouge"
        if s.count("*") >= 2:
            return "orange"
        return "jaune"

    blocks = re.findall(r'<div class="interligne">(.*?)</div>', html, re.DOTALL)
    for block in blocks:
        road_raw = _span(block, "axe")
        road = road_raw.strip().upper()

        # Garder seulement les routes Isère APRR/AREA
        if not _APRR_ROAD_PATTERN.search(road):
            continue

        importance = _span(block, "importance_vr_reduit") or _span(block, "importance_vr")
        level = _importance_to_level(importance)

        # Type d'événement
        nature = (
            _span(block, "nature_restriction")
            or _span(block, "nature_obstacle")
            or _span(block, "nature_bouchon")
            or "Événement"
        )

        # Localisation
        commune = _span(block, "commune")
        pr = _span(block, "pr")
        direction = _span(block, "sens_par_pole") or _span(block, "sens_cardinal")
        bretelle = _span(block, "bretelle") or _span(block, "complementaire")

        # Description publique
        commentaire = _span(block, "commentaire_public")

        # Heure de fin prévue
        end_time = (
            _span(block, "horodate_fin_complet_ve_evt_encours")
            or _span(block, "horodate_fin_complet_ve")
            or _span(block, "separator-date")
        )

        # Opérateur source (APRR / AREA / Escota / …)
        origine = _span(block, "origine_vr")

        # Construction du titre et de la description
        title_parts = [nature, road.strip()]
        if direction:
            title_parts.append(direction)
        title = " · ".join(p for p in title_parts if p)

        desc_parts = []
        if commune:
            desc_parts.append(f"à {commune}")
        if pr:
            desc_parts.append(f"PR {pr}")
        if bretelle:
            desc_parts.append(bretelle)
        if commentaire:
            desc_parts.append(commentaire)
        if end_time:
            desc_parts.append(f"Prévu jusqu'au : {end_time}")
        if origine:
            desc_parts.append(f"[{origine}]")
        description = " — ".join(p for p in desc_parts if p)

        evt: dict[str, Any] = {
            "title": title[:160],
            "description": description[:500],
            "road": road.strip(),
            "type": nature[:60],
            "level": level,
            "start": "",
            "end": end_time[:60] if end_time else "",
            "severity": level,
            "source": "Bison Futé / APRR AREA DATEXII",
            "pr": pr,
            "direction": direction[:120] if direction else "",
            "access": bretelle[:160] if bretelle else "",
            "commune": commune[:80] if commune else "",
        }
        if pr:
            coords = _aprr_pr_to_coords(road.strip(), pr)
            if coords:
                evt["lat"], evt["lon"] = coords
        events.append(evt)

    return events


def _fetch_aprr_isere_live() -> dict[str, Any]:
    """Événements temps réel APRR/AREA sur A41/A43/A48/A51 via Bison Futé récapitulatif national.

    La page RecapTraficFranceEntiere.html agrège le DATEX2 de TOUS les opérateurs
    (DIR pour le réseau non-concédé ET SCA APRR/AREA/Escota pour le réseau concédé).
    C'est la seule source publique accessible sans authentification pour les autoroutes APRR.
    """
    events: list[dict[str, Any]] = []
    source_used = _BISON_RECAP_URL

    try:
        hdrs = {"User-Agent": _BROWSER_UA, "Accept": "text/html,*/*"}
        if _REQUESTS_OK and _requests is not None:
            resp = _requests.get(_BISON_RECAP_URL, headers=hdrs, timeout=20, verify=False)
            resp.raise_for_status()
            try:
                html = resp.content.decode("utf-8")
            except UnicodeDecodeError:
                html = resp.content.decode("iso-8859-1", errors="replace")
        else:
            html = _http_get_text(_BISON_RECAP_URL, timeout=20, headers=hdrs)

        if html:
            events = _parse_bison_recap_aprr(html)
    except Exception:
        pass

    # Fallback : filtrer le DATEX2 RRN (réseau non-concédé, peu de routes APRR mais parfois utile)
    if not events:
        try:
            bison_data = fetch_bison_fute_live_events()
            all_events: list[dict[str, Any]] = bison_data.get("events") or []
            for evt in all_events:
                road = str(evt.get("road") or "")
                blob = f"{road} {evt.get('title', '')} {evt.get('description', '')} {evt.get('location_summary', '')}"
                if _APRR_ROAD_PATTERN.search(blob):
                    events.append({
                        "title": str(evt.get("title") or "Événement trafic")[:120],
                        "type": str(evt.get("category") or "inconnu"),
                        "road": road,
                        "description": str(evt.get("description") or "")[:400],
                        "start": str(evt.get("validity_start") or ""),
                        "end": str(evt.get("validity_end") or ""),
                        "level": str(evt.get("severity") or "jaune"),
                        "severity": str(evt.get("severity") or "jaune"),
                        "source": "Bison Futé DATEX2 RRN",
                    })
            if events:
                source_used = "https://www.bison-fute.gouv.fr (DATEX2 RRN)"
        except Exception:
            pass

    return {
        "service": "APRR/AREA · Autoroutes Isère",
        "status": "online",
        "source": source_used,
        "routes": _APRR_ISERE_ROUTES,
        "events": events[:15],
        "events_total": len(events),
        "normal_service": len(events) == 0,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_aprr_isere_traffic(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_aprr_isere_cache,
        lock=_aprr_isere_cache_lock,
        ttl_seconds=_APRR_ISERE_CACHE_TTL,
        force_refresh=force_refresh,
        loader=_fetch_aprr_isere_live,
    )


# ─── 2. M Réseau · Trams, bus et cars de l'agglomération grenobloise ──────────
_MRESEAU_CACHE_TTL = 120
_mreseau_cache_lock = Lock()
_mreseau_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "mreseau"}

_MRESEAU_INFOTRAFIC_URL = "https://www.reso-m.fr/55-infotrafic.htm"
_MRESEAU_LINES_TRAM: tuple[str, ...] = ("A", "B", "C", "D", "E")
_MRESEAU_DISRUPTION_WORDS: frozenset[str] = frozenset({
    "perturbation", "travaux", "déviation", "interrompu", "supprimé",
    "retard", "incident", "modification", "info trafic", "information trafic",
    "régulation", "ralentissement", "dégradé", "partiellement", "limité",
    "arrêt", "suspension",
})


def _parse_mreseau_level(text: str) -> str:
    tl = text.lower()
    if any(w in tl for w in ("interrompu", "supprimé", "totalement", "complètement")):
        return "rouge"
    if any(w in tl for w in ("important", "majeur", "fortement", "significatif")):
        return "orange"
    return "jaune"


def _parse_mreseau_line(text: str) -> str:
    """Identifie la ligne M Réseau depuis un texte libre."""
    for letter in ("A", "B", "C", "D", "E"):
        if re.search(rf'\b(?:tram(?:way)?\s+)?(?:ligne\s+)?{letter}\b', text, re.IGNORECASE):
            return f"Tram {letter}"
    m = re.search(r'\blignes?\s+([A-Z]?\d{{1,3}})\b', text, re.IGNORECASE)
    if m:
        return f"Ligne {m.group(1).upper()}"
    m = re.search(r'\b([CEKST]\d{{1,3}})\b', text, re.IGNORECASE)
    if m:
        return f"Ligne {m.group(1).upper()}"
    for special in ("Proximo", "Flexo", "Chrono", "Atoubus", "Métrocâble", "Téléphérique"):
        if special.lower() in text.lower():
            return special
    return "Réseau M"


def _fetch_mreseau_live() -> dict[str, Any]:
    """Perturbations M Réseau — trams, bus et cars agglomération grenobloise.

    Sources par ordre de priorité :
    1. Page info-trafic officielle reso-m.fr/55-infotrafic.htm
    2. API perturbations data.mobilites-m.fr
    3. GTFS-RT service alerts Isère Mobilités (transport.data.gouv.fr)
    """
    disruptions: list[dict[str, Any]] = []
    source_used = ""
    normal_service = False
    _hdrs = {
        "User-Agent": _BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/json,*/*",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Referer": "https://www.reso-m.fr/",
    }

    # ── Source 1 : scraping HTML reso-m.fr/55-infotrafic.htm ──────────────────
    try:
        html = ""
        if _REQUESTS_OK and _requests is not None:
            resp = _requests.get(_MRESEAU_INFOTRAFIC_URL, headers=_hdrs, timeout=15, verify=False)
            resp.raise_for_status()
            html = resp.text
        else:
            html = _http_get_text(_MRESEAU_INFOTRAFIC_URL, timeout=15, headers=_hdrs)

        if re.search(
            r'aucune?\s+perturbation|trafic\s+normal|service\s+normal|pas\s+de\s+perturbation|aucun\s+incident',
            html, re.IGNORECASE,
        ):
            normal_service = True

        seen: set[str] = set()

        # Pattern 1 : divs/articles avec classe indicatrice
        item_blocks = re.findall(
            r'<(?:div|article|li|section)\b[^>]*class=["\'][^"\']*'
            r'(?:info|trafic|perturbation|alerte|incident|ligne|disruption|alert)[^"\']*["\'][^>]*>'
            r'([\s\S]{30,3000}?)'
            r'</(?:div|article|li|section)>',
            html, re.IGNORECASE,
        )
        # Pattern 2 : fallback large si pattern 1 vide
        if not item_blocks:
            item_blocks = re.findall(
                r'<(?:article|li)\b[^>]*>([\s\S]{40,2000}?)</(?:article|li)>',
                html, re.IGNORECASE,
            )
        # Pattern 3 : paragraphes / spans contenant des mots-clés de perturbation
        if not item_blocks:
            item_blocks = re.findall(
                r'<(?:p|span)\b[^>]*>([\s\S]{40,800}?)</(?:p|span)>',
                html, re.IGNORECASE,
            )

        for block in item_blocks:
            text = re.sub(r"<[^>]+>", " ", block)
            text = re.sub(r"\s+", " ", unescape(text)).strip()
            if len(text) < 30:
                continue
            tl = text.lower()
            if not any(w in tl for w in _MRESEAU_DISRUPTION_WORDS):
                continue
            if _is_german_alert(text):
                continue
            key = text[:70].lower()
            if key in seen:
                continue
            seen.add(key)
            # Titre = première phrase courte
            title_m = re.match(r'^([^.!?\n]{10,120})', text)
            title = title_m.group(1).strip() if title_m else text[:100]
            line_label = _parse_mreseau_line(text)
            level = _parse_mreseau_level(text)
            date_m = re.search(
                r'(?:du|le|à\s+partir\s+du)\s+(\d{{1,2}}[/\-.]\d{{1,2}}(?:[/\-.]\d{{2,4}})?)',
                tl,
            )
            until_m = re.search(
                r"(?:jusqu'au|jusqu'à|au)\s+(\d{{1,2}}[/\-.]\d{{1,2}}(?:[/\-.]\d{{2,4}})?)",
                tl,
            )
            disruptions.append({
                "title": title[:120],
                "description": text[:400],
                "level": level,
                "line": line_label,
                "mode": "Tram" if line_label.startswith("Tram") else "Bus/Car",
                "valid_from": date_m.group(1) if date_m else "",
                "valid_until": until_m.group(1) if until_m else "",
            })

        if disruptions or normal_service:
            source_used = _MRESEAU_INFOTRAFIC_URL
    except Exception:
        pass

    # ── Source 2 : API data.mobilites-m.fr ────────────────────────────────────
    if not disruptions and not normal_service:
        for _api_url in (
            "https://data.mobilites-m.fr/api/perturbations/json",
            "https://data.mobilites-m.fr/api/disruptions/json",
        ):
            if disruptions:
                break
            try:
                data = _http_get_json(_api_url, timeout=12, headers={
                    "Accept": "application/json",
                    "User-Agent": _BROWSER_UA,
                })
                items = (
                    data if isinstance(data, list)
                    else data.get("disruptions") or data.get("features") or data.get("data") or []
                )
                for item in items[:50]:
                    props = item.get("properties") or item
                    title_raw = str(
                        props.get("cause") or props.get("title") or props.get("titre")
                        or props.get("libelle") or ""
                    )
                    desc_raw = str(
                        props.get("message") or props.get("description") or props.get("texte") or ""
                    )
                    if not title_raw and not desc_raw:
                        continue
                    combined = title_raw + " " + desc_raw
                    line_label = _parse_mreseau_line(combined)
                    severity = str(props.get("severity") or props.get("niveau") or "").lower()
                    level = "rouge" if any(w in severity for w in ("high", "grave", "severe")) else "jaune"
                    disruptions.append({
                        "title": title_raw[:120] or desc_raw[:80],
                        "description": (desc_raw or title_raw)[:400],
                        "level": level,
                        "line": line_label,
                        "mode": "Tram" if line_label.startswith("Tram") else "Bus/Car",
                        "valid_from": str(props.get("start_date") or props.get("debut") or ""),
                        "valid_until": str(props.get("end_date") or props.get("fin") or ""),
                    })
                if disruptions:
                    source_used = _api_url
            except Exception:
                continue

    # ── Source 3 : GTFS-RT service alerts Isère Mobilités ────────────────────
    if not disruptions and not normal_service:
        try:
            data = _http_get_json(
                "https://proxy.transport.data.gouv.fr/resource/isere-mobilites-gtfs-rt-service-alerts",
                timeout=10,
                headers={"Accept": "application/json", "User-Agent": _BROWSER_UA},
            )
            entities = data.get("entity") or data.get("alerts") or []
            for entity in entities[:40]:
                alert = entity.get("alert") or (entity if isinstance(entity, dict) else {})

                def _trans(field: str) -> str:
                    raw = alert.get(field)
                    if isinstance(raw, dict):
                        transl = raw.get("translation") or []
                        return str(transl[0].get("text", "") if transl else "")
                    return str(raw or "")

                header = _trans("headerText")
                desc = _trans("descriptionText")
                if not header and not desc:
                    continue
                if _is_german_alert(header + " " + desc):
                    continue
                combined = header + " " + desc
                line_label = _parse_mreseau_line(combined)
                disruptions.append({
                    "title": header[:120] or desc[:80],
                    "description": (desc or header)[:400],
                    "level": "jaune",
                    "line": line_label,
                    "mode": "Tram" if line_label.startswith("Tram") else "Bus/Car",
                    "valid_from": "",
                    "valid_until": "",
                })
            if disruptions:
                source_used = "isere-mobilites-gtfs-rt"
        except Exception:
            pass

    if not source_used:
        return {
            "service": "M Réseau",
            "status": "degraded",
            "source": _MRESEAU_INFOTRAFIC_URL,
            "disruptions": [],
            "disruptions_total": 0,
            "normal_service": False,
            "error": "Sources indisponibles",
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }

    return {
        "service": "M Réseau",
        "status": "online",
        "source": source_used,
        "disruptions": disruptions[:20],
        "disruptions_total": len(disruptions),
        "normal_service": normal_service and len(disruptions) == 0,
        "lines_tram": list(_MRESEAU_LINES_TRAM),
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_mreseau_disruptions(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_mreseau_cache,
        lock=_mreseau_cache_lock,
        ttl_seconds=_MRESEAU_CACHE_TTL,
        force_refresh=force_refresh,
        loader=_fetch_mreseau_live,
    )


# ─── 3. Vinci Autoroutes · Isère ──────────────────────────────────────────────
_VINCI_AUTOROUTES_CACHE_TTL = 180
_vinci_autoroutes_cache_lock = Lock()
_vinci_autoroutes_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "vinci_autoroutes"}
_VINCI_ISERE_ROUTES = ["A40", "A41", "A42", "A43"]


_VINCI_ROAD_PATTERN = re.compile(r'\bA(40|41|42|43)\b', re.IGNORECASE)


def _fetch_vinci_autoroutes_live() -> dict[str, Any]:
    """Filtre les événements Bison Futé DATEX2 pour les routes Vinci/AREA en Isère (A40,A41,A42,A43).
    Source fiable et déjà rafraîchie toutes les 5 min — aucun scraping SPA nécessaire."""
    bison_data = fetch_bison_fute_live_events()
    all_events: list[dict[str, Any]] = bison_data.get("events") or []
    events: list[dict[str, Any]] = []
    for evt in all_events:
        road = str(evt.get("road") or "")
        blob = f"{road} {evt.get('title', '')} {evt.get('description', '')} {evt.get('location_summary', '')}"
        if _VINCI_ROAD_PATTERN.search(blob):
            events.append({
                "title": str(evt.get("title") or "Événement trafic")[:120],
                "type": str(evt.get("category") or "inconnu"),
                "road": road,
                "description": str(evt.get("description") or "")[:400],
                "lat": evt.get("lat") or _ISERE_ROAD_COORDS.get(road, (45.19, 5.73))[0],
                "lon": evt.get("lon") or _ISERE_ROAD_COORDS.get(road, (45.19, 5.73))[1],
                "start": str(evt.get("validity_start") or ""),
                "end": str(evt.get("validity_end") or ""),
                "severity": str(evt.get("severity") or "jaune"),
            })
    return {
        "service": "Vinci Autoroutes · Isère",
        "status": "online",
        "source": "https://www.bison-fute.gouv.fr (DATEX2)",
        "routes": _VINCI_ISERE_ROUTES,
        "events": events[:10],
        "events_total": len(events),
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_vinci_autoroutes_isere(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_vinci_autoroutes_cache,
        lock=_vinci_autoroutes_cache_lock,
        ttl_seconds=_VINCI_AUTOROUTES_CACHE_TTL,
        force_refresh=force_refresh,
        loader=_fetch_vinci_autoroutes_live,
    )


# ─── 4. TER SNCF · Auvergne-Rhône-Alpes (trains Isère) ───────────────────────
_TER_AURA_CACHE_TTL = 120
_ter_aura_cache_lock = Lock()
_ter_aura_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "ter_aura"}
_TER_ISERE_GEO_KEYWORDS: tuple[str, ...] = (
    "isère", "isere", "grenoble", "voiron", "bourgoin", "vienne", "saint-marcellin",
    "romans", "valence", "chambéry", "chamb", "lyon", "genève", "briançon",
)

# Mots spécifiquement allemands qui indiquent une alerte en allemand à exclure
_GERMAN_ALERT_WORDS: frozenset[str] = frozenset({
    "verspätung", "zug hat", "baustelleninfo", "holzfällerarbeiten",
    "totalunterbrechung", "verkehrs", "gleis", "bahnhof", "fahrgäste",
    "fahrt", "ankunft", "abfahrt", "strecke zwischen", "betrieb",
    "störung", "sperrung", "ihr zug",
})


def _is_german_alert(text: str) -> bool:
    """Retourne True si le texte est clairement en allemand."""
    lower = text.lower()
    return sum(1 for w in _GERMAN_ALERT_WORDS if w in lower) >= 1


_TER_SIRI_NAMESPACES = [
    "http://www.siri.org.uk/siri",
    "http://wsdl.siri.org.uk/siri",
    "",  # sans namespace
]


def _parse_siri_situations(xml_text: str, geo_keywords: tuple[str, ...]) -> list[dict[str, Any]]:
    """Tente de parser un document SIRI SX avec plusieurs préfixes de namespace."""
    disruptions: list[dict[str, Any]] = []
    root = ET.fromstring(xml_text)
    for ns_uri in _TER_SIRI_NAMESPACES:
        prefix = f"{{{ns_uri}}}" if ns_uri else ""
        situations = root.findall(f".//{prefix}PtSituationElement")
        if not situations:
            situations = root.findall(".//PtSituationElement")
        for situation in situations:
            def _txt(tag: str) -> str:
                val = situation.findtext(f"{prefix}{tag}") or situation.findtext(tag) or ""
                return re.sub(r"\s+", " ", val.strip())
            summary = _txt("Summary")
            description = _txt("Description")
            text_blob = f"{summary} {description}".lower()
            if not any(kw in text_blob for kw in geo_keywords):
                continue
            severity = (_txt("Severity") or "").lower()
            level = "rouge" if severity in ("severe", "verysevere") else "orange" if severity in ("normal", "moderate") else "jaune"
            # Lignes affectées depuis affects/AffectedLine ou AffectedRoute
            affected_lines: list[str] = []
            for tag in ("AffectedLine/LineRef", "AffectedRoute/LineRef", "LineRef"):
                refs = situation.findall(f".//{prefix}{tag}") or situation.findall(f".//{tag}")
                for r in refs:
                    val = (r.text or "").strip()
                    if val and val not in affected_lines:
                        affected_lines.append(val)
            # Cause détaillée
            cause = _txt("ReasonName") or _txt("Reason") or ""
            advice = _txt("Advice") or ""
            detail = description
            if cause and cause.lower() not in detail.lower():
                detail = f"{cause} — {detail}" if detail else cause
            if advice and advice.lower() not in detail.lower():
                detail = f"{detail} | Conseil : {advice}" if detail else f"Conseil : {advice}"
            disruptions.append({
                "title": summary or "Perturbation TER",
                "description": detail[:600],
                "line": ", ".join(affected_lines[:3]) if affected_lines else "",
                "level": level,
                "valid_from": _txt("ValidityPeriod/StartTime") or _txt("StartTime"),
                "valid_until": _txt("ValidityPeriod/EndTime") or _txt("EndTime"),
            })
        if disruptions:
            break
    return disruptions


def _fetch_ter_aura_live() -> dict[str, Any]:
    # Source 1 (priorité) : SNCF Open Data — perturbations en français, structurées
    opendata_source = (
        "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/"
        "disruptions-semaines-a-venir-4-weeks/records"
        "?limit=25&where=region_code%3D%2284%22%20AND%20reseau_name%3D%22TER%22"
        "&order_by=date_debut%20desc"
    )
    # Source 2 : proxy transport.data.gouv.fr SIRI SX (peut contenir des alertes en allemand)
    siri_source = "https://proxy.transport.data.gouv.fr/resource/sncf-siri-lite-situation-exchange"
    # Source 3 : RSS TER AURA
    rss_source = "https://www.ter.sncf.com/auvergne-rhone-alpes/se-deplacer/info-trafic/rss"

    disruptions: list[dict[str, Any]] = []
    source_used = ""

    # --- Tentative 1 : SNCF Open Data JSON (français garanti) ---
    try:
        data = _http_get_json(
            opendata_source,
            timeout=12,
            headers={"Accept": "application/json", "User-Agent": _BROWSER_UA},
        )
        records = data.get("results") or data.get("records") or []
        for rec in records:
            fields = rec if isinstance(rec, dict) else {}
            title = str(fields.get("titre") or fields.get("title") or "Perturbation TER").strip()
            desc = str(
                fields.get("description") or fields.get("cause_detail") or
                fields.get("texte") or fields.get("message") or ""
            ).strip()
            # Enrichir la description avec la cause si distincte du titre
            cause = str(fields.get("cause") or fields.get("type_evenement") or "").strip()
            if cause and cause.lower() not in title.lower() and cause.lower() not in desc.lower():
                desc = f"{cause} — {desc}" if desc else cause
            if _is_german_alert(f"{title} {desc}"):
                continue
            # Ligne / axe impacté
            line_raw = str(
                fields.get("ligne_impactee") or fields.get("ligne") or
                fields.get("axe") or fields.get("line") or ""
            ).strip()
            # Période de validité
            valid_from = str(fields.get("date_debut") or fields.get("start_date") or fields.get("start") or "")
            valid_until = str(fields.get("date_fin") or fields.get("end_date") or fields.get("end") or "")
            # Niveau de gravité
            gravity = str(fields.get("gravite") or fields.get("severity") or "").lower()
            level = "rouge" if any(w in gravity for w in ("fort", "severe", "critiqu")) else \
                    "orange" if any(w in gravity for w in ("moyen", "modera")) else "jaune"
            disruptions.append({
                "title": title[:200],
                "description": desc[:600],
                "line": line_raw[:80] if line_raw else "",
                "level": level,
                "valid_from": valid_from,
                "valid_until": valid_until,
            })
        if records:
            source_used = opendata_source
    except Exception:
        pass

    # --- Tentative 2 : SIRI SX (avec filtre anti-allemand) ---
    if not source_used:
        try:
            xml_payload = _http_get_text(siri_source, timeout=15)
            raw = _parse_siri_situations(xml_payload, _TER_ISERE_GEO_KEYWORDS)
            # Filtrer les alertes en allemand (trains internationaux)
            disruptions = [d for d in raw if not _is_german_alert(f"{d.get('title','')} {d.get('description','')}")]
            if raw:
                source_used = siri_source
        except Exception:
            pass

    # --- Tentative 3 : RSS TER ---
    if not source_used:
        try:
            rss_text = _http_get_text(rss_source, timeout=12)
            root = ET.fromstring(rss_text)
            source_used = rss_source
            for item in root.findall(".//item")[:20]:
                title = (item.findtext("title") or "").strip()
                desc = _strip_html_tags(item.findtext("description") or "").strip()
                if _is_german_alert(f"{title} {desc}"):
                    continue
                if any(kw in f"{title} {desc}".lower() for kw in _TER_ISERE_GEO_KEYWORDS):
                    # Extraire ligne depuis le titre si possible (ex: "Ligne Grenoble - Valence")
                    line_m = re.search(
                        r'(?:ligne\s+|axe\s+|tgv\s+)?([A-Z][a-z]+(?:\s*[-–]\s*[A-Z][a-z]+)+)',
                        title, re.IGNORECASE
                    )
                    disruptions.append({
                        "title": title[:200],
                        "description": desc[:600],
                        "line": line_m.group(1)[:80] if line_m else "",
                        "level": "jaune",
                        "valid_from": (item.findtext("pubDate") or "").strip(),
                        "valid_until": (item.findtext("dc:date") or "").strip(),
                    })
        except Exception:
            pass

    if not source_used:
        return {
            "service": "TER SNCF · Auvergne-Rhône-Alpes",
            "status": "degraded",
            "source": siri_source,
            "disruptions": [],
            "disruptions_total": 0,
            "error": "Sources SIRI, OpenData et RSS indisponibles",
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    return {
        "service": "TER SNCF · Auvergne-Rhône-Alpes",
        "status": "online",
        "source": source_used,
        "disruptions": disruptions[:10],
        "disruptions_total": len(disruptions),
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_ter_aura_disruptions(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_ter_aura_cache,
        lock=_ter_aura_cache_lock,
        ttl_seconds=_TER_AURA_CACHE_TTL,
        force_refresh=force_refresh,
        loader=_fetch_ter_aura_live,
    )


# ---------------------------------------------------------------------------
# (M TAG fusionné dans M Réseau — voir fetch_mreseau_disruptions)
# ---------------------------------------------------------------------------

def fetch_mtag_grenoble_disruptions(force_refresh: bool = False) -> dict[str, Any]:
    """Alias conservé pour compatibilité — délègue à fetch_mreseau_disruptions."""
    return fetch_mreseau_disruptions(force_refresh=force_refresh)


# ─── 5. Cars Région AURA · Transports interrégionaux ─────────────────────────
_CARS_REGION_CACHE_TTL = 300
_cars_region_cache_lock = Lock()
_cars_region_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "cars_region_aura"}
_CARS_REGION_ISERE_KEYWORDS: tuple[str, ...] = (
    "isère", "isere", "grenoble", "bourgoin", "vienne", "voiron", "38",
)


def _cars_region_find_isere_disruptions(obj: Any, depth: int = 0) -> list[dict[str, Any]]:
    """Parcourt récursivement le JSON Next.js pour trouver les lignes Isère avec perturbations."""
    if depth > 12 or obj is None:
        return []
    results: list[dict[str, Any]] = []
    if isinstance(obj, list):
        for item in obj:
            results.extend(_cars_region_find_isere_disruptions(item, depth + 1))
    elif isinstance(obj, dict):
        # Chercher un objet "réseau/groupe Isère" contenant des lignes
        name_val = str(obj.get("name") or obj.get("label") or obj.get("title") or obj.get("network") or "").lower()
        is_isere_network = "isère" in name_val or "isere" in name_val
        # Chercher les lignes enfants
        children = (
            obj.get("lines") or obj.get("routes") or obj.get("items")
            or obj.get("children") or obj.get("data") or []
        )
        if is_isere_network and isinstance(children, list):
            for line in children:
                if not isinstance(line, dict):
                    continue
                line_name = str(
                    line.get("name") or line.get("long_name") or line.get("route_long_name")
                    or line.get("label") or line.get("title") or ""
                )
                # Nombre de perturbations
                disruption_count = int(
                    line.get("disruptions_count") or line.get("disruptions")
                    or line.get("nb_disruptions") or line.get("perturbations")
                    or (len(line.get("disruptions_list") or []) if isinstance(line.get("disruptions_list"), list) else 0)
                    or 0
                )
                if disruption_count <= 0:
                    continue
                # Détails des perturbations si disponibles
                detail_list = line.get("disruptions_list") or line.get("alerts") or []
                if isinstance(detail_list, list) and detail_list:
                    for d in detail_list:
                        if not isinstance(d, dict):
                            continue
                        msg = str(d.get("message") or d.get("description") or d.get("title") or d.get("cause") or "")
                        results.append({
                            "title": line_name[:200] or "Perturbation Cars Région Isère",
                            "description": msg[:400] or f"Perturbation sur {line_name}",
                            "line": line_name[:80],
                            "level": "jaune",
                            "effect": "perturbation",
                            "valid_from": str(d.get("begin") or d.get("start") or ""),
                            "valid_until": str(d.get("end") or d.get("until") or ""),
                        })
                else:
                    results.append({
                        "title": line_name[:200] or "Perturbation Cars Région Isère",
                        "description": f"{disruption_count} perturbation(s) signalée(s) sur cette ligne",
                        "line": line_name[:80],
                        "level": "jaune",
                        "effect": "perturbation",
                        "valid_from": "",
                        "valid_until": "",
                    })
        else:
            # Continuer la traversée sur toutes les valeurs dict/list
            for val in obj.values():
                if isinstance(val, (dict, list)):
                    results.extend(_cars_region_find_isere_disruptions(val, depth + 1))
    return results


def _fetch_cars_region_live() -> dict[str, Any]:
    """Perturbations Cars Région AURA — lignes desservant l'Isère.

    Sources par ordre de priorité :
    1. __NEXT_DATA__ de sim.laregionvoustransporte.fr/fr/schedules (données SSR)
    2. GTFS-RT service alerts transport.data.gouv.fr
    3. SIRI SX transport.data.gouv.fr filtré Cars Région
    """
    disruptions: list[dict[str, Any]] = []
    source_used = ""
    _hdrs_json = {"Accept": "application/json", "User-Agent": _BROWSER_UA}
    _hdrs_html = {
        "User-Agent": _BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Referer": "https://sim.laregionvoustransporte.fr/",
        "Sec-Fetch-Mode": "navigate",
    }

    # ── Source 1 : __NEXT_DATA__ de sim.laregionvoustransporte.fr/fr/schedules ─
    # La page est une app Next.js — les lignes avec perturbations sont en SSR JSON.
    _SCHEDULES_URL = "https://sim.laregionvoustransporte.fr/fr/schedules"
    try:
        html = ""
        if _REQUESTS_OK and _requests is not None:
            resp = _requests.get(_SCHEDULES_URL, headers=_hdrs_html, timeout=20, verify=False)
            resp.raise_for_status()
            html = resp.text
        else:
            html = _http_get_text(_SCHEDULES_URL, timeout=20, headers=_hdrs_html)

        if html:
            # Extraire le bloc __NEXT_DATA__ (JSON SSR de Next.js)
            nd_match = re.search(
                r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>([\s\S]*?)</script>',
                html, re.IGNORECASE,
            )
            if nd_match:
                try:
                    next_data = json.loads(nd_match.group(1))
                    found = _cars_region_find_isere_disruptions(next_data)
                    if found:
                        disruptions.extend(found)
                        source_used = _SCHEDULES_URL
                except (json.JSONDecodeError, Exception):
                    pass

            # Si __NEXT_DATA__ vide, essayer de trouver buildId pour l'API _next/data
            if not disruptions and html:
                build_match = re.search(r'"buildId"\s*:\s*"([^"]{4,80})"', html)
                if build_match:
                    build_id = build_match.group(1)
                    _next_data_url = (
                        f"https://sim.laregionvoustransporte.fr/_next/data/{build_id}/fr/schedules.json"
                    )
                    try:
                        page_data = _http_get_json(_next_data_url, timeout=15, headers=_hdrs_json)
                        found = _cars_region_find_isere_disruptions(page_data)
                        if found:
                            disruptions.extend(found)
                            source_used = _next_data_url
                    except Exception:
                        pass
    except Exception:
        pass

    # ── Source 2 : API interne Next.js (routes /api) ──────────────────────────
    if not disruptions:
        _api_candidates = (
            "https://sim.laregionvoustransporte.fr/api/lines?disrupted=true",
            "https://sim.laregionvoustransporte.fr/api/lines/isere",
            "https://sim.laregionvoustransporte.fr/api/disruptions?network=isere",
            "https://sim.laregionvoustransporte.fr/api/schedules",
            "https://sim.laregionvoustransporte.fr/api/lines",
        )
        for _api_url in _api_candidates:
            if disruptions:
                break
            try:
                data = _http_get_json(_api_url, timeout=12, headers=_hdrs_json)
                found = _cars_region_find_isere_disruptions(data)
                if found:
                    disruptions.extend(found)
                    source_used = _api_url
            except Exception:
                continue

    # ── Source 3 : GTFS-RT service alerts transport.data.gouv.fr ─────────────
    if not disruptions:
        _GTFS_RT_CANDIDATES = (
            "https://proxy.transport.data.gouv.fr/resource/cars-region-auvergne-rhone-alpes-gtfs-rt-service-alerts",
            "https://proxy.transport.data.gouv.fr/resource/aura-cars-region-gtfs-rt-service-alerts",
            "https://proxy.transport.data.gouv.fr/resource/reseau-cars-region-aura-gtfs-rt-service-alerts",
        )
        for _gtfs_url in _GTFS_RT_CANDIDATES:
            if disruptions:
                break
            try:
                data = _http_get_json(_gtfs_url, timeout=12, headers=_hdrs_json)
                entities = data.get("entity") or (data if isinstance(data, list) else [])
                _found: list[dict[str, Any]] = []
                for entity in entities:
                    alert = entity.get("alert") or (entity if isinstance(entity, dict) else {})
                    header_obj = alert.get("headerText") or {}
                    desc_obj = alert.get("descriptionText") or {}
                    header = str(
                        header_obj.get("translation", [{}])[0].get("text", "")
                        if isinstance(header_obj, dict) else header_obj
                    )
                    desc = str(
                        desc_obj.get("translation", [{}])[0].get("text", "")
                        if isinstance(desc_obj, dict) else desc_obj
                    )
                    if not header and not desc:
                        continue
                    if _is_german_alert(header + " " + desc):
                        continue
                    blob = f"{header} {desc}".lower()
                    has_isere = any(kw in blob for kw in _CARS_REGION_ISERE_KEYWORDS)
                    other_depts = any(
                        d in blob for d in ("savoie", "haute-savoie", "ain ", "haute-loire",
                                            "puy-de-dôme", "cantal", "allier", "drôme", "ardèche")
                    )
                    if other_depts and not has_isere:
                        continue
                    line_m = re.search(r'\b(?:ligne\s+)?([A-Z]?\d{2,4})\b', header + " " + desc)
                    _found.append({
                        "title": (header or "Perturbation Cars Région")[:200],
                        "description": (desc or header)[:400],
                        "line": line_m.group(1).upper() if line_m else "Cars Région",
                        "level": "jaune",
                        "effect": "perturbation",
                        "valid_from": "",
                        "valid_until": "",
                    })
                if _found:
                    disruptions.extend(_found)
                    source_used = _gtfs_url
            except Exception:
                continue

    if not source_used:
        return {
            "service": "Cars Région · Auvergne-Rhône-Alpes",
            "status": "online",
            "source": _SCHEDULES_URL,
            "disruptions": [],
            "disruptions_total": 0,
            "normal_service": True,
            "note": "Flux temps réel indisponibles — aucune perturbation connue",
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }

    return {
        "service": "Cars Région · Auvergne-Rhône-Alpes",
        "status": "online",
        "source": source_used,
        "disruptions": disruptions[:20],
        "disruptions_total": len(disruptions),
        "normal_service": False,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_cars_region_aura_disruptions(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_cars_region_cache,
        lock=_cars_region_cache_lock,
        ttl_seconds=_CARS_REGION_CACHE_TTL,
        force_refresh=force_refresh,
        loader=_fetch_cars_region_live,
    )


# ---------------------------------------------------------------------------
# Points statiques OSM (Barrages, Montagne, Héliports) – cache Redis uniquement
# ---------------------------------------------------------------------------

_OSM_POINTS_CACHE_TTL = 24 * 3600  # 24 h

# --- Barrages ---

_BARRAGE_OVERPASS_QUERY = """[out:json][timeout:60];
area["boundary"="administrative"]["admin_level"="6"]["ref:INSEE"="38"]->.searchArea;
(
  nwr["waterway"="dam"](area.searchArea);
  nwr["man_made"="dam"](area.searchArea);
  nwr["waterway"="weir"](area.searchArea);
);
out center tags;"""

_barrages_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_barrages_cache_lock = Lock()


def _fetch_barrages_live() -> dict[str, Any]:
    elements = _overpass_fetch_institutions(_BARRAGE_OVERPASS_QUERY)
    points: list[dict[str, Any]] = []
    for el in elements:
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        try:
            lat, lon = float(lat), float(lon)
        except (TypeError, ValueError):
            continue
        if not (44.70 <= lat <= 45.95 and 4.70 <= lon <= 6.60):
            continue
        tags = el.get("tags") or {}
        name = str(tags.get("name") or "").strip() or "Barrage"
        points.append({
            "id": f"osm-{el.get('type', 'node')}-{el.get('id', 0)}",
            "lat": lat,
            "lon": lon,
            "name": name,
            "capacity": tags.get("capacity:persons") or tags.get("volume"),
            "ele": tags.get("ele") or tags.get("elevation"),
            "operator": tags.get("operator"),
            "osmId": el.get("id"),
            "osmType": el.get("type", "node"),
        })
    return {
        "status": "online",
        "count": len(points),
        "points": points,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_barrages_isere(force_refresh: bool = False) -> dict[str, Any]:
    redis_key = "osm_barrages_isere"
    persist_key = f"persist:{redis_key}"
    with _barrages_cache_lock:
        if not force_refresh and _barrages_cache["payload"] and datetime.utcnow() < _barrages_cache["expires_at"]:
            return _barrages_cache["payload"]
    cached = _redis_get(redis_key)
    if cached and not force_refresh:
        with _barrages_cache_lock:
            _barrages_cache["payload"] = cached
            _barrages_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_OSM_POINTS_CACHE_TTL)
        return cached
    try:
        live = _fetch_barrages_live()
        _redis_set(redis_key, live, _OSM_POINTS_CACHE_TTL)
        _redis_set(persist_key, live, _PERSIST_TTL_SECONDS)
        with _barrages_cache_lock:
            _barrages_cache["payload"] = live
            _barrages_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_OSM_POINTS_CACHE_TTL)
        return live
    except Exception:
        stale = _redis_get(persist_key)
        if stale:
            return stale
        return {"status": "degraded", "count": 0, "points": [], "updated_at": datetime.utcnow().isoformat() + "Z"}


# --- Montagne (refuges, abris, secours) ---

_MONTAGNE_OVERPASS_QUERY = """[out:json][timeout:60];
area["boundary"="administrative"]["admin_level"="6"]["ref:INSEE"="38"]->.searchArea;
(
  nwr["tourism"="alpine_hut"](area.searchArea);
  nwr["tourism"="wilderness_hut"](area.searchArea);
  nwr["amenity"="shelter"]["shelter_type"="basic_hut"](area.searchArea);
  nwr["emergency"="mountain_rescue"](area.searchArea);
  nwr["man_made"="tower"]["tower:type"="watchtower"](area.searchArea);
);
out center tags;"""

_montagne_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_montagne_cache_lock = Lock()


def _fetch_montagne_live() -> dict[str, Any]:
    elements = _overpass_fetch_institutions(_MONTAGNE_OVERPASS_QUERY)
    points: list[dict[str, Any]] = []
    for el in elements:
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        try:
            lat, lon = float(lat), float(lon)
        except (TypeError, ValueError):
            continue
        if not (44.70 <= lat <= 45.95 and 4.70 <= lon <= 6.60):
            continue
        tags = el.get("tags") or {}
        name = str(tags.get("name") or "").strip() or "Refuge"
        point_type = (
            "rescue" if tags.get("emergency") == "mountain_rescue"
            else "wilderness" if tags.get("tourism") == "wilderness_hut"
            else "shelter" if tags.get("amenity") == "shelter"
            else "refuge"
        )
        points.append({
            "id": f"osm-{el.get('type', 'node')}-{el.get('id', 0)}",
            "lat": lat,
            "lon": lon,
            "name": name,
            "capacity": tags.get("capacity") or tags.get("capacity:persons"),
            "ele": tags.get("ele") or tags.get("elevation"),
            "operator": tags.get("operator") or tags.get("network"),
            "type": point_type,
            "osmId": el.get("id"),
            "osmType": el.get("type", "node"),
        })
    return {
        "status": "online",
        "count": len(points),
        "points": points,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_montagne_isere(force_refresh: bool = False) -> dict[str, Any]:
    redis_key = "osm_montagne_isere"
    persist_key = f"persist:{redis_key}"
    with _montagne_cache_lock:
        if not force_refresh and _montagne_cache["payload"] and datetime.utcnow() < _montagne_cache["expires_at"]:
            return _montagne_cache["payload"]
    cached = _redis_get(redis_key)
    if cached and not force_refresh:
        with _montagne_cache_lock:
            _montagne_cache["payload"] = cached
            _montagne_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_OSM_POINTS_CACHE_TTL)
        return cached
    try:
        live = _fetch_montagne_live()
        _redis_set(redis_key, live, _OSM_POINTS_CACHE_TTL)
        _redis_set(persist_key, live, _PERSIST_TTL_SECONDS)
        with _montagne_cache_lock:
            _montagne_cache["payload"] = live
            _montagne_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_OSM_POINTS_CACHE_TTL)
        return live
    except Exception:
        stale = _redis_get(persist_key)
        if stale:
            return stale
        return {"status": "degraded", "count": 0, "points": [], "updated_at": datetime.utcnow().isoformat() + "Z"}


# --- Héliports / Hélistations / Aérodromes ---

_HELIPAD_OVERPASS_QUERY = """[out:json][timeout:60];
area["boundary"="administrative"]["admin_level"="6"]["ref:INSEE"="38"]->.searchArea;
(
  nwr["aeroway"="helipad"](area.searchArea);
  nwr["aeroway"="aerodrome"](area.searchArea);
  nwr["aeroway"="airport"](area.searchArea);
);
out center tags;"""

_helipads_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}
_helipads_cache_lock = Lock()


def _fetch_helipads_live() -> dict[str, Any]:
    import re as _re
    _smur_re = _re.compile(r"smur|samu|h[oô]pital|hopital|chu|chg|clinic", _re.IGNORECASE)
    elements = _overpass_fetch_institutions(_HELIPAD_OVERPASS_QUERY)
    points: list[dict[str, Any]] = []
    for el in elements:
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        try:
            lat, lon = float(lat), float(lon)
        except (TypeError, ValueError):
            continue
        if not (44.70 <= lat <= 45.95 and 4.70 <= lon <= 6.60):
            continue
        tags = el.get("tags") or {}
        name = str(tags.get("name") or "").strip() or "Héliport"
        aeroway = tags.get("aeroway", "helipad")
        icao = tags.get("icao") or tags.get("ref:ICAO")
        smur = bool(_smur_re.search(name + (tags.get("operator") or "")))
        points.append({
            "id": f"osm-{el.get('type', 'node')}-{el.get('id', 0)}",
            "lat": lat,
            "lon": lon,
            "name": name,
            "aeroway": aeroway,
            "icao": icao,
            "smur": smur,
            "operator": tags.get("operator"),
            "osmId": el.get("id"),
            "osmType": el.get("type", "node"),
        })
    return {
        "status": "online",
        "count": len(points),
        "points": points,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_helipads_isere(force_refresh: bool = False) -> dict[str, Any]:
    redis_key = "osm_helipads_isere"
    persist_key = f"persist:{redis_key}"
    with _helipads_cache_lock:
        if not force_refresh and _helipads_cache["payload"] and datetime.utcnow() < _helipads_cache["expires_at"]:
            return _helipads_cache["payload"]
    cached = _redis_get(redis_key)
    if cached and not force_refresh:
        with _helipads_cache_lock:
            _helipads_cache["payload"] = cached
            _helipads_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_OSM_POINTS_CACHE_TTL)
        return cached
    try:
        live = _fetch_helipads_live()
        _redis_set(redis_key, live, _OSM_POINTS_CACHE_TTL)
        _redis_set(persist_key, live, _PERSIST_TTL_SECONDS)
        with _helipads_cache_lock:
            _helipads_cache["payload"] = live
            _helipads_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_OSM_POINTS_CACHE_TTL)
        return live
    except Exception:
        stale = _redis_get(persist_key)
        if stale:
            return stale
        return {"status": "degraded", "count": 0, "points": [], "updated_at": datetime.utcnow().isoformat() + "Z"}


# ---------------------------------------------------------------------------
# Gestion globale des données statiques (état + collecte forcée)
# ---------------------------------------------------------------------------

_STATIC_FILES: dict[str, str] = {
    "institutions": _INSTITUTIONS_FILE,
    "finess": _FINESS_FILE,
    "barrages": "osm_barrages_isere.json",    # cohérence nom Redis → fichier
    "montagne": "osm_montagne_isere.json",
    "helipads": "osm_helipads_isere.json",
}


def get_static_data_status() -> dict[str, Any]:
    """Retourne l'état de chaque fichier de cache statique (présence, taille, date)."""
    result = {}
    for key, filename in _STATIC_FILES.items():
        p = _static_data_path(filename)
        if p.exists():
            try:
                stat = p.stat()
                data = _file_cache_load(filename) or {}
                result[key] = {
                    "file": str(p),
                    "exists": True,
                    "size_kb": round(stat.st_size / 1024, 1),
                    "updated_at": data.get("updated_at", "?"),
                    "count": data.get("count") or data.get("resources_total") or len(data.get("points") or data.get("resources") or []),
                }
            except Exception as exc:
                result[key] = {"file": str(p), "exists": True, "error": str(exc)}
        else:
            result[key] = {"file": str(p), "exists": False}
    return result


def collect_all_static_data() -> dict[str, Any]:
    """Force la re-collecte de toutes les données statiques depuis leurs sources.
    Sauvegarde les résultats dans les fichiers JSON du volume Docker.
    Cette opération peut prendre 2–5 minutes (requêtes Overpass + CSV FINESS)."""
    from concurrent.futures import ThreadPoolExecutor, as_completed as _ac

    tasks = {
        "institutions": lambda: fetch_institutions_isere(force_refresh=True),
        "finess": lambda: fetch_finess_isere_resources(force_refresh=True, limit=_FINESS_ISERE_MAX_LIMIT),
        "barrages": lambda: fetch_barrages_isere(force_refresh=True),
        "montagne": lambda: fetch_montagne_isere(force_refresh=True),
        "helipads": lambda: fetch_helipads_isere(force_refresh=True),
    }
    results: dict[str, Any] = {}
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(fn): key for key, fn in tasks.items()}
        for future in _ac(futures):
            key = futures[future]
            try:
                data = future.result()
                status = data.get("status", "?")
                count = data.get("count") or data.get("resources_total") or len(data.get("points") or data.get("resources") or [])
                results[key] = {"status": status, "count": count, "updated_at": data.get("updated_at", "?")}
            except Exception as exc:
                results[key] = {"status": "error", "error": str(exc)}

    # Sauvegarder barrages/montagne/helipads dans leurs fichiers JSON aussi
    for key, filename in [("barrages", _STATIC_FILES["barrages"]), ("montagne", _STATIC_FILES["montagne"]), ("helipads", _STATIC_FILES["helipads"])]:
        redis_key = f"osm_{key}_isere" if key != "helipads" else "osm_helipads_isere"
        data = _redis_get(redis_key)
        if data:
            _file_cache_save(filename, data)

    results["collected_at"] = datetime.utcnow().isoformat() + "Z"
    return results


# ══════════════════════════════════════════════════════════════════════════════
# COPERNICUS EMS — Cartographie d'urgence Sentinel-1 / inondations (Feature 11)
# API : emergency.copernicus.eu/mapping/rest/api/v1/activations
# ══════════════════════════════════════════════════════════════════════════════
_COPERNICUS_EMS_CACHE_TTL_SECONDS = 1800  # 30 min
_copernicus_ems_cache_lock = Lock()
_copernicus_ems_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "copernicus_ems"}

_GDACS_NS = "http://www.gdacs.org"
_GEO_NS   = "http://www.w3.org/2003/01/geo/wgs84_pos#"


def _gdacs_text(item: Any, tag: str, ns: str | None = None) -> str:
    """Extrait le texte d'un élément XML RSS GDACS."""
    prefix = f"{{{ns}}}" if ns else ""
    el = item.find(f"{prefix}{tag}")
    return (el.text or "").strip() if el is not None else ""


_GDACS_EVENT_LABELS: dict[str, str] = {
    "FL": "Inondation",
    "EQ": "Séisme",
    "TC": "Cyclone tropical",
    "VO": "Volcan",
    "WF": "Feux de forêt",
    "DR": "Sécheresse",
    "TS": "Tsunami",
    "LS": "Glissement de terrain",
}
# Pays européens (ISO3) pour filtrage géographique
_EUROPE_ISO3 = {
    "FRA","DEU","GBR","ESP","ITA","PRT","BEL","NLD","LUX","CHE","AUT","POL","CZE","SVK",
    "HUN","ROU","BGR","HRV","SVN","SRB","BIH","MNE","MKD","ALB","GRC","TUR","CYP","MLT",
    "DNK","SWE","NOR","FIN","ISL","IRL","EST","LVA","LTU","BLR","UKR","MDA","GEO","ARM",
    "AZE","RUS","AND","MCO","SMR","VAT","LIE","XKX","NOR",
}
# BBox Europe élargie (inclut Turquie, Caucase, Maroc/Algérie proches)
_EUROPE_LAT_MIN, _EUROPE_LAT_MAX = 27.0, 72.0
_EUROPE_LON_MIN, _EUROPE_LON_MAX = -32.0, 50.0


def _is_in_europe(lat: float | None, lon: float | None, iso3: str) -> bool:
    if iso3.upper() in _EUROPE_ISO3:
        return True
    if lat is not None and lon is not None:
        return _EUROPE_LAT_MIN <= lat <= _EUROPE_LAT_MAX and _EUROPE_LON_MIN <= lon <= _EUROPE_LON_MAX
    return False


def _fetch_copernicus_ems_live() -> dict[str, Any]:
    """
    Toutes catastrophes actives en Europe et France via le flux RSS GDACS.
    URL : https://www.gdacs.org/xml/rss.xml (FL, EQ, TC, VO, WF, DR, TS...)
    Filtre : événements en cours uniquement, scope France + Europe.
    """
    try:
        resp = _requests.get(
            "https://www.gdacs.org/xml/rss.xml",
            timeout=20,
            headers={"Accept": "application/xml,text/xml,*/*", "User-Agent": _BROWSER_UA},
        )
        resp.raise_for_status()
        content = resp.content.lstrip(b"\xef\xbb\xbf")
        root = ET.fromstring(content)
        channel = root.find("channel")
        all_items = (channel or root).findall("item")

        europe_activations: list[dict[str, Any]] = []
        france_activations: list[dict[str, Any]] = []

        for item in all_items:
            # Garder seulement les événements en cours
            is_current = _gdacs_text(item, "iscurrent", _GDACS_NS)
            if is_current == "false":
                continue

            event_type = _gdacs_text(item, "eventtype", _GDACS_NS) or "?"
            title   = _gdacs_text(item, "title")
            country = _gdacs_text(item, "country", _GDACS_NS)
            iso3    = _gdacs_text(item, "iso3", _GDACS_NS)
            alert   = _gdacs_text(item, "alertlevel", _GDACS_NS)
            event_id = _gdacs_text(item, "eventid", _GDACS_NS)
            link    = _gdacs_text(item, "link")
            pub     = _gdacs_text(item, "pubDate")[:16] if _gdacs_text(item, "pubDate") else ""
            severity = _gdacs_text(item, "severity", _GDACS_NS)

            # Coordonnées : <georss:point> = "lat lon"
            _GEORSS_NS = "http://www.georss.org/georss"
            georss_pt = _gdacs_text(item, "point", _GEORSS_NS)
            lat_val: float | None = None
            lon_val: float | None = None
            if georss_pt and " " in georss_pt:
                parts = georss_pt.split()
                try:
                    lat_val, lon_val = float(parts[0]), float(parts[1])
                except ValueError:
                    pass
            if lat_val is None:
                geo_point = item.find(f"{{{_GEO_NS}}}Point")
                if geo_point is not None:
                    try:
                        lat_val = float(_gdacs_text(geo_point, "lat", _GEO_NS))
                        lon_val = float(_gdacs_text(geo_point, "long", _GEO_NS))
                    except ValueError:
                        pass

            is_france = (
                "FRANCE" in country.upper()
                or iso3.upper() == "FRA"
                or country.upper() == "FR"
            )
            in_europe = is_france or _is_in_europe(lat_val, lon_val, iso3)

            if not in_europe:
                continue

            type_label = _GDACS_EVENT_LABELS.get(event_type.upper(), event_type)
            activation = {
                "id": event_id or link,
                "title": title or type_label,
                "type": event_type.upper(),
                "type_label": type_label,
                "date": pub,
                "level": alert,
                "severity": severity,
                "country": country,
                "iso3": iso3,
                "lat": lat_val,
                "lon": lon_val,
                "france": is_france,
                "url": link or "https://www.gdacs.org",
            }
            europe_activations.append(activation)
            if is_france:
                france_activations.append(activation)

        return {
            "service": "GDACS · Catastrophes Europe",
            "status": "online",
            "source": "https://www.gdacs.org",
            "activations_total": len(europe_activations),
            "france_total": len(france_activations),
            "activations": europe_activations[:30],
            "france_activations": france_activations[:10],
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except Exception as exc:
        return {
            "service": "GDACS · Catastrophes Europe",
            "status": "degraded",
            "source": "https://www.gdacs.org",
            "activations_total": 0,
            "france_total": 0,
            "activations": [],
            "france_activations": [],
            "error": str(exc),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }


# ── kept for unused reference ──────────────────────────────────────────────
def _fetch_copernicus_ems_live_UNUSED() -> dict[str, Any]:
    """Ancienne implémentation REST Copernicus EMS (API désactivée fin 2025)."""
    try:
        resp = _requests.get(
            "https://emergency.copernicus.eu/mapping/rest/api/v1/activations",
            timeout=15,
            headers={"Accept": "application/json", "User-Agent": _BROWSER_UA},
        )
        resp.raise_for_status()
        data = resp.json()
        raw_items = data if isinstance(data, list) else (data.get("items") or data.get("activations") or [])
        activations: list[dict[str, Any]] = []
        france_activations: list[dict[str, Any]] = []

        for item in raw_items[:50]:
            countries = item.get("countries") or item.get("country") or []
            if isinstance(countries, str):
                countries = [countries]
            # Normalize: list of country names or codes
            country_strs = [str(c).lower() for c in countries]
            is_france = any(
                "france" in c or c == "fr" or "french" in c
                for c in country_strs
            )
            activation = {
                "id": item.get("activationid") or item.get("id") or item.get("code"),
                "title": item.get("title") or item.get("name") or item.get("event_name"),
                "type": item.get("type") or item.get("event_type") or "FLOOD",
                "countries": countries,
                "date": (item.get("reportdate") or item.get("date") or "")[:10],
                "lat": item.get("latitude") or item.get("lat"),
                "lon": item.get("longitude") or item.get("lon"),
                "france": is_france,
                "url": item.get("url") or item.get("link"),
            }
            activations.append(activation)
            if is_france:
                france_activations.append(activation)

        return {
            "service": "Copernicus EMS",
            "status": "online",
            "source": "https://emergency.copernicus.eu",
            "activations_total": len(activations),
            "france_total": len(france_activations),
            "activations": activations[:20],
            "france_activations": france_activations[:10],
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except Exception as exc:
        return {
            "service": "Copernicus EMS",
            "status": "degraded",
            "source": "https://emergency.copernicus.eu",
            "activations_total": 0,
            "france_total": 0,
            "activations": [],
            "france_activations": [],
            "error": str(exc),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }


def fetch_copernicus_ems_france(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_copernicus_ems_cache,
        lock=_copernicus_ems_cache_lock,
        ttl_seconds=_COPERNICUS_EMS_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_copernicus_ems_live,
    )


# ---------------------------------------------------------------------------
# Persistance du snapshot consolidé (main.py ↔ Redis)
# ---------------------------------------------------------------------------

_RISKS_SNAPSHOT_KEY = "risks_snapshot_v1"


def save_risks_snapshot(payload: dict[str, Any]) -> None:
    """Sauvegarde le snapshot complet des risques dans Redis (7 jours).
    Appelé par main.py après chaque mise à jour d'un slot de service."""
    _redis_set(_RISKS_SNAPSHOT_KEY, payload, _PERSIST_TTL_SECONDS)


def load_risks_snapshot() -> dict[str, Any] | None:
    """Charge le dernier snapshot complet depuis Redis.
    Retourne None si Redis est indisponible ou si aucune donnée n'a encore été sauvegardée."""
    return _redis_get(_RISKS_SNAPSHOT_KEY)


def flush_service_memory_cache(service_key: str) -> dict[str, str]:
    """Vide le cache mémoire et Redis d'un service. Force le prochain fetch à aller en live."""
    _known: dict[str, tuple[dict[str, Any], Any]] = {
        "france_bleu_isere":   (_france_bleu_cache,          _france_bleu_cache_lock),
        "prefecture_isere":    (_prefecture_cache,            _prefecture_cache_lock),
        "dauphine_isere":      (_dauphine_cache,              _dauphine_cache_lock),
        "meteo_france":        (_meteo_cache,                 _meteo_cache_lock),
        "vigicrues":           (_vigicrues_cache,             _vigicrues_cache_lock),
        "itinisere":           (_itinisere_cache,             _itinisere_cache_lock),
        "bison_fute":          (_bison_cache,                 _bison_cache_lock),
        "vigieau":             (_vigieau_cache,               _vigieau_cache_lock),
        "atmo_aura":           (_atmo_aura_cache,             _atmo_aura_cache_lock),
        "sncf_isere":          (_sncf_isere_cache,            _sncf_isere_cache_lock),
        "anfr_isere":          (_anfr_isere_cache,            _anfr_isere_cache_lock),
        "arcep_isere":         (_arcep_isere_cache,           _arcep_isere_cache_lock),
        "groundwater_isere":   (_hubeau_groundwater_cache,    _hubeau_groundwater_cache_lock),
        "apic_isere":          (_apic_isere_cache,            _apic_isere_cache_lock),
        "isere_opendata":      (_isere_opendata_cache,        _isere_opendata_cache_lock),
        "finess_isere":        (_finess_isere_cache,          _finess_isere_cache_lock),
        "placegrenet":         (_placegrenet_cache,           _placegrenet_cache_lock),
        "grenoble_metro":      (_grenoble_metro_cache,        _grenoble_metro_cache_lock),
        "ars_aura":            (_ars_aura_cache,              _ars_aura_cache_lock),
        "seismes_isere":       (_seismes_isere_cache,         _seismes_isere_cache_lock),
        "feux_foret_isere":    (_feux_foret_cache,            _feux_foret_cache_lock),
        "cols_alpins_isere":   (_cols_cache,                  _cols_cache_lock),
        "copernicus_ems":      (_copernicus_ems_cache,        _copernicus_ems_cache_lock),
    }
    if service_key not in _known:
        return {"status": "not_found", "service": service_key}
    cache, lock = _known[service_key]
    with lock:
        cache["payload"] = None
        cache["expires_at"] = datetime.min
    redis_key = cache.get("redis_key")
    if redis_key and _redis_client:
        _redis_client.delete(redis_key)
        _redis_client.delete(f"persist:{redis_key}")
    return {"status": "flushed", "service": service_key}


# ══════════════════════════════════════════════════════════════════════════════
# FEUX DE FORÊT — EFFIS/JRC Copernicus (Feature 17)
# ══════════════════════════════════════════════════════════════════════════════
_FEUX_FORET_CACHE_TTL_SECONDS = 3600  # 1h — source souvent inaccessible réseau, éviter les retries
_feux_foret_cache_lock = Lock()
_feux_foret_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "feux_foret_isere"}


_ISERE_BBOX = (44.4, 4.9, 45.7, 6.4)  # lat_min, lon_min, lat_max, lon_max

_ISERE_ZONES = [
    ((45.2, 5.5, 45.5, 5.9), "Chartreuse"),
    ((44.7, 5.0, 45.2, 5.6), "Vercors"),
    ((45.0, 5.8, 45.7, 6.3), "Belledonne"),
    ((44.8, 5.9, 45.2, 6.4), "Oisans"),
    ((44.7, 5.5, 45.0, 5.9), "Trièves / Matheysine"),
    ((45.1, 5.8, 45.5, 6.1), "Grésivaudan"),
    ((45.0, 5.0, 45.5, 5.5), "Bièvre-Valloire"),
    ((45.1, 5.4, 45.3, 5.8), "Agglomération grenobloise"),
]


def _fire_zone(lat: float, lon: float) -> str:
    for (lat_min, lon_min, lat_max, lon_max), name in _ISERE_ZONES:
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            return name
    return f"Isère ({lat:.2f}°N {lon:.2f}°E)"


def _parse_effis_geojson(data: dict) -> list[dict]:
    lat_min, lon_min, lat_max, lon_max = _ISERE_BBOX
    fires = []
    for f in data.get("features") or []:
        coords = (f.get("geometry") or {}).get("coordinates") or []
        props = f.get("properties") or {}
        if len(coords) < 2:
            continue
        lat, lon = round(float(coords[1]), 5), round(float(coords[0]), 5)
        if not (lat_min <= lat <= lat_max and lon_min <= lon <= lon_max):
            continue
        fires.append({
            "lat": lat,
            "lon": lon,
            "zone": _fire_zone(lat, lon),
            "confidence": str(props.get("confidence") or "nominal"),
            "date": str(props.get("acq_date") or ""),
            "frp": _safe_float(props.get("frp")),
            "source": "EFFIS/Copernicus",
        })
    return fires


def _parse_firms_csv(text: str) -> list[dict]:
    """Parse NASA FIRMS area CSV response — filtré sur la bbox Isère élargie."""
    fires = []
    try:
        reader = csv.DictReader(io.StringIO(text))
        for row in reader:
            try:
                lat = float(row.get("latitude") or row.get("lat") or 0)
                lon = float(row.get("longitude") or row.get("lon") or 0)
            except ValueError:
                continue
            # Isère élargie : 44.4–45.7 N, 4.9–6.4 E
            if not (44.4 <= lat <= 45.7 and 4.9 <= lon <= 6.4):
                continue
            fires.append({
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "zone": _fire_zone(lat, lon),
                "confidence": str(row.get("confidence") or "nominal"),
                "date": str(row.get("acq_date") or ""),
                "time": str(row.get("acq_time") or ""),
                "frp": _safe_float(row.get("frp")),
                "source": "NASA FIRMS/VIIRS",
            })
    except Exception:
        pass
    return fires


def _safe_float(v: Any) -> float | None:
    try:
        return float(v) if v not in (None, "", "nan") else None
    except (ValueError, TypeError):
        return None


def _fetch_feux_foret_live() -> dict[str, Any]:
    # 1. EFFIS/Copernicus — deux endpoints WFS GeoJSON
    _EFFIS_URLS = [
        (
            "https://maps.effis.emergency.copernicus.eu/effis/ows?SERVICE=WFS&VERSION=2.0.0"
            "&REQUEST=GetFeature&TYPENAMES=activefires:viirsFires24h"
            "&outputFormat=application/json&COUNT=500"
            "&BBOX=43.0,4.0,47.5,8.0,EPSG:4326"
        ),
        (
            "https://ows.jrc.ec.europa.eu/effis/ows?SERVICE=WFS&VERSION=2.0.0"
            "&REQUEST=GetFeature&TYPENAMES=activefires:viirsFires24h"
            "&outputFormat=application/json&COUNT=500"
            "&BBOX=43.0,4.0,47.5,8.0,EPSG:4326"
        ),
    ]
    fires: list[dict] = []
    data_source = "EFFIS/Copernicus"

    for url in _EFFIS_URLS:
        try:
            data = _http_get_json(url, timeout=12)
            fires = _parse_effis_geojson(data)
            break
        except Exception:
            pass

    # 2. Fallback NASA FIRMS si EFFIS inaccessible
    if not fires:
        map_key = (settings.firms_map_key or "").strip()
        if map_key:
            # BBOX : west,south,east,north — SE France élargi
            firms_url = (
                f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
                f"{map_key}/VIIRS_SNPP_NRT/4.0,43.0,8.0,47.5/2"
            )
            try:
                text = _http_get_text(firms_url, timeout=20)
                fires = _parse_firms_csv(text)
                data_source = "NASA FIRMS/VIIRS"
            except Exception:
                pass

    if not fires and not (settings.firms_map_key or "").strip():
        # Aucune source disponible — indiquer clairement le statut
        return {
            "service": "Feux de forêt EFFIS",
            "status": "degraded",
            "source": "https://effis.jrc.ec.europa.eu",
            "fires": [],
            "fires_total": 0,
            "note": (
                "Sources EFFIS/JRC inaccessibles depuis ce réseau. "
                "Configurez FIRMS_MAP_KEY (gratuit sur firms.modaps.eosdis.nasa.gov) pour activer le fallback NASA."
            ),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }

    # Trier par date desc puis FRP desc pour mettre les plus récents/intenses en premier
    def _fire_sort_key(f: dict):
        d = str(f.get("date") or "")
        t = str(f.get("time") or "")
        frp = float(f.get("frp") or 0)
        return (d + t, frp)

    fires_sorted = sorted(fires, key=_fire_sort_key, reverse=True)

    return {
        "service": "Feux de forêt EFFIS",
        "status": "online",
        "source": "https://effis.jrc.ec.europa.eu",
        "data_source": data_source,
        "fires": fires_sorted,
        "fires_total": len(fires_sorted),
        "top_fires": fires_sorted[:3],
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_feux_foret_isere(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_feux_foret_cache,
        lock=_feux_foret_cache_lock,
        ttl_seconds=_FEUX_FORET_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_feux_foret_live,
    )


# ══════════════════════════════════════════════════════════════════════════════
# COLS ALPINS — État en temps réel via open-meteo (Feature 19)
# ══════════════════════════════════════════════════════════════════════════════
_COLS_CACHE_TTL_SECONDS = 1800
_cols_cache_lock = Lock()
_cols_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min, "redis_key": "cols_alpins_isere"}

_COLS_ALPINS: list[dict[str, Any]] = [
    {"nom": "Col du Lautaret",        "route": "N91",   "alt": 2058, "lat": 45.036, "lon": 6.408},
    {"nom": "Col du Galibier",         "route": "D902",  "alt": 2642, "lat": 45.064, "lon": 6.409},
    {"nom": "Col de la Croix de Fer",  "route": "D926",  "alt": 2067, "lat": 45.229, "lon": 6.197},
    {"nom": "Col du Glandon",          "route": "D926",  "alt": 1924, "lat": 45.223, "lon": 6.178},
    {"nom": "Col de l'Ornon",          "route": "D526",  "alt": 1367, "lat": 45.039, "lon": 5.960},
    {"nom": "Col de Mens",             "route": "D526",  "alt": 1356, "lat": 44.845, "lon": 5.771},
    {"nom": "Col de Porte",            "route": "D512",  "alt": 1326, "lat": 45.295, "lon": 5.773},
    {"nom": "Col du Coq",              "route": "D30",   "alt": 1434, "lat": 45.289, "lon": 5.835},
    {"nom": "Col du Granier",          "route": "D912",  "alt": 1134, "lat": 45.451, "lon": 5.924},
    {"nom": "Col de la Chartreuse",    "route": "D512",  "alt": 1139, "lat": 45.333, "lon": 5.824},
]


def _col_status_from_weather(temp_c, snow_cm, precip, wind_kmh):
    if temp_c is None:
        return {"statut": "inconnu", "couleur": "gris", "detail": "Météo indisponible"}
    if snow_cm is not None and snow_cm > 10:
        return {"statut": "chaines obligatoires", "couleur": "orange", "detail": f"{snow_cm:.0f} cm neige · {temp_c:.0f}°C"}
    if snow_cm is not None and snow_cm > 2:
        return {"statut": "prudence", "couleur": "jaune", "detail": f"Enneigement {snow_cm:.0f} cm · {temp_c:.0f}°C"}
    if temp_c < -5 and (precip or 0) > 1:
        return {"statut": "verglas probable", "couleur": "orange", "detail": f"{temp_c:.0f}°C · précipitations"}
    if wind_kmh is not None and wind_kmh > 80:
        return {"statut": "vent fort", "couleur": "jaune", "detail": f"Rafales {wind_kmh:.0f} km/h"}
    return {"statut": "ouvert", "couleur": "vert", "detail": f"{temp_c:.0f}°C · conditions normales"}


def _fetch_cols_alpins_live() -> dict[str, Any]:
    cols_out: list[dict[str, Any]] = []
    # Requête batch unique — Open-Meteo accepte latitude=lat1,lat2,... (une seule requête = pas de 429)
    lats = ",".join(str(c["lat"]) for c in _COLS_ALPINS)
    lons = ",".join(str(c["lon"]) for c in _COLS_ALPINS)
    batch_results: list[dict[str, Any]] = [{"temp": None, "snow": None, "precip": None, "wind": None, "ok": False}] * len(_COLS_ALPINS)
    first_error: str | None = None
    try:
        resp = _requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lats,
                "longitude": lons,
                "current": "temperature_2m,precipitation,snow_depth,wind_speed_10m",
                "wind_speed_unit": "kmh",
                "timezone": "Europe/Paris",
            },
            timeout=20,
            headers={"Accept": "application/json", "User-Agent": _BROWSER_UA},
        )
        resp.raise_for_status()
        raw = resp.json()
        # Réponse batch = liste si plusieurs localisations, dict si une seule
        items = raw if isinstance(raw, list) else [raw]
        batch_results = []
        for item in items:
            cur = (item.get("current") or {})
            batch_results.append({
                "temp": cur.get("temperature_2m"),
                "snow": cur.get("snow_depth"),
                "precip": cur.get("precipitation"),
                "wind": cur.get("wind_speed_10m"),
                "ok": True,
            })
        # Compléter si la réponse est plus courte que la liste (ne devrait pas arriver)
        while len(batch_results) < len(_COLS_ALPINS):
            batch_results.append({"temp": None, "snow": None, "precip": None, "wind": None, "ok": False})
    except Exception as exc:
        first_error = str(exc)

    results_map: dict[str, dict[str, Any]] = {
        col["nom"]: batch_results[i] for i, col in enumerate(_COLS_ALPINS)
    }

    for col in _COLS_ALPINS:
        r = results_map.get(col["nom"], {})
        temp   = r.get("temp")
        snow_m = r.get("snow")   # open-meteo renvoie snow_depth en mètres → convertir en cm
        snow   = round(snow_m * 100, 1) if snow_m is not None else None
        precip = r.get("precip")
        wind   = r.get("wind")
        if r.get("ok") and temp is not None:
            status = _col_status_from_weather(temp, snow, precip, wind)
        else:
            status = {"statut": "inconnu", "couleur": "gris", "detail": "Météo indisponible"}
            temp = snow = precip = wind = None
        cols_out.append({**col, **status, "temperature": temp, "enneigement_cm": snow, "precipitations": precip, "vent_kmh": wind})

    nb_dangereux = sum(1 for c in cols_out if c["couleur"] in ("orange", "rouge"))
    result: dict[str, Any] = {
        "service": "Cols alpins Isère",
        "status": "online",
        "source": "https://api.open-meteo.com",
        "cols": cols_out,
        "cols_total": len(cols_out),
        "dangereux_total": nb_dangereux,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    if first_error:
        result["_debug_first_error"] = first_error
    return result


def fetch_cols_alpins_isere(force_refresh: bool = False) -> dict[str, Any]:
    return _cached_external_payload(
        cache=_cols_cache,
        lock=_cols_cache_lock,
        ttl_seconds=_COLS_CACHE_TTL_SECONDS,
        force_refresh=force_refresh,
        loader=_fetch_cols_alpins_live,
    )

