from datetime import datetime

from pydantic import BaseModel, EmailStr, field_validator


ALLOWED_ROLES = {"admin", "ope", "securite", "visiteur", "mairie"}
ALLOWED_WEATHER_LEVELS = {"vert", "jaune", "orange", "rouge"}
ALLOWED_VIGILANCE_COLORS = {"vert", "jaune", "orange", "rouge"}
ALLOWED_DANGER_LEVELS = {"vert", "jaune", "orange", "rouge"}
ALLOWED_LOG_SCOPES = {"commune", "pcs", "departemental"}
ALLOWED_LOG_STATUS = {"nouveau", "en_cours", "suivi", "clos"}


class Token(BaseModel):
    access_token: str
    token_type: str
    must_change_password: bool = False


class UserCreate(BaseModel):
    username: str
    password: str
    role: str
    municipality_name: str | None = None

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str) -> str:
        sanitized = value.strip()
        if len(sanitized) < 3:
            raise ValueError("Le nom d'utilisateur doit contenir au moins 3 caractères")
        return sanitized

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        normalized = value.lower().strip()
        if normalized not in ALLOWED_ROLES:
            raise ValueError("Rôle invalide")
        return normalized

    @field_validator("municipality_name")
    @classmethod
    def normalize_municipality_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        sanitized = value.strip()
        return sanitized or None


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

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        normalized = value.lower().strip()
        if normalized not in ALLOWED_ROLES:
            raise ValueError("Rôle invalide")
        return normalized

    @field_validator("municipality_name")
    @classmethod
    def normalize_municipality_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        sanitized = value.strip()
        return sanitized or None


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

    @field_validator("risk_type")
    @classmethod
    def normalize_risk_type(cls, value: str) -> str:
        sanitized = value.strip().lower()
        if not sanitized:
            raise ValueError("Le type de risque est obligatoire")
        return sanitized

    @field_validator("level", "previous_level")
    @classmethod
    def validate_alert_level(cls, value: str) -> str:
        normalized = value.lower().strip()
        if normalized not in ALLOWED_WEATHER_LEVELS:
            raise ValueError("Niveau de vigilance invalide")
        return normalized

    @field_validator("internal_mail_group")
    @classmethod
    def normalize_internal_mail_group(cls, value: str | None) -> str | None:
        if value is None:
            return None
        sanitized = value.strip()
        return sanitized or None


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
    population: int | None = None
    shelter_capacity: int | None = None
    radio_channel: str | None = None

    @field_validator("name", "manager")
    @classmethod
    def validate_required_text_fields(cls, value: str) -> str:
        sanitized = value.strip()
        if not sanitized:
            raise ValueError("Ce champ est obligatoire")
        return sanitized

    @field_validator("contacts", "additional_info", "radio_channel")
    @classmethod
    def strip_text_fields(cls, value: str | None) -> str | None:
        if value is None:
            return None
        sanitized = value.strip()
        return sanitized or None

    @field_validator("population", "shelter_capacity")
    @classmethod
    def validate_non_negative_numbers(cls, value: int | None) -> int | None:
        if value is not None and value < 0:
            raise ValueError("La valeur ne peut pas être négative")
        return value


