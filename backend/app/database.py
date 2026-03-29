from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import settings

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_timeout=settings.db_pool_timeout_seconds,
    pool_recycle=settings.db_pool_recycle_seconds,
    connect_args={"application_name": "ope-protec-api", "options": "-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000"},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
auth_engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=4,
    max_overflow=2,
    pool_timeout=2,
    pool_recycle=settings.db_pool_recycle_seconds,
    connect_args={"application_name": "ope-protec-auth", "options": "-c statement_timeout=10000 -c idle_in_transaction_session_timeout=10000"},
)
SessionLocalAuth = sessionmaker(autocommit=False, autoflush=False, bind=auth_engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
