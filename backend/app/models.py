from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="lecture")
    municipality_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    two_factor_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class WeatherAlert(Base):
    __tablename__ = "weather_alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    risk_type: Mapped[str] = mapped_column(String(100))
    level: Mapped[str] = mapped_column(String(20))
    previous_level: Mapped[str] = mapped_column(String(20), default="vert")
    internal_mail_group: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sent_to_internal_group: Mapped[bool] = mapped_column(Boolean, default=False)
    source: Mapped[str] = mapped_column(String(50), default="Météo-France")
    pcs_validated: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


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
    postal_code: Mapped[str | None] = mapped_column(String(10), nullable=True)
    contacts: Mapped[str | None] = mapped_column(Text, nullable=True)
    additional_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    population: Mapped[int | None] = mapped_column(Integer, nullable=True)
    shelter_capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    radio_channel: Mapped[str | None] = mapped_column(String(80), nullable=True)
    pcs_active: Mapped[bool] = mapped_column(Boolean, default=True)
    crisis_mode: Mapped[bool] = mapped_column(Boolean, default=False)
    vigilance_color: Mapped[str] = mapped_column(String(20), default="vert")
    orsec_plan_file: Mapped[str | None] = mapped_column(String(255), nullable=True)
    convention_file: Mapped[str | None] = mapped_column(String(255), nullable=True)


class OperationalLog(Base):
    __tablename__ = "operational_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_type: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(Text)
    danger_level: Mapped[str] = mapped_column(String(20), default="vert")
    danger_emoji: Mapped[str] = mapped_column(String(8), default="🟢")
    attachment_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    municipality_id: Mapped[int | None] = mapped_column(ForeignKey("municipalities.id"), nullable=True)

    created_by = relationship("User")
    municipality = relationship("Municipality")


class PublicShare(Base):
    __tablename__ = "public_shares"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    municipality_id: Mapped[int] = mapped_column(ForeignKey("municipalities.id"))

    municipality = relationship("Municipality")
