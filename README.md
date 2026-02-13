# Protection Civile de l'Isère – Veille Opérationnelle

Application web de veille opérationnelle avec un frontend moderne et une stack conteneurisée complète.

## Démarrage rapide

```bash
docker compose up -d --build
```

Ou via script:

```bash
./scripts/install.sh
```

## Accès aux services

- Interface web : `http://localhost:1182`
- API backend : `http://localhost:8000`
- PostgreSQL : `localhost:5432` (base `veille`, utilisateur `postgres`, mot de passe `postgres`)
- Redis : `localhost:6379`

## Authentification par défaut

- Utilisateur initial : `admin`
- Mot de passe initial : `admin`
- Le changement du mot de passe est obligatoire à la première connexion.

## Architecture

- `web` : interface dashboard (Nginx + HTML/CSS/JS)
- `backend` : API FastAPI
- `db` : PostgreSQL 16 avec script d'initialisation
- `redis` : Redis 7 avec persistance AOF

## Fonctionnalités livrées

- Connexion locale et changement de mot de passe obligatoire au premier login.
- Dashboard synthétique modernisé (vigilance, crues, risque global, communes en crise, derniers événements).
- Gestion des communes (ajout + bascule mode crise).
- Main courante locale (ajout d’évènements horodatés).
- Carte opérationnelle embarquée (OpenStreetMap).
