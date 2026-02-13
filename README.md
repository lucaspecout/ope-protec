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
- API backend (via le conteneur web) : `http://localhost:1182`
- PostgreSQL : `localhost:5432` (base `veille`, utilisateur `postgres`, mot de passe `postgres`)
- Redis : `localhost:6379`

## Authentification par défaut

- Utilisateur initial : `admin`
- Mot de passe initial : `admin`
- Le changement du mot de passe est obligatoire à la première connexion.

## Architecture

- `web` : interface dashboard + API FastAPI (Nginx + HTML/CSS/JS + Uvicorn)
- `db` : PostgreSQL 16 avec script d'initialisation
- `redis` : Redis 7 avec persistance AOF

## Fonctionnalités livrées

- Connexion locale et changement de mot de passe obligatoire au premier login.
- Dashboard synthétique modernisé (vigilance, crues, risque global, communes en crise, derniers événements).
- Gestion des communes (ajout + bascule mode crise).
- Main courante locale (ajout d’évènements horodatés).
- Carte opérationnelle embarquée (OpenStreetMap).
- Connexion aux flux externes Isère : Météo-France (état de disponibilité et infos vigilance) et Vigicrues (stations Isère + niveau d'alerte eau calculé).

## Endpoint de surveillance externe (Isère)

Après authentification, l'API expose :

```http
GET /external/isere/risks
```

Retourne un bloc consolidé :
- `meteo_france` : état de connexion au service vigilance Météo-France et bulletin Isère.
- `vigicrues` : état de connexion, stations détectées en Isère et niveau d'alerte eau courant (`vert`, `jaune`, `orange`, `rouge`).
