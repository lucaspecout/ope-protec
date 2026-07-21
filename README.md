# Protection Civile de l'Isère – Veille Opérationnelle

Application web repensée comme un centre de crise départemental (CRISIS38) dédié à l'Isère, avec une interface modernisée, une carte stratégique locale et des interconnexions vers les services publics de référence.

## Démarrage rapide

```bash
docker compose up -d --build
```

Ou via script:

```bash
./scripts/install.sh
```

## Optimisation Docker / conteneurs (fluidité + stabilité)

Pour améliorer la fluidité des requêtes et réduire les bugs en production, appliquez ces optimisations en priorité :

1. **Séparer le backend API du frontend Nginx**
   - Aujourd'hui, le service `web` mélange Nginx + backend Python.
   - Créer un service `api` dédié (Uvicorn/Gunicorn) + un service `web` statique simplifie le debug, améliore l'isolation des pannes et permet de scaler uniquement l'API.

2. **Utiliser une image Redis figée et plus sûre**
   - Remplacer `redis:latest` par `redis:7-alpine` pour éviter les changements inattendus lors des mises à jour.
   - Ajouter `--maxmemory` et une politique d’éviction (`allkeys-lru` par exemple) pour éviter les saturations mémoire.

3. **Durcir les limites ressources + réservations**
   - Conserver des limites (`mem_limit`) mais ajouter aussi des contraintes CPU et des réservations minimales.
   - Objectif : éviter qu’un conteneur monopolise l’hôte et dégrade les temps de réponse des autres services.

4. **Rendre les healthchecks plus applicatifs**
   - DB/Redis : OK actuellement.
   - API : ajouter un endpoint `/health` vérifiant DB + Redis + dépendances critiques.
   - Nginx : healthcheck HTTP local (`curl -f http://localhost/`).

5. **Optimiser le serveur Python pour la charge**
   - Passer de `uvicorn` simple à `gunicorn` + workers `uvicorn` (ex: `2-4` workers selon CPU).
   - Paramétrer `--timeout`, `--keep-alive`, et activer les logs d’accès pour identifier les lenteurs.

6. **Activer un pool de connexions DB + timeouts SQL**
   - Configurer SQLAlchemy (ou équivalent) avec `pool_size`, `max_overflow`, `pool_recycle`.
   - Ajouter des timeouts de requêtes pour éviter les blocages qui se propagent à toute l’application.

7. **Réduire la taille des images Docker**
   - Multi-stage build pour éviter les dépendances de build en runtime.
   - Installer uniquement les paquets système strictement nécessaires.
   - Bénéfice : démarrage plus rapide, moins de surface de bug/sécurité.

8. **Mettre en place observabilité minimale**
   - Logs JSON structurés (API + Nginx), corrélation par `request_id`.
   - Métriques techniques : latence p95/p99, taux d’erreur, saturation CPU/RAM, connexions DB.
   - Sans métriques, difficile d’identifier la vraie cause des lenteurs.

9. **Sécuriser la configuration runtime**
   - Sortir les secrets (`SECRET_KEY`, tokens API) du `docker-compose.yml` vers `.env`/secrets.
   - Éviter les clés codées en dur pour prévenir les incidents et comportements incohérents entre environnements.

10. **Stabiliser le cycle de livraison**
    - Versions d’images figées (`python:3.12-slim`, `postgres:16-alpine`, `redis:7-alpine`).
    - Pipeline CI avec tests API, smoke test Docker Compose, et vérification de migration DB.
    - Les régressions sont détectées avant la prod, donc moins de bugs visibles.

### Plan d’action rapide (fort impact)

- **Étape 1 (immédiat)** : figer les versions d’images, externaliser les secrets, ajouter healthcheck API.
- **Étape 2** : séparer `api` et `web`, configurer Gunicorn + pool DB.
- **Étape 3** : ajouter métriques/alertes et tests de charge (`k6` ou `locust`) sur endpoints critiques.

## Accès aux services



## Authentification par défaut


