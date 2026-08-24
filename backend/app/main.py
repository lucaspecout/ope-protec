from datetime import datetime, timedelta
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor, as_completed
import logging
from pathlib import Path
import re
import secrets
import socket
from threading import Event, Lock, Thread
from time import monotonic, sleep
from typing import Callable
from urllib.parse import urlparse

import asyncio
import hashlib
import json

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from ldap3 import ALL, SUBTREE, Connection, Server
from ldap3.core.exceptions import LDAPException
from sqlalchemy import func, or_, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .config import settings
from .database import Base, SessionLocal, engine, get_db
from .models import AlertHistory, AppSetting, AuditLog, IncidentEvent, InstitutionPoint, MapAnnotation, MapPoint, Municipality, MunicipalityDocument, OperationalLog, RiverStation, User
from .schemas import (
    MapAnnotationCreate,
    MapAnnotationOut,
    IncidentEventCreate,
    IncidentEventOut,
    IncidentEventUpdate,
    MapPointCreate,
    MapPointOut,
    MunicipalityCreate,
    MunicipalityDocumentOut,
    MunicipalityOut,
    MunicipalityUpdate,
    OperationalLogCreate,
    OperationalLogOut,
    OperationalLogStatusUpdate,
    OperationalLogUpdate,
    LdapTestRequest,
    LdapTestResponse,
    LdapBindPasswordStatus,
    LdapBindPasswordUpdate,
    PasswordChangeRequest,
    LoginResponse,
    Token,
    UserCreate,
    UserOut,
    UserPasswordResetRequest,
    UserPasswordResetResponse,
    UserUpdate,
)
from .security import create_access_token, hash_password, verify_password, verify_and_upgrade, warmup_crypto
from .services import (
    fetch_institutions_isere,
    fetch_forest_fire_map_isere,
    fetch_verified_hosting_isere,
    fetch_bison_fute_live_events,
    fetch_bison_fute_traffic,
    fetch_georisques_commune_risks,
    fetch_georisques_isere_summary,
    fetch_isere_boundary_geojson,
    fetch_meteo_france_isere,
    fetch_meteo_forets_isere,
    fetch_itinisere_disruptions,
    fetch_itinisere_webcams,
    fetch_prefecture_isere_news,
    fetch_dauphine_isere_news,
    fetch_france_bleu_isere_news,
    fetch_placegrenet_news,
    fetch_grenoble_metro_news,
    fetch_ars_aura_health_alerts,
    fetch_seismes_isere,
    fetch_mreseau_disruptions,
    fetch_finess_isere_resources,
    fetch_geodae_isere_defibrillators,
    fetch_isere_opendata_resilience,
    fetch_hubeau_isere_groundwater,
    fetch_hubeau_water_quality,
    fetch_hubeau_water_services,
    fetch_rnb_isere_summary,
    fetch_sncf_isere_alerts,
    fetch_sncf_isere_station_timetables,
    fetch_atmo_aura_isere_air_quality,
    fetch_anfr_isere_antennas,
    fetch_arcep_isere_mobile_outages,
    fetch_apic_isere_alerts,
    fetch_vigicrues_isere,
    fetch_vigicrues_flash_isere_alerts,
    fetch_vigieau_restrictions,
    fetch_aprr_isere_traffic,
    fetch_vinci_autoroutes_isere,
    fetch_ter_aura_disruptions,
    fetch_cars_region_aura_disruptions,
    fetch_avalanche_isere,
    fetch_feux_foret_isere,
    fetch_cols_alpins_isere,
    fetch_copernicus_ems_france,
    resolve_commune_insee_code,
    vigicrues_geojson_from_stations,
    save_risks_snapshot,
    load_risks_snapshot,
    fetch_municipality_public_services,
    fetch_isere_public_services_by_city,
    fetch_rnb_buildings_bbox,
    fetch_pr_autoroutes,
    fetch_route_estimate,
    fetch_road_isochrone,
    _redis,
    _REDIS_OK,
)

logger = logging.getLogger(__name__)

Base.metadata.create_all(bind=engine)
Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)


with engine.begin() as conn:
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS app_settings (
            key VARCHAR(120) PRIMARY KEY,
            value TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    """))
    conn.execute(text("ALTER TABLE users ALTER COLUMN username TYPE VARCHAR(120)"))
    conn.execute(text("ALTER TABLE users ALTER COLUMN hashed_password TYPE VARCHAR(255)"))
    conn.execute(text("ALTER TABLE users ALTER COLUMN role TYPE VARCHAR(20)"))
    conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE"))
    conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE"))
    conn.execute(text("UPDATE users SET two_factor_enabled = FALSE WHERE two_factor_enabled IS NULL"))
    conn.execute(text("ALTER TABLE users ALTER COLUMN two_factor_enabled SET DEFAULT FALSE"))
    conn.execute(text("ALTER TABLE users ALTER COLUMN two_factor_enabled SET NOT NULL"))
    conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_source VARCHAR(20) DEFAULT 'local'"))
    conn.execute(text("ALTER TABLE users ALTER COLUMN auth_source TYPE VARCHAR(20)"))
    conn.execute(text("UPDATE users SET auth_source = 'local' WHERE auth_source IS NULL"))
    conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS municipality_name VARCHAR(120)"))
    conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITHOUT TIME ZONE"))
    conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_access_at TIMESTAMP WITHOUT TIME ZONE"))
    conn.execute(text("UPDATE users SET last_access_at = last_login_at WHERE last_access_at IS NULL AND last_login_at IS NOT NULL"))
    conn.execute(text("""
        DO $$
        DECLARE constraint_record record;
        BEGIN
            FOR constraint_record IN
                SELECT conname
                FROM pg_constraint
                WHERE conrelid = 'users'::regclass
                  AND contype = 'c'
                  AND pg_get_constraintdef(oid) ILIKE '%role%'
            LOOP
                EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', constraint_record.conname);
            END LOOP;
        END $$;
    """))
    conn.execute(text("ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS contacts TEXT"))
    conn.execute(text("ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS insee_code VARCHAR(5)"))
    conn.execute(text("ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS postal_code VARCHAR(10)"))
    conn.execute(text("ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS additional_info TEXT"))
    conn.execute(text("ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS population INTEGER"))
    conn.execute(text("ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS shelter_capacity INTEGER"))
    conn.execute(text("ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS radio_channel VARCHAR(80)"))
    conn.execute(text("ALTER TABLE river_stations ADD COLUMN IF NOT EXISTS is_priority BOOLEAN DEFAULT FALSE"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS municipality_id INTEGER REFERENCES municipalities(id)"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS danger_level VARCHAR(20) DEFAULT 'vert'"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS danger_emoji VARCHAR(8) DEFAULT '🟢'"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS target_scope VARCHAR(20) DEFAULT 'departemental'"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'nouveau'"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS event_time TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS location VARCHAR(160)"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS source VARCHAR(120)"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS actions_taken TEXT"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS next_update_due TIMESTAMP WITHOUT TIME ZONE"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS assigned_to VARCHAR(120)"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS tags VARCHAR(255)"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES incident_events(id)"))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS incident_events (
            id SERIAL PRIMARY KEY,
            title VARCHAR(180) NOT NULL,
            address VARCHAR(220) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'ouvert',
            municipality_id INTEGER REFERENCES municipalities(id) ON DELETE SET NULL,
            created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            created_by_id INTEGER NOT NULL REFERENCES users(id)
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS municipality_documents (
            id SERIAL PRIMARY KEY,
            municipality_id INTEGER NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
            doc_type VARCHAR(40) NOT NULL DEFAULT 'annexe',
            title VARCHAR(160) NOT NULL,
            file_path VARCHAR(255) NOT NULL,
            uploaded_by_id INTEGER NOT NULL REFERENCES users(id),
            created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    """))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_municipality_documents_municipality ON municipality_documents(municipality_id)"))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS map_points (
            id SERIAL PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            category VARCHAR(40) NOT NULL DEFAULT 'autre',
            icon VARCHAR(16) NOT NULL DEFAULT '📍',
            notes TEXT,
            lat DOUBLE PRECISION NOT NULL,
            lon DOUBLE PRECISION NOT NULL,
            municipality_id INTEGER REFERENCES municipalities(id) ON DELETE SET NULL,
            created_by_id INTEGER NOT NULL REFERENCES users(id),
            created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    """))
    conn.execute(text("ALTER TABLE map_points ADD COLUMN IF NOT EXISTS icon_url VARCHAR(512)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_river_stations_updated_at ON river_stations(updated_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_operational_logs_created_at ON operational_logs(created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_operational_logs_municipality_created_at ON operational_logs(municipality_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_operational_logs_event_created_at ON operational_logs(event_id, created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_incident_events_created_at ON incident_events(created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_municipality_documents_created_at ON municipality_documents(created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_municipalities_crisis_mode ON municipalities(crisis_mode)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_municipalities_pcs_active ON municipalities(pcs_active)"))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS map_annotations (
            id SERIAL PRIMARY KEY,
            annotation_type VARCHAR(24) NOT NULL DEFAULT 'polygon',
            geojson TEXT NOT NULL,
            text_label VARCHAR(180),
            color VARCHAR(16) NOT NULL DEFAULT '#d7263d',
            weight INTEGER NOT NULL DEFAULT 3,
            fill_opacity DOUBLE PRECISION NOT NULL DEFAULT 0.18,
            municipality_id INTEGER REFERENCES municipalities(id) ON DELETE SET NULL,
            created_by_id INTEGER NOT NULL REFERENCES users(id),
            created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS institution_points (
            osm_id VARCHAR(60) PRIMARY KEY,
            name VARCHAR(200) NOT NULL,
            type VARCHAR(60) NOT NULL,
            lat DOUBLE PRECISION NOT NULL,
            lon DOUBLE PRECISION NOT NULL,
            address VARCHAR(300) NOT NULL DEFAULT '',
            priority VARCHAR(20) NOT NULL DEFAULT 'standard',
            info VARCHAR(200) NOT NULL DEFAULT '',
            capacity INTEGER,
            surface_m2 DOUBLE PRECISION,
            capacity_source VARCHAR(80),
            accessibility VARCHAR(40),
            sanitary VARCHAR(40),
            heating VARCHAR(40),
            parking VARCHAR(40),
            source VARCHAR(200) NOT NULL DEFAULT '',
            updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        )
    """))
    conn.execute(text("ALTER TABLE institution_points ADD COLUMN IF NOT EXISTS capacity INTEGER"))
    conn.execute(text("ALTER TABLE institution_points ADD COLUMN IF NOT EXISTS surface_m2 DOUBLE PRECISION"))
    conn.execute(text("ALTER TABLE institution_points ADD COLUMN IF NOT EXISTS capacity_source VARCHAR(80)"))
    conn.execute(text("ALTER TABLE institution_points ADD COLUMN IF NOT EXISTS accessibility VARCHAR(40)"))
    conn.execute(text("ALTER TABLE institution_points ADD COLUMN IF NOT EXISTS sanitary VARCHAR(40)"))
    conn.execute(text("ALTER TABLE institution_points ADD COLUMN IF NOT EXISTS heating VARCHAR(40)"))
    conn.execute(text("ALTER TABLE institution_points ADD COLUMN IF NOT EXISTS parking VARCHAR(40)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_institution_points_type ON institution_points(type)"))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS alert_history (
            id SERIAL PRIMARY KEY,
            service_key VARCHAR(80) NOT NULL,
            service_label VARCHAR(120) NOT NULL,
            new_level VARCHAR(20) NOT NULL,
            previous_level VARCHAR(20),
            detail TEXT,
            triggered_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    """))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_alert_history_triggered_at ON alert_history(triggered_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_alert_history_service_key ON alert_history(service_key)"))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS audit_log (
            id SERIAL PRIMARY KEY,
            username VARCHAR(80) NOT NULL,
            action VARCHAR(160) NOT NULL,
            resource_type VARCHAR(80),
            details TEXT,
            ip_address VARCHAR(60),
            status_code INTEGER,
            created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    """))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_audit_log_username ON audit_log(username)"))


app = FastAPI(title=settings.app_name)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=800)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")
AUDIT_LOG_MAX_ROWS = 500


def prune_audit_logs(db: Session) -> None:
    db.flush()
    db.execute(text("""
        DELETE FROM audit_log
        WHERE id NOT IN (
            SELECT id FROM audit_log
            ORDER BY created_at DESC, id DESC
            LIMIT :limit
        )
    """), {"limit": AUDIT_LOG_MAX_ROWS})


@app.middleware("http")
async def audit_log_middleware(request: Request, call_next):
    try:
        response = await call_next(request)
    except Exception as exc:
        logger.exception("Unhandled API error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "detail": f"Erreur interne du serveur ({exc.__class__.__name__})",
                "path": request.url.path,
                "error": exc.__class__.__name__,
            },
        )
    method = request.method
    path = request.url.path
    should_log = (
        method in ("POST", "PATCH", "PUT", "DELETE")
        or (method == "GET" and "/export/" in path)
    )
    if should_log and not path.startswith(("/static", "/health")):
        username = _get_request_username(request)
        ip = _get_client_ip(request)
        action = f"{method} {path}"
        resource_type = _path_resource_type(path)
        status_code = response.status_code
        details = json.dumps({
            "query": str(request.url.query or ""),
            "user_agent": str(request.headers.get("user-agent") or "")[:220],
            "referer": str(request.headers.get("referer") or "")[:220],
        }, ensure_ascii=False)

        def _write():
            db = None
            try:
                db = SessionLocal()
                db.add(AuditLog(
                    username=username,
                    action=action,
                    resource_type=resource_type,
                    details=details,
                    ip_address=ip,
                    status_code=status_code,
                ))
                prune_audit_logs(db)
                db.commit()
            except Exception:
                pass
            finally:
                if db:
                    db.close()

        import asyncio as _asyncio
        loop = _asyncio.get_event_loop()
        loop.run_in_executor(None, _write)
    return response

READ_ROLES = {"admin", "ope", "securite", "visiteur", "mairie"}
EDIT_ROLES = {"admin", "ope"}

# Intervalle de rafraîchissement par service (secondes).
# Chaque service tourne dans sa propre boucle indépendante : une panne sur
# l'un n'affecte pas les autres, et les données les plus volatiles sont
# rafraîchies plus souvent que les données quasi-statiques.
SERVICE_REFRESH_INTERVALS: dict[str, int] = {
    "prefecture_isere":        90,   # Actualités urgentes
    "meteo_france":           120,
    "meteo_forets_isere":    1800,
    "itinisere":              120,
    "sncf_isere":             120,
    "vigicrues":              120,
    "ter_aura":               120,   # Transport
    "mreseau":                120,   # M Réseau trams + bus + cars Grenoble
    "vigicrues_flash_isere":  180,
    "apic_isere":             180,
    "dauphine_isere":         180,
    "aprr_isere":             180,
    "vinci_autoroutes":       180,
    "bison_fute":             300,
    "cars_region_aura":       300,
    "vigieau":                600,
    "atmo_aura":              600,
    "arcep_isere":            600,
    "georisques":             600,
    "rnb_isere":             1800,
    "isere_opendata":        1800,
    "groundwater_isere":     3600,
    "anfr_isere":           21600,   # Données quasi-statiques
    "finess_isere":         21600,
    "geodae_isere":         21600,
    "france_bleu_isere":    300,    # Actualités France Bleu Isère
    "placegrenet":          300,    # Place Gre'net – actualités Grenoble/Isère
    "grenoble_metro":       300,    # Grenoble Alpes Métropole
    "ars_aura":             300,    # ARS AURA – alertes sanitaires
    "seismes_isere":        600,    # Séismes Isère (BCSF-RéNaSS)
    "avalanche_isere":     1800,    # BRA Météo-France massifs Isère
    "feux_foret_isere":     300,    # Feux de forêt FeuxDeForet.fr Isère
    "cols_alpins_isere":   1800,    # État cols alpins Isère (couche officielle Itinisère)
    "copernicus_ems":      1800,    # Copernicus EMS cartographie d'urgence
}
CRITICAL_REFRESH_SERVICES = (
    "meteo_france",
    "vigicrues",
    "apic_isere",
    "vigicrues_flash_isere",
    "prefecture_isere",
)
HIGH_REFRESH_SERVICES = CRITICAL_REFRESH_SERVICES + (
    "itinisere",
    "sncf_isere",
    "ter_aura",
    "mreseau",
)
LOW_REFRESH_SERVICES = (
    "anfr_isere",
    "finess_isere",
    "geodae_isere",
    "groundwater_isere",
    "rnb_isere",
    "isere_opendata",
    "avalanche_isere",
    "cols_alpins_isere",
    "copernicus_ems",
)
SERVICE_BACKOFF_SECONDS = (60, 180, 300, 900)
SERVICE_CIRCUIT_BREAKER_OPEN_AFTER = 3

_external_risks_snapshot_lock = Lock()
_external_risks_snapshot: dict = {"updated_at": None, "payload": {}}


def _is_legacy_cols_snapshot(slot: dict | None) -> bool:
    if not isinstance(slot, dict):
        return False
    source = str(slot.get("source") or "")
    if "Layer-repere_cols" in source:
        return False
    cols = slot.get("cols")
    if not isinstance(cols, list) or not cols:
        return False
    return all(
        str((col or {}).get("statut") or "").strip().lower() in {"", "inconnu", "unknown"}
        and "météo indisponible" in str((col or {}).get("detail") or "").strip().lower()
        for col in cols
        if isinstance(col, dict)
    )
_external_risks_refresh_lock = Lock()
_external_risks_refresh_in_progress = False
_service_runtime_lock = Lock()
_service_runtime: dict[str, dict] = {}
_refresh_stop_event = Event()
_refresh_executor = ThreadPoolExecutor(max_workers=settings.background_refresh_workers)

# SSE broadcast registry — clients abonnés aux mises à jour temps réel
_sse_risk_clients: set[asyncio.Queue] = set()
_sse_risk_clients_lock = Lock()
_sse_risk_loop: asyncio.AbstractEventLoop | None = None

ALLOWED_DOC_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}

_map_annotations_revision_lock = Lock()
_map_annotations_revision = 0
# ── Alert history tracking ──────────────────────────────────────────────────
_LEVEL_SEVERITY: dict[str, int] = {
    "inconnu": -1, "pending": -1,
    "vert": 0, "online": 0, "partial": 0,
    "jaune": 1, "stale": 1,
    "orange": 2, "degraded": 2,
    "rouge": 3, "unavailable": 3,
}
_alert_prev_levels: dict[str, str] = {}
_alert_prev_levels_lock = Lock()


def _extract_level_from_slot(key: str, data: dict) -> str:
    status = str(data.get("status") or "inconnu")
    if status in ("error", "unavailable"):
        return "rouge"
    if key == "meteo_france":
        return str(data.get("level") or status)
    if key == "meteo_forets_isere":
        return str(data.get("level") or status)
    if key == "vigicrues":
        return str(data.get("water_alert_level") or status)
    if key == "apic_isere":
        return "orange" if (data.get("alerts_total") or 0) > 0 else "vert"
    if key == "avalanche_isere":
        n = data.get("niveau_max_bra") or 0
        if n >= 4: return "rouge"
        if n >= 3: return "orange"
        if n >= 2: return "jaune"
        return "vert"
    if key == "feux_foret_isere":
        t = data.get("fires_total") or 0
        return "orange" if t > 5 else "jaune" if t > 0 else "vert"
    return status


_SVC_LABELS: dict[str, str] = {
    "meteo_france": "Météo-France", "meteo_forets_isere": "Météo des forêts", "vigicrues": "Vigicrues", "apic_isere": "APIC",
    "avalanche_isere": "Avalanches BRA", "feux_foret_isere": "Feux de forêt Isère",
    "seismes_isere": "Séismes Isère", "vigicrues_flash_isere": "Vigicrues Flash",
    "vigieau": "Vigieau", "atmo_aura": "Atmo AURA", "copernicus_ems": "GDACS · Catastrophes Europe",
    "cols_alpins_isere": "Cols alpins", "prefecture_isere": "Préfecture Isère",
}


