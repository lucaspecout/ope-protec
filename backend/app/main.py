from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from .bootstrap import bootstrap
from .config import settings
from .database import Base, SessionLocal, engine, get_db
from .models import Municipality, User
from .schemas import (
    LoginIn,
    MunicipalityIn,
    MunicipalityOut,
    PasswordChangeIn,
    SituationOut,
    SourceSnapshotOut,
    TokenOut,
    UserOut,
)
from .security import create_access_token, decode_access_token, hash_password, verify_password
from .services import latest_snapshots, refresh_and_persist


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        bootstrap(db)
        await refresh_and_persist(db)
    yield


app = FastAPI(title=settings.app_name, version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    username = decode_access_token(token)
    user = db.execute(select(User).where(User.username == username)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


@app.get("/health")
def health(db: Session = Depends(get_db)):
    db.execute(select(1))
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}


@app.post("/auth/login", response_model=TokenOut)
def login(payload: LoginIn, db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.username == payload.username)).scalar_one_or_none()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return TokenOut(access_token=create_access_token(user.username), must_change_password=user.must_change_password)


@app.get("/auth/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return UserOut(id=user.id, username=user.username, role=user.role, must_change_password=user.must_change_password)


@app.post("/auth/change-password")
def change_password(payload: PasswordChangeIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    user.hashed_password = hash_password(payload.new_password)
    user.must_change_password = False
    db.add(user)
    db.commit()
    return {"ok": True}


@app.get("/municipalities", response_model=list[MunicipalityOut])
def list_municipalities(_: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(Municipality).order_by(Municipality.name.asc())).scalars().all()
    return [MunicipalityOut(id=r.id, name=r.name, insee_code=r.insee_code, crisis_mode=r.crisis_mode, contact_phone=r.contact_phone, contact_email=r.contact_email) for r in rows]


@app.post("/municipalities", response_model=MunicipalityOut)
def create_municipality(payload: MunicipalityIn, _: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = Municipality(**payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return MunicipalityOut(id=row.id, **payload.model_dump())


@app.get("/situation", response_model=SituationOut)
async def situation(
    refresh: bool = False,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if refresh:
        await refresh_and_persist(db)

    snapshots = latest_snapshots(db)
    municipalities_in_crisis = db.execute(select(Municipality).where(Municipality.crisis_mode.is_(True))).scalars().all()
    return SituationOut(
        generated_at=datetime.now(timezone.utc),
        municipalities_in_crisis=len(municipalities_in_crisis),
        sources=[
            SourceSnapshotOut(
                source=s.source,
                status=s.status,
                message=s.message,
                payload=s.payload or {},
                fetched_at=s.fetched_at,
            )
            for s in snapshots
        ],
    )
