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
    municipality_name: str | None = None


class UserOut(BaseModel):
    id: int
    username: str
    role: str
    municipality_name: str | None = None
    two_factor_enabled: bool
    must_change_password: bool
    created_at: datetime

    class Config:
        from_attributes = True


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str


class UserUpdate(BaseModel):
    role: str
    municipality_name: str | None = None


class UserPasswordResetRequest(BaseModel):
    new_password: str | None = None


class UserPasswordResetResponse(BaseModel):
    username: str
    temporary_password: str
    must_change_password: bool


class WeatherAlertCreate(BaseModel):
    risk_type: str
    level: str
    previous_level: str
    internal_mail_group: str | None = None
    sent_to_internal_group: bool = False


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
    postal_code: str | None = None
    contacts: str | None = None
    additional_info: str | None = None


class MunicipalityOut(BaseModel):
    id: int
    name: str
    phone: str
    email: str
    manager: str
    postal_code: str | None = None
    contacts: str | None = None
    additional_info: str | None = None
    pcs_active: bool
    crisis_mode: bool
    vigilance_color: str

    class Config:
        from_attributes = True


class OperationalLogCreate(BaseModel):
    event_type: str
    description: str
    municipality_id: int | None = None


class OperationalLogOut(BaseModel):
    id: int
    event_type: str
    description: str
    created_at: datetime
    created_by_id: int

    class Config:
        from_attributes = True


class ShareAccessRequest(BaseModel):
    password: str


class TwoFactorToggleRequest(BaseModel):
    enabled: bool
