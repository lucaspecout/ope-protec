/**
 * Configuration du proxy API.
 *
 * Clés API:
 * - METEO_FRANCE_API_KEY: clé de l'API Bulletin Vigilance Météo-France.
 * - ITINISERE_API_KEY: clé Open Services Itinisère.
 */
module.exports = {
  port: process.env.PORT || 3000,

  meteoFrance: {
    apiKey: process.env.METEO_FRANCE_API_KEY || 'VOTRE_CLE_METEO_FRANCE_ICI',
    bulletinUrl:
      process.env.METEO_FRANCE_BULLETIN_URL ||
      'https://public-api.meteofrance.fr/public/DPVigilance/v1/bulletin',
    domain: process.env.METEO_FRANCE_DOMAIN || '38'
  },

  vigicrues: {
    geojsonUrl:
      process.env.VIGICRUES_GEOJSON_URL ||
      'https://www.vigicrues.gouv.fr/services/1/InfoVigiCru.geojson'
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379/0',
    ttlSeconds: Number(process.env.ITINISERE_CACHE_TTL_SECONDS || 3600)
  },

  itinisere: {
    apiKey: process.env.ITINISERE_API_KEY || '9fedf25a27bde6cad9e57d8c1c5a3b6e',
    baseUrl: process.env.ITINISERE_BASE_URL || 'https://www.itinisere.fr',
    endpoints: {
      nearestRoad: '/api/map/v2/GetNearestRoad/json',
      nearestPlace: '/api/map/v2/GetNearestPlace/json',
      placesByBoundingBox: '/api/map/v2/GetPlacesByBoundingBox/json',
      lineStopsByBoundingBox: '/api/map/v2/GetLineStopsByBoundingBox/json',
      stopsByBoundingBox: '/api/transport/v3/stop/GetStopsByBoundingBox/json',
      lines: '/api/transport/v3/line/GetLines/json',
      linesShapes: '/api/transport/v3/line/GetLinesShapes/json',
      networkRealtimeState: '/api/transport/v3/timetable/GetNetworkRealTimeState/json',
      monitoredStopPoints: '/api/transport/v3/timetable/GetMonitoredStopPoints/json',
      places: '/api/transport/v3/trippoint/GetPlaces/json',
      roadDisruptionsByBoundingBox: '/api/crowdsourcing/v1/GetRoadDisruptionsByBoundingBox/json'
    }
  }
};
