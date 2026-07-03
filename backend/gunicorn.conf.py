# Configuration Gunicorn optimisée pour FastAPI / UvicornWorker
# Séparation des responsabilités : les paramètres lourds ici, pas dans CMD Docker.

workers = 2
worker_class = "uvicorn.workers.UvicornWorker"
bind = "0.0.0.0:8000"

# Délai maximum pour un worker avant d'être tué et redémarré.
# 120s évite les faux kills pendant les démarrages lents (migrations DB, Overpass…).
timeout = 120

# Keep-alive HTTP : maintenir la connexion TCP ouverte entre requêtes successives.
# 30s réduit les handshakes TCP répétés et améliore la latence ressentie.
keepalive = 30

# Connexions simultanées max par worker (pour UvicornWorker = worker asyncio).
worker_connections = 1000

# Temps accordé aux workers pour finir leurs requêtes en cours avant arrêt forcé.
graceful_timeout = 30

# Précharger le module applicatif dans le processus master AVANT de forker les workers.
# Avantage : les migrations DB (ALTER TABLE × 20) s'exécutent une seule fois,
# pas 3 fois en parallèle avec contention de locks PostgreSQL.
preload_app = True

accesslog = "-"
errorlog = "-"
loglevel = "warning"


def post_fork(server, worker):
    """Réinitialiser le pool de connexions SQLAlchemy après le fork.
    Sans cette étape, les workers partageraient les sockets ouverts dans le master,
    ce qui provoque des erreurs 'SSL connection has been closed unexpectedly'."""
    try:
        from app.database import engine
        # close=False : ferme les connexions actives mais garde le pool prêt.
        # Chaque worker recrée ses propres connexions à la demande.
        engine.dispose(close=False)
    except Exception:
        pass
