from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="lecture")
    auth_source: Mapped[str] = mapped_column(String(20), default="local")
    municipality_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_access_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class RiverStation(Base):
    __tablename__ = "river_stations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    municipality: Mapped[str] = mapped_column(String(120))
    level: Mapped[str] = mapped_column(String(20), default="vert")
    water_height_cm: Mapped[int] = mapped_column(Integer, default=0)
    is_priority: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Municipality(Base):
    __tablename__ = "municipalities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    phone: Mapped[str] = mapped_column(String(30))
    email: Mapped[str] = mapped_column(String(120))
    manager: Mapped[str] = mapped_column(String(120))
    insee_code: Mapped[str | None] = mapped_column(String(5), nullable=True)
    postal_code: Mapped[str | None] = mapped_column(String(10), nullable=True)
    contacts: Mapped[str | None] = mapped_column(Text, nullable=True)
    additional_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    population: Mapped[int | None] = mapped_column(Integer, nullable=True)
    shelter_capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    radio_channel: Mapped[str | None] = mapped_column(String(80), nullable=True)
    pcs_active: Mapped[bool] = mapped_column(Boolean, default=True)
    crisis_mode: Mapped[bool] = mapped_column(Boolean, default=False)
    vigilance_color: Mapped[str] = mapped_column(String(20), default="vert")


class MunicipalityDocument(Base):
    __tablename__ = "municipality_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    municipality_id: Mapped[int] = mapped_column(ForeignKey("municipalities.id"), index=True)
    doc_type: Mapped[str] = mapped_column(String(40), default="annexe")
    title: Mapped[str] = mapped_column(String(160))
    file_path: Mapped[str] = mapped_column(String(255))
    uploaded_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    municipality = relationship("Municipality")
    uploaded_by = relationship("User")


class MapPoint(Base):
    __tablename__ = "map_points"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(40), default="autre")
    icon: Mapped[str] = mapped_column(String(16), default="📍")
    icon_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    municipality_id: Mapped[int | None] = mapped_column(ForeignKey("municipalities.id"), nullable=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    municipality = relationship("Municipality")
    created_by = relationship("User")


class MapAnnotation(Base):
    __tablename__ = "map_annotations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    annotation_type: Mapped[str] = mapped_column(String(24), default="polygon")
    geojson: Mapped[str] = mapped_column(Text)
    text_label: Mapped[str | None] = mapped_column(String(180), nullable=True)
    color: Mapped[str] = mapped_column(String(16), default="#d7263d")
    weight: Mapped[int] = mapped_column(Integer, default=3)
    fill_opacity: Mapped[float] = mapped_column(Float, default=0.18)
    municipality_id: Mapped[int | None] = mapped_column(ForeignKey("municipalities.id"), nullable=True)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    municipality = relationship("Municipality")
    created_by = relationship("User")


class OperationalLog(Base):
    __tablename__ = "operational_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_type: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(Text)
    danger_level: Mapped[str] = mapped_column(String(20), default="vert")
    danger_emoji: Mapped[str] = mapped_column(String(8), default="🟢")
    target_scope: Mapped[str] = mapped_column(String(20), default="departemental")
    status: Mapped[str] = mapped_column(String(20), default="nouveau")
    event_time: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    location: Mapped[str | None] = mapped_column(String(160), nullable=True)
    source: Mapped[str | None] = mapped_column(String(120), nullable=True)
    actions_taken: Mapped[str | None] = mapped_column(Text, nullable=True)
    next_update_due: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    assigned_to: Mapped[str | None] = mapped_column(String(120), nullable=True)
    tags: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    municipality_id: Mapped[int | None] = mapped_column(ForeignKey("municipalities.id"), nullable=True)
    event_id: Mapped[int | None] = mapped_column(ForeignKey("incident_events.id"), nullable=True)

    created_by = relationship("User")
    municipality = relationship("Municipality")
    event = relationship("IncidentEvent")


class IncidentEvent(Base):
    __tablename__ = "incident_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(180))
    address: Mapped[str] = mapped_column(String(220))
    status: Mapped[str] = mapped_column(String(20), default="ouvert")
    municipality_id: Mapped[int | None] = mapped_column(ForeignKey("municipalities.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))

    municipality = relationship("Municipality")
    created_by = relationship("User")


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class InstitutionPoint(Base):
    """Cache persistant des points OSM (écoles, pompiers, police, transport).
    Mis à jour en arrière-plan une fois par semaine sans jamais effacer les données existantes."""
    __tablename__ = "institution_points"

    osm_id: Mapped[str] = mapped_column(String(60), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    type: Mapped[str] = mapped_column(String(60), nullable=False)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    address: Mapped[str] = mapped_column(String(300), default="")
    priority: Mapped[str] = mapped_column(String(20), default="standard")
    info: Mapped[str] = mapped_column(String(200), default="")
    capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    surface_m2: Mapped[float | None] = mapped_column(Float, nullable=True)
    capacity_source: Mapped[str | None] = mapped_column(String(80), nullable=True)
    accessibility: Mapped[str | None] = mapped_column(String(40), nullable=True)
    sanitary: Mapped[str | None] = mapped_column(String(40), nullable=True)
    heating: Mapped[str | None] = mapped_column(String(40), nullable=True)
    parking: Mapped[str | None] = mapped_column(String(40), nullable=True)
    source: Mapped[str] = mapped_column(String(200), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AlertHistory(Base):
    __tablename__ = "alert_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    service_key: Mapped[str] = mapped_column(String(80))
    service_label: Mapped[str] = mapped_column(String(120))
    new_level: Mapped[str] = mapped_column(String(20))
    previous_level: Mapped[str | None] = mapped_column(String(20), nullable=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    triggered_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(80))
    action: Mapped[str] = mapped_column(String(160))
    resource_type: Mapped[str | None] = mapped_column(String(80), nullable=True)
    details: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(60), nullable=True)
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
