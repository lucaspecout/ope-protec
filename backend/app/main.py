from datetime import datetime, timedelta
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import re
import secrets
import hashlib
import logging
from threading import Lock, Thread
from time import sleep
from typing import Callable

import asyncio
import json

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from .config import settings
from .database import Base, SessionLocal, SessionLocalAuth, engine, get_db
from .models import ExerciseRun, IncidentEvent, MapAnnotation, MapPoint, Municipality, MunicipalityDocument, OperationalLog, PcsGuidanceRun, PublicShare, RiverStation, ScenarioTemplate, User, WeatherAlert
from .schemas import (
    MapAnnotationCreate,
    MapAnnotationOut,
    IncidentEventCreate,
    IncidentEventOut,
    IncidentEventStatusUpdate,
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
    PcsGuidanceOut,
    PcsGuidanceRequest,
    PasswordChangeRequest,
    ExerciseRunCreate,
    ExerciseRunOut,
    ShareAccessRequest,
    ScenarioTemplateOut,
    Token,
    TwoFactorToggleRequest,
    UserCreate,
    UserOut,
    UserPasswordResetRequest,
    UserPasswordResetResponse,
    UserUpdate,
    WeatherAlertCreate,
    WeatherAlertOut,
)
from .security import create_access_token, hash_password, verify_password
from .services import (
    fetch_bison_fute_live_events,
    fetch_bison_fute_traffic,
    fetch_georisques_commune_risks,
    cleanup_old_weather_alerts,
    fetch_georisques_isere_summary,
    fetch_isere_boundary_geojson,
    fetch_meteo_france_isere,
    fetch_itinisere_disruptions,
    fetch_prefecture_isere_news,
    fetch_dauphine_isere_news,
    fetch_finess_isere_resources,
    fetch_isere_opendata_resilience,
    fetch_hubeau_isere_groundwater,
    fetch_sncf_isere_alerts,
    fetch_rte_isere_electricity_status,
    fetch_atmo_aura_isere_air_quality,
    fetch_anfr_isere_antennas,
    fetch_arcep_isere_mobile_outages,
    fetch_apic_isere_alerts,
    fetch_vigicrues_isere,
    fetch_vigicrues_flash_isere_alerts,
    fetch_vigieau_restrictions,
    generate_pdf_report,
    resolve_commune_insee_code,
    vigicrues_geojson_from_stations,
)

Base.metadata.create_all(bind=engine)
Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)


