# Mise à jour des dépendances du 24 octobre 2026

Les versions ont été vérifiées sur PyPI, le registre npm et les images officielles Docker Hub. Les versions stables compatibles avec Python 3.12 sont épinglées dans `backend/requirements.txt`. Le fichier `backend/requirements.lock` verrouille également les dépendances indirectes, avec les conditions de plateforme nécessaires à Windows et Linux. Docker installe ce fichier verrouillé.

## Python

| Dépendance | Avant | Après |
| --- | --- | --- |
| FastAPI | 0.115.0 | 0.162.0 |
| Uvicorn | 0.30.6 | 0.54.0 |
| uvicorn-worker | module embarqué dans Uvicorn | 0.4.0 |
| SQLAlchemy | 2.0.35 | 2.1.6 |
| psycopg2-binary | 2.9.9 | 2.9.13 |
| python-multipart | 0.0.9 | 0.0.32 |
| bcrypt | 4.0.1 | 5.0.0 |
| Passlib | 1.7.4 | retiré ; utilisation directe de bcrypt |
| python-jose | 3.3.0 | 3.5.0 |
| redis (client Python) | 5.1.1 | 8.1.0 |
| pydantic-settings | 2.5.2 | 2.16.1 |
| Pydantic | indirecte, non verrouillée | 2.14.1 |
| cryptography | indirecte, non verrouillée | 50.0.2 |
| email-validator | 2.2.0 | 2.3.0 |
| ldap3 | 2.9.1 | 2.9.1, dernière stable publiée |
| Gunicorn | 22.0.0 | 26.2.0 |
| gtfs-realtime-bindings | ≥ 1.0.0, non épinglée | 3.0.0 |
| requests | 2.32.3 | 2.34.2 |
| urllib3 | 2.2.3 | 2.8.0 |
| Pillow | 10.4.0 | 13.0.0 |
| NumPy | 2.1.3 | 2.5.4 |
| h5py | 3.12.1 | 3.16.0 |
| pyproj | 3.7.0 | 3.8.0 |
| Shapely | 2.0.6 | 2.2.0 |
| tzdata | 2026.1 | 2026.5 |

`backend/requirements-test.txt` ajoute HTTPX 0.28.1 au verrouillage pour exécuter les contrats HTTP réels de FastAPI.

Adaptations effectuées :

- SQLAlchemy 2.1 utilise psycopg 3 par défaut pour les URL `postgresql://`. Leur pilote est rendu explicite dans `database.py`, en conservant psycopg2 et les URL existantes, y compris les mots de passe encodés et paramètres SSL.
- Les anciens hashes bcrypt `$2a$`, `$2b$` et `$2y$` restent utilisables. Le coût existant de 8 tours et le comportement historique de troncature UTF-8 à 72 octets sont conservés. Les tests utilisent notamment des hashes générés avec l’ancienne pile Passlib 1.7.4 / bcrypt 4.0.1.
- Gunicorn utilise désormais `uvicorn_worker.UvicornWorker`, fourni par le paquet dédié.

## Interface et images Docker

| Composant | Avant | Après |
| --- | --- | --- |
| Turf | branche 6 flottante | 7.4.0 |
| Chart.js | 4.4.0 | 4.6.1 |
| Leaflet | 1.9.4 | 1.9.4, dernière stable |
| Leaflet Draw | 1.0.4 | 1.0.4, dernière stable |
| Leaflet Heat | 0.2.0 | 0.2.0, dernière stable |
| Python | 3.12-slim | 3.12.15-slim |
| Nginx | 1.27-alpine | 1.30.6-alpine |
| PostgreSQL | 16-alpine | 16.15-alpine |
| Redis serveur | latest | 8.10.2 |

Les deux calculs d’intersection géographique utilisent la nouvelle signature Turf 7 : `intersect(featureCollection([a, b]))`. Les contrôles avec de vrais polygones vérifient les estimations de population et la ventilation par commune.

Le tag Redis 8.10.2 correspondait au même digest que `latest` au moment du contrôle. PostgreSQL reste sur la version majeure 16 pour préserver la compatibilité du volume de données ; une migration majeure demanderait un traitement distinct.

## Validation

- Résolution et installation des dépendances dans un environnement isolé Python 3.12.15 ; contrôle de compatibilité réussi.
- Correspondance de toutes les versions de production installées avec le fichier verrouillé sous Windows.
- Simulation d’installation des 51 paquets de production pour Linux x86-64 / Python 3.12, avec uniquement des distributions binaires : réussie, y compris uvloop.
- 276 tests Python réussis, aucun ignoré.
- 143 tests JavaScript réussis.
- 45 contrôles Edge sur ordinateur et 45 sur mobile réussis, dont les calculs réels avec Turf 7 et le rendu d’un graphique Chart.js 4.6.1.
- Compilation des fichiers Python et vérification des différences Git réussies.

La simulation Linux vérifie la résolution et la disponibilité des paquets, pas l’exécution du conteneur. Docker n’est pas disponible dans cet environnement : les images n’ont pas été construites ni déployées. Aucun service de production ni volume persistant n’a été modifié.

Pour appliquer les changements sur l’hôte Docker :

```sh
docker compose pull db redis
docker compose build --pull api web
docker compose up -d
```

Pour les vérifications locales après installation de Python 3.12 et Node.js :

```sh
python -m pip install -r backend/requirements-test.txt
python -m unittest discover -s backend/tests -p "test_*.py"
node --test tests/*.test.cjs
python scripts/smoke_hosting.py
```

Pour régénérer le verrouillage après une modification des versions directes :

```sh
uv pip compile backend/requirements.txt --universal --python-version 3.12 --output-file backend/requirements.lock
```

Références : [PyPI](https://pypi.org/), [registre npm](https://registry.npmjs.org/), [images officielles Docker](https://hub.docker.com/u/library), [signature Turf intersect](https://turfjs.org/docs/api/intersect), [versions stables Leaflet](https://leafletjs.com/download.html), [politique de versions PostgreSQL](https://www.postgresql.org/support/versioning/).
