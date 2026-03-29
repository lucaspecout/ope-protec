# CRISIS38 — Refonte complète A→Z

Cette version est une **reconstruction complète** de l’application de veille opérationnelle Isère.
L’existant est conservé uniquement comme référence métier (fonctionnalités + sources), mais la base technique est neuve.

## Fonction métier couvert
- Authentification locale (JWT) avec compte administrateur bootstrap.
- Suivi des communes Isère (ajout + état crise).
- Tableau de situation consolidé avec statut des sources externes.
- Rafraîchissement manuel ou automatique de la collecte externe.

## Sources de données conservées
- Météo-France vigilance (web public Isère).
- Vigicrues (API observations JSON).
- Préfecture de l’Isère (flux RSS).

## Architecture cible
- **web**: Nginx statique, SPA légère.
- **api**: FastAPI + SQLAlchemy, services découplés, JWT, gestion d’erreurs.
- **db**: PostgreSQL (stockage métier + snapshots sources externes).
- **redis**: prêt pour cache/queue (activé dans l’infra, extensible).

## Démarrage
```bash
docker compose up -d --build
```

Accès:
- Front: http://localhost:1182
- API docs: http://localhost:1182/docs

Identifiants initiaux:
- `admin` / `admin`

## Structure projet
```text
backend/app/
  config.py        # configuration centralisée
  database.py      # moteur SQL + sessions
  models.py        # modèle domaine (users, communes, snapshots)
  schemas.py       # contrats API Pydantic
  security.py      # hash + JWT
  services.py      # collecte robuste des sources externes
  bootstrap.py     # seed initial
  main.py          # composition FastAPI, endpoints, lifecycle
web/
  index.html
  styles.css
  script.js
  nginx.conf
```

## Principes techniques
- séparation claire API / domaine / accès données / collecteurs externes;
- timeouts réseau centralisés;
- erreurs de source isolées (une source KO ne casse pas la situation globale);
- snapshots historisés en base pour audit et résilience;
- socle prêt pour montée en charge (pool DB + limites HTTP).

## Plan de migration recommandé
1. Déployer cette version en environnement de staging.
2. Injecter les communes et utilisateurs depuis l’ancien système (script dédié).
3. Valider les connecteurs externes et seuils d’alerting.
4. Basculer la prod avec rollback docker-compose conservé.