def _check_and_record_alert(key: str, new_data: dict) -> None:
    new_level = _extract_level_from_slot(key, new_data)
    with _alert_prev_levels_lock:
        prev_level = _alert_prev_levels.get(key)
        _alert_prev_levels[key] = new_level
    if prev_level is None or prev_level == new_level:
        return
    prev_sev = _LEVEL_SEVERITY.get(prev_level, 0)
    new_sev = _LEVEL_SEVERITY.get(new_level, 0)
    if prev_sev == new_sev or (prev_sev <= 0 and new_sev <= 0):
        return
    label = _SVC_LABELS.get(key, key)
    db = None
    try:
        db = SessionLocal()
        db.add(AlertHistory(
            service_key=key,
            service_label=label,
            new_level=new_level,
            previous_level=prev_level,
            detail=f"{label}: {prev_level} → {new_level}",
        ))
        db.commit()
    except Exception:
        pass
    finally:
        if db:
            db.close()


# ── Audit helpers ────────────────────────────────────────────────────────────
def _get_request_username(request: Request) -> str:
    try:
        auth = request.headers.get("Authorization", "")
        tok = auth[7:].strip() if auth.startswith("Bearer ") else ""
        if not tok:
            return "anonymous"
        payload = jwt.decode(tok, settings.secret_key, algorithms=["HS256"])
        return str(payload.get("sub") or "anonymous")
    except Exception:
        return "anonymous"


def _get_client_ip(request: Request) -> str:
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _path_resource_type(path: str) -> str:
    if "/auth/" in path:        return "auth"
    if "/municipalities" in path: return "municipalities"
    if "/logs" in path:         return "logs"
    if "/events" in path:       return "events"
    if "/map" in path:          return "map"
    if "/notifications" in path: return "notifications"
    if "/users" in path:        return "users"
    return "api"


def bump_map_annotations_revision() -> int:
    global _map_annotations_revision
    with _map_annotations_revision_lock:
        _map_annotations_revision += 1
        return _map_annotations_revision


def utc_timestamp() -> str:
    return datetime.utcnow().isoformat() + "Z"


def compute_global_risk(*levels: str) -> str:
    normalized_levels = {str(level).lower() for level in levels}
    for level in ("rouge", "orange", "jaune"):
        if level in normalized_levels:
            return level
    return "vert"


def _risk_rank(level: str | None) -> int:
    return {"vert": 0, "jaune": 1, "orange": 2, "rouge": 3, "noir": 4}.get(str(level or "").lower(), 0)


def _risk_level_from_score(score: int) -> str:
    if score >= 75:
        return "rouge"
    if score >= 50:
        return "orange"
    if score >= 25:
        return "jaune"
    return "vert"


def _max_level(*levels: str | None) -> str:
    return max((str(level or "vert").lower() for level in levels), key=_risk_rank, default="vert")


