from datetime import datetime, timedelta, timezone

from jose import jwt
import bcrypt

from .config import settings

# Preserve the existing bcrypt cost and stored $2a$/$2b$/$2y$ hashes.
BCRYPT_ROUNDS = 8


def _password_bytes(password: str) -> bytes:
    if "\x00" in password:
        raise ValueError("Le mot de passe ne peut pas contenir de caractère nul.")
    # Passlib previously truncated UTF-8 passwords to bcrypt's 72-byte limit.
    # Preserve that behavior when verifying existing hashes with bcrypt >= 5.
    return password.encode("utf-8")[:72]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_password_bytes(password), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode("ascii")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_password_bytes(password), hashed.encode("ascii"))
    except (ValueError, UnicodeError):
        return False


def verify_and_upgrade(password: str, hashed: str) -> tuple[bool, str | None]:
    """Vérifie le mot de passe et retourne le nouveau hash si upgrade vers 8 rounds nécessaire."""
    if not verify_password(password, hashed):
        return False, None
    rounds = int(hashed.split("$")[2])
    return True, hash_password(password) if rounds != BCRYPT_ROUNDS else None


def warmup_crypto() -> None:
    """Pré-chauffe bcrypt au démarrage pour éviter la latence sur la première connexion."""
    try:
        verify_password("warmup", hash_password("warmup"))
    except Exception:
        pass


def create_access_token(subject: str) -> str:
    expires = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": subject, "exp": expires}
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")
