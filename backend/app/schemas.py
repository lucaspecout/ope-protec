from datetime import datetime

from pydantic import BaseModel, Field


class LoginIn(BaseModel):
    username: str
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    must_change_password: bool = False


class PasswordChangeIn(BaseModel):
    new_password: str = Field(min_length=8)


class UserOut(BaseModel):
    id: int
    username: str
    role: str
    must_change_password: bool


class MunicipalityIn(BaseModel):
    name: str
    insee_code: str | None = None
    crisis_mode: bool = False
    contact_phone: str | None = None
    contact_email: str | None = None


class MunicipalityOut(MunicipalityIn):
    id: int


class SourceSnapshotOut(BaseModel):
    source: str
    status: str
    message: str | None = None
    payload: dict
    fetched_at: datetime


class SituationOut(BaseModel):
    generated_at: datetime
    sources: list[SourceSnapshotOut]
    municipalities_in_crisis: int
