from datetime import datetime, timedelta
from pathlib import Path
import secrets
from typing import Callable

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
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
    OperationalLogCreate,
    OperationalLogOut,
    PasswordChangeRequest,
    ShareAccessRequest,
    Token,
    TwoFactorToggleRequest,
    UserCreate,
    UserOut,
    WeatherAlertCreate,
    WeatherAlertOut,
)
from .security import create_access_token, hash_password, verify_password
from .services import cleanup_old_weather_alerts, fetch_meteo_france_isere, fetch_vigicrues_isere, generate_pdf_report

Base.metadata.create_all(bind=engine)
Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)


with engine.begin() as conn:
    conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE"))
    conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS municipality_name VARCHAR(120)"))
    conn.execute(text("ALTER TABLE weather_alerts ADD COLUMN IF NOT EXISTS internal_mail_group VARCHAR(255)"))
    conn.execute(text("ALTER TABLE weather_alerts ADD COLUMN IF NOT EXISTS sent_to_internal_group BOOLEAN DEFAULT FALSE"))
    conn.execute(text("ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS contacts TEXT"))
    conn.execute(text("ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS additional_info TEXT"))
    conn.execute(text("ALTER TABLE river_stations ADD COLUMN IF NOT EXISTS is_priority BOOLEAN DEFAULT FALSE"))
    conn.execute(text("ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS municipality_id INTEGER REFERENCES municipalities(id)"))


app = FastAPI(title=settings.app_name)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

ALLOWED_WEATHER_TRANSITIONS = {("jaune", "orange"), ("orange", "rouge")}
READ_ROLES = {"admin", "ope", "securite", "visiteur", "mairie"}
EDIT_ROLES = {"admin", "ope"}


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


@app.post("/auth/register", response_model=UserOut)
def register(user: UserCreate, db: Session = Depends(get_db), creator: User = Depends(require_roles("admin", "ope"))):
    allowed_roles = {"admin", "ope", "securite", "visiteur", "mairie"}
    if user.role not in allowed_roles:
        raise HTTPException(400, "Rôle invalide")
    if creator.role == "ope" and user.role not in {"securite", "visiteur", "mairie"}:
        raise HTTPException(403, "Un opérateur ne peut créer que sécurité, visiteur ou mairie")
    if user.role == "mairie" and not user.municipality_name:
        raise HTTPException(400, "Le rôle mairie nécessite le nom de la commune")

    if db.query(User).count() >= 20:
        raise HTTPException(400, "Limite de 20 utilisateurs atteinte")
    if db.query(User).filter(User.username == user.username).first():
        raise HTTPException(400, "Identifiant déjà utilisé")

    entity = User(
        username=user.username,
        hashed_password=hash_password(user.password),
        role=user.role,
        municipality_name=user.municipality_name if user.role == "mairie" else None,
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

    meteo_level = latest_alert.level if latest_alert else "vert"
    crues_level = river_level.level if river_level else "vert"

    return {
        "vigilance": meteo_level,
        "crues": crues_level,
        "vigilance_risk_type": latest_alert.risk_type if latest_alert else "",
        "global_risk": "rouge" if "rouge" in [meteo_level, crues_level] else "orange" if "orange" in [meteo_level, crues_level] else "jaune" if "jaune" in [meteo_level, crues_level] else "vert",
        "communes_crise": crisis_count,
        "latest_logs": [OperationalLogOut.model_validate(log).model_dump() for log in logs],
    }


@app.get("/external/isere/risks")
def isere_external_risks(db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    meteo = fetch_meteo_france_isere()
    priority_names = [m.name for m in db.query(Municipality).filter(Municipality.pcs_active.is_(True)).all()]
    vigicrues = fetch_vigicrues_isere(priority_names=priority_names)
    return {
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "meteo_france": meteo,
        "vigicrues": vigicrues,
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
        orsec_path = base_dir / f"{municipality_id}_orsec_{orsec_plan.filename}"
        orsec_path.write_bytes(orsec_plan.file.read())
        municipality.orsec_plan_file = str(orsec_path)

    if convention:
        convention_path = base_dir / f"{municipality_id}_convention_{convention.filename}"
        convention_path.write_bytes(convention.file.read())
        municipality.convention_file = str(convention_path)

    db.commit()
    return {"status": "uploaded", "orsec_plan_file": municipality.orsec_plan_file, "convention_file": municipality.convention_file}


@app.post("/municipalities/{municipality_id}/crisis")
def toggle_crisis(municipality_id: int, db: Session = Depends(get_db), _: User = Depends(require_roles(*EDIT_ROLES))):
    municipality = db.get(Municipality, municipality_id)
    if not municipality:
        raise HTTPException(404, "Commune introuvable")
    municipality.crisis_mode = not municipality.crisis_mode
    db.commit()
    return {"id": municipality_id, "crisis_mode": municipality.crisis_mode}


@app.post("/logs", response_model=OperationalLogOut)
def create_log(data: OperationalLogCreate, db: Session = Depends(get_db), user: User = Depends(require_roles(*EDIT_ROLES))):
    entry = OperationalLog(**data.model_dump(), created_by_id=user.id)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@app.post("/logs/{log_id}/attachment")
def upload_attachment(log_id: int, file: UploadFile = File(...), db: Session = Depends(get_db), _: User = Depends(require_roles(*EDIT_ROLES))):
    if not file.filename.lower().endswith((".pdf", ".png", ".jpg", ".jpeg")):
        raise HTTPException(400, "Type de fichier interdit")
    log = db.get(OperationalLog, log_id)
    if not log:
        raise HTTPException(404, "Entrée introuvable")
    dst = Path(settings.upload_dir) / f"{log_id}_{file.filename}"
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
