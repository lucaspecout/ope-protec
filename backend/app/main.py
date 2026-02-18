from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
import re
import secrets
from threading import Lock, Thread
from time import sleep
from typing import Callable

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from .config import settings
from .database import Base, engine, get_db
from .models import MapPoint, Municipality, MunicipalityDocument, OperationalLog, PublicShare, RiverStation, User, WeatherAlert
from .schemas import (
    MapPointCreate,
    MapPointOut,
    MunicipalityCreate,
    MunicipalityDocumentOut,
    MunicipalityOut,
    MunicipalityUpdate,
    OperationalLogCreate,
    OperationalLogOut,
    OperationalLogStatusUpdate,
    PasswordChangeRequest,
    ShareAccessRequest,
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
    fetch_bison_fute_traffic,
    cleanup_old_weather_alerts,
    fetch_georisques_isere_summary,
    fetch_isere_boundary_geojson,
    fetch_meteo_france_isere,
    fetch_itinisere_disruptions,
    fetch_prefecture_isere_news,
    fetch_vigicrues_isere,
    generate_pdf_report,
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


app = FastAPI(title=settings.app_name)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=800)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

ALLOWED_WEATHER_TRANSITIONS = {("jaune", "orange"), ("orange", "rouge")}
READ_ROLES = {"admin", "ope", "securite", "visiteur", "mairie"}
EDIT_ROLES = {"admin", "ope"}

EXTERNAL_REFRESH_INTERVAL_SECONDS = 90
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
    },
}
ALLOWED_DOC_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}


def utc_timestamp() -> str:
    return datetime.utcnow().isoformat() + "Z"


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
    try:
        fetch_meteo_france_isere(force_refresh=True)
        fetch_vigicrues_isere(force_refresh=True)
        fetch_itinisere_disruptions(force_refresh=True)
        fetch_bison_fute_traffic(force_refresh=True)
        fetch_georisques_isere_summary(force_refresh=True)
    except Exception:
        # Le warmup ne doit jamais empêcher le démarrage de l'API.
        return


def _set_external_risks_snapshot(payload: dict) -> None:
    with _external_risks_snapshot_lock:
        _external_risks_snapshot["updated_at"] = datetime.utcnow()
        _external_risks_snapshot["payload"] = deepcopy(payload)


def _get_external_risks_snapshot() -> dict:
    with _external_risks_snapshot_lock:
        return deepcopy(_external_risks_snapshot.get("payload") or {})


def _continuous_external_refresh() -> None:
    """Met à jour les caches de supervision même sans utilisateur connecté."""
    while True:
        try:
            payload = build_external_risks_payload(refresh=True)
            _set_external_risks_snapshot(payload)
        except Exception:
            # La boucle continue même en cas d'erreur externe.
            pass
        sleep(EXTERNAL_REFRESH_INTERVAL_SECONDS)


@app.on_event("startup")
def startup_warmup_external_sources() -> None:
    Thread(target=_warmup_external_sources, daemon=True).start()
    Thread(target=_continuous_external_refresh, daemon=True).start()


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


@app.post("/auth/login", response_model=Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(401, "Utilisateur ou mot de passe incorrect")
    return {
        "access_token": create_access_token(user.username),
        "token_type": "bearer",
        "must_change_password": user.must_change_password,
    }


@app.get("/auth/me", response_model=UserOut)
def auth_me(user: User = Depends(get_current_user)):
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


def build_external_risks_payload(refresh: bool = False) -> dict:
    errors: dict[str, str] = {}
    errors_lock = Lock()

    def safe_fetch(key: str, fetcher: Callable[[], dict], fallback: dict) -> dict:
        try:
            return fetcher()
        except Exception as exc:
            with errors_lock:
                errors[key] = str(exc)
            payload = dict(fallback)
            payload.setdefault("status", "unavailable")
            payload.setdefault("error", str(exc))
            payload.setdefault("updated_at", utc_timestamp())
            return payload

    fetch_jobs: dict[str, tuple[Callable[[], dict], dict]] = {
        "meteo_france": (lambda: fetch_meteo_france_isere(force_refresh=refresh), {"level": "vert", "title": "Météo-France indisponible"}),
        "vigicrues": (lambda: fetch_vigicrues_isere(force_refresh=refresh), {"level": "vert", "stations": [], "alerts": []}),
        "itinisere": (lambda: fetch_itinisere_disruptions(force_refresh=refresh), {"status": "degraded", "events": [], "events_total": 0}),
        "bison_fute": (lambda: fetch_bison_fute_traffic(force_refresh=refresh), {"status": "degraded", "alerts": []}),
        "georisques": (lambda: fetch_georisques_isere_summary(force_refresh=refresh), {"status": "degraded", "details": []}),
        "prefecture_isere": (lambda: fetch_prefecture_isere_news(force_refresh=refresh), {"status": "degraded", "articles": []}),
    }

    results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=len(fetch_jobs)) as executor:
        future_map = {
            key: executor.submit(safe_fetch, key, fetcher, fallback)
            for key, (fetcher, fallback) in fetch_jobs.items()
        }
        for key, future in future_map.items():
            results[key] = future.result()

    payload = {
        "updated_at": utc_timestamp(),
        "meteo_france": results["meteo_france"],
        "vigicrues": results["vigicrues"],
        "itinisere": results["itinisere"],
        "bison_fute": results["bison_fute"],
        "georisques": results["georisques"],
        "prefecture_isere": results["prefecture_isere"],
    }
    if errors:
        payload["errors"] = errors
    return payload


