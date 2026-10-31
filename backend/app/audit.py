"""Human-readable audit metadata; only explicitly allowed context is persisted."""
import json


def actor_snapshot(user):
    return {"username": user.username, "user_id": user.id, "user_role": user.role,
            "user_municipality": user.municipality_name, "auth_source": user.auth_source,
            "identity_verified": True}


def resource_type(path):
    for fragment, module in (("/auth/users", "users"), ("/auth/register", "users"),
                             ("/api/audit", "audit"), ("/api/admin/integrations", "interconnections"),
                             ("/api/notifications", "notifications"), ("/auth/ldap", "interconnections"),
                             ("/auth/", "auth"), ("/municipalities", "municipalities"),
                             ("/logs", "logs"), ("/events", "events"), ("/map", "map"),
                             ("/notifications", "notifications"), ("/agents", "agents"),
                             ("/integrations", "interconnections"), ("/interconnections", "interconnections"),
                             ("/external/", "interconnections"), ("/sources", "interconnections")):
        if path.startswith(fragment):
            return module
    return "api"


def action_label(method, path):
    exact = {"/auth/login": "Connexion", "/auth/logout": "Déconnexion",
             "/auth/session": "Ouverture de session navigateur", "/auth/register": "Création d’utilisateur",
             "/auth/change-password": "Changement de mot de passe", "/agents/location": "Mise à jour de position"}
    if path in exact:
        return exact[path]
    if "/export/" in path:
        return "Export CSV" if path.endswith("/csv") else "Export de données"
    if path.endswith("/reset-password"):
        return "Réinitialisation du mot de passe"
    if path.endswith("/crisis"):
        return "Changement du mode crise"
    if path.endswith("/refresh"):
        return "Actualisation des données"
    if path.endswith("/test"):
        return "Test de connexion" if resource_type(path) == "interconnections" else "Envoi de notification test"
    if "/files" in path:
        return {"POST": "Ajout de document", "DELETE": "Suppression de document"}.get(method, "Consultation de document")
    return {"POST": "Création", "PATCH": "Modification", "PUT": "Mise à jour",
            "DELETE": "Suppression", "GET": "Consultation"}.get(method, method)


def safe_context(payload):
    # Never store passwords, keys, tokens, free-text reports or arbitrary JSON.
    allowed = {"name", "title", "username", "role", "municipality_name", "municipality_id",
               "status", "type", "crisis_mode", "enabled", "service_key"}
    if not isinstance(payload, dict):
        return {}
    return {key: value[:160] if isinstance(value, str) else value
            for key, value in payload.items() if key in allowed and isinstance(value, (str, bool, int, float, type(None)))}


def parse_details(raw):
    try:
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {"reason": raw} if isinstance(raw, str) and raw else {}


def serialize(log, role=None, municipality=None):
    details = parse_details(log.details)
    method, _, path = (log.action or "").partition(" ")
    actor = details.get("actor") if isinstance(details.get("actor"), dict) else {}
    code = log.status_code or 0
    return {"id": log.id, "username": log.username,
            "user_role": actor.get("user_role", role),
            "user_municipality": actor.get("user_municipality", municipality),
            "user_id": actor.get("user_id"), "auth_source": actor.get("auth_source"),
            "identity_verified": actor.get("identity_verified"),
            "action": log.action, "action_label": action_label(method, path),
            "method": method, "path": path, "resource_type": log.resource_type,
            "target": details.get("target") or {}, "context": details.get("context") or {},
            "reason": details.get("reason"), "duration_ms": details.get("duration_ms"),
            "user_agent": details.get("user_agent"),
            "outcome": "Échec" if code >= 400 else "Redirection" if code >= 300 else "Réussite" if code >= 200 else "Inconnu",
            "details": log.details, "ip_address": log.ip_address, "status_code": log.status_code,
            "created_at": log.created_at.isoformat() + "Z"}
