from datetime import datetime, timedelta
from pathlib import Path
import re
import secrets
from typing import Callable

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import settings
from .database import Base, engine, get_db
from .models import Municipality, OperationalLog, PublicShare, RiverStation, User, WeatherAlert
from .schemas import (
    MunicipalityCreate,
    MunicipalityOut,
    MunicipalityUpdate,
    OperationalLogCreate,
    OperationalLogOut,
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


app = FastAPI(title=settings.app_name)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

ALLOWED_WEATHER_TRANSITIONS = {("jaune", "orange"), ("orange", "rouge")}
READ_ROLES = {"admin", "ope", "securite", "visiteur", "mairie"}
EDIT_ROLES = {"admin", "ope"}
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

    meteo = fetch_meteo_france_isere()
    meteo_level = (meteo.get("level") or db_meteo_level).lower()
    global_risk = compute_global_risk(meteo_level, crues_level)
    priority_names = [m.name for m in db.query(Municipality).filter(Municipality.pcs_active.is_(True)).all()]
    vigicrues = fetch_vigicrues_isere(priority_names=priority_names)
    itinisere = fetch_itinisere_disruptions(limit=8)
    bison_fute = fetch_bison_fute_traffic()
    georisques = fetch_georisques_isere_summary()
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
    }


@app.get("/public/isere-map")
def public_isere_map():
    return fetch_isere_boundary_geojson()


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
    latest_alert = db.query(WeatherAlert).order_by(WeatherAlert.created_at.desc()).first()
    river_level = db.query(RiverStation).order_by(RiverStation.updated_at.desc()).first()
    crisis_count = db.query(Municipality).filter(Municipality.crisis_mode.is_(True)).count()

    logs_query = db.query(OperationalLog)
    if user.role == "mairie":
        municipality_id = get_user_municipality_id(user, db)
        logs_query = logs_query.filter(OperationalLog.municipality_id == municipality_id)
        crisis_count = 1 if municipality_id and db.get(Municipality, municipality_id).crisis_mode else 0

    logs = logs_query.order_by(OperationalLog.created_at.desc()).limit(5).all()

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


@app.get("/external/isere/risks")
def isere_external_risks(db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    meteo = fetch_meteo_france_isere()
    priority_names = [m.name for m in db.query(Municipality).filter(Municipality.pcs_active.is_(True)).all()]
    vigicrues = fetch_vigicrues_isere(priority_names=priority_names)
    itinisere = fetch_itinisere_disruptions()
    bison_fute = fetch_bison_fute_traffic()
    georisques = fetch_georisques_isere_summary()
    return {
        "updated_at": utc_timestamp(),
        "meteo_france": meteo,
        "vigicrues": vigicrues,
        "itinisere": itinisere,
        "bison_fute": bison_fute,
        "georisques": georisques,
    }


@app.get("/api/meteo-france/vigilance")
def interactive_map_meteo_vigilance():
    return fetch_meteo_france_isere()


@app.get("/api/vigicrues/geojson")
def interactive_map_vigicrues_geojson(db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    priority_names = [m.name for m in db.query(Municipality).filter(Municipality.pcs_active.is_(True)).all()]
    vigicrues = fetch_vigicrues_isere(priority_names=priority_names, station_limit=60)
    return vigicrues_geojson_from_stations(vigicrues.get("stations", []))


@app.get("/api/itinisere/events")
def interactive_map_itinisere_events(_: User = Depends(require_roles(*READ_ROLES))):
    return fetch_itinisere_disruptions()


@app.get("/supervision/overview")
def supervision_overview(db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    meteo = fetch_meteo_france_isere()
    priority_names = [m.name for m in db.query(Municipality).filter(Municipality.pcs_active.is_(True)).all()]
    vigicrues = fetch_vigicrues_isere(priority_names=priority_names, station_limit=12)
    itinisere = fetch_itinisere_disruptions(limit=8)
    bison_fute = fetch_bison_fute_traffic()
    georisques = fetch_georisques_isere_summary()
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
        return db.query(Municipality).filter(Municipality.name == user.municipality_name).all()
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
    _: User = Depends(require_roles(*EDIT_ROLES)),
):
    municipality = db.get(Municipality, municipality_id)
    if not municipality:
        raise HTTPException(404, "Commune introuvable")

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
    _: User = Depends(require_roles(*READ_ROLES)),
):
    municipality = db.get(Municipality, municipality_id)
    if not municipality:
        raise HTTPException(404, "Commune introuvable")

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
    _: User = Depends(require_roles(*EDIT_ROLES)),
):
    municipality = db.get(Municipality, municipality_id)
    if not municipality:
        raise HTTPException(404, "Commune introuvable")

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
    entry = OperationalLog(**data.model_dump(), created_by_id=user.id)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


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
