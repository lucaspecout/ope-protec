/**
 * Configuration du proxy API.
 *
 * Où insérer les clés API:
 * - METEO_FRANCE_API_KEY: clé de l'API Bulletin Vigilance Météo-France.
 * - ITINISERE_API_KEY: clé Open Services Itinisère.
 *
 * Vous pouvez aussi définir ces valeurs via variables d'environnement
 * (recommandé en production) plutôt que de modifier ce fichier.
 */
module.exports = {
  port: process.env.PORT || 3000,

  meteoFrance: {
    apiKey: process.env.METEO_FRANCE_API_KEY || 'VOTRE_CLE_METEO_FRANCE_ICI',
    // Endpoint Bulletin Vigilance JSON (adapter selon votre offre/contrat API)
    bulletinUrl:
      process.env.METEO_FRANCE_BULLETIN_URL ||
      'https://public-api.meteofrance.fr/public/DPVigilance/v1/bulletin',
    domain: process.env.METEO_FRANCE_DOMAIN || '38'
  },

  vigicrues: {
    // Endpoint GeoJSON public; peut être remplacé par un dataset data.gouv simplifié.
    geojsonUrl:
      process.env.VIGICRUES_GEOJSON_URL ||
      'https://www.vigicrues.gouv.fr/services/1/InfoVigiCru.geojson'
  },

  itinisere: {
    apiKey: process.env.ITINISERE_API_KEY || 'VOTRE_CLE_ITINISERE_ICI',
    // Endpoint Open Services Itinisère (adapter à votre route exacte)
    eventsUrl:
      process.env.ITINISERE_EVENTS_URL ||
      'https://api.itinisere.fr/open-data/traffic/events'
  }
};
