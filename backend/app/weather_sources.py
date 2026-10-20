"""Official Météo-France station observations and a local radar image archive.

Collectors run in the existing background scheduler. API credentials stay in
headers on the server; snapshots contain neither credentials nor image bytes.
The targeted radar API exposes its latest mosaic only, so animation frames are
collected locally rather than pretending to provide a remote history.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
import csv
from datetime import datetime, timedelta, timezone
import io
import json
import math
import os
from pathlib import Path
import re
import tempfile
from time import monotonic, time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .config import settings
from .api_credentials import CredentialStoreError, resolve_credentials


OBS_API = "https://public-api.meteofrance.fr/public/DPObs/v2"
RADAR_API = "https://public-api.meteofrance.fr/public/DPRadar/v1"
PORTAL_URL = "https://portail-api.meteofrance.fr/"
OBS_DOCUMENTATION = (
    "https://confluence-meteofrance.atlassian.net/wiki/spaces/"
    "OpenDataMeteoFrance/pages/853639294"
)
RADAR_DOCUMENTATION = (
    "https://confluence-meteofrance.atlassian.net/wiki/spaces/"
    "OpenDataMeteoFrance/pages/853639355"
)
# Include the neighbouring catchments while keeping images small.
RADAR_BOUNDS = [[44.55, 4.65], [46.0, 6.65]]  # Leaflet: southwest, northeast
RADAR_FRAME_LIMIT = 12
RADAR_TTL_SECONDS = 240
OBS_TTL_SECONDS = 300
STALE_SECONDS = 1800
MAX_JSON_BYTES = 3 * 1024 * 1024
MAX_RADAR_BYTES = 32 * 1024 * 1024
FRAME_ID_RE = re.compile(r"[0-9]{14}\Z")

RADAR_LEGEND = [
    {"min": 0.05, "color": "#60a5fa", "label": "0,05 à 0,2 mm"},
    {"min": 0.2, "color": "#22d3ee", "label": "0,2 à 0,5 mm"},
    {"min": 0.5, "color": "#34d399", "label": "0,5 à 1 mm"},
    {"min": 1.0, "color": "#facc15", "label": "1 à 2 mm"},
    {"min": 2.0, "color": "#fb923c", "label": "2 à 5 mm"},
    {"min": 5.0, "color": "#ef4444", "label": "5 à 10 mm"},
    {"min": 10.0, "color": "#d946ef", "label": "10 mm et plus"},
    {"min": None, "color": "#64748b", "label": "Mesure manquante ou inutilisable"},
]


class WeatherSourceError(Exception):
    """A safe diagnostic code, without upstream URLs, bodies or credentials."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _date(value: Any) -> datetime | None:
    try:
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return result.replace(tzinfo=timezone.utc) if result.tzinfo is None else result.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def _number(value: Any) -> float | None:
    try:
        result = float(str(value).replace(",", "."))
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def _cache_dir() -> Path:
    path = Path(settings.static_data_dir) / "weather"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read_snapshot(name: str) -> dict:
    try:
        path = _cache_dir() / f"{name}.json"
        if path.stat().st_size > MAX_JSON_BYTES:
            return {}
        result = json.loads(path.read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else {}
    except (OSError, ValueError):
        return {}


def _atomic_bytes(path: Path, data: bytes) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".weather-", delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
        temporary.replace(path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def _write_snapshot(name: str, payload: dict) -> None:
    _atomic_bytes(
        _cache_dir() / f"{name}.json",
        json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8"),
    )


@contextmanager
def _collection_lock(name: str):
    """Nonblocking process lock shared through the persistent Docker volume."""
    lock_path = _cache_dir() / f"{name}.lock"
    descriptor = None
    try:
        try:
            # A killed worker must not permanently stop collection.
            if lock_path.exists() and time() - lock_path.stat().st_mtime > 900:
                lock_path.unlink(missing_ok=True)
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            yield False
            return
        yield True
    finally:
        if descriptor is not None:
            os.close(descriptor)
            lock_path.unlink(missing_ok=True)


def _fresh(payload: dict, ttl: int) -> bool:
    checked = _date(payload.get("checked_at"))
    return bool(checked and 0 <= (_now() - checked).total_seconds() < ttl)


def _auth_headers(kind: str) -> dict[str, str]:
    try:
        credentials = resolve_credentials("meteo_france")
    except CredentialStoreError:
        raise WeatherSourceError("credential_store_unavailable") from None
    key = str(credentials.get(f"{kind}_api_key") or credentials.get("api_key") or "").strip()
    token = str(credentials.get("access_token") or "").strip()
    headers = {"Accept": "*/*", "User-Agent": "ope-protec/1.0 (observations publiques)"}
    if key:
        headers["apikey"] = key
    elif token:
        headers["Authorization"] = f"Bearer {token}"
    else:
        raise WeatherSourceError("configuration_required")
    return headers


class _OfficialRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        target = urlparse(new_url)
        if target.scheme != "https" or target.netloc != "public-api.meteofrance.fr":
            raise WeatherSourceError("unsafe_redirect")
        return super().redirect_request(request, response, code, message, headers, new_url)


def _http_bytes(url: str, headers: dict, limit: int = MAX_JSON_BYTES) -> bytes:
    try:
        started = monotonic()
        with build_opener(_OfficialRedirects()).open(Request(url, headers=headers), timeout=8) as response:
            declared = int(response.headers.get("Content-Length") or 0)
            if declared > limit:
                raise WeatherSourceError("response_too_large")
            chunks, total = [], 0
            while True:
                chunk = response.read(min(256 * 1024, limit + 1 - total))
                if not chunk:
                    return b"".join(chunks)
                total += len(chunk)
                if total > limit:
                    raise WeatherSourceError("response_too_large")
                if monotonic() - started > 20:
                    raise WeatherSourceError("timeout")
                chunks.append(chunk)
    except HTTPError as error:
        raise WeatherSourceError(f"http_{error.code}") from None
    except (URLError, TimeoutError, OSError):
        raise WeatherSourceError("network_error") from None


def _base_payload(kind: str) -> dict:
    radar = kind == "radar"
    return {
        "status": "pending", "source": "Météo-France", "department": "Isère",
        "title": "Radar des précipitations" if radar else "Observations météorologiques",
        "source_url": RADAR_DOCUMENTATION if radar else OBS_DOCUMENTATION,
        "checked_at": _iso(_now()), "updated_at": None, "observed_at": None,
        **({
            "frames": [], "bounds": deepcopy(RADAR_BOUNDS), "legend": deepcopy(RADAR_LEGEND),
            "unit": "mm/5 min", "resolution_m": 500, "interval_minutes": 5,
            "history_note": "Animation constituée à partir des images collectées par ce serveur (1 heure maximum).",
        } if radar else {"stations": [], "summary": {}, "interval_minutes": 6}),
    }


def _error_payload(kind: str, error: Exception, previous: dict) -> dict:
    payload = deepcopy(previous) if previous else _base_payload(kind)
    code = str(error) if isinstance(error, WeatherSourceError) else "invalid_data"
    has_data = bool(payload.get("frames") if kind == "radar" else payload.get("stations"))
    payload.update(checked_at=_iso(_now()), error_code=code)
    if code == "configuration_required":
        payload.update(
            status="configuration_required", configured=False,
            message="Un accès Météo-France est nécessaire. Souscrire gratuitement aux API Observations et Radar puis renseigner la clé côté serveur.",
            setup_url=PORTAL_URL,
        )
    elif code in {"http_401", "http_403"}:
        payload.update(
            status="stale" if has_data else "error", configured=True,
            message="Accès Météo-France refusé : vérifier la validité de la clé et la souscription à cette API.",
        )
    elif code == "dependencies_missing":
        payload.update(status="error", configured=True,
                       message="Le traitement radar nécessite les dépendances du serveur : numpy, h5py, pyproj et Pillow.")
    elif code == "invalid_station_ids":
        payload.update(status="error", configured=True,
                       message="Les identifiants des stations doivent comporter 8 chiffres et commencer par 38 pour l'Isère.")
    else:
        payload.update(
            status="stale" if has_data else "error", configured=True,
            message="Météo-France temporairement indisponible. Les dernières données disponibles sont conservées."
            if has_data else "Aucune mesure Météo-France disponible pour le moment.",
        )
    return _with_age(payload)


def _with_age(payload: dict) -> dict:
    payload = deepcopy(payload)
    if payload.get("status") == "ok":
        payload["status"] = "online"  # Compatibility with earlier persisted files.
    observed = _date(payload.get("observed_at"))
    age = max(0, int((_now() - observed).total_seconds())) if observed else None
    payload["data_age_seconds"] = age
    payload["stale"] = age is not None and age > STALE_SECONDS
    if payload["stale"] and payload.get("status") in {"online", "partial"}:
        payload.update(status="stale", message="Les dernières mesures disponibles datent de plus de 30 minutes.")
    for station in payload.get("stations", []):
        when = _date(station.get("observed_at"))
        station["stale"] = when is None or (_now() - when).total_seconds() > STALE_SECONDS
    if "stations" in payload:
        payload["summary"] = _observation_summary(payload["stations"])
        if payload.get("status") == "online" and any(station["stale"] for station in payload["stations"]):
            payload.update(status="partial", message="Certaines stations disposent uniquement de mesures anciennes. Vérifier la date de chaque relevé.")
    return payload


def _parse_station_catalog(raw: bytes) -> list[dict]:
    text = raw.decode("utf-8-sig")
    delimiter = ";" if ";" in text.splitlines()[0] else ","
    stations = {}
    for row in csv.DictReader(io.StringIO(text), delimiter=delimiter):
        row = {str(key or "").strip().lower(): value for key, value in row.items()}
        station_id = str(row.get("id_station") or row.get("geo_id_insee") or "").strip()
        if not re.fullmatch(r"38[0-9]{6}", station_id):
            continue
        lat = _number(row.get("latitude") or row.get("lat"))
        lon = _number(row.get("longitude") or row.get("lon"))
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        stations[station_id] = {
            "id": station_id, "name": str(row.get("nom_usuel") or row.get("nom") or station_id).strip(),
            "lat": lat, "lon": lon, "elevation_m": _number(row.get("altitude")),
        }
    return sorted(stations.values(), key=lambda station: station["id"])


def _station_catalog(headers: dict) -> list[dict]:
    cached = _read_snapshot("stations")
    if _fresh(cached, 3600) and cached.get("stations"):
        return cached["stations"]
    try:
        stations = _parse_station_catalog(_http_bytes(f"{OBS_API}/liste-stations", headers))
        if not stations:
            raise WeatherSourceError("empty_catalog")
        _write_snapshot("stations", {"checked_at": _iso(_now()), "stations": stations})
        return stations
    except Exception:
        if cached.get("stations"):
            return cached["stations"]
        raise


def _parse_observations(raw: bytes, station: dict) -> list[dict]:
    payload = json.loads(raw)
    rows = payload.get("features", []) if isinstance(payload, dict) and payload.get("type") == "FeatureCollection" else payload
    if isinstance(rows, dict):
        rows = [rows]
    if not isinstance(rows, list):
        raise WeatherSourceError("invalid_observations")
    observations = []
    for feature in rows:
        if not isinstance(feature, dict):
            continue
        properties = feature.get("properties", feature)
        if not isinstance(properties, dict):
            continue
        station_id = str(properties.get("geo_id_insee") or properties.get("id_station") or station["id"])
        if station_id != station["id"]:
            continue
        observed = _date(properties.get("validity_time"))
        if observed is None or observed > _now() + timedelta(minutes=5) or observed < _now() - timedelta(hours=25):
            continue
        def scaled(key, factor=1, offset=0, minimum=None, maximum=None):
            number = _number(properties.get(key))
            if number is None:
                return None
            value = number * factor + offset
            if (minimum is not None and value < minimum) or (maximum is not None and value > maximum):
                return None
            return round(value, 2)
        point = {
            "observed_at": _iso(observed),
            "temperature_c": scaled("t", offset=-273.15, minimum=-100, maximum=70),
            "wind_kmh": scaled("ff", 3.6, minimum=0, maximum=500),
            "gust_kmh": scaled("fxi10", 3.6, minimum=0, maximum=500),
            "wind_direction_deg": scaled("dd", minimum=0, maximum=360),
            "rain_6m_mm": scaled("rr_per", minimum=0, maximum=500),
            "humidity_percent": scaled("u", minimum=0, maximum=100),
            "pressure_hpa": scaled("pres", 0.01, minimum=300, maximum=1100),
        }
        if not any(value is not None for key, value in point.items() if key != "observed_at"):
            continue
        observations.append(point)
        geometry = feature.get("geometry")
        coordinates = geometry.get("coordinates") if isinstance(geometry, dict) else None
        if isinstance(coordinates, list) and len(coordinates) >= 2:
            lon, lat = _number(coordinates[0]), _number(coordinates[1])
            if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180:
                station.update(lat=lat, lon=lon)
    return sorted(observations, key=lambda item: item["observed_at"])


def _merge_history(previous: list, current: list) -> list[dict]:
    cutoff = _now() - timedelta(hours=24)
    unique = {}
    for item in [*previous, *current]:
        observed = _date(item.get("observed_at")) if isinstance(item, dict) else None
        if observed and cutoff <= observed <= _now() + timedelta(minutes=5):
            unique[_iso(observed)] = item
    return [unique[key] for key in sorted(unique)][-241:]


def get_observation_history(station_id: str) -> dict:
    """Read local history on demand; never trigger a station/API download."""
    valid = bool(re.fullmatch(r"38[0-9]{6}", str(station_id)))
    snapshot = _read_snapshot(f"history_{station_id}") if valid else {}
    history = _merge_history(snapshot.get("history", []), [])
    return {
        "status": "online" if history else "unavailable", "source": "Météo-France",
        "station_id": station_id if valid else None, "history": history,
        "history_note": "Mesures collectées par ce serveur sur les dernières 24 heures. Les intervalles manquants ne sont pas interpolés.",
        "interval_minutes": 6,
    }


def _observation_summary(stations: list[dict]) -> dict:
    fresh = [station for station in stations if not station.get("stale")]
    def values(key):
        return [station[key] for station in fresh if isinstance(station.get(key), (int, float))]
    return {
        "station_count": len(stations), "fresh_stations": len(fresh),
        "max_rain_6m_mm": max(values("rain_6m_mm"), default=None),
        "max_gust_kmh": max(values("gust_kmh"), default=None),
        "min_temperature_c": min(values("temperature_c"), default=None),
        "max_temperature_c": max(values("temperature_c"), default=None),
    }


def fetch_meteo_observations_isere(force_refresh: bool = False) -> dict:
    previous = _read_snapshot("observations")
    try:
        headers = _auth_headers("observations")
    except WeatherSourceError as error:
        return _error_payload("observations", error, previous)
    if not force_refresh and _fresh(previous, OBS_TTL_SECONDS):
        return _with_age(previous)
    try:
        with _collection_lock("observations") as acquired:
            if not acquired:
                return _with_age(previous or _base_payload("observations"))
            # Another process may have finished between reading the cache and acquiring its lock.
            latest = _read_snapshot("observations")
            if not force_refresh and _fresh(latest, OBS_TTL_SECONDS):
                return _with_age(latest)
            previous = latest or previous
            configured_ids = str(getattr(settings, "meteo_france_station_ids", "") or "").strip()
            ids = list(dict.fromkeys(re.split(r"[,;\s]+", configured_ids))) if configured_ids else []
            if any(not re.fullmatch(r"38[0-9]{6}", item) for item in ids):
                raise WeatherSourceError("invalid_station_ids")
            try:
                catalog = _station_catalog(headers)
            except Exception:
                if not ids:
                    raise
                catalog = previous.get("stations", [])
            stations = [item for item in catalog if item["id"] in ids] if ids else catalog
            known = {item["id"] for item in stations}
            stations += [{"id": item, "name": item, "lat": None, "lon": None} for item in ids if item not in known]
            limit = max(1, min(40, int(getattr(settings, "meteo_france_station_limit", 40))))
            selected, total = stations[:limit], len(stations)
            if not selected:
                raise WeatherSourceError("empty_catalog")
            old = {station["id"]: station for station in previous.get("stations", [])}
            def fetch_station(station):
                station = dict(station)
                try:
                    url = f"{OBS_API}/station/infrahoraire-6m?{urlencode({'id_station': station['id'], 'format': 'geojson'})}"
                    points = _parse_observations(_http_bytes(url, headers), station)
                    if not points:
                        raise WeatherSourceError("empty_observations")
                    history = _merge_history(get_observation_history(station["id"])["history"], points)
                    _write_snapshot(f"history_{station['id']}", {"history": history})
                    station.update(points[-1], status="ok")
                    station.pop("error_code", None)
                except Exception as error:
                    saved = old.get(station["id"])
                    if saved:
                        station = deepcopy(saved)
                    station.update(status="unavailable", error_code=str(error) if isinstance(error, WeatherSourceError) else "invalid_data")
                return station
            with ThreadPoolExecutor(max_workers=min(4, len(selected))) as executor:
                collected = list(executor.map(fetch_station, selected))
            available = [station for station in collected if station.get("observed_at")]
            errors = {station.get("error_code") for station in collected if station.get("status") != "ok"}
            if not available and len(errors) == 1 and errors.intersection({"http_401", "http_403", "http_429"}):
                raise WeatherSourceError(errors.pop())
            payload = _base_payload("observations")
            observed = max((station["observed_at"] for station in available), default=None)
            payload.update(
                configured=True, stations=collected, observed_at=observed,
                updated_at=_iso(_now()) if available else previous.get("updated_at"),
                station_total=total, station_limit=limit, truncated=total > limit,
                status="online" if all(station.get("status") == "ok" for station in collected) else "partial" if available else "error",
                history_note="Historique des mesures collectées par ce serveur sur les dernières 24 heures.",
                message="Mesures brutes du réseau Météo-France, actualisées toutes les 6 minutes.",
            )
            if any(station.get("status") != "ok" for station in collected):
                payload["message"] = "Certaines stations n'ont pas transmis de mesure exploitable. Les dates de chaque station restent visibles."
            payload = _with_age(payload)
            payload["summary"] = _observation_summary(payload["stations"])
            _write_snapshot("observations", payload)
            return payload
    except Exception as error:
        payload = _error_payload("observations", error, previous)
        try:
            _write_snapshot("observations", payload)
        except OSError:
            pass
        return payload


def _attribute_text(value: Any) -> str:
    return value.decode("utf-8") if isinstance(value, bytes) else str(value)


def _radar_dependencies():
    try:
        import h5py
        import numpy
        from PIL import Image
        from pyproj import Transformer
        return h5py, numpy, Image, Transformer
    except ImportError:
        raise WeatherSourceError("dependencies_missing") from None


def _hdf_observed_at(hdf, dataset) -> datetime:
    for attributes, pairs in (
        (dataset["what"].attrs if "what" in dataset else {}, [("enddate", "endtime"), ("startdate", "starttime")]),
        (hdf["what"].attrs if "what" in hdf else {}, [("date", "time")]),
    ):
        for date_key, time_key in pairs:
            if date_key in attributes and time_key in attributes:
                try:
                    value = _attribute_text(attributes[date_key]) + _attribute_text(attributes[time_key])
                    observed = datetime.strptime(value, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
                    if observed > _now() + timedelta(minutes=5):
                        raise WeatherSourceError("future_radar")
                    return observed
                except ValueError:
                    continue
    raise WeatherSourceError("missing_radar_time")


def _render_radar_hdf(raw: bytes) -> tuple[bytes, dict]:
    """Reproject an ODIM ACRR mosaic to a small EPSG:3857 PNG for Leaflet.

    Sampling the source window only avoids loading the full 3472×3472 France
    mosaic in each worker. ODIM gain/offset convert stored codes to millimetres.
    Zero precipitation is transparent; missing/unusable pixels are grey.
    """
    h5py, np, Image, Transformer = _radar_dependencies()
    if not raw.startswith(b"\x89HDF\r\n\x1a\n") or len(raw) > MAX_RADAR_BYTES:
        raise WeatherSourceError("invalid_radar_format")
    with h5py.File(io.BytesIO(raw), "r") as hdf:
        dataset = hdf.get("dataset1")
        where = hdf.get("where")
        if dataset is None or where is None:
            raise WeatherSourceError("invalid_radar_structure")
        rain_group, quality_group = None, None
        for key in dataset:
            if not re.fullmatch(r"data[0-9]+", key):
                continue
            group = dataset[key]
            if "what" not in group or "data" not in group:
                continue
            quantity = _attribute_text(group["what"].attrs.get("quantity", "")).upper()
            if quantity == "ACRR":
                rain_group = group
            elif quantity == "QIND":
                quality_group = group
        if rain_group is None:
            raise WeatherSourceError("unsupported_radar_quantity")
        source_data = rain_group["data"]
        if source_data.ndim != 2 or source_data.size > 16_000_000 or source_data.dtype.kind not in "uif":
            raise WeatherSourceError("invalid_radar_dimensions")
        attrs = where.attrs
        height, width = source_data.shape
        xscale, yscale = float(attrs["xscale"]), float(attrs["yscale"])
        if not (0 < xscale <= 10000 and 0 < yscale <= 10000):
            raise WeatherSourceError("invalid_radar_scale")
        if int(attrs["xsize"]) != width or int(attrs["ysize"]) != height:
            raise WeatherSourceError("invalid_radar_dimensions")
        # Do not allow a PROJ definition to access arbitrary local grids/files.
        projection = _attribute_text(attrs["projdef"])
        if any(part in projection.lower() for part in ("+init=", "+nadgrids=", "+geoidgrids=", "+file=", "http:", "https:")):
            raise WeatherSourceError("invalid_radar_projection")
        to_source = Transformer.from_crs("EPSG:4326", projection, always_xy=True)
        origin_x, origin_y = to_source.transform(float(attrs["UL_lon"]), float(attrs["UL_lat"]))
        to_mercator = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
        southwest, northeast = RADAR_BOUNDS
        xmin, ymin = to_mercator.transform(southwest[1], southwest[0])
        xmax, ymax = to_mercator.transform(northeast[1], northeast[0])
        image_width = 640
        image_height = min(1024, max(1, round(image_width * (ymax - ymin) / (xmax - xmin))))
        xs = xmin + (np.arange(image_width) + 0.5) * (xmax - xmin) / image_width
        ys = ymax - (np.arange(image_height) + 0.5) * (ymax - ymin) / image_height
        target_x, target_y = np.meshgrid(xs, ys)
        transform = Transformer.from_crs("EPSG:3857", projection, always_xy=True)
        source_x, source_y = transform.transform(target_x, target_y)
        columns = np.floor((source_x - origin_x) / xscale).astype(np.int64)
        rows = np.floor((origin_y - source_y) / yscale).astype(np.int64)
        inside = (columns >= 0) & (columns < width) & (rows >= 0) & (rows < height)
        if not np.any(inside):
            raise WeatherSourceError("radar_outside_area")
        first_row, last_row = int(rows[inside].min()), int(rows[inside].max())
        first_col, last_col = int(columns[inside].min()), int(columns[inside].max())
        window = source_data[first_row:last_row + 1, first_col:last_col + 1]
        clipped_rows = np.clip(rows - first_row, 0, window.shape[0] - 1)
        clipped_cols = np.clip(columns - first_col, 0, window.shape[1] - 1)
        codes = window[clipped_rows, clipped_cols]
        metadata = rain_group["what"].attrs
        gain, offset = float(metadata.get("gain", 0.01)), float(metadata.get("offset", 0))
        if not (math.isfinite(gain) and gain > 0 and math.isfinite(offset)):
            raise WeatherSourceError("invalid_radar_scale")
        amount = codes.astype(np.float64) * gain + offset
        valid = inside & np.isfinite(amount) & (amount >= 0)
        nodata = metadata.get("nodata", 65535)
        undetect = metadata.get("undetect", 0)
        valid &= codes != nodata
        amount[codes == undetect] = 0
        # Some ODIM files place QIND under the rain field rather than data2.
        if quality_group is None:
            for key in rain_group:
                if key.startswith("quality") and "data" in rain_group[key]:
                    quality_group = rain_group[key]
                    break
        if quality_group is not None and quality_group["data"].shape == source_data.shape:
            quality_window = quality_group["data"][first_row:last_row + 1, first_col:last_col + 1]
            quality = quality_window[clipped_rows, clipped_cols]
            quality_attrs = quality_group["what"].attrs if "what" in quality_group else {}
            physical_quality = quality * float(quality_attrs.get("gain", 1)) + float(quality_attrs.get("offset", 0))
            valid &= (physical_quality > 0) & (quality != quality_attrs.get("nodata", -1))
        rgba = np.zeros((image_height, image_width, 4), dtype=np.uint8)
        rgba[~valid] = [100, 116, 139, 45]
        for entry in RADAR_LEGEND:
            if entry["min"] is None:
                continue
            color = entry["color"].lstrip("#")
            rgba[valid & (amount >= entry["min"])] = [int(color[index:index + 2], 16) for index in (0, 2, 4)] + [210]
        output = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(output, format="PNG", optimize=True)
        observed = _hdf_observed_at(hdf, dataset)
        summary = {
            "max_rain_5m_mm": round(float(amount[valid].max()), 2) if np.any(valid) else None,
            "coverage_percent": round(float(valid.mean() * 100), 1),
        }
        return output.getvalue(), {
            "id": observed.strftime("%Y%m%d%H%M%S"), "observed_at": _iso(observed),
            "timestamp": int(observed.timestamp()), "bounds": deepcopy(RADAR_BOUNDS),
            "width": image_width, "height": image_height, "summary": summary,
        }


def get_radar_frame_path(frame_id: str) -> Path | None:
    if not FRAME_ID_RE.fullmatch(str(frame_id)):
        return None
    try:
        path = _cache_dir() / f"radar_{frame_id}.png"
        return path if path.is_file() else None
    except OSError:
        return None


def _retained_frames(previous: dict, newest: dict | None = None) -> list[dict]:
    cutoff = _now() - timedelta(hours=1)
    candidates = [*previous.get("frames", []), *([newest] if newest else [])]
    frames = {}
    for frame in candidates:
        observed = _date(frame.get("observed_at"))
        if observed and cutoff <= observed <= _now() + timedelta(minutes=5) and get_radar_frame_path(frame.get("id", "")):
            frames[frame["id"]] = frame
    return [frames[key] for key in sorted(frames)][-RADAR_FRAME_LIMIT:]


def fetch_meteo_radar_isere(force_refresh: bool = False) -> dict:
    previous = _read_snapshot("radar")
    try:
        headers = _auth_headers("radar")
    except WeatherSourceError as error:
        return _error_payload("radar", error, previous)
    if not force_refresh and _fresh(previous, RADAR_TTL_SECONDS):
        return _with_age(previous)
    try:
        with _collection_lock("radar") as acquired:
            if not acquired:
                return _with_age(previous or _base_payload("radar"))
            latest = _read_snapshot("radar")
            if not force_refresh and _fresh(latest, RADAR_TTL_SECONDS):
                return _with_age(latest)
            previous = latest or previous
            _radar_dependencies()  # Fail clearly before downloading a large file.
            url = f"{RADAR_API}/mosaiques/METROPOLE/observations/LAME_D_EAU"
            catalog = json.loads(_http_bytes(url, headers))
            links = catalog.get("links", []) if isinstance(catalog, dict) else catalog
            products = [entry for entry in links if isinstance(entry, dict)
                        and re.search(r"[?&]maille=500(?:&|$)", entry.get("href", ""))]
            advertised_time = max((_date(entry.get("validity_time")) for entry in products
                                   if _date(entry.get("validity_time"))), default=None)
            existing = get_radar_frame_path(advertised_time.strftime("%Y%m%d%H%M%S")) if advertised_time else None
            if existing and any(frame.get("id") == advertised_time.strftime("%Y%m%d%H%M%S") for frame in previous.get("frames", [])):
                frames = _retained_frames(previous)
            else:
                # Ignore catalogue hrefs: credentials go only to this fixed official URL.
                raw = _http_bytes(f"{url}/produit?maille=500", headers, MAX_RADAR_BYTES)
                png, frame = _render_radar_hdf(raw)
                frame["url"] = f"/api/meteo-france/radar/frames/{frame['id']}.png"
                _atomic_bytes(_cache_dir() / f"radar_{frame['id']}.png", png)
                frames = _retained_frames(previous, frame)
            payload = _base_payload("radar")
            if not frames:
                raise WeatherSourceError("stale_radar")
            payload.update(
                status="online", configured=True, frames=frames,
                observed_at=frames[-1]["observed_at"], updated_at=_iso(_now()),
                summary=frames[-1].get("summary", {}),
                message="Cumuls de pluie estimés par radar sur 5 minutes. Source : Météo-France.",
            )
            payload = _with_age(payload)
            _write_snapshot("radar", payload)
            retained = {frame["id"] for frame in frames}
            for path in _cache_dir().glob("radar_*.png"):
                frame_id = path.stem.removeprefix("radar_")
                if FRAME_ID_RE.fullmatch(frame_id) and frame_id not in retained:
                    path.unlink(missing_ok=True)
            return payload
    except Exception as error:
        payload = _error_payload("radar", error, previous)
        try:
            _write_snapshot("radar", payload)
        except OSError:
            pass
        return payload