def _safe_int(value: object, fallback: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _safe_float(value: object, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def compute_global_risk_details(
    *,
    meteo_level: str | None = "vert",
    crues_level: str | None = "vert",
    external_risks: dict | None = None,
    crisis_count: int = 0,
) -> dict:
    """Calcule un score opérationnel 0-100 sans remplacer les niveaux officiels.

    Le score est une pondération de signaux hétérogènes : vigilance officielle,
    crues observées, alertes flash, crises PCS, trafic routier et qualité de l'air.
    """
    risks = external_risks or {}
    vigicrues = risks.get("vigicrues") if isinstance(risks.get("vigicrues"), dict) else {}
    meteo = risks.get("meteo_france") if isinstance(risks.get("meteo_france"), dict) else {}

    station_levels = [
        str(station.get("level") or station.get("control_status") or "vert").lower()
        for station in (vigicrues.get("stations") or [])
        if isinstance(station, dict)
    ]
    troncon_levels = [
        str(troncon.get("level") or "vert").lower()
        for troncon in (vigicrues.get("troncons") or [])
        if isinstance(troncon, dict)
    ]
    crues_observed = _max_level(crues_level, vigicrues.get("water_alert_level"), *station_levels, *troncon_levels)
    meteo_observed = _max_level(meteo_level, meteo.get("level"))

    score = 0
    factors: list[dict] = []

    def add_factor(label: str, points: int, detail: str = "") -> None:
        nonlocal score
        points = max(0, int(points))
        if points <= 0:
            return
        score += points
        factors.append({"label": label, "points": points, "detail": detail})

    level_points = {"vert": 0, "jaune": 12, "orange": 28, "rouge": 45}
    add_factor("Vigilance météo", level_points.get(meteo_observed, 0), meteo_observed)
    add_factor("Crues observées", level_points.get(crues_observed, 0), crues_observed)
    add_factor("Communes en crise", min(30, crisis_count * 12), f"{crisis_count} commune(s)")

    apic = risks.get("apic_isere") if isinstance(risks.get("apic_isere"), dict) else {}
    apic_total = _safe_int(apic.get("alerts_total"), len(apic.get("alerts") or []))
    add_factor("Pluie intense APIC", min(20, apic_total * 8), f"{apic_total} alerte(s)")

    flash = risks.get("vigicrues_flash_isere") if isinstance(risks.get("vigicrues_flash_isere"), dict) else {}
    flash_total = _safe_int(flash.get("alerts_total"), len(flash.get("alerts") or []))
    add_factor("Vigicrues Flash", min(20, flash_total * 8), f"{flash_total} alerte(s)")

    avalanche = risks.get("avalanche_isere") if isinstance(risks.get("avalanche_isere"), dict) else {}
    bra_level = _safe_int(avalanche.get("niveau_max_bra"))
    add_factor("Avalanche BRA", {3: 8, 4: 16, 5: 24}.get(bra_level, 0), f"niveau {bra_level}/5")

    feux = risks.get("feux_foret_isere") if isinstance(risks.get("feux_foret_isere"), dict) else {}
    fires_total = _safe_int(feux.get("fires_total"))
    add_factor("Feux FeuxDeForet.fr", 16 if fires_total > 5 else 8 if fires_total > 0 else 0, f"{fires_total} foyer(s) sur 2 jours")

    seismes = risks.get("seismes_isere") if isinstance(risks.get("seismes_isere"), dict) else {}
    magnitudes = [_safe_float(item.get("magnitude")) for item in (seismes.get("items") or []) if isinstance(item, dict)]
    max_magnitude = max(magnitudes, default=0)
    add_factor("Séismes récents", 18 if max_magnitude >= 4 else 10 if max_magnitude >= 3 else 0, f"M{max_magnitude:g}")

    sncf = risks.get("sncf_isere") if isinstance(risks.get("sncf_isere"), dict) else {}
    sncf_total = _safe_int(sncf.get("alerts_total"), len(sncf.get("alerts") or []))
    add_factor("SNCF Isère", min(10, sncf_total * 3), f"{sncf_total} alerte(s)")

    bison = risks.get("bison_fute") if isinstance(risks.get("bison_fute"), dict) else {}
    bison_today = bison.get("today") if isinstance(bison.get("today"), dict) else {}
    bison_isere = bison_today.get("isere") if isinstance(bison_today.get("isere"), dict) else {}
    bison_departure = str(bison_isere.get("departure") or "vert").lower()
    bison_return = str(bison_isere.get("return") or "vert").lower()
    bison_level = _max_level(bison_departure, bison_return)
    bison_points = {"jaune": 5, "orange": 10, "rouge": 16, "noir": 22}.get(bison_level, 0)
    add_factor("Bison Futé Isère", bison_points, f"départ {bison_departure} / retour {bison_return}")

    atmo = risks.get("atmo_aura") if isinstance(risks.get("atmo_aura"), dict) else {}
    atmo_today = atmo.get("today") if isinstance(atmo.get("today"), dict) else {}
    atmo_level = str(atmo_today.get("level") or "").lower()
    atmo_label = str(atmo_today.get("label") or atmo_level or "indice indisponible")
    add_factor("Qualité de l'air", {"jaune": 4, "orange": 8, "rouge": 14}.get(atmo_level, 0), atmo_label)

    vigieau = risks.get("vigieau") if isinstance(risks.get("vigieau"), dict) else {}
    water_total = int(len(vigieau.get("alerts") or []))
    add_factor("Restrictions eau", min(10, water_total * 3), f"{water_total} restriction(s)")

    score = max(0, min(100, score))
    level = _max_level(_risk_level_from_score(score), compute_global_risk(meteo_observed, crues_observed))
    return {
        "level": level,
        "score": score,
        "percent": score,
        "label": f"{score}%",
        "factors": factors[:8],
    }


def validate_password_strength(password: str) -> None:
    if len(password) < 8:
        raise HTTPException(400, "Le mot de passe doit contenir au moins 8 caractères")


def sanitize_upload_filename(raw_filename: str | None) -> str:
    filename = Path(raw_filename or "").name
    if not filename:
        raise HTTPException(400, "Nom de fichier invalide")

    sanitized = re.sub(r"[^A-Za-z0-9._-]", "_", filename)
    if not sanitized:
        raise HTTPException(400, "Nom de fichier invalide")
    return sanitized


def ensure_allowed_extension(filename: str) -> None:
    if Path(filename).suffix.lower() not in ALLOWED_DOC_EXTENSIONS:
        raise HTTPException(400, "Type de fichier interdit")


def bootstrap_default_admin() -> None:
    with Session(bind=engine) as db:
        admin = db.query(User).filter(User.username == "admin").first()
        if admin:
            if admin.role != "admin":
                admin.role = "admin"
                db.commit()
            return
        entity = User(
            username="admin",
            hashed_password=hash_password("admin"),
            role="admin",
            must_change_password=True,
        )
        db.add(entity)
        db.commit()


def validate_user_payload(user_payload: UserCreate | UserUpdate, actor: User | None = None) -> tuple[str, str | None]:
    allowed_roles = {"admin", "ope", "securite", "visiteur", "mairie"}
    if user_payload.role not in allowed_roles:
        raise HTTPException(400, "Rôle invalide")
    if actor and actor.role == "ope" and user_payload.role not in {"securite", "visiteur", "mairie"}:
        raise HTTPException(403, "Un opérateur ne peut créer que sécurité, visiteur ou mairie")
    if user_payload.role == "mairie" and not user_payload.municipality_name:
        raise HTTPException(400, "Le rôle mairie nécessite le nom de la commune")
    municipality_name = user_payload.municipality_name if user_payload.role == "mairie" else None
    return user_payload.role, municipality_name


bootstrap_default_admin()
with Session(bind=engine) as db:
    prune_audit_logs(db)
    db.commit()


def touch_user_site_access(user: User, db: Session, force: bool = False) -> None:
    now = datetime.utcnow()
    if not force and user.last_access_at and now - user.last_access_at < timedelta(minutes=1):
        return
    user.last_access_at = now
    db.commit()


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    credentials_exception = HTTPException(status_code=401, detail="Invalid credentials")
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        username = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError as exc:
        raise credentials_exception from exc
    user = db.query(User).filter(User.username == username).first()
    if not user:
        raise credentials_exception
    touch_user_site_access(user, db)
    return user


def get_active_user(user: User = Depends(get_current_user)) -> User:
    if user.must_change_password:
        raise HTTPException(403, "Changement du mot de passe obligatoire")
    return user


def get_user_from_token_value(token: str, db: Session) -> User:
    credentials_exception = HTTPException(status_code=401, detail="Invalid credentials")
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        username = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError as exc:
        raise credentials_exception from exc
    user = db.query(User).filter(User.username == username).first()
    if not user:
        raise credentials_exception
    if user.must_change_password:
        raise HTTPException(403, "Changement du mot de passe obligatoire")
    touch_user_site_access(user, db)
    return user


def require_roles(*roles: str) -> Callable[[User], User]:
    allowed = set(roles)

    def validator(user: User = Depends(get_active_user)) -> User:
        if user.role not in allowed:
            raise HTTPException(403, "Droits insuffisants")
        return user

    return validator


def ldap_escape_filter_value(value: str) -> str:
    return (
        value.replace("\\", r"\5c")
        .replace("*", r"\2a")
        .replace("(", r"\28")
        .replace(")", r"\29")
        .replace("\x00", r"\00")
    )


def ldap_role_from_groups(group_names: set[str]) -> str:
    role = str(settings.ldap_role_default or "visiteur").strip().lower()
    if role not in READ_ROLES:
        role = "visiteur"
    for item in str(settings.ldap_group_role_map or "").split(","):
        if ":" not in item:
            continue
        group, mapped_role = [part.strip().lower() for part in item.split(":", 1)]
        if group and mapped_role in READ_ROLES and group in group_names:
            return mapped_role
    return role


def ldap_required_groups() -> set[str]:
    return {
        group.strip().lower()
        for group in str(settings.ldap_group_required or "").split(",")
        if group.strip()
    }


LDAP_BIND_PASSWORD_SETTING_KEY = "ldap_bind_password"


class LdapAuthenticationUnavailable(RuntimeError):
    pass


def sql_error_detail(exc: SQLAlchemyError) -> str:
    original = getattr(exc, "orig", None)
    message = str(original or exc).splitlines()[0].strip()
    if not message:
        message = exc.__class__.__name__
    return f"{exc.__class__.__name__}: {message[:240]}"


def get_app_setting(db: Session, key: str) -> str | None:
    setting = db.get(AppSetting, key)
    if setting is None:
        return None
    return setting.value


def set_app_setting(db: Session, key: str, value: str) -> AppSetting:
    setting = db.get(AppSetting, key)
    if setting is None:
        setting = AppSetting(key=key, value=value)
        db.add(setting)
    else:
        setting.value = value
        setting.updated_at = datetime.utcnow()
    return setting


def get_ldap_bind_password(db: Session | None = None) -> tuple[str, str]:
    if db is not None:
        configured = get_app_setting(db, LDAP_BIND_PASSWORD_SETTING_KEY)
        if configured:
            return configured, "application"
    else:
        local_db = SessionLocal()
        try:
            configured = get_app_setting(local_db, LDAP_BIND_PASSWORD_SETTING_KEY)
            if configured:
                return configured, "application"
        finally:
            local_db.close()
    fallback = str(settings.ldap_bind_password or "")
    return fallback, "environment" if fallback else "none"


def ldap_query_groups(connection: Connection, user_dn: str) -> set[str]:
    base_dn = str(settings.ldap_group_base_dn or "").strip()
    if not base_dn:
        return set()
    filter_template = str(settings.ldap_group_filter or "(member={user_dn})")
    group_filter = filter_template.replace("{user_dn}", ldap_escape_filter_value(user_dn))
    group_attr = str(settings.ldap_group_name_attr or "cn").strip() or "cn"
    try:
        connection.search(base_dn, group_filter, search_scope=SUBTREE, attributes=[group_attr])
    except LDAPException:
        return set()
    groups: set[str] = set()
    for entry in connection.entries:
        value = getattr(entry, group_attr, None)
        if value:
            for group in value.values:
                groups.add(str(group).strip().lower())
    return groups


def authenticate_ldap_user(username: str, password: str) -> dict | None:
    if not settings.ldap_enabled:
        return None
    username = username.strip()
    if not username or not password:
        return None

    try:
        server = Server(settings.ldap_url, get_info=ALL, connect_timeout=5)
        user_filter = str(settings.ldap_user_filter or "(uid={username})").replace(
            "{username}", ldap_escape_filter_value(username)
        )
        attrs = ["uid", "mail"]
        municipality_attr = str(settings.ldap_municipality_attr or "").strip()
        if municipality_attr:
            attrs.append(municipality_attr)

        if settings.ldap_user_dn_template:
            user_dn = settings.ldap_user_dn_template.replace("{username}", username)
            with Connection(server, user=user_dn, password=password, auto_bind=True):
                if ldap_required_groups():
                    return None
                return {
                    "username": username,
                    "role": ldap_role_from_groups(set()),
                    "municipality_name": None,
                }

        bind_user = str(settings.ldap_bind_dn or "").strip() or None
        bind_password, _ = get_ldap_bind_password()
        with Connection(server, user=bind_user, password=bind_password, auto_bind=True) as search_conn:
            if not settings.ldap_user_base_dn:
                raise LdapAuthenticationUnavailable("LDAP_USER_BASE_DN doit etre configure")
            search_conn.search(settings.ldap_user_base_dn, user_filter, search_scope=SUBTREE, attributes=attrs)
            if not search_conn.entries:
                return None
            entry = search_conn.entries[0]
            user_dn = entry.entry_dn
            canonical_username = username
            uid = getattr(entry, "uid", None)
            if uid and uid.value:
                canonical_username = str(uid.value).strip() or username
            municipality_name = None
            if municipality_attr:
                municipality_value = getattr(entry, municipality_attr, None)
                if municipality_value and municipality_value.value:
                    municipality_name = str(municipality_value.value).strip() or None
            groups = ldap_query_groups(search_conn, user_dn)
            required_groups = ldap_required_groups()
            if required_groups and not groups.intersection(required_groups):
                return None

        with Connection(server, user=user_dn, password=password, auto_bind=True):
            return {
                "username": canonical_username,
                "role": ldap_role_from_groups(groups),
                "municipality_name": municipality_name,
            }
    except LdapAuthenticationUnavailable:
        raise
    except LDAPException as exc:
        logger.warning("LDAP authentication refused or unavailable for %s: %s", username, exc)
        return None
    except Exception as exc:
        logger.exception("Unexpected LDAP authentication error for %s", username)
        raise LdapAuthenticationUnavailable("Erreur LDAP inattendue") from exc


def get_or_create_ldap_user(db: Session, ldap_user: dict) -> User:
    username = str(ldap_user.get("username") or "").strip()
    if not username:
        raise HTTPException(401, "Utilisateur ou mot de passe incorrect")
    user = db.query(User).filter(User.username == username).first()
    role = str(ldap_user.get("role") or settings.ldap_role_default or "visiteur").strip().lower()
    if role not in READ_ROLES:
        role = "visiteur"
    municipality_name = ldap_user.get("municipality_name") if role == "mairie" else None
    if user:
        if user.auth_source != "ldap":
            raise HTTPException(401, "Utilisateur ou mot de passe incorrect")
        user.role = role
        user.municipality_name = municipality_name
        user.must_change_password = False
        return user
    if db.query(User).count() >= 200:
        raise HTTPException(400, "Limite de 200 utilisateurs atteinte")
    user = User(
        username=username,
        hashed_password=hash_password(secrets.token_urlsafe(32)),
        auth_source="ldap",
        role=role,
        municipality_name=municipality_name,
        must_change_password=False,
        two_factor_enabled=False,
    )
    db.add(user)
    return user


def test_ldap_directory_connection() -> dict:
    checks: list[dict[str, str | bool]] = []
    def add_check(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": ok, "detail": detail})

    if not settings.ldap_enabled:
        add_check("Activation", False, "LDAP_ENABLED=false")
        return {"ok": False, "detail": "LDAP desactive", "checks": checks}

    parsed = urlparse(settings.ldap_url)
    host = parsed.hostname
    port = parsed.port or (636 if parsed.scheme == "ldaps" else 389)
    if not host:
        add_check("URL serveur", False, f"URL invalide: {settings.ldap_url}")
        return {"ok": False, "detail": "URL LDAP invalide", "checks": checks}
    add_check("Configuration", True, f"{parsed.scheme or 'ldap'}://{host}:{port}")

    try:
        with socket.create_connection((host, port), timeout=4):
            add_check("Port TCP", True, f"{host}:{port} joignable")
    except OSError as exc:
        add_check("Port TCP", False, f"{host}:{port} injoignable: {exc}")
        return {"ok": False, "detail": "Serveur LDAP injoignable", "checks": checks}

    try:
        server = Server(settings.ldap_url, get_info=ALL, connect_timeout=5)
        bind_user = str(settings.ldap_bind_dn or "").strip() or None
        bind_password, _ = get_ldap_bind_password()
        with Connection(server, user=bind_user, password=bind_password, auto_bind=True) as conn:
            add_check("Bind", True, bind_user or "bind anonyme")
            if settings.ldap_user_base_dn:
                found = conn.search(settings.ldap_user_base_dn, "(objectClass=*)", search_scope=SUBTREE, attributes=["uid", "mail"], size_limit=1)
                add_check("Base utilisateurs", bool(found), settings.ldap_user_base_dn)
                for attr in ("displayname", "display_name", "cn", "givenname", "sn"):
                    try:
                        attr_ok = conn.search(settings.ldap_user_base_dn, "(objectClass=*)", search_scope=SUBTREE, attributes=[attr], size_limit=1)
                        add_check(f"Attribut {attr}", bool(attr_ok), "lisible" if attr_ok else "non trouve")
                        if attr_ok:
                            break
                    except Exception as exc:
                        add_check(f"Attribut {attr}", False, str(exc))
            else:
                add_check("Base utilisateurs", False, "LDAP_USER_BASE_DN manquant")
                return {"ok": False, "detail": "Base utilisateurs manquante", "checks": checks}
            if settings.ldap_group_base_dn:
                found_groups = conn.search(settings.ldap_group_base_dn, "(objectClass=*)", search_scope=SUBTREE, attributes=["cn"], size_limit=1)
                add_check("Base groupes", bool(found_groups), settings.ldap_group_base_dn)
                required_groups = ldap_required_groups()
                if required_groups:
                    required_ok = False
                    for group in required_groups:
                        group_filter = f"({settings.ldap_group_name_attr or 'cn'}={ldap_escape_filter_value(group)})"
                        if conn.search(settings.ldap_group_base_dn, group_filter, search_scope=SUBTREE, attributes=[settings.ldap_group_name_attr or "cn"], size_limit=1):
                            required_ok = True
                            break
                    add_check("Groupe requis", required_ok, ", ".join(sorted(required_groups)))
            return {"ok": all(bool(c["ok"]) for c in checks), "detail": "Diagnostic LDAP termine", "checks": checks}
    except Exception as exc:
        add_check("LDAP", False, str(exc))
        return {"ok": False, "detail": f"Connexion LDAP impossible: {exc}", "checks": checks}


def get_user_municipality_id(user: User, db: Session) -> int | None:
    if not user.municipality_name:
        return None
    municipality = db.query(Municipality).filter(Municipality.name == user.municipality_name).first()
    return municipality.id if municipality else None


def ensure_municipality_scope(user: User, db: Session, municipality_id: int) -> Municipality:
    municipality = db.get(Municipality, municipality_id)
    if not municipality:
        raise HTTPException(404, "Commune introuvable")
    if user.role == "mairie":
        user_municipality_id = get_user_municipality_id(user, db)
        if user_municipality_id != municipality_id:
            raise HTTPException(403, "Accès refusé à cette commune")
    return municipality


def serialize_document(document: MunicipalityDocument, db: Session) -> MunicipalityDocumentOut:
    uploader = db.get(User, document.uploaded_by_id)
    return MunicipalityDocumentOut(
        id=document.id,
        municipality_id=document.municipality_id,
        doc_type=document.doc_type,
        title=document.title,
        filename=Path(document.file_path).name,
        uploaded_by=uploader.username if uploader else "inconnu",
        created_at=document.created_at,
    )


def _broadcast_risk_update_from_thread(event_payload: dict | None = None) -> None:
    """Pousse une mise à jour vers tous les clients SSE connectés.
    Appelé depuis des threads sync — utilise call_soon_threadsafe pour
    soumettre l'écriture dans la boucle asyncio principale."""
    loop = _sse_risk_loop
    if loop is None or not loop.is_running():
        return
    payload = deepcopy(event_payload) if isinstance(event_payload, dict) else _get_external_risks_snapshot()

    def _enqueue() -> None:
        with _sse_risk_clients_lock:
            for q in list(_sse_risk_clients):
                try:
                    q.put_nowait(payload)
                except asyncio.QueueFull:
                    pass  # client trop lent, on passe

    try:
        loop.call_soon_threadsafe(_enqueue)
    except RuntimeError:
        pass


def _set_external_risks_snapshot(payload: dict) -> None:
    with _external_risks_snapshot_lock:
        _external_risks_snapshot["updated_at"] = datetime.utcnow()
        _external_risks_snapshot["payload"] = deepcopy(payload)
    save_risks_snapshot(payload)
    _broadcast_risk_update_from_thread()


def _get_external_risks_snapshot() -> dict:
    with _external_risks_snapshot_lock:
        return deepcopy(_external_risks_snapshot.get("payload") or {})


def _service_meta(key: str, *, status: str | None = None) -> dict:
    with _service_runtime_lock:
        runtime = deepcopy(_service_runtime.get(key) or {})
    meta = {
        "service_key": key,
        "priority": "critical" if key in CRITICAL_REFRESH_SERVICES else "low" if key in LOW_REFRESH_SERVICES else "normal",
        "interval_seconds": SERVICE_REFRESH_INTERVALS.get(key),
        "refreshing": bool(runtime.get("refreshing")),
        "last_success_at": runtime.get("last_success_at"),
        "last_error_at": runtime.get("last_error_at"),
        "last_error": runtime.get("last_error"),
        "last_duration_ms": runtime.get("last_duration_ms"),
        "failure_count": int(runtime.get("failure_count") or 0),
        "next_retry_at": runtime.get("next_retry_at"),
        "circuit_open": bool(runtime.get("circuit_open")),
    }
    if status:
        meta["status"] = status
    return meta


def _is_any_service_refreshing() -> bool:
    with _service_runtime_lock:
        return any(bool(state.get("refreshing")) for state in _service_runtime.values())


def _annotate_service_payload(key: str, payload: dict, *, status: str | None = None) -> dict:
    result = dict(payload or {})
    result["meta"] = _service_meta(key, status=status or str(result.get("status") or "unknown"))
    return result


def _annotate_external_snapshot(payload: dict) -> dict:
    annotated = dict(payload or {})
    for key in SERVICE_REFRESH_INTERVALS:
        slot = annotated.get(key)
        if isinstance(slot, dict):
            annotated[key] = _annotate_service_payload(key, slot)
    return annotated


def _update_service_slot(key: str, result: dict) -> None:
    """Mise à jour atomique d'un seul slot de service dans le snapshot.
    Les autres services ne sont pas affectés."""
    result = _annotate_service_payload(key, result)
    with _external_risks_snapshot_lock:
        payload = dict(_external_risks_snapshot.get("payload") or {})
        payload[key] = deepcopy(result)
        payload["updated_at"] = datetime.utcnow().isoformat() + "Z"
        _external_risks_snapshot["payload"] = payload
        _external_risks_snapshot["updated_at"] = datetime.utcnow()
        snapshot_copy = deepcopy(payload)
    save_risks_snapshot(snapshot_copy)
    _broadcast_risk_update_from_thread({
        "type": "service_update",
        "service_key": key,
        "updated_at": snapshot_copy.get("updated_at"),
        "payload": result,
        "refresh": {"in_progress": _is_any_service_refreshing()},
    })


def _refresh_one_service(key: str) -> None:
    """Récupère les données d'un seul service externe et met à jour son slot."""
    db: Session | None = None
    distributed_lock_key = f"svc:refresh-lock:{key}"
    distributed_lock_token: str | None = None
    try:
        now_mono = monotonic()
        now_utc = datetime.utcnow()
        with _service_runtime_lock:
            runtime = _service_runtime.setdefault(key, {})
            if runtime.get("refreshing"):
                return
            next_retry_mono = float(runtime.get("next_retry_mono") or 0)
            if next_retry_mono and now_mono < next_retry_mono:
                runtime["circuit_open"] = int(runtime.get("failure_count") or 0) >= SERVICE_CIRCUIT_BREAKER_OPEN_AFTER
                return
            runtime["refreshing"] = True
            runtime["circuit_open"] = False
            runtime["started_at"] = now_utc.isoformat() + "Z"
        # Gunicorn workers each run a scheduler. Redis elects one worker per feed,
        # avoiding duplicate downloads and duplicate in-memory parsing.
        if _REDIS_OK and _redis is not None:
            candidate_token = secrets.token_hex(16)
            try:
                if not _redis.set(distributed_lock_key, candidate_token, nx=True, ex=300):
                    return
                distributed_lock_token = candidate_token
            except Exception:
                pass
        with _external_risks_snapshot_lock:
            pending_payload = dict((_external_risks_snapshot.get("payload") or {}).get(key) or {})
        if pending_payload:
            pending_payload["meta"] = _service_meta(key, status="refreshing")
            _broadcast_risk_update_from_thread({
                "type": "service_update",
                "service_key": key,
                "updated_at": utc_timestamp(),
                "payload": pending_payload,
                "refresh": {"in_progress": True},
            })

        pcs_names: list[str] = []
        if key == "georisques":
            db = SessionLocal()
            pcs_names = [
                str(name)
                for (name,) in db.query(Municipality.name).filter(Municipality.pcs_active.is_(True)).all()
                if name
            ]
        jobs = build_external_risks_fetch_jobs(refresh=True, pcs_commune_names=pcs_names)
        if key not in jobs:
            return
        fetcher, fallback = jobs[key]
        # Sauvegarder les données courantes avant la tentative de fetch,
        # pour les préserver si le service est temporairement indisponible.
        with _external_risks_snapshot_lock:
            prev_slot = deepcopy((_external_risks_snapshot.get("payload") or {}).get(key)) or {}
        started = monotonic()
        try:
            result = fetcher()
            duration_ms = int((monotonic() - started) * 1000)
            success_statuses = {"online", "partial", "stale", "degraded"}
            is_success = str(result.get("status") or "").lower() in success_statuses or not result.get("error")
            with _service_runtime_lock:
                runtime = _service_runtime.setdefault(key, {})
                runtime["refreshing"] = False
                runtime["last_duration_ms"] = duration_ms
                if is_success:
                    runtime["failure_count"] = 0
                    runtime["last_success_at"] = datetime.utcnow().isoformat() + "Z"
                    runtime["last_error"] = None
                    runtime["circuit_open"] = False
                    runtime["next_retry_mono"] = 0
                    runtime["next_retry_at"] = None
                else:
                    failure_count = int(runtime.get("failure_count") or 0) + 1
                    backoff = SERVICE_BACKOFF_SECONDS[min(failure_count - 1, len(SERVICE_BACKOFF_SECONDS) - 1)]
                    runtime["failure_count"] = failure_count
                    runtime["circuit_open"] = failure_count >= SERVICE_CIRCUIT_BREAKER_OPEN_AFTER
                    runtime["last_error"] = str(result.get("error") or result.get("stale_reason") or "service indisponible")
                    runtime["last_error_at"] = datetime.utcnow().isoformat() + "Z"
                    runtime["next_retry_mono"] = monotonic() + backoff
                    runtime["next_retry_at"] = (datetime.utcnow() + timedelta(seconds=backoff)).isoformat() + "Z"
        except Exception as exc:
            duration_ms = int((monotonic() - started) * 1000)
            # Conserver les données précédentes (articles, alertes…) :
            # seul le statut et l'erreur sont mis à jour.
            result = prev_slot if prev_slot else dict(fallback)
            result["status"] = "stale" if prev_slot else "unavailable"
            result["error"] = str(exc)
            result.setdefault("updated_at", utc_timestamp())
            with _service_runtime_lock:
                runtime = _service_runtime.setdefault(key, {})
                failure_count = int(runtime.get("failure_count") or 0) + 1
                backoff = SERVICE_BACKOFF_SECONDS[min(failure_count - 1, len(SERVICE_BACKOFF_SECONDS) - 1)]
                runtime["refreshing"] = False
                runtime["failure_count"] = failure_count
                runtime["circuit_open"] = failure_count >= SERVICE_CIRCUIT_BREAKER_OPEN_AFTER
                runtime["last_duration_ms"] = duration_ms
                runtime["last_error"] = str(exc)
                runtime["last_error_at"] = datetime.utcnow().isoformat() + "Z"
                runtime["next_retry_mono"] = monotonic() + backoff
                runtime["next_retry_at"] = (datetime.utcnow() + timedelta(seconds=backoff)).isoformat() + "Z"
        _update_service_slot(key, result)
    except Exception:
        pass
    finally:
        with _service_runtime_lock:
            if key in _service_runtime:
                _service_runtime[key]["refreshing"] = False
        if db is not None:
            db.close()
        if distributed_lock_token and _redis is not None:
            try:
                _redis.eval(
                    "if redis.call('get', KEYS[1]) == ARGV[1] then "
                    "return redis.call('del', KEYS[1]) else return 0 end",
                    1,
                    distributed_lock_key,
                    distributed_lock_token,
                )
            except Exception:
                pass


def _service_scheduler() -> None:
    """Run all periodic feeds through one scheduler and a bounded worker pool."""
    services = sorted(SERVICE_REFRESH_INTERVALS.items(), key=lambda item: item[1])
    now = monotonic()
    next_runs = {key: now + index * 0.4 for index, (key, _) in enumerate(services)}
    while not _refresh_stop_event.is_set():
        now = monotonic()
        for key, interval in services:
            if now >= next_runs[key]:
                _refresh_executor.submit(_refresh_one_service, key)
                next_runs[key] = now + interval
        _refresh_stop_event.wait(0.5)


@app.on_event("startup")
async def startup_capture_event_loop() -> None:
    """Capture la boucle asyncio pour pouvoir y soumettre des mises à jour SSE depuis les threads."""
    global _sse_risk_loop
    _sse_risk_loop = asyncio.get_running_loop()


@app.on_event("startup")
def startup_warmup_external_sources() -> None:
    # Préchauffer bcrypt en arrière-plan pour que la première connexion soit rapide.
    Thread(target=warmup_crypto, daemon=True).start()

    # Initialiser le snapshot : charger la dernière valeur depuis Redis si disponible
    # pour que les données soient immédiatement présentes après un redémarrage.
    # Sinon, utiliser les valeurs "pending" par défaut en attendant les premiers fetches.
    initial_jobs = build_external_risks_fetch_jobs(refresh=False, pcs_commune_names=[])
    persisted_snapshot = load_risks_snapshot()
    if persisted_snapshot and isinstance(persisted_snapshot, dict):
        # Fusionner avec les valeurs par défaut pour garantir que tous les services
        # sont présents (y compris les nouveaux services ajoutés après la dernière sauvegarde).
        fallback_payload: dict = {key: dict(fb) for key, (_, fb) in initial_jobs.items()}
        fallback_payload.update(persisted_snapshot)
        if _is_legacy_cols_snapshot(fallback_payload.get("cols_alpins_isere")):
            fallback_payload["cols_alpins_isere"] = dict(initial_jobs["cols_alpins_isere"][1])
        fallback_payload["updated_at"] = persisted_snapshot.get("updated_at") or utc_timestamp()
        _set_external_risks_snapshot(fallback_payload)
    else:
        initial_payload: dict = {key: dict(fb) for key, (_, fb) in initial_jobs.items()}
        initial_payload["updated_at"] = utc_timestamp()
        _set_external_risks_snapshot(initial_payload)

    # Start one scheduler; its bounded pool staggers services by 400 ms and
    # prevents large external responses from being parsed concurrently without limit.
    _refresh_stop_event.clear()
    Thread(target=_service_scheduler, name="external-refresh-scheduler", daemon=True).start()

    # Préchauffer toutes les données statiques au démarrage.
    # Priorité : fichier JSON (immédiat) → Redis → Overpass/CSV (réseau, seulement si nécessaire).
    def _warmup_static_data() -> None:
        from time import sleep as _sleep
        _sleep(3)  # Laisser gunicorn/uvicorn terminer le démarrage
        # Institutions et FINESS : fetch_* lit le fichier JSON en priorité (< 10 ms)
        try:
            fetch_institutions_isere()
        except Exception:
            pass
        try:
            fetch_finess_isere_resources()
        except Exception:
            pass

    Thread(target=_warmup_static_data, daemon=True).start()


@app.on_event("shutdown")
def shutdown_background_refreshes() -> None:
    _refresh_stop_event.set()
    _refresh_executor.shutdown(wait=False, cancel_futures=True)


@app.get("/health")
def healthcheck():
    return {
        "status": "ok",
        "service": settings.app_name,
        "deployment": "docker-ready",
        "scope": "Département de l'Isère",
        "project_validated": True,
    }


@app.get("/public/live")
def public_live_status(db: Session = Depends(get_db)):
    latest_station = db.query(RiverStation).order_by(RiverStation.updated_at.desc()).first()
    crisis_count = db.query(Municipality).filter(Municipality.crisis_mode.is_(True)).count()

    crues_level = (latest_station.level if latest_station else "vert").lower()

    risks_snapshot = get_external_risks_payload(refresh=False)
    meteo = risks_snapshot.get("meteo_france") or {}
    meteo_level = (meteo.get("level") or "vert").lower()
    vigicrues = risks_snapshot.get("vigicrues") or {}
    itinisere = risks_snapshot.get("itinisere") or {}
    bison_fute = risks_snapshot.get("bison_fute") or {}
    georisques = risks_snapshot.get("georisques") or {}
    prefecture = risks_snapshot.get("prefecture_isere") or {}
    global_risk_details = compute_global_risk_details(
        meteo_level=meteo_level,
        crues_level=crues_level,
        external_risks=risks_snapshot,
        crisis_count=crisis_count,
    )
    weather_situation = [
        {
            "label": alert.get("phenomenon", "Risque météo"),
            "level": (alert.get("level") or "inconnu").lower(),
        }
        for alert in (meteo.get("current_alerts") or [])
    ]

    return {
        "updated_at": utc_timestamp(),
        "dashboard": {
            "vigilance": meteo_level,
            "crues": crues_level,
            "global_risk": global_risk_details["level"],
            "global_risk_score": global_risk_details["score"],
            "global_risk_percent": global_risk_details["percent"],
            "global_risk_label": global_risk_details["label"],
            "global_risk_factors": global_risk_details["factors"],
            "communes_crise": crisis_count,
        },
        "meteo_france": {
            "status": meteo.get("status", "unknown"),
            "department": meteo.get("department", "Isère"),
            "level": meteo.get("level", "n/a"),
            "title": meteo.get("bulletin_title", ""),
            "current_situation": weather_situation,
        },
        "vigicrues": {
            "status": vigicrues.get("status", "unknown"),
            "water_alert_level": vigicrues.get("water_alert_level", "vert"),
            "station_count": len(vigicrues.get("stations", [])),
        },
        "itinisere": {
            "status": itinisere.get("status", "unknown"),
            "events_count": len(itinisere.get("events", [])),
        },
        "bison_fute": bison_fute,
        "georisques": georisques,
        "prefecture_isere": prefecture,
    }


@app.get("/public/isere-map")
def public_isere_map():
    return fetch_isere_boundary_geojson()


@app.get("/map/points", response_model=list[MapPointOut])
def list_map_points(db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    query = db.query(MapPoint)
    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None:
            return []
        query = query.filter((MapPoint.municipality_id == municipality_id) | (MapPoint.municipality_id.is_(None)))
    return query.order_by(MapPoint.created_at.desc()).all()


@app.post("/map/points", response_model=MapPointOut)
def create_map_point(payload: MapPointCreate, db: Session = Depends(get_db), user: User = Depends(require_roles("admin", "ope"))):
    if payload.municipality_id:
        ensure_municipality_scope(user, db, payload.municipality_id)
    point = MapPoint(**payload.model_dump(), created_by_id=user.id)
    db.add(point)
    db.commit()
    db.refresh(point)
    return point


@app.delete("/map/points/{point_id}")
def delete_map_point(point_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles("admin", "ope"))):
    point = db.get(MapPoint, point_id)
    if not point:
        raise HTTPException(404, "Point introuvable")

    db.delete(point)
    db.commit()
    return {"status": "deleted", "id": point_id}


@app.get("/map/annotations", response_model=list[MapAnnotationOut])
def list_map_annotations(db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    query = db.query(MapAnnotation)
    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None:
            return []
        query = query.filter((MapAnnotation.municipality_id == municipality_id) | (MapAnnotation.municipality_id.is_(None)))
    records = query.order_by(MapAnnotation.created_at.desc()).all()
    return [
        {
            "id": row.id,
            "annotation_type": row.annotation_type,
            "geojson": json.loads(row.geojson),
            "text_label": row.text_label,
            "color": row.color,
            "weight": row.weight,
            "fill_opacity": row.fill_opacity,
            "municipality_id": row.municipality_id,
            "created_by_id": row.created_by_id,
            "created_at": row.created_at,
        }
        for row in records
    ]


@app.post("/map/annotations", response_model=MapAnnotationOut)
def create_map_annotation(payload: MapAnnotationCreate, db: Session = Depends(get_db), user: User = Depends(require_roles("admin", "ope"))):
    if payload.municipality_id:
        ensure_municipality_scope(user, db, payload.municipality_id)

    entity = MapAnnotation(
        annotation_type=payload.annotation_type,
        geojson=json.dumps(payload.geojson),
        text_label=payload.text_label,
        color=payload.color,
        weight=payload.weight,
        fill_opacity=payload.fill_opacity,
        municipality_id=payload.municipality_id,
        created_by_id=user.id,
    )
    db.add(entity)
    db.commit()
    db.refresh(entity)
    bump_map_annotations_revision()
    return {
        "id": entity.id,
        "annotation_type": entity.annotation_type,
        "geojson": json.loads(entity.geojson),
        "text_label": entity.text_label,
        "color": entity.color,
        "weight": entity.weight,
        "fill_opacity": entity.fill_opacity,
        "municipality_id": entity.municipality_id,
        "created_by_id": entity.created_by_id,
        "created_at": entity.created_at,
    }


@app.delete("/map/annotations/{annotation_id}")
def delete_map_annotation(annotation_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles("admin", "ope"))):
    entity = db.get(MapAnnotation, annotation_id)
    if not entity:
        raise HTTPException(404, "Annotation introuvable")

    db.delete(entity)
    db.commit()
    bump_map_annotations_revision()
    return {"status": "deleted", "id": annotation_id}


@app.get("/map/annotations/stream")
async def stream_map_annotations(request: Request, token: str = Query(...), db: Session = Depends(get_db)):
    user = get_user_from_token_value(token, db)
    if user.role not in READ_ROLES:
        raise HTTPException(403, "Droits insuffisants")

    async def event_stream():
        last_sent = -1
        last_heartbeat = asyncio.get_running_loop().time()
        while True:
            if await request.is_disconnected():
                break
            with _map_annotations_revision_lock:
                current_revision = _map_annotations_revision
            if current_revision != last_sent:
                last_sent = current_revision
                yield f"data: {json.dumps({'revision': current_revision})}\n\n"
                last_heartbeat = asyncio.get_running_loop().time()
            elif asyncio.get_running_loop().time() - last_heartbeat >= 15:
                # Keep the SSE connection alive through reverse proxies even when
                # no annotation changes occur for a while.
                yield ": keep-alive\n\n"
                last_heartbeat = asyncio.get_running_loop().time()
            await asyncio.sleep(1.0)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/external/isere/risks/stream")
async def stream_external_risks(request: Request, token: str = Query(...), db: Session = Depends(get_db)):
    """Flux SSE : pousse le snapshot complet des risques dès chaque mise à jour serveur.
    Le client reçoit immédiatement le snapshot courant à la connexion, puis chaque
    mise à jour dès qu'un service est rafraîchi en arrière-plan."""
    user = get_user_from_token_value(token, db)
    if user.role not in READ_ROLES:
        raise HTTPException(403, "Droits insuffisants")

    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    with _sse_risk_clients_lock:
        _sse_risk_clients.add(queue)

    async def event_stream():
        try:
            # Envoi immédiat du snapshot courant dès la connexion
            current = _get_external_risks_snapshot()
            yield f"data: {json.dumps(current)}\n\n"

            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=20.0)
                    yield f"data: {json.dumps(data)}\n\n"
                except asyncio.TimeoutError:
                    # Maintien de la connexion à travers les proxies
                    yield ": keep-alive\n\n"
        finally:
            with _sse_risk_clients_lock:
                _sse_risk_clients.discard(queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/auth/register", response_model=UserOut)
def register(user: UserCreate, db: Session = Depends(get_db), creator: User = Depends(require_roles("admin"))):
    role, municipality_name = validate_user_payload(user, actor=creator)
    validate_password_strength(user.password)

    if db.query(User).count() >= 20:
        raise HTTPException(400, "Limite de 20 utilisateurs atteinte")
    if db.query(User).filter(User.username == user.username).first():
        raise HTTPException(400, "Identifiant déjà utilisé")

    entity = User(
        username=user.username,
        hashed_password=hash_password(user.password),
        role=role,
        municipality_name=municipality_name,
    )
    db.add(entity)
    db.commit()
    db.refresh(entity)
    return entity


@app.get("/auth/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), _: User = Depends(require_roles("admin"))):
    return db.query(User).order_by(User.created_at.desc()).all()


@app.post("/auth/ldap/test", response_model=LdapTestResponse)
async def test_ldap(payload: LdapTestRequest, _: User = Depends(require_roles("admin"))):
    username = (payload.username or "").strip()
    password = payload.password or ""
    if username or password:
        if not username or not password:
            raise HTTPException(400, "Identifiant et mot de passe LDAP requis pour tester un utilisateur")
        try:
            ldap_user = await asyncio.get_running_loop().run_in_executor(
                None, lambda: authenticate_ldap_user(username, password)
            )
        except LdapAuthenticationUnavailable as exc:
            return {"ok": False, "mode": "user", "detail": str(exc)}
        if not ldap_user:
            return {"ok": False, "mode": "user", "detail": "Authentification LDAP refusee"}
        return {
            "ok": True,
            "mode": "user",
            "detail": "Authentification LDAP OK",
            "username": ldap_user.get("username"),
            "role": ldap_user.get("role"),
            "municipality_name": ldap_user.get("municipality_name"),
        }
    result = await asyncio.get_running_loop().run_in_executor(None, test_ldap_directory_connection)
    return {
        "ok": bool(result.get("ok")),
        "mode": "directory",
        "detail": str(result.get("detail") or ""),
        "checks": result.get("checks") or [],
    }


@app.get("/auth/ldap/bind-password", response_model=LdapBindPasswordStatus)
def get_ldap_bind_password_status(db: Session = Depends(get_db), _: User = Depends(require_roles("admin"))):
    password, source = get_ldap_bind_password(db)
    return {"configured": bool(password), "source": source}


@app.put("/auth/ldap/bind-password", response_model=LdapBindPasswordStatus)
def update_ldap_bind_password(
    payload: LdapBindPasswordUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin")),
):
    if payload.clear:
        set_app_setting(db, LDAP_BIND_PASSWORD_SETTING_KEY, "")
    elif payload.password:
        set_app_setting(db, LDAP_BIND_PASSWORD_SETTING_KEY, payload.password)
    else:
        raise HTTPException(400, "Mot de passe LDAP requis")
    db.commit()
    password, source = get_ldap_bind_password(db)
    return {"configured": bool(password), "source": source}


@app.patch("/auth/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, payload: UserUpdate, db: Session = Depends(get_db), _: User = Depends(require_roles("admin"))):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    if target.username == "admin" and payload.role != "admin":
        raise HTTPException(400, "Le compte admin principal doit conserver le rôle admin")

    role, municipality_name = validate_user_payload(payload)
    target.role = role
    target.municipality_name = municipality_name
    db.commit()
    db.refresh(target)
    return target


@app.post("/auth/users/{user_id}/reset-password", response_model=UserPasswordResetResponse)
def reset_user_password(
    user_id: int,
    payload: UserPasswordResetRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin")),
):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    if target.auth_source == "ldap":
        raise HTTPException(400, "Le mot de passe d'un utilisateur LDAP se gere dans l'annuaire")

    temporary_password = payload.new_password or secrets.token_urlsafe(10)
    validate_password_strength(temporary_password)

    target.hashed_password = hash_password(temporary_password)
    target.must_change_password = True
    db.commit()
    return {
        "username": target.username,
        "temporary_password": temporary_password,
        "must_change_password": True,
    }


@app.delete("/auth/users/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db), actor: User = Depends(require_roles("admin"))):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    if target.id == actor.id:
        raise HTTPException(400, "Vous ne pouvez pas supprimer votre propre compte")
    if target.username == "admin":
        raise HTTPException(400, "Le compte admin principal ne peut pas être supprimé")

    db.delete(target)
    db.commit()
    return {"status": "deleted", "id": user_id}


@app.post("/auth/login", response_model=LoginResponse)
async def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    ip = _get_client_ip(request)

    def _audit(status: int, detail: str | None = None):
        def _write():
            db2 = SessionLocal()
            try:
                db2.add(AuditLog(
                    username=form_data.username,
                    action="POST /auth/login",
                    resource_type="auth",
                    details=detail,
                    ip_address=ip,
                    status_code=status,
                ))
                prune_audit_logs(db2)
                db2.commit()
            except Exception:
                pass
            finally:
                db2.close()
        asyncio.get_event_loop().run_in_executor(None, _write)

    username = form_data.username.strip()
    password_plain = form_data.password
    user = db.query(User).filter(User.username == username).first()
    if user and user.auth_source == "ldap":
        try:
            ldap_user = await asyncio.get_running_loop().run_in_executor(
                None, lambda: authenticate_ldap_user(username, password_plain)
            )
        except LdapAuthenticationUnavailable as exc:
            _audit(503, str(exc))
            raise HTTPException(503, str(exc)) from exc
        if not ldap_user:
            _audit(401, "LDAP: authentification refusee")
            raise HTTPException(401, "Utilisateur ou mot de passe incorrect")
        user = get_or_create_ldap_user(db, ldap_user)
    elif user:
        hashed = user.hashed_password
        ok, new_hash = await asyncio.get_running_loop().run_in_executor(
            None, lambda: verify_and_upgrade(password_plain, hashed)
        )
        if not ok:
            _audit(401, "Mot de passe incorrect")
            raise HTTPException(401, "Utilisateur ou mot de passe incorrect")
        if new_hash:
            user.hashed_password = new_hash
    else:
        try:
            ldap_user = await asyncio.get_running_loop().run_in_executor(
                None, lambda: authenticate_ldap_user(username, password_plain)
            )
        except LdapAuthenticationUnavailable as exc:
            _audit(503, str(exc))
            raise HTTPException(503, str(exc)) from exc
        if not ldap_user:
            await asyncio.sleep(0.025)
            _audit(401, "Utilisateur inconnu")
            raise HTTPException(401, "Utilisateur ou mot de passe incorrect")
        user = get_or_create_ldap_user(db, ldap_user)
    now = datetime.utcnow()
    user.last_login_at = now
    user.last_access_at = now
    try:
        db.commit()
        db.refresh(user)
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Database error during login for %s", username)
        detail = sql_error_detail(exc)
        _audit(500, f"Erreur base de donnees: {detail}")
        raise HTTPException(500, f"Erreur base de donnees pendant la connexion ({detail})") from exc
    _audit(200)
    return {
        "access_token": create_access_token(user.username),
        "token_type": "bearer",
        "must_change_password": user.must_change_password,
        "user": user,
    }


@app.get("/auth/me", response_model=UserOut)
def auth_me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    touch_user_site_access(user, db, force=True)
    return user


@app.post("/auth/change-password")
def change_password(payload: PasswordChangeRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if user.auth_source == "ldap":
        raise HTTPException(400, "Le mot de passe LDAP se gere dans l'annuaire")
    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(400, "Mot de passe actuel invalide")
    validate_password_strength(payload.new_password)
    user.hashed_password = hash_password(payload.new_password)
    user.must_change_password = False
    db.commit()
    return {"status": "password_updated"}


@app.get("/dashboard")
def dashboard(db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    risks_payload = get_external_risks_payload(refresh=False)
    return build_dashboard_payload(db, user, external_risks=risks_payload)


def build_dashboard_payload(db: Session, user: User, external_risks: dict | None = None) -> dict:
    river_level = db.query(RiverStation).order_by(RiverStation.updated_at.desc()).first()
    crisis_count = db.query(Municipality).filter(Municipality.crisis_mode.is_(True)).count()

    logs_query = db.query(OperationalLog)
    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        logs_query = logs_query.filter(OperationalLog.municipality_id == municipality_id)
        crisis_count = 1 if municipality_id and db.get(Municipality, municipality_id).crisis_mode else 0

    logs = logs_query.order_by(OperationalLog.created_at.desc()).limit(5).all()

    meteo = external_risks.get("meteo_france") if external_risks else None
    if not isinstance(meteo, dict) or not meteo:
        meteo = fetch_meteo_france_isere()
    meteo_level = meteo.get("level") or "vert"
    crues_level = river_level.level if river_level else "vert"
    global_risk_details = compute_global_risk_details(
        meteo_level=meteo_level,
        crues_level=crues_level,
        external_risks=external_risks,
        crisis_count=crisis_count,
    )
    vigicrues = external_risks.get("vigicrues") if isinstance(external_risks, dict) and isinstance(external_risks.get("vigicrues"), dict) else {}
    critical_sources_syncing = (
        str(meteo.get("status") or "").lower() in {"pending", "idle"}
        and str(vigicrues.get("status") or "").lower() in {"pending", "idle", ""}
    )
    if critical_sources_syncing and global_risk_details["level"] == "vert" and crisis_count == 0:
        global_risk_details = {
            **global_risk_details,
            "level": "gris",
            "label": "sync",
            "factors": [{"label": "Synchronisation", "points": 0, "detail": "Météo/crues en cours de mise à jour"}],
        }

    return {
        "vigilance": meteo_level,
        "crues": crues_level,
        "vigilance_risk_type": "",
        "global_risk": global_risk_details["level"],
        "global_risk_score": global_risk_details["score"],
        "global_risk_percent": global_risk_details["percent"],
        "global_risk_label": global_risk_details["label"],
        "global_risk_factors": global_risk_details["factors"],
        "communes_crise": crisis_count,
        "latest_logs": [OperationalLogOut.model_validate(log).model_dump() for log in logs],
    }


def build_external_risks_fetch_jobs(refresh: bool, pcs_commune_names: list[str]) -> dict[str, tuple[Callable[[], dict], dict]]:
    return {
        "meteo_france": (lambda: fetch_meteo_france_isere(force_refresh=refresh), {"status": "pending", "level": "gris", "title": "Météo-France en synchronisation"}),
        "meteo_forets_isere": (lambda: fetch_meteo_forets_isere(force_refresh=refresh), {"status": "pending", "level": "gris", "danger": "synchronisation", "forecasts": []}),
        "vigicrues": (lambda: fetch_vigicrues_isere(force_refresh=refresh), {"status": "pending", "level": "gris", "water_alert_level": "gris", "stations": [], "alerts": []}),
        "itinisere": (lambda: fetch_itinisere_disruptions(force_refresh=refresh), {"status": "pending", "events": [], "events_total": 0}),
        "bison_fute": (lambda: fetch_bison_fute_traffic(force_refresh=refresh), {"status": "pending", "alerts": []}),
        "georisques": (lambda: fetch_georisques_isere_summary(force_refresh=refresh, commune_names=pcs_commune_names), {"status": "pending", "details": []}),
        "rnb_isere": (lambda: fetch_rnb_isere_summary(force_refresh=refresh), {"status": "pending", "buildings_total": 0, "sample": []}),
        "prefecture_isere": (lambda: fetch_prefecture_isere_news(force_refresh=refresh), {"status": "pending", "articles": []}),
        "dauphine_isere": (lambda: fetch_dauphine_isere_news(force_refresh=refresh), {"status": "pending", "articles": []}),
        "france_bleu_isere": (lambda: fetch_france_bleu_isere_news(force_refresh=refresh), {"status": "pending", "items": []}),
        "placegrenet": (lambda: fetch_placegrenet_news(force_refresh=refresh), {"status": "pending", "items": []}),
        "grenoble_metro": (lambda: fetch_grenoble_metro_news(force_refresh=refresh), {"status": "pending", "items": []}),
        "ars_aura": (lambda: fetch_ars_aura_health_alerts(force_refresh=refresh), {"status": "pending", "items": []}),
        "seismes_isere": (lambda: fetch_seismes_isere(force_refresh=refresh), {"status": "pending", "items": []}),
        "sncf_isere": (lambda: fetch_sncf_isere_alerts(force_refresh=refresh), {"status": "pending", "alerts": [], "alerts_total": 0}),
        "vigieau": (lambda: fetch_vigieau_restrictions(force_refresh=refresh), {"status": "pending", "alerts": [], "max_level": "vert"}),
        "atmo_aura": (lambda: fetch_atmo_aura_isere_air_quality(force_refresh=refresh), {"status": "pending", "today": {}, "tomorrow": {}}),
        "anfr_isere": (lambda: fetch_anfr_isere_antennas(force_refresh=refresh), {"status": "pending", "supports_total": 0}),
        "arcep_isere": (lambda: fetch_arcep_isere_mobile_outages(force_refresh=refresh), {"status": "pending", "outages_total": 0, "communes": []}),
        "apic_isere": (lambda: fetch_apic_isere_alerts(force_refresh=refresh), {"status": "pending", "level": "vert", "alerts_total": 0, "alerts": []}),
        "vigicrues_flash_isere": (lambda: fetch_vigicrues_flash_isere_alerts(force_refresh=refresh), {"status": "pending", "level": "vert", "alerts_total": 0, "alerts": []}),
        "finess_isere": (lambda: fetch_finess_isere_resources(force_refresh=refresh), {"status": "pending", "resources": [], "resources_total": 0}),
        "geodae_isere": (lambda: fetch_geodae_isere_defibrillators(force_refresh=refresh), {"status": "pending", "resources": [], "resources_total": 0}),
        "groundwater_isere": (lambda: fetch_hubeau_isere_groundwater(force_refresh=refresh, station_limit=30), {"status": "pending", "stations": [], "stations_total": 0, "trend_summary": {"hausse": 0, "baisse": 0, "stable": 0}}),
        "isere_opendata": (lambda: fetch_isere_opendata_resilience(force_refresh=refresh), {"status": "pending", "datasets": [], "totals": {"food_aid_points": 0, "health_centers": 0, "schools": 0}, "insights": []}),
        "aprr_isere": (lambda: fetch_aprr_isere_traffic(force_refresh=refresh), {"status": "pending", "events": [], "events_total": 0, "routes": ["A41", "A43", "A48", "A51"]}),
        "vinci_autoroutes": (lambda: fetch_vinci_autoroutes_isere(force_refresh=refresh), {"status": "pending", "events": [], "events_total": 0, "routes": ["A40", "A41", "A42", "A43"]}),
        "ter_aura": (lambda: fetch_ter_aura_disruptions(force_refresh=refresh), {"status": "pending", "disruptions": [], "disruptions_total": 0}),
        "mreseau": (lambda: fetch_mreseau_disruptions(force_refresh=refresh), {"status": "pending", "disruptions": [], "disruptions_total": 0, "normal_service": True}),
        "cars_region_aura": (lambda: fetch_cars_region_aura_disruptions(force_refresh=refresh), {"status": "pending", "disruptions": [], "disruptions_total": 0}),
        "avalanche_isere": (lambda: fetch_avalanche_isere(force_refresh=refresh), {"status": "pending", "massifs": [], "massifs_total": 0, "niveau_global": "gris"}),
        "feux_foret_isere": (lambda: fetch_feux_foret_isere(force_refresh=refresh), {"status": "pending", "fires": [], "fires_total": 0, "fires_window_days": 2, "top_fires": [], "recent_incidents": [], "recent_incidents_total": 0, "recent_incidents_2d": [], "recent_incidents_2d_total": 0, "recent_incidents_3d": [], "recent_incidents_3d_total": 0, "info_items": [], "info_items_total": 0}),
        "cols_alpins_isere": (lambda: fetch_cols_alpins_isere(force_refresh=refresh), {"status": "pending", "cols": [], "cols_total": 0, "dangereux_total": 0}),
        "copernicus_ems": (lambda: fetch_copernicus_ems_france(force_refresh=refresh), {"status": "pending", "activations": [], "activations_total": 0, "france_total": 0, "france_activations": []}),
    }


def build_external_risks_pending_payload(
    db: Session | None = None,
    refresh: bool = False,
    base_snapshot: dict | None = None,
    current_key: str | None = None,
) -> dict:
    pcs_commune_names: list[str] = []
    if db is not None:
        pcs_commune_names = [
            str(name)
            for (name,) in db.query(Municipality.name).filter(Municipality.pcs_active.is_(True)).all()
            if name
        ]
    jobs = build_external_risks_fetch_jobs(refresh=refresh, pcs_commune_names=pcs_commune_names)
    payload = {"updated_at": utc_timestamp()}
    for key, (_, fallback) in jobs.items():
        source_payload = base_snapshot.get(key) if isinstance(base_snapshot, dict) else None
        service_payload = dict(source_payload) if isinstance(source_payload, dict) else dict(fallback)
        if current_key:
            if key == current_key:
                service_payload["status"] = "pending"
                service_payload.pop("error", None)
            elif not isinstance(source_payload, dict) and service_payload.get("status") == "pending":
                service_payload["status"] = "idle"
        payload[key] = service_payload
    payload["refresh"] = {
        "in_progress": True,
        "completed": 0,
        "total": len(jobs),
        "current": current_key or "Préparation des flux externes",
    }
    return payload


def build_external_risks_payload(
    refresh: bool = False,
    db: Session | None = None,
    progress_callback: Callable[[str, dict, int, int], None] | None = None,
) -> dict:
    errors: dict[str, str] = {}
    errors_lock = Lock()
    pcs_commune_names: list[str] = []
    if db is not None:
        pcs_commune_names = [
            str(name)
            for (name,) in db.query(Municipality.name).filter(Municipality.pcs_active.is_(True)).all()
            if name
        ]

    def safe_fetch(key: str, fetcher: Callable[[], dict], fallback: dict) -> dict:
        try:
            return fetcher()
        except Exception as exc:
            with errors_lock:
                errors[key] = str(exc)
            payload = dict(fallback)
            payload["status"] = "unavailable"
            payload.setdefault("error", str(exc))
            payload.setdefault("updated_at", utc_timestamp())
            return payload

    fetch_jobs = build_external_risks_fetch_jobs(refresh=refresh, pcs_commune_names=pcs_commune_names)

    results: dict[str, dict] = {}
    total_jobs = len(fetch_jobs)
    completed_count = 0
    callback_lock = Lock()

    def fetch_and_notify(key: str, fetcher, fallback) -> tuple[str, dict]:
        result = safe_fetch(key, fetcher, fallback)
        nonlocal completed_count
        with callback_lock:
            completed_count += 1
            if progress_callback is not None:
                progress_callback(key, result, completed_count, total_jobs)
        return key, result

    with ThreadPoolExecutor(max_workers=settings.external_fetch_workers) as executor:
        futures = [
            executor.submit(fetch_and_notify, key, fetcher, fallback)
            for key, (fetcher, fallback) in fetch_jobs.items()
        ]
        for future in as_completed(futures):
            key, result = future.result()
            results[key] = result

    payload = {"updated_at": utc_timestamp(), **results}
    payload["refresh"] = {
        "in_progress": False,
        "completed": total_jobs,
        "total": total_jobs,
        "current": "Terminé",
    }
    if errors:
        payload["errors"] = errors
    return payload


def trigger_external_risks_refresh(db: Session | None = None) -> None:
    """Relance immédiatement tous les services en parallèle (bouton 'Actualiser maintenant').
    Les boucles indépendantes continuent à tourner sur leur propre cadence."""
    global _external_risks_refresh_in_progress
    with _external_risks_refresh_lock:
        if _external_risks_refresh_in_progress:
            return
        _external_risks_refresh_in_progress = True

    def run_all() -> None:
        global _external_risks_refresh_in_progress
        try:
            priority = [key for key in HIGH_REFRESH_SERVICES if key in SERVICE_REFRESH_INTERVALS]
            remaining = [key for key in SERVICE_REFRESH_INTERVALS if key not in priority]
            for group in (priority, remaining):
                futures = [_refresh_executor.submit(_refresh_one_service, key) for key in group]
                for future in futures:
                    try:
                        future.result(timeout=25)
                    except Exception:
                        pass
        finally:
            with _external_risks_refresh_lock:
                _external_risks_refresh_in_progress = False
            _broadcast_risk_update_from_thread({
                "type": "refresh_status",
                "updated_at": utc_timestamp(),
                "refresh": {"in_progress": _is_any_service_refreshing()},
            })

    Thread(target=run_all, daemon=True).start()


def get_external_risks_payload(refresh: bool = False, db: Session | None = None) -> dict:
    if refresh:
        trigger_external_risks_refresh(db=db)
    payload = _annotate_external_snapshot(_get_external_risks_snapshot())
    with _external_risks_refresh_lock:
        refresh_in_progress = _external_risks_refresh_in_progress
    payload["refresh"] = {
        **(payload.get("refresh") if isinstance(payload.get("refresh"), dict) else {}),
        "in_progress": refresh_in_progress or _is_any_service_refreshing(),
        "critical_services": list(CRITICAL_REFRESH_SERVICES),
        "high_services": list(HIGH_REFRESH_SERVICES),
    }
    return payload


@app.get("/external/isere/risks")
def isere_external_risks(
    refresh: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles(*READ_ROLES)),
):
    return get_external_risks_payload(refresh=refresh, db=db)


@app.post("/external/isere/risks/{service_key}/refresh")
def isere_refresh_one_service(
    service_key: str,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    """Force le rafraîchissement immédiat d'un seul service externe.
    La requête retourne immédiatement le snapshot actuel ;
    la mise à jour réelle arrive via SSE ou au prochain GET /external/isere/risks."""
    if service_key not in SERVICE_REFRESH_INTERVALS:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"Service inconnu : {service_key}")
    _refresh_executor.submit(_refresh_one_service, service_key)
    snapshot = _annotate_external_snapshot(_get_external_risks_snapshot())
    return {
        "service_key": service_key,
        "status": "queued",
        "current": snapshot.get(service_key, {}),
    }


@app.get("/external/isere/risks/status")
def external_risks_status(_: User = Depends(require_roles(*READ_ROLES))):
    snapshot = _annotate_external_snapshot(_get_external_risks_snapshot())
    with _sse_risk_clients_lock:
        sse_clients = len(_sse_risk_clients)
    try:
        snapshot_size_bytes = len(json.dumps(snapshot, default=str, ensure_ascii=False).encode("utf-8"))
    except Exception:
        snapshot_size_bytes = 0
    services = []
    for key, interval in SERVICE_REFRESH_INTERVALS.items():
        slot = snapshot.get(key) if isinstance(snapshot.get(key), dict) else {}
        meta = slot.get("meta") if isinstance(slot, dict) else {}
        services.append({
            "key": key,
            "status": slot.get("status") if isinstance(slot, dict) else "unknown",
            "updated_at": slot.get("updated_at") if isinstance(slot, dict) else None,
            "interval_seconds": interval,
            "meta": meta,
        })
    return {
        "updated_at": snapshot.get("updated_at"),
        "refreshing": _is_any_service_refreshing(),
        "sse_clients": sse_clients,
        "snapshot_size_bytes": snapshot_size_bytes,
        "services": services,
    }


@app.get("/api/sncf/isere/station-timetables")
def api_sncf_isere_station_timetables(
    refresh: bool = False,
    station_id: str | None = Query(None),
    _: User = Depends(require_roles(*READ_ROLES)),
):
    payload = fetch_sncf_isere_station_timetables(force_refresh=refresh)
    if station_id:
        wanted = station_id.strip().lower()
        stations = [
            station
            for station in payload.get("stations", [])
            if str(station.get("id") or "").lower() == wanted
        ]
        payload = {**payload, "stations": stations, "stations_total": len(stations)}
    return payload


@app.get("/operations/bootstrap")
def operations_bootstrap(
    refresh: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    """Charge en une seule requête toutes les données nécessaires à l'interface.
    Les 4 requêtes DB (communes, évènements, MCO, users) sont exécutées en parallèle
    avec des sessions indépendantes — SQLAlchemy n'est pas thread-safe sur une session."""
    started_at = datetime.utcnow()

    # Le bootstrap doit rester instantané: il lit le snapshot en mémoire et ne déclenche
    # jamais de rafraîchissement externe global depuis la navigation utilisateur.
    risks_payload = get_external_risks_payload(refresh=False, db=db)
    dashboard_payload = build_dashboard_payload(db, user, external_risks=risks_payload)

    # Requêtes DB parallèles — chaque tâche ouvre et ferme sa propre session.
    from concurrent.futures import ThreadPoolExecutor as _TPE

    user_role = user.role
    user_municipality_name = user.municipality_name

    def _fetch_municipalities() -> list:
        with SessionLocal() as s:
            if user_role == "mairie":
                if not user_municipality_name:
                    return []
                nm = user_municipality_name.strip().lower()
                return s.query(Municipality).filter(func.lower(Municipality.name) == nm).all()
            rows = s.query(Municipality).order_by(Municipality.name).all()
            s.expunge_all()
            return rows

    def _fetch_events() -> list:
        with SessionLocal() as s:
            q = s.query(IncidentEvent).order_by(IncidentEvent.created_at.desc())
            if user_role == "mairie":
                mun = s.query(Municipality).filter(
                    func.lower(Municipality.name) == (user_municipality_name or "").strip().lower()
                ).first()
                if mun is None:
                    return []
                q = q.filter(IncidentEvent.municipality_id == mun.id)
            rows = q.limit(300).all()
            s.expunge_all()
            return rows

    def _fetch_logs() -> list:
        with SessionLocal() as s:
            q = s.query(OperationalLog).order_by(OperationalLog.created_at.desc())
            if user_role == "mairie":
                mun = s.query(Municipality).filter(
                    func.lower(Municipality.name) == (user_municipality_name or "").strip().lower()
                ).first()
                if mun is None:
                    return []
                q = q.filter(OperationalLog.municipality_id == mun.id)
            rows = q.limit(200).all()
            s.expunge_all()
            return rows

    def _fetch_users() -> list:
        if user_role != "admin":
            return []
        with SessionLocal() as s:
            rows = s.query(User).order_by(User.created_at.desc()).all()
            s.expunge_all()
            return rows

    with _TPE(max_workers=4) as ex:
        f_muni  = ex.submit(_fetch_municipalities)
        f_evts  = ex.submit(_fetch_events)
        f_logs  = ex.submit(_fetch_logs)
        f_users = ex.submit(_fetch_users)
        municipalities_payload = f_muni.result()
        events_payload         = f_evts.result()
        logs_payload           = f_logs.result()
        users_payload          = f_users.result()

    duration_ms = int((datetime.utcnow() - started_at).total_seconds() * 1000)
    return {
        "updated_at": utc_timestamp(),
        "refresh": refresh,
        "perf": {
            "backend_duration_ms": duration_ms,
            "municipality_count": len(municipalities_payload),
            "event_count": len(events_payload),
            "log_count": len(logs_payload),
        },
        "dashboard": dashboard_payload,
        "external_risks": risks_payload,
        "municipalities": [MunicipalityOut.model_validate(item).model_dump() for item in municipalities_payload],
        "events": [IncidentEventOut.model_validate(item).model_dump() for item in events_payload],
        "logs": [OperationalLogOut.model_validate(item).model_dump() for item in logs_payload],
        "users": [UserOut.model_validate(item).model_dump() for item in users_payload],
    }


@app.get("/api/meteo-france/vigilance")
def interactive_map_meteo_vigilance():
    return fetch_meteo_france_isere()


@app.get("/api/vigicrues/geojson")
def interactive_map_vigicrues_geojson(
    refresh: bool = False,
    limit: int | None = None,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    safe_limit = None if limit is None else max(10, min(limit, 500))
    vigicrues = fetch_vigicrues_isere(station_limit=safe_limit, force_refresh=refresh)
    return vigicrues_geojson_from_stations(vigicrues.get("stations", []))


@app.get("/api/routes/estimate")
def interactive_map_route_estimate(
    start_lat: float = Query(..., ge=-90, le=90),
    start_lon: float = Query(..., ge=-180, le=180),
    end_lat: float = Query(..., ge=-90, le=90),
    end_lon: float = Query(..., ge=-180, le=180),
    _: User = Depends(require_roles(*READ_ROLES)),
):
    try:
        return fetch_route_estimate(start_lat, start_lon, end_lat, end_lon)
    except Exception as exc:
        raise HTTPException(502, f"Calcul trajet indisponible: {exc}") from exc


@app.get("/api/routes/isochrone")
def interactive_map_road_isochrone(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    mode: str = Query(..., pattern="^(isochrone|isodistance)$"),
    value: float = Query(..., gt=0),
    _: User = Depends(require_roles(*READ_ROLES)),
):
    try:
        return fetch_road_isochrone(lat, lon, mode, value)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"Calcul de zone routiere indisponible: {exc}") from exc


@app.get("/api/itinisere/events")
def interactive_map_itinisere_events(
    refresh: bool = False,
    limit: int = 60,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    safe_limit = max(10, min(limit, 120))
    return fetch_itinisere_disruptions(limit=safe_limit, force_refresh=refresh)


@app.get("/api/itinisere/webcams")
def interactive_map_itinisere_webcams(
    refresh: bool = False,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    return fetch_itinisere_webcams(force_refresh=refresh)


@app.get("/api/bison-fute/events")
def interactive_map_bison_fute_events(
    refresh: bool = False,
    limit: int = 120,
    categories: list[str] | None = Query(default=None),
    _: User = Depends(require_roles(*READ_ROLES)),
):
    safe_limit = max(1, min(limit, 250))
    normalized_categories = [str(item or "").strip().lower() for item in (categories or []) if str(item or "").strip()]
    return fetch_bison_fute_live_events(categories=normalized_categories, limit=safe_limit, force_refresh=refresh)

@app.get("/api/vigieau/alerts")
def interactive_map_vigieau_alerts(
    refresh: bool = False,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    return fetch_vigieau_restrictions(force_refresh=refresh)


@app.get("/api/institutions/isere")
def api_institutions_isere(
    refresh: bool = False,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    return fetch_institutions_isere(force_refresh=refresh)


@app.get("/api/forest-fire-map/isere")
def api_forest_fire_map_isere(
    refresh: bool = False,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    return fetch_forest_fire_map_isere(force_refresh=refresh)


@app.get("/api/hosting/isere/verified")
def api_verified_hosting_isere(
    refresh: bool = Query(False),
    limit: int = Query(2000, ge=1, le=5000),
    current_user: User = Depends(get_current_user),
):
    return fetch_verified_hosting_isere(force_refresh=refresh, limit=limit)


@app.get("/api/finess/isere/resources")
def interactive_map_finess_isere_resources(
    refresh: bool = False,
    limit: int = 5000,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    safe_limit = max(200, min(limit, 100000))
    return fetch_finess_isere_resources(force_refresh=refresh, limit=safe_limit)


@app.get("/api/geodae/isere/defibrillators")
def api_geodae_isere_defibrillators(
    refresh: bool = False,
    limit: int = 5000,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    safe_limit = max(100, min(limit, 20000))
    return fetch_geodae_isere_defibrillators(force_refresh=refresh, limit=safe_limit)


@app.get("/api/osm/isere/pr-autoroutes")
def api_pr_autoroutes(
    refresh: bool = False,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    """Positions des PR des autoroutes isèroises depuis le bornage officiel RRN, avec fallback OSM."""
    return fetch_pr_autoroutes(force_refresh=refresh)


@app.get("/api/hubeau/isere/groundwater")
def interactive_map_hubeau_groundwater(
    refresh: bool = False,
    station_limit: int = 8,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    safe_limit = max(3, min(station_limit, 20))
    return fetch_hubeau_isere_groundwater(force_refresh=refresh, station_limit=safe_limit)


@app.get("/api/rnb/buildings")
def api_rnb_buildings(
    min_lat: float = Query(...),
    min_lon: float = Query(...),
    max_lat: float = Query(...),
    max_lon: float = Query(...),
    refresh: bool = Query(False),
    limit: int = Query(10000, ge=20, le=50000),
    _: User = Depends(require_roles(*READ_ROLES)),
):
    return fetch_rnb_buildings_bbox(
        min_lat=min_lat,
        min_lon=min_lon,
        max_lat=max_lat,
        max_lon=max_lon,
        force_refresh=refresh,
        limit=limit,
    )


@app.get("/api/opendata/isere/resilience")
def opendata_isere_resilience(
    refresh: bool = Query(False),
    limit: int = Query(80, ge=20, le=200),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    return fetch_isere_opendata_resilience(force_refresh=refresh, limit=limit)


@app.get("/supervision/overview")
def supervision_overview(
    refresh: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles(*READ_ROLES)),
):
    risks_payload = get_external_risks_payload(refresh=refresh, db=db)
    meteo = risks_payload.get("meteo_france") or {}
    vigicrues = risks_payload.get("vigicrues") or {}
    itinisere = risks_payload.get("itinisere") or {}
    bison_fute = risks_payload.get("bison_fute") or {}
    georisques = risks_payload.get("georisques") or {}
    prefecture = risks_payload.get("prefecture_isere") or {}
    dauphine = risks_payload.get("dauphine_isere") or {}
    crisis = db.query(Municipality).filter(Municipality.crisis_mode.is_(True)).all()
    latest_logs = db.query(OperationalLog).order_by(OperationalLog.created_at.desc()).limit(10).all()
    return {
        "updated_at": utc_timestamp(),
        "alerts": {
            "meteo": meteo,
            "vigicrues": vigicrues,
            "vigieau": risks_payload.get("vigieau") or {},
            "itinisere": itinisere,
            "bison_fute": bison_fute,
            "georisques": georisques,
            "prefecture_isere": prefecture,
            "dauphine_isere": dauphine,
            "anfr_isere": risks_payload.get("anfr_isere") or {},
            "arcep_isere": risks_payload.get("arcep_isere") or {},
            "groundwater_isere": risks_payload.get("groundwater_isere") or {},
            "isere_opendata": risks_payload.get("isere_opendata") or {},
        },
        "crisis_municipalities": [MunicipalityOut.model_validate(c).model_dump() for c in crisis],
        "timeline": [OperationalLogOut.model_validate(log).model_dump() for log in latest_logs],
    }


@app.post("/municipalities", response_model=MunicipalityOut)
def create_municipality(data: MunicipalityCreate, db: Session = Depends(get_db), _: User = Depends(require_roles(*EDIT_ROLES))):
    payload = data.model_dump()
    if not payload.get("insee_code"):
        payload["insee_code"] = resolve_commune_insee_code(payload.get("name", ""), payload.get("postal_code"))
    municipality = Municipality(**payload)
    db.add(municipality)
    db.commit()
    db.refresh(municipality)
    return municipality


@app.get("/municipalities", response_model=list[MunicipalityOut])
def list_municipalities(db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    if user.role == "mairie":
        if not user.municipality_name:
            return []
        normalized_name = user.municipality_name.strip().lower()
        return db.query(Municipality).filter(func.lower(Municipality.name) == normalized_name).all()
    return db.query(Municipality).order_by(Municipality.name).all()


@app.patch("/municipalities/{municipality_id}", response_model=MunicipalityOut)
def update_municipality(
    municipality_id: int,
    data: MunicipalityUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles(*EDIT_ROLES)),
):
    municipality = db.get(Municipality, municipality_id)
    if not municipality:
        raise HTTPException(404, "Commune introuvable")

    changes = data.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(municipality, key, value)

    if ("insee_code" in changes and not municipality.insee_code) or ("name" in changes or "postal_code" in changes):
        municipality.insee_code = resolve_commune_insee_code(municipality.name, municipality.postal_code)

    db.commit()
    db.refresh(municipality)
    return municipality


@app.get("/municipalities/{municipality_id}/georisques-risks")
def municipality_georisques_risks(
    municipality_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    municipality = ensure_municipality_scope(user, db, municipality_id)
    insee_code = (municipality.insee_code or "").strip()
    if not insee_code:
        insee_code = resolve_commune_insee_code(municipality.name, municipality.postal_code)
        if insee_code:
            municipality.insee_code = insee_code
            db.commit()

    if not insee_code:
        return {"municipality_id": municipality_id, "name": municipality.name, "code_insee": None, "risks": [], "danger_level": "Faible"}

    payload = fetch_georisques_commune_risks([insee_code])
    entry = (payload.get("communes") or [{}])[0]
    return {
        "municipality_id": municipality_id,
        "name": municipality.name,
        "code_insee": insee_code,
        "risks": entry.get("risks", []),
        "risk_total": entry.get("risk_total", 0),
        "danger_level": entry.get("danger_level", "Faible"),
        "updated_at": payload.get("updated_at"),
    }


@app.get("/municipalities/{municipality_id}/public-services")
def municipality_public_services(
    municipality_id: int,
    force_refresh: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    municipality = ensure_municipality_scope(user, db, municipality_id)
    insee_code = (municipality.insee_code or "").strip()
    if not insee_code:
        insee_code = resolve_commune_insee_code(municipality.name, municipality.postal_code)
        if insee_code:
            municipality.insee_code = insee_code
            db.commit()
    return fetch_municipality_public_services(
        municipality.name,
        insee_code=insee_code,
        postal_code=municipality.postal_code,
        force_refresh=force_refresh,
    )


@app.get("/contacts/search")
def search_public_contacts(
    city: str = Query(..., min_length=2, max_length=120),
    force_refresh: bool = Query(False),
    _: User = Depends(require_roles(*READ_ROLES)),
):
    safe_city = str(city or "").strip()
    insee_code = resolve_commune_insee_code(safe_city, departement="38")
    if insee_code:
        return fetch_municipality_public_services(
            safe_city,
            insee_code=insee_code,
            force_refresh=force_refresh,
        )
    return fetch_isere_public_services_by_city(safe_city, force_refresh=force_refresh)


@app.get("/municipalities/{municipality_id}/water-quality")
def municipality_water_quality(
    municipality_id: int,
    force_refresh: bool = Query(False),
    limit: int = Query(40, ge=10, le=200),
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    municipality = ensure_municipality_scope(user, db, municipality_id)
    insee_code = (municipality.insee_code or "").strip()
    if not insee_code:
        insee_code = resolve_commune_insee_code(municipality.name, municipality.postal_code)
        if insee_code:
            municipality.insee_code = insee_code
            db.commit()
    return fetch_hubeau_water_quality(
        insee_code,
        commune_name=municipality.name,
        force_refresh=force_refresh,
        limit=limit,
    )


@app.get("/municipalities/{municipality_id}/water-services")
def municipality_water_services(
    municipality_id: int,
    force_refresh: bool = Query(False),
    limit: int = Query(60, ge=10, le=200),
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    municipality = ensure_municipality_scope(user, db, municipality_id)
    insee_code = (municipality.insee_code or "").strip()
    if not insee_code:
        insee_code = resolve_commune_insee_code(municipality.name, municipality.postal_code)
        if insee_code:
            municipality.insee_code = insee_code
            db.commit()
    return fetch_hubeau_water_services(
        insee_code,
        commune_name=municipality.name,
        force_refresh=force_refresh,
        limit=limit,
    )


@app.get("/municipalities/{municipality_id}/files", response_model=list[MunicipalityDocumentOut])
def list_municipality_files(
    municipality_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    ensure_municipality_scope(user, db, municipality_id)
    docs = db.query(MunicipalityDocument).filter(MunicipalityDocument.municipality_id == municipality_id).order_by(MunicipalityDocument.created_at.desc()).all()
    uploader_ids = {doc.uploaded_by_id for doc in docs}
    uploaders = {
        user_id: username
        for user_id, username in db.query(User.id, User.username).filter(User.id.in_(uploader_ids)).all()
    } if uploader_ids else {}

    return [
        MunicipalityDocumentOut(
            id=doc.id,
            municipality_id=doc.municipality_id,
            doc_type=doc.doc_type,
            title=doc.title,
            filename=Path(doc.file_path).name,
            uploaded_by=uploaders.get(doc.uploaded_by_id, "inconnu"),
            created_at=doc.created_at,
        )
        for doc in docs
    ]


@app.post("/municipalities/{municipality_id}/files", response_model=MunicipalityDocumentOut)
def upload_municipality_file(
    municipality_id: int,
    file: UploadFile = File(...),
    title: str = Form(...),
    doc_type: str = Form("annexe"),
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "ope")),
):
    ensure_municipality_scope(user, db, municipality_id)

    safe_name = sanitize_upload_filename(file.filename)
    ensure_allowed_extension(safe_name)
    safe_title = title.strip() or safe_name
    safe_doc_type = re.sub(r"[^a-z0-9_-]", "", doc_type.lower()) or "annexe"

    base_dir = Path(settings.upload_dir) / "municipality-files" / str(municipality_id)
    base_dir.mkdir(parents=True, exist_ok=True)
    final_path = base_dir / f"{datetime.utcnow().strftime('%Y%m%d%H%M%S')}_{safe_name}"
    final_path.write_bytes(file.file.read())

    record = MunicipalityDocument(
        municipality_id=municipality_id,
        doc_type=safe_doc_type,
        title=safe_title[:160],
        file_path=str(final_path),
        uploaded_by_id=user.id,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return serialize_document(record, db)


@app.get("/municipalities/{municipality_id}/files/{file_id}")
def get_municipality_file(
    municipality_id: int,
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    ensure_municipality_scope(user, db, municipality_id)
    record = db.get(MunicipalityDocument, file_id)
    if not record or record.municipality_id != municipality_id:
        raise HTTPException(404, "Fichier introuvable")

    file_path = Path(record.file_path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "Fichier introuvable")
    return FileResponse(path=file_path, filename=file_path.name)


@app.delete("/municipalities/{municipality_id}/files/{file_id}")
def delete_municipality_file(
    municipality_id: int,
    file_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "ope")),
):
    ensure_municipality_scope(user, db, municipality_id)
    record = db.get(MunicipalityDocument, file_id)
    if not record or record.municipality_id != municipality_id:
        raise HTTPException(404, "Fichier introuvable")

    file_path = Path(record.file_path)
    if file_path.exists() and file_path.is_file():
        file_path.unlink()

    db.delete(record)
    db.commit()
    return {"status": "deleted", "id": file_id}


@app.post("/municipalities/{municipality_id}/crisis")
def toggle_crisis(municipality_id: int, db: Session = Depends(get_db), _: User = Depends(require_roles(*EDIT_ROLES))):
    municipality = db.get(Municipality, municipality_id)
    if not municipality:
        raise HTTPException(404, "Commune introuvable")
    municipality.crisis_mode = not municipality.crisis_mode
    db.commit()
    return {"id": municipality_id, "crisis_mode": municipality.crisis_mode}


@app.delete("/municipalities/{municipality_id}")
def delete_municipality(
    municipality_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles(*EDIT_ROLES)),
):
    municipality = db.get(Municipality, municipality_id)
    if not municipality:
        raise HTTPException(404, "Commune introuvable")
    db.delete(municipality)
    db.commit()
    return {"status": "deleted", "id": municipality_id}


@app.post("/events", response_model=IncidentEventOut)
def create_event(data: IncidentEventCreate, db: Session = Depends(get_db), user: User = Depends(require_roles(*EDIT_ROLES))):
    payload = data.model_dump()
    municipality_id = payload.get("municipality_id")
    if municipality_id:
        municipality = db.get(Municipality, municipality_id)
        if not municipality:
            raise HTTPException(404, "Commune introuvable")
    event = IncidentEvent(**payload, created_by_id=user.id)
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


@app.patch("/events/{event_id}", response_model=IncidentEventOut)
def update_event(
    event_id: int,
    data: IncidentEventUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*EDIT_ROLES)),
):
    event = db.get(IncidentEvent, event_id)
    if not event:
        raise HTTPException(404, "Évènement introuvable")
    changes = {
        field: value
        for field, value in data.model_dump(exclude_unset=True).items()
        if value is not None
    }
    if not changes:
        raise HTTPException(422, "Aucune modification fournie")
    for field, value in changes.items():
        setattr(event, field, value)
    db.commit()
    db.refresh(event)
    return event


@app.delete("/events/{event_id}")
def delete_event(
    event_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*EDIT_ROLES)),
):
    event = db.get(IncidentEvent, event_id)
    if not event:
        raise HTTPException(404, "Évènement introuvable")
    db.query(OperationalLog).filter(OperationalLog.event_id == event_id).delete(synchronize_session=False)
    db.delete(event)
    db.commit()
    return {"status": "deleted", "id": event_id}


@app.get("/events", response_model=list[IncidentEventOut])
def list_events(db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    query = db.query(IncidentEvent).order_by(IncidentEvent.created_at.desc())
    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None:
            return []
        query = query.filter(IncidentEvent.municipality_id == municipality_id)
    return query.limit(300).all()


@app.post("/logs", response_model=OperationalLogOut)
def create_log(data: OperationalLogCreate, db: Session = Depends(get_db), user: User = Depends(require_roles(*EDIT_ROLES))):
    payload = data.model_dump()
    payload["event_time"] = payload.get("event_time") or datetime.utcnow()
    target_scope = payload.get("target_scope", "departemental")
    municipality_id = payload.get("municipality_id")
    linked_municipality = None
    event_id = payload.get("event_id")

    event = db.get(IncidentEvent, event_id) if event_id else None

    if target_scope in {"commune", "pcs"} and municipality_id:
        municipality = db.get(Municipality, municipality_id)
        if not municipality:
            raise HTTPException(404, "Commune introuvable")
        if target_scope == "pcs" and not municipality.pcs_active:
            raise HTTPException(400, "La commune sélectionnée n'a pas de PCS actif")
        linked_municipality = municipality
    elif target_scope not in {"commune", "pcs"}:
        payload["municipality_id"] = None

    if event and event.municipality_id and payload.get("municipality_id") and event.municipality_id != payload.get("municipality_id"):
        raise HTTPException(400, "La commune de la main courante doit correspondre à la commune de l'évènement")

    if event and not payload.get("municipality_id") and event.municipality_id:
        payload["municipality_id"] = event.municipality_id

    payload["event_type"] = payload.get("event_type") or "MCO"
    payload["description"] = payload.get("description") or ""
    entry = OperationalLog(**payload, created_by_id=user.id)
    db.add(entry)

    if linked_municipality:
        summary_date = payload["event_time"].strftime("%d/%m/%Y %H:%M")
        summary = f"[MCO {summary_date}] {payload.get('event_type', 'MCO')} · {payload.get('description', '')}".strip()
        previous_info = (linked_municipality.additional_info or "").strip()
        linked_municipality.additional_info = f"{summary}\n{previous_info}" if previous_info else summary

    db.commit()
    db.refresh(entry)
    return entry


@app.patch("/logs/{log_id}", response_model=OperationalLogOut)
def update_log_status(
    log_id: int,
    data: OperationalLogStatusUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*EDIT_ROLES)),
):
    entry = db.get(OperationalLog, log_id)
    if not entry:
        raise HTTPException(404, "Entrée introuvable")
    entry.status = data.status
    db.commit()
    db.refresh(entry)
    return entry


@app.delete("/logs/{log_id}")
def delete_log(
    log_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*EDIT_ROLES)),
):
    entry = db.get(OperationalLog, log_id)
    if not entry:
        raise HTTPException(404, "Entrée introuvable")
    db.delete(entry)
    db.commit()
    return {"status": "deleted", "id": log_id}


@app.put("/logs/{log_id}", response_model=OperationalLogOut)
def update_log(
    log_id: int,
    data: OperationalLogUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*EDIT_ROLES)),
):
    entry = db.get(OperationalLog, log_id)
    if not entry:
        raise HTTPException(404, "Entrée introuvable")

    event = db.get(IncidentEvent, entry.event_id) if entry.event_id else None
    payload = data.model_dump()
    target_scope = payload.get("target_scope", "departemental")
    municipality_id = payload.get("municipality_id")

    if target_scope in {"commune", "pcs"} and municipality_id:
        municipality = db.get(Municipality, municipality_id)
        if not municipality:
            raise HTTPException(404, "Commune introuvable")
        if target_scope == "pcs" and not municipality.pcs_active:
            raise HTTPException(400, "La commune sélectionnée n'a pas de PCS actif")
    elif target_scope not in {"commune", "pcs"}:
        payload["municipality_id"] = None

    if event and event.municipality_id and payload.get("municipality_id") and event.municipality_id != payload.get("municipality_id"):
        raise HTTPException(400, "La commune de la main courante doit correspondre à la commune de l'évènement")

    if event and not payload.get("municipality_id") and event.municipality_id:
        payload["municipality_id"] = event.municipality_id

    payload["event_type"] = payload.get("event_type") or "MCO"
    payload["description"] = payload.get("description") or ""
    payload["event_time"] = payload.get("event_time") or entry.event_time

    for key, value in payload.items():
        setattr(entry, key, value)

    db.commit()
    db.refresh(entry)
    return entry


@app.get("/logs", response_model=list[OperationalLogOut])
def list_logs(db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    query = db.query(OperationalLog).order_by(OperationalLog.created_at.desc())
    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None:
            return []
        query = query.filter(OperationalLog.municipality_id == municipality_id)
    return query.limit(200).all()


@app.get("/logs/export/csv")
def export_logs_csv(db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    query = db.query(OperationalLog).order_by(OperationalLog.created_at.desc())
    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None:
            raise HTTPException(404, "Commune introuvable")
        query = query.filter(OperationalLog.municipality_id == municipality_id)

    rows = query.limit(1000).all()

    import csv
    import io

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "id", "event_id", "event_time", "created_at", "event_type", "status", "danger_level", "target_scope",
        "municipality_id", "location", "source", "assigned_to", "tags", "description", "actions_taken", "next_update_due",
    ])
    for row in rows:
        writer.writerow([
            row.id, row.event_id, row.event_time, row.created_at, row.event_type, row.status, row.danger_level, row.target_scope,
            row.municipality_id, row.location, row.source, row.assigned_to, row.tags, row.description, row.actions_taken, row.next_update_due,
        ])

    output.seek(0)
    filename = f"main-courante-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ─────────────────────────────────────────────────────────────────────────────
# NOTIFICATIONS DISCORD (Webhook)
# ─────────────────────────────────────────────────────────────────────────────

_NOTIF_SETTINGS_KEY = "notif:settings"   # ancien format (migration)
_NOTIF_RULES_KEY = "notif:rules"          # nouveau format : list de règles
_NOTIF_LAST_KEY_PREFIX = "notif:last:"
_NOTIF_LOG_KEY = "notif:log"
_NOTIF_MAX_LOG = 50

_LEVEL_ORDER: dict[str, int] = {"vert": 0, "jaune": 1, "orange": 2, "rouge": 3}

# Mapping service → libellé lisible
_SERVICE_LABELS: dict[str, str] = {
    "meteo_france": "Météo-France",
    "apic_isere": "APIC · Pluie intense",
    "vigicrues": "Vigicrues",
    "vigicrues_flash_isere": "Vigicrues Flash",
    "vigieau": "Vigieau · Restrictions eau",
    "atmo_aura": "Atmo AURA · Qualité air",
    "georisques": "Géorisques",
    "itinisere": "Itinisère · Transports",
    "autoroutes_isere": "Autoroutes Isère",  # ancienne clé, conservée pour les règles existantes
    "sncf_isere": "SNCF Isère",
    "ter_aura": "TER SNCF · AURA",
    "mreseau": "M Réseau · Grenoble",
    "aprr_isere": "APRR/AREA · Autoroutes",
    "vinci_autoroutes": "Vinci Autoroutes",
    "cars_region_aura": "Cars Région · AURA",
    "prefecture_isere": "Préfecture Isère",
    "france_bleu_isere": "France Bleu Isère",
    "bison_fute": "Bison Futé",
}


def _extract_service_level(key: str, data: dict) -> str:
    """Retourne le niveau d'alerte normalisé (vert/jaune/orange/rouge) pour un service."""
    if not data or data.get("status") in ("pending", "unavailable"):
        return "vert"

    # Météo / vigilance
    if key == "meteo_france":
        return str(data.get("level") or "vert").lower()
    if key == "apic_isere":
        return "jaune" if (data.get("alerts_total") or 0) > 0 else "vert"
    if key == "vigicrues":
        raw = str(data.get("water_alert_level") or "vert").lower()
        return raw if raw in _LEVEL_ORDER else "vert"
    if key == "vigicrues_flash_isere":
        n = int(data.get("alerts_total") or 0)
        return "orange" if n > 0 else "vert"
    if key == "vigieau":
        return "jaune" if len(data.get("alerts") or []) > 0 else "vert"
    if key == "atmo_aura":
        # Utilise le level calculé par services.py (échelle 1-6 : 5-6=rouge, 4=orange, 3=jaune, 1-2=vert)
        lvl = str((data.get("today") or {}).get("level") or "vert").lower()
        return lvl if lvl in _LEVEL_ORDER else "vert"

    # Transport
    if key in ("ter_aura", "mreseau", "cars_region_aura"):
        n = int(data.get("disruptions_total") or len(data.get("disruptions") or []))
        return "jaune" if n > 0 else "vert"
    if key in ("aprr_isere", "vinci_autoroutes", "autoroutes_isere", "itinisere"):
        n = int(data.get("events_total") or len(data.get("events") or []))
        if n == 0:
            return "vert"
        # Prendre le pire niveau parmi les événements
        worst = "jaune"
        for evt in (data.get("events") or [])[:10]:
            lvl = str(evt.get("level") or evt.get("severity") or "jaune").lower()
            if _LEVEL_ORDER.get(lvl, 1) > _LEVEL_ORDER.get(worst, 1):
                worst = lvl
        return worst
    if key == "sncf_isere":
        return "jaune" if len(data.get("alerts") or []) > 0 else "vert"
    if key == "feux_foret_isere":
        n = int(data.get("fires_total") or data.get("recent_incidents_2d_total") or 0)
        return "orange" if n > 5 else "jaune" if n > 0 else "vert"

    # Fallback générique
    raw = str(data.get("level") or data.get("alert_level") or "vert").lower()
    return raw if raw in _LEVEL_ORDER else "vert"


def _latest_news_fingerprint(data: dict) -> tuple[str | None, dict | None]:
    """Retourne une signature stable de la dernière actualité d'un flux presse/RSS."""
    items = data.get("items") or data.get("articles") or []
    if not items:
        return None, None
    latest = items[0] if isinstance(items[0], dict) else {}
    title = str(latest.get("title") or latest.get("headline") or "").strip()
    link = str(latest.get("link") or latest.get("url") or "").strip()
    published = str(latest.get("published_at") or latest.get("date") or latest.get("pubDate") or "").strip()
    fingerprint = "|".join(part for part in (link, published, title) if part)
    return (fingerprint or None), latest


def _latest_feux_foret_fingerprint(data: dict) -> tuple[str | None, dict | None]:
    """Retourne une signature stable du dernier signalement FeuxDeForet.fr."""
    items = data.get("recent_incidents_2d") or data.get("recent_incidents") or []
    if not items:
        return None, None
    latest = items[0] if isinstance(items[0], dict) else {}
    title = str(latest.get("title") or latest.get("commune") or "").strip()
    link = str(latest.get("link") or latest.get("url") or "").strip()
    incident_id = str(latest.get("id") or latest.get("incident_id") or "").strip()
    commune = str(latest.get("commune") or "").strip()
    # Ne jamais inclure "il y a X heures" : cette valeur change à chaque
    # collecte alors que le signalement reste strictement identique.
    fingerprint = "|".join(part for part in (incident_id, link, title, commune) if part)
    return (fingerprint or None), latest


_NOTIF_VOLATILE_FIELDS = {
    "checked_at", "fetched_at", "last_checked_at", "last_refresh_at",
    "observed_at", "refreshed_at", "retrieved_at", "updated_at",
    "elapsed_ms", "latency_ms", "meta", "status",
}


def _notification_content_fingerprint(data: dict, service_key: str = "") -> str:
    """Return a stable business-content signature, excluding refresh metadata.

    VigiEau is deliberately reduced to the actual restrictions.  Transport
    details (API URL, availability status or error wording) must not trigger a
    new water-restriction notification.
    """
    def _stable(value):
        if isinstance(value, dict):
            return {
                str(key): _stable(item)
                for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
                if str(key).lower() not in _NOTIF_VOLATILE_FIELDS
            }
        if isinstance(value, (list, tuple, set)):
            items = [_stable(item) for item in value]
            return sorted(
                items,
                key=lambda item: json.dumps(item, ensure_ascii=False, sort_keys=True, default=str),
            )
        return value

    fingerprint_data: Any = data
    if service_key == "vigieau":
        alerts = data.get("alerts") if isinstance(data, dict) else []
        fingerprint_data = {
            "alerts": [
                {
                    "zone": alert.get("zone") or "",
                    "level": alert.get("level") or "",
                    "measure": alert.get("measure") or "",
                    "start_date": alert.get("start_date") or "",
                    "end_date": alert.get("end_date") or "",
                }
                for alert in (alerts or [])
                if isinstance(alert, dict)
            ],
            "max_level": data.get("max_level") or "vert",
        }

    canonical = json.dumps(
        _stable(fingerprint_data),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _build_discord_embed(service_key: str, level: str, data: dict, reason: str = "") -> dict:
    """Construit le payload Discord (embed riche) pour une alerte."""
    label = _SERVICE_LABELS.get(service_key, service_key)
    emoji = {"rouge": "🔴", "orange": "🟠", "jaune": "🟡", "vert": "🟢"}.get(level, "ℹ️")
    color = {"rouge": 0xC0392B, "orange": 0xE67E22, "jaune": 0xF1C40F, "vert": 0x27AE60}.get(level, 0x95A5A6)
    now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")  # format ISO pour Discord timestamp

    def _f(name: str, value: str, inline: bool = True) -> dict:
        return {"name": name, "value": value[:1024] or "–", "inline": inline}

    def _trunc(s: str, n: int = 80) -> str:
        s = str(s or "").strip()
        return s[:n] + "…" if len(s) > n else s

    def _value(item: dict, *keys: str) -> str:
        """Retourne la première valeur exploitable parmi plusieurs variantes de schéma."""
        for key in keys:
            value = item.get(key)
            if isinstance(value, (list, tuple)):
                value = ", ".join(str(part) for part in value if part not in (None, ""))
            if value not in (None, "", []):
                return str(value).strip()
        return ""

    def _detail_line(item: dict, *, title_keys: tuple[str, ...], icon: str = "•") -> str:
        """Formate une alerte avec les informations opérationnelles disponibles."""
        title = _trunc(_value(item, *title_keys) or "Alerte sans titre", 120)
        meta = []
        location = _value(item, "commune", "zone", "location", "area", "department")
        axis = _value(item, "road", "axis", "axes", "line", "route", "river")
        kind = _value(item, "type", "category", "cause", "severity_raw")
        alert_level = _value(item, "level", "severity", "level_color")
        if location and location.lower() not in title.lower():
            meta.append(f"📍 {location}")
        if axis and axis.lower() not in title.lower():
            meta.append(f"🧭 {axis}")
        if kind:
            meta.append(f"Nature : {kind}")
        if alert_level:
            meta.append(f"Niveau : **{alert_level.upper()}**")

        period_start = _value(item, "valid_from", "start_at", "started_at", "published_at", "date")
        period_end = _value(item, "valid_until", "end_at", "ended_at")
        if period_start or period_end:
            meta.append(f"🕒 {period_start or '?'}{(' → ' + period_end) if period_end else ''}")

        description_text = _value(item, "description", "message", "detail", "measure", "restriction", "impact")
        link = _value(item, "link", "url", "source_url")
        parts = [f"{icon} **{title}**"]
        if meta:
            parts.append("  " + " · ".join(meta))
        if description_text and description_text.lower() != title.lower():
            parts.append("  " + _trunc(description_text, 240))
        if link.startswith("http"):
            parts.append(f"  [Consulter le détail]({link[:300]})")
        return "\n".join(parts)

    fields: list[dict] = []
    description = f"**Niveau : {level.upper()}**"
    if reason:
        desc_map = {
            "nouvelle alerte": "🆕 Nouvelle alerte déclenchée",
            "nouvelle actualité": "🆕 Nouvelle actualité détectée",
            "nouveau feu": "🆕 Nouveau feu détecté en Isère",
            "retour alerte après retour au vert": "🔁 Alerte réapparue après retour au vert",
        }
        desc_reason = desc_map.get(reason) or f"📢 {reason.capitalize()}"
        description += f"\n{desc_reason}"

    # ── Météo-France ──────────────────────────────────────────────────────────
    if service_key == "meteo_france":
        current = data.get("current_alerts") or data.get("alerts") or []
        tomorrow = data.get("tomorrow_alerts") or []
        if current:
            lines = []
            for a in current[:6]:
                ph = str(a.get("phenomenon") or a.get("title") or "?")
                lv = str(a.get("level") or "?")
                details = a.get("details") or []
                if isinstance(details, str):
                    details = [details]
                detail = "; ".join(str(value) for value in details if value)
                lines.append(f"• **{ph}** — **{lv.upper()}**{(chr(10) + '  ' + _trunc(detail, 220)) if detail else ''}")
            fields.append(_f("⚠️ Alertes J0 (en cours)", "\n".join(lines), inline=False))
        if tomorrow:
            lines2 = []
            for a in tomorrow[:4]:
                ph = str(a.get("phenomenon") or a.get("title") or "?")
                lv = str(a.get("level") or "?")
                details = a.get("details") or []
                if isinstance(details, str):
                    details = [details]
                detail = "; ".join(str(value) for value in details if value)
                lines2.append(f"• **{ph}** — **{lv.upper()}**{(chr(10) + '  ' + _trunc(detail, 180)) if detail else ''}")
            fields.append(_f("📅 Alertes J1 (demain)", "\n".join(lines2), inline=False))
        if data.get("bulletin_title"):
            fields.append(_f("📋 Bulletin", _trunc(data["bulletin_title"], 150), inline=False))

    # ── Vigicrues ─────────────────────────────────────────────────────────────
    elif service_key == "vigicrues":
        minimum_rank = max(1, _LEVEL_ORDER.get(level, 1))
        alert_stations = [s for s in (data.get("stations") or []) if _LEVEL_ORDER.get(str(s.get("level") or "vert").lower(), 0) >= minimum_rank]
        troncons = [t for t in (data.get("troncons") or data.get("alerts") or []) if _LEVEL_ORDER.get(str(t.get("level") or "vert").lower(), 0) >= minimum_rank]
        if alert_stations:
            lines = []
            for s in alert_stations[:6]:
                lv = str(s.get("level") or "?")
                h = s.get("height_m") or s.get("current_level_m") or "?"
                trend = _value(s, "trend", "tendance")
                updated = _value(s, "observed_at", "updated_at", "date")
                lines.append(f"• **{s.get('station') or s.get('name') or s.get('code', '?')}** ({s.get('river','')}) — **{lv.upper()}** — {h} m{(' · tendance ' + trend) if trend else ''}{(chr(10) + '  Mesure : ' + updated) if updated else ''}")
            fields.append(_f(f"🌊 Stations en alerte ({len(alert_stations)})", "\n".join(lines), inline=False))
        if troncons:
            lines2 = [f"• **{t.get('name') or t.get('code','?')}** — {t.get('level','?')}" for t in troncons[:4]]
            fields.append(_f("🗺️ Tronçons concernés", "\n".join(lines2), inline=False))

    # ── Vigicrues Flash ───────────────────────────────────────────────────────
    elif service_key == "vigicrues_flash_isere":
        alerts = data.get("alerts") or []
        total = int(data.get("alerts_total") or len(alerts))
        fields.append(_f("⚡ Crues rapides", f"{total} avertissement(s)", inline=True))
        if alerts:
            lines = [_detail_line(a, title_keys=("zone", "commune", "title"), icon="•") for a in alerts[:5]]
            fields.append(_f("📍 Zones concernées", "\n".join(lines), inline=False))

    # ── APIC ─────────────────────────────────────────────────────────────────
    elif service_key == "apic_isere":
        alerts = data.get("alerts") or []
        total = int(data.get("alerts_total") or len(alerts))
        fields.append(_f("🌧️ Pluie intense", f"{total} avertissement(s)", inline=True))
        if alerts:
            lines = [_detail_line(a, title_keys=("zone", "commune", "title"), icon="•") for a in alerts[:5]]
            fields.append(_f("📍 Communes concernées", "\n".join(lines), inline=False))

    # ── Itinisère / Transports ────────────────────────────────────────────────
    elif service_key == "itinisere":
        events = data.get("events") or []
        total = int(data.get("events_total") or len(events))
        fields.append(_f("🚌 Perturbations", str(total), inline=True))
        if events:
            lines = []
            for e in events[:5]:
                lines.append(_detail_line(e, title_keys=("title", "description")))
            fields.append(_f("📋 Détail", "\n".join(lines), inline=False))

    # ── SNCF ──────────────────────────────────────────────────────────────────
    elif service_key == "sncf_isere":
        alerts = data.get("alerts") or []
        total = int(data.get("alerts_total") or len(alerts))
        fields.append(_f("🚆 Alertes voie ferrée", str(total), inline=True))
        if alerts:
            lines = []
            for a in alerts[:5]:
                lines.append(_detail_line(a, title_keys=("title", "description")))
            fields.append(_f("📋 Alertes", "\n".join(lines), inline=False))

    # ── TER AURA / M Réseau / Cars Région ────────────────────────────────────
    elif service_key in ("ter_aura", "mreseau", "cars_region_aura"):
        disruptions = data.get("disruptions") or []
        total = int(data.get("disruptions_total") or len(disruptions))
        icon = {"ter_aura": "🚄", "mreseau": "🚊", "cars_region_aura": "🚐"}.get(service_key, "🚌")
        fields.append(_f(f"{icon} Perturbations", str(total), inline=True))
        if data.get("normal_service") is False or total > 0:
            fields.append(_f("🔴 Service", "Perturbé" if total > 0 else "Normal", inline=True))
        if disruptions:
            lines = []
            for d in disruptions[:5]:
                lines.append(_detail_line(d, title_keys=("title", "description")))
            fields.append(_f("📋 Perturbations", "\n".join(lines), inline=False))

    # ── APRR / Vinci Autoroutes ───────────────────────────────────────────────
    elif service_key in ("aprr_isere", "vinci_autoroutes", "autoroutes_isere"):
        events = data.get("events") or []
        total = int(data.get("events_total") or len(events))
        routes = ", ".join(data.get("routes") or [])
        fields.append(_f("🛣️ Événements", str(total), inline=True))
        if routes:
            fields.append(_f("🗺️ Axes", routes, inline=True))
        if events:
            lines = []
            for e in events[:5]:
                lines.append(_detail_line(e, title_keys=("title", "description", "type")))
            fields.append(_f("📋 Événements", "\n".join(lines), inline=False))

    # ── Bison Futé ────────────────────────────────────────────────────────────
    elif service_key == "bison_fute":
        isere = (data.get("today") or {}).get("isere") or {}
        dep = str(isere.get("departure") or "?")
        ret = str(isere.get("return") or "?")
        fields.append(_f("🚗 Départ Isère J0", dep, inline=True))
        fields.append(_f("🏠 Retour Isère J0", ret, inline=True))
        isere_j1 = (data.get("tomorrow") or {}).get("isere") or {}
        if isere_j1:
            fields.append(_f("📅 J1 Départ/Retour", f"{isere_j1.get('departure','?')} / {isere_j1.get('return','?')}", inline=True))

    # ── Vigieau ───────────────────────────────────────────────────────────────
    elif service_key == "vigieau":
        alerts = data.get("alerts") or []
        fields.append(_f("💧 Restrictions eau", str(len(alerts)), inline=True))
        if alerts:
            lines = []
            for a in alerts[:5]:
                lines.append(_detail_line(a, title_keys=("zone", "department")))
            fields.append(_f("📋 Restrictions", "\n".join(lines), inline=False))

    # ── Qualité de l'air ──────────────────────────────────────────────────────
    elif service_key == "atmo_aura":
        today = data.get("today") or {}
        tomorrow = data.get("tomorrow") or {}
        lbl = str(today.get("label") or today.get("level") or "?")
        idx = today.get("index") or "?"
        fields.append(_f("🌫️ Indice air J0", f"{idx} — {lbl}", inline=True))
        if tomorrow:
            lbl2 = str(tomorrow.get("label") or tomorrow.get("level") or "?")
            idx2 = tomorrow.get("index") or "?"
            fields.append(_f("📅 Indice air J1", f"{idx2} — {lbl2}", inline=True))
        if data.get("has_pollution_episode"):
            fields.append(_f("⚠️ Épisode pollution", "En cours", inline=True))
        pollutants = today.get("pollutants") or []
        if pollutants:
            lines = [f"• {p.get('name','?')} : {p.get('value','?')} {p.get('unit','')}" for p in pollutants[:4]]
            fields.append(_f("🔬 Polluants", "\n".join(lines), inline=False))

    # ── Préfecture / Presse ───────────────────────────────────────────────────
    elif service_key in ("prefecture_isere", "dauphine_isere", "france_bleu_isere"):
        items = data.get("items") or data.get("articles") or []
        icon = {"prefecture_isere": "🏛️", "dauphine_isere": "📰", "france_bleu_isere": "📻"}.get(service_key, "📰")
        fields.append(_f(f"{icon} Articles/Actualités", str(len(items)), inline=True))
        if items:
            lines = [_detail_line(i, title_keys=("title", "headline")) for i in items[:4]]
            fields.append(_f("📋 Dernières actualités", "\n".join(lines), inline=False))

    # ── Géorisques ────────────────────────────────────────────────────────────
    elif service_key == "feux_foret_isere":
        recent = data.get("recent_incidents_2d") or data.get("recent_incidents") or []
        total = int(data.get("fires_total") or len(recent))
        fields.append(_f("Foyers < 2 jours", str(total), inline=True))
        fields.append(_f("Source", "FeuxDeForet.fr Isere", inline=True))
        if recent:
            lines = [_detail_line(item, title_keys=("title", "commune"), icon="🔥") for item in recent[:5]]
            fields.append(_f("Derniers signalements", "\n".join(lines), inline=False))
    elif service_key == "georisques":
        details = data.get("details") or []
        seismic = data.get("highest_seismic_zone_label") or "?"
        flood_docs = data.get("flood_documents_total") or 0
        fields.append(_f("🌋 Zone sismique max", seismic, inline=True))
        fields.append(_f("🌊 Documents inondation", str(flood_docs), inline=True))
        if details:
            lines = [f"• {_trunc(str(d.get('type') or d.get('title') or d), 80)}" for d in details[:4]]
            fields.append(_f("📋 Risques identifiés", "\n".join(lines), inline=False))

    # ── ARCEP ─────────────────────────────────────────────────────────────────
    elif service_key == "arcep_isere":
        total = int(data.get("outages_total") or 0)
        fields.append(_f("📶 Sites indisponibles", str(total), inline=True))
        communes = data.get("communes") or []
        if communes:
            lines = [f"• {_trunc(str(c.get('name') or c), 60)}" for c in communes[:5]]
            fields.append(_f("📍 Communes affectées", "\n".join(lines), inline=False))

    # ── Champ générique si aucun cas spécifique ───────────────────────────────
    if not fields:
        if data.get("error"):
            fields.append(_f("❌ Erreur", _trunc(str(data["error"]), 200), inline=False))
        else:
            summary_parts = []
            for key, display in (
                ("title", "Titre"), ("message", "Message"), ("description", "Description"),
                ("alert_level", "Niveau source"), ("events_total", "Événements"),
                ("alerts_total", "Alertes"), ("disruptions_total", "Perturbations"),
            ):
                if data.get(key) not in (None, "", []):
                    summary_parts.append(f"**{display} :** {_trunc(str(data[key]), 220)}")
            fields.append(_f("📋 Détails transmis par le service", "\n".join(summary_parts) or "Aucun détail complémentaire fourni par la source.", inline=False))

    service_status = str(data.get("status") or "").strip()
    updated_at = str(data.get("updated_at") or data.get("observed_at") or "").strip()
    if service_status:
        fields.append(_f("État du service", service_status, inline=True))
    if updated_at:
        fields.append(_f("Dernière mise à jour", updated_at, inline=True))

    # ── Source / lien ─────────────────────────────────────────────────────────
    source_url = str(data.get("source") or data.get("source_url") or data.get("link") or "")
    if source_url.startswith("http"):
        fields.append(_f("🔗 Source", f"[Voir la source]({source_url[:200]})", inline=True))

    return {
        "username": "CRISIS38",
        "embeds": [{
            "title": f"{emoji} ALERTE ISÈRE — {label}",
            "description": description,
            "color": color,
            "fields": fields[:25],  # Discord limite à 25 champs
            "footer": {"text": "CRISIS38 · Centre opérationnel Isère"},
            "timestamp": now_iso,
        }]
    }


def _send_discord_webhook(webhook_url: str, payload: dict) -> tuple[bool, str]:
    """Envoie un message sur un canal Discord via Webhook. Retourne (success, detail)."""
    import urllib.request
    try:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            webhook_url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "User-Agent": "CRISIS38/1.0"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            # Discord renvoie 204 No Content en cas de succès
            return resp.status in (200, 204), f"HTTP {resp.status}"
    except Exception as exc:
        return False, str(exc)[:150]


def _load_notif_settings() -> dict:
    """Charge les paramètres de notification depuis Redis (ancien format, conservé pour compat)."""
    if not _REDIS_OK or _redis is None:
        return {}
    try:
        raw = _redis.get(_NOTIF_SETTINGS_KEY)
        return json.loads(raw) if raw else {}
    except Exception:
        return {}


def _load_notif_rules() -> list[dict]:
    """Charge toutes les règles de notification depuis Redis.
    Migre automatiquement depuis l'ancien format notif:settings si besoin."""
    if not _REDIS_OK or _redis is None:
        return []
    try:
        raw = _redis.get(_NOTIF_RULES_KEY)
        if raw:
            return json.loads(raw)
        # Migration depuis l'ancien format
        old = _load_notif_settings()
        if old.get("discord_webhook"):
            import uuid as _uuid
            rule: dict = {
                "id": _uuid.uuid4().hex[:8],
                "name": "Alertes par défaut",
                "enabled": bool(old.get("enabled", True)),
                "discord_webhook": str(old.get("discord_webhook", "")),
                "cooldown_minutes": int(old.get("cooldown_minutes") or 60),
                "quiet_hours": old.get("quiet_hours") or {"enabled": False, "start": "22:00", "end": "07:00"},
                "services": old.get("services") or {},
            }
            rules = [rule]
            _redis.set(_NOTIF_RULES_KEY, json.dumps(rules, default=str))
            return rules
        return []
    except Exception:
        return []


def _save_notif_rules(rules: list[dict]) -> None:
    if not _REDIS_OK or _redis is None:
        return
    try:
        _redis.set(_NOTIF_RULES_KEY, json.dumps(rules, default=str))
    except Exception:
        pass


def _save_notif_log(entry: dict) -> None:
    """Ajoute une entrée au journal des notifications (Redis list, max 50)."""
    if not _REDIS_OK or _redis is None:
        return
    try:
        _redis.lpush(_NOTIF_LOG_KEY, json.dumps(entry, default=str))
        _redis.ltrim(_NOTIF_LOG_KEY, 0, _NOTIF_MAX_LOG - 1)
    except Exception:
        pass


def _check_notif_quiet(quiet: dict, now_utc: "datetime") -> bool:
    """Retourne True si on est dans une plage silencieuse."""
    if not quiet.get("enabled"):
        return False
    try:
        start_h, start_m = map(int, quiet.get("start", "22:00").split(":"))
        end_h, end_m = map(int, quiet.get("end", "07:00").split(":"))
        now_min = now_utc.hour * 60 + now_utc.minute
        start_min = start_h * 60 + start_m
        end_min = end_h * 60 + end_m
        return (start_min > end_min and (now_min >= start_min or now_min < end_min)) \
            or (start_min <= end_min and start_min <= now_min < end_min)
    except Exception:
        return False


def _check_and_send_notifications(service_key: str, data: dict) -> None:
    """Vérifie si une notification doit être envoyée pour chaque règle active.

    Envoie uniquement lors d'un changement vers un niveau jaune/orange/rouge
    configuré, ou lorsque le contenu métier change. Il n'y a aucun rappel
    périodique pour un état inchangé.

    Clés Redis utilisées :
    - notif:state:{rule_id}:{service_key} → JSON {"notified_level":"orange","seen_below":false,"notified_at":"..."}
    """
    try:
        rules = _load_notif_rules()
        current_level = _extract_service_level(service_key, data)
        current_rank = _LEVEL_ORDER.get(current_level, 0)
        now_utc = datetime.utcnow()

        for rule in rules:
            try:
                if not rule.get("enabled"):
                    continue
                webhook_url = str(rule.get("discord_webhook") or "").strip()
                if not webhook_url:
                    continue
                rule_id = str(rule.get("id", "default"))

                svc_cfg = (rule.get("services") or {}).get(service_key) or {}
                if not svc_cfg.get("enabled"):
                    continue

                # Une panne ou un changement de route API VigiEau ne signifie
                # pas que les restrictions ont changé. Conserver le dernier
                # état métier connu jusqu'au prochain relevé exploitable.
                if service_key == "vigieau" and str(data.get("status") or "").lower() != "online":
                    continue

                threshold = str(svc_cfg.get("threshold") or "orange").lower()
                threshold_rank = _LEVEL_ORDER.get(threshold, 1)

                if _check_notif_quiet(rule.get("quiet_hours") or {}, now_utc):
                    continue

                # ── Charger l'état précédent ────────────────────────────────
                state_key = f"notif:state:{rule_id}:{service_key}"
                state: dict = {}
                if _REDIS_OK and _redis is not None:
                    raw = _redis.get(state_key)
                    if raw:
                        try:
                            state = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
                        except Exception:
                            state = {}

                if service_key in ("prefecture_isere", "feux_foret_isere"):
                    latest_fingerprint, latest_item = (
                        _latest_feux_foret_fingerprint(data)
                        if service_key == "feux_foret_isere"
                        else _latest_news_fingerprint(data)
                    )
                    if not latest_fingerprint:
                        continue

                    previous_fingerprint = str(state.get("latest_fingerprint") or "")
                    if not previous_fingerprint:
                        if _REDIS_OK and _redis is not None:
                            _redis.setex(state_key, 30 * 86400, json.dumps({
                                **state,
                                "latest_fingerprint": latest_fingerprint,
                                "latest_title": (latest_item or {}).get("title") or (latest_item or {}).get("headline") or "",
                                "last_seen_at": now_utc.isoformat(),
                            }))
                        continue

                    if previous_fingerprint == latest_fingerprint:
                        continue

                    reason = "nouveau feu" if service_key == "feux_foret_isere" else "nouvelle actualité"
                    embed_payload = _build_discord_embed(service_key, "jaune", data, reason=reason)
                    ok, detail = _send_discord_webhook(webhook_url, embed_payload)
                    log_entry = {
                        "rule_id": rule_id,
                        "rule_name": rule.get("name", ""),
                        "service": service_key,
                        "label": _SERVICE_LABELS.get(service_key, service_key),
                        "level": "jaune",
                        "reason": reason,
                        "sent_at": now_utc.isoformat() + "Z",
                        "success": ok,
                        "detail": detail,
                    }
                    _save_notif_log(log_entry)

                    if _REDIS_OK and _redis is not None:
                        new_state = {
                            **state,
                            "last_seen_at": now_utc.isoformat(),
                        }
                        if ok:
                            new_state["latest_fingerprint"] = latest_fingerprint
                            new_state["latest_title"] = (latest_item or {}).get("title") or (latest_item or {}).get("headline") or ""
                            new_state["notified_at"] = now_utc.isoformat()
                        _redis.setex(state_key, 30 * 86400, json.dumps(new_state))
                    continue

                last_seen_level = str(state.get("last_seen_level") or "vert")
                content_fingerprint = _notification_content_fingerprint(data, service_key)

                # ── Mettre à jour seen_below ────────────────────────────────
                if current_rank < threshold_rank:
                    # Sous le seuil : mémoriser la transition sans notifier.
                    new_state = {
                        **state,
                        "seen_below": True,
                        "last_seen_level": current_level,
                        "last_seen_fingerprint": content_fingerprint,
                    }
                    if _REDIS_OK and _redis is not None:
                        _redis.setex(state_key, 30 * 86400, json.dumps(new_state))
                    continue

                # ── Décider si on envoie ────────────────────────────────────
                # Migration silencieuse des états créés avant les empreintes :
                # ne pas renvoyer une alerte déjà reçue lors du déploiement.
                if (
                    state.get("notified_at")
                    and not state.get("notified_fingerprint")
                    and str(state.get("notified_level") or "") == current_level
                ):
                    state["notified_fingerprint"] = content_fingerprint
                    state["last_seen_fingerprint"] = content_fingerprint
                    state["last_seen_level"] = current_level
                    if _REDIS_OK and _redis is not None:
                        _redis.setex(state_key, 30 * 86400, json.dumps(state))
                    continue

                level_changed = current_level != last_seen_level
                new_information = (
                    content_fingerprint
                    != str(state.get("notified_fingerprint") or "")
                )
                should_send = level_changed or new_information
                reason = (
                    f"changement de statut {last_seen_level}→{current_level}"
                    if level_changed
                    else "nouvelles informations"
                )

                if not should_send:
                    # Renouveler la durée de vie de l'état tant que le service
                    # est observé. Une restriction inchangée pendant plus de
                    # 30 jours ne doit pas être renvoyée comme si elle était
                    # nouvelle après expiration de la clé Redis.
                    if _REDIS_OK and _redis is not None:
                        _redis.setex(state_key, 30 * 86400, json.dumps({
                            **state,
                            "last_seen_level": current_level,
                            "last_seen_fingerprint": content_fingerprint,
                            "last_seen_at": now_utc.isoformat(),
                        }))
                    continue

                # ── Envoyer ────────────────────────────────────────────────
                embed_payload = _build_discord_embed(service_key, current_level, data, reason=reason)
                ok, detail = _send_discord_webhook(webhook_url, embed_payload)

                log_entry = {
                    "rule_id": rule_id,
                    "rule_name": rule.get("name", ""),
                    "service": service_key,
                    "label": _SERVICE_LABELS.get(service_key, service_key),
                    "level": current_level,
                    "reason": reason,
                    "sent_at": now_utc.isoformat() + "Z",
                    "success": ok,
                    "detail": detail,
                }
                _save_notif_log(log_entry)

                # Ne marquer le contenu comme notifié qu'après un envoi réussi.
                if _REDIS_OK and _redis is not None:
                    new_state = {
                        **state,
                        "notified_level": current_level,
                        "seen_below": False,
                        "last_seen_level": current_level,
                        "last_seen_fingerprint": content_fingerprint,
                    }
                    if ok:
                        new_state["notified_at"] = now_utc.isoformat()
                        new_state["notified_fingerprint"] = content_fingerprint
                    _redis.setex(state_key, 30 * 86400, json.dumps(new_state))

            except Exception:
                continue
    except Exception:
        pass


# Injecter le hook dans _update_service_slot
_orig_update_service_slot = _update_service_slot


def _update_service_slot_with_notif(key: str, result: dict) -> None:
    _orig_update_service_slot(key, result)
    Thread(target=_check_and_send_notifications, args=(key, result), daemon=True).start()
    Thread(target=_check_and_record_alert, args=(key, result), daemon=True).start()


_update_service_slot = _update_service_slot_with_notif  # type: ignore[assignment]


# ── Endpoints notification (multi-règles) ─────────────────────────────────────

def _sanitize_rule(body: dict, existing: dict | None = None) -> dict:
    import uuid as _uuid
    base = existing or {}
    return {
        "id": base.get("id") or _uuid.uuid4().hex[:8],
        "name": str(body.get("name") or base.get("name") or "Notification")[:80],
        "enabled": bool(body.get("enabled") if "enabled" in body else base.get("enabled", True)),
        "discord_webhook": str(body.get("discord_webhook") or base.get("discord_webhook") or "").strip()[:500],
        "cooldown_minutes": max(5, min(1440, int(body.get("cooldown_minutes") or base.get("cooldown_minutes") or 60))),
        "quiet_hours": body.get("quiet_hours") or base.get("quiet_hours") or {"enabled": False, "start": "22:00", "end": "07:00"},
        "services": body.get("services") or base.get("services") or {},
    }


@app.get("/api/notifications")
def list_notif_rules(_: User = Depends(require_roles("admin", "ope"))):
    return {"rules": _load_notif_rules()}


@app.post("/api/notifications")
async def create_notif_rule(request: Request, _: User = Depends(require_roles("admin", "ope"))):
    if not _REDIS_OK or _redis is None:
        raise HTTPException(503, "Redis indisponible")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Corps JSON invalide")
    rules = _load_notif_rules()
    rule = _sanitize_rule(body)
    rules.append(rule)
    _save_notif_rules(rules)
    return rule


@app.put("/api/notifications/{rule_id}")
async def update_notif_rule(rule_id: str, request: Request, _: User = Depends(require_roles("admin", "ope"))):
    if not _REDIS_OK or _redis is None:
        raise HTTPException(503, "Redis indisponible")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Corps JSON invalide")
    rules = _load_notif_rules()
    for i, r in enumerate(rules):
        if r.get("id") == rule_id:
            rules[i] = _sanitize_rule(body, r)
            _save_notif_rules(rules)
            return rules[i]
    raise HTTPException(404, "Règle introuvable")


@app.delete("/api/notifications/{rule_id}")
def delete_notif_rule(rule_id: str, _: User = Depends(require_roles("admin", "ope"))):
    rules = _load_notif_rules()
    new_rules = [r for r in rules if r.get("id") != rule_id]
    if len(new_rules) == len(rules):
        raise HTTPException(404, "Règle introuvable")
    _save_notif_rules(new_rules)
    return {"deleted": rule_id}


@app.post("/api/notifications/test")
async def test_notif(request: Request, _: User = Depends(require_roles("admin", "ope"))):
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "Corps JSON invalide")
    webhook_url = str(payload.get("webhook_url") or "").strip()
    if not webhook_url:
        raise HTTPException(400, "webhook_url requis")
    test_payload = {
        "username": "CRISIS38",
        "embeds": [{
            "title": "✅ Test CRISIS38",
            "description": (
                "Les notifications Discord sont correctement configurées.\n"
                f"Envoyé le {datetime.utcnow().strftime('%d/%m/%Y %H:%M UTC')}"
            ),
            "color": 0x2ECC71,
            "footer": {"text": "CRISIS38 · Centre opérationnel Isère"},
        }]
    }
    ok, detail = _send_discord_webhook(webhook_url, test_payload)
    return {"success": ok, "detail": detail}


@app.get("/api/avalanche-isere")
def api_avalanche_isere(refresh: bool = False, _: User = Depends(require_roles(*READ_ROLES))):
    return fetch_avalanche_isere(force_refresh=refresh)


@app.get("/api/feux-foret-isere")
def api_feux_foret_isere(refresh: bool = False, _: User = Depends(require_roles(*READ_ROLES))):
    return fetch_feux_foret_isere(force_refresh=refresh)


@app.get("/api/meteo-forets-isere")
def api_meteo_forets_isere(refresh: bool = False, _: User = Depends(require_roles(*READ_ROLES))):
    return fetch_meteo_forets_isere(force_refresh=refresh)


@app.get("/api/cols-alpins-isere")
def api_cols_alpins_isere(refresh: bool = False, _: User = Depends(require_roles(*READ_ROLES))):
    return fetch_cols_alpins_isere(force_refresh=refresh)


@app.get("/api/notifications/log")
def get_notif_log(_: User = Depends(require_roles("admin", "ope"))):
    if not _REDIS_OK or _redis is None:
        return {"entries": []}
    try:
        raw_list = _redis.lrange(_NOTIF_LOG_KEY, 0, _NOTIF_MAX_LOG - 1)
        entries = []
        for r in raw_list:
            try:
                entries.append(json.loads(r))
            except Exception:
                pass
        return {"entries": entries}
    except Exception:
        return {"entries": []}


# ── Géolocalisation terrain ─────────────────────────────────────────────────
_AGENT_LOC_PREFIX = "agent_loc:"
_AGENT_LOC_TTL = 60  # secondes — expire si plus de signal GPS


@app.put("/agents/location")
async def update_agent_location(request: Request, user: User = Depends(get_active_user)):
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "Corps JSON invalide")
    name = str(payload.get("name") or user.username or "Agent")[:40]
    try:
        lat = float(payload["lat"])
        lon = float(payload["lon"])
    except (KeyError, ValueError, TypeError):
        raise HTTPException(400, "lat/lon manquants ou invalides")
    accuracy = float(payload.get("accuracy") or 0)
    data = {
        "user_id": user.id,
        "name": name,
        "lat": lat,
        "lon": lon,
        "accuracy": accuracy,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    if not _REDIS_OK or _redis is None:
        raise HTTPException(503, "Redis non disponible")
    _redis.setex(f"{_AGENT_LOC_PREFIX}{user.id}", _AGENT_LOC_TTL, json.dumps(data))
    return {"status": "ok"}


@app.get("/agents/locations")
def get_agent_locations(_: User = Depends(get_active_user)):
    if not _REDIS_OK or _redis is None:
        return {"agents": []}
    try:
        keys = _redis.keys(f"{_AGENT_LOC_PREFIX}*")
        agents = []
        for key in keys:
            raw = _redis.get(key)
            if raw:
                try:
                    agents.append(json.loads(raw))
                except Exception:
                    pass
        return {"agents": agents}
    except Exception:
        return {"agents": []}


# ══════════════════════════════════════════════════════════════════════════════
# FEATURE 3 — Historique des alertes
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/alerts/history")
def get_alerts_history(
    days: int = Query(30, ge=1, le=90),
    limit: int = Query(300, ge=1, le=1000),
    db: Session = Depends(get_db),
    _: User = Depends(require_roles(*READ_ROLES)),
):
    since = datetime.utcnow() - timedelta(days=days)
    alerts = (
        db.query(AlertHistory)
        .filter(AlertHistory.triggered_at >= since)
        .order_by(AlertHistory.triggered_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": a.id,
            "service_key": a.service_key,
            "service_label": a.service_label,
            "new_level": a.new_level,
            "previous_level": a.previous_level,
            "detail": a.detail,
            "triggered_at": a.triggered_at.isoformat() + "Z",
        }
        for a in alerts
    ]


# ══════════════════════════════════════════════════════════════════════════════
# FEATURE 15 — Journal d'audit
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/audit")
def get_audit_log(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0, le=5000),
    search: str | None = Query(None),
    username: str | None = Query(None),
    resource_type: str | None = Query(None),
    method: str | None = Query(None),
    status: str | None = Query(None),
    sort_by: str = Query("created_at"),
    sort_dir: str = Query("desc"),
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin")),
):
    q = db.query(AuditLog, User.role, User.municipality_name).outerjoin(User, User.username == AuditLog.username)
    if username:
        q = q.filter(AuditLog.username == username)
    if resource_type:
        q = q.filter(AuditLog.resource_type == resource_type)
    if method:
        normalized_method = method.upper().strip()
        q = q.filter(AuditLog.action.ilike(f"{normalized_method} %"))
    if status == "success":
        q = q.filter(AuditLog.status_code >= 200, AuditLog.status_code < 400)
    elif status == "error":
        q = q.filter(AuditLog.status_code >= 400)
    elif status == "warning":
        q = q.filter(AuditLog.status_code >= 300, AuditLog.status_code < 400)
    if search:
        term = f"%{search.strip()}%"
        q = q.filter(or_(
            AuditLog.username.ilike(term),
            AuditLog.action.ilike(term),
            AuditLog.resource_type.ilike(term),
            AuditLog.details.ilike(term),
            AuditLog.ip_address.ilike(term),
        ))

    sort_columns = {
        "created_at": AuditLog.created_at,
        "username": AuditLog.username,
        "resource_type": AuditLog.resource_type,
        "status_code": AuditLog.status_code,
        "action": AuditLog.action,
    }
    sort_column = sort_columns.get(sort_by, AuditLog.created_at)
    q = q.order_by(sort_column.asc() if sort_dir == "asc" else sort_column.desc())
    total = q.count()
    rows = q.offset(offset).limit(limit).all()
    users = [
        username
        for (username,) in db.query(AuditLog.username).distinct().order_by(AuditLog.username.asc()).limit(300).all()
        if username
    ]
    resource_types = [
        resource
        for (resource,) in db.query(AuditLog.resource_type).filter(AuditLog.resource_type.isnot(None)).distinct().order_by(AuditLog.resource_type.asc()).all()
        if resource
    ]

    items = [
        {
            "id": a.id,
            "username": a.username,
            "user_role": role,
            "user_municipality": municipality_name,
            "action": a.action,
            "method": (a.action or "").split(" ", 1)[0] if a.action else "",
            "path": (a.action or "").split(" ", 1)[1] if " " in (a.action or "") else a.action,
            "resource_type": a.resource_type,
            "details": a.details,
            "ip_address": a.ip_address,
            "status_code": a.status_code,
            "created_at": a.created_at.isoformat() + "Z",
        }
        for a, role, municipality_name in rows
    ]
    return {"items": items, "total": total, "users": users, "resource_types": resource_types}


@app.get("/api/audit/export/csv")
def export_audit_csv(
    days: int = Query(30, ge=1, le=90),
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin")),
):
    since = datetime.utcnow() - timedelta(days=days)
    logs = (
        db.query(AuditLog)
        .filter(AuditLog.created_at >= since)
        .order_by(AuditLog.created_at.desc())
        .all()
    )

    def _csv_field(value) -> str:
        text_value = "" if value is None else str(value)
        return '"' + text_value.replace('"', '""') + '"'

    def _csv():
        yield "id,username,action,resource_type,details,ip_address,status_code,created_at\n"
        for a in logs:
            fields = [
                str(a.id),
                a.username,
                a.action,
                a.resource_type or "",
                a.details or "",
                a.ip_address or "",
                str(a.status_code or ""),
                a.created_at.isoformat() + "Z",
            ]
            yield ",".join(_csv_field(field) for field in fields) + "\n"

    filename = f"audit_{datetime.utcnow().strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        _csv(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
