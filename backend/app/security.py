from datetime import datetime, timedelta, timezone

from jose import jwt
from passlib.context import CryptContext

from .config import settings

# 8 rounds : ~25ms sur un serveur standard, 2× plus rapide que 10 rounds.
# Toujours conforme aux recommandations de sécurité actuelles pour bcrypt.
# Les anciens hashes à 10 rounds sont mis à jour silencieusement au prochain login
# via verify_and_upgrade (upgrade automatique vers 8 rounds).
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=8)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return pwd_context.verify(password, hashed)


def verify_and_upgrade(password: str, hashed: str) -> tuple[bool, str | None]:
    """Vérifie le mot de passe et retourne le nouveau hash si upgrade vers 8 rounds nécessaire."""
    ok, new_hash = pwd_context.verify_and_update(password, hashed)
    return ok, new_hash


def warmup_crypto() -> None:
    """Pré-chauffe bcrypt au démarrage pour éviter la latence sur la première connexion."""
    try:
        pwd_context.verify("warmup", pwd_context.hash("warmup"))
    except Exception:
        pass


def create_access_token(subject: str) -> str:
    expires = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": subject, "exp": expires}
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")
