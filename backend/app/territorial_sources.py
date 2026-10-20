"""Official territorial reference data, imported once on the server.

The large INSEE archive must only be refreshed by the background collector.
Zone analysis reads the compact regional cache and never downloads a dataset.
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import csv
from datetime import datetime, timezone
import io
from itertools import chain
import json
import math
import os
from pathlib import Path
import re
import tempfile
from threading import RLock
import time
from typing import Any, Iterator
import unicodedata
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import zipfile


INSEE_SOURCE_URL = "https://www.insee.fr/fr/statistiques/8735162"
INSEE_CSV_URL = "https://www.insee.fr/fr/statistiques/fichier/8735162/Filosofi2021_carreaux_200m_csv.zip"
INDUSTRIAL_SOURCE_URL = "https://www.georisques.gouv.fr/donnees/bases-de-donnees/installations-industrielles"
INDUSTRIAL_CSV_URL = "https://mapsref.brgm.fr/wxs/georisques/georisques_dl?" + urlencode({
    "service": "WFS", "version": "2.0.0", "request": "GetFeature",
    "typename": "InstallationsClassees_France", "outputformat": "CSVTEXT",
    "Filter": "<Filter><PropertyIsEqualTo><PropertyName>num_dep</PropertyName><Literal>38</Literal></PropertyIsEqualTo></Filter>",
})
# Includes every Isère border and a margin. Projected bounds are retained in the
# cache, so an analysis outside this import is explicitly reported as partial.
INSEE_IMPORT_BBOX = (4.65, 44.60, 6.65, 46.00)
_GRID_FILENAME = "insee_population_2021_200m_isere_v1.json"
_INDUSTRIAL_FILENAME = "georisques_icpe_isere_v1.json"
_GRID_TTL_SECONDS = 30 * 86400
_INDUSTRIAL_TTL_SECONDS = 86400
_CELL_ID = re.compile(r"(?:^|.*CRS3035RES200m)N(\d+)E(\d+)$", re.IGNORECASE)
_AGE_COLUMNS = ("ind_0_3", "ind_4_5", "ind_6_10", "ind_11_17", "ind_65_79", "ind_80p")
_lock = RLock()
_grid_memory: dict[str, Any] = {}
_industrial_memory: dict[str, Any] = {}


def _settings():
    from .config import settings
    return settings


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _path(filename: str) -> Path:
    root = Path(_settings().static_data_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root / filename


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8") as stream:
            value = json.load(stream)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    # A unique temporary file also makes concurrent workers' writes atomic.
    descriptor, temporary = tempfile.mkstemp(prefix=path.stem + "-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def _import_lock(path: Path) -> Iterator[bool]:
    """Coordinate downloads across workers sharing the persistent volume."""
    lock_path = path.with_suffix(".lock")
    descriptor = None
    try:
        try:
            if lock_path.exists() and time.time() - lock_path.stat().st_mtime > 1800:
                lock_path.unlink()
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.write(descriptor, str(os.getpid()).encode("ascii"))
        except FileExistsError:
            yield False
            return
        yield True
    finally:
        if descriptor is not None:
            os.close(descriptor)
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass


def _fresh(payload: dict[str, Any] | None, ttl: int) -> bool:
    try:
        stamp = datetime.fromisoformat(str(payload["updated_at"]).replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - stamp).total_seconds() < ttl
    except (TypeError, ValueError, KeyError):
        return False


def _download(url: str, path: Path, max_bytes: int) -> None:
    request = Request(url, headers={"User-Agent": "OpeProtec/1.0 (territorial reference data)", "Accept": "*/*"})
    started = time.monotonic()
    with urlopen(request, timeout=60) as response, path.open("wb") as destination:
        declared = int(response.headers.get("Content-Length") or 0)
        if declared > max_bytes:
            raise ValueError("Le fichier officiel dépasse la taille autorisée")
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes or time.monotonic() - started > 900:
                raise ValueError("Import interrompu : taille ou durée maximale dépassée")
            destination.write(chunk)
        if not total:
            raise ValueError("Le serveur officiel a renvoyé un fichier vide")


def _normal_key(value: str) -> str:
    value = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")


def _csv_rows(stream) -> Iterator[dict[str, str]]:
    first = stream.readline().lstrip("\ufeff")
    if not first:
        return
    delimiter = max((";", ",", "\t"), key=first.count)
    reader = csv.DictReader(chain([first], stream), delimiter=delimiter)
    # Normalize once, not 34 times for each of ~2 million national grid rows.
    reader.fieldnames = [_normal_key(key) for key in reader.fieldnames or []]
    for row in reader:
        yield row


def _number(value: Any) -> float | None:
    try:
        result = float(str(value).replace("\u00a0", "").replace(" ", "").replace(",", "."))
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def _geo_tools():
    from pyproj import Transformer
    from shapely.geometry import box, shape
    from shapely.ops import transform, unary_union
    return Transformer, box, shape, transform, unary_union


def _projected_import_bounds() -> list[float]:
    Transformer, _, _, _, _ = _geo_tools()
    project = Transformer.from_crs("EPSG:4326", "EPSG:3035", always_xy=True)
    return list(project.transform_bounds(*INSEE_IMPORT_BBOX, densify_pts=21))


def _read_grid_cache() -> dict[str, Any] | None:
    try:
        path = _path(_GRID_FILENAME)
        stamp = path.stat().st_mtime_ns
        with _lock:
            if _grid_memory.get("stamp") == stamp:
                return _grid_memory.get("payload")
        payload = _read_json(path)
        if not payload or payload.get("schema_version") != 1 or not payload.get("cells") or not payload.get("projected_bounds"):
            return None
        with _lock:
            _grid_memory.update(stamp=stamp, payload=payload)
        return payload
    except OSError:
        return None


def _grid_metadata(payload: dict[str, Any] | None, status: str = "pending", error: str | None = None) -> dict[str, Any]:
    result = {
        "status": status, "source": "INSEE Filosofi — carreaux de 200 m",
        "source_url": INSEE_SOURCE_URL, "data_year": 2021, "resolution_m": 200,
        "scope": "Isère et alentours", "import_bbox": list(INSEE_IMPORT_BBOX),
        "cells_total": len(payload.get("cells", [])) if payload else 0,
        "updated_at": payload.get("updated_at") if payload else None,
        "imputed_cells_total": payload.get("imputed_cells_total", 0) if payload else 0,
        "info_state": "Référentiel de résidents fiscaux de 2021 ; les carreaux imputés sont signalés.",
    }
    if not payload:
        result["info_state"] = "Import INSEE en arrière-plan ; aucune population carroyée disponible pour le moment."
    if error:
        result["error"] = error
    return result


def _parse_grid_csv(stream, bounds: list[float]) -> tuple[list[list[Any]], int]:
    """Keep only the regional envelope while streaming the national CSV.

    Row layout: x, y, population, households, under18, over65, over80, imputed.
    Inspire coordinates are south-west corners in the equal-area EPSG:3035 CRS.
    """
    cells = []
    imputed = 0
    minx, miny, maxx, maxy = bounds
    seen = set()
    for row in _csv_rows(stream):
        identifier = row.get("idcar_200m", "") or row.get("idcarreau", "")
        match = _CELL_ID.fullmatch(identifier)
        if not match:
            continue  # Other overseas CRS are not in this regional import.
        y, x = (int(value) for value in match.groups())
        # Require whole cells inside the declared coverage rectangle.
        if x < minx or y < miny or x + 200 > maxx or y + 200 > maxy or (x, y) in seen:
            continue
        population = _number(row.get("ind"))
        if population is None or population < 0:
            raise ValueError("Population INSEE manquante ou invalide dans un carreau de la zone")
        amounts = [_number(row.get(key)) for key in _AGE_COLUMNS]
        households = _number(row.get("men"))
        if any(value is None or value < 0 for value in amounts) or households is None or households < 0:
            raise ValueError("Variables démographiques INSEE incomplètes dans un carreau de la zone")
        imputation_value = _number(row.get("i_est_200"))
        if imputation_value not in {0, 1}:
            raise ValueError("Indicateur d'imputation INSEE absent ou invalide dans la zone")
        is_imputed = int(imputation_value)
        cells.append([x, y, population, households, sum(amounts[:4]), amounts[4] + amounts[5], amounts[5], is_imputed])
        seen.add((x, y))
        imputed += is_imputed
    return cells, imputed


def fetch_insee_population_grid(force_refresh: bool = False) -> dict[str, Any]:
    """Background-only importer. Return small metadata, never the grid."""
    cached = _read_grid_cache()
    if cached and not force_refresh and _fresh(cached, _GRID_TTL_SECONDS):
        return _grid_metadata(cached, "online")
    try:
        path = _path(_GRID_FILENAME)
        with _import_lock(path) as acquired:
            if not acquired:
                return _grid_metadata(cached, "stale" if cached else "pending")
            # Another process may have finished between the initial read and lock.
            cached = _read_grid_cache() or cached
            if cached and not force_refresh and _fresh(cached, _GRID_TTL_SECONDS):
                return _grid_metadata(cached, "online")
            bounds = _projected_import_bounds()
            # Align scope to the same full cells actually retained by the parser.
            bounds = [math.ceil(bounds[0] / 200) * 200, math.ceil(bounds[1] / 200) * 200,
                      math.floor(bounds[2] / 200) * 200, math.floor(bounds[3] / 200) * 200]
            local_path = str(getattr(_settings(), "insee_population_local_path", "") or "").strip()
            downloaded = None
            if local_path:
                archive_path = Path(local_path)
            else:
                descriptor, downloaded = tempfile.mkstemp(prefix="insee-import-", suffix=".zip", dir=path.parent)
                os.close(descriptor)
                archive_path = Path(downloaded)
            try:
                if downloaded:
                    url = str(getattr(_settings(), "insee_population_csv_url", "") or INSEE_CSV_URL)
                    _download(url, archive_path, 250 * 1024 * 1024)
                cells, imputed = [], 0
                if zipfile.is_zipfile(archive_path):
                    with zipfile.ZipFile(archive_path) as archive:
                        files = [info for info in archive.infolist() if info.filename.lower().endswith(".csv")]
                        if not files or sum(info.file_size for info in files) > 4 * 1024 ** 3:
                            raise ValueError("Archive INSEE invalide ou trop volumineuse")
                        for info in files:
                            with archive.open(info) as binary, io.TextIOWrapper(binary, encoding="utf-8-sig") as stream:
                                rows, count = _parse_grid_csv(stream, bounds)
                                cells.extend(rows)
                                imputed += count
                else:
                    with archive_path.open("r", encoding="utf-8-sig") as stream:
                        cells, imputed = _parse_grid_csv(stream, bounds)
                if not cells:
                    raise ValueError("Aucun carreau INSEE reconnu dans la zone Isère ; vérifier le format de la source")
                payload = {"schema_version": 1, "updated_at": _now(), "projected_bounds": bounds,
                           "cells": cells, "imputed_cells_total": imputed, "source_url": INSEE_SOURCE_URL}
                _write_json(path, payload)
                with _lock:
                    _grid_memory.update(stamp=path.stat().st_mtime_ns, payload=payload)
                return _grid_metadata(payload, "online")
            finally:
                if downloaded:
                    try:
                        Path(downloaded).unlink()
                    except FileNotFoundError:
                        pass
    except Exception as exc:
        return _grid_metadata(cached, "stale" if cached else "degraded", str(exc))


def _analysis_geometry(geojson: dict[str, Any]):
    _, _, shape, _, unary_union = _geo_tools()
    kind = geojson.get("type") if isinstance(geojson, dict) else None
    if kind == "Feature":
        geojson = geojson.get("geometry") or {}
        kind = geojson.get("type")
    if kind == "FeatureCollection":
        features = geojson.get("features") or []
        if not features or len(features) > 500:
            raise ValueError("Une zone doit contenir entre 1 et 500 polygones")
        parts = [_analysis_geometry(feature) for feature in features]
        geometry = unary_union(parts)
    elif kind in {"Polygon", "MultiPolygon"}:
        geometry = shape(geojson)
    else:
        raise ValueError("La zone doit être un Polygon ou MultiPolygon GeoJSON")
    if geometry.is_empty or not geometry.is_valid:
        raise ValueError("La géométrie de la zone est vide ou invalide")
    minx, miny, maxx, maxy = geometry.bounds
    if not all(math.isfinite(value) for value in geometry.bounds) or minx < -180 or maxx > 180 or miny < -90 or maxy > 90:
        raise ValueError("Coordonnées de zone invalides ; le GeoJSON doit être en longitude/latitude WGS84")
    return geometry


def estimate_insee_population(geojson: dict[str, Any]) -> dict[str, Any]:
    """Estimate resident population by exact overlap of published 200 m cells."""
    payload = _read_grid_cache()
    result = _grid_metadata(payload, "online" if payload else "pending")
    if not payload:
        return result  # In particular: no network, no import, no fabricated zero.
    try:
        Transformer, box, _, transform, _ = _geo_tools()
        project = Transformer.from_crs("EPSG:4326", "EPSG:3035", always_xy=True)
        zone = transform(project.transform, _analysis_geometry(geojson))
        if not math.isfinite(zone.area) or zone.area <= 0:
            raise ValueError("La zone n'a pas de surface exploitable")
        scope = box(*payload["projected_bounds"])
        scoped_zone = zone.intersection(scope)
        coverage = max(0.0, min(1.0, scoped_zone.area / zone.area))
        totals = [0.0] * 5
        count = imputed = 0
        inhabited_area = 0.0
        if not scoped_zone.is_empty:
            minx, miny, maxx, maxy = scoped_zone.bounds
            for row in payload["cells"]:
                x, y = row[0], row[1]
                if x >= maxx or x + 200 <= minx or y >= maxy or y + 200 <= miny:
                    continue
                overlap = scoped_zone.intersection(box(x, y, x + 200, y + 200)).area
                if overlap <= 0:
                    continue
                ratio = min(1.0, overlap / 40000.0)
                for index in range(5):
                    totals[index] += row[index + 2] * ratio
                count += 1
                imputed += int(row[7])
                inhabited_area += overlap
        result.update({
            "status": "online" if coverage >= 0.999 else "partial",
            "population_estimated": round(totals[0]), "households_estimated": round(totals[1]),
            "children_under_18": round(totals[2]), "elderly_65_plus": round(totals[3]),
            "elderly_80_plus": round(totals[4]), "cells_intersected": count,
            "imputed_cells": imputed, "scope_coverage_ratio": round(coverage, 6),
            "inhabited_area_ratio": round(min(1.0, inhabited_area / zone.area), 6),
            "method": "Pondération des résidents de chaque carreau INSEE par sa surface intersectée (EPSG:3035).",
            "limitations": [
                "Résidents des ménages fiscaux en 2021 ; ce chiffre ne mesure pas la présence réelle actuelle ni tous les hébergements collectifs.",
                "Répartition supposée uniforme dans chaque carreau de 200 m ; une partie des données est imputée pour confidentialité.",
                "Les estimations d'âge se recouvrent : les 80 ans et plus font partie des 65 ans et plus.",
            ],
        })
        if coverage < 0.999:
            result["limitations"].append("Zone partiellement hors de l'import régional : population limitée à la partie couverte.")
        if not _fresh(payload, _GRID_TTL_SECONDS):
            result["cache_stale"] = True
        return result
    except ValueError:
        raise
    except Exception as exc:
        result.update(status="degraded", error=str(exc))
        return result


def _seveso_level(value: str, label: str) -> tuple[str, str]:
    normalized = _normal_key(label or value)
    if "haut" in normalized or normalized in {"1", "sh", "ssh", "seveso_haut"}:
        return "haut", "Seveso seuil haut"
    if "bas" in normalized or normalized in {"2", "sb", "ssb", "seveso_bas"}:
        return "bas", "Seveso seuil bas"
    if "non" in normalized or normalized in {"3", "n", "ns", "0"}:
        return "non", "Non Seveso"
    return "inconnu", label or value or "Statut Seveso non renseigné"


def _parse_industrial_csv(stream) -> tuple[list[dict[str, Any]], int]:
    sites, skipped = [], 0
    seen = set()
    transformers = {}
    for row in _csv_rows(stream):
        row = {key: str(value or "").strip() for key, value in row.items() if key is not None}
        department = row.get("num_dep") or row.get("departement") or row.get("code_departement")
        code = row.get("cd_insee") or row.get("code_insee") or row.get("code_commune") or ""
        if department and department != "38" or not department and not code.startswith("38"):
            continue
        identifier = row.get("code_aiot") or row.get("numero_aiot") or row.get("code_s3ic") or ""
        name = row.get("nom_ets") or row.get("nom_etablissement") or row.get("raison_sociale") or ""
        if not identifier or identifier in seen or not name:
            skipped += 1
            continue
        lat = _number(row.get("latitude") or row.get("lat"))
        lon = _number(row.get("longitude") or row.get("lon"))
        if lat is None or lon is None:
            x, y = _number(row.get("x")), _number(row.get("y"))
            epsg = str(row.get("code_epsg") or row.get("epsg") or "").strip().upper().replace("EPSG:", "")
            if x is not None and y is not None and epsg.isdigit():
                if epsg not in transformers:
                    Transformer, _, _, _, _ = _geo_tools()
                    transformers[epsg] = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
                lon, lat = transformers[epsg].transform(x, y)
        if lat is None or lon is None or not (44.5 <= lat <= 46.1 and 4.5 <= lon <= 6.8):
            skipped += 1
            continue
        seveso, label = _seveso_level(row.get("seveso", ""), row.get("lib_seveso", ""))
        safe_identifier = re.sub(r"[^A-Za-z0-9.-]", "", identifier)
        sites.append({
            "id": identifier, "nom": name, "commune": row.get("commune", ""), "code_insee": code,
            "lat": round(lat, 7), "lon": round(lon, 7), "seveso": seveso, "seveso_label": label,
            "regime": row.get("lib_regime") or row.get("regime") or "Non renseigné",
            "etat_activite": row.get("etat_activite") or row.get("lib_etat") or row.get("etat") or "Non renseigné",
            "activite": row.get("lib_naf") or row.get("activite_principale") or "",
            "adresse": row.get("adresse", ""), "siret": row.get("num_siret") or row.get("siret") or "",
            "source_modified_at": row.get("date_modification") or None,
            "last_inspection_at": row.get("derniere_inspection") or None,
            "source_url": "https://www.georisques.gouv.fr/risques/installations/donnees/details/" + safe_identifier,
        })
        seen.add(identifier)
    return sorted(sites, key=lambda site: ({"haut": 0, "bas": 1, "inconnu": 2, "non": 3}[site["seveso"]], site["nom"])), skipped


def fetch_industrial_sites_isere(force_refresh: bool = False) -> dict[str, Any]:
    """Daily departmental ICPE reference; retain last successful data on failure."""
    cached = None
    try:
        path = _path(_INDUSTRIAL_FILENAME)
        stamp = path.stat().st_mtime_ns if path.exists() else None
        with _lock:
            cached = _industrial_memory.get("payload") if _industrial_memory.get("stamp") == stamp else None
        cached = cached or _read_json(path)
        if cached and not force_refresh and _fresh(cached, _INDUSTRIAL_TTL_SECONDS):
            return deepcopy(cached)
        with _import_lock(path) as acquired:
            if not acquired:
                if cached:
                    return {**deepcopy(cached), "status": "stale", "refreshing": True}
                return {"status": "pending", "source": "Géorisques — ICPE", "source_url": INDUSTRIAL_SOURCE_URL, "sites": [], "sites_total": 0}
            latest = _read_json(path)
            if latest and not force_refresh and _fresh(latest, _INDUSTRIAL_TTL_SECONDS):
                return deepcopy(latest)
            url = str(getattr(_settings(), "industrial_sites_csv_url", "") or INDUSTRIAL_CSV_URL)
            descriptor, temporary = tempfile.mkstemp(prefix="icpe-import-", suffix=".csv", dir=path.parent)
            os.close(descriptor)
            try:
                _download(url, Path(temporary), 30 * 1024 * 1024)
                with Path(temporary).open("r", encoding="utf-8-sig") as stream:
                    sites, skipped = _parse_industrial_csv(stream)
                if not sites:
                    raise ValueError("Aucun établissement ICPE localisé reconnu dans la source officielle de l'Isère")
                result = {
                    "status": "online", "source": "Géorisques — ICPE", "source_url": INDUSTRIAL_SOURCE_URL,
                    "department": "Isère (38)", "sites": sites, "sites_total": len(sites),
                    "seveso_haut_total": sum(site["seveso"] == "haut" for site in sites),
                    "seveso_bas_total": sum(site["seveso"] == "bas" for site in sites),
                    "unlocated_sites_total": skipped, "updated_at": _now(),
                    "info_state": "Référentiel d'établissements et de classement réglementaire ; ne signale pas les incidents en cours.",
                }
                _write_json(path, result)
                with _lock:
                    _industrial_memory.update(stamp=path.stat().st_mtime_ns, payload=result)
                return deepcopy(result)
            finally:
                try:
                    Path(temporary).unlink()
                except FileNotFoundError:
                    pass
    except Exception as exc:
        if cached:
            return {**deepcopy(cached), "status": "stale", "error": str(exc)}
        return {"status": "degraded", "source": "Géorisques — ICPE", "source_url": INDUSTRIAL_SOURCE_URL,
                "sites": [], "sites_total": 0, "error": str(exc), "updated_at": None}
