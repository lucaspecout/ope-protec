# Carte interactive Isère (Leaflet + proxy Node)

## Lancement

```bash
cd web/interactive-map
npm install
npm start
```

Puis ouvrir `http://localhost:3000`.

## Clés API

Renseigner les variables d'environnement (recommandé) ou adapter `config.js`:

- `METEO_FRANCE_API_KEY`
- `ITINISERE_API_KEY`

## Endpoints proxy exposés

- `GET /api/meteo-france/vigilance`
  - Proxy vers l'endpoint JSON Bulletin Vigilance Météo-France.
  - Ajoute l'en-tête `apikey` côté serveur.
- `GET /api/vigicrues/geojson`
  - Proxy GeoJSON de Vigicrues (ex: `InfoVigiCru.geojson` ou URL data.gouv de substitution).
- `GET /api/itinisere/events`
  - Proxy des événements de circulation Itinisère.
  - Ajoute `x-api-key` côté serveur.

## Rafraîchissement automatique

Dans `main.js`, la constante `REFRESH_INTERVAL_MS` est fixée à 5 minutes.

- `refreshLayers()` recharge les 3 couches via `fetch()`.
- `setInterval(refreshLayers, REFRESH_INTERVAL_MS)` relance automatiquement la synchronisation.