- Le changement du mot de passe est obligatoire à la première connexion.
- Le token de connexion est conservé côté navigateur et reste valide 7 jours par défaut (`ACCESS_TOKEN_EXPIRE_MINUTES=10080`).

## Architecture

- `web` : frontend statique (Nginx + HTML/CSS/JS)
- `api` : backend FastAPI exécuté via Gunicorn + workers Uvicorn
- `db` : PostgreSQL 16 avec script d'initialisation
- `redis` : Redis 7 avec persistance AOF

## Fonctionnalités livrées

- Connexion locale et changement de mot de passe obligatoire au premier login.
- Tableau de situation repensé (vigilance, crues, risque global, communes en crise, chronologie courte).
- Module d'interconnexions Isère (Météo-France, Vigicrues, Préfecture, Géorisques, Itinisère).
- Carte stratégique Isère enrichie (couleurs de niveau, villes clés, infos pratiques d'astreinte).
- Gestion des communes (ajout, enrichissement contacts/informations, bascule mode crise, import ORSEC et conventions).
- Main courante locale (ajout d’évènements horodatés).
- Carte opérationnelle embarquée (OpenStreetMap).
- Connexion aux flux externes Isère : Météo-France (état de disponibilité et infos vigilance), Vigicrues (stations du département + vigilances de tronçons + niveau d'alerte eau calculé), Vigieau (restrictions d'eau), Hub'Eau (niveaux de nappes phréatiques), Atmo AURA (indice qualité de l'air Grenoble/Isère), RTE éCO2mix (proxy électrique régional ARA pour suivi Isère), ANFR (supports/antennes radioélectriques du 38) et ARCEP (sites mobiles indisponibles en Isère).


## Géorisques API v2 (clé annuelle)

Pour enrichir les données départementales Isère (mouvements de terrain, cavités, radon, AZI) avec l'API v2 authentifiée, ajoutez votre clé dans le backend :

```bash
# .env (backend)
GEORISQUES_API_TOKEN=votre_cle_api
```

Sans clé, le module Géorisques reste en mode dégradé et n'expose pas de consolidation (fonctionnement 100% API v2).

## Géorisques v2 Isère – données enrichies

En mode API v2 (token), la consolidation Isère (`/external/isere/risks`) agrège désormais les endpoints suivants pour le département `38` :

- `zonage_sismique` : zone sismique maximale et distribution des zones.
- `gaspar/azi` : documents d'inondation.
- `gaspar/pprn`, `gaspar/pprm`, `gaspar/pprt` : volume de PPR par catégorie.
- `gaspar/dicrim` : nombre de DICRIM et année de publication pour les communes suivies.
- `gaspar/tim` : volume des transmissions d'information au maire (TIM).
- `gaspar/risques` : volume des informations préventives risques.
- `mvt`, `cavites`, `radon` : mouvements de terrain, cavités, potentiel radon.

## Endpoint de surveillance externe (Isère)

Après authentification, l'API expose :

```http
GET /external/isere/risks
```