with engine.begin() as conn:
    conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE"))
    conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS municipality_name VARCHAR(120)"))
    conn.execute(text("ALTER TABLE weather_alerts ADD COLUMN IF NOT EXISTS internal_mail_group VARCHAR(255)"))
    conn.execute(text("ALTER TABLE weather_alerts ADD COLUMN IF NOT EXISTS sent_to_internal_group BOOLEAN DEFAULT FALSE"))
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
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS assigned_role VARCHAR(40)"))
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
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_weather_alerts_created_at ON weather_alerts(created_at DESC)"))
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
        CREATE TABLE IF NOT EXISTS scenario_templates (
            id SERIAL PRIMARY KEY,
            name VARCHAR(120) NOT NULL UNIQUE,
            hazard_type VARCHAR(40) NOT NULL DEFAULT 'multi',
            severity VARCHAR(20) NOT NULL DEFAULT 'jaune',
            description TEXT NOT NULL DEFAULT '',
            default_checklist TEXT NOT NULL DEFAULT '[]',
            reflex_sheet_template TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS exercise_runs (
            id SERIAL PRIMARY KEY,
            scenario_id INTEGER NOT NULL REFERENCES scenario_templates(id) ON DELETE CASCADE,
            municipality_id INTEGER REFERENCES municipalities(id) ON DELETE SET NULL,
            mode VARCHAR(20) NOT NULL DEFAULT 'exercice',
            status VARCHAR(20) NOT NULL DEFAULT 'planifie',
            score_preparedness INTEGER NOT NULL DEFAULT 0,
            started_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            ended_at TIMESTAMP WITHOUT TIME ZONE,
            created_by_id INTEGER NOT NULL REFERENCES users(id)
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS pcs_guidance_runs (
            id SERIAL PRIMARY KEY,
            municipality_id INTEGER REFERENCES municipalities(id) ON DELETE SET NULL,
            hazard_type VARCHAR(40) NOT NULL,
            alert_level VARCHAR(20) NOT NULL DEFAULT 'jaune',
            recommended_level VARCHAR(20) NOT NULL DEFAULT 'veille',
            current_step VARCHAR(120) NOT NULL DEFAULT 'qualification',
            checklist_json TEXT NOT NULL DEFAULT '[]',
            reflex_sheet_text TEXT NOT NULL DEFAULT '',
            triggered_by_id INTEGER NOT NULL REFERENCES users(id),
            created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    """))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_exercise_runs_started_at ON exercise_runs(started_at DESC)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_pcs_guidance_runs_created_at ON pcs_guidance_runs(created_at DESC)"))


app = FastAPI(title=settings.app_name)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=800)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")
logger = logging.getLogger("ope_protec.concurrency")

ALLOWED_WEATHER_TRANSITIONS = {("jaune", "orange"), ("orange", "rouge")}
READ_ROLES = {"admin", "ope", "securite", "visiteur", "mairie"}
EDIT_ROLES = {"admin", "ope"}

EXTERNAL_REFRESH_INTERVAL_SECONDS = 300
_external_risks_snapshot_lock = Lock()
_external_risks_snapshot: dict = {
    "updated_at": None,
    "payload": {
        "updated_at": None,
        "meteo_france": {},
        "vigicrues": {},
        "itinisere": {},
        "bison_fute": {},
        "georisques": {},
        "prefecture_isere": {},
        "dauphine_isere": {},
        "atmo_aura": {},
        "anfr_isere": {},
        "arcep_isere": {},
        "apic_isere": {},
        "vigicrues_flash_isere": {},
    },
}
_external_risks_refresh_lock = Lock()
_external_risks_refresh_in_progress = False
ALLOWED_DOC_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}

_map_annotations_revision_lock = Lock()
_map_annotations_revision = 0
_weather_cleanup_lock = Lock()
_last_weather_cleanup_at: datetime | None = None
_WEATHER_CLEANUP_MIN_INTERVAL = timedelta(minutes=10)
_inflight_request_count_lock = Lock()
_inflight_request_count = 0
_auth_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="auth-login")
DEFAULT_SCENARIO_LIBRARY = [
    {
        "name": "Inondation majeure",
        "hazard_type": "inondation",
        "severity": "orange",
        "description": "Montée rapide des eaux avec impacts potentiels sur ERP, écoles et axes routiers.",
        "checklist": [
            "Qualifier le secteur impacté et le niveau d'alerte",
            "Alerter mairie, DGS et astreinte",
            "Pré-positionner les équipes terrain et zones de repli",
            "Informer ERP, écoles et EHPAD de la zone",
            "Tracer toutes les décisions dans la main courante",
        ],
        "reflex": "Fiche réflexe inondation: fermeture axes bas, mise à l'abri ciblée, remontée situation toutes les 30 min.",
    },
    {
        "name": "Feu de forêt périurbain",
        "hazard_type": "feu_foret",
        "severity": "rouge",
        "description": "Propagation rapide d'un feu de végétation menaçant des habitations.",
        "checklist": [
            "Activer coordination CODIS / mairie / terrain",
            "Identifier populations vulnérables à évacuer en priorité",
            "Définir périmètre de sécurité et points de regroupement",
            "Assurer continuité des communications radio",
        ],
        "reflex": "Fiche réflexe feu de forêt: confinement/évacuation selon vent, information riverains, protection ERP sensibles.",
    },
    {
        "name": "Tempête et rupture réseau",
        "hazard_type": "tempete_reseau",
        "severity": "jaune",
        "description": "Épisode vent violent entraînant coupures électriques et télécom.",
        "checklist": [
            "Recenser communes avec coupure électrique / mobile",
            "Prioriser EHPAD, écoles et centres de santé",
            "Déployer cellules d'information citoyenne",
            "Planifier points de recharge / accueil temporaire",
        ],
        "reflex": "Fiche réflexe tempête-réseau: priorisation sites vitaux, alternatives radio, suivi ENEDIS/ARCEP.",
    },
]


@app.middleware("http")
async def log_request_timing(request: Request, call_next):
    global _inflight_request_count
    started_at = datetime.utcnow()
    with _inflight_request_count_lock:
        _inflight_request_count += 1
        active_requests = _inflight_request_count
    try:
        response = await call_next(request)
        return response
    finally:
        duration_ms = int((datetime.utcnow() - started_at).total_seconds() * 1000)
        with _inflight_request_count_lock:
            _inflight_request_count -= 1
            remaining_requests = _inflight_request_count
        logger.info(
            "request method=%s path=%s duration_ms=%s active_requests=%s remaining_requests=%s",
            request.method,
            request.url.path,
            duration_ms,
            active_requests,
            remaining_requests,
        )


def bump_map_annotations_revision() -> int:
    global _map_annotations_revision
    with _map_annotations_revision_lock:
        _map_annotations_revision += 1
        return _map_annotations_revision


def utc_timestamp() -> str:
    return datetime.utcnow().isoformat() + "Z"


def parse_json_list(raw_value: str | None) -> list[str]:
    if not raw_value:
        return []
    try:
        payload = json.loads(raw_value)
    except Exception:
        return []
    if not isinstance(payload, list):
        return []
    return [str(item).strip() for item in payload if str(item).strip()]


def ensure_default_scenario_templates(db: Session) -> None:
    if db.query(ScenarioTemplate).count() > 0:
        return
    for template in DEFAULT_SCENARIO_LIBRARY:
        db.add(
            ScenarioTemplate(
                name=template["name"],
                hazard_type=template["hazard_type"],
                severity=template["severity"],
                description=template["description"],
                default_checklist=json.dumps(template["checklist"], ensure_ascii=False),
                reflex_sheet_template=template["reflex"],
            )
        )
    db.commit()


def compute_global_risk(*levels: str) -> str:
    normalized_levels = {str(level).lower() for level in levels}
    for level in ("rouge", "orange", "jaune"):
        if level in normalized_levels:
            return level
    return "vert"


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


def run_weather_cleanup_if_due(db: Session) -> None:
    global _last_weather_cleanup_at
    now = datetime.utcnow()
    with _weather_cleanup_lock:
        if _last_weather_cleanup_at and (now - _last_weather_cleanup_at) < _WEATHER_CLEANUP_MIN_INTERVAL:
            return
        _last_weather_cleanup_at = now

    try:
        cleanup_old_weather_alerts(db)
    except Exception:
        # Ne jamais bloquer la réponse API pour une purge opportuniste.
        pass


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
    cleanup_old_weather_alerts(db)


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
    return user


def require_roles(*roles: str) -> Callable[[User], User]:
    allowed = set(roles)

    def validator(user: User = Depends(get_active_user)) -> User:
        if user.role not in allowed:
            raise HTTPException(403, "Droits insuffisants")
        return user

    return validator


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


def _warmup_external_sources() -> None:
    """Démarre un premier rafraîchissement partagé dès le démarrage du serveur."""
    trigger_external_risks_refresh(db=None)


def _set_external_risks_snapshot(payload: dict) -> None:
    with _external_risks_snapshot_lock:
        _external_risks_snapshot["updated_at"] = datetime.utcnow()
        _external_risks_snapshot["payload"] = deepcopy(payload)


def _get_external_risks_snapshot() -> dict:
    with _external_risks_snapshot_lock:
        return deepcopy(_external_risks_snapshot.get("payload") or {})


def _continuous_external_refresh() -> None:
    """Planifie un rafraîchissement de supervision périodique sans chevauchement."""
    while True:
        trigger_external_risks_refresh(db=None)
        sleep(EXTERNAL_REFRESH_INTERVAL_SECONDS)


@app.on_event("startup")
def startup_warmup_external_sources() -> None:
    Thread(target=_warmup_external_sources, daemon=True).start()
    Thread(target=_continuous_external_refresh, daemon=True).start()


@app.on_event("shutdown")
def shutdown_auth_executor() -> None:
    _auth_executor.shutdown(wait=False, cancel_futures=True)


@app.get("/health")
def healthcheck():
    logger.info("healthcheck status=ok")
    return {
        "status": "ok",
        "service": settings.app_name,
        "deployment": "docker-ready",
        "scope": "Département de l'Isère",
        "project_validated": True,
    }


@app.get("/public/live")
def public_live_status(db: Session = Depends(get_db)):
    latest_alert = db.query(WeatherAlert).order_by(WeatherAlert.created_at.desc()).first()
    latest_station = db.query(RiverStation).order_by(RiverStation.updated_at.desc()).first()
    crisis_count = db.query(Municipality).filter(Municipality.crisis_mode.is_(True)).count()

    db_meteo_level = (latest_alert.level if latest_alert else "vert").lower()
    crues_level = (latest_station.level if latest_station else "vert").lower()

    risks_snapshot = get_external_risks_payload(refresh=False)
    meteo = risks_snapshot.get("meteo_france") or {}
    meteo_level = (meteo.get("level") or db_meteo_level).lower()
    global_risk = compute_global_risk(meteo_level, crues_level)
    vigicrues = risks_snapshot.get("vigicrues") or {}
    itinisere = risks_snapshot.get("itinisere") or {}
    bison_fute = risks_snapshot.get("bison_fute") or {}
    georisques = risks_snapshot.get("georisques") or {}
    prefecture = risks_snapshot.get("prefecture_isere") or {}
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
            "global_risk": global_risk,
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
def create_map_point(payload: MapPointCreate, db: Session = Depends(get_db), user: User = Depends(require_roles("admin", "ope", "mairie"))):
    if payload.municipality_id:
        ensure_municipality_scope(user, db, payload.municipality_id)

    if user.role == "mairie" and payload.municipality_id is None:
        payload = payload.model_copy(update={"municipality_id": get_user_municipality_id(user, db)})

    point = MapPoint(**payload.model_dump(), created_by_id=user.id)
    db.add(point)
    db.commit()
    db.refresh(point)
    return point


@app.delete("/map/points/{point_id}")
def delete_map_point(point_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles("admin", "ope", "mairie"))):
    point = db.get(MapPoint, point_id)
    if not point:
        raise HTTPException(404, "Point introuvable")

    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None or point.municipality_id not in {None, municipality_id}:
            raise HTTPException(403, "Suppression non autorisée")

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
def create_map_annotation(payload: MapAnnotationCreate, db: Session = Depends(get_db), user: User = Depends(require_roles("admin", "ope", "mairie"))):
    if payload.municipality_id:
        ensure_municipality_scope(user, db, payload.municipality_id)

    if user.role == "mairie" and payload.municipality_id is None:
        payload = payload.model_copy(update={"municipality_id": get_user_municipality_id(user, db)})

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
def delete_map_annotation(annotation_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles("admin", "ope", "mairie"))):
    entity = db.get(MapAnnotation, annotation_id)
    if not entity:
        raise HTTPException(404, "Annotation introuvable")

    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None or entity.municipality_id not in {None, municipality_id}:
            raise HTTPException(403, "Suppression non autorisée")

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


@app.post("/auth/register", response_model=UserOut)
def register(user: UserCreate, db: Session = Depends(get_db), creator: User = Depends(require_roles("admin", "ope"))):
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
def list_users(db: Session = Depends(get_db), user: User = Depends(require_roles("admin", "ope"))):
    users_query = db.query(User)
    if user.role == "ope":
        users_query = users_query.filter(User.role.in_(["securite", "visiteur", "mairie"]))
    return users_query.order_by(User.created_at.desc()).all()


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


def authenticate_locally(username: str, password: str) -> tuple[str, bool] | None:
    db = SessionLocalAuth()
    try:
        user = db.query(User).filter(User.username == username).first()
        if not user or not verify_password(password, user.hashed_password):
            return None
        return user.username, user.must_change_password
    finally:
        db.close()


@app.post("/auth/login", response_model=Token)
async def login(request: Request):
    form_data = await request.form()
    username = str(form_data.get("username") or "")
    password = str(form_data.get("password") or "")
    if not username or not password:
        raise HTTPException(400, "Formulaire d'authentification incomplet")

    start_wait = datetime.utcnow()
    loop = asyncio.get_running_loop()
    auth_result = await loop.run_in_executor(_auth_executor, authenticate_locally, username, password)
    wait_ms = int((datetime.utcnow() - start_wait).total_seconds() * 1000)
    logger.info("login_attempt username=%s auth_duration_ms=%s", username, wait_ms)
    if not auth_result:
        raise HTTPException(401, "Utilisateur ou mot de passe incorrect")
    authenticated_username, must_change_password = auth_result
    return {
        "access_token": create_access_token(authenticated_username),
        "token_type": "bearer",
        "must_change_password": must_change_password,
    }


@app.get("/auth/me", response_model=UserOut)
def auth_me(user: User = Depends(get_current_user)):
    logger.info("auth_me username=%s role=%s", user.username, user.role)
    return user


@app.post("/auth/change-password")
def change_password(payload: PasswordChangeRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(400, "Mot de passe actuel invalide")
    validate_password_strength(payload.new_password)
    user.hashed_password = hash_password(payload.new_password)
    user.must_change_password = False
    db.commit()
    return {"status": "password_updated"}


@app.post("/auth/me/2fa")
def toggle_2fa(payload: TwoFactorToggleRequest, db: Session = Depends(get_db), user: User = Depends(get_active_user)):
    user.two_factor_enabled = payload.enabled
    db.commit()
    return {"two_factor_enabled": user.two_factor_enabled, "mode": "optionnel"}


@app.get("/dashboard")
def dashboard(db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    risks_payload = get_external_risks_payload(refresh=False)
    return build_dashboard_payload(db, user, external_risks=risks_payload)


def build_dashboard_payload(db: Session, user: User, external_risks: dict | None = None) -> dict:
    latest_alert = db.query(WeatherAlert).order_by(WeatherAlert.created_at.desc()).first()
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
    db_meteo_level = latest_alert.level if latest_alert else "vert"
    meteo_level = meteo.get("level") or db_meteo_level
    crues_level = river_level.level if river_level else "vert"

    return {
        "vigilance": meteo_level,
        "crues": crues_level,
        "vigilance_risk_type": latest_alert.risk_type if latest_alert else "",
        "global_risk": compute_global_risk(meteo_level, crues_level),
        "communes_crise": crisis_count,
        "latest_logs": [OperationalLogOut.model_validate(log).model_dump() for log in logs],
    }


def build_external_risks_fetch_jobs(refresh: bool, pcs_commune_names: list[str]) -> dict[str, tuple[Callable[[], dict], dict]]:
    return {
        "meteo_france": (lambda: fetch_meteo_france_isere(force_refresh=refresh), {"status": "pending", "level": "vert", "title": "Météo-France en attente"}),
        "vigicrues": (lambda: fetch_vigicrues_isere(force_refresh=refresh), {"status": "pending", "level": "vert", "stations": [], "alerts": []}),
        "itinisere": (lambda: fetch_itinisere_disruptions(force_refresh=refresh), {"status": "pending", "events": [], "events_total": 0}),
        "bison_fute": (lambda: fetch_bison_fute_traffic(force_refresh=refresh), {"status": "pending", "alerts": []}),
        "georisques": (lambda: fetch_georisques_isere_summary(force_refresh=refresh, commune_names=pcs_commune_names), {"status": "pending", "details": []}),
        "prefecture_isere": (lambda: fetch_prefecture_isere_news(force_refresh=refresh), {"status": "pending", "articles": []}),
        "dauphine_isere": (lambda: fetch_dauphine_isere_news(force_refresh=refresh), {"status": "pending", "articles": []}),
        "sncf_isere": (lambda: fetch_sncf_isere_alerts(force_refresh=refresh), {"status": "pending", "alerts": [], "alerts_total": 0}),
        "vigieau": (lambda: fetch_vigieau_restrictions(force_refresh=refresh), {"status": "pending", "alerts": [], "max_level": "vert"}),
        "atmo_aura": (lambda: fetch_atmo_aura_isere_air_quality(force_refresh=refresh), {"status": "pending", "today": {}, "tomorrow": {}}),
        "anfr_isere": (lambda: fetch_anfr_isere_antennas(force_refresh=refresh), {"status": "pending", "supports_total": 0}),
        "arcep_isere": (lambda: fetch_arcep_isere_mobile_outages(force_refresh=refresh), {"status": "pending", "outages_total": 0, "communes": []}),
        "apic_isere": (lambda: fetch_apic_isere_alerts(force_refresh=refresh), {"status": "pending", "level": "vert", "alerts_total": 0, "alerts": []}),
        "vigicrues_flash_isere": (lambda: fetch_vigicrues_flash_isere_alerts(force_refresh=refresh), {"status": "pending", "level": "vert", "alerts_total": 0, "alerts": []}),
        "electricity_isere": (lambda: fetch_rte_isere_electricity_status(force_refresh=refresh), {"status": "pending", "level": "inconnu"}),
        "finess_isere": (lambda: fetch_finess_isere_resources(force_refresh=refresh), {"status": "pending", "resources": [], "resources_total": 0}),
        "groundwater_isere": (lambda: fetch_hubeau_isere_groundwater(force_refresh=refresh), {"status": "pending", "stations": [], "stations_total": 0, "trend_summary": {"hausse": 0, "baisse": 0, "stable": 0}}),
        "isere_opendata": (lambda: fetch_isere_opendata_resilience(force_refresh=refresh), {"status": "pending", "datasets": [], "totals": {"food_aid_points": 0, "health_centers": 0, "schools": 0}, "insights": []}),
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
    pre_fetch_callback: Callable[[str, int, int], None] | None = None,
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
    completed = 0
    total_jobs = len(fetch_jobs)
    max_workers = min(6, max(1, total_jobs))

    future_to_key: dict = {}
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        for key, (fetcher, fallback) in fetch_jobs.items():
            if pre_fetch_callback is not None:
                pre_fetch_callback(key, completed, total_jobs)
            future = executor.submit(safe_fetch, key, fetcher, fallback)
            future_to_key[future] = key

        for future in as_completed(future_to_key):
            key = future_to_key[future]
            try:
                results[key] = future.result()
            except Exception as exc:
                with errors_lock:
                    errors[key] = str(exc)
                results[key] = {
                    "status": "unavailable",
                    "error": str(exc),
                    "updated_at": utc_timestamp(),
                }
            completed += 1
            if progress_callback is not None:
                progress_callback(key, results[key], completed, total_jobs)

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
    global _external_risks_refresh_in_progress

    with _external_risks_refresh_lock:
        if _external_risks_refresh_in_progress:
            return
        _external_risks_refresh_in_progress = True

    jobs_order = list(build_external_risks_fetch_jobs(refresh=True, pcs_commune_names=[]).keys())
    first_job = jobs_order[0] if jobs_order else None
    _set_external_risks_snapshot(
        build_external_risks_pending_payload(
            db=db,
            refresh=True,
            base_snapshot=_get_external_risks_snapshot(),
            current_key=first_job,
        )
    )

    def run_refresh() -> None:
        global _external_risks_refresh_in_progress
        local_db: Session | None = None
        try:
            local_db = SessionLocal()
            jobs = list(build_external_risks_fetch_jobs(refresh=True, pcs_commune_names=[]).keys())
            incremental_payload = build_external_risks_pending_payload(
                db=local_db,
                refresh=True,
                base_snapshot=_get_external_risks_snapshot(),
                current_key=jobs[0] if jobs else None,
            )

            def pre_fetch_callback(key: str, completed: int, total: int) -> None:
                incremental_payload.update(
                    build_external_risks_pending_payload(
                        db=local_db,
                        refresh=True,
                        base_snapshot=incremental_payload,
                        current_key=key,
                    )
                )
                incremental_payload["refresh"] = {
                    "in_progress": True,
                    "completed": completed,
                    "total": total,
                    "current": key,
                }
                _set_external_risks_snapshot(incremental_payload)

            def progress_callback(key: str, data: dict, completed: int, total: int) -> None:
                incremental_payload[key] = data
                incremental_payload["refresh"] = {
                    "in_progress": True,
                    "completed": completed,
                    "total": total,
                    "current": key,
                }
                _set_external_risks_snapshot(incremental_payload)

            final_payload = build_external_risks_payload(
                refresh=True,
                db=local_db,
                progress_callback=progress_callback,
                pre_fetch_callback=pre_fetch_callback,
            )
            _set_external_risks_snapshot(final_payload)
        except Exception as exc:
            error_payload = _get_external_risks_snapshot() or build_external_risks_pending_payload(db=None, refresh=True)
            error_payload["refresh"] = {
                "in_progress": False,
                "completed": 0,
                "total": len(jobs) if 'jobs' in locals() else 14,
                "current": "Erreur",
            }
            error_payload.setdefault("errors", {})["refresh"] = str(exc)
            _set_external_risks_snapshot(error_payload)
        finally:
            if local_db is not None:
                local_db.close()
            with _external_risks_refresh_lock:
                _external_risks_refresh_in_progress = False

    Thread(target=run_refresh, daemon=True).start()


def get_external_risks_payload(refresh: bool = False, db: Session | None = None) -> dict:
    snapshot = _get_external_risks_snapshot()
    has_snapshot = bool(snapshot and any(snapshot.get(key) for key in ("meteo_france", "vigicrues", "itinisere", "bison_fute", "georisques", "prefecture_isere", "dauphine_isere", "sncf_isere", "vigieau", "atmo_aura", "anfr_isere", "arcep_isere", "apic_isere", "vigicrues_flash_isere", "electricity_isere", "finess_isere", "groundwater_isere", "isere_opendata")))

    if refresh:
        trigger_external_risks_refresh(db=db)
        jobs_order = list(build_external_risks_fetch_jobs(refresh=True, pcs_commune_names=[]).keys())
        return snapshot or build_external_risks_pending_payload(db=db, refresh=True, current_key=jobs_order[0] if jobs_order else None)

    if has_snapshot:
        return snapshot

    trigger_external_risks_refresh(db=db)
    jobs_order = list(build_external_risks_fetch_jobs(refresh=True, pcs_commune_names=[]).keys())
    return build_external_risks_pending_payload(db=db, refresh=True, current_key=jobs_order[0] if jobs_order else None)


@app.get("/external/isere/risks")
def isere_external_risks(
    refresh: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles(*READ_ROLES)),
):
    return get_external_risks_payload(refresh=refresh, db=db)


@app.get("/operations/bootstrap")
def operations_bootstrap(
    refresh: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    started_at = datetime.utcnow()
    risks_payload = get_external_risks_payload(refresh=refresh, db=db)
    dashboard_payload = build_dashboard_payload(db, user, external_risks=risks_payload)
    municipalities_payload = list_municipalities(db=db, user=user)
    events_payload = list_events(db=db, user=user)
    logs_payload = list_logs(db=db, user=user)

    users_payload = []
    if user.role == "admin":
        users_payload = db.query(User).order_by(User.created_at.desc()).all()

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


@app.get("/api/itinisere/events")
def interactive_map_itinisere_events(
    refresh: bool = False,
    limit: int = 60,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    safe_limit = max(10, min(limit, 120))
    return fetch_itinisere_disruptions(limit=safe_limit, force_refresh=refresh)


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


@app.get("/api/finess/isere/resources")
def interactive_map_finess_isere_resources(
    refresh: bool = False,
    limit: int = 5000,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    safe_limit = max(200, min(limit, 100000))
    return fetch_finess_isere_resources(force_refresh=refresh, limit=safe_limit)


@app.get("/api/hubeau/isere/groundwater")
def interactive_map_hubeau_groundwater(
    refresh: bool = False,
    station_limit: int = 8,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    safe_limit = max(3, min(station_limit, 20))
    return fetch_hubeau_isere_groundwater(force_refresh=refresh, station_limit=safe_limit)


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
            "electricity_isere": risks_payload.get("electricity_isere") or {},
            "groundwater_isere": risks_payload.get("groundwater_isere") or {},
            "isere_opendata": risks_payload.get("isere_opendata") or {},
        },
        "crisis_municipalities": [MunicipalityOut.model_validate(c).model_dump() for c in crisis],
        "timeline": [OperationalLogOut.model_validate(log).model_dump() for log in latest_logs],
    }


@app.post("/weather", response_model=WeatherAlertOut)
def create_weather_alert(alert: WeatherAlertCreate, db: Session = Depends(get_db), _: User = Depends(require_roles(*EDIT_ROLES))):
    transition = (alert.previous_level.lower(), alert.level.lower())
    if transition not in ALLOWED_WEATHER_TRANSITIONS:
        raise HTTPException(400, "Transitions autorisées: jaune→orange et orange→rouge")

    entity = WeatherAlert(**alert.model_dump())
    db.add(entity)
    db.commit()
    db.refresh(entity)
    run_weather_cleanup_if_due(db)
    return entity


@app.get("/weather/history", response_model=list[WeatherAlertOut])
def list_weather_alerts(db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    run_weather_cleanup_if_due(db)
    return db.query(WeatherAlert).order_by(WeatherAlert.created_at.desc()).all()


@app.post("/weather/{alert_id}/validate")
def validate_weather(alert_id: int, db: Session = Depends(get_db), _: User = Depends(require_roles(*EDIT_ROLES))):
    alert = db.get(WeatherAlert, alert_id)
    if not alert:
        raise HTTPException(404, "Alerte introuvable")
    alert.pcs_validated = True
    db.commit()
    return {"status": "validated", "manual_dispatch_required": True}


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


@app.post("/municipalities/{municipality_id}/documents")
def upload_municipality_docs(
    municipality_id: int,
    orsec_plan: UploadFile | None = File(None),
    convention: UploadFile | None = File(None),
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "ope", "mairie")),
):
    municipality = ensure_municipality_scope(user, db, municipality_id)

    base_dir = Path(settings.upload_dir) / "municipalities"
    base_dir.mkdir(parents=True, exist_ok=True)

    if orsec_plan:
        safe_name = sanitize_upload_filename(orsec_plan.filename)
        ensure_allowed_extension(safe_name)
        orsec_path = base_dir / f"{municipality_id}_orsec_{safe_name}"
        orsec_path.write_bytes(orsec_plan.file.read())
        municipality.orsec_plan_file = str(orsec_path)

    if convention:
        safe_name = sanitize_upload_filename(convention.filename)
        ensure_allowed_extension(safe_name)
        convention_path = base_dir / f"{municipality_id}_convention_{safe_name}"
        convention_path.write_bytes(convention.file.read())
        municipality.convention_file = str(convention_path)

    db.commit()
    return {"status": "uploaded", "orsec_plan_file": municipality.orsec_plan_file, "convention_file": municipality.convention_file}


@app.get("/municipalities/{municipality_id}/documents/{doc_type}")
def get_municipality_document(
    municipality_id: int,
    doc_type: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    municipality = ensure_municipality_scope(user, db, municipality_id)

    path = municipality.orsec_plan_file if doc_type == "orsec_plan" else municipality.convention_file if doc_type == "convention" else None
    if not path:
        raise HTTPException(404, "Document introuvable")

    file_path = Path(path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "Document introuvable")

    return FileResponse(path=file_path, filename=file_path.name)


@app.delete("/municipalities/{municipality_id}/documents/{doc_type}")
def delete_municipality_document(
    municipality_id: int,
    doc_type: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles("admin", "ope", "mairie")),
):
    municipality = ensure_municipality_scope(user, db, municipality_id)

    if doc_type not in {"orsec_plan", "convention"}:
        raise HTTPException(400, "Type de document invalide")

    current_path = municipality.orsec_plan_file if doc_type == "orsec_plan" else municipality.convention_file
    if not current_path:
        raise HTTPException(404, "Document introuvable")

    file_path = Path(current_path)
    if file_path.exists() and file_path.is_file():
        file_path.unlink()

    if doc_type == "orsec_plan":
        municipality.orsec_plan_file = None
    else:
        municipality.convention_file = None

    db.commit()
    return {"status": "deleted", "id": municipality_id, "doc_type": doc_type}


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
    user: User = Depends(require_roles("admin", "ope", "mairie")),
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
    user: User = Depends(require_roles("admin", "ope", "mairie")),
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
def update_event_status(
    event_id: int,
    data: IncidentEventStatusUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*EDIT_ROLES, "mairie")),
):
    event = db.get(IncidentEvent, event_id)
    if not event:
        raise HTTPException(404, "Évènement introuvable")

    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None or event.municipality_id != municipality_id:
            raise HTTPException(403, "Accès refusé à cette commune")

    event.status = data.status
    db.commit()
    db.refresh(event)
    return event


@app.delete("/events/{event_id}")
def delete_event(
    event_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*EDIT_ROLES, "mairie")),
):
    event = db.get(IncidentEvent, event_id)
    if not event:
        raise HTTPException(404, "Évènement introuvable")

    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None or event.municipality_id != municipality_id:
            raise HTTPException(403, "Accès refusé à cette commune")

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


def compute_pcs_recommended_level(alert_level: str, hazard_type: str) -> str:
    normalized = (alert_level or "jaune").lower().strip()
    if normalized == "rouge":
        return "crise_majeure"
    if normalized == "orange":
        return "activation_pc"
    if hazard_type in {"feu_foret", "inondation"}:
        return "pre_alerte_renforcee" if normalized == "jaune" else "veille"
    return "veille"


def compute_preparedness_score(logs: list[OperationalLog], checklist_items: list[str]) -> int:
    if not checklist_items:
        return 0
    validated = sum(1 for item in checklist_items if any(item.lower().split(" ")[0] in (log.description or "").lower() for log in logs))
    status_bonus = sum(1 for log in logs if (log.status or "") in {"suivi", "clos"})
    raw_score = int(((validated + min(status_bonus, len(checklist_items))) / (2 * len(checklist_items))) * 100)
    return max(0, min(100, raw_score))


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
    user: User = Depends(require_roles(*EDIT_ROLES, "mairie")),
):
    entry = db.get(OperationalLog, log_id)
    if not entry:
        raise HTTPException(404, "Entrée introuvable")

    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None or entry.municipality_id != municipality_id:
            raise HTTPException(403, "Accès refusé à cette commune")

    entry.status = data.status
    db.commit()
    db.refresh(entry)
    return entry


@app.delete("/logs/{log_id}")
def delete_log(
    log_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*EDIT_ROLES, "mairie")),
):
    entry = db.get(OperationalLog, log_id)
    if not entry:
        raise HTTPException(404, "Entrée introuvable")

    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None or entry.municipality_id != municipality_id:
            raise HTTPException(403, "Accès refusé à cette commune")

    db.delete(entry)
    db.commit()
    return {"status": "deleted", "id": log_id}


@app.put("/logs/{log_id}", response_model=OperationalLogOut)
def update_log(
    log_id: int,
    data: OperationalLogUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*EDIT_ROLES, "mairie")),
):
    entry = db.get(OperationalLog, log_id)
    if not entry:
        raise HTTPException(404, "Entrée introuvable")

    event = db.get(IncidentEvent, entry.event_id) if entry.event_id else None

    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        event_municipality_id = event.municipality_id if event else entry.municipality_id
        if municipality_id is None or event_municipality_id != municipality_id:
            raise HTTPException(403, "Accès refusé à cette commune")

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


@app.get("/mco/timeline")
def mco_timeline(
    event_id: int | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=2000),
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    query = db.query(OperationalLog).order_by(OperationalLog.event_time.asc(), OperationalLog.created_at.asc())
    if event_id:
        query = query.filter(OperationalLog.event_id == event_id)
    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None:
            return {"timeline": [], "certification_hash": None}
        query = query.filter(OperationalLog.municipality_id == municipality_id)
    rows = query.limit(limit).all()
    timeline = [
        {
            "id": row.id,
            "timestamp": row.event_time.isoformat() if row.event_time else row.created_at.isoformat(),
            "type": row.event_type,
            "description": row.description,
            "action": row.actions_taken,
            "assigned_to": row.assigned_to,
            "assigned_role": row.assigned_role,
            "status": row.status,
            "danger_level": row.danger_level,
        }
        for row in rows
    ]
    certified_payload = json.dumps(timeline, ensure_ascii=False, sort_keys=True).encode("utf-8")
    certification_hash = hashlib.sha256(certified_payload).hexdigest() if timeline else None
    return {"timeline": timeline, "certification_hash": certification_hash}


@app.get("/pcs/scenarios", response_model=list[ScenarioTemplateOut])
def list_pcs_scenarios(db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    ensure_default_scenario_templates(db)
    templates = db.query(ScenarioTemplate).order_by(ScenarioTemplate.name.asc()).all()
    result: list[ScenarioTemplateOut] = []
    for template in templates:
        result.append(
            ScenarioTemplateOut(
                id=template.id,
                name=template.name,
                hazard_type=template.hazard_type,
                severity=template.severity,
                description=template.description,
                checklist=parse_json_list(template.default_checklist),
                reflex_sheet_template=template.reflex_sheet_template,
                created_at=template.created_at,
            )
        )
    return result


@app.post("/pcs/guidance", response_model=PcsGuidanceOut)
def create_pcs_guidance(
    data: PcsGuidanceRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*EDIT_ROLES, "mairie")),
):
    municipality_id = data.municipality_id
    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
    if municipality_id:
        municipality = db.get(Municipality, municipality_id)
        if not municipality:
            raise HTTPException(404, "Commune introuvable")
    ensure_default_scenario_templates(db)
    template = (
        db.query(ScenarioTemplate)
        .filter(ScenarioTemplate.hazard_type == data.hazard_type)
        .order_by(ScenarioTemplate.id.asc())
        .first()
    )
    checklist = parse_json_list(template.default_checklist if template else "[]")
    recommended = compute_pcs_recommended_level(data.alert_level, data.hazard_type)
    reflex_sheet = template.reflex_sheet_template if template else f"Fiche réflexe {data.hazard_type}: appliquer protocole standard."
    guidance = PcsGuidanceRun(
        municipality_id=municipality_id,
        hazard_type=data.hazard_type,
        alert_level=data.alert_level,
        recommended_level=recommended,
        current_step="qualification",
        checklist_json=json.dumps(checklist, ensure_ascii=False),
        reflex_sheet_text=reflex_sheet,
        triggered_by_id=user.id,
    )
    db.add(guidance)
    db.commit()
    db.refresh(guidance)
    return PcsGuidanceOut(
        id=guidance.id,
        municipality_id=guidance.municipality_id,
        hazard_type=guidance.hazard_type,
        alert_level=guidance.alert_level,
        recommended_level=guidance.recommended_level,
        current_step=guidance.current_step,
        checklist=parse_json_list(guidance.checklist_json),
        reflex_sheet=guidance.reflex_sheet_text,
        created_at=guidance.created_at,
    )


@app.post("/exercises", response_model=ExerciseRunOut)
def create_exercise_run(
    data: ExerciseRunCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*EDIT_ROLES, "mairie")),
):
    ensure_default_scenario_templates(db)
    scenario = db.get(ScenarioTemplate, data.scenario_id)
    if not scenario:
        raise HTTPException(404, "Scénario introuvable")
    municipality_id = data.municipality_id
    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
    if municipality_id and not db.get(Municipality, municipality_id):
        raise HTTPException(404, "Commune introuvable")
    exercise = ExerciseRun(
        scenario_id=data.scenario_id,
        municipality_id=municipality_id,
        mode=data.mode,
        status="en_cours",
        created_by_id=user.id,
    )
    db.add(exercise)
    db.commit()
    db.refresh(exercise)
    return exercise


@app.get("/exercises", response_model=list[ExerciseRunOut])
def list_exercise_runs(db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    query = db.query(ExerciseRun).order_by(ExerciseRun.started_at.desc())
    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None:
            return []
        query = query.filter(ExerciseRun.municipality_id == municipality_id)
    return query.limit(150).all()


@app.get("/cartography/multi-hazards")
def get_multi_hazards_cartography(db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    municipalities = db.query(Municipality).all()
    vulnerable = [m for m in municipalities if (m.population or 0) > 5000 or (m.shelter_capacity or 0) < 150]
    sensitive_points = db.query(MapPoint).order_by(MapPoint.created_at.desc()).limit(500).all()
    risk_layers = {
        "zones_inondables": [{"municipality_id": m.id, "name": m.name, "risk": "elevated" if m.vigilance_color in {"orange", "rouge"} else "watch"} for m in municipalities],
        "points_sensibles": [{"id": p.id, "name": p.name, "category": p.category, "lat": p.lat, "lon": p.lon} for p in sensitive_points],
        "populations_vulnerables": [{"municipality_id": m.id, "name": m.name, "population": m.population or 0, "shelter_capacity": m.shelter_capacity or 0} for m in vulnerable],
    }
    return {"updated_at": utc_timestamp(), "layers": risk_layers}


@app.get("/documents/official")
def generate_official_documents(
    event_id: int | None = Query(default=None),
    exercise_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    logs_query = db.query(OperationalLog).order_by(OperationalLog.event_time.asc())
    if event_id:
        logs_query = logs_query.filter(OperationalLog.event_id == event_id)
    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        if municipality_id is None:
            raise HTTPException(404, "Commune introuvable")
        logs_query = logs_query.filter(OperationalLog.municipality_id == municipality_id)
    logs = logs_query.limit(1200).all()
    timeline_rows = [
        {
            "ts": (log.event_time or log.created_at).isoformat(),
            "type": log.event_type,
            "description": log.description,
            "actions": log.actions_taken,
            "assigned_role": log.assigned_role,
        }
        for log in logs
    ]
    timeline_hash = hashlib.sha256(json.dumps(timeline_rows, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest() if timeline_rows else None
    exercise_summary = None
    if exercise_id:
        exercise = db.get(ExerciseRun, exercise_id)
        if not exercise:
            raise HTTPException(404, "Exercice introuvable")
        scenario = db.get(ScenarioTemplate, exercise.scenario_id)
        checklist = parse_json_list(scenario.default_checklist if scenario else "[]")
        linked_logs = logs if not exercise.municipality_id else [log for log in logs if log.municipality_id == exercise.municipality_id]
        score = compute_preparedness_score(linked_logs, checklist)
        exercise.score_preparedness = score
        if exercise.status != "termine":
            exercise.status = "termine"
            exercise.ended_at = datetime.utcnow()
        db.commit()
        exercise_summary = {
            "exercise_id": exercise.id,
            "scenario": scenario.name if scenario else "N/A",
            "mode": exercise.mode,
            "score_preparedness": score,
            "status": exercise.status,
        }

    report_title = "Compte-rendu de crise"
    return {
        "title": report_title,
        "generated_at": utc_timestamp(),
        "crisis_report": {
            "events_count": len({log.event_id for log in logs if log.event_id}),
            "entries_count": len(logs),
            "open_entries": len([log for log in logs if log.status in {"nouveau", "en_cours"}]),
        },
        "certified_timeline": {"hash_sha256": timeline_hash, "entries": timeline_rows[-300:]},
        "exercise_report": exercise_summary,
    }


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
        "municipality_id", "location", "source", "assigned_to", "assigned_role", "tags", "description", "actions_taken", "next_update_due",
    ])
    for row in rows:
        writer.writerow([
            row.id, row.event_id, row.event_time, row.created_at, row.event_type, row.status, row.danger_level, row.target_scope,
            row.municipality_id, row.location, row.source, row.assigned_to, row.assigned_role, row.tags, row.description, row.actions_taken, row.next_update_due,
        ])

    output.seek(0)
    filename = f"main-courante-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.post("/logs/{log_id}/attachment")
def upload_attachment(log_id: int, file: UploadFile = File(...), db: Session = Depends(get_db), _: User = Depends(require_roles(*EDIT_ROLES))):
    safe_name = sanitize_upload_filename(file.filename)
    ensure_allowed_extension(safe_name)
    log = db.get(OperationalLog, log_id)
    if not log:
        raise HTTPException(404, "Entrée introuvable")
    dst = Path(settings.upload_dir) / f"{log_id}_{safe_name}"
    dst.write_bytes(file.file.read())
    log.attachment_path = str(dst)
    db.commit()
    return {"path": str(dst)}


@app.get("/reports/pdf")
def export_report(db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    path = generate_pdf_report(db)
    return {"report": path, "format": "pdf"}


@app.post("/shares/{municipality_id}")
def create_share(municipality_id: int, password: str, db: Session = Depends(get_db), _: User = Depends(require_roles(*EDIT_ROLES))):
    municipality = db.get(Municipality, municipality_id)
    if not municipality:
        raise HTTPException(404, "Commune introuvable")
    validate_password_strength(password)
    token = secrets.token_urlsafe(24)
    share = PublicShare(
        token=token,
        password_hash=hash_password(password),
        municipality_id=municipality_id,
        expires_at=datetime.utcnow() + timedelta(hours=24),
    )
    db.add(share)
    db.commit()
    return {"token": token, "expires_at": share.expires_at}


@app.post("/shares/{token}/access")
def access_share(token: str, payload: ShareAccessRequest, db: Session = Depends(get_db)):
    share = db.query(PublicShare).filter(PublicShare.token == token, PublicShare.active.is_(True)).first()
    if not share or share.expires_at < datetime.utcnow():
        raise HTTPException(404, "Lien indisponible")
    if not verify_password(payload.password, share.password_hash):
        raise HTTPException(401, "Mot de passe invalide")
    municipality = db.get(Municipality, share.municipality_id)
    return {
        "municipality": MunicipalityOut.model_validate(municipality).model_dump(),
        "token": token,
        "expires_at": share.expires_at,
    }


@app.delete("/shares/{token}")
def revoke_share(token: str, db: Session = Depends(get_db), _: User = Depends(require_roles(*EDIT_ROLES))):
    share = db.query(PublicShare).filter(PublicShare.token == token).first()
    if not share:
        raise HTTPException(404, "Lien introuvable")
    share.active = False
    db.commit()
    return {"status": "revoked"}
