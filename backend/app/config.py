from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "CRISIS38 - Veille opérationnelle Isère"
    app_env: str = "production"

    database_url: str = "postgresql://postgres:postgres@db:5432/veille"
    redis_url: str = "redis://redis:6379/0"

    secret_key: str = Field(default="change-me", min_length=8)
    access_token_expire_minutes: int = 60 * 24

    external_refresh_interval_seconds: int = 300
    external_http_timeout_seconds: float = 8.0
    external_max_connections: int = 40

    cors_origins: str = "*"


settings = Settings()
