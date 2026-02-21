from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "Protection Civile de l'Isère – Veille Opérationnelle"
    database_url: str = "postgresql://postgres:postgres@db:5432/veille"
    redis_url: str = "redis://redis:6379/0"
    secret_key: str = "change-me-in-production"
    access_token_expire_minutes: int = 1440
    upload_dir: str = "/data/uploads"
    report_dir: str = "/data/reports"
    weather_retention_days: int = 90

    class Config:
        env_file = ".env"


settings = Settings()
