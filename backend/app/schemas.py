from datetime import datetime

from pydantic import BaseModel, EmailStr


class Token(BaseModel):
    access_token: str
    token_type: str
    must_change_password: bool = False


class UserCreate(BaseModel):
    username: str
    password: str
    role: str


class UserOut(BaseModel):
    id: int
    username: str
    role: str

    class Config:
        from_attributes = True


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str


class WeatherAlertCreate(BaseModel):
    risk_type: str
    level: str
    previous_level: str


class WeatherAlertOut(WeatherAlertCreate):
    id: int
    pcs_validated: bool
    created_at: datetime

    class Config:
        from_attributes = True


class MunicipalityCreate(BaseModel):
    name: str
    phone: str
    email: EmailStr
    manager: str


class MunicipalityOut(BaseModel):
    id: int
    name: str
    phone: str
    email: str
    manager: str
    pcs_active: bool
    crisis_mode: bool
    vigilance_color: str

    class Config:
        from_attributes = True


class OperationalLogCreate(BaseModel):
    event_type: str
    description: str


class OperationalLogOut(BaseModel):
    id: int
    event_type: str
    description: str
    created_at: datetime
    created_by_id: int

    class Config:
        from_attributes = True