def get_external_risks_payload(refresh: bool = False) -> dict:
    if refresh:
        payload = build_external_risks_payload(refresh=True)
        _set_external_risks_snapshot(payload)
        return payload

    snapshot = _get_external_risks_snapshot()
    if snapshot and any(snapshot.get(key) for key in ("meteo_france", "vigicrues", "itinisere", "bison_fute", "georisques", "prefecture_isere")):
        return snapshot

    payload = build_external_risks_payload(refresh=True)
    _set_external_risks_snapshot(payload)
    return payload


@app.get("/external/isere/risks")
def isere_external_risks(
    refresh: bool = False,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    return get_external_risks_payload(refresh=refresh)


@app.get("/operations/bootstrap")
def operations_bootstrap(
    refresh: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(*READ_ROLES)),
):
    started_at = datetime.utcnow()
    risks_payload = get_external_risks_payload(refresh=refresh)
    dashboard_payload = build_dashboard_payload(db, user, external_risks=risks_payload)
    municipalities_payload = list_municipalities(db=db, user=user)
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
            "log_count": len(logs_payload),
        },
        "dashboard": dashboard_payload,
        "external_risks": risks_payload,
        "municipalities": [MunicipalityOut.model_validate(item).model_dump() for item in municipalities_payload],
        "logs": [OperationalLogOut.model_validate(item).model_dump() for item in logs_payload],
        "users": [UserOut.model_validate(item).model_dump() for item in users_payload],
    }


@app.get("/api/meteo-france/vigilance")
def interactive_map_meteo_vigilance():
    return fetch_meteo_france_isere()


@app.get("/api/vigicrues/geojson")
def interactive_map_vigicrues_geojson(
    refresh: bool = False,
    _: User = Depends(require_roles(*READ_ROLES)),
):
    vigicrues = fetch_vigicrues_isere(station_limit=60, force_refresh=refresh)
    return vigicrues_geojson_from_stations(vigicrues.get("stations", []))


@app.get("/api/itinisere/events")
def interactive_map_itinisere_events(refresh: bool = False, _: User = Depends(require_roles(*READ_ROLES))):
    return fetch_itinisere_disruptions(force_refresh=refresh)


@app.get("/supervision/overview")
def supervision_overview(
    refresh: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(require_roles(*READ_ROLES)),
):
    risks_payload = get_external_risks_payload(refresh=refresh)
    meteo = risks_payload.get("meteo_france") or {}
    vigicrues = risks_payload.get("vigicrues") or {}
    itinisere = risks_payload.get("itinisere") or {}
    bison_fute = risks_payload.get("bison_fute") or {}
    georisques = risks_payload.get("georisques") or {}
    prefecture = risks_payload.get("prefecture_isere") or {}
    crisis = db.query(Municipality).filter(Municipality.crisis_mode.is_(True)).all()
    latest_logs = db.query(OperationalLog).order_by(OperationalLog.created_at.desc()).limit(10).all()
    return {
        "updated_at": utc_timestamp(),
        "alerts": {
            "meteo": meteo,
            "vigicrues": vigicrues,
            "itinisere": itinisere,
            "bison_fute": bison_fute,
            "georisques": georisques,
            "prefecture_isere": prefecture,
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
    cleanup_old_weather_alerts(db)
    return entity


@app.get("/weather/history", response_model=list[WeatherAlertOut])
def list_weather_alerts(db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    cleanup_old_weather_alerts(db)
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
    municipality = Municipality(**data.model_dump())
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

    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(municipality, key, value)

    db.commit()
    db.refresh(municipality)
    return municipality


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
    return [serialize_document(doc, db) for doc in docs]


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


@app.post("/logs", response_model=OperationalLogOut)
def create_log(data: OperationalLogCreate, db: Session = Depends(get_db), user: User = Depends(require_roles(*EDIT_ROLES))):
    payload = data.model_dump()
    payload["event_time"] = payload.get("event_time") or datetime.utcnow()
    target_scope = payload.get("target_scope", "departemental")
    municipality_id = payload.get("municipality_id")
    linked_municipality = None

    if target_scope in {"commune", "pcs"}:
        if not municipality_id:
            raise HTTPException(400, "Sélectionnez une commune pour ce type d'évènement")
        municipality = db.get(Municipality, municipality_id)
        if not municipality:
            raise HTTPException(404, "Commune introuvable")
        if target_scope == "pcs" and not municipality.pcs_active:
            raise HTTPException(400, "La commune sélectionnée n'a pas de PCS actif")
        linked_municipality = municipality
    else:
        payload["municipality_id"] = None

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
        "id", "event_time", "created_at", "event_type", "status", "danger_level", "target_scope",
        "municipality_id", "location", "source", "assigned_to", "tags", "description", "actions_taken", "next_update_due",
    ])
    for row in rows:
        writer.writerow([
            row.id, row.event_time, row.created_at, row.event_type, row.status, row.danger_level, row.target_scope,
            row.municipality_id, row.location, row.source, row.assigned_to, row.tags, row.description, row.actions_taken, row.next_update_due,
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