Retourne un bloc consolidé :
- `meteo_france` : état de connexion au service vigilance Météo-France et bulletin Isère.
- `vigicrues` : état de connexion, stations du département de l'Isère, vigilances des tronçons associés et niveau d'alerte eau courant (`vert`, `jaune`, `orange`, `rouge`).
- `bison_fute` : état de connexion, prévisions trafic Isère (départs/retours J0/J1) et évènements temps réel filtrés Isère (accidents, pannes, incidents, travaux, réductions de voie) issus du jeu de données de l'État sur data.gouv.fr.
- `georisques` : synthèse multi-communes Isère (sismicité max, AZI, PPRN/PPRM/PPRT, DICRIM, TIM, information préventive risques, radon, mouvements de terrain et cavités).
- `prefecture_isere` : flux RSS des actualités de la Préfecture de l'Isère (titres, dates, liens).
- `sncf_isere` : alertes SNCF filtrées sur l'Isère (accidents et travaux de voie) issues du flux temps réel SNCF (SIRI SX Lite / GTFS-RT Service Alerts).
- `atmo_aura` : indice ATMO (J/J+1), commentaire et statut d'épisode pollution via Atmo Auvergne-Rhône-Alpes (commune de Grenoble).
- `electricity_isere` : état électrique Isère via jeu officiel data.gouv RTE éCO2mix régional (consommation, production, marge de sécurité, échanges).
- `anfr_isere` : synthèse ANFR Isère (supports recensés, stations ANFR associées, hauteur moyenne des supports).
- `arcep_isere` : indisponibilités mobiles ARCEP sur l'Isère (volumétrie, communes touchées, opérateurs les plus impactés).
- `groundwater_isere` : état des nappes phréatiques Hub'Eau (stations Isère, dernières mesures, tendance locale en hausse/baisse/stable).
- `isere_opendata` : consolidation Open Data Isère orientée préparation opérationnelle (aide alimentaire, maisons de santé pluriprofessionnelles et établissements scolaires géolocalisés).


## Alignement besoins métier

- Gouvernance: projet validé, périmètre Isère, déploiement Docker, authentification par identifiants.
- Alertes météo: transitions surveillées `jaune→orange` et `orange→rouge`, historique conservé 3 mois avec purge automatique, alerte différenciée par type de risque, validation avant diffusion manuelle au groupe interne.
- Vigicrues: collecte stations Isère avec mise en avant Grenoble/communes PCS, données temps réel dans le dashboard.
- Cartographie/PCS: fiche commune enrichissable (contacts, pièces ORSEC/conventions), mode crise, partage public par lien avec mot de passe et révocation.
- Rapports: export PDF contenant synthèse, chronologie et rappels carte/graphes.
- Sécurité: rôles, limite 20 utilisateurs, option d'activation 2FA par utilisateur.


## Nouveaux flux de supervision

- `GET /supervision/overview` : consolidation prête à l'emploi (Météo-France + Vigicrues + Itinisère + Géorisques + communes en crise + timeline).
- `GET /api/vigicrues/geojson` : stations Vigicrues Isère en GeoJSON pour cartographie interactive.
- `GET /api/itinisere/events` : perturbations Itinisère en direct via le flux RSS officiel.
- `GET /api/bison-fute/events` : évènements Bison Futé en direct filtrables par catégories (`accident`, `travaux`, `reduction_voie`, `danger`) avec `?categories=` et `?limit=`.
- `GET /api/vigieau/alerts` : restrictions d'eau Vigieau pour l'Isère (actualisation optionnelle avec `?refresh=true`).
- `GET /api/hubeau/isere/groundwater` : synthèse des nappes phréatiques Isère via Hub'Eau (actualisation avec `?refresh=true`, taille d'échantillon avec `?station_limit=`).
- `GET /api/opendata/isere/resilience` : indicateurs de résilience territoriale depuis opendata.isere.fr (`?refresh=true`, `?limit=` pour la taille de l'échantillon).
## Ressources des conteneurs

Le déploiement applique par défaut des plafonds CPU/RAM à chaque service. Ils peuvent
être adaptés à la capacité du serveur sans modifier le fichier Compose, par exemple :

```env
API_MEMORY_LIMIT=768m
API_CPU_LIMIT=1.5
DB_MEMORY_LIMIT=768m
DB_CPU_LIMIT=1.0
REDIS_MEMORY_LIMIT=256m
REDIS_CPU_LIMIT=0.5
WEB_MEMORY_LIMIT=128m
WEB_CPU_LIMIT=0.5
EXTERNAL_FETCH_WORKERS=6
BACKGROUND_REFRESH_WORKERS=4
```

Redis évince les clés les moins récemment utilisées à partir de 160 Mo. L'API borne
également ses récupérations externes et recycle périodiquement ses workers Gunicorn.
Après déploiement, surveiller la marge avec `docker stats` et augmenter un plafond
uniquement si le conteneur atteint régulièrement sa limite sous une charge normale.
