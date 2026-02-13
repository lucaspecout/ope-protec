from datetime import datetime, timedelta
from pathlib import Path
import secrets

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
    Token,
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


app = FastAPI(title=settings.app_name)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def bootstrap_default_admin() -> None:
    with Session(bind=engine) as db:
        admin = db.query(User).filter(User.username == "admin").first()
        if admin:
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


@app.get("/health")
def healthcheck():
    return {"status": "ok", "service": settings.app_name}


@app.post("/auth/register", response_model=UserOut)
def register(user: UserCreate, db: Session = Depends(get_db)):
    if db.query(User).count() >= 20:
        raise HTTPException(400, "Limite de 20 utilisateurs atteinte")
    if db.query(User).filter(User.username == user.username).first():
        raise HTTPException(400, "Identifiant déjà utilisé")
    entity = User(username=user.username, hashed_password=hash_password(user.password), role=user.role)
    db.add(entity)
    db.commit()
    db.refresh(entity)
    return entity


@app.post("/auth/login", response_model=Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(401, "Identifiants invalides")
    return {
        "access_token": create_access_token(user.username),
        "token_type": "bearer",
        "must_change_password": user.must_change_password,
    }


@app.post("/auth/change-password")
def change_password(payload: PasswordChangeRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(400, "Mot de passe actuel invalide")
    user.hashed_password = hash_password(payload.new_password)
    user.must_change_password = False
    db.commit()
    return {"status": "password_updated"}


@app.get("/dashboard")
def dashboard(db: Session = Depends(get_db), _: User = Depends(get_active_user)):
    latest_alert = db.query(WeatherAlert).order_by(WeatherAlert.created_at.desc()).first()
    river_level = db.query(RiverStation).order_by(RiverStation.updated_at.desc()).first()
    crisis_count = db.query(Municipality).filter(Municipality.crisis_mode.is_(True)).count()
    logs = db.query(OperationalLog).order_by(OperationalLog.created_at.desc()).limit(5).all()
    return {
        "vigilance": latest_alert.level if latest_alert else "vert",
        "crues": river_level.level if river_level else "vert",
        "global_risk": "rouge" if any(x == "rouge" for x in [latest_alert.level if latest_alert else "vert", river_level.level if river_level else "vert"]) else "orange",
        "communes_crise": crisis_count,
        "latest_logs": [OperationalLogOut.model_validate(log).model_dump() for log in logs],
    }


@app.get("/external/isere/risks")
def isere_external_risks(_: User = Depends(get_active_user)):
    meteo = fetch_meteo_france_isere()
    vigicrues = fetch_vigicrues_isere()
    return {
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "meteo_france": meteo,
        "vigicrues": vigicrues,
    }


@app.post("/weather", response_model=WeatherAlertOut)
def create_weather_alert(alert: WeatherAlertCreate, db: Session = Depends(get_db), _: User = Depends(get_active_user)):
    entity = WeatherAlert(**alert.model_dump())
    db.add(entity)
    db.commit()
    db.refresh(entity)
    cleanup_old_weather_alerts(db)
    return entity


@app.post("/weather/{alert_id}/validate")
def validate_weather(alert_id: int, db: Session = Depends(get_db), _: User = Depends(get_active_user)):
    alert = db.get(WeatherAlert, alert_id)
    if not alert:
        raise HTTPException(404, "Alerte introuvable")
    alert.pcs_validated = True
    db.commit()
    return {"status": "validated"}


@app.post("/municipalities", response_model=MunicipalityOut)
def create_municipality(data: MunicipalityCreate, db: Session = Depends(get_db), _: User = Depends(get_active_user)):
    municipality = Municipality(**data.model_dump())
    db.add(municipality)
    db.commit()
    db.refresh(municipality)
    return municipality


@app.get("/municipalities", response_model=list[MunicipalityOut])
def list_municipalities(db: Session = Depends(get_db), _: User = Depends(get_active_user)):
    return db.query(Municipality).order_by(Municipality.name).all()


@app.post("/municipalities/{municipality_id}/crisis")
def toggle_crisis(municipality_id: int, db: Session = Depends(get_db), _: User = Depends(get_active_user)):
    municipality = db.get(Municipality, municipality_id)
    if not municipality:
        raise HTTPException(404, "Commune introuvable")
    municipality.crisis_mode = not municipality.crisis_mode
    db.commit()
    return {"id": municipality_id, "crisis_mode": municipality.crisis_mode}


@app.post("/logs", response_model=OperationalLogOut)
def create_log(data: OperationalLogCreate, db: Session = Depends(get_db), user: User = Depends(get_active_user)):
    entry = OperationalLog(**data.model_dump(), created_by_id=user.id)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@app.post("/logs/{log_id}/attachment")
def upload_attachment(log_id: int, file: UploadFile = File(...), db: Session = Depends(get_db), _: User = Depends(get_active_user)):
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
def export_report(db: Session = Depends(get_db), _: User = Depends(get_active_user)):
    path = generate_pdf_report(db)
    return {"report": path}


@app.post("/shares/{municipality_id}")
def create_share(municipality_id: int, password: str, db: Session = Depends(get_db), _: User = Depends(get_active_user)):
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
