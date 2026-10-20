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
    # Persistent private key, outside served/static directories. Back up with DB.
    api_credentials_key_path: str = "/data/api_credentials.key"
    georisques_api_token: str = Field(
        default="",
        validation_alias=AliasChoices("GEORISQUES_API_TOKEN", "GEORISQUE_API_TOKEN"),
    )
    # Pool par worker Gunicorn. Keep the total bounded across all workers.
    db_pool_size: int = 3
    db_max_overflow: int = 3
    db_pool_timeout_seconds: int = 30
    db_pool_recycle_seconds: int = 1800
    external_fetch_workers: int = 6
    background_refresh_workers: int = 4
    # Sources officielles : identifiants uniquement côté serveur.
    meteo_france_api_key: str = ""
    meteo_france_observations_api_key: str = ""
    meteo_france_radar_api_key: str = ""
    meteo_france_access_token: str = ""
    meteo_france_station_ids: str = ""
    meteo_france_station_limit: int = Field(default=40, ge=1, le=40)
    insee_population_csv_url: str = "https://www.insee.fr/fr/statistiques/fichier/8735162/Filosofi2021_carreaux_200m_csv.zip"
    insee_population_local_path: str = ""
    industrial_sites_csv_url: str = ""
    # NASA FIRMS — clé gratuite sur https://firms.modaps.eosdis.nasa.gov/api/map_key/
    firms_map_key: str = ""
    # TomTom Routing API. If configured, route estimates include live traffic.
    tomtom_api_key: str = ""
    # Valhalla-compatible endpoint for road isochrones and isodistances.
    valhalla_url: str = "https://valhalla1.openstreetmap.de"
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