class MunicipalityUpdate(BaseModel):
    manager: str | None = None
    phone: str | None = None
    email: EmailStr | None = None
    postal_code: str | None = None
    contacts: str | None = None
    additional_info: str | None = None
    population: int | None = None
    shelter_capacity: int | None = None
    radio_channel: str | None = None
    vigilance_color: str | None = None
    pcs_active: bool | None = None

    @field_validator("manager", "phone", "postal_code", "contacts", "additional_info", "radio_channel")
    @classmethod
    def strip_optional_text_fields(cls, value: str | None) -> str | None:
        if value is None:
            return None
        sanitized = value.strip()
        return sanitized or None

    @field_validator("population", "shelter_capacity")
    @classmethod
    def validate_non_negative_numbers(cls, value: int | None) -> int | None:
        if value is not None and value < 0:
            raise ValueError("La valeur ne peut pas être négative")
        return value

    @field_validator("vigilance_color")
    @classmethod
    def validate_vigilance_color(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.lower().strip()
        if normalized not in ALLOWED_VIGILANCE_COLORS:
            raise ValueError("Couleur de vigilance invalide")
        return normalized


class MunicipalityOut(BaseModel):
    id: int
    name: str
    phone: str
    email: str
    manager: str
    postal_code: str | None = None
    contacts: str | None = None
    additional_info: str | None = None
    population: int | None = None
    shelter_capacity: int | None = None
    radio_channel: str | None = None
    pcs_active: bool
    crisis_mode: bool
    vigilance_color: str
    orsec_plan_file: str | None = None
    convention_file: str | None = None

    class Config:
        from_attributes = True


class OperationalLogCreate(BaseModel):
    event_type: str
    description: str
    danger_level: str = "vert"
    danger_emoji: str = "🟢"
    target_scope: str = "departemental"
    status: str = "nouveau"
    event_time: datetime | None = None
    location: str | None = None
    source: str | None = None
    actions_taken: str | None = None
    next_update_due: datetime | None = None
    assigned_to: str | None = None
    tags: str | None = None
    municipality_id: int | None = None

    @field_validator("event_type", "description")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        sanitized = value.strip()
        if not sanitized:
            raise ValueError("Ce champ est obligatoire")
        return sanitized

    @field_validator("danger_level")
    @classmethod
    def validate_danger_level(cls, value: str) -> str:
        normalized = value.lower().strip()
        if normalized not in ALLOWED_DANGER_LEVELS:
            raise ValueError("Niveau de danger invalide")
        return normalized

    @field_validator("target_scope")
    @classmethod
    def validate_target_scope(cls, value: str) -> str:
        normalized = value.lower().strip()
        if normalized not in ALLOWED_LOG_SCOPES:
            raise ValueError("Cible invalide")
        return normalized

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: str) -> str:
        normalized = value.lower().strip()
        if normalized not in ALLOWED_LOG_STATUS:
            raise ValueError("Statut invalide")
        return normalized

    @field_validator("location", "source", "actions_taken", "assigned_to", "tags")
    @classmethod
    def strip_optional_fields(cls, value: str | None) -> str | None:
        if value is None:
            return None
        sanitized = value.strip()
        return sanitized or None


class OperationalLogOut(BaseModel):
    id: int
    event_type: str
    description: str
    danger_level: str
    danger_emoji: str
    target_scope: str
    status: str
    event_time: datetime
    location: str | None = None
    source: str | None = None
    actions_taken: str | None = None
    next_update_due: datetime | None = None
    assigned_to: str | None = None
    tags: str | None = None
    municipality_id: int | None = None
    created_at: datetime
    created_by_id: int

    class Config:
        from_attributes = True


class OperationalLogStatusUpdate(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: str) -> str:
        normalized = value.lower().strip()
        if normalized not in ALLOWED_LOG_STATUS:
            raise ValueError("Statut invalide")
        return normalized


class ShareAccessRequest(BaseModel):
    password: str


class TwoFactorToggleRequest(BaseModel):
    enabled: bool


class MunicipalityDocumentOut(BaseModel):
    id: int
    municipality_id: int
    doc_type: str
    title: str
    filename: str
    uploaded_by: str
    created_at: datetime


class MunicipalityDocumentCreate(BaseModel):
    title: str
    doc_type: str = "annexe"

    @field_validator("title", "doc_type")
    @classmethod
    def validate_document_fields(cls, value: str) -> str:
        sanitized = value.strip()
        if not sanitized:
            raise ValueError("Ce champ est obligatoire")
        return sanitized


class MapPointCreate(BaseModel):
    name: str
    category: str = "autre"
    icon: str = "📍"
    notes: str | None = None
    lat: float
    lon: float
    municipality_id: int | None = None

    @field_validator("name", "category", "icon")
    @classmethod
    def validate_required_map_point_text(cls, value: str) -> str:
        sanitized = value.strip()
        if not sanitized:
            raise ValueError("Ce champ est obligatoire")
        return sanitized

    @field_validator("notes")
    @classmethod
    def normalize_map_point_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        sanitized = value.strip()
        return sanitized or None

    @field_validator("lat")
    @classmethod
    def validate_latitude(cls, value: float) -> float:
        if value < -90 or value > 90:
            raise ValueError("Latitude invalide")
        return value

    @field_validator("lon")
    @classmethod
    def validate_longitude(cls, value: float) -> float:
        if value < -180 or value > 180:
            raise ValueError("Longitude invalide")
        return value


class MapPointOut(BaseModel):
    id: int
    name: str
    category: str
    icon: str
    notes: str | None = None
    lat: float
    lon: float
    municipality_id: int | None = None
    created_by_id: int
    created_at: datetime

    class Config:
        from_attributes = True
