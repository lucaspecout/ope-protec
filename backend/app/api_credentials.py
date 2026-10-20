"""Server-only, encrypted integration overrides shared by all API workers.

No secrets are cached in process memory or Redis. Collectors resolve the current
database values at collection time; environment variables remain the fallback.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from .config import settings
from .database import SessionLocal
from .models import AppSetting


class CredentialStoreError(ValueError):
    """Safe diagnostic: never include database errors or decrypted values."""


CATALOG = {
    "meteo_france": {
        "label": "Météo-France — observations et radar",
        "description": "Souscrire aux produits Observations et Radar. Une clé commune ou des clés distinctes peuvent être utilisées. Le jeton Bearer est temporaire et utilisé en l’absence de clé API.",
        "help_url": "https://portail-api.meteofrance.fr/",
        "fields": {
            "api_key": ("Clé API commune", "meteo_france_api_key"),
            "observations_api_key": ("Clé API Observations (prioritaire)", "meteo_france_observations_api_key"),
            "radar_api_key": ("Clé API Radar (prioritaire)", "meteo_france_radar_api_key"),
            "access_token": ("Jeton Bearer temporaire (sans le préfixe Bearer)", "meteo_france_access_token"),
        },
        "refresh_keys": ("meteo_observations", "meteo_radar"),
    },
    "georisques": {
        "label": "Géorisques — API v2",
        "description": "Jeton d’accès aux données de risques de l’API v2. Le référentiel public ICPE reste accessible sans ce jeton.",
        "help_url": "https://www.georisques.gouv.fr/doc-api",
        "fields": {"token": ("Jeton API", "georisques_api_token")},
        "refresh_keys": ("georisques",),
    },
    "firms": {
        "label": "NASA FIRMS — détections de feux",
        "description": "MAP_KEY gratuite pour les détections thermiques satellitaires VIIRS.",
        "help_url": "https://firms.modaps.eosdis.nasa.gov/api/map_key/",
        "fields": {"map_key": ("MAP_KEY", "firms_map_key")},
        "refresh_keys": ("feux_foret_isere",),
    },
    "tomtom": {
        "label": "TomTom — itinéraires et trafic",
        "description": "Clé autorisée à utiliser Routing API. Le test calcule un court trajet à Grenoble et consomme une requête du quota fournisseur.",
        "help_url": "https://developer.tomtom.com/",
        "fields": {"api_key": ("Clé API Routing", "tomtom_api_key")},
        "refresh_keys": (),
    },
}
PREFIX = "integration_credentials:"


def _cipher(create: bool = False) -> Fernet:
    """Publish a complete key atomically, including concurrent Gunicorn writes."""
    path = Path(settings.api_credentials_key_path)
    temporary = None
    try:
        if create and not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".api-key-", delete=False) as output:
                temporary = Path(output.name)
                os.chmod(temporary, 0o600)
                output.write(Fernet.generate_key())
                output.flush()
                os.fsync(output.fileno())
            try:
                # A losing worker keeps the already-published key; never replace it.
                os.link(temporary, path)
            except FileExistsError:
                pass
        return Fernet(path.read_bytes())
    except (OSError, ValueError):
        raise CredentialStoreError("Le coffre des accès API est indisponible. Vérifier sa clé de chiffrement persistante.") from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def read_overrides(db, service_id: str) -> dict[str, str]:
    if service_id not in CATALOG:
        raise ValueError("Service inconnu.")
    try:
        row = db.get(AppSetting, PREFIX + service_id)
        if row is None:
            return {}
        # Bind ciphertext to its service to prevent exchanging encrypted records.
        document = json.loads(_cipher().decrypt(row.value.encode("ascii")))
        values = document["values"]
        if (document.get("service_id") != service_id or not isinstance(values, dict)
                or not set(values).issubset(CATALOG[service_id]["fields"])
                or any(not isinstance(value, str) or not value for value in values.values())):
            raise ValueError()
        return values
    except CredentialStoreError:
        raise
    except (SQLAlchemyError, InvalidToken, ValueError, KeyError, TypeError, UnicodeError):
        raise CredentialStoreError("Les accès API enregistrés sont illisibles. Vérifier la base et la clé de chiffrement.") from None


def effective_credentials(service_id: str, overrides: dict[str, str]) -> dict[str, str]:
    return {
        name: overrides.get(name, str(getattr(settings, attribute, "") or "").strip())
        for name, (_, attribute) in CATALOG[service_id]["fields"].items()
    }


def resolve_credentials(service_id: str) -> dict[str, str]:
    try:
        with SessionLocal() as db:
            return effective_credentials(service_id, read_overrides(db, service_id))
    except SQLAlchemyError:
        raise CredentialStoreError("La configuration des accès API est temporairement indisponible.") from None


def public_status(db, service_id: str) -> dict:
    definition = CATALOG[service_id]
    overrides = read_overrides(db, service_id)
    effective = effective_credentials(service_id, overrides)
    return {
        "id": service_id,
        "label": definition["label"],
        "description": definition["description"],
        "help_url": definition["help_url"],
        "configured": any(effective.values()),
        "fields": [
            {"id": name, "label": label, "configured": bool(effective[name]),
             "source": "application" if name in overrides else "environment" if effective[name] else "missing"}
            for name, (label, _) in definition["fields"].items()
        ],
    }


def merge_update(overrides: dict, values: dict, clear_fields: list) -> dict:
    updated = {name: value for name, value in overrides.items() if name not in clear_fields}
    updated.update({name: value for name, value in values.items() if value})
    return updated


def lock_service(db, service_id: str) -> None:
    # PostgreSQL transaction lock also covers initial creation (no row yet).
    # Serialize read/merge/write so concurrent admins cannot lose other fields.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:scope))"),
                   {"scope": PREFIX + service_id})


def save_overrides(db, service_id: str, overrides: dict) -> None:
    try:
        row = db.get(AppSetting, PREFIX + service_id)
        if not overrides:
            if row is not None:
                db.delete(row)
            return
        if (not Path(settings.api_credentials_key_path).exists()
                and db.query(AppSetting).filter(AppSetting.key.startswith(PREFIX, autoescape=True)).first() is not None):
            raise CredentialStoreError("La clé de chiffrement des accès existants est manquante. Restaurer la clé persistante avant tout nouvel enregistrement.")
        plaintext = json.dumps({"service_id": service_id, "values": overrides}, ensure_ascii=False).encode("utf-8")
        encrypted = _cipher(create=True).encrypt(plaintext).decode("ascii")
        if row is None:
            row = AppSetting(key=PREFIX + service_id, value=encrypted)
            db.add(row)
        else:
            from datetime import datetime
            row.value = encrypted
            row.updated_at = datetime.utcnow()
    except SQLAlchemyError:
        raise CredentialStoreError("Impossible d’enregistrer les accès API.") from None
