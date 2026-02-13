# Carte interactive Isère (Leaflet + proxy Node)

## Lancement

```bash
cd web/interactive-map
npm install
npm start
```

Puis ouvrir `http://localhost:3000`.

## Clés API

- `METEO_FRANCE_API_KEY`
- `ITINISERE_API_KEY` (préconfigurée par défaut avec la clé fournie, surchargeable via variable d'environnement)

## Cache Redis

Le proxy met en cache les réponses Itinisère pendant 1h (par défaut) pour limiter les appels API.

Variables utiles :

- `REDIS_URL` (défaut: `redis://127.0.0.1:6379/0`)
- `ITINISERE_CACHE_TTL_SECONDS` (défaut: `3600`)

Si Redis est indisponible, l'application continue sans cache.

## Endpoints proxy exposés

### Sources existantes

- `GET /api/meteo-france/vigilance`
- `GET /api/vigicrues/geojson`

### Intégration Itinisère Open Services

- `GET /api/itinisere/nearest-road?lon=&lat=`
- `GET /api/itinisere/nearest-place?lon=&lat=`
- `GET /api/itinisere/places?minLon=&minLat=&maxLon=&maxLat=`
- `GET /api/itinisere/stops?minLon=&minLat=&maxLon=&maxLat=`
- `GET /api/itinisere/line-stops?minLon=&minLat=&maxLon=&maxLat=`
- `GET /api/itinisere/lines?networkId=`
- `GET /api/itinisere/line-shapes?networkId=`
- `GET /api/itinisere/realtime-state?networkId=`
- `GET /api/itinisere/monitored-stop-points?stopAreaId=`
- `GET /api/itinisere/trip-places?city=&category=&text=`
- `GET /api/itinisere/road-disruptions?minLon=&minLat=&maxLon=&maxLat=`

Le proxy ajoute automatiquement `apiKey` à chaque requête vers Itinisère.

## Couche carte Itinisère

L'interface Leaflet propose des couches activables/désactivables :

- Routes proches
- Perturbations routières crowdsourcées
- Arrêts transport
- POI / lieux publics
- Tracés des lignes

En cas d'indisponibilité Itinisère, un message « données mobilité non disponibles » est affiché.
