from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import settings

def database_url_with_driver(value: str):
    url = make_url(value)
    # SQLAlchemy 2.1 defaults bare PostgreSQL URLs to psycopg 3. Keep the
    # installed psycopg2 driver and existing deployment URLs compatible.
    return url.set(drivername="postgresql+psycopg2") if url.drivername == "postgresql" else url


engine = create_engine(
    database_url_with_driver(settings.database_url),
    pool_pre_ping=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_timeout=settings.db_pool_timeout_seconds,
    pool_recycle=settings.db_pool_recycle_seconds,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
