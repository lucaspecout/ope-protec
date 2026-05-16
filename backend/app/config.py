from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "Protection Civile de l'Isère – Veille Opérationnelle"
    database_url: str = "postgresql://postgres:postgres@db:5432/veille"
    redis_url: str = "redis://redis:6379/0"
    secret_key: str = "change-me-in-production"
    access_token_expire_minutes: int = 1440
    upload_dir: str = "/data/uploads"
    static_data_dir: str = "/data/static"
    weather_retention_days: int = 90
    georisques_api_token: str = Field(
        default="",
        validation_alias=AliasChoices("GEORISQUES_API_TOKEN", "GEORISQUE_API_TOKEN"),
    )
    # Pool par worker × 3 workers gunicorn.
    # pool_size=5 → 15 connexions de base, max_overflow=10 → 30 en pic = 45 total max.
    # PostgreSQL par défaut accepte max 100 connexions — on reste bien en-dessous.
    db_pool_size: int = 5
    db_max_overflow: int = 10
    db_pool_timeout_seconds: int = 30
    db_pool_recycle_seconds: int = 1800
    external_fetch_workers: int = 18
    # RTE data.rte-france.com — base64(client_id:client_secret)
    rte_ecowatt_b64: str = ""
    rte_consumption_b64: str = ""
    # NASA FIRMS — clé gratuite sur https://firms.modaps.eosdis.nasa.gov/api/map_key/
    firms_map_key: str = ""
    # Ma Sécurité — accès restreint, endpoint fourni par la documentation partenaire.
    ma_securite_api_key: str = ""
    ma_securite_api_url: str = ""
    # INSEE SIRENE open data — jeton "ouvert avec compte".
    sirene_api_token: str = ""
    sirene_api_base_url: str = "https://api.insee.fr/api-sirene/3.11"
    # TomTom Routing API. If configured, route estimates include live traffic.
    tomtom_api_key: str = ""
    # LDAP / LLDAP authentication. Local users remain available when enabled.
    ldap_enabled: bool = False
    ldap_url: str = "ldap://lldap:3890"
    ldap_bind_dn: str = ""
    ldap_bind_password: str = ""
    ldap_user_base_dn: str = ""
    ldap_user_filter: str = "(|(uid={username})(mail={username}))"
    ldap_user_dn_template: str = ""
    ldap_role_default: str = "visiteur"
    ldap_municipality_attr: str = ""
    ldap_group_base_dn: str = ""
    ldap_group_filter: str = "(member={user_dn})"
    ldap_group_name_attr: str = "cn"
    ldap_group_required: str = "alerte"
    ldap_group_role_map: str = "alerte:ope"

    class Config:
        env_file = ".env"


settings = Settings()
