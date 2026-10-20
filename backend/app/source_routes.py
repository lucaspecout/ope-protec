"""Authenticated, cache-only HTTP access to the additional official sources."""
from typing import Callable
import math
import re

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator
from .public_sources import DEFINITIONS as PUBLIC_SOURCE_DEFINITIONS


SOURCE_KEYS = (
    "insee_population", "meteo_observations", "vigicrues_forecasts",
    "meteo_radar", "industrial_sites", "enedis",
    *PUBLIC_SOURCE_DEFINITIONS,
)


class PopulationEstimateRequest(BaseModel):
    geometry: dict

    @field_validator("geometry")
    @classmethod
    def validate_geometry(cls, value: dict) -> dict:
        pending = [value]
        while pending:
            node = pending.pop()
            if isinstance(node, float) and not math.isfinite(node):
                raise HTTPException(422, "Les coordonnées doivent être des nombres finis.")
            if isinstance(node, dict):
                pending.extend(node.values())
            elif isinstance(node, list):
                pending.extend(node)
        if value.get("type") == "Feature":
            value = value.get("geometry") or {}
        if not isinstance(value, dict):
            raise ValueError("La géométrie doit être un objet GeoJSON.")
        if value.get("type") not in {"Polygon", "MultiPolygon"}:
            raise ValueError("Tracer un polygone ou un multipolygone.")
        polygons = [value.get("coordinates")] if value["type"] == "Polygon" else value.get("coordinates")
        if not isinstance(polygons, list) or not polygons:
            raise ValueError("Géométrie vide.")
        count = 0
        for polygon in polygons:
            if not isinstance(polygon, list) or not polygon:
                raise ValueError("Polygone vide.")
            for ring in polygon:
                if not isinstance(ring, list) or len(ring) < 4 or ring[0] != ring[-1]:
                    raise ValueError("Chaque contour doit être fermé et contenir au moins quatre points.")
                count += len(ring)
                if count > 2500:
                    raise ValueError("La zone dépasse 2 500 sommets.")
                for point in ring:
                    if not isinstance(point, list) or len(point) < 2:
                        raise ValueError("Coordonnées invalides.")
                    lon, lat = point[:2]
                    if (isinstance(lon, bool) or isinstance(lat, bool)
                            or not isinstance(lon, (float, int)) or not isinstance(lat, (float, int))
                            or not (-180 <= lon <= 180 and -90 <= lat <= 90)):
                        raise ValueError("Les coordonnées doivent être exprimées en longitude/latitude WGS84.")
        return {"type": value["type"], "coordinates": value["coordinates"]}


def create_source_router(authorize: Callable, snapshot_reader: Callable, queue_refresh: Callable) -> APIRouter:
    router = APIRouter(prefix="/api", dependencies=[Depends(authorize)])

    def read_source(key: str, refresh: bool = False) -> dict:
        if refresh:
            queue_refresh(key)
        slot = snapshot_reader().get(key)
        return slot if isinstance(slot, dict) else {"status": "pending", "info_state": "Collecte en arrière-plan."}

    @router.get("/sources/isere")
    def list_sources():
        snapshot = snapshot_reader()
        return {key: snapshot.get(key, {"status": "pending"}) for key in SOURCE_KEYS}

    @router.get("/population/isere/grid")
    def population_grid_status(refresh: bool = False):
        return read_source("insee_population", refresh)

    @router.post("/population/isere/estimate")
    def estimate_population(payload: PopulationEstimateRequest):
        from .territorial_sources import estimate_insee_population
        try:
            return estimate_insee_population(payload.geometry)
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.get("/industries/isere")
    def industrial_sites(refresh: bool = False):
        return read_source("industrial_sites", refresh)

    @router.get("/meteo-france/observations")
    def observations(refresh: bool = False):
        return read_source("meteo_observations", refresh)

    @router.get("/meteo-france/observations/{station_id}/history")
    def observation_history(station_id: str):
        from .weather_sources import get_observation_history
        if not station_id.isdigit() or len(station_id) > 16:
            raise HTTPException(422, "Identifiant de station invalide.")
        return get_observation_history(station_id)

    @router.get("/meteo-france/radar")
    def radar(refresh: bool = False):
        return read_source("meteo_radar", refresh)

    @router.get("/meteo-france/radar/frames/{frame_id}.png", response_class=FileResponse)
    def radar_frame(frame_id: str):
        from .weather_sources import get_radar_frame_path
        path = get_radar_frame_path(frame_id)
        if path is None:
            raise HTTPException(404, "Image radar absente ou expirée.")
        return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, max-age=300"})

    @router.get("/vigicrues/forecasts")
    def forecasts(refresh: bool = False):
        return read_source("vigicrues_forecasts", refresh)

    @router.get("/enedis/isere")
    def electricity():
        return read_source("enedis")

    @router.get("/fuel/isere")
    def fuel(refresh: bool = False):
        return read_source("fuel_isere", refresh)

    @router.get("/onde/isere")
    def onde(refresh: bool = False):
        return read_source("onde_isere", refresh)

    @router.get("/catnat/isere")
    def catnat(refresh: bool = False):
        return read_source("catnat_isere", refresh)

    @router.get("/catnat/isere/history")
    def catnat_history(code_insee: str):
        if not re.fullmatch(r"38[0-9]{3}", code_insee):
            raise HTTPException(422, "Code INSEE de l’Isère invalide.")
        from .public_sources import read_catnat_history
        return read_catnat_history(code_insee)

    @router.get("/energy/aura")
    def energy(refresh: bool = False):
        return read_source("energy_aura", refresh)

    @router.get("/recalls")
    def recalls(refresh: bool = False):
        return read_source("recalls", refresh)

    @router.get("/recalls/{recall_id}")
    def recall_detail(recall_id: str):
        if not re.fullmatch(r"[0-9]{1,15}", recall_id):
            raise HTTPException(422, "Identifiant de rappel invalide.")
        from .public_sources import read_recall_detail
        result = read_recall_detail(recall_id)
        if result is None:
            raise HTTPException(404, "Rappel absent du cache récent. Consulter la source officielle.")
        return result

    return router
