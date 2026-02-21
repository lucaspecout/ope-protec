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

## Accès aux services

- Interface web : `http://localhost:1182`
- API backend (via le conteneur web) : `http://localhost:1182`
- PostgreSQL : `localhost:5432` (base `veille`, utilisateur `postgres`, mot de passe `postgres`)
- Redis : `localhost:6379`

## Authentification par défaut

- Utilisateur initial : `admin`
- Mot de passe initial : `admin`
- Le changement du mot de passe est obligatoire à la première connexion.
- Le token de connexion est conservé côté navigateur et reste valide 7 jours par défaut (`ACCESS_TOKEN_EXPIRE_MINUTES=10080`).

## Architecture

- `web` : interface dashboard + API FastAPI (Nginx + HTML/CSS/JS + Uvicorn)
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
- Connexion aux flux externes Isère : Météo-France (état de disponibilité et infos vigilance) et Vigicrues (stations du département + vigilances de tronçons + niveau d'alerte eau calculé).


## Géorisques API v2 (clé annuelle)

Pour enrichir les données départementales Isère (mouvements de terrain, cavités, radon, AZI) avec l'API v2 authentifiée, ajoutez votre clé dans le backend :

```bash
# .env (backend)
GEORISQUES_API_TOKEN=votre_cle_api
```

Sans clé, l'application bascule automatiquement sur l'API publique v1 (mode dégradé mais fonctionnel).

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
- `georisques` : synthèse multi-communes Isère (sismicité max, AZI, PPRN/PPRM/PPRT, DICRIM, TIM, information préventive risques, radon, mouvements de terrain et cavités).
- `prefecture_isere` : flux RSS des actualités de la Préfecture de l'Isère (titres, dates, liens).


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
