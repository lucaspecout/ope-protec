"""Admin-only configuration. Responses and validation errors contain no secrets."""
import json
from threading import BoundedSemaphore
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.exc import SQLAlchemyError

from . import api_credentials as store
from .database import get_db
from .integration_tests import test_integration


async def _read_update(request: Request) -> dict:
    # Manual bounded validation avoids FastAPI echoing secret inputs in 422 errors.
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 40000:
            raise HTTPException(413, "Configuration trop volumineuse.")
    try:
        value = json.loads(raw) if raw else {}
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(422, "Configuration JSON invalide.") from None
    if not isinstance(value, dict) or set(value) - {"values", "clear_fields"}:
        raise HTTPException(422, "Format de configuration invalide.")
    values, clear_fields = value.get("values", {}), value.get("clear_fields", [])
    if (not isinstance(values, dict) or not isinstance(clear_fields, list)
            or len(values) > 4 or len(clear_fields) > 4
            or any(not isinstance(name, str) for name in clear_fields)
            or any(not isinstance(secret, str) for secret in values.values())):
        raise HTTPException(422, "Les accès doivent être des chaînes de caractères.")
    values = {name: secret.strip() for name, secret in values.items()}
    if any(len(secret) > 8192 or not secret.isascii() or any(ord(char) < 33 or ord(char) > 126 for char in secret)
           for secret in values.values()):
        raise HTTPException(422, "Accès invalide : utiliser une clé ou un jeton sans espace ni saut de ligne (8 192 caractères maximum).")
    return {"values": values, "clear_fields": clear_fields}


def create_integration_router(authorize: Callable, queue_refresh: Callable,
                              db_dependency: Callable = get_db, tester: Callable = test_integration) -> APIRouter:
    def no_cache(response: Response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"

    router = APIRouter(prefix="/api/admin/integrations", dependencies=[Depends(authorize), Depends(no_cache)])
    # Bound expensive outbound tests; a second click cannot exhaust thread workers.
    testing = BoundedSemaphore(2)

    def known(service_id):
        if service_id not in store.CATALOG:
            raise HTTPException(404, "Service inconnu.")

    def checked_update(service_id, payload):
        known(service_id)
        names = set(store.CATALOG[service_id]["fields"])
        if (set(payload["values"]) - names or set(payload["clear_fields"]) - names
                or set(payload["values"]) & set(payload["clear_fields"])):
            raise HTTPException(422, "Champs d’accès invalides ou contradictoires.")
        return payload

    def safe(operation, db):
        try:
            return operation()
        except (store.CredentialStoreError, SQLAlchemyError):
            db.rollback()
            raise HTTPException(503, "Configuration des accès API indisponible. Vérifier la base et la clé de chiffrement persistante.") from None

    @router.get("")
    def catalog(db=Depends(db_dependency)):
        return safe(lambda: {"services": [store.public_status(db, name) for name in store.CATALOG]}, db)

    @router.put("/{service_id}")
    def update(service_id: str, payload=Depends(_read_update), db=Depends(db_dependency)):
        payload = checked_update(service_id, payload)
        def persist():
            store.lock_service(db, service_id)
            overrides = store.merge_update(store.read_overrides(db, service_id), **payload)
            store.save_overrides(db, service_id, overrides)
            db.commit()
            return store.public_status(db, service_id)
        result = safe(persist, db)
        for key in store.CATALOG[service_id]["refresh_keys"]:
            queue_refresh(key)
        return result

    @router.delete("/{service_id}")
    def reset(service_id: str, db=Depends(db_dependency)):
        known(service_id)
        def persist():
            store.lock_service(db, service_id)
            # Reset remains possible even when a lost key prevents decryption.
            store.save_overrides(db, service_id, {})
            db.commit()
            return store.public_status(db, service_id)
        result = safe(persist, db)
        for key in store.CATALOG[service_id]["refresh_keys"]:
            queue_refresh(key)
        return result

    @router.post("/{service_id}/test")
    def test(service_id: str, payload=Depends(_read_update), db=Depends(db_dependency)):
        payload = checked_update(service_id, payload)
        credentials = safe(lambda: store.effective_credentials(
            service_id, store.merge_update(store.read_overrides(db, service_id), **payload)), db)
        # Release the SQL connection before a potentially slow provider request.
        db.rollback()
        if not testing.acquire(blocking=False):
            raise HTTPException(429, "Des tests sont déjà en cours. Réessayer dans quelques secondes.")
        try:
            return tester(service_id, credentials)
        finally:
            testing.release()

    return router
