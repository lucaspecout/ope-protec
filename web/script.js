// Blocage défensif des notifications navigateur.
// Les notifications opérationnelles conservées sont celles de l'interface et Discord.
(function disableBrowserNotifications() {
  try {
    localStorage.removeItem('browserNotifAlertStateV1');
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations()
        .then((registrations) => registrations.forEach((registration) => registration.unregister()))
        .catch(() => {});
    }
  } catch (_) {}
  try {
    if ('Notification' in window) {
      const BlockedNotification = function BlockedNotification() {
        return { close() {} };
      };
      Object.defineProperty(BlockedNotification, 'permission', { configurable: true, get: () => 'denied' });
      Object.defineProperty(BlockedNotification, 'requestPermission', { configurable: true, value: () => Promise.resolve('denied') });
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        writable: false,
        value: BlockedNotification,
      });
    }
  } catch (_) {}
})();

const STORAGE_KEYS = {
  token: 'token',
  activePanel: 'activePanel',
  appSidebarCollapsed: 'appSidebarCollapsed',
  mapPointsCache: 'mapPointsCache',
  municipalitiesCache: 'municipalitiesCache',
  eventsSnapshot: 'eventsSnapshot',
  logsSnapshot: 'logsSnapshot',
  usersSnapshot: 'usersSnapshot',
  dashboardSnapshot: 'dashboardSnapshot',
  externalRisksSnapshot: 'externalRisksSnapshot',
  apiInterconnectionsSnapshot: 'apiInterconnectionsSnapshot',
  homeLiveSnapshot: 'homeLiveSnapshot',
  staticInstitutionsCache: 'staticInstitutionsCacheV3',
  staticFinessCache: 'staticFinessCacheV3',
  staticDaeCache: 'staticDaeCacheV2',
  staticTelecomCache: 'staticTelecomCacheV1',
  staticMontagneCache: 'staticMontagneCacheV1',
  staticHelipadCache: 'staticHelipadCacheV1',
  staticBarrageCache: 'staticBarrageCacheV1',
  staticPrAutoroutesCache: 'staticPrAutoroutesCacheV1',
  serviceStatusHistory: 'serviceStatusHistory',
};
const AUTO_REFRESH_MS = 45000;
const EVENTS_LIVE_REFRESH_MS = 10000;
const HOME_LIVE_REFRESH_MS = 60000;
const STATION_TIMETABLE_REFRESH_MS = 60000;
const API_CACHE_TTL_MS = 45000;
const API_PANEL_REFRESH_MS = 60000;
const API_MAX_CONCURRENT_REQUESTS = 8;
const API_REQUEST_TIMEOUT_MS = 20000;
const API_SLOW_ENDPOINT_TIMEOUT_MS = 45000;
const LOGIN_REQUEST_TIMEOUT_MS = 20000;   // 20s — Docker cold start peut être lent
const SESSION_RESTORE_TIMEOUT_MS = 6000;  // 6s pour la vérification de session au démarrage
const API_RETRY_BASE_DELAY_MS = 500;
const API_MAX_RETRIES_GET = 3;
const API_MAX_RETRIES_NON_GET = 1;
const PENDING_SERVICE_AUTO_RETRY_MS = 15000;
const PENDING_SERVICE_SETTLE_MS = 250;
const API_ORIGIN_COOLDOWN_MS = 60000;
const STATIC_POINTS_CACHE_TTL_MS = 10 * 60 * 1000;
const TELECOM_POINTS_CACHE_TTL_MS = 10 * 60 * 1000;
const PR_AUTOROUTES_LOCAL_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const MAP_ROUTE_REFRESH_MS = 60 * 1000;
const OSM_DETAILS_MIN_ZOOM = 15;
const LAZY_ASSETS = {
  leafletCss: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  leafletDrawCss: 'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css',
  leafletJs: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  leafletDrawJs: 'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js',
  leafletHeatJs: 'https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js',
  turfJs: 'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js',
  chartJs: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
};
const lazyAssetPromises = new Map();
let mapBootstrapPromise = null;
const FLUX_SERVICES = [
  { key: 'meteo_france',           label: 'Météo-France',              icon: '⛅', category: 'Météo',         interval: 120,   metric: (d) => d.level ? `Vigilance ${d.level}` : `${(d.alerts || []).length} alerte(s)` },
  { key: 'apic_isere',             label: 'APIC · Pluie intense',      icon: '🌧️', category: 'Météo',        interval: 180,   metric: (d) => `${d.alerts_total ?? 0} avertissement(s)` },
  { key: 'vigicrues',              label: 'Vigicrues',                 icon: '🌊', category: 'Eau',           interval: 120,   metric: (d) => `${(d.stations || []).length} station(s) · niveau ${d.water_alert_level || '?'}` },
  { key: 'vigicrues_flash_isere',  label: 'Vigicrues Flash',           icon: '⚡', category: 'Eau',           interval: 180,   metric: (d) => `${d.alerts_total ?? 0} alerte(s) crues rapides` },
  { key: 'vigieau',                label: 'Vigieau · Restrictions eau', icon: '💧', category: 'Eau',          interval: 600,   metric: (d) => `${(d.alerts || []).length} restriction(s)` },
  { key: 'groundwater_isere',      label: "Hub'Eau · Nappes phréatiques", icon: '🏔️', category: 'Eau',        interval: 3600,  metric: (d) => `${d.stations_total ?? 0} station(s) · ↑${d.trend_summary?.hausse ?? 0} ↓${d.trend_summary?.baisse ?? 0} =${d.trend_summary?.stable ?? 0}` },
  { key: 'rnb_isere',              label: 'RNB · Bâtiments Isère',        icon: '🏢', category: 'Données',     interval: 1800,  metric: (d) => `${d.buildings_total ?? 0} bâtiment(s) détecté(s)` },
  { key: 'atmo_aura',              label: "Atmo AURA · Qualité de l'air", icon: '🌫️', category: 'Environnement', interval: 600, metric: (d) => d.today?.index ? `Indice ${d.today.index}${d.today.label ? ' — ' + d.today.label : ''}` : 'Indice non disponible' },
  { key: 'georisques',             label: 'Géorisques',                icon: '🌋', category: 'Risques',       interval: 600,   metric: (d) => `${d.flood_documents_total ?? 0} doc(s) inondation · zone sismique ${d.highest_seismic_zone_label || '?'}` },
  { key: 'itinisere',              label: 'Itinisère · Transports',    icon: '🚌', category: 'Transport',     interval: 120,   metric: (d) => `${d.events_total ?? (d.events || []).length} perturbation(s)` },
  { key: 'autoroutes_isere',       label: 'Autoroutes Isère',          icon: '🛣️', category: 'Transport',     interval: 180,   metric: (d) => `${d.events_total ?? 0} événement(s) · ${(d.routes || []).join(' ')}` },
  { key: 'sncf_isere',             label: 'SNCF Isère',                icon: '🚆', category: 'Transport',     interval: 120,   metric: (d) => `${(d.alerts || []).length} alerte(s) voie ferrée` },
  { key: 'ter_aura',               label: 'TER SNCF · AURA',           icon: '🚄', category: 'Transport',     interval: 120,   metric: (d) => `${d.disruptions_total ?? 0} perturbation(s) TER` },
  { key: 'mreseau',                 label: 'M Réseau · Grenoble',       icon: '🚊', category: 'Transport',     interval: 120,   metric: (d) => d.normal_service ? 'Trafic normal' : `${d.disruptions_total ?? 0} perturbation(s)` },
  { key: 'cars_region_aura',       label: 'Cars Région · AURA',        icon: '🚐', category: 'Transport',     interval: 300,   metric: (d) => `${d.disruptions_total ?? 0} perturbation(s) cars région` },
  { key: 'prefecture_isere',       label: 'Préfecture Isère',          icon: '🏛️', category: 'Actualités',   interval: 90,    metric: (d) => `${(d.items || []).length} actualité(s)` },
  { key: 'fr_alert_isere',         label: 'FR-Alert Isère',            icon: 'FR', category: 'Actualités',   interval: 90,    metric: (d) => `${d.today_count ?? 0} aujourd'hui · ${(d.events || []).length} alerte(s)` },
  { key: 'dauphine_isere',         label: 'Dauphiné Libéré',           icon: '📰', category: 'Actualités',   interval: 180,   metric: (d) => `${(d.items || []).length} article(s)` },
  { key: 'france_bleu_isere',      label: 'France Bleu Isère',         icon: '📻', category: 'Actualités',   interval: 180,   metric: (d) => `${(d.items || []).length} article(s)` },
  { key: 'placegrenet',            label: "Place Gre'net",             icon: '🗞️', category: 'Actualités',   interval: 180,   metric: (d) => `${(d.items || []).length} article(s)` },
  { key: 'grenoble_metro',         label: 'Grenoble Alpes Métropole',  icon: '🏙️', category: 'Actualités',   interval: 300,   metric: (d) => `${(d.items || []).length} actualité(s)` },
  { key: 'ars_aura',               label: 'ARS AURA · Santé',          icon: '🏥', category: 'Actualités',   interval: 300,   metric: (d) => `${(d.items || []).length} alerte(s) sanitaire(s)` },
  { key: 'seismes_isere',          label: 'Séismes Isère',             icon: '🌍', category: 'Risques',       interval: 600,   metric: (d) => `${(d.items || []).length} séisme(s) détecté(s)` },
  { key: 'avalanche_isere',        label: 'Avalanches BRA · Isère',    icon: '🏔️', category: 'Risques',       interval: 1800,  metric: (d) => `Niveau max ${d.niveau_max_bra ?? '?'}/5 · ${(d.massifs || []).length} massif(s)` },
  { key: 'feux_foret_isere',       label: 'Feux de forêt EFFIS',       icon: '🔥', category: 'Risques',       interval: 600,   metric: (d) => `${d.fires_total ?? 0} foyer(s) détecté(s) 24h` },
  { key: 'copernicus_ems',         label: 'GDACS · Catastrophes Europe',  icon: '🛰️', category: 'Risques',    interval: 1800,  metric: (d) => `${d.france_total ?? 0} événement(s) France · ${d.activations_total ?? 0} Europe` },
  { key: 'cols_alpins_isere',      label: 'Cols alpins Isère',         icon: '⛰️', category: 'Transport',     interval: 1800,  metric: (d) => `${d.cols_total ?? 0} cols · ${d.dangereux_total ?? 0} à surveiller` },
  { key: 'anfr_isere',             label: 'ANFR · Antennes mobiles',   icon: '📡', category: 'Télécom',       interval: 21600, metric: (d) => `${d.supports_total ?? 0} support(s) mobile recensés` },
  { key: 'arcep_isere',            label: 'ARCEP · Sites mobiles',     icon: '📶', category: 'Télécom',       interval: 600,   metric: (d) => `${d.outages_total ?? 0} indisponibilité(s)` },
  { key: 'isere_opendata',         label: 'Isère OpenData · Résilience', icon: '📊', category: 'Données',    interval: 1800,  metric: (d) => `${d.totals?.schools ?? 0} écoles · ${d.totals?.health_centers ?? 0} santé · ${d.totals?.food_aid_points ?? 0} aide alim.` },
  { key: 'finess_isere',           label: 'FINESS · Établissements santé', icon: '🏥', category: 'Santé',    interval: 21600, metric: (d) => `${d.resources_total ?? 0} établissement(s)` },
  { key: 'geodae_isere',           label: "Geo'DAE - Defibrillateurs", icon: 'DAE', category: 'Santé', interval: 21600, metric: (d) => `${d.resources_total ?? 0} DAE - ${d.available_24h_total ?? 0} 24h/24` },
];
const AUTOROUTES_ISERE_ROADS = Object.freeze(['A41', 'A43', 'A48', 'A49', 'A51', 'A480']);
const AUTOROUTES_ISERE_ROAD_SET = new Set(AUTOROUTES_ISERE_ROADS);
const AUTOROUTES_ISERE_ROAD_REGEX = /\bA\s?(480|49|48|51|43|41)\b/i;
const PANEL_TITLES = {
  'situation-panel': 'Situation opérationnelle',
  'services-panel': 'Services connectés',
  'stations-panel': 'Horaires gares Isere',
  'meteo-panel': 'Météo hebdomadaire Isère',
  'water-panel': 'Eau potable et assainissement',
  'contacts-panel': 'Contacts utiles Isère',
  'georisques-panel': 'Page Géorisques',
  'news-panel': 'Actualités Isère',
  'api-panel': 'Interconnexions API',
  'municipalities-panel': 'Communes partenaires',
  'logs-panel': 'Main courante opérationnelle',
  'map-panel': 'Carte stratégique Isère',
  'users-panel': 'Gestion des utilisateurs',
  'notifications-panel': 'Notifications Discord',
  'audit-panel': "Journal d'audit",
};

const PANEL_PRIORITY_SERVICES = {
  'situation-panel': ['meteo_france', 'vigicrues', 'apic_isere', 'vigicrues_flash_isere', 'fr_alert_isere', 'prefecture_isere'],
  'services-panel': ['meteo_france', 'vigicrues', 'apic_isere', 'vigicrues_flash_isere', 'itinisere', 'sncf_isere'],
  'meteo-panel': ['meteo_france', 'apic_isere', 'atmo_aura'],
  'water-panel': ['vigicrues', 'vigicrues_flash_isere', 'vigieau', 'groundwater_isere'],
  'news-panel': ['prefecture_isere', 'fr_alert_isere', 'dauphine_isere', 'france_bleu_isere', 'placegrenet', 'grenoble_metro', 'ars_aura'],
  'api-panel': ['meteo_france', 'vigicrues', 'apic_isere', 'fr_alert_isere'],
  'map-panel': ['meteo_france', 'vigicrues', 'itinisere', 'aprr_isere', 'vinci_autoroutes', 'seismes_isere', 'feux_foret_isere'],
  'stations-panel': ['sncf_isere', 'ter_aura'],
};

const RESOURCE_TYPE_META = {
  poste_commandement: { label: 'Poste de commandement', icon: '🛰️' },
  gymnase: { label: 'Gymnase', icon: '🏟️' },
  complexe_sportif: { label: 'Complexe sportif', icon: '🏋️' },
  stade: { label: 'Stade', icon: '🏟️' },
  salle_omnisports: { label: 'Salle omnisports / palais des sports', icon: '🏆' },
  centre_culturel: { label: 'Centre culturel', icon: '🏛️' },
  salle_spectacle_public: { label: 'Salle de spectacle / concert', icon: '🎭' },
  palais_congres: { label: 'Palais des congrès / convention', icon: '🏢' },
  salle_fetes: { label: 'Salle des fêtes / polyvalente', icon: '🎪' },
  hopital: { label: 'Hôpital', icon: '🏥' },
  hopital_public: { label: 'Centre hospitalier public', icon: '🏥' },
  hopital_prive: { label: 'Hôpital / établissement privé', icon: '🏥' },
  chu: { label: 'CHU (centre hospitalier universitaire)', icon: '🏨' },
  clinique: { label: 'Clinique', icon: '🩺' },
  medecin: { label: 'Médecins / cabinets médicaux', icon: '🩺' },
  ehpad: { label: 'EHPAD', icon: '🧓' },
  ecole_primaire: { label: 'École primaire', icon: '🧒' },
  college: { label: 'Collège', icon: '🎒' },
  lycee: { label: 'Lycée', icon: '📘' },
  universite: { label: 'Université', icon: '🎓' },
  creche: { label: 'Crèche', icon: '🍼' },
  gendarmerie: { label: 'Gendarmerie', icon: '🛡️' },
  commissariat_police_nationale: { label: 'Commissariat (police nationale)', icon: '🚓' },
  police_municipale: { label: 'Police municipale', icon: '👮' },
  caserne_pompier: { label: 'Caserne de pompiers', icon: '🚒' },
  caserne: { label: 'Caserne', icon: '🚒' },
  centrale_nucleaire: { label: 'Site nucléaire', icon: '☢️' },
  lieu_risque: { label: 'Site Seveso / risque technologique', icon: '⚠️' },
  lieu_vital: { label: 'Lieu vital logistique', icon: '📦' },
  transport: { label: 'Nœud transport', icon: '🚉' },
  transport_gare_sncf: { label: 'Gare SNCF', icon: '🚆' },
  transport_gare_routiere: { label: 'Gare routière', icon: '🚌' },
  transport_aeroport: { label: 'Aéroport', icon: '✈️' },
  energie: { label: 'Énergie / barrage', icon: '⚡' },
  protection_civile: { label: 'Antenne Protection Civile', icon: '🔺' },
  site_sensible_custom: { label: 'Site sensible (ajouté)', icon: '⚠️' },
  anfr_antenna: { label: 'Antenne ANFR', icon: '📡' },
  arcep_mobile_outage: { label: 'Site mobile indisponible (ARCEP)', icon: '🔴' },
  telecom_white_zone: { label: 'Zone blanche potentielle', icon: '📵' },
  defibrillateur: { label: 'Defibrillateur automatise externe', icon: '⚡' },
};

const RESOURCE_POINTS = [
  { id: 'pc-grenoble', name: 'Préfecture de l’Isère (PC départemental ORSEC)', type: 'poste_commandement', active: true, lat: 45.188179265241644, lon: 5.732620255019881, address: '12 Pl. de Verdun, 38000 Grenoble', priority: 'critical', info: 'Centre de commandement départemental activé en gestion de crise majeure.', source: 'https://www.isere.gouv.fr' },
  { id: 'hebergement-voiron', name: 'Gymnase municipal de Voiron (site d’hébergement d’urgence)', type: 'gymnase', active: true, lat: 45.36495, lon: 5.59244, address: 'Avenue Jules Ravat, 38500 Voiron', priority: 'vital', info: 'Structure mobilisable pour mise à l’abri temporaire et accueil évacués.', source: 'https://www.ville-voiron.fr' },
  { id: 'chu-grenoble', name: 'CHU Grenoble Alpes – Site Nord (Hôpital Michallon)', type: 'hopital', active: true, lat: 45.19890130472817, lon: 5.745337307337676, address: 'Bd de la Chantourne, 38700 La Tronche', priority: 'critical', info: 'Pôle sanitaire de référence (SAMU 38, urgences, réanimation, trauma center).', source: 'https://www.chu-grenoble.fr' },
  { id: 'chu-grenoble-sud', name: 'CHU Grenoble Alpes - Site SUD', type: 'hopital', active: true, lat: 45.14824137405201, lon: 5.732509610468402, address: 'Hôpital Michallon, Chu de Grenoble, 38043 Grenoble', priority: 'vital', info: 'Site hospitalier mobilisable pour la continuité de la réponse sanitaire en crise.', source: 'https://www.chu-grenoble.fr' },
  { id: 'ch-vienne', name: 'Centre hospitalier Lucien Hussel', type: 'hopital', active: true, lat: 45.533846044381946, lon: 4.880350896438764, address: 'Montee Dr Maurice Chapuis, 38200 Vienne', priority: 'vital', info: 'Hôpital pivot pour le sud-ouest du département et la vallée du Rhône.', source: 'https://www.ch-vienne.fr' },
  { id: 'sdis-bj', name: 'SDIS 38 – CSP Bourgoin-Jallieu', type: 'caserne', active: true, lat: 45.59259063641058, lon: 5.259705725092601, address: '59 Rue Lavoisier, 38300 Bourgoin-Jallieu', priority: 'vital', info: 'Point de projection stratégique sur l’axe A43 et Nord-Isère.', source: 'https://www.sdis38.fr' },
  { id: 'sdis38-em', name: 'État-major du Service Départemental d\'Incendie et de Secours de l\'Isère', type: 'poste_commandement', active: true, lat: 45.187614671926696, lon: 5.683126256547923, address: '24 Rue René Camphin, 38600 Fontaine', priority: 'critical', info: 'État-major départemental de coordination des moyens d\'incendie et de secours.', source: 'https://www.sdis38.fr' },
  { id: 'cea-grenoble', name: 'CEA Grenoble – Presqu’île scientifique', type: 'centrale_nucleaire', active: true, lat: 45.201145835693275, lon: 5.705203927562952, address: '17 Av. des Martyrs, 38000 Grenoble', priority: 'critical', info: 'Site de recherche sensible avec enjeux continuité d’activité et sûreté.', source: 'https://www.cea.fr' },
  { id: 'cnpe-saint-alban', name: 'CNPE EDF Saint-Alban / Saint-Maurice', type: 'centrale_nucleaire', active: true, lat: 45.405422953042404, lon: 4.757081312357517, address: 'Rte de la Centrale, 38550 Saint-Maurice-l\'Exil', priority: 'risk', info: 'Installation nucléaire majeure sous surveillance pour la frange sud-ouest Isère.', source: 'https://www.edf.fr/centrale-nucleaire-saint-alban' },
  { id: 'pont-de-claix-chem', name: 'Plateforme chimique de Pont-de-Claix', type: 'lieu_risque', active: true, lat: 45.13180530005534, lon: 5.706618216387599, address: 'Francia, Rue Lavoisier, Le Pont-de-Claix', priority: 'risk', info: 'Cluster industriel SEVESO de l’agglomération grenobloise.', source: 'https://www.pontdeclaix.fr' },
  { id: 'gare-grenoble', name: 'Gare de Grenoble', type: 'transport_gare_sncf', active: true, lat: 45.19142, lon: 5.71472, address: '1 place de la Gare, 38000 Grenoble', priority: 'vital', info: 'Hub ferroviaire principal pour mobilité de crise et évacuation.', source: 'https://www.garesetconnexions.sncf/fr/gares-services/grenoble' },
  { id: 'barrage-verney', name: 'Barrage du Verney', type: 'energie', active: true, lat: 45.12920201985221, lon: 6.043436022227785, address: '38114 Allemond', priority: 'risk', info: 'Ouvrage hydraulique structurant de la vallée de l’Eau d’Olle.', source: 'https://www.edf.fr/hydraulique-isere' },
  { id: 'plateforme-chem-jarrie', name: 'Plateforme chimique de Jarrie', type: 'lieu_risque', active: true, lat: 45.08694132318529, lon: 5.736251871908567, address: 'N85 BP 16, 38560 Jarrie', priority: 'risk', info: 'Zone industrielle sensible en continuité du couloir chimique sud grenoblois.', source: 'https://www.jarrie.fr' },
  { id: 'centrale-barrage-grandmaison', name: 'STEP de Grand’Maison', type: 'energie', active: true, lat: 45.206053828393784, lon: 6.116978747872993, address: '38114 Vaujany', priority: 'risk', info: 'Infrastructure énergétique stratégique pour la stabilité du réseau.', source: 'https://www.edf.fr/hydraulique-isere' },
  { id: 'aeroport-grenoble', name: 'Aéroport Grenoble Alpes Isère', type: 'transport_aeroport', active: true, lat: 45.361, lon: 5.33056, address: '38590 Saint-Étienne-de-Saint-Geoirs', priority: 'vital', info: 'Plateforme aérienne de soutien logistique et d’évacuation sanitaire.', source: 'https://www.grenoble-airport.com' },
  { id: 'palais-sports', name: 'Palais des Sports de Grenoble (centre d’accueil)', type: 'salle_spectacle_public', active: true, lat: 45.18565564489357, lon: 5.7408451908719655, address: '14 Bd Clemenceau, 38029 Grenoble', priority: 'vital', info: 'Site de regroupement mobilisable pour accueil population/renforts.', source: 'https://www.grenoble.fr' },
  { id: 'summum-grenoble', name: 'Le Summum (Grenoble Alpes Métropole)', type: 'salle_spectacle_public', active: true, lat: 45.156988, lon: 5.716922, address: 'Rue Henri Barbusse, 38100 Grenoble', priority: 'vital', info: 'Salle événementielle mobilisable pour accueil temporaire en cas de crise.', source: 'https://www.summumgrenoble.com' },
  { id: 'mc2-grenoble', name: 'MC2: Maison de la Culture de Grenoble', type: 'centre_culturel', active: true, lat: 45.166739, lon: 5.735104, address: '4 Rue Paul Claudel, 38100 Grenoble', priority: 'vital', info: 'Équipement culturel public pouvant soutenir un dispositif d’accueil exceptionnel.', source: 'https://www.mc2grenoble.fr' },
  { id: 'halle-tonnelle-fontaine', name: 'Halle de la Tonnelle (Fontaine)', type: 'salle_fetes', active: true, lat: 45.192873, lon: 5.68872, address: 'Rue de la Liberté, 38600 Fontaine', priority: 'vital', info: 'Salle polyvalente mobilisable pour hébergement d’appoint.', source: 'https://www.ville-fontaine.fr' },
  { id: 'barrage-chambon', name: 'Barrage du Chambon', type: 'energie', active: true, lat: 45.04554730445581, lon: 6.137479156603567, address: '38860 Les Deux Alpes', priority: 'risk', info: 'Barrage alpin stratégique de la vallée de la Romanche.', source: 'https://fr.wikipedia.org/wiki/Barrage_du_Chambon' },
  { id: 'barrage-sautet', name: 'Barrage du Sautet', type: 'energie', active: true, lat: 44.81749004792632, lon: 5.908287667268233, address: '38970 Pellafol', priority: 'risk', info: 'Ouvrage hydroélectrique majeur entre Isère et Hautes-Alpes.', source: 'https://fr.wikipedia.org/wiki/Barrage_du_Sautet' },
  { id: 'barrage-saint-pierre-cognet', name: 'Barrage de Saint-Pierre-Cognet', type: 'energie', active: true, lat: 44.8766210455462, lon: 5.8038682262595644, address: '38350 Saint-Pierre-de-Méaroz', priority: 'risk', info: 'Barrage de la vallée du Drac intégré à la chaîne hydroélectrique locale.', source: 'https://fr.wikipedia.org/wiki/Barrage_de_Saint-Pierre-Cognet' },
  { id: 'barrage-monteynard', name: 'Barrage de Monteynard', type: 'energie', active: true, lat: 44.96155501047247, lon: 5.688786660513596, address: '38650 Avignonet', priority: 'risk', info: 'Grand lac de retenue du Drac, sensible pour la gestion hydraulique départementale.', source: 'https://fr.wikipedia.org/wiki/Barrage_de_Monteynard-Avignonet' },
  { id: 'barrage-nd-com' , name: 'Barrage de Notre-Dame-de-Commiers', type: 'energie', active: true, lat: 45.005935722637325, lon: 5.688129616155315, address: '38450 Notre-Dame-de-Commiers', priority: 'risk', info: 'Barrage situé en aval de Monteynard sur l’axe hydraulique du Drac.', source: 'https://fr.wikipedia.org/wiki/Barrage_de_Notre-Dame-de-Commiers' },
  { id: 'seveso-seqens-bj', name: 'Pcas - Seqens', type: 'lieu_risque', active: true, lat: 45.594926837137486, lon: 5.261413249717274, address: '38300 Bourgoin-Jallieu', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.02822).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-finorga', name: 'Finorga-Novasep', type: 'lieu_risque', active: true, lat: 45.58200705628313, lon: 4.78812425892635, address: '38670 Chasse-sur-Rhône', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.02857).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-stmicro-crolles', name: 'ST Microelectronics', type: 'lieu_risque', active: true, lat: 45.2667763, lon: 5.8841567, address: '38920 Crolles', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.02885).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-sobegal-domene', name: 'Sobegal', type: 'lieu_risque', active: true, lat: 45.20126076730851, lon: 5.826417249715717, address: '38420 Domène', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.02904).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-umicore-grenoble', name: 'Umicore Specialty Powders France', type: 'lieu_risque', active: true, lat: 45.1740634, lon: 5.703482, address: '38000 Grenoble', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.02962).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-adisseo-stclair', name: 'Adisseo France Sas (Saint-Clair-du-Rhône)', type: 'lieu_risque', active: true, lat: 45.4407742, lon: 4.7644548, address: '38370 Saint-Clair-du-Rhône', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.05225).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-sigma-sqf', name: 'Sigma Aldrich Chimie', type: 'lieu_risque', active: true, lat: 45.64319117656856, lon: 5.094081751338476, address: '38070 Saint-Quentin-Fallavier', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.03159).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-titanobel-stq', name: 'Titanobel', type: 'lieu_risque', active: true, lat: 45.254661813860125, lon: 5.627549791920214, address: '38210 Saint-Quentin-sur-Isère', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.03169).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-suez-salaise', name: 'Suez Rr Iws Chemicals France (Salaise-sur-Sanne)', type: 'lieu_risque', active: true, lat: 45.3441237, lon: 4.8189855, address: '38150 Salaise-sur-Sanne', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0104.00032).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-novapex-salaise', name: 'Novapex', type: 'lieu_risque', active: true, lat: 45.3441237, lon: 4.8189855, address: '38150 Salaise-sur-Sanne', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0104.00104).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-hlog-salaise', name: 'Hlog C/O Océdis', type: 'lieu_risque', active: true, lat: 45.3441237, lon: 4.8189855, address: '38150 Salaise-sur-Sanne', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.03188).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-rubis-salaise', name: 'Rubis Terminal', type: 'lieu_risque', active: true, lat: 45.3470615, lon: 4.7867574, address: '38150 Salaise-sur-Sanne', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.03181).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-engrais-salaise', name: 'Engrais Sud Vienne', type: 'lieu_risque', active: true, lat: 45.3362562, lon: 4.7885365, address: '38150 Salaise-sur-Sanne', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.03180).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-pec-tredi-salaise', name: 'Pec Tredi', type: 'lieu_risque', active: true, lat: 45.3441237, lon: 4.8189855, address: '38150 Salaise-sur-Sanne', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.03190).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-thor-salaise', name: 'Thor', type: 'lieu_risque', active: true, lat: 45.3385579, lon: 4.8002861, address: '38150 Salaise-sur-Sanne', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.03183).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-elkem-salaise', name: 'Elkem Silicones France', type: 'lieu_risque', active: true, lat: 45.360477592838244, lon: 4.795869508883314, address: '38150 Salaise-sur-Sanne', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.05222).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-total-serpaize', name: 'Total Raffinage France (Serpaize)', type: 'lieu_risque', active: true, lat: 45.57315591438844, lon: 4.931628272923433, address: '38200 Serpaize', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.02999).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-esso-villette', name: 'Esso S.A.F.', type: 'lieu_risque', active: true, lat: 45.5867649, lon: 4.9140734, address: '38200 Villette-de-Vienne', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.03258).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-spmr-villette', name: 'Spmr', type: 'lieu_risque', active: true, lat: 45.5745417, lon: 4.915693, address: '38200 Villette-de-Vienne', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.03261).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  { id: 'seveso-stepan-voreppe', name: 'Stepan Europe Sa', type: 'lieu_risque', active: true, lat: 45.292283, lon: 5.6235683, address: '38340 Voreppe', priority: 'risk', info: 'Établissement SEVESO seuil haut (code S3IC 0061.03282).', source: 'https://www.georisques.gouv.fr/risques/installations/donnees' },
  // ─── Antennes Protection Civile ──────────────────────────────────────────────
  { id: 'pc-grenoble-antenne', name: 'Antenne de Grenoble — Protection Civile', type: 'protection_civile', active: true, lat: 45.191296, lon: 5.689586, address: '1 Rue des Marronniers, 38600 Fontaine', priority: 'vital', info: 'Antenne Protection Civile de Grenoble.', source: '' },
  { id: 'pc-vri', name: 'Antenne de VRI — Protection Civile', type: 'protection_civile', active: true, lat: 45.339315, lon: 4.915945, address: 'Route de Bel Air, 38150 Bougé-Chambalud', priority: 'vital', info: 'Antenne Protection Civile de VRI.', source: '' },
  { id: 'pc-rhone', name: 'Antenne du Rhône — Protection Civile', type: 'protection_civile', active: true, lat: 45.720708, lon: 4.866714, address: '158 avenue Francis de Pressensé, 69200 Vénissieux', priority: 'vital', info: 'Antenne Protection Civile du Rhône.', source: '' },
  { id: 'pc-tassin', name: 'Antenne de Tassin — Protection Civile', type: 'protection_civile', active: true, lat: 45.759879, lon: 4.779425, address: '13 Avenue de Lauterbourg, 69160 Tassin-la-Demi-Lune', priority: 'vital', info: 'Antenne Protection Civile de Tassin.', source: '' },
  { id: 'pc-drome', name: 'Antenne de la Drôme — Protection Civile', type: 'protection_civile', active: true, lat: 44.936273, lon: 4.919106, address: '74 Route de Montélier, 26000 Valence', priority: 'vital', info: 'Antenne Protection Civile de la Drôme.', source: '' },
  { id: 'pc-nord-drome', name: 'Antenne Nord Drôme — Protection Civile', type: 'protection_civile', active: true, lat: 45.022872, lon: 5.045960, address: '435 chemin des Passas, 26300 Bourg-de-Péage', priority: 'vital', info: 'Antenne Protection Civile Nord Drôme.', source: '' },
  { id: 'pc-sud-drome', name: 'Antenne Sud Drôme — Protection Civile', type: 'protection_civile', active: true, lat: 44.661916, lon: 4.791205, address: '1 Avenue du Blomard, 26740 Les Tourrettes', priority: 'vital', info: 'Antenne Protection Civile Sud Drôme.', source: '' },
  { id: 'pc-balan', name: 'Antenne de Balan — Protection Civile', type: 'protection_civile', active: true, lat: 45.836997, lon: 5.094751, address: 'Rue des Écoles, 01360 Balan', priority: 'vital', info: 'Antenne Protection Civile de Balan (Ain).', source: '' },
  { id: 'pc-bourg', name: 'Antenne de Bourg-en-Bresse — Protection Civile', type: 'protection_civile', active: true, lat: 46.203862, lon: 5.208437, address: '14 Rue Abbé Gorini, 01000 Bourg-en-Bresse', priority: 'vital', info: 'Antenne Protection Civile de Bourg-en-Bresse.', source: '' },
  { id: 'pc-gex', name: 'Antenne Pays de Gex — Protection Civile', type: 'protection_civile', active: true, lat: 46.336459, lon: 6.069914, address: '36 Rue de Pitegny, 01170 Gex', priority: 'vital', info: 'Antenne Protection Civile du Pays de Gex.', source: '' },
  { id: 'pc-rumilly', name: 'Antenne de Rumilly — Protection Civile', type: 'protection_civile', active: true, lat: 45.859974, lon: 5.957009, address: '1 Rue des Bauges, 74150 Rumilly', priority: 'vital', info: 'Antenne Protection Civile de Rumilly (Haute-Savoie).', source: '' },
  { id: 'pc-annemasse', name: 'Antenne d\'Annemasse — Protection Civile', type: 'protection_civile', active: true, lat: 46.196477, lon: 6.232161, address: '13 Avenue Emile Zola, 74100 Annemasse', priority: 'vital', info: 'Antenne Protection Civile d\'Annemasse.', source: '' },
  { id: 'pc-chambery', name: 'Antenne de Chambéry — Protection Civile', type: 'protection_civile', active: true, lat: 45.591000, lon: 5.951000, address: '2610 avenue des Landiers, 73000 Chambéry', priority: 'vital', info: 'Antenne Protection Civile de Chambéry.', source: '' },
  { id: 'pc-hautes-alpes-briancon', name: 'Antenne des Hautes-Alpes — Protection Civile', type: 'protection_civile', active: true, lat: 44.89663846389449, lon: 6.635444741586887, address: '6 place Paul Blein, 05100 Briançon', priority: 'vital', info: 'Antenne Protection Civile des Hautes-Alpes.', source: '' },
];

let token = localStorage.getItem(STORAGE_KEYS.token);
let currentUser = null;
const MAIRIE_ALLOWED_PANELS = new Set([
  'situation-panel',
  'services-panel',
  'stations-panel',
  'meteo-panel',
  'water-panel',
  'contacts-panel',
  'georisques-panel',
  'municipalities-panel',
  'logs-panel',
  'map-panel',
]);
let pendingCurrentPassword = '';
let refreshTimer = null;
let liveEventsTimer = null;
let homeLiveTimer = null;
let stationTimetableTimer = null;
let apiPanelTimer = null;
let apiResyncTimer = null;
let agentMarkersTimer = null;
let refreshAllInFlight = null;
let _lastRefreshAllTs = 0;
let _lastServerSnapshotAt = 0;
let _serverSnapshotSyncing = false;
let _liveEventsFailCount = 0;
let lastApiResyncAt = null;
let isLoginSubmitting = false;
let externalRisksRenderTimer = 0;
const apiGetCache = new Map();
const apiInFlight = new Map();
const apiRequestQueue = [];
let apiActiveRequests = 0;
let preferredApiOrigin = window.location.origin;
const apiOriginFailures = new Map();
const startupQueueState = { total: 0, completed: 0, current: '' };
const panelLoadingState = new Map();
const serviceRefreshRequestState = new Map();

const ISERE_MAJOR_CITIES = [
  { key: 'grenoble', name: 'Grenoble', lat: 45.1885, lon: 5.7245, population: 158180 },
  { key: 'smh', name: 'Saint-Martin-d’Hères', lat: 45.1656, lon: 5.7634, population: 38980 },
  { key: 'echirolles', name: 'Échirolles', lat: 45.146, lon: 5.7144, population: 36500 },
  { key: 'vienne', name: 'Vienne', lat: 45.5257, lon: 4.8748, population: 31320 },
  { key: 'bourgoin', name: 'Bourgoin-Jallieu', lat: 45.5861, lon: 5.2736, population: 28710 },
  { key: 'voiron', name: 'Voiron', lat: 45.3659, lon: 5.5926, population: 20600 },
  { key: 'isle', name: 'L’Isle-d’Abeau', lat: 45.6256, lon: 5.226, population: 16840 },
  { key: 'meylan', name: 'Meylan', lat: 45.2125, lon: 5.7773, population: 17790 },
  { key: 'fontaine', name: 'Fontaine', lat: 45.1939, lon: 5.6856, population: 22400 },
  { key: 'pont-claix', name: 'Le Pont-de-Claix', lat: 45.1245, lon: 5.7064, population: 10900 },
  { key: 'seyssinet', name: 'Seyssinet-Pariset', lat: 45.1765, lon: 5.6946, population: 12000 },
  { key: 'saint-egreve', name: 'Saint-Égrève', lat: 45.2339, lon: 5.6819, population: 16000 },
  { key: 'coublevie', name: 'Coublevie', lat: 45.3567, lon: 5.6181, population: 5200 },
  { key: 'moirans', name: 'Moirans', lat: 45.3267, lon: 5.5642, population: 7800 },
  { key: 'tullins', name: 'Tullins', lat: 45.2989, lon: 5.4852, population: 7700 },
  { key: 'saint-marcellin', name: 'Saint-Marcellin', lat: 45.1514, lon: 5.3199, population: 7800 },
  { key: 'vinay', name: 'Vinay', lat: 45.2106, lon: 5.4070, population: 4300 },
  { key: 'la-cote-saint-andre', name: 'La Côte-Saint-André', lat: 45.3940, lon: 5.2593, population: 4800 },
  { key: 'beaurepaire', name: 'Beaurepaire', lat: 45.3382, lon: 5.0557, population: 5000 },
  { key: 'roussillon', name: 'Roussillon', lat: 45.3737, lon: 4.8123, population: 8300 },
  { key: 'peage-roussillon', name: 'Le Péage-de-Roussillon', lat: 45.3732, lon: 4.7970, population: 6600 },
  { key: 'saint-maurice-exil', name: 'Saint-Maurice-l’Exil', lat: 45.3983, lon: 4.7742, population: 6300 },
  { key: 'pont-eveque', name: 'Pont-Évêque', lat: 45.5314, lon: 4.9148, population: 5200 },
  { key: 'heyrieux', name: 'Heyrieux', lat: 45.6314, lon: 5.0639, population: 4800 },
  { key: 'villefontaine', name: 'Villefontaine', lat: 45.6122, lon: 5.1494, population: 19200 },
  { key: 'la-verpilliere', name: 'La Verpillière', lat: 45.6356, lon: 5.1453, population: 7300 },
  { key: 'morestel', name: 'Morestel', lat: 45.6750, lon: 5.4707, population: 4500 },
  { key: 'cremieu', name: 'Crémieu', lat: 45.7258, lon: 5.2493, population: 3400 },
  { key: 'pontcharra', name: 'Pontcharra', lat: 45.4328, lon: 6.0181, population: 7300 },
  { key: 'crolles', name: 'Crolles', lat: 45.2850, lon: 5.8836, population: 8300 },
  { key: 'goncelin', name: 'Goncelin', lat: 45.3420, lon: 5.9780, population: 2500 },
  { key: 'villard-bonnot', name: 'Villard-Bonnot', lat: 45.2407, lon: 5.8909, population: 7200 },
  { key: 'vizille', name: 'Vizille', lat: 45.0782, lon: 5.7708, population: 7300 },
  { key: 'vif', name: 'Vif', lat: 45.0548, lon: 5.6713, population: 8600 },
  { key: 'varces', name: 'Varces-Allières-et-Risset', lat: 45.0882, lon: 5.6839, population: 8200 },
  { key: 'la-mure', name: 'La Mure', lat: 44.9025, lon: 5.7868, population: 5000 },
  { key: 'mens', name: 'Mens', lat: 44.8172, lon: 5.7511, population: 1400 },
  { key: 'bourg-oisans', name: 'Le Bourg-d’Oisans', lat: 45.0549, lon: 6.0336, population: 3300 },
  { key: 'alpe-huez', name: 'Huez / Alpe d’Huez', lat: 45.0919, lon: 6.0693, population: 1300 },
  { key: 'saint-jean-bournay', name: 'Saint-Jean-de-Bournay', lat: 45.5016, lon: 5.1394, population: 4700 },
  { key: 'les-abrets', name: 'Les Abrets en Dauphiné', lat: 45.5370, lon: 5.5838, population: 6500 },
  { key: 'tour-du-pin', name: 'La Tour-du-Pin', lat: 45.5660, lon: 5.4482, population: 8200 },
  { key: 'charvieu', name: 'Charvieu-Chavagneux', lat: 45.7481, lon: 5.1554, population: 9900 },
];
let meteoCityOptions = [...ISERE_MAJOR_CITIES];

let leafletMap = null;
let boundaryLayer = null;
let hydroLayer = null;
let hydroLineLayer = null;
// Index des marqueurs/polylines existants pour mise à jour sans clearLayers
const hydroMarkersByCode = new Map();
const hydroLinesByCode = new Map();
let pcsBoundaryLayer = null;
let pcsLayer = null;
let resourceLayer = null;
let searchLayer = null;
let customPointsLayer = null;
let mapPointsLayer = null;
let itinisereLayer = null;
let bisonLayer = null;
let bisonCameraLayer = null;
let autorouteLayer = null;
let prAutorouteLayer = null;
let tchooTrainLayer = null;
let tchooRailTileLayer = null;
let tchooTrainTimer = null;
let institutionLayer = null;
let populationLayer = null;
let mapTileLayer = null;
let mapFloodOverlayLayer = null;
let googleTrafficFlowLayer = null;
let floodZoneWmsLayer = null;
let avalancheZoneWmsLayer = null;
let barrageMarkerLayer = null;
let montagneLayer = null;
let helipadLayer = null;
let seismesLayer = null;
let feuxForetLayer = null;
let colsAlpinsLayer = null;
let meteoCitiesLayer = null;
let populationHeatLayer = null;
let userLocationMarker = null;
let mapAddPointMode = false;
let mapPoints = [];
let mapAnnotations = [];
let mapAnnotationsSync = null;
let externalRisksSSE = null;
let mapDrawControl = null;
let mapAnnotationFeatureGroup = null;
let mapZoneImpactLayer = null;
let mapZoneImpactSelection = null;
let mapZoneImpactDrawHandler = null;
let mapZoneImpactComputationSeq = 0;
let mapZoneImpactReportData = null; // stocke les données brutes pour l'export
let mapEvacuationCircleLayer = null;
let mapEvacuationCircleMode = false;
let mapEvacuationCircle = null;
let mapMeasureLayer = null;
let mapMeasureMode = false;
let mapMeasurePoints = [];
let mapRouteLayer = null;
let mapRouteMode = false;
let mapRoutePoints = [];
let mapRoutes = [];
let mapRouteIdSeq = 1;
let mapRouteRefreshTimer = null;
let mapRouteAbortController = null;
let mapRouteRequestSeq = 0;
const mapPointVisibilityOverrides = new Map();
const resourceVisibilityOverrides = new Map();
let pendingMapPointCoords = null;
let mapIconTouched = false;
let cachedStations = [];
let cachedVigicruesPayload = { stations: [], troncons: [] };
let cachedMunicipalities = [];
let cachedMunicipalityRecords = [];
let cachedItinisereEvents = [];
let cachedItinisereWebcams = [];
let itinisereWebcamsInFlight = null;
let cachedBisonFute = {};
let cachedBisonLiveEvents = [];
let geocodeCache = new Map();
let municipalityContourCache = new Map();
const municipalityDocumentsUiState = new Map();
let trafficGeocodeCache = new Map();
let mapStats = { stations: 0, pcs: 0, resources: 0, custom: 0, traffic: 0 };
let mapControlsCollapsed = false;
let mapStreetViewMode = false;
const TACTICAL_LAYER_CATEGORIES = new Set(['evacuation', 'rassemblement', 'roadblock', 'barriere', 'danger_zone', 'centre_accueil', 'team']);
const GEORISQUES_WMS_URL = 'https://www.georisques.gouv.fr/services';
const GEORISQUES_FLOOD_PPRI_LAYER = 'PPRN_ZONE_INOND';
const GEORISQUES_FLOOD_TRI_LAYERS = [
  'ALEA_SYNT_01_01FOR_FXX',
  'ALEA_SYNT_01_02MOY_FXX',
  'ALEA_SYNT_01_04FAI_FXX',
].join(',');
let cachedCrisisPoints = [];
let cachedEvents = [];
let selectedOperationalEventId = null;
let cachedLogs = [];
let mcoEventFilter = 'open'; // 'open' | 'all' | 'clos'
let cachedDashboardSnapshot = {};
let cachedExternalRisksSnapshot = {};
let cachedWeeklyMeteo = null;
let weeklyMeteoInFlight = null;
const meteoAirQualityCache = new Map();
const meteoAirQualityInFlight = new Map();
let selectedMeteoCityKey = ISERE_MAJOR_CITIES[0]?.key || 'grenoble';
let selectedWaterMunicipalityId = '';
let selectedContactsCity = '';
let stationsTimetableCache = null;
let stationsTimetableInFlight = null;
let selectedStationFilter = '';
const STATION_OPERATIONAL_INFO = Object.freeze({
  grenoble: {
    sector: 'Agglomeration grenobloise',
    role: 'Hub principal Isere pour evacuation, relai equipes et regroupement voyageurs.',
    connections: ['TER Lyon / Valence / Chambery / Gap', 'Tram A/B, Chrono, gare routiere'],
    attention: 'Affluence forte et parvis dense: prevoir un point de rendez-vous visible hors hall.',
    usefulFor: ['Centre OPE', 'transfert intermodal', 'point presse / accueil familles'],
  },
  'grenoble-universites-gieres': {
    sector: 'Campus / Est grenoblois',
    role: 'Gare de desserte campus et porte est de l agglomeration.',
    connections: ['TER Grenoble - Chambery', 'Tram B, lignes campus'],
    attention: 'Flux etudiants importants aux heures de pointe; acces utiles cote campus.',
    usefulFor: ['renfort campus', 'repli est agglo', 'navettes universitaires'],
  },
  echirolles: {
    sector: 'Sud agglomeration',
    role: 'Appui ferroviaire pour Echirolles, quartiers sud et acces rocade.',
    connections: ['TER axe Grenoble - Vif / Clelles', 'Tram A, bus sud agglo'],
    attention: 'Verifier les cheminements pietons si operation nocturne ou meteo degradee.',
    usefulFor: ['evacuation sud agglo', 'liaison tram/train', 'renfort urbain'],
  },
  'pont-de-claix': {
    sector: 'Sud industriel',
    role: 'Point rail proche plateformes industrielles et entree vallee du Drac.',
    connections: ['TER Grenoble - Gap', 'bus sud grenoblois'],
    attention: 'Secteur industriel: croiser avec les risques technologiques et plans de circulation.',
    usefulFor: ['incident industriel', 'filtrage acces sud', 'acheminement equipes'],
  },
  'jarrie-vizille': {
    sector: 'Romanche / Vizille',
    role: 'Acces rail pour Vizille, Jarrie et debut vallee de la Romanche.',
    connections: ['TER Grenoble - Gap', 'cars vers Vizille / Oisans'],
    attention: 'Surveillance utile en cas de crue Romanche ou contraintes routieres RN85/RD.',
    usefulFor: ['porte Oisans', 'relai cars', 'repli vallee'],
  },
  vif: {
    sector: 'Trièves nord',
    role: 'Gare d appui entre agglomeration grenobloise et Trièves.',
    connections: ['TER Grenoble - Gap', 'cars locaux'],
    attention: 'Verifier disponibilite des parkings et routes de rabattement en episode neige.',
    usefulFor: ['repli sud', 'evacuation secteur Vif', 'liaison montagne'],
  },
  'saint-georges-de-commiers': {
    sector: 'Drac / Monteynard',
    role: 'Point de jonction utile pour le sud grenoblois et secteur Monteynard.',
    connections: ['TER Grenoble - Gap'],
    attention: 'Anticiper les coupures routieres possibles sur axes de vallee.',
    usefulFor: ['accueil local', 'liaison Trièves', 'appui plan neige'],
  },
  'monestier-de-clermont': {
    sector: 'Trièves',
    role: 'Gare structurante du Trièves pour operations montagne et axes RN75/A51.',
    connections: ['TER Grenoble - Gap', 'cars Trièves'],
    attention: 'Conditions hivernales et vent peuvent ralentir les rabattements routiers.',
    usefulFor: ['base avancee Trièves', 'point ravitaillement', 'regroupement evacues'],
  },
  'clelles-mens': {
    sector: 'Trièves sud',
    role: 'Dernier point rail iserois majeur avant le Devoluy / Hautes-Alpes.',
    connections: ['TER Grenoble - Gap', 'cars vers Mens'],
    attention: 'Zone diffuse: confirmer les temps d acces terrain avant engagement.',
    usefulFor: ['secours montagne', 'evacuation rurale', 'liaison sud departement'],
  },
  voreppe: {
    sector: 'Cluse de Voreppe',
    role: 'Point strategique entre Grenoble, Voironnais et Chartreuse.',
    connections: ['TER Grenoble - Lyon / Valence', 'cars Voironnais'],
    attention: 'Secteur sensible si A48/A49 perturbees; surveiller reports routiers.',
    usefulFor: ['delestage nord agglo', 'acces Chartreuse', 'filtrage cluse'],
  },
  moirans: {
    sector: 'Noeud Voironnais',
    role: 'Noeud ferroviaire majeur entre Grenoble, Lyon et Valence.',
    connections: ['TER Grenoble - Lyon', 'TER Grenoble - Valence', 'cars Voironnais'],
    attention: 'Gare cle pour rupture de correspondance: prioriser information voyageurs.',
    usefulFor: ['correspondances', 'evacuation Voironnais', 'tri des flux'],
  },
  voiron: {
    sector: 'Voironnais',
    role: 'Gare principale du bassin voironnais et relais population nord-ouest.',
    connections: ['TER Grenoble - Lyon', 'bus / cars Pays Voironnais'],
    attention: 'Centre-ville dense: reperer acces secours et stationnement avant operation.',
    usefulFor: ['centre d accueil', 'relai intercommunal', 'liaison Lyon/Grenoble'],
  },
  rives: {
    sector: 'Bièvre est',
    role: 'Desserte rail pour Rives et acces plateau de Bièvre.',
    connections: ['TER Grenoble - Lyon'],
    attention: 'Coordonner avec les axes routiers locaux en cas de restriction A48.',
    usefulFor: ['rabattement Bièvre', 'renfort Voironnais', 'repli local'],
  },
  'tullins-fures': {
    sector: 'Vallee de l Isere',
    role: 'Point d appui entre Voironnais, Sud-Gresivaudan et axe Valence.',
    connections: ['TER Grenoble - Valence'],
    attention: 'A croiser avec vigilance crues Isere et acces ponts.',
    usefulFor: ['liaison Valence', 'secteur Tullins', 'appui inondation'],
  },
  vinay: {
    sector: 'Sud-Gresivaudan',
    role: 'Gare locale utile pour rabattement entre Saint-Marcellin et Voironnais.',
    connections: ['TER Grenoble - Valence'],
    attention: 'Verifier acces par RD si episode crue ou eboulement en vallee.',
    usefulFor: ['appui rural', 'evacuation vallee', 'relais logistique'],
  },
  'saint-marcellin': {
    sector: 'Sud-Gresivaudan',
    role: 'Gare principale du bassin saint-marcellinois.',
    connections: ['TER Grenoble - Valence', 'cars Sud-Gresivaudan'],
    attention: 'Bon point de regroupement hors metropole; anticiper flux cars.',
    usefulFor: ['base ouest departement', 'accueil evacues', 'liaison Valence'],
  },
  polienas: {
    sector: 'Vallee de l Isere',
    role: 'Halte de proximite entre Tullins et Vinay.',
    connections: ['TER Grenoble - Valence'],
    attention: 'Capacite d accueil limitee: privilegier usage local et navettes ciblees.',
    usefulFor: ['desserte locale', 'point de navette', 'maillage vallee'],
  },
  'le-grand-lemps': {
    sector: 'Bièvre',
    role: 'Point rail pour le centre Bièvre et communes rurales proches.',
    connections: ['TER Grenoble - Lyon'],
    attention: 'Prevoir signaletique claire si activation comme point de rendez-vous.',
    usefulFor: ['rabattement rural', 'appui Bièvre', 'liaison Lyon'],
  },
  chabons: {
    sector: 'Bièvre nord',
    role: 'Desserte locale sur axe Grenoble - Lyon.',
    connections: ['TER Grenoble - Lyon'],
    attention: 'Petite gare: confirmer eclairage, abri et capacite avant accueil prolonge.',
    usefulFor: ['repli local', 'navette courte', 'maillage nord'],
  },
  'virieu-sur-bourbre': {
    sector: 'Bourbre',
    role: 'Gare de proximite pour la vallee de la Bourbre.',
    connections: ['TER Grenoble - Lyon'],
    attention: 'A surveiller avec risques de ruissellement et acces routiers locaux.',
    usefulFor: ['appui vallee', 'liaison nord Isere', 'regroupement local'],
  },
  'saint-andre-le-gaz': {
    sector: 'Noeud Nord-Isere',
    role: 'Noeud ferroviaire important vers Lyon, Chambery et Grenoble.',
    connections: ['TER Lyon / Grenoble / Chambery', 'cars locaux'],
    attention: 'Correspondances multiples: traiter les ruptures de charge en priorite.',
    usefulFor: ['tri des flux', 'evacuation nord Isere', 'relai Savoie'],
  },
  'bourgoin-jallieu': {
    sector: 'Nord-Isere',
    role: 'Gare principale du bassin berjallien, forte valeur de regroupement.',
    connections: ['TER Lyon - Grenoble', 'reseau urbain nord Isere'],
    attention: 'Affluence importante; separer zone accueil public et zone operations.',
    usefulFor: ['centre nord Isere', 'liaison Lyon', 'information voyageurs'],
  },
  'l-isle-d-abeau': {
    sector: 'Porte de l Isle d Abeau',
    role: 'Desserte du secteur urbain et economique de l Isle d Abeau.',
    connections: ['TER Lyon - Grenoble', 'bus locaux'],
    attention: 'Coordonner avec zones d activite et axes A43.',
    usefulFor: ['flux pendulaires', 'appui ZI', 'evacuation locale'],
  },
  'la-verpilliere': {
    sector: 'Porte de l Est lyonnais',
    role: 'Gare de rabattement pour l ouest Nord-Isere.',
    connections: ['TER Lyon - Grenoble', 'bus locaux'],
    attention: 'Secteur A43: utile si reports routiers ou bouchons vers Lyon.',
    usefulFor: ['liaison Lyon', 'delestage A43', 'accueil local'],
  },
  'saint-quentin-fallavier': {
    sector: 'Zone logistique A43',
    role: 'Point rail proche grandes zones logistiques et industriels Nord-Isere.',
    connections: ['TER Lyon - Grenoble'],
    attention: 'Croiser avec risques industriels, poids lourds et plans de circulation.',
    usefulFor: ['incident logistique', 'relai ouest Isere', 'acheminement equipes'],
  },
  vienne: {
    sector: 'Vallee du Rhone',
    role: 'Gare principale du secteur viennois, interface Isere/Rhone.',
    connections: ['TER Lyon - Valence', 'bus urbains / cars'],
    attention: 'Coordination interdepartementale utile avec Rhone et axes A7/RN7.',
    usefulFor: ['liaison Rhone', 'accueil bassin viennois', 'evacuation vallee'],
  },
  estressin: {
    sector: 'Nord de Vienne',
    role: 'Halte de proximite pour quartiers nord et zone viennoise.',
    connections: ['TER Lyon - Valence'],
    attention: 'Usage plutot local; verifier correspondances avec bus urbains.',
    usefulFor: ['desserte locale', 'repli quartier nord', 'maillage Vienne'],
  },
  'chasse-sur-rhone': {
    sector: 'Confluence Rhone / Gier',
    role: 'Gare en limite departementale, utile pour coordination sud lyonnais.',
    connections: ['TER Lyon - Valence'],
    attention: 'Secteur industriel et autoroutier: croiser avec risques technologiques.',
    usefulFor: ['interface Rhone', 'liaison A7', 'incident industriel'],
  },
  'le-peage-de-roussillon': {
    sector: 'Roussillonnais',
    role: 'Gare structurante du sud viennois et vallee du Rhone iseroise.',
    connections: ['TER Lyon - Valence', 'cars Roussillonnais'],
    attention: 'Zone industrielle proche: verifier perimetres de securite si alerte.',
    usefulFor: ['base Rhone sud', 'liaison Valence', 'accueil evacues'],
  },
});
let waterPanelLoadSeq = 0;
const waterPanelCache = new Map();
let contactsPanelLoadSeq = 0;
const contactsPanelCache = new Map();
let isereBoundaryGeometry = null;
let trafficRenderSequence = 0;
const tchooTrainMarkers = new Map();
let mapSearchController = null;
let osmDetailsController = null;
let osmDetailsMarker = null;
const AVALANCHE_MASSIF_ZONES = Object.freeze([
  { nom: 'Chartreuse', lat: 45.364, lon: 5.815, radiusKm: 12 },
  { nom: 'Belledonne', lat: 45.215, lon: 6.015, radiusKm: 15 },
  { nom: 'Grandes-Rousses', lat: 45.166, lon: 6.102, radiusKm: 12 },
  { nom: 'Vercors', lat: 45.044, lon: 5.566, radiusKm: 16 },
  { nom: 'Oisans', lat: 44.975, lon: 6.128, radiusKm: 18 },
]);

function trafficIconZoomClass(zoom = 9) {
  if (zoom <= 7) return 'traffic-zoom-xs';
  if (zoom <= 8) return 'traffic-zoom-sm';
  if (zoom >= 12) return 'traffic-zoom-lg';
  return 'traffic-zoom-md';
}

function updateTrafficZoomClass() {
  if (!leafletMap) return;
  const pane = leafletMap.getPanes?.().markerPane;
  if (!pane) return;
  pane.classList.remove('traffic-zoom-xs', 'traffic-zoom-sm', 'traffic-zoom-md', 'traffic-zoom-lg');
  pane.classList.add(trafficIconZoomClass(leafletMap.getZoom()));
}
let currentMunicipalityPreviewUrl = null;
let institutionPointsCache = [];
let institutionsLoaded = false;
let verifiedHostingPointsCache = [];
let verifiedHostingLoaded = false;
let finessPointsCache = [];
let finessLoaded = false;
let finessTypeCounts = {};
let daePointsCache = [];
let daeLoaded = false;
let iserePopulationPointsCache = [];
let iserePopulationLoaded = false;
let iserePopulationByInseeCache = new Map();
let iserePopulationByInseeLoaded = false;
let isereCommunesGeometryCache = [];
let isereCommunesGeometryLoaded = false;
let telecomPointsCache = [];
let telecomLoaded = false;
let cachedHomeLiveSnapshot = {};
let lastRenderedExternalRisksSignature = null;
let lastRenderedApiInterconnectionsSignature = null;
let _currentFluxFilter = 'all';
let lastRenderedGeorisquesSignature = null;
const pendingServiceAutoRefreshState = new Map();

function keepPreviousValue(previousValue, nextValue) {
  if (nextValue === undefined || nextValue === null) return previousValue;
  if (typeof nextValue === 'string' && nextValue.trim() === '') return previousValue;
  return nextValue;
}

function keepPreviousArray(previousValue, nextValue) {
  // On ne remplace les données précédentes que si le nouveau tableau est non-vide.
  // Un tableau vide signifie un état "pending" ou une erreur temporaire, pas l'absence réelle de données.
  if (Array.isArray(nextValue) && nextValue.length > 0) return nextValue;
  return Array.isArray(previousValue) ? previousValue : [];
}

/**
 * Fusionne un slot de service en préservant TOUTES les données précédentes si le
 * prochain état est "pending" — seul le champ `status` est mis à jour.
 * Cela évite que les alertes/compteurs disparaissent pendant une mise à jour en cours.
 * @param {object} prev  Données actuelles du service (snapshot précédent)
 * @param {object} next  Données reçues depuis l'API
 * @param {function} merge  Fonction de fusion normale à appliquer quand next n'est pas pending
 */
function mergeServiceSlot(prev, next, merge) {
  if (next?.status === 'pending' && Object.keys(prev).length > 0) {
    return { ...prev, status: 'pending' };
  }
  return merge(prev, next);
}

function isUnknownStatusValue(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim().toLowerCase();
  return !text || text === '-' || text === 'inconnu' || text === 'inconnue' || text === 'unknown';
}

function isOfficialColsSource(payload = {}) {
  return String(payload?.source || '').includes('Layer-repere_cols');
}

function isLegacyUnknownColsPayload(payload = {}) {
  if (isOfficialColsSource(payload)) return false;
  const cols = Array.isArray(payload?.cols) ? payload.cols : [];
  if (!cols.length) return false;
  return cols.every((col) => {
    const statut = String(col?.statut || '').trim().toLowerCase();
    const detail = String(col?.detail || '').trim().toLowerCase();
    return (!statut || statut === 'inconnu' || statut === 'unknown') && detail.includes('météo indisponible');
  });
}

function mergeColsAlpinsSlot(prev = {}, next = {}) {
  const discardLegacyPrevious = isLegacyUnknownColsPayload(prev) && Object.keys(next || {}).length > 0;
  if (discardLegacyPrevious) {
    const nextCols = Array.isArray(next?.cols) ? next.cols : [];
    return {
      ...prev,
      ...next,
      cols: nextCols,
      cols_total: next.cols_total ?? nextCols.length ?? 0,
      dangereux_total: next.dangereux_total ?? 0,
    };
  }
  return mergeServiceSlot(prev, next, (p, n) => ({
    ...p, ...n,
    cols: keepPreviousArray(p.cols, n.cols),
    dangereux_total: keepPreviousValue(p.dangereux_total, n.dangereux_total),
  }));
}

function readStatusHistory() {
  const history = readSnapshot(STORAGE_KEYS.serviceStatusHistory);
  return history && typeof history === 'object' ? history : {};
}

function rememberStatusValue(key, value) {
  const history = readStatusHistory();
  if (history[key]?.value === value) return;
  const nextHistory = {
    ...history,
    [key]: {
      value,
      updatedAt: Date.now(),
    },
  };
  saveSnapshot(STORAGE_KEYS.serviceStatusHistory, nextHistory);
}

function keepLastKnownStatus(key, candidateValue) {
  const history = readStatusHistory();
  const known = history[key]?.value;
  if (!isUnknownStatusValue(candidateValue)) {
    rememberStatusValue(key, candidateValue);
    return candidateValue;
  }
  if (!isUnknownStatusValue(known)) return known;
  return candidateValue;
}

function keepLastKnownCount(key, candidateValue, fallback = 0) {
  const history = readStatusHistory();
  const known = Number(history[key]?.value);
  const candidate = Number(candidateValue);
  if (Number.isFinite(candidate) && candidate >= 0) {
    rememberStatusValue(key, candidate);
    return candidate;
  }
  if (Number.isFinite(known) && known >= 0) return known;
  return fallback;
}

function mergeHomeLiveSnapshot(previous = {}, next = {}) {
  const prevDashboard = previous.dashboard || {};
  const nextDashboard = next.dashboard || {};
  const prevGeorisques = previous.georisques || {};
  const nextGeorisques = next.georisques || {};
  const prevVigicrues = previous.vigicrues || {};
  const nextVigicrues = next.vigicrues || {};
  const prevItinisere = previous.itinisere || {};
  const nextItinisere = next.itinisere || {};
  const prevBison = previous.bison_fute || {};
  const nextBison = next.bison_fute || {};
  const prevMeteo = previous.meteo_france || {};
  const nextMeteo = next.meteo_france || {};

  return {
    ...previous,
    ...next,
    updated_at: keepPreviousValue(previous.updated_at, next.updated_at),
    dashboard: {
      ...prevDashboard,
      ...nextDashboard,
      vigilance: keepPreviousValue(prevDashboard.vigilance, nextDashboard.vigilance),
      crues: keepPreviousValue(prevDashboard.crues, nextDashboard.crues),
      global_risk: keepPreviousValue(prevDashboard.global_risk, nextDashboard.global_risk),
      global_risk_score: keepPreviousValue(prevDashboard.global_risk_score, nextDashboard.global_risk_score),
      global_risk_percent: keepPreviousValue(prevDashboard.global_risk_percent, nextDashboard.global_risk_percent),
      global_risk_label: keepPreviousValue(prevDashboard.global_risk_label, nextDashboard.global_risk_label),
      global_risk_factors: keepPreviousArray(prevDashboard.global_risk_factors, nextDashboard.global_risk_factors),
      communes_crise: keepPreviousValue(prevDashboard.communes_crise, nextDashboard.communes_crise),
    },
    georisques: {
      ...prevGeorisques,
      ...nextGeorisques,
      highest_seismic_zone_label: keepPreviousValue(prevGeorisques.highest_seismic_zone_label, nextGeorisques.highest_seismic_zone_label),
      flood_documents_total: keepPreviousValue(prevGeorisques.flood_documents_total, nextGeorisques.flood_documents_total),
    },
    vigicrues: {
      ...prevVigicrues,
      ...nextVigicrues,
      water_alert_level: keepPreviousValue(prevVigicrues.water_alert_level, nextVigicrues.water_alert_level),
    },
    itinisere: {
      ...prevItinisere,
      ...nextItinisere,
      status: keepPreviousValue(prevItinisere.status, nextItinisere.status),
      events_count: keepPreviousValue(prevItinisere.events_count, nextItinisere.events_count),
    },
    bison_fute: {
      ...prevBison,
      ...nextBison,
      today: {
        ...(prevBison.today || {}),
        ...(nextBison.today || {}),
        isere: {
          ...((prevBison.today || {}).isere || {}),
          ...((nextBison.today || {}).isere || {}),
          departure: keepPreviousValue((prevBison.today || {}).isere?.departure, (nextBison.today || {}).isere?.departure),
          return: keepPreviousValue((prevBison.today || {}).isere?.return, (nextBison.today || {}).isere?.return),
        },
      },
    },
    meteo_france: {
      ...prevMeteo,
      ...nextMeteo,
      current_situation: keepPreviousValue(prevMeteo.current_situation, nextMeteo.current_situation),
    },
  };
}

function mergeExternalRisksSnapshot(previous = {}, next = {}) {
  const prevMeteo = previous.meteo_france || {};
  const nextMeteo = next.meteo_france || {};
  const prevVigicrues = previous.vigicrues || {};
  const nextVigicrues = next.vigicrues || {};
  const prevItinisere = previous.itinisere || {};
  const nextItinisere = next.itinisere || {};
  const prevBison = previous.bison_fute || {};
  const nextBison = next.bison_fute || {};
  const prevSncf = previous.sncf_isere || {};
  const prevGeorisques = previous.georisques || {};
  const nextGeorisques = next.georisques || {};
  const nextSncf = next.sncf_isere || {};
  const prevVigieau = previous.vigieau || {};
  const nextVigieau = next.vigieau || {};
  const prevAtmo = previous.atmo_aura || {};
  const nextAtmo = next.atmo_aura || {};
  const prevAnfr = previous.anfr_isere || {};
  const nextAnfr = next.anfr_isere || {};
  const prevArcep = previous.arcep_isere || {};
  const nextArcep = next.arcep_isere || {};
  const prevApic = previous.apic_isere || {};
  const nextApic = next.apic_isere || {};
  const prevVigicruesFlash = previous.vigicrues_flash_isere || {};
  const nextVigicruesFlash = next.vigicrues_flash_isere || {};

  return {
    ...previous,
    ...next,
    updated_at: keepPreviousValue(previous.updated_at, next.updated_at),
    meteo_france: {
      ...prevMeteo,
      ...nextMeteo,
      level: keepPreviousValue(prevMeteo.level, nextMeteo.level),
      hazards: keepPreviousArray(prevMeteo.hazards, nextMeteo.hazards),
      current_situation: keepPreviousArray(prevMeteo.current_situation, nextMeteo.current_situation),
    },
    vigicrues: {
      ...prevVigicrues,
      ...nextVigicrues,
      water_alert_level: keepPreviousValue(prevVigicrues.water_alert_level, nextVigicrues.water_alert_level),
      stations: keepPreviousArray(prevVigicrues.stations, nextVigicrues.stations),
      troncons: keepPreviousArray(prevVigicrues.troncons, nextVigicrues.troncons),
    },
    itinisere: {
      ...prevItinisere,
      ...nextItinisere,
      status: keepPreviousValue(prevItinisere.status, nextItinisere.status),
      events_total: keepPreviousValue(prevItinisere.events_total, nextItinisere.events_total),
      events: keepPreviousArray(prevItinisere.events, nextItinisere.events),
    },
    bison_fute: {
      ...prevBison,
      ...nextBison,
      events: keepPreviousArray(prevBison.events, nextBison.events),
      live_events: keepPreviousArray(prevBison.live_events, nextBison.live_events),
      today: {
        ...(prevBison.today || {}),
        ...(nextBison.today || {}),
        isere: {
          ...((prevBison.today || {}).isere || {}),
          ...((nextBison.today || {}).isere || {}),
          departure: keepPreviousValue((prevBison.today || {}).isere?.departure, (nextBison.today || {}).isere?.departure),
          return: keepPreviousValue((prevBison.today || {}).isere?.return, (nextBison.today || {}).isere?.return),
        },
      },
    },
    sncf_isere: mergeServiceSlot(prevSncf, nextSncf, (p, n) => ({
      ...p,
      ...n,
      alerts_total: keepPreviousValue(p.alerts_total, n.alerts_total),
      alerts: keepPreviousArray(p.alerts, n.alerts),
    })),
    vigieau: {
      ...prevVigieau,
      ...nextVigieau,
      alerts: keepPreviousArray(prevVigieau.alerts, nextVigieau.alerts),
      max_level: keepPreviousValue(prevVigieau.max_level, nextVigieau.max_level),
    },
    atmo_aura: {
      ...prevAtmo,
      ...nextAtmo,
      today: {
        ...(prevAtmo.today || {}),
        ...(nextAtmo.today || {}),
        level: keepPreviousValue((prevAtmo.today || {}).level, (nextAtmo.today || {}).level),
        label: keepPreviousValue((prevAtmo.today || {}).label, (nextAtmo.today || {}).label),
        index: keepPreviousValue((prevAtmo.today || {}).index, (nextAtmo.today || {}).index),
      },
    },
    anfr_isere: {
      ...prevAnfr,
      ...nextAnfr,
      supports_total: keepPreviousValue(prevAnfr.supports_total, nextAnfr.supports_total),
      stations_total: keepPreviousValue(prevAnfr.stations_total, nextAnfr.stations_total),
      average_support_height_m: keepPreviousValue(prevAnfr.average_support_height_m, nextAnfr.average_support_height_m),
    },
    arcep_isere: mergeServiceSlot(prevArcep, nextArcep, (p, n) => ({
      ...p,
      ...n,
      outages_total: keepPreviousValue(p.outages_total, n.outages_total),
      communes_total: keepPreviousValue(p.communes_total, n.communes_total),
      voice_impacted_total: keepPreviousValue(p.voice_impacted_total, n.voice_impacted_total),
      data_impacted_total: keepPreviousValue(p.data_impacted_total, n.data_impacted_total),
      top_operators: keepPreviousArray(p.top_operators, n.top_operators),
    })),
    apic_isere: {
      ...prevApic,
      ...nextApic,
      level: keepPreviousValue(prevApic.level, nextApic.level),
      alerts_total: keepPreviousValue(prevApic.alerts_total, nextApic.alerts_total),
      alerts: keepPreviousArray(prevApic.alerts, nextApic.alerts),
    },
    vigicrues_flash_isere: {
      ...prevVigicruesFlash,
      ...nextVigicruesFlash,
      level: keepPreviousValue(prevVigicruesFlash.level, nextVigicruesFlash.level),
      alerts_total: keepPreviousValue(prevVigicruesFlash.alerts_total, nextVigicruesFlash.alerts_total),
      alerts: keepPreviousArray(prevVigicruesFlash.alerts, nextVigicruesFlash.alerts),
    },
    prefecture_isere: {
      ...(previous.prefecture_isere || {}),
      ...(next.prefecture_isere || {}),
      // Conserver les articles précédents si le flux est temporairement vide ou en erreur
      items: keepPreviousArray((previous.prefecture_isere || {}).items, (next.prefecture_isere || {}).items),
      articles: keepPreviousArray((previous.prefecture_isere || {}).articles, (next.prefecture_isere || {}).articles),
    },
    fr_alert_isere: {
      ...(previous.fr_alert_isere || {}),
      ...(next.fr_alert_isere || {}),
      events: keepPreviousArray((previous.fr_alert_isere || {}).events, (next.fr_alert_isere || {}).events),
      today_events: keepPreviousArray((previous.fr_alert_isere || {}).today_events, (next.fr_alert_isere || {}).today_events),
      today_count: keepPreviousValue((previous.fr_alert_isere || {}).today_count, (next.fr_alert_isere || {}).today_count),
    },
    dauphine_isere: {
      ...(previous.dauphine_isere || {}),
      ...(next.dauphine_isere || {}),
      items: keepPreviousArray((previous.dauphine_isere || {}).items, (next.dauphine_isere || {}).items),
      articles: keepPreviousArray((previous.dauphine_isere || {}).articles, (next.dauphine_isere || {}).articles),
    },
    france_bleu_isere: {
      ...(previous.france_bleu_isere || {}),
      ...(next.france_bleu_isere || {}),
      items: keepPreviousArray((previous.france_bleu_isere || {}).items, (next.france_bleu_isere || {}).items),
    },
    placegrenet: {
      ...(previous.placegrenet || {}),
      ...(next.placegrenet || {}),
      items: keepPreviousArray((previous.placegrenet || {}).items, (next.placegrenet || {}).items),
    },
    grenoble_metro: {
      ...(previous.grenoble_metro || {}),
      ...(next.grenoble_metro || {}),
      items: keepPreviousArray((previous.grenoble_metro || {}).items, (next.grenoble_metro || {}).items),
    },
    ars_aura: {
      ...(previous.ars_aura || {}),
      ...(next.ars_aura || {}),
      items: keepPreviousArray((previous.ars_aura || {}).items, (next.ars_aura || {}).items),
    },
    seismes_isere: {
      ...(previous.seismes_isere || {}),
      ...(next.seismes_isere || {}),
      items: keepPreviousArray((previous.seismes_isere || {}).items, (next.seismes_isere || {}).items),
    },
    georisques: {
      ...prevGeorisques,
      ...nextGeorisques,
      status: keepPreviousValue(prevGeorisques.status, nextGeorisques.status),
      highest_seismic_zone_label: keepPreviousValue(prevGeorisques.highest_seismic_zone_label, nextGeorisques.highest_seismic_zone_label),
      flood_documents_total: keepPreviousValue(prevGeorisques.flood_documents_total, nextGeorisques.flood_documents_total),
      ppr_total: keepPreviousValue(prevGeorisques.ppr_total, nextGeorisques.ppr_total),
      ground_movements_total: keepPreviousValue(prevGeorisques.ground_movements_total, nextGeorisques.ground_movements_total),
      cavities_total: keepPreviousValue(prevGeorisques.cavities_total, nextGeorisques.cavities_total),
      communes_with_radon_moderate_or_high: keepPreviousValue(prevGeorisques.communes_with_radon_moderate_or_high, nextGeorisques.communes_with_radon_moderate_or_high),
      dicrim_total: keepPreviousValue(prevGeorisques.dicrim_total, nextGeorisques.dicrim_total),
      tim_total: keepPreviousValue(prevGeorisques.tim_total, nextGeorisques.tim_total),
      risques_information_total: keepPreviousValue(prevGeorisques.risques_information_total, nextGeorisques.risques_information_total),
      monitored_communes: keepPreviousArray(prevGeorisques.monitored_communes, nextGeorisques.monitored_communes),
      monitored_municipalities: keepPreviousArray(prevGeorisques.monitored_municipalities, nextGeorisques.monitored_municipalities),
      communes: keepPreviousArray(prevGeorisques.communes, nextGeorisques.communes),
      recent_ground_movements: keepPreviousArray(prevGeorisques.recent_ground_movements, nextGeorisques.recent_ground_movements),
      movement_types: (nextGeorisques.movement_types && Object.keys(nextGeorisques.movement_types).length > 0) ? nextGeorisques.movement_types : (prevGeorisques.movement_types || {}),
      radon_distribution: nextGeorisques.radon_distribution || prevGeorisques.radon_distribution || null,
      ppr_categories: nextGeorisques.ppr_categories || prevGeorisques.ppr_categories || null,
    },
    // ── Transport — protège les listes de perturbations contre le statut "pending" ──
    ter_aura: mergeServiceSlot(previous.ter_aura || {}, next.ter_aura || {}, (p, n) => ({
      ...p, ...n,
      disruptions: keepPreviousArray(p.disruptions, n.disruptions),
      disruptions_total: keepPreviousValue(p.disruptions_total, n.disruptions_total),
    })),
    mreseau: mergeServiceSlot(previous.mreseau || {}, next.mreseau || {}, (p, n) => ({
      ...p, ...n,
      disruptions: keepPreviousArray(p.disruptions, n.disruptions),
      disruptions_total: keepPreviousValue(p.disruptions_total, n.disruptions_total),
    })),
    aprr_isere: mergeServiceSlot(previous.aprr_isere || {}, next.aprr_isere || {}, (p, n) => ({
      ...p, ...n,
      events: keepPreviousArray(p.events, n.events),
      events_total: keepPreviousValue(p.events_total, n.events_total),
    })),
    vinci_autoroutes: mergeServiceSlot(previous.vinci_autoroutes || {}, next.vinci_autoroutes || {}, (p, n) => ({
      ...p, ...n,
      events: keepPreviousArray(p.events, n.events),
      events_total: keepPreviousValue(p.events_total, n.events_total),
    })),
    cars_region_aura: mergeServiceSlot(previous.cars_region_aura || {}, next.cars_region_aura || {}, (p, n) => ({
      ...p, ...n,
      disruptions: keepPreviousArray(p.disruptions, n.disruptions),
      disruptions_total: keepPreviousValue(p.disruptions_total, n.disruptions_total),
    })),
    isere_opendata: mergeServiceSlot(previous.isere_opendata || {}, next.isere_opendata || {}, (p, n) => ({
      ...p, ...n,
      totals: (n.totals && Object.keys(n.totals).length > 0) ? n.totals : (p.totals || {}),
    })),
    avalanche_isere: mergeServiceSlot(previous.avalanche_isere || {}, next.avalanche_isere || {}, (p, n) => ({
      ...p, ...n,
      massifs: keepPreviousArray(p.massifs, n.massifs),
      niveau_max_bra: keepPreviousValue(p.niveau_max_bra, n.niveau_max_bra),
    })),
    feux_foret_isere: mergeServiceSlot(previous.feux_foret_isere || {}, next.feux_foret_isere || {}, (p, n) => ({
      ...p, ...n,
      fires: keepPreviousArray(p.fires, n.fires),
      fires_total: keepPreviousValue(p.fires_total, n.fires_total),
    })),
    cols_alpins_isere: mergeColsAlpinsSlot(previous.cols_alpins_isere || {}, next.cols_alpins_isere || {}),
    copernicus_ems: mergeServiceSlot(previous.copernicus_ems || {}, next.copernicus_ems || {}, (p, n) => ({
      ...p, ...n,
      activations: keepPreviousArray(p.activations, n.activations),
      france_activations: keepPreviousArray(p.france_activations, n.france_activations),
      france_total: keepPreviousValue(p.france_total, n.france_total),
    })),
  };
}

function getStartupQueuePercent() {
  const total = startupQueueState.total;
  const completed = startupQueueState.completed;
  return total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
}

function updateApiQueueVisual() {
  const summaryNode = document.getElementById('api-queue-summary');
  const progressNode = document.getElementById('api-queue-progress-bar');
  const currentNode = document.getElementById('api-queue-current');
  const progressWrap = document.querySelector('.api-queue-progress');
  updateGlobalLoadingVisual(getStartupQueuePercent());
  if (!summaryNode || !progressNode || !currentNode || !progressWrap) return;

  const pending = apiRequestQueue.length;
  const active = apiActiveRequests;
  const total = startupQueueState.total;
  const completed = startupQueueState.completed;
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  summaryNode.textContent = total > 0
    ? `${completed}/${total} modules · ${active} requête(s) active(s) · ${pending} en attente`
    : `${active} requête(s) active(s) · ${pending} en attente`;
  progressNode.style.width = `${percent}%`;
  progressWrap.setAttribute('aria-valuenow', String(percent));
  currentNode.textContent = startupQueueState.current || 'Aucune tâche en cours.';
}

function updateGlobalLoadingVisual(percent = 0) {
  const bar = document.getElementById('global-loading-bar');
  if (!bar) return;

  const isLoading = startupQueueState.total > 0 && startupQueueState.completed < startupQueueState.total;
  const visiblePercent = isLoading ? percent : 0;
  bar.hidden = !isLoading;
  bar.classList.toggle('hidden', !isLoading);

  const progress = document.getElementById('global-loading-progress');
  const percentNode = document.getElementById('global-loading-percent');
  const currentNode = document.getElementById('global-loading-current');
  const track = bar.querySelector('.global-loading-bar__track');

  if (progress) progress.style.width = `${visiblePercent}%`;
  if (percentNode) percentNode.textContent = isLoading ? `${percent}%` : '';
  if (currentNode) currentNode.textContent = startupQueueState.current || 'Chargement des donnees...';
  if (track) track.setAttribute('aria-valuenow', String(visiblePercent));

}

function setPanelLoading(panelId, loading, label = 'Chargement des données...') {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const current = panelLoadingState.get(panelId) || { count: 0, label };
  current.count = Math.max(0, current.count + (loading ? 1 : -1));
  current.label = label || current.label || 'Chargement des données...';
  panelLoadingState.set(panelId, current);
  const active = current.count > 0;
  panel.classList.toggle('is-loading', active);
  panel.setAttribute('data-loading-label', active ? current.label : '');
}

async function withPanelLoading(panelId, label, task) {
  setPanelLoading(panelId, true, label);
  try {
    return await task();
  } finally {
    setPanelLoading(panelId, false, label);
  }
}

function startStartupQueue(total = 0) {
  startupQueueState.total = Math.max(0, Number(total) || 0);
  startupQueueState.completed = 0;
  startupQueueState.current = startupQueueState.total ? 'Préparation des données…' : '';
  updateApiQueueVisual();
}

function advanceStartupQueue(label = '') {
  startupQueueState.completed = Math.min(startupQueueState.total, startupQueueState.completed + 1);
  startupQueueState.current = label ? `Terminé: ${label}` : startupQueueState.current;
  updateApiQueueVisual();
}

function setStartupQueueCurrent(label = '') {
  startupQueueState.current = label;
  updateApiQueueVisual();
}

function finishStartupQueue() {
  startupQueueState.completed = startupQueueState.total;
  startupQueueState.current = 'Chargement initial terminé.';
  updateApiQueueVisual();
}

const SCHOOL_RESOURCE_TYPES = new Set(['ecole_primaire', 'college', 'lycee', 'universite', 'creche']);
const SECURITY_RESOURCE_TYPES = new Set(['gendarmerie', 'commissariat_police_nationale', 'police_municipale']);
const FIRE_RESOURCE_TYPES = new Set(['caserne_pompier', 'caserne']);
const HEALTH_RESOURCE_TYPES = new Set(['hopital', 'hopital_public', 'hopital_prive', 'chu', 'clinique', 'medecin', 'ehpad']);
const DAE_RESOURCE_TYPES = new Set(['defibrillateur']);
const HEALTH_URGENT_CARE_TYPES = new Set(['chu', 'hopital', 'hopital_public', 'hopital_prive', 'clinique']);
const FINESS_DYNAMIC_RESOURCE_TYPES = new Set();
const RISK_RESOURCE_TYPES = new Set(['lieu_risque', 'centrale_nucleaire', 'energie', 'site_sensible_custom']);
const TRANSPORT_RESOURCE_TYPES = new Set(['transport', 'transport_gare_sncf', 'transport_gare_routiere', 'transport_aeroport']);
const COMMAND_RESOURCE_TYPES = new Set(['poste_commandement']);
const PC_RESOURCE_TYPES = new Set(['protection_civile']);
const HOSTING_RESOURCE_TYPES = new Set(['gymnase', 'complexe_sportif', 'stade', 'salle_omnisports', 'centre_culturel', 'salle_spectacle_public', 'palais_congres', 'salle_fetes']);
const SCHOOL_HOSTING_TYPES = new Set(['ecole_primaire', 'college', 'lycee', 'universite']);
const TELECOM_RESOURCE_TYPES = new Set(['anfr_antenna', 'arcep_mobile_outage', 'telecom_white_zone']);

const ISERE_BOUNDARY_STYLE = { color: '#163a87', weight: 2, fillColor: '#63c27d', fillOpacity: 0.2 };
const TRAFFIC_COMMUNES = [
  'Grenoble', 'Voiron', 'Vienne', 'Bourgoin-Jallieu', 'Pont-de-Claix', 'Meylan',
  'Échirolles', "L'Isle-d'Abeau", 'Saint-Martin-d\'Hères', 'La Tour-du-Pin', 'Rives',
  'Sassenage', 'Crolles', 'Tullins', 'Vizille', 'Pontcharra', 'La Mure', 'Corps',
  'Domène', 'Voreppe', 'Moirans', 'Saint-Marcellin', 'Le Touvet', 'Goncelin',
  'Allevard', 'Claix', 'Échirolles', 'Fontaine', 'Saint-Égrève', 'Seyssins',
  'Jarrie', 'Vif', 'Uriage', 'Chamrousse', 'La Terrasse', 'Chapareillan',
  'Renage', 'Chabons', 'Virieu', 'Morestel', 'Crémieu', 'Roussillon',
  'Villard-de-Lans', 'Autrans', 'La Chapelle-en-Vercors', 'Monestier-de-Clermont',
  'Clelles', 'Corps', 'Roybon', 'Vinay', 'Chatte', 'Saint-Antoine-l\'Abbaye',
  'Rochetaillée', 'Le Bourg-d\'Oisans', 'Livet-et-Gavet', 'Mizoën', 'La Grave',
  'Eybens', 'Gières', 'Saint-Nizier-du-Moucherotte', 'Sarcenas', 'Le Sappey',
  'Pont-Évêque', 'Jardin', 'Saint-Clair-du-Rhône', 'Saint-Jean-de-Bournay',
  'La Rochette', 'Seiglières',
];
const ITINISERE_ROAD_CORRIDORS = {
  // ── Autoroutes ──────────────────────────────────────────────────────────────
  A7:    [[45.552, 4.879], [45.525, 4.877], [45.430, 4.830], [45.365, 4.790]],
  A41:   [[45.201, 5.786], [45.240, 5.830], [45.279, 5.883], [45.350, 5.995], [45.429, 6.018], [45.500, 6.100]],
  A43:   [[45.490, 5.190], [45.537, 5.235], [45.587, 5.270], [45.587, 5.344], [45.566, 5.440]],
  A48:   [[45.188, 5.724], [45.240, 5.686], [45.297, 5.649], [45.339, 5.552], [45.356, 5.498], [45.448, 5.399], [45.520, 5.290]],
  A49:   [[45.188, 5.724], [45.230, 5.629], [45.285, 5.530], [45.299, 5.477], [45.230, 5.390], [45.149, 5.317]],
  A480:  [[45.120, 5.697], [45.143, 5.705], [45.160, 5.712], [45.188, 5.724]],
  A516:  [[45.188, 5.724], [45.175, 5.680], [45.152, 5.662]],
  // ── Routes nationales ───────────────────────────────────────────────────────
  N7:    [[45.552, 4.879], [45.499, 4.840], [45.430, 4.830]],
  N75:   [[45.188, 5.724], [45.079, 5.773], [44.900, 5.785]],
  N85:   [[45.188, 5.724], [45.079, 5.773], [45.059, 5.714], [44.960, 5.758], [44.900, 5.785], [44.835, 5.859], [44.816, 5.959]],
  N87:   [[45.149, 5.717], [45.188, 5.724], [45.260, 5.700], [45.360, 5.450], [45.450, 5.180], [45.525, 4.876]],
  // ── Départementales — grands axes ───────────────────────────────────────────
  D1:    [[45.188, 5.724], [45.230, 5.685], [45.297, 5.649], [45.339, 5.552], [45.388, 5.480]],   // Grenoble → Lyon (ex-RN)
  D5:    [[45.567, 5.441], [45.450, 5.310], [45.388, 5.257], [45.250, 5.282], [45.217, 5.316], [45.149, 5.317]], // La Tour-du-Pin → Romans
  D6:    [[45.188, 5.724], [45.155, 5.707], [45.120, 5.697], [45.058, 5.671]],                    // Grenoble → Pont-de-Claix → Vif (rive gauche Drac)
  D9:    [[45.188, 5.724], [45.150, 5.717], [45.100, 5.720], [45.058, 5.714]],                    // Grenoble → Vizille (rive droite)
  D12:   [[45.587, 5.270], [45.540, 5.190], [45.499, 5.133]],                                     // Bourgoin → L'Isle-d'Abeau
  D15:   [[45.148, 5.717], [45.130, 5.757], [45.134, 5.818], [45.120, 5.887]],                    // Échirolles → Uriage → Chamrousse
  D20:   [[45.525, 4.877], [45.490, 4.950], [45.450, 5.010]],                                     // Vienne → Beaurepaire
  D26:   [[45.525, 4.877], [45.470, 4.860], [45.410, 4.820], [45.376, 4.811]],                    // Vienne → Péage-de-Roussillon
  D35:   [[45.587, 5.270], [45.560, 5.340], [45.510, 5.380], [45.499, 5.133]],                    // Bourgoin → Morestel
  D44:   [[45.230, 5.685], [45.250, 5.710], [45.265, 5.740], [45.280, 5.760]],                    // Saint-Égrève → Chartreuse (bas)
  D57:   [[45.188, 5.724], [45.148, 5.717], [45.125, 5.700], [45.100, 5.695]],                    // Grenoble → Échirolles → Pont-de-Claix
  D68:   [[45.188, 5.724], [45.215, 5.750], [45.240, 5.775]],                                     // Grenoble → Corenc → Montbonnot
  D75:   [[45.299, 5.477], [45.320, 5.510], [45.339, 5.530], [45.362, 5.566]],                    // Tullins → Voreppe
  D85:   [[44.900, 5.785], [44.860, 5.730], [44.820, 5.710]],                                     // La Mure → Laffrey (Matheysine)
  D90:   [[45.188, 5.724], [45.200, 5.760], [45.203, 5.853]],                                     // Grenoble → Domène (rive gauche)
  D91:   [[45.201, 5.781], [45.240, 5.830], [45.279, 5.883], [45.344, 5.950], [45.429, 6.018]],  // Grésivaudan rive droite (Meylan → Pontcharra)
  D94:   [[44.900, 5.785], [44.840, 5.760], [44.780, 5.790], [44.740, 5.850], [44.710, 5.920]],  // La Mure → Mens → Clelles (Trièves)
  D96:   [[45.297, 5.649], [45.270, 5.700], [45.255, 5.735], [45.245, 5.780]],                    // Voreppe → Chartreuse (RD du Désert)
  D106:  [[45.250, 5.850], [45.270, 5.890], [45.310, 5.940], [45.350, 5.990]],                    // Basse Belledonne (Gières → Laval)
  D109:  [[45.429, 6.018], [45.400, 6.040], [45.370, 6.060]],                                     // Pontcharra → Allevard (basse)
  D111:  [[45.188, 5.724], [45.155, 5.869], [45.130, 5.930]],                                     // Grenoble → Seiglières
  D113:  [[45.525, 4.877], [45.480, 4.920], [45.430, 4.980], [45.380, 5.050]],                    // Vienne → Beaurepaire (rive gauche Rhône)
  D116:  [[45.148, 5.717], [45.134, 5.818], [45.120, 5.887]],                                     // Échirolles → Chamrousse (variante D15)
  D119:  [[45.230, 5.685], [45.240, 5.730], [45.258, 5.764], [45.266, 5.782]],                    // Saint-Égrève → Col de Porte (Chartreuse)
  D120:  [[45.279, 5.883], [45.290, 5.910], [45.310, 5.950], [45.330, 5.980]],                    // Crolles → Plateau de Chartreuse (est)
  D143:  [[44.900, 5.785], [44.870, 5.830], [44.850, 5.870], [44.816, 5.959]],                    // La Mure → Corps (variante)
  D214:  [[45.567, 5.441], [45.590, 5.490], [45.620, 5.530], [45.670, 5.468]],                    // La Tour-du-Pin → Morestel
  D269:  [[45.448, 5.399], [45.490, 5.440], [45.540, 5.470]],                                     // Chabons → La Tour-du-Pin
  D282:  [[45.587, 5.270], [45.620, 5.240], [45.669, 5.221]],                                     // Bourgoin → Crémieu
  D512:  [[45.202, 5.679], [45.175, 5.625], [45.140, 5.580], [45.116, 5.549], [45.072, 5.554]],  // Sassenage → Engins → Villard-de-Lans (Vercors)
  D518:  [[45.079, 5.773], [44.960, 5.758], [44.900, 5.785], [44.870, 5.780], [44.837, 5.780]],  // Vizille → La Mure (Matheysine)
  D519:  [[45.429, 6.018], [45.393, 6.076], [45.365, 6.100], [45.340, 6.130]],                    // Pontcharra → Allevard → Sept-Laux
  D520:  [[45.188, 5.724], [45.204, 5.853], [45.250, 5.832], [45.300, 5.818], [45.340, 5.808]],  // Grenoble → Belledonne (Domène → La Diat)
  D520B: [[45.300, 5.800], [45.340, 5.808]],                                                       // Variant Belledonne
  D523:  [[45.188, 5.724], [45.150, 5.750], [45.114, 5.755]],                                     // Grenoble → Vizille (variante)
  D524:  [[45.114, 5.755], [45.090, 5.800], [45.054, 5.820]],                                     // Vizille → Saint-Jean-de-Bournay direction
  D525:  [[45.340, 5.808], [45.356, 5.870], [45.356, 5.992], [45.282, 6.074]],                    // Belledonne → Fond de France
  D525A: [[45.282, 6.074], [45.260, 6.120]],
  D526:  [[45.054, 6.034], [45.080, 6.050], [45.114, 6.005]],                                     // Bourg-d'Oisans → Rochetaillée
  D530:  [[45.188, 5.724], [45.170, 5.650], [45.140, 5.580], [45.110, 5.530]],                    // Seyssins → Vercors nord
  D531:  [[45.188, 5.724], [45.175, 5.670], [45.150, 5.660], [45.109, 5.553], [45.071, 5.490]],  // Grenoble → Gorges de la Bourne → Villard-de-Lans
  D532:  [[45.188, 5.724], [45.280, 5.620], [45.339, 5.552], [45.356, 5.498], [45.448, 5.399], [45.567, 5.270]], // = D1532
  // ── Départementales — axes principaux (longueurs) ───────────────────────────
  D1075: [[45.188, 5.724], [45.079, 5.773], [44.960, 5.758], [44.900, 5.785], [44.816, 5.959]],  // Route Napoléon (Grenoble → Gap)
  D1085: [[44.840, 5.860], [44.760, 5.880], [44.700, 5.930]],                                     // Corps → Aspres (Trièves sud)
  D1090: [[45.188, 5.724], [45.076, 5.883], [45.054, 6.034], [44.999, 6.200], [45.035, 6.404]],  // Grenoble → Bourg-d'Oisans → Col du Lautaret
  D1091: [[45.079, 5.773], [45.076, 5.883], [45.114, 6.005], [45.054, 6.034], [44.999, 6.200], [45.035, 6.404]], // Vizille → Oisans → Lautaret
  D1532: [[45.188, 5.724], [45.280, 5.620], [45.339, 5.552], [45.356, 5.498], [45.448, 5.399], [45.500, 5.360], [45.567, 5.270]], // Grenoble → Rives → Bourgoin
};

// Lieux connus en Isère avec coordonnées exactes (pour éviter le géocodage)
const ITINISERE_KNOWN_LOCATIONS = {
  'col du lautaret': { lat: 45.0346, lon: 6.4042 },
  'lautaret': { lat: 45.0346, lon: 6.4042 },
  'col du galibier': { lat: 45.0603, lon: 6.4055 },
  'galibier': { lat: 45.0603, lon: 6.4055 },
  'tunnel du chambon': { lat: 44.9989, lon: 6.2004 },
  'chambon': { lat: 44.9989, lon: 6.2004 },
  'lac du chambon': { lat: 44.9919, lon: 6.1893 },
  'bourg d\'oisans': { lat: 45.0537, lon: 6.0341 },
  "bourg d'oisans": { lat: 45.0537, lon: 6.0341 },
  'le bourg d\'oisans': { lat: 45.0537, lon: 6.0341 },
  "le bourg d'oisans": { lat: 45.0537, lon: 6.0341 },
  'oisans': { lat: 45.0537, lon: 6.0341 },
  'col de la croix de fer': { lat: 45.2261, lon: 6.1987 },
  'croix de fer': { lat: 45.2261, lon: 6.1987 },
  'col du coq': { lat: 45.3098, lon: 5.9694 },
  'col de porte': { lat: 45.2658, lon: 5.7815 },
  'col de vence': { lat: 45.2047, lon: 5.7745 },
  'col ornon': { lat: 44.9792, lon: 5.8973 },
  'col d\'ornon': { lat: 44.9792, lon: 5.8973 },
  "col d'ornon": { lat: 44.9792, lon: 5.8973 },
  'col du glandon': { lat: 45.2389, lon: 6.1700 },
  'glandon': { lat: 45.2389, lon: 6.1700 },
  'col de la madeleine': { lat: 45.4386, lon: 6.3570 },
  'alpe d\'huez': { lat: 45.0910, lon: 6.0706 },
  "alpe d'huez": { lat: 45.0910, lon: 6.0706 },
  'les deux alpes': { lat: 45.0124, lon: 6.1279 },
  'deux alpes': { lat: 45.0124, lon: 6.1279 },
  'villard-de-lans': { lat: 45.0716, lon: 5.5535 },
  'villard de lans': { lat: 45.0716, lon: 5.5535 },
  'autrans': { lat: 45.1751, lon: 5.5458 },
  'méaudre': { lat: 45.1310, lon: 5.5176 },
  'gorges de la bourne': { lat: 45.0900, lon: 5.5300 },
  'la chapelle-en-vercors': { lat: 44.9710, lon: 5.4175 },
  'monestier-de-clermont': { lat: 44.9189, lon: 5.6357 },
  'clelles': { lat: 44.8150, lon: 5.6395 },
  'corps': { lat: 44.8164, lon: 5.9594 },
  'la mure': { lat: 44.8999, lon: 5.7850 },
  'vizille': { lat: 45.0786, lon: 5.7728 },
  'jarrie': { lat: 45.0997, lon: 5.7511 },
  'vif': { lat: 45.0583, lon: 5.6720 },
  'claix': { lat: 45.1196, lon: 5.6939 },
  'pont-de-claix': { lat: 45.1247, lon: 5.7004 },
  'pont de claix': { lat: 45.1247, lon: 5.7004 },
  'échirolles': { lat: 45.1434, lon: 5.7186 },
  'echirolles': { lat: 45.1434, lon: 5.7186 },
  'grenoble': { lat: 45.1885, lon: 5.7245 },
  'meylan': { lat: 45.2046, lon: 5.7895 },
  'gières': { lat: 45.1851, lon: 5.7874 },
  'domène': { lat: 45.2032, lon: 5.8529 },
  'uriage': { lat: 45.1345, lon: 5.8178 },
  'chamrousse': { lat: 45.1199, lon: 5.8873 },
  'le sappey': { lat: 45.2340, lon: 5.7745 },
  'sarcenas': { lat: 45.2697, lon: 5.7654 },
  'saint-nizier-du-moucherotte': { lat: 45.1709, lon: 5.6369 },
  'sassenage': { lat: 45.2020, lon: 5.6794 },
  'seyssins': { lat: 45.1558, lon: 5.6900 },
  'seyssinet': { lat: 45.1693, lon: 5.6862 },
  'fontaine': { lat: 45.1929, lon: 5.6876 },
  'saint-egreve': { lat: 45.2298, lon: 5.6853 },
  'saint-égrève': { lat: 45.2298, lon: 5.6853 },
  'voreppe': { lat: 45.2974, lon: 5.6485 },
  'moirans': { lat: 45.3387, lon: 5.5517 },
  'voiron': { lat: 45.3620, lon: 5.5900 },
  'rives': { lat: 45.3550, lon: 5.4975 },
  'renage': { lat: 45.4118, lon: 5.4310 },
  'tullins': { lat: 45.2987, lon: 5.4773 },
  'saint-marcellin': { lat: 45.1487, lon: 5.3170 },
  'chatte': { lat: 45.1260, lon: 5.2869 },
  'vienne': { lat: 45.5248, lon: 4.8765 },
  'pont-évêque': { lat: 45.5394, lon: 4.9119 },
  'pont evêque': { lat: 45.5394, lon: 4.9119 },
  'condrieu': { lat: 45.4679, lon: 4.7740 },
  'givors': { lat: 45.5894, lon: 4.7672 },
  'bourgoin-jallieu': { lat: 45.5869, lon: 5.2701 },
  'bourgoin': { lat: 45.5869, lon: 5.2701 },
  "l'isle-d'abeau": { lat: 45.6149, lon: 5.2279 },
  "isle d'abeau": { lat: 45.6149, lon: 5.2279 },
  'saint-jean-de-bournay': { lat: 45.4994, lon: 5.1331 },
  'la tour-du-pin': { lat: 45.5667, lon: 5.4412 },
  'la tour du pin': { lat: 45.5667, lon: 5.4412 },
  'virieu': { lat: 45.5122, lon: 5.4796 },
  'morestel': { lat: 45.6699, lon: 5.4683 },
  'crémieu': { lat: 45.7283, lon: 5.2561 },
  'chabons': { lat: 45.4478, lon: 5.3994 },
  'châbons': { lat: 45.4478, lon: 5.3994 },
  'pontcharra': { lat: 45.4293, lon: 6.0175 },
  'crolles': { lat: 45.2785, lon: 5.8832 },
  'goncelin': { lat: 45.3502, lon: 5.9952 },
  'le touvet': { lat: 45.3437, lon: 5.9495 },
  'la terrasse': { lat: 45.3202, lon: 5.9382 },
  'chapareillan': { lat: 45.4337, lon: 5.9986 },
  'allevard': { lat: 45.3930, lon: 6.0762 },
  'la rochette': { lat: 45.4365, lon: 6.1048 },
  'saint-jean-de-moirans': { lat: 45.3403, lon: 5.5665 },
  'vinay': { lat: 45.2172, lon: 5.3157 },
  'roybon': { lat: 45.2571, lon: 5.2537 },
  'saint-antoine-l\'abbaye': { lat: 45.1603, lon: 5.1941 },
  'rochetaillée': { lat: 45.1144, lon: 6.0052 },
  'rochetaillee': { lat: 45.1144, lon: 6.0052 },
  'mizoën': { lat: 44.9935, lon: 6.2159 },
  'mizoen': { lat: 44.9935, lon: 6.2159 },
  'la grave': { lat: 45.0451, lon: 6.3075 },
  'le monetier': { lat: 44.9783, lon: 6.5073 },
  'seiglières': { lat: 45.1547, lon: 5.8699 },
  'seiglieres': { lat: 45.1547, lon: 5.8699 },
  'livet-et-gavet': { lat: 45.0659, lon: 5.9743 },
  'le péage-de-roussillon': { lat: 45.3762, lon: 4.8110 },
  'roussillon': { lat: 45.3722, lon: 4.8161 },
  'saint-clair-du-rhône': { lat: 45.4337, lon: 4.7655 },
  'jardin': { lat: 45.4717, lon: 4.8676 },
  'eybens': { lat: 45.1565, lon: 5.7475 },
  'herbeys': { lat: 45.1303, lon: 5.7855 },
  'bresson': { lat: 45.1248, lon: 5.7380 },
  'brié-et-angonnes': { lat: 45.1232, lon: 5.7735 },
};
const BISON_FUTE_CAMERAS = [
  { name: 'Meylan N87 PR10+590', road: 'N87', lat: 45.201217282265034, lon: 5.7812657653824875, manager: 'DIR Centre-Est', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/nce_27.mp4' },
  { name: 'Eybens N87 PR4+200', road: 'N87', lat: 45.15652758486637, lon: 5.7475476745737355, manager: 'DIR Centre-Est', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/nce_31.mp4' },
  { name: 'A480 Grenoble vers Grenoble Sud', road: 'A480', lat: 45.15873823197743, lon: 5.7005336069172925, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area09.mp4' },
  { name: 'A480/RN481 direction Ouest/Sud', road: 'A480 / RN481', lat: 45.21650958839951, lon: 5.6784500109717335, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area10.mp4' },
  { name: 'A48 aire de l’Île rose', road: 'A48', lat: 45.272598746702336, lon: 5.625897585313137, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area08.mp4' },
  { name: 'A41S près de Grenoble vers Grenoble', road: 'A41S', lat: 45.203406837349334, lon: 5.7762608185576765, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area05.mp4' },
  { name: 'A48 Châbons voie Sud', road: 'A48', lat: 45.44780572102549, lon: 5.399438919782866, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area11.mp4' },
  { name: 'Saut du Moine N85 PR52+595', road: 'N85', lat: 45.09107420388591, lon: 5.724767451985743, manager: 'DIR Centre-Est', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/nce_38.mp4' },
  { name: 'Vienne N7 PR5+434', road: 'N7', lat: 45.531422895527555, lon: 4.873893232425462, manager: 'DIR Centre-Est', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/nce_29.mp4' },
];

function nearestPointOnCorridor(corridor = [], anchor = null) {
  if (!Array.isArray(corridor) || !corridor.length) return null;
  if (!anchor || Number.isNaN(Number(anchor.lat)) || Number.isNaN(Number(anchor.lon))) {
    const [lat, lon] = corridor[0];
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }

  let nearest = null;
  let shortestDistance = Number.POSITIVE_INFINITY;

  corridor.forEach((point) => {
    const [lat, lon] = point;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const distance = ((lat - anchor.lat) ** 2) + ((lon - anchor.lon) ** 2);
    if (distance < shortestDistance) {
      shortestDistance = distance;
      nearest = { lat, lon };
    }
  });

  return nearest;
}


function cameraPopupMarkup(camera = {}) {
  const name = escapeHtml(camera.name || 'Caméra routière');
  const road = escapeHtml(camera.road || 'Réseau principal');
  const manager = escapeHtml(camera.manager || camera.source || 'Bison Futé');
  const rawSourceUrl = camera.imageUrl || camera.image_url || camera.streamUrl || camera.folder_url || camera.source_url || 'https://www.bison-fute.gouv.fr';
  const sourceUrl = escapeHtml(rawSourceUrl);
  const pageUrl = escapeHtml(camera.source_url || camera.folder_url || rawSourceUrl);
  const mediaType = camera.mediaType === 'image' || camera.imageUrl || camera.image_url ? 'image' : 'video';
  const updatedAt = camera.image_updated_at || camera.updated_at || '';
  const mediaMarkup = mediaType === 'image'
    ? `<img src="${sourceUrl}" alt="Flux image caméra ${name}" loading="lazy" referrerpolicy="no-referrer" />`
    : `<video muted autoplay loop playsinline preload="metadata" aria-label="Flux caméra ${name}">
          <source src="${sourceUrl}" type="video/mp4" />
        </video>`;
  return `
    <article class="camera-popup">
      <strong>🎥 ${name}</strong><br/>
      <span class="badge neutral">${road} · ${manager}</span>
      <a class="camera-popup__media" href="${sourceUrl}" target="_blank" rel="noreferrer" title="Ouvrir le flux caméra dans un nouvel onglet">
        ${mediaMarkup}
      </a>
      ${updatedAt ? `<span class="muted">Image: ${escapeHtml(updatedAt)}</span>` : ''}
      <a href="${pageUrl}" target="_blank" rel="noreferrer">Voir la source caméra</a>
    </article>
  `;
}


const homeView = document.getElementById('home-view');
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const passwordForm = document.getElementById('password-form');

const normalizeLevel = (level) => {
  const raw = String(level ?? '').trim().toLowerCase();
  if (!raw || raw === '-' || raw === 'unknown' || raw === 'inconnu' || raw === 'inconnue' || raw === 'pending' || raw === 'idle' || raw === 'gris') return 'gris';
  return ({ verte: 'vert', green: 'vert', yellow: 'jaune', red: 'rouge', grey: 'gris', gray: 'gris' }[raw] || raw);
};
const levelColor = (level) => ({ vert: '#2f9e44', jaune: '#f59f00', orange: '#f76707', rouge: '#e03131', gris: '#64748b' }[normalizeLevel(level)] || '#64748b');
const LOG_LEVEL_EMOJI = { vert: '🟢', jaune: '🟡', orange: '🟠', rouge: '🔴' };
const LOG_STATUS_LABEL = { nouveau: 'Nouveau', en_cours: 'En cours', suivi: 'Suivi', clos: 'Clos' };
const EVENT_STATUS_LABEL = { ouvert: 'Ouvert', clos: 'Clos' };

function debounce(fn, wait = 200) {
  let timeoutId = null;
  return (...args) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), wait);
  };
}

function riskRank(level) {
  return ({ rouge: 4, orange: 3, jaune: 2, vert: 1 }[normalizeLevel(level)] || 0);
}

function globalRiskPercent(dashboard = {}) {
  const raw = dashboard.global_risk_percent ?? dashboard.global_risk_score;
  const score = Number(raw);
  if (Number.isFinite(score)) return Math.max(0, Math.min(100, Math.round(score)));
  const fallback = { vert: 8, jaune: 35, orange: 65, rouge: 90 }[normalizeLevel(dashboard.global_risk)];
  return fallback ?? 0;
}

function formatGlobalRiskValue(dashboard = {}) {
  const level = normalizeLevel(dashboard.global_risk || dashboard.vigilance || 'vert');
  return `${globalRiskPercent(dashboard)}% · ${level}`;
}

function buildGlobalRiskFactorsMarkup(dashboard = {}) {
  const factors = Array.isArray(dashboard.global_risk_factors) ? dashboard.global_risk_factors : [];
  if (!factors.length) return '<li>Aucun facteur aggravant significatif.</li>';
  return factors.map((factor) => {
    const points = Number(factor.points || 0);
    const detail = factor.detail ? ` · <span class="muted">${escapeHtml(factor.detail)}</span>` : '';
    return `<li><strong>${escapeHtml(factor.label || 'Facteur')}</strong> +${points} pts${detail}</li>`;
  }).join('');
}

function stationStatusLevel(station = {}) {
  const status = normalizeLevel(station.control_status || station.status || '');
  if (['vert', 'jaune', 'orange', 'rouge'].includes(status)) return status;
  return normalizeLevel(station.level || 'vert');
}

function formatLogScope(log = {}) {
  const scope = String(log.target_scope || 'departemental').toLowerCase();
  if (scope === 'pcs') return 'PCS';
  if (scope === 'commune') return `Commune${log.municipality_id ? ` · ${escapeHtml(getMunicipalityName(log.municipality_id))}` : ''}`;
  return 'Départemental';
}

function getMunicipalityName(municipalityId) {
  const id = String(municipalityId || '');
  if (!id) return 'Commune inconnue';
  const fromCache = cachedMunicipalityRecords.find((municipality) => String(municipality.id) === id)
    || cachedMunicipalities.find((municipality) => String(municipality.id) === id);
  if (fromCache?.name) return fromCache.name;
  return `#${id}`;
}

function getEventTitle(eventId) {
  const id = String(eventId || '');
  if (!id) return 'Évènement non défini';
  const event = (Array.isArray(cachedEvents) ? cachedEvents : []).find((item) => String(item.id) === id);
  return event?.title || `Évènement #${id}`;
}

function eventStatusRank(status = 'ouvert') {
  const normalized = String(status || 'ouvert').toLowerCase();
  if (normalized === 'ouvert') return 0;
  if (normalized === 'clos') return 1;
  return 2;
}

function sortOperationalEvents(events = []) {
  return [...(Array.isArray(events) ? events : [])].sort((a, b) => {
    const statusDiff = eventStatusRank(a.status) - eventStatusRank(b.status);
    if (statusDiff !== 0) return statusDiff;
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });
}

function getSelectedOperationalEvent() {
  if (!selectedOperationalEventId) return null;
  return cachedEvents.find((event) => String(event.id) === String(selectedOperationalEventId)) || null;
}

function isOpenOrActiveEvent(event = {}) {
  const status = String(event?.status || '').toLowerCase();
  return status === 'ouvert';
}

function renderEventMcoSuggestions() {
  const target = document.getElementById('log-event-mco-suggestions');
  if (!target) return;
  target.innerHTML = '';
}

function getLogById(logId) {
  return (Array.isArray(cachedLogs) ? cachedLogs : []).find((log) => String(log.id) === String(logId)) || null;
}

function fillLogFormFromEntry(log = {}) {
  const form = document.getElementById('log-form');
  if (!form) return;
  form.elements.danger_level.value = log.danger_level || 'vert';
  form.elements.target_scope.value = log.target_scope || 'departemental';
  form.elements.municipality_id.value = log.municipality_id ? String(log.municipality_id) : '';
  form.elements.location.value = log.location || '';
  form.elements.source.value = log.source || '';
  form.elements.assigned_to.value = log.assigned_to || '';
  form.elements.event_time.value = log.event_time ? toDatetimeLocal(log.event_time) : '';
  form.elements.next_update_due.value = log.next_update_due ? toDatetimeLocal(log.next_update_due) : '';
  form.elements.description.value = log.description || '';
  form.elements.actions_taken.value = log.actions_taken || '';
  form.dataset.editLogId = String(log.id);
  const submitButton = document.getElementById('mco-submit-btn') || form.querySelector('button[type="submit"]');
  if (submitButton) submitButton.textContent = 'Enregistrer la modification';
  const cancelBtn = document.getElementById('mco-cancel-edit-btn');
  if (cancelBtn) { cancelBtn.hidden = false; cancelBtn.classList.remove('hidden'); }
  syncLogScopeFields();
}

function prefillEventTime() {
  const input = document.getElementById('log-event-time');
  if (!input || input.value) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  input.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function resetLogFormState() {
  const form = document.getElementById('log-form');
  if (!form) return;
  delete form.dataset.editLogId;
  const submitButton = document.getElementById('mco-submit-btn') || form.querySelector('button[type="submit"]');
  if (submitButton) submitButton.textContent = "Ajouter l'entrée";
  const cancelBtn = document.getElementById('mco-cancel-edit-btn');
  if (cancelBtn) { cancelBtn.hidden = true; cancelBtn.classList.add('hidden'); }
  const eventTimeInput = document.getElementById('log-event-time');
  if (eventTimeInput) eventTimeInput.value = '';
  prefillEventTime();
}

function renderEventsList() {
  const target = document.getElementById('events-list');
  if (!target) return;

  let sorted = sortOperationalEvents(cachedEvents);

  // Apply sidebar filter
  if (mcoEventFilter === 'open') {
    sorted = sorted.filter((e) => String(e.status || 'ouvert').toLowerCase() !== 'clos');
  } else if (mcoEventFilter === 'clos') {
    sorted = sorted.filter((e) => String(e.status || '').toLowerCase() === 'clos');
  }

  const markup = sorted.map((event) => {
    const isSelected = String(event.id) === String(selectedOperationalEventId);
    const municipality = event.municipality_id
      ? escapeHtml(getMunicipalityName(event.municipality_id))
      : 'Départemental';
    const status = EVENT_STATUS_LABEL[event.status] || event.status || 'Ouvert';
    const isClosed = String(event.status || '').toLowerCase() === 'clos';

    // Compute worst severity from MCO entries for this event
    const eventLogs = (Array.isArray(cachedLogs) ? cachedLogs : [])
      .filter((log) => String(log.event_id || '') === String(event.id));
    const worstLevel = eventLogs.reduce((max, log) => {
      return riskRank(log.danger_level) > riskRank(max) ? (log.danger_level || 'vert') : max;
    }, 'vert');
    const levelNorm = normalizeLevel(worstLevel);
    const levelEmoji = LOG_LEVEL_EMOJI[levelNorm] || '🟢';

    const badgeClass = levelNorm === 'rouge' ? 'red' : levelNorm === 'orange' ? 'orange' : levelNorm === 'jaune' ? 'yellow' : 'green';

    return `<li>
      <div class="mco-event-card mco-event-card--${levelNorm}${isSelected ? ' active' : ''}" data-event-open="${event.id}" role="button" tabindex="0">
        <div class="mco-event-card-title">${levelEmoji} ${escapeHtml(event.title || 'Évènement')}</div>
        <div class="mco-event-card-sub">${escapeHtml(event.address || '-')} · ${municipality}</div>
        <div class="mco-event-card-foot">
          <span class="badge ${isClosed ? 'neutral' : badgeClass}" style="font-size:.7rem;padding:.18rem .5rem">${escapeHtml(status)}</span>
          ${eventLogs.length > 0 ? `<span class="mco-event-entry-count">📝 ${eventLogs.length} entrée${eventLogs.length > 1 ? 's' : ''}</span>` : '<span class="mco-event-entry-count muted">Aucune entrée</span>'}
          ${isSelected ? '<span style="font-size:.72rem;font-weight:700;color:var(--primary)">● ouvert</span>' : ''}
        </div>
      </div>
    </li>`;
  }).join('');

  target.innerHTML = markup || `<li><p class="muted" style="font-size:.85rem;padding:.4rem .2rem">Aucun évènement ${mcoEventFilter === 'open' ? 'en cours' : mcoEventFilter === 'clos' ? 'clôturé' : ''}.</p></li>`;
}

function updateEventDetailPanel() {
  const detailPanel = document.getElementById('event-detail');
  const emptyState = document.getElementById('mco-empty-state');
  const workspace = document.querySelector('.mco-workspace');
  const selectedEvent = getSelectedOperationalEvent();
  if (!detailPanel) return;

  if (!selectedEvent) {
    setVisibility(detailPanel, false);
    if (emptyState) setVisibility(emptyState, true);
    if (workspace) workspace.classList.remove('mco-event-selected');
    renderEventMcoSuggestions();
    return;
  }

  setVisibility(detailPanel, true);
  if (emptyState) setVisibility(emptyState, false);
  if (workspace) workspace.classList.add('mco-event-selected');

  setText('event-detail-title', selectedEvent.title || 'Fiche évènement');
  const status = EVENT_STATUS_LABEL[selectedEvent.status] || selectedEvent.status || 'Ouvert';
  const locality = selectedEvent.municipality_id ? getMunicipalityName(selectedEvent.municipality_id) : 'Départemental';
  const isClosed = String(selectedEvent.status || '').toLowerCase() === 'clos';
  const levelEmoji = (() => {
    const eventLogs = (Array.isArray(cachedLogs) ? cachedLogs : [])
      .filter((log) => String(log.event_id || '') === String(selectedEvent.id));
    const worstLevel = eventLogs.reduce((max, log) => riskRank(log.danger_level) > riskRank(max) ? (log.danger_level || 'vert') : max, 'vert');
    return LOG_LEVEL_EMOJI[normalizeLevel(worstLevel)] || '🟢';
  })();
  setText('event-detail-meta', `${levelEmoji} ${escapeHtml(selectedEvent.address || 'Adresse non renseignée')} · ${locality} · ${status}${isClosed ? ' 🔒' : ''}`);

  const closeButton = document.getElementById('event-close-btn');
  if (closeButton) {
    closeButton.setAttribute('data-event-status', String(selectedEvent.id));
    closeButton.setAttribute('data-event-next', isClosed ? 'ouvert' : 'clos');
    closeButton.textContent = isClosed ? "Réouvrir" : "Clôturer";
  }

  const deleteButton = document.getElementById('event-delete-btn');
  if (deleteButton) deleteButton.setAttribute('data-event-delete', String(selectedEvent.id));

  // Show/hide the add-entry form based on closed state
  const addWrap = document.querySelector('.mco-add-wrap');
  if (addWrap) addWrap.style.opacity = isClosed ? '.5' : '1';

  renderEventMcoSuggestions();
}

function selectOperationalEvent(eventId) {
  selectedOperationalEventId = eventId ? String(eventId) : null;
  updateEventDetailPanel();
  renderEventsList();
  renderLogsList();
}

function openOperationalEventMcoForm(eventId) {
  if (!eventId) return;
  setActivePanel('logs-panel');
  selectOperationalEvent(eventId);
  const form = document.getElementById('log-form');
  form?.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function populateEventOptions(events = []) {
  const source = sortOperationalEvents(events);
  const filterSelect = document.getElementById('logs-event-filter');
  if (filterSelect) {
    const current = filterSelect.value;
    const options = '<option value="all">Tous les évènements</option>' + source
      .map((event) => `<option value="${event.id}">${escapeHtml(event.title)}</option>`)
      .join('');
    setHtml('logs-event-filter', options);
    if (current) filterSelect.value = current;
  }
}

function populateLogMunicipalityOptions(municipalities = []) {
  let source = Array.isArray(municipalities) ? municipalities : [];
  if (!source.length && Array.isArray(cachedMunicipalityRecords) && cachedMunicipalityRecords.length) source = cachedMunicipalityRecords;
  if (!source.length && Array.isArray(cachedMunicipalities) && cachedMunicipalities.length) source = cachedMunicipalities;
  if (!source.length) source = [];

  const createOptions = (includeEmpty = true, allLabel = 'Toutes les communes') => {
    const base = includeEmpty ? `<option value="">Sélectionnez une commune</option>` : `<option value="all">${allLabel}</option>`;
    return base + source
      .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}${m.pcs_active ? ' · PCS actif' : ''}</option>`)
      .join('');
  };

  const formSelect = document.getElementById('log-municipality-id');
  if (formSelect) {
    const current = formSelect.value;
    setHtml('log-municipality-id', createOptions(true));
    if (current) formSelect.value = current;
  }

  const eventSelect = document.getElementById('event-municipality-id');
  if (eventSelect) {
    const current = eventSelect.value;
    const eventOptions = `<option value="">Aucune commune (départemental)</option>` + source
      .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`)
      .join('');
    setHtml('event-municipality-id', eventOptions);
    if (current) eventSelect.value = current;
  }

  const filterSelect = document.getElementById('logs-municipality-filter');
  if (filterSelect) {
    const currentFilter = filterSelect.value;
    setHtml('logs-municipality-filter', createOptions(false, 'Toutes les communes'));
    if (currentFilter) filterSelect.value = currentFilter;
  }
}

function syncLogScopeFields() {
  const scopeSelect = document.getElementById('log-target-scope');
  const municipalitySelect = document.getElementById('log-municipality-id');
  if (!scopeSelect || !municipalitySelect) return;
  const scope = String(scopeSelect.value || 'departemental');
  const requiresMunicipality = scope === 'commune' || scope === 'pcs';
  municipalitySelect.disabled = !requiresMunicipality;
  municipalitySelect.required = false;
  if (!requiresMunicipality) municipalitySelect.value = '';
}

function syncLogOtherFields() {
  const categorySelect = document.getElementById('log-event-type');
  const categoryOther = document.getElementById('log-event-type-other');
  const sourceSelect = document.getElementById('log-source-select');
  const sourceOther = document.getElementById('log-source-other');

  if (categorySelect && categoryOther) {
    const isOther = String(categorySelect.value || '').toLowerCase() === 'autre';
    categoryOther.required = isOther;
    setVisibility(categoryOther, isOther);
    if (!isOther) categoryOther.value = '';
  }

  if (sourceSelect && sourceOther) {
    const isOther = String(sourceSelect.value || '').toLowerCase() === 'autre';
    sourceOther.required = isOther;
    setVisibility(sourceOther, isOther);
    if (!isOther) sourceOther.value = '';
  }
}

async function ensureLogMunicipalitiesLoaded() {
  const municipalitySelect = document.getElementById('log-municipality-id');
  if (!municipalitySelect) return;
  const loadedOptions = Array.from(municipalitySelect.options || []).filter((option) => option.value).length;
  if (loadedOptions > 0) return;
  try {
    await loadMunicipalities();
  } catch (_) {
    populateLogMunicipalityOptions();
  }
}

function setVisibility(node, visible) {
  if (!node) return;
  node.classList.toggle('hidden', !visible);
  node.hidden = !visible;
}

function canEdit() { return ['admin', 'ope'].includes(currentUser?.role); }
function canCreateMapPoints() { return ['admin', 'ope'].includes(currentUser?.role); }
function canMunicipalityFiles() { return ['admin', 'ope'].includes(currentUser?.role); }
function canManageUsers() { return currentUser?.role === 'admin'; }
function roleLabel(role) { return { admin: 'Admin', ope: 'Opérateur', securite: 'Sécurité', visiteur: 'Visiteur', mairie: 'Mairie' }[role] || role; }
function canAccessPanel(panelId) {
  if (panelId === 'users-panel' || panelId === 'audit-panel') return currentUser?.role === 'admin';
  if (currentUser?.role === 'mairie') return MAIRIE_ALLOWED_PANELS.has(panelId);
  return true;
}
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function normalizeExternalUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('https://') || raw.startsWith('http://')) return raw;
  if (raw.startsWith('/')) return `https://www.georisques.gouv.fr${raw}`;
  return null;
}

function buildGeorisquesCommuneUrl(commune) {
  const code = String(commune?.code_insee || commune?.insee || '').trim();
  if (!code) return null;
  return `https://www.georisques.gouv.fr/minformer-sur-un-risque?insee=${encodeURIComponent(code)}`;
}

function buildGeorisquesApiSearchUrl(doc, commune) {
  const codeInsee = String(commune?.code_insee || commune?.insee || doc?.code_insee || '').trim();
  if (!codeInsee) return null;

  const title = String(doc?.title || doc?.libelle_azi || '').trim().toUpperCase();

  // DICRIM — page officielle Géorisques (pas l'endpoint JSON)
  if (title === 'DICRIM') return `https://www.georisques.gouv.fr/DICRIM/${encodeURIComponent(codeInsee)}`;

  // TIM & informations risques → fiche commune Géorisques
  if (title === 'TIM' || title.includes('RISQUE') || title.includes('INFORMATION')) return buildGeorisquesCommuneUrl(commune);

  // PPRN/PPRM/PPRT → fiche commune (les endpoints PPR n'ont pas de page publique directe)
  if (title === 'PPRN' || title === 'PPRM' || title === 'PPRT') return buildGeorisquesCommuneUrl(commune);

  // AZI et autres → fiche commune par défaut
  return buildGeorisquesCommuneUrl(commune);
}

function georisquesDocumentUrl(doc, commune) {
  const directUrl = normalizeExternalUrl(
    doc?.url
    || doc?.href
    || doc?.link
    || doc?.document_url
    || doc?.documentUrl
    || doc?.lien
    || doc?.lien_document
  );
  if (directUrl) return directUrl;
  const apiSearchUrl = buildGeorisquesApiSearchUrl(doc, commune);
  if (apiSearchUrl) return apiSearchUrl;
  return buildGeorisquesCommuneUrl(commune);
}

function showHome() { showLogin(); }
function showLogin() { setVisibility(homeView, false); setVisibility(loginView, true); setVisibility(appView, false); setVisibility(passwordForm, false); setVisibility(loginForm, true); }
function showApp() { setVisibility(homeView, false); setVisibility(loginView, false); setVisibility(appView, true); }

function loadLazyScript(src, globalName = '') {
  if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
  if (lazyAssetPromises.has(src)) return lazyAssetPromises.get(src);
  const promise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-lazy-src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(globalName ? window[globalName] : true), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Chargement impossible: ${src}`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.lazySrc = src;
    script.onload = () => resolve(globalName ? window[globalName] : true);
    script.onerror = () => reject(new Error(`Chargement impossible: ${src}`));
    document.head.appendChild(script);
  });
  lazyAssetPromises.set(src, promise);
  return promise;
}

function loadLazyStylesheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve(true);
  if (lazyAssetPromises.has(href)) return lazyAssetPromises.get(href);
  const promise = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.crossOrigin = '';
    link.onload = () => resolve(true);
    link.onerror = () => reject(new Error(`Chargement CSS impossible: ${href}`));
    document.head.appendChild(link);
  });
  lazyAssetPromises.set(href, promise);
  return promise;
}

async function ensureChartAssets() {
  if (window.Chart) return window.Chart;
  await loadLazyScript(LAZY_ASSETS.chartJs, 'Chart');
  return window.Chart;
}

async function ensureMapAssets() {
  await Promise.all([
    loadLazyStylesheet(LAZY_ASSETS.leafletCss),
    loadLazyStylesheet(LAZY_ASSETS.leafletDrawCss),
    loadLazyScript(LAZY_ASSETS.leafletJs, 'L'),
  ]);
  await Promise.all([
    loadLazyScript(LAZY_ASSETS.leafletDrawJs),
    loadLazyScript(LAZY_ASSETS.leafletHeatJs),
    loadLazyScript(LAZY_ASSETS.turfJs, 'turf'),
  ]);
  return window.L;
}

function isMapPanelActive() {
  return !document.getElementById('map-panel')?.classList.contains('hidden');
}

function apiOrigins() {
  const origins = [];
  const { protocol, hostname, port } = window.location;
  const isDefaultWebPort = (protocol === 'https:' && (port === '' || port === '443')) || (protocol === 'http:' && (port === '' || port === '80'));
  const lowerHostname = String(hostname || '').toLowerCase();
  // Les aliases loopback ne sont utiles que si le navigateur est AUSSI sur localhost.
  // Si l'utilisateur accède via une IP réseau (192.168.x.x, 10.x…), localhost:1182
  // pointe sur SA propre machine — pas le serveur — et ne fait que créer des délais.
  const isLocalHostname = ['localhost', '127.0.0.1', '::1'].includes(lowerHostname);

  origins.push(window.location.origin);

  if (hostname && !isLocalHostname) {
    // Accès via IP ou nom de domaine : on teste seulement le port explicite si besoin
    const preferredProtocol = protocol === 'https:' ? 'https:' : 'http:';
    if (isDefaultWebPort) origins.push(`${preferredProtocol}//${hostname}`);
    if (port !== '1182') origins.push(`${preferredProtocol}//${hostname}:1182`);
  }

  if (isLocalHostname) {
    // Sur localhost uniquement : on peut tester les aliases loopback
    origins.push('http://localhost:1182', 'http://127.0.0.1:1182');
  }

  return Array.from(new Set(origins));
}

function prioritizedApiOrigins() {
  const now = Date.now();
  const origins = apiOrigins();
  const withoutCooldown = origins.filter((origin) => {
    if (origin === preferredApiOrigin || origin === window.location.origin) return true;
    const failedAt = apiOriginFailures.get(origin);
    return !failedAt || (now - failedAt) >= API_ORIGIN_COOLDOWN_MS;
  });
  const candidates = withoutCooldown.length ? withoutCooldown : origins;
  return candidates.sort((a, b) => {
    if (a === preferredApiOrigin) return -1;
    if (b === preferredApiOrigin) return 1;
    if (a === window.location.origin) return -1;
    if (b === window.location.origin) return 1;
    return 0;
  });
}

function buildApiUrl(path, origin) {
  if (origin === window.location.origin) return path;
  return `${origin}${path}`;
}

function sanitizeErrorMessage(message) {
  const normalized = typeof message === 'string' ? message : String(message || '');
  if (!normalized) return 'Erreur inconnue';
  if (normalized.includes('Failed to fetch') || normalized.includes('NetworkError') || normalized.includes('ERR_CONNECTION_REFUSED')) {
    return "Connexion API indisponible. Vérifiez que le serveur tourne (docker compose up -d) et que le port est accessible.";
  }
  if (normalized.includes('Délai dépassé') || normalized.includes('AbortError') || normalized.includes('timeout')) {
    return "Délai dépassé — le serveur met trop longtemps à répondre. Réessayez dans quelques secondes.";
  }
  if (normalized.includes('<!doctype') || normalized.includes('<html')) {
    return "Le serveur démarre encore. Réessayez dans quelques secondes.";
  }
  if (normalized.includes('502') || normalized.includes('Bad Gateway')) {
    return "Serveur en cours de démarrage (502) — réessayez dans quelques secondes.";
  }
  if (normalized.includes('503') || normalized.includes('Service Unavailable') || normalized.includes('starting')) {
    return "Serveur en cours de démarrage — réessayez dans quelques secondes.";
  }
  return normalized;
}

function isNetworkFetchError(error) {
  const message = String(error?.message || '');
  return message.includes('Failed to fetch')
    || message.includes('NetworkError')
    || message.includes('Load failed')
    || message.includes('ERR_CONNECTION_REFUSED')
    || message.includes('ERR_NETWORK');
}

function isTransientBackendError(error) {
  const status = Number(error?.status || error?.cause?.status || 0);
  const message = String(error?.message || error?.cause?.message || '').toLowerCase();
  return status === 502
    || status === 503
    || status === 504
    || message.includes('backend démarre')
    || message.includes('backend demarre')
    || message.includes('service temporairement indisponible')
    || message.includes('serveur en cours de démarrage')
    || message.includes('serveur en cours de demarrage')
    || message.includes('délai dépassé')
    || message.includes('delai depasse')
    || isNetworkFetchError(error);
}


function setLoginError(message = '', debugDetails = '') {
  const errorTarget = document.getElementById('login-error');
  const debugWrap = document.getElementById('login-error-debug-wrap');
  const debugTarget = document.getElementById('login-error-debug');

  if (errorTarget) errorTarget.textContent = message;
  _setLoginStatus('');  // effacer le statut en cours quand une erreur apparaît

  if (!debugWrap || !debugTarget) return;
  if (!debugDetails) {
    debugWrap.classList.add('hidden');
    debugWrap.open = false;
    debugTarget.textContent = '';
    return;
  }

  debugTarget.textContent = debugDetails;
  debugWrap.classList.remove('hidden');
}

function _setLoginStatus(message = '') {
  const el = document.getElementById('login-status');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

function _setLoginSubmitting(submitting) {
  const btn = document.getElementById('login-submit-btn');
  if (btn) {
    btn.disabled = submitting;
    btn.textContent = submitting ? 'Connexion en cours…' : 'Connexion sécurisée';
  }
}

function buildLoginDebugDetails(error, username = '') {
  const lines = [
    `Horodatage: ${new Date().toISOString()}`,
    `Identifiant saisi: ${username || '(vide)'}`,
    `Message brut: ${String(error?.message || 'Erreur inconnue')}`,
  ];

  if (error?.status !== undefined && error?.status !== null && !Number.isNaN(Number(error.status))) {
    lines.push(`HTTP status: ${Number(error.status)}`);
  }

  const triedOrigins = Array.isArray(error?.triedOrigins) && error.triedOrigins.length
    ? error.triedOrigins.join(', ')
    : 'non disponible';
  lines.push(`Origines API testées: ${triedOrigins}`);

  if (error?.cause?.message) {
    lines.push(`Cause technique: ${String(error.cause.message)}`);
  }

  lines.push('Conseils: vérifier docker compose up -d, l\'écoute backend sur 0.0.0.0:1182, et le reverse proxy.');
  if (error?.payload && typeof error.payload === 'object') {
    if (error.payload.error) lines.push(`Erreur backend: ${String(error.payload.error)}`);
    if (error.payload.path) lines.push(`Route backend: ${String(error.payload.path)}`);
  }

  return lines.join('\n');
}

function formatElapsedSince(timestamp) {
  if (!timestamp) return 'inconnue';
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'inconnue';
  const elapsed = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (elapsed < 60) return `il y a ${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `il y a ${hours}h${remainingMinutes ? ` ${remainingMinutes}min` : ''}`;
}

function markServerSnapshotFresh(payload = {}) {
  const risks = payload?.external_risks && typeof payload.external_risks === 'object' ? payload.external_risks : payload;
  const rawUpdatedAt = payload?.updated_at || risks?.updated_at || payload?.dashboard?.updated_at;
  const parsed = rawUpdatedAt ? new Date(rawUpdatedAt).getTime() : 0;
  _lastServerSnapshotAt = Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
  _serverSnapshotSyncing = Boolean(
    risks?.refresh?.in_progress
    || isPendingServicePayload(risks?.meteo_france || {})
    || isPendingServicePayload(risks?.vigicrues || {})
  );
  _lastRefreshAllTs = Date.now();
}

function setServerSnapshotSyncing(syncing, label = '') {
  _serverSnapshotSyncing = Boolean(syncing);
  if (label) setStartupQueueCurrent(label);
}

function renderApiResyncClock() {
  const elapsed = formatElapsedSince(lastApiResyncAt);
  setText('api-resync-ago', elapsed);
  const fluxClock = document.getElementById('flux-resync-ago');
  if (fluxClock) fluxClock.textContent = `↻ ${elapsed}`;
  // Mise à jour live des âges individuels sans re-render complet
  document.querySelectorAll('.flux-age[data-updated-at]').forEach((el) => {
    const ts = Number(el.dataset.updatedAt);
    if (!ts) return;
    const intervalSec = Number(el.dataset.interval) || 120;
    const ageMs = Date.now() - ts;
    const ageSec = ageMs / 1000;
    const svcKey = el.closest('.flux-row')?.dataset.key;
    const state = el.closest('.flux-row')?.className?.includes('status-') ?
      (el.closest('.flux-row').className.match(/status-(\w+)/)?.[1] || 'online') : 'online';
    el.textContent = _fluxAgeLabel(ageMs, intervalSec, state).text;
    el.className = 'flux-age ' + _fluxAgeLabel(ageMs, intervalSec, state).css;
    const nextEl = el.nextElementSibling;
    if (nextEl && nextEl.classList.contains('flux-interval')) {
      nextEl.textContent = _fluxNextLabel(ts, intervalSec, state);
    }
  });
}

function normalizeApiErrorMessage(payload, status) {
  if (!payload) return `Erreur API (${status})`;
  const detail = payload.detail ?? payload.message;
  if (typeof detail === 'string' && detail.trim()) {
    const errorName = String(payload.error || '').trim();
    return errorName && !detail.includes(errorName) ? `${detail} (${errorName})` : detail;
  }
  if (Array.isArray(detail)) {
    const lines = detail.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const msg = String(item.msg || item.message || '').trim();
        const loc = Array.isArray(item.loc) ? item.loc.join('.') : '';
        if (msg && loc) return `${loc}: ${msg}`;
        if (msg) return msg;
      }
      return String(item || '').trim();
    }).filter(Boolean);
    if (lines.length) return lines.join(' · ');
  }
  if (detail && typeof detail === 'object') {
    const msg = String(detail.msg || detail.message || '').trim();
    if (msg) return msg;
    return JSON.stringify(detail);
  }
  return `Erreur API (${status})`;
}


// Données toujours servies par le serveur — aucun cache navigateur.
function saveSnapshot(key, payload) {} // no-op intentionnel
function readSnapshot(key) { return null; }
function readFreshSnapshot(key, ttlMs) { return null; }

function clonePayload(payload) {
  if (payload == null) return payload;
  return JSON.parse(JSON.stringify(payload));
}

function createComparablePayload(value, ignoredKeys = new Set()) {
  if (Array.isArray(value)) return value.map((item) => createComparablePayload(item, ignoredKeys));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  Object.keys(value).sort().forEach((key) => {
    if (ignoredKeys.has(key)) return;
    output[key] = createComparablePayload(value[key], ignoredKeys);
  });
  return output;
}

function createPayloadSignature(payload, ignoredKeys = []) {
  const ignored = new Set(Array.isArray(ignoredKeys) ? ignoredKeys : []);
  return JSON.stringify(createComparablePayload(payload, ignored));
}

function isCacheableRequest(path, fetchOptions = {}) {
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  if (method !== 'GET') return false;
  return !path.includes('/auth/login');
}


function createApiError(message, status = null, context = {}) {
  const error = new Error(message);
  if (status !== null && status !== undefined) error.status = Number(status);
  if (context && typeof context === 'object') Object.assign(error, context);
  return error;
}

function clearApiCache() {
  apiGetCache.clear();
  apiInFlight.clear();
}

function getRequestCacheKey(path, fetchOptions = {}) {
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  return `${method} ${path}`;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runNextQueuedApiRequest() {
  if (!apiRequestQueue.length || apiActiveRequests >= API_MAX_CONCURRENT_REQUESTS) return;
  const nextRequest = apiRequestQueue.shift();
  apiActiveRequests += 1;
  updateApiQueueVisual();
  Promise.resolve()
    .then(nextRequest)
    .finally(() => {
      apiActiveRequests = Math.max(0, apiActiveRequests - 1);
      updateApiQueueVisual();
      runNextQueuedApiRequest();
    });
}

function queueApiRequest(task) {
  return new Promise((resolve, reject) => {
    apiRequestQueue.push(async () => {
      try {
        resolve(await task());
      } catch (error) {
        reject(error);
      }
    });
    updateApiQueueVisual();
    runNextQueuedApiRequest();
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = API_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createApiError('Délai dépassé, veuillez vérifier votre réseau.', null, { isTimeout: true });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function canRetryRequest(error, attempt, method) {
  const maxRetries = method === 'GET' ? API_MAX_RETRIES_GET : API_MAX_RETRIES_NON_GET;
  if (attempt >= maxRetries) return false;
  if (error?.status !== undefined && error?.status !== null) return false;
  return Boolean(error?.isTimeout || isNetworkFetchError(error) || String(error?.message || '').includes('Réponse non-JSON'));
}

async function requestApiAcrossOrigins(path, fetchOptions = {}, {
  logoutOn401 = true,
  highPriority = false,
  maxRetries,
  timeoutMs = API_REQUEST_TIMEOUT_MS,
} = {}) {
  const headers = { 'Connection': 'keep-alive', ...(fetchOptions.headers || {}) };
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  if (token && !fetchOptions.omitAuth) headers.Authorization = `Bearer ${token}`;

  let lastError = null;
  const isLoginRequest = String(path || '').startsWith('/auth/login');
  const origins = isLoginRequest ? [window.location.origin] : prioritizedApiOrigins();
  const resolvedMaxRetries = Number.isInteger(maxRetries) && maxRetries >= 0
    ? maxRetries
    : (method === 'GET' ? API_MAX_RETRIES_GET : API_MAX_RETRIES_NON_GET);

  for (let attempt = 0; attempt <= resolvedMaxRetries; attempt += 1) {
    for (const origin of origins) {
      const url = buildApiUrl(path, origin);
      try {
        const runFetch = () => fetchWithTimeout(url, { ...fetchOptions, headers }, timeoutMs);
        const response = await (highPriority ? runFetch() : queueApiRequest(runFetch));
        const payload = await parseJsonResponse(response, path);
        if (!response.ok) {
          const message = normalizeApiErrorMessage(payload, response.status);
          if (response.status === 401 && logoutOn401) logout();
          throw createApiError(message, response.status, { payload });
        }
        preferredApiOrigin = origin;
        apiOriginFailures.delete(origin);
        return payload;
      } catch (error) {
        apiOriginFailures.set(origin, Date.now());
        if (error?.status !== undefined && error?.status !== null) throw error;
        lastError = error;
      }
    }

    if (!canRetryRequest(lastError, attempt, method) || attempt >= resolvedMaxRetries) break;
    const backoffMs = API_RETRY_BASE_DELAY_MS * (2 ** attempt);
    await wait(backoffMs);
  }

  throw createApiError(sanitizeErrorMessage(lastError?.message || 'API indisponible'), lastError?.status, { cause: lastError, triedOrigins: origins });
}

async function api(path, options = {}) {
  const {
    logoutOn401 = true,
    omitAuth = false,
    cacheTtlMs = API_CACHE_TTL_MS,
    bypassCache = false,
    highPriority = false,
    timeoutMs = API_REQUEST_TIMEOUT_MS,
    maxRetries,
    ...fetchOptions
  } = options;
  const cacheable = !bypassCache && isCacheableRequest(path, fetchOptions);
  const cacheKey = getRequestCacheKey(path, fetchOptions);

  if (cacheable) {
    const cached = apiGetCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < cacheTtlMs) {
      return clonePayload(cached.payload);
    }
    if (apiInFlight.has(cacheKey)) {
      return clonePayload(await apiInFlight.get(cacheKey));
    }
  }

  const requestPromise = requestApiAcrossOrigins(path, { ...fetchOptions, omitAuth }, {
    logoutOn401,
    highPriority,
    timeoutMs,
    maxRetries,
  });

  if (!cacheable) {
    const responsePayload = await requestPromise;
    // Vider le cache uniquement pour les mutations (POST/PUT/DELETE/PATCH), jamais pour les GET.
    // Vider pour un GET bypassCache tuerait toutes les requêtes in-flight en cours et
    // invaliderait des réponses récentes sans raison, causant des re-fetches inutiles.
    const mutatingMethod = String(fetchOptions.method || 'GET').toUpperCase();
    if (mutatingMethod !== 'GET') clearApiCache();
    return responsePayload;
  }

  apiInFlight.set(cacheKey, requestPromise);
  try {
    const payload = await requestPromise;
    apiGetCache.set(cacheKey, { timestamp: Date.now(), payload: clonePayload(payload) });
    return clonePayload(payload);
  } finally {
    apiInFlight.delete(cacheKey);
  }
}


async function parseJsonResponse(response, path = '') {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(`Réponse non-JSON pour ${path || response.url} (${response.status}): ${snippet}`);
  }
}

async function apiFile(path) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let lastError = null;
  for (const origin of apiOrigins()) {
    const url = buildApiUrl(path, origin);
    try {
      const response = await queueApiRequest(() => fetchWithTimeout(url, { headers }));
      if (!response.ok) {
        if (response.status === 401) logout();
        const detailText = await response.text();
        let detail = detailText;
        try {
          const payload = detailText ? JSON.parse(detailText) : null;
          detail = normalizeApiErrorMessage(payload, response.status);
        } catch (_) {
          detail = detailText || `Erreur API (${response.status})`;
        }
        throw createApiError(detail, response.status);
      }
      return { blob: await response.blob(), contentType: response.headers.get('content-type') || 'application/octet-stream' };
    } catch (error) {
      if (error?.status !== undefined && error?.status !== null) throw error;
      lastError = error;
      if (!isNetworkFetchError(error)) break;
    }
  }
  throw createApiError(sanitizeErrorMessage(lastError?.message || 'API indisponible'), lastError?.status);
}

function closeMobileSidebar() {
  document.getElementById('app-sidebar')?.classList.remove('open', 'mobile-open');
  document.getElementById('sidebar-backdrop')?.classList.remove('open', 'mobile-open');
  document.getElementById('app-menu-btn')?.setAttribute('aria-expanded', 'false');
}

function openMobileSidebar() {
  document.getElementById('app-sidebar')?.classList.add('open', 'mobile-open');
  document.getElementById('sidebar-backdrop')?.classList.add('open', 'mobile-open');
  document.getElementById('app-menu-btn')?.setAttribute('aria-expanded', 'true');
}

/* ── Mobile terrain helpers ── */
function isMobileView() { return window.innerWidth <= 768; }

function updateMobileNavActive(panelId) {
  document.querySelectorAll('.mobile-nav-btn[data-mobile-target]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mobileTarget === panelId);
  });
}

function openMobileMcoSheet() {
  const overlay = document.getElementById('mobile-mco-overlay');
  if (!overlay) return;
  // Pré-remplir l'heure
  const timeInput = overlay.querySelector('input[name="event_time"]');
  if (timeInput && !timeInput.value) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    timeInput.value = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
  overlay.hidden = false;
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeMobileMcoSheet() {
  const overlay = document.getElementById('mobile-mco-overlay');
  if (!overlay) return;
  overlay.hidden = true;
  overlay.classList.add('hidden');
  document.body.style.overflow = '';
}

function initMobileNav() {
  // Bottom nav — navigation entre panels
  document.querySelectorAll('.mobile-nav-btn[data-mobile-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setActivePanel(btn.dataset.mobileTarget);
      updateMobileNavActive(btn.dataset.mobileTarget);
    });
  });

  // Bouton nouvel événement
  document.getElementById('mobile-mco-open-btn')?.addEventListener('click', () => {
    _populateMobileEventMunicipalities();
    openMobileMcoSheet();
  });
  document.getElementById('mobile-mco-close')?.addEventListener('click', closeMobileMcoSheet);

  // Fermer en cliquant le fond
  document.getElementById('mobile-mco-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMobileMcoSheet();
  });

  // Bouton Menu → ouvre la sidebar
  document.getElementById('mobile-menu-btn')?.addEventListener('click', openMobileSidebar);

  // Soumission — création d'un événement
  document.getElementById('mobile-mco-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!canEdit()) { document.getElementById('mobile-mco-error').textContent = 'Accès en lecture seule.'; return; }
    const form = new FormData(e.target);
    const errorEl = document.getElementById('mobile-mco-error');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    try {
      errorEl.textContent = '';
      if (submitBtn) submitBtn.disabled = true;
      const created = await api('/events', {
        method: 'POST',
        highPriority: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: String(form.get('title') || '').trim(),
          address: String(form.get('address') || '').trim(),
          status: 'ouvert',
          municipality_id: form.get('municipality_id') ? Number(form.get('municipality_id')) : null,
        }),
      });
      e.target.reset();
      closeMobileMcoSheet();
      // Sélectionner le nouvel événement et aller sur la main courante
      if (created?.id) selectedOperationalEventId = String(created.id);
      upsertCachedEvent(created);
      setActivePanel('logs-panel');
    } catch (err) {
      errorEl.textContent = sanitizeErrorMessage(err.message);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  // Mettre à jour le badge actif quand setActivePanel est appelé
  const _origSetActivePanel = setActivePanel;
  window._mobileNavHooked = true;
}

// ── Géolocalisation terrain (mobile uniquement) ──────────────────────────────
const _GEO_STORAGE_KEY = 'agentDisplayName';
const _GEO_INTERVAL_MS = 20000;

const _geoState = {
  active: false,
  intervalId: null,
  markersRefreshId: null,
  wakeLock: null,
  name: null,
};

let _agentMarkersLayer = null;

function _geoToast(msg, type = 'info') {
  const el = document.getElementById('geo-toast');
  if (!el) return;
  const bg    = { info: '#e3f2fd', success: '#e8f5e9', error: '#ffebee' };
  const brd   = { info: '#90caf9', success: '#a5d6a7', error: '#ef9a9a' };
  const color = { info: '#1565c0', success: '#2e7d32', error: '#c62828' };
  el.innerHTML = `<div style="padding:.5rem .85rem;border-radius:8px;font-size:.82rem;font-weight:600;
    background:${bg[type]};border:1px solid ${brd[type]};color:${color[type]};
    box-shadow:0 2px 8px rgba(0,0,0,.15)">${escapeHtml(msg)}</div>`;
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.innerHTML = ''; }, 5000);
}

function _ensureAgentLayer() {
  if (!leafletMap || _agentMarkersLayer) return;
  _agentMarkersLayer = window.L.layerGroup().addTo(leafletMap);
}

function _setAgentFilterStatus(msg, color) {
  const el = document.getElementById('filter-agents-status');
  if (el) { el.textContent = msg; el.style.color = color || 'var(--muted)'; }
}

async function _refreshAgentMarkers() {
  if (!leafletMap) return;
  _ensureAgentLayer();

  const filterEl = document.getElementById('filter-agents');
  if (filterEl && !filterEl.checked) {
    if (_agentMarkersLayer) _agentMarkersLayer.clearLayers();
    return;
  }

  let agents = [];
  try {
    const origin = apiOrigins()[0];
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`${origin}/agents/locations`, { headers });
    if (!res.ok) {
      _setAgentFilterStatus(`Erreur HTTP ${res.status}`, '#c62828');
      return;
    }
    const data = await res.json();
    agents = Array.isArray(data?.agents) ? data.agents : [];
  } catch (e) {
    _setAgentFilterStatus('Réseau indisponible', '#c62828');
    return;
  }

  _agentMarkersLayer.clearLayers();
  if (!leafletMap.hasLayer(_agentMarkersLayer)) _agentMarkersLayer.addTo(leafletMap);

  const nowTs = Date.now();
  const nowStr = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  _setAgentFilterStatus(agents.length === 0 ? `0 agent · ${nowStr}` : `${agents.length} agent(s) · ${nowStr}`, agents.length > 0 ? '#2e7d32' : 'var(--muted)');

  for (const agent of agents) {
    const updatedMs = agent.updated_at ? new Date(agent.updated_at).getTime() : 0;
    const ageSec = updatedMs > 0 ? (nowTs - updatedMs) / 1000 : 999;
    const isStale = ageSec >= 30;
    const ts = updatedMs > 0 ? new Date(updatedMs).toLocaleTimeString('fr-FR') : '';

    // Vert = signal frais (<30s), Rouge = connexion perdue (≥30s, expire dans Redis à 60s)
    const fillColor = isStale ? '#e53935' : '#2e7d32';
    const statusLabel = isStale ? '🔴 Signal perdu' : '🟢 En ligne';

    const circle = window.L.circleMarker([agent.lat, agent.lon], {
      radius: 10,
      color: '#fff',
      weight: 3,
      fillColor,
      fillOpacity: 1,
    })
      .bindTooltip(escapeHtml(agent.name), { permanent: true, direction: 'top', offset: [0, -14], className: 'agent-tooltip' })
      .bindPopup(`<strong>${escapeHtml(agent.name)}</strong><br>${statusLabel}<br>±${Math.round(agent.accuracy || 0)} m${ts ? `<br><small>Dernière position : ${ts}</small>` : ''}`)
      .addTo(_agentMarkersLayer);

    if (circle.bringToFront) circle.bringToFront();
  }
}

async function _geoSendPosition(lat, lon, accuracy) {
  try {
    const origin = apiOrigins()[0];
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${origin}/agents/location`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ name: _geoState.name, lat, lon, accuracy }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      _geoToast(`Erreur envoi position : ${err.detail || res.status}`, 'error');
    }
  } catch (e) {
    _geoToast('Impossible d\'envoyer la position (réseau ?)', 'error');
  }
}

async function _geoTick() {
  if (!navigator.geolocation || !_geoState.active) return;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      await _geoSendPosition(lat, lon, accuracy);
      _geoToast(`📍 Position envoyée · ±${Math.round(accuracy)} m`, 'success');
      // Centrer la carte sur soi au premier tick
      if (leafletMap && _geoState.firstTick) {
        _geoState.firstTick = false;
        leafletMap.setView([lat, lon], 14);
      }
      _refreshAgentMarkers();
    },
    (err) => {
      const msgs = { 1: 'Permission GPS refusée', 2: 'Position GPS indisponible', 3: 'Délai GPS dépassé' };
      _geoToast(msgs[err.code] || 'Erreur GPS', 'error');
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
  );
}

async function _acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    _geoState.wakeLock = await navigator.wakeLock.request('screen');
    _geoState.wakeLock.addEventListener('release', () => { _geoState.wakeLock = null; });
  } catch (_) {}
}

function _releaseWakeLock() {
  if (_geoState.wakeLock) {
    try { _geoState.wakeLock.release(); } catch (_) {}
    _geoState.wakeLock = null;
  }
}

async function _onGeoVisibilityChange() {
  if (!document.hidden && _geoState.active && !_geoState.wakeLock) {
    await _acquireWakeLock();
    _geoTick();
  }
}

async function _startGeoTracking(name) {
  _geoState.name = name;
  _geoState.active = true;
  _geoState.firstTick = true;
  localStorage.setItem(_GEO_STORAGE_KEY, name);

  // Ouvrir la carte pour voir sa position
  setActivePanel('map-panel');
  setTimeout(() => { if (leafletMap) leafletMap.invalidateSize(); }, 120);

  await _acquireWakeLock();
  await _geoTick();
  _geoState.intervalId = setInterval(_geoTick, _GEO_INTERVAL_MS);
  _geoState.markersRefreshId = setInterval(_refreshAgentMarkers, _GEO_INTERVAL_MS);
  document.addEventListener('visibilitychange', _onGeoVisibilityChange);

  const btn = document.getElementById('mobile-locate-btn');
  if (btn) {
    btn.classList.add('mobile-nav-btn--locate-active');
    const lbl = btn.querySelector('.mobile-nav-label');
    if (lbl) lbl.textContent = 'Actif';
  }
}

function _stopGeoTracking() {
  _geoState.active = false;
  clearInterval(_geoState.intervalId);
  clearInterval(_geoState.markersRefreshId);
  _geoState.intervalId = null;
  _geoState.markersRefreshId = null;
  _releaseWakeLock();
  document.removeEventListener('visibilitychange', _onGeoVisibilityChange);
  if (_agentMarkersLayer) _agentMarkersLayer.clearLayers();
  _geoToast('Partage de position arrêté', 'info');
  const btn = document.getElementById('mobile-locate-btn');
  if (btn) {
    btn.classList.remove('mobile-nav-btn--locate-active');
    const lbl = btn.querySelector('.mobile-nav-label');
    if (lbl) lbl.textContent = 'Localiser';
  }
}

function openAgentNameModal() {
  const modal = document.getElementById('agent-name-modal');
  if (!modal) return;
  const saved = localStorage.getItem(_GEO_STORAGE_KEY) || '';
  const input = document.getElementById('agent-name-input');
  if (input && saved) input.value = saved;
  modal.hidden = false;
  modal.classList.remove('hidden');
  setTimeout(() => input?.focus(), 50);
}

function closeAgentNameModal() {
  const modal = document.getElementById('agent-name-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.classList.add('hidden');
}

function toggleGeoTracking() {
  if (_geoState.active) {
    _stopGeoTracking();
  } else {
    openAgentNameModal();
  }
}

function initMobileGeoLocate() {
  if (!isMobileView()) return;
  document.getElementById('mobile-locate-btn')?.addEventListener('click', toggleGeoTracking);
  document.getElementById('agent-name-close')?.addEventListener('click', closeAgentNameModal);
  document.getElementById('agent-name-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAgentNameModal();
  });
  document.getElementById('agent-name-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (document.getElementById('agent-name-input')?.value || '').trim();
    if (!name) return;
    closeAgentNameModal();
    await _startGeoTracking(name);
  });
}

function _populateMobileEventMunicipalities() {
  const select = document.getElementById('mobile-event-municipality-id');
  if (!select || select.dataset.populated) return;
  const municipalities = Array.isArray(cachedMunicipalities) ? cachedMunicipalities : [];
  municipalities.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr')).forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name || `Commune #${m.id}`;
    select.appendChild(opt);
  });
  select.dataset.populated = '1';
}

function syncMobileNavWithPanel() {
  const stored = localStorage.getItem('activePanel') || 'situation-panel';
  updateMobileNavActive(stored);
}

async function ensureMapReady() {
  if (leafletMap) return leafletMap;
  if (!mapBootstrapPromise) {
    mapBootstrapPromise = ensureMapAssets()
      .then(async () => {
        await loadIsereBoundary();
        if (token) startMapAnnotationsSync();
      })
      .catch((error) => {
        mapBootstrapPromise = null;
        throw error;
      });
  }
  await mapBootstrapPromise;
  return leafletMap;
}

function setActivePanel(panelId) {
  if (!canAccessPanel(panelId)) panelId = 'situation-panel';
  closeMobileSidebar();
  localStorage.setItem(STORAGE_KEYS.activePanel, panelId);
  document.querySelectorAll('.menu-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.target === panelId));
  document.querySelectorAll('.view').forEach((panel) => setVisibility(panel, panel.id === panelId));
  updateGlobalLoadingVisual(getStartupQueuePercent());
  updateMobileNavActive(panelId);
  document.getElementById('panel-title').textContent = PANEL_TITLES[panelId] || 'Centre opérationnel';
  requestPriorityServicesForPanel(panelId);
  if (panelId === 'map-panel') {
    withPanelLoading('map-panel', 'Chargement de la carte...', () => ensureMapReady().then(() => {
      setTimeout(() => {
        leafletMap?.invalidateSize();
        centerMapOnIsere();
      }, 100);
      if (token) _refreshAgentMarkers();
      if (token && !stationsTimetableCache) loadAndRenderStationsPanel(false).catch(() => {});
      renderResources();
      renderTrafficOnMap().catch(() => {});
    })).catch((error) => {
      setMapFeedback(`Carte indisponible: ${sanitizeErrorMessage(error.message)}`, true);
    });
  }
  if (panelId === 'logs-panel') ensureLogMunicipalitiesLoaded();
  if (panelId === 'news-panel') ensureSocialFeedsRendered();
  if (['situation-panel', 'services-panel', 'meteo-panel', 'news-panel'].includes(panelId) && token) {
    withPanelLoading(panelId, 'Synchronisation des données...', async () => {
      if (panelId === 'situation-panel') await loadDashboard(false);
      await loadExternalRisks(false);
      if (panelId === 'meteo-panel') await renderWeeklyWeatherPanel(cachedExternalRisksSnapshot || {});
    }).catch((error) => {
      const errorTarget = document.getElementById('dashboard-error');
      if (errorTarget && !errorTarget.textContent.trim()) errorTarget.textContent = sanitizeErrorMessage(error.message);
    });
  }
  if (panelId === 'water-panel' && token) {
    withPanelLoading('water-panel', 'Chargement eau potable...', () => loadAndRenderWaterPanel(false)).catch((error) => {
      waterPanelEmptyState(sanitizeErrorMessage(error.message));
    });
  }
  if (panelId === 'contacts-panel' && token) {
    const city = currentUser?.role === 'mairie'
      ? String(currentUser?.municipality_name || selectedContactsCity || '').trim()
      : String(selectedContactsCity || '').trim();
    withPanelLoading('contacts-panel', 'Chargement contacts...', () => loadAndRenderContactsPanel(city, false)).catch((error) => {
      contactsPanelEmptyState(sanitizeErrorMessage(error.message));
    });
  }
  if (panelId === 'api-panel' && token) {
    withPanelLoading('api-panel', 'Synchronisation des flux...', () => Promise.all([loadApiInterconnections(false), loadSystemHealth()])).catch((error) => {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    });
  }
  if (panelId === 'stations-panel' && token) {
    withPanelLoading('stations-panel', 'Chargement horaires gares...', () => loadAndRenderStationsPanel(false)).catch((error) => {
      const errorEl = document.getElementById('stations-error');
      if (errorEl) errorEl.textContent = sanitizeErrorMessage(error.message);
    });
  }
  if (panelId === 'notifications-panel' && token) {
    withPanelLoading('notifications-panel', 'Chargement notifications...', async () => {
      await Promise.allSettled([_notifLoad(), _notifLoadLog()]);
    });
  }
}

function ensureSocialFeedsRendered() { /* social feeds removed */ }

function centerMapOnIsere() {
  if (!leafletMap) return;
  if (boundaryLayer?.getBounds) {
    const bounds = boundaryLayer.getBounds();
    if (bounds?.isValid && bounds.isValid()) {
      leafletMap.fitBounds(bounds, { padding: [16, 16] });
      return;
    }
  }
  leafletMap.setView([45.2, 5.72], 9);
}

function withPreservedScroll(runUpdate) {
  const SCROLL_RESTORE_TOLERANCE_PX = 4;
  const pageScroll = window.scrollY || document.documentElement.scrollTop || 0;
  const activePanelId = localStorage.getItem(STORAGE_KEYS.activePanel);
  const activePanel = activePanelId ? document.getElementById(activePanelId) : null;
  const panelScroll = activePanel ? activePanel.scrollTop : 0;
  const panelScrollLeft = activePanel ? activePanel.scrollLeft : 0;

  return Promise.resolve()
    .then(runUpdate)
    .finally(() => {
      if (activePanel && activePanel.id === (localStorage.getItem(STORAGE_KEYS.activePanel) || '')) {
        const panelStillAtInitialPosition = Math.abs(activePanel.scrollTop - panelScroll) <= SCROLL_RESTORE_TOLERANCE_PX
          && Math.abs(activePanel.scrollLeft - panelScrollLeft) <= SCROLL_RESTORE_TOLERANCE_PX;
        if (panelStillAtInitialPosition) {
          activePanel.scrollTop = panelScroll;
          activePanel.scrollLeft = panelScrollLeft;
        }
      }
      const latestPageScroll = window.scrollY || document.documentElement.scrollTop || 0;
      const pageStillAtInitialPosition = Math.abs(latestPageScroll - pageScroll) <= SCROLL_RESTORE_TOLERANCE_PX;
      if (pageStillAtInitialPosition) {
        window.scrollTo({ top: pageScroll, left: 0, behavior: 'auto' });
      }
    });
}


function updateMapSummary() {
  setText('map-summary-stations', String(mapStats.stations));
  setText('map-summary-pcs', String(mapStats.pcs));
  setText('map-summary-resources', String(mapStats.resources));
  setText('map-summary-custom', String(mapStats.custom));
  setText('map-summary-traffic', String(mapStats.traffic));
}

function mapZoneImpactExposureLevel(score = 0) {
  if (score >= 12) return 'Très élevée';
  if (score >= 8) return 'Élevée';
  if (score >= 5) return 'Modérée';
  return 'Faible';
}

function mapZoneImpactRiskScoreFromCommune(commune = {}) {
  const dangerRank = georisquesDangerRank(commune);
  const flood = Number(commune.flood_documents || commune.nb_documents || 0);
  const movements = Number(commune.ground_movements_total || 0);
  const roadDependency = Number(commune.tim_total || 0);
  const incidentHistory = Number(commune.gaspar_risk_total || 0);
  return (dangerRank * 2) + (flood > 0 ? 2 : 0) + (movements > 0 ? 2 : 0) + (roadDependency > 0 ? 1 : 0) + (incidentHistory >= 5 ? 2 : incidentHistory > 0 ? 1 : 0);
}

function selectedZoneGeometry() {
  if (!mapZoneImpactSelection || typeof mapZoneImpactSelection.toGeoJSON !== 'function') return null;
  try {
    return mapZoneImpactSelection.toGeoJSON()?.geometry || null;
  } catch {
    return null;
  }
}

function zoneImpactGeometryCoordinates(geometry) {
  if (!geometry || typeof geometry !== 'object') return [];
  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates?.[0])) return geometry.coordinates[0];
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    const largest = geometry.coordinates
      .filter((poly) => Array.isArray(poly?.[0]))
      .map((poly) => poly[0])
      .sort((a, b) => b.length - a.length)[0];
    return Array.isArray(largest) ? largest : [];
  }
  return [];
}

function zoneImpactBoundingBox(geometry) {
  const coords = zoneImpactGeometryCoordinates(geometry);
  const lons = coords.map((coord) => Number(coord?.[0])).filter(Number.isFinite);
  const lats = coords.map((coord) => Number(coord?.[1])).filter(Number.isFinite);
  if (!lons.length || !lats.length) return null;
  return {
    minLat: Math.min(...lats),
    minLon: Math.min(...lons),
    maxLat: Math.max(...lats),
    maxLon: Math.max(...lons),
  };
}

async function fetchZoneRnbBuildings(geometry) {
  const bbox = zoneImpactBoundingBox(geometry);
  if (!bbox) return { buildings: [], buildings_total: 0 };
  const params = new URLSearchParams({
    min_lat: String(bbox.minLat),
    min_lon: String(bbox.minLon),
    max_lat: String(bbox.maxLat),
    max_lon: String(bbox.maxLon),
    limit: '400',
  });
  const payload = await api(`/api/rnb/buildings?${params.toString()}`, {
    cacheTtlMs: 5 * 60 * 1000,
  });
  return payload && typeof payload === 'object' ? payload : { buildings: [], buildings_total: 0 };
}

function zoneImpactOverpassPoly(geometry) {
  const ring = zoneImpactGeometryCoordinates(geometry);
  if (ring.length < 4) return '';
  return ring
    .map((coord) => {
      const lon = Number(coord?.[0]);
      const lat = Number(coord?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return `${lat} ${lon}`;
    })
    .filter(Boolean)
    .join(' ');
}

function zoneImpactMunicipalityPoint(commune = {}) {
  const direct = normalizeMapCoordinates(commune.latitude, commune.longitude)
    || normalizeMapCoordinates(commune.lat, commune.lon);
  if (direct) return direct;

  const insee = String(commune.code_insee || commune.insee || '').trim();
  if (insee) {
    const municipality = cachedMunicipalities.find((item) => String(item.insee_code || '').trim() === insee);
    if (municipality) {
      const cacheKey = `${municipality.name}|${municipality.postal_code || ''}`;
      const point = geocodeCache.get(cacheKey);
      if (point) return point;
    }
  }
  return null;
}

function zoneImpactDepartmentCommunesInZone(geometry) {
  const georisques = cachedExternalRisksSnapshot?.georisques || {};
  const source = georisques.monitored_communes || georisques.monitored_municipalities || georisques.communes || [];
  const seen = new Set();
  return source.filter((commune) => {
    const id = String(commune.code_insee || commune.insee || commune.name || commune.commune || '').trim().toLowerCase();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    const point = zoneImpactMunicipalityPoint(commune);
    if (!point) return false;
    return isPointInsideGeometry(point, geometry);
  });
}

async function fetchZoneStreetInsights(geometry) {
  const poly = zoneImpactOverpassPoly(geometry);
  if (!poly) return { streets: [], districts: [] };
  const query = `[out:json][timeout:25];(
    way["highway"]["name"](poly:"${poly}");
    nwr["place"~"suburb|neighbourhood|quarter"]["name"](poly:"${poly}");
  );out tags;`;

  try {
    const response = await queueApiRequest(() => fetchWithTimeout('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: `data=${encodeURIComponent(query)}`,
      timeoutMs: 26000,
    }));
    const payload = await parseJsonResponse(response, 'https://overpass-api.de/api/interpreter');
    const elements = Array.isArray(payload?.elements) ? payload.elements : [];
    const streets = new Set();
    const districts = new Set();
    elements.forEach((element) => {
      const tags = element?.tags || {};
      const name = String(tags.name || '').trim();
      if (!name) return;
      if (tags.highway) streets.add(name);
      if (/(suburb|neighbourhood|quarter)/i.test(String(tags.place || ''))) districts.add(name);
    });
    return {
      streets: Array.from(streets).sort((a, b) => a.localeCompare(b, 'fr')).slice(0, 14),
      districts: Array.from(districts).sort((a, b) => a.localeCompare(b, 'fr')).slice(0, 8),
    };
  } catch {
    return { streets: [], districts: [] };
  }
}

function setZoneImpactPanelVisible(visible = false) {
  const panel = document.getElementById('map-zone-impact-panel');
  if (!panel) return;
  panel.hidden = !visible;
  panel.classList.toggle('hidden', !visible);
}

function renderZoneImpactPanel(html = '') {
  if (!html) {
    setZoneImpactPanelVisible(false);
    setHtml('map-zone-impact-list', '<li>Aucune zone d&rsquo;analyse active.</li>');
    return;
  }
  setZoneImpactPanelVisible(true);
  setHtml('map-zone-impact-list', html);
}

/** Géocode inverse le centre de la zone via Nominatim pour identifier ville/quartier/rue. */
async function fetchZoneGeographicContext(geometry) {
  const coords = zoneImpactGeometryCoordinates(geometry);
  if (!coords.length) return {};
  const lons = coords.map((c) => Number(c?.[0])).filter(Number.isFinite);
  const lats = coords.map((c) => Number(c?.[1])).filter(Number.isFinite);
  if (!lats.length || !lons.length) return {};
  const centerLat = lats.reduce((a, b) => a + b, 0) / lats.length;
  const centerLon = lons.reduce((a, b) => a + b, 0) / lons.length;
  try {
    const response = await fetchWithTimeout(
      `https://nominatim.openstreetmap.org/reverse?lat=${centerLat}&lon=${centerLon}&format=json&addressdetails=1&accept-language=fr`,
      { headers: { 'User-Agent': 'OPE-Protec/1.0' }, timeoutMs: 8000 },
    );
    const data = await parseJsonResponse(response, 'nominatim-reverse');
    const addr = data?.address || {};
    return {
      city: addr.city || addr.town || addr.village || addr.municipality || null,
      district: addr.suburb || addr.neighbourhood || addr.quarter || null,
      street: addr.road || addr.pedestrian || addr.footway || null,
      postcode: addr.postcode || null,
    };
  } catch {
    return {};
  }
}

/** Détermine l'échelle de la zone selon sa surface (m²). */
function detectZoneScale(areaM2) {
  if (areaM2 < 50_000) return 'rue';
  if (areaM2 < 2_000_000) return 'quartier';
  if (areaM2 < 50_000_000) return 'ville';
  return 'secteur';
}

/** Formate un nom de ressource pour l'affichage dans le rapport d'évacuation. */
function _zoneResourceName(r) {
  return escapeHtml(r.name || 'Sans nom');
}

function zoneImpactCenter(geometry) {
  const coords = zoneImpactGeometryCoordinates(geometry);
  const valid = coords
    .map((coord) => ({ lon: Number(coord?.[0]), lat: Number(coord?.[1]) }))
    .filter((coord) => Number.isFinite(coord.lat) && Number.isFinite(coord.lon));
  if (!valid.length) return null;
  return {
    lat: valid.reduce((sum, coord) => sum + coord.lat, 0) / valid.length,
    lon: valid.reduce((sum, coord) => sum + coord.lon, 0) / valid.length,
  };
}

function zoneImpactDistanceMeters(from, to) {
  const a = normalizeMapCoordinates(from?.lat, from?.lon);
  const b = normalizeMapCoordinates(to?.lat, to?.lon);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  if (leafletMap?.distance) return leafletMap.distance([a.lat, a.lon], [b.lat, b.lon]);
  const rad = Math.PI / 180;
  const earth = 6371000;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earth * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function zoneImpactPointFromItem(item = {}) {
  return normalizeMapCoordinates(item.lat, item.lon)
    || normalizeMapCoordinates(item.latitude, item.longitude)
    || normalizeMapCoordinates(item.y, item.x);
}

function zoneImpactOperationalEventsInZone(geometry, municipalitiesInZone = []) {
  const municipalityIds = new Set(
    municipalitiesInZone
      .map((m) => String(m.id || m.municipality_id || m.code_insee || m.insee || '').trim())
      .filter(Boolean),
  );
  const municipalityNames = new Set(
    municipalitiesInZone
      .map((m) => String(m.name || m.commune || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const logs = Array.isArray(cachedLogs) ? cachedLogs : [];
  return sortOperationalEvents(cachedEvents)
    .map((event) => {
      const point = zoneImpactPointFromItem(event);
      const inGeometry = point ? isPointInsideGeometry(point, geometry) : false;
      const municipalityMatch = event.municipality_id && municipalityIds.has(String(event.municipality_id));
      const municipalityNameMatch = event.municipality_id
        ? municipalityNames.has(String(getMunicipalityName(event.municipality_id) || '').trim().toLowerCase())
        : false;
      if (!inGeometry && !municipalityMatch && !municipalityNameMatch) return null;
      const eventLogs = logs.filter((log) => String(log.event_id || '') === String(event.id || ''));
      const worstLevel = eventLogs.reduce((level, log) => (
        riskRank(log.danger_level) > riskRank(level) ? normalizeLevel(log.danger_level) : level
      ), normalizeLevel(event.level || event.severity || 'vert'));
      const activeLogCount = eventLogs.filter((log) => String(log.status || '').toLowerCase() !== 'clos').length;
      return { ...event, coords: point, logs: eventLogs, worstLevel, activeLogCount };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function zoneImpactTrafficIncidentsInZone(geometry) {
  const source = [
    ...(Array.isArray(cachedItinisereEvents) ? cachedItinisereEvents : []),
    ...(Array.isArray(cachedBisonLiveEvents) ? cachedBisonLiveEvents : []),
  ];
  return source
    .map((event) => {
      const point = zoneImpactPointFromItem(event);
      if (!point || !isPointInsideGeometry(point, geometry)) return null;
      return { ...event, coords: point };
    })
    .filter(Boolean)
    .slice(0, 10);
}

function zoneImpactCustomPointsInZone(geometry) {
  return (Array.isArray(mapPoints) ? mapPoints : [])
    .map((point) => ({ ...point, coords: zoneImpactPointFromItem(point) }))
    .filter((point) => point.coords && isPointInsideGeometry(point.coords, geometry))
    .slice(0, 30);
}

function zoneImpactVigicruesStationsInZone(geometry) {
  const externalStations = Array.isArray(cachedExternalRisksSnapshot?.vigicrues?.stations)
    ? cachedExternalRisksSnapshot.vigicrues.stations
    : [];
  const source = [
    ...(Array.isArray(cachedVigicruesPayload?.stations) ? cachedVigicruesPayload.stations : []),
    ...externalStations,
  ];
  const seen = new Set();
  return source
    .map((station) => {
      const point = zoneImpactPointFromItem(station);
      const key = String(station.code || station.station || station.id || `${point?.lat},${point?.lon}`).trim();
      if (!point || seen.has(key) || !isPointInsideGeometry(point, geometry)) return null;
      seen.add(key);
      return { ...station, coords: point, statusLevel: stationStatusLevel(station) };
    })
    .filter(Boolean)
    .sort((a, b) => riskRank(b.statusLevel) - riskRank(a.statusLevel))
    .slice(0, 12);
}

function zoneImpactExternalRiskSummary(municipalitiesInZone = []) {
  const external = cachedExternalRisksSnapshot || {};
  const meteoLevel = normalizeLevel(external.meteo_france?.level || external.meteo_france?.vigilance || 'vert');
  const vigicruesLevel = normalizeLevel(external.vigicrues?.water_alert_level || 'vert');
  const apicAlerts = Number(external.apic_isere?.alerts_total ?? (external.apic_isere?.alerts || []).length ?? 0);
  const vigicruesFlashAlerts = Number(external.vigicrues_flash_isere?.alerts_total ?? (external.vigicrues_flash_isere?.alerts || []).length ?? 0);
  const atmoToday = external.atmo_aura?.today || {};
  const communes = municipalitiesInZone
    .map((commune) => {
      const score = mapZoneImpactRiskScoreFromCommune(commune);
      return {
        ...commune,
        score,
        exposureLabel: mapZoneImpactExposureLevel(score),
        dangerLabel: georisquesDangerLevel(commune).label,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  return {
    meteoLevel,
    vigicruesLevel,
    apicAlerts,
    vigicruesFlashAlerts,
    atmoLabel: atmoToday.label || atmoToday.index || atmoToday.level || 'non disponible',
    communes,
  };
}

function zoneImpactNearestResources(geometry, resources = [], typeSet = new Set(), max = 3) {
  const center = zoneImpactCenter(geometry);
  if (!center) return [];
  return resources
    .filter((resource) => typeSet.has(resource.type))
    .map((resource) => {
      const coords = zoneImpactPointFromItem(resource);
      if (!coords || isPointInsideGeometry(coords, geometry)) return null;
      return { ...resource, coords, distanceMeters: zoneImpactDistanceMeters(center, coords) };
    })
    .filter((resource) => resource && Number.isFinite(resource.distanceMeters))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, max);
}

function zoneImpactMunicipalityNameFromCode(code) {
  const safeCode = String(code || '').trim();
  if (!safeCode) return '';
  const municipality = (Array.isArray(cachedMunicipalities) ? cachedMunicipalities : [])
    .find((item) => String(item.insee_code || item.code_insee || item.code || '').trim() === safeCode);
  return municipality?.name || municipality?.commune || '';
}

function zoneImpactMunicipalityRecordFromCode(code) {
  const safeCode = String(code || '').trim();
  if (!safeCode) return null;
  return (Array.isArray(cachedMunicipalities) ? cachedMunicipalities : [])
    .find((item) => String(item.insee_code || item.code_insee || item.code || '').trim() === safeCode) || null;
}

function zoneImpactMunicipalityPostalLabel(input = {}) {
  const commune = typeof input === 'string' ? { code: input } : (input || {});
  const code = String(commune.code_insee || commune.insee || commune.code || '').trim();
  const name = String(commune.name || commune.commune || '').trim();
  const byCode = zoneImpactMunicipalityRecordFromCode(code);
  const byName = name
    ? (Array.isArray(cachedMunicipalities) ? cachedMunicipalities : [])
      .find((item) => String(item.name || item.commune || '').trim().toLowerCase() === name.toLowerCase())
    : null;
  const record = byCode || byName || {};
  const city = String(name || record.name || record.commune || '').trim();
  const postalCode = String(commune.postal_code || commune.code_postal || record.postal_code || record.code_postal || '').trim();
  if (postalCode && city) return `${postalCode} (${city})`;
  if (city) return city;
  if (postalCode) return postalCode;
  return 'Commune non identifiée';
}

function zoneImpactResourceCity(resource = {}) {
  const direct = resource.city || resource.commune || resource.municipality || resource.town || resource.locality;
  if (direct) return String(direct).trim();

  const address = String(resource.address || '').trim();
  const postcodeMatch = address.match(/\b38\d{3}\s+([^,;]+)/i);
  if (postcodeMatch?.[1]) return postcodeMatch[1].trim();

  const coords = zoneImpactPointFromItem(resource);
  if (coords && Array.isArray(isereCommunesGeometryCache)) {
    const commune = isereCommunesGeometryCache.find((item) => isPointInsideGeometry(coords, item.geometry));
    if (commune?.code) return zoneImpactMunicipalityNameFromCode(commune.code);
  }
  return '';
}

function zoneImpactResourceDetails(resource = {}) {
  const city = zoneImpactResourceCity(resource);
  const address = String(resource.address || '').trim();
  return [
    city ? `Ville : ${escapeHtml(city)}` : '',
    address ? `Adresse : ${escapeHtml(address)}` : '',
  ].filter(Boolean).join(' · ');
}

function zoneImpactResourceDetailsWithDistance(resource = {}) {
  return [
    zoneImpactResourceDetails(resource),
    Number.isFinite(resource.distanceMeters) ? formatDistanceMeters(resource.distanceMeters) : '',
  ].filter(Boolean).join(' · ');
}

async function computeZoneMunicipalityBreakdown(geometry, municipalitiesInZone = [], inseePopulationMap = new Map()) {
  if (!geometry || typeof window.turf === 'undefined') {
    return municipalitiesInZone.map((municipality) => ({
      code: String(municipality.code_insee || municipality.insee || '').trim(),
      name: municipality.name || municipality.commune || 'Commune',
      displayLabel: zoneImpactMunicipalityPostalLabel(municipality),
      overlapAreaM2: 0,
      overlapKm2: 0,
      estimatedPopulation: 0,
      sharePercent: 0,
    }));
  }

  try {
    const zoneFeature = window.turf.feature(geometry);
    const zoneAreaM2 = Number(window.turf.area(zoneFeature) || 0);
    const communesGeometry = await loadIsereCommunesGeometry();
    const selectedCodes = new Set(
      municipalitiesInZone
        .map((municipality) => String(municipality.code_insee || municipality.insee || '').trim())
        .filter(Boolean),
    );
    const source = selectedCodes.size
      ? communesGeometry.filter((commune) => selectedCodes.has(commune.code))
      : communesGeometry;

    return source
      .map((commune) => {
        try {
          const sourceMunicipality = municipalitiesInZone.find((municipality) => (
            String(municipality.code_insee || municipality.insee || '').trim() === commune.code
          )) || {};
          const communeFeature = window.turf.feature(commune.geometry);
          const overlapFeature = window.turf.intersect(zoneFeature, communeFeature);
          if (!overlapFeature) return null;
          const overlapAreaM2 = Number(window.turf.area(overlapFeature) || 0);
          if (!Number.isFinite(overlapAreaM2) || overlapAreaM2 <= 0) return null;
          const communeAreaM2 = Number(window.turf.area(communeFeature) || 0);
          const basePopulation = Number(inseePopulationMap.get(commune.code) || commune.population || 0);
          const estimatedPopulation = communeAreaM2 > 0 && basePopulation > 0
            ? Math.round(basePopulation * Math.min(1, overlapAreaM2 / communeAreaM2))
            : 0;
          return {
            code: commune.code,
            name: sourceMunicipality.name || sourceMunicipality.commune || zoneImpactMunicipalityNameFromCode(commune.code),
            displayLabel: zoneImpactMunicipalityPostalLabel({ ...sourceMunicipality, code: commune.code }),
            overlapAreaM2,
            overlapKm2: overlapAreaM2 / 1_000_000,
            estimatedPopulation,
            sharePercent: zoneAreaM2 > 0 ? (overlapAreaM2 / zoneAreaM2) * 100 : 0,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.overlapAreaM2 - a.overlapAreaM2);
  } catch {
    return [];
  }
}

async function computeZoneImpact() {
  const runSeq = ++mapZoneImpactComputationSeq;
  const geometry = selectedZoneGeometry();
  if (!geometry) {
    renderZoneImpactPanel();
    return;
  }

  renderZoneImpactPanel('<li>⏳ Analyse en cours…</li>');

  // ─── Chargements parallèles ────────────────────────────────────────────────
  const [inseePopulationMap, zonePopulationMetrics, streetInsights, geoCtx, rnbPayload] = await Promise.all([
    loadIserePopulationByInsee(),
    (async () => {
      const muns = zoneImpactDepartmentCommunesInZone(geometry);
      return estimatePopulationInZoneByArea(geometry, muns, await loadIserePopulationByInsee());
    })(),
    fetchZoneStreetInsights(geometry),
    fetchZoneGeographicContext(geometry),
    fetchZoneRnbBuildings(geometry).catch(() => ({ buildings: [], buildings_total: 0 })),
  ]);
  if (runSeq !== mapZoneImpactComputationSeq) return;

  const municipalitiesInZone = zoneImpactDepartmentCommunesInZone(geometry);
  const municipalityBreakdown = await computeZoneMunicipalityBreakdown(geometry, municipalitiesInZone, inseePopulationMap);
  if (runSeq !== mapZoneImpactComputationSeq) return;
  const resources = getResourcesForZoneImpact();
  const resourcesInZone = resources.filter((r) => {
    const c = normalizeMapCoordinates(r.lat, r.lon);
    return c ? isPointInsideGeometry(c, geometry) : false;
  });
  const rnbBuildings = (Array.isArray(rnbPayload?.buildings) ? rnbPayload.buildings : []).filter((building) => {
    const c = normalizeMapCoordinates(building.lat, building.lon);
    return c ? isPointInsideGeometry(c, geometry) : false;
  });
  const buildingCount = rnbBuildings.length;

  // ─── Population ───────────────────────────────────────────────────────────
  const areaBasedPop = Number(zonePopulationMetrics.estimatedPopulation || 0);
  const zoneAreaM2 = Number(zonePopulationMetrics.zoneAreaM2 || 0);
  const fallbackPop = municipalitiesInZone.reduce((sum, m) => {
    const code = String(m.code_insee || m.insee || '').trim();
    const p = code ? Number(inseePopulationMap.get(code) || 0) : 0;
    return sum + (p > 0 ? p : Number(m.population || 0));
  }, 0);
  const population = areaBasedPop > 0 ? Math.round(areaBasedPop) : fallbackPop;
  const popSource = areaBasedPop > 0 ? 'pondérée par surface (INSEE + contours communes)' : 'population légale communes intersectées (INSEE)';

  // ─── Échelle géographique ─────────────────────────────────────────────────
  const scale = detectZoneScale(zoneAreaM2);
  let geoLabel = '';
  if (scale === 'rue' && geoCtx.street) {
    geoLabel = `${geoCtx.street}${geoCtx.city ? `, ${geoCtx.city}` : ''}`;
  } else if (scale === 'quartier' && (geoCtx.district || geoCtx.city)) {
    geoLabel = [geoCtx.district, geoCtx.city].filter(Boolean).join(' · ');
  } else if (geoCtx.city) {
    geoLabel = geoCtx.city;
  }
  if (!geoLabel && municipalitiesInZone.length) {
    geoLabel = municipalitiesInZone.map((m) => escapeHtml(m.name || m.commune || '')).filter(Boolean).slice(0, 3).join(', ');
  }
  const scaleIcons = { rue: '🛣️', quartier: '🏘️', ville: '🏙️', secteur: '🗺️' };
  const scaleLabels = { rue: 'Échelle rue', quartier: 'Échelle quartier', ville: 'Échelle ville', secteur: 'Secteur multi-communes' };

  // ─── Catégories de ressources dans la zone ────────────────────────────────
  const schools       = resourcesInZone.filter((r) => SCHOOL_RESOURCE_TYPES.has(r.type));
  const ehpads        = resourcesInZone.filter((r) => r.type === 'ehpad');
  const hospitals     = resourcesInZone.filter((r) => HEALTH_URGENT_CARE_TYPES.has(r.type));
  const fireStations  = resourcesInZone.filter((r) => FIRE_RESOURCE_TYPES.has(r.type));
  const police        = resourcesInZone.filter((r) => SECURITY_RESOURCE_TYPES.has(r.type));
  const hostings      = resourcesInZone.filter((r) => HOSTING_RESOURCE_TYPES.has(r.type));
  const dangers       = resourcesInZone.filter((r) => RISK_RESOURCE_TYPES.has(r.type));
  const transports    = resourcesInZone.filter((r) => TRANSPORT_RESOURCE_TYPES.has(r.type));
  const operationalEventsInZone = zoneImpactOperationalEventsInZone(geometry, municipalitiesInZone);
  const trafficIncidentsInZone = zoneImpactTrafficIncidentsInZone(geometry);
  const customPointsInZone = zoneImpactCustomPointsInZone(geometry);
  const vigicruesStationsInZone = zoneImpactVigicruesStationsInZone(geometry);
  const nearbyFireStations = zoneImpactNearestResources(geometry, resources, FIRE_RESOURCE_TYPES, 3);
  const nearbyHospitals = zoneImpactNearestResources(geometry, resources, HEALTH_URGENT_CARE_TYPES, 3);
  const nearbyHostings = zoneImpactNearestResources(geometry, resources, HOSTING_RESOURCE_TYPES, 3);
  const riskSummary = zoneImpactExternalRiskSummary(municipalitiesInZone);

  // Estimation populations vulnérables (ratios standards)
  const childrenEstimate = schools.length > 0 ? Math.round(population * 0.12) : 0;
  const ehpadResidents   = ehpads.length * 80; // capacité moyenne EHPAD France

  // ─── Rues / quartiers OSM ─────────────────────────────────────────────────
  const allDistricts = Array.from(new Set([
    ...(geoCtx.district ? [geoCtx.district] : []),
    ...streetInsights.districts,
  ])).slice(0, 6);

  // ─── Construction du rapport HTML ─────────────────────────────────────────
  const section = (icon, title, items, emptyMsg = null) => {
    if (!items.length && !emptyMsg) return '';
    const content = items.length
      ? `<ul style="margin:.3em 0 0 1.1em;padding:0">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`
      : `<span class="muted">${emptyMsg}</span>`;
    return `<li style="margin-bottom:.6em"><strong>${icon} ${escapeHtml(title)}</strong><br>${content}</li>`;
  };

  const nameList = (arr, max = 5) => arr.slice(0, max).map((r) => {
    const details = zoneImpactResourceDetails(r);
    return `<em>${_zoneResourceName(r)}</em>${details ? ` <span class="muted">(${details})</span>` : ''}`;
  }).join(', ')
    + (arr.length > max ? ` <span class="muted">+${arr.length - max}</span>` : '');

  const parts = [];
  const kpis = [
    ['Population', population > 0 ? population.toLocaleString('fr-FR') : '?'],
    ['Bâtiments', buildingCount.toLocaleString('fr-FR')],
    ['Ressources', resourcesInZone.length.toLocaleString('fr-FR')],
    ['Événements actifs', operationalEventsInZone.filter((event) => String(event.status || '').toLowerCase() !== 'clos').length.toLocaleString('fr-FR')],
    ['Sites sensibles', (schools.length + ehpads.length + dangers.length).toLocaleString('fr-FR')],
  ];
  parts.push(`<li style="margin-bottom:.7em;display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:.35em">
    ${kpis.map(([label, value]) => `<span style="display:block;padding:.45em;background:#f8faff;border:1px solid #dbe7fb;border-radius:6px"><strong style="display:block;font-size:1rem">${escapeHtml(value)}</strong><span class="muted">${escapeHtml(label)}</span></span>`).join('')}
  </li>`);

  // 1. Identification de la zone
  parts.push(`<li style="margin-bottom:.7em;padding:.5em;background:#f0f4ff;border-radius:6px">
    <strong>${scaleIcons[scale]} ${scaleLabels[scale]}${geoLabel ? ` · ${escapeHtml(geoLabel)}` : ''}</strong><br>
    ${zoneAreaM2 > 0 ? `Surface : <strong>${(zoneAreaM2 / 1_000_000).toFixed(2).replace('.', ',')} km²</strong> · ` : ''}
    ${municipalitiesInZone.length} commune(s) couverte(s)${municipalitiesInZone.length ? ` (${municipalitiesInZone.slice(0, 3).map((m) => escapeHtml(m.name || m.commune || '')).filter(Boolean).join(', ')}${municipalitiesInZone.length > 3 ? '…' : ''})` : ''}
  </li>`);

  if (municipalityBreakdown.length) {
    parts.push(section('📏', 'Surface dessinée par ville', municipalityBreakdown.slice(0, 8).map((row) => (
      `<strong>${escapeHtml(row.displayLabel || row.name || 'Commune non identifiée')}</strong> · ${row.overlapKm2.toLocaleString('fr-FR', { maximumFractionDigits: 3 })} km²`
      + ` · ${row.sharePercent.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}% de la zone`
      + `${row.estimatedPopulation > 0 ? ` · ~${row.estimatedPopulation.toLocaleString('fr-FR')} hab.` : ''}`
    ))));
  }

  // 2. Population
  parts.push(`<li style="margin-bottom:.6em;padding:.4em;background:#fff7e6;border-radius:6px">
    <strong>👥 Population exposée : <span style="font-size:1.2em;color:#c05900">${population > 0 ? population.toLocaleString('fr-FR') : 'inconnue'}</span> habitants</strong><br>
    <span class="muted">${popSource}</span><br>
    ${childrenEstimate > 0 ? `👶 ~${childrenEstimate.toLocaleString('fr-FR')} enfants scolarisés estimés · ` : ''}
    ${ehpadResidents > 0 ? `🧓 ~${ehpadResidents.toLocaleString('fr-FR')} résidents EHPAD (personnes à mobilité réduite)` : ''}
  </li>`);
  parts.push(`<li style="margin-bottom:.6em;padding:.4em;background:#eef7ff;border-radius:6px">
    <strong>🏢 Bâtiments sélectionnés : <span style="font-size:1.15em;color:#0b4daa">${buildingCount.toLocaleString('fr-FR')}</span></strong><br>
    <span class="muted">Calculé à partir du Référentiel National des Bâtiments dans l'emprise tracée.</span>
  </li>`);

  const officialItems = [
    `⛅ Météo-France : <strong style="color:${levelColor(riskSummary.meteoLevel)}">${escapeHtml(riskSummary.meteoLevel)}</strong>`,
    `🌊 Vigicrues : <strong style="color:${levelColor(riskSummary.vigicruesLevel)}">${escapeHtml(riskSummary.vigicruesLevel)}</strong>`,
    `🌧️ APIC pluie intense : <strong>${riskSummary.apicAlerts.toLocaleString('fr-FR')}</strong> avertissement(s)`,
    `⚡ Vigicrues Flash : <strong>${riskSummary.vigicruesFlashAlerts.toLocaleString('fr-FR')}</strong> alerte(s)`,
    `🌫️ Qualité de l'air : <strong>${escapeHtml(String(riskSummary.atmoLabel))}</strong>`,
  ];
  parts.push(section('📡', 'Situation officielle actuelle', officialItems));

  if (riskSummary.communes.length) {
    parts.push(section('🏛️', 'Communes et risques connus', riskSummary.communes.map((commune) => {
      const name = escapeHtml(zoneImpactMunicipalityPostalLabel(commune));
      const floodDocs = Number(commune.flood_documents || commune.nb_documents || 0);
      const movements = Number(commune.ground_movements_total || 0);
      const ppr = Number(commune.ppr_total || commune.pprn_total || 0);
      return `<strong>${name}</strong> · exposition ${escapeHtml(commune.exposureLabel)} · danger ${escapeHtml(commune.dangerLabel)}`
        + `${floodDocs > 0 ? ` · ${floodDocs} doc. inondation` : ''}`
        + `${ppr > 0 ? ` · ${ppr} PPR` : ''}`
        + `${movements > 0 ? ` · ${movements} mouvement(s) terrain` : ''}`;
    })));
  }

  // 3. Dangers dans la zone
  if (dangers.length) {
    parts.push(section('⚠️', `DANGERS DANS LA ZONE (${dangers.length})`, [
      dangers.map((r) => {
        const meta = RESOURCE_TYPE_META[r.type] || {};
        const details = zoneImpactResourceDetails(r);
        return `${meta.icon || '⚠️'} <strong>${_zoneResourceName(r)}</strong>${details ? ` <span class="muted">(${details})</span>` : ''}`;
      }).join('</li><li>'),
    ]));
  }

  // 4. Secours disponibles dans la zone
  const rescueItems = [];
  if (fireStations.length) rescueItems.push(`🚒 <strong>Pompiers (${fireStations.length}) :</strong> ${nameList(fireStations)}`);
  if (police.length) rescueItems.push(`🛡️ <strong>Police/Gendarmerie (${police.length}) :</strong> ${nameList(police)}`);
  if (hospitals.length) rescueItems.push(`🏥 <strong>Hôpitaux/Cliniques (${hospitals.length}) :</strong> ${nameList(hospitals)}`);
  parts.push(section('🚨', `Secours disponibles dans la zone`, rescueItems,
    'Aucun service de secours détecté dans la zone — prévoir projection externe.'));

  // 5. Évacuation : lieux d'accueil
  const hostItems = [];
  if (hostings.length) hostItems.push(`🏟️ <strong>Lieux d'accueil (${hostings.length}) :</strong> ${nameList(hostings, 6)}`);
  if (transports.length) hostItems.push(`🚆 <strong>Nœuds transport (${transports.length}) :</strong> ${nameList(transports)}`);
  parts.push(section('🚌', `Points d'évacuation et d'accueil`, hostItems,
    'Aucun lieu d\'accueil ni nœud transport dans la zone — vérifier les zones adjacentes.'));

  // 6. Populations vulnérables
  const vulnItems = [];
  if (schools.length) {
    const byType = { creche: [], ecole_primaire: [], college: [], lycee: [], universite: [] };
    schools.forEach((r) => { if (byType[r.type]) byType[r.type].push(r); });
    if (byType.creche.length) vulnItems.push(`🍼 Crèches (${byType.creche.length}) : ${nameList(byType.creche)}`);
    if (byType.ecole_primaire.length) vulnItems.push(`🧒 Écoles primaires (${byType.ecole_primaire.length}) : ${nameList(byType.ecole_primaire)}`);
    if (byType.college.length) vulnItems.push(`🎒 Collèges (${byType.college.length}) : ${nameList(byType.college)}`);
    if (byType.lycee.length) vulnItems.push(`📘 Lycées (${byType.lycee.length}) : ${nameList(byType.lycee)}`);
    if (byType.universite.length) vulnItems.push(`🎓 Universités (${byType.universite.length}) : ${nameList(byType.universite)}`);
  }
  if (ehpads.length) vulnItems.push(`🧓 EHPAD (${ehpads.length}) : ${nameList(ehpads)} <span class="muted">(~${ehpadResidents} résidents, évacuation médicalisée requise)</span>`);
  parts.push(section('⚡', `Populations vulnérables à évacuer en priorité`, vulnItems,
    'Aucun établissement scolaire ni EHPAD détecté dans la zone.'));

  // 7. Contexte géographique OSM
  const geoItems = [];
  if (allDistricts.length) geoItems.push(`🏘️ Quartiers : ${allDistricts.map(escapeHtml).join(', ')}`);
  if (streetInsights.streets.length) {
    geoItems.push(`🛣️ Principales rues : ${streetInsights.streets.slice(0, 8).map(escapeHtml).join(', ')}`);
  }
  if (geoItems.length) parts.push(section('🗺️', 'Contexte géographique (OpenStreetMap)', geoItems));

  const eventItems = operationalEventsInZone.map((event) => {
    const status = EVENT_STATUS_LABEL[String(event.status || '').toLowerCase()] || event.status || 'Statut inconnu';
    const locality = event.municipality_id ? getMunicipalityName(event.municipality_id) : (event.location || event.address || '');
    const logsText = event.logs.length ? ` · ${event.logs.length} MCO (${event.activeLogCount} actif(s))` : '';
    return `<strong>${escapeHtml(event.title || event.name || `Événement #${event.id || '?'}`)}</strong> · ${escapeHtml(status)} · <span style="color:${levelColor(event.worstLevel)}">${escapeHtml(event.worstLevel)}</span>${locality ? ` · ${escapeHtml(locality)}` : ''}${logsText}`;
  });
  parts.push(section('📍', 'Événements opérationnels dans la zone', eventItems,
    'Aucun événement opérationnel géolocalisé ou rattaché aux communes de la zone.'));

  const hydroItems = vigicruesStationsInZone.map((station) => {
    const level = station.statusLevel || stationStatusLevel(station);
    const height = station.height_m || station.height || station.last_height_m;
    return `<strong>${escapeHtml(station.station || station.name || station.code || 'Station')}</strong> · ${escapeHtml(station.river || station.troncon || '')} · <span style="color:${levelColor(level)}">${escapeHtml(level)}</span>${height ? ` · ${escapeHtml(height)} m` : ''}`;
  });
  parts.push(section('🌊', 'Hydrologie locale', hydroItems,
    'Aucune station Vigicrues dans l’emprise exacte. Vérifier aussi les stations en aval/amont sur la carte.'));

  const trafficItems = trafficIncidentsInZone.map((event) => {
    const road = event.road || (Array.isArray(event.roads) ? event.roads.join(', ') : '');
    const severity = event.severity || event.category || 'incident trafic';
    return `<strong>${escapeHtml(event.title || event.description || 'Incident trafic')}</strong>${road ? ` · ${escapeHtml(road)}` : ''} · ${escapeHtml(severity)}`;
  });
  if (trafficItems.length) parts.push(section('🚧', 'Trafic impactant la zone', trafficItems));

  const nearbyItems = [];
  if (nearbyFireStations.length) nearbyItems.push(`🚒 Pompiers proches : ${nearbyFireStations.map((r) => `${_zoneResourceName(r)} <span class="muted">(${zoneImpactResourceDetailsWithDistance(r)})</span>`).join(', ')}`);
  if (nearbyHospitals.length) nearbyItems.push(`🏥 Soins proches : ${nearbyHospitals.map((r) => `${_zoneResourceName(r)} <span class="muted">(${zoneImpactResourceDetailsWithDistance(r)})</span>`).join(', ')}`);
  if (nearbyHostings.length) nearbyItems.push(`🏟️ Accueil proche : ${nearbyHostings.map((r) => `${_zoneResourceName(r)} <span class="muted">(${zoneImpactResourceDetailsWithDistance(r)})</span>`).join(', ')}`);
  parts.push(section('🧭', 'Ressources proches hors zone', nearbyItems,
    'Aucune ressource proche calculable depuis les données chargées.'));

  const customPointItems = customPointsInZone.map((point) => {
    const category = point.category ? ` · ${escapeHtml(point.category)}` : '';
    const notes = point.notes ? ` · <span class="muted">${escapeHtml(point.notes)}</span>` : '';
    return `<strong>${escapeHtml(point.name || 'Point terrain')}</strong>${category}${notes}`;
  });
  if (customPointItems.length) parts.push(section('📌', 'Points terrain personnalisés', customPointItems));

  // Stocker les données brutes pour l'export
  mapZoneImpactReportData = {
    generatedAt: new Date(),
    scale, geoLabel, geoCtx, zoneAreaM2, population, popSource,
    buildingCount,
    childrenEstimate, ehpadResidents,
    municipalitiesInZone, municipalityBreakdown, resourcesInZone,
    rnbBuildings,
    schools, ehpads, hospitals, fireStations, police, hostings, dangers, transports,
    allDistricts, streetInsights,
    operationalEventsInZone, trafficIncidentsInZone, customPointsInZone, vigicruesStationsInZone,
    nearbyFireStations, nearbyHospitals, nearbyHostings, riskSummary,
  };

  const actionBar = `<div style="display:flex;gap:.5em;margin-top:.7em;flex-wrap:wrap">
    <button id="zone-impact-export-btn" type="button" class="map-btn-lite" style="background:#1971c2;color:#fff;border:none;padding:.4em .9em;border-radius:6px;cursor:pointer;font-size:.82rem">📄 Exporter le rapport</button>
    <button id="zone-impact-clear-btn" type="button" class="ghost map-btn-lite" style="padding:.4em .9em;border-radius:6px;font-size:.82rem">🗑️ Effacer la zone</button>
  </div>`;

  renderZoneImpactPanel(`<ul style="list-style:none;padding:0;margin:0">${parts.join('')}</ul>${actionBar}`);

  document.getElementById('zone-impact-export-btn')?.addEventListener('click', exportZoneImpactReport);
  document.getElementById('zone-impact-clear-btn')?.addEventListener('click', clearZoneImpactSelection);

  // Feature 6 — Heatmap population dans la zone
  renderPopulationHeatmap(municipalitiesInZone);
}

function exportZoneImpactReport() {
  const d = mapZoneImpactReportData;
  if (!d) return;

  const scaleIcons = { rue: '🛣️', quartier: '🏘️', ville: '🏙️', secteur: '🗺️' };
  const scaleLabels = { rue: 'Échelle rue', quartier: 'Échelle quartier', ville: 'Échelle ville', secteur: 'Secteur multi-communes' };
  const now = d.generatedAt;
  const dateStr = now.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  const toText = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const priorityText = (p) => ({ critical: 'CRITIQUE', vital: 'VITAL', risk: 'À RISQUE', standard: 'Standard' }[p] || 'Standard');
  const resourceTable = (title, icon, arr) => {
    if (!arr.length) return `<p class="empty">${icon} <em>Aucun(e) détecté(e) dans la zone.</em></p>`;
    return `<h3>${icon} ${toText(title)} (${arr.length})</h3>
    <table>
      <thead><tr><th>Nom</th><th>Ville</th><th>Adresse</th><th>Priorité</th></tr></thead>
      <tbody>${arr.map((r) => `<tr>
        <td>${toText(r.name || 'Sans nom')}</td>
        <td>${toText(zoneImpactResourceCity(r) || '–')}</td>
        <td>${toText(r.address || '–')}</td>
        <td class="tag-${r.priority || 'standard'}">${priorityText(r.priority)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  };
  const simpleTable = (title, icon, rows, columns) => {
    if (!rows.length) return `<p class="empty">${icon} <em>Aucun élément détecté.</em></p>`;
    return `<h3>${icon} ${toText(title)} (${rows.length})</h3>
    <table>
      <thead><tr>${columns.map((col) => `<th>${toText(col.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${columns.map((col) => `<td>${toText(col.value(row) || '–')}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  };
  const riskSummary = d.riskSummary || {};
  const officialRows = [
    { source: 'Météo-France', value: riskSummary.meteoLevel || 'vert', detail: 'Vigilance départementale' },
    { source: 'Vigicrues', value: riskSummary.vigicruesLevel || 'vert', detail: 'Niveau eau départemental' },
    { source: 'APIC pluie intense', value: `${Number(riskSummary.apicAlerts || 0).toLocaleString('fr-FR')} avertissement(s)`, detail: 'Météo-France APIC' },
    { source: 'Vigicrues Flash', value: `${Number(riskSummary.vigicruesFlashAlerts || 0).toLocaleString('fr-FR')} alerte(s)`, detail: 'Crues rapides' },
    { source: "Qualité de l'air", value: riskSummary.atmoLabel || 'non disponible', detail: 'Atmo Auvergne-Rhône-Alpes' },
  ];

  const schoolsByType = { creche: [], ecole_primaire: [], college: [], lycee: [], universite: [] };
  d.schools.forEach((r) => { if (schoolsByType[r.type]) schoolsByType[r.type].push(r); });

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Rapport d'impact terrain – ${toText(d.geoLabel || 'Zone analysée')}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 11pt; color: #1a1a2e; background: #fff; padding: 2cm; }
  h1 { font-size: 18pt; color: #132f63; margin-bottom: .3em; }
  h2 { font-size: 13pt; color: #1971c2; margin: 1.4em 0 .4em; border-bottom: 2px solid #d3e0f8; padding-bottom: .2em; }
  h3 { font-size: 11pt; color: #333; margin: 1em 0 .3em; }
  .meta { font-size: 9.5pt; color: #555; margin-bottom: 1.2em; }
  .badge-zone { display: inline-block; background: #eef2ff; border: 1px solid #c7d7fa; border-radius: 6px; padding: .2em .7em; font-size: 10pt; font-weight: bold; margin-bottom: .5em; }
  .pop-block { background: #fff7e6; border-left: 4px solid #f08c00; padding: .5em .8em; margin: .5em 0 1em; border-radius: 0 6px 6px 0; }
  .pop-block .pop-num { font-size: 22pt; font-weight: bold; color: #c05900; }
  .danger-block { background: #fff0f0; border-left: 4px solid #e03131; padding: .5em .8em; margin: .5em 0 1em; border-radius: 0 6px 6px 0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: .8em; font-size: 10pt; }
  thead { background: #eef2ff; }
  th { text-align: left; padding: .35em .5em; font-weight: bold; border: 1px solid #d3e0f8; }
  td { padding: .3em .5em; border: 1px solid #e8eef8; vertical-align: top; }
  tr:nth-child(even) td { background: #f8faff; }
  .empty { color: #888; font-style: italic; font-size: 10pt; margin: .2em 0 .8em; }
  .tag-critical { color: #e03131; font-weight: bold; }
  .tag-vital { color: #1971c2; font-weight: bold; }
  .tag-risk { color: #f08c00; font-weight: bold; }
  .footer { margin-top: 2em; font-size: 8.5pt; color: #888; border-top: 1px solid #ddd; padding-top: .5em; }
  .communes-list { font-size: 10pt; color: #444; }
  @media print {
    body { padding: 1.2cm; }
    h2 { page-break-after: avoid; }
    table { page-break-inside: avoid; }
  }
</style>
</head>
<body>

<div class="badge-zone">${scaleIcons[d.scale] || '🗺️'} ${scaleLabels[d.scale] || 'Zone'}${d.geoLabel ? ` · ${toText(d.geoLabel)}` : ''}</div>
<h1>Rapport d'impact terrain</h1>
<p class="meta">
  Généré le <strong>${dateStr}</strong> à <strong>${timeStr}</strong> · Département de l'Isère (38)<br>
  OPE-Protec · Préfecture de l'Isère · Usage opérationnel réservé aux services habilités
</p>

<h2>1. Identification de la zone</h2>
<table>
  <tbody>
    <tr><th style="width:35%">Échelle détectée</th><td>${scaleIcons[d.scale]} ${scaleLabels[d.scale]}${d.geoLabel ? ` — ${toText(d.geoLabel)}` : ''}</td></tr>
    ${d.zoneAreaM2 > 0 ? `<tr><th>Surface</th><td><strong>${(d.zoneAreaM2 / 1_000_000).toFixed(2).replace('.', ',')} km²</strong> (${Math.round(d.zoneAreaM2).toLocaleString('fr-FR')} m²)</td></tr>` : ''}
    <tr><th>Communes intersectées</th><td class="communes-list">${d.municipalitiesInZone.map((m) => toText(zoneImpactMunicipalityPostalLabel(m))).filter(Boolean).join(', ') || 'Non déterminées'}</td></tr>
    ${d.geoCtx.city ? `<tr><th>Ville / commune centre</th><td>${toText(d.geoCtx.city)}${d.geoCtx.postcode ? ` (${toText(d.geoCtx.postcode)})` : ''}</td></tr>` : ''}
    ${d.geoCtx.district ? `<tr><th>Quartier</th><td>${toText(d.geoCtx.district)}</td></tr>` : ''}
    ${d.geoCtx.street ? `<tr><th>Rue / voie</th><td>${toText(d.geoCtx.street)}</td></tr>` : ''}
    ${d.allDistricts.length ? `<tr><th>Quartiers OSM</th><td>${d.allDistricts.map(toText).join(', ')}</td></tr>` : ''}
    ${d.streetInsights.streets.length ? `<tr><th>Principales rues</th><td>${d.streetInsights.streets.slice(0, 10).map(toText).join(', ')}</td></tr>` : ''}
  </tbody>
</table>

${simpleTable('Surface dessinée par ville', '📏', d.municipalityBreakdown || [], [
  { label: 'Code postal (ville)', value: (row) => row.displayLabel || row.name },
  { label: 'Surface concernée', value: (row) => `${Number(row.overlapKm2 || 0).toLocaleString('fr-FR', { maximumFractionDigits: 3 })} km²` },
  { label: 'Part de la zone', value: (row) => `${Number(row.sharePercent || 0).toLocaleString('fr-FR', { maximumFractionDigits: 1 })}%` },
  { label: 'Population estimée', value: (row) => row.estimatedPopulation > 0 ? `~${Number(row.estimatedPopulation).toLocaleString('fr-FR')} hab.` : '–' },
])}

<h2>2. Population exposée</h2>
<div class="pop-block">
  <div class="pop-num">${d.population > 0 ? d.population.toLocaleString('fr-FR') : '?'} habitants</div>
  <div style="font-size:9.5pt;color:#666;margin-top:.2em">${toText(d.popSource)}</div>
  <div style="margin-top:.4em">🏢 Bâtiments RNB dans la zone : <strong>${Number(d.buildingCount || 0).toLocaleString('fr-FR')}</strong></div>
  ${d.childrenEstimate > 0 ? `<div style="margin-top:.4em">👶 Enfants scolarisés estimés : <strong>~${d.childrenEstimate.toLocaleString('fr-FR')}</strong></div>` : ''}
  ${d.ehpadResidents > 0 ? `<div>🧓 Résidents EHPAD (mobilité réduite) : <strong>~${d.ehpadResidents.toLocaleString('fr-FR')}</strong></div>` : ''}
</div>

<h2>3. Situation opérationnelle actuelle</h2>
${simpleTable('Niveaux officiels et signaux externes', '📡', officialRows, [
  { label: 'Source', value: (row) => row.source },
  { label: 'Valeur', value: (row) => row.value },
  { label: 'Détail', value: (row) => row.detail },
])}

${simpleTable('Communes et risques connus', '🏛️', Array.isArray(riskSummary.communes) ? riskSummary.communes : [], [
  { label: 'Code postal (ville)', value: (row) => zoneImpactMunicipalityPostalLabel(row) },
  { label: 'Exposition', value: (row) => row.exposureLabel },
  { label: 'Danger', value: (row) => row.dangerLabel },
  { label: 'Données clés', value: (row) => [
    Number(row.flood_documents || row.nb_documents || 0) ? `${Number(row.flood_documents || row.nb_documents || 0)} doc. inondation` : '',
    Number(row.ppr_total || row.pprn_total || 0) ? `${Number(row.ppr_total || row.pprn_total || 0)} PPR` : '',
    Number(row.ground_movements_total || 0) ? `${Number(row.ground_movements_total || 0)} mouvements terrain` : '',
  ].filter(Boolean).join(' · ') },
])}

${simpleTable('Événements et MCO dans la zone', '📍', d.operationalEventsInZone || [], [
  { label: 'Événement', value: (row) => row.title || row.name || `#${row.id || ''}` },
  { label: 'Statut', value: (row) => EVENT_STATUS_LABEL[String(row.status || '').toLowerCase()] || row.status },
  { label: 'Niveau', value: (row) => row.worstLevel },
  { label: 'MCO', value: (row) => `${(row.logs || []).length} fiche(s), ${row.activeLogCount || 0} active(s)` },
])}

${simpleTable('Hydrologie locale', '🌊', d.vigicruesStationsInZone || [], [
  { label: 'Station', value: (row) => row.station || row.name || row.code },
  { label: 'Cours d’eau', value: (row) => row.river || row.troncon },
  { label: 'Niveau', value: (row) => row.statusLevel || stationStatusLevel(row) },
  { label: 'Hauteur', value: (row) => row.height_m || row.height || row.last_height_m },
])}

${(d.trafficIncidentsInZone || []).length ? simpleTable('Trafic impactant la zone', '🚧', d.trafficIncidentsInZone || [], [
  { label: 'Incident', value: (row) => row.title || row.description },
  { label: 'Axe', value: (row) => row.road || (Array.isArray(row.roads) ? row.roads.join(', ') : '') },
  { label: 'Type', value: (row) => row.category || row.severity || row.type },
]) : ''}

<h2>4. Dangers dans la zone</h2>
${d.dangers.length ? `<div class="danger-block">
  <strong>⚠️ ${d.dangers.length} site(s) dangereux détecté(s) — plan d'évacuation à adapter</strong>
</div>
<table>
  <thead><tr><th>Nom</th><th>Type</th><th>Ville</th><th>Adresse</th></tr></thead>
  <tbody>${d.dangers.map((r) => `<tr>
    <td>${toText(r.name || 'Sans nom')}</td>
    <td>${toText((RESOURCE_TYPE_META[r.type] || {}).label || r.type)}</td>
    <td>${toText(zoneImpactResourceCity(r) || '–')}</td>
    <td>${toText(r.address || '–')}</td>
  </tr>`).join('')}</tbody>
</table>` : '<p class="empty">⚠️ Aucun site dangereux détecté dans la zone.</p>'}

<h2>5. Secours disponibles dans la zone</h2>
${resourceTable('Casernes de pompiers', '🚒', d.fireStations)}
${resourceTable('Police / Gendarmerie', '🛡️', d.police)}
${resourceTable('Hôpitaux et cliniques', '🏥', d.hospitals)}

<h2>6. Points d'évacuation et d'accueil</h2>
${resourceTable("Lieux d'accueil hébergeables", '🏟️', d.hostings)}
${resourceTable('Nœuds de transport', '🚆', d.transports)}

<h2>7. Ressources proches hors zone</h2>
${simpleTable('Pompiers proches', '🚒', d.nearbyFireStations || [], [
  { label: 'Nom', value: (row) => row.name },
  { label: 'Ville', value: (row) => zoneImpactResourceCity(row) },
  { label: 'Adresse', value: (row) => row.address },
  { label: 'Distance depuis la zone', value: (row) => formatDistanceMeters(row.distanceMeters) },
])}
${simpleTable('Soins proches', '🏥', d.nearbyHospitals || [], [
  { label: 'Nom', value: (row) => row.name },
  { label: 'Ville', value: (row) => zoneImpactResourceCity(row) },
  { label: 'Adresse', value: (row) => row.address },
  { label: 'Distance depuis la zone', value: (row) => formatDistanceMeters(row.distanceMeters) },
])}
${simpleTable('Accueil proche', '🏟️', d.nearbyHostings || [], [
  { label: 'Nom', value: (row) => row.name },
  { label: 'Ville', value: (row) => zoneImpactResourceCity(row) },
  { label: 'Adresse', value: (row) => row.address },
  { label: 'Distance depuis la zone', value: (row) => formatDistanceMeters(row.distanceMeters) },
])}

<h2>8. Populations vulnérables — évacuation prioritaire</h2>
${schoolsByType.creche.length ? resourceTable('Crèches', '🍼', schoolsByType.creche) : ''}
${schoolsByType.ecole_primaire.length ? resourceTable('Écoles primaires', '🧒', schoolsByType.ecole_primaire) : ''}
${schoolsByType.college.length ? resourceTable('Collèges', '🎒', schoolsByType.college) : ''}
${schoolsByType.lycee.length ? resourceTable('Lycées', '📘', schoolsByType.lycee) : ''}
${schoolsByType.universite.length ? resourceTable('Universités', '🎓', schoolsByType.universite) : ''}
${d.ehpads.length ? resourceTable('EHPAD (évacuation médicalisée requise)', '🧓', d.ehpads) : ''}
${!d.schools.length && !d.ehpads.length ? '<p class="empty">Aucun établissement scolaire ni EHPAD détecté dans la zone.</p>' : ''}

<h2>9. Points terrain personnalisés</h2>
${simpleTable('Points ajoutés sur la carte', '📌', d.customPointsInZone || [], [
  { label: 'Nom', value: (row) => row.name },
  { label: 'Catégorie', value: (row) => row.category },
  { label: 'Notes', value: (row) => row.notes },
])}

<div class="footer">
  Rapport généré automatiquement par OPE-Protec · Sources : INSEE, RNB, geo.api.gouv.fr, FINESS data.gouv.fr, OpenStreetMap, Géorisques, Météo-France, Vigicrues, Atmo AURA<br>
  Les données de population sont des estimations — se référer aux données communales officielles pour les décisions définitives.<br>
  Document à usage opérationnel interne · ${dateStr} ${timeStr}
</div>

</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) { setMapFeedback('Veuillez autoriser les popups pour exporter le rapport.', true); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
  // Lancer l'impression automatiquement après chargement
  win.addEventListener('load', () => win.print());
}

async function loadIsereCommunesGeometry() {
  if (isereCommunesGeometryLoaded) return isereCommunesGeometryCache;
  try {
    const response = await queueApiRequest(() => fetchWithTimeout('https://geo.api.gouv.fr/departements/38/communes?fields=code,population,contour&format=geojson&geometry=contour'));
    const payload = await parseJsonResponse(response, 'geo-api-communes-contours');
    const features = Array.isArray(payload?.features) ? payload.features : [];
    isereCommunesGeometryCache = features
      .map((feature) => {
        const code = String(feature?.properties?.code || '').trim();
        const population = Number(feature?.properties?.population || 0);
        const geometry = feature?.geometry || null;
        if (!code || !geometry || !Number.isFinite(population) || population < 0) return null;
        return { code, population, geometry };
      })
      .filter(Boolean);
  } catch {
    isereCommunesGeometryCache = [];
  }
  isereCommunesGeometryLoaded = true;
  return isereCommunesGeometryCache;
}

async function estimatePopulationInZoneByArea(geometry, municipalitiesInZone = [], inseePopulationMap = new Map()) {
  if (!geometry || typeof window.turf === 'undefined') {
    return { zoneAreaM2: 0, estimatedPopulation: 0 };
  }

  try {
    const zoneFeature = window.turf.feature(geometry);
    const zoneAreaM2 = Number(window.turf.area(zoneFeature) || 0);
    if (!Number.isFinite(zoneAreaM2) || zoneAreaM2 <= 0) return { zoneAreaM2: 0, estimatedPopulation: 0 };

    const communesGeometry = await loadIsereCommunesGeometry();
    const targetedInsee = new Set(
      municipalitiesInZone
        .map((municipality) => String(municipality.code_insee || municipality.insee || '').trim())
        .filter(Boolean),
    );
    const source = targetedInsee.size
      ? communesGeometry.filter((commune) => targetedInsee.has(commune.code))
      : communesGeometry;

    const estimatedPopulation = source.reduce((sum, commune) => {
      try {
        const communeFeature = window.turf.feature(commune.geometry);
        const communeArea = Number(window.turf.area(communeFeature) || 0);
        if (!Number.isFinite(communeArea) || communeArea <= 0) return sum;
        const overlapFeature = window.turf.intersect(zoneFeature, communeFeature);
        if (!overlapFeature) return sum;
        const overlapArea = Number(window.turf.area(overlapFeature) || 0);
        if (!Number.isFinite(overlapArea) || overlapArea <= 0) return sum;
        const overlapRatio = Math.min(1, Math.max(0, overlapArea / communeArea));
        const inseePopulation = Number(inseePopulationMap.get(commune.code) || 0);
        const basePopulation = Number.isFinite(inseePopulation) && inseePopulation > 0 ? inseePopulation : Number(commune.population || 0);
        if (!Number.isFinite(basePopulation) || basePopulation <= 0) return sum;
        return sum + (basePopulation * overlapRatio);
      } catch {
        return sum;
      }
    }, 0);

    return {
      zoneAreaM2,
      estimatedPopulation: Number.isFinite(estimatedPopulation) ? estimatedPopulation : 0,
    };
  } catch {
    return { zoneAreaM2: 0, estimatedPopulation: 0 };
  }
}

async function loadIserePopulationByInsee() {
  if (iserePopulationByInseeLoaded) return iserePopulationByInseeCache;
  try {
    const response = await queueApiRequest(() => fetchWithTimeout('https://geo.api.gouv.fr/departements/38/communes?fields=code,population&format=json'));
    const payload = await parseJsonResponse(response, 'geo-api-population-insee');
    const rows = Array.isArray(payload) ? payload : [];
    iserePopulationByInseeCache = new Map(
      rows
        .map((row) => [String(row?.code || '').trim(), Number(row?.population || 0)])
        .filter(([code, population]) => code && Number.isFinite(population) && population >= 0),
    );
  } catch {
    iserePopulationByInseeCache = new Map();
  }
  iserePopulationByInseeLoaded = true;
  return iserePopulationByInseeCache;
}

function renderPopulationHeatmap(communes = []) {
  if (!leafletMap || typeof window.L === 'undefined') return;
  if (populationHeatLayer) { leafletMap.removeLayer(populationHeatLayer); populationHeatLayer = null; }
  if (!communes.length) return;
  // Leaflet.heat doit être chargé; si absent on tombe en mode fallback cercles
  const heatPoints = communes
    .map((c) => {
      const pt = zoneImpactMunicipalityPoint(c);
      const pop = Number(c.population || c.pop || c.total_population || 0);
      if (!pt || !pop) return null;
      return [pt.lat, pt.lon, Math.min(1, pop / 15000)];
    })
    .filter(Boolean);
  if (!heatPoints.length) return;
  if (typeof window.L.heatLayer === 'function') {
    populationHeatLayer = window.L.heatLayer(heatPoints, { radius: 35, blur: 20, maxZoom: 13, minOpacity: 0.3, gradient: { 0.2: '#4dabf7', 0.5: '#ffd43b', 0.8: '#ff6b6b', 1.0: '#c92a2a' } });
    populationHeatLayer.addTo(leafletMap);
  } else {
    // Fallback : cercles proportionnels si plugin absent
    populationHeatLayer = window.L.layerGroup();
    heatPoints.forEach(([lat, lon, intensity]) => {
      window.L.circleMarker([lat, lon], { radius: 5 + intensity * 20, color: '#e03131', fillColor: '#ff6b6b', fillOpacity: 0.35 + intensity * 0.3, weight: 1 }).addTo(populationHeatLayer);
    });
    populationHeatLayer.addTo(leafletMap);
  }
}

function clearZoneImpactSelection() {
  if (populationHeatLayer) { leafletMap?.removeLayer(populationHeatLayer); populationHeatLayer = null; }
  if (mapZoneImpactLayer) mapZoneImpactLayer.clearLayers();
  mapZoneImpactSelection = null;
  if (mapZoneImpactDrawHandler?.disable) mapZoneImpactDrawHandler.disable();
  setMapFeedback('Analyse de zone effacée.');
  renderZoneImpactPanel();
}

function startZoneImpactSelection() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  if (mapZoneImpactDrawHandler?.enable) mapZoneImpactDrawHandler.enable();
  renderZoneImpactPanel('<li>Tracez une zone sur la carte pour ouvrir l&rsquo;analyse terrain.</li>');
  setMapFeedback("Tracez un rectangle ou un polygone pour analyser l'impact terrain.");
}

function applyBasemap(style = 'osm') {
  if (!leafletMap || typeof window.L === 'undefined') return;
  if (mapTileLayer) leafletMap.removeLayer(mapTileLayer);
  if (mapFloodOverlayLayer) {
    leafletMap.removeLayer(mapFloodOverlayLayer);
    mapFloodOverlayLayer = null;
  }

  const layers = {
    osm: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 20, attribution: '&copy; OpenStreetMap contributors' },
    },
    topo: {
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 19, attribution: '&copy; OpenTopoMap contributors' },
    },
    satellite: {
      url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',
      options: { maxZoom: 20, attribution: '© IGN Géoportail — Orthophotographies', tileSize: 256 },
    },
    light: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      options: { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' },
    },
    population: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      options: { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors &copy; CARTO · INSEE (population légale)' },
    },
    ign: {
      url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
      options: { maxZoom: 19, attribution: '&copy; IGN/Geoportail France' },
    },
  };

  const selected = layers[style] || layers.osm;
  mapTileLayer = window.L.tileLayer(selected.url, selected.options).addTo(leafletMap);
  if (selected.floodOverlay) {
    mapFloodOverlayLayer = window.L.tileLayer.wms(selected.floodOverlay.url, selected.floodOverlay.options).addTo(leafletMap);
  }
  applyGoogleTrafficFlowOverlay();
}

function applyGoogleTrafficFlowOverlay() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  const enabled = document.getElementById('filter-google-traffic-flow')?.checked ?? false;
  if (!enabled) {
    if (googleTrafficFlowLayer) {
      leafletMap.removeLayer(googleTrafficFlowLayer);
      googleTrafficFlowLayer = null;
    }
    return;
  }

  if (!googleTrafficFlowLayer) {
    googleTrafficFlowLayer = window.L.tileLayer('https://mt1.google.com/vt?lyrs=h,traffic&x={x}&y={y}&z={z}', {
      maxZoom: 20,
      opacity: 0.85,
      attribution: 'Flux trafic (lignes colorées) style Google Maps',
    });
  }

  if (!leafletMap.hasLayer(googleTrafficFlowLayer)) googleTrafficFlowLayer.addTo(leafletMap);
}

function applyFloodZoneLayer() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  const enabled = document.getElementById('filter-flood-zones')?.checked ?? false;
  if (!enabled) {
    if (floodZoneWmsLayer) {
      leafletMap.removeLayer(floodZoneWmsLayer);
      floodZoneWmsLayer = null;
    }
    return;
  }
  if (floodZoneWmsLayer) {
    if (typeof floodZoneWmsLayer.bringToFront === 'function') {
      floodZoneWmsLayer.bringToFront();
    } else if (typeof floodZoneWmsLayer.eachLayer === 'function') {
      floodZoneWmsLayer.eachLayer((layer) => layer?.bringToFront?.());
    }
    return;
  }
  // Créer un pane dédié au-dessus des markers (overlayPane = 400) mais sous les popups (700)
  if (!leafletMap.getPane('floodZonePane')) {
    const pane = leafletMap.createPane('floodZonePane');
    pane.style.zIndex = 450;
    pane.style.pointerEvents = 'none';
  }

  const pprLayer = window.L.tileLayer.wms(GEORISQUES_WMS_URL, {
    layers: GEORISQUES_FLOOD_PPRI_LAYER,
    styles: '',
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    opacity: 0.78,
    pane: 'floodZonePane',
    attribution: '&copy; État / Géorisques — Zonage réglementaire PPR inondation',
  });

  const triLayer = window.L.tileLayer.wms(GEORISQUES_WMS_URL, {
    layers: GEORISQUES_FLOOD_TRI_LAYERS,
    styles: '',
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    opacity: 0.34,
    pane: 'floodZonePane',
    attribution: '&copy; État / Géorisques — Surfaces inondables TRI rapportage 2020',
  });

  [pprLayer, triLayer].forEach((layer) => {
    layer.on('tileerror', () => {
      setMapFeedback("Impossible de charger le zonage inondation détaillé. Le service WMS Géorisques ne répond pas correctement.");
    });
  });
  pprLayer.on('load', () => {
    setMapFeedback('Zonage inondation détaillé affiché: PPR réglementaire + surfaces TRI.');
  });

  floodZoneWmsLayer = window.L.layerGroup([triLayer, pprLayer]);
  floodZoneWmsLayer.addTo(leafletMap);
}

function applyAvalancheZoneLayer() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  const enabled = document.getElementById('filter-avalanche-zones')?.checked ?? false;
  if (!enabled) {
    if (avalancheZoneWmsLayer) {
      if (leafletMap.hasLayer(avalancheZoneWmsLayer)) leafletMap.removeLayer(avalancheZoneWmsLayer);
      avalancheZoneWmsLayer = null;
    }
    return;
  }
  if (!avalancheZoneWmsLayer) avalancheZoneWmsLayer = window.L.layerGroup().addTo(leafletMap);
  if (!leafletMap.hasLayer(avalancheZoneWmsLayer)) avalancheZoneWmsLayer.addTo(leafletMap);
  avalancheZoneWmsLayer.clearLayers();

  const avalanche = cachedExternalRisksSnapshot?.avalanche_isere || {};
  const massifs = Array.isArray(avalanche.massifs) ? avalanche.massifs : [];
  const massifByName = new Map(massifs.map((massif) => [String(massif.nom || massif.massif || '').trim().toLowerCase(), massif]));
  const colorByLevel = { 1: '#2b8a3e', 2: '#e9a800', 3: '#e67700', 4: '#c92a2a', 5: '#6741d9' };
  const labelByLevel = { 1: 'Faible', 2: 'Limité', 3: 'Marqué', 4: 'Fort', 5: 'Très fort' };

  AVALANCHE_MASSIF_ZONES.forEach((zone) => {
    const massif = massifByName.get(String(zone.nom || '').trim().toLowerCase()) || {};
    const level = Number(massif.niveau_bra || 0);
    const color = colorByLevel[level] || '#868e96';
    const label = labelByLevel[level] || 'Indisponible';
    const secteurs = Array.isArray(massif.secteurs) ? massif.secteurs : [];
    const dateLabel = massif.date_echeance || massif.date_bulletin || '';
    const commentaire = String(massif.commentaire || '').trim();
    const circle = window.L.circle([zone.lat, zone.lon], {
      radius: zone.radiusKm * 1000,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: level ? 0.18 : 0.08,
    });
    circle.bindPopup(`
      <strong>🏔️ ${escapeHtml(zone.nom)}</strong><br>
      Niveau actuel : <strong style="color:${color}">${level ? `${level}/5 — ${escapeHtml(label)}` : 'Indisponible'}</strong><br>
      ${dateLabel ? `<span class="muted">Échéance : ${escapeHtml(dateLabel)}</span><br>` : ''}
      ${commentaire ? `${escapeHtml(commentaire)}<br>` : ''}
      ${secteurs.length ? `<span class="muted">Secteurs : ${escapeHtml(secteurs.join(', '))}</span>` : ''}
    `);
    circle.addTo(avalancheZoneWmsLayer);

    window.L.marker([zone.lat, zone.lon], {
      icon: window.L.divIcon({
        className: '',
        html: `<div style="background:${color};color:#fff;padding:2px 6px;border-radius:999px;font-size:11px;font-weight:700;border:1px solid rgba(255,255,255,.9);box-shadow:0 1px 4px rgba(0,0,0,.25);white-space:nowrap">${escapeHtml(zone.nom)} · ${level || '?'}/5</div>`,
        iconSize: null,
      }),
      interactive: false,
    }).addTo(avalancheZoneWmsLayer);
  });
}

// ── Feature 15 : Séismes récents sur la carte ────────────────────────────────
function renderSeismesLayer() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  const show = document.getElementById('filter-seismes')?.checked ?? false;
  if (!show) {
    if (seismesLayer && leafletMap.hasLayer(seismesLayer)) leafletMap.removeLayer(seismesLayer);
    return;
  }
  if (!seismesLayer) seismesLayer = window.L.layerGroup();
  if (!leafletMap.hasLayer(seismesLayer)) seismesLayer.addTo(leafletMap);
  seismesLayer.clearLayers();
  const items = Array.isArray(cachedExternalRisksSnapshot?.seismes_isere?.items) ? cachedExternalRisksSnapshot.seismes_isere.items : [];
  items.forEach((q) => {
    if (!q.lat || !q.lon) return;
    const mag = q.magnitude != null ? Number(q.magnitude) : 0;
    const r = Math.max(8, Math.min(28, mag * 7));
    const color = mag >= 4 ? '#c92a2a' : mag >= 3 ? '#e67700' : mag >= 2 ? '#e9a800' : '#2b8a3e';
    const icon = window.L.divIcon({
      className: '',
      html: `<div style="width:${r * 2}px;height:${r * 2}px;border-radius:50%;background:${color};opacity:.7;border:2px solid #fff;box-shadow:0 0 0 2px ${color}44;"></div>`,
      iconSize: [r * 2, r * 2], iconAnchor: [r, r],
    });
    window.L.marker([q.lat, q.lon], { icon })
      .bindPopup(`<strong>🌍 M${mag} — ${escapeHtml(q.place || q.title || '?')}</strong><br><span class="muted">${escapeHtml(q.date_label || q.published_at || '')}</span><br>${q.commune ? `Positionné sur ${escapeHtml(q.commune)}<br>` : ''}Profondeur : ${escapeHtml(String(q.depth_km ?? '?'))} km`)
      .addTo(seismesLayer);
  });
}

// ── Feature 17 : Feux de forêt EFFIS ─────────────────────────────────────────
function renderFeuxForetLayer() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  const show = document.getElementById('filter-feux-foret')?.checked ?? false;
  if (!show) {
    if (feuxForetLayer && leafletMap.hasLayer(feuxForetLayer)) leafletMap.removeLayer(feuxForetLayer);
    return;
  }
  if (!feuxForetLayer) feuxForetLayer = window.L.layerGroup();
  if (!leafletMap.hasLayer(feuxForetLayer)) feuxForetLayer.addTo(leafletMap);
  feuxForetLayer.clearLayers();
  const fires = Array.isArray(cachedExternalRisksSnapshot?.feux_foret_isere?.fires) ? cachedExternalRisksSnapshot.feux_foret_isere.fires : [];
  fires.forEach((f) => {
    const frp = f.frp != null ? `${Number(f.frp).toFixed(0)} MW` : '?';
    const conf = f.confidence || 'nominal';
    const color = conf === 'high' ? '#c92a2a' : conf === 'low' ? '#f08c00' : '#e03131';
    const icon = window.L.divIcon({
      className: '',
      html: `<span style="font-size:18px;filter:drop-shadow(0 1px 3px rgba(0,0,0,.5))">🔥</span>`,
      iconSize: [22, 22], iconAnchor: [11, 11],
    });
    window.L.marker([f.lat, f.lon], { icon })
      .bindPopup(`<strong>🔥 Foyer actif EFFIS</strong><br>Puissance : ${frp}<br>Confiance : ${conf}<br><span class="muted">${escapeHtml(f.date || '')}</span>`)
      .addTo(feuxForetLayer);
  });
}

// ── Feature 19 : Cols alpins ──────────────────────────────────────────────────
function renderColsAlpinsLayer() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  const show = document.getElementById('filter-cols-alpins')?.checked ?? false;
  if (!show) {
    if (colsAlpinsLayer && leafletMap.hasLayer(colsAlpinsLayer)) leafletMap.removeLayer(colsAlpinsLayer);
    return;
  }
  if (!colsAlpinsLayer) colsAlpinsLayer = window.L.layerGroup();
  if (!leafletMap.hasLayer(colsAlpinsLayer)) colsAlpinsLayer.addTo(leafletMap);
  colsAlpinsLayer.clearLayers();
  const cols = Array.isArray(cachedExternalRisksSnapshot?.cols_alpins_isere?.cols) ? cachedExternalRisksSnapshot.cols_alpins_isere.cols : [];
  cols.forEach((col) => {
    const couleur = { vert: '#2b8a3e', jaune: '#e9a800', orange: '#e67700', rouge: '#c92a2a', gris: '#868e96' }[col.couleur] || '#868e96';
    const icon = window.L.divIcon({
      className: '',
      html: `<div style="background:${couleur};color:#fff;font-size:9px;font-weight:700;padding:2px 4px;border-radius:4px;border:1px solid rgba(0,0,0,.25);white-space:nowrap;max-width:90px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.4)">⛰️ ${escapeHtml(col.nom.replace('Col ', '').replace('Col de la ', '').replace('Col du ', '').replace('Col de ', ''))}</div>`,
      iconAnchor: [0, 10], popupAnchor: [0, -12],
    });
    const temp = col.temperature != null ? `${Number(col.temperature).toFixed(1)}°C` : '—';
    const snow = col.enneigement_cm != null ? `${Number(col.enneigement_cm).toFixed(0)} cm` : '—';
    window.L.marker([col.lat, col.lon], { icon })
      .bindPopup(`<strong>⛰️ ${escapeHtml(col.nom)}</strong> · ${col.route || ''}<br>Altitude : ${col.alt || '?'} m · État : <strong style="color:${couleur}">${escapeHtml(col.statut || '?')}</strong><br>${escapeHtml(col.detail || '')}<br>Temp : ${temp} · Neige : ${snow}`)
      .addTo(colsAlpinsLayer);
  });
}

function meteoCityTemperatureColor(tempC) {
  const temp = Number(tempC);
  if (!Number.isFinite(temp)) return '#64748b';
  if (temp <= 0) return '#2563eb';
  if (temp <= 8) return '#0891b2';
  if (temp <= 18) return '#16a34a';
  if (temp <= 28) return '#f59e0b';
  if (temp <= 35) return '#f97316';
  return '#dc2626';
}

function meteoWindColor(speedKmh) {
  const speed = Number(speedKmh);
  if (!Number.isFinite(speed)) return '#64748b';
  if (speed < 15) return '#16a34a';
  if (speed < 30) return '#f59e0b';
  if (speed < 50) return '#f97316';
  return '#dc2626';
}

function meteoPollutionColor(aqi) {
  const value = Number(aqi);
  if (!Number.isFinite(value)) return '#64748b';
  if (value <= 20) return '#16a34a';
  if (value <= 40) return '#84cc16';
  if (value <= 60) return '#f59e0b';
  if (value <= 80) return '#f97316';
  return '#dc2626';
}

function meteoLayerSpec(current = {}, airQuality = {}, mode = 'temperature') {
  if (mode === 'heat') {
    const felt = Number(current.apparent_temperature);
    return {
      label: Number.isFinite(felt) ? `${Math.round(felt)}°` : '--',
      color: meteoCityTemperatureColor(felt),
      emoji: felt >= 30 ? '🔥' : felt <= 0 ? '❄️' : '🌡️',
      title: 'Ressenti / chaleur',
      value: Number.isFinite(felt) ? `${Math.round(felt)}°C ressentis` : 'n/d',
    };
  }
  if (mode === 'wind') {
    const wind = Number(current.wind_speed_10m);
    return {
      label: Number.isFinite(wind) ? `${Math.round(wind)}` : '--',
      color: meteoWindColor(wind),
      emoji: '💨',
      title: 'Vent',
      value: Number.isFinite(wind) ? `${Math.round(wind)} km/h` : 'n/d',
    };
  }
  if (mode === 'gust') {
    const gust = Number(current.wind_gusts_10m);
    return {
      label: Number.isFinite(gust) ? `${Math.round(gust)}` : '--',
      color: meteoWindColor(gust),
      emoji: '🌬️',
      title: 'Rafales',
      value: Number.isFinite(gust) ? `${Math.round(gust)} km/h` : 'n/d',
    };
  }
  if (mode === 'rain') {
    const rain = Number(current.rain ?? current.showers ?? current.precipitation);
    return {
      label: Number.isFinite(rain) ? `${rain.toFixed(rain >= 10 ? 0 : 1)}` : '--',
      color: rain >= 15 ? '#dc2626' : rain >= 6 ? '#f97316' : rain >= 1 ? '#2563eb' : '#16a34a',
      emoji: rain >= 1 ? '🌧️' : '☁️',
      title: 'Pluie actuelle',
      value: Number.isFinite(rain) ? `${rain.toFixed(rain >= 10 ? 0 : 1)} mm` : 'n/d',
    };
  }
  if (mode === 'precipitation') {
    const total = Number(current.precipitation);
    return {
      label: Number.isFinite(total) ? `${total.toFixed(total >= 10 ? 0 : 1)}` : '--',
      color: total >= 20 ? '#dc2626' : total >= 8 ? '#f97316' : total >= 2 ? '#2563eb' : '#16a34a',
      emoji: '💧',
      title: 'Cumul de précipitations',
      value: Number.isFinite(total) ? `${total.toFixed(total >= 10 ? 0 : 1)} mm` : 'n/d',
    };
  }
  if (mode === 'humidity') {
    const humidity = Number(current.relative_humidity_2m);
    return {
      label: Number.isFinite(humidity) ? `${Math.round(humidity)}%` : '--',
      color: humidity >= 90 ? '#2563eb' : humidity >= 70 ? '#0891b2' : humidity >= 35 ? '#16a34a' : '#f59e0b',
      emoji: '💦',
      title: 'Humidité',
      value: Number.isFinite(humidity) ? `${Math.round(humidity)}%` : 'n/d',
    };
  }
  if (mode === 'pollution') {
    const aqi = Number(airQuality.european_aqi);
    return {
      label: Number.isFinite(aqi) ? `${Math.round(aqi)}` : '--',
      color: meteoPollutionColor(aqi),
      emoji: '🌫️',
      title: "Pollution / qualité de l'air",
      value: Number.isFinite(aqi) ? `Indice européen ${Math.round(aqi)}` : 'n/d',
    };
  }
  const temp = Number(current.temperature_2m);
  return {
    label: Number.isFinite(temp) ? `${Math.round(temp)}°` : '--',
    color: meteoCityTemperatureColor(temp),
    emoji: weatherCodeEmoji(current.weathercode),
    title: 'Température actuelle',
    value: Number.isFinite(temp) ? `${Math.round(temp)}°C` : 'n/d',
  };
}

function meteoCityMarkerIcon(city = {}, current = {}, airQuality = {}, mode = 'temperature') {
  const spec = meteoLayerSpec(current, airQuality, mode);
  return window.L.divIcon({
    className: 'meteo-city-marker-wrap',
    html: `<div class="meteo-city-marker" style="--meteo-city-color:${escapeHtml(spec.color)}"><span class="meteo-city-marker__temp">${escapeHtml(spec.label)}</span><span class="meteo-city-marker__emoji">${escapeHtml(spec.emoji)}</span></div>`,
    iconSize: [46, 34],
    iconAnchor: [23, 17],
    popupAnchor: [0, -18],
  });
}

async function fetchMeteoAirQualityForCity(city = {}) {
  const key = String(city.key || `${city.lat},${city.lon}`);
  const cached = meteoAirQualityCache.get(key);
  if (cached && Date.now() - cached.savedAt < 10 * 60 * 1000) return cached.payload;
  if (meteoAirQualityInFlight.has(key)) return meteoAirQualityInFlight.get(key);
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${encodeURIComponent(city.lat)}&longitude=${encodeURIComponent(city.lon)}&current=european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone&timezone=Europe%2FParis`;
  const promise = fetchWithTimeout(url, {}, 12000)
    .then((response) => {
      if (!response.ok) throw new Error(`open-meteo-air ${response.status}`);
      return response.json();
    })
    .then((payload) => {
      const current = payload?.current || {};
      meteoAirQualityCache.set(key, { savedAt: Date.now(), payload: current });
      return current;
    })
    .catch(() => ({}))
    .finally(() => meteoAirQualityInFlight.delete(key));
  meteoAirQualityInFlight.set(key, promise);
  return promise;
}

function meteoCityPopup(city = {}, forecast = {}, airQuality = {}, mode = 'temperature') {
  const current = forecast?.current || {};
  const spec = meteoLayerSpec(current, airQuality, mode);
  const temp = Number.isFinite(Number(current.temperature_2m)) ? `${Math.round(Number(current.temperature_2m))}°C` : 'n/d';
  const felt = Number.isFinite(Number(current.apparent_temperature)) ? `${Math.round(Number(current.apparent_temperature))}°C` : 'n/d';
  const humidity = Number.isFinite(Number(current.relative_humidity_2m)) ? `${Math.round(Number(current.relative_humidity_2m))}%` : 'n/d';
  const wind = Number.isFinite(Number(current.wind_speed_10m)) ? `${Math.round(Number(current.wind_speed_10m))} km/h` : 'n/d';
  const gust = Number.isFinite(Number(current.wind_gusts_10m)) ? `${Math.round(Number(current.wind_gusts_10m))} km/h` : 'n/d';
  const rain = Number.isFinite(Number(current.rain ?? current.showers ?? current.precipitation)) ? `${Number(current.rain ?? current.showers ?? current.precipitation).toFixed(1)} mm` : 'n/d';
  const precipitation = Number.isFinite(Number(current.precipitation)) ? `${Number(current.precipitation).toFixed(1)} mm` : 'n/d';
  const label = weatherCodeLabel(current.weathercode);
  const emoji = weatherCodeEmoji(current.weathercode);
  const aqi = Number.isFinite(Number(airQuality.european_aqi)) ? Math.round(Number(airQuality.european_aqi)) : null;
  const pm25 = Number.isFinite(Number(airQuality.pm2_5)) ? `${Number(airQuality.pm2_5).toFixed(1)} µg/m³` : 'n/d';
  const pm10 = Number.isFinite(Number(airQuality.pm10)) ? `${Number(airQuality.pm10).toFixed(1)} µg/m³` : 'n/d';
  const updated = forecast?.updated_at ? new Date(forecast.updated_at) : null;
  const updatedLabel = updated && !Number.isNaN(updated.getTime())
    ? updated.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : 'n/d';
  return `<div class="map-popup-content">
    <p class="tag">Météo en direct · Open-Meteo</p>
    <strong>${emoji} ${escapeHtml(city.name || 'Ville')}</strong>
    <p style="margin:.35rem 0 0"><strong>${escapeHtml(spec.title)} :</strong> <span style="color:${escapeHtml(spec.color)};font-weight:800">${escapeHtml(spec.value)}</span></p>
    <p style="margin:.35rem 0 0">Température : <strong>${escapeHtml(temp)}</strong> · Ressenti : <strong>${escapeHtml(felt)}</strong></p>
    <p style="margin:.2rem 0 0">${escapeHtml(label)} · Humidité ${escapeHtml(humidity)} · Vent ${escapeHtml(wind)} · Rafales ${escapeHtml(gust)}</p>
    <p style="margin:.2rem 0 0">Pluie : <strong>${escapeHtml(rain)}</strong> · Cumul : <strong>${escapeHtml(precipitation)}</strong></p>
    ${mode === 'pollution' ? `<p style="margin:.2rem 0 0">AQI : <strong>${aqi ?? 'n/d'}</strong> · PM2.5 ${escapeHtml(pm25)} · PM10 ${escapeHtml(pm10)}</p>` : ''}
    <p class="muted" style="font-size:.74rem;margin:.35rem 0 0">Mise à jour : ${escapeHtml(updatedLabel)}</p>
  </div>`;
}

async function renderMeteoCitiesLayer() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  const enabled = document.getElementById('filter-meteo-cities')?.checked ?? false;
  if (!meteoCitiesLayer) meteoCitiesLayer = window.L.layerGroup();
  if (!enabled) {
    meteoCitiesLayer.clearLayers();
    if (leafletMap.hasLayer(meteoCitiesLayer)) leafletMap.removeLayer(meteoCitiesLayer);
    return;
  }

  if (!leafletMap.hasLayer(meteoCitiesLayer)) meteoCitiesLayer.addTo(leafletMap);
  meteoCitiesLayer.clearLayers();
  const mode = document.getElementById('filter-meteo-layer-type')?.value || 'temperature';
  const cities = (await getMeteoCityOptions()).slice(0, 48);
  if (!cities.length) {
    setMapFeedback('Aucune ville météo disponible à afficher.', true);
    return;
  }

  const forecasts = await Promise.all(cities.map(async (city) => ({
    city,
    forecast: await fetchWeeklyForecastForCity(city),
    airQuality: mode === 'pollution' ? await fetchMeteoAirQualityForCity(city) : {},
  })));

  forecasts.forEach(({ city, forecast, airQuality }) => {
    if (!forecast?.current) return;
    const coords = normalizeMapCoordinates(city.lat, city.lon);
    if (!coords) return;
    window.L.marker([coords.lat, coords.lon], {
      icon: meteoCityMarkerIcon(city, forecast.current, airQuality, mode),
      zIndexOffset: 450,
    })
      .bindPopup(meteoCityPopup(city, forecast, airQuality, mode))
      .addTo(meteoCitiesLayer);
  });
  const labels = { temperature: 'température', heat: 'ressenti chaleur', wind: 'vent', pollution: 'pollution' };
  setMapFeedback(`Calque météo ${labels[mode] || 'météo'} affiché : ${forecasts.filter((item) => item.forecast?.current).length} ville(s).`);
}

function renderBarrageLayer() {
  if (!barrageMarkerLayer || !leafletMap) return;
  const enabled = document.getElementById('filter-barrages')?.checked ?? false;
  if (!enabled) {
    if (leafletMap.hasLayer(barrageMarkerLayer)) leafletMap.removeLayer(barrageMarkerLayer);
    return;
  }
  if (!leafletMap.hasLayer(barrageMarkerLayer)) barrageMarkerLayer.addTo(leafletMap);
  barrageMarkerLayer.clearLayers();
  barragePointsCache.forEach((pt) => {
    const icon = window.L.divIcon({
      className: '',
      html: `<span style="font-size:20px;line-height:1;filter:drop-shadow(0 1px 2px #0006)">🏗️</span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    const marker = window.L.marker([pt.lat, pt.lon], { icon });
    const rows = [
      pt.name !== 'Barrage' ? `<b>${escapeHtml(pt.name)}</b>` : '',
      pt.capacity ? `Capacité : ${escapeHtml(String(pt.capacity))}` : '',
      pt.operator ? `Exploitant : ${escapeHtml(pt.operator)}` : '',
      pt.ele ? `Altitude : ${escapeHtml(String(pt.ele))} m` : '',
    ].filter(Boolean).join('<br>');
    marker.bindPopup(`<div style="min-width:160px"><b>🏗️ Barrage</b><hr style="margin:4px 0">${rows || 'Ouvrage hydraulique'}</div>`);
    barrageMarkerLayer.addLayer(marker);
  });
}

async function loadBarragePoints() {
  if (barrageLoaded) return barragePointsCache;
  try {
    const payload = await api('/api/osm/isere/barrages', { cacheTtlMs: 24 * 60 * 60 * 1000 });
    barragePointsCache = Array.isArray(payload?.points) ? payload.points : [];
  } catch {
    barragePointsCache = [];
  }
  barrageLoaded = true;
  return barragePointsCache;
}

function initMap() {
  if (leafletMap || typeof window.L === 'undefined') return;
  leafletMap = window.L.map('isere-map-leaflet', { zoomControl: true }).setView([45.2, 5.72], 9);
  if (!leafletMap.getPane('tacticalShapePane')) {
    const pane = leafletMap.createPane('tacticalShapePane');
    pane.style.zIndex = 430;
    pane.style.pointerEvents = 'none';
  }
  if (!leafletMap.getPane('poiPriorityPane')) {
    const pane = leafletMap.createPane('poiPriorityPane');
    pane.style.zIndex = 660;
  }
  applyBasemap(document.getElementById('map-basemap-select')?.value || 'osm');
  hydroLayer = window.L.layerGroup().addTo(leafletMap);
  hydroLineLayer = window.L.layerGroup().addTo(leafletMap);
  pcsBoundaryLayer = window.L.layerGroup().addTo(leafletMap);
  pcsLayer = window.L.layerGroup().addTo(leafletMap);
  resourceLayer = window.L.layerGroup().addTo(leafletMap);
  searchLayer = window.L.layerGroup().addTo(leafletMap);
  customPointsLayer = window.L.layerGroup().addTo(leafletMap);
  mapPointsLayer = window.L.layerGroup().addTo(leafletMap);
  mapAnnotationFeatureGroup = window.L.featureGroup().addTo(leafletMap);
  mapZoneImpactLayer = window.L.layerGroup().addTo(leafletMap);
  mapEvacuationCircleLayer = window.L.layerGroup().addTo(leafletMap);
  mapMeasureLayer = window.L.layerGroup().addTo(leafletMap);
  mapRouteLayer = window.L.layerGroup().addTo(leafletMap);
  initMapAnnotationModule();
  itinisereLayer = window.L.layerGroup().addTo(leafletMap);
  bisonLayer = window.L.layerGroup().addTo(leafletMap);
  bisonCameraLayer = window.L.layerGroup().addTo(leafletMap);
  autorouteLayer = window.L.layerGroup().addTo(leafletMap);
  prAutorouteLayer = window.L.layerGroup();
  tchooTrainLayer = window.L.layerGroup();
  institutionLayer = window.L.layerGroup().addTo(leafletMap);
  populationLayer = window.L.layerGroup().addTo(leafletMap);
  montagneLayer = window.L.layerGroup(); // ajouté à la carte uniquement si filtre activé
  helipadLayer = window.L.layerGroup();
  barrageMarkerLayer = window.L.layerGroup();
  seismesLayer = window.L.layerGroup();
  feuxForetLayer = window.L.layerGroup();
  colsAlpinsLayer = window.L.layerGroup();
  meteoCitiesLayer = window.L.layerGroup();
  leafletMap.on('click', onMapClickEvacuationCircle);
  leafletMap.on('click', onMapClickMeasure);
  leafletMap.on('click', onMapClickRoute);
  leafletMap.on('click', onMapClickAddPoint);
  leafletMap.on('click', onMapClickStreetView);
  leafletMap.on('click', handleOsmDetailsClick);
  leafletMap.on('zoomend', updateTrafficZoomClass);
  updateTrafficZoomClass();
}

function formatOsmDetailsPopup(payload = {}) {
  const address = payload.address || {};
  const labels = [];
  if (address.road) labels.push(address.road);
  if (address.suburb) labels.push(address.suburb);
  if (address.city || address.town || address.village) labels.push(address.city || address.town || address.village);
  if (address.postcode) labels.push(address.postcode);
  const extras = payload.extratags || {};
  const osmLink = payload.osm_type && payload.osm_id
    ? `https://www.openstreetmap.org/${payload.osm_type}/${payload.osm_id}`
    : '';
  const name = payload.namedetails?.name || payload.name || payload.display_name?.split(',')?.[0] || 'Lieu OSM';
  const category = [payload.category, payload.type].filter(Boolean).join(' · ') || 'Élément cartographique';
  const lat = Number(payload.lat);
  const lon = Number(payload.lon);
  const coordsLabel = formatCoordinates(lat, lon);

  return `
    <strong>🧭 ${escapeHtml(name)}</strong><br>
    <span class="muted">${escapeHtml(category)}</span><br>
    ${labels.length ? `📍 ${escapeHtml(labels.join(', '))}<br>` : ''}
    ${coordsLabel !== '-' ? `🧮 Coordonnées: ${escapeHtml(coordsLabel)}<br>` : ''}
    ${extras.opening_hours ? `🕒 ${escapeHtml(extras.opening_hours)}<br>` : ''}
    ${extras.phone ? `📞 ${escapeHtml(extras.phone)}<br>` : ''}
    ${extras.website ? `🌐 <a href="${escapeHtml(extras.website)}" target="_blank" rel="noreferrer">Site web</a><br>` : ''}
    ${extras.wikipedia ? `📚 ${escapeHtml(extras.wikipedia)}<br>` : ''}
    ${osmLink ? `<a href="${escapeHtml(osmLink)}" target="_blank" rel="noreferrer">Voir sur OpenStreetMap</a><br>` : ''}
    ${coordsLabel !== '-' ? `<a href="https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lon}`)}" target="_blank" rel="noreferrer">Ouvrir dans Google Maps</a>` : ''}
  `;
}

async function handleOsmDetailsClick(event) {
  if (event?.originalEvent?._mapRouteHandled) return;
  if (!leafletMap || isMapToolActive() || typeof fetch !== 'function') return;
  if (leafletMap.getZoom() < OSM_DETAILS_MIN_ZOOM) return;
  const lat = Number(event?.latlng?.lat);
  const lon = Number(event?.latlng?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  updateSelectedLocationPanel(lat, lon);

  if (osmDetailsController) osmDetailsController.abort();
  osmDetailsController = new AbortController();

  if (!osmDetailsMarker) {
    osmDetailsMarker = window.L.circleMarker([lat, lon], {
      radius: 6,
      color: '#0f172a',
      weight: 1,
      fillColor: '#ffffff',
      fillOpacity: 0.85,
    }).addTo(leafletMap);
  } else {
    osmDetailsMarker.setLatLng([lat, lon]);
  }
  osmDetailsMarker.bindPopup('Recherche des informations OSM…').openPopup();

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=19&addressdetails=1&extratags=1&namedetails=1`,
      { signal: osmDetailsController.signal, headers: { 'Accept-Language': 'fr' } },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();

    const popupContent = formatOsmDetailsPopup(payload);
    osmDetailsMarker.bindPopup(popupContent).openPopup();
    setMapFeedback('Informations OSM affichées pour le lieu sélectionné.');
  } catch (error) {
    if (error?.name === 'AbortError') return;
    osmDetailsMarker.bindPopup('Impossible de récupérer les détails OSM pour ce point.').openPopup();
    setMapFeedback('Impossible de récupérer les détails OSM pour ce point.', true);
  }
}

function isMapToolActive() {
  if (mapAddPointMode || mapEvacuationCircleMode || mapMeasureMode || mapRouteMode || mapStreetViewMode) return true;
  if (mapZoneImpactDrawHandler?.enabled && mapZoneImpactDrawHandler.enabled()) return true;
  const drawToolbarModes = mapDrawControl?._toolbars?.draw?._modes;
  if (drawToolbarModes && typeof drawToolbarModes === 'object') {
    const hasActiveLeafletDrawTool = Object.values(drawToolbarModes).some((mode) => {
      try {
        return Boolean(mode?.handler?.enabled && mode.handler.enabled());
      } catch {
        return false;
      }
    });
    if (hasActiveLeafletDrawTool) return true;
  }
  return false;
}

function buildStreetViewUrl(lat, lon, embedded = true) {
  const latNumber = Number(lat);
  const lonNumber = Number(lon);
  if (!Number.isFinite(latNumber) || !Number.isFinite(lonNumber)) return '#';
  const params = new URLSearchParams({
    layer: 'c',
    cbll: `${latNumber.toFixed(6)},${lonNumber.toFixed(6)}`,
    cbp: '12,0,0,0,0',
  });
  if (embedded) params.set('output', 'svembed');
  return `https://www.google.com/maps?${params.toString()}`;
}

function syncStreetViewModeButton() {
  const button = document.getElementById('map-streetview-toggle');
  if (!button) return;
  button.classList.toggle('active', mapStreetViewMode);
  button.setAttribute('aria-pressed', String(mapStreetViewMode));
  button.title = mapStreetViewMode ? 'Cliquez sur la carte pour ouvrir Street View' : 'Choisir un point Street View';
  if (leafletMap) {
    leafletMap.getContainer().style.cursor = mapStreetViewMode ? 'crosshair' : '';
  }
}

function setStreetViewMode(enabled) {
  mapStreetViewMode = Boolean(enabled);
  if (mapStreetViewMode) {
    if (mapAddPointMode) {
      mapAddPointMode = false;
      document.getElementById('map-add-point-btn')?.classList.remove('active');
      document.getElementById('map-add-point-btn')?.setAttribute('aria-pressed', 'false');
    }
    if (mapEvacuationCircleMode) mapEvacuationCircleMode = false;
    if (mapMeasureMode) clearMapMeasure(false);
    if (mapRouteMode) clearMapRoute(false);
    if (typeof _mapWeatherMode !== 'undefined' && _mapWeatherMode) _toggleMapWeatherMode();
    setMapFeedback('Mode Street View actif: cliquez sur une route ou un lieu sur la carte.');
  } else {
    setMapFeedback('');
  }
  syncStreetViewModeButton();
}

function openStreetViewAt(lat, lon) {
  const latNumber = Number(lat);
  const lonNumber = Number(lon);
  if (!Number.isFinite(latNumber) || !Number.isFinite(lonNumber)) return;
  const panel = document.getElementById('map-streetview-panel');
  const frame = document.getElementById('map-streetview-frame');
  const title = document.getElementById('map-streetview-title');
  const externalLink = document.getElementById('map-streetview-open-external');
  if (!panel || !frame) return;

  const embedUrl = buildStreetViewUrl(latNumber, lonNumber, true);
  const externalUrl = buildStreetViewUrl(latNumber, lonNumber, false);
  frame.src = embedUrl;
  if (externalLink) externalLink.href = externalUrl;
  if (title) title.textContent = `Street View · ${formatCoordinates(latNumber, lonNumber)}`;
  panel.hidden = false;
  panel.classList.remove('hidden');
  setStreetViewMode(false);
  updateSelectedLocationPanel(latNumber, lonNumber);
}

function closeStreetView() {
  const panel = document.getElementById('map-streetview-panel');
  const frame = document.getElementById('map-streetview-frame');
  const wasOpen = Boolean(panel && !panel.hidden);
  if (!wasOpen && !mapStreetViewMode) return;
  if (frame) frame.src = 'about:blank';
  if (panel) {
    panel.hidden = true;
    panel.classList.add('hidden');
  }
  setStreetViewMode(false);
  if (wasOpen) setMapFeedback('Retour carte.');
}

function onMapClickStreetView(event) {
  if (!mapStreetViewMode) return;
  const lat = Number(event?.latlng?.lat);
  const lon = Number(event?.latlng?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  openStreetViewAt(lat, lon);
}

function setMapFeedback(message = '', isError = false) {
  const target = document.getElementById('map-feedback');
  if (!target) return;
  target.textContent = message;
  target.className = isError ? 'error' : 'muted';
}

function formatCoordinates(lat, lon) {
  const latNumber = Number(lat);
  const lonNumber = Number(lon);
  if (!Number.isFinite(latNumber) || !Number.isFinite(lonNumber)) return '-';
  return `${latNumber.toFixed(6)}, ${lonNumber.toFixed(6)}`;
}

function updateSelectedLocationPanel(lat, lon) {
  const panel = document.getElementById('map-selected-location');
  const coordsNode = document.getElementById('map-selected-coords');
  const googleLink = document.getElementById('map-open-google-maps');
  const streetViewButton = document.getElementById('map-open-streetview');
  if (!panel || !coordsNode || !googleLink) return;
  const formattedCoords = formatCoordinates(lat, lon);
  const hasCoords = formattedCoords !== '-';
  coordsNode.textContent = formattedCoords;
  if (hasCoords) {
    const latNumber = Number(lat);
    const lonNumber = Number(lon);
    googleLink.href = `https://www.google.com/maps?q=${encodeURIComponent(`${latNumber},${lonNumber}`)}`;
    if (streetViewButton) {
      streetViewButton.dataset.lat = String(latNumber);
      streetViewButton.dataset.lon = String(lonNumber);
      streetViewButton.disabled = false;
    }
    panel.hidden = false;
    return;
  }
  googleLink.href = '#';
  if (streetViewButton) {
    delete streetViewButton.dataset.lat;
    delete streetViewButton.dataset.lon;
    streetViewButton.disabled = true;
  }
  panel.hidden = true;
}


async function resetMapFilters() {
  const defaults = {
    'map-search': '',
    'poi-target-category-filter': 'all',
    'filter-resources-schools-type': 'all',
    'filter-resources-security-type': 'all',
    'filter-resources-risks-type': 'all',
    'filter-resources-transport-type': 'all',
    'filter-resources-health-type': 'all',
    'filter-resources-hosting-type': 'all',
    'filter-resources-hosting-capacity': '0',
    'filter-resources-hosting-surface': '0',
    'filter-resources-hosting-accessibility': 'all',
    'filter-resources-telecom-type': 'all',
    'filter-meteo-layer-type': 'temperature',
    'map-basemap-select': 'osm',
  };
  Object.entries(defaults).forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.value = value;
  });
  const hydro = document.getElementById('filter-hydro');
  const pcs = document.getElementById('filter-pcs');
  const meteoCities = document.getElementById('filter-meteo-cities');
  const activeOnly = document.getElementById('filter-resources-active');
  const schools = document.getElementById('filter-resources-schools');
  const security = document.getElementById('filter-resources-security');
  const fireStations = document.getElementById('filter-resources-fire');
  const riskResources = document.getElementById('filter-resources-risks');
  const transportResources = document.getElementById('filter-resources-transport');
  const trafficIncidents = document.getElementById('filter-traffic-incidents');
  const cameras = document.getElementById('filter-cameras');
  const googleFlow = document.getElementById('filter-google-traffic-flow');
  const tchooTrains = document.getElementById('filter-tchoo-trains');
  const seismes = document.getElementById('filter-seismes');
  const feuxForet = document.getElementById('filter-feux-foret');
  const healthResources = document.getElementById('filter-resources-health');
  const daeResources = document.getElementById('filter-resources-dae');
  const commandResources = document.getElementById('filter-resources-command');
  const hostingResources = document.getElementById('filter-resources-hosting');
  const hostingSanitary = document.getElementById('filter-resources-hosting-sanitary');
  const hostingHeating = document.getElementById('filter-resources-hosting-heating');
  const hostingParking = document.getElementById('filter-resources-hosting-parking');
  const telecomResources = document.getElementById('filter-resources-telecom');
  if (hydro) hydro.checked = true;
  if (pcs) pcs.checked = true;
  if (meteoCities) meteoCities.checked = false;
  if (activeOnly) activeOnly.checked = true;
  if (schools) schools.checked = false;
  if (security) security.checked = false;
  if (fireStations) fireStations.checked = false;
  if (riskResources) riskResources.checked = false;
  if (transportResources) transportResources.checked = false;
  if (trafficIncidents) trafficIncidents.checked = true;
  if (cameras) cameras.checked = true;
  if (tchooTrains) tchooTrains.checked = false;
  if (seismes) seismes.checked = false;
  if (feuxForet) feuxForet.checked = false;
  if (healthResources) healthResources.checked = false;
  if (daeResources) daeResources.checked = false;
  if (commandResources) commandResources.checked = true;
  if (hostingResources) hostingResources.checked = false;
  if (hostingSanitary) hostingSanitary.checked = false;
  if (hostingHeating) hostingHeating.checked = false;
  if (hostingParking) hostingParking.checked = false;
  if (telecomResources) telecomResources.checked = false;
  if (googleFlow) googleFlow.checked = false;
  document.querySelectorAll('.tactical-layer-toggle').forEach((input) => { input.checked = true; });
  resourceVisibilityOverrides.clear();
  syncTelecomFilterState();
  if (searchLayer) searchLayer.clearLayers();
  applyBasemap('osm');
  renderStations(cachedVigicruesPayload);
  renderCustomPoints();
  renderResources();
  await renderMeteoCitiesLayer();
  renderSeismesLayer();
  renderFeuxForetLayer();
  await renderMunicipalitiesOnMap(cachedMunicipalities);
  await renderPopulationByCityLayer();
  await renderTrafficOnMap();
  renderMapChecks([]);
  clearZoneImpactSelection();
  clearEvacuationCircle(false);
  clearMapMeasure(false);
  setMapFeedback('Filtres carte réinitialisés.');
}

function focusOnCrisisAreas() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  if (!cachedCrisisPoints.length) {
    setMapFeedback('Aucune commune en crise actuellement, vue globale conservée.');
    fitMapToData();
    return;
  }
  const bounds = window.L.latLngBounds(cachedCrisisPoints.map((point) => [point.lat, point.lon]));
  if (bounds.isValid()) {
    leafletMap.fitBounds(bounds, { padding: [34, 34], maxZoom: 11 });
    setMapFeedback(`Focus crise: ${cachedCrisisPoints.length} commune(s) en mode crise.`);
    return;
  }
  setMapFeedback('Impossible de centrer la carte sur les communes en crise.', true);
}

function toggleMapContrast() {
  const panel = document.getElementById('map-panel');
  const button = document.getElementById('map-toggle-contrast');
  if (!panel || !button) return;
  const active = panel.classList.toggle('map-panel--high-contrast');
  button.textContent = `Contraste renforcé: ${active ? 'on' : 'off'}`;
  button.setAttribute('aria-pressed', String(active));
}

function fitMapToData(showFeedback = false) {
  if (!leafletMap) return;
  const layers = [boundaryLayer, hydroLayer, hydroLineLayer, pcsBoundaryLayer, pcsLayer, resourceLayer, institutionLayer, populationLayer, searchLayer, customPointsLayer, mapPointsLayer, itinisereLayer, bisonLayer, bisonCameraLayer, seismesLayer, feuxForetLayer, tchooTrainLayer].filter(Boolean);
  const bounds = window.L.latLngBounds([]);
  layers.forEach((layer) => {
    if (layer?.getBounds) {
      const layerBounds = layer.getBounds();
      if (layerBounds?.isValid && layerBounds.isValid()) bounds.extend(layerBounds);
    }
  });
  if (bounds.isValid()) {
    leafletMap.fitBounds(bounds, { padding: [24, 24] });
    if (showFeedback) setMapFeedback('Carte recentrée sur les données visibles.');
    return;
  }
  if (showFeedback) setMapFeedback('Aucune donnée cartographique à afficher.', true);
}

function locateUserOnMap() {
  if (!leafletMap) return;
  if (!navigator.geolocation) {
    setMapFeedback('La géolocalisation n\'est pas disponible sur cet appareil.', true);
    return;
  }
  navigator.geolocation.getCurrentPosition((position) => {
    const { latitude, longitude, accuracy } = position.coords;
    const coords = [latitude, longitude];
    leafletMap.setView(coords, 14);
    if (!userLocationMarker) {
      userLocationMarker = window.L.circleMarker(coords, {
        radius: 9,
        color: '#0b4daa',
        weight: 2,
        fillColor: '#2b6bff',
        fillOpacity: 0.35,
      }).addTo(leafletMap);
    } else {
      userLocationMarker.setLatLng(coords);
    }
    userLocationMarker.bindPopup(`Vous êtes ici (précision ±${Math.round(accuracy)} m)`).openPopup();
    setMapFeedback('Position trouvée et centrée sur votre localisation.');
  }, (error) => {
    const messages = {
      1: 'Autorisation refusée pour la géolocalisation.',
      2: 'Position indisponible actuellement.',
      3: 'Délai dépassé pour récupérer la position.',
    };
    setMapFeedback(messages[error.code] || 'Impossible de vous localiser.', true);
  }, {
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 60000,
  });
}

function setSidebarCollapsed(collapsed) {
  const appView = document.getElementById('app-view');
  const toggle = document.getElementById('app-sidebar-toggle');
  if (!appView || !toggle) return;
  const isCollapsed = Boolean(collapsed);
  appView.classList.toggle('app--sidebar-collapsed', isCollapsed);
  toggle.setAttribute('aria-expanded', String(!isCollapsed));
  toggle.textContent = isCollapsed ? '↔ Agrandir menu' : '↔ Réduire menu';
  localStorage.setItem(STORAGE_KEYS.appSidebarCollapsed, String(isCollapsed));
  if (leafletMap) setTimeout(() => leafletMap.invalidateSize(), 160);
}

async function loadIsereBoundary() {
  initMap();
  const data = await api('/public/isere-map');
  isereBoundaryGeometry = data?.geometry || null;
  if (boundaryLayer) leafletMap.removeLayer(boundaryLayer);
  boundaryLayer = window.L.geoJSON({ type: 'Feature', geometry: data.geometry }, { style: ISERE_BOUNDARY_STYLE }).addTo(leafletMap);
  leafletMap.fitBounds(boundaryLayer.getBounds(), { padding: [16, 16] });
  const mapSourceNode = document.getElementById('map-source');
  if (mapSourceNode) mapSourceNode.textContent = `Source carte: ${data.source}`;
  setMapFeedback('Fond de carte et contour Isère chargés.');
}

function isPointInRing(point, ring = []) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i] || [];
    const [xj, yj] = ring[j] || [];
    const intersects = ((yi > point.lat) !== (yj > point.lat))
      && (point.lon < ((xj - xi) * (point.lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function isPointInsideGeometry(point, geometry = null) {
  if (!point || !geometry) return false;
  const { type, coordinates } = geometry;
  if (!Array.isArray(coordinates)) return false;

  const isInsidePolygon = (polygon = []) => {
    if (!Array.isArray(polygon) || !polygon.length) return false;
    const [outerRing, ...holes] = polygon;
    if (!isPointInRing(point, outerRing || [])) return false;
    return !holes.some((hole) => isPointInRing(point, hole || []));
  };

  if (type === 'Polygon') return isInsidePolygon(coordinates);
  if (type === 'MultiPolygon') return coordinates.some((polygon) => isInsidePolygon(polygon));
  return false;
}

function isIncidentInIsere(incident = {}) {
  if (!isereBoundaryGeometry) return true;
  const points = [];
  const incidentCoords = normalizeMapCoordinates(incident.lat, incident.lon);
  if (incidentCoords) points.push(incidentCoords);
  if (Array.isArray(incident.line)) {
    incident.line.forEach((linePoint) => {
      const normalized = normalizeMapCoordinates(linePoint?.lat, linePoint?.lon);
      if (normalized) points.push(normalized);
    });
  }
  if (!points.length) return false;
  return points.some((point) => isPointInsideGeometry(point, isereBoundaryGeometry));
}

function isAccidentIncident(incident = {}) {
  const fields = [incident.type, incident.subtype, incident.title, incident.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /accident|collision|carambolage|crash/.test(fields);
}

function renderStations(vigicruesPayload = []) {
  const stations = Array.isArray(vigicruesPayload)
    ? vigicruesPayload
    : (Array.isArray(vigicruesPayload?.stations) ? vigicruesPayload.stations : []);
  const troncons = Array.isArray(vigicruesPayload?.troncons) ? vigicruesPayload.troncons : [];
  cachedStations = stations;

  // Mise à jour de la liste latérale (toujours, même sans carte)
  setHtml('hydro-stations-list', stations.slice(0, 40).map((s) => {
    const statusLevel = stationStatusLevel(s);
    return `<li><strong>${s.station || s.code}</strong> · ${s.river || ''} · <span style="color:${levelColor(statusLevel)}">${statusLevel}</span> · Contrôle: ${escapeHtml(s.control_status || 'inconnu')} · ${s.height_m} m</li>`;
  }).join('') || '<li>Aucune station.</li>');

  if (!hydroLayer || !hydroLineLayer) return;

  const visible = document.getElementById('filter-hydro')?.checked ?? true;

  if (!visible) {
    // Filtre désactivé : retirer tous les marqueurs de la carte sans détruire les Maps
    hydroMarkersByCode.forEach((marker) => hydroLayer.removeLayer(marker));
    hydroMarkersByCode.clear();
    hydroLinesByCode.forEach((line) => hydroLineLayer.removeLayer(line));
    hydroLinesByCode.clear();
    mapStats.stations = 0;
    updateMapSummary();
    return;
  }

  // --- Stations : diff — on ne touche qu'à ce qui a changé ---
  const stationsWithPoints = stations
    .map((s) => {
      const coords = normalizeMapCoordinates(s.lat, s.lon);
      return coords ? { ...s, ...coords } : null;
    })
    .filter(Boolean);

  const incomingCodes = new Set();
  stationsWithPoints.forEach((s) => {
    const code = String(s.code || '');
    if (!code) return;
    incomingCodes.add(code);
    const statusLevel = stationStatusLevel(s);
    const counter = ({ vert: 'V', jaune: 'J', orange: 'O', rouge: 'R' }[statusLevel] || 'V');
    const delta = Number.isFinite(Number(s.delta_window_m)) ? `${Number(s.delta_window_m) > 0 ? '+' : ''}${Number(s.delta_window_m).toFixed(3)} m` : 'n/d';
    const observedDate = s.observed_at ? new Date(s.observed_at) : null;
    const observedLabel = observedDate && !Number.isNaN(observedDate.getTime())
      ? observedDate.toLocaleString('fr-FR')
      : (s.observed_at || 'n/d');
    const troncon = s.troncon || s.troncon_code || '';
    const sourceLink = s.source_link || (s.code ? `https://www.vigicrues.gouv.fr/station/${encodeURIComponent(s.code)}` : 'https://www.vigicrues.gouv.fr');
    const popupContent = `<div class="map-popup-content">
      <p class="tag">Vigicrues · station hydrométrique</p>
      <strong>${escapeHtml(s.station || s.code)}</strong>
      <p style="margin:.3rem 0 0">${escapeHtml(s.river || 'Cours d’eau non précisé')} · Département Isère (38)</p>
      <p style="margin:.25rem 0 0">Statut : <strong style="color:${levelColor(statusLevel)}">${escapeHtml(statusLevel)}</strong> · Contrôle : ${escapeHtml(s.control_status || 'inconnu')}</p>
      <p style="margin:.25rem 0 0">Hauteur : <strong>${escapeHtml(String(s.height_m ?? 'n/d'))} m</strong> · Variation : <strong>${escapeHtml(delta)}</strong></p>
      ${troncon ? `<p style="margin:.25rem 0 0">Tronçon : ${escapeHtml(troncon)}</p>` : ''}
      <p class="muted" style="font-size:.74rem;margin:.35rem 0 0">Observation : ${escapeHtml(String(observedLabel))}</p>
      <a href="${escapeHtml(sourceLink)}" target="_blank" rel="noreferrer">Ouvrir Vigicrues</a>
    </div>`;

    if (hydroMarkersByCode.has(code)) {
      // Marqueur déjà présent : mettre à jour l'icône et le popup sans flash
      const existing = hydroMarkersByCode.get(code);
      existing.setIcon(vigicruesStationIcon(statusLevel, counter));
      existing.setPopupContent(popupContent);
    } else {
      // Nouveau marqueur
      const marker = window.L.marker([s.lat, s.lon], { icon: vigicruesStationIcon(statusLevel, counter) })
        .bindPopup(popupContent)
        .addTo(hydroLayer);
      hydroMarkersByCode.set(code, marker);
    }
  });

  // Supprimer les marqueurs qui ne sont plus dans les données
  // Uniquement si on a reçu un jeu de données réel (non vide) — évite de tout supprimer en état pending.
  if (incomingCodes.size > 0) {
    hydroMarkersByCode.forEach((marker, code) => {
      if (!incomingCodes.has(code)) {
        hydroLayer.removeLayer(marker);
        hydroMarkersByCode.delete(code);
      }
    });
  }

  // --- Tronçons : diff ---
  const incomingTroncons = new Set();
  troncons.forEach((troncon) => {
    const code = String(troncon.code || '');
    if (!code) return;
    const polyline = Array.isArray(troncon?.polyline) ? troncon.polyline : [];
    if (!polyline.length) return;
    const points = polyline
      .map((point) => Array.isArray(point) && point.length >= 2 ? normalizeMapCoordinates(point[0], point[1]) : null)
      .filter(Boolean);
    if (points.length < 2) return;
    incomingTroncons.add(code);
    const level = normalizeLevel(troncon.level || 'vert');
    const popupContent = `<strong>${escapeHtml(troncon.name || 'Tronçon Isère')}</strong><br>Code: ${escapeHtml(code)}<br>Niveau: ${escapeHtml(level)}${troncon.rss ? `<br><a href="${escapeHtml(troncon.rss)}" target="_blank" rel="noopener noreferrer">Flux RSS</a>` : ''}`;

    if (hydroLinesByCode.has(code)) {
      // Mettre à jour la couleur et le popup sans recréer la polyline
      const existing = hydroLinesByCode.get(code);
      existing.setStyle({ color: levelColor(level), weight: 6, opacity: 0.9 });
      existing.setPopupContent(popupContent);
    } else {
      const line = window.L.polyline(points.map((point) => [point.lat, point.lon]), { color: levelColor(level), weight: 6, opacity: 0.9 })
        .bindPopup(popupContent)
        .addTo(hydroLineLayer);
      hydroLinesByCode.set(code, line);
    }
  });

  if (incomingTroncons.size > 0) {
    hydroLinesByCode.forEach((line, code) => {
      if (!incomingTroncons.has(code)) {
        hydroLineLayer.removeLayer(line);
        hydroLinesByCode.delete(code);
      }
    });
  }

  mapStats.stations = stationsWithPoints.length;
  updateMapSummary();
  setMapFeedback(`${stations.length} station(s) Vigicrues Isère chargée(s).`);
}

async function geocodeMunicipality(municipality) {
  const key = `mairie|${municipality.name}|${municipality.postal_code || ''}|${municipality.insee_code || ''}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  try {
    const cityCodeParam = municipality.insee_code ? `&citycode=${encodeURIComponent(municipality.insee_code)}` : '';
    const expectedName = normalizeLooseCityKey(municipality.name || '');
    const expectedPostcode = String(municipality.postal_code || '').trim();
    const expectedCityCode = String(municipality.insee_code || '').trim();
    const townHallQueries = municipality.postal_code
      ? [
          `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(`mairie ${municipality.name}`)}&postcode=${encodeURIComponent(municipality.postal_code)}${cityCodeParam}&limit=5`,
          `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(`mairie de ${municipality.name}`)}&postcode=${encodeURIComponent(municipality.postal_code)}${cityCodeParam}&limit=5`,
          `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(`hotel de ville ${municipality.name}`)}&postcode=${encodeURIComponent(municipality.postal_code)}${cityCodeParam}&limit=5`,
        ]
      : [
          `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(`mairie ${municipality.name}`)}${cityCodeParam}&limit=5`,
          `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(`mairie de ${municipality.name}`)}${cityCodeParam}&limit=5`,
          `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(`hotel de ville ${municipality.name}`)}${cityCodeParam}&limit=5`,
        ];

    for (const url of townHallQueries) {
      const response = await queueApiRequest(() => fetchWithTimeout(url));
      const payload = await parseJsonResponse(response, url);
      const features = Array.isArray(payload?.features) ? payload.features : [];
      const preferred = features.find((feature) => {
        const props = feature?.properties || {};
        const label = normalizeLooseCityKey(`${props.label || ''} ${props.name || ''}`);
        const city = normalizeLooseCityKey(props.city || '');
        const postcode = String(props.postcode || '').trim();
        const citycode = String(props.citycode || '').trim();
        const isTownHall = label.includes('mairie') || label.includes('hotel de ville');
        const matchesCity = !expectedName || city.includes(expectedName) || expectedName.includes(city);
        const matchesPostcode = !expectedPostcode || postcode === expectedPostcode;
        const matchesCityCode = !expectedCityCode || citycode === expectedCityCode;
        return isTownHall && matchesCity && matchesPostcode && matchesCityCode;
      });
      const coords = preferred?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length !== 2) continue;
      const point = normalizeMapCoordinates(coords[1], coords[0]);
      if (!point) continue;
      geocodeCache.set(key, point);
      return point;
    }

    geocodeCache.set(key, null);
    return null;
  } catch {
    return null;
  }
}

async function fetchMunicipalityContour(municipality) {
  const key = `${municipality.name}|${municipality.postal_code || ''}`;
  if (municipalityContourCache.has(key)) return municipalityContourCache.get(key);
  try {
    const queries = municipality.postal_code
      ? [
          `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&codePostal=${encodeURIComponent(municipality.postal_code)}&fields=contour&format=geojson&geometry=contour&limit=1`,
          `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&fields=contour&format=geojson&geometry=contour&limit=1`,
        ]
      : [`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&fields=contour&format=geojson&geometry=contour&limit=1`];

    for (const url of queries) {
      const response = await queueApiRequest(() => fetchWithTimeout(url));
      const payload = await parseJsonResponse(response, url);
      const geometry = payload?.features?.[0]?.geometry;
      if (!geometry) continue;
      municipalityContourCache.set(key, geometry);
      return geometry;
    }
  } catch {
    // Ne bloque pas l'affichage des points PCS si le contour est indisponible.
  }

  municipalityContourCache.set(key, null);
  return null;
}

async function renderMunicipalitiesOnMap(municipalities = []) {
  cachedMunicipalities = municipalities;
  const pcs = municipalities.filter((m) => m.pcs_active);
  setHtml('pcs-list', pcs.slice(0, 15).map((m) => `<li><strong>${m.name}</strong> · ${m.postal_code || 'CP ?'} · ${m.manager} · ${m.crisis_mode ? '🔴 CRISE' : 'veille'}</li>`).join('') || '<li>Aucune commune PCS.</li>');
  if (!pcsLayer) return;
  pcsLayer.clearLayers();
  if (pcsBoundaryLayer) pcsBoundaryLayer.clearLayers();
  if (!(document.getElementById('filter-pcs')?.checked ?? true)) {
    mapStats.pcs = 0;
    updateMapSummary();
    return;
  }
  const points = await Promise.all(
    pcs.map(async (m) => ({
      municipality: m,
      point: await geocodeMunicipality(m),
      contour: await fetchMunicipalityContour(m),
    })),
  );
  let renderedCount = 0;
  cachedCrisisPoints = [];
  points.forEach(({ municipality, point, contour }) => {
    if (contour && pcsBoundaryLayer) {
      window.L.geoJSON({ type: 'Feature', geometry: contour }, {
        style: ISERE_BOUNDARY_STYLE,
        interactive: false,
      })
        .addTo(pcsBoundaryLayer);
    }
    if (!point) return;
    const isInCrisis = Boolean(municipality.crisis_mode);
    window.L.circleMarker([point.lat, point.lon], {
      radius: isInCrisis ? 11 : 8,
      color: isInCrisis ? '#a51111' : '#fff',
      weight: isInCrisis ? 2.4 : 1.5,
      fillColor: isInCrisis ? '#e03131' : '#17335f',
      fillOpacity: 0.95,
    })
      .bindPopup(`<strong>${municipality.name}</strong><br>Code postal: ${municipality.postal_code || '-'}<br>PCS: actif<br>Statut: ${isInCrisis ? 'CRISE' : 'veille'}`)
      .addTo(pcsLayer);

    if (isInCrisis) {
      cachedCrisisPoints.push({ lat: point.lat, lon: point.lon, name: municipality.name });
      window.L.circle([point.lat, point.lon], {
        radius: 1000,
        color: '#e03131',
        weight: 1.5,
        fillColor: '#e03131',
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(pcsLayer);
    }
    renderedCount += 1;
  });
  mapStats.pcs = renderedCount;
  updateMapSummary();
  setMapFeedback(`${renderedCount}/${pcs.length} commune(s) PCS géolocalisée(s).`);
}

function refreshPoiTargetOptions() {
  const button = document.getElementById('poi-target-toggle-btn');
  if (!button) return;
  const hasVisible = mapPoints.some((point) => mapPointVisibilityOverrides.get(point.id) !== false);
  button.disabled = mapPoints.length === 0;
  button.textContent = hasVisible ? 'Masquer tous les POI' : 'Afficher tous les POI';
}

function syncPoiTargetButton() {
  refreshPoiTargetOptions();
}

function toggleSelectedPoiVisibility() {
  if (!mapPoints.length) return;
  const hasVisible = mapPoints.some((point) => mapPointVisibilityOverrides.get(point.id) !== false);
  mapPoints.forEach((point) => {
    mapPointVisibilityOverrides.set(point.id, !hasVisible);
  });
  renderCustomPoints();
  setMapFeedback(`POI personnalisés: ${hasVisible ? 'masqués' : 'affichés'} (toutes catégories).`);
}

function classifyInstitutionPoint(element = {}) {
  const tags = element.tags || {};
  const amenity = String(tags.amenity || '').toLowerCase();
  const leisure = String(tags.leisure || '').toLowerCase();
  const building = String(tags.building || '').toLowerCase();
  const socialFacility = String(tags['social_facility'] || '').toLowerCase();
  const name = String(tags.name || '').toLowerCase();
  const policeType = String(tags.police || '').toLowerCase();
  const railway = String(tags.railway || '').toLowerCase();
  const aeroway = String(tags.aeroway || '').toLowerCase();

  // ── Établissements scolaires ──────────────────────────────────────────────
  if (amenity === 'kindergarten') return 'creche';
  if (amenity === 'university') return 'universite';
  if (amenity === 'college') return 'college';
  if (amenity === 'school') {
    if (name.includes('lycée') || name.includes('lycee')) return 'lycee';
    if (name.includes('collège') || name.includes('college')) return 'college';
    return 'ecole_primaire';
  }

  // ── Sécurité / secours ────────────────────────────────────────────────────
  if (amenity === 'fire_station') return 'caserne_pompier';
  if (amenity === 'police') {
    if (name.includes('gendarmerie') || policeType.includes('gendarmerie')) return 'gendarmerie';
    if (name.includes('municipale') || policeType.includes('municipal')) return 'police_municipale';
    return 'commissariat_police_nationale';
  }

  // ── Transport ─────────────────────────────────────────────────────────────
  if (amenity === 'bus_station') return 'transport_gare_routiere';
  if (railway === 'station') return 'transport_gare_sncf';
  if (aeroway === 'aerodrome' || aeroway === 'airport') return 'transport_aeroport';

  // ── Salles de spectacle / congrès ─────────────────────────────────────────
  if (amenity === 'theatre' || amenity === 'cinema' || amenity === 'music_venue') return 'salle_spectacle_public';
  if (amenity === 'concert_hall' || amenity === 'events_venue') return 'salle_spectacle_public';
  if (amenity === 'convention_centre') return 'palais_congres';

  // ── Gymnases et équipements sportifs ──────────────────────────────────────
  if (leisure === 'sports_hall' || building === 'sports_hall' || building === 'gymnasium') return 'gymnase';
  if (leisure === 'stadium' || building === 'stadium') return 'stade';
  if (leisure === 'sports_centre' || building === 'sports_centre') return 'complexe_sportif';
  if (leisure === 'ice_rink' || leisure === 'velodrome' || leisure === 'fitness_centre') return 'complexe_sportif';

  // ── Centres culturels / communautaires ────────────────────────────────────
  if (amenity === 'community_centre' || amenity === 'arts_centre') {
    // Distinguer salle des fêtes (foyer/polyvalente) de centre culturel
    if (name.includes('foyer') || name.includes('polyvalent') || name.includes('fête') || name.includes('fete') || name.includes('salle')) return 'salle_fetes';
    return 'centre_culturel';
  }
  if (amenity === 'hall') return 'salle_fetes';
  if (amenity === 'social_facility' || socialFacility.includes('shelter') || socialFacility.includes('group_home')) return 'salle_fetes';

  // ── Bâtiments civiques ────────────────────────────────────────────────────
  if (building === 'civic' || building === 'public' || building === 'hall' || building === 'community_centre') return 'salle_fetes';

  // ── Classification par nom ────────────────────────────────────────────────
  // Gymnases
  if (name.includes('gymnase') || name.includes('salle de sport') || name.includes('halle sportive') || name.includes('gym municipal') || name.includes('gymnase municipal') || name.includes('gymnase scolaire')) return 'gymnase';
  // Complexes sportifs
  if (name.includes('complexe sportif') || name.includes('complexe omnisports') || name.includes('complexe municipal') || name.includes('espace sportif') || name.includes('maison des sports') || name.includes('pôle sportif') || name.includes('pole sportif') || name.includes('plateau sportif')) return 'complexe_sportif';
  // Stades
  if (name.includes('stade') || name.includes('arena ') || name.includes(' arena')) return 'stade';
  // Salles omnisports
  if (name.includes('palais des sports') || name.includes('palais omnisports') || name.includes('halle omnisports') || name.includes('salle omnisports') || name.includes('espace omnisports') || name.includes('terrain omnisports')) return 'salle_omnisports';
  // Palais des congrès
  if (name.includes('palais des congrès') || name.includes('palais des congres') || name.includes('centre des congrès') || name.includes('centre des congres') || name.includes('parc des expositions') || name.includes('palais de la foire')) return 'palais_congres';
  // Salles de spectacle
  if (name.includes('salle de concert') || name.includes('salle de spectacle') || name.includes('théâtre') || name.includes('theatre') || name.includes('espace culturel') || name.includes('centre culturel')) return 'salle_spectacle_public';
  // Salles des fêtes / polyvalentes
  if (name.includes('salle des fêtes') || name.includes('salle des fetes') || name.includes('salle polyvalente') || name.includes('salle communale') || name.includes('salle municipale') || name.includes('salle intercommunale') || name.includes('salle de la mairie') || name.includes('salle des associations')) return 'salle_fetes';
  if (name.includes('foyer rural') || name.includes('foyer municipal') || name.includes('foyer communal') || name.includes('foyer des sports')) return 'salle_fetes';
  if (name.includes('salle d\'accueil') || name.includes('salle de réunion') || name.includes('salle de reunion') || name.includes('halle polyvalente')) return 'salle_fetes';
  // Centres sociaux / maisons de quartier
  if (name.includes('maison des associations') || name.includes('centre social') || name.includes('maison de quartier') || name.includes('maison des habitants') || name.includes('centre de vie')) return 'centre_culturel';

  return null;
}

function shouldDisplayBaseResourceType(type = '', resource = null) {
  const resourceForFilters = resource || { type };
  if (TELECOM_RESOURCE_TYPES.has(type)) {
    const telecomEnabled = document.getElementById('filter-resources-telecom')?.checked ?? false;
    const telecomTypeFilter = document.getElementById('filter-resources-telecom-type')?.value || 'all';
    if (!telecomEnabled) return false;
    return telecomTypeFilter === 'all' || telecomTypeFilter === type;
  }
  if (SCHOOL_RESOURCE_TYPES.has(type)) {
    const schoolsEnabled = document.getElementById('filter-resources-schools')?.checked ?? false;
    const schoolTypeFilter = document.getElementById('filter-resources-schools-type')?.value || 'all';
    if (!schoolsEnabled) return false;
    return schoolTypeFilter === 'all' || schoolTypeFilter === type;
  }
  if (SECURITY_RESOURCE_TYPES.has(type)) {
    const securityEnabled = document.getElementById('filter-resources-security')?.checked ?? false;
    const securityTypeFilter = document.getElementById('filter-resources-security-type')?.value || 'all';
    if (!securityEnabled) return false;
    return securityTypeFilter === 'all' || securityTypeFilter === type;
  }
  if (FIRE_RESOURCE_TYPES.has(type)) return document.getElementById('filter-resources-fire')?.checked ?? false;
  if (DAE_RESOURCE_TYPES.has(type)) return document.getElementById('filter-resources-dae')?.checked ?? false;
  if (RISK_RESOURCE_TYPES.has(type)) {
    const risksEnabled = document.getElementById('filter-resources-risks')?.checked ?? false;
    const risksTypeFilter = document.getElementById('filter-resources-risks-type')?.value || 'all';
    if (!risksEnabled) return false;
    return risksTypeFilter === 'all' || risksTypeFilter === type;
  }
  if (TRANSPORT_RESOURCE_TYPES.has(type)) {
    const transportEnabled = document.getElementById('filter-resources-transport')?.checked ?? false;
    if (!transportEnabled) return false;
    const transportTypeFilter = document.getElementById('filter-resources-transport-type')?.value || 'all';
    if (transportTypeFilter === 'all') return true;
    // 'transport' est un type générique → visible si n'importe quel sous-type est sélectionné
    if (type === 'transport') return true;
    return transportTypeFilter === type;
  }
  if (HEALTH_RESOURCE_TYPES.has(type) || FINESS_DYNAMIC_RESOURCE_TYPES.has(type)) {
    const healthEnabled = document.getElementById('filter-resources-health')?.checked ?? false;
    const healthTypeFilter = document.getElementById('filter-resources-health-type')?.value || 'all';
    if (!healthEnabled) return false;
    if (healthTypeFilter === 'health_urgent_care') return HEALTH_URGENT_CARE_TYPES.has(type);
    return healthTypeFilter === 'all' || healthTypeFilter === type;
  }
  if (COMMAND_RESOURCE_TYPES.has(type)) return document.getElementById('filter-resources-command')?.checked ?? true;
  if (HOSTING_RESOURCE_TYPES.has(type)) {
    const hostingEnabled = document.getElementById('filter-resources-hosting')?.checked ?? false;
    const hostingTypeFilter = document.getElementById('filter-resources-hosting-type')?.value || 'all';
    if (!hostingEnabled) return false;
    if (hostingTypeFilter !== 'all' && hostingTypeFilter !== type) return false;
    return hostingMatchesAdvancedFilters(resourceForFilters);
  }
  if (PC_RESOURCE_TYPES.has(type)) return document.getElementById('filter-resources-protcivile')?.checked ?? true;
  return true;
}

function normalizeYesNo(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (['yes', 'true', '1', 'oui', 'available', 'present', 'designated'].includes(text)) return true;
  if (['no', 'false', '0', 'non', 'none', 'absent'].includes(text)) return false;
  if (['limited', 'partial', 'partiel', 'unknown', 'inconnu'].includes(text)) return text;
  return text;
}

function yesNoLabel(value, { unknown = 'Non renseigné', yes = 'Oui', no = 'Non' } = {}) {
  const normalized = normalizeYesNo(value);
  if (normalized === true) return yes;
  if (normalized === false) return no;
  if (['limited', 'partial', 'partiel'].includes(normalized)) return 'Partiel';
  if (normalized === 'probable') return 'Probable';
  return unknown;
}

function isHostingCandidateType(type = '') {
  return HOSTING_RESOURCE_TYPES.has(type) || SCHOOL_HOSTING_TYPES.has(type);
}

function estimateHostingCapacity(resource = {}) {
  const min = Number(resource.capacity_min);
  const max = Number(resource.capacity_max);
  if (Number.isFinite(min) && min > 0 && Number.isFinite(max) && max > 0) {
    return { value: max, label: `${min.toLocaleString('fr-FR')}-${max.toLocaleString('fr-FR')} pers.`, source: resource.capacity_source || 'catégorie ERP renseignée' };
  }
  if (Number.isFinite(min) && min > 0) {
    return { value: min, label: `${min.toLocaleString('fr-FR')}+ pers.`, source: resource.capacity_source || 'catégorie ERP renseignée' };
  }
  const explicit = Number(resource.capacity || resource.hosting_capacity || resource.details?.capacity);
  if (Number.isFinite(explicit) && explicit > 0) return { value: Math.round(explicit), label: `${Math.round(explicit).toLocaleString('fr-FR')} pers.`, source: resource.capacity_source || 'capacité renseignée' };
  const surface = Number(resource.surface_m2 || resource.details?.surface_m2);
  if (Number.isFinite(surface) && surface > 0) {
    const value = Math.max(1, Math.floor(surface / 4));
    return { value, label: `${value.toLocaleString('fr-FR')} pers.`, source: 'estimation surface / 4 m²' };
  }
  const fallback = {
    palais_congres: 800,
    salle_omnisports: 500,
    stade: 300,
    complexe_sportif: 220,
    lycee: 220,
    universite: 220,
    college: 160,
    centre_culturel: 150,
    salle_spectacle_public: 150,
    gymnase: 120,
    salle_fetes: 80,
    ecole_primaire: 70,
  }[String(resource.type || '')];
  return fallback ? { value: fallback, label: `${fallback.toLocaleString('fr-FR')} pers.`, source: 'estimation par type, à confirmer' } : { value: null, label: 'à confirmer', source: 'capacité à confirmer' };
}

function hostingAmenityStatus(resource = {}, key = '') {
  const details = resource.details && typeof resource.details === 'object' ? resource.details : {};
  const value = resource[key] ?? resource[`hosting_${key}`] ?? details[key] ?? details[`hosting_${key}`];
  const normalized = normalizeYesNo(value);
  if (normalized !== null) return normalized;
  const type = String(resource.type || '');
  if (key === 'sanitary' && isHostingCandidateType(type)) return true;
  if (key === 'heating') {
    if (type === 'stade') return false;
    if (isHostingCandidateType(type)) return true;
  }
  if (key === 'parking' && ['complexe_sportif', 'salle_omnisports', 'palais_congres', 'stade', 'lycee', 'college', 'universite'].includes(type)) return true;
  if (key === 'accessibility') {
    if (normalizeYesNo(resource.wheelchair ?? details.wheelchair) === true) return true;
    if (['palais_congres', 'salle_omnisports', 'complexe_sportif', 'centre_culturel', 'lycee', 'college', 'universite'].includes(type)) return 'probable';
  }
  return null;
}

function buildHostingProfile(resource = {}) {
  const type = String(resource.type || '');
  if (!isHostingCandidateType(type)) return null;
  const capacity = estimateHostingCapacity(resource);
  return {
    capacity: capacity.value,
    capacityLabel: capacity.label,
    capacitySource: resource.capacity_source || capacity.source,
    surfaceM2: Number(resource.surface_m2) || null,
    accessibility: hostingAmenityStatus(resource, 'accessibility'),
    sanitary: hostingAmenityStatus(resource, 'sanitary'),
    heating: hostingAmenityStatus(resource, 'heating'),
    parking: hostingAmenityStatus(resource, 'parking'),
    isSchool: SCHOOL_HOSTING_TYPES.has(type),
  };
}

function hostingMatchesAdvancedFilters(resource = {}) {
  const profile = buildHostingProfile(resource);
  if (!profile) return false;
  const minCapacity = Number(document.getElementById('filter-resources-hosting-capacity')?.value || 0);
  if (Number.isFinite(minCapacity) && minCapacity > 0 && (!profile.capacity || profile.capacity < minCapacity)) return false;
  const minSurface = Number(document.getElementById('filter-resources-hosting-surface')?.value || 0);
  if (Number.isFinite(minSurface) && minSurface > 0 && (!profile.surfaceM2 || profile.surfaceM2 < minSurface)) return false;
  const accessibility = document.getElementById('filter-resources-hosting-accessibility')?.value || 'all';
  if (accessibility === 'accessible' && !(profile.accessibility === true || profile.accessibility === 'probable' || profile.accessibility === 'limited')) return false;
  if ((document.getElementById('filter-resources-hosting-sanitary')?.checked ?? false) && profile.sanitary !== true) return false;
  if ((document.getElementById('filter-resources-hosting-heating')?.checked ?? false) && profile.heating !== true) return false;
  if ((document.getElementById('filter-resources-hosting-parking')?.checked ?? false) && !(profile.parking === true || profile.parking === 'probable')) return false;
  return true;
}

function formatHostingDetailsHtml(resource = {}) {
  const profile = buildHostingProfile(resource);
  if (!profile) return '';
  const capacity = profile.capacityLabel || (profile.capacity ? `${Number(profile.capacity).toLocaleString('fr-FR')} pers.` : 'à confirmer');
  const surface = profile.surfaceM2 ? `Surface ${Number(profile.surfaceM2).toLocaleString('fr-FR')} m²` : '';
  const chips = [
    `<span class="hosting-chip hosting-chip--ok">Capacité ${escapeHtml(capacity)}</span>`,
    `<span class="hosting-chip ${profile.accessibility ? 'hosting-chip--ok' : 'hosting-chip--warn'}">PMR ${escapeHtml(yesNoLabel(profile.accessibility, { unknown: 'à vérifier', yes: 'oui', no: 'non' }))}</span>`,
    `<span class="hosting-chip ${profile.sanitary === true ? 'hosting-chip--ok' : 'hosting-chip--warn'}">Sanitaires ${escapeHtml(yesNoLabel(profile.sanitary, { unknown: 'à vérifier', yes: 'oui', no: 'non' }))}</span>`,
    `<span class="hosting-chip ${profile.heating === true ? 'hosting-chip--ok' : 'hosting-chip--warn'}">Chauffage ${escapeHtml(yesNoLabel(profile.heating, { unknown: 'à vérifier', yes: 'oui', no: 'non' }))}</span>`,
    `<span class="hosting-chip ${profile.parking === true ? 'hosting-chip--ok' : 'hosting-chip--warn'}">Parking ${escapeHtml(yesNoLabel(profile.parking, { unknown: 'à vérifier', yes: 'oui', no: 'non' }))}</span>`,
  ].join('');
  const note = [profile.capacitySource, surface, profile.isSchool ? 'ERP scolaire: accord commune/établissement à valider avant ouverture accueil.' : 'Lieu d’accueil: à confirmer avec la commune avant activation.']
    .filter(Boolean)
    .join(' · ');
  return `<div class="hosting-details"><div class="hosting-details__chips">${chips}</div><div class="hosting-details__note">${escapeHtml(note)}</div></div>`;
}

async function loadFinessIsereResources() {
  if (finessLoaded) return finessPointsCache;
  // Cache localStorage valide (7j) — affichage immédiat, ne charger que si non vide
  const cached = readFreshSnapshot(STORAGE_KEYS.staticFinessCache, STATIC_POINTS_CACHE_TTL_MS);
  if (Array.isArray(cached) && cached.length > 0) {
    finessPointsCache = cached;
    finessTypeCounts = computeFinessTypeCounts(finessPointsCache);
    rebuildFinessMetaFromCache();
    syncFinessHealthFilterOptions();
    finessLoaded = true;
    return finessPointsCache;
  }
  let backendPending = false;
  try {
    // Cache 10 min — le CSV FINESS met ~30s à charger la 1ère fois; évite les appels répétés
    const payload = await api('/api/finess/isere/resources?limit=20000', { cacheTtlMs: 10 * 60 * 1000 });
    const resources = Array.isArray(payload?.resources) ? payload.resources : [];
    backendPending = resources.length === 0 && payload?.status !== 'online';
    const dynamicTypeMeta = new Map();
    FINESS_DYNAMIC_RESOURCE_TYPES.clear();
    finessPointsCache = resources
      .map((resource) => {
        const lat = Number(resource?.lat);
        const lon = Number(resource?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        const rawType = String(resource?.type || '').trim().toLowerCase();
        const category = String(resource?.category || '').trim() || 'Établissement FINESS';
        const type = rawType || `finess_${slugifyFinessCategory(category)}`;
        const healthKind = String(resource?.health_kind || '').trim().toLowerCase();
        const healthCategory = String(resource?.health_category || '').trim();
        const meta = buildFinessResourceMeta(type, category, healthKind, healthCategory);
        dynamicTypeMeta.set(type, meta);
        return {
          id: String(resource?.id || `finess-${resource?.finess_id || Math.random().toString(36).slice(2)}`),
          name: String(resource?.name || 'Établissement FINESS'),
          type,
          lat,
          lon,
          active: true,
          address: String(resource?.address || resource?.city || 'Adresse non renseignée'),
          priority: String(resource?.priority || inferFinessPriority(healthKind || type)),
          info: String(resource?.info || `Source FINESS data.gouv.fr · ${meta.label}${healthCategory ? ` · ${healthCategory}` : ''}`),
          category: meta.label,
          health_kind: healthKind,
          health_category: healthCategory,
          source: String(resource?.source || 'https://www.data.gouv.fr/fr/datasets/finess-extraction-du-fichier-des-etablissements/'),
          details: resource?.details && typeof resource.details === 'object' ? resource.details : null,
          dynamic: true,
        };
      })
      .filter(Boolean);
    finessTypeCounts = computeFinessTypeCounts(finessPointsCache);
    dynamicTypeMeta.forEach((meta, type) => {
      RESOURCE_TYPE_META[type] = meta;
      if (!HEALTH_RESOURCE_TYPES.has(type)) FINESS_DYNAMIC_RESOURCE_TYPES.add(type);
    });
    syncFinessHealthFilterOptions();
    // Ne sauvegarder en localStorage que si on a de vraies données
    if (finessPointsCache.length > 0) {
      saveSnapshot(STORAGE_KEYS.staticFinessCache, finessPointsCache);
    }
  } catch {
    const staleCached = readSnapshot(STORAGE_KEYS.staticFinessCache);
    finessPointsCache = Array.isArray(staleCached) ? staleCached : [];
    finessTypeCounts = computeFinessTypeCounts(finessPointsCache);
    rebuildFinessMetaFromCache();
    syncFinessHealthFilterOptions();
  }
  if (finessPointsCache.length > 0) {
    finessLoaded = true;
    if (finessPointsCache.length > 0) saveSnapshot(STORAGE_KEYS.staticFinessCache, finessPointsCache);
  } else {
    // Données vides : le backend est probablement en train de charger le CSV FINESS
    // Retry progressif : 30s, puis 90s, puis abandon
    finessLoaded = true; // bloquer les appels répétés pendant le délai
    const retryDelay = backendPending ? 30 * 1000 : 90 * 1000;
    setTimeout(async () => {
      finessLoaded = false;
      apiGetCache.delete(getRequestCacheKey('/api/finess/isere/resources?limit=20000', {}));
      _finessLoadInFlight = true;
      await loadFinessIsereResources();
      _finessLoadInFlight = false;
      if (finessPointsCache.length > 0) _drawResourceMarkers();
    }, retryDelay);
  }
  return finessPointsCache;
}

async function loadDaeIsereResources(forceRefresh = false) {
  if (daeLoaded && !forceRefresh) return daePointsCache;
  const cached = forceRefresh ? null : readFreshSnapshot(STORAGE_KEYS.staticDaeCache, STATIC_POINTS_CACHE_TTL_MS);
  if (!forceRefresh && Array.isArray(cached) && cached.length > 0) {
    daePointsCache = cached;
    daeLoaded = true;
    return daePointsCache;
  }
  try {
    const url = `/api/geodae/isere/defibrillators?limit=20000${forceRefresh ? '&refresh=true' : ''}`;
    const payload = await api(url, { cacheTtlMs: forceRefresh ? 0 : 10 * 60 * 1000, bypassCache: forceRefresh });
    const resources = Array.isArray(payload?.resources) ? payload.resources : [];
    daePointsCache = filterIserePoints(resources)
      .map((resource) => {
        const lat = Number(resource?.lat);
        const lon = Number(resource?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          id: String(resource?.id || `geodae-${Math.random().toString(36).slice(2)}`),
          name: String(resource?.name || 'Defibrillateur automatise externe'),
          type: 'defibrillateur',
          lat,
          lon,
          active: true,
          address: String(resource?.address || resource?.city || 'Adresse non renseignee'),
          priority: String(resource?.priority || 'vital'),
          info: String(resource?.info || "Source Geo'DAE data.gouv.fr"),
          source: String(resource?.source || 'https://www.data.gouv.fr/fr/datasets/geodae-base-nationale-des-defibrillateurs/'),
          details: resource?.details && typeof resource.details === 'object' ? resource.details : null,
          dynamic: true,
        };
      })
      .filter(Boolean);
    if (daePointsCache.length > 0) saveSnapshot(STORAGE_KEYS.staticDaeCache, daePointsCache);
  } catch {
    const stale = readSnapshot(STORAGE_KEYS.staticDaeCache);
    daePointsCache = Array.isArray(stale) ? stale : [];
  }
  daeLoaded = true;
  return daePointsCache;
}

function slugifyFinessCategory(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'autre';
}

function inferFinessPriority(type = '') {
  if (['hopital', 'hopital_public', 'hopital_prive', 'chu', 'clinique'].includes(type)) return 'critical';
  if (type === 'medecin') return 'standard';
  return 'vital';
}

function buildFinessResourceMeta(type = '', category = '', healthKind = '', healthCategory = '') {
  const lowerCategory = String(category || '').toLowerCase();
  const lowerHealth = `${String(healthKind || '').toLowerCase()} ${String(healthCategory || '').toLowerCase()}`;
  const label = category || String(type || '').replace(/^finess_/, '').replace(/_/g, ' ').trim() || 'Établissement FINESS';
  let icon = '🏥';
  if (type === 'medecin' || /medecin|médecin|cabinet medical|cabinet de medecine/.test(lowerHealth)) icon = '🩺';
  else if (type === 'chu' || /chu|hospitalier universitaire/.test(lowerHealth)) icon = '🏨';
  else if (type === 'hopital_public' || /hopital public|hôpital public|hospitalisation publique/.test(lowerHealth)) icon = '🏥';
  else if (type === 'hopital_prive' || /hopital prive|hôpital privé|hospitalisation privee/.test(lowerHealth)) icon = '🏥';
  if (type === 'ehpad' || /ehpad|personnes agees|personnes âgées/.test(lowerHealth)) icon = '🧓';
  else if (type === 'clinique' || /clinique|dialyse/.test(lowerHealth)) icon = '🩺';
  else if (type === 'hopital' || /hopital|hôpital|chu|hospitalier/.test(lowerHealth)) icon = '🏥';
  else if (/psy|sante mentale|santé mentale/.test(lowerHealth)) icon = '🧠';
  else if (/handicap|ime|mas|foyer/.test(lowerHealth)) icon = '♿';
  else if (/laboratoire|analyse/.test(lowerHealth)) icon = '🧪';
  else if (/pharmacie/.test(lowerHealth)) icon = '💊';
  else if (/commune/.test(lowerCategory)) icon = '📍';
  return { label, icon };
}

function rebuildFinessMetaFromCache() {
  FINESS_DYNAMIC_RESOURCE_TYPES.clear();
  (finessPointsCache || []).forEach((resource) => {
    const type = String(resource?.type || '').trim().toLowerCase();
    if (!type) return;
    const category = String(resource?.category || '').trim() || 'Établissement FINESS';
    const healthKind = String(resource?.health_kind || '').trim().toLowerCase();
    const healthCategory = String(resource?.health_category || '').trim();
    RESOURCE_TYPE_META[type] = buildFinessResourceMeta(type, category, healthKind, healthCategory);
    if (!HEALTH_RESOURCE_TYPES.has(type)) FINESS_DYNAMIC_RESOURCE_TYPES.add(type);
  });
}

function computeFinessTypeCounts(resources = []) {
  const counts = {};
  (Array.isArray(resources) ? resources : []).forEach((resource) => {
    const type = String(resource?.type || '').trim().toLowerCase();
    if (!type) return;
    counts[type] = (counts[type] || 0) + 1;
  });
  return counts;
}

function syncFinessHealthFilterOptions() {
  const select = document.getElementById('filter-resources-health-type');
  if (!select) return;
  const previous = select.value || 'all';
  const values = new Set(['all']);
  const urgentCount = [...HEALTH_URGENT_CARE_TYPES].reduce((sum, type) => sum + Number(finessTypeCounts[type] || 0), 0);
  const ehpadCount = Number(finessTypeCounts.ehpad || 0);
  const prioritizedOptions = [
    { type: 'health_urgent_care', label: 'Lieux de soins d’urgence (CHU, hôpitaux, cliniques)', total: urgentCount },
    { type: 'ehpad', label: 'EHPAD', total: ehpadCount },
  ];
  prioritizedOptions.forEach((option) => values.add(option.type));
  const dynamicOptions = [];
  const seenLabels = new Set();
  const types = [...HEALTH_RESOURCE_TYPES, ...FINESS_DYNAMIC_RESOURCE_TYPES];
  const skippedTypes = new Set([...HEALTH_URGENT_CARE_TYPES, 'ehpad']);
  types.forEach((type) => {
    if (skippedTypes.has(type)) return;
    const meta = RESOURCE_TYPE_META[type];
    if (!meta) return;
    if (seenLabels.has(meta.label)) return;
    seenLabels.add(meta.label);
    values.add(type);
    dynamicOptions.push({ type, label: meta.label, total: Number(finessTypeCounts[type] || 0) });
  });
  dynamicOptions.sort((a, b) => a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' }));
  select.innerHTML = [
    ...prioritizedOptions.map((option) => `<option value="${escapeHtml(option.type)}">${escapeHtml(option.label)} (${option.total})</option>`),
    '<option value="all">Toutes les catégories stratégiques FINESS (Isère)</option>',
    ...dynamicOptions.map((option) => `<option value="${escapeHtml(option.type)}">${escapeHtml(option.label)} (${option.total})</option>`),
  ].join('');
  select.value = values.has(previous) ? previous : 'all';
}

function formatFinessDetailsHtml(resource = {}) {
  const details = resource?.details && typeof resource.details === 'object' ? resource.details : null;
  if (!details) return '';
  const entries = [
    ['FINESS ET', details.finess_et],
    ['FINESS EJ', details.finess_ej],
    ['SIRET', details.siret],
    ['Téléphone', details.telephone],
    ['Fax', details.fax],
    ['Catégorie', details.categorie_libelle || details.categorie_code],
    ['Agrégat', details.categorie_agregat_code],
    ['Statut', details.statut_juridique_libelle || details.statut_juridique_code],
    ['Type', details.type_etablissement_libelle || details.type_etablissement_code],
    ['Code commune', details.code_commune],
    ['Date ouverture', details.date_ouverture],
    ['Date autorisation', details.date_autorisation],
    ['Date maj FINESS', details.date_maj],
  ]
    .filter(([, value]) => String(value || '').trim())
    .map(([label, value]) => `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(String(value))}</li>`)
    .join('');
  return entries ? `<ul class="popup-details-list">${entries}</ul>` : '';
}

function formatDaeDetailsHtml(resource = {}) {
  if (String(resource?.type || '') !== 'defibrillateur') return '';
  const details = resource?.details && typeof resource.details === 'object' ? resource.details : {};
  const access24h = details.access_24h === true ? 'Oui' : details.access_24h === false ? 'Non' : '';
  const entries = [
    ['Commune', details.commune],
    ['Acces', details.access_type],
    ['Accessible 24h/24', access24h],
    ['Jours', details.available_days],
    ['Horaires', details.available_hours],
    ['Emplacement', details.access_detail],
    ['Etage', details.floor],
    ['Etat', details.state],
    ['Fonctionnement', resource.info],
    ['Derniere maintenance', details.last_maintenance],
    ['MAJ donnees', details.data_updated_at],
    ['Exploitant', details.operator],
  ]
    .filter(([, value]) => String(value || '').trim())
    .map(([label, value]) => `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(String(value))}</li>`)
    .join('');
  return entries ? `<ul class="popup-details-list">${entries}</ul>` : '';
}

async function loadIserePopulationPoints() {
  if (iserePopulationLoaded) return iserePopulationPointsCache;
  try {
    const response = await queueApiRequest(() => fetchWithTimeout('https://geo.api.gouv.fr/departements/38/communes?fields=nom,population,centre&format=json'));
    const payload = await parseJsonResponse(response, 'geo-api-population');
    const rows = Array.isArray(payload) ? payload : [];
    iserePopulationPointsCache = rows
      .map((row) => {
        const coordinates = row?.centre?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length !== 2) return null;
        const [lon, lat] = coordinates;
        const population = Number(row?.population || 0);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(population)) return null;
        return {
          name: String(row?.nom || 'Commune'),
          population,
          lat,
          lon,
        };
      })
      .filter(Boolean);
  } catch {
    iserePopulationPointsCache = [];
  }
  iserePopulationLoaded = true;
  return iserePopulationPointsCache;
}

function populationColor(population = 0) {
  if (population >= 50000) return '#7f0000';
  if (population >= 20000) return '#b30000';
  if (population >= 10000) return '#e34a33';
  if (population >= 5000) return '#fc8d59';
  return '#fdcc8a';
}

function populationRadius(population = 0) {
  if (population >= 100000) return 16;
  if (population >= 50000) return 14;
  if (population >= 20000) return 12;
  if (population >= 10000) return 10;
  return 8;
}

async function renderPopulationByCityLayer() {
  if (!populationLayer) return;
  populationLayer.clearLayers();
  const enabled = (document.getElementById('map-basemap-select')?.value || 'osm') === 'population';
  if (!enabled) return;
  const points = await loadIserePopulationPoints();
  points.forEach((point) => {
    window.L.circleMarker([point.lat, point.lon], {
      radius: populationRadius(point.population),
      color: '#fff',
      weight: 1,
      fillColor: populationColor(point.population),
      fillOpacity: 0.72,
    })
      .bindPopup(`<strong>${escapeHtml(point.name)}</strong><br>Population légale INSEE: ${Number(point.population).toLocaleString('fr-FR')}`)
      .addTo(populationLayer);
  });
}

// Bbox stricte du département Isère — filtre tout point hors département
const ISERE_BBOX = { latMin: 44.70, latMax: 45.95, lonMin: 4.70, lonMax: 6.60 };
function filterIserePoints(points) {
  if (!Array.isArray(points)) return [];
  return points.filter((p) => {
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    return lat >= ISERE_BBOX.latMin && lat <= ISERE_BBOX.latMax
        && lon >= ISERE_BBOX.lonMin && lon <= ISERE_BBOX.lonMax;
  });
}

function isVerifiedHostingResource(resource = {}) {
  const source = String(resource.source || resource.verified_source || resource.info || '').toLowerCase();
  return Boolean(resource.verified) || source.includes('data es') || source.includes('data.education.gouv.fr') || source.includes('sports');
}

async function loadVerifiedHostingIsere() {
  if (verifiedHostingLoaded) return verifiedHostingPointsCache;
  try {
    const payload = await api('/api/hosting/isere/verified?limit=2000', { cacheTtlMs: 24 * 60 * 60 * 1000 });
    verifiedHostingPointsCache = filterIserePoints(Array.isArray(payload?.points) ? payload.points : [])
      .filter((point) => HOSTING_RESOURCE_TYPES.has(String(point.type || '')))
      .map((point) => ({ ...point, verified: true, dynamic: true }));
  } catch {
    verifiedHostingPointsCache = [];
  }
  verifiedHostingLoaded = true;
  return verifiedHostingPointsCache;
}

async function loadIsereInstitutions() {
  if (institutionsLoaded) return institutionPointsCache;

  // 1. Cache localStorage valide (24h) avec données réelles
  const cached = readFreshSnapshot(STORAGE_KEYS.staticInstitutionsCache, STATIC_POINTS_CACHE_TTL_MS);
  const filteredCached = filterIserePoints(cached);
  const hasCritical = filteredCached.some((p) => ['ecole_primaire', 'caserne_pompier', 'gendarmerie', 'police_municipale', 'commissariat_police_nationale'].includes(p.type));
  const hasHosting = filteredCached.some((p) => ['gymnase', 'complexe_sportif', 'salle_omnisports', 'centre_culturel', 'salle_spectacle_public', 'palais_congres', 'salle_fetes'].includes(p.type));
  const cacheIsUsable = filteredCached.length >= 20 && hasCritical && hasHosting;
  if (cacheIsUsable) {
    institutionPointsCache = filteredCached;
    institutionsLoaded = true;
    return institutionPointsCache;
  }

  // 2. Stale cache → affichage immédiat pendant que le backend charge
  const staleImmediate = filterIserePoints(readSnapshot(STORAGE_KEYS.staticInstitutionsCache));
  if (staleImmediate.length > 0) {
    institutionPointsCache = staleImmediate;
    _drawResourceMarkers();
  }

  // 3. Appel backend /api/institutions/isere (Overpass côté serveur, cache 24h)
  try {
    const payload = await api('/api/institutions/isere', { cacheTtlMs: 24 * 60 * 60 * 1000 });
    const points = filterIserePoints(Array.isArray(payload?.points) ? payload.points : []);
    if (points.length > 0) {
      institutionPointsCache = points;
      saveSnapshot(STORAGE_KEYS.staticInstitutionsCache, points);
      institutionsLoaded = true;
      return institutionPointsCache;
    }
  } catch { /* backend indisponible → fallback stale */ }

  // 4. Fallback : stale cache ou retry dans 60s
  institutionsLoaded = true;
  setTimeout(async () => {
    institutionsLoaded = false;
    _institutionsLoadInFlight = true;
    await loadIsereInstitutions();
    _institutionsLoadInFlight = false;
    _drawResourceMarkers();
  }, 60 * 1000);

  return institutionPointsCache;
}


function parseTelecomGenerations(value = '') {
  const text = String(value || '').toLowerCase();
  const generations = new Set();
  if (text.includes('5g') || text.includes('nr')) generations.add('5G');
  if (text.includes('4g') || text.includes('lte')) generations.add('4G');
  if (text.includes('3g') || text.includes('umts')) generations.add('3G');
  if (text.includes('2g') || text.includes('gsm')) generations.add('2G');
  return Array.from(generations);
}

function buildTelecomWhiteZoneResources(anfrResources = [], arcepResources = []) {
  const antennas = Array.isArray(anfrResources) ? anfrResources : [];
  const outages = Array.isArray(arcepResources) ? arcepResources : [];
  return ISERE_MAJOR_CITIES
    .filter((city) => Number(city.population || 0) >= 3000 || ['bourg-oisans', 'la-mure', 'mens'].includes(city.key))
    .map((city) => {
      const nearestAntennaKm = antennas.reduce((best, antenna) => {
        const distance = _haversineKm(Number(city.lat), Number(city.lon), Number(antenna.lat), Number(antenna.lon));
        return Number.isFinite(distance) ? Math.min(best, distance) : best;
      }, Infinity);
      const outagesNearby = outages.filter((outage) => {
        const distance = _haversineKm(Number(city.lat), Number(city.lon), Number(outage.lat), Number(outage.lon));
        return Number.isFinite(distance) && distance <= 4;
      });
      const remoteSector = nearestAntennaKm > 7;
      const degradedSector = outagesNearby.length >= 2;
      if (!remoteSector && !degradedSector) return null;
      const distanceLabel = Number.isFinite(nearestAntennaKm) ? `${nearestAntennaKm.toFixed(1)} km` : 'aucune antenne détectée';
      return {
        id: `white-zone-${city.key}`,
        name: `Zone blanche à vérifier · ${city.name}`,
        type: 'telecom_white_zone',
        lat: city.lat,
        lon: city.lon,
        active: true,
        address: city.name,
        priority: degradedSector ? 'critical' : 'risk',
        info: `Signal opérationnel à contrôler : antenne ANFR la plus proche ${distanceLabel}${degradedSector ? ` · ${outagesNearby.length} site(s) ARCEP indisponible(s) à moins de 4 km` : ''}.`,
        source: 'Analyse locale OPE-Protec depuis ANFR + ARCEP',
        dynamic: true,
      };
    })
    .filter(Boolean);
}

async function loadTelecomPoints() {
  if (telecomLoaded) return telecomPointsCache;

  // Vérifier le cache localStorage en premier (24h) pour un affichage immédiat
  const cached = readFreshSnapshot(STORAGE_KEYS.staticTelecomCache, TELECOM_POINTS_CACHE_TTL_MS);
  if (Array.isArray(cached) && cached.length > 0) {
    telecomPointsCache = cached;
    telecomLoaded = true;
    return telecomPointsCache;
  }

  let anfrPending = false;
  try {
    // Cache court (2 min) pour permettre les nouvelles tentatives rapides si les données sont en attente
    const payload = await api('/external/isere/risks', { cacheTtlMs: 2 * 60 * 1000 });
    const anfrData = payload?.anfr_isere || {};
    anfrPending = anfrData?.status === 'pending' && !Array.isArray(anfrData?.supports_points);
    const anfrPoints = Array.isArray(anfrData?.supports_points) ? anfrData.supports_points : [];
    const arcepPoints = Array.isArray(payload?.arcep_isere?.outages_points) ? payload.arcep_isere.outages_points : [];

    const anfrResources = anfrPoints.map((point) => {
      const lat = Number(point?.lat);
      const lon = Number(point?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const supportId = String(point?.id || '').trim();
      const stationName = String(point?.station_name || '').trim();
      const operator = String(point?.operator || 'non renseigné (ANFR)').trim();
      const availableData = Array.isArray(point?.data_services) ? point.data_services.map((item) => String(item || '').trim()).filter(Boolean) : [];
      const availableVoice = String(point?.voice_service || (availableData.length ? 'possible selon opérateur' : 'inconnu')).trim();
      const dataLabel = availableData.length ? availableData.join(', ') : 'inconnue';
      return {
        id: `anfr-${supportId || Math.random().toString(36).slice(2)}`,
        name: stationName || `Support ANFR ${supportId || ''}`.trim(),
        type: 'anfr_antenna',
        lat,
        lon,
        active: true,
        address: 'Isère (38)',
        priority: 'standard',
        info: `Support ANFR ${supportId || '-'} · opérateur ${operator} · voix ${availableVoice} · data ${dataLabel}`,
        source: 'https://www.data.gouv.fr/fr/datasets/donnees-sur-les-installations-radioelectriques-de-plus-de-5-watts-1/',
        dynamic: true,
      };
    }).filter(Boolean);

    const arcepResources = arcepPoints.map((point) => {
      const lat = Number(point?.lat);
      const lon = Number(point?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const commune = String(point?.commune || '').trim() || 'Commune non renseignée';
      const operator = String(point?.operator || 'inconnu').trim();
      const dataState = String(point?.data || '-').trim();
      const voiceState = String(point?.voice || '-').trim();
      const impactedGenerations = parseTelecomGenerations(dataState);
      const generationsLabel = impactedGenerations.length ? impactedGenerations.join(', ') : 'non précisé';
      const id = String(point?.id || '').trim();
      return {
        id: `arcep-${id || Math.random().toString(36).slice(2)}`,
        name: `Site mobile indisponible · ${commune}`,
        type: 'arcep_mobile_outage',
        lat,
        lon,
        active: true,
        address: commune,
        priority: 'critical',
        info: `Opérateur ${operator} · voix ${voiceState} · data ${dataState} (2G/3G/4G/5G: ${generationsLabel})`,
        source: 'https://www.data.gouv.fr/fr/datasets/sites-indisponibles/',
        dynamic: true,
      };
    }).filter(Boolean);

    const whiteZoneResources = buildTelecomWhiteZoneResources(anfrResources, arcepResources);
    telecomPointsCache = [...anfrResources, ...arcepResources, ...whiteZoneResources];

    // Sauvegarder en localStorage uniquement si on a de vraies données
    if (telecomPointsCache.length > 0) {
      saveSnapshot(STORAGE_KEYS.staticTelecomCache, telecomPointsCache);
    }
  } catch {
    telecomPointsCache = [];
  }

  // Si on a des données, terminé
  if (telecomPointsCache.length > 0) {
    telecomLoaded = true;
    return telecomPointsCache;
  }

  // Fallback sur le cache périmé si disponible
  const stale = readSnapshot(STORAGE_KEYS.staticTelecomCache);
  if (Array.isArray(stale) && stale.length > 0) {
    telecomPointsCache = stale;
    telecomLoaded = true;
    return telecomPointsCache;
  }

  // Si le backend charge encore les données ANFR, planifier une nouvelle tentative automatique
  if (anfrPending) {
    setTimeout(async () => {
      telecomLoaded = false;
      apiGetCache.delete(getRequestCacheKey('/external/isere/risks', {}));
      _telecomLoadInFlight = true;
      await loadTelecomPoints();
      _telecomLoadInFlight = false;
      if (telecomPointsCache.length > 0) _drawResourceMarkers();
    }, 3 * 60 * 1000);
  } else {
    telecomLoaded = true;
  }

  return telecomPointsCache;
}

function getDisplayedResources() {
  const query = (document.getElementById('map-search')?.value || '').trim().toLowerCase();
  const hostingStatic = [];
  const allStaticPoints = RESOURCE_POINTS.filter((resource) => !HOSTING_RESOURCE_TYPES.has(String(resource.type || '')));
  const staticResources = allStaticPoints
    .filter((r) => r.active)
    .filter((r) => resourceVisibilityOverrides.get(r.id) !== false)
    .filter((r) => shouldDisplayBaseResourceType(r.type, r))
    .filter((r) => !query || `${r.name} ${r.address}`.toLowerCase().includes(query))
    .map((r) => ({ ...r, dynamic: false }));
  const osmNonHostingInstitutions = institutionPointsCache.filter((r) => !HOSTING_RESOURCE_TYPES.has(String(r.type || '')));
  const dynamicResources = [...osmNonHostingInstitutions, ...verifiedHostingPointsCache, ...finessPointsCache, ...daePointsCache, ...telecomPointsCache]
    .filter((r) => r.type)
    // Exclure les doublons avec les données statiques hébergement (même id)
    .filter((r) => !hostingStatic.some((h) => h.id === r.id))
    .filter((r) => !HOSTING_RESOURCE_TYPES.has(String(r.type || '')) || isVerifiedHostingResource(r))
    .filter((r) => shouldDisplayBaseResourceType(r.type, r))
    .filter((r) => resourceVisibilityOverrides.get(r.id) !== false)
    .filter((r) => !query || `${r.name} ${r.address}`.toLowerCase().includes(query));
  const customSensible = (Array.isArray(mapPoints) ? mapPoints : [])
    .filter((p) => p.category === 'site_sensible' && mapPointVisibilityOverrides.get(p.id) !== false)
    .filter((p) => !query || p.name.toLowerCase().includes(query))
    .map((p) => ({ id: p.id, name: p.name, type: 'site_sensible_custom', active: true, lat: p.lat, lon: p.lon, address: `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`, priority: 'risk', info: p.notes || '', source: '', dynamic: false }))
    .filter((p) => shouldDisplayBaseResourceType('site_sensible_custom'));
  return [...staticResources, ...dynamicResources, ...customSensible];
}

function getResourcesForZoneImpact() {
  const hostingStatic = [];
  const staticResources = RESOURCE_POINTS
    .filter((resource) => resource.active)
    .filter((resource) => !HOSTING_RESOURCE_TYPES.has(String(resource.type || '')))
    .map((resource) => ({ ...resource, dynamic: false }));
  const osmNonHostingInstitutions = institutionPointsCache.filter((r) => !HOSTING_RESOURCE_TYPES.has(String(r.type || '')));
  const dynamicResources = [...osmNonHostingInstitutions, ...verifiedHostingPointsCache, ...finessPointsCache, ...daePointsCache, ...telecomPointsCache]
    .filter((r) => !hostingStatic.some((h) => h.id === r.id));
  return [...staticResources, ...dynamicResources];
}


function syncTelecomFilterState() {
  const telecomToggle = document.getElementById('filter-resources-telecom');
  const telecomTypeFilter = document.getElementById('filter-resources-telecom-type');
  if (!telecomTypeFilter) return;
  telecomTypeFilter.disabled = !(telecomToggle?.checked);
  if (!telecomToggle?.checked) telecomTypeFilter.value = 'all';
}

// ─── Flags anti double-lancement des loaders statiques ───────────────────────
let _institutionsLoadInFlight = false;
let _finessLoadInFlight = false;
let _daeLoadInFlight = false;
let _lastDaeRefreshAttempt = 0;
let _telecomLoadInFlight = false;

/** Retourne true si au moins un loader de données statiques est encore en cours. */
function _staticDataLoading() {
  return _institutionsLoadInFlight || _finessLoadInFlight || _daeLoadInFlight || _telecomLoadInFlight;
}

/**
 * Rendu synchrone des ressources depuis le cache actuel.
 * N'attend aucune requête réseau. Appelée dès que le cache change.
 */
function _drawResourceMarkers() {
  syncFinessHealthFilterOptions();
  const resources = getDisplayedResources();
  const priorityLabel = { critical: 'critique', vital: 'vital', risk: 'à risque', standard: 'standard' };
  const markerColor = { critical: '#e03131', vital: '#1971c2', risk: '#f08c00', standard: '#2f9e44' };

  let emptyMsg = '<li>Aucune ressource avec ces filtres.</li>';
  if (resources.length === 0 && _staticDataLoading()) {
    emptyMsg = '<li class="muted">⏳ Chargement des données en cours… les points apparaîtront automatiquement.</li>';
  }

  setHtml('resources-list', resources.map((r) => {
    const typeKey = String(r.type || '');
    const meta = RESOURCE_TYPE_META[typeKey] || { label: typeKey.replace(/_/g, ' ') || 'Inconnu', icon: '📍' };
    const statusLabel = r.active ? 'affichée' : 'masquée';
    const toggleButton = r.dynamic ? '' : `<button type="button" class="ghost" data-resource-toggle="${escapeHtml(r.id)}">${r.active ? 'Masquer' : 'Afficher'}</button>`;
    return `<li>
      <strong>${meta.icon} ${r.name}</strong> · ${r.address}<br/>
      <span class="muted">${meta.label} · ${statusLabel} · ${priorityLabel[r.priority] || 'standard'}</span><br/>
      <span class="muted">${escapeHtml(r.info || 'Aucune information complémentaire.')}</span><br/>
      ${formatHostingDetailsHtml(r)}
      ${formatDaeDetailsHtml(r)}
      <a href="${escapeHtml(r.source || '#')}" target="_blank" rel="noreferrer">Source</a>
      ${toggleButton}
    </li>`;
  }).join('') || emptyMsg);

  mapStats.resources = resources.length;
  updateMapSummary();
  if (!resourceLayer) return;
  resourceLayer.clearLayers();
  resources.forEach((r) => {
    const coords = normalizeMapCoordinates(r.lat, r.lon);
    if (!coords) return;
    const typeKey = String(r.type || '');
    const meta = RESOURCE_TYPE_META[typeKey] || { label: typeKey.replace(/_/g, ' ') || 'Inconnu', icon: '📍' };
    let markerHtml;
    if (typeKey === 'protection_civile') {
      markerHtml = `<div style="background:linear-gradient(145deg,#1a3568,#0f2240);width:28px;height:28px;border-radius:50%;display:grid;place-items:center;box-shadow:0 1px 4px rgba(0,0,0,.45);"><div style="width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:12px solid #f07800;margin-top:2px;"></div></div>`;
    } else {
      markerHtml = `<span class="map-resource-icon" style="background:${markerColor[r.priority] || '#2f9e44'}">${meta.icon}</span>`;
    }
    const stationTimetableHtml = typeKey === 'transport_gare_sncf' ? stationPopupTimetableHtml(r.name) : '';
    window.L.marker([coords.lat, coords.lon], {
      icon: window.L.divIcon({ className: 'map-resource-icon-wrap', html: markerHtml, iconSize: [24, 24], iconAnchor: [12, 12] }),
    })
      .bindPopup(`<strong>${meta.icon} ${r.name}</strong><br>Type: ${meta.label}<br>Niveau: ${priorityLabel[r.priority] || 'standard'}<br>Adresse: ${r.address}<br>${escapeHtml(r.info || '')}${formatHostingDetailsHtml(r)}${formatFinessDetailsHtml(r)}${formatDaeDetailsHtml(r)}${stationTimetableHtml}<br><a href="${escapeHtml(r.source || '#')}" target="_blank" rel="noreferrer">Source publique</a>`)
      .addTo(resourceLayer);
  });

  if (resources.length > 0) {
    setMapFeedback(`${resources.length} ressource(s) affichée(s).`);
  } else if (_staticDataLoading()) {
    setMapFeedback('Chargement des données cartographiques en cours…');
  } else {
    setMapFeedback('Aucune ressource avec ces filtres.');
  }
}

/**
 * Lance les loaders statiques (institutions, FINESS, télécom) en arrière-plan.
 * Chaque loader, une fois terminé, redessine les marqueurs automatiquement.
 * Anti-doublon : jamais deux chargements simultanés du même dataset.
 */
// ── Refuges de montagne (OSM) ───────────────────────────────────────────────
let montagnePointsCache = [];
let montagneLoaded = false;
let _montagneLoadInFlight = false;
let helipadPointsCache = [];
let helipadLoaded = false;
let _helipadLoadInFlight = false;
let barragePointsCache = [];
let barrageLoaded = false;
let _barrageLoadInFlight = false;

async function loadMontagnePoints() {
  if (montagneLoaded) return montagnePointsCache;
  try {
    const payload = await api('/api/osm/isere/montagne', { cacheTtlMs: 24 * 60 * 60 * 1000 });
    montagnePointsCache = Array.isArray(payload?.points) ? payload.points : [];
  } catch {
    montagnePointsCache = [];
  }
  montagneLoaded = true;
  return montagnePointsCache;
}

async function loadHelipadPoints() {
  if (helipadLoaded) return helipadPointsCache;
  try {
    const payload = await api('/api/osm/isere/helipads', { cacheTtlMs: 24 * 60 * 60 * 1000 });
    helipadPointsCache = Array.isArray(payload?.points) ? payload.points : [];
  } catch {
    helipadPointsCache = [];
  }
  helipadLoaded = true;
  return helipadPointsCache;
}

function renderMontagneLayer() {
  if (!montagneLayer || !leafletMap) return;
  const enabled = document.getElementById('filter-montagne')?.checked ?? false;
  if (!enabled) {
    if (leafletMap.hasLayer(montagneLayer)) leafletMap.removeLayer(montagneLayer);
    return;
  }
  if (!leafletMap.hasLayer(montagneLayer)) montagneLayer.addTo(leafletMap);
  montagneLayer.clearLayers();
  montagnePointsCache.forEach((pt) => {
    const emoji = pt.type === 'rescue' ? '🆘' : pt.type === 'shelter' ? '⛺' : '🛖';
    const icon = window.L.divIcon({
      className: '',
      html: `<span style="font-size:20px;line-height:1;filter:drop-shadow(0 1px 2px #0006)">${emoji}</span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    const capacityStr = pt.capacity ? ` · ${pt.capacity} places` : '';
    const eleStr = pt.ele ? ` · ${pt.ele} m` : '';
    const operatorStr = pt.operator ? `<br>Gestionnaire : ${escapeHtml(pt.operator)}` : '';
    const popup = `<strong>${escapeHtml(pt.name)}</strong><br>Type : ${escapeHtml(pt.type)}${eleStr}${capacityStr}${operatorStr}<br><a href="https://www.openstreetmap.org/${pt.osmType}/${pt.osmId}" target="_blank" rel="noreferrer">OpenStreetMap</a>`;
    window.L.marker([pt.lat, pt.lon], { icon }).bindPopup(popup).addTo(montagneLayer);
  });
  setMapFeedback(`${montagnePointsCache.length} refuge(s) / site(s) montagne chargé(s).`);
}

function renderHelipadLayer() {
  if (!helipadLayer || !leafletMap) return;
  const enabled = document.getElementById('filter-helipads')?.checked ?? false;
  if (!enabled) {
    if (leafletMap.hasLayer(helipadLayer)) leafletMap.removeLayer(helipadLayer);
    return;
  }
  if (!leafletMap.hasLayer(helipadLayer)) helipadLayer.addTo(leafletMap);
  helipadLayer.clearLayers();
  helipadPointsCache.forEach((pt) => {
    const emoji = pt.aeroway === 'helipad' ? '🚁' : '✈️';
    const icon = window.L.divIcon({
      className: '',
      html: `<span style="font-size:20px;line-height:1;filter:drop-shadow(0 1px 2px #0006)">${emoji}</span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    const smurBadge = pt.smur ? ' <span style="color:#c62828;font-weight:700">[SMUR/SAMU]</span>' : '';
    const icaoStr = pt.icao ? `<br>Code OACI : ${escapeHtml(pt.icao)}` : '';
    const operatorStr = pt.operator ? `<br>Opérateur : ${escapeHtml(pt.operator)}` : '';
    const popup = `<strong>${escapeHtml(pt.name)}</strong>${smurBadge}<br>Type : ${escapeHtml(pt.aeroway)}${icaoStr}${operatorStr}<br><a href="https://www.openstreetmap.org/${pt.osmType}/${pt.osmId}" target="_blank" rel="noreferrer">OpenStreetMap</a>`;
    window.L.marker([pt.lat, pt.lon], { icon }).bindPopup(popup).addTo(helipadLayer);
  });
  setMapFeedback(`${helipadPointsCache.length} héliport(s) / aérodrome(s) chargé(s).`);
}

function _ensureStaticDataLoaded() {
  if (!leafletMap && !isMapPanelActive()) return;
  if ((!institutionsLoaded || !verifiedHostingLoaded) && !_institutionsLoadInFlight) {
    _institutionsLoadInFlight = true;
    Promise.all([loadIsereInstitutions(), loadVerifiedHostingIsere()])
      .then(() => { _institutionsLoadInFlight = false; _drawResourceMarkers(); })
      .catch(() => { _institutionsLoadInFlight = false; });
  }
  if (!finessLoaded && !_finessLoadInFlight) {
    _finessLoadInFlight = true;
    loadFinessIsereResources()
      .then(() => { _finessLoadInFlight = false; _drawResourceMarkers(); })
      .catch(() => { _finessLoadInFlight = false; });
  }
  const daeFilterEnabled = document.getElementById('filter-resources-dae')?.checked ?? false;
  const shouldRetryDae = daeFilterEnabled && daeLoaded && daePointsCache.length === 0 && (Date.now() - _lastDaeRefreshAttempt > 60 * 1000);
  if ((!daeLoaded || shouldRetryDae) && !_daeLoadInFlight) {
    _daeLoadInFlight = true;
    _lastDaeRefreshAttempt = Date.now();
    loadDaeIsereResources(shouldRetryDae)
      .then(() => { _daeLoadInFlight = false; _drawResourceMarkers(); })
      .catch(() => { _daeLoadInFlight = false; });
  }
  if (!telecomLoaded && !_telecomLoadInFlight) {
    _telecomLoadInFlight = true;
    loadTelecomPoints()
      .then(() => { _telecomLoadInFlight = false; _drawResourceMarkers(); })
      .catch(() => { _telecomLoadInFlight = false; });
  }
  // Chargement différé des couches montagne uniquement si les filtres sont activés
  if (document.getElementById('filter-montagne')?.checked && !montagneLoaded && !_montagneLoadInFlight) {
    _montagneLoadInFlight = true;
    loadMontagnePoints()
      .then(() => { _montagneLoadInFlight = false; renderMontagneLayer(); })
      .catch(() => { _montagneLoadInFlight = false; });
  }
  if (document.getElementById('filter-helipads')?.checked && !helipadLoaded && !_helipadLoadInFlight) {
    _helipadLoadInFlight = true;
    loadHelipadPoints()
      .then(() => { _helipadLoadInFlight = false; renderHelipadLayer(); })
      .catch(() => { _helipadLoadInFlight = false; });
  }
  if (document.getElementById('filter-barrages')?.checked && !barrageLoaded && !_barrageLoadInFlight) {
    _barrageLoadInFlight = true;
    loadBarragePoints()
      .then(() => { _barrageLoadInFlight = false; renderBarrageLayer(); })
      .catch(() => { _barrageLoadInFlight = false; });
  }
  renderColsAlpinsLayer();
}

/**
 * Point d'entrée principal pour afficher les ressources sur la carte.
 * 1. Rendu immédiat depuis le cache (0 ms d'attente pour l'utilisateur).
 * 2. Lance les loaders manquants en arrière-plan — quand ils arrivent,
 *    les marqueurs se mettent à jour automatiquement sans action utilisateur.
 */
function renderResources() {
  _ensureStaticDataLoaded();
  _drawResourceMarkers();
}

function toggleResourceActive(resourceId = '') {
  const resource = RESOURCE_POINTS.find((item) => item.id === resourceId);
  if (!resource) return;
  resource.active = !resource.active;
  renderResources();
}

function tryLocalMapSearch(query = '') {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const municipality = cachedMunicipalities.find((item) => String(item.name || '').toLowerCase().includes(needle));
  if (municipality) {
    const cacheKey = `${municipality.name}|${municipality.postal_code || ''}`;
    const point = geocodeCache.get(cacheKey);
    if (point) return { ...point, label: `${municipality.name} (commune)` };
  }
  const resources = [...RESOURCE_POINTS, ...institutionPointsCache, ...verifiedHostingPointsCache];
  const resource = resources.find((item) => `${item.name} ${item.address}`.toLowerCase().includes(needle));
  if (resource) {
    const coords = normalizeMapCoordinates(resource.lat, resource.lon);
    if (coords) return { ...coords, label: `${resource.name} (${resource.address})` };
  }
  const point = mapPoints.find((item) => String(item.name || '').toLowerCase().includes(needle));
  if (point) {
    const coords = normalizeMapCoordinates(point.lat, point.lon);
    if (coords) return { ...coords, label: `${point.icon || '📍'} ${point.name} (point opérationnel)` };
  }
  return null;
}

function placeSearchResult(lat, lon, label) {
  if (!leafletMap || !searchLayer) return;
  const coords = normalizeMapCoordinates(lat, lon);
  if (!coords) return;
  const coordsLabel = formatCoordinates(coords.lat, coords.lon);
  searchLayer.clearLayers();
  window.L.marker([coords.lat, coords.lon]).bindPopup(`Résultat: ${escapeHtml(label)}<br>Coordonnées: ${escapeHtml(coordsLabel)}`).addTo(searchLayer).openPopup();
  updateSelectedLocationPanel(coords.lat, coords.lon);
  leafletMap.setView([coords.lat, coords.lon], 12);
}

async function handleMapSearch() {
  const query = (document.getElementById('map-search')?.value || '').trim();
  renderResources();
  if (!query || !leafletMap) {
    setMapFeedback('Saisissez un lieu ou une commune pour lancer la recherche.');
    return;
  }

  if (query.length < 3) {
    const localResult = tryLocalMapSearch(query);
    if (!localResult) {
      setMapFeedback('Ajoutez au moins 3 caractères pour une recherche externe.', true);
      return;
    }
    placeSearchResult(localResult.lat, localResult.lon, localResult.label);
    setMapFeedback(`Résultat local: ${localResult.label}`);
    return;
  }

  if (mapSearchController) mapSearchController.abort();
  mapSearchController = new AbortController();

  try {
    const response = await fetchWithTimeout(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query + ', Isère, France')}`,
      {
        signal: mapSearchController.signal,
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'fr',
        },
      },
      7000,
    );
    const payload = await parseJsonResponse(response, 'nominatim');
    if (!payload?.length) {
      const localResult = tryLocalMapSearch(query);
      if (!localResult) {
        setMapFeedback('Aucun résultat de recherche trouvé.');
        return;
      }
      placeSearchResult(localResult.lat, localResult.lon, localResult.label);
      setMapFeedback(`Résultat local: ${localResult.label}`);
      return;
    }
    const lat = Number(payload[0].lat);
    const lon = Number(payload[0].lon);
    placeSearchResult(lat, lon, payload[0].display_name);
    setMapFeedback(`Recherche OK: ${payload[0].display_name}`);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.cause?.name === 'AbortError') return;
    const localResult = tryLocalMapSearch(query);
    if (!localResult) {
      setMapFeedback('Service de recherche temporairement indisponible.', true);
      return;
    }
    placeSearchResult(localResult.lat, localResult.lon, localResult.label);
    setMapFeedback(`Service externe indisponible, résultat local: ${localResult.label}`);
  } finally {
    mapSearchController = null;
  }
}




function setRiskText(id, value, level = null) {
  const node = document.getElementById(id);
  if (!node) return;
  const normalized = normalizeLevel(level || value);
  node.textContent = value;
  node.style.color = levelColor(normalized);
  const text = String(value || '').toLowerCase();
  const pending = normalized === 'gris' || text.includes('pending') || text.includes('synchronisation') || text.includes('chargement');
  node.classList.toggle('is-pending', pending && node.classList.contains('svc-card-status'));
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function setHtml(id, value) {
  try {
    const node = document.getElementById(id);
    if (!node) return false;
    node.innerHTML = value;
    return true;
  } catch (_) {
    return false;
  }
}

function formatApiJson(payload) {
  return escapeHtml(JSON.stringify(payload, null, 2));
}

const MAP_POINT_ICONS = {
  incident: '🚨',
  evacuation: '🏃',
  rassemblement: '📍',
  water: '💧',
  roadblock: '🚧',
  barriere: '⛔',
  danger_zone: '⚠️',
  centre_accueil: '🏟️',
  team: '🧑‍🚒',
  medical: '🏥',
  logistics: '📦',
  command: '🛰️',
  poi: '📌',
  autre: '📍',
};

const MAP_ICON_SUGGESTIONS = {
  incident: ['🚨', '🔥', '⚠️', '💥', '🚓', '🚒', '🧯'],
  evacuation: ['🏃', '🏘️', '🚌', '🚶', '🏟️', '🏫', '🧒'],
  rassemblement: ['📍', '🧭', '🏁', '👥', '🏟️', '🏫', '🅿️'],
  water: ['💧', '🌊', '🛶', '🌧️', '🏞️', '🚤', '🪵'],
  roadblock: ['⛔', '🚧', '🚦', '🛑', '🚫', '🚓', '⚠️'],
  barriere: ['⛔', '🚧', '🛑', '🚫', '🔒', '⚠️'],
  danger_zone: ['⚠️', '🔥', '☣️', '☢️', '🌊', '⛰️', '💥'],
  centre_accueil: ['🏟️', '🏫', '🏠', '🛏️', '🍽️', '👥'],
  team: ['🧑‍🚒', '🚑', '🚒', '👷', '📡', '🚙', '🦺'],
  medical: ['🏥', '🚑', '🩺', '💊', '🧑‍⚕️', '❤️', '🫁'],
  logistics: ['📦', '🚛', '🛠️', '⛽', '🔋', '🧰', '🏗️'],
  command: ['🛰️', '📡', '🧭', '🖥️', '📞', '📢', '🗺️'],
  poi: ['📌', '📍', '⭐', '🏢', '🏠', '🏫', '🏛️', '🏬', '🅿️'],
  autre: ['📍', '📌', '⭐', '🧩', '❗', '📎', '🔖'],
};

function iconForCategory(category) {
  return MAP_POINT_ICONS[category] || '📍';
}

function emojiDivIcon(emoji, options = {}) {
  const iconSize = Array.isArray(options.iconSize) ? options.iconSize : [30, 30];
  const iconAnchor = Array.isArray(options.iconAnchor) ? options.iconAnchor : [Math.round(iconSize[0] / 2), Math.round(iconSize[1] / 2)];
  const popupAnchor = Array.isArray(options.popupAnchor) ? options.popupAnchor : [0, -Math.round(iconSize[1] / 2)];
  const className = options.className ? `map-emoji-icon ${options.className}` : 'map-emoji-icon';
  return window.L.divIcon({ className, html: `<span>${escapeHtml(emoji)}</span>`, iconSize, iconAnchor, popupAnchor });
}

function vigicruesStationIcon(level = 'vert', counter = '1') {
  const normalizedLevel = normalizeLevel(level);
  return window.L.divIcon({
    className: 'vigicrues-station-icon-wrap',
    html: `<span class="vigicrues-station-icon">💧<span class="vigicrues-station-counter ${escapeHtml(normalizedLevel)}">${escapeHtml(counter)}</span></span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 28],
    popupAnchor: [0, -24],
  });
}

function imageMarkerIcon(iconUrl) {
  return window.L.icon({
    iconUrl,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28],
    className: 'map-poi-icon',
  });
}

function markerIconForPoint(point = {}) {
  const iconUrl = String(point.icon_url || '').trim();
  if (/^https?:\/\//i.test(iconUrl)) return imageMarkerIcon(iconUrl);
  return emojiDivIcon(point.icon || iconForCategory(point.category));
}

function normalizeTrafficSeverity(level) {
  const raw = String(level || '').trim().toLowerCase();
  if (['rouge', 'orange', 'jaune', 'vert'].includes(raw)) return raw;
  return normalizeLevel(raw || 'vert');
}

function trafficMarkerIcon(kind = 'incident', category = '', text = '') {
  const lowered = `${category} ${text}`.toLowerCase();
  if (kind === 'waze-road-closed') return '⛔';
  if (/travaux|chantier|coup(é|e)|route coup/.test(lowered)) return '🚧';
  if (/ferm|barr|interdit/.test(lowered)) return '⛔';
  return detectItinisereIcon(text);
}

function itinisereRoadBadge(point = {}) {
  const road = Array.isArray(point.roads) && point.roads.length ? point.roads[0] : '';
  return String(road || '').toUpperCase().replace(/\s+/g, '');
}

function bisonIsereTrafficType(point = {}) {
  const blob = `${point.category || ''} ${point.title || ''} ${point.description || ''}`.toLowerCase();
  if (/r[eé]duction|voie(?:s)?\s+(?:neutralis|ferm|coup)|alternat|basculement/.test(blob)) return 'reduction_voie';
  if (/ralent|bouchon|embouteill|dense|congestion/.test(blob)) return 'ralentissement';
  if (/travaux|chantier/.test(blob) || point.category === 'travaux') return 'travaux';
  if (/accident|collision|carambolage/.test(blob) || point.category === 'accident') return 'accident';
  if (/panne|obstacle|incident/.test(blob) || point.category === 'incident') return 'incident';
  if (/danger|verglas|neige|intemp|crue|inond|ébou|ebou|chute|risque/.test(blob) || ['orange', 'rouge'].includes(normalizeTrafficSeverity(point.severity))) return 'danger';
  return 'info';
}

function bisonTrafficTypeLabel(type = '') {
  return ({
    ralentissement: 'Ralentissement',
    reduction_voie: 'Réduction de voie',
    travaux: 'Travaux',
    accident: 'Accident',
    incident: 'Incident',
    danger: 'Danger',
    info: 'Info circulation',
  }[type] || 'Info circulation');
}

function selectedTrafficFilter() {
  const selected = document.getElementById('filter-bison-type')?.value || 'all';
  if (selected === 'all') return { source: 'all', types: null };
  if (selected === 'itinisere') return { source: 'itinisere', types: null };
  if (selected === 'alea') return { source: 'all', types: ['accident', 'danger'] };
  return { source: 'all', types: [selected] };
}

function parseTrafficDate(value = '') {
  const text = String(value || '').trim();
  if (!text) return null;
  const iso = Date.parse(text);
  if (Number.isFinite(iso)) return iso;
  const fr = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s*(?:a|à|-)?\s*(\d{1,2})(?::(\d{2}))?)?/i);
  if (!fr) return null;
  const day = Number(fr[1]);
  const month = Number(fr[2]);
  let year = Number(fr[3]);
  if (year < 100) year += 2000;
  const hours = Number(fr[4] || 0);
  const minutes = Number(fr[5] || 0);
  return new Date(year, month - 1, day, hours, minutes).getTime();
}

function isTrafficEventCurrent(event = {}) {
  const now = Date.now();
  const end = parseTrafficDate(event.period_end || event.end_at || event.validity_end);
  if (Number.isFinite(end) && end < now) return false;
  const start = parseTrafficDate(event.period_start || event.start_at || event.validity_start);
  if (Number.isFinite(start) && start > now) return false;
  return true;
}

function filterCurrentTrafficEvents(events = []) {
  return (Array.isArray(events) ? events : []).filter((event) => isTrafficEventCurrent(event));
}

async function loadItinisereWebcams(forceRefresh = false) {
  if (itinisereWebcamsInFlight) return itinisereWebcamsInFlight;
  const suffix = forceRefresh ? '?refresh=true' : '';
  itinisereWebcamsInFlight = api(`/api/itinisere/webcams${suffix}`, {
    bypassCache: forceRefresh,
    cacheTtlMs: forceRefresh ? 0 : 60 * 1000,
    timeoutMs: API_SLOW_ENDPOINT_TIMEOUT_MS,
  }).then((payload) => {
    cachedItinisereWebcams = Array.isArray(payload?.webcams) ? payload.webcams : [];
    return cachedItinisereWebcams;
  }).catch(() => cachedItinisereWebcams).finally(() => {
    itinisereWebcamsInFlight = null;
  });
  return itinisereWebcamsInFlight;
}

function trafficMarkerSpec(point = {}) {
  const type = bisonIsereTrafficType(point);
  const isBison = String(point.source || '').toLowerCase().includes('bison');
  const sourceBadge = isBison ? 'B' : 'I';
  const sourceClass = isBison ? 'traffic-source--bison' : 'traffic-source--itinisere';
  const config = {
    ralentissement: { emoji: '🐢', className: 'traffic-type--slowdown' },
    reduction_voie: { emoji: '↘️', className: 'traffic-type--lane' },
    travaux: { emoji: '🚧', className: 'traffic-type--works' },
    accident: { emoji: '💥', className: 'traffic-type--accident' },
    incident: { emoji: '⚠️', className: 'traffic-type--incident' },
    danger: { emoji: '⛔', className: 'traffic-type--danger' },
    info: { emoji: 'ℹ️', className: 'traffic-type--info' },
  };
  return {
    type,
    sourceBadge,
    sourceClass,
    ...(config[type] || config.info),
  };
}

function itinisereDivIcon(point = {}) {
  return trafficDivIcon(point, { compact: false });
}

function bisonDivIcon(point = {}) {
  return trafficDivIcon(point, { compact: true });
}

function trafficDivIcon(point = {}, options = {}) {
  const compact = Boolean(options.compact);
  const roadBadge = itinisereRoadBadge(point);
  const road = roadBadge || '';
  const markerSpec = trafficMarkerSpec(point);

  return window.L.divIcon({
    className: compact ? 'itinisere-icon-wrap itinisere-icon-wrap--compact' : 'itinisere-icon-wrap',
    html: `<span class="itinisere-icon ${markerSpec.className}">${markerSpec.emoji}<span class="itinisere-source-badge ${markerSpec.sourceClass}">${markerSpec.sourceBadge}</span></span>${road ? `<span class="itinisere-road-dot">${escapeHtml(road)}</span>` : ''}`,
    iconSize: compact ? [20, 20] : [28, 28],
    iconAnchor: compact ? [10, 16] : [14, 22],
    popupAnchor: compact ? [0, -14] : [0, -20],
  });
}

function tchooTrainIcon(route = {}, angle = 0) {
  const color = route.color || '#0f172a';
  return window.L.divIcon({
    className: 'tchoo-train-icon-wrap',
    html: `<span class="tchoo-train-icon" style="--train-color:${escapeHtml(color)}"><span class="tchoo-train-icon__glyph" style="transform:rotate(${Number(angle || 0).toFixed(0)}deg)">▲</span></span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -15],
  });
}

function tchooRouteLengthKm(points = []) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += _haversineKm(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  return total;
}

function tchooPositionOnRoute(route = {}, progress = 0) {
  const points = Array.isArray(route.points) ? route.points : [];
  if (points.length < 2) return null;
  const safeProgress = ((Number(progress) % 1) + 1) % 1;
  const totalKm = tchooRouteLengthKm(points);
  if (!Number.isFinite(totalKm) || totalKm <= 0) return { lat: points[0][0], lon: points[0][1], angle: 0 };
  let targetKm = totalKm * safeProgress;
  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1];
    const end = points[i];
    const segmentKm = _haversineKm(start[0], start[1], end[0], end[1]);
    if (targetKm > segmentKm) {
      targetKm -= segmentKm;
      continue;
    }
    const ratio = segmentKm > 0 ? targetKm / segmentKm : 0;
    const lat = start[0] + (end[0] - start[0]) * ratio;
    const lon = start[1] + (end[1] - start[1]) * ratio;
    const angle = Math.atan2(end[1] - start[1], end[0] - start[0]) * 180 / Math.PI + 90;
    return { lat, lon, angle };
  }
  const last = points[points.length - 1];
  return { lat: last[0], lon: last[1], angle: 0 };
}

function tchooTrainPosition(train = {}, now = Date.now()) {
  const route = TCHOO_TRAIN_ROUTES.find((item) => item.id === train.routeId);
  if (!route) return null;
  const cycle = Math.max(60_000, Number(route.durationMs || 30 * 60 * 1000));
  let progress = ((now % cycle) / cycle + Number(train.offset || 0)) % 1;
  if (Number(train.direction || 1) < 0) progress = 1 - progress;
  const position = tchooPositionOnRoute(route, progress);
  return position ? { ...position, route, progress } : null;
}

function tchooTrainPopup(train = {}, route = {}, position = {}) {
  const percent = Number(position.progress || 0) * 100;
  const directionLabel = Number(train.direction || 1) < 0 ? 'sens retour' : 'sens aller';
  return `<div class="map-popup-content">
    <p class="tag">Carto Tchoo · ${escapeHtml(route.line || 'Train')}</p>
    <strong>🚆 ${escapeHtml(train.label || 'Train')}</strong>
    <p class="muted" style="font-size:.78rem;margin:.25rem 0 0">${escapeHtml(route.label || '')} · ${escapeHtml(directionLabel)}</p>
    <p style="font-size:.8rem;margin:.3rem 0 0">Position animée sur axe ferroviaire Isère (${percent.toFixed(0)}% du parcours).</p>
    <a href="${TCHOO_TRAINS_SOURCE_URL}" target="_blank" rel="noreferrer">Ouvrir Carto Tchoo</a>
  </div>`;
}

function updateTchooTrainPositions() {
  if (!tchooTrainLayer || !leafletMap || !leafletMap.hasLayer(tchooTrainLayer)) return;
  const now = Date.now();
  TCHOO_TRAINS.forEach((train) => {
    const position = tchooTrainPosition(train, now);
    if (!position) return;
    const markerState = tchooTrainMarkers.get(train.id);
    if (!markerState) return;
    markerState.marker.setLatLng([position.lat, position.lon]);
    markerState.marker.setIcon(tchooTrainIcon(position.route, position.angle));
    markerState.marker.setPopupContent(tchooTrainPopup(train, position.route, position));
  });
}

function startTchooTrainTimer() {
  if (tchooTrainTimer) return;
  tchooTrainTimer = setInterval(updateTchooTrainPositions, 1200);
}

function stopTchooTrainTimer() {
  if (!tchooTrainTimer) return;
  clearInterval(tchooTrainTimer);
  tchooTrainTimer = null;
}

function applyTchooRailOverlay(enabled) {
  if (!leafletMap || typeof window.L === 'undefined') return;
  if (!enabled) {
    if (tchooRailTileLayer && leafletMap.hasLayer(tchooRailTileLayer)) leafletMap.removeLayer(tchooRailTileLayer);
    return;
  }
  if (!tchooRailTileLayer) {
    tchooRailTileLayer = window.L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', {
      maxZoom: 19,
      opacity: 0.72,
      attribution: '&copy; OpenRailwayMap contributors',
    });
    tchooRailTileLayer.on('tileerror', () => {
      setMapFeedback('Le calque voies ferrées OpenRailwayMap est temporairement indisponible.', true);
    });
  }
  if (!leafletMap.hasLayer(tchooRailTileLayer)) tchooRailTileLayer.addTo(leafletMap);
}

function renderTchooTrainLayer() {
  if (!leafletMap || typeof window.L === 'undefined') return 0;
  const show = document.getElementById('filter-tchoo-trains')?.checked ?? false;
  if (!tchooTrainLayer) tchooTrainLayer = window.L.layerGroup();
  if (!show) {
    applyTchooRailOverlay(false);
    stopTchooTrainTimer();
    tchooTrainMarkers.clear();
    tchooTrainLayer.clearLayers();
    if (leafletMap.hasLayer(tchooTrainLayer)) leafletMap.removeLayer(tchooTrainLayer);
    return 0;
  }

  applyTchooRailOverlay(true);
  if (!leafletMap.hasLayer(tchooTrainLayer)) tchooTrainLayer.addTo(leafletMap);
  tchooTrainLayer.clearLayers();
  tchooTrainMarkers.clear();

  TCHOO_TRAIN_ROUTES.forEach((route) => {
    window.L.polyline(route.points, {
      color: route.color || '#0f172a',
      weight: 3,
      opacity: 0.42,
      dashArray: '4 7',
      interactive: false,
    }).addTo(tchooTrainLayer);
  });

  const now = Date.now();
  TCHOO_TRAINS.forEach((train) => {
    const position = tchooTrainPosition(train, now);
    if (!position) return;
    const marker = window.L.marker([position.lat, position.lon], {
      icon: tchooTrainIcon(position.route, position.angle),
      zIndexOffset: 600,
    });
    marker.bindPopup(tchooTrainPopup(train, position.route, position));
    marker.addTo(tchooTrainLayer);
    tchooTrainMarkers.set(train.id, { marker });
  });

  startTchooTrainTimer();
  return tchooTrainMarkers.size;
}

const ISERE_BOUNDS = {
  latMin: 44.6,
  latMax: 46.0,
  lonMin: 4.2,
  lonMax: 6.8,
};

const TCHOO_TRAINS_SOURCE_URL = 'https://carto.tchoo.net/';
const TCHOO_TRAIN_ROUTES = Object.freeze([
  {
    id: 'grenoble-lyon',
    label: 'TER Grenoble ⇄ Lyon',
    line: 'TER AURA',
    durationMs: 44 * 60 * 1000,
    color: '#0f766e',
    points: [
      [45.1910, 5.7142], [45.2068, 5.7044], [45.2296, 5.6825], [45.2531, 5.6712],
      [45.2925, 5.6362], [45.3236, 5.5639], [45.3638, 5.5902], [45.3565, 5.5019],
      [45.3978, 5.4205], [45.4434, 5.4318], [45.4847, 5.4751], [45.5580, 5.4448],
      [45.5861, 5.2732], [45.6186, 5.2348], [45.6356, 5.1451],
    ],
  },
  {
    id: 'grenoble-chambery',
    label: 'TER Grenoble ⇄ Chambéry',
    line: 'Sillon alpin nord',
    durationMs: 36 * 60 * 1000,
    color: '#2563eb',
    points: [
      [45.1910, 5.7142], [45.1862, 5.7428], [45.1847, 5.7845], [45.2090, 5.8083],
      [45.2355, 5.8844], [45.2627, 5.8992], [45.2831, 5.9217], [45.3415, 5.9836],
      [45.3844, 6.0002], [45.4341, 6.0189], [45.5026, 6.0525],
    ],
  },
  {
    id: 'grenoble-valence',
    label: 'TER Grenoble ⇄ Valence',
    line: 'Sillon alpin sud',
    durationMs: 58 * 60 * 1000,
    color: '#7c3aed',
    points: [
      [45.1910, 5.7142], [45.2068, 5.7044], [45.2296, 5.6825], [45.2531, 5.6712],
      [45.2925, 5.6362], [45.3236, 5.5639], [45.2990, 5.4855], [45.2498, 5.4800],
      [45.2091, 5.4074], [45.1512, 5.3195], [45.0472, 5.0549],
    ],
  },
  {
    id: 'grenoble-gap',
    label: 'TER Grenoble ⇄ Clelles / Gap',
    line: 'Ligne des Alpes',
    durationMs: 62 * 60 * 1000,
    color: '#c2410c',
    points: [
      [45.1910, 5.7142], [45.1542, 5.7156], [45.1240, 5.6990], [45.0967, 5.7045],
      [45.0548, 5.6711], [45.0445, 5.7063], [44.9842, 5.7120], [44.9284, 5.7071],
      [44.8894, 5.6669], [44.8278, 5.6199], [44.7558, 5.6064],
    ],
  },
]);

const TCHOO_TRAINS = Object.freeze([
  { id: 'ter17610', routeId: 'grenoble-lyon', label: 'TER 17610', direction: 1, offset: 0.04 },
  { id: 'ter17623', routeId: 'grenoble-lyon', label: 'TER 17623', direction: -1, offset: 0.57 },
  { id: 'ter885720', routeId: 'grenoble-chambery', label: 'TER 885720', direction: 1, offset: 0.21 },
  { id: 'ter885733', routeId: 'grenoble-chambery', label: 'TER 885733', direction: -1, offset: 0.74 },
  { id: 'ter17564', routeId: 'grenoble-valence', label: 'TER 17564', direction: 1, offset: 0.32 },
  { id: 'ter17579', routeId: 'grenoble-gap', label: 'TER 17579', direction: -1, offset: 0.69 },
]);

function normalizeMapCoordinates(lat, lon) {
  let safeLat = Number(lat);
  let safeLon = Number(lon);
  if (!Number.isFinite(safeLat) || !Number.isFinite(safeLon)) return null;

  const inIsere = safeLat >= ISERE_BOUNDS.latMin && safeLat <= ISERE_BOUNDS.latMax
    && safeLon >= ISERE_BOUNDS.lonMin && safeLon <= ISERE_BOUNDS.lonMax;
  const inIsereIfSwapped = safeLon >= ISERE_BOUNDS.latMin && safeLon <= ISERE_BOUNDS.latMax
    && safeLat >= ISERE_BOUNDS.lonMin && safeLat <= ISERE_BOUNDS.lonMax;

  if (!inIsere && inIsereIfSwapped) [safeLat, safeLon] = [safeLon, safeLat];

  if (safeLat < -90 || safeLat > 90 || safeLon < -180 || safeLon > 180) return null;
  return {
    lat: Number(safeLat.toFixed(6)),
    lon: Number(safeLon.toFixed(6)),
  };
}

function isPointInIsere(point = {}) {
  const coords = normalizeMapCoordinates(point.lat, point.lon);
  if (!coords) return false;
  return coords.lat >= ISERE_BOUNDS.latMin && coords.lat <= ISERE_BOUNDS.latMax
    && coords.lon >= ISERE_BOUNDS.lonMin && coords.lon <= ISERE_BOUNDS.lonMax;
}

function trafficPopupDetails(point = {}, sourceLabel = '', trafficType = '') {
  const roads = Array.isArray(point.roads) && point.roads.length ? point.roads.join(', ') : (point.road || 'Non précisé');
  const locations = Array.isArray(point.locations) && point.locations.length ? point.locations.join(', ') : (point.location_summary || point.anchor || 'Commune Isère');
  const level = normalizeTrafficSeverity(point.severity || 'jaune');
  const category = point.category || 'info';
  const publishedAt = point.published_at || point.updated_at || point.timestamp || point.start_time || '';
  const reference = point.id || point.event_id || point.uid || '';
  const coords = normalizeMapCoordinates(point.lat, point.lon);
  const periodStart = point.period_start || point.start_at || point.validity_start || '';
  const periodEnd = point.period_end || point.end_at || point.validity_end || '';
  const scope = [point.direction, point.carriageway, point.lane_status].filter(Boolean).join(' · ');
  const restriction = point.vehicle_restriction || point.mobility || '';
  const sourceLocation = point.location_summary || '';
  const placementBasis = point.placement_basis || '';
  const precisionEmoji = { source: '📍', exact: '📍', pr: '📏', commune: '🏘️', mairie: '🏛️', adresse: '🏠', localité: '🗺️', 'axe+commune': '🛣️', axe: '🛣️', estimée: '⚠️' };
  const precisionKey = point.precision || 'estimée';
  const precisionIcon = precisionEmoji[precisionKey] || '⚠️';
  return `<strong>${escapeHtml(point.title || 'Évènement circulation Isère')}</strong><br/>
    <span class="badge neutral">${escapeHtml(sourceLabel)} · ${escapeHtml(trafficType)} · ${escapeHtml(level)}</span><br/>
    ${escapeHtml(point.description || 'Aucun détail complémentaire fourni.')}<br/>
    Axe(s): ${escapeHtml(roads)}<br/>
    ${sourceLocation ? `Repère source: ${escapeHtml(sourceLocation)}<br/>` : ''}
    ${precisionIcon} Localisation: ${escapeHtml(locations)} <em>(précision: ${escapeHtml(precisionKey)})</em><br/>
    ${placementBasis ? `Placement carte: ${escapeHtml(placementBasis)}<br/>` : ''}
    Catégorie: ${escapeHtml(category)}${reference ? `<br/>Référence: ${escapeHtml(String(reference))}` : ''}${periodStart || periodEnd ? `<br/>Période: ${escapeHtml(periodStart ? safeDateToLocale(periodStart) : '?')} → ${escapeHtml(periodEnd ? safeDateToLocale(periodEnd) : '?')}` : ''}${scope ? `<br/>Sens/voies: ${escapeHtml(scope)}` : ''}${restriction ? `<br/>Véhicules concernés: ${escapeHtml(restriction)}` : ''}${point.mandatory ? '<br/>Mesure obligatoire: oui' : ''}${publishedAt ? `<br/>Mis à jour: ${escapeHtml(safeDateToLocale(publishedAt))}` : ''}${coords ? `<br/>Coordonnées: ${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}` : ''}<br/>
    <a href="${escapeHtml(point.link || '#')}" target="_blank" rel="noreferrer">Voir la source officielle</a>`;
}

function detectItinisereIcon(text = '') {
  const lowered = text.toLowerCase();
  if (/accident|collision|carambolage/.test(lowered)) return '💥';
  if (/fermet|coup|interdit|barr/.test(lowered)) return '⛔';
  if (/travaux|chantier/.test(lowered)) return '🚧';
  if (/bouchon|ralenti|embouteillage/.test(lowered)) return '🐢';
  if (/manifestation|cortège|événement/.test(lowered)) return '🚶';
  return '⚠️';
}

// Alias : certains codes apparaissent sous plusieurs formes dans les textes
const _ROAD_ALIASES = {
  D532: 'D1532', D1532: 'D1532',  // même route
  D1085: 'D1085',
  RD520: 'D520', CD520: 'D520',
  RD525: 'D525', CD525: 'D525',
  RD531: 'D531', CD531: 'D531',
  RD512: 'D512', CD512: 'D512',
  RD94: 'D94',   CD94: 'D94',
  RD91: 'D91',   CD91: 'D91',
  RD15: 'D15',   CD15: 'D15',
};

function normalizeRoadCode(rawRoad = '') {
  const upper = String(rawRoad || '').toUpperCase().replace(/\s+/g, '');
  if (_ROAD_ALIASES[upper]) return _ROAD_ALIASES[upper];
  const compact = upper.replace(/^(?:RD|RN|CD)/, (prefix) => (prefix === 'RN' ? 'N' : 'D'));
  const match = compact.match(/^(A|N|D)(\d{1,4})([A-Z]?)$/);
  if (!match) return '';
  const code = `${match[1]}${match[2]}${match[3]}`;
  return _ROAD_ALIASES[code] || code;
}

function detectRoadCodes(text = '') {
  const roads = new Set();
  // Regex plus large : capture "D 15", "D-15", "RD15", "CD15", "D1075", etc.
  const matches = String(text).toUpperCase().match(/\b(?:(?:RD|CD|RN|R\.D\.|C\.D\.|R\.N\.)?\s?(?:D|A|N)\s?\d{1,4}[A-Z]?)\b/g) || [];
  matches
    .map((road) => normalizeRoadCode(road.replace(/\s/g, '')))
    .filter(Boolean)
    .forEach((road) => roads.add(road));
  return Array.from(roads);
}

async function geocodeRoadWithContext(road = '', contextHints = []) {
  const normalizedRoad = normalizeRoadCode(road);
  if (!normalizedRoad) return null;
  for (const hint of contextHints) {
    const label = String(hint || '').trim();
    if (!label) continue;
    const point = await geocodeTrafficLabel(`${normalizedRoad} ${label}`);
    if (point) return { ...point, anchor: `${normalizedRoad} · ${label}` };
  }
  const fallback = await geocodeTrafficLabel(`${normalizedRoad} Isère`);
  if (fallback) return { ...fallback, anchor: `${normalizedRoad} · Isère` };
  return null;
}

const _GEOCODE_LS_KEY = 'itinisereGeocodeCacheV2';
const _GEOCODE_LS_TTL_MS = 7 * 24 * 3600 * 1000; // 7 jours

function _loadGeocodeCache() {
  try {
    const raw = localStorage.getItem(_GEOCODE_LS_KEY);
    if (!raw) return;
    const store = JSON.parse(raw);
    const now = Date.now();
    let changed = false;
    Object.entries(store).forEach(([k, entry]) => {
      if (entry && entry.expires_at && entry.expires_at > now) {
        trafficGeocodeCache.set(k, entry.value ?? null);
      } else {
        changed = true; // expired
      }
    });
    if (changed) _saveGeocodeCache();
  } catch { /* ignore */ }
}

function _saveGeocodeCache() {
  try {
    const store = {};
    trafficGeocodeCache.forEach((value, key) => {
      store[key] = { value, expires_at: Date.now() + _GEOCODE_LS_TTL_MS };
    });
    localStorage.setItem(_GEOCODE_LS_KEY, JSON.stringify(store));
  } catch { /* quota dépassé — silencieux */ }
}

async function geocodeTrafficLabel(label) {
  const key = String(label || '').trim().toLowerCase();
  if (!key || key.length < 3) return null;
  // 1. Table des lieux connus — résultat instantané (exact match ou landmark partial)
  const known = lookupKnownLocation(key);
  if (known && isPointInIsere(known)) {
    trafficGeocodeCache.set(key, known);
    return known;
  }
  // 2. Cache en mémoire (chargé depuis localStorage au démarrage)
  if (trafficGeocodeCache.has(key)) return trafficGeocodeCache.get(key);
  // 3. API communes (réseau)
  try {
    const communeUrl = `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(label)}&fields=centre,codeDepartement&codeDepartement=38&limit=1`;
    const communeResponse = await queueApiRequest(() => fetchWithTimeout(communeUrl));
    const communePayload = await parseJsonResponse(communeResponse, communeUrl);
    const center = communePayload?.[0]?.centre?.coordinates;
    if (Array.isArray(center) && center.length === 2) {
      const point = { lat: Number(center[1]), lon: Number(center[0]), precision: 'commune' };
      if (isPointInIsere(point)) {
        trafficGeocodeCache.set(key, point);
        _saveGeocodeCache();
        return point;
      }
    }
  } catch { /* fallback nominatim */ }

  // 4. Nominatim
  try {
    const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(`${label}, Isère, France`)}`;
    const response = await queueApiRequest(() => fetchWithTimeout(nominatimUrl, { headers: { Accept: 'application/json' } }));
    const payload = await parseJsonResponse(response, nominatimUrl);
    const first = payload?.[0];
    const point = first ? { lat: Number(first.lat), lon: Number(first.lon), precision: 'adresse' } : null;
    if (!isPointInIsere(point || {})) {
      trafficGeocodeCache.set(key, null);
      _saveGeocodeCache();
      return null;
    }
    trafficGeocodeCache.set(key, point);
    _saveGeocodeCache();
    return point;
  } catch {
    trafficGeocodeCache.set(key, null);
    return null;
  }
}


async function geocodeClosureCommune(label) {
  const key = `closure-commune:${String(label || '').trim().toLowerCase()}`;
  const normalizedLabel = String(label || '').replace(/^mairie\s+de\s+/i, '').replace(/^commune\s+(?:de\s+)?/i, '').trim();
  if (!normalizedLabel) return null;
  if (trafficGeocodeCache.has(key)) return trafficGeocodeCache.get(key);
  try {
    const communeUrl = `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(normalizedLabel)}&fields=nom,centre,codeDepartement&codeDepartement=38&boost=population&limit=1`;
    const communeResponse = await queueApiRequest(() => fetchWithTimeout(communeUrl));
    const communePayload = await parseJsonResponse(communeResponse, communeUrl);
    const commune = Array.isArray(communePayload) ? communePayload[0] : null;
    const center = commune?.centre?.coordinates;
    if (Array.isArray(center) && center.length === 2) {
      const point = {
        lat: Number(center[1]),
        lon: Number(center[0]),
        precision: 'mairie',
        communeName: commune.nom || normalizedLabel,
      };
      if (isPointInIsere(point)) {
        trafficGeocodeCache.set(key, point);
        return point;
      }
    }
  } catch {
    // ignore commune geocoding issues for closure placement
  }
  trafficGeocodeCache.set(key, null);
  return null;
}

function extractItinisereLocationHints(event = {}, fullText = '', roads = []) {
  const hints = [];
  const blockedHints = new Set([
    'coupure',
    'fermeture',
    'signaler',
    'détail',
    'detail',
    'itinisère',
    'itinisere',
    'infos route',
    'perturbation',
  ]);
  const pushHint = (value) => {
    const label = String(value || '').replace(/\s+/g, ' ').trim();
    const normalized = label.toLowerCase();
    if (!label || blockedHints.has(normalized)) return;
    if (/^(lieux?|signaler|d[ée]tail)\s*:?$/i.test(label)) return;
    if (!label || hints.includes(label)) return;
    hints.push(label);
  };

  const extractScopedLocationLabels = (text) => {
    const labels = [];
    const blob = String(text || '');
    const scopedMatches = [...blob.matchAll(/\b(?:localisation|lieux?)\s*:\s*([^\n.;]+)/gi)];
    scopedMatches.forEach((match) => {
      const chunk = String(match?.[1] || '').replace(/\s+/g, ' ').trim();
      if (!chunk) return;
      chunk
        .split(/[,/]|\s+-\s+/)
        .map((part) => part.replace(/^\s*(?:adresse|commune)\s*[:\-]?\s*/i, '').trim())
        .filter(Boolean)
        .forEach((part) => labels.push(part));
    });
    return labels;
  };

  extractScopedLocationLabels(`${event.description || ''} ${event.title || ''}`).forEach(pushHint);

  [event.address, event.city, ...(Array.isArray(event.addresses) ? event.addresses : []), ...(Array.isArray(event.locations) ? event.locations : [])]
    .forEach(pushHint);

  const blob = String(fullText || '');
  const cityAfterA = [...blob.matchAll(/\b(?:à|au|aux)\s+([A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+(?:\s+[A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+){0,3})/g)];
  cityAfterA.forEach((match) => pushHint(match?.[1]));

  const streetMatches = [...blob.matchAll(/\b(?:rue|route|avenue|boulevard|chemin|quai|pont|échangeur|sortie)\s+[A-Z0-9À-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\- ]{2,70}/gi)];
  streetMatches.forEach((match) => pushHint(match?.[0]));

  roads.forEach((road) => {
    if (event.city) pushHint(`${road} ${event.city}`);
    if (event.address) pushHint(`${road} ${event.address}`);
  });

  return hints.slice(0, 12);
}

function extractAlertDynamicHints(fullText = '') {
  const blockedHints = new Set([
    'isère',
    'isere',
    'trafic',
    'route',
    'routes',
    'alerte',
    'info',
    'infos',
    'incident',
    'perturbation',
  ]);
  const hints = [];
  const pushHint = (value) => {
    const label = String(value || '').replace(/\s+/g, ' ').trim();
    const normalized = label.toLowerCase();
    if (!label || blockedHints.has(normalized) || hints.includes(label)) return;
    hints.push(label);
  };

  const blob = String(fullText || '');
  const scopedMatches = [...blob.matchAll(/\b(?:sur|secteur|vers|au niveau de|à hauteur de|en direction de|depuis|jusqu'à|à partir de)\s+([^\n.;:,]+)/gi)];
  scopedMatches.forEach((match) => {
    String(match?.[1] || '')
      .split(/[,/]|\s+-\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach(pushHint);
  });

  const cityAfterA = [...blob.matchAll(/\b(?:à|au|aux)\s+([A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+(?:\s+[A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+){0,3})/g)];
  cityAfterA.forEach((match) => pushHint(match?.[1]));

  return hints.slice(0, 8);
}

function extractTrafficLocationSummaryHints(event = {}, roads = []) {
  const hints = [];
  const pushHint = (value) => {
    const label = String(value || '').replace(/\s+/g, ' ').trim().replace(/^[-:> ]+|[-:> ]+$/g, '');
    if (!label || hints.includes(label)) return;
    if (/^(?:is[èe]re|info|trafic|circulation|route|routes|sens|voie|voies)$/i.test(label)) return;
    hints.push(label);
  };

  const summaryParts = [
    event.location_summary,
    event.anchor,
    event.city,
    event.address,
    event.direction,
    event.carriageway,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(/→|;|\||,|\s+-\s+/))
    .map((part) => part.trim())
    .filter(Boolean);

  summaryParts.forEach((part) => {
    pushHint(part);
    roads.forEach((road) => pushHint(`${road} ${part}`));
  });

  return hints.slice(0, 10);
}

function snapTrafficPointToRoadCorridor(point = null, roads = []) {
  if (!point || !roads.length) return null;
  let best = null;
  roads.forEach((road) => {
    const corridor = ITINISERE_ROAD_CORRIDORS[road];
    if (!corridor || !corridor.length) return;
    const projected = nearestPointOnCorridor(corridor, point);
    if (!projected) return;
    const distanceKm = _haversineKm(point.lat, point.lon, projected.lat, projected.lon);
    if (!Number.isFinite(distanceKm)) return;
    if (!best || distanceKm < best.distanceKm) {
      best = { ...projected, road, distanceKm };
    }
  });
  return best && best.distanceKm <= 5 ? best : null;
}

function snapBisonPointToRoadCorridor(point = null, roads = []) {
  const snapped = snapTrafficPointToRoadCorridor(point, roads);
  return snapped && snapped.distanceKm <= 1.5 ? snapped : null;
}

function extractTrafficPr(text = '') {
  const blob = String(text || '');
  const match = blob.match(/\bPR\s*([0-9]{1,3})(?:\s*[+.,]\s*([0-9]{1,3}))?\b/i);
  if (!match) return '';
  const km = String(match[1] || '').trim();
  const meters = String(match[2] || '').trim();
  return meters ? `${km}+${meters.padStart(3, '0')}` : km;
}

function buildItinisereMapQuery(event = {}) {
  const candidates = [
    event.address,
    ...(Array.isArray(event.addresses) ? event.addresses : []),
    ...(Array.isArray(event.locations) ? event.locations : []),
    event.city,
    ...(Array.isArray(event.roads) ? event.roads : []),
    event.title,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    return value;
  }
  return 'Isère';
}

function extractClosureCommuneHints(event = {}, fullText = '') {
  const hints = [];
  const pushHint = (value) => {
    const label = String(value || '').replace(/\s+/g, ' ').trim();
    if (!label || hints.includes(label)) return;
    hints.push(label);
  };

  const blob = `${fullText || ''} ${event.city || ''} ${event.address || ''}`;
  TRAFFIC_COMMUNES.forEach((commune) => {
    const escaped = commune.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(blob)) pushHint(commune);
  });

  const scopedCityMatches = [...blob.matchAll(/\b(?:commune(?:\s+de)?|mairie\s+de|[àa]u?x?)\s+([A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+(?:\s+[A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+){0,3})/gi)];
  scopedCityMatches.forEach((match) => pushHint(match?.[1]));

  return hints.slice(0, 8);
}

function spreadOverlappingTrafficPoints(points = []) {
  return points;
}

// Landmarks "nommés" — cols, tunnels, sites spécifiques — sans villes génériques
// Utilisés pour le scan de texte complet (chercher LE lieu précis d'un événement)
const ITINISERE_LANDMARK_KEYS = new Set([
  'col du lautaret', 'lautaret', 'col du galibier', 'galibier',
  'tunnel du chambon', 'chambon', 'lac du chambon',
  'col de la croix de fer', 'croix de fer', 'col du coq',
  'col de porte', 'col de vence', 'col ornon', "col d'ornon",
  'col du glandon', 'glandon', 'col de la madeleine',
  "alpe d'huez", "alpe d'huez", 'les deux alpes', 'deux alpes',
  'gorges de la bourne', 'rochetaillée', 'rochetaillee',
  'seiglières', 'seiglieres', 'mizoën', 'mizoen',
  'la grave', 'le monetier', 'livet-et-gavet',
  'chamrousse', 'villard-de-lans', 'villard de lans',
  'autrans', 'méaudre', 'la chapelle-en-vercors',
]);

// Lookup exact (clé == texte) ou partiel LANDMARK uniquement (pas de villes génériques)
function lookupLandmark(text = '') {
  const lowered = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (ITINISERE_LANDMARK_KEYS.has(lowered) && ITINISERE_KNOWN_LOCATIONS[lowered]) {
    return { ...ITINISERE_KNOWN_LOCATIONS[lowered], name: lowered, precision: 'exact' };
  }
  for (const key of ITINISERE_LANDMARK_KEYS) {
    if (lowered.includes(key) && ITINISERE_KNOWN_LOCATIONS[key]) {
      return { ...ITINISERE_KNOWN_LOCATIONS[key], name: key, precision: 'exact' };
    }
  }
  return null;
}

// Lookup exact sur une chaîne courte (hint spécifique, pas texte complet)
function lookupKnownLocation(label = '') {
  const lowered = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!lowered || lowered.length < 3) return null;
  if (ITINISERE_KNOWN_LOCATIONS[lowered]) return { ...ITINISERE_KNOWN_LOCATIONS[lowered], precision: 'exact' };
  // Partial match uniquement si le label est court (< 40 chars) pour éviter faux positifs
  if (lowered.length < 40) {
    for (const key of Object.keys(ITINISERE_KNOWN_LOCATIONS)) {
      if (lowered.includes(key) && key.length >= 5) {
        return { ...ITINISERE_KNOWN_LOCATIONS[key], precision: 'exact' };
      }
    }
  }
  return null;
}

// Extraire les deux extrémités d'un "entre A et B" et retourner le milieu géocodé
async function resolveBetweenPattern(text = '', roads = []) {
  const m = String(text).match(/\bentre\s+([A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+(?:\s+[A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+){0,3})\s+et\s+([A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+(?:\s+[A-ZÀ-ÖØ-Ý][\wÀ-ÖØ-öø-ÿ'\-]+){0,3})/i);
  if (!m) return null;
  const [, fromLabel, toLabel] = m;
  const [from, to] = await Promise.all([
    geocodeTrafficLabel(fromLabel),
    geocodeTrafficLabel(toLabel),
  ]);
  if (!from && !to) return null;
  if (!from) return to;
  if (!to) return from;
  const midLat = (from.lat + to.lat) / 2;
  const midLon = (from.lon + to.lon) / 2;
  const mid = { lat: midLat, lon: midLon, precision: 'entre' };
  // Si road corridor disponible, projeter le milieu sur le corridor
  for (const road of roads) {
    const corridor = ITINISERE_ROAD_CORRIDORS[road];
    if (corridor) {
      const projected = nearestPointOnCorridor(corridor, mid);
      if (projected) return { ...projected, precision: 'entre', anchor: `${fromLabel} ↔ ${toLabel}` };
    }
  }
  return isPointInIsere(mid) ? mid : null;
}

async function buildItinisereMapPoints(events = []) {
  const points = [];
  for (const event of events.slice(0, 80)) {
    const isBisonEvent = String(event.source || '').toLowerCase().includes('bison');
    const fullText = `${event.title || ''} ${event.description || ''} ${event.location_summary || ''} ${event.road || ''} ${event.direction || ''} ${event.carriageway || ''}`;
    const roads = (Array.isArray(event.roads) && event.roads.length ? event.roads : [event.road, ...detectRoadCodes(fullText)])
      .map((road) => normalizeRoadCode(road))
      .filter(Boolean);
    const isClosureEvent = /ferm|barr|interdit|coup/.test(fullText.toLowerCase())
      || String(event.category || '').toLowerCase() === 'fermeture';
    const locationHints = extractItinisereLocationHints(event, fullText, roads);
    const locationSummaryHints = extractTrafficLocationSummaryHints(event, roads);
    const dynamicAlertHints = extractAlertDynamicHints(fullText);
    const locations = Array.isArray(event.locations) && event.locations.length
      ? event.locations.filter(Boolean)
      : [...locationHints, ...locationSummaryHints];
    const communeHints = TRAFFIC_COMMUNES.filter((commune) => {
      const escaped = commune.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(`${fullText} ${locationHints.join(' ')} ${locationSummaryHints.join(' ')}`);
    });
    const candidateLocationHints = [...new Set([...locations, ...locationHints, ...locationSummaryHints, ...dynamicAlertHints, ...communeHints])];
    let position = null;
    let anchor = '';
    let precision = 'estimée';
    let communeAnchor = null;
    let placementBasis = '';

    // 1. Coordonnées directes depuis l'API
    const providedCoords = normalizeMapCoordinates(event.lat, event.lon);
    if (isBisonEvent && !providedCoords) continue;
    const trustedSourceCoords = providedCoords && !isBisonEvent && String(event.source_api || '').toLowerCase() === 'cityway';
    const prHint = event.pr || extractTrafficPr(fullText);
    const prRoadPoint = prHint && roads.length
      ? roads.map((road) => {
        const resolved = _interpolatePrGeometry(road, prHint);
        return resolved ? { ...resolved, road } : null;
      }).find(Boolean)
      : null;
    const snappedProvidedCoords = providedCoords
      ? (isBisonEvent ? snapBisonPointToRoadCorridor(providedCoords, roads) : snapTrafficPointToRoadCorridor(providedCoords, roads))
      : null;
    if (trustedSourceCoords) {
      position = snappedProvidedCoords
        ? { lat: snappedProvidedCoords.lat, lon: snappedProvidedCoords.lon }
        : providedCoords;
      anchor = locations[0] || roads[0] || 'Itinisère';
      precision = snappedProvidedCoords ? 'axe+commune' : 'source';
      placementBasis = snappedProvidedCoords
        ? `coordonnée source recalée sur ${snappedProvidedCoords.road}`
        : 'coordonnée fournie par la source';
    }

    // 1b. Bison/DATEX : le PR routier est plus fiable que les coordonnées source.
    if (!position && isBisonEvent && prRoadPoint) {
      position = { lat: prRoadPoint.lat, lon: prRoadPoint.lon };
      anchor = `${prRoadPoint.road} · PR ${prHint}`;
      precision = 'pr';
      placementBasis = `PR officiel ${prHint} sur ${prRoadPoint.road}`;
    }

    // 2. Landmark spécifique (col, tunnel, site nommé) dans le texte complet
    // ⚠️ N'utilise PAS les noms de villes génériques (Grenoble, etc.)
    if (!position) {
      const lm = lookupLandmark(fullText);
      if (lm && isPointInIsere(lm)) {
        position = lm;
        anchor = lm.name || 'Lieu spécifique';
        precision = 'exact';
        placementBasis = 'lieu nommé détecté dans le texte';
      }
    }

    // 3. Construire l'ancrage commune AVANT de placer sur corridor
    // (permet nearestPointOnCorridor sur le bon segment)
    if (communeHints.length) {
      for (const commune of communeHints) {
        const pt = await geocodeClosureCommune(commune) || await geocodeTrafficLabel(commune);
        if (pt && isPointInIsere(pt)) { communeAnchor = { ...pt, communeName: pt.communeName || commune }; break; }
      }
    }

    // 4a. "entre A et B" → milieu projeté sur le corridor routier
    if (!position) {
      const betweenPt = await resolveBetweenPattern(fullText, roads);
      if (betweenPt && isPointInIsere(betweenPt)) {
        position = betweenPt;
        anchor = betweenPt.anchor || 'Tronçon';
        precision = betweenPt.precision || 'entre';
        placementBasis = 'tronçon entre deux repères';
      }
    }

    // 4b. Si routes connues : nearest point sur corridor avec ancrage commune
    if (!position && roads.length) {
      for (const road of roads) {
        const corridor = ITINISERE_ROAD_CORRIDORS[road];
        if (!corridor) continue;
        if (communeAnchor) {
          const roadPoint = nearestPointOnCorridor(corridor, communeAnchor);
          if (roadPoint && isPointInIsere(roadPoint)) {
            position = roadPoint;
            anchor = `${road} · ${communeAnchor.communeName || communeHints[0] || road}`;
            precision = 'axe+commune';
            placementBasis = `projection sur l'axe ${road} à hauteur de ${communeAnchor.communeName || communeHints[0] || road}`;
            break;
          }
        }
      }
    }

    // 5. Hints précis (localisation, adresse, lieu-dit) — PAS villes si roads déjà trouvée
    if (!position) {
      const specificHints = [...new Set([...locations, ...locationHints])].filter((h) => h && h.length > 3);
      for (const hint of specificHints) {
        const knownPt = lookupKnownLocation(hint);
        if (knownPt && isPointInIsere(knownPt)) {
          position = knownPt; anchor = hint; precision = 'exact'; placementBasis = 'repère local connu'; break;
        }
        const geocodedPt = await geocodeTrafficLabel(hint);
        if (geocodedPt && isPointInIsere(geocodedPt)) {
          // Si event a des roads → placer sur le corridor plutôt que sur la ville
          if (roads.length) {
            for (const road of roads) {
              const corridor = ITINISERE_ROAD_CORRIDORS[road];
              if (!corridor) continue;
              const roadPoint = nearestPointOnCorridor(corridor, geocodedPt);
              if (roadPoint && isPointInIsere(roadPoint)) {
                position = roadPoint; anchor = `${road} · ${hint}`; precision = 'axe+commune'; placementBasis = `projection sur l'axe ${road} depuis ${hint}`; break;
              }
            }
          }
          if (!position) {
            position = geocodedPt; anchor = hint; precision = geocodedPt.precision || 'localité'; placementBasis = 'géocodage du lieu transmis';
          }
          break;
        }
      }
    }

    // 6. Hints dynamiques (sur X, vers Y) si toujours rien
    if (!position) {
      for (const hint of dynamicAlertHints) {
        const geocodedPt = await geocodeTrafficLabel(hint);
        if (geocodedPt && isPointInIsere(geocodedPt)) {
          position = geocodedPt; anchor = hint; precision = geocodedPt.precision || 'localité'; placementBasis = 'géocodage contextuel'; break;
        }
      }
    }

    // 7. Coordonnée source non fiable (Bison/flux non précis) : recaler sur l'axe le plus proche
    if (!position && providedCoords) {
      if (snappedProvidedCoords) {
        position = { lat: snappedProvidedCoords.lat, lon: snappedProvidedCoords.lon };
        anchor = locations[0] || `${snappedProvidedCoords.road} · secteur signalé`;
        precision = 'axe';
        placementBasis = `coordonnée source recalée sur ${snappedProvidedCoords.road}`;
      } else if (!isBisonEvent) {
        position = providedCoords;
        anchor = locations[0] || roads[0] || 'Source trafic';
        precision = 'source';
        placementBasis = 'coordonnée fournie par la source';
      }
    }

    // 8. Milieu du corridor routier (fallback sans commune)
    if (!position && roads.length && !isBisonEvent) {
      for (const road of roads) {
        const corridor = ITINISERE_ROAD_CORRIDORS[road];
        if (!corridor || !corridor.length) continue;
        const midIdx = Math.floor(corridor.length / 2);
        position = { lat: corridor[midIdx][0], lon: corridor[midIdx][1] };
        anchor = `Axe ${road}`;
        precision = 'axe';
        placementBasis = `position médiane de l'axe ${road}`;
        break;
      }
    }

    // 9. Fermeture avec commune (mairie)
    if (!position && isClosureEvent) {
      const closureCommuneHints = extractClosureCommuneHints(event, fullText);
      for (const commune of closureCommuneHints) {
        const communePoint = await geocodeClosureCommune(commune) || await geocodeTrafficLabel(commune);
        if (!communePoint || !isPointInIsere(communePoint)) continue;
        position = { lat: communePoint.lat, lon: communePoint.lon };
        anchor = `Mairie de ${communePoint.communeName || commune}`;
        precision = 'mairie';
        placementBasis = `commune de fermeture ${communePoint.communeName || commune}`;
        break;
      }
    }

    // 10. Commune seule (événement sans route)
    if (!position && communeAnchor && isPointInIsere(communeAnchor)) {
      position = { lat: communeAnchor.lat, lon: communeAnchor.lon };
      anchor = communeAnchor.communeName || 'Commune';
      precision = 'commune';
      placementBasis = `centre de commune ${communeAnchor.communeName || 'Isère'}`;
    }

    if (!position && !isBisonEvent) {
      for (const road of roads) {
        const corridor = ITINISERE_ROAD_CORRIDORS[road];
        if (!corridor) continue;
        position = { lat: corridor[0][0], lon: corridor[0][1] };
        anchor = `Axe ${road}`;
        precision = 'axe';
        placementBasis = `début de l'axe ${road}`;
        break;
      }
    }

    if (!position && !isBisonEvent) {
      for (const commune of [...communeHints, ...TRAFFIC_COMMUNES]) {
        const escaped = commune.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`\\b${escaped}\\b`, 'i').test(`${fullText} ${candidateLocationHints.join(' ')}`)) continue;
        position = await geocodeTrafficLabel(commune);
        anchor = commune;
        if (position) {
          precision = 'commune';
          placementBasis = `géocodage de la commune ${commune}`;
          break;
        }
      }
    }

    if (!position) {
      position = await geocodeTrafficLabel((event.title || '').slice(0, 90));
      anchor = 'Localisation estimée';
      placementBasis = 'estimation depuis le titre';
    }
    if (!position) continue;

    const normalizedPosition = normalizeMapCoordinates(position.lat, position.lon);
    if (!normalizedPosition) continue;

    points.push({
      ...event,
      lat: normalizedPosition.lat,
      lon: normalizedPosition.lon,
      icon: trafficMarkerIcon('itinisere', event.category, fullText),
      roads,
      anchor,
      precision,
      placement_basis: placementBasis || 'position calculée',
      severity: normalizeTrafficSeverity(event.severity || (event.category === 'fermeture' ? 'rouge' : 'jaune')),
    });
  }
  return spreadOverlappingTrafficPoints(points);
}

// Points de repère (PR) par autoroute — snapshot officiel bornage RRN data.gouv.fr (2025-07-22)
const APRR_PR_COORDS = {
  A41: [
    {k:0,lat:45.200545,lon:5.759221},{k:1,lat:45.202649,lon:5.771386},{k:2,lat:45.204464,lon:5.783846},
    {k:3,lat:45.206932,lon:5.796071},{k:4,lat:45.210893,lon:5.807473},{k:5,lat:45.217223,lon:5.816476},
    {k:6,lat:45.224641,lon:5.823679},{k:7,lat:45.231565,lon:5.831715},{k:8,lat:45.237508,lon:5.841266},
    {k:9,lat:45.241611,lon:5.852545},{k:10,lat:45.245236,lon:5.86407},{k:11,lat:45.250451,lon:5.874709},
    {k:12,lat:45.256732,lon:5.883685},{k:13,lat:45.263619,lon:5.89194},{k:14,lat:45.270526,lon:5.899549},
    {k:15,lat:45.278176,lon:5.906883},{k:16,lat:45.285815,lon:5.913552},{k:17,lat:45.293749,lon:5.91973},
    {k:18,lat:45.301773,lon:5.925282},{k:19,lat:45.30955,lon:5.93176},{k:20,lat:45.316281,lon:5.940161},
    {k:21,lat:45.322525,lon:5.949307},{k:22,lat:45.32966,lon:5.957152},{k:23,lat:45.33768,lon:5.962869},
    {k:24,lat:45.346308,lon:5.966313},{k:25,lat:45.355153,lon:5.968739},{k:26,lat:45.363852,lon:5.97195},
    {k:27,lat:45.372367,lon:5.97604},{k:28,lat:45.380734,lon:5.980736},{k:29,lat:45.388889,lon:5.985983},
    {k:30,lat:45.39702,lon:5.991438},{k:31,lat:45.405143,lon:5.997033},{k:32,lat:45.413855,lon:5.999419},
    {k:33,lat:45.422841,lon:5.99786},{k:34,lat:45.431444,lon:6.000984},{k:35,lat:45.440252,lon:6.003791},
    {k:36,lat:45.449179,lon:6.003475},{k:37,lat:45.457535,lon:6.007851},
  ],
  A43: [
    {k:16,lat:45.6651,lon:5.059739},{k:17,lat:45.660979,lon:5.071127},{k:18,lat:45.657073,lon:5.082681},
    {k:19,lat:45.654498,lon:5.094645},{k:20,lat:45.651816,lon:5.107528},{k:21,lat:45.64809,lon:5.119882},
    {k:22,lat:45.646129,lon:5.131696},{k:23,lat:45.642743,lon:5.143248},{k:24,lat:45.637087,lon:5.153157},
    {k:25,lat:45.631234,lon:5.162912},{k:26,lat:45.626202,lon:5.173669},{k:27,lat:45.620761,lon:5.183961},
    {k:28,lat:45.616082,lon:5.19477},{k:29,lat:45.613322,lon:5.20697},{k:30,lat:45.611554,lon:5.219811},
    {k:31,lat:45.608327,lon:5.23149},{k:32,lat:45.605817,lon:5.24368},{k:33,lat:45.603323,lon:5.256067},
    {k:34,lat:45.600743,lon:5.26836},{k:35,lat:45.596484,lon:5.279678},{k:36,lat:45.593416,lon:5.291409},
    {k:37,lat:45.587436,lon:5.300846},{k:38,lat:45.578842,lon:5.304404},{k:39,lat:45.572987,lon:5.313573},
    {k:40,lat:45.571709,lon:5.326201},{k:41,lat:45.569064,lon:5.338171},{k:42,lat:45.565409,lon:5.349892},
    {k:43,lat:45.563998,lon:5.362646},{k:44,lat:45.562081,lon:5.374925},{k:45,lat:45.560015,lon:5.387367},
    {k:46,lat:45.559546,lon:5.400248},{k:47,lat:45.560266,lon:5.412966},{k:48,lat:45.560764,lon:5.425689},
    {k:49,lat:45.560941,lon:5.438832},{k:50,lat:45.558992,lon:5.450815},{k:51,lat:45.557642,lon:5.463252},
    {k:52,lat:45.561338,lon:5.474963},{k:53,lat:45.563542,lon:5.487273},{k:54,lat:45.563827,lon:5.499945},
    {k:55,lat:45.564204,lon:5.512424},{k:56,lat:45.56524,lon:5.52529},{k:57,lat:45.566735,lon:5.538154},
    {k:58,lat:45.568938,lon:5.550082},{k:59,lat:45.570519,lon:5.562604},{k:60,lat:45.569425,lon:5.575475},
    {k:61,lat:45.570327,lon:5.587745},{k:62,lat:45.571945,lon:5.600771},{k:63,lat:45.576624,lon:5.611629},
    {k:64,lat:45.578944,lon:5.623965},{k:65,lat:45.576897,lon:5.636276},{k:66,lat:45.573497,lon:5.647994},
  ],
  A48: [
    {k:41,lat:45.566344,lon:5.346575},{k:42,lat:45.564058,lon:5.348311},{k:43,lat:45.556394,lon:5.354566},
    {k:44,lat:45.550937,lon:5.364705},{k:45,lat:45.545858,lon:5.374697},{k:46,lat:45.542202,lon:5.386217},
    {k:47,lat:45.537194,lon:5.396623},{k:48,lat:45.532328,lon:5.407076},{k:49,lat:45.523864,lon:5.410492},
    {k:50,lat:45.515281,lon:5.407277},{k:51,lat:45.507243,lon:5.401478},{k:52,lat:45.498447,lon:5.399077},
    {k:53,lat:45.489389,lon:5.398917},{k:54,lat:45.480465,lon:5.398321},{k:55,lat:45.471523,lon:5.400019},
    {k:56,lat:45.46253,lon:5.401759},{k:57,lat:45.45379,lon:5.400484},{k:58,lat:45.445251,lon:5.401381},
    {k:59,lat:45.439444,lon:5.411119},{k:60,lat:45.434261,lon:5.421329},{k:61,lat:45.427762,lon:5.430137},
    {k:62,lat:45.424485,lon:5.441948},{k:63,lat:45.419447,lon:5.452431},{k:64,lat:45.413183,lon:5.461263},
    {k:65,lat:45.40457,lon:5.46411},{k:66,lat:45.395701,lon:5.466577},{k:67,lat:45.387644,lon:5.471981},
    {k:68,lat:45.380293,lon:5.479419},{k:69,lat:45.372778,lon:5.486336},{k:70,lat:45.36972,lon:5.498137},
    {k:71,lat:45.365005,lon:5.509051},{k:72,lat:45.358665,lon:5.518},{k:73,lat:45.354428,lon:5.528632},
    {k:74,lat:45.351217,lon:5.540758},{k:75,lat:45.347075,lon:5.551837},{k:76,lat:45.344953,lon:5.56422},
    {k:77,lat:45.340185,lon:5.574933},{k:78,lat:45.334396,lon:5.584839},{k:79,lat:45.328365,lon:5.594161},
    {k:80,lat:45.322535,lon:5.603928},{k:81,lat:45.315765,lon:5.612214},{k:82,lat:45.308044,lon:5.618745},
    {k:83,lat:45.29939,lon:5.621541},{k:84,lat:45.290486,lon:5.619992},{k:85,lat:45.281677,lon:5.621881},
    {k:86,lat:45.273054,lon:5.62561},{k:87,lat:45.26496,lon:5.630944},{k:88,lat:45.25824,lon:5.639576},
    {k:89,lat:45.252358,lon:5.649169},{k:90,lat:45.245078,lon:5.656488},{k:91,lat:45.236962,lon:5.661991},
    {k:92,lat:45.228734,lon:5.666766},{k:93,lat:45.220753,lon:5.67277},
  ],
  A49: [
    {k:0,lat:45.290875,lon:5.620164},{k:1,lat:45.298814,lon:5.619243},{k:2,lat:45.303933,lon:5.608772},
    {k:3,lat:45.304657,lon:5.596264},{k:4,lat:45.300462,lon:5.585094},{k:5,lat:45.298585,lon:5.573242},
    {k:6,lat:45.297835,lon:5.561022},{k:7,lat:45.29421,lon:5.549697},{k:8,lat:45.293294,lon:5.537035},
    {k:9,lat:45.288897,lon:5.526285},{k:10,lat:45.280285,lon:5.523314},{k:11,lat:45.27151,lon:5.520551},
    {k:12,lat:45.263094,lon:5.516374},{k:13,lat:45.255633,lon:5.50926},{k:14,lat:45.247826,lon:5.503037},
    {k:15,lat:45.240243,lon:5.496326},{k:16,lat:45.234464,lon:5.486706},{k:17,lat:45.226408,lon:5.481441},
    {k:18,lat:45.217986,lon:5.477235},{k:19,lat:45.211502,lon:5.468605},{k:20,lat:45.208901,lon:5.456587},
    {k:21,lat:45.205901,lon:5.444573},{k:22,lat:45.202684,lon:5.4327},{k:23,lat:45.19779,lon:5.422083},
    {k:24,lat:45.191121,lon:5.413584},{k:25,lat:45.184509,lon:5.405087},{k:26,lat:45.177794,lon:5.39675},
    {k:27,lat:45.173008,lon:5.386039},{k:28,lat:45.167614,lon:5.37585},{k:29,lat:45.162153,lon:5.365775},
    {k:30,lat:45.154975,lon:5.358333},{k:31,lat:45.148091,lon:5.350436},{k:32,lat:45.142889,lon:5.340121},
    {k:33,lat:45.137831,lon:5.32969},{k:34,lat:45.133525,lon:5.318547},{k:35,lat:45.12999,lon:5.306961},
    {k:36,lat:45.125094,lon:5.296414},{k:37,lat:45.124019,lon:5.283884},{k:38,lat:45.120712,lon:5.272157},
    {k:39,lat:45.11545,lon:5.261848},{k:40,lat:45.108322,lon:5.254398},{k:41,lat:45.103178,lon:5.244203},
    {k:42,lat:45.099762,lon:5.232474},{k:43,lat:45.094171,lon:5.222666},{k:44,lat:45.086292,lon:5.216565},
  ],
  A51: [
    {k:0,lat:45.115561,lon:5.683907},{k:1,lat:45.107525,lon:5.67857},{k:2,lat:45.09907,lon:5.674041},
    {k:3,lat:45.090991,lon:5.669034},{k:4,lat:45.08404,lon:5.6759},{k:5,lat:45.075827,lon:5.679466},
    {k:6,lat:45.066945,lon:5.681188},{k:7,lat:45.058429,lon:5.684915},{k:8,lat:45.049762,lon:5.684957},
    {k:9,lat:45.04493,lon:5.67509},{k:10,lat:45.039603,lon:5.665347},{k:11,lat:45.030855,lon:5.662378},
    {k:12,lat:45.022061,lon:5.661403},{k:13,lat:45.0133,lon:5.658195},{k:14,lat:45.004556,lon:5.655462},
    {k:15,lat:44.995951,lon:5.652125},{k:16,lat:44.987286,lon:5.648963},{k:17,lat:44.978592,lon:5.646041},
    {k:18,lat:44.969781,lon:5.64341},{k:19,lat:44.961828,lon:5.648211},{k:20,lat:44.955017,lon:5.655644},
    {k:21,lat:44.946762,lon:5.651194},{k:22,lat:44.939097,lon:5.644513},{k:23,lat:44.931388,lon:5.638998},
    {k:24,lat:44.924768,lon:5.630682},{k:25,lat:44.9173,lon:5.624934},{k:26,lat:44.909011,lon:5.625768},
  ],
  A480: [
    {k:0,lat:45.217774,lon:5.67611},{k:1,lat:45.211622,lon:5.684988},{k:2,lat:45.204559,lon:5.691199},
    {k:3,lat:45.197843,lon:5.70074},{k:4,lat:45.189302,lon:5.702644},{k:5,lat:45.180286,lon:5.702359},
    {k:6,lat:45.171168,lon:5.701954},{k:7,lat:45.16219,lon:5.701546},{k:8,lat:45.153591,lon:5.698247},
    {k:9,lat:45.14521,lon:5.694262},{k:10,lat:45.136651,lon:5.690554},{k:11,lat:45.127678,lon:5.690999},
    {k:12,lat:45.119404,lon:5.686422},{k:13,lat:45.110393,lon:5.681475},
  ],
};

// Cache des PR autoroutes (bornage officiel via backend)
let _prApiCache = null;
let _prLocalCacheHydrated = false;

// Interpolation précise depuis les données backend / snapshot officiel
function _haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

let _prApiSource = null;

function _readPrAutoroutesLocalCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.staticPrAutoroutesCache);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.payload || typeof parsed.payload !== 'object') return null;
    const savedAt = Number(parsed.savedAt || 0);
    if (savedAt > 0 && (Date.now() - savedAt) > PR_AUTOROUTES_LOCAL_CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function _savePrAutoroutesLocalCache(payload, source = '') {
  try {
    if (!payload || typeof payload !== 'object' || !Object.keys(payload).length) return;
    localStorage.setItem(STORAGE_KEYS.staticPrAutoroutesCache, JSON.stringify({
      savedAt: Date.now(),
      source,
      payload,
    }));
  } catch {}
}

function _hydratePrAutoroutesFromLocalCache() {
  if (_prLocalCacheHydrated) return;
  _prLocalCacheHydrated = true;
  const cached = _readPrAutoroutesLocalCache();
  if (!cached?.payload) return;
  _prApiCache = cached.payload;
  _prApiSource = cached.source || 'cache local navigateur';
}

function _mergePrCoords(...sources) {
  const merged = {};
  sources.forEach((source) => {
    if (!source || typeof source !== 'object') return;
    Object.entries(source).forEach(([road, pts]) => {
      if (!Array.isArray(pts) || !pts.length) return;
      if (!merged[road]) merged[road] = new Map();
      pts.forEach((pt) => {
        const k = Number(pt?.k);
        const lat = Number(pt?.lat);
        const lon = Number(pt?.lon);
        if (!Number.isFinite(k) || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
        merged[road].set(k.toFixed(3), { k, lat, lon });
      });
    });
  });
  return Object.fromEntries(Object.entries(merged).map(([road, ptsMap]) => [
    road,
    Array.from(ptsMap.values()).sort((a, b) => a.k - b.k),
  ]));
}

function _getEffectivePrCoords() {
  _hydratePrAutoroutesFromLocalCache();
  return _mergePrCoords(APRR_PR_COORDS, _prApiCache);
}

async function loadPrFromApi() {
  _hydratePrAutoroutesFromLocalCache();
  if (_prApiCache) return _prApiCache;
  try {
    const data = await api('/api/osm/isere/pr-autoroutes', { cacheTtlMs: 24 * 60 * 60 * 1000 });
    const roads = data?.roads;
    if (roads && Object.keys(roads).length > 0) {
      _prApiCache = roads;
      _prApiSource = data?.source || 'données officielles';
      _savePrAutoroutesLocalCache(roads, _prApiSource);
      return roads;
    }
  } catch { /* fallback snapshot officiel embarque */ }
  return null;
}


function _drawPrMarkers(coords, sourceLabel) {
  if (!prAutorouteLayer || typeof window.L === 'undefined') return;
  prAutorouteLayer.clearLayers();
  const roadColors = {
    A7: '#4b5563',
    A40: '#0f766e',
    A41: '#2563eb',
    A42: '#7c3aed',
    A43: '#8b5cf6',
    A46: '#374151',
    A47: '#52525b',
    A48: '#059669',
    A49: '#d97706',
    A51: '#dc2626',
    A89: '#7c2d12',
    A410: '#0ea5e9',
    A430: '#a855f7',
    A432: '#4338ca',
    A450: '#be123c',
    A480: '#0891b2',
  };
  Object.entries(coords).forEach(([road, pts]) => {
    const color = roadColors[road] || '#555';
    pts.forEach(({ k, lat, lon }) => {
      const icon = window.L.divIcon({
        className: '',
        html: `<div style="background:${color};color:#fff;font-size:9px;font-weight:700;padding:1px 3px;border-radius:3px;border:1px solid rgba(0,0,0,.3);white-space:nowrap;line-height:1.3;box-shadow:0 1px 3px rgba(0,0,0,.4)">${road} ${k}</div>`,
        iconAnchor: [0, 8],
        popupAnchor: [0, -10],
      });
      window.L.marker([lat, lon], { icon })
        .bindPopup(`<strong>${road} — PR ${k}</strong><br><small>${lat.toFixed(5)}, ${lon.toFixed(5)}</small><br><span class="muted" style="font-size:.75rem">Source: ${sourceLabel}</span>`)
        .addTo(prAutorouteLayer);
    });
  });
}

async function renderPrAutorouteLayer() {
  if (!prAutorouteLayer || typeof window.L === 'undefined') return;
  const show = document.getElementById('filter-pr-autoroutes')?.checked ?? false;
  if (!show) {
    if (leafletMap && leafletMap.hasLayer(prAutorouteLayer)) leafletMap.removeLayer(prAutorouteLayer);
    prAutorouteLayer.clearLayers();
    return;
  }
  if (leafletMap && !leafletMap.hasLayer(prAutorouteLayer)) leafletMap.addLayer(prAutorouteLayer);

  // Affichage immédiat : cache API si dispo, sinon snapshot officiel embarqué
  const immediateCoords = _getEffectivePrCoords();
  const immediateLabel = _prApiCache
    ? `${_prApiSource || 'données officielles'} + snapshot embarque`
    : 'snapshot officiel embarque (data.gouv.fr)';
  _drawPrMarkers(immediateCoords, immediateLabel);

  // Charger les données officielles en arrière-plan si pas encore en cache
  if (!_prApiCache) {
    loadPrFromApi().then(apiData => {
      if (!apiData) return;
      if (!(document.getElementById('filter-pr-autoroutes')?.checked)) return;
      _drawPrMarkers(_getEffectivePrCoords(), `${_prApiSource || 'données officielles'} + snapshot embarque`);
    }).catch(() => {});
  }
}

// Diff stable des marqueurs autoroute — clé = id d'événement, valeur = {marker, popupHtml}
const _autorouteMarkers = new Map();

function _parsePrKm(prStr) {
  const parts = String(prStr || '').split('+');
  const km = parseFloat(parts[0]) + (parts[1] ? parseFloat(parts[1]) / 1000 : 0);
  return Number.isFinite(km) ? km : null;
}

function _interpolatePrGeometry(road, prStr) {
  const km = _parsePrKm(prStr);
  const pts = (_getEffectivePrCoords()[road] || []);
  if (!Number.isFinite(km) || pts.length < 2) return null;
  const toleranceKm = 0.15;
  if (km < pts[0].k - toleranceKm || km > pts[pts.length - 1].k + toleranceKm) return null;
  if (km <= pts[0].k) {
    const next = pts[1];
    return { lat: pts[0].lat, lon: pts[0].lon, dx: next.lon - pts[0].lon, dy: next.lat - pts[0].lat };
  }
  if (km >= pts[pts.length - 1].k) {
    const prev = pts[pts.length - 2];
    const last = pts[pts.length - 1];
    return { lat: last.lat, lon: last.lon, dx: last.lon - prev.lon, dy: last.lat - prev.lat };
  }
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (km >= a.k && km <= b.k) {
      const span = b.k - a.k || 1;
      const t = (km - a.k) / span;
      return {
        lat: a.lat + t * (b.lat - a.lat),
        lon: a.lon + t * (b.lon - a.lon),
        dx: b.lon - a.lon,
        dy: b.lat - a.lat,
      };
    }
  }
  return null;
}

function _resolveAutoroutePrPoint(evt) {
  if (!evt?.road || !evt?.pr) return null;
  const base = _interpolatePrGeometry(evt.road, evt.pr);
  return base ? [base.lat, base.lon] : null;
}

function snapPointToAutoroutePrGeometry(point = null, road = '') {
  if (!point || !road) return null;
  const pts = _getEffectivePrCoords()[road] || [];
  if (pts.length < 2) return null;
  const projected = nearestPointOnCorridor(pts.map((pt) => [pt.lat, pt.lon]), point);
  if (!projected) return null;
  const distanceKm = _haversineKm(point.lat, point.lon, projected.lat, projected.lon);
  return Number.isFinite(distanceKm) && distanceKm <= 2 ? { ...projected, distanceKm } : null;
}

// Interpolation précise d'un PR depuis les données OSM backend
function _prToLatLonOsrm(road, prStr) {
  const pts = _prApiCache?.[road];
  if (!pts || !pts.length || !prStr) return null;
  const parts = String(prStr).split('+');
  const km = parseFloat(parts[0]) + (parts[1] ? parseFloat(parts[1]) / 1000 : 0);
  if (!Number.isFinite(km)) return null;
  const toleranceKm = 0.15;
  if (km < pts[0].k - toleranceKm || km > pts[pts.length - 1].k + toleranceKm) return null;
  if (km <= pts[0].k) return [pts[0].lat, pts[0].lon];
  if (km >= pts[pts.length - 1].k) return [pts[pts.length - 1].lat, pts[pts.length - 1].lon];
  for (let i = 0; i < pts.length - 1; i++) {
    if (km >= pts[i].k && km <= pts[i + 1].k) {
      const t = (km - pts[i].k) / (pts[i + 1].k - pts[i].k);
      return [pts[i].lat + t * (pts[i + 1].lat - pts[i].lat), pts[i].lon + t * (pts[i + 1].lon - pts[i].lon)];
    }
  }
  return null;
}

async function renderTrafficOnMap() {
  if (!itinisereLayer || !bisonLayer || !bisonCameraLayer || typeof window.L === 'undefined') return;
  const renderSequence = ++trafficRenderSequence;
  itinisereLayer.clearLayers();
  bisonLayer.clearLayers();
  bisonCameraLayer.clearLayers();
  // autorouteLayer est mis à jour par diff stable (voir plus bas) — pas de clearLayers() ici
  mapStats.traffic = 0;

  // ── Événements autoroutes Isère agrégés (Bison + APRR/AREA + Vinci) ──
  const showAutoroutes = document.getElementById('filter-autoroutes')?.checked ?? true;
  if (autorouteLayer) {
    if (!showAutoroutes) {
      if (leafletMap.hasLayer(autorouteLayer)) leafletMap.removeLayer(autorouteLayer);
    } else {
      if (!leafletMap.hasLayer(autorouteLayer)) leafletMap.addLayer(autorouteLayer);
    }
  }
  if (autorouteLayer) {
    const autoroutesTypeFilter = document.getElementById('filter-autoroutes-type')?.value || 'all';
    const autoroutesPayload = buildAutoroutesIsereService(cachedExternalRisksSnapshot || {});
    const allRoadEvents = showAutoroutes
      ? (autoroutesPayload?.events || []).map((e) => ({ ...e, src: e?.source_label || 'Autoroutes Isère' }))
      : [];

    // Clé stable par événement : src + route + titre + PR + sens/acces
    const evtKey = (evt) => `${evt.src}|${evt.road}|${evt.title}|${evt.pr || ''}|${evt.direction || ''}|${evt.access || ''}`;

    const activeKeys = new Set();

    allRoadEvents.forEach((evt) => {
      if (autoroutesTypeFilter !== 'all') {
        const t = (evt.type || '').toLowerCase();
        if (autoroutesTypeFilter === 'travaux' && !['travaux','chantier'].includes(t)) return;
        else if (autoroutesTypeFilter === 'accident' && t !== 'accident') return;
        else if (autoroutesTypeFilter === 'perturbation' && t !== 'perturbation') return;
        else if (autoroutesTypeFilter === 'inconnu' && ['accident','travaux','chantier','perturbation'].includes(t)) return;
      }

      // Priorité au PR lorsqu'il existe, sinon fallback sur la position DATEX.
      let placed = _resolveAutoroutePrPoint(evt);
      if (!placed) placed = _prToLatLonOsrm(evt.road, evt.pr);
      if (!placed && Number.isFinite(Number(evt.lat)) && Number.isFinite(Number(evt.lon))) {
        const sourcePoint = { lat: Number(evt.lat), lon: Number(evt.lon) };
        const prSnapped = snapPointToAutoroutePrGeometry(sourcePoint, evt.road);
        if (prSnapped) {
          placed = [prSnapped.lat, prSnapped.lon];
        } else {
          const corridorSnapped = snapBisonPointToRoadCorridor(sourcePoint, [evt.road]);
          if (corridorSnapped) placed = [corridorSnapped.lat, corridorSnapped.lon];
        }
      }
      if (!placed) return;
      const [lat, lon] = placed;
      if (!isPointInIsere({ lat, lon })) return;

      const key = evtKey(evt);
      activeKeys.add(key);

      const popupHtml = `<div class="map-popup-content">
        <p class="tag">${escapeHtml(evt.src)} · ${escapeHtml(evt.road || 'Autoroute')}${evt.pr ? ` · PR ${escapeHtml(evt.pr)}` : ''}</p>
        <strong>${escapeHtml(evt.title || evt.type || 'Événement trafic')}</strong>
        ${evt.direction ? `<p class="muted" style="font-size:.78rem;margin:.25rem 0 0">Sens: ${escapeHtml(evt.direction)}</p>` : ''}
        ${evt.access ? `<p class="muted" style="font-size:.78rem;margin:.25rem 0 0">Accès: ${escapeHtml(evt.access)}</p>` : ''}
        ${evt.description ? `<p style="font-size:.8rem;margin:.3rem 0 0">${escapeHtml(evt.description.substring(0, 200))}</p>` : ''}
        ${evt.start ? `<p class="muted" style="font-size:.75rem;margin:.2rem 0 0">Depuis: ${new Date(evt.start).toLocaleString('fr-FR')}</p>` : ''}
      </div>`;

      // Diff : si le marqueur existe déjà à la même position, ne pas le recréer
      if (_autorouteMarkers.has(key)) {
        const existing = _autorouteMarkers.get(key);
        const prev = existing.marker.getLatLng?.();
        if (!prev || Math.abs(prev.lat - lat) > 1e-6 || Math.abs(prev.lng - lon) > 1e-6) {
          existing.marker.setLatLng([lat, lon]);
        }
        if (existing.popupHtml !== popupHtml) {
          existing.marker.setPopupContent(popupHtml);
          existing.popupHtml = popupHtml;
        }
        mapStats.traffic += 1;
        return;
      }

      const icon = emojiDivIcon(evt.type === 'accident' ? '⚠️' : '🚧', { iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12] });
      const marker = window.L.marker([lat, lon], { icon });
      marker.bindPopup(popupHtml);
      marker.addTo(autorouteLayer);
      _autorouteMarkers.set(key, { marker, popupHtml });
      mapStats.traffic += 1;
    });

    // Supprimer les marqueurs des événements qui ne sont plus présents
    for (const [key, { marker }] of _autorouteMarkers) {
      if (!activeKeys.has(key)) {
        autorouteLayer.removeLayer(marker);
        _autorouteMarkers.delete(key);
      }
    }
  }

  const showTrafficIncidents = document.getElementById('filter-traffic-incidents')?.checked ?? true;
  if (showTrafficIncidents) {
    const selectedFilter = selectedTrafficFilter();
    const trafficEvents = [
      ...filterCurrentTrafficEvents(cachedItinisereEvents).map((event) => ({ ...event, source: 'itinisere' })),
      ...filterCurrentTrafficEvents(cachedBisonLiveEvents).map((event) => ({ ...event, source: 'bison_fute' })),
    ];
    const points = await buildItinisereMapPoints(trafficEvents);
    if (renderSequence !== trafficRenderSequence) return;
    const filteredPoints = points.filter((point) => {
      if (selectedFilter.source === 'itinisere' && String(point.source || '') !== 'itinisere') return false;
      if (!selectedFilter.types) return true;
      return selectedFilter.types.includes(bisonIsereTrafficType(point));
    });
    filteredPoints.forEach((point) => {
      const coords = normalizeMapCoordinates(point.lat, point.lon);
      if (!coords) return;
      if (String(point.source || '').includes('bison') && !isPointInIsere(coords)) return;
      const trafficType = bisonIsereTrafficType(point);
      const sourceLabel = String(point.source || '').includes('bison') ? 'Bison Futé' : 'Itinisère';
      const markerIcon = sourceLabel === 'Bison Futé' ? bisonDivIcon(point) : itinisereDivIcon(point);
      const marker = window.L.marker([coords.lat, coords.lon], { icon: markerIcon });
      marker.bindPopup(trafficPopupDetails(point, sourceLabel, bisonTrafficTypeLabel(trafficType)));
      marker.addTo(sourceLabel === 'Bison Futé' ? bisonLayer : itinisereLayer);
      mapStats.traffic += 1;
    });
  }

  const showCameras = document.getElementById('filter-cameras')?.checked ?? true;
  if (showCameras) {
    const itinisereWebcams = cachedItinisereWebcams;
    if (!itinisereWebcams.length && !itinisereWebcamsInFlight) {
      loadItinisereWebcams(false).then(() => {
        if (document.getElementById('filter-cameras')?.checked ?? true) renderTrafficOnMap();
      });
    }
    BISON_FUTE_CAMERAS.forEach((camera) => {
      const coords = normalizeMapCoordinates(camera.lat, camera.lon);
      if (!coords) return;
      const popupHtml = cameraPopupMarkup(camera);
      const pointIcon = emojiDivIcon('🎥', { iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -11] });
      window.L.marker([coords.lat, coords.lon], { icon: pointIcon }).bindPopup(popupHtml).addTo(bisonCameraLayer);
    });
    itinisereWebcams.forEach((camera) => {
      const coords = normalizeMapCoordinates(camera.lat, camera.lon);
      if (!coords) return;
      const popupHtml = cameraPopupMarkup({
        ...camera,
        source: 'Itinisère',
        mediaType: 'image',
      });
      const pointIcon = emojiDivIcon('📷', { iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -11] });
      window.L.marker([coords.lat, coords.lon], { icon: pointIcon }).bindPopup(popupHtml).addTo(bisonCameraLayer);
    });
    mapStats.traffic += BISON_FUTE_CAMERAS.length + itinisereWebcams.length;

  }



  mapStats.traffic += renderTchooTrainLayer();
  renderPrAutorouteLayer();
  updateMapSummary();
}


function renderMapIconSuggestions(category = 'autre') {
  const container = document.getElementById('map-icon-suggestions');
  if (!container) return;
  const icons = MAP_ICON_SUGGESTIONS[category] || MAP_ICON_SUGGESTIONS.autre;
  setHtml('map-icon-suggestions', `${icons
    .map((icon) => `<button type="button" class="ghost inline-action map-icon-chip" data-map-icon="${escapeHtml(icon)}">${escapeHtml(icon)}</button>`)
    .join('')}<span class="muted">ou saisissez votre emoji.</span>`);
}

function mapAnnotationStyle(record = {}) {
  return {
    color: record.color || '#d7263d',
    weight: Number(record.weight || 3),
    fillOpacity: Number(record.fill_opacity ?? 0.18),
    pane: 'tacticalShapePane',
    interactive: false,
  };
}

function mapTextAnnotationIcon(record = {}) {
  const text = escapeHtml(record.text_label || 'Repère');
  return window.L.divIcon({ className: 'map-text-annotation', html: text, iconSize: null });
}

function initMapAnnotationModule() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  if (!mapAnnotationFeatureGroup) mapAnnotationFeatureGroup = window.L.featureGroup().addTo(leafletMap);
  if (!mapZoneImpactDrawHandler && window.L.Draw?.Polygon) {
    mapZoneImpactDrawHandler = new window.L.Draw.Polygon(leafletMap, {
      allowIntersection: false,
      shapeOptions: { color: '#7c3aed', weight: 2, fillOpacity: 0.12, pane: 'tacticalShapePane', interactive: false },
    });
  }
  if (mapDrawControl || !window.L.Control?.Draw || !canEdit()) return;

  mapDrawControl = new window.L.Control.Draw({
    position: 'topleft',
    draw: {
      polygon: true,
      polyline: true,
      rectangle: true,
      circle: false,
      circlemarker: false,
      marker: true,
    },
    edit: { featureGroup: mapAnnotationFeatureGroup, remove: false },
  });
  leafletMap.addControl(mapDrawControl);

  leafletMap.on('draw:created', async (event) => {
    if (event.layerType === 'polygon' && mapZoneImpactDrawHandler && mapZoneImpactDrawHandler.enabled && mapZoneImpactDrawHandler.enabled()) {
      if (mapZoneImpactLayer) mapZoneImpactLayer.clearLayers();
      mapZoneImpactSelection = event.layer;
      if (typeof mapZoneImpactSelection.setStyle === 'function') {
        mapZoneImpactSelection.setStyle({ color: '#7c3aed', weight: 2, fillOpacity: 0.12, pane: 'tacticalShapePane', interactive: false });
      }
      mapZoneImpactSelection.options.interactive = false;
      mapZoneImpactSelection.addTo(mapZoneImpactLayer || leafletMap);
      computeZoneImpact();
      if (mapZoneImpactDrawHandler?.disable) mapZoneImpactDrawHandler.disable();
      setMapFeedback('Zone analysée. Les indicateurs impact terrain ont été mis à jour.');
      return;
    }
    if (!canEdit()) return;
    const color = document.getElementById('map-annotation-color')?.value || '#d7263d';
    const weight = Number(document.getElementById('map-annotation-weight')?.value || 3);
    const layerType = event.layerType;
    const layer = event.layer;

    try {
      let payload = null;
      const label = window.prompt('Description de la forme (visible par tous). Laissez vide pour ignorer.', '');
      const textLabel = (label || '').trim() || null;
      if (layerType === 'marker') {
        const feature = layer.toGeoJSON();
        payload = { annotation_type: 'text', geojson: feature, text_label: textLabel || 'Repère tactique', color, weight, fill_opacity: 0.2 };
      } else {
        if (typeof layer.setStyle === 'function') layer.setStyle({ color, weight, fillOpacity: 0.2, pane: 'tacticalShapePane', interactive: false });
        layer.options.interactive = false;
        const feature = layer.toGeoJSON();
        payload = { annotation_type: layerType, geojson: feature, text_label: textLabel, color, weight, fill_opacity: 0.2 };
      }
      await api('/map/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await loadMapAnnotations();
      setMapFeedback('Annotation tactique synchronisée avec les autres opérateurs.');
    } catch (error) {
      setMapFeedback(`Annotation impossible: ${sanitizeErrorMessage(error.message)}`, true);
    }
  });
}

async function loadMapAnnotations(showFeedback = false) {
  try {
    const response = await api('/map/annotations', { cacheTtlMs: 0, bypassCache: true });
    mapAnnotations = Array.isArray(response) ? response : [];
    renderMapAnnotations(showFeedback);
  } catch (error) {
    if (showFeedback) setMapFeedback(`Annotations indisponibles: ${sanitizeErrorMessage(error.message)}`, true);
  }
}

function renderMapAnnotations(showFeedback = false) {
  if (!mapAnnotationFeatureGroup || typeof window.L === 'undefined') return;
  mapAnnotationFeatureGroup.clearLayers();

  const list = [];
  mapAnnotations.forEach((record) => {
    const style = mapAnnotationStyle(record);
    if (record.annotation_type === 'text') {
      const coords = record.geojson?.geometry?.coordinates || [];
      if (coords.length >= 2) {
        window.L.marker([coords[1], coords[0]], { icon: mapTextAnnotationIcon(record), zIndexOffset: 200 })
          .bindPopup(`<strong>Texte tactique</strong><br/>${escapeHtml(record.text_label || '-')}`)
          .addTo(mapAnnotationFeatureGroup);
      }
    } else {
      const geo = window.L.geoJSON(record.geojson, {
        style,
        interactive: false,
        pane: 'tacticalShapePane',
      });
      geo.eachLayer((layer) => {
        layer.options.interactive = false;
        layer.bringToBack?.();
      });
      geo.addTo(mapAnnotationFeatureGroup);
    }
    if (canEdit()) {
      list.push(`<li>${escapeHtml(record.annotation_type)} · ${escapeHtml(record.text_label || 'zone tracée')} <button type="button" data-remove-annotation="${record.id}">Supprimer</button></li>`);
    } else {
      list.push(`<li>${escapeHtml(record.annotation_type)} · ${escapeHtml(record.text_label || 'zone tracée')}</li>`);
    }
  });
  setHtml('map-annotations-list', list.join('') || '<li>Aucune annotation tactique.</li>');
  if (showFeedback) setMapFeedback(`${mapAnnotations.length} annotation(s) tactique(s) visible(s).`);
}

const MAP_BRIEFING_COLORS = {
  evacuation: '#c92a2a',
  rassemblement: '#1971c2',
  roadblock: '#f08c00',
  barriere: '#495057',
  danger_zone: '#d6336c',
  centre_accueil: '#2b8a3e',
  team: '#6741d9',
  incident: '#e03131',
  poi: '#0b7285',
  autre: '#364fc7',
};

function mapBriefingColor(category = '') {
  return MAP_BRIEFING_COLORS[category] || MAP_BRIEFING_COLORS.autre;
}

function mapBriefingPointLabel(point = {}) {
  const labels = {
    evacuation: 'EVAC',
    rassemblement: 'RAS',
    roadblock: 'ROUTE',
    barriere: 'BARR',
    danger_zone: 'DANGER',
    centre_accueil: 'ACCUEIL',
    team: 'EQUIPE',
    incident: 'INC',
    poi: 'POI',
  };
  return labels[point.category] || 'POI';
}

function mapBriefingProjector(width, height) {
  if (!leafletMap) return null;
  const size = leafletMap.getSize?.();
  const mapWidth = Math.max(1, Number(size?.x || width || 900));
  const mapHeight = Math.max(1, Number(size?.y || height || 520));
  const scale = Math.min(width / mapWidth, height / mapHeight);
  const offsetX = (width - (mapWidth * scale)) / 2;
  const offsetY = (height - (mapHeight * scale)) / 2;
  return (lat, lon) => {
    const projected = leafletMap.latLngToContainerPoint([lat, lon]);
    return {
      x: offsetX + (projected.x * scale),
      y: offsetY + (projected.y * scale),
      scale,
    };
  };
}

function mapBriefingGeoJsonSvg(geojson, project, fallbackColor = '#d7263d') {
  const geometry = geojson?.geometry || geojson;
  if (!geometry || !project) return '';
  const color = fallbackColor || '#d7263d';
  const pointFromCoord = (coord) => {
    if (!Array.isArray(coord) || coord.length < 2) return null;
    return project(Number(coord[1]), Number(coord[0]));
  };
  const pointsText = (coords) => (coords || [])
    .map(pointFromCoord)
    .filter(Boolean)
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ');

  if (geometry.type === 'LineString') {
    const points = pointsText(geometry.coordinates);
    return points ? `<polyline points="${points}" fill="none" stroke="${escapeHtml(color)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>` : '';
  }
  if (geometry.type === 'Polygon') {
    return (geometry.coordinates || []).map((ring) => {
      const points = pointsText(ring);
      return points ? `<polygon points="${points}" fill="${escapeHtml(color)}" fill-opacity=".16" stroke="${escapeHtml(color)}" stroke-width="2"/>` : '';
    }).join('');
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates || []).flatMap((polygon) => (polygon || []).map((ring) => {
      const points = pointsText(ring);
      return points ? `<polygon points="${points}" fill="${escapeHtml(color)}" fill-opacity=".16" stroke="${escapeHtml(color)}" stroke-width="2"/>` : '';
    })).join('');
  }
  if (geometry.type === 'Point') {
    const point = pointFromCoord(geometry.coordinates);
    return point ? `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="5" fill="${escapeHtml(color)}"/>` : '';
  }
  return '';
}

function buildMapBriefingSnapshotSvg() {
  if (!leafletMap) return '<p class="muted">Carte non initialisee: capture indisponible.</p>';
  leafletMap.invalidateSize?.();
  const width = 900;
  const height = 520;
  const project = mapBriefingProjector(width, height);
  const bounds = leafletMap.getBounds?.();
  const safeBoundsContains = (lat, lon) => {
    try { return !bounds || bounds.pad(0.08).contains([lat, lon]); } catch (_) { return true; }
  };
  const shapes = [];
  const labels = [];

  mapAnnotations.forEach((annotation) => {
    const color = annotation.color || '#d7263d';
    shapes.push(mapBriefingGeoJsonSvg(annotation.geojson, project, color));
    if (annotation.text_label && annotation.geojson?.geometry?.type === 'Point') {
      const coords = annotation.geojson.geometry.coordinates || [];
      const point = project(Number(coords[1]), Number(coords[0]));
      if (point) labels.push(`<text x="${(point.x + 8).toFixed(1)}" y="${(point.y - 8).toFixed(1)}" class="map-label">${escapeHtml(annotation.text_label)}</text>`);
    }
  });

  if (mapEvacuationCircle?.getLatLng && mapEvacuationCircle?.getRadius) {
    const center = mapEvacuationCircle.getLatLng();
    const centerPoint = project(center.lat, center.lng);
    const radiusLat = center.lat + (Number(mapEvacuationCircle.getRadius()) / 111320);
    const radiusPoint = project(radiusLat, center.lng);
    const radius = Math.max(6, Math.abs(radiusPoint.y - centerPoint.y));
    shapes.push(`<circle cx="${centerPoint.x.toFixed(1)}" cy="${centerPoint.y.toFixed(1)}" r="${radius.toFixed(1)}" fill="#ff8787" fill-opacity=".18" stroke="#c92a2a" stroke-width="2"/>`);
    labels.push(`<text x="${(centerPoint.x + 10).toFixed(1)}" y="${(centerPoint.y - 10).toFixed(1)}" class="map-label map-label--danger">Zone evacuation ${(Number(mapEvacuationCircle.getRadius()) / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km</text>`);
  }

  const visiblePoints = (Array.isArray(mapPoints) ? mapPoints : [])
    .filter((point) => mapPointVisibilityOverrides.get(point.id) !== false)
    .filter((point) => isTacticalLayerEnabled(point.category))
    .filter((point) => safeBoundsContains(point.lat, point.lon));

  visiblePoints.forEach((point, index) => {
    const projected = project(point.lat, point.lon);
    if (!projected) return;
    const color = mapBriefingColor(point.category);
    const label = mapBriefingPointLabel(point);
    shapes.push(`<circle cx="${projected.x.toFixed(1)}" cy="${projected.y.toFixed(1)}" r="8" fill="#fff" stroke="${escapeHtml(color)}" stroke-width="3"/>`);
    shapes.push(`<circle cx="${projected.x.toFixed(1)}" cy="${projected.y.toFixed(1)}" r="4" fill="${escapeHtml(color)}"/>`);
    if (index < 45) {
      labels.push(`<text x="${(projected.x + 11).toFixed(1)}" y="${(projected.y + 4).toFixed(1)}" class="map-label"><tspan class="map-label-kind">${escapeHtml(label)}</tspan> ${escapeHtml(point.name || '')}</text>`);
    }
  });

  const center = leafletMap.getCenter?.();
  const zoom = leafletMap.getZoom?.();
  const visibleSummary = [
    `${visiblePoints.length} point(s) tactique(s) visibles`,
    `${mapAnnotations.length} annotation(s)`,
    center ? `centre ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}` : '',
    zoom != null ? `zoom ${zoom}` : '',
  ].filter(Boolean).join(' - ');

  return `<figure class="map-capture">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Capture operationnelle de la carte">
      <defs>
        <pattern id="briefing-grid" width="48" height="48" patternUnits="userSpaceOnUse">
          <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#d8e2f2" stroke-width="1"/>
        </pattern>
        <filter id="label-shadow"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#ffffff" flood-opacity=".95"/></filter>
      </defs>
      <rect width="${width}" height="${height}" fill="#eef4fb"/>
      <rect width="${width}" height="${height}" fill="url(#briefing-grid)" opacity=".75"/>
      <path d="M80,395 C170,350 230,360 315,305 C410,245 492,260 570,190 C640,130 700,125 820,82" fill="none" stroke="#b9d4f3" stroke-width="18" stroke-linecap="round" opacity=".75"/>
      <path d="M55,410 C190,438 330,405 460,432 C610,462 720,420 852,455" fill="none" stroke="#c8d2df" stroke-width="10" stroke-linecap="round" opacity=".55"/>
      ${shapes.join('')}
      ${labels.join('')}
    </svg>
    <figcaption>${escapeHtml(visibleSummary || 'Vue carte courante')}</figcaption>
  </figure>`;
}

function loadMapBriefingImage(src) {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const img = new Image();
    const finish = (value) => {
      img.onload = null;
      img.onerror = null;
      resolve(value);
    };
    const timeout = window.setTimeout(() => finish(null), 2200);
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      window.clearTimeout(timeout);
      finish(img);
    };
    img.onerror = () => {
      window.clearTimeout(timeout);
      finish(null);
    };
    img.src = src;
  });
}

function drawMapBriefingLabel(ctx, text, x, y, options = {}) {
  const value = String(text || '').trim();
  if (!value) return;
  ctx.save();
  ctx.font = options.font || '700 13px Arial, sans-serif';
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = options.color || '#17233f';
  ctx.textBaseline = 'middle';
  ctx.strokeText(value, x, y);
  ctx.fillText(value, x, y);
  ctx.restore();
}

async function drawMapBriefingPoiSymbol(ctx, point, x, y, color) {
  const iconUrl = String(point.icon_url || '').trim();
  const radius = 15;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.38)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.shadowColor = 'transparent';

  if (/^https?:\/\//i.test(iconUrl)) {
    const img = await loadMapBriefingImage(iconUrl);
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, radius - 4, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, x - radius + 4, y - radius + 4, (radius - 4) * 2, (radius - 4) * 2);
      ctx.restore();
      ctx.restore();
      return;
    }
  }

  const symbol = point.icon || iconForCategory(point.category);
  ctx.font = '20px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",Arial,sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#17233f';
  ctx.fillText(symbol, x, y + 1);
  ctx.restore();
}

function drawMapBriefingGeoJson(ctx, geojson, project, color = '#d7263d', label = '') {
  const geometry = geojson?.geometry || geojson;
  if (!geometry || !project) return;
  const projectedPoints = [];
  const addProjectedPoint = (coord) => {
    if (!Array.isArray(coord) || coord.length < 2) return null;
    const point = project(Number(coord[1]), Number(coord[0]));
    if (point) projectedPoints.push(point);
    return point;
  };
  const drawPath = (coords, fill) => {
    let started = false;
    ctx.beginPath();
    (coords || []).forEach((coord) => {
      const point = addProjectedPoint(coord);
      if (!point) return;
      if (!started) {
        ctx.moveTo(point.x, point.y);
        started = true;
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });
    if (!started) return;
    if (fill) {
      ctx.closePath();
      ctx.fill();
    }
    ctx.stroke();
  };
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = 'rgba(255,255,255,.18)';
  ctx.lineWidth = 7;
  if (geometry.type === 'LineString') drawPath(geometry.coordinates, false);
  if (geometry.type === 'Polygon') (geometry.coordinates || []).forEach((ring) => drawPath(ring, true));
  if (geometry.type === 'MultiPolygon') (geometry.coordinates || []).forEach((polygon) => (polygon || []).forEach((ring) => drawPath(ring, true)));
  ctx.strokeStyle = color;
  ctx.fillStyle = `${color}44`;
  ctx.lineWidth = 4;
  if (geometry.type === 'LineString') drawPath(geometry.coordinates, false);
  if (geometry.type === 'Polygon') (geometry.coordinates || []).forEach((ring) => drawPath(ring, true));
  if (geometry.type === 'MultiPolygon') (geometry.coordinates || []).forEach((polygon) => (polygon || []).forEach((ring) => drawPath(ring, true)));
  if (geometry.type === 'Point') {
    const coord = geometry.coordinates || [];
    const point = addProjectedPoint(coord);
    if (point) {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  if (label && projectedPoints.length) {
    const center = projectedPoints.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
    drawMapBriefingLabel(ctx, label, (center.x / projectedPoints.length) + 10, (center.y / projectedPoints.length) - 10, { color });
  }
}

async function buildRealMapBriefingCaptureHtml() {
  if (!leafletMap) return buildMapBriefingSnapshotSvg();
  const mapEl = document.getElementById('isere-map-leaflet');
  const mapRect = mapEl?.getBoundingClientRect?.();
  if (!mapEl || !mapRect?.width || !mapRect?.height) return buildMapBriefingSnapshotSvg();

  leafletMap.invalidateSize?.();
  const outputScale = Math.min(2, 1200 / Math.max(1, mapRect.width));
  const width = Math.round(mapRect.width * outputScale);
  const height = Math.round(mapRect.height * outputScale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return buildMapBriefingSnapshotSvg();
  ctx.fillStyle = '#e8eef5';
  ctx.fillRect(0, 0, width, height);

  const tiles = Array.from(mapEl.querySelectorAll('img.leaflet-tile-loaded, img.leaflet-tile'))
    .filter((tile) => tile.src && tile.offsetParent !== null);
  let drawnTiles = 0;
  for (const tile of tiles) {
    const tileRect = tile.getBoundingClientRect();
    const img = await loadMapBriefingImage(tile.currentSrc || tile.src);
    if (!img) continue;
    try {
      ctx.drawImage(
        img,
        (tileRect.left - mapRect.left) * outputScale,
        (tileRect.top - mapRect.top) * outputScale,
        tileRect.width * outputScale,
        tileRect.height * outputScale,
      );
      drawnTiles += 1;
    } catch (_) {}
  }
  if (!drawnTiles) return buildMapBriefingSnapshotSvg();

  const bounds = leafletMap.getBounds?.();
  const safeBoundsContains = (lat, lon) => {
    try { return !bounds || bounds.pad(0.08).contains([lat, lon]); } catch (_) { return true; }
  };
  const project = (lat, lon) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const point = leafletMap.latLngToContainerPoint([lat, lon]);
    return { x: point.x * outputScale, y: point.y * outputScale };
  };

  mapAnnotations.forEach((annotation) => drawMapBriefingGeoJson(ctx, annotation.geojson, project, annotation.color || '#d7263d', annotation.text_label || ''));

  if (mapEvacuationCircle?.getLatLng && mapEvacuationCircle?.getRadius) {
    const center = mapEvacuationCircle.getLatLng();
    const centerPoint = project(center.lat, center.lng);
    const radiusPoint = project(center.lat + (Number(mapEvacuationCircle.getRadius()) / 111320), center.lng);
    if (centerPoint && radiusPoint) {
      const radius = Math.max(8, Math.abs(radiusPoint.y - centerPoint.y));
      ctx.fillStyle = 'rgba(255, 135, 135, .34)';
      ctx.strokeStyle = '#c92a2a';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(centerPoint.x, centerPoint.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 7]);
      ctx.beginPath();
      ctx.arc(centerPoint.x, centerPoint.y, Math.max(2, radius - 4), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      drawMapBriefingLabel(ctx, `Zone evacuation ${(Number(mapEvacuationCircle.getRadius()) / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`, centerPoint.x + 12, centerPoint.y - 14, { color: '#8a1c1c' });
    }
  }

  const visiblePoints = (Array.isArray(mapPoints) ? mapPoints : [])
    .filter((point) => mapPointVisibilityOverrides.get(point.id) !== false)
    .filter((point) => isTacticalLayerEnabled(point.category))
    .filter((point) => safeBoundsContains(point.lat, point.lon));

  for (const [index, point] of visiblePoints.entries()) {
    const projected = project(point.lat, point.lon);
    if (!projected) continue;
    const color = mapBriefingColor(point.category);
    await drawMapBriefingPoiSymbol(ctx, point, projected.x, projected.y, color);
    if (index < 60) drawMapBriefingLabel(ctx, point.name || mapBriefingPointLabel(point), projected.x + 18, projected.y + 1);
  }

  const center = leafletMap.getCenter?.();
  const zoom = leafletMap.getZoom?.();
  const visibleSummary = [
    `${visiblePoints.length} point(s) tactique(s) visibles`,
    `${mapAnnotations.length} annotation(s)`,
    center ? `centre ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}` : '',
    zoom != null ? `zoom ${zoom}` : '',
  ].filter(Boolean).join(' - ');

  try {
    const png = canvas.toDataURL('image/png');
    return `<figure class="map-capture map-capture--real"><img src="${png}" alt="Capture reelle de la carte avec points tactiques visibles"><figcaption>${escapeHtml(visibleSummary)}</figcaption></figure>`;
  } catch (_) {
    return buildMapBriefingSnapshotSvg();
  }
}

async function exportMapBriefing() {
  const exportedAt = new Date().toLocaleString('fr-FR');
  const win = window.open('', '_blank', 'width=980,height=720');
  if (!win) {
    setMapFeedback('Veuillez autoriser les popups pour generer le briefing carte.', true);
    return;
  }
  win.document.write('<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Briefing carte CRISIS38</title></head><body><p>Capture de la carte en cours...</p></body></html>');
  win.document.close();

  const tacticalCounts = tacticalLayerCounts();
  const tacticalRows = [
    ['Zones d\'évacuation', tacticalCounts.evacuation || 0],
    ['Points de rassemblement', tacticalCounts.rassemblement || 0],
    ['Routes coupées', tacticalCounts.roadblock || 0],
    ['Barrières', tacticalCounts.barriere || 0],
    ['Zones dangereuses', tacticalCounts.danger_zone || 0],
    ['Centres d\'accueil', tacticalCounts.centre_accueil || 0],
    ['Équipes terrain', tacticalCounts.team || 0],
  ];
  const mapCaptureHtml = await buildRealMapBriefingCaptureHtml();
  const rowsHtml = tacticalRows.map(([label, count]) => `<tr><td>${escapeHtml(label)}</td><td>${count}</td></tr>`).join('');
  const annotationsHtml = mapAnnotations.slice(0, 80).map((a) => `<li>${escapeHtml(a.annotation_type || 'annotation')} - ${escapeHtml(a.text_label || 'zone tracée')}</li>`).join('');
  win.document.open();
  win.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Briefing carte CRISIS38</title>
    <style>
      body{font-family:Inter,Arial,sans-serif;margin:28px;color:#17233f} h1{margin:0 0 4px} h2{margin:24px 0 8px;font-size:18px}
      .muted{color:#637087}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}
      .kpi{border:1px solid #d9e2f2;border-radius:8px;padding:10px;background:#f7faff}.kpi strong{display:block;font-size:22px}
      table{width:100%;border-collapse:collapse;margin-top:8px} th,td{border:1px solid #d9e2f2;padding:7px;text-align:left;font-size:13px} th{background:#eef4ff}
      .map-capture{margin:16px 0 20px;border:1px solid #d9e2f2;border-radius:10px;overflow:hidden;background:#fff}.map-capture img,.map-capture svg{display:block;width:100%;height:auto}.map-capture figcaption{padding:8px 10px;color:#637087;font-size:12px;border-top:1px solid #d9e2f2}.map-label{font:700 12px Inter,Arial,sans-serif;fill:#17233f;paint-order:stroke;stroke:#fff;stroke-width:4px;stroke-linejoin:round;filter:url(#label-shadow)}.map-label-kind{fill:#0b4daa}
      ul{margin-top:8px}.footer{margin-top:24px;font-size:12px;color:#637087}@media print{button{display:none} body{margin:16mm}}
    </style></head><body>
    <button onclick="window.print()">Exporter PDF / imprimer</button>
    <h1>Briefing carte CRISIS38</h1><p class="muted">Généré le ${escapeHtml(exportedAt)}</p>
    <div class="kpis">
      <div class="kpi"><span>Points tactiques</span><strong>${mapPoints.length}</strong></div>
      <div class="kpi"><span>Annotations</span><strong>${mapAnnotations.length}</strong></div>
      <div class="kpi"><span>Calques visibles</span><strong>${tacticalRows.filter(([, count]) => count > 0).length}</strong></div>
      <div class="kpi"><span>Capture</span><strong>OK</strong></div>
    </div>
    <h2>Capture carte</h2>${mapCaptureHtml}
    <h2>Calques actions</h2><table><thead><tr><th>Calque</th><th>Points visibles</th></tr></thead><tbody>${rowsHtml}</tbody></table>
    <h2>Annotations tactiques</h2><ul>${annotationsHtml || '<li>Aucune annotation tactique.</li>'}</ul>
    <p class="footer">Document de briefing opérationnel. Vérifier les informations critiques auprès des sources officielles et du terrain.</p>
    </body></html>`);
  win.document.close();
  win.focus();
}

function stopMapAnnotationsSync() {
  if (mapAnnotationsSync) {
    mapAnnotationsSync.close();
    mapAnnotationsSync = null;
  }
}

function startMapAnnotationsSync() {
  stopMapAnnotationsSync();
  if (!token || typeof window.EventSource === 'undefined') return;
  mapAnnotationsSync = new window.EventSource(`/map/annotations/stream?token=${encodeURIComponent(token)}`);
  mapAnnotationsSync.onmessage = async () => {
    await loadMapAnnotations();
  };
  mapAnnotationsSync.onerror = () => {
    stopMapAnnotationsSync();
    window.setTimeout(startMapAnnotationsSync, 4000);
  };
}

function stopExternalRisksSSE() {
  if (externalRisksSSE) {
    externalRisksSSE.close();
    externalRisksSSE = null;
  }
}

function scheduleExternalRisksRender({ map = false } = {}) {
  if (externalRisksRenderTimer) window.clearTimeout(externalRisksRenderTimer);
  externalRisksRenderTimer = window.setTimeout(() => {
    externalRisksRenderTimer = 0;
    if (document.hidden) return;
    renderExternalRisks(cachedExternalRisksSnapshot);
    renderApiInterconnections(cachedExternalRisksSnapshot);
    saveSnapshot(STORAGE_KEYS.externalRisksSnapshot, cachedExternalRisksSnapshot);
    if (map && isMapPanelActive()) renderTrafficOnMap().catch(() => {});
  }, 250);
}

function startExternalRisksSSE() {
  stopExternalRisksSSE();
  if (!token || typeof window.EventSource === 'undefined') return;
  externalRisksSSE = new window.EventSource(`/external/isere/risks/stream?token=${encodeURIComponent(token)}`);
  externalRisksSSE.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (!data || typeof data !== 'object') return;
      if (data.type === 'refresh_status') {
        cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, { updated_at: data.updated_at || new Date().toISOString(), refresh: data.refresh || {} });
        markServerSnapshotFresh(cachedExternalRisksSnapshot);
        scheduleExternalRisksRender();
        return;
      }
      const patch = data.type === 'service_update' && data.service_key
        ? {
          updated_at: data.updated_at || new Date().toISOString(),
          refresh: data.refresh || {},
          [data.service_key]: data.payload || {},
        }
        : data;
      markServerSnapshotFresh(patch);
      cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, patch);
      scheduleExternalRisksRender({ map: true });
    } catch (_) {}
  };
  externalRisksSSE.onerror = () => {
    stopExternalRisksSSE();
    window.setTimeout(startExternalRisksSSE, 5000);
  };
}

async function loadMapPoints() {
  let loadedPoints = [];
  let usedCacheFallback = false;
  const previousPoints = Array.isArray(mapPoints) ? mapPoints : [];

  try {
    const response = await api('/map/points');
    loadedPoints = keepPreviousArray(previousPoints, response);
  } catch (error) {
    usedCacheFallback = true;
    loadedPoints = previousPoints.length ? previousPoints : [];
    setMapFeedback(`Points personnalisés indisponibles (API): ${sanitizeErrorMessage(error.message)}.`, true);
  }

  mapPoints = loadedPoints
    .map((point) => {
      const coords = normalizeMapCoordinates(point.lat, point.lon);
      if (!coords) return null;
      return { ...point, lat: coords.lat, lon: coords.lon };
    })
    .filter(Boolean);
  Array.from(mapPointVisibilityOverrides.keys()).forEach((pointId) => {
    if (!mapPoints.some((point) => point.id === pointId)) mapPointVisibilityOverrides.delete(pointId);
  });
  renderCustomPoints(!usedCacheFallback);
  return { usedCacheFallback, count: loadedPoints.length };
}


async function saveMapPoint(payload) {
  const tempId = `tmp-${Date.now()}`;
  const optimisticPoint = {
    ...payload,
    id: tempId,
    created_at: new Date().toISOString(),
    created_by_id: currentUser?.id || 0,
  };
  mapPoints = [optimisticPoint, ...mapPoints];
  renderCustomPoints(false);
  try {
    const createdPoint = await api('/map/points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const coords = normalizeMapCoordinates(createdPoint?.lat, createdPoint?.lon);
    mapPoints = mapPoints.map((point) => (
      point.id === tempId
        ? { ...createdPoint, lat: coords?.lat ?? payload.lat, lon: coords?.lon ?? payload.lon }
        : point
    ));
    renderCustomPoints(false);
    loadMapPoints().catch(() => {});
    return createdPoint;
  } catch (error) {
    mapPoints = mapPoints.filter((point) => point.id !== tempId);
    renderCustomPoints(false);
    throw error;
  }
}

async function deleteMapPoint(pointId) {
  const previousPoints = mapPoints.slice();
  mapPoints = mapPoints.filter((point) => String(point.id) !== String(pointId));
  mapPointVisibilityOverrides.delete(Number(pointId));
  mapPointVisibilityOverrides.delete(String(pointId));
  renderCustomPoints(false);
  try {
    await api(`/map/points/${pointId}`, { method: 'DELETE' });
    loadMapPoints().catch(() => {});
  } catch (error) {
    mapPoints = previousPoints;
    renderCustomPoints(false);
    throw error;
  }
}

function isTacticalLayerEnabled(category = '') {
  if (!TACTICAL_LAYER_CATEGORIES.has(category)) return true;
  const escaped = window.CSS?.escape ? window.CSS.escape(category) : category.replace(/"/g, '');
  const input = document.querySelector(`.tactical-layer-toggle[data-tactical-layer="${escaped}"]`);
  return input ? input.checked : true;
}

function tacticalLayerCounts() {
  return [...TACTICAL_LAYER_CATEGORIES].reduce((acc, category) => {
    acc[category] = mapPoints.filter((point) => point.category === category && isTacticalLayerEnabled(category)).length;
    return acc;
  }, {});
}

function renderCustomPoints(showFeedback = true) {
  if (customPointsLayer) customPointsLayer.clearLayers();
  if (mapPointsLayer) mapPointsLayer.clearLayers();

  const selectedCategory = document.getElementById('map-point-category-filter')?.value || 'all';
  const targetedCategory = document.getElementById('poi-target-category-filter')?.value || 'all';
  const filteredPoints = mapPoints.filter((point) => {
    const isVisible = mapPointVisibilityOverrides.get(point.id) !== false;
    if (!isVisible) return false;
    if (!isTacticalLayerEnabled(point.category)) return false;
    return (selectedCategory === 'all' || point.category === selectedCategory)
      && (targetedCategory === 'all' || point.category === targetedCategory);
  });
  const listMarkup = filteredPoints
    .map((point) => {
      const pointIcon = point.icon_url ? '🖼️' : (point.icon || iconForCategory(point.category));
      return `<li><strong>${escapeHtml(pointIcon)} ${escapeHtml(point.name)}</strong> · ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)} <button type="button" data-remove-point="${point.id}">Supprimer</button></li>`;
    })
    .join('') || '<li>Aucun point personnalisé.</li>';
  setHtml('custom-points-list', listMarkup);

  mapStats.custom = filteredPoints.length;
  updateMapSummary();
  refreshPoiTargetOptions();
  if (!mapPointsLayer) return;
  filteredPoints.forEach((point) => {
    const marker = window.L.marker([point.lat, point.lon], {
      icon: markerIconForPoint(point),
      pane: 'poiPriorityPane',
      zIndexOffset: 1000,
      riseOnHover: true,
      riseOffset: 1200,
    });
    const popupIcon = point.icon_url ? '🖼️' : (point.icon || iconForCategory(point.category));
    marker.bindPopup(`<strong>${escapeHtml(popupIcon)} ${escapeHtml(point.name)}</strong><br/>Catégorie: ${escapeHtml(point.category)}${point.icon_url ? '<br/>Type: POI avec icône personnalisée' : ''}<br/>${escapeHtml(point.notes || 'Sans note')}`);
    marker.addTo(mapPointsLayer);
  });
  if (showFeedback) setMapFeedback(`${filteredPoints.length} marqueur(s) opérationnel(s)/POI affiché(s).`);
  if (mapPoints.some((p) => p.category === 'site_sensible')) _drawResourceMarkers();
}

function onMapClickAddPoint(event) {
  if (!mapAddPointMode) return;
  pendingMapPointCoords = event.latlng;
  openMapPointModal('poi');
}

function currentEvacuationRadiusMeters() {
  const raw = Number(document.getElementById('map-evacuation-radius-km')?.value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw * 1000;
}

function updateEvacuationCircleButtons() {
  const startBtn = document.getElementById('map-evacuation-circle-start');
  if (startBtn) {
    startBtn.classList.toggle('active', mapEvacuationCircleMode);
    startBtn.setAttribute('aria-pressed', String(mapEvacuationCircleMode));
  }
}

function updateMeasureButtons() {
  const startBtn = document.getElementById('map-measure-start');
  if (startBtn) {
    startBtn.classList.toggle('active', mapMeasureMode);
    startBtn.setAttribute('aria-pressed', String(mapMeasureMode));
  }
}

function clearMapMeasure(showFeedback = true) {
  mapMeasureMode = false;
  mapMeasurePoints = [];
  updateMeasureButtons();
  if (mapMeasureLayer) mapMeasureLayer.clearLayers();
  if (showFeedback) setMapFeedback('Mesure effacée.');
}

function formatDistanceMeters(distanceMeters = 0) {
  const distance = Number(distanceMeters);
  if (!Number.isFinite(distance) || distance <= 0) return '0 m';
  if (distance >= 1000) return `${(distance / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} km`;
  return `${Math.round(distance).toLocaleString('fr-FR')} m`;
}

function startMapMeasureMode() {
  if (mapAddPointMode) {
    mapAddPointMode = false;
    pendingMapPointCoords = null;
    document.getElementById('map-add-point-btn')?.classList.remove('active');
    document.getElementById('map-add-point-btn')?.setAttribute('aria-pressed', 'false');
  }
  if (mapEvacuationCircleMode) {
    mapEvacuationCircleMode = false;
    updateEvacuationCircleButtons();
  }
  if (mapRouteMode) clearMapRoute(false);
  mapMeasureMode = !mapMeasureMode;
  mapMeasurePoints = [];
  if (mapMeasureLayer) mapMeasureLayer.clearLayers();
  updateMeasureButtons();
  setMapFeedback(
    mapMeasureMode
      ? 'Mode mètre actif: cliquez deux points sur la carte pour mesurer la distance.'
      : 'Mode mètre désactivé.',
  );
}

function onMapClickMeasure(event) {
  if (!mapMeasureMode || !leafletMap || typeof window.L === 'undefined') return;
  const lat = Number(event?.latlng?.lat);
  const lon = Number(event?.latlng?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  mapMeasurePoints.push([lat, lon]);
  if (mapMeasureLayer) {
    window.L.circleMarker([lat, lon], {
      radius: 5,
      color: '#0b7285',
      weight: 2,
      fillColor: '#99e9f2',
      fillOpacity: 0.95,
    }).addTo(mapMeasureLayer);
  }

  if (mapMeasurePoints.length < 2) {
    setMapFeedback('Premier point de mesure posé. Cliquez le second point.');
    return;
  }

  const [start, end] = mapMeasurePoints.slice(-2);
  const distanceMeters = leafletMap.distance(start, end);
  if (mapMeasureLayer) {
    window.L.polyline([start, end], {
      color: '#0b7285',
      weight: 3,
      dashArray: '8 6',
    }).addTo(mapMeasureLayer);
    const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    window.L.marker(midpoint, {
      icon: window.L.divIcon({
        className: 'map-measure-label',
        html: `<span>${escapeHtml(formatDistanceMeters(distanceMeters))}</span>`,
        iconSize: null,
      }),
    }).addTo(mapMeasureLayer);
  }

  mapMeasureMode = false;
  mapMeasurePoints = [];
  updateMeasureButtons();
  setMapFeedback(`Distance mesurée: ${formatDistanceMeters(distanceMeters)}.`);
}

function formatDurationSeconds(seconds = 0) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')}`;
  return `${Math.max(1, minutes)} min`;
}

function mapRouteMarkerIcon(label) {
  return window.L.divIcon({
    className: 'map-route-marker',
    html: `<span>${escapeHtml(label)}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function mapRouteDurationIcon(label) {
  return window.L.divIcon({
    className: 'map-route-duration-label',
    html: `<span>${escapeHtml(label)}</span>`,
    iconSize: [74, 24],
    iconAnchor: [37, 12],
  });
}

const MAP_ROUTE_COLORS = ['#1c7ed6', '#d9480f', '#2b8a3e', '#7048e8', '#0b7285', '#c92a2a', '#5f3dc4'];

function routeDisplayIndex(route) {
  const index = mapRoutes.findIndex((item) => item.id === route?.id);
  return index >= 0 ? index + 1 : '?';
}

function routeColorForIndex(index) {
  return MAP_ROUTE_COLORS[Math.max(0, index) % MAP_ROUTE_COLORS.length];
}

function updateRouteButtons() {
  const startBtn = document.getElementById('map-route-start');
  if (startBtn) {
    startBtn.classList.toggle('active', mapRouteMode);
    startBtn.setAttribute('aria-pressed', String(mapRouteMode));
  }
  const refreshBtn = document.getElementById('map-route-refresh');
  if (refreshBtn) refreshBtn.disabled = mapRoutes.length === 0 && mapRoutePoints.length < 2;
}

function setRouteSummary(html, isError = false) {
  const el = document.getElementById('map-route-summary');
  if (!el) return;
  el.classList.toggle('route-tool__summary--error', Boolean(isError));
  el.innerHTML = html;
}

function stopRouteRefreshTimer() {
  if (mapRouteRefreshTimer) {
    clearInterval(mapRouteRefreshTimer);
    mapRouteRefreshTimer = null;
  }
}

function startRouteRefreshTimer() {
  stopRouteRefreshTimer();
  mapRouteRefreshTimer = setInterval(() => {
    if (mapRoutes.length) refreshAllMapRoutes(false);
  }, MAP_ROUTE_REFRESH_MS);
}

function clearMapRoute(showFeedback = true) {
  mapRouteMode = false;
  mapRoutePoints = [];
  mapRoutes = [];
  mapRouteRequestSeq += 1;
  stopRouteRefreshTimer();
  if (mapRouteAbortController) {
    mapRouteAbortController.abort();
    mapRouteAbortController = null;
  }
  if (mapRouteLayer) mapRouteLayer.clearLayers();
  updateRouteButtons();
  renderRouteList();
  setRouteSummary('Cliquez deux points sur la carte pour estimer un trajet.');
  if (showFeedback) setMapFeedback('Trajet efface.');
}

function startMapRouteMode() {
  if (mapAddPointMode) {
    mapAddPointMode = false;
    pendingMapPointCoords = null;
    document.getElementById('map-add-point-btn')?.classList.remove('active');
    document.getElementById('map-add-point-btn')?.setAttribute('aria-pressed', 'false');
  }
  if (mapEvacuationCircleMode) {
    mapEvacuationCircleMode = false;
    updateEvacuationCircleButtons();
  }
  if (mapMeasureMode) clearMapMeasure(false);
  if (mapStreetViewMode) setStreetViewMode(false);
  if (typeof _mapWeatherMode !== 'undefined' && _mapWeatherMode) _toggleMapWeatherMode();

  const nextMode = !mapRouteMode;
  mapRoutePoints = [];
  if (mapRouteAbortController) {
    mapRouteAbortController.abort();
    mapRouteAbortController = null;
  }
  mapRouteMode = nextMode;
  renderMapRoutes();
  updateRouteButtons();
  setRouteSummary(mapRouteMode ? 'Point de depart: cliquez sur la carte.' : 'Cliquez deux points sur la carte pour estimer un trajet.');
  setMapFeedback(mapRouteMode ? 'Mode trajet actif: cliquez le depart puis l arrivee.' : 'Mode trajet desactive.');
}

function drawRouteEndpoint(point, index, route = null) {
  if (!mapRouteLayer || typeof window.L === 'undefined') return;
  const display = route ? routeDisplayIndex(route) : '';
  const marker = window.L.marker([point.lat, point.lon], {
    draggable: Boolean(route),
    icon: mapRouteMarkerIcon(`${index === 0 ? 'A' : 'B'}${display}`),
  }).addTo(mapRouteLayer);
  marker.on('dragend', () => {
    const pos = marker.getLatLng();
    if (!route) return;
    route.points[index] = { lat: pos.lat, lon: pos.lng };
    calculateRouteForRoute(route, true);
  });
  if (route) {
    marker.bindPopup(`<strong>Trajet ${display}</strong><br>${index === 0 ? 'Depart' : 'Arrivee'}<br>Glissez le point pour recalculer.`);
  }
}

function routeLineFromPayload(payload = {}, fallbackPoints = []) {
  const hasRouteGeometry = hasDetailedRoutePolyline(payload);
  if (hasRouteGeometry) {
    return payload.polyline
      .map((point) => [Number(point[0]), Number(point[1])])
      .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  }
  return fallbackPoints.map((point) => [point.lat, point.lon]);
}

function drawRouteDurationLabel(line, payload = {}) {
  if (!mapRouteLayer || line.length < 2) return;
  const middle = line[Math.floor(line.length / 2)];
  const label = formatDurationSeconds(payload.duration_seconds);
  window.L.marker(middle, {
    interactive: false,
    icon: mapRouteDurationIcon(label),
  }).addTo(mapRouteLayer);
}

function renderRouteList() {
  const el = document.getElementById('map-route-list');
  if (!el) return;
  if (!mapRoutes.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = mapRoutes.map((route, index) => {
    const payload = route.payload || {};
    const duration = route.loading ? 'calcul...' : formatDurationSeconds(payload.duration_seconds);
    const distance = route.loading ? '' : ` - ${formatDistanceMeters(payload.distance_meters)}`;
    const source = route.error ? sanitizeErrorMessage(route.error) : (payload.source || 'Source inconnue');
    return `
      <div class="route-item" data-route-id="${escapeHtml(route.id)}">
        <span class="route-item__swatch" style="background:${escapeHtml(route.color)}"></span>
        <div class="route-item__main">
          <strong>Trajet ${index + 1} - ${escapeHtml(duration)}${escapeHtml(distance)}</strong>
          <span>${escapeHtml(source)}</span>
        </div>
        <div class="route-item__actions">
          <button type="button" class="ghost map-btn-lite" data-route-action="focus" data-route-id="${escapeHtml(route.id)}">Voir</button>
          <button type="button" class="ghost map-btn-lite" data-route-action="info" data-route-id="${escapeHtml(route.id)}">Infos</button>
          <button type="button" class="ghost map-btn-lite" data-route-action="delete" data-route-id="${escapeHtml(route.id)}">Suppr.</button>
        </div>
      </div>`;
  }).join('');
}

function renderMapRoutes(options = {}) {
  if (!mapRouteLayer || typeof window.L === 'undefined') return;
  mapRouteLayer.clearLayers();
  let focusBounds = null;
  mapRoutes.forEach((route) => {
    const payload = route.payload || {};
    const line = route.payload || route.loading ? routeLineFromPayload(payload, route.points || []) : [];
    if (line.length < 2) {
      (route.points || []).forEach((point, index) => drawRouteEndpoint(point, index, route));
      return;
    }
    const routeLine = window.L.polyline(line, {
      color: route.color,
      weight: 6,
      opacity: 0.86,
      dashArray: hasDetailedRoutePolyline(payload) ? null : '8 8',
    }).addTo(mapRouteLayer);
    routeLine.bringToFront?.();
    routeLine.bindPopup(buildRouteInfoHtml(route));
    if (route.payload && !route.loading) drawRouteDurationLabel(line, payload);
    (route.points || []).forEach((point, index) => drawRouteEndpoint(point, index, route));
    if (options.focusRouteId === route.id) {
      focusBounds = routeLine.getBounds();
    }
  });
  mapRoutePoints.forEach((point, index) => drawRouteEndpoint(point, index, null));
  if (mapRoutePoints.length === 2) {
    window.L.polyline(mapRoutePoints.map((point) => [point.lat, point.lon]), {
      color: '#7895c9',
      weight: 4,
      opacity: .65,
      dashArray: '6 8',
    }).addTo(mapRouteLayer);
  }
  if (options.fitBounds && leafletMap && focusBounds?.isValid?.()) {
    leafletMap.fitBounds(focusBounds, { padding: [36, 36], maxZoom: 15 });
  }
  renderRouteList();
}

function hasDetailedRoutePolyline(payload = {}) {
  const points = Array.isArray(payload.polyline) ? payload.polyline : [];
  if (points.length < 3) return false;
  return points
    .map((point) => [Number(point?.[0]), Number(point?.[1])])
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .length >= 3;
}

function shouldPreferBrowserRoute(payload = {}) {
  const provider = String(payload.provider || '').toLowerCase();
  return provider === 'local' || !hasDetailedRoutePolyline(payload);
}

function buildRouteInfoHtml(route = {}) {
  const payload = route.payload || {};
  const duration = formatDurationSeconds(payload.duration_seconds);
  const distance = formatDistanceMeters(payload.distance_meters);
  const source = payload.source || 'Source inconnue';
  const delay = Number(payload.traffic_delay_seconds || 0);
  const delayText = delay > 0 ? `<br>Retard estime: ${escapeHtml(formatDurationSeconds(delay))}` : '';
  const errorText = route.error ? `<br><span style="color:#9b1c1c">${escapeHtml(sanitizeErrorMessage(route.error))}</span>` : '';
  return `<strong>Trajet ${escapeHtml(String(routeDisplayIndex(route)))}</strong><br>${escapeHtml(duration)} - ${escapeHtml(distance)}<br>${escapeHtml(source)}${delayText}${errorText}`;
}

function renderRouteEstimate(payload = {}) {
  const trafficAware = Boolean(payload.traffic_aware);
  const trafficMode = String(payload.traffic_mode || '');
  const distance = formatDistanceMeters(payload.distance_meters);
  const duration = formatDurationSeconds(payload.duration_seconds);
  const delay = Number(payload.traffic_delay_seconds || 0);
  const nearbyEvents = Array.isArray(payload.traffic_events_nearby) ? payload.traffic_events_nearby : [];
  let delayText = 'Trafic live non disponible sans source externe';
  if (trafficMode === 'live_speed') {
    delayText = `Retard trafic live: ${delay > 0 ? formatDurationSeconds(delay) : 'aucun'}`;
  } else if (trafficMode === 'open_incidents') {
    delayText = `${nearbyEvents.length} perturbation(s) proche(s) - ajustement ${delay > 0 ? formatDurationSeconds(delay) : '0 min'}`;
  } else if (trafficAware) {
    delayText = `Ajustement trafic: ${delay > 0 ? formatDurationSeconds(delay) : 'aucun'}`;
  }
  const updatedAt = payload.updated_at ? new Date(payload.updated_at) : null;
  const updatedLabel = updatedAt && !Number.isNaN(updatedAt.getTime())
    ? updatedAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--';
  const source = payload.source || (trafficAware ? 'TomTom' : 'OSRM');
  const altText = payload.alternatives_checked
    ? `<br><span class="muted">Alternative ${escapeHtml(String(payload.selected_alternative || 1))}/${escapeHtml(String(payload.alternatives_checked))} retenue</span>`
    : '';
  const eventText = nearbyEvents.length
    ? `<br><span class="muted">${nearbyEvents.slice(0, 2).map((event) => escapeHtml(event.title || event.category || 'Perturbation')).join(' / ')}</span>`
    : '';
  setRouteSummary(`
    <strong>${escapeHtml(duration)}</strong> - ${escapeHtml(distance)}<br>
    <span>${escapeHtml(delayText)}</span><br>
    <span class="muted">Source: ${escapeHtml(source)} - MAJ ${escapeHtml(updatedLabel)} - auto 60 s</span>${altText}${eventText}
  `);
}

async function fetchClientOsrmRoute(start, end) {
  const coords = `${encodeURIComponent(start.lon)},${encodeURIComponent(start.lat)};${encodeURIComponent(end.lon)},${encodeURIComponent(end.lat)}`;
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=true&steps=false`;
  const response = await fetchWithTimeout(url, {}, API_SLOW_ENDPOINT_TIMEOUT_MS);
  if (!response.ok) throw createApiError(`OSRM direct indisponible (${response.status})`, response.status);
  const payload = await response.json();
  const routes = Array.isArray(payload?.routes) ? payload.routes : [];
  if (!routes.length) throw createApiError('Aucun trajet OSRM direct trouve');
  const best = routes
    .slice(0, 4)
    .map((route, index) => ({ route, index, duration: Number(route.duration || 0) }))
    .sort((a, b) => a.duration - b.duration)[0];
  const coordinates = best.route?.geometry?.coordinates || [];
  const polyline = coordinates
    .map((point) => [Number(point[1]), Number(point[0])])
    .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  return {
    status: 'online',
    provider: 'osrm_browser',
    traffic_aware: false,
    traffic_mode: 'none',
    source: 'OSRM public routing direct navigateur',
    distance_meters: Number(best.route.distance || 0),
    duration_seconds: Number(best.route.duration || 0),
    duration_no_traffic_seconds: Number(best.route.duration || 0),
    traffic_delay_seconds: 0,
    polyline,
    alternatives_checked: Math.min(routes.length, 4),
    selected_alternative: best.index + 1,
    updated_at: new Date().toISOString(),
  };
}

async function fetchBestRoutePayload(start, end) {
  const params = new URLSearchParams({
    start_lat: String(start.lat),
    start_lon: String(start.lon),
    end_lat: String(end.lat),
    end_lon: String(end.lon),
  });
  try {
    const payload = await api(`/api/routes/estimate?${params.toString()}`, {
      bypassCache: true,
      cacheTtlMs: 0,
      timeoutMs: API_SLOW_ENDPOINT_TIMEOUT_MS,
      maxRetries: 1,
    });
    if (!shouldPreferBrowserRoute(payload)) return payload;
    const browserPayload = await fetchClientOsrmRoute(start, end);
    browserPayload.backend_fallback = payload;
    return browserPayload;
  } catch (error) {
    const browserPayload = await fetchClientOsrmRoute(start, end);
    browserPayload.backend_error = sanitizeErrorMessage(error.message || 'Backend trajet indisponible');
    return browserPayload;
  }
}

function createMapRouteFromPending() {
  if (mapRoutePoints.length < 2) return null;
  const id = `route-${mapRouteIdSeq++}`;
  const route = {
    id,
    color: routeColorForIndex(mapRoutes.length),
    points: mapRoutePoints.slice(0, 2).map((point) => ({ lat: point.lat, lon: point.lon })),
    payload: null,
    loading: true,
    error: '',
    requestSeq: 0,
  };
  mapRoutes.push(route);
  mapRoutePoints = [];
  renderMapRoutes();
  renderRouteList();
  return route;
}

async function calculateRouteForRoute(route, showFeedback = true) {
  if (!route || !Array.isArray(route.points) || route.points.length < 2) return;
  const requestSeq = ++route.requestSeq;
  route.loading = true;
  route.error = '';
  renderRouteList();
  if (showFeedback) setMapFeedback(`Calcul du trajet ${routeDisplayIndex(route)} en cours...`);
  setRouteSummary('Calcul du trajet en cours...');
  const [start, end] = route.points;
  try {
    const routePayload = await fetchBestRoutePayload(start, end);
    if (!mapRoutes.some((item) => item.id === route.id) || requestSeq !== route.requestSeq) return;
    route.payload = routePayload;
    route.loading = false;
    route.error = '';
    renderMapRoutes({ fitBounds: showFeedback, focusRouteId: route.id });
    renderRouteEstimate(routePayload);
    startRouteRefreshTimer();
    if (showFeedback) {
      const mode = String(routePayload.traffic_mode || '');
      if (mode === 'live_speed') {
        setMapFeedback(`Trajet ${routeDisplayIndex(route)} calcule avec trafic live.`);
      } else if (mode === 'open_incidents') {
        setMapFeedback(`Trajet ${routeDisplayIndex(route)} calcule avec itineraire routier et perturbations temps reel.`);
      } else {
        setMapFeedback(`Trajet ${routeDisplayIndex(route)} calcule via OSRM public avec trace routiere detaillee.`);
      }
    }
  } catch (error) {
    if (!mapRoutes.some((item) => item.id === route.id) || requestSeq !== route.requestSeq) return;
    route.loading = false;
    route.error = sanitizeErrorMessage(error.message || 'Routage indisponible');
    renderMapRoutes();
    setRouteSummary(`Trajet ${routeDisplayIndex(route)} indisponible: ${escapeHtml(route.error)}`, true);
    if (showFeedback) setMapFeedback(`Trajet indisponible: ${route.error}`, true);
  } finally {
    updateRouteButtons();
  }
}

async function refreshAllMapRoutes(showFeedback = true) {
  if (!mapRoutes.length) {
    if (mapRoutePoints.length === 2) {
      const route = createMapRouteFromPending();
      if (route) calculateRouteForRoute(route, showFeedback);
      return;
    }
    setRouteSummary('Ajoutez au moins un trajet pour actualiser.', true);
    return;
  }
  await Promise.all(mapRoutes.map((route) => calculateRouteForRoute(route, showFeedback)));
}

async function refreshMapRoute(showFeedback = true) {
  if (mapRoutePoints.length < 2) {
    setRouteSummary('Posez un depart et une arrivee pour calculer le trajet.', true);
    return;
  }
  const route = createMapRouteFromPending();
  if (route) calculateRouteForRoute(route, showFeedback);
}

function onMapClickRoute(event) {
  if (!mapRouteMode || !leafletMap || typeof window.L === 'undefined') return;
  if (event?.originalEvent) event.originalEvent._mapRouteHandled = true;
  const lat = Number(event?.latlng?.lat);
  const lon = Number(event?.latlng?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (mapRoutePoints.length >= 2) {
    mapRoutePoints = [];
  }
  mapRoutePoints.push({ lat, lon });
  renderMapRoutes();
  updateRouteButtons();
  if (mapRoutePoints.length === 1) {
    setRouteSummary('Depart pose. Cliquez le point d arrivee.');
    setMapFeedback('Depart du trajet pose. Cliquez l arrivee.');
    return;
  }
  mapRouteMode = true;
  updateRouteButtons();
  refreshMapRoute(true);
  setRouteSummary('Trajet ajoute. Cliquez un nouveau depart pour ajouter un autre trajet.');
}

function clearEvacuationCircle(showFeedback = true) {
  leafletMap?.closePopup?.();
  mapEvacuationCircleMode = false;
  updateEvacuationCircleButtons();
  if (mapEvacuationCircleLayer) mapEvacuationCircleLayer.clearLayers();
  mapEvacuationCircle = null;
  if (showFeedback) setMapFeedback("Zone d'évacuation effacée.");
}

function startEvacuationCircleMode() {
  const radiusMeters = currentEvacuationRadiusMeters();
  if (!radiusMeters) {
    setMapFeedback("Saisissez d'abord un rayon d'évacuation en kilomètres.", true);
    return;
  }
  if (mapAddPointMode) {
    mapAddPointMode = false;
    pendingMapPointCoords = null;
    document.getElementById('map-add-point-btn')?.classList.remove('active');
    document.getElementById('map-add-point-btn')?.setAttribute('aria-pressed', 'false');
  }
  if (mapMeasureMode) clearMapMeasure(false);
  if (mapRouteMode) clearMapRoute(false);
  mapEvacuationCircleMode = !mapEvacuationCircleMode;
  updateEvacuationCircleButtons();
  setMapFeedback(
    mapEvacuationCircleMode
      ? `Cliquez sur la carte pour poser le centre du rond d'évacuation (${(radiusMeters / 1000).toLocaleString('fr-FR')} km).`
      : "Mode rond d'évacuation désactivé.",
  );
}

function onMapClickEvacuationCircle(event) {
  if (!mapEvacuationCircleMode || !leafletMap || typeof window.L === 'undefined') return;
  const radiusMeters = currentEvacuationRadiusMeters();
  if (!radiusMeters) {
    setMapFeedback("Rayon d'évacuation invalide.", true);
    mapEvacuationCircleMode = false;
    updateEvacuationCircleButtons();
    return;
  }
  if (mapEvacuationCircleLayer) mapEvacuationCircleLayer.clearLayers();
  mapEvacuationCircle = window.L.circle([event.latlng.lat, event.latlng.lng], {
    radius: radiusMeters,
    color: '#c92a2a',
    weight: 2,
    fillColor: '#ff8787',
    fillOpacity: 0.16,
    pane: 'tacticalShapePane',
    interactive: false,
  }).addTo(mapEvacuationCircleLayer || leafletMap);
  mapEvacuationCircleMode = false;
  updateEvacuationCircleButtons();
  setMapFeedback(`Rond d'évacuation affiché (${(radiusMeters / 1000).toLocaleString('fr-FR')} km).`);
}

function openMapPointModal(defaultCategory = 'autre') {
  const modal = document.getElementById('map-point-modal');
  if (!modal) return;
  const form = document.getElementById('map-point-form');
  if (form) {
    form.reset();
    form.elements.namedItem('category').value = defaultCategory;
    form.elements.namedItem('name').value = `Point ${new Date().toLocaleTimeString()}`;
    form.elements.namedItem('icon').value = iconForCategory(defaultCategory);
    form.elements.namedItem('icon_url').value = '';
    mapIconTouched = false;
    renderMapIconSuggestions(defaultCategory);
  }
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', 'open');
}
function renderMeteoAlerts(meteo = {}) {
  const current = meteo.current_alerts || [];
  const tomorrow = meteo.tomorrow_alerts || [];
  const alertDetailMarkup = (alert = {}) => {
    const level = normalizeLevel(alert.level);
    const details = (alert.details || []).filter(Boolean);
    const detailsText = ['orange', 'rouge'].includes(level) && details.length
      ? `<br><span class="meteo-detail">${details.map((detail) => escapeHtml(detail)).join('<br>')}</span>`
      : '';
    const label = ({ vert: 'Vert', jaune: 'Jaune', orange: 'Orange', rouge: 'Rouge' })[level] || level;
    return `<li><strong>${escapeHtml(alert.phenomenon || '-')}</strong> · <span class="meteo-alert-level ${level}">${label}</span>${detailsText}</li>`;
  };
  const section = (title, alerts) => `<li><strong>${title}</strong><ul>${alerts.map((alert) => alertDetailMarkup(alert)).join('') || '<li>Aucune alerte significative.</li>'}</ul></li>`;
  setHtml('meteo-alerts-list', `${section('En cours (J0)', current)}${section('Demain (J1)', tomorrow)}`);
}

function renderItinisereEvents(events = [], targetId = 'itinerary-list') {
  cachedItinisereEvents = filterCurrentTrafficEvents(events);
  const target = document.getElementById(targetId);
  if (!target) return;
  setHtml(targetId, cachedItinisereEvents.slice(0, 20).map((e) => {
    const title = escapeHtml(e.title || 'Évènement');
    const description = escapeHtml(e.description || '');
    const safeLink = String(e.link || '').startsWith('http') ? e.link : '#';
    const mapQuery = escapeHtml(buildItinisereMapQuery(e)).replace(/"/g, '&quot;');
    const category = escapeHtml(e.category || 'trafic');
    const severity = normalizeTrafficSeverity(e.severity || 'jaune');
    const roads = Array.isArray(e.roads) && e.roads.length ? ` · Axes: ${escapeHtml(e.roads.join(', '))}` : '';
    const locations = Array.isArray(e.locations) && e.locations.length ? ` · Lieux: ${escapeHtml(e.locations.slice(0, 3).join(', '))}` : '';
    const period = e.period_start || e.period_end ? `<br><span class="muted">Période: ${escapeHtml(e.period_start || '?')} → ${escapeHtml(e.period_end || '?')}</span>` : '';
    return `<li><strong>${title}</strong> <span class="badge neutral">${category} · ${severity}</span>${roads}${locations}<br>${description}${period}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Détail</a><br><button type="button" class="ghost inline-action" data-map-query="${mapQuery}">Voir sur la carte</button></li>`;
  }).join('') || '<li>Aucune perturbation publiée.</li>');
}



function sortPrefectureItemsByRecency(items = []) {
  const toTimestamp = (value) => {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...items].sort((a, b) => toTimestamp(b?.published_at) - toTimestamp(a?.published_at));
}

function detectNewsCategory(item = {}) {
  const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  if (/police|gendarmer|pompi|incend|secours/.test(text)) return 'Sécurité & secours';
  if (/météo|orage|inond|neige|canicule|tempête|risque/.test(text)) return 'Météo & risques';
  if (/route|trafic|accident|a48|a43|sncf|transport|train/.test(text)) return 'Mobilité & transport';
  if (/commune|mairie|prefecture|préfecture|département/.test(text)) return 'Institutions locales';
  if (/école|ecole|lycée|lycee|collège|college|universit|crèche|creche/.test(text)) return 'Éducation';
  return 'Autres actualités';
}

function renderNewsCategoryTable(items = []) {
  const stats = new Map();
  items.forEach((item) => {
    const category = detectNewsCategory(item);
    const previous = stats.get(category) || { count: 0, published_at: '' };
    const nextDate = Date.parse(item.published_at || '') > Date.parse(previous.published_at || '')
      ? item.published_at
      : previous.published_at;
    stats.set(category, { count: previous.count + 1, published_at: nextDate });
  });
  const rows = [...stats.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([category, values]) => `<tr><td>${escapeHtml(category)}</td><td>${values.count}</td><td>${escapeHtml(values.published_at || 'Date non précisée')}</td></tr>`)
    .join('');
  setHtml('news-categories-table-body', rows || '<tr><td colspan="3">Aucune actualité catégorisable.</td></tr>');
}

function renderPrefectureNews(prefecture = {}) {
  const items = sortPrefectureItemsByRecency(Array.isArray(prefecture.items) ? prefecture.items : []);
  const latestTitle = items[0]?.title || "Actualité Préfecture de l'Isère";
  setText('prefecture-news-title', latestTitle);
  setText('prefecture-status', `${prefecture.status || 'inconnu'} · ${items.length} actualité(s)`);
  setText('prefecture-info', `Dernière mise à jour: ${prefecture.updated_at ? new Date(prefecture.updated_at).toLocaleString() : 'inconnue'}`);
  setHtml('prefecture-news-list', items.slice(0, 7).map((item) => {
    const title = escapeHtml(item.title || 'Actualité Préfecture');
    const description = escapeHtml(item.description || '');
    const published = item.published_at ? escapeHtml(item.published_at) : 'Date non précisée';
    const safeLink = String(item.link || '').startsWith('http') ? item.link : 'https://www.isere.gouv.fr';
    return `<li><strong>${title}</strong><br><span class="muted">${published}</span>${description ? `<br>${description}` : ''}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Lire l'actualité</a></li>`;
  }).join('') || '<li>Aucune actualité disponible pour le moment.</li>');
}

function renderFrAlertIsere(frAlert = {}) {
  const events = Array.isArray(frAlert.events) ? frAlert.events : [];
  const todayEvents = Array.isArray(frAlert.today_events) ? frAlert.today_events : [];
  const todayCount = Number(frAlert.today_count ?? todayEvents.length);
  setRiskText('fr-alert-status', `${frAlert.status || 'inconnu'} · ${todayCount} aujourd'hui · ${events.length} alerte(s)`, todayCount > 0 ? 'rouge' : 'vert');
  setText('fr-alert-info', `${frAlert.updated_at ? new Date(frAlert.updated_at).toLocaleString() : 'MAJ inconnue'} · source officielle FR-Alert`);
  setHtml('fr-alert-list', events.slice(0, 5).map((event) => {
    const isToday = event.is_today ? '<span class="badge red">Aujourd’hui</span> ' : '';
    const exercise = event.is_exercise ? '<span class="badge neutral">Exercice</span> ' : '';
    const title = escapeHtml(event.title || 'FR-Alert Isère');
    const date = escapeHtml(event.started_at_label || event.started_at || 'Date non précisée');
    const location = event.location ? `<br><span class="muted">${escapeHtml(event.location)}</span>` : '';
    const link = String(event.link || '').startsWith('http') ? event.link : 'https://fr-alert.gouv.fr';
    return `<li>${isToday}${exercise}<strong>${title}</strong><br><span class="muted">${date} · ${escapeHtml(event.source || 'FR-Alert')}</span>${location}<br><a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">Voir l'alerte</a></li>`;
  }).join('') || '<li>Aucune FR-Alert Isère récente détectée.</li>');
}


function renderDauphineNews(dauphine = {}) {
  const items = sortPrefectureItemsByRecency(Array.isArray(dauphine.items) ? dauphine.items : []);
  const panelItems = items.slice(0, 15);
  setRiskText('dauphine-status', `${dauphine.status || 'inconnu'} · ${items.length} article(s)`, dauphine.status === 'online' ? 'vert' : 'jaune');
  setText('dauphine-info', `Dernière mise à jour: ${dauphine.updated_at ? new Date(dauphine.updated_at).toLocaleString() : 'inconnue'}`);
  const servicesMarkup = items.slice(0, 7).map((item) => {
    const title = escapeHtml(item.title || 'Article Le Dauphiné Libéré');
    const description = escapeHtml(item.description || '');
    const published = item.published_at ? escapeHtml(item.published_at) : 'Date non précisée';
    const safeLink = String(item.link || '').startsWith('http') ? item.link : 'https://www.ledauphine.com/isere';
    return `<li><strong>${title}</strong><br><span class="muted">${published}</span>${description ? `<br>${description}` : ''}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Lire l'article</a></li>`;
  }).join('') || '<li>Aucun article Isère disponible pour le moment.</li>';
  const panelMarkup = panelItems.map((item) => {
    const title = escapeHtml(item.title || 'Article Le Dauphiné Libéré');
    const description = escapeHtml(item.description || '');
    const published = item.published_at ? escapeHtml(item.published_at) : 'Date non précisée';
    const safeLink = String(item.link || '').startsWith('http') ? item.link : 'https://www.ledauphine.com/isere';
    const category = detectNewsCategory(item);
    return `<li><strong>${title}</strong> <span class="badge neutral">${escapeHtml(category)}</span><br><span class="muted">${published}</span>${description ? `<br>${description}` : ''}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Lire l'article</a></li>`;
  }).join('') || '<li>Aucun article Isère disponible pour le moment.</li>';
  setHtml('dauphine-news-list', servicesMarkup);
  setHtml('dauphine-news-panel-list', panelMarkup);
  setText('dauphine-news-count', String(panelItems.length));
  renderNewsCategoryTable(panelItems);
}

function renderFranceBleuNews(franceBleu = {}) {
  const items = sortPrefectureItemsByRecency(Array.isArray(franceBleu.items) ? franceBleu.items : []);
  setRiskText('francebleu-status', `${franceBleu.status || 'inconnu'} · ${items.length} article(s)`, franceBleu.status === 'online' ? 'vert' : 'jaune');
  setText('francebleu-info', `Dernière mise à jour: ${franceBleu.updated_at ? new Date(franceBleu.updated_at).toLocaleString() : 'inconnue'}`);
  setHtml('francebleu-news-list', items.slice(0, 7).map((item) => {
    const title = escapeHtml(item.title || 'Article France Bleu Isère');
    const description = escapeHtml(item.description || '');
    const published = item.published_at ? escapeHtml(item.published_at) : 'Date non précisée';
    const safeLink = String(item.link || '').startsWith('http') ? item.link : 'https://www.francebleu.fr/isere';
    return `<li><strong>${title}</strong><br><span class="muted">${published}</span>${description ? `<br>${description}` : ''}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Écouter/lire</a></li>`;
  }).join('') || '<li>Aucun article France Bleu Isère disponible.</li>');
}

function _renderNewsSvcCard(statusId, listId, data, fallbackLink, emptyMsg) {
  const items = sortPrefectureItemsByRecency(Array.isArray(data.items) ? data.items : []);
  setRiskText(statusId, `${data.status || 'inconnu'} · ${items.length} article(s)`, data.status === 'online' ? 'vert' : 'jaune');
  setHtml(listId, items.slice(0, 7).map((item) => {
    const title = escapeHtml(item.title || 'Article');
    const published = item.published_at ? escapeHtml(item.published_at) : '';
    const safeLink = String(item.link || '').startsWith('http') ? item.link : fallbackLink;
    return `<li><strong>${title}</strong>${published ? `<br><span class="muted">${published}</span>` : ''}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Lire ↗</a></li>`;
  }).join('') || `<li>${emptyMsg}</li>`);
}

function renderPlacegrenetNews(data = {}) {
  _renderNewsSvcCard('placegrenet-svc-status', 'placegrenet-svc-list', data, 'https://www.placegrenet.fr', "Aucun article Place Gre'net.");
}

function renderGrenobleMetroNews(data = {}) {
  _renderNewsSvcCard('grenoble-metro-svc-status', 'grenoble-metro-svc-list', data, 'https://www.grenoblealpesmetropole.fr', 'Aucune actualité Métropole.');
}

function renderArsAuraAlerts(data = {}) {
  const items = sortPrefectureItemsByRecency(Array.isArray(data.items) ? data.items : []);
  setRiskText('ars-aura-svc-status', `${data.status || 'inconnu'} · ${items.length} alerte(s)`, data.status === 'online' ? 'vert' : 'jaune');
  setHtml('ars-aura-svc-list', items.slice(0, 7).map((item) => {
    const title = escapeHtml(item.title || 'Alerte sanitaire');
    const published = item.published_at ? escapeHtml(item.published_at) : '';
    const safeLink = String(item.link || '').startsWith('http') ? item.link : 'https://www.auvergne-rhone-alpes.ars.sante.fr';
    return `<li><strong>${title}</strong>${published ? `<br><span class="muted">${published}</span>` : ''}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Détails ↗</a></li>`;
  }).join('') || '<li>Aucune alerte sanitaire ARS.</li>');
}

function renderSeismesIsere(data = {}) {
  const items = Array.isArray(data.items) ? data.items : [];
  const last = items[0];
  const lastMag = last?.magnitude != null ? `M${last.magnitude}` : '';
  const statusLabel = items.length
    ? `${items.length} séisme(s) · Dernier ${lastMag} le ${escapeHtml(last?.date_label || last?.published_at?.slice(0, 10) || '?')}`
    : 'Aucun séisme détecté récemment';
  setRiskText('seismes-svc-status', statusLabel, data.status === 'online' ? 'vert' : 'jaune');
  setText('seismes-svc-info', items.length ? `Source : BCSF-RéNaSS · Isère (30 jours)` : '');
  setHtml('seismes-svc-list', items.slice(0, 6).map((item) => {
    const mag = item.magnitude != null ? item.magnitude : '?';
    const magColor = mag >= 3 ? '#c92a2a' : mag >= 2 ? '#e67700' : '#2b8a3e';
    const place = escapeHtml(item.place || 'Isère');
    const depth = item.depth_km != null ? `prof. ${item.depth_km} km` : '';
    const date = escapeHtml(item.date_label || item.published_at?.slice(0, 16)?.replace('T', ' ') || '—');
    return `<li style="display:flex;align-items:baseline;gap:6px">
      <span style="font-weight:700;color:${magColor};min-width:32px">M${mag}</span>
      <span style="flex:1"><strong>${place}</strong>${depth ? ` <span class="muted">· ${depth}</span>` : ''}</span>
      <span class="muted" style="white-space:nowrap;font-size:11px">${date}</span>
    </li>`;
  }).join('') || '<li class="muted">Aucun séisme détecté récemment.</li>');
}

/* Helpers pour les badges de catégorie dans le nouveau news panel */
function newsBadgeClass(category) {
  if (/Sécurité/.test(category)) return 'news-article-badge--securite';
  if (/Météo/.test(category))    return 'news-article-badge--meteo';
  if (/Mobilité/.test(category)) return 'news-article-badge--transport';
  if (/Institution/.test(category)) return 'news-article-badge--institution';
  if (/Éducation/.test(category))  return 'news-article-badge--education';
  return '';
}

function buildNewsArticleCard(item, fallbackLink) {
  const title = escapeHtml(item.title || 'Actualité');
  const description = item.description ? escapeHtml(item.description) : '';
  const safeLink = String(item.link || '').startsWith('http') ? escapeHtml(item.link) : escapeHtml(fallbackLink);
  const category = detectNewsCategory(item);
  const badgeClass = newsBadgeClass(category);
  const badgeShort = category.replace(' & ', '/').replace('Mobilité/transport', 'Transport').replace('Institutions locales', 'Institutions').replace('Autres actualités', 'Autres');
  let rawDate = item.published_at || '';
  let dateDisplay = 'Date inconnue';
  if (rawDate) {
    try {
      const d = new Date(rawDate);
      dateDisplay = d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) { dateDisplay = escapeHtml(rawDate); }
  }
  return `<a href="${safeLink}" target="_blank" rel="noreferrer" class="news-article-card" data-category="${escapeHtml(category)}">
    <div class="news-article-top">
      <p class="news-article-title">${title}</p>
      <span class="news-article-badge ${badgeClass}">${escapeHtml(badgeShort)}</span>
    </div>
    ${description ? `<p class="news-article-desc">${description}</p>` : ''}
    <span class="news-article-date">${dateDisplay}</span>
  </a>`;
}

function renderNewsPanel(prefecture = {}, dauphine = {}, franceBleu = {}, placegrenet = {}, grenobleMétropole = {}, arsAura = {}, seismesIsere = {}) {
  const prefItems      = sortPrefectureItemsByRecency(Array.isArray(prefecture.items)        ? prefecture.items        : []);
  const dauphItems     = sortPrefectureItemsByRecency(Array.isArray(dauphine.items)          ? dauphine.items          : []);
  const fbItems        = sortPrefectureItemsByRecency(Array.isArray(franceBleu.items)        ? franceBleu.items        : []);
  const pgItems        = sortPrefectureItemsByRecency(Array.isArray(placegrenet.items)       ? placegrenet.items       : []);
  const metroItems     = sortPrefectureItemsByRecency(Array.isArray(grenobleMétropole.items) ? grenobleMétropole.items : []);
  const arsItems       = sortPrefectureItemsByRecency(Array.isArray(arsAura.items)           ? arsAura.items           : []);
  const seismeItems    = Array.isArray(seismesIsere.items) ? seismesIsere.items : [];

  const allItems = [...prefItems, ...dauphItems, ...fbItems, ...pgItems, ...metroItems, ...arsItems, ...seismeItems];
  const totalCount = allItems.length;

  /* Compteurs par source */
  const el = (id) => document.getElementById(id);
  if (el('news-pref-count'))       el('news-pref-count').textContent       = String(prefItems.length);
  if (el('news-dauphine-count'))   el('news-dauphine-count').textContent   = String(dauphItems.length);
  if (el('news-francebleu-count')) el('news-francebleu-count').textContent = String(fbItems.length);
  if (el('news-placegrenet-count')) el('news-placegrenet-count').textContent = String(pgItems.length);
  if (el('news-metro-count'))      el('news-metro-count').textContent      = String(metroItems.length);
  if (el('news-ars-count'))        el('news-ars-count').textContent        = String(arsItems.length);
  if (el('news-seismes-count'))    el('news-seismes-count').textContent    = String(seismeItems.length);
  if (el('news-total-count-badge')) el('news-total-count-badge').textContent = `${totalCount} article${totalCount > 1 ? 's' : ''}`;

  /* Dernière MàJ globale */
  const latestDate = allItems.reduce((best, item) => {
    const t = Date.parse(item.published_at || '') || 0;
    return t > best ? t : best;
  }, 0);
  if (el('news-last-update')) {
    el('news-last-update').textContent = latestDate
      ? `MàJ ${new Date(latestDate).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
      : '';
  }

  /* Statuts source */
  if (el('news-pref-status'))       el('news-pref-status').textContent       = `${prefecture.status || '–'} · ${prefItems.length} actualité(s)`;
  if (el('news-dauphine-status'))   el('news-dauphine-status').textContent   = `${dauphine.status || '–'} · ${dauphItems.length} article(s)`;
  if (el('news-francebleu-status')) el('news-francebleu-status').textContent = `${franceBleu.status || '–'} · ${fbItems.length} article(s)`;
  if (el('news-placegrenet-status')) el('news-placegrenet-status').textContent = `${placegrenet.status || '–'} · ${pgItems.length} article(s)`;
  if (el('news-metro-status'))      el('news-metro-status').textContent      = `${grenobleMétropole.status || '–'} · ${metroItems.length} actualité(s)`;
  if (el('news-ars-status'))        el('news-ars-status').textContent        = `${arsAura.status || '–'} · ${arsItems.length} alerte(s)`;
  if (el('news-seismes-status'))    el('news-seismes-status').textContent    = `${seismesIsere.status || '–'} · ${seismeItems.length} séisme(s)`;

  /* Listes d'articles */
  const renderList = (containerId, items, fallbackLink, emptyMsg) => {
    const container = el(containerId);
    if (!container) return;
    if (!items.length) {
      container.innerHTML = `<p class="muted" style="padding:.5rem">${emptyMsg}</p>`;
      return;
    }
    container.innerHTML = items.slice(0, 12).map((item) => buildNewsArticleCard(item, fallbackLink)).join('');
  };
  renderList('news-prefecture-list',  prefItems,   'https://www.isere.gouv.fr',                    'Aucune actualité Préfecture.');
  renderList('news-dauphine-list',    dauphItems,  'https://www.ledauphine.com/isere',              'Aucun article Dauphiné Libéré.');
  renderList('news-francebleu-list',  fbItems,     'https://www.francebleu.fr/isere',               'Aucun article France Bleu Isère.');
  renderList('news-placegrenet-list', pgItems,     'https://www.placegrenet.fr',                    "Aucun article Place Gre'net.");
  renderList('news-metro-list',       metroItems,  'https://www.grenoblealpesmetropole.fr',         'Aucune actualité Métropole.');
  renderList('news-ars-list',         arsItems,    'https://www.auvergne-rhone-alpes.ars.sante.fr', 'Aucune alerte sanitaire ARS.');
  renderList('news-seismes-list',     seismeItems, 'https://www.franceseisme.fr',                   'Aucun séisme détecté.');

  /* Synthèse catégories (toutes sources) */
  const statsGrid = el('news-stats-grid');
  if (statsGrid) {
    const stats = new Map();
    allItems.forEach((item) => {
      const cat = detectNewsCategory(item);
      stats.set(cat, (stats.get(cat) || 0) + 1);
    });
    const chips = [...stats.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => {
        const cls = newsBadgeClass(cat);
        return `<div class="news-stat-chip"><span class="${cls ? 'news-article-badge ' + cls : ''}" style="background:none;padding:0">${escapeHtml(cat)}</span><span class="news-stat-chip__count">${count}</span></div>`;
      }).join('');
    statsGrid.innerHTML = chips || '<span class="muted" style="font-size:.82rem">Aucune donnée disponible.</span>';
  }

  /* Filtres catégorie */
  const filterBar = el('news-filter-bar');
  if (filterBar && !filterBar.dataset.bound) {
    filterBar.dataset.bound = '1';
    filterBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.news-filter-btn');
      if (!btn) return;
      filterBar.querySelectorAll('.news-filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const cat = btn.dataset.cat;
      document.querySelectorAll('.news-article-card').forEach((card) => {
        if (cat === 'all' || card.dataset.category === cat) {
          card.classList.remove('news-article-hidden');
        } else {
          card.classList.add('news-article-hidden');
        }
      });
    });
  }
}

function sanitizeMeteoInformation(info = '') {
  const text = String(info || '').trim();
  const unwanted = "Consultez la carte de Vigilance de Météo-France sur l'ISERE (38) : Information sur les risques météorologiques de la journée en cours.";
  if (text === unwanted) return '';
  return text;
}

function bisonTrafficSplitBar(departureLevel, arrivalLevel) {
  const severityByLevel = { inconnu: -1, vert: 0, jaune: 1, orange: 2, rouge: 3 };
  const departure = normalizeLevel(departureLevel || 'inconnu');
  const arrival = normalizeLevel(arrivalLevel || 'inconnu');
  const dominantLevel = (severityByLevel[arrival] ?? -1) > (severityByLevel[departure] ?? -1) ? arrival : departure;
  const label = `${escapeHtml(departureLevel || 'inconnu')} / ${escapeHtml(arrivalLevel || 'inconnu')}`;

  return `
    <div class="bison-isere-square__single ${dominantLevel}" role="img" aria-label="Bison Futé Isère: départ / arrivée ${label}">
      <span>Départ / Arrivée</span>
      <strong>${label}</strong>
    </div>
  `;
}

function renderVigieauAlerts(vigieau = {}) {
  const alerts = Array.isArray(vigieau.alerts) ? vigieau.alerts : [];
  const maxLevel = vigieau.max_level || 'vert';
  setRiskText('vigieau-status', `${vigieau.status || 'inconnu'} · niveau ${normalizeLevel(maxLevel)}`, maxLevel);
  setText('vigieau-info', `${alerts.length} alerte(s) restriction d'eau · source Vigieau`);
  setHtml('vigieau-list', alerts.slice(0, 8).map((alert) => {
    const zone = escapeHtml(alert.zone || 'Zone Isère');
    const level = escapeHtml(alert.level || 'non définie');
    const measure = escapeHtml(alert.measure || 'Restriction en vigueur');
    const period = alert.start_date || alert.end_date
      ? `<br><span class="muted">Période: ${escapeHtml(alert.start_date || '?')} → ${escapeHtml(alert.end_date || '?')}</span>`
      : '';
    return `<li><strong>${zone}</strong> · <span style="color:${levelColor(alert.level_color || 'vert')}">${level}</span><br>${measure}${period}</li>`;
  }).join('') || "<li>Aucune restriction d'eau active signalée pour l'Isère.</li>");
}


function renderBisonFuteSummary(bison = {}) {
  cachedBisonFute = bison || {};
  cachedBisonLiveEvents = filterCurrentTrafficEvents(Array.isArray(bison.live?.events) ? bison.live.events : [])
    .map((event) => {
      const coords = normalizeMapCoordinates(event.lat, event.lon);
      if (!coords) return null;
      return { ...event, lat: coords.lat, lon: coords.lon };
    })
    .filter(Boolean);
  const today = bison.today || {};
  const tomorrow = bison.tomorrow || {};
  const isereToday = today.isere || {};
  const isereTomorrow = tomorrow.isere || {};
  const nationalToday = today.national || {};
  const nationalTomorrow = tomorrow.national || {};
  const isereDeparture = keepLastKnownStatus('bison_isere_departure', isereToday.departure || 'inconnu');
  const isereReturn = keepLastKnownStatus('bison_isere_return', isereToday.return || 'inconnu');
  const nationalDeparture = keepLastKnownStatus('bison_national_departure', nationalToday.departure || 'inconnu');
  const nationalReturn = keepLastKnownStatus('bison_national_return', nationalToday.return || 'inconnu');
  const nationalTomorrowDeparture = keepLastKnownStatus('bison_national_tomorrow_departure', nationalTomorrow.departure || 'inconnu');
  const nationalTomorrowReturn = keepLastKnownStatus('bison_national_tomorrow_return', nationalTomorrow.return || 'inconnu');
  setText('bison-status', `${bison.status || 'inconnu'} · Isère départ ${isereDeparture} / retour ${isereReturn}`);
  const lastUpdate = bison.updated_at ? new Date(bison.updated_at).toLocaleTimeString() : 'non précisée';
  const liveCount = cachedBisonLiveEvents.length;
  setText('bison-info', `National J0: ${nationalDeparture} / ${nationalReturn} · J1: ${nationalTomorrowDeparture} / ${nationalTomorrowReturn} · Événements trafic Isère: ${liveCount} · MAJ ${lastUpdate}`);
  setText('map-bison-isere', `${isereDeparture} (retour ${isereReturn})`);
  setText('home-feature-bison-isere', `${isereDeparture} / ${isereReturn}`);
  setHtml('bison-isere-square', bisonTrafficSplitBar(isereDeparture, isereReturn));

  const bisonMarkup = [
    `<li><strong>Aujourd'hui (${today.date || '-'})</strong><br>Isère départ: ${isereDeparture} · Isère retour: ${isereReturn}<br>National départ: ${nationalDeparture} · National retour: ${nationalReturn}<br><a href="https://www.bison-fute.gouv.fr" target="_blank" rel="noreferrer">Voir la carte Bison Futé</a></li>`,
    `<li><strong>Demain (${tomorrow.date || '-'})</strong><br>Isère départ: ${isereTomorrow.departure || 'inconnu'} · Isère retour: ${isereTomorrow.return || 'inconnu'}<br>National départ: ${nationalTomorrow.departure || 'inconnu'} · National retour: ${nationalTomorrow.return || 'inconnu'}</li>`,
  ].join('');
  setHtml('bison-list', bisonMarkup);

  const communiqueMarkup = [
    `<li><strong>Communiqué du jour (${today.date || '-'})</strong><br>Isère: départ <strong>${escapeHtml(isereDeparture)}</strong> · retour <strong>${escapeHtml(isereReturn)}</strong><br>National: départ ${escapeHtml(nationalDeparture)} · retour ${escapeHtml(nationalReturn)}<br><span class="muted">Dernière mise à jour: ${escapeHtml(lastUpdate)}</span><br><a href="https://www.bison-fute.gouv.fr/previsions.html" target="_blank" rel="noreferrer">Lire le communiqué Bison Futé</a></li>`,
    `<li><strong>Communiqué de demain (${tomorrow.date || '-'})</strong><br>Isère: départ <strong>${escapeHtml(isereTomorrow.departure || 'inconnu')}</strong> · retour <strong>${escapeHtml(isereTomorrow.return || 'inconnu')}</strong><br>National: départ ${escapeHtml(nationalTomorrow.departure || 'inconnu')} · retour ${escapeHtml(nationalTomorrow.return || 'inconnu')}<br><a href="https://www.bison-fute.gouv.fr/previsions.html" target="_blank" rel="noreferrer">Voir les prévisions J+1</a></li>`,
  ].join('');
  setHtml('bison-communique-list', communiqueMarkup);
}

function renderHomeMeteoSituation(situations = []) {
  const markup = situations.map((item) => `<li>${item.label}: <strong>${normalizeLevel(item.level)}</strong></li>`).join('') || '<li>Aucune vigilance significative en cours.</li>';
  setHtml('home-meteo-situation', markup);
}

function georisquesDangerLevel(commune = {}) {
  const seismicMatch = String(commune.seismic_zone || commune.zone_sismicite || '').match(/(\d+)/);
  const seismic = Number(seismicMatch?.[1] || 0);
  const flood = Number(commune.flood_documents || commune.nb_documents || 0);
  const ppr = Number(commune.ppr_total || 0);
  const movements = Number(commune.ground_movements_total || 0);
  const radonClass = Number(commune.radon_class || 0);
  let score = 0;
  if (seismic >= 3) score += 2;
  else if (seismic >= 2) score += 1;
  if (flood > 0) score += 1;
  if (ppr >= 3) score += 2;
  else if (ppr > 0) score += 1;
  if (movements >= 3) score += 2;
  else if (movements > 0) score += 1;
  if (radonClass >= 3) score += 2;
  else if (radonClass >= 2) score += 1;

  if (score >= 7) return { label: 'Très élevé', css: 'tres-eleve' };
  if (score >= 5) return { label: 'Élevé', css: 'eleve' };
  if (score >= 3) return { label: 'Modéré', css: 'modere' };
  return { label: 'Faible', css: 'faible' };
}

function georisquesDangerRank(commune = {}) {
  const level = georisquesDangerLevel(commune).label;
  const rank = { 'Très élevé': 4, 'Élevé': 3, 'Modéré': 2, 'Faible': 1 };
  return rank[level] || 0;
}

let selectedGeorisquesPcsCommuneKey = '';

function georisquesCommuneKey(commune = {}) {
  return String(commune.code_insee || commune.insee || commune.name || commune.commune || '').trim().toLowerCase();
}

function georisquesHazardTone(hazard = {}) {
  const dangerText = String(hazard.knownDanger || '').toLowerCase();
  if (/très élevé|eleve|élevé/.test(dangerText)) return 'tres-eleve';
  if (/modéré|modere|présent|present|zone 3|zone 4|zone 5/.test(dangerText)) return 'eleve';
  if (!hazard.applies) return 'faible';
  return 'modere';
}

function georisquesSlugText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildGeorisquesMunicipalityUrl({ communeName = '', insee = '', postalCode = '', latitude = null, longitude = null } = {}) {
  const safeName = String(communeName || '').trim();
  const city = georisquesSlugText(safeName) || safeName;
  const code = String(insee || '').trim();
  const cp = String(postalCode || '').trim();
  const lat = Number(latitude);
  const lon = Number(longitude);
  const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lon);

  const params = new URLSearchParams();
  params.set('form-adresse', 'true');
  params.set('isCadastre', 'false');
  params.set('city', city);
  params.set('type', 'adresse');
  params.set('typeForm', 'adresse');
  if (code) params.set('codeInsee', code);
  if (hasCoordinates) {
    params.set('lon', String(lon));
    params.set('lat', String(lat));
  }
  params.set('go_back', '/');
  params.set('propertiesType', 'municipality');
  params.set('adresse', cp ? `${safeName}, ${cp} ${safeName}` : safeName);
  if (hasCoordinates) {
    params.set('longitude', String(lon));
    params.set('latitude', String(lat));
  }
  params.set('commune', city);
  return `https://www.georisques.gouv.fr/mes-risques/connaitre-les-risques-pres-de-chez-moi/rapport2?${params.toString()}`;
}

function renderGeorisquesPcsDetail(commune) {
  if (!commune) {
    setHtml('georisques-pcs-detail', '<p class="muted">Sélectionnez une commune PCS pour afficher sa lecture opérationnelle.</p>');
    const overview = document.getElementById('georisques-overview');
    if (overview) {
      overview.hidden = true;
      overview.classList.add('hidden');
    }
    return;
  }

  const communeName = commune.name || commune.commune || 'Commune inconnue';
  const insee = commune.code_insee || commune.insee || '';
  const danger = georisquesDangerLevel(commune);
  const gasparRisks = Array.isArray(commune.gaspar_risks) ? commune.gaspar_risks : [];
  const docs = Array.isArray(commune.flood_documents_details) ? commune.flood_documents_details : [];
  const hazardCatalogue = [
    {
      label: 'Sismicité',
      knownDanger: commune.seismic_zone || commune.zone_sismicite || 'inconnue',
      applies: String(commune.seismic_zone || commune.zone_sismicite || '').toLowerCase() !== 'inconnue',
      detail: `Zone ${escapeHtml(String(commune.seismic_zone || commune.zone_sismicite || 'inconnue'))}`,
    },
    {
      label: 'Radon',
      knownDanger: commune.radon_label || 'inconnu',
      applies: Number(commune.radon_class || 0) > 0,
      detail: `Classe ${Number(commune.radon_class || 0) || 'non renseignée'}`,
    },
    {
      label: 'Inondation',
      knownDanger: Number(commune.flood_documents || commune.nb_documents || 0) > 0 ? 'Présent' : 'Faible',
      applies: Number(commune.flood_documents || commune.nb_documents || 0) > 0,
      detail: `${Number(commune.flood_documents || commune.nb_documents || 0)} document(s)`,
    },
    {
      label: 'Plan de prévention des risques naturels',
      knownDanger: Number(commune.ppr_by_risk?.pprn || 0) > 0 ? 'Présent' : 'Faible',
      applies: Number(commune.ppr_by_risk?.pprn || 0) > 0,
      detail: `${Number(commune.ppr_by_risk?.pprn || 0)} plan(s)`,
    },
    {
      label: 'Plan de prévention des risques miniers',
      knownDanger: Number(commune.ppr_by_risk?.pprm || 0) > 0 ? 'Présent' : 'Faible',
      applies: Number(commune.ppr_by_risk?.pprm || 0) > 0,
      detail: `${Number(commune.ppr_by_risk?.pprm || 0)} plan(s)`,
    },
    {
      label: 'Plan de prévention des risques technologiques',
      knownDanger: Number(commune.ppr_by_risk?.pprt || 0) > 0 ? 'Présent' : 'Faible',
      applies: Number(commune.ppr_by_risk?.pprt || 0) > 0,
      detail: `${Number(commune.ppr_by_risk?.pprt || 0)} plan(s)`,
    },
    {
      label: 'Mouvements de terrain',
      knownDanger: Number(commune.ground_movements_total || 0) > 0 ? 'Présent' : 'Faible',
      applies: Number(commune.ground_movements_total || 0) > 0,
      detail: `${Number(commune.ground_movements_total || 0)} événement(s)`,
    },
    {
      label: 'Cavités',
      knownDanger: Number(commune.cavities_total || 0) > 0 ? 'Présent' : 'Faible',
      applies: Number(commune.cavities_total || 0) > 0,
      detail: `${Number(commune.cavities_total || 0)} occurrence(s)`,
    },
    {
      label: 'Transport de matières dangereuses',
      knownDanger: Number(commune.tim_total || 0) > 0 ? 'Présent' : 'Faible',
      applies: Number(commune.tim_total || 0) > 0,
      detail: `${Number(commune.tim_total || 0)} signalement(s)`,
    },
    {
      label: 'Information risques',
      knownDanger: Number(commune.risques_information_total || 0) > 0 ? 'Présent' : 'Faible',
      applies: Number(commune.risques_information_total || 0) > 0,
      detail: `${Number(commune.risques_information_total || 0)} élément(s)`,
    },
    {
      label: 'Document d\'information communal sur les risques majeurs',
      knownDanger: commune.dicrim_publication_year ? 'Disponible' : 'Non renseigné',
      applies: Boolean(commune.dicrim_publication_year),
      detail: commune.dicrim_publication_year ? `Publication ${escapeHtml(String(commune.dicrim_publication_year))}` : 'Aucune publication connue',
    },
  ];

  const gasparItems = gasparRisks.length
    ? gasparRisks.map((risk) => ({
      label: risk,
      knownDanger: commune.gaspar_danger_level || danger.label,
      applies: true,
      detail: 'Risque GASPAR identifié',
    }))
    : [{
      label: 'Risques GASPAR',
      knownDanger: 'Non détaillé',
      applies: false,
      detail: 'Aucun libellé détaillé remonté',
    }];

  const allHazards = [...hazardCatalogue, ...gasparItems];
  const risksMarkup = allHazards
    .map((hazard) => {
      const tone = georisquesHazardTone(hazard);
      return `<li class="georisques-risk-line"><strong>${escapeHtml(String(hazard.label || 'Risque'))}</strong> <span class="hazard-chip ${tone}">${escapeHtml(String(hazard.knownDanger || 'inconnu'))}</span> <span class="muted">· ${hazard.applies ? 'applicable' : 'non confirmé'}</span>${hazard.detail ? `<br><span class="muted">${escapeHtml(String(hazard.detail))}</span>` : ''}</li>`;
    })
    .join('');

  const docsText = docs.length
    ? docs.slice(0, 10).map((doc) => `<li>${escapeHtml(doc.title || doc.libelle_azi || 'Document inondation')}${doc.river_basin ? ` · Bassin ${escapeHtml(doc.river_basin)}` : ''}${doc.published_at ? ` · Diffusion ${escapeHtml(doc.published_at)}` : ''}</li>`).join('')
    : '<li>Aucun document inondation détaillé.</li>';

  const municipality = cachedMunicipalities.find((item) => String(item.insee_code || '').trim() === insee);
  const georisquesSearchUrl = buildGeorisquesMunicipalityUrl({
    communeName,
    insee,
    postalCode: municipality?.postal_code || '',
    latitude: commune.latitude,
    longitude: commune.longitude,
  });
  const georisquesMainUrl = 'https://www.georisques.gouv.fr/';
  const dicrimUrl = commune.dicrim_publication_year && insee
    ? `https://www.georisques.gouv.fr/DICRIM/${encodeURIComponent(insee)}`
    : '';
  const cityDocuments = [];
  if (commune.dicrim_publication_year) {
    cityDocuments.push(`DICRIM · publication ${escapeHtml(String(commune.dicrim_publication_year))}${dicrimUrl ? ` · <a href="${dicrimUrl}" target="_blank" rel="noreferrer">ouvrir le document ↗</a>` : ''}`);
  }
  if (Number(commune.ppr_by_risk?.pprn || 0) > 0) {
    cityDocuments.push(`PPRN · ${Number(commune.ppr_by_risk?.pprn || 0)} document(s)`);
  }
  if (Number(commune.ppr_by_risk?.pprm || 0) > 0) {
    cityDocuments.push(`PPRM · ${Number(commune.ppr_by_risk?.pprm || 0)} document(s)`);
  }
  if (Number(commune.ppr_by_risk?.pprt || 0) > 0) {
    cityDocuments.push(`PPRT · ${Number(commune.ppr_by_risk?.pprt || 0)} document(s)`);
  }
  if (Number(commune.tim_total || 0) > 0) {
    cityDocuments.push(`TIM · ${Number(commune.tim_total || 0)} information(s)`);
  }
  if (Number(commune.risques_information_total || 0) > 0) {
    cityDocuments.push(`Informations risques · ${Number(commune.risques_information_total || 0)} élément(s)`);
  }
  const cityDocumentsMarkup = cityDocuments.length
    ? cityDocuments.map((doc) => `<li>${doc}</li>`).join('')
    : '<li>Aucun document communal supplémentaire détecté.</li>';

  const topKpis = [
    { label: 'Danger agrégé', value: commune.gaspar_danger_level || danger.label, chip: `danger-chip ${danger.css}` },
    { label: 'Sismicité', value: commune.seismic_zone || commune.zone_sismicite || 'inconnue' },
    { label: 'Radon', value: commune.radon_label || 'inconnu' },
    { label: 'Inondation', value: `${Number(commune.flood_documents || commune.nb_documents || 0)} doc(s)` },
    { label: 'PPR', value: String(Number(commune.ppr_total || 0)) },
    { label: 'Terrain', value: String(Number(commune.ground_movements_total || 0)) },
    { label: 'Cavités', value: String(Number(commune.cavities_total || 0)) },
    { label: 'TIM', value: String(Number(commune.tim_total || 0)) },
  ];
  const hasDetailedData = Boolean(
    Number(commune.flood_documents || commune.nb_documents || 0)
    || Number(commune.ppr_total || 0)
    || Number(commune.ground_movements_total || 0)
    || Number(commune.cavities_total || 0)
    || Number(commune.tim_total || 0)
    || Number(commune.risques_information_total || 0)
    || String(commune.seismic_zone || commune.zone_sismicite || '').trim()
    || String(commune.radon_label || '').trim()
    || Array.isArray(commune.gaspar_risks) && commune.gaspar_risks.length
  );
  const fallbackInfo = hasDetailedData
    ? ''
    : `<p class="muted">Aucune donnée détaillée Géorisques n’a encore été remontée pour cette commune. Le sélecteur reste néanmoins disponible à partir de tes communes PCS locales.</p>`;
  const overview = document.getElementById('georisques-overview');
  if (overview) {
    overview.hidden = true;
    overview.classList.add('hidden');
  }

  setHtml('georisques-pcs-detail', `
    <div class="georisques-commune-head">
      <div>
        <p class="tag">Commune sélectionnée</p>
        <h3>${escapeHtml(communeName)}</h3>
        <p class="muted">Code INSEE ${escapeHtml(insee || '-')}</p>
      </div>
      <div class="georisques-commune-links">
        <a href="${georisquesSearchUrl}" target="_blank" rel="noreferrer">Rapport Géorisques ↗</a>
        <a href="${georisquesMainUrl}" target="_blank" rel="noreferrer">Portail national ↗</a>
      </div>
    </div>
    <div class="georisques-commune-kpis">
      ${topKpis.map((item) => `<article class="georisques-commune-kpi"><span>${escapeHtml(item.label)}</span><strong class="${escapeHtml(item.chip || '')}">${escapeHtml(item.value)}</strong></article>`).join('')}
    </div>
    ${fallbackInfo}
    <div class="georisques-commune-columns">
      <section class="georisques-commune-card">
        <h5>Risques confirmés ou signalés</h5>
        <ul class="list compact">${risksMarkup}</ul>
      </section>
      <section class="georisques-commune-card">
        <h5>Documents et prévention</h5>
        <p class="muted" style="margin:.2rem 0 .5rem">DICRIM, PPR, TIM et documents inondation utiles pour la commune.</p>
        <div class="georisques-doc-columns">
          <div>
            <strong style="font-size:.82rem">Inondation / AZI</strong>
            <ul class="list compact">${docsText}</ul>
          </div>
          <div>
            <strong style="font-size:.82rem">Prévention communale</strong>
            <ul class="list compact">${cityDocumentsMarkup}</ul>
          </div>
        </div>
      </section>
    </div>
  `);
}

function renderGeorisquesPcsRisks(monitored = []) {
  const pcsMunicipalities = cachedMunicipalities
    .filter((municipality) => municipality?.pcs_active)
    .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), 'fr'));
  const monitoredByKey = new Map(
    (Array.isArray(monitored) ? monitored : []).map((commune) => [georisquesCommuneKey(commune), commune]),
  );
  const monitoredByName = new Map(
    (Array.isArray(monitored) ? monitored : []).map((commune) => [String(commune?.name || commune?.commune || '').trim().toLowerCase(), commune]),
  );
  const pcsMonitored = pcsMunicipalities.map((municipality) => {
    const insee = String(municipality.insee_code || '').trim();
    const byInsee = insee ? monitoredByKey.get(insee) : null;
    const byName = monitoredByName.get(String(municipality.name || '').trim().toLowerCase());
    if (byInsee || byName) return byInsee || byName;
    return {
      name: municipality.name || 'Commune inconnue',
      commune: municipality.name || 'Commune inconnue',
      code_insee: insee,
      insee,
      postal_code: municipality.postal_code || '',
      gaspar_danger_level: municipality.vigilance_color || 'Faible',
      seismic_zone: 'inconnue',
      radon_label: 'inconnu',
      flood_documents: 0,
      ppr_total: 0,
      ground_movements_total: 0,
      cavities_total: 0,
      tim_total: 0,
      risques_information_total: 0,
      gaspar_risks: [],
    };
  });

  if (selectedGeorisquesPcsCommuneKey && !pcsMonitored.some((commune) => georisquesCommuneKey(commune) === selectedGeorisquesPcsCommuneKey)) {
    selectedGeorisquesPcsCommuneKey = '';
  }
  if (currentUser?.role === 'mairie' && pcsMonitored.length === 1) {
    selectedGeorisquesPcsCommuneKey = georisquesCommuneKey(pcsMonitored[0]);
  }

  const select = document.getElementById('georisques-pcs-select');
  if (select) {
    const options = pcsMonitored.map((commune) => {
      const key = georisquesCommuneKey(commune);
      return `<option value="${escapeHtml(key)}">${escapeHtml(commune.name || commune.commune || 'Commune inconnue')} (${escapeHtml(commune.code_insee || '-')})</option>`;
    }).join('');
    const placeholder = currentUser?.role === 'mairie' ? '' : '<option value="">Sélectionnez une commune PCS</option>';
    setHtml('georisques-pcs-select', `${placeholder}${options}`);
    select.disabled = currentUser?.role === 'mairie';
    if (selectedGeorisquesPcsCommuneKey) {
      select.value = selectedGeorisquesPcsCommuneKey;
    } else {
      select.value = '';
    }
  }

  const selectedCommune = pcsMonitored.find((commune) => georisquesCommuneKey(commune) === selectedGeorisquesPcsCommuneKey) || null;
  renderGeorisquesPcsDetail(selectedCommune);
}

function renderGeorisquesDetails(georisques = {}) {
  const sig = JSON.stringify([
    georisques.status, georisques.highest_seismic_zone_label, georisques.flood_documents_total,
    georisques.ppr_total, georisques.ground_movements_total, georisques.cavities_total,
    georisques.monitored_communes?.length, georisques.monitored_municipalities?.length, georisques.communes?.length,
  ]);
  if (sig === lastRenderedGeorisquesSignature) return;
  lastRenderedGeorisquesSignature = sig;
  const monitored = georisques.monitored_communes || georisques.monitored_municipalities || georisques.communes || [];
  const errorDetails = Array.isArray(georisques.errors) ? georisques.errors.filter(Boolean) : [];
  const movementTypes = georisques.movement_types && typeof georisques.movement_types === 'object' ? georisques.movement_types : {};
  const recentMovements = Array.isArray(georisques.recent_ground_movements) ? georisques.recent_ground_movements : [];
  const radonDistribution = georisques.radon_distribution && typeof georisques.radon_distribution === 'object' ? georisques.radon_distribution : null;

  setText('georisques-page-status', georisques.status || 'inconnu');
  setText('georisques-page-seismic', georisques.highest_seismic_zone_label || 'inconnue');
  setText('georisques-page-flood-docs', String(georisques.flood_documents_total ?? 0));
  setText('georisques-page-ppr-total', String(georisques.ppr_total ?? 0));
  setText('georisques-page-ground-movements', String(georisques.ground_movements_total ?? 0));
  setText('georisques-page-cavities', String(georisques.cavities_total ?? 0));
  setText('georisques-page-radon-alert', String(georisques.communes_with_radon_moderate_or_high ?? 0));
  setText('georisques-page-api-mode', georisques.api_mode || 'auto');

  const sourceText = `Source: ${georisques.source || 'inconnue'} · Dernière mise à jour: ${georisques.updated_at ? new Date(georisques.updated_at).toLocaleString() : 'inconnue'}`;
  const errorsText = errorDetails.length ? ` · Anomalies: ${errorDetails.join(' | ')}` : '';
  const radonText = radonDistribution ? ` · Radon (faible/moyen/élevé): ${Number(radonDistribution.faible || 0)}/${Number(radonDistribution.moyen || 0)}/${Number(radonDistribution.eleve || 0)}` : '';
  const pprCategories = georisques.ppr_categories && typeof georisques.ppr_categories === 'object' ? georisques.ppr_categories : null;
  const pprText = pprCategories ? ` · PPR (N/M/T): ${Number(pprCategories.pprn || 0)}/${Number(pprCategories.pprm || 0)}/${Number(pprCategories.pprt || 0)}` : '';
  const preventionText = ` · DICRIM: ${Number(georisques.dicrim_total || 0)} · TIM: ${Number(georisques.tim_total || 0)} · Info-risques: ${Number(georisques.risques_information_total || 0)}`;
  setText('georisques-page-source', `${sourceText}${radonText}${pprText}${preventionText}${errorsText}`);
  setText('georisques-page-debug', monitored.length ? '' : `Aucune commune détaillée reçue (clés: ${Object.keys(georisques || {}).join(', ') || 'aucune'}).`);

  const overview = document.getElementById('georisques-overview');
  if (overview) {
    overview.hidden = true;
    overview.classList.add('hidden');
  }

  const movementTypesMarkup = Object.entries(movementTypes)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([type, count]) => `<li><strong>${escapeHtml(type)}</strong> · ${Number(count || 0)} signalement(s)</li>`)
    .join('') || '<li>Aucune répartition disponible.</li>';
  setHtml('georisques-movement-types-list', movementTypesMarkup);

  const recentMovementsMarkup = recentMovements.map((event) => {
    const dateText = event.date ? new Date(event.date).toLocaleDateString() : 'Date inconnue';
    const reliability = event.reliability ? ` · Fiabilité: ${escapeHtml(String(event.reliability))}` : '';
    const identifier = event.identifier ? ` · ID: ${escapeHtml(String(event.identifier))}` : '';
    const location = event.location ? `<br>Lieu: ${escapeHtml(String(event.location))}` : '';
    return `<li><strong>${escapeHtml(event.commune || 'Commune inconnue')}</strong> · ${escapeHtml(event.type || 'Mouvement de terrain')} · ${dateText}${reliability}${identifier}${location}</li>`;
  }).join('') || '<li>Aucun mouvement de terrain récent exploitable.</li>';
  setHtml('georisques-recent-movements-list', recentMovementsMarkup);

  const priorityCommunesMarkup = [...monitored]
    .sort((a, b) => georisquesDangerRank(b) - georisquesDangerRank(a))
    .slice(0, 8)
    .map((commune) => {
      const danger = georisquesDangerLevel(commune);
      const recentFlag = Number(commune.ground_movements_total || 0) > 0 ? ' · activité terrain récente' : '';
      return `<li><strong>${escapeHtml(commune.name || commune.commune || 'Commune inconnue')}</strong> <span class="danger-chip ${danger.css}">${escapeHtml(danger.label)}</span><br>Sismicité: <strong>${escapeHtml(commune.seismic_zone || commune.zone_sismicite || 'inconnue')}</strong> · Plans de prévention: <strong>${Number(commune.ppr_total || 0)}</strong> · Inondation: <strong>${Number(commune.flood_documents || commune.nb_documents || 0)}</strong>${recentFlag}</li>`;
    }).join('') || '<li>Aucune commune prioritaire calculable.</li>';
  setHtml('georisques-priority-communes-list', priorityCommunesMarkup);

  const markup = monitored.map((commune) => {
    const docs = Array.isArray(commune.flood_documents_details) ? commune.flood_documents_details : [];
    const pprByRisk = commune.ppr_by_risk && typeof commune.ppr_by_risk === 'object' ? commune.ppr_by_risk : {};
    const pprText = Object.entries(pprByRisk).map(([risk, count]) => `${escapeHtml(risk)} (${Number(count || 0)})`).join(', ') || 'Aucun PPR détaillé';
    const communeErrors = Array.isArray(commune.errors) ? commune.errors.filter(Boolean) : [];

    const docsMarkup = docs.length
      ? `<ul class="list compact">${docs.slice(0, 6).map((doc) => {
        const docUrl = georisquesDocumentUrl(doc, commune);
        const consultLink = docUrl ? ` · <a href="${escapeHtml(docUrl)}" target="_blank" rel="noreferrer">Consulter</a>` : '';
        return `<li><strong>${escapeHtml(doc.title || doc.libelle_azi || 'Document inondation')}</strong>${doc.code ? ` (${escapeHtml(doc.code)})` : ''}${doc.river_basin ? ` · Bassin: ${escapeHtml(doc.river_basin)}` : ''}${doc.published_at ? ` · Diffusion: ${escapeHtml(doc.published_at)}` : ''}${consultLink}</li>`;
      }).join('')}</ul>`
      : '<span class="muted">Aucun détail de document remonté.</span>';

    const gasparRisks = Array.isArray(commune.gaspar_risks) ? commune.gaspar_risks : [];
    return `<li><strong>${escapeHtml(commune.name || commune.commune || 'Commune inconnue')}</strong> (${escapeHtml(commune.code_insee || commune.insee || '-')})<br>Sismicité: <strong>${escapeHtml(commune.seismic_zone || commune.zone_sismicite || 'inconnue')}</strong> · Radon: <strong>${escapeHtml(commune.radon_label || 'inconnu')}</strong><br>Inondation: <strong>${Number(commune.flood_documents || commune.nb_documents || 0)}</strong> · Plans de prévention: <strong>${Number(commune.ppr_total || 0)}</strong> · Mouvements: <strong>${Number(commune.ground_movements_total || 0)}</strong> · Cavités: <strong>${Number(commune.cavities_total || 0)}</strong><br>Document d'information communal sur les risques majeurs: <strong>${escapeHtml(commune.dicrim_publication_year || 'non renseigné')}</strong> · Transport de matières dangereuses: <strong>${Number(commune.tim_total || 0)}</strong> · Information risques: <strong>${Number(commune.risques_information_total || 0)}</strong><br>Risques recensés: <strong>${Number(commune.gaspar_risk_total || gasparRisks.length || 0)}</strong>${gasparRisks.length ? ` · ${gasparRisks.slice(0, 6).map((risk) => escapeHtml(risk)).join(', ')}` : ''}<br>Plans de prévention par risque: ${pprText}${communeErrors.length ? `<br><span class="muted">Anomalies commune: ${escapeHtml(communeErrors.join(' | '))}</span>` : ''}<br>${docsMarkup}</li>`;
  }).join('') || '<li>Aucune commune remontée par Géorisques.</li>';
  setHtml('georisques-communes-list', markup);
  renderGeorisquesPcsRisks(monitored);

  const allDocs = monitored.flatMap((commune) => {
    const docs = Array.isArray(commune.flood_documents_details) ? commune.flood_documents_details : [];
    const communeName = commune.name || commune.commune || 'Commune inconnue';
    const extraDocs = [];
    if (commune.dicrim_publication_year) {
      extraDocs.push({
        communeName,
        commune,
        doc: { title: 'DICRIM', code: commune.code_insee || commune.insee || '', published_at: String(commune.dicrim_publication_year) },
      });
    }
    if (Number(commune.ppr_by_risk?.pprn || 0) > 0) {
      extraDocs.push({ communeName, commune, doc: { title: 'PPRN', code: `${Number(commune.ppr_by_risk?.pprn || 0)} doc(s)` } });
    }
    if (Number(commune.ppr_by_risk?.pprm || 0) > 0) {
      extraDocs.push({ communeName, commune, doc: { title: 'PPRM', code: `${Number(commune.ppr_by_risk?.pprm || 0)} doc(s)` } });
    }
    if (Number(commune.ppr_by_risk?.pprt || 0) > 0) {
      extraDocs.push({ communeName, commune, doc: { title: 'PPRT', code: `${Number(commune.ppr_by_risk?.pprt || 0)} doc(s)` } });
    }
    if (Number(commune.tim_total || 0) > 0) {
      extraDocs.push({ communeName, commune, doc: { title: 'TIM', code: `${Number(commune.tim_total || 0)} info(s)` } });
    }
    if (Number(commune.risques_information_total || 0) > 0) {
      extraDocs.push({ communeName, commune, doc: { title: 'Informations risques', code: `${Number(commune.risques_information_total || 0)} élément(s)` } });
    }
    return [
      ...docs.map((doc) => ({ communeName, doc, commune })),
      ...extraDocs,
    ];
  });

  const docsListMarkup = allDocs.map(({ communeName, doc, commune }) => {
    const docUrl = georisquesDocumentUrl(doc, commune);
    const consultLink = docUrl ? ` · <a href="${escapeHtml(docUrl)}" target="_blank" rel="noreferrer">Consulter</a>` : '';
    return `
    <li><strong>${escapeHtml(communeName)}</strong> · ${escapeHtml(doc.title || doc.libelle_azi || 'Document inondation')}${doc.code ? ` (${escapeHtml(doc.code)})` : ''}${doc.river_basin ? ` · Bassin: ${escapeHtml(doc.river_basin)}` : ''}${doc.published_at ? ` · Diffusion: ${escapeHtml(doc.published_at)}` : ''}${consultLink}</li>
  `;
  }).join('') || '<li>Aucun document Géorisques associé affichable.</li>';
  setHtml('georisques-documents-list', docsListMarkup);
}


function openMunicipalityEditor(municipality) {
  const panel = document.getElementById('municipality-editor');
  const form = document.getElementById('municipality-edit-form');
  if (!panel || !form || !municipality) return;
  form.elements.id.value = municipality.id;
  form.elements.name.value = municipality.name || '';
  form.elements.phone.value = municipality.phone || '';
  form.elements.email.value = municipality.email || '';
  form.elements.postal_code.value = municipality.postal_code || '';
  form.elements.insee_code.value = municipality.insee_code || '';
  form.elements.contacts.value = municipality.contacts || '';
  form.elements.additional_info.value = municipality.additional_info || '';
  form.elements.population.value = municipality.population ?? '';
  form.elements.shelter_capacity.value = municipality.shelter_capacity ?? '';
  form.elements.vigilance_color.value = normalizeLevel(municipality.vigilance_color || 'vert');
  form.elements.pcs_active.checked = Boolean(municipality.pcs_active);
  setMunicipalityLookupOptions(form, [], municipality.name || '');
  autofillMunicipalityFromPostalCode(form).catch(() => {});
  setText('municipality-editor-title', `Éditer ${municipality.name}`);
  setVisibility(panel, true);
}

function closeMunicipalityEditor() {
  const panel = document.getElementById('municipality-editor');
  if (!panel) return;
  setVisibility(panel, false);
}

async function loadMunicipalityFiles(municipalityId) {
  const files = await api(`/municipalities/${municipalityId}/files`, { bypassCache: true, cacheTtlMs: 0 });
  return Array.isArray(files) ? files : [];
}

function municipalityFilesMarkup(files = [], municipalityId) {
  const canManage = canMunicipalityFiles();
  const list = files.map((file) => `<li><strong>${escapeHtml(file.title)}</strong> · <span class="badge neutral">${escapeHtml(file.doc_type)}</span> · ${new Date(file.created_at).toLocaleDateString()} · par ${escapeHtml(file.uploaded_by)} <button type="button" class="ghost inline-action" data-muni-file-open="${file.id}" data-muni-id="${municipalityId}">Consulter</button> <button type="button" class="ghost inline-action" data-muni-file-download="${file.id}" data-muni-id="${municipalityId}" data-muni-file-name="${escapeHtml(file.title || 'document')}">Télécharger</button> ${canManage ? `<button type="button" class="ghost inline-action danger" data-muni-file-delete="${file.id}" data-muni-id="${municipalityId}">Supprimer</button>` : ''}</li>`).join('');
  return list || '<li>Aucun fichier opérationnel.</li>';
}

function guessFileExtension(contentType = '') {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  return {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'text/plain': 'txt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
  }[normalized] || 'bin';
}

function sanitizeFilename(name = '') {
  return String(name || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

async function downloadMunicipalityFile(municipalityId, fileId, preferredName = '') {
  const { blob, contentType } = await apiFile(`/municipalities/${municipalityId}/files/${fileId}`);
  const objectUrl = URL.createObjectURL(blob);
  const downloadName = sanitizeFilename(preferredName) || `document_${fileId}`;
  const hasExtension = /\.[a-z0-9]{2,6}$/i.test(downloadName);
  const filename = hasExtension ? downloadName : `${downloadName}.${guessFileExtension(contentType)}`;
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function municipalityDocumentFiltersMarkup(state, municipalityId) {
  return `<div class="municipality-doc-toolbar">
    <input type="search" placeholder="Rechercher un document" value="${escapeHtml(state.search || '')}" data-muni-doc-search="${municipalityId}" />
    <select data-muni-doc-type-filter="${municipalityId}">
      <option value="all">Tous les types</option>
      <option value="pcs" ${state.type === 'pcs' ? 'selected' : ''}>PCS</option>
      <option value="orsec" ${state.type === 'orsec' ? 'selected' : ''}>ORSEC</option>
      <option value="convention" ${state.type === 'convention' ? 'selected' : ''}>Convention</option>
      <option value="cartographie" ${state.type === 'cartographie' ? 'selected' : ''}>Cartographie</option>
      <option value="annexe" ${state.type === 'annexe' ? 'selected' : ''}>Annexe</option>
      <option value="document" ${state.type === 'document' ? 'selected' : ''}>Document</option>
    </select>
    <select data-muni-doc-sort="${municipalityId}">
      <option value="date_desc" ${state.sort === 'date_desc' ? 'selected' : ''}>Plus récent</option>
      <option value="date_asc" ${state.sort === 'date_asc' ? 'selected' : ''}>Plus ancien</option>
      <option value="title" ${state.sort === 'title' ? 'selected' : ''}>Titre A → Z</option>
    </select>
  </div>`;
}

function uploadMunicipalityDocument(origin, municipalityId, formData, onProgress) {
  const url = buildApiUrl(`/municipalities/${municipalityId}/files`, origin);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.timeout = 90000;
    xhr.setRequestHeader('Accept', 'application/json');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || typeof onProgress !== 'function') return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error('Failed to fetch'));
    xhr.ontimeout = () => reject(new Error("Téléversement expiré avant réponse du serveur"));
    xhr.onload = () => {
      if (xhr.status === 401) {
        logout();
        reject(new Error('Session expirée'));
        return;
      }
      let payload = null;
      if (xhr.responseText) {
        try { payload = JSON.parse(xhr.responseText); } catch { payload = null; }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      reject(new Error(payload?.detail || payload?.message || `Erreur API (${xhr.status})`));
    };
    xhr.send(formData);
  });
}

async function uploadMunicipalityDocumentWithFallback(municipalityId, formData, onProgress) {
  let lastError = null;
  for (const origin of apiOrigins()) {
    try {
      return await uploadMunicipalityDocument(origin, municipalityId, formData, onProgress);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(sanitizeErrorMessage(lastError?.message || 'Téléversement impossible'));
}

async function waitForMunicipalityDocumentAppearance(municipalityId, expectedTitle, expectedFilename, timeoutMs = 20000) {
  const startedAt = Date.now();
  const normalizedTitle = String(expectedTitle || '').trim().toLowerCase();
  const normalizedFilename = String(expectedFilename || '').trim().toLowerCase();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const docs = await api(`/municipalities/${municipalityId}/files`, { bypassCache: true, cacheTtlMs: 0, timeoutMs: 15000 });
      const found = (Array.isArray(docs) ? docs : []).some((doc) => {
        const docTitle = String(doc?.title || '').trim().toLowerCase();
        const docFilename = String(doc?.filename || '').trim().toLowerCase();
        return (normalizedTitle && docTitle === normalizedTitle) || (normalizedFilename && docFilename.includes(normalizedFilename));
      });
      if (found) return true;
    } catch (_) {}
    await wait(1200);
  }
  return false;
}

async function openMunicipalityFile(municipalityId, fileId) {
  const { blob, contentType } = await apiFile(`/municipalities/${municipalityId}/files/${fileId}`);
  const objectUrl = URL.createObjectURL(blob);
  const previewHost = document.getElementById('municipality-document-preview');

  if (currentMunicipalityPreviewUrl) {
    URL.revokeObjectURL(currentMunicipalityPreviewUrl);
    currentMunicipalityPreviewUrl = null;
  }

  if (previewHost) {
    currentMunicipalityPreviewUrl = objectUrl;
    setHtml('municipality-document-preview', municipalityPreviewMarkup(contentType || '', objectUrl));
    previewHost.classList.remove('hidden');
    previewHost.hidden = false;
    previewHost.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  window.open(objectUrl, '_blank', 'noopener,noreferrer');
  currentMunicipalityPreviewUrl = objectUrl;
}

function closeMunicipalityDetailsModal() {
  const modal = document.getElementById('municipality-details-modal');
  cleanupMunicipalityPreview();
  if (!modal) return;
  if (typeof modal.close === 'function' && modal.open) {
    modal.close();
    return;
  }
  modal.open = false;
  modal.removeAttribute('open');
}

function requestMunicipalityDetailsCloseLikeEscape() {
  const modal = document.getElementById('municipality-details-modal');
  if (!modal) return;
  if (typeof modal.requestClose === 'function') {
    modal.requestClose();
    return;
  }
  const cancelEvent = new Event('cancel', { cancelable: true });
  modal.dispatchEvent(cancelEvent);
  if (!cancelEvent.defaultPrevented) closeMunicipalityDetailsModal();
}

function cleanupMunicipalityPreview() {
  if (currentMunicipalityPreviewUrl) {
    URL.revokeObjectURL(currentMunicipalityPreviewUrl);
    currentMunicipalityPreviewUrl = null;
  }
}

function openMunicipalityDetailsInlineFallback(municipality) {
  return openMunicipalityDetailsModal(municipality);
}

function parseAnnuaireValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try {
        return JSON.parse(text);
      } catch (_) {
        return text;
      }
    }
    return text;
  }
  return value;
}

function collectAnnuaireStrings(value) {
  const parsed = parseAnnuaireValue(value);
  if (parsed == null) return [];
  if (typeof parsed === 'string') return parsed.trim() ? [parsed.trim()] : [];
  if (typeof parsed === 'number') return [String(parsed)];
  if (Array.isArray(parsed)) return parsed.flatMap((item) => collectAnnuaireStrings(item));
  if (typeof parsed === 'object') return Object.values(parsed).flatMap((item) => collectAnnuaireStrings(item));
  return [];
}

function normalizeDisplayPhone(value) {
  const candidates = collectAnnuaireStrings(value);
  for (const candidate of candidates) {
    const compact = candidate.replace(/[^\d+]/g, '');
    if ((compact.match(/\d/g) || []).length >= 10) return candidate.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function normalizeDisplayMail(value) {
  const candidates = collectAnnuaireStrings(value);
  for (const candidate of candidates) {
    const match = candidate.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) return match[0];
  }
  return '';
}

function normalizeDisplayAddress(value) {
  const parsed = parseAnnuaireValue(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const text = normalizeDisplayAddress(item);
      if (text) return text;
    }
    return '';
  }
  if (parsed && typeof parsed === 'object') {
    const parts = [
      String(parsed.complement1 || '').trim(),
      String(parsed.complement2 || '').trim(),
      [parsed.numero_voie, parsed.nom_voie].filter(Boolean).map((part) => String(part).trim()).join(' ').trim(),
      String(parsed.service_distribution || '').trim(),
      [parsed.code_postal, parsed.nom_commune || parsed.commune].filter(Boolean).map((part) => String(part).trim()).join(' ').trim(),
      String(parsed.pays || '').trim(),
    ].filter(Boolean);
    return parts.join(', ');
  }
  return String(parsed || '').replace(/\s+/g, ' ').trim();
}

function renderPublicServiceCard(item, emptyLabel = 'Service public') {
  const phoneValue = normalizeDisplayPhone(item?.phone);
  const emailValue = normalizeDisplayMail(item?.email);
  const addressValue = normalizeDisplayAddress(item?.address);
  if (!phoneValue && !emailValue && !addressValue) return '';
  const phoneHref = phoneValue ? phoneValue.replace(/[^\d+]/g, '') : '';
  const phone = phoneValue ? `<a href="tel:${escapeHtml(phoneHref)}" style="color:var(--primary)">${escapeHtml(phoneValue)}</a>` : '';
  const email = emailValue ? `<a href="mailto:${escapeHtml(emailValue)}" style="color:var(--primary)">${escapeHtml(emailValue)}</a>` : '';
  return `<div class="muni-public-card">
    <div class="muni-public-card__head">
      <strong>${escapeHtml(item?.name || emptyLabel)}</strong>
      <span class="badge neutral">${escapeHtml(item?.type || 'Service')}</span>
    </div>
    <div class="muni-public-card__body">
      ${phone ? `<div class="muni-public-row"><span class="muni-public-label">Téléphone</span><span>${phone}</span></div>` : ''}
      ${addressValue ? `<div class="muni-public-row"><span class="muni-public-label">Adresse</span><span>${escapeHtml(addressValue)}</span></div>` : ''}
      ${email ? `<div class="muni-public-row"><span class="muni-public-label">Email</span><span>${email}</span></div>` : ''}
    </div>
  </div>`;
}

if (typeof window !== 'undefined') {
  window.openMunicipalityDetailsInlineFallback = openMunicipalityDetailsInlineFallback;
  window.closeMunicipalityDetailsModal = closeMunicipalityDetailsModal;
  window.requestMunicipalityDetailsCloseLikeEscape = requestMunicipalityDetailsCloseLikeEscape;
  window.closeMunicipalityEditorFallback = closeMunicipalityEditor;
}

async function openMunicipalityDetailsModal(municipality) {
  const modal = document.getElementById('municipality-details-modal');
  const content = document.getElementById('municipality-details-content');
  if (!modal || !content || !municipality) return;

  const [logs, publicServices] = await Promise.all([
    api('/logs').catch(() => []),
    api(`/municipalities/${municipality.id}/public-services`).catch(() => ({})),
  ]);
  const municipalityLogs = (Array.isArray(logs) ? logs : [])
    .filter((log) => String(log.municipality_id || '') === String(municipality.id))
    .slice(0, 10);
  const municipalityEvents = sortOperationalEvents(cachedEvents)
    .filter((event) => String(event.municipality_id || '') === String(municipality.id) && isOpenOrActiveEvent(event))
    .slice(0, 10);
  const level = normalizeLevel(municipality.vigilance_color || 'vert');
  const badgeClass = level === 'rouge' ? 'red' : level === 'orange' ? 'orange' : level === 'jaune' ? 'yellow' : 'green';
  const municipalityContacts = Array.isArray(publicServices?.municipality_contacts) ? publicServices.municipality_contacts : [];
  const importantContacts = Array.isArray(publicServices?.important_contacts) ? publicServices.important_contacts : [];
  const emergencyNumbers = Array.isArray(publicServices?.emergency_numbers) ? publicServices.emergency_numbers : [];
  const filteredMunicipalityContacts = municipalityContacts.filter((item) => {
    const phoneValue = normalizeDisplayPhone(item?.phone);
    const emailValue = normalizeDisplayMail(item?.email);
    const addressValue = normalizeDisplayAddress(item?.address);
    return Boolean(phoneValue || emailValue || addressValue);
  });
  const filteredImportantContacts = importantContacts.filter((item) => {
    const phoneValue = normalizeDisplayPhone(item?.phone);
    const emailValue = normalizeDisplayMail(item?.email);
    const addressValue = normalizeDisplayAddress(item?.address);
    return Boolean(phoneValue || emailValue || addressValue);
  });
  const emergencyMarkup = emergencyNumbers.length
    ? `<div class="muni-emergency-strip">${emergencyNumbers.map((item) => `<span class="muni-emergency-pill"><strong>${escapeHtml(item.label || '')}</strong> · ${escapeHtml(item.phone || '')}</span>`).join('')}</div>`
    : '';
  const municipalityContactsMarkup = filteredMunicipalityContacts.length
    ? `<div class="muni-public-grid">${filteredMunicipalityContacts.map((item) => renderPublicServiceCard(item)).join('')}</div>`
    : '<p class="muted">Aucun contact public complémentaire trouvé pour cette commune.</p>';
  const importantContactsMarkup = filteredImportantContacts.length
    ? `<div class="muni-public-grid">${filteredImportantContacts.map((item) => renderPublicServiceCard(item)).join('')}</div>`
    : '<p class="muted">Aucun contact départemental clé récupéré pour le moment.</p>';

  // ── Tab: Fiche ────────────────────────────────────────────
  const crisisActions = canEdit()
    ? `<button type="button" class="ghost inline-action${municipality.crisis_mode ? ' danger' : ''}" data-muni-detail-crisis="${municipality.id}" style="margin-top:.6rem">${municipality.crisis_mode ? '🔴 Sortir de crise' : '⚠️ Passer en crise'}</button>
       <button type="button" class="ghost inline-action" data-muni-edit="${municipality.id}" style="margin-top:.6rem">Éditer la fiche</button>`
    : '';

  const ficheTab = `
    <div class="muni-status-strip">
      <span class="badge ${badgeClass}">${level}</span>
      ${municipality.crisis_mode ? '<span style="font-weight:700;color:#c91c2e;font-size:.85rem">🔴 MODE CRISE</span>' : '<span style="color:#5f7190;font-size:.85rem">🟢 Veille normale</span>'}
      <span class="muni-pill ${municipality.pcs_active ? 'pcs-on' : 'pcs-off'}">${municipality.pcs_active ? '✅ PCS actif' : '⬜ PCS inactif'}</span>
    </div>
    ${municipality.contacts ? `<p style="margin:.35rem 0 .65rem"><strong style="font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Contacts d'astreinte</strong><br><span style="white-space:pre-wrap">${escapeHtml(municipality.contacts)}</span></p>` : ''}
    <div class="muni-info-grid">
      <p class="muni-info-item"><strong>Code postal</strong>${escapeHtml(municipality.postal_code || '-')}</p>
      <p class="muni-info-item"><strong>Code INSEE</strong>${escapeHtml(municipality.insee_code || '-')}</p>
      <p class="muni-info-item"><strong>Population</strong>${municipality.population ? Number(municipality.population).toLocaleString('fr-FR') + ' hab.' : '-'}</p>
      <p class="muni-info-item"><strong>Capacité d'accueil</strong>${municipality.shelter_capacity ? Number(municipality.shelter_capacity).toLocaleString('fr-FR') + ' places' : '-'}</p>
      <p class="muni-info-item"><strong>Téléphone</strong>${municipality.phone ? `<a href="tel:${encodeURIComponent(municipality.phone.replace(/\s/g,''))}" style="color:var(--primary)">${escapeHtml(municipality.phone)}</a>` : '-'}</p>
      <p class="muni-info-item"><strong>Email</strong>${municipality.email ? `<a href="mailto:${encodeURIComponent(municipality.email)}" style="color:var(--primary)">${escapeHtml(municipality.email)}</a>` : '-'}</p>
    </div>
    ${emergencyMarkup}
    <div class="muni-public-section">
      <h5>Services publics utiles de la commune</h5>
      ${municipalityContactsMarkup}
    </div>
    <div class="muni-public-section">
      <h5>Numéros et contacts importants Isère</h5>
      ${importantContactsMarkup}
    </div>
    ${municipality.additional_info ? `<p style="margin:.3rem 0"><strong style="font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Informations complémentaires</strong><br><span style="white-space:pre-wrap;font-size:.88rem">${escapeHtml(municipality.additional_info)}</span></p>` : ''}
    ${crisisActions}
  `;

  // ── Tab: Événements ──────────────────────────────────────
  const eventsTab = municipalityEvents.length
    ? municipalityEvents.map((event) => {
        const status = EVENT_STATUS_LABEL[event.status] || event.status || 'Ouvert';
        return `<div class="muni-event-item">
          <div class="muni-event-item__title">${escapeHtml(event.title || 'Évènement')}</div>
          <div class="muni-event-item__sub">${escapeHtml(event.address || 'Adresse non renseignée')} · <span class="badge neutral">${escapeHtml(status)}</span></div>
          <button type="button" class="ghost inline-action" style="margin-top:.4rem;padding:.3rem .7rem;font-size:.8rem" data-muni-open-event="${event.id}">Ouvrir la fiche évènement</button>
        </div>`;
      }).join('')
    : '<p class="muted">Aucun évènement ouvert lié à cette commune.</p>';

  // ── Tab: MCO ─────────────────────────────────────────────
  const mcoTab = municipalityLogs.length
    ? municipalityLogs.map((log) => {
        const status = LOG_STATUS_LABEL[String(log.status || 'nouveau')] || 'Nouveau';
        const eventTitle = getEventTitle(log.event_id);
        const openAction = log.event_id ? `<button type="button" class="ghost inline-action" style="margin-top:.35rem;padding:.28rem .65rem;font-size:.77rem" data-muni-open-event="${log.event_id}">Accéder à l'évènement</button>` : '';
        return `<div class="muni-log-item">
          <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.25rem">
            <span>${log.danger_emoji || '🟢'} <strong>${escapeHtml(log.event_type || 'MCO')}</strong></span>
            <span class="badge neutral">${escapeHtml(status)}</span>
            <span class="muted" style="font-size:.78rem">${timeAgo(log.created_at)}</span>
          </div>
          ${eventTitle ? `<div class="muni-log-item__sub" style="margin-bottom:.2rem">${escapeHtml(eventTitle)}</div>` : ''}
          <div style="font-size:.88rem">${escapeHtml(log.description || '')}</div>
          ${openAction}
        </div>`;
      }).join('')
    : '<p class="muted">Aucune entrée main courante associée.</p>';

  // ── Assemble HTML ─────────────────────────────────────────
  setHtml('municipality-details-content', `
    <div style="display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;margin-bottom:.5rem">
      <h4 style="margin:0;font-size:1.05rem">${escapeHtml(municipality.name)}</h4>
      ${municipality.postal_code ? `<span class="muted" style="font-size:.85rem">${escapeHtml(municipality.postal_code)}</span>` : ''}
    </div>
    <nav class="muni-detail-tabs" id="muni-tabs-nav-${municipality.id}">
      <button class="muni-tab-btn active" data-muni-tab="fiche">Fiche</button>
      <button class="muni-tab-btn" data-muni-tab="events">Évènements${municipalityEvents.length > 0 ? `<span class="muni-tab-badge">${municipalityEvents.length}</span>` : ''}</button>
      <button class="muni-tab-btn" data-muni-tab="mco">MCO${municipalityLogs.length > 0 ? `<span class="muni-tab-badge">${municipalityLogs.length}</span>` : ''}</button>
    </nav>
    <div class="muni-detail-section active" data-muni-section="fiche">${ficheTab}</div>
    <div class="muni-detail-section" data-muni-section="events">${eventsTab}</div>
    <div class="muni-detail-section" data-muni-section="mco">${mcoTab}</div>
  `);

  // Tab switching
  content.querySelectorAll('.muni-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.muniTab;
      content.querySelectorAll('.muni-tab-btn').forEach((b) => b.classList.remove('active'));
      content.querySelectorAll('.muni-detail-section').forEach((s) => s.classList.remove('active'));
      btn.classList.add('active');
      const section = content.querySelector(`[data-muni-section="${tab}"]`);
      if (section) section.classList.add('active');
    });
  });

  if (typeof modal.showModal === 'function') {
    if (modal.open) return;
    modal.showModal();
    return;
  }
  modal.setAttribute('open', 'open');
}

async function pickMunicipalityFile(municipalityId) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.pdf,.png,.jpg,.jpeg';
  picker.onchange = async () => {
    const file = picker.files?.[0];
    if (!file) return;
    const titlePrompt = window.prompt('Nom du document', file.name);
    if (titlePrompt === null) return;
    const title = titlePrompt.trim() || file.name;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', title);
    formData.append('doc_type', 'document');
    await api(`/municipalities/${municipalityId}/files`, { method: 'POST', body: formData });
    const refreshed = getMunicipality(municipalityId);
    if (refreshed) await openMunicipalityDetailsModal(refreshed);
    loadMunicipalities().catch(() => {});
  };
  picker.click();
}

async function submitMunicipalityUploadForm(form, municipalityId) {
  const file = form.elements.file.files?.[0];
  if (!file) return;
  const title = form.elements.title.value.trim() || file.name;
  const docType = form.elements.doc_type.value || 'document';
  const submitButton = form.querySelector('button[type="submit"]');
  const formData = new FormData();
  formData.append('file', file);
  formData.append('title', title);
  formData.append('doc_type', docType);

  const progressWrap = document.querySelector(`[data-muni-upload-progress="${municipalityId}"]`);
  const progressLabel = document.querySelector(`[data-muni-upload-progress-label="${municipalityId}"]`);
  const progressBar = progressWrap?.querySelector('.municipality-upload-progress__bar');
  if (progressWrap) {
    progressWrap.hidden = false;
    progressWrap.classList.remove('hidden');
  }
  if (progressBar) progressBar.style.width = '0%';
  if (progressLabel) progressLabel.textContent = '0%';
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Envoi...';
  }

  let uploadReached100 = false;
  try {
    const uploadPromise = uploadMunicipalityDocumentWithFallback(municipalityId, formData, (progress) => {
      if (progressBar) progressBar.style.width = `${progress}%`;
      if (progressLabel) progressLabel.textContent = `${progress}%`;
      if (progress >= 100) uploadReached100 = true;
    });

    const completionPromise = (async () => {
      while (!uploadReached100) {
        await wait(150);
      }
      const found = await waitForMunicipalityDocumentAppearance(municipalityId, title, file.name, 30000);
      if (!found) throw new Error("Document non visible après téléversement");
      return true;
    })();

    await Promise.race([uploadPromise, completionPromise]);
    if (progressBar) progressBar.style.width = '100%';
    if (progressLabel) progressLabel.textContent = '100%';
    const refreshed = getMunicipality(municipalityId);
    form.reset();
    if (refreshed) await openMunicipalityDetailsModal(refreshed);
    document.getElementById('municipality-feedback').textContent = 'Document chargé avec succès.';
    loadMunicipalities().catch(() => {});
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = 'Ajouter';
    }
    if (progressWrap) {
      setTimeout(() => {
        progressWrap.hidden = true;
        progressWrap.classList.add('hidden');
        if (progressBar) progressBar.style.width = '0%';
        if (progressLabel) progressLabel.textContent = '0%';
      }, 500);
    }
  }
}

function parseUtcTimestamp(value) {
  if (!value) return new Date(0);
  const s = String(value);
  // La DB stocke TIMESTAMP WITHOUT TIME ZONE en UTC.
  // FastAPI sérialise sans 'Z' → JS traite comme heure locale → décalage +2h en été.
  // On force UTC en ajoutant 'Z' si aucune info de timezone n'est présente.
  if (s.includes('T') && !/[Z+\-]\d{2}:?\d{2}$/.test(s) && !s.endsWith('Z')) {
    return new Date(s + 'Z');
  }
  return new Date(s);
}

function safeDateToLocale(value, options = {}) {
  const timestamp = parseUtcTimestamp(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.getTime() > 0
    ? timestamp.toLocaleString('fr-FR', options)
    : '-';
}

function parseMcoTimestamp(value) {
  if (!value) return new Date(0);
  const s = String(value);
  if (s.includes('T') && !/[Z+\-]\d{2}:?\d{2}$/.test(s) && !s.endsWith('Z')) {
    return new Date(s);
  }
  return new Date(value);
}

function formatMcoTimestamp(value, options = {}) {
  const timestamp = parseMcoTimestamp(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.getTime() > 0
    ? timestamp.toLocaleString('fr-FR', options)
    : '-';
}

/**
 * Retourne un horodatage relatif lisible : "il y a 5 min", "il y a 2h", "hier"…
 * Utilisé dans la MCO pour rendre les entrées récentes immédiatement lisibles.
 */
function timeAgo(value) {
  const date = parseMcoTimestamp(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '';
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 30)  return 'à l\'instant';
  if (seconds < 90)  return 'il y a 1 min';
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 7200) return 'il y a 1h';
  if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)}h`;
  if (seconds < 172800) return 'hier';
  if (seconds < 604800) return `il y a ${Math.floor(seconds / 86400)} j`;
  return safeDateToLocale(value, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function toDatetimeLocal(value) {
  const date = parseMcoTimestamp(value || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '';
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - (offset * 60000));
  return localDate.toISOString().slice(0, 16);
}

function buildSituationLogMarkup(log = {}) {
  const status = LOG_STATUS_LABEL[String(log.status || 'nouveau')] || 'Nouveau';
  const at = safeDateToLocale(log.event_time || log.created_at || Date.now());
  const scope = formatLogScope(log);
  const icon = log.danger_emoji || LOG_LEVEL_EMOJI[normalizeLevel(log.danger_level)] || '🟢';
  const lvlColor = levelColor(log.danger_level);

  const details = [];
  if (log.location)        details.push(`📍 ${escapeHtml(log.location)}`);
  if (log.assigned_to)     details.push(`👤 ${escapeHtml(log.assigned_to)}`);
  if (log.source)          details.push(`🔎 ${escapeHtml(log.source)}`);
  if (log.actions_taken)   details.push(`✅ <em>${escapeHtml(log.actions_taken)}</em>`);
  if (log.next_update_due) details.push(`⏰ Proch. point : ${escapeHtml(safeDateToLocale(log.next_update_due))}`);

  return `<li style="border-left:3px solid ${lvlColor};padding-left:8px;margin-bottom:6px">
    <div><strong>${at}</strong> · <span class="badge neutral">${status}</span> · <span class="badge neutral">${scope}</span></div>
    <div>${icon} <strong style="color:${lvlColor}">${escapeHtml(log.event_type || 'MCO')}</strong>${log.description ? ` · ${escapeHtml(log.description)}` : ''}</div>
    ${details.length ? `<div class="muted" style="font-size:0.82em;margin-top:2px">${details.join(' · ')}</div>` : ''}
  </li>`;
}

function buildCriticalRisksMarkup(dashboard = {}, externalRisks = {}) {
  const risks = [];
  const meteo = externalRisks?.meteo_france || {};
  const criticalLevels = new Set(['orange', 'rouge']);
  const currentAlerts = (meteo.current_alerts || []).filter((alert) => criticalLevels.has(normalizeLevel(alert.level)));

  currentAlerts.forEach((alert) => {
    const level = normalizeLevel(alert.level);
    const details = (alert.details || []).filter(Boolean);
    const detailsText = details.length ? `<br>${details.map((detail) => escapeHtml(detail)).join('<br>')}` : '';
    risks.push(`<li><strong>${escapeHtml(alert.phenomenon || 'Phénomène météo')}</strong> · <span class="risk-${level}">${level}</span>${detailsText}</li>`);
  });

  const itinisereEvents = externalRisks?.itinisere?.events || [];
  const frAlertToday = Array.isArray(externalRisks?.fr_alert_isere?.today_events) ? externalRisks.fr_alert_isere.today_events : [];
  if (frAlertToday.length) {
    risks.unshift(`<li><strong>FR-Alert Isère</strong> · <span class="risk-rouge">${frAlertToday.length} alerte(s) aujourd'hui</span> · ${escapeHtml(frAlertToday[0]?.title || 'Alerte population')}</li>`);
  }
  const georisques = externalRisks?.georisques?.data && typeof externalRisks.georisques.data === 'object'
    ? { ...externalRisks.georisques.data, ...externalRisks.georisques }
    : (externalRisks?.georisques || {});

  risks.push(`<li><strong>Itinisère</strong> · ${(itinisereEvents || []).length} événement(s) actif(s) · Statut ${escapeHtml(externalRisks?.itinisere?.status || 'inconnu')}</li>`);

  const terDisruptions = Number(externalRisks?.ter_aura?.disruptions_total ?? (externalRisks?.ter_aura?.disruptions || []).length);
  if (terDisruptions > 0) {
    risks.push(`<li><strong>TER SNCF AURA</strong> · <span class="risk-jaune">${terDisruptions} perturbation(s)</span> sur le réseau TER en Isère.</li>`);
  }
  const mreseauDisruptions = Number(externalRisks?.mreseau?.disruptions_total ?? (externalRisks?.mreseau?.disruptions || []).length);
  if (mreseauDisruptions > 0) {
    risks.push(`<li><strong>M Réseau Grenoble</strong> · <span class="risk-jaune">${mreseauDisruptions} alerte(s)</span> trams/bus agglomération grenobloise.</li>`);
  }
  const apicAlerts = Number((externalRisks?.apic_isere?.alerts_total ?? (externalRisks?.apic_isere?.alerts || []).length) || 0);
  const vfAlerts = Number((externalRisks?.vigicrues_flash_isere?.alerts_total ?? (externalRisks?.vigicrues_flash_isere?.alerts || []).length) || 0);
  if (apicAlerts > 0) {
    risks.push(`<li><strong>APIC Isère</strong> · <span class="risk-jaune">${apicAlerts} alerte(s)</span> pluie intense / ruissellement.</li>`);
  }
  if (vfAlerts > 0) {
    risks.push(`<li><strong>Vigicrues Flash Isère</strong> · <span class="risk-jaune">${vfAlerts} alerte(s)</span> crues rapides.</li>`);
  }
  risks.push(`<li><strong>Géorisques</strong> · Sismicité ${escapeHtml(georisques.highest_seismic_zone_label || 'inconnue')} · ${Number(georisques.flood_documents_total ?? 0)} document(s) inondation</li>`);

  const fromDashboard = Array.isArray(dashboard?.latest_logs) ? dashboard.latest_logs : [];
  const criticalLogs = fromDashboard.filter((log) => {
    const isCritical = ['orange', 'rouge'].includes(normalizeLevel(log.danger_level));
    const isOpen = String(log.status || '').toLowerCase() !== 'clos';
    return isCritical && isOpen;
  });
  if (criticalLogs.length) {
    risks.unshift(`<li><strong>Main courante</strong> · ${criticalLogs.length} évènement(s) critique(s) orange/rouge.</li>`);
  }

  return risks.join('') || '<li>Aucun risque critique détecté.</li>';
}

function buildFrAlertTodayBanner(frAlert = {}) {
  const todayEvents = Array.isArray(frAlert.today_events) ? frAlert.today_events : [];
  if (!todayEvents.length) return '';
  return `<section class="fr-alert-home-banner" role="alert">
    <div>
      <p class="tag">FR-Alert Isère · aujourd'hui</p>
      <h3>${todayEvents.length} alerte(s) détectée(s) dans l'Isère</h3>
    </div>
    <ul class="list compact">
      ${todayEvents.slice(0, 4).map((event) => {
        const link = String(event.link || '').startsWith('http') ? event.link : 'https://fr-alert.gouv.fr';
        return `<li><strong>${escapeHtml(event.title || 'FR-Alert')}</strong>${event.is_exercise ? ' · Exercice' : ''}<br><span class="muted">${escapeHtml(event.started_at_label || event.started_at || '')} · ${escapeHtml(event.location || event.source || '')}</span><br><a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">Ouvrir l'alerte officielle</a></li>`;
      }).join('')}
    </ul>
  </section>`;
}

function buildOpenEventsSituationMarkup(events = []) {
  const openEvents = sortOperationalEvents(events).filter((event) => String(event.status || '').toLowerCase() === 'ouvert');
  if (!openEvents.length) return '<li>Aucun évènement ouvert.</li>';
  const allLogs = Array.isArray(cachedLogs) ? cachedLogs : [];
  return openEvents.slice(0, 10).map((event) => {
    const locality = event.municipality_id ? getMunicipalityName(event.municipality_id) : 'Départemental';
    const eventLogs = allLogs.filter((l) => String(l.event_id || '') === String(event.id));
    const activeLogs = eventLogs.filter((l) => ['nouveau','en_cours','suivi'].includes(String(l.status || '')));
    const worstLevel = eventLogs.reduce((max, l) => riskRank(l.danger_level) > riskRank(max) ? (l.danger_level || 'vert') : max, 'vert');
    const icon = LOG_LEVEL_EMOJI[normalizeLevel(worstLevel)] || '🟢';
    const lvlColor = levelColor(worstLevel);
    const lastLog = eventLogs.sort((a, b) => parseUtcTimestamp(b.event_time || b.created_at) - parseUtcTimestamp(a.event_time || a.created_at))[0];
    const lastLogLine = lastLog
      ? `<div class="muted" style="font-size:0.82em;margin-top:2px">Dernière MCO : ${escapeHtml(lastLog.description || lastLog.event_type || 'MCO')}${lastLog.assigned_to ? ` · 👤 ${escapeHtml(lastLog.assigned_to)}` : ''} · ${escapeHtml(safeDateToLocale(lastLog.event_time || lastLog.created_at))}</div>`
      : '';
    return `<li style="border-left:3px solid ${lvlColor};padding-left:8px;margin-bottom:6px">
      <div>${icon} <strong>${escapeHtml(event.title || 'Évènement')}</strong> · <span class="muted">${escapeHtml(locality)} · ${escapeHtml(event.address || 'N/A')}</span></div>
      <div class="muted" style="font-size:0.82em">${activeLogs.length} entrée(s) active(s) · ${eventLogs.length} au total · niveau <strong style="color:${lvlColor}">${escapeHtml(normalizeLevel(worstLevel))}</strong></div>
      ${lastLogLine}
    </li>`;
  }).join('');
}

function buildMeteoSituationModalContent(meteo = {}) {
  const renderAlertLine = (alert = {}) => {
    const phenomenon = escapeHtml(alert.phenomenon || 'Phénomène');
    const level = normalizeLevel(alert.level || 'inconnu');
    const details = Array.isArray(alert.details) && alert.details.length
      ? `<br><span class="muted">${alert.details.map((detail) => escapeHtml(detail)).join(' · ')}</span>`
      : '';
    return `<li><strong>${phenomenon}</strong> · <span class="risk-${level}">${escapeHtml(level)}</span>${details}</li>`;
  };
  const renderSection = (title, alerts = []) => `
    <h5>${escapeHtml(title)}</h5>
    <ul class="situation-kpi-modal__list">
      ${Array.isArray(alerts) && alerts.length ? alerts.map((alert) => renderAlertLine(alert)).join('') : '<li>Aucune alerte significative.</li>'}
    </ul>
  `;
  return `
    <p class="muted">Source: Météo-France Vigilance · vue identique au panneau Services connectés.</p>
    ${renderSection('J0 · En cours', meteo.current_alerts || [])}
    ${renderSection('J1 · Demain', meteo.tomorrow_alerts || [])}
  `;
}

function buildSituationKpiModalContent(key, externalRisks = {}) {
  const dashboard = cachedDashboardSnapshot || {};
  const meteo = externalRisks?.meteo_france || {};
  const vigicrues = externalRisks?.vigicrues || {};
  const bison = externalRisks?.bison_fute || {};
  const sncf = externalRisks?.sncf_isere || {};
  const vigieau = externalRisks?.vigieau || {};
  const apic = externalRisks?.apic_isere || {};
  const vigicruesFlash = externalRisks?.vigicrues_flash_isere || {};
  const atmo = externalRisks?.atmo_aura || {};
  const arcep = externalRisks?.arcep_isere || {};
  switch (key) {
    case 'meteo':
      return buildMeteoSituationModalContent(meteo);
    case 'crues': {
      const mainTronconCodes = new Set(['AN11', 'AN12', 'AN20', 'AN30', 'AN31']);
      const troncons = (Array.isArray(vigicrues.troncons) ? vigicrues.troncons : [])
        .filter((troncon) => mainTronconCodes.has(String(troncon.code || '')))
        .map((troncon) => ({ ...troncon, normalizedLevel: normalizeLevel(troncon.level || 'vert') }))
        .sort((a, b) => riskRank(b.normalizedLevel) - riskRank(a.normalizedLevel));
      const stations = (Array.isArray(vigicrues.stations) ? vigicrues.stations : [])
        .map((station) => ({ ...station, normalizedLevel: normalizeLevel(station.level || 'vert') }))
        .sort((a, b) => riskRank(b.normalizedLevel) - riskRank(a.normalizedLevel));
      const tronconMax = troncons.reduce((max, troncon) => riskRank(troncon.normalizedLevel) > riskRank(max) ? troncon.normalizedLevel : max, 'vert');
      const stationMax = stations.reduce((max, station) => riskRank(station.normalizedLevel) > riskRank(max) ? station.normalizedLevel : max, 'vert');
      const tronconsHtml = troncons.length
        ? `<ul class="situation-kpi-modal__list">${troncons.slice(0, 12).map((troncon) => `<li><strong style="color:${levelColor(troncon.normalizedLevel)}">${escapeHtml(troncon.name || troncon.code || 'Tronçon')}</strong> · ${escapeHtml(troncon.normalizedLevel)}</li>`).join('')}</ul>`
        : '<p class="muted">Aucun tronçon principal disponible.</p>';
      const stationsHtml = stations.length
        ? `<ul class="situation-kpi-modal__list">${stations.slice(0, 14).map((station) => `<li><strong style="color:${levelColor(station.normalizedLevel)}">${escapeHtml(station.station || station.code || 'Station')}</strong>${station.river ? ` · <span class="muted">${escapeHtml(station.river)}</span>` : ''} · ${escapeHtml(station.normalizedLevel)}</li>`).join('')}</ul>`
        : '<p class="muted">Aucune station disponible.</p>';
      return `
        <p><strong>Niveau Vigicrues global:</strong> ${escapeHtml(normalizeLevel(vigicrues.water_alert_level || 'inconnu'))}</p>
        <p><strong>Tronçons AN11/12/20/30/31 max:</strong> <span style="color:${levelColor(tronconMax)}">${escapeHtml(tronconMax)}</span></p>
        <p><strong>Stations max:</strong> <span style="color:${levelColor(stationMax)}">${escapeHtml(stationMax)}</span> · ${stations.length} station(s) suivie(s)</p>
        <h5>Tronçons</h5>
        ${tronconsHtml}
        <h5>Stations</h5>
        ${stationsHtml}
      `;
    }
    case 'global-risk':
      return `<p><strong>Risque global consolidé:</strong> ${escapeHtml(formatGlobalRiskValue(dashboard))}</p><p class="muted">Score opérationnel 0-100 consolidant météo, crues, PCS et alertes externes.</p><ul class="situation-kpi-modal__list">${buildGlobalRiskFactorsMarkup(dashboard)}</ul>`;
    case 'communes-crise':
      return `<p><strong>Communes en crise:</strong> ${Number(dashboard.communes_crise ?? 0)}</p><p class="muted">Valeur issue du suivi des PCS actifs côté dashboard.</p>`;
    case 'bison':
      return `<p><strong>Bison Futé Isère J0:</strong> départ ${escapeHtml(normalizeLevel(bison.today?.isere?.departure || 'inconnu'))} / arrivée ${escapeHtml(normalizeLevel(bison.today?.isere?.return || 'inconnu'))}</p><p><strong>Bison Futé Isère J1:</strong> départ ${escapeHtml(normalizeLevel(bison.tomorrow?.isere?.departure || 'inconnu'))} / arrivée ${escapeHtml(normalizeLevel(bison.tomorrow?.isere?.return || 'inconnu'))}</p>`;
    case 'sncf':
      return `<p><strong>Alertes SNCF Isère:</strong> ${Number(sncf.alerts_total ?? (sncf.alerts || []).length)}</p><ul class="situation-kpi-modal__list">${(sncf.alerts || []).slice(0, 8).map((alert) => `<li><strong>${escapeHtml(alert.title || 'Alerte SNCF')}</strong><br><span class="muted">${escapeHtml(alert.description || '')}</span></li>`).join('') || '<li>Aucune alerte en cours.</li>'}</ul>`;
    case 'arcep':
      return `<p><strong>Sites mobiles indisponibles:</strong> ${Number(arcep.outages_total ?? 0)}</p><p class="muted">Source: ARCEP / data.gouv.fr.</p>`;
    case 'vigieau':
      return `<p><strong>Restrictions eau:</strong> ${Number((vigieau.alerts || []).length)}</p><ul class="situation-kpi-modal__list">${(vigieau.alerts || []).slice(0, 8).map((alert) => `<li><strong>${escapeHtml(alert.zone || 'Isère')}</strong> · ${escapeHtml(alert.level || 'non définie')}<br><span class="muted">${escapeHtml(alert.measure || 'Restriction')}</span></li>`).join('') || '<li>Aucune alerte restriction d’eau.</li>'}</ul>`;
    case 'atmo':
      return `<p><strong>Qualité de l’air:</strong> ${escapeHtml(String(atmo.today?.label || normalizeLevel(atmo.today?.level || 'inconnu')).toLowerCase())}</p><p><strong>Indice:</strong> ${escapeHtml(String(atmo.today?.index ?? '-'))}</p>`;
    case 'apic':
      return `<p><strong>Alertes APIC Isère:</strong> ${Number(apic.alerts_total ?? (apic.alerts || []).length)}</p><ul class="situation-kpi-modal__list">${(apic.alerts || []).slice(0, 8).map((alert) => `<li><strong>${escapeHtml(alert.zone || 'Isère')}</strong> · ${escapeHtml(normalizeLevel(alert.level || 'jaune'))}</li>`).join('') || '<li>Aucune alerte APIC en cours.</li>'}</ul>`;
    case 'vigicrues-flash':
      return `<p><strong>Alertes Vigicrues Flash Isère:</strong> ${Number(vigicruesFlash.alerts_total ?? (vigicruesFlash.alerts || []).length)}</p><ul class="situation-kpi-modal__list">${(vigicruesFlash.alerts || []).slice(0, 8).map((alert) => `<li><strong>${escapeHtml(alert.zone || 'Isère')}</strong> · ${escapeHtml(normalizeLevel(alert.level || 'jaune'))}</li>`).join('') || '<li>Aucune alerte Vigicrues Flash.</li>'}</ul>`;
    case 'avalanche': {
      const braData = externalRisks?.avalanche_isere || {};
      const massifs = Array.isArray(braData.massifs) ? braData.massifs : [];
      const braColors = { 1: '#2b8a3e', 2: '#e9a800', 3: '#e67700', 4: '#c92a2a', 5: '#6741d9' };
      const braLabels = { 1: 'Faible', 2: 'Limité', 3: 'Marqué', 4: 'Fort', 5: 'Très fort' };
      const items = massifs.map((m) => {
        const color = braColors[m.niveau_bra] || '#868e96';
        const label = braLabels[m.niveau_bra] || 'Indisponible';
        return `<li style="padding:4px 0;border-bottom:1px solid #eee"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:6px"></span><strong>${escapeHtml(m.nom || m.massif || '?')}</strong> · <span style="color:${color};font-weight:600">Niveau ${m.niveau_bra ?? '?'}/5 — ${escapeHtml(label)}</span><br><span class="muted">${escapeHtml(m.detail || m.description || '')}</span></li>`;
      }).join('');
      return `<p><strong>Niveau max BRA Isère :</strong> ${braData.niveau_max_bra ?? '?'}/5 · ${massifs.length} massif(s)</p><p><strong>Source :</strong> Météo-France · Bulletin de Risque Avalanche</p><ul class="situation-kpi-modal__list">${items || '<li>Aucune donnée BRA disponible.</li>'}</ul>`;
    }
    case 'feux': {
      const feuxData = externalRisks?.feux_foret_isere || {};
      const fires = Array.isArray(feuxData.top_fires) && feuxData.top_fires.length ? feuxData.top_fires
                   : Array.isArray(feuxData.fires) ? feuxData.fires.slice(0, 8) : [];
      const items = fires.map((f) => {
        const zone = escapeHtml(f.zone || `${f.lat?.toFixed(2)}°N ${f.lon?.toFixed(2)}°E`);
        const frp = f.frp != null ? `${Number(f.frp).toFixed(0)} MW` : '–';
        const conf = escapeHtml(f.confidence || '?');
        const confColor = conf === 'high' ? '#c92a2a' : conf === 'nominal' ? '#e67700' : '#868e96';
        return `<li style="padding:4px 0;border-bottom:1px solid #eee"><strong>🔥 ${zone}</strong><br><span class="muted">Puissance : ${frp} · Confiance : <span style="color:${confColor};font-weight:600">${conf}</span></span></li>`;
      }).join('');
      return `<p><strong>Foyers détectés (24h) :</strong> ${feuxData.fires_total ?? 0}</p><p><strong>Source :</strong> EFFIS / Copernicus / VIIRS satellite</p><ul class="situation-kpi-modal__list">${items || '<li>Aucun foyer détecté dans la région.</li>'}</ul>`;
    }
    case 'seismes': {
      const seismesData = externalRisks?.seismes_isere || {};
      const items = (Array.isArray(seismesData.items) ? seismesData.items : []).slice(0, 10).map((q) => {
        const mag = q.magnitude != null ? q.magnitude : '?';
        const magColor = mag >= 3 ? '#c92a2a' : mag >= 2 ? '#e67700' : '#2b8a3e';
        return `<li style="padding:4px 0;border-bottom:1px solid #eee"><span style="font-size:1.1em;font-weight:700;color:${magColor}">M${mag}</span> · <strong>${escapeHtml(q.place || q.title || 'Isère')}</strong><br><span class="muted">${escapeHtml(q.date || '')} · Profondeur ${q.depth ?? '?'} km</span></li>`;
      }).join('');
      return `<p><strong>Séismes détectés (30 jours) :</strong> ${(seismesData.items || []).length}</p><p><strong>Source :</strong> BCSF-RéNaSS · Réseau Sismologique National</p><ul class="situation-kpi-modal__list">${items || '<li>Aucun séisme détecté récemment.</li>'}</ul>`;
    }
    case 'cols': {
      const colsData = externalRisks?.cols_alpins_isere || {};
      const cols = Array.isArray(colsData.cols) ? colsData.cols : [];
      const colorMapOfficial = { vert: '#2b8a3e', jaune: '#e9a800', orange: '#e67700', rouge: '#c92a2a', gris: '#868e96' };
      const itemsOfficial = cols.map((c) => {
        const color = colorMapOfficial[c.couleur] || '#868e96';
        const tempStrOfficial = c.temperature != null ? `${c.temperature}°C` : '';
        const snowStrOfficial = c.enneigement_cm != null ? `${c.enneigement_cm} cm neige` : '';
        const windStrOfficial = c.vent_kmh != null ? `vent ${Math.round(c.vent_kmh)} km/h` : '';
        const metricsOfficial = [tempStrOfficial, snowStrOfficial, windStrOfficial].filter(Boolean).join(' · ');
        const operationalDetail = escapeHtml(c.detail || '');
        const routeLabelOfficialClean = String(c.route || '').trim();
        const routeMetaOfficialClean = routeLabelOfficialClean ? ` <span class="muted">(${escapeHtml(routeLabelOfficialClean)})</span>` : '';
        const detailOfficialClean = operationalDetail ? ` - <span class="muted">${operationalDetail}</span>` : '';
        return `<li style="padding:4px 0;border-bottom:1px solid #eee"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:6px"></span><strong>${escapeHtml(c.nom)}</strong>${routeMetaOfficialClean}<br><span style="color:${color};font-weight:600">${escapeHtml(c.statut || '?')}</span>${detailOfficialClean}${metricsOfficial ? `<br><span class="muted">${escapeHtml(metricsOfficial)}</span>` : ''}</li>`;
        const routeLabelOfficial = String(c.route || '').trim();
        const routeMetaOfficial = routeLabelOfficial ? ` <span class="muted">(${escapeHtml(routeLabelOfficial)})</span>` : '';
        return `<li style="padding:4px 0;border-bottom:1px solid #eee"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:6px"></span><strong>${escapeHtml(c.nom)}</strong>${routeMetaOfficial}<br><span style="color:${color};font-weight:600">${escapeHtml(c.statut || '?')}</span>${operationalDetail ? ` Â· <span class="muted">${operationalDetail}</span>` : ''}${metricsOfficial ? `<br><span class="muted">${escapeHtml(metricsOfficial)}</span>` : ''}</li>`;
        return `<li style="padding:4px 0;border-bottom:1px solid #eee"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:6px"></span><strong>${escapeHtml(c.nom)}</strong> <span class="muted">(${c.alt} m · ${escapeHtml(c.route || '')})</span><br><span style="color:${color};font-weight:600">${escapeHtml(c.statut || '?')}</span>${operationalDetail ? ` · <span class="muted">${operationalDetail}</span>` : ''}${metricsOfficial ? `<br><span class="muted">${escapeHtml(metricsOfficial)}</span>` : ''}</li>`;
      }).join('');
      const colsSourceLineOfficial = isOfficialColsSource(colsData) ? 'Itinisère · couche officielle des cols' : 'Itinisère + fallback météo';
      const colsEmptyLabelOfficial = colsData.status === 'pending' ? 'Actualisation Itinisère en cours…' : 'Aucune donnée cols disponible.';
      return `<p><strong>Cols surveillés :</strong> ${colsData.cols_total ?? 0} · <strong>À surveiller :</strong> ${colsData.dangereux_total ?? 0}</p><p><strong>Source :</strong> ${colsSourceLineOfficial}</p><ul class="situation-kpi-modal__list">${itemsOfficial || `<li>${colsEmptyLabelOfficial}</li>`}</ul>`;
    }
    default:
      return '<p>Aucun détail supplémentaire disponible pour ce KPI.</p>';
  }
}

function openSituationKpiModal(key, label) {
  const modal = document.getElementById('situation-kpi-modal');
  if (!modal) return;
  const title = document.getElementById('situation-kpi-modal-title');
  const content = document.getElementById('situation-kpi-modal-content');
  if (title) title.textContent = `Détail · ${label || 'KPI'}`;
  if (content) setHtml('situation-kpi-modal-content', buildSituationKpiModalContent(key, cachedExternalRisksSnapshot || {}));
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', 'open');
}

function renderSituationOverview() {
  const target = document.getElementById('situation-content');
  if (!target) return;

  const dashboard = cachedDashboardSnapshot && Object.keys(cachedDashboardSnapshot).length
    ? cachedDashboardSnapshot
    : (readSnapshot(STORAGE_KEYS.dashboardSnapshot) || {});
  const externalRisks = cachedExternalRisksSnapshot && Object.keys(cachedExternalRisksSnapshot).length
    ? cachedExternalRisksSnapshot
    : (readSnapshot(STORAGE_KEYS.externalRisksSnapshot) || {});

  const vigilance = normalizeLevel(dashboard.vigilance || externalRisks?.meteo_france?.level || 'vert');

  // ── Niveau crues : niveau max réellement observé sur tronçons AN et stations ──
  const vigicruesTroncons = Array.isArray(externalRisks?.vigicrues?.troncons)
    ? externalRisks.vigicrues.troncons : [];
  const mainTronconCodes = new Set(['AN11', 'AN12', 'AN20', 'AN30', 'AN31']);
  const mainTroncons = vigicruesTroncons
    .filter((t) => mainTronconCodes.has(String(t.code || '')))
    .map((troncon) => ({ ...troncon, normalizedLevel: normalizeLevel(troncon.level || 'vert') }));
  const mainTronconLevel = mainTroncons.reduce(
    (max, troncon) => riskRank(troncon.normalizedLevel) > riskRank(max) ? troncon.normalizedLevel : max,
    'vert',
  );
  const topTroncons = mainTroncons.filter((troncon) => troncon.normalizedLevel === mainTronconLevel);

  const vigicruesStations = Array.isArray(externalRisks?.vigicrues?.stations)
    ? externalRisks.vigicrues.stations : [];
  const stationsWithLevel = vigicruesStations
    .map((station) => ({ ...station, normalizedLevel: normalizeLevel(station.level || 'vert') }))
    .sort((a, b) => riskRank(b.normalizedLevel) - riskRank(a.normalizedLevel));
  const stationsLevel = stationsWithLevel.reduce(
    (max, station) => riskRank(station.normalizedLevel) > riskRank(max) ? station.normalizedLevel : max,
    'vert',
  );
  const topStations = stationsWithLevel.filter((station) => station.normalizedLevel === stationsLevel);

  const crues = [
    mainTronconLevel,
    stationsLevel,
    normalizeLevel(dashboard.crues || externalRisks?.vigicrues?.water_alert_level || 'vert'),
  ].reduce((max, lvl) => riskRank(lvl) > riskRank(max) ? lvl : max, 'vert');

  const globalRisk = normalizeLevel(dashboard.global_risk || vigilance);
  const globalRiskValue = formatGlobalRiskValue(dashboard);
  const crisisCount = Number(dashboard.communes_crise ?? 0);

  const logs = Array.isArray(cachedLogs) && cachedLogs.length
    ? cachedLogs
    : (Array.isArray(dashboard.latest_logs) ? dashboard.latest_logs : []);
  const eventsSource = Array.isArray(cachedEvents) && cachedEvents.length
    ? cachedEvents
    : (readSnapshot(STORAGE_KEYS.eventsSnapshot) || []);
  const openEventIds = new Set((Array.isArray(eventsSource) ? eventsSource : [])
    .filter((event) => String(event.status || '').toLowerCase() === 'ouvert')
    .map((event) => String(event.id)));
  const activeSituationStatuses = new Set(['nouveau', 'en_cours', 'suivi']);
  const activeLogs = logs.filter((log) => {
    if (!activeSituationStatuses.has(String(log.status || '').toLowerCase())) return false;
    return openEventIds.has(String(log.event_id || ''));
  });
  const prefectureItems = Array.isArray(externalRisks?.prefecture_isere?.items)
    ? sortPrefectureItemsByRecency(externalRisks.prefecture_isere.items).slice(0, 4)
    : [];
  const frAlert = externalRisks?.fr_alert_isere || {};
  const cruesTopLevel = riskRank(mainTronconLevel) >= riskRank(stationsLevel) ? mainTronconLevel : stationsLevel;
  const cruesAlertHtml = `
    <div style="margin-top:6px;font-size:0.82em">
      <p style="margin:.2rem 0"><strong>Tronçons au plus haut niveau</strong> · <span style="color:${levelColor(mainTronconLevel)}">${escapeHtml(mainTronconLevel)}</span></p>
      ${topTroncons.length
        ? `<ul class="list compact">${topTroncons.slice(0, 5).map((troncon) => `<li><span style="color:${levelColor(troncon.normalizedLevel)};font-weight:600">${escapeHtml(troncon.name || troncon.code || 'Tronçon')}</span> · ${escapeHtml(troncon.normalizedLevel)}</li>`).join('')}${topTroncons.length > 5 ? `<li class="muted">… et ${topTroncons.length - 5} autre(s)</li>` : ''}</ul>`
        : `<p class="muted" style="margin:.15rem 0 .45rem">Aucun tronçon principal disponible</p>`
      }
      <p style="margin:.55rem 0 .2rem"><strong>Stations au plus haut niveau</strong> · <span style="color:${levelColor(stationsLevel)}">${escapeHtml(stationsLevel)}</span></p>
      ${topStations.length
        ? `<ul class="list compact">${topStations.slice(0, 6).map((station) => `<li><span style="color:${levelColor(station.normalizedLevel)};font-weight:600">${escapeHtml(station.station || station.code || 'Station')}</span>${station.river ? ` · <span class="muted">${escapeHtml(station.river)}</span>` : ''} · ${escapeHtml(station.normalizedLevel)}</li>`).join('')}${topStations.length > 6 ? `<li class="muted">… et ${topStations.length - 6} autre(s)</li>` : ''}</ul>`
        : `<p class="muted" style="margin:.15rem 0">Aucune station disponible</p>`
      }
    </div>
  `;

  const kpiCards = [
    { key: 'meteo', label: 'Vigilance météo', value: vigilance, info: 'Source Météo-France', css: normalizeLevel(vigilance) },
    { key: 'crues', label: 'Niveau crues', value: crues, info: `Tronçons AN11/12/20/30/31 max ${mainTronconLevel} · stations max ${stationsLevel}`, css: normalizeLevel(crues) },
    { key: 'global-risk', label: 'Risque global', value: globalRiskValue, info: 'Score consolidé 0-100', css: normalizeLevel(globalRisk) },
    { key: 'communes-crise', label: 'Communes en crise', value: String(crisisCount), info: 'PCS actif', css: crisisCount > 0 ? 'rouge' : 'vert' },
  ];
  // ── Nouvelles tuiles risques (Features 13/15/17/18/20) ───────────────────
  const braData = externalRisks?.avalanche_isere || {};
  const braNiveauMax = braData.niveau_max_bra;
  const braLevel = braNiveauMax >= 4 ? 'rouge' : braNiveauMax >= 3 ? 'orange' : braNiveauMax >= 2 ? 'jaune' : braNiveauMax ? 'vert' : 'inconnu';
  const braLabel = { 1: 'Faible', 2: 'Limité', 3: 'Marqué', 4: 'Fort', 5: 'Très fort' }[braNiveauMax] || 'Indisponible';
  const feuxData = externalRisks?.feux_foret_isere || {};
  const seismesData = externalRisks?.seismes_isere || {};
  const dernierSeisme = (seismesData.items || [])[0];
  const seismeLevel = dernierSeisme?.magnitude >= 4 ? 'rouge' : dernierSeisme?.magnitude >= 3 ? 'orange' : dernierSeisme?.magnitude >= 2 ? 'jaune' : 'vert';
  const colsData = externalRisks?.cols_alpins_isere || {};

  const bisonDeparture = normalizeLevel(externalRisks?.bison_fute?.today?.isere?.departure || 'inconnu');
  const bisonReturn = normalizeLevel(externalRisks?.bison_fute?.today?.isere?.return || 'inconnu');
  const bisonCombinedLevel = riskRank(bisonReturn) > riskRank(bisonDeparture) ? bisonReturn : bisonDeparture;
  const vigieauAlertsCount = Number((externalRisks?.vigieau?.alerts || []).length);
  const atmoLevel = normalizeLevel(externalRisks?.atmo_aura?.today?.level || 'inconnu');
  const atmoLabel = String(externalRisks?.atmo_aura?.today?.label || atmoLevel || 'inconnu').toLowerCase();
  const apicAlerts = Number(externalRisks?.apic_isere?.alerts_total ?? (externalRisks?.apic_isere?.alerts || []).length);
  const vigicruesFlashAlerts = Number(externalRisks?.vigicrues_flash_isere?.alerts_total ?? (externalRisks?.vigicrues_flash_isere?.alerts || []).length);
  const sncfAlerts = Number(externalRisks?.sncf_isere?.alerts_total ?? (externalRisks?.sncf_isere?.alerts || []).length);
  const arcepOutages = Number(externalRisks?.arcep_isere?.outages_total ?? 0);
  const mobilityCards = [
    { key: 'bison', label: 'Bison Futé (38) · Départ / Arrivée', value: `${bisonDeparture} / ${bisonReturn}`, info: 'Tendance Isère départ / arrivée', css: bisonCombinedLevel },
    { key: 'sncf', label: 'SNCF · alertes Isère', value: `${sncfAlerts}`, info: 'Accidents / travaux de voie', css: sncfAlerts > 0 ? 'orange' : 'vert' },
    { key: 'arcep', label: 'ARCEP · Sites mobiles indisponibles Isère', value: `${arcepOutages}`, info: 'Source data.gouv.fr / ARCEP', css: arcepOutages > 0 ? 'jaune' : 'vert' },
    { key: 'vigieau', label: 'Vigieau', value: `${vigieauAlertsCount}`, info: "Restriction(s) d'eau active(s)", css: vigieauAlertsCount > 0 ? 'jaune' : 'vert' },
    { key: 'atmo', label: "Qualité de l'air", value: atmoLabel, info: 'Source Atmo AURA', css: atmoLevel },
    { key: 'apic', label: 'APIC · alertes Isère', value: `${apicAlerts}`, info: 'Pluie intense à l’échelle communale', css: apicAlerts > 0 ? 'orange' : 'vert' },
    { key: 'vigicrues-flash', label: 'Vigicrues Flash · alertes Isère', value: `${vigicruesFlashAlerts}`, info: 'Avertissements crues rapides', css: vigicruesFlashAlerts > 0 ? 'orange' : 'vert' },
  ];
  const risquesNaturelsCards = [
    { key: 'avalanche', label: '🏔️ Avalanches BRA', value: braNiveauMax ? `${braNiveauMax}/5 — ${braLabel}` : 'Indisponible', info: `${(braData.massifs || []).length} massif(s) Isère`, css: braLevel },
    { key: 'feux', label: '🔥 Feux de forêt EFFIS', value: `${feuxData.fires_total ?? 0} foyer(s) 24h`, info: feuxData.fires_total > 0 ? 'Foyers détectés par satellite VIIRS' : 'Aucun foyer détecté dans la région', css: (feuxData.fires_total ?? 0) > 5 ? 'rouge' : (feuxData.fires_total ?? 0) > 0 ? 'orange' : 'vert' },
    { key: 'seismes', label: '🌍 Séismes récents', value: dernierSeisme ? `M${dernierSeisme.magnitude} ${escapeHtml(dernierSeisme.place?.split(',')[0] || '')}` : 'Aucun', info: `${(seismesData.items || []).length} séisme(s) détecté(s)`, css: seismeLevel },
    { key: 'cols', label: '⛰️ Cols alpins', value: `${colsData.dangereux_total ?? 0} à surveiller`, info: `${colsData.cols_total ?? 0} cols suivis`, css: (colsData.dangereux_total ?? 0) > 3 ? 'orange' : (colsData.dangereux_total ?? 0) > 0 ? 'jaune' : 'vert' },
  ];

  const generatedAt = safeDateToLocale(Date.now());

  setHtml('situation-content', `
    ${buildFrAlertTodayBanner(frAlert)}
    <div class="situation-toolbar">
      <div>
        <h3>SITREP prêt à diffusion · Isère</h3>
        <p class="muted">Version claire et moderne pour envoi immédiat · mise à jour ${escapeHtml(generatedAt)}</p>
      </div>
      <div class="situation-toolbar__actions">
        <button id="situation-copy-sitrep-btn" type="button" class="btn-copy-sitrep ghost" title="Copier le SITREP en texte brut">📋 Copier SITREP</button>
        <button id="situation-export-pdf-btn" type="button">📄 Télécharger PDF</button>
      </div>
    </div>

    <div class="situation-top-grid">
      ${kpiCards.map((card) => `<article class="tile situation-tile situation-tile--interactive situation-tile--bg-${escapeHtml(card.css)}" role="button" tabindex="0" data-kpi-key="${escapeHtml(card.key)}" data-kpi-label="${escapeHtml(card.label)}"><h3>${card.label}</h3><p class="kpi-value ${card.css}">${escapeHtml(card.value)}</p><p class="muted">${escapeHtml(card.info)}</p></article>`).join('')}
    </div>

    <div class="situation-top-grid">
      ${mobilityCards.map((card) => `<article class="tile situation-tile situation-tile--interactive" role="button" tabindex="0" data-kpi-key="${escapeHtml(card.key)}" data-kpi-label="${escapeHtml(card.label)}"><h3>${card.label}</h3><p class="kpi-value ${card.css}">${escapeHtml(card.value)}</p><p class="muted">${card.info}</p></article>`).join('')}
    </div>

    <div class="situation-top-grid">
      ${risquesNaturelsCards.map((card) => `<article class="tile situation-tile situation-tile--interactive" role="button" tabindex="0" data-kpi-key="${escapeHtml(card.key)}" data-kpi-label="${escapeHtml(card.label)}"><h3>${card.label}</h3><p class="kpi-value ${card.css}">${card.value}</p><p class="muted">${card.info}</p></article>`).join('')}
    </div>

    <div class="situation-middle-grid">
      <article class="tile situation-summary">
        <h3>Dernières informations Préfecture</h3>
        <ul class="list compact">
          ${prefectureItems.map((item) => {
            const title = escapeHtml(item.title || 'Actualité Préfecture');
            const published = item.published_at ? escapeHtml(item.published_at) : '';
            const safeLink = String(item.link || '').startsWith('http') ? item.link : 'https://www.isere.gouv.fr';
            return `<li><strong>${title}</strong>${published ? `<br><span class="muted">${published}</span>` : ''}<br><a href="${safeLink}" target="_blank" rel="noreferrer">Lire l'actualité</a></li>`;
          }).join('') || '<li>Aucune actualité Préfecture disponible.</li>'}
        </ul>
      </article>
      <article class="tile situation-risks">
        <h3>Risques en cours (orange / rouge)</h3>
        <ul class="list compact">${buildCriticalRisksMarkup(dashboard, externalRisks)}</ul>
      </article>
    </div>

    <h3>Évènements ouverts</h3>
    <article class="tile situation-risks">
      <ul class="list compact">${buildOpenEventsSituationMarkup(cachedEvents)}</ul>
    </article>

    <h3>Fil de situation</h3>
    <div class="situation-log-columns">
      <div>
        <h4>Nouveaux / En cours / Suivi (prioritaires)</h4>
        <ul class="list">${activeLogs.map((log) => buildSituationLogMarkup(log)).join('') || '<li>Aucune crise nouvelle / en cours / suivie liée à un évènement ouvert.</li>'}</ul>
      </div>
    </div>
  `);

  bindSituationActions();
}

function toSitrepBulletItems(items = [], emptyLabel = 'Aucune donnée disponible.') {
  if (!Array.isArray(items) || !items.length) return `<li>${escapeHtml(emptyLabel)}</li>`;
  return items.map((item) => `<li>${item}</li>`).join('');
}

function isSameDayLocal(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isPreviousDayLocal(candidate, reference) {
  const previous = new Date(reference);
  previous.setDate(reference.getDate() - 1);
  return isSameDayLocal(candidate, previous);
}

function projectToIsereMap(lat, lon, width = 480, height = 280, padding = 16) {
  const bounds = { minLat: 44.75, maxLat: 45.95, minLon: 4.7, maxLon: 6.45 };
  const normalizedX = (Number(lon) - bounds.minLon) / (bounds.maxLon - bounds.minLon);
  const normalizedY = (bounds.maxLat - Number(lat)) / (bounds.maxLat - bounds.minLat);
  const safeX = Number.isFinite(normalizedX) ? Math.max(0, Math.min(1, normalizedX)) : 0.5;
  const safeY = Number.isFinite(normalizedY) ? Math.max(0, Math.min(1, normalizedY)) : 0.5;
  return {
    x: padding + safeX * (width - (padding * 2)),
    y: padding + safeY * (height - (padding * 2)),
  };
}

function buildSitrepMapSvg(title, points = [], lines = [], options = {}) {
  const width = 480;
  const height = 280;
  const frame = '<path d="M90 26 L376 26 L450 82 L432 246 L120 258 L40 194 L36 88 Z" fill="rgba(255,255,255,0.18)" stroke="#163a87" stroke-width="2.4" />';
  const lineSvg = lines.map((line) => {
    const coords = (line.points || [])
      .map((coord) => projectToIsereMap(coord.lat, coord.lon, width, height, 18))
      .map((coord) => `${coord.x.toFixed(1)},${coord.y.toFixed(1)}`)
      .join(' ');
    if (!coords) return '';
    return `<polyline points="${coords}" fill="none" stroke="${escapeHtml(line.color || '#d9480f')}" stroke-width="${line.weight || 3}" stroke-linecap="round" stroke-linejoin="round" opacity="0.88" />`;
  }).join('');
  const pointsSvg = points.map((point) => {
    const position = projectToIsereMap(point.lat, point.lon, width, height, 18);
    const radius = Number(point.radius || 4.2);
    return `<circle cx="${position.x.toFixed(1)}" cy="${position.y.toFixed(1)}" r="${radius.toFixed(1)}" fill="${escapeHtml(point.color || '#0d4b8e')}" stroke="#ffffff" stroke-width="1.2" opacity="0.95" />`;
  }).join('');

  const majorCities = [
    { label: 'Grenoble', lat: 45.1885, lon: 5.7245 },
    { label: 'Vienne', lat: 45.5256, lon: 4.8748 },
    { label: 'Bourgoin-Jallieu', lat: 45.5868, lon: 5.2737 },
    { label: 'Voiron', lat: 45.3653, lon: 5.5926 },
  ];
  const cityMarkers = majorCities.map((city) => {
    const position = projectToIsereMap(city.lat, city.lon, width, height, 18);
    return `<circle cx="${position.x.toFixed(1)}" cy="${position.y.toFixed(1)}" r="2.7" fill="#ffffff" stroke="#1e3a8a" stroke-width="1.1" />
      <text x="${(position.x + 6).toFixed(1)}" y="${(position.y - 4).toFixed(1)}" fill="#0f172a" font-size="10" font-weight="600">${escapeHtml(city.label)}</text>`;
  }).join('');

  const subtitle = options.subtitle ? `<p style="margin:0 0 6px; color:#334155; font-size:12px;">${escapeHtml(options.subtitle)}</p>` : '';
  const totalPoints = Number(options.totalPoints ?? points.length);
  const totalLines = Number(options.totalLines ?? lines.length);
  const mapSummary = `<div style="margin-top:6px; display:flex; flex-wrap:wrap; gap:6px; font-size:11px;">
    <span style="background:#e7f0ff; color:#0d4b8e; border-radius:999px; padding:3px 8px;">${totalPoints} point(s)</span>
    <span style="background:#fff4e6; color:#b45309; border-radius:999px; padding:3px 8px;">${totalLines} corridor(s)</span>
    <span style="background:#ecfdf3; color:#166534; border-radius:999px; padding:3px 8px;">Vue département 38</span>
  </div>`;

  const terrainBands = [
    '<path d="M0 210 L110 185 L190 220 L300 198 L392 226 L480 205 L480 280 L0 280 Z" fill="#d9f99d" opacity="0.45"/>',
    '<path d="M0 150 L88 130 L176 158 L252 142 L344 164 L430 146 L480 158 L480 214 L0 214 Z" fill="#bfdbfe" opacity="0.55"/>',
    '<path d="M0 88 L72 76 L170 102 L256 86 L340 110 L430 88 L480 98 L480 154 L0 154 Z" fill="#cbd5e1" opacity="0.50"/>',
  ].join('');
  const referenceGrid = Array.from({ length: 8 }).map((_, index) => {
    const x = (index + 1) * 54;
    return `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#cbd5e1" stroke-width="0.8" opacity="0.38"/>`;
  }).join('')
    + Array.from({ length: 4 }).map((_, index) => {
      const y = (index + 1) * 56;
      return `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#cbd5e1" stroke-width="0.8" opacity="0.38"/>`;
    }).join('');
  return `<figure style="margin:10px 0 16px;">
    <figcaption style="font-weight:700; margin-bottom:6px;">${escapeHtml(title)} (centrée Isère)</figcaption>
    ${subtitle}
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="220" role="img" aria-label="${escapeHtml(title)}">
      <defs>
        <linearGradient id="isere-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#dbeafe" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="#bfdbfe" stop-opacity="0.06"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc"/>
      ${referenceGrid}
      ${terrainBands}
      <rect x="0" y="0" width="${width}" height="${height}" fill="url(#isere-gradient)" />
      ${frame}
      ${lineSvg}
      ${pointsSvg}
      ${cityMarkers}
    </svg>
    ${mapSummary}
  </figure>`;
}

// ---------------------------------------------------------------------------
// Helpers couleur niveau de risque pour le SITREP
// ---------------------------------------------------------------------------
function sitrepLevelColor(level) {
  const l = String(level || '').toLowerCase();
  if (l === 'rouge') return '#c62828';
  if (l === 'orange') return '#e65100';
  if (l === 'jaune') return '#f9a825';
  if (l === 'vert') return '#2e7d32';
  return '#546e7a';
}
function sitrepLevelBg(level) {
  const l = String(level || '').toLowerCase();
  if (l === 'rouge') return '#ffebee';
  if (l === 'orange') return '#fff3e0';
  if (l === 'jaune') return '#fffde7';
  if (l === 'vert') return '#e8f5e9';
  return '#f5f5f5';
}
function sitrepLevelBadge(level) {
  const l = normalizeLevel(level || 'inconnu');
  const color = sitrepLevelColor(l);
  const bg = sitrepLevelBg(l);
  return `<span style="display:inline-block;padding:1px 8px;border-radius:4px;font-size:11px;font-weight:700;background:${bg};color:${color};border:1px solid ${color}33;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(l)}</span>`;
}
function sitrepRow(cells, bold = false) {
  return `<tr>${cells.map((c) => `<td style="padding:5px 8px;border-bottom:1px solid #e8eaed;${bold ? 'font-weight:600;' : ''}vertical-align:top">${c}</td>`).join('')}</tr>`;
}
function sitrepTh(cells) {
  return `<tr>${cells.map((c) => `<th style="padding:5px 8px;background:#f0f4f8;border-bottom:2px solid #c8d6e5;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#3d5a80">${c}</th>`).join('')}</tr>`;
}
function sitrepTable(headers, rows, note = '') {
  if (!rows.length) return `<p style="color:#78909c;font-size:12px;margin:4px 0 12px">Aucune donnée disponible.</p>`;
  return `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:${note ? '4px' : '14px'}">${sitrepTh(headers)}${rows.join('')}</table>${note ? `<p style="color:#78909c;font-size:11px;margin:0 0 12px">${note}</p>` : ''}`;
}
function sitrepSection(title, content, icon = '') {
  return `<section style="margin-bottom:18px;page-break-inside:avoid">
    <h2 style="margin:0 0 8px;font-size:14px;font-weight:700;color:#1a2e47;border-left:4px solid #1565c0;padding-left:10px;letter-spacing:.01em">${icon ? icon + ' ' : ''}${title}</h2>
    ${content}
  </section>`;
}
function sitrepKpiCard(label, value, level = '') {
  const color = level ? sitrepLevelColor(normalizeLevel(level)) : '#1565c0';
  const bg = level ? sitrepLevelBg(normalizeLevel(level)) : '#e3f0ff';
  return `<div style="border:1px solid ${color}33;border-radius:6px;padding:10px 12px;background:${bg}">
    <div style="font-size:10px;color:#546e7a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">${escapeHtml(label)}</div>
    <div style="font-size:18px;font-weight:800;color:${color};line-height:1.1">${value}</div>
  </div>`;
}

function buildSitrepHtml() {
  const dashboard = cachedDashboardSnapshot && Object.keys(cachedDashboardSnapshot).length
    ? cachedDashboardSnapshot
    : (readSnapshot(STORAGE_KEYS.dashboardSnapshot) || {});
  const externalRisks = cachedExternalRisksSnapshot && Object.keys(cachedExternalRisksSnapshot).length
    ? cachedExternalRisksSnapshot
    : (readSnapshot(STORAGE_KEYS.externalRisksSnapshot) || {});

  // ── Sources de données ──────────────────────────────────────────────────
  const meteo        = externalRisks?.meteo_france || {};
  const vigicrues    = externalRisks?.vigicrues || {};
  const atmo         = externalRisks?.atmo_aura || {};
  const bison        = externalRisks?.bison_fute?.today?.isere || {};
  const sncf         = externalRisks?.sncf_isere || {};
  const vigieau      = externalRisks?.vigieau || {};
  const apic         = externalRisks?.apic_isere || {};
  const vigiFlash    = externalRisks?.vigicrues_flash_isere || {};
  const arcep        = externalRisks?.arcep_isere || {};
  const prefData     = externalRisks?.prefecture_isere || {};
  const dauphineData = externalRisks?.dauphine_isere || {};

  const prefItems    = Array.isArray(prefData.items) ? sortPrefectureItemsByRecency(prefData.items).slice(0, 6) : [];
  const dauphItems   = Array.isArray(dauphineData.items) ? sortPrefectureItemsByRecency(dauphineData.items).slice(0, 4) : [];
  const vigieauAlerts = Array.isArray(vigieau.alerts) ? vigieau.alerts.slice(0, 8) : [];
  const sncfAlerts   = Array.isArray(sncf.alerts) ? sncf.alerts.slice(0, 8) : [];
  const apicAlerts   = Array.isArray(apic.alerts) ? apic.alerts.slice(0, 5) : [];
  const flashAlerts  = Array.isArray(vigiFlash.alerts) ? vigiFlash.alerts.slice(0, 5) : [];
  const allStations  = Array.isArray(vigicrues.stations) ? vigicrues.stations : [];
  const alertStations = allStations.filter((s) => ['orange', 'rouge'].includes(stationStatusLevel(s)));
  const troncons     = Array.isArray(vigicrues.troncons) ? vigicrues.troncons : [];
  const logs = Array.isArray(cachedLogs) && cachedLogs.length ? cachedLogs : (Array.isArray(dashboard.latest_logs) ? dashboard.latest_logs : []);

  // ── Calculs globaux ─────────────────────────────────────────────────────
  const now          = new Date();
  const generatedAt  = safeDateToLocale(Date.now(), { dateStyle: 'full', timeStyle: 'short' });
  const vigilance    = normalizeLevel(dashboard.vigilance || meteo.level || 'vert');
  const crues        = normalizeLevel(dashboard.crues || vigicrues.water_alert_level || 'vert');
  const globalRisk   = normalizeLevel(dashboard.global_risk || 'vert');
  const globalRiskDisplay = escapeHtml(formatGlobalRiskValue(dashboard));
  const crisisCount  = Number(dashboard.communes_crise ?? 0);
  const globalColor  = sitrepLevelColor(globalRisk);
  const globalBg     = sitrepLevelBg(globalRisk);

  const crisisMunicipalities = (Array.isArray(cachedMunicipalityRecords) ? cachedMunicipalityRecords : [])
    .filter((m) => m.crisis_mode).map((m) => m.name).filter(Boolean);

  const logsAll = logs.slice(0, 20);
  const logsToday     = logsAll.filter((l) => isSameDayLocal(new Date(l.event_time || l.created_at || Date.now()), now));
  const logsYesterday = logsAll.filter((l) => isPreviousDayLocal(new Date(l.event_time || l.created_at || Date.now()), now));
  const logsAlert     = logsAll.filter((l) => ['orange', 'rouge'].includes(normalizeLevel(l.danger_level)));

  // ── HTML de chaque section ──────────────────────────────────────────────

  // KPI header (3 colonnes + 2 colonnes)
  const kpiTop = `
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:14px">
      ${sitrepKpiCard('Vigilance météo', sitrepLevelBadge(vigilance), vigilance)}
      ${sitrepKpiCard('Niveau crues', sitrepLevelBadge(crues), crues)}
      ${sitrepKpiCard('Risque global', globalRiskDisplay, globalRisk)}
      ${sitrepKpiCard('Communes en crise', String(crisisCount), crisisCount > 0 ? 'rouge' : 'vert')}
      ${sitrepKpiCard('Stations en alerte', String(alertStations.length), alertStations.length > 0 ? (alertStations.some((s) => stationStatusLevel(s) === 'rouge') ? 'rouge' : 'orange') : 'vert')}
    </div>
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:16px">
      ${sitrepKpiCard('APIC pluie intense', String(Number(apic.alerts_total ?? apicAlerts.length)))}
      ${sitrepKpiCard('Vigicrues Flash', String(Number(vigiFlash.alerts_total ?? flashAlerts.length)))}
      ${sitrepKpiCard('Restrictions eau', String(vigieauAlerts.length))}
      ${sitrepKpiCard('Alertes SNCF', String(sncfAlerts.length))}
      ${sitrepKpiCard('Qualité air', escapeHtml(String(atmo?.today?.label || atmo?.today?.index || '—')))}
      ${sitrepKpiCard('MCO orange/rouge', String(logsAlert.length), logsAlert.length > 0 ? 'orange' : 'vert')}
    </div>`;

  // Météo
  const meteoAlerts = Array.isArray(meteo.current_alerts) && meteo.current_alerts.length
    ? meteo.current_alerts.map((a) => {
        const lvl = normalizeLevel(a.level || 'inconnu');
        const details = Array.isArray(a.details) && a.details.length ? a.details.slice(0, 2).join(' · ') : '';
        return sitrepRow([sitrepLevelBadge(lvl), `<strong>${escapeHtml(a.phenomenon || '—')}</strong>`, escapeHtml(details || a.description || '—')]);
      })
    : null;
  const meteoHtml = meteoAlerts
    ? sitrepTable(['Niveau', 'Phénomène', 'Détail'], meteoAlerts)
    : `<p style="color:#2e7d32;font-size:12px">✔ Aucune vigilance active · ${escapeHtml(sanitizeMeteoInformation(meteo.info_state) || 'Situation normale.')}</p>`;
  const meteoSection = sitrepSection('Météo-France · Vigilance', meteoHtml + (meteo.bulletin_title ? `<p style="font-size:11px;color:#546e7a;margin-top:4px">Bulletin : ${escapeHtml(meteo.bulletin_title)}</p>` : ''), '🌦');

  // Vigicrues tronçons
  const tronconsRows = troncons.map((t) => {
    const lvl = normalizeLevel(t.level || 'vert');
    return sitrepRow([escapeHtml(t.name || t.code || '—'), sitrepLevelBadge(lvl), String(Array.isArray(t.stations) ? t.stations.length : '—')]);
  });
  const tronconsHtml = sitrepTable(['Tronçon', 'Niveau', 'Stations'], tronconsRows, `${allStations.length} station(s) suivie(s) au total`);

  // Stations en alerte
  const alertRows = alertStations.sort((a, b) => riskRank(stationStatusLevel(b)) - riskRank(stationStatusLevel(a))).map((s) => {
    const lvl = stationStatusLevel(s);
    const delta = s.delta_m != null ? (s.delta_m >= 0 ? `+${Number(s.delta_m).toFixed(2)} m` : `${Number(s.delta_m).toFixed(2)} m`) : '—';
    return sitrepRow([
      sitrepLevelBadge(lvl),
      `<strong>${escapeHtml(s.station || s.code || '—')}</strong>`,
      escapeHtml(s.river || '—'),
      `${s.height_m != null ? Number(s.height_m).toFixed(2) + ' m' : '—'}`,
      delta,
    ]);
  });
  const alertStationsHtml = alertRows.length
    ? sitrepTable(['Niveau', 'Station', 'Cours d\'eau', 'Hauteur', 'Variation'], alertRows)
    : `<p style="color:#2e7d32;font-size:12px">✔ Aucune station en alerte orange ou rouge.</p>`;
  const vigicruesSection = sitrepSection('Vigicrues · Hydrologie Isère', tronconsHtml + alertStationsHtml, '💧');

  // APIC + Vigicrues Flash
  const apicRows = apicAlerts.map((a) => sitrepRow([sitrepLevelBadge(a.level || 'jaune'), escapeHtml(a.zone || a.title || '—'), escapeHtml(a.description || '—')]));
  const flashRows = flashAlerts.map((a) => sitrepRow([sitrepLevelBadge(a.level || 'orange'), escapeHtml(a.zone || a.title || '—'), escapeHtml(a.description || '—')]));
  const alertsSection = sitrepSection('Alertes spéciales', [
    apicAlerts.length ? `<p style="font-size:11px;font-weight:700;margin:0 0 4px;color:#546e7a">APIC — Pluies intenses</p>${sitrepTable(['Niveau', 'Zone', 'Description'], apicRows)}` : '',
    flashAlerts.length ? `<p style="font-size:11px;font-weight:700;margin:0 0 4px;color:#546e7a">Vigicrues Flash — Crues rapides</p>${sitrepTable(['Niveau', 'Zone', 'Description'], flashRows)}` : '',
    !apicAlerts.length && !flashAlerts.length ? '<p style="color:#2e7d32;font-size:12px">✔ Aucune alerte spéciale active.</p>' : '',
  ].join(''), '🚨');

  // Trafic
  const sncfRows = sncfAlerts.map((a) => sitrepRow([escapeHtml(a.type || '—'), `<strong>${escapeHtml(a.title || '—')}</strong>`, escapeHtml(a.line || a.description || '—')]));
  const bisonDep = normalizeLevel(bison.departure || 'inconnu');
  const bisonRet = normalizeLevel(bison.return || 'inconnu');
  const bisonHtml = `<div style="display:flex;gap:16px;margin-bottom:8px">
    <div>Départ Isère : ${sitrepLevelBadge(bisonDep)}</div>
    <div>Retour Isère : ${sitrepLevelBadge(bisonRet)}</div>
  </div>`;
  const trafficSection = sitrepSection('Trafic & Transport', bisonHtml + (sncfAlerts.length
    ? sitrepTable(['Type', 'Incident', 'Ligne / Détail'], sncfRows)
    : '<p style="color:#2e7d32;font-size:12px">✔ Aucune alerte SNCF en Isère.</p>'), '🚦');

  // Vigieau
  const vigieauRows = vigieauAlerts.map((a) => sitrepRow([sitrepLevelBadge(a.level || 'jaune'), escapeHtml(a.zone || '—'), escapeHtml(a.usages || a.title || '—')]));
  const vigieauSection = sitrepSection('Vigieau · Restrictions eau', vigieauAlerts.length
    ? sitrepTable(['Niveau', 'Zone', 'Usages concernés'], vigieauRows)
    : '<p style="color:#2e7d32;font-size:12px">✔ Aucune restriction eau en vigueur.</p>', '💧');

  // Réseaux ARCEP
  const arcepHtml = `<p style="font-size:12px">Sites mobiles indisponibles : <strong>${Number(arcep.outages_total ?? 0)}</strong> · Communes impactées : <strong>${Number(arcep.communes_total ?? 0)}</strong> · Voix : ${Number(arcep.voice_impacted_total ?? 0)} · Data : ${Number(arcep.data_impacted_total ?? 0)}</p>`;
  const reseauxSection = sitrepSection('Réseaux critiques', arcepHtml, '📡');

  // Préfecture + Dauphiné
  const prefRows = prefItems.map((item) => sitrepRow([escapeHtml(item.published_at || '—'), `<strong>${escapeHtml(item.title || '—')}</strong>`]));
  const dauphRows = dauphItems.map((item) => sitrepRow([escapeHtml(item.published_at || '—'), `<strong>${escapeHtml(item.title || '—')}</strong>`]));
  const newsSection = sitrepSection('Informations institutionnelles', [
    prefItems.length ? `<p style="font-size:11px;font-weight:700;margin:0 0 4px;color:#546e7a">Préfecture de l'Isère</p>${sitrepTable(['Date', 'Actualité'], prefRows)}` : '<p style="font-size:12px;color:#78909c">Aucune actualité Préfecture.</p>',
    dauphItems.length ? `<p style="font-size:11px;font-weight:700;margin:0 0 4px;color:#546e7a">Le Dauphiné Libéré · Isère</p>${sitrepTable(['Date', 'Article'], dauphRows)}` : '',
  ].join(''), '📰');

  // Main courante
  const logRow = (log) => {
    const at     = safeDateToLocale(log.event_time || log.created_at || Date.now(), { dateStyle: 'short', timeStyle: 'short' });
    const lvl    = normalizeLevel(log.danger_level || 'vert');
    const mun    = log.municipality_id ? getMunicipalityName(log.municipality_id) : (log.location || '—');
    const desc   = String(log.description || '—').slice(0, 80);
    return sitrepRow([escapeHtml(at), sitrepLevelBadge(lvl), escapeHtml(log.event_type || '—'), escapeHtml(mun), escapeHtml(desc)]);
  };
  const logHeaders = ['Horodatage', 'Niveau', 'Type', 'Commune / Lieu', 'Description'];
  const mcoTodayHtml = logsToday.length ? sitrepTable(logHeaders, logsToday.map(logRow)) : '<p style="color:#78909c;font-size:12px">Aucun évènement ce jour.</p>';
  const mcoYestHtml  = logsYesterday.length ? sitrepTable(logHeaders, logsYesterday.map(logRow)) : '<p style="color:#78909c;font-size:12px">Aucun évènement la veille.</p>';
  const mcoAlertHtml = logsAlert.length ? `<p style="font-size:11px;font-weight:700;color:#e65100;margin:4px 0">⚠ ${logsAlert.length} évènement(s) orange/rouge en cours :</p>${sitrepTable(logHeaders, logsAlert.map(logRow))}` : '';
  const mcoSection = sitrepSection('Main courante opérationnelle', mcoAlertHtml + `<p style="font-size:11px;font-weight:700;margin:8px 0 4px;color:#546e7a">Aujourd'hui (J0)</p>` + mcoTodayHtml + `<p style="font-size:11px;font-weight:700;margin:8px 0 4px;color:#546e7a">Veille (J-1)</p>` + mcoYestHtml, '📋');

  // Communes en crise
  const crisisMuniHtml = crisisMunicipalities.length
    ? `<p style="font-size:12px"><strong>${crisisMunicipalities.join(' · ')}</strong></p>`
    : `<p style="color:#2e7d32;font-size:12px">✔ Aucune commune en mode crise activé.</p>`;
  const crisisSection = sitrepSection('Communes en crise', crisisMuniHtml, '🏛');

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<title>SITREP Isère · ${escapeHtml(generatedAt)}</title>
<style>
  @page { size: A4; margin: 14mm 14mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1a2e47; margin: 0; line-height: 1.45; }
  p { margin: 0 0 4px; }
  table { border-collapse: collapse; }
  section { page-break-inside: avoid; }
</style>
</head>
<body>

<!-- ══ EN-TÊTE ════════════════════════════════════════════════════════════ -->
<div style="border:3px solid ${globalColor};border-radius:8px;padding:12px 16px;background:${globalBg};margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-start">
  <div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#546e7a;margin-bottom:2px">Protection Civile · Département de l'Isère (38)</div>
    <div style="font-size:20px;font-weight:800;color:#1a2e47;margin-bottom:4px">SITREP · Situation de référence</div>
    <div style="font-size:12px;color:#3d5a80">Émis le <strong>${escapeHtml(generatedAt)}</strong> · Document opérationnel d'aide à la décision</div>
  </div>
  <div style="text-align:right;flex-shrink:0;margin-left:16px">
    <div style="font-size:11px;color:#546e7a;margin-bottom:4px">Risque global</div>
    <div style="font-size:28px;font-weight:900;color:${globalColor};text-transform:uppercase;letter-spacing:.04em">${globalRisk}</div>
  </div>
</div>

<!-- ══ KPI ════════════════════════════════════════════════════════════════ -->
${kpiTop}

<!-- ══ SECTIONS ══════════════════════════════════════════════════════════ -->
${meteoSection}
${vigicruesSection}
${alertsSection}
${trafficSection}
${vigieauSection}
${reseauxSection}
${newsSection}
${mcoSection}
${crisisSection}

<!-- ══ PIED DE PAGE ══════════════════════════════════════════════════════ -->
<div style="border-top:1px solid #c8d6e5;margin-top:20px;padding-top:8px;display:flex;justify-content:space-between;font-size:10px;color:#78909c">
  <span>CRISIS38 · Protection Civile Isère · Document généré automatiquement</span>
  <span>Visa opérationnel : ________________________</span>
</div>

</body>
</html>`;
}

function exportSitrepPdf() {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.opacity = '0';

  const cleanup = () => {
    setTimeout(() => {
      iframe.remove();
    }, 800);
  };

  let printTriggered = false;
  iframe.onload = () => {
    if (printTriggered) return;
    printTriggered = true;
    const frameWindow = iframe.contentWindow;
    if (frameWindow) {
      setTimeout(() => {
        frameWindow.focus();
        frameWindow.print();
      }, 250);
    }
    cleanup();
  };

  document.body.appendChild(iframe);
  const frameDocument = iframe.contentDocument || iframe.contentWindow?.document;
  if (!frameDocument) {
    cleanup();
    throw new Error('Impossible de préparer le document SITREP PDF.');
  }

  frameDocument.open();
  frameDocument.write(buildSitrepHtml());
  frameDocument.close();
}

function bindSituationActions() {
  document.getElementById('situation-copy-sitrep-btn')?.addEventListener('click', () => copySitrepToClipboard());
  document.getElementById('situation-export-pdf-btn')?.addEventListener('click', async () => {
    const button = document.getElementById('situation-export-pdf-btn');
    const originalText = button?.textContent || '📄 Générer et télécharger le SITREP PDF';
    if (button) {
      button.disabled = true;
      button.textContent = 'Collecte des informations...';
    }
    try {
      await refreshAll(true);
      if (button) button.textContent = 'Préparation du PDF...';
      exportSitrepPdf();
      document.getElementById('dashboard-error').textContent = '';
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  });
  const situationContent = document.getElementById('situation-content');
  if (situationContent && !situationContent.dataset.kpiPopupBound) {
    situationContent.dataset.kpiPopupBound = '1';
    situationContent.addEventListener('click', (event) => {
      const tile = event.target.closest('[data-kpi-key]');
      if (!tile) return;
      openSituationKpiModal(tile.getAttribute('data-kpi-key'), tile.getAttribute('data-kpi-label'));
    });
    situationContent.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const tile = event.target.closest('[data-kpi-key]');
      if (!tile) return;
      event.preventDefault();
      openSituationKpiModal(tile.getAttribute('data-kpi-key'), tile.getAttribute('data-kpi-label'));
    });
  }
}

function renderDashboard(dashboard = {}) {
  cachedDashboardSnapshot = dashboard && typeof dashboard === 'object' ? dashboard : {};
  renderSituationOverview();
  // Mettre à jour le badge de vigilance dans le header dès que le dashboard change.
  const globalLevel = normalizeLevel(dashboard?.global_risk || dashboard?.vigilance || 'vert');
  updateHeaderVigilanceBadge(globalLevel);
}

function renderSncfAlerts(sncf = {}) {
  const alerts = Array.isArray(sncf?.alerts) ? sncf.alerts : [];
  const total = Number(sncf?.alerts_total ?? alerts.length);
  setRiskText('sncf-status', `${sncf.status || 'inconnu'} · ${total} alerte(s)`, sncf.status === 'online' ? 'vert' : 'jaune');
  setServiceInfoWithSource('sncf-info', 'Filtre Isère · accidents/travaux de voie', sncf.source || '');
  setHtml('sncf-alerts-list', alerts.slice(0, 10).map((alert) => {
    const level = normalizeLevel(alert.level || alert.severity || 'jaune');
    const type = escapeHtml(alert.type || 'alerte');
    const title = escapeHtml(alert.title || 'Alerte SNCF');
    const desc = escapeHtml(alert.description || '');
    const location = Array.isArray(alert.locations) && alert.locations.length ? ` · ${escapeHtml(alert.locations.join(', '))}` : '';
    const axes = Array.isArray(alert.axes) && alert.axes.length ? `<br><small><strong>Axe(s):</strong> ${escapeHtml(alert.axes.join(' · '))}</small>` : '';
    const validity = alert.valid_from || alert.valid_until
      ? `<br><small><strong>Période:</strong> ${escapeHtml(alert.valid_from || '?')} → ${escapeHtml(alert.valid_until || '?')}</small>`
      : '';
    const link = String(alert.link || '').startsWith('http') ? alert.link : 'https://www.sncf.com/fr/itineraire-reservation/info-trafic';
    return `<li><strong>${title}</strong> · <span style="color:${levelColor(level)}">${type}</span>${location}<br>${desc}${axes}${validity}${link ? `<br><a href="${link}" target="_blank" rel="noreferrer">Consulter SNCF</a>` : ''}</li>`;
  }).join('') || '<li>Aucune alerte SNCF accidents/travaux en Isère pour le moment.</li>');
}

function renderApicAlerts(apic = {}) {
  const alerts = Array.isArray(apic?.alerts) ? apic.alerts : [];
  const total = Number(apic?.alerts_total ?? alerts.length);
  const level = normalizeLevel(apic?.level || (total > 0 ? 'jaune' : 'vert'));
  setRiskText('apic-status', `${apic.status || 'inconnu'} · ${total} alerte(s)`, level);
  setServiceInfoWithSource('apic-info', 'Département 38', apic.source_data || apic.source || '');
  setHtml('apic-list', alerts.slice(0, 10).map((alert) => {
    const zone = escapeHtml(alert.zone || 'Isère');
    const alertLevel = normalizeLevel(alert.level || 'jaune');
    const firstAlert = alert.first_alert_at ? ` · 1ère alerte ${escapeHtml(alert.first_alert_at)}` : '';
    const lastChange = alert.last_change_at ? ` · maj ${escapeHtml(alert.last_change_at)}` : '';
    return `<li><strong>${zone}</strong> · <span style="color:${levelColor(alertLevel)}">${escapeHtml(alertLevel)}</span>${firstAlert}${lastChange}</li>`;
  }).join('') || '<li>Aucune alerte APIC en cours sur l’Isère.</li>');
}

function renderVigicruesFlashAlerts(vigicruesFlash = {}) {
  const alerts = Array.isArray(vigicruesFlash?.alerts) ? vigicruesFlash.alerts : [];
  const total = Number(vigicruesFlash?.alerts_total ?? alerts.length);
  const level = normalizeLevel(vigicruesFlash?.level || (total > 0 ? 'jaune' : 'vert'));
  setRiskText('vigicrues-flash-status', `${vigicruesFlash.status || 'inconnu'} · ${total} alerte(s)`, level);
  setServiceInfoWithSource('vigicrues-flash-info', 'Département 38', vigicruesFlash.source_data || vigicruesFlash.source || '');
  setHtml('vigicrues-flash-list', alerts.slice(0, 10).map((alert) => {
    const zone = escapeHtml(alert.zone || 'Isère');
    const alertLevel = normalizeLevel(alert.level || 'jaune');
    return `<li><strong>${zone}</strong> · <span style="color:${levelColor(alertLevel)}">${escapeHtml(alertLevel)}</span></li>`;
  }).join('') || '<li>Aucune alerte Vigicrues Flash en cours sur l’Isère.</li>');
}

function renderAvalancheIsere(data = {}) {
  const massifs = Array.isArray(data.massifs) ? data.massifs : [];
  const niveauGlobal = data.niveau_global || 'gris';
  const niveauMax = data.niveau_max_bra;
  const braColors = { 1: '#2b8a3e', 2: '#e9a800', 3: '#e67700', 4: '#c92a2a', 5: '#6741d9' };
  const braLabels = { 1: 'Faible', 2: 'Limité', 3: 'Marqué', 4: 'Fort', 5: 'Très fort' };
  setRiskText('avalanche-svc-status', `${data.status || 'inconnu'} · Niveau max ${niveauMax ?? '?'}/5 · ${massifs.length} massif(s)`, data.status === 'online' ? 'vert' : 'jaune');
  setHtml('avalanche-svc-list', massifs.map((m) => {
    const lvl = m.niveau_bra;
    const color = braColors[lvl] || '#868e96';
    const label = braLabels[lvl] || 'Indisponible';
    return `<li><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:5px"></span><strong>${escapeHtml(m.nom || '?')}</strong> <span style="color:${color};font-weight:600">${lvl ? lvl + '/5 · ' + label : '—'}</span> <span class="muted">${escapeHtml(m.date_echeance ? '· ' + m.date_echeance : '')}</span></li>`;
  }).join('') || '<li>Aucune donnée BRA disponible.</li>');
}

function renderFeuxForetWidget(data = {}) {
  const total = data.fires_total ?? 0;
  const color = total > 5 ? 'rouge' : total > 0 ? 'orange' : 'vert';
  const src = data.data_source ? ` · ${escapeHtml(data.data_source)}` : '';
  setRiskText('feux-svc-status', `${data.status || 'inconnu'} · ${total} foyer(s) détecté(s)${src}`, color);

  const top = Array.isArray(data.top_fires) && data.top_fires.length ? data.top_fires
              : Array.isArray(data.fires) ? data.fires.slice(0, 3) : [];

  if (!top.length) {
    setHtml('feux-svc-list', '<li class="muted">Aucun foyer détecté dans le département.</li>');
    return;
  }

  setHtml('feux-svc-list', top.map((f, i) => {
    const zone    = escapeHtml(f.zone || `${f.lat?.toFixed(2)}°N ${f.lon?.toFixed(2)}°E`);
    const frp     = f.frp != null ? `<strong>${Number(f.frp).toFixed(0)} MW</strong>` : '– MW';
    const conf    = escapeHtml(f.confidence || '?');
    const confColor = conf === 'high' ? '#c92a2a' : conf === 'nominal' ? '#e67700' : '#868e96';
    const dateStr = f.date ? escapeHtml(f.date) + (f.time ? ` ${String(f.time).padStart(4,'0').replace(/(\d{2})(\d{2})/, '$1h$2')}` : '') : '–';
    const label   = i === 0 ? '🔴 Dernière alerte' : i === 1 ? '🟠 Alerte précédente' : '🟡 Alerte antérieure';
    return `<li style="padding:4px 0;border-bottom:1px solid #eee">
      <span style="font-size:0.7em;font-weight:600;color:#888;text-transform:uppercase">${label}</span><br>
      <strong>📍 ${zone}</strong><br>
      <span class="muted">Puissance : ${frp} · Confiance : <span style="color:${confColor};font-weight:600">${conf}</span></span><br>
      <span class="muted">Détecté le ${dateStr}</span>
    </li>`;
  }).join(''));
}

function renderColsAlpinsWidget(data = {}) {
  const cols = Array.isArray(data.cols) ? data.cols : [];
  const braColors = { vert: '#2b8a3e', jaune: '#e9a800', orange: '#e67700', rouge: '#c92a2a', gris: '#868e96' };
  const sourceIsOfficial = isOfficialColsSource(data);
  const colorLevel = (data.dangereux_total ?? 0) > 0 ? 'jaune' : (sourceIsOfficial ? 'vert' : (data.status === 'pending' ? 'jaune' : 'gris'));
  setRiskText('cols-svc-status', `${data.status || 'inconnu'} · ${data.dangereux_total ?? 0} à surveiller / ${data.cols_total ?? 0} cols`, colorLevel);
  setHtml('cols-svc-list', cols.map((c) => {
    const color = braColors[c.couleur] || '#868e96';
    return `<li><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:4px"></span><strong>${escapeHtml(c.nom)}</strong> <span style="color:${color};font-weight:600">${escapeHtml(c.statut || '?')}</span> <span class="muted">- ${escapeHtml(c.detail || '')}</span></li>`;
    return `<li><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:4px"></span><strong>${escapeHtml(c.nom)}</strong> <span style="color:${color};font-weight:600">${escapeHtml(c.statut || '?')}</span> <span class="muted">Â· ${escapeHtml(c.detail || '')}</span></li>`;
    return `<li><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:4px"></span><strong>${escapeHtml(c.nom)}</strong> <span style="color:${color};font-weight:600">${escapeHtml(c.statut || '?')}</span> <span class="muted">· ${c.alt} m · ${escapeHtml(c.detail || '')}</span></li>`;
  }).join('') || `<li class="muted">${data.status === 'pending' ? 'Actualisation Itinisère en cours…' : 'Aucune donnée cols disponible.'}</li>`);
}

function renderOfficialColsAlpinsWidget(data = {}) {
  const cols = Array.isArray(data.cols) ? data.cols : [];
  const braColors = { vert: '#2b8a3e', jaune: '#e9a800', orange: '#e67700', rouge: '#c92a2a', gris: '#868e96' };
  const sourceIsOfficial = isOfficialColsSource(data);
  const colorLevel = (data.dangereux_total ?? 0) > 0 ? 'jaune' : (sourceIsOfficial ? 'vert' : (data.status === 'pending' ? 'jaune' : 'gris'));
  setRiskText('cols-svc-status', `${data.status || 'inconnu'} · ${data.dangereux_total ?? 0} à surveiller / ${data.cols_total ?? 0} cols`, colorLevel);
  setHtml('cols-svc-list', cols.map((c) => {
    const color = braColors[c.couleur] || '#868e96';
    const metaPartsClean = [];
    if (String(c.route || '').trim()) metaPartsClean.push(String(c.route).trim());
    if (String(c.detail || '').trim()) metaPartsClean.push(String(c.detail).trim());
    const metaClean = metaPartsClean.length ? ` <span class="muted">- ${escapeHtml(metaPartsClean.join(' - '))}</span>` : '';
    return `<li><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:4px"></span><strong>${escapeHtml(c.nom)}</strong> <span style="color:${color};font-weight:600">${escapeHtml(c.statut || '?')}</span>${metaClean}</li>`;
    const metaPartsWithoutAltitude = [];
    if (String(c.route || '').trim()) metaPartsWithoutAltitude.push(String(c.route).trim());
    if (String(c.detail || '').trim()) metaPartsWithoutAltitude.push(String(c.detail).trim());
    const metaWithoutAltitude = metaPartsWithoutAltitude.length ? ` <span class="muted">Â· ${escapeHtml(metaPartsWithoutAltitude.join(' Â· '))}</span>` : '';
    return `<li><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:4px"></span><strong>${escapeHtml(c.nom)}</strong> <span style="color:${color};font-weight:600">${escapeHtml(c.statut || '?')}</span>${metaWithoutAltitude}</li>`;
    const metaParts = [];
    if (Number.isFinite(Number(c.alt))) metaParts.push(`${Number(c.alt)} m`);
    if (String(c.route || '').trim()) metaParts.push(String(c.route).trim());
    if (String(c.detail || '').trim()) metaParts.push(String(c.detail).trim());
    const meta = metaParts.length ? ` <span class="muted">· ${escapeHtml(metaParts.join(' · '))}</span>` : '';
    return `<li><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:4px"></span><strong>${escapeHtml(c.nom)}</strong> <span style="color:${color};font-weight:600">${escapeHtml(c.statut || '?')}</span>${meta}</li>`;
  }).join('') || `<li class="muted">${data.status === 'pending' ? 'Actualisation Itinisère en cours…' : 'Aucune donnée cols disponible.'}</li>`);
}

function setServiceInfoWithSource(targetId, label, sourceCandidate) {
  const safeLabel = escapeHtml(String(label || '').trim() || '-');
  const safeSource = String(sourceCandidate || '').trim();
  if (safeSource.startsWith('http')) {
    setHtml(
      targetId,
      `<span>${safeLabel} · source officielle</span> <a class="ghost inline-action api-card-open-link" href="${escapeHtml(safeSource)}" target="_blank" rel="noreferrer noopener">Ouvrir</a>`,
    );
    return;
  }
  setText(targetId, `${label} · source indisponible`);
}


function formatPrecipitationProbability(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/d';
  return `${Math.max(0, Math.min(100, Math.round(numeric)))}%`;
}

function weatherCodeEmoji(code) {
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) return '🌤️';
  if (numeric === 0) return '☀️';
  if ([1, 2].includes(numeric)) return '🌤️';
  if ([3, 45, 48].includes(numeric)) return '☁️';
  if ([51, 53, 55, 61, 63, 80, 81].includes(numeric)) return '🌧️';
  if ([65, 82, 66, 67].includes(numeric)) return '⛈️';
  if ([71, 73, 75, 85, 86].includes(numeric)) return '❄️';
  if ([95, 96, 99].includes(numeric)) return '🌩️';
  return '🌦️';
}

function weatherCodeLabel(code) {
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) return 'Condition non précisée';
  const mapping = {
    0: 'Ciel dégagé',
    1: 'Peu nuageux',
    2: 'Partiellement nuageux',
    3: 'Couvert',
    45: 'Brouillard',
    48: 'Brouillard givrant',
    51: 'Bruine légère',
    53: 'Bruine',
    55: 'Bruine dense',
    61: 'Pluie faible',
    63: 'Pluie modérée',
    65: 'Pluie forte',
    66: 'Pluie verglaçante faible',
    67: 'Pluie verglaçante forte',
    71: 'Neige faible',
    73: 'Neige modérée',
    75: 'Neige forte',
    80: 'Averses faibles',
    81: 'Averses modérées',
    82: 'Averses fortes',
    85: 'Averses de neige',
    86: 'Fortes averses de neige',
    95: 'Orages',
    96: 'Orages et grêle',
    99: 'Orages forts et grêle',
  };
  return mapping[numeric] || 'Condition variable';
}

function toFrenchDate(value) {
  if (!value) return '-';
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

function formatHourLabel(value) {
  if (!value) return '--:--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function renderMeteoHourlyForecast(cityForecast) {
  const container = document.getElementById('meteo-hourly-list');
  if (!container) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hours = Array.isArray(cityForecast?.hourly_forecast) ? cityForecast.hourly_forecast : [];
  const todayHours = hours.filter((hour) => typeof hour?.date_time === 'string' && hour.date_time.startsWith(today));
  const upcoming = todayHours.filter((hour) => {
    const dt = new Date(hour.date_time);
    return !Number.isNaN(dt.getTime()) && dt >= now;
  }).slice(0, 12);

  const hourlyToRender = upcoming.length ? upcoming : todayHours.slice(0, 12);
  if (!hourlyToRender.length) {
    container.innerHTML = "<p class=\"muted\">Prévisions horaires indisponibles pour aujourd'hui.</p>";
    return;
  }

  container.innerHTML = hourlyToRender.map((hour) => {
    const temp = Number.isFinite(Number(hour.temp_c)) ? `${Math.round(Number(hour.temp_c))}°C` : 'n/d';
    const rain = formatPrecipitationProbability(hour.precip_probability);
    const emoji = weatherCodeEmoji(hour.weather_code);
    const summary = weatherCodeLabel(hour.weather_code);
    return `<article class="meteo-hour-card"><h5>${escapeHtml(formatHourLabel(hour.date_time))}</h5><p>${emoji} ${escapeHtml(summary)}</p><p><strong>${escapeHtml(temp)}</strong> · Pluie: <strong>${escapeHtml(rain)}</strong></p></article>`;
  }).join('');
}

async function getMeteoCityOptions() {
  const byKey = new Map((currentUser?.role === 'mairie' ? [] : ISERE_MAJOR_CITIES).map((city) => [city.key, city]));
  const pcsMunicipalities = (Array.isArray(cachedMunicipalities) ? cachedMunicipalities : [])
    .filter((municipality) => municipality?.pcs_active)
    .filter((municipality) => {
      if (currentUser?.role !== 'mairie') return true;
      return String(municipality?.name || '').trim().toLowerCase() === String(currentUser?.municipality_name || '').trim().toLowerCase();
    });

  const geocoded = await Promise.all(
    pcsMunicipalities.map(async (municipality) => ({
      municipality,
      point: await geocodeMunicipality(municipality),
    })),
  );

  geocoded.forEach(({ municipality, point }) => {
    if (!municipality || !point) return;
    const normalizedName = String(municipality.name || '').trim();
    if (!normalizedName) return;
    const key = `pcs-${String(municipality.insee_code || normalizedName)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')}`;
    const duplicate = Array.from(byKey.values()).some((city) => {
      const sameName = String(city.name || '').trim().toLowerCase() === normalizedName.toLowerCase();
      const closePoint = Math.abs(Number(city.lat || 0) - point.lat) < 0.001 && Math.abs(Number(city.lon || 0) - point.lon) < 0.001;
      return sameName || closePoint;
    });
    if (duplicate) return;
    byKey.set(key, {
      key,
      name: normalizedName,
      lat: point.lat,
      lon: point.lon,
      population: municipality.population || 0,
      isPcs: true,
    });
  });

  const options = Array.from(byKey.values())
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'fr'));
  meteoCityOptions = options.length ? options : (currentUser?.role === 'mairie' ? [] : [...ISERE_MAJOR_CITIES]);
  return meteoCityOptions;
}

function getSelectedMeteoCity() {
  if (currentUser?.role === 'mairie') {
    return meteoCityOptions.find((city) => city.key === selectedMeteoCityKey) || meteoCityOptions[0] || null;
  }
  return meteoCityOptions.find((city) => city.key === selectedMeteoCityKey) || meteoCityOptions[0] || ISERE_MAJOR_CITIES[0];
}

function cityForecastCacheKey(city) {
  return `city:${city.key}`;
}

async function fetchWeeklyForecastForCity(city) {
  const key = cityForecastCacheKey(city);
  if (cachedWeeklyMeteo?.[key]) return cachedWeeklyMeteo[key];
  if (weeklyMeteoInFlight?.[key]) return weeklyMeteoInFlight[key];

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(city.lat)}&longitude=${encodeURIComponent(city.lon)}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max&hourly=temperature_2m,precipitation,precipitation_probability,weathercode&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,rain,showers,wind_speed_10m,wind_gusts_10m,weathercode&timezone=Europe%2FParis&forecast_days=7`;

  weeklyMeteoInFlight = weeklyMeteoInFlight && typeof weeklyMeteoInFlight === 'object' ? weeklyMeteoInFlight : {};
  weeklyMeteoInFlight[key] = fetchWithTimeout(url, {}, 12000)
    .then((response) => {
      if (!response.ok) throw new Error(`open-meteo ${response.status}`);
      return response.json();
    })
    .then((payload) => {
      const daily = payload?.daily || {};
      const entries = Array.isArray(daily.time) ? daily.time.map((date, index) => ({
        date,
        weather_code: daily.weathercode?.[index],
        temp_max_c: daily.temperature_2m_max?.[index],
        temp_min_c: daily.temperature_2m_min?.[index],
        precip_probability_max: daily.precipitation_probability_max?.[index],
        precipitation_sum_mm: daily.precipitation_sum?.[index],
        wind_speed_max_kmh: daily.wind_speed_10m_max?.[index],
        wind_gust_max_kmh: daily.wind_gusts_10m_max?.[index],
      })) : [];
      const hourly = payload?.hourly || {};
      const hourlyEntries = Array.isArray(hourly.time) ? hourly.time.map((dateTime, index) => ({
        date_time: dateTime,
        weather_code: hourly.weathercode?.[index],
        temp_c: hourly.temperature_2m?.[index],
        precipitation_mm: hourly.precipitation?.[index],
        precip_probability: hourly.precipitation_probability?.[index],
      })) : [];
      const data = {
        source: 'open-meteo',
        city_name: city.name,
        updated_at: new Date().toISOString(),
        current: payload?.current || {},
        daily_forecast: entries,
        hourly_forecast: hourlyEntries,
      };
      cachedWeeklyMeteo = cachedWeeklyMeteo && typeof cachedWeeklyMeteo === 'object' ? cachedWeeklyMeteo : {};
      cachedWeeklyMeteo[key] = data;
      return data;
    })
    .catch(() => null)
    .finally(() => {
      if (weeklyMeteoInFlight?.[key]) delete weeklyMeteoInFlight[key];
    });

  return weeklyMeteoInFlight[key];
}

async function renderMeteoCitySelector() {
  const select = document.getElementById('meteo-city-select');
  if (!select) return;
  const options = await getMeteoCityOptions();
  if (currentUser?.role === 'mairie' && options.length === 1) {
    selectedMeteoCityKey = options[0].key;
  }
  const previousValue = select.value || selectedMeteoCityKey;
  select.innerHTML = options.map((city) => `<option value="${escapeHtml(city.key)}">${escapeHtml(city.name)}${city.isPcs ? ' · PCS' : ''}</option>`).join('');
  const found = options.some((city) => city.key === previousValue);
  select.value = found ? previousValue : (options[0]?.key || ISERE_MAJOR_CITIES[0].key);
  selectedMeteoCityKey = select.value;
  select.disabled = currentUser?.role === 'mairie';
  if (select.dataset.bound === '1') return;
  select.addEventListener('change', async () => {
    selectedMeteoCityKey = select.value;
    await renderWeeklyWeatherPanel(cachedExternalRisksSnapshot || {});
  });
  select.dataset.bound = '1';
}

function renderMeteoCurrentCard(cityForecast, city) {
  const container = document.getElementById('meteo-city-current');
  if (!container) return;
  const current = cityForecast?.current || {};
  const weatherCode = current.weathercode;
  const label = weatherCodeLabel(weatherCode);
  const emoji = weatherCodeEmoji(weatherCode);
  const temp = Number.isFinite(Number(current.temperature_2m)) ? `${Math.round(Number(current.temperature_2m))}°C` : 'n/d';
  const felt = Number.isFinite(Number(current.apparent_temperature)) ? `${Math.round(Number(current.apparent_temperature))}°C` : 'n/d';
  const humidity = Number.isFinite(Number(current.relative_humidity_2m)) ? `${Math.round(Number(current.relative_humidity_2m))}%` : 'n/d';
  const wind = Number.isFinite(Number(current.wind_speed_10m)) ? `${Math.round(Number(current.wind_speed_10m))} km/h` : 'n/d';

  container.innerHTML = `
    <h4>${emoji} ${escapeHtml(city.name)} · météo du jour</h4>
    <p><strong>${escapeHtml(label)}</strong></p>
    <p>Température: <strong>${escapeHtml(temp)}</strong> · Ressenti: <strong>${escapeHtml(felt)}</strong></p>
    <p>Humidité: <strong>${escapeHtml(humidity)}</strong> · Vent: <strong>${escapeHtml(wind)}</strong></p>
  `;
}

async function renderWeeklyWeatherPanel(externalRisks = {}) {
  const meteo = externalRisks?.meteo_france || {};
  await renderMeteoCitySelector();
  const selectedCity = getSelectedMeteoCity();
  if (!selectedCity) {
    setHtml('meteo-city-current', '<p class="muted">Aucune commune PCS géolocalisée disponible pour ce compte.</p>');
    setHtml('meteo-hourly-list', '<p class="muted">Prévisions horaires indisponibles pour le moment.</p>');
    setHtml('meteo-week-list', '<p class="muted">Aucune commune météo disponible pour ce compte.</p>');
    setText('meteo-week-updated', 'Dernière mise à jour météo: non disponible');
    return;
  }
  const cityForecast = await fetchWeeklyForecastForCity(selectedCity);
  const dailySource = Array.isArray(cityForecast?.daily_forecast) && cityForecast.daily_forecast.length
    ? cityForecast.daily_forecast
    : (Array.isArray(meteo.daily_forecast) && meteo.daily_forecast.length ? meteo.daily_forecast : []);
  const daily = dailySource.slice(0, 7);
  const weekList = document.getElementById('meteo-week-list');

  renderMeteoCurrentCard(cityForecast, selectedCity);
  renderMeteoHourlyForecast(cityForecast);

  if (weekList) {
    weekList.innerHTML = daily.map((day) => {
      const dayLabel = toFrenchDate(day.date);
      const summary = weatherCodeLabel(day.weather_code);
      const min = Number.isFinite(Number(day.temp_min_c)) ? `${Math.round(Number(day.temp_min_c))}°C` : 'n/d';
      const max = Number.isFinite(Number(day.temp_max_c)) ? `${Math.round(Number(day.temp_max_c))}°C` : 'n/d';
      const wind = Number.isFinite(Number(day.wind_speed_max_kmh)) ? `${Math.round(Number(day.wind_speed_max_kmh))} km/h` : 'n/d';
      const emoji = weatherCodeEmoji(day.weather_code);
      return `<article class="meteo-day-card"><h5>${emoji} ${escapeHtml(dayLabel)}</h5><p>${escapeHtml(summary)}</p><p><strong>${min}</strong> · <strong>${max}</strong></p><p>Pluie: ${escapeHtml(formatPrecipitationProbability(day.precip_probability_max))}</p><p>Vent max: ${escapeHtml(wind)}</p></article>`;
    }).join('') || '<p class="muted">Prévisions indisponibles pour le moment.</p>';
  }

  const updateText = cityForecast?.updated_at || meteo.updated_at || externalRisks.updated_at || null;
  const updateDate = updateText ? new Date(updateText) : null;
  const label = updateDate && !Number.isNaN(updateDate.getTime())
    ? `Dernière mise à jour météo: ${updateDate.toLocaleString('fr-FR')}`
    : 'Dernière mise à jour météo: non disponible';
  setText('meteo-week-updated', label);
}

function getWaterMunicipalityOptions() {
  return (Array.isArray(cachedMunicipalities) ? cachedMunicipalities : [])
    .filter((municipality) => municipality?.pcs_active)
    .filter((municipality) => {
      if (currentUser?.role !== 'mairie') return true;
      return String(municipality?.name || '').trim().toLowerCase() === String(currentUser?.municipality_name || '').trim().toLowerCase();
    })
    .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), 'fr'));
}

function renderWaterMunicipalitySelector() {
  const select = document.getElementById('water-municipality-select');
  if (!select) return [];
  const municipalities = getWaterMunicipalityOptions();
  if (currentUser?.role === 'mairie' && municipalities.length === 1) {
    selectedWaterMunicipalityId = String(municipalities[0].id);
  } else if (selectedWaterMunicipalityId && !municipalities.some((item) => String(item.id) === String(selectedWaterMunicipalityId))) {
    selectedWaterMunicipalityId = '';
  }
  const placeholder = currentUser?.role === 'mairie' ? '' : '<option value="">Sélectionnez une commune PCS</option>';
  const options = municipalities.map((municipality) => (
    `<option value="${escapeHtml(String(municipality.id))}">${escapeHtml(municipality.name || 'Commune')}</option>`
  )).join('');
  setHtml('water-municipality-select', `${placeholder}${options}`);
  select.disabled = currentUser?.role === 'mairie';
  select.value = selectedWaterMunicipalityId || '';
  return municipalities;
}

function waterPanelEmptyState(message = 'Sélectionnez une commune PCS pour afficher les données eau potable et assainissement.') {
  setVisibility(document.getElementById('water-panel-empty'), true);
  setVisibility(document.getElementById('water-panel-content'), false);
  setHtml('water-panel-empty', `<h4>Choisir une commune</h4><p class="muted">${escapeHtml(message)}</p>`);
  setHtml('water-quality-summary', '');
  setHtml('water-quality-list', '');
  setHtml('water-services-summary', '');
  setHtml('water-services-list', '');
}

function formatWaterDate(value) {
  if (!value) return 'Date inconnue';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('fr-FR') : String(value);
}

function formatWaterMetric(value, unit = '') {
  if (value == null || value === '') return 'n/d';
  if (typeof value === 'number') {
    return `${value.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`;
  }
  return `${String(value)}${unit ? ` ${unit}` : ''}`;
}

function renderWaterQualityPanel(payload = {}) {
  const summary = payload?.summary || {};
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const cards = [
    { label: 'Dernier prélèvement', value: summary.last_sample_at ? formatWaterDate(summary.last_sample_at) : 'n/d' },
    { label: 'Paramètre récent', value: summary.latest_parameter || 'n/d' },
    { label: 'Résultat', value: summary.latest_result != null ? formatWaterMetric(summary.latest_result, summary.latest_unit || '') : 'n/d' },
    { label: 'Non conformités', value: String(summary.non_conforming_total ?? 0) },
  ];
  setHtml('water-quality-summary', cards.map((card) => (
    `<article class="water-summary-card"><span>${escapeHtml(card.label)}</span><strong>${escapeHtml(String(card.value))}</strong></article>`
  )).join(''));

  if (!items.length) {
    setHtml('water-quality-list', `<p class="muted">Aucune analyse disponible pour cette commune.</p>${payload?.error ? `<p class="error">${escapeHtml(payload.error)}</p>` : ''}`);
    return;
  }

  const markup = items.slice(0, 8).map((item) => `
    <article class="water-card">
      <div class="water-card__head">
        <strong>${escapeHtml(item.libelle_parametre || 'Analyse')}</strong>
        <span>${escapeHtml(formatWaterDate(item.date_prelevement))}</span>
      </div>
      <p><strong>Résultat:</strong> ${escapeHtml(item.resultat_alphanumerique || formatWaterMetric(item.resultat_numerique, item.libelle_unite || ''))}</p>
      ${item.limite_qualite_parametre ? `<p><strong>Limite qualité:</strong> ${escapeHtml(item.limite_qualite_parametre)}</p>` : ''}
      ${item.nom_installation_amont ? `<p><strong>Installation:</strong> ${escapeHtml(item.nom_installation_amont)}</p>` : ''}
      ${item.nom_distributeur ? `<p><strong>Distributeur:</strong> ${escapeHtml(item.nom_distributeur)}</p>` : ''}
      ${item.conclusion_conformite_prelevement ? `<p class="muted">${escapeHtml(item.conclusion_conformite_prelevement)}</p>` : ''}
    </article>
  `).join('');

  setHtml('water-quality-list', `
    ${summary.latest_conclusion ? `<div class="water-banner">${escapeHtml(summary.latest_conclusion)}</div>` : ''}
    ${payload?.warning ? `<p class="muted">${escapeHtml(payload.warning)}</p>` : ''}
    ${markup}
  `);
}

function renderWaterServicesPanel(payload = {}) {
  const summary = payload?.summary || {};
  const aep = summary?.aep || {};
  const ac = summary?.ac || {};
  const anc = summary?.anc || {};
  const items = Array.isArray(payload?.items) ? payload.items : [];

  const kpis = [
    { label: 'Année de référence', value: summary.latest_year || 'n/d' },
    { label: 'Rendement réseau AEP', value: aep.rendement_reseau != null ? formatWaterMetric(aep.rendement_reseau, '%') : 'n/d' },
    { label: 'Prix eau', value: aep.prix_ttc_m3 != null ? formatWaterMetric(aep.prix_ttc_m3, '€/m³') : 'n/d' },
    { label: 'Desservi AEP', value: aep.population_desservie != null ? formatWaterMetric(aep.population_desservie) : 'n/d' },
  ];
  setHtml('water-services-summary', kpis.map((kpi) => (
    `<article class="water-kpi"><span>${escapeHtml(kpi.label)}</span><strong>${escapeHtml(String(kpi.value))}</strong></article>`
  )).join(''));

  if (!items.length) {
    setHtml('water-services-list', `<p class="muted">Aucun indicateur SISPEA disponible pour cette commune.</p>${payload?.error ? `<p class="error">${escapeHtml(payload.error)}</p>` : ''}`);
    return;
  }

  const sections = [
    {
      title: 'Eau potable (AEP)',
      item: aep,
      rows: [
        ['Population desservie', aep.population_desservie != null ? formatWaterMetric(aep.population_desservie) : 'n/d'],
        ['Prix TTC', aep.prix_ttc_m3 != null ? formatWaterMetric(aep.prix_ttc_m3, '€/m³') : 'n/d'],
        ['Rendement réseau', aep.rendement_reseau != null ? formatWaterMetric(aep.rendement_reseau, '%') : 'n/d'],
        ['Indice pertes', aep.indice_pertes_reseau != null ? formatWaterMetric(aep.indice_pertes_reseau) : 'n/d'],
        ['Conformité microbio', aep.taux_conformite_microbio != null ? formatWaterMetric(aep.taux_conformite_microbio, '%') : 'n/d'],
        ['Conformité physicochimie', aep.taux_conformite_physicochimie != null ? formatWaterMetric(aep.taux_conformite_physicochimie, '%') : 'n/d'],
      ],
    },
    {
      title: 'Assainissement collectif (AC)',
      item: ac,
      rows: [
        ['Population desservie', ac.population_desservie != null ? formatWaterMetric(ac.population_desservie) : 'n/d'],
        ['Taux desserte', ac.taux_desserte_assainissement != null ? formatWaterMetric(ac.taux_desserte_assainissement, '%') : 'n/d'],
        ['Conformité ERU', ac.conformite_eru != null ? formatWaterMetric(ac.conformite_eru, '%') : 'n/d'],
      ],
    },
    {
      title: 'Assainissement non collectif (ANC)',
      item: anc,
      rows: [
        ['Population desservie', anc.population_desservie != null ? formatWaterMetric(anc.population_desservie) : 'n/d'],
        ['Conformité ANC', anc.taux_conformite_anc != null ? formatWaterMetric(anc.taux_conformite_anc, '%') : 'n/d'],
      ],
    },
  ].filter((section) => section.item && Object.keys(section.item).length);

  setHtml('water-services-list', sections.map((section) => `
    <article class="water-card">
      <div class="water-card__head">
        <strong>${escapeHtml(section.title)}</strong>
        <span>${escapeHtml(String(summary.latest_year || 'n/d'))}</span>
      </div>
      ${section.rows.map(([labelText, value]) => `<p><strong>${escapeHtml(labelText)}:</strong> ${escapeHtml(String(value))}</p>`).join('')}
    </article>
  `).join(''));
}

function stationDelayLabel(item = {}) {
  const delay = Number(item.delay_minutes || 0);
  if (delay > 0) return `+${delay} min`;
  if (delay < 0) return `${delay} min`;
  return 'A l heure';
}

function stationDelayClass(item = {}) {
  const delay = Number(item.delay_minutes || 0);
  if (delay > 0) return 'stations-delay stations-delay--late';
  if (delay < 0) return 'stations-delay stations-delay--early';
  return 'stations-delay';
}

function stationSortTime(item = {}) {
  const raw = item.expected_time || item.aimed_time || '';
  const time = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function upcomingStationItems(items = []) {
  const now = Date.now() - 60 * 1000;
  return (Array.isArray(items) ? items : [])
    .filter((item) => stationSortTime(item) >= now)
    .sort((a, b) => stationSortTime(a) - stationSortTime(b))
    .slice(0, 10);
}

function renderStationRows(items = [], movement = 'departure') {
  const upcoming = upcomingStationItems(items);
  if (!upcoming.length) {
    return '<tr><td colspan="6" class="muted">Aucun horaire proche.</td></tr>';
  }
  return upcoming.map((item) => {
    const place = movement === 'departure' ? item.destination : item.origin;
    const train = [item.category, item.train_number || item.line].filter(Boolean).join(' ');
    const delay = Number(item.delay_minutes || 0);
    return `<tr class="${delay > 0 ? 'is-delayed' : ''}">
      <td><strong>${escapeHtml(item.scheduled_time || item.time || '--:--')}</strong></td>
      <td><strong>${escapeHtml(item.time || item.scheduled_time || '--:--')}</strong></td>
      <td>${escapeHtml(place || '-')}</td>
      <td>${escapeHtml(train || 'Train')}</td>
      <td>${escapeHtml(item.platform || '-')}</td>
      <td><span class="${stationDelayClass(item)}">${escapeHtml(stationDelayLabel(item))}</span></td>
    </tr>`;
  }).join('');
}

function renderStationTable(title, items = [], movement = 'departure') {
  const placeHeader = movement === 'departure' ? 'Destination' : 'Provenance';
  return `<section class="station-table-block">
    <h5>${escapeHtml(title)}</h5>
    <div class="station-table-wrap">
      <table class="station-timetable-table">
        <thead>
          <tr>
            <th>Prévu</th>
            <th>Réel</th>
            <th>${escapeHtml(placeHeader)}</th>
            <th>Train</th>
            <th>Voie</th>
            <th>Retard</th>
          </tr>
        </thead>
        <tbody>${renderStationRows(items, movement)}</tbody>
      </table>
    </div>
  </section>`;
}

function stationOperationalInfo(station = {}) {
  return STATION_OPERATIONAL_INFO[station.id] || {
    sector: 'Isere',
    role: 'Gare de proximite utile pour le maillage ferroviaire local.',
    connections: ['TER regional', 'rabattements routiers locaux'],
    attention: 'Verifier sur place les acces, l eclairage et la capacite d accueil avant activation.',
    usefulFor: ['desserte locale', 'point de rendez-vous', 'navette de rabattement'],
  };
}

function stationNextInfo(station = {}) {
  const departures = upcomingStationItems(station.departures || []);
  const arrivals = upcomingStationItems(station.arrivals || []);
  const delayedItems = [...departures, ...arrivals].filter((item) => Number(item.delay_minutes || 0) > 0);
  const maxDelay = delayedItems.reduce((max, item) => Math.max(max, Number(item.delay_minutes || 0)), 0);
  return { nextDeparture: departures[0], nextArrival: arrivals[0], maxDelay };
}

function renderStationOperationalInfo(station = {}) {
  const info = stationOperationalInfo(station);
  const next = stationNextInfo(station);
  const hasCoords = Number.isFinite(Number(station.lat)) && Number.isFinite(Number(station.lon));
  const coords = hasCoords ? `${Number(station.lat).toFixed(5)}, ${Number(station.lon).toFixed(5)}` : 'Coordonnees a confirmer';
  const osmHref = hasCoords
    ? `https://www.openstreetmap.org/?mlat=${encodeURIComponent(station.lat)}&mlon=${encodeURIComponent(station.lon)}#map=16/${encodeURIComponent(station.lat)}/${encodeURIComponent(station.lon)}`
    : '';
  const nextDepartureLabel = next.nextDeparture
    ? `${next.nextDeparture.time || next.nextDeparture.scheduled_time || '--:--'} vers ${next.nextDeparture.destination || 'destination non precisee'}`
    : 'Aucun depart proche';
  const nextArrivalLabel = next.nextArrival
    ? `${next.nextArrival.time || next.nextArrival.scheduled_time || '--:--'} depuis ${next.nextArrival.origin || 'provenance non precisee'}`
    : 'Aucune arrivee proche';
  return `<div class="station-operational-info">
    <div class="station-operational-info__main">
      <p class="station-operational-info__sector">${escapeHtml(info.sector || 'Isere')}</p>
      <p>${escapeHtml(info.role || '')}</p>
      <div class="station-operational-info__tags">
        ${(info.usefulFor || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
      </div>
    </div>
    <dl class="station-operational-info__details">
      <div><dt>Correspondances</dt><dd>${escapeHtml((info.connections || []).join(' · ') || 'A confirmer')}</dd></div>
      <div><dt>Point d attention</dt><dd>${escapeHtml(info.attention || 'Verifier les acces terrain avant activation.')}</dd></div>
      <div><dt>Prochain depart</dt><dd>${escapeHtml(nextDepartureLabel)}</dd></div>
      <div><dt>Prochaine arrivee</dt><dd>${escapeHtml(nextArrivalLabel)}</dd></div>
      <div><dt>Retard max visible</dt><dd class="${next.maxDelay > 0 ? 'station-operational-info__late' : ''}">${next.maxDelay > 0 ? escapeHtml(`+${next.maxDelay} min`) : 'Aucun retard proche'}</dd></div>
      <div><dt>Coordonnees</dt><dd>${osmHref ? `<a href="${escapeHtml(osmHref)}" target="_blank" rel="noreferrer">${escapeHtml(coords)}</a>` : escapeHtml(coords)}</dd></div>
    </dl>
  </div>`;
}

function syncStationsFilterOptions(stations = []) {
  const select = document.getElementById('stations-filter');
  if (!select) return;
  const current = select.value || selectedStationFilter;
  select.innerHTML = `<option value="">Toutes les gares</option>${stations.map((station) => `<option value="${escapeHtml(station.id)}">${escapeHtml(station.name)}</option>`).join('')}`;
  if ([...select.options].some((option) => option.value === current)) {
    select.value = current;
    selectedStationFilter = current;
  }
}

function normalizeSearchText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stationPopupTimetableHtml(resourceName = '') {
  const payload = stationsTimetableCache;
  const stations = Array.isArray(payload?.stations) ? payload.stations : [];
  if (!stations.length) return '<p class="muted stations-popup-note">Horaires temps reel en cours de chargement.</p>';
  const normalizedName = normalizeSearchText(resourceName).replace(/\bgare\s+(de|du|des|d)?\s*/g, '').trim();
  const station = stations.find((item) => {
    const name = normalizeSearchText(item.name || '');
    return name && (normalizedName.includes(name) || name.includes(normalizedName));
  });
  if (!station) return '<p class="muted stations-popup-note">Horaires non disponibles pour cette gare.</p>';
  const nextDepartures = upcomingStationItems(station.departures || []).slice(0, 2);
  const nextArrivals = upcomingStationItems(station.arrivals || []).slice(0, 2);
  const delayed = Number(station.delayed_total || 0);
  return `<div class="stations-popup">
    <strong>Horaires SNCF</strong>
    ${delayed > 0 ? `<span class="stations-popup-late">${delayed} retard(s)</span>` : '<span class="stations-popup-ok">A l heure</span>'}
    <div class="stations-popup-cols">
      <div><span>Departs</span>${nextDepartures.map((item) => `<p class="${item.is_delayed ? 'is-delayed' : ''}">${escapeHtml(item.time || '--:--')} · ${escapeHtml(item.destination || '-')}${item.is_delayed ? ` · <b>${escapeHtml(stationDelayLabel(item))}</b>` : ''}</p>`).join('') || '<p class="muted">Aucun</p>'}</div>
      <div><span>Arrivees</span>${nextArrivals.map((item) => `<p class="${item.is_delayed ? 'is-delayed' : ''}">${escapeHtml(item.time || '--:--')} · ${escapeHtml(item.origin || '-')}${item.is_delayed ? ` · <b>${escapeHtml(stationDelayLabel(item))}</b>` : ''}</p>`).join('') || '<p class="muted">Aucune</p>'}</div>
    </div>
  </div>`;
}

function renderStationsPanel(payload = stationsTimetableCache) {
  const list = document.getElementById('station-timetables-list');
  const summary = document.getElementById('stations-summary');
  const errorEl = document.getElementById('stations-error');
  if (!list) return;
  const stations = Array.isArray(payload?.stations) ? payload.stations : [];
  syncStationsFilterOptions(stations);
  const enrichedStations = stations.map((station) => {
    const arrivals = upcomingStationItems(station.arrivals || []);
    const departures = upcomingStationItems(station.departures || []);
    const delayed_total = [...arrivals, ...departures].filter((item) => Number(item.delay_minutes || 0) > 0).length;
    return { ...station, arrivals, departures, delayed_total, next_items_total: arrivals.length + departures.length };
  }).filter((station) => station.next_items_total > 0);
  const filtered = selectedStationFilter ? enrichedStations.filter((station) => station.id === selectedStationFilter) : enrichedStations;
  const delayedTotal = filtered.reduce((sum, station) => sum + Number(station.delayed_total || 0), 0);
  const nextTotal = filtered.reduce((sum, station) => sum + Number(station.next_items_total || 0), 0);
  if (summary) {
    summary.innerHTML = `
      <article><strong>${filtered.length}</strong><span>gare(s)</span></article>
      <article><strong>${nextTotal}</strong><span>mouvements proches</span></article>
      <article class="${delayedTotal > 0 ? 'is-delayed' : ''}"><strong>${delayedTotal}</strong><span>retard(s)</span></article>
      <article><strong>${escapeHtml(payload?.status || '-')}</strong><span>${escapeHtml(payload?.source_label || 'SNCF temps reel')}</span></article>`;
  }
  if (errorEl) errorEl.textContent = payload?.error ? sanitizeErrorMessage(payload.error) : '';
  if (!filtered.length) {
    list.innerHTML = '<p class="muted">Aucun horaire SNCF Isere disponible pour le moment.</p>';
    return;
  }
  list.innerHTML = filtered.map((station) => `
    <article class="station-timetable ${Number(station.delayed_total || 0) > 0 ? 'station-timetable--delayed' : ''}">
      <header>
        <div>
          <h4>${escapeHtml(station.name)}</h4>
          <p class="muted">${Number(station.next_items_total || 0)} horaire(s) proche(s)</p>
        </div>
        <span class="${Number(station.delayed_total || 0) > 0 ? 'station-status station-status--late' : 'station-status'}">
          ${Number(station.delayed_total || 0) > 0 ? `${Number(station.delayed_total || 0)} retard(s)` : 'A l heure'}
        </span>
      </header>
      ${renderStationOperationalInfo(station)}
      <div class="station-timetable__grid">
        ${renderStationTable('Départs', station.departures || [], 'departure')}
        ${renderStationTable('Arrivées', station.arrivals || [], 'arrival')}
      </div>
    </article>`).join('');
}

async function loadAndRenderStationsPanel(forceRefresh = false, { silent = false } = {}) {
  if (stationsTimetableInFlight) return stationsTimetableInFlight;
  const list = document.getElementById('station-timetables-list');
  const errorEl = document.getElementById('stations-error');
  if (list && !stationsTimetableCache && !silent) list.innerHTML = '<p class="muted">Chargement des horaires SNCF...</p>';
  if (errorEl) errorEl.textContent = '';
  const suffix = forceRefresh ? '?refresh=true' : '';
  const request = api(`/api/sncf/isere/station-timetables${suffix}`, {
    bypassCache: forceRefresh,
    cacheTtlMs: forceRefresh ? 0 : STATION_TIMETABLE_REFRESH_MS,
    timeoutMs: API_SLOW_ENDPOINT_TIMEOUT_MS,
  }).then((payload) => {
    stationsTimetableCache = payload;
    renderStationsPanel(payload);
    if (leafletMap) renderResources();
    return payload;
  }).catch((error) => {
    if (errorEl && (!silent || !stationsTimetableCache)) errorEl.textContent = sanitizeErrorMessage(error.message);
    if (!stationsTimetableCache) renderStationsPanel({ status: 'degraded', stations: [], error: error.message });
    throw error;
  }).finally(() => {
    if (stationsTimetableInFlight === request) stationsTimetableInFlight = null;
  });
  stationsTimetableInFlight = request;
  return request;
}

function refreshStationTimetables({ forceRefresh = false, silent = true } = {}) {
  if (!token) return Promise.resolve(null);
  return loadAndRenderStationsPanel(forceRefresh, { silent }).catch((error) => {
    if (!silent) throw error;
    return null;
  });
}

async function loadAndRenderWaterPanel(forceRefresh = false) {
  renderWaterMunicipalitySelector();
  if (!selectedWaterMunicipalityId) {
    waterPanelEmptyState('Sélectionnez une commune PCS pour afficher les données eau potable et assainissement.');
    return;
  }

  const seq = ++waterPanelLoadSeq;
  const municipality = (Array.isArray(cachedMunicipalities) ? cachedMunicipalities : []).find((item) => String(item.id) === String(selectedWaterMunicipalityId));
  const cacheKey = String(selectedWaterMunicipalityId);

  setVisibility(document.getElementById('water-panel-empty'), false);
  setVisibility(document.getElementById('water-panel-content'), true);
  setHtml('water-quality-summary', '<article class="water-summary-card"><span>Chargement</span><strong>…</strong></article>');
  setHtml('water-quality-list', '<p class="muted">Chargement des analyses eau potable…</p>');
  setHtml('water-services-summary', '<article class="water-kpi"><span>Chargement</span><strong>…</strong></article>');
  setHtml('water-services-list', '<p class="muted">Chargement des indicateurs eau et assainissement…</p>');

  try {
    const payload = !forceRefresh && waterPanelCache.has(cacheKey)
      ? waterPanelCache.get(cacheKey)
      : await Promise.all([
        api(`/municipalities/${encodeURIComponent(selectedWaterMunicipalityId)}/water-quality${forceRefresh ? '?force_refresh=true' : ''}`, { bypassCache: forceRefresh, cacheTtlMs: forceRefresh ? 0 : API_CACHE_TTL_MS }),
        api(`/municipalities/${encodeURIComponent(selectedWaterMunicipalityId)}/water-services${forceRefresh ? '?force_refresh=true' : ''}`, { bypassCache: forceRefresh, cacheTtlMs: forceRefresh ? 0 : API_CACHE_TTL_MS }),
      ]).then(([quality, services]) => ({ quality, services }));

    if (seq !== waterPanelLoadSeq) return;
    waterPanelCache.set(cacheKey, payload);
    renderWaterQualityPanel(payload?.quality || {});
    renderWaterServicesPanel(payload?.services || {});
    if ((localStorage.getItem(STORAGE_KEYS.activePanel) || '') === 'water-panel') {
      document.getElementById('panel-title').textContent = municipality?.name
        ? `Eau potable et assainissement - ${municipality.name}`
        : PANEL_TITLES['water-panel'];
    }
  } catch (error) {
    if (seq !== waterPanelLoadSeq) return;
    waterPanelEmptyState(`Impossible de charger les données eau pour ${municipality?.name || 'la commune sélectionnée'} : ${sanitizeErrorMessage(error.message)}`);
  }
}

function getContactsCitySuggestions() {
  const names = new Set();
  (Array.isArray(cachedMunicipalities) ? cachedMunicipalities : []).forEach((municipality) => {
    const name = String(municipality?.name || '').trim();
    if (name) names.add(name);
  });
  ISERE_MAJOR_CITIES.forEach((city) => {
    const name = String(city?.name || '').trim();
    if (name) names.add(name);
  });
  if (currentUser?.municipality_name) names.add(String(currentUser.municipality_name).trim());
  return Array.from(names).sort((a, b) => a.localeCompare(b, 'fr'));
}

function normalizeLooseCityKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, ' ')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findMunicipalityByLooseName(city) {
  const target = normalizeLooseCityKey(city);
  if (!target) return null;
  return (Array.isArray(cachedMunicipalities) ? cachedMunicipalities : []).find((municipality) => {
    const name = normalizeLooseCityKey(municipality?.name);
    return name === target;
  }) || null;
}

function renderContactsCitySuggestions() {
  const datalist = document.getElementById('contacts-city-suggestions');
  if (!datalist) return;
  const options = getContactsCitySuggestions().map((city) => `<option value="${escapeHtml(city)}"></option>`).join('');
  setHtml('contacts-city-suggestions', options);
}

function renderContactsEmergencyNumbers(items = []) {
  const emergencyNumbers = Array.isArray(items) ? items : [];
  if (!emergencyNumbers.length) {
    setHtml('contacts-emergency-list', '<p class="muted">Aucun numéro d\'urgence disponible.</p>');
    return;
  }
  setHtml('contacts-emergency-list', emergencyNumbers.map((item) => `
    <article class="contacts-emergency-card">
      <span>${escapeHtml(item?.label || 'Urgence')}</span>
      <strong>${escapeHtml(item?.phone || '-')}</strong>
    </article>
  `).join(''));
}

function contactsPanelEmptyState(message = 'Saisissez une ville de l\'Isère pour afficher les contacts publics utiles.') {
  setText('contacts-results-title', 'Choisir une ville');
  setText('contacts-results-meta', 'Aucune recherche lancée.');
  setText('contacts-results-error', '');
  setHtml('contacts-results-list', `<p class="muted">${escapeHtml(message)}</p>`);
  renderContactsEmergencyNumbers([
    { label: 'Urgences européennes', phone: '112' },
    { label: 'Sapeurs-pompiers', phone: '18' },
    { label: 'SAMU', phone: '15' },
    { label: 'Police secours', phone: '17' },
    { label: "SMS d'urgence", phone: '114' },
  ]);
}

async function loadAndRenderContactsPanel(city = '', forceRefresh = false) {
  renderContactsCitySuggestions();
  const input = document.getElementById('contacts-city-search');
  const normalizedCity = String(city || input?.value || selectedContactsCity || '').trim();
  if (!normalizedCity) {
    contactsPanelEmptyState();
    return;
  }

  if (input) input.value = normalizedCity;
  selectedContactsCity = normalizedCity;
  const cacheKey = normalizedCity.toLowerCase();
  const seq = ++contactsPanelLoadSeq;

  setText('contacts-results-title', normalizedCity);
  setText('contacts-results-meta', 'Chargement des contacts publics utiles…');
  setText('contacts-results-error', '');
  setHtml('contacts-results-list', '<p class="muted">Recherche en cours…</p>');

  try {
    const matchedMunicipality = findMunicipalityByLooseName(normalizedCity);
    const payload = !forceRefresh && contactsPanelCache.has(cacheKey)
      ? contactsPanelCache.get(cacheKey)
      : matchedMunicipality
        ? await api(`/municipalities/${encodeURIComponent(matchedMunicipality.id)}/public-services${forceRefresh ? '?force_refresh=true' : ''}`, {
          bypassCache: forceRefresh,
          cacheTtlMs: forceRefresh ? 0 : API_CACHE_TTL_MS,
        }).then((data) => ({
          ...data,
          city: matchedMunicipality.name,
          contacts: Array.isArray(data?.municipality_contacts) ? data.municipality_contacts : [],
          contacts_total: Array.isArray(data?.municipality_contacts) ? data.municipality_contacts.length : 0,
          emergency_numbers: Array.isArray(data?.emergency_numbers) ? data.emergency_numbers : [],
        }))
        : await api(`/contacts/search?city=${encodeURIComponent(normalizedCity)}${forceRefresh ? '&force_refresh=true' : ''}`, {
          bypassCache: forceRefresh,
          cacheTtlMs: forceRefresh ? 0 : API_CACHE_TTL_MS,
        });
    if (seq !== contactsPanelLoadSeq) return;
    contactsPanelCache.set(cacheKey, payload);

    const contacts = Array.isArray(payload?.contacts)
      ? payload.contacts
      : (Array.isArray(payload?.municipality_contacts) ? payload.municipality_contacts : []);
    const cards = contacts.map((item) => renderPublicServiceCard(item, 'Contact public')).filter(Boolean);
    const importantContacts = Array.isArray(payload?.important_contacts) ? payload.important_contacts : [];
    const importantCards = importantContacts.map((item) => renderPublicServiceCard(item, 'Contact Isère')).filter(Boolean);
    renderContactsEmergencyNumbers(payload?.emergency_numbers || []);
    setText('contacts-results-title', payload?.city || payload?.municipality_name || normalizedCity);
    setText('contacts-results-meta', `${Number(payload?.contacts_total ?? contacts.length)} contact(s) utile(s) · source Annuaire administration`);
    setText('contacts-results-error', payload?.error ? sanitizeErrorMessage(payload.error) : '');
    if ((localStorage.getItem(STORAGE_KEYS.activePanel) || '') === 'contacts-panel') {
      document.getElementById('panel-title').textContent = (payload?.city || payload?.municipality_name)
        ? `Contacts utiles - ${payload.city || payload.municipality_name}`
        : PANEL_TITLES['contacts-panel'];
    }
    setHtml('contacts-results-list', cards.length
      ? `${cards.join('')}${importantCards.length ? `<div class="contacts-results-divider"><h5>Contacts importants Isère</h5>${importantCards.join('')}</div>` : ''}`
      : '<p class="muted">Aucun contact public exploitable trouvé pour cette ville iséroise.</p>');
  } catch (error) {
    if (seq !== contactsPanelLoadSeq) return;
    renderContactsEmergencyNumbers([]);
    setText('contacts-results-title', normalizedCity);
    setText('contacts-results-meta', 'Recherche impossible.');
    setText('contacts-results-error', sanitizeErrorMessage(error.message));
    setHtml('contacts-results-list', '<p class="muted">Impossible de charger les contacts pour cette ville.</p>');
  }
}

async function loadDashboard(forceRefresh = false) {
  const cached = readSnapshot(STORAGE_KEYS.dashboardSnapshot);
  if (cached) renderDashboard(cached);
  else renderSituationOverview();

  try {
    const suffix = forceRefresh ? '?refresh=true' : '';
    const dashboard = await api(`/dashboard${suffix}`, {
      bypassCache: forceRefresh,
      cacheTtlMs: forceRefresh ? 0 : API_CACHE_TTL_MS,
    });
    renderDashboard(dashboard);
    saveSnapshot(STORAGE_KEYS.dashboardSnapshot, dashboard);
  } catch (error) {
    if (cached) {
      document.getElementById('dashboard-error').textContent = `tableau de bord (cache): ${sanitizeErrorMessage(error.message)}`;
      return;
    }
    throw error;
  }
}

/* ── Services panel — cards builder & groundwater renderers ──────────────── */

const SVC_CARD_META = {
  meteo_france:          { statusId: 'meteo-status',           infoId: 'meteo-info',           url: 'https://vigilance.meteofrance.fr' },
  apic_isere:            { statusId: 'apic-status',            infoId: 'apic-info',            url: 'https://apic.meteofrance.fr' },
  vigicrues:             { statusId: 'vigicrues-status',       infoId: 'vigicrues-info',       url: 'https://www.vigicrues.gouv.fr' },
  vigicrues_flash_isere: { statusId: 'vigicrues-flash-status', infoId: 'vigicrues-flash-info', url: 'https://apic.meteofrance.fr/?mode=vf&area=fr' },
  vigieau:               { statusId: 'vigieau-status',         infoId: 'vigieau-info',         url: 'https://www.vigieau.gouv.fr' },
  groundwater_isere:     { statusId: 'groundwater-status',     infoId: 'groundwater-info',     url: 'https://hubeau.eaufrance.fr' },
  rnb_isere:             { statusId: 'rnb-status',             infoId: 'rnb-info',             url: 'https://rnb-fr.gitbook.io/documentation/api-et-outils/api-batiments/lister-des-batiments' },
  atmo_aura:             { statusId: 'atmo-status',            infoId: 'atmo-info',            url: 'https://www.atmo-auvergnerhonealpes.fr' },
  georisques:            { statusId: 'georisques-status',      infoId: 'georisques-info',      url: 'https://www.georisques.gouv.fr' },
  itinisere:             { statusId: 'itinisere-status',       infoId: null,                   url: 'https://www.itinisere.fr' },
  autoroutes_isere:      { statusId: 'autoroutes-status',      infoId: 'autoroutes-info',      url: 'https://www.bison-fute.gouv.fr' },
  sncf_isere:            { statusId: 'sncf-status',            infoId: 'sncf-info',            url: 'https://www.sncf.com/fr/itineraire-reservation/info-trafic' },
  prefecture_isere:      { statusId: 'prefecture-status',      infoId: 'prefecture-info',      url: 'https://www.isere.gouv.fr' },
  fr_alert_isere:        { statusId: 'fr-alert-status',        infoId: 'fr-alert-info',        url: 'https://fr-alert.gouv.fr' },
  dauphine_isere:        { statusId: 'dauphine-status',        infoId: 'dauphine-info',        url: 'https://www.ledauphine.com' },
  france_bleu_isere:     { statusId: 'francebleu-status',      infoId: 'francebleu-info',      url: 'https://www.francebleu.fr/isere' },
  placegrenet:           { statusId: 'placegrenet-svc-status', infoId: null,                   url: 'https://www.placegrenet.fr' },
  grenoble_metro:        { statusId: 'grenoble-metro-svc-status', infoId: null,                url: 'https://www.grenoblealpesmetropole.fr' },
  ars_aura:              { statusId: 'ars-aura-svc-status',    infoId: null,                   url: 'https://www.auvergne-rhone-alpes.ars.sante.fr/alertes-sanitaires-en-cours' },
  seismes_isere:         { statusId: 'seismes-svc-status',     infoId: 'seismes-svc-info',     url: 'https://www.franceseisme.fr' },
  avalanche_isere:       { statusId: 'avalanche-svc-status',   infoId: null,                   url: 'https://meteofrance.com/meteo-montagne' },
  feux_foret_isere:      { statusId: 'feux-svc-status',        infoId: null,                   url: 'https://effis.jrc.ec.europa.eu' },
  copernicus_ems:        { statusId: 'copernicus-svc-status',  infoId: null,                   url: 'https://www.gdacs.org' },
  cols_alpins_isere:     { statusId: 'cols-svc-status',        infoId: null,                   url: 'https://itinisere.fr/mod_turbolead/mod/inforoute/index.php?action=367&layer=Layer-repere_cols' },
  anfr_isere:            { statusId: 'anfr-status',            infoId: 'anfr-info',            url: 'https://www.data.gouv.fr/fr/datasets/donnees-sur-les-installations-radioelectriques-de-plus-de-5-watts-1/' },
  arcep_isere:           { statusId: 'arcep-status',           infoId: 'arcep-info',           url: 'https://www.data.gouv.fr/fr/datasets/sites-indisponibles/' },
  isere_opendata:        { statusId: 'opendata-status',        infoId: 'opendata-info',        url: 'https://opendata.isere.fr' },
  finess_isere:          { statusId: 'finess-status',          infoId: 'finess-info',          url: 'https://www.data.gouv.fr/datasets/finess-extraction-du-fichier-des-etablissements' },
  geodae_isere:          { statusId: 'geodae-status',          infoId: 'geodae-info',          url: 'https://www.data.gouv.fr/fr/datasets/geodae-base-nationale-des-defibrillateurs/' },
  ter_aura:              { statusId: 'ter-aura-status',        infoId: 'ter-aura-info',        url: 'https://www.ter.sncf.com/auvergne-rhone-alpes/se-deplacer/info-trafic' },
  mreseau:               { statusId: 'mreseau-status',         infoId: 'mreseau-info',         url: 'https://www.reso-m.fr/55-infotrafic.htm' },
  cars_region_aura:      { statusId: 'cars-region-status',     infoId: 'cars-region-info',     url: 'https://www.laregionvoustransporte.fr/fr/votre-region/infos-trafic' },
};

const SVC_CAT_COLORS = {
  'Eau':           '#0b4daa',
  'Météo':         '#3a7bd5',
  'Environnement': '#2e7d32',
  'Transport':     '#7b4f00',
  'Énergie':       '#c47a00',
  'Télécom':       '#5c2d91',
  'Actualités':    '#1a5276',
  'Risques':       '#922b21',
  'Données':       '#1565c0',
  'Santé':         '#1b6b3a',
};

/* Détail déplié pour chaque service (listes d'alertes / stations / etc.) */
const SVC_DETAIL_LISTS = {
  meteo_france:          [{ id: 'meteo-alerts-list',     label: 'Alertes météo' }],
  apic_isere:            [{ id: 'apic-list',             label: 'Alertes pluie intense' }],
  vigicrues:             [{ id: 'stations-list',         label: 'Stations' }, { id: 'troncons-list', label: 'Tronçons' }],
  vigicrues_flash_isere: [{ id: 'vigicrues-flash-list',  label: 'Alertes crues rapides' }],
  vigieau:               [{ id: 'vigieau-list',          label: 'Restrictions eau' }],
  autoroutes_isere:      [{ id: 'autoroutes-list',       label: 'Événements grands axes Isère' }],
  sncf_isere:            [{ id: 'sncf-alerts-list',      label: 'Alertes voie ferrée' }],
  prefecture_isere:      [{ id: 'prefecture-news-list',  label: 'Actualités', titleId: 'prefecture-news-title' }],
  fr_alert_isere:        [{ id: 'fr-alert-list',         label: 'Dernières FR-Alert Isère' }],
  dauphine_isere:        [{ id: 'dauphine-news-list',    label: 'Articles' }],
  france_bleu_isere:     [{ id: 'francebleu-news-list',  label: 'Articles France Bleu' }],
  anfr_isere:            [{ id: 'anfr-list',             label: 'Synthèse antennes' }],
  arcep_isere:           [{ id: 'arcep-list',            label: 'Indisponibilités' }],
  ter_aura:              [{ id: 'ter-aura-list',         label: 'Perturbations TER Isère' }],
  mreseau:               [{ id: 'mreseau-list',          label: 'Alertes M Réseau (trams · bus · cars)' }],
  cars_region_aura:      [{ id: 'cars-region-list',      label: 'Perturbations cars Région AURA' }],
  placegrenet:           [{ id: 'placegrenet-svc-list',  label: "Derniers articles Place Gre'net" }],
  grenoble_metro:        [{ id: 'grenoble-metro-svc-list', label: 'Actualités Grenoble Alpes Métropole' }],
  ars_aura:              [{ id: 'ars-aura-svc-list',     label: 'Alertes sanitaires ARS AURA' }],
  seismes_isere:         [{ id: 'seismes-svc-list',      label: 'Séismes récents Isère' }],
  avalanche_isere:       [{ id: 'avalanche-svc-list',    label: 'BRA — Risque avalanche massifs Isère' }],
  feux_foret_isere:      [{ id: 'feux-svc-list',         label: 'Foyers actifs EFFIS (24h)' }],
  copernicus_ems:        [{ id: 'copernicus-svc-list',   label: 'Catastrophes actives — GDACS' }],
  cols_alpins_isere:     [{ id: 'cols-svc-list',         label: 'État des cols alpins Isère' }],
};

function buildAutoroutesIsereService(data = {}) {
  const bison = data?.bison_fute || {};
  const aprr = data?.aprr_isere || {};
  const vinci = data?.vinci_autoroutes || {};
  const normalizeRoad = (value) => {
    const text = String(value || '').toUpperCase().replace(/\s+/g, '');
    if (AUTOROUTES_ISERE_ROAD_SET.has(text)) return text;
    const match = text.match(/A(480|49|48|51|43|41)/);
    return match ? `A${match[1]}` : '';
  };
  const inferRoad = (item) => {
    const direct = normalizeRoad(item?.road);
    if (direct) return direct;
    const blob = [
      item?.title,
      item?.description,
      item?.location_summary,
      item?.access,
    ].map((part) => String(part || '')).join(' ');
    const match = blob.match(AUTOROUTES_ISERE_ROAD_REGEX);
    return match ? `A${match[1]}` : '';
  };
  const isAutoroutesIsereEvent = (item) => {
    const road = inferRoad(item);
    if (!road) return false;
    const prPlaced = _resolveAutoroutePrPoint({ road, pr: item?.pr });
    if (prPlaced && isPointInIsere({ lat: prPlaced[0], lon: prPlaced[1] })) return true;
    const lat = Number(item?.lat);
    const lon = Number(item?.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return isPointInIsere({ lat, lon });
    return true;
  };
  const bisonLive = Array.isArray(bison?.live?.events) ? bison.live.events.filter(isAutoroutesIsereEvent) : [];
  const aprrEvents = Array.isArray(aprr?.events) ? aprr.events : [];
  const vinciEvents = Array.isArray(vinci?.events) ? vinci.events : [];
  const normalized = [];
  const dedupe = new Map();
  const pushEvents = (items, sourceLabel) => {
    items.forEach((item) => {
      const road = inferRoad(item);
      if (!road) return;
      const title = String(item?.title || '').trim();
      const pr = String(item?.pr || '').trim();
      const key = `${road}|${title}|${pr}|${String(item?.direction || '').trim()}|${String(item?.access || '').trim()}`;
      if (dedupe.has(key)) return;
      const normalizedItem = {
        ...item,
        source_label: sourceLabel,
        title: title || 'Événement trafic',
        road,
        pr,
        level: item?.level || item?.severity || 'jaune',
        severity: item?.severity || item?.level || 'jaune',
      };
      dedupe.set(key, normalizedItem);
      normalized.push(normalizedItem);
    });
  };
  pushEvents(aprrEvents, 'APRR/AREA');
  pushEvents(vinciEvents, 'Vinci');
  pushEvents(bisonLive, 'Bison Futé');

  normalized.sort((a, b) => {
    const rank = { rouge: 0, orange: 1, jaune: 2, vert: 3 };
    const ar = rank[String(a?.severity || a?.level || '').toLowerCase()] ?? 9;
    const br = rank[String(b?.severity || b?.level || '').toLowerCase()] ?? 9;
    if (ar !== br) return ar - br;
    return String(a?.road || '').localeCompare(String(b?.road || ''), 'fr');
  });

  const allRoutes = new Set([
    ...(Array.isArray(aprr?.routes) ? aprr.routes : []),
    ...(Array.isArray(vinci?.routes) ? vinci.routes : []),
    ...normalized.map((item) => String(item?.road || '').trim()).filter(Boolean),
  ]);
  const statuses = [bison?.status, aprr?.status, vinci?.status].map((v) => String(v || '').toLowerCase());
  const status = statuses.includes('online')
    ? 'online'
    : statuses.some((v) => v && v !== 'pending' && v !== 'idle') ? 'degraded' : 'pending';
  const isereDeparture = bison?.today?.isere?.departure || 'inconnu';
  const isereReturn = bison?.today?.isere?.return || 'inconnu';

  return {
    service: 'Autoroutes Isère',
    status,
    routes: Array.from(allRoutes).sort((a, b) => a.localeCompare(b, 'fr')),
    events: normalized,
    events_total: normalized.length,
    source: 'Bison Futé + APRR/AREA + Vinci Autoroutes',
    sources: [
      { label: 'Bison Futé', url: 'https://www.bison-fute.gouv.fr' },
      { label: 'APRR', url: 'https://voyage.aprr.fr/information-trafic' },
      { label: 'Vinci Autoroutes', url: 'https://www.vinci-autoroutes.com/fr/autoroutes-temps-reel/' },
    ],
    today: { isere: { departure: isereDeparture, return: isereReturn } },
    updated_at: aprr?.updated_at || vinci?.updated_at || bison?.updated_at || new Date().toISOString(),
  };
}

function getFluxPayload(key, data = {}) {
  if (key === 'autoroutes_isere') return buildAutoroutesIsereService(data);
  if (!data || typeof data !== 'object' || !(key in data)) {
  }
  return data?.[key] || {};
}

function isPendingServicePayload(payload = {}) {
  const status = String(payload?.status || '').toLowerCase();
  return status === 'pending' || status === 'idle';
}

async function _reloadExternalRiskViews(forceRefresh = false, bypassCache = forceRefresh) {
  const data = await api('/external/isere/risks', {
    bypassCache,
    cacheTtlMs: bypassCache ? 0 : API_CACHE_TTL_MS,
    timeoutMs: API_SLOW_ENDPOINT_TIMEOUT_MS,
  });
  markServerSnapshotFresh(data);
  cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, data);
  renderExternalRisks(cachedExternalRisksSnapshot);
  renderApiInterconnections(cachedExternalRisksSnapshot);
  saveSnapshot(STORAGE_KEYS.externalRisksSnapshot, cachedExternalRisksSnapshot);
  saveSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot, cachedExternalRisksSnapshot);
  if (isMapPanelActive()) await renderTrafficOnMap();
  return cachedExternalRisksSnapshot;
}

async function _requestServiceRefreshAndReload(serviceKey) {
  await api(`/external/isere/risks/${encodeURIComponent(serviceKey)}/refresh`, { method: 'POST' });
  const current = cachedExternalRisksSnapshot?.[serviceKey] || {};
  cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, {
    updated_at: new Date().toISOString(),
    [serviceKey]: {
      ...current,
      status: current.status || 'pending',
      meta: { ...(current.meta || {}), refreshing: true },
    },
  });
  renderExternalRisks(cachedExternalRisksSnapshot);
  renderApiInterconnections(cachedExternalRisksSnapshot);
  return cachedExternalRisksSnapshot;
}

function requestPriorityServicesForPanel(panelId) {
  if (!token) return;
  const services = PANEL_PRIORITY_SERVICES[panelId] || [];
  const now = Date.now();
  services.forEach((serviceKey) => {
    const lastAt = Number(serviceRefreshRequestState.get(serviceKey) || 0);
    if (now - lastAt < 30000) return;
    serviceRefreshRequestState.set(serviceKey, now);
    api(`/external/isere/risks/${encodeURIComponent(serviceKey)}/refresh`, {
      method: 'POST',
      bypassCache: true,
      cacheTtlMs: 0,
      timeoutMs: 5000,
      maxRetries: 0,
    }).catch(() => {});
  });
}

function refreshActivePanelData() {
  if (!token || document.hidden) return Promise.resolve();
  const panelId = localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel';
  requestPriorityServicesForPanel(panelId);
  if (panelId === 'logs-panel') return Promise.allSettled([loadEvents(null), loadLogs(null)]).then(() => undefined);
  if (panelId === 'municipalities-panel') return loadMunicipalities(null);
  if (panelId === 'users-panel' && canManageUsers()) return loadUsers(null);
  if (panelId === 'stations-panel') return loadAndRenderStationsPanel(false, { silent: true });
  if (panelId === 'water-panel') return loadAndRenderWaterPanel(false);
  if (panelId === 'contacts-panel') return loadAndRenderContactsPanel(getDefaultContactsPreloadCity(), false);
  if (panelId === 'api-panel') return loadApiInterconnections(false);
  if (panelId === 'map-panel') return refreshMapDataInBackground();
  if (panelId === 'situation-panel') return loadDashboard(false);
  return Promise.resolve();
}

function _clearPendingServiceAutoRefresh(serviceKey) {
  const state = pendingServiceAutoRefreshState.get(serviceKey);
  if (state?.timerId) window.clearTimeout(state.timerId);
  pendingServiceAutoRefreshState.delete(serviceKey);
}

function _queuePendingServiceAutoRefresh(serviceKey, payload = {}) {
  if (serviceKey !== 'cols_alpins_isere') return;
  if (!isPendingServicePayload(payload)) {
    _clearPendingServiceAutoRefresh(serviceKey);
    return;
  }

  const state = pendingServiceAutoRefreshState.get(serviceKey) || { inFlight: false, lastAttemptAt: 0, timerId: 0 };
  if (state.inFlight || state.timerId) return;

  const elapsedMs = state.lastAttemptAt > 0 ? (Date.now() - state.lastAttemptAt) : PENDING_SERVICE_AUTO_RETRY_MS;
  const waitMs = Math.max(0, PENDING_SERVICE_AUTO_RETRY_MS - elapsedMs);

  state.timerId = window.setTimeout(async () => {
    const liveState = pendingServiceAutoRefreshState.get(serviceKey) || state;
    liveState.timerId = 0;
    if (liveState.inFlight) return;

    liveState.inFlight = true;
    liveState.lastAttemptAt = Date.now();
    pendingServiceAutoRefreshState.set(serviceKey, liveState);

    try {
      const snapshot = await _requestServiceRefreshAndReload(serviceKey);
      const latestPayload = getFluxPayload(serviceKey, snapshot);
      if (isPendingServicePayload(latestPayload)) {
        liveState.inFlight = false;
        pendingServiceAutoRefreshState.set(serviceKey, liveState);
        _queuePendingServiceAutoRefresh(serviceKey, latestPayload);
        return;
      }
      _clearPendingServiceAutoRefresh(serviceKey);
    } catch (_) {
      liveState.inFlight = false;
      pendingServiceAutoRefreshState.set(serviceKey, liveState);
      _queuePendingServiceAutoRefresh(serviceKey, payload);
    }
  }, waitMs);

  pendingServiceAutoRefreshState.set(serviceKey, state);
}

function buildServiceCards() {
  const root = document.getElementById('svc-cards-root');
  if (!root || root.dataset.built) return;
  root.dataset.built = '1';

  const groups = new Map();
  for (const svc of FLUX_SERVICES) {
    if (!groups.has(svc.category)) groups.set(svc.category, []);
    groups.get(svc.category).push(svc);
  }

  let html = '';
  for (const [cat, svcs] of groups) {
    const color = SVC_CAT_COLORS[cat] || 'var(--primary)';
    const visibleSvcs = svcs.filter((s) => s.key !== 'groundwater_isere');
    if (!visibleSvcs.length) continue;
    html += `<div class="svc-cat-group"><div class="svc-cat-hd" style="--cat-color:${color}">`;
    html += `<span class="svc-cat-dot"></span><span class="svc-cat-label">${escapeHtml(cat)}</span>`;
    html += `<span class="svc-cat-count">${visibleSvcs.length}</span></div><div class="svc-cat-cards">`;
    for (const svc of visibleSvcs) {
      const meta     = SVC_CARD_META[svc.key] || {};
      const statusId = meta.statusId || '';
      const infoId   = meta.infoId || '';
      const url      = meta.url || '#';
      const lists    = SVC_DETAIL_LISTS[svc.key] || [];
      const hasDetail = lists.length > 0 || infoId;

      // Résumé compact toujours visible (summary)
      html += `<details class="svc-card" data-svc-key="${escapeHtml(svc.key)}">`;
      html += `<summary class="svc-card-summary">`;
      html += `<span class="svc-card-icon">${svc.icon}</span>`;
      html += `<div class="svc-card-body">`;
      html += `<h5 class="svc-card-title">${escapeHtml(svc.label)}</h5>`;
      if (statusId) html += `<p id="${escapeHtml(statusId)}" class="svc-card-status">–</p>`;
      html += `</div>`;
      if (hasDetail) html += `<span class="svc-chevron" aria-hidden="true"></span>`;
      html += `</summary>`;

      // Contenu déplié
      if (hasDetail) {
        html += `<div class="svc-card-detail">`;
        if (infoId) html += `<p id="${escapeHtml(infoId)}" class="svc-card-info muted">–</p>`;
        for (const lst of lists) {
          const titleAttr = lst.titleId ? ` id="${escapeHtml(lst.titleId)}"` : '';
          html += `<p class="svc-list-label"${titleAttr}>${escapeHtml(lst.label)}</p>`;
          html += `<ul id="${escapeHtml(lst.id)}" class="list svc-card-list"></ul>`;
        }
        html += `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer" class="svc-ext-link">Ouvrir le portail ↗</a>`;
        html += `</div>`;
      }
      html += `</details>`;
    }
    html += '</div></div>';
  }
  root.innerHTML = html;
}

function renderSvcSummaryBar(data = {}) {
  const bar = document.getElementById('svc-summary-bar');
  if (!bar) return;
  const counts = { online: 0, error: 0, stale: 0, pending: 0 };
  for (const svc of FLUX_SERVICES) {
    const { state } = _fluxServiceState(getFluxPayload(svc.key, data), svc.interval);
    counts[state] = (counts[state] || 0) + 1;
  }
  const pills = [];
  if (counts.online  > 0) pills.push(`<span class="svc-pill svc-pill--ok">${counts.online} actif${counts.online > 1 ? 's' : ''}</span>`);
  if (counts.stale   > 0) pills.push(`<span class="svc-pill svc-pill--stale">${counts.stale} obsolète${counts.stale > 1 ? 's' : ''}</span>`);
  if (counts.error   > 0) pills.push(`<span class="svc-pill svc-pill--error">${counts.error} erreur${counts.error > 1 ? 's' : ''}</span>`);
  if (counts.pending > 0) pills.push(`<span class="svc-pill svc-pill--pending">${counts.pending} en attente</span>`);
  pills.push(`<span class="svc-pill svc-pill--total">${FLUX_SERVICES.length} flux</span>`);
  bar.innerHTML = pills.join('');
}

function renderGroundwaterDetail(gw = {}) {
  const summary = document.getElementById('groundwater-summary');
  if (summary) {
    const trend = gw.trend_summary || {};
    const total = gw.stations_total ?? 0;
    const status = gw.status || 'inconnu';
    const statusClass = status === 'online' ? 'svc-gw-kpi--ok' : 'svc-gw-kpi--muted';
    summary.innerHTML = [
      `<span class="svc-gw-kpi"><strong>${total}</strong> station${total !== 1 ? 's' : ''}</span>`,
      `<span class="svc-gw-kpi svc-gw-kpi--up">↑ ${trend.hausse ?? 0} hausse</span>`,
      `<span class="svc-gw-kpi svc-gw-kpi--stable">= ${trend.stable ?? 0} stable</span>`,
      `<span class="svc-gw-kpi svc-gw-kpi--down">↓ ${trend.baisse ?? 0} baisse</span>`,
      `<span class="svc-gw-kpi ${statusClass}">${escapeHtml(status)}</span>`,
    ].join('');
  }

  const stationsEl = document.getElementById('groundwater-stations');
  if (!stationsEl) return;
  const stations = Array.isArray(gw.stations) ? gw.stations : [];
  if (!stations.length) {
    stationsEl.innerHTML = '<p class="muted" style="padding:.6rem 0">Aucune donnée de nappe phréatique disponible.</p>';
    return;
  }
  const trendIcon  = (t) => t === 'hausse' ? '↑' : t === 'baisse' ? '↓' : '=';
  const trendClass = (t) => t === 'hausse' ? 'svc-trend-up' : t === 'baisse' ? 'svc-trend-down' : 'svc-trend-stable';
  const rows = stations.slice(0, 24).map((s) => {
    const level = s.groundwater_level_m_ngf != null ? `${Number(s.groundwater_level_m_ngf).toFixed(2)} m NGF` : '–';
    const depth = s.depth_m != null ? `–${Number(s.depth_m).toFixed(1)} m` : '–';
    const date  = s.date_measure ? new Date(s.date_measure).toLocaleDateString('fr-FR') : '–';
    const trend = s.trend || 'stable';
    return `<tr>
      <td class="svc-gw-td-code">${escapeHtml(s.code_bss || '–')}</td>
      <td>${escapeHtml(s.name || '–')}</td>
      <td class="svc-gw-td-muted">${escapeHtml(s.commune || '–')}</td>
      <td class="svc-gw-td-num">${escapeHtml(level)}</td>
      <td class="svc-gw-td-num">${escapeHtml(depth)}</td>
      <td><span class="${trendClass(trend)}">${trendIcon(trend)} ${escapeHtml(trend)}</span></td>
      <td class="svc-gw-td-muted">${escapeHtml(date)}</td>
    </tr>`;
  }).join('');
  stationsEl.innerHTML = `<div class="svc-gw-table-wrap"><table class="svc-gw-table">
    <thead><tr>
      <th>Code BSS</th><th>Station</th><th>Commune</th>
      <th>Niveau NGF</th><th>Profondeur</th><th>Tendance</th><th>Mesure</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/* ── Nouveaux flux transport ─────────────────────────────────────────────── */

function _fmtDate(raw) {
  if (!raw) return '';
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return String(raw).substring(0, 30);
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return String(raw).substring(0, 30); }
}

function _renderDisruptionsList(listId, items, emptyMsg = 'Aucune perturbation signalée.') {
  const lvlColor = { rouge: '#c22f43', orange: '#b46a00', jaune: '#9a7700', vert: '#2f9e44', inconnu: '#5f7190' };
  const lvlLabel = { rouge: '🔴 Critique', orange: '🟠 Important', jaune: '🟡 Info', vert: '🟢 Normal', inconnu: 'ℹ️ Info' };
  setHtml(listId, items.slice(0, 10).map((d) => {
    const level = d.level || d.effect || 'inconnu';
    const color = lvlColor[level] || lvlColor.inconnu;
    const badge = lvlLabel[level] || level;

    // Ligne / axe impacté
    const lineStr = d.road
      ? `<strong>${escapeHtml(d.road)}</strong>`
      : d.line ? `<strong>${escapeHtml(d.line)}</strong>` : '';
    const routesStr = Array.isArray(d.routes) && d.routes.length
      ? `Lignes : ${d.routes.slice(0, 4).map(escapeHtml).join(', ')}`
      : '';
    const lineHtml = lineStr || routesStr
      ? `<span style="font-size:.8rem;color:#333"> · ${lineStr || routesStr}</span>` : '';

    // Dates de validité
    const fromStr = _fmtDate(d.valid_from);
    const untilStr = _fmtDate(d.valid_until);
    const dateHtml = fromStr || untilStr
      ? `<br><span style="font-size:.76rem;color:#666">🕒 ${fromStr && untilStr ? `Du ${escapeHtml(fromStr)} au ${escapeHtml(untilStr)}` : fromStr ? `Depuis le ${escapeHtml(fromStr)}` : `Jusqu'au ${escapeHtml(untilStr)}`}</span>`
      : '';

    // Titre + description
    const title = (d.title || '').substring(0, 200);
    const desc = (d.description || '').substring(0, 450);
    const bodyHtml = title && desc && desc.toLowerCase() !== title.toLowerCase()
      ? `<strong style="font-size:.85rem">${escapeHtml(title)}</strong><br><span style="font-size:.79rem;color:#444">${escapeHtml(desc)}</span>`
      : `<span style="font-size:.85rem">${escapeHtml(title || desc || 'Perturbation')}</span>`;

    return `<li style="border-left:3px solid ${color};padding-left:.6rem;margin-bottom:.5rem;padding-top:.1rem">
      <span style="font-size:.78rem;font-weight:600;color:${color}">${badge}</span>${lineHtml}${dateHtml}<br>
      ${bodyHtml}
    </li>`;
  }).join('') || `<li class="muted">${emptyMsg}</li>`);
}

function _renderEventsList(listId, items, emptyMsg = 'Aucun événement signalé.') {
  const typeIcon = { accident: '⚠️', travaux: '🔧', chantier: '🔧', perturbation: '⚡', bouchon: '🚗', inconnu: 'ℹ️', pannevehicule: '🚘', panne: '🚘' };
  const lvlColor = { rouge: '#c22f43', orange: '#b46a00', jaune: '#9a7700', vert: '#2f9e44', inconnu: '#5f7190' };
  const lvlLabel = { rouge: '🔴 Critique', orange: '🟠 Important', jaune: '🟡 Info', vert: '🟢 Normal', inconnu: 'ℹ️ Info' };
  setHtml(listId, items.slice(0, 12).map((e) => {
    const typeKey = (e.type || '').toLowerCase().replace(/\s+/g, '').replace(/[-_]/g, '');
    const icon = typeIcon[typeKey] || (typeKey.includes('panne') ? '🚘' : typeKey.includes('accident') ? '⚠️' : typeKey.includes('travaux') || typeKey.includes('chantier') ? '🔧' : 'ℹ️');
    const level = e.level || e.severity || 'jaune';
    const color = lvlColor[level] || lvlColor.jaune;
    const badge = lvlLabel[level] || level;
    const road = e.road ? `<strong>${escapeHtml(e.road)}</strong>` : '';
    const sourceLabel = e.source_label ? ` · ${escapeHtml(e.source_label)}` : '';

    // Date de fin
    const endStr = e.end ? ` · jusqu'au <em>${escapeHtml(e.end)}</em>` : '';
    const startStr = e.start ? ` · depuis ${_fmtDate(e.start)}` : '';

    // Titre + description
    const title = (e.title || '').substring(0, 200);
    const desc = (e.description || '').substring(0, 400);
    const bodyHtml = title && desc && desc.toLowerCase() !== title.toLowerCase()
      ? `<strong style="font-size:.84rem">${escapeHtml(title)}</strong><br><span style="font-size:.79rem;color:#444">${escapeHtml(desc)}</span>`
      : `<span style="font-size:.84rem">${escapeHtml(title || desc || 'Événement')}</span>`;

    return `<li style="border-left:3px solid ${color};padding-left:.6rem;margin-bottom:.5rem">
      <span style="font-size:.78rem;font-weight:600;color:${color}">${badge}</span> ${icon}${road ? ' · ' + road : ''}${sourceLabel}${endStr}${startStr}<br>
      ${bodyHtml}
    </li>`;
  }).join('') || `<li class="muted">${emptyMsg}</li>`);
}

function _renderMreseauList(listId, items) {
  const lvlColor = { rouge: '#c22f43', orange: '#b46a00', jaune: '#9a7700', vert: '#2f9e44', inconnu: '#5f7190' };
  const modeIcon = { Tram: '🚊', 'Bus/Car': '🚌' };
  setHtml(listId, items.slice(0, 20).map((d) => {
    const level = d.level || 'inconnu';
    const color = lvlColor[level] || lvlColor.inconnu;
    const line = d.line ? `<strong style="color:${color}">${escapeHtml(d.line)}</strong>` : '';
    const icon = modeIcon[d.mode] || '🚌';
    const until = d.valid_until ? ` · jusqu'au <em>${escapeHtml(d.valid_until)}</em>` : '';
    const from = d.valid_from ? ` · dès le ${escapeHtml(d.valid_from)}` : '';
    return `<li>${icon} ${line ? line + ' · ' : ''}<span style="font-size:.9em">${escapeHtml(d.description || d.title || '–').substring(0, 220)}</span>${from}${until}</li>`;
  }).join('') || '<li class="muted">Trafic M Réseau normal — aucune alerte en cours.</li>');
}

function renderTransportFlux(data = {}) {
  // TER SNCF AURA
  const ter = data?.ter_aura || {};
  const terDisruptions = ter.disruptions || [];
  setRiskText('ter-aura-status',
    `${ter.status || 'inconnu'} · ${terDisruptions.length} perturbation(s)`,
    terDisruptions.length > 0 ? 'orange' : (ter.status === 'online' ? 'vert' : 'jaune'),
  );
  setText('ter-aura-info', ter.status === 'online'
    ? (terDisruptions.length === 0 ? 'Trafic TER normal sur Isère' : `${terDisruptions.length} perturbation(s) détectée(s)`)
    : (ter.error ? ter.error.substring(0, 80) : 'Données non disponibles'));
  _renderDisruptionsList('ter-aura-list', terDisruptions, 'Trafic TER normal pour l\'Isère.');

  // M Réseau (trams + bus + cars agglomération grenobloise)
  const mreseau = data?.mreseau || {};
  const mreseauDisruptions = mreseau.disruptions || [];
  const mreseauTrams = (mreseau.lines_tram || ['A','B','C','D','E']).join(' · ');
  const mreseauNormal = mreseau.normal_service !== false && mreseauDisruptions.length === 0;
  setRiskText('mreseau-status',
    mreseauNormal
      ? `online · Trafic normal · Trams ${mreseauTrams}`
      : `${mreseau.status || 'inconnu'} · ${mreseauDisruptions.length} perturbation(s)`,
    mreseauDisruptions.length > 0 ? 'orange' : (mreseau.status === 'online' ? 'vert' : 'jaune'),
  );
  setText('mreseau-info', mreseauNormal
    ? `Trams A·B·C·D·E + bus normaux · source reso-m.fr`
    : (mreseauDisruptions.length > 0
        ? `${mreseauDisruptions.length} alerte(s) en cours · ${mreseau.source ? new URL(mreseau.source).hostname : 'reso-m.fr'}`
        : (mreseau.error ? mreseau.error.substring(0, 80) : 'Données non disponibles')));
  _renderMreseauList('mreseau-list', mreseauDisruptions);

  // Service agrégé autoroutes Isère
  const autoroutes = buildAutoroutesIsereService(data);
  const autorouteEvents = Array.isArray(autoroutes.events) ? autoroutes.events : [];
  const bisonDeparture = autoroutes?.today?.isere?.departure || 'inconnu';
  const bisonReturn = autoroutes?.today?.isere?.return || 'inconnu';
  setRiskText('autoroutes-status',
    `${autoroutes.status || 'inconnu'} · ${autorouteEvents.length} événement(s) · ${(autoroutes.routes || []).join(' ')}`,
    autorouteEvents.length > 0 ? 'orange' : (autoroutes.status === 'online' ? 'vert' : 'jaune'),
  );
  setText('autoroutes-info',
    autoroutes.status === 'online'
      ? `Bison départ/retour Isère: ${bisonDeparture} / ${bisonReturn} · ${autorouteEvents.length} événement(s) grands axes`
      : 'Données autoroutes non disponibles'
  );
  _renderEventsList(
    'autoroutes-list',
    autorouteEvents.map((item) => ({
      ...item,
      title: item?.source_label ? `${item.source_label} · ${item.title || 'Événement trafic'}` : item?.title,
    })),
    'Trafic autoroutier fluide sur les grands axes isérois.',
  );


  // Cars Région AURA
  const cars = data?.cars_region_aura || {};
  const carsDisruptions = cars.disruptions || [];
  setRiskText('cars-region-status',
    `${cars.status || 'inconnu'} · ${carsDisruptions.length} perturbation(s)`,
    carsDisruptions.length > 0 ? 'orange' : (cars.status === 'online' ? 'vert' : 'jaune'),
  );
  setText('cars-region-info', cars.status === 'online'
    ? (carsDisruptions.length === 0 ? 'Service Cars Région normal sur Isère' : `${carsDisruptions.length} perturbation(s)`)
    : (cars.error ? cars.error.substring(0, 80) : 'Données non disponibles'));
  _renderDisruptionsList('cars-region-list', carsDisruptions, 'Service Cars Région normal sur Isère.');
}

function renderExternalRisks(data = {}) {
  const mergedData = mergeExternalRisksSnapshot(
    cachedExternalRisksSnapshot,
    data && typeof data === 'object' ? data : {},
  );
  const signature = createPayloadSignature(mergedData, ['updated_at', 'fetched_at', 'retrieved_at']);
  if (signature === lastRenderedExternalRisksSignature) return false;

  lastRenderedExternalRisksSignature = signature;
  cachedExternalRisksSnapshot = mergedData;
  const meteo = mergedData?.meteo_france || {};
  const vigicrues = mergedData?.vigicrues || {};
  cachedVigicruesPayload = {
    stations: Array.isArray(vigicrues.stations) ? vigicrues.stations : [],
    troncons: Array.isArray(vigicrues.troncons) ? vigicrues.troncons : [],
  };
  const itinisere = mergedData?.itinisere || {};
  const bisonFute = mergedData?.bison_fute || {};
  const prefecture = mergedData?.prefecture_isere || {};
  const frAlert = mergedData?.fr_alert_isere || {};
  const dauphine = mergedData?.dauphine_isere || {};
  const franceBleu = mergedData?.france_bleu_isere || {};
  const sncf = mergedData?.sncf_isere || {};
  const vigieau = mergedData?.vigieau || {};
  const rnb = mergedData?.rnb_isere || {};
  const atmo = mergedData?.atmo_aura || {};
  const anfr = mergedData?.anfr_isere || {};
  const arcep = mergedData?.arcep_isere || {};
  const apic = mergedData?.apic_isere || {};
  const vigicruesFlash = mergedData?.vigicrues_flash_isere || {};
  const georisquesPayload = mergedData?.georisques || {};
  const georisques = georisquesPayload?.data && typeof georisquesPayload.data === 'object'
    ? { ...georisquesPayload.data, ...georisquesPayload }
    : georisquesPayload;
  const placegrenet = mergedData?.placegrenet || {};
  const grenobleMétropole = mergedData?.grenoble_metro || {};
  const arsAura = mergedData?.ars_aura || {};
  const seismesIsere = mergedData?.seismes_isere || {};
  const avalancheIsere = mergedData?.avalanche_isere || {};
  const feuxForet = mergedData?.feux_foret_isere || {};
  const colsAlpins = mergedData?.cols_alpins_isere || {};
  _queuePendingServiceAutoRefresh('cols_alpins_isere', colsAlpins);

  const meteoDisplayLevel = isPendingServicePayload(meteo) ? 'gris' : (meteo.level || 'gris');
  const vigicruesDisplayLevel = isPendingServicePayload(vigicrues) ? 'gris' : (vigicrues.water_alert_level || 'gris');
  setRiskText('meteo-status', `${meteo.status || 'inconnu'} · niveau ${normalizeLevel(meteoDisplayLevel)}`, meteoDisplayLevel);
  setText('meteo-info', sanitizeMeteoInformation(meteo.info_state) || meteo.bulletin_title || '');
  setRiskText('vigicrues-status', `${vigicrues.status || 'inconnu'} · niveau ${normalizeLevel(vigicruesDisplayLevel)}`, vigicruesDisplayLevel);
  setText('vigicrues-info', `${(vigicrues.stations || []).length} station(s) suivie(s) · ${(vigicrues.troncons || []).length} tronçon(s)`);
  setHtml('stations-list', (vigicrues.stations || []).slice(0, 10).map((s) => {
    const statusLevel = stationStatusLevel(s);
    return `<li>${s.station || s.code} · ${s.river || ''} · <span style="color:${levelColor(statusLevel)}">${statusLevel}</span> · Contrôle: ${escapeHtml(s.control_status || 'inconnu')} · ${s.height_m} m</li>`;
  }).join('') || '<li>Aucune station disponible.</li>');
  setHtml('troncons-list', (vigicrues.troncons || []).map((troncon) => {
    const level = normalizeLevel(troncon.level || 'inconnu');
    const stationsCount = Array.isArray(troncon.stations) ? troncon.stations.length : 0;
    return `<li><strong>${escapeHtml(troncon.name || troncon.code || 'Tronçon')}</strong> · <span style="color:${levelColor(level)}">${escapeHtml(level)}</span> · ${stationsCount} station(s)</li>`;
  }).join('') || '<li>Aucun tronçon disponible.</li>');
  const itinisereEvents = itinisere.events || [];
  const itinisereTotal = Number(itinisere.events_total ?? itinisereEvents.length);
  setText('itinisere-status', `${itinisere.status || 'inconnu'} · ${itinisereTotal} événements`);
  renderBisonFuteSummary(bisonFute);
  renderPrefectureNews(prefecture);
  renderFrAlertIsere(frAlert);
  renderDauphineNews(dauphine);
  renderFranceBleuNews(franceBleu);
  renderPlacegrenetNews(placegrenet);
  renderGrenobleMetroNews(grenobleMétropole);
  renderArsAuraAlerts(arsAura);
  renderSeismesIsere(seismesIsere);
  renderAvalancheIsere(avalancheIsere);
  renderFeuxForetWidget(feuxForet);
  renderCopernicusEmsWidget(mergedData?.copernicus_ems || {});
  renderOfficialColsAlpinsWidget(colsAlpins);
  // Redessiner les couches lourdes uniquement si la carte est visible.
  if (isMapPanelActive()) {
    renderColsAlpinsLayer();
    applyAvalancheZoneLayer();
    renderSeismesLayer();
    renderFeuxForetLayer();
  }
  renderNewsPanel(prefecture, dauphine, franceBleu, placegrenet, grenobleMétropole, arsAura, seismesIsere);
  renderSncfAlerts(sncf);
  renderApicAlerts(apic);
  renderVigicruesFlashAlerts(vigicruesFlash);
  renderVigieauAlerts(vigieau);
  const atmoToday = atmo?.today || {};
  const atmoLevel = normalizeLevel(atmoToday.level || 'inconnu');
  const atmoLabelRaw = String(atmoToday.label || atmoLevel || 'inconnu').toLowerCase();
  const atmoLabel = keepLastKnownStatus('atmo_label', atmoLabelRaw);
  const atmoIndex = keepLastKnownStatus('atmo_index', atmoToday.index ?? '-');
  setRiskText('atmo-status', `${atmo.status || 'inconnu'} · indice ${atmoIndex}`, atmoToday.level || 'vert');
  setText('atmo-info', `${atmoToday.date || 'date inconnue'} · niveau ${atmoLabel}${atmo.has_pollution_episode ? ' · épisode en cours' : ''}`);
  setRiskText('anfr-status', `${anfr.status || 'inconnu'} · ${anfr.supports_total ?? 0} support(s)`, anfr.status === 'online' ? 'vert' : 'jaune');
  setText('anfr-info', `${anfr.stations_total ?? 0} station(s) · hauteur moyenne ${anfr.average_support_height_m ?? '-'} m`);
  setHtml('anfr-list', [
    `<li><strong>Publication:</strong> ${escapeHtml(anfr.data_release || '-')}</li>`,
    `<li><strong>Supports recensés:</strong> ${Number(anfr.supports_total ?? 0)}</li>`,
    `<li><strong>Stations ANFR:</strong> ${Number(anfr.stations_total ?? 0)}</li>`,
  ].join(''));
  const arcepLevel = normalizeLevel(arcep.level || (Number(arcep.outages_total ?? 0) > 0 ? 'jaune' : 'vert'));
  setRiskText('arcep-status', `${arcep.status || 'inconnu'} · ${arcep.outages_total ?? 0} indisponibilité(s)`, arcepLevel);
  setText('arcep-info', `${arcep.communes_total ?? 0} commune(s) · voix HS ${arcep.voice_impacted_total ?? 0} · data HS ${arcep.data_impacted_total ?? 0}`);
  setHtml('arcep-list', (arcep.top_operators || []).map((item) => `<li><strong>${escapeHtml(item.operator || 'Opérateur')}</strong> · ${Number(item.outages ?? 0)} site(s)</li>`).join('') || '<li>Aucune indisponibilité signalée en Isère.</li>');
  setRiskText('georisques-status', `${georisques.status || 'inconnu'} · sismicité ${georisques.highest_seismic_zone_label || 'inconnue'}`, georisques.status === 'online' ? 'vert' : 'jaune');
  setText('georisques-info', `${georisques.flood_documents_total ?? 0} AZI · ${georisques.ppr_total ?? 0} PPR · ${georisques.ground_movements_total ?? 0} mouvements`);
  setRiskText('rnb-status', `${rnb.status || 'inconnu'} · ${rnb.buildings_total ?? 0} bâtiment(s)`, rnb.status === 'online' ? 'vert' : 'jaune');
  setText('rnb-info', `${rnb.coverage_note || 'Référentiel national des bâtiments'}${rnb.error ? ` · ${rnb.error}` : ''}`);
  renderGeorisquesDetails(georisques);
  renderMeteoAlerts(meteo);
  renderWeeklyWeatherPanel(mergedData).catch(() => {});
  renderItinisereEvents(itinisereEvents);
  setText('meteo-level', normalizeLevel(isPendingServicePayload(meteo) ? 'gris' : (meteo.level || 'gris')));
  setText('meteo-hazards', (meteo.hazards || []).join(', ') || 'non précisé');
  setText('river-level', normalizeLevel(isPendingServicePayload(vigicrues) ? 'gris' : (vigicrues.water_alert_level || 'gris')));
  const itinisereInsights = itinisere.insights || {};
  const topRoads = (itinisereInsights.top_roads || []).map((item) => `${item.road} (${item.count})`).join(', ');
  const severityBreakdown = itinisereInsights.severity_breakdown || {};
  const preciseLocations = itinisereEvents.filter((event) => Array.isArray(event.locations) && event.locations.length).length;
  setText('map-itinisere-category', itinisereInsights.dominant_category || 'inconnue');
  setText('map-itinisere-roads', topRoads || 'non renseigné');
  setText('map-itinisere-severity', `R${severityBreakdown.rouge || 0} / O${severityBreakdown.orange || 0} / J${severityBreakdown.jaune || 0} / V${severityBreakdown.vert || 0}`);
  setText('map-itinisere-precision', `${preciseLocations}/${itinisereEvents.length || 0} avec lieu identifié`);
  setText('map-seismic-level', georisques.highest_seismic_zone_label || 'inconnue');
  setText('map-flood-docs', String(georisques.flood_documents_total ?? 0));
  renderStations(cachedVigicruesPayload);
  renderSituationOverview();
  renderSvcSummaryBar(mergedData);
  renderGroundwaterDetail(mergedData?.groundwater_isere || {});
  renderTransportFlux(mergedData);
  return true;
}

async function loadExternalRisks(forceRefresh = false) {
  const cached = readSnapshot(STORAGE_KEYS.externalRisksSnapshot);
  if (cached) {
    cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, cached);
    renderExternalRisks(cachedExternalRisksSnapshot);
    renderTrafficOnMap().catch(() => {});
  }

  const data = await api('/external/isere/risks', {
    bypassCache: forceRefresh,
    cacheTtlMs: forceRefresh ? 0 : API_CACHE_TTL_MS,
    timeoutMs: API_SLOW_ENDPOINT_TIMEOUT_MS,
  });
  cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, data);
  renderExternalRisks(cachedExternalRisksSnapshot);
  saveSnapshot(STORAGE_KEYS.externalRisksSnapshot, cachedExternalRisksSnapshot);
  if (isMapPanelActive()) await renderTrafficOnMap();
}

function _fluxServiceState(payload, intervalSec) {
  const status = String(payload?.status || 'pending');
  const updatedAt = payload?.updated_at ? new Date(payload.updated_at).getTime() : 0;
  const ageMs = updatedAt > 0 ? (Date.now() - updatedAt) : Infinity;
  if (payload?.meta?.refreshing) return { state: 'pending', updatedAt, ageMs };
  if (status === 'pending' || status === 'idle') return { state: 'pending', updatedAt, ageMs };
  if (status === 'stale' || status === 'partial') return { state: 'stale', updatedAt, ageMs };
  if (status !== 'online' || payload?.error) return { state: 'error', updatedAt, ageMs };
  if (ageMs > intervalSec * 1000 * 2.5) return { state: 'stale', updatedAt, ageMs };
  return { state: 'online', updatedAt, ageMs };
}

function _fluxAgeLabel(ageMs, intervalSec, state) {
  if (state === 'pending') return { text: 'en attente', css: 'unknown' };
  if (!Number.isFinite(ageMs)) return { text: '–', css: 'unknown' };
  const ageSec = ageMs / 1000;
  const text = formatElapsedSince(new Date(Date.now() - ageMs).toISOString());
  const css = ageSec < intervalSec ? 'fresh' : ageSec < intervalSec * 2.5 ? 'slow' : 'stale';
  return { text, css };
}

function _fluxNextLabel(updatedAt, intervalSec, state) {
  if (state === 'pending') return `↻ toutes les ${_formatInterval(intervalSec)}`;
  if (updatedAt > 0 && state === 'online') {
    const nextMs = (intervalSec * 1000) - (Date.now() - updatedAt);
    if (nextMs > 0) return `↻ dans ${_formatInterval(Math.ceil(nextMs / 1000))}`;
    return '↻ en cours...';
  }
  return `↻ toutes les ${_formatInterval(intervalSec)}`;
}

function _formatInterval(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

function renderApiInterconnections(data = {}) {
  const signature = createPayloadSignature(data, ['updated_at', 'fetched_at', 'retrieved_at']);
  if (signature === lastRenderedApiInterconnectionsSignature) return false;
  lastRenderedApiInterconnectionsSignature = signature;
  _queuePendingServiceAutoRefresh('cols_alpins_isere', getFluxPayload('cols_alpins_isere', data));

  // Compute state for every service
  const now = Date.now();
  const rows = FLUX_SERVICES.map((svc) => {
    const payload = getFluxPayload(svc.key, data);
    const { state, updatedAt, ageMs } = _fluxServiceState(payload, svc.interval);
    return { svc, payload, state, updatedAt, ageMs };
  });

  // Summary counts
  const counts = { online: 0, error: 0, stale: 0, pending: 0 };
  rows.forEach((r) => counts[r.state]++);

  // Summary bar HTML
  const summaryParts = [
    `<span class="flux-stat ok">● ${counts.online} actif${counts.online > 1 ? 's' : ''} / ${rows.length}</span>`,
    counts.error > 0 ? `<span class="flux-stat error">⚠ ${counts.error} erreur${counts.error > 1 ? 's' : ''}</span>` : '',
    counts.stale > 0 ? `<span class="flux-stat stale">⏱ ${counts.stale} périmé${counts.stale > 1 ? 's' : ''}</span>` : '',
    counts.pending > 0 ? `<span class="flux-stat pending">⋯ ${counts.pending} en attente</span>` : '',
    `<span class="flux-stat clock" id="flux-resync-ago">↻ ${formatElapsedSince(lastApiResyncAt)}</span>`,
  ];
  setHtml('flux-summary', summaryParts.filter(Boolean).join(''));

  // Filter button counts
  document.querySelectorAll('.flux-filter-btn').forEach((btn) => {
    const f = btn.dataset.filter;
    const labels = { all: 'Tous', online: 'Actifs', error: 'Erreurs', stale: 'Lents' };
    const c = f === 'all' ? rows.length : f === 'stale' ? counts.stale + counts.pending : (counts[f] ?? 0);
    btn.textContent = `${labels[f] || f}${c > 0 && f !== 'all' ? ` (${c})` : ''}`;
  });

  // Sort: errors first, stale second, then online sorted by oldest update, pending last
  const ORDER = { error: 0, stale: 1, online: 2, pending: 3 };
  const sorted = [...rows].sort((a, b) => {
    if (ORDER[a.state] !== ORDER[b.state]) return ORDER[a.state] - ORDER[b.state];
    return b.ageMs - a.ageMs;
  });

  // Filter
  const filtered = sorted.filter((r) => {
    if (_currentFluxFilter === 'all') return true;
    if (_currentFluxFilter === 'online') return r.state === 'online';
    if (_currentFluxFilter === 'error') return r.state === 'error';
    if (_currentFluxFilter === 'stale') return r.state === 'stale' || r.state === 'pending';
    return true;
  });

  // Render rows
  const listHtml = filtered.map(({ svc, payload, state, updatedAt, ageMs }) => {
    const hasKnownPayload = payload?.updated_at || payload?.meta?.last_success_at;
    const metric = state === 'pending' && !hasKnownPayload
      ? 'Chargement des données...'
      : (() => { try { return svc.metric(payload); } catch (_) { return '–'; } })();
    const { text: ageText, css: ageCss } = _fluxAgeLabel(ageMs, svc.interval, state);
    const nextText = _fluxNextLabel(updatedAt, svc.interval, state);
    const errorText = payload.error
      ? payload.error
      : (state === 'stale' ? 'Données périmées — le service externe répond lentement' : '');
    const sourceCandidates = [payload.source_data, payload.source, payload.source_reseaux, payload.dataset_url, payload.source_url, payload.link];
    const sourceUrl = sourceCandidates.find((u) => String(u || '').startsWith('http'));
    const sourceLink = sourceUrl
      ? `<a class="flux-source-link" href="${escapeHtml(String(sourceUrl))}" target="_blank" rel="noreferrer noopener">Source officielle ↗</a>`
      : '';

    const canForceRefresh = svc.key !== 'autoroutes_isere';
    return `<div class="flux-row status-${state}" data-key="${escapeHtml(svc.key)}">
      <div class="flux-dot ${state}"></div>
      <div class="flux-row-main">
        <div class="flux-row-title"><span class="flux-icon">${escapeHtml(svc.icon)}</span>${escapeHtml(svc.label)}<span class="flux-row-category">${escapeHtml(svc.category)}</span>${state === 'pending' ? '<span class="flux-loading-label">en cours</span>' : ''}</div>
        <div class="flux-row-metric">${escapeHtml(metric)}</div>
        ${errorText ? `<div class="flux-row-error">⚠ ${escapeHtml(errorText)}</div>` : ''}
        ${sourceLink ? `<div class="flux-row-source">${sourceLink}</div>` : ''}
      </div>
      <div class="flux-row-meta">
        <span class="flux-age ${ageCss}" data-updated-at="${updatedAt || ''}" data-interval="${svc.interval}">${escapeHtml(ageText)}</span>
        <span class="flux-interval">${escapeHtml(nextText)}</span>
        ${canForceRefresh
          ? `<button class="flux-force-btn" data-action="force-refresh-service" data-service-key="${escapeHtml(svc.key)}" title="Forcer l'actualisation maintenant">⟳</button>`
          : '<span class="flux-force-btn" style="opacity:.35;cursor:default" title="Service agrégé">⟳</span>'}
      </div>
    </div>`;
  }).join('');

  setHtml('flux-service-list', listHtml || '<p class="muted" style="padding:.6rem">Aucun service dans ce filtre.</p>');

  // Raw JSON (collapsed)
  const rawBlocks = FLUX_SERVICES.map((svc) => {
    const payload = getFluxPayload(svc.key, data);
    return `<details class="api-raw-item"><summary>${escapeHtml(svc.icon)} ${escapeHtml(svc.label)}</summary><pre>${formatApiJson(payload)}</pre></details>`;
  }).join('');
  setHtml('api-raw-list', rawBlocks);

  lastApiResyncAt = data.updated_at || new Date().toISOString();
  renderApiResyncClock();
  return true;
}

async function loadApiInterconnections(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = readSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot);
    if (cached) {
      cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, cached);
      renderApiInterconnections(cachedExternalRisksSnapshot);
    }
  }
  const data = await api('/external/isere/risks', { timeoutMs: API_SLOW_ENDPOINT_TIMEOUT_MS });
  cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, data);
  renderApiInterconnections(cachedExternalRisksSnapshot);
  saveSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot, cachedExternalRisksSnapshot);
}

async function loadSystemHealth() {
  const summary = document.getElementById('system-health-summary');
  const list = document.getElementById('system-health-list');
  if (summary) summary.textContent = 'Chargement de l’état des flux...';
  try {
    const data = await api('/external/isere/risks/status', { cacheTtlMs: 15000 });
    const services = Array.isArray(data?.services) ? data.services : [];
    const errorCount = services.filter((svc) => ['error', 'unavailable'].includes(String(svc.status || '').toLowerCase())).length;
    const staleCount = services.filter((svc) => String(svc.status || '').toLowerCase() === 'stale').length;
    const pausedCount = services.filter((svc) => svc?.meta?.circuit_open).length;
    const refreshingCount = services.filter((svc) => svc?.meta?.refreshing).length;
    const snapshotKb = Number(data?.snapshot_size_bytes || 0) ? `${Math.round(Number(data.snapshot_size_bytes) / 1024)} Ko` : '-';
    if (summary) summary.textContent = `${services.length} flux · ${refreshingCount} en cours · ${staleCount} dernière valeur connue · ${errorCount} erreur · ${pausedCount} suspendu(s) · SSE ${Number(data?.sse_clients || 0)} · snapshot ${snapshotKb}`;
    const rows = services.slice().sort((a, b) => {
      const ar = (a?.meta?.circuit_open ? 100000 : 0) + Number(a?.meta?.failure_count || 0) * 1000 + Number(a?.meta?.last_duration_ms || 0);
      const br = (b?.meta?.circuit_open ? 100000 : 0) + Number(b?.meta?.failure_count || 0) * 1000 + Number(b?.meta?.last_duration_ms || 0);
      return br - ar;
    }).slice(0, 8);
    if (list) {
      list.innerHTML = rows.map((svc) => {
        const meta = svc.meta || {};
        const status = escapeHtml(String(svc.status || 'unknown'));
        const duration = meta.last_duration_ms != null ? `${Number(meta.last_duration_ms)} ms` : '-';
        const retry = meta.next_retry_at ? ` · prochain essai ${formatElapsedSince(meta.next_retry_at)}` : '';
        const paused = meta.circuit_open ? ' · suspendu temporairement' : '';
        return `<div class="system-health-row status-${status}">
          <strong>${escapeHtml(svc.key || '?')}</strong>
          <span>${status} · ${duration} · échecs ${Number(meta.failure_count || 0)}${paused}${retry}</span>
        </div>`;
      }).join('') || '<p class="muted">Aucun flux à signaler.</p>';
    }
  } catch (error) {
    if (summary) summary.textContent = `Santé système indisponible: ${sanitizeErrorMessage(error.message)}`;
  }
}

function renderMunicipalitiesList(municipalities = []) {
  // ── Summary bar ────────────────────────────────────────────
  const totalAll = cachedMunicipalityRecords.length;
  const crisisCount = cachedMunicipalityRecords.filter((m) => m.crisis_mode).length;
  const pcsCount = cachedMunicipalityRecords.filter((m) => m.pcs_active).length;
  const summaryBar = document.getElementById('municipalities-summary-bar');
  if (summaryBar && totalAll > 0) {
    summaryBar.hidden = false;
    summaryBar.classList.remove('hidden');
    summaryBar.innerHTML = `
      <span class="muni-summary-pill total">🏘️ ${totalAll} commune${totalAll > 1 ? 's' : ''}</span>
      ${crisisCount > 0 ? `<span class="muni-summary-pill crisis">🔴 ${crisisCount} en crise</span>` : ''}
      <span class="muni-summary-pill pcs">✅ ${pcsCount} PCS actif${pcsCount > 1 ? 's' : ''}</span>
      ${totalAll - crisisCount > 0 ? `<span class="muni-summary-pill veille">🟡 ${totalAll - crisisCount} en veille</span>` : ''}
    `;
  } else if (summaryBar) {
    summaryBar.hidden = true;
    summaryBar.classList.add('hidden');
  }

  // ── Cards ──────────────────────────────────────────────────
  const municipalitiesMarkup = municipalities.map((m) => {
    const level = normalizeLevel(m.vigilance_color || 'vert');
    const badgeClass = level === 'rouge' ? 'red' : level === 'orange' ? 'orange' : level === 'jaune' ? 'yellow' : 'green';

    const crisisBanner = m.crisis_mode
      ? `<div class="muni-crisis-banner">Mode crise activé</div>`
      : '';

    const astreintePhone = (() => {
      const contactBlob = String(m.contacts || '');
      const match = contactBlob.match(/(?:\+33\s?[1-9]|0[1-9])(?:[\s.:-]?\d{2}){4}/);
      return match ? match[0].trim() : '';
    })();
    const quickPhone = astreintePhone || String(m.phone || '').trim();
    const quickPhoneLabel = astreintePhone ? `Astreinte ${astreintePhone}` : String(m.phone || '').trim();
    const phoneHref = quickPhone ? `<a class="muni-contact-btn" href="tel:${encodeURIComponent(quickPhone.replace(/\s/g,''))}">📞 ${escapeHtml(quickPhoneLabel)}</a>` : '';
    const emailHref = m.email ? `<a class="muni-contact-btn" href="mailto:${encodeURIComponent(m.email)}">✉️ ${escapeHtml(m.email)}</a>` : '';

    const pills = `<div class="muni-pills">
      <span class="muni-pill ${m.pcs_active ? 'pcs-on' : 'pcs-off'}">${m.pcs_active ? '✅ PCS actif' : '⬜ PCS inactif'}</span>
      ${m.population ? `<span class="muni-pill pop">👥 ${Number(m.population).toLocaleString('fr-FR')}</span>` : ''}
      ${m.shelter_capacity ? `<span class="muni-pill shelter">🏠 ${Number(m.shelter_capacity).toLocaleString('fr-FR')} places</span>` : ''}
    </div>`;

    const additionalInfo = m.additional_info
      ? `<p class="muted" style="font-size:.82rem;margin:.4rem 0 0;">${escapeHtml(m.additional_info)}</p>`
      : '';

    const actions = canEdit()
      ? `<div class="municipality-actions">
           <button type="button" class="ghost inline-action" data-muni-view="${m.id}">Voir la fiche</button>
           <button type="button" class="ghost inline-action" data-muni-edit="${m.id}">Éditer</button>
           <button type="button" class="ghost inline-action${m.crisis_mode ? ' danger' : ''}" data-muni-crisis="${m.id}">${m.crisis_mode ? '🔴 Sortir de crise' : '⚠️ Passer en crise'}</button>
           <button type="button" class="ghost inline-action danger" data-muni-delete="${m.id}">Supprimer</button>
         </div>`
      : canMunicipalityFiles()
        ? `<div class="municipality-actions"><button type="button" class="ghost inline-action" data-muni-view="${m.id}">Voir la fiche</button></div>`
        : `<div class="municipality-actions"><button type="button" class="ghost inline-action" data-muni-view="${m.id}">Voir la fiche</button></div>`;

    return `<article class="municipality-card municipality-card--${level}" data-muni-id="${m.id}">
      ${crisisBanner}
      <header>
        <h4 style="font-size:.97rem">${escapeHtml(m.postal_code ? `${m.postal_code} · ` : '')}${escapeHtml(m.name)}</h4>
        <span class="badge ${badgeClass}">${level}</span>
      </header>
      <div class="muni-quick-contact" style="margin-top:.5rem">
        ${phoneHref}${emailHref}
      </div>
      ${pills}
      ${additionalInfo}
      ${actions}
    </article>`;
  }).join('') || '<p class="muted">Aucune commune.</p>';

  setText('municipalities-count', String(municipalities.length));
  setHtml('municipalities-list', municipalitiesMarkup);
}

function applyMunicipalityFilters() {
  const search = String(document.getElementById('municipalities-search')?.value || '').trim().toLowerCase();
  const statusFilter = String(document.getElementById('municipalities-status-filter')?.value || 'all');
  const sort = String(document.getElementById('municipalities-sort')?.value || 'name_asc');

  let filtered = [...cachedMunicipalityRecords];

  if (statusFilter === 'crisis') filtered = filtered.filter((item) => Boolean(item.crisis_mode));
  if (statusFilter === 'watch') filtered = filtered.filter((item) => !item.crisis_mode);

  if (search) {
    filtered = filtered.filter((item) => [
      item.name,
      item.phone,
      item.email,
      item.postal_code,
      item.contacts,
      item.additional_info,
    ].map((value) => String(value || '').toLowerCase()).join(' ').includes(search));
  }

  filtered.sort((a, b) => {
    if (sort === 'risk_desc') return riskRank(b.vigilance_color) - riskRank(a.vigilance_color);
    if (sort === 'population_desc') return Number(b.population || 0) - Number(a.population || 0);
    return String(a.name || '').localeCompare(String(b.name || ''), 'fr');
  });

  renderMunicipalitiesList(filtered);
}

async function loadMunicipalities(preloaded = null) {
  const previousMunicipalities = Array.isArray(cachedMunicipalityRecords) ? cachedMunicipalityRecords : [];
  let municipalities = [];
  if (Array.isArray(preloaded)) {
    municipalities = keepPreviousArray(previousMunicipalities, preloaded);
  } else {
    try {
      const payload = await api('/municipalities');
      municipalities = keepPreviousArray(previousMunicipalities, payload);
    } catch (error) {
      municipalities = previousMunicipalities.length ? previousMunicipalities : [];
      setMapFeedback(`Liste des communes indisponible via API (${municipalities.length} en mémoire).`, true);
    }
  }

  cachedMunicipalityRecords = municipalities;
  cachedMunicipalities = municipalities;
  populateUserMunicipalityOptions();
  renderContactsCitySuggestions();
  const georisquesPayload = cachedExternalRisksSnapshot?.georisques || {};
  const georisquesData = georisquesPayload?.data && typeof georisquesPayload.data === 'object'
    ? { ...georisquesPayload.data, ...georisquesPayload }
    : georisquesPayload;
  renderGeorisquesPcsRisks(georisquesData.monitored_communes || georisquesData.monitored_municipalities || georisquesData.communes || []);
  populateLogMunicipalityOptions(municipalities);
  syncLogScopeFields();
  syncLogOtherFields();
  applyMunicipalityFilters();
  await renderMunicipalitiesOnMap(municipalities);
}

function computeLogCriticality(level) {
  return riskRank(level);
}

function buildLogTableRow(log = {}) {
  const level = normalizeLevel(log.danger_level || 'vert');
  const emoji = log.danger_emoji || LOG_LEVEL_EMOJI[level] || '🟢';
  const logTimestamp = log.event_time || log.created_at;
  const timeAbsolute = formatMcoTimestamp(logTimestamp, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  const timeRel = timeAgo(logTimestamp);

  const municipality = log.municipality_id ? escapeHtml(getMunicipalityName(log.municipality_id)) : '';
  const scope = formatLogScope(log);
  const scopeLabel = municipality ? `${scope} · ${municipality}` : scope;

  const metaChips = [
    log.location ? `<span class="mco-meta-chip">📍 ${escapeHtml(log.location)}</span>` : '',
    log.source ? `<span class="mco-meta-chip">🗣️ ${escapeHtml(log.source)}</span>` : '',
    log.assigned_to ? `<span class="mco-meta-chip">👤 ${escapeHtml(log.assigned_to)}</span>` : '',
    log.next_update_due ? `<span class="mco-meta-chip">⏱️ MAJ ${safeDateToLocale(log.next_update_due, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>` : '',
  ].filter(Boolean).join('');

  const actionsBtns = canEdit()
    ? `<button type="button" class="mco-entry-btn" data-log-edit="${log.id}">Modifier</button>
       <button type="button" class="mco-entry-btn danger" data-log-delete="${log.id}">Supprimer</button>`
    : '';

  return `<div class="mco-entry mco-entry--${level}">
    <div class="mco-entry-head">
      <span class="mco-entry-emoji">${emoji}</span>
      <span class="mco-entry-time-rel">${escapeHtml(timeRel || timeAbsolute)}</span>
      <span class="mco-entry-time-abs">${timeRel ? escapeHtml(timeAbsolute) : ''}</span>
      <span class="mco-entry-scope">${escapeHtml(scopeLabel)}</span>
    </div>
    ${log.description ? `<div class="mco-entry-desc">${escapeHtml(log.description)}</div>` : ''}
    ${metaChips ? `<div class="mco-entry-meta">${metaChips}</div>` : ''}
    ${log.actions_taken ? `<div class="mco-entry-actions-text">${escapeHtml(log.actions_taken)}</div>` : ''}
    ${actionsBtns ? `<div class="mco-entry-btns">${actionsBtns}</div>` : ''}
  </div>`;
}

function generateMcoEventPdf() {
  const event = getSelectedOperationalEvent();
  if (!event) return;

  const logs = [...cachedLogs]
    .filter((log) => String(log.event_id || '') === String(event.id))
    .sort((a, b) => parseMcoTimestamp(a.event_time || a.created_at).getTime() - parseMcoTimestamp(b.event_time || b.created_at).getTime());

  const isClosed = String(event.status || '').toLowerCase() === 'clos';
  const locality = event.municipality_id ? getMunicipalityName(event.municipality_id) : 'Départemental';
  const worstLevel = logs.reduce((max, log) => riskRank(log.danger_level) > riskRank(max) ? (log.danger_level || 'vert') : max, 'vert');
  const levelNorm = normalizeLevel(worstLevel);
  const levelEmoji = LOG_LEVEL_EMOJI[levelNorm] || '🟢';
  const levelColors = { rouge: '#c92a2a', orange: '#e67700', jaune: '#e9a800', vert: '#2b8a3e' };
  const levelBg = { rouge: '#fff5f5', orange: '#fff8f0', jaune: '#fffde7', vert: '#f0fff4' };
  const levelColor = levelColors[levelNorm] || '#2b8a3e';
  const levelBgColor = levelBg[levelNorm] || '#f0fff4';

  const created = event.created_at ? formatMcoTimestamp(event.created_at, { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const exportedAt = new Date().toLocaleString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const durationMs = logs.length >= 2
    ? parseMcoTimestamp(logs[logs.length - 1].event_time || logs[logs.length - 1].created_at).getTime() - parseMcoTimestamp(logs[0].event_time || logs[0].created_at).getTime()
    : null;
  const durationText = durationMs !== null ? (() => {
    const h = Math.floor(durationMs / 3600000);
    const m = Math.floor((durationMs % 3600000) / 60000);
    return h > 0 ? `${h}h${m.toString().padStart(2, '0')}` : `${m} min`;
  })() : '—';

  const entryDotColor = { rouge: '#c92a2a', orange: '#e67700', jaune: '#e9a800', vert: '#2b8a3e' };

  const timelineRows = logs.map((log, idx) => {
    const level = normalizeLevel(log.danger_level || 'vert');
    const emoji = log.danger_emoji || LOG_LEVEL_EMOJI[level] || '🟢';
    const dotColor = entryDotColor[level] || '#2b8a3e';
    const timeStr = formatMcoTimestamp(log.event_time || log.created_at, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    const scope = formatLogScope(log);
    const municipality = log.municipality_id ? getMunicipalityName(log.municipality_id) : '';
    const scopeLabel = municipality ? `${scope} · ${escapeHtml(municipality)}` : scope;
    const isLast = idx === logs.length - 1;
    return `
      <div class="tl-row">
        <div class="tl-time">${escapeHtml(timeStr)}</div>
        <div class="tl-spine">
          <div class="tl-dot" style="background:${dotColor};box-shadow:0 0 0 3px ${dotColor}22;"></div>
          ${isLast ? '' : '<div class="tl-line"></div>'}
        </div>
        <div class="tl-card" style="border-left:3px solid ${dotColor};">
          <div class="tl-card-head">
            <span class="tl-emoji">${emoji}</span>
            <span class="tl-level" style="color:${dotColor}">${escapeHtml(levelNorm.toUpperCase())}</span>
            <span class="tl-scope">${escapeHtml(scopeLabel)}</span>
          </div>
          ${log.description ? `<div class="tl-desc">${escapeHtml(log.description)}</div>` : ''}
          ${log.actions_taken ? `<div class="tl-actions"><strong>↳ Actions :</strong> ${escapeHtml(log.actions_taken)}</div>` : ''}
          <div class="tl-meta">
            ${log.location ? `<span>📍 ${escapeHtml(log.location)}</span>` : ''}
            ${log.source ? `<span>🗣️ ${escapeHtml(log.source)}</span>` : ''}
            ${log.assigned_to ? `<span>👤 ${escapeHtml(log.assigned_to)}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Rapport MCO — ${escapeHtml(event.title || 'Évènement')}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11pt; color: #1a1a2e; background: #fff; }
  @page { size: A4; margin: 18mm 15mm 18mm 15mm; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display: none !important; } }

  /* ── Cover ── */
  .cover { border-radius: 10px; background: linear-gradient(135deg, #0f2240 0%, #1a3568 60%, #1565c0 100%); color: #fff; padding: 28px 32px 22px; margin-bottom: 24px; position: relative; overflow: hidden; }
  .cover::after { content: ''; position: absolute; top: -30px; right: -30px; width: 160px; height: 160px; border-radius: 50%; background: rgba(255,255,255,.06); }
  .cover-logo { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; font-size: 10pt; opacity: .8; letter-spacing: .05em; text-transform: uppercase; }
  .cover-logo-pc { width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(145deg,#1a3568,#0f2240); border: 2px solid rgba(255,255,255,.4); display: flex; align-items: center; justify-content: center; }
  .cover-logo-pc::after { content: '▲'; color: #f07800; font-size: 12px; line-height: 1; }
  .cover-title { font-size: 19pt; font-weight: 700; line-height: 1.25; margin-bottom: 6px; }
  .cover-addr { font-size: 10.5pt; opacity: .85; margin-bottom: 14px; }
  .cover-badges { display: flex; gap: 8px; flex-wrap: wrap; }
  .cover-badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 9pt; font-weight: 600; }
  .cover-badge--level { background: ${levelColor}; color: #fff; }
  .cover-badge--status { background: ${isClosed ? '#495057' : '#2b8a3e'}; color: #fff; }
  .cover-badge--loc { background: rgba(255,255,255,.18); color: #fff; border: 1px solid rgba(255,255,255,.3); }

  /* ── Info grid ── */
  .info-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 22px; }
  .info-box { border: 1px solid #e9ecef; border-radius: 7px; padding: 10px 14px; }
  .info-box-label { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; color: #868e96; margin-bottom: 3px; }
  .info-box-value { font-size: 11pt; font-weight: 600; color: #1a1a2e; }

  /* ── Section header ── */
  .section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .section-head-line { flex: 1; height: 1px; background: #dee2e6; }
  .section-head-title { font-size: 10pt; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #495057; white-space: nowrap; }

  /* ── Timeline ── */
  .timeline { }
  .tl-row { display: grid; grid-template-columns: 72px 28px 1fr; gap: 0 10px; margin-bottom: 0; }
  .tl-time { font-size: 8.5pt; color: #868e96; padding-top: 2px; text-align: right; line-height: 1.3; }
  .tl-spine { display: flex; flex-direction: column; align-items: center; }
  .tl-dot { width: 13px; height: 13px; border-radius: 50%; flex-shrink: 0; margin-top: 2px; }
  .tl-line { width: 2px; background: #dee2e6; flex: 1; min-height: 12px; margin-top: 2px; }
  .tl-card { background: #f8f9fa; border-radius: 6px; padding: 8px 11px 9px; margin-bottom: 10px; }
  .tl-card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
  .tl-emoji { font-size: 12pt; }
  .tl-level { font-size: 8pt; font-weight: 700; letter-spacing: .05em; }
  .tl-scope { font-size: 8.5pt; color: #868e96; margin-left: auto; }
  .tl-desc { font-size: 10pt; color: #1a1a2e; line-height: 1.5; margin-bottom: 5px; }
  .tl-actions { font-size: 9.5pt; color: #495057; background: #e9ecef; border-radius: 4px; padding: 4px 8px; margin-bottom: 5px; line-height: 1.4; }
  .tl-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 8.5pt; color: #868e96; }

  /* ── Footer ── */
  .pdf-footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #dee2e6; display: flex; justify-content: space-between; font-size: 8.5pt; color: #adb5bd; }

  /* ── Print button ── */
  .print-btn { position: fixed; bottom: 24px; right: 24px; background: #1a3568; color: #fff; border: none; border-radius: 8px; padding: 12px 22px; font-size: 12pt; font-weight: 600; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
  .print-btn:hover { background: #0f2240; }
</style>
</head>
<body>

<button class="print-btn no-print" onclick="window.print()">🖨️ Imprimer / Sauvegarder PDF</button>

<div class="cover">
  <div class="cover-logo">
    <div class="cover-logo-pc"></div>
    Protection Civile — Rapport opérationnel
  </div>
  <div class="cover-title">${escapeHtml(event.title || 'Évènement')}</div>
  <div class="cover-addr">${escapeHtml(event.address || 'Adresse non renseignée')}</div>
  <div class="cover-badges">
    <span class="cover-badge cover-badge--level">${levelEmoji} Niveau ${escapeHtml(levelNorm)}</span>
    <span class="cover-badge cover-badge--status">${isClosed ? '🔒 Clôturé' : '🟢 En cours'}</span>
    <span class="cover-badge cover-badge--loc">📍 ${escapeHtml(locality)}</span>
  </div>
</div>

<div class="info-grid">
  <div class="info-box">
    <div class="info-box-label">Ouverture</div>
    <div class="info-box-value">${escapeHtml(created)}</div>
  </div>
  <div class="info-box">
    <div class="info-box-label">Entrées MCO</div>
    <div class="info-box-value">${logs.length} entrée${logs.length !== 1 ? 's' : ''}</div>
  </div>
  <div class="info-box">
    <div class="info-box-label">Durée enregistrée</div>
    <div class="info-box-value">${escapeHtml(durationText)}</div>
  </div>
</div>

<div class="section-head">
  <span class="section-head-title">Chronologie des entrées</span>
  <div class="section-head-line"></div>
</div>

<div class="timeline">
  ${timelineRows || '<p style="color:#868e96;font-size:10pt;padding:8px 0">Aucune entrée enregistrée pour cet évènement.</p>'}
</div>

<div class="pdf-footer">
  <span>Rapport généré le ${escapeHtml(exportedAt)}</span>
  <span>OPE-PROTEC · Main Courante Opérationnelle</span>
</div>

</body>
</html>`;

  const win = window.open('', '_blank', 'width=900,height=750');
  if (!win) { alert('Veuillez autoriser les popups pour générer le rapport PDF.'); return; }
  win.document.write(html);
  win.document.close();
}

function renderLogsList() {
  let filtered = [...cachedLogs];
  if (selectedOperationalEventId) {
    filtered = filtered.filter((log) => String(log.event_id || '') === String(selectedOperationalEventId));
  } else {
    filtered = [];
  }

  filtered.sort((a, b) => parseMcoTimestamp(b.event_time || b.created_at).getTime() - parseMcoTimestamp(a.event_time || a.created_at).getTime());

  setText('logs-count', String(filtered.length));
  setHtml('logs-table-stream', filtered.map((log) => buildLogTableRow(log)).join('')
    || '<p class="muted" style="font-size:.88rem;padding:.4rem .2rem;text-align:center">Aucune entrée MCO pour cet évènement. Ajoutez la première ci-dessous.</p>');
}

async function loadLogs(preloaded = null) {
  const previousLogs = Array.isArray(cachedLogs) ? cachedLogs : [];
  const logs = Array.isArray(preloaded) ? preloaded : await api('/logs');
  cachedLogs = keepPreviousArray(previousLogs, logs);
  saveSnapshot(STORAGE_KEYS.logsSnapshot, cachedLogs);
  renderLogsList();
  renderSituationOverview();
  updateEventDetailPanel();
}

async function loadEvents(preloaded = null) {
  const previousEvents = Array.isArray(cachedEvents) ? cachedEvents : [];
  const events = Array.isArray(preloaded) ? preloaded : await api('/events');
  cachedEvents = keepPreviousArray(previousEvents, events);
  saveSnapshot(STORAGE_KEYS.eventsSnapshot, cachedEvents);
  populateEventOptions(cachedEvents);
  if (selectedOperationalEventId && !getSelectedOperationalEvent()) {
    selectedOperationalEventId = null;
  }
  if (!selectedOperationalEventId) {
    const firstOpen = sortOperationalEvents(cachedEvents).find((event) => String(event.status || '').toLowerCase() !== 'clos');
    if (firstOpen) selectedOperationalEventId = String(firstOpen.id);
  }
  renderEventsList();
  updateEventDetailPanel();
  renderLogsList();
  updateMenuEventsBadge();
}

function refreshMcoViews() {
  populateEventOptions(cachedEvents);
  renderEventsList();
  updateEventDetailPanel();
  renderLogsList();
  renderSituationOverview();
  updateMenuEventsBadge();
}

function upsertCachedEvent(event) {
  if (!event || event.id == null) return;
  const id = String(event.id);
  const existing = Array.isArray(cachedEvents) ? cachedEvents : [];
  const index = existing.findIndex((item) => String(item.id) === id);
  cachedEvents = index >= 0
    ? existing.map((item, itemIndex) => itemIndex === index ? { ...item, ...event } : item)
    : [event, ...existing];
  cachedEvents = sortOperationalEvents(cachedEvents).slice(0, 300);
  saveSnapshot(STORAGE_KEYS.eventsSnapshot, cachedEvents);
  refreshMcoViews();
}

function removeCachedEvent(eventId) {
  const id = String(eventId || '');
  cachedEvents = (Array.isArray(cachedEvents) ? cachedEvents : [])
    .filter((event) => String(event.id) !== id);
  cachedLogs = (Array.isArray(cachedLogs) ? cachedLogs : [])
    .filter((log) => String(log.event_id || '') !== id);
  saveSnapshot(STORAGE_KEYS.eventsSnapshot, cachedEvents);
  saveSnapshot(STORAGE_KEYS.logsSnapshot, cachedLogs);
  refreshMcoViews();
}

function upsertCachedLog(log) {
  if (!log || log.id == null) return;
  const id = String(log.id);
  const existing = Array.isArray(cachedLogs) ? cachedLogs : [];
  const index = existing.findIndex((item) => String(item.id) === id);
  cachedLogs = index >= 0
    ? existing.map((item, itemIndex) => itemIndex === index ? { ...item, ...log } : item)
    : [log, ...existing];
  cachedLogs = cachedLogs
    .sort((a, b) => parseMcoTimestamp(b.created_at || b.event_time).getTime() - parseMcoTimestamp(a.created_at || a.event_time).getTime())
    .slice(0, 200);
  saveSnapshot(STORAGE_KEYS.logsSnapshot, cachedLogs);
  refreshMcoViews();
}

function removeCachedLog(logId) {
  const id = String(logId || '');
  cachedLogs = (Array.isArray(cachedLogs) ? cachedLogs : [])
    .filter((log) => String(log.id) !== id);
  saveSnapshot(STORAGE_KEYS.logsSnapshot, cachedLogs);
  refreshMcoViews();
}

async function exportLogsCsv() {
  const response = await queueApiRequest(() => fetchWithTimeout('/logs/export/csv', { headers: { Authorization: `Bearer ${token}` } }));
  if (!response.ok) throw new Error(`Export impossible (${response.status})`);
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `main-courante-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  link.click();
  window.URL.revokeObjectURL(url);
}

async function loadUsers(preloaded = null) {
  if (!canManageUsers()) return;
  const usersSnapshot = readSnapshot(STORAGE_KEYS.usersSnapshot);
  const users = keepPreviousArray(
    Array.isArray(usersSnapshot) ? usersSnapshot : [],
    Array.isArray(preloaded) ? preloaded : await api('/auth/users', { bypassCache: true, cacheTtlMs: 0 }),
  );
  saveSnapshot(STORAGE_KEYS.usersSnapshot, users);
  const isAdmin = currentUser?.role === 'admin';
  const formatUserDateTime = (value) => {
    if (!value) return 'Jamais';
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? String(value) : dt.toLocaleString('fr-FR');
  };
  setHtml('users-table', users.map((u) => {
    const source = u.auth_source === 'ldap' ? '<span class="badge neutral">LDAP</span>' : '<span class="badge neutral">Local</span>';
    const resetButton = u.auth_source === 'ldap'
      ? '<button type="button" disabled title="Mot de passe gere dans LDAP">Mot de passe LDAP</button>'
      : `<button type="button" data-user-reset="${u.id}">Reinitialiser mot de passe</button>`;
    const actionButtons = isAdmin
      ? `<div class="users-actions"><button type="button" data-user-edit="${u.id}">Modifier</button>${resetButton}<button type="button" class="ghost" data-user-delete="${u.id}">Supprimer</button></div>`
      : '-';
    return `<tr><td>${escapeHtml(u.username)}</td><td>${source}</td><td>${roleLabel(u.role)}</td><td>${escapeHtml(u.municipality_name || '-')}</td><td>${new Date(u.created_at).toLocaleDateString()}</td><td>${escapeHtml(formatUserDateTime(u.last_access_at || u.last_login_at))}</td><td>${u.must_change_password ? 'Changement requis' : 'Actif'}</td><td>${actionButtons}</td></tr>`;
  }).join('') || '<tr><td colspan="8">Aucun utilisateur.</td></tr>');
}

function renderLdapBindPasswordStatus(status) {
  const node = document.getElementById('ldap-bind-password-status');
  if (!node) return;
  const sourceLabels = {
    application: 'application',
    environment: 'variable d environnement',
    none: 'aucune source',
  };
  const source = sourceLabels[status?.source] || status?.source || 'inconnue';
  node.textContent = status?.configured
    ? `Mot de passe LDAP configure (${source}).`
    : 'Aucun mot de passe LDAP configure.';
}

async function loadLdapBindPasswordStatus() {
  if (currentUser?.role !== 'admin') return;
  try {
    renderLdapBindPasswordStatus(await api('/auth/ldap/bind-password', { bypassCache: true, cacheTtlMs: 0 }));
  } catch (error) {
    const node = document.getElementById('ldap-bind-password-status');
    if (node) node.textContent = sanitizeErrorMessage(error.message);
  }
}

async function loadOperationsBootstrap(forceRefresh = false) {
  const payload = await api('/operations/bootstrap', {
    bypassCache: forceRefresh,
    cacheTtlMs: forceRefresh ? 0 : 5000,
    timeoutMs: API_SLOW_ENDPOINT_TIMEOUT_MS,
    maxRetries: 0,
  });
  if (!payload || typeof payload !== 'object') throw new Error('Réponse bootstrap invalide');
  markServerSnapshotFresh(payload);

  if (payload.dashboard) {
    renderDashboard(payload.dashboard);
    saveSnapshot(STORAGE_KEYS.dashboardSnapshot, payload.dashboard);
  }
  if (payload.external_risks) {
    renderExternalRisks(payload.external_risks);
    renderApiInterconnections(payload.external_risks);
    saveSnapshot(STORAGE_KEYS.externalRisksSnapshot, payload.external_risks);
    saveSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot, payload.external_risks);
  }

  await loadMunicipalities(payload.municipalities || []);
  await loadEvents(payload.events || null);
  await loadLogs(payload.logs || []);
  if (canManageUsers()) await loadUsers(payload.users || []);
  if (currentUser?.role === 'admin') await loadLdapBindPasswordStatus();

  const perf = payload.perf || {};
  const duration = Number(perf.backend_duration_ms || 0);
  const countM = Number(perf.municipality_count || (payload.municipalities || []).length || 0);
  const countL = Number(perf.log_count || (payload.logs || []).length || 0);
  const risksSync = payload?.external_risks?.refresh?.in_progress ? ' · flux externes en synchronisation' : '';
  setText('operations-perf', `Perf: ${duration} ms · ${countM} communes · ${countL} événements${risksSync}`);
  return payload;
}

function getDefaultContactsPreloadCity() {
  if (currentUser?.role === 'mairie' && currentUser?.municipality_name) return currentUser.municipality_name;
  if (selectedContactsCity) return selectedContactsCity;
  const municipality = (Array.isArray(cachedMunicipalities) ? cachedMunicipalities : [])
    .find((item) => String(item?.name || '').trim());
  return municipality?.name || 'Grenoble';
}

function ensureWaterPreloadMunicipality() {
  const municipalities = renderWaterMunicipalitySelector();
  if (selectedWaterMunicipalityId) return selectedWaterMunicipalityId;
  const preferredName = currentUser?.municipality_name ? String(currentUser.municipality_name).trim().toLowerCase() : '';
  const preferred = preferredName
    ? municipalities.find((item) => String(item?.name || '').trim().toLowerCase() === preferredName)
    : null;
  const fallback = preferred || municipalities[0];
  if (fallback?.id != null) {
    selectedWaterMunicipalityId = String(fallback.id);
    const select = document.getElementById('water-municipality-select');
    if (select) select.value = selectedWaterMunicipalityId;
  }
  return selectedWaterMunicipalityId;
}

async function preloadAllPanelData(forceRefresh = false) {
  const jobs = [];
  if (ensureWaterPreloadMunicipality()) jobs.push(loadAndRenderWaterPanel(forceRefresh));
  const contactsCity = getDefaultContactsPreloadCity();
  if (contactsCity) jobs.push(loadAndRenderContactsPanel(contactsCity, forceRefresh));
  jobs.push(renderWeeklyWeatherPanel(cachedExternalRisksSnapshot || {}));

  const results = await Promise.allSettled(jobs);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    console.warn('Prechargement partiel des pages', failures.map((item) => item.reason));
  }
}

async function refreshMapDataInBackground() {
  if (!(isMapPanelActive() || leafletMap)) return;
  try {
    await ensureMapReady();
    await Promise.allSettled([
      loadMapPoints(),
      loadMapAnnotations(),
      renderTrafficOnMap(),
    ]);
  } catch (error) {
    setMapFeedback(`Carte mise Ã  jour partiellement: ${sanitizeErrorMessage(error.message)}`, true);
  }
}

function requestExternalRisksBackgroundRefresh() {
  // Les flux externes sont orchestrés côté backend et poussés par SSE.
  // Le navigateur ne déclenche plus de refresh global pour éviter les tempêtes réseau.
  return Promise.resolve();
}

async function refreshAll(forceRefresh = false) {
  if (refreshAllInFlight) return refreshAllInFlight;

  refreshAllInFlight = withPreservedScroll(async () => {
    // Phase visible : relire vite le snapshot applicatif. Les couches carte et
    // les flux externes forcés continuent en arrière-plan pour garder l'UI fluide.
    startStartupQueue(2);
    const activePanelId = localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel';
    setPanelLoading(activePanelId, true, forceRefresh ? 'Actualisation en cours...' : 'Mise à jour des données...');
    setServerSnapshotSyncing(true, forceRefresh ? 'Synchronisation demandée…' : 'Lecture du snapshot serveur…');
    if (forceRefresh) requestExternalRisksBackgroundRefresh();

    // Effacer toute erreur résiduelle du cycle précédent dès le début.
    // Sans ce reset, une erreur ponctuelle reste affichée pour toujours même si les
    // refreshs suivants réussissent.
    const errorTarget = document.getElementById('dashboard-error');
    if (errorTarget) errorTarget.textContent = '';

    let bootstrapError = null;
    let fallbackFailedCount = 0;

    setStartupQueueCurrent('Lecture du snapshot serveur…');
    try {
      const bsData = await loadOperationsBootstrap(false);

      // — dashboard —
      if (bsData?.dashboard) {
        renderDashboard(bsData.dashboard);
        saveSnapshot(STORAGE_KEYS.dashboardSnapshot, bsData.dashboard);
      }
      // — risques externes —
      if (bsData?.external_risks) {
        cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, bsData.external_risks);
        renderExternalRisks(cachedExternalRisksSnapshot);
        saveSnapshot(STORAGE_KEYS.externalRisksSnapshot, cachedExternalRisksSnapshot);
        renderApiInterconnections(cachedExternalRisksSnapshot);
      }
      // — données opérationnelles (support preloaded) —
      await Promise.all([
        loadMunicipalities(Array.isArray(bsData?.municipalities) ? bsData.municipalities : null),
        loadEvents(Array.isArray(bsData?.events) ? bsData.events : null),
        loadLogs(Array.isArray(bsData?.logs) ? bsData.logs : null),
        loadUsers(Array.isArray(bsData?.users) ? bsData.users : null),
      ]);
    } catch (err) {
      bootstrapError = err;
      // Fallback : appels individuels si le bootstrap échoue.
      // Compter les échecs : si tous réussissent, l'UI est complète → pas d'erreur à afficher.
      const fallbackResults = await Promise.allSettled([
        loadDashboard(false),
        Promise.resolve(),
        loadMunicipalities(null),
        loadEvents(null),
        loadLogs(null),
        loadUsers(null),
      ]);
      fallbackFailedCount = fallbackResults.filter((r) => r.status === 'rejected').length;
    }
    advanceStartupQueue('données initiales');

    refreshMapDataInBackground();

    renderResources();
    advanceStartupQueue('pages applicatives');
    _ensureStaticDataLoaded();

    // N'afficher "Chargement dégradé" que si le fallback a aussi échoué (≥3 sources en erreur).
    // Si le bootstrap échoue mais que les fallbacks individuels passent, l'UI est complète
    // et il n'y a rien à signaler à l'utilisateur.
    if (bootstrapError && fallbackFailedCount >= 3) {
      if (errorTarget) errorTarget.textContent = `Chargement dégradé: ${sanitizeErrorMessage(bootstrapError.message)}`;
    }

    _serverSnapshotSyncing = Boolean(
      isPendingServicePayload(cachedExternalRisksSnapshot?.meteo_france || {})
      || isPendingServicePayload(cachedExternalRisksSnapshot?.vigicrues || {})
      || cachedExternalRisksSnapshot?.refresh?.in_progress
    );
    setPanelLoading(activePanelId, false);
    finishStartupQueue();
  });

  try {
    await refreshAllInFlight;
    // Un refreshAll complet réussi signifie que les données sont fraîches :
    // réinitialiser le compteur d'échecs live pour ne pas afficher d'erreur
    // sur le prochain cycle si le refreshAll a déjà tout corrigé.
    _liveEventsFailCount = 0;
  } finally {
    refreshAllInFlight = null;
    _lastRefreshAllTs = Date.now();
  }
}

function applyRoleVisibility() {
  document.querySelectorAll('[data-requires-edit]').forEach((node) => setVisibility(node, canEdit()));
  document.querySelectorAll('[data-requires-map-point]').forEach((node) => setVisibility(node, canCreateMapPoints()));
  document.querySelectorAll('[data-admin-only]').forEach((node) => setVisibility(node, currentUser?.role === 'admin'));
  setVisibility(document.querySelector('[data-target="users-panel"]'), canManageUsers());
  document.querySelectorAll('.menu-btn').forEach((node) => {
    const target = String(node.getAttribute('data-target') || '');
    setVisibility(node, canAccessPanel(target));
  });
  const activePanel = localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel';
  if (!canAccessPanel(activePanel)) setActivePanel('situation-panel');
}


function syncUserCreateMunicipalityVisibility() {
  const role = document.getElementById('user-create-role')?.value;
  setVisibility(document.getElementById('user-create-municipality-wrap'), role === 'mairie');
}

function populateUserMunicipalityOptions() {
  const select = document.getElementById('user-create-municipality');
  if (!select) return;
  const pcsMunicipalities = (Array.isArray(cachedMunicipalities) ? cachedMunicipalities : [])
    .filter((municipality) => municipality?.pcs_active)
    .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), 'fr'));
  select.innerHTML = `<option value="">Sélectionner une commune PCS</option>${pcsMunicipalities.map((municipality) => `<option value="${escapeHtml(municipality.name)}">${escapeHtml(municipality.name)}${municipality.postal_code ? ` (${escapeHtml(municipality.postal_code)})` : ''}</option>`).join('')}`;
}

async function handleUsersTableAction(event) {
  const editButton = event.target.closest('[data-user-edit]');
  const resetButton = event.target.closest('[data-user-reset]');
  const deleteButton = event.target.closest('[data-user-delete]');
  if (!editButton && !resetButton && !deleteButton) return;

  document.getElementById('users-error').textContent = '';
  document.getElementById('users-success').textContent = '';

  try {
    if (editButton) {
      const userId = editButton.getAttribute('data-user-edit');
      const role = window.prompt('Nouveau rôle (admin, ope, securite, visiteur, mairie)');
      if (!role) return;
      const municipalityName = role === 'mairie' ? window.prompt('Nom de la commune associée') : null;
      await api(`/auth/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: role.trim().toLowerCase(), municipality_name: municipalityName || null }),
      });
      document.getElementById('users-success').textContent = 'Utilisateur mis à jour.';
    }

    if (resetButton) {
      const userId = resetButton.getAttribute('data-user-reset');
      const customPassword = window.prompt('Nouveau mot de passe temporaire (laisser vide pour générer automatiquement)', '');
      const payload = customPassword ? { new_password: customPassword } : {};
      const result = await api(`/auth/users/${userId}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      document.getElementById('users-success').textContent = `Mot de passe temporaire pour ${result.username}: ${result.temporary_password}`;
    }

    if (deleteButton) {
      const userId = deleteButton.getAttribute('data-user-delete');
      if (!window.confirm('Confirmer la suppression de cet utilisateur ?')) return;
      await api(`/auth/users/${userId}`, { method: 'DELETE' });
      document.getElementById('users-success').textContent = 'Utilisateur supprimé.';
    }

    await loadUsers();
  } catch (error) {
    document.getElementById('users-error').textContent = sanitizeErrorMessage(error.message);
  }
}


function renderMapChecks(checks = []) {
  const target = document.getElementById('map-checks-list');
  if (!target) return;
  if (!checks.length) {
    setHtml('map-checks-list', '<li>Aucun diagnostic exécuté.</li>');
    return;
  }
  setHtml('map-checks-list', checks.map((check) => `<li><span class="${check.ok ? 'ok' : 'ko'}">${check.ok ? 'OK' : 'KO'}</span> · ${escapeHtml(check.label)}${check.detail ? ` — ${escapeHtml(check.detail)}` : ''}</li>`).join(''));
}

async function runMapChecks() {
  await ensureMapReady();
  const checks = [];
  checks.push({ ok: typeof window.L !== 'undefined', label: 'Leaflet chargé', detail: typeof window.L !== 'undefined' ? 'bibliothèque disponible' : 'script Leaflet absent' });
  checks.push({ ok: Boolean(leafletMap), label: 'Instance carte initialisée', detail: leafletMap ? 'instance active' : 'carte non initialisée' });
  checks.push({ ok: Boolean(boundaryLayer), label: 'Contour Isère', detail: boundaryLayer ? 'contour affiché' : 'contour non chargé' });
  checks.push({ ok: cachedStations.length > 0, label: 'Stations Vigicrues', detail: `${cachedStations.length} station(s) en mémoire` });
  checks.push({ ok: cachedMunicipalities.length > 0, label: 'Communes disponibles', detail: `${cachedMunicipalities.length} commune(s) en mémoire` });
  checks.push({ ok: mapPoints.length >= 0, label: 'Points opérationnels', detail: `${mapPoints.length} point(s)` });
  const online = await Promise.allSettled([
    api('/public/isere-map', { logoutOn401: false }),
    api('/external/isere/risks', { logoutOn401: false }),
  ]);
  checks.push({ ok: online[0].status === 'fulfilled', label: 'API contour Isère', detail: online[0].status === 'fulfilled' ? 'accessible' : sanitizeErrorMessage(online[0].reason?.message) });
  checks.push({ ok: online[1].status === 'fulfilled', label: 'API risques consolidés', detail: online[1].status === 'fulfilled' ? 'accessible' : sanitizeErrorMessage(online[1].reason?.message) });

  renderMapChecks(checks);
  const failures = checks.filter((item) => !item.ok).length;
  if (!failures) {
    setMapFeedback('Diagnostic carte terminé: tout est opérationnel ✅');
    return;
  }
  setMapFeedback(`Diagnostic carte: ${failures} point(s) à corriger.`, true);
}

function setMapControlsCollapsed(collapsed) {
  mapControlsCollapsed = Boolean(collapsed);
  const workspace = document.querySelector('#map-panel .map-workspace');
  const controls = document.getElementById('map-controls-panel');
  const toggle = document.getElementById('map-controls-toggle');
  const toolbarToggle = document.getElementById('map-toolbar-collapse-toggle');
  if (!workspace || !controls || !toggle) return;
  workspace.classList.toggle('map-workspace--collapsed', mapControlsCollapsed);
  controls.setAttribute('aria-hidden', String(mapControlsCollapsed));
  toggle.setAttribute('aria-expanded', String(!mapControlsCollapsed));
  toggle.textContent = mapControlsCollapsed ? '🧰' : '📌';
  const toggleLabel = mapControlsCollapsed ? 'Afficher les options de la carte' : 'Ranger les options de la carte';
  toggle.title = toggleLabel;
  toggle.setAttribute('aria-label', toggleLabel);
  if (toolbarToggle) {
    toolbarToggle.setAttribute('aria-expanded', String(!mapControlsCollapsed));
    toolbarToggle.textContent = mapControlsCollapsed ? '🧰 Afficher menu carte' : '📌 Ranger menu carte';
  }
  if (leafletMap) setTimeout(() => leafletMap.invalidateSize(), 160);
}

function updateMapFullscreenButton() {
  const button = document.getElementById('map-fullscreen-toggle');
  const toolbarButton = document.getElementById('map-toolbar-fullscreen-toggle');
  const mapWrapper = document.querySelector('#map-panel .map-canvas-wrap');
  if (!button || !mapWrapper) return;
  const isFullscreen = document.fullscreenElement === mapWrapper;
  button.textContent = isFullscreen ? '🡼' : '⛶';
  button.setAttribute('aria-pressed', String(isFullscreen));
  const label = isFullscreen ? 'Quitter le plein écran de la carte' : 'Passer la carte en plein écran';
  button.title = label;
  button.setAttribute('aria-label', label);
  if (toolbarButton) {
    toolbarButton.setAttribute('aria-pressed', String(isFullscreen));
    toolbarButton.textContent = isFullscreen ? '🡼 Quitter plein écran' : '⛶ Plein écran';
    toolbarButton.title = label;
    toolbarButton.setAttribute('aria-label', label);
  }
  if (leafletMap) setTimeout(() => leafletMap.invalidateSize(), 150);
}

async function toggleMapFullscreen() {
  const mapWrapper = document.querySelector('#map-panel .map-canvas-wrap');
  if (!mapWrapper) return;
  try {
    if (document.fullscreenElement === mapWrapper) {
      await document.exitFullscreen();
    } else {
      await mapWrapper.requestFullscreen();
    }
  } catch (error) {
    setMapFeedback('Mode plein écran indisponible sur ce navigateur.', true);
  }
}

function bindHomeInteractions() {
  const openLogin = () => showLogin();
  const mobileMenuButton = document.getElementById('mobile-menu-btn');
  const homeNav = document.getElementById('home-nav');

  document.getElementById('open-login-btn')?.addEventListener('click', openLogin);
  document.getElementById('hero-login-btn')?.addEventListener('click', openLogin);
  document.getElementById('back-home-btn')?.addEventListener('click', showHome);
  document.getElementById('scroll-actions-btn')?.addEventListener('click', () => document.getElementById('home-features')?.scrollIntoView({ behavior: 'smooth' }));

  mobileMenuButton?.addEventListener('click', () => {
    const isOpen = homeNav?.classList.toggle('open');
    mobileMenuButton.setAttribute('aria-expanded', String(Boolean(isOpen)));
  });

  homeNav?.querySelectorAll('a, button').forEach((node) => node.addEventListener('click', () => {
    homeNav.classList.remove('open');
    mobileMenuButton?.setAttribute('aria-expanded', 'false');
  }));
}

function bindAppInteractions() {
  const appMenuButton = document.getElementById('app-menu-btn');
  const appSidebar = document.getElementById('app-sidebar');

  document.querySelectorAll('.menu-btn').forEach((button) => button.addEventListener('click', () => {
    setActivePanel(button.dataset.target);
    // setActivePanel appelle déjà closeMobileSidebar()
  }));

  // Bouton "Rafraîchir" dans le header — accessible depuis tous les panels.
  document.getElementById('header-refresh-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('header-refresh-btn');
    if (btn) btn.classList.add('spinning');
    try {
      await refreshAll(true);
    } finally {
      if (btn) btn.classList.remove('spinning');
    }
  });
  document.getElementById('system-health-refresh-btn')?.addEventListener('click', () => {
    loadSystemHealth().catch((error) => {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    });
  });
  document.getElementById('georisques-pcs-select')?.addEventListener('change', (event) => {
    selectedGeorisquesPcsCommuneKey = String(event.target?.value || '').trim().toLowerCase();
    const georisquesPayload = cachedExternalRisksSnapshot?.georisques || {};
    const georisquesData = georisquesPayload?.data && typeof georisquesPayload.data === 'object'
      ? { ...georisquesPayload.data, ...georisquesPayload }
      : georisquesPayload;
    renderGeorisquesPcsRisks(georisquesData.monitored_communes || georisquesData.monitored_municipalities || georisquesData.communes || []);
  });
  document.getElementById('water-municipality-select')?.addEventListener('change', async (event) => {
    selectedWaterMunicipalityId = String(event.target?.value || '').trim();
    await loadAndRenderWaterPanel(false);
  });
  document.getElementById('contacts-search-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const city = String(new FormData(form).get('city') || '').trim();
    await loadAndRenderContactsPanel(city, true);
  });
  document.getElementById('stations-filter')?.addEventListener('change', (event) => {
    selectedStationFilter = String(event.target?.value || '');
    renderStationsPanel(stationsTimetableCache);
  });
  document.getElementById('stations-refresh-btn')?.addEventListener('click', async () => {
    await loadAndRenderStationsPanel(true);
  });
  const contactsInput = document.getElementById('contacts-city-search');
  if (contactsInput && currentUser?.role === 'mairie' && currentUser?.municipality_name) {
    contactsInput.value = currentUser.municipality_name;
    selectedContactsCity = currentUser.municipality_name;
  }
  renderContactsCitySuggestions();
  contactsPanelEmptyState();
  appMenuButton?.addEventListener('click', () => {
    const isOpen = !appSidebar?.classList.contains('open');
    if (isOpen) openMobileSidebar(); else closeMobileSidebar();
  });
  document.getElementById('sidebar-backdrop')?.addEventListener('click', closeMobileSidebar);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeStreetView();
    closeMobileSidebar();
  });
  const appSidebarToggle = document.getElementById('app-sidebar-toggle');
  appSidebarToggle?.addEventListener('click', () => {
    const appView = document.getElementById('app-view');
    const isCollapsed = appView?.classList.contains('app--sidebar-collapsed');
    setSidebarCollapsed(!isCollapsed);
  });
  setSidebarCollapsed(localStorage.getItem(STORAGE_KEYS.appSidebarCollapsed) === 'true');
  document.getElementById('logout-btn').addEventListener('click', logout);
  setMapControlsCollapsed(false);
  document.getElementById('map-search-btn')?.addEventListener('click', handleMapSearch);
  document.getElementById('map-controls-toggle')?.addEventListener('click', () => {
    setMapControlsCollapsed(!mapControlsCollapsed);
  });
  document.getElementById('map-toolbar-collapse-toggle')?.addEventListener('click', () => {
    setMapControlsCollapsed(!mapControlsCollapsed);
  });
  document.getElementById('map-fullscreen-toggle')?.addEventListener('click', toggleMapFullscreen);
  document.getElementById('map-toolbar-fullscreen-toggle')?.addEventListener('click', toggleMapFullscreen);
  document.getElementById('map-streetview-toggle')?.addEventListener('click', () => setStreetViewMode(!mapStreetViewMode));
  document.getElementById('map-streetview-close')?.addEventListener('click', closeStreetView);
  document.getElementById('map-open-streetview')?.addEventListener('click', () => {
    const button = document.getElementById('map-open-streetview');
    openStreetViewAt(button?.dataset.lat, button?.dataset.lon);
  });
  document.addEventListener('fullscreenchange', updateMapFullscreenButton);
  updateMapFullscreenButton();
  document.getElementById('map-fit-btn')?.addEventListener('click', () => fitMapToData(true));
  document.getElementById('map-locate-btn')?.addEventListener('click', locateUserOnMap);
  document.getElementById('map-zone-impact-start')?.addEventListener('click', startZoneImpactSelection);
  document.getElementById('map-zone-impact-clear')?.addEventListener('click', clearZoneImpactSelection);
  document.getElementById('map-briefing-export-btn')?.addEventListener('click', exportMapBriefing);
  document.querySelectorAll('.tactical-layer-toggle').forEach((input) => {
    input.addEventListener('change', () => renderCustomPoints(true));
  });
  document.getElementById('map-evacuation-circle-start')?.addEventListener('click', startEvacuationCircleMode);
  document.getElementById('map-evacuation-circle-clear')?.addEventListener('click', () => clearEvacuationCircle(true));
  document.getElementById('map-measure-start')?.addEventListener('click', startMapMeasureMode);
  document.getElementById('map-measure-clear')?.addEventListener('click', () => clearMapMeasure(true));
  document.getElementById('map-route-start')?.addEventListener('click', startMapRouteMode);
  document.getElementById('map-route-refresh')?.addEventListener('click', () => refreshAllMapRoutes(true));
  document.getElementById('map-route-clear')?.addEventListener('click', () => clearMapRoute(true));
  document.getElementById('map-route-list')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-route-action]');
    if (!btn) return;
    const route = mapRoutes.find((item) => item.id === btn.dataset.routeId);
    if (!route) return;
    const action = btn.dataset.routeAction;
    if (action === 'delete') {
      const displayIndex = routeDisplayIndex(route);
      mapRoutes = mapRoutes.filter((item) => item.id !== route.id);
      renderMapRoutes();
      updateRouteButtons();
      setRouteSummary(mapRoutes.length ? `${mapRoutes.length} trajet(s) affiché(s).` : 'Cliquez deux points sur la carte pour estimer un trajet.');
      setMapFeedback(`Trajet ${displayIndex} supprime.`);
    } else if (action === 'focus') {
      renderMapRoutes({ fitBounds: true, focusRouteId: route.id });
      if (route.payload) renderRouteEstimate(route.payload);
    } else if (action === 'info') {
      setRouteSummary(buildRouteInfoHtml(route), Boolean(route.error));
    }
  });
  updateRouteButtons();
  document.getElementById('map-add-point-btn')?.addEventListener('click', () => {
    if (!canEdit()) {
      setMapFeedback('Vous n\'avez pas le droit de créer un POI.', true);
      return;
    }
    if (mapEvacuationCircleMode) {
      mapEvacuationCircleMode = false;
      updateEvacuationCircleButtons();
    }
    if (mapMeasureMode) clearMapMeasure(false);
    if (mapRouteMode) clearMapRoute(false);
    mapAddPointMode = !mapAddPointMode;
    pendingMapPointCoords = null;
    const button = document.getElementById('map-add-point-btn');
    button?.classList.toggle('active', mapAddPointMode);
    button?.setAttribute('aria-pressed', String(mapAddPointMode));
    setMapFeedback(mapAddPointMode
      ? 'Mode création POI actif: cliquez sur la carte pour positionner le point.'
      : 'Mode création POI désactivé.');
  });
  document.getElementById('map-focus-crisis')?.addEventListener('click', focusOnCrisisAreas);
  document.getElementById('map-run-checks')?.addEventListener('click', runMapChecks);
  document.getElementById('map-toggle-contrast')?.addEventListener('click', toggleMapContrast);
  document.getElementById('map-reset-filters')?.addEventListener('click', async () => {
    try {
      await resetMapFilters();
    } catch (error) {
      setMapFeedback(sanitizeErrorMessage(error.message), true);
    }
  });
  document.getElementById('map-basemap-select')?.addEventListener('change', async (event) => { applyBasemap(event.target.value); await renderPopulationByCityLayer(); });
  document.getElementById('filter-google-traffic-flow')?.addEventListener('change', () => applyGoogleTrafficFlowOverlay());
  document.getElementById('filter-flood-zones')?.addEventListener('change', () => applyFloodZoneLayer());
  document.getElementById('filter-avalanche-zones')?.addEventListener('change', () => applyAvalancheZoneLayer());
  document.getElementById('filter-barrages')?.addEventListener('change', () => {
    if (!barrageLoaded && !_barrageLoadInFlight) {
      _barrageLoadInFlight = true;
      loadBarragePoints()
        .then(() => { _barrageLoadInFlight = false; renderBarrageLayer(); })
        .catch(() => { _barrageLoadInFlight = false; });
    } else {
      renderBarrageLayer();
    }
  });
  document.getElementById('filter-montagne')?.addEventListener('change', () => {
    if (!montagneLoaded && !_montagneLoadInFlight) {
      _montagneLoadInFlight = true;
      loadMontagnePoints()
        .then(() => { _montagneLoadInFlight = false; renderMontagneLayer(); })
        .catch(() => { _montagneLoadInFlight = false; });
    } else {
      renderMontagneLayer();
    }
  });
  document.getElementById('filter-helipads')?.addEventListener('change', () => {
    if (!helipadLoaded && !_helipadLoadInFlight) {
      _helipadLoadInFlight = true;
      loadHelipadPoints()
        .then(() => { _helipadLoadInFlight = false; renderHelipadLayer(); })
        .catch(() => { _helipadLoadInFlight = false; });
    } else {
      renderHelipadLayer();
    }
  });
  document.getElementById('filter-agents-refresh')?.addEventListener('click', () => _refreshAgentMarkers());
  document.getElementById('filter-agents')?.addEventListener('change', () => {
    if (document.getElementById('filter-agents').checked) {
      _refreshAgentMarkers();
    } else {
      if (_agentMarkersLayer) _agentMarkersLayer.clearLayers();
      _setAgentFilterStatus('', null);
    }
  });
  document.getElementById('filter-seismes')?.addEventListener('change', () => renderSeismesLayer());
  document.getElementById('filter-feux-foret')?.addEventListener('change', () => renderFeuxForetLayer());
  document.getElementById('filter-cols-alpins')?.addEventListener('change', () => renderColsAlpinsLayer());
  document.getElementById('filter-resources-telecom')?.addEventListener('change', () => {
    syncTelecomFilterState();
    renderResources();
  });
  document.getElementById('api-refresh-btn')?.addEventListener('click', async () => {
    try {
      requestPriorityServicesForPanel('api-panel');
      await Promise.all([loadApiInterconnections(false), loadSystemHealth()]);
      document.getElementById('dashboard-error').textContent = '';
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  document.getElementById('flux-filters')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.flux-filter-btn');
    if (!btn) return;
    _currentFluxFilter = btn.dataset.filter || 'all';
    document.querySelectorAll('.flux-filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
    lastRenderedApiInterconnectionsSignature = null; // force re-render
    renderApiInterconnections(cachedExternalRisksSnapshot);
  });
  document.getElementById('map-search')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); handleMapSearch(); } });
  document.getElementById('map-search-clear')?.addEventListener('click', () => {
    const input = document.getElementById('map-search');
    if (input) input.value = '';
    if (searchLayer) searchLayer.clearLayers();
    updateSelectedLocationPanel(null, null);
    renderResources();
    setMapFeedback('Recherche effacée, ressources remises à jour.');
  });
  document.getElementById('resources-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-resource-toggle]');
    if (!button) return;
    toggleResourceActive(button.dataset.resourceToggle || '');
  });
  document.getElementById('poi-target-category-filter')?.addEventListener('change', () => {
    renderCustomPoints();
  });
  document.getElementById('poi-target-toggle-btn')?.addEventListener('click', toggleSelectedPoiVisibility);
  document.getElementById('map-point-form-cancel')?.addEventListener('click', () => {
    const modal = document.getElementById('map-point-modal');
    mapAddPointMode = false;
    document.getElementById('map-add-point-btn')?.classList.remove('active');
    document.getElementById('map-add-point-btn')?.setAttribute('aria-pressed', 'false');
    if (typeof modal?.close === 'function') modal.close();
    else modal?.removeAttribute('open');
  });
  document.getElementById('map-point-category')?.addEventListener('change', (event) => {
    const category = event.target.value;
    const iconInput = document.getElementById('map-point-icon');
    renderMapIconSuggestions(category);
    if (iconInput && !mapIconTouched) iconInput.value = iconForCategory(category);
  });
  document.getElementById('map-point-icon')?.addEventListener('input', () => {
    mapIconTouched = true;
  });
  document.getElementById('map-icon-suggestions')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-map-icon]');
    if (!button) return;
    const iconInput = document.getElementById('map-point-icon');
    if (!iconInput) return;
    iconInput.value = button.getAttribute('data-map-icon') || '📍';
    mapIconTouched = true;
  });
  document.getElementById('map-point-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pendingMapPointCoords && leafletMap) {
      pendingMapPointCoords = leafletMap.getCenter();
      setMapFeedback('Point non sélectionné: utilisation du centre de carte.');
    }
    if (!pendingMapPointCoords) {
      setMapFeedback('Cliquez d\'abord sur la carte pour positionner le point.', true);
      return;
    }
    const form = event.target;
    const category = form.elements.category.value || 'autre';
    const icon = form.elements.icon.value.trim() || iconForCategory(category);
    const iconUrl = form.elements.icon_url.value.trim() || null;
    try {
      await saveMapPoint({
        name: form.elements.name.value.trim(),
        category,
        icon,
        icon_url: iconUrl,
        notes: form.elements.notes.value.trim() || null,
        lat: pendingMapPointCoords.lat,
        lon: pendingMapPointCoords.lng,
      });
      pendingMapPointCoords = null;
      mapAddPointMode = false;
      document.getElementById('map-add-point-btn')?.classList.remove('active');
      document.getElementById('map-add-point-btn')?.setAttribute('aria-pressed', 'false');
      const modal = document.getElementById('map-point-modal');
      if (typeof modal?.close === 'function') modal.close();
      else modal?.removeAttribute('open');
      form.reset();
      setMapFeedback('Point opérationnel enregistré.');
    } catch (error) {
      setMapFeedback(`Enregistrement impossible: ${sanitizeErrorMessage(error.message)}`, true);
    }
  });
  document.getElementById('itinerary-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-map-query]');
    if (!button) return;
    document.getElementById('map-search').value = button.getAttribute('data-map-query') || '';
    await handleMapSearch();
  });
  document.getElementById('custom-points-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove-point]');
    if (!button) return;
    const targetId = button.getAttribute('data-remove-point');
    try {
      button.disabled = true;
      await deleteMapPoint(targetId);
      setMapFeedback('Point opérationnel supprimé.');
    } catch (error) {
      setMapFeedback(sanitizeErrorMessage(error.message), true);
    }
  });
  document.getElementById('map-annotations-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove-annotation]');
    if (!button) return;
    try {
      await api(`/map/annotations/${button.getAttribute('data-remove-annotation')}`, { method: 'DELETE' });
      await loadMapAnnotations(true);
    } catch (error) {
      setMapFeedback(sanitizeErrorMessage(error.message), true);
    }
  });
  document.getElementById('map-annotation-clear-btn')?.addEventListener('click', async () => {
    if (!canEdit()) return;
    const ids = mapAnnotations.map((a) => a.id);
    await Promise.all(ids.map((id) => api(`/map/annotations/${id}`, { method: 'DELETE' }).catch(() => null)));
    await loadMapAnnotations(true);
  });
  document.getElementById('municipalities-list')?.addEventListener('click', async (event) => {
    const viewButton = event.target.closest('[data-muni-view], [data-muni-detail]');
    const editButton = event.target.closest('[data-muni-edit]');
    const crisisButton = event.target.closest('[data-muni-crisis]');
    const filesButton = event.target.closest('[data-muni-files]');
    const deleteButton = event.target.closest('[data-muni-delete]');
    const card = event.target.closest('.municipality-card');
    const fallbackId = card?.getAttribute('data-muni-id');
    if (!viewButton && !editButton && !crisisButton && !filesButton && !deleteButton && !fallbackId) return;
    try {
      const getMunicipality = (id) => cachedMunicipalityRecords.find((m) => String(m.id) === String(id));

      if (viewButton) {
        const municipality = getMunicipality(viewButton.getAttribute('data-muni-view') || viewButton.getAttribute('data-muni-detail'));
        if (!municipality) return;
        document.getElementById('municipality-feedback').textContent = `Commune ${municipality.name}: ${municipality.crisis_mode ? 'en crise' : 'en veille'} · vigilance ${normalizeLevel(municipality.vigilance_color)}.`;
        openMunicipalityDetailsModal(municipality);
        return;
      }

      if (!editButton && !crisisButton && !filesButton && !deleteButton && fallbackId) {
        const municipality = getMunicipality(fallbackId);
        if (!municipality) return;
        document.getElementById('municipality-feedback').textContent = `Commune ${municipality.name}: ${municipality.crisis_mode ? 'en crise' : 'en veille'} · vigilance ${normalizeLevel(municipality.vigilance_color)}.`;
        openMunicipalityDetailsModal(municipality);
        return;
      }

      if (editButton) {
        const municipalityId = editButton.getAttribute('data-muni-edit');
        const municipality = getMunicipality(municipalityId);
        if (!municipality) return;
        openMunicipalityEditor(municipality);
        return;
      }

      if (crisisButton) {
        const municipalityId = crisisButton.getAttribute('data-muni-crisis');
        const result = await api(`/municipalities/${municipalityId}/crisis`, { method: 'POST' });
        const municipality = getMunicipality(municipalityId);
        document.getElementById('municipality-feedback').textContent = `${municipality?.name || 'Commune'}: ${result.crisis_mode ? 'mode crise activé' : 'retour en veille'}.`;
      }

      if (filesButton) {
        const municipalityId = filesButton.getAttribute('data-muni-files');
        const municipality = getMunicipality(municipalityId);
        if (municipality) await openMunicipalityDetailsModal(municipality);
        return;
      }

      if (deleteButton) {
        const municipalityId = deleteButton.getAttribute('data-muni-delete');
        const municipality = getMunicipality(municipalityId);
        const confirmed = window.confirm(`Supprimer définitivement la commune ${municipality?.name || municipalityId} ?`);
        if (!confirmed) return;
        await api(`/municipalities/${municipalityId}`, { method: 'DELETE' });
        document.getElementById('municipality-feedback').textContent = `Commune ${municipality?.name || municipalityId} supprimée.`;
      }

      await loadMunicipalities();
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  document.getElementById('user-create-role')?.addEventListener('change', syncUserCreateMunicipalityVisibility);
  document.getElementById('municipality-editor-close')?.addEventListener('click', () => {
    closeMunicipalityEditor();
  });
  document.getElementById('municipality-details-close')?.addEventListener('click', () => {
    requestMunicipalityDetailsCloseLikeEscape();
  });
  document.getElementById('municipality-details-modal')?.addEventListener('cancel', (event) => {
    cleanupMunicipalityPreview();
  });
  document.getElementById('municipality-details-modal')?.addEventListener('close', () => {
    cleanupMunicipalityPreview();
  });
  document.getElementById('municipality-details-modal')?.addEventListener('click', (event) => {
    if (event.target?.id === 'municipality-details-modal') closeMunicipalityDetailsModal();
  });
  document.getElementById('situation-kpi-modal-close')?.addEventListener('click', () => {
    const modal = document.getElementById('situation-kpi-modal');
    if (typeof modal?.close === 'function') modal.close();
    else modal?.removeAttribute('open');
  });
  document.getElementById('situation-kpi-modal')?.addEventListener('click', (event) => {
    if (event.target?.id === 'situation-kpi-modal') {
      const modal = document.getElementById('situation-kpi-modal');
      if (typeof modal?.close === 'function') modal.close();
      else modal?.removeAttribute('open');
    }
  });
  document.getElementById('municipality-details-content')?.addEventListener('click', async (event) => {
    const crisisButton = event.target.closest('[data-muni-detail-crisis]');
    const editButton = event.target.closest('[data-muni-edit]');
    const openEventButton = event.target.closest('[data-muni-open-event]');
    if (!crisisButton && !editButton && !openEventButton) return;

    const getMunicipality = (id) => cachedMunicipalityRecords.find((m) => String(m.id) === String(id));

    try {
      if (editButton) {
        if (!canEdit()) return;
        const municipalityId = editButton.getAttribute('data-muni-edit');
        const municipality = getMunicipality(municipalityId);
        if (!municipality) return;
        closeMunicipalityDetailsModal();
        openMunicipalityEditor(municipality);
        return;
      }

      if (openEventButton) {
        const eventId = openEventButton.getAttribute('data-muni-open-event');
        if (!eventId) return;
        closeMunicipalityDetailsModal();
        openOperationalEventMcoForm(eventId);
        return;
      }

      if (crisisButton) {
        if (!canEdit()) return;
        const municipalityId = crisisButton.getAttribute('data-muni-detail-crisis');
        const result = await api(`/municipalities/${municipalityId}/crisis`, { method: 'POST' });
        await loadMunicipalities();
        const municipality = getMunicipality(municipalityId);
        document.getElementById('municipality-feedback').textContent = `${municipality?.name || 'Commune'}: ${result.crisis_mode ? 'mode crise activé' : 'retour en veille'}.`;
        if (municipality) await openMunicipalityDetailsModal(municipality);
        return;
      }

    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });

  document.getElementById('log-target-scope')?.addEventListener('change', () => {
    syncLogScopeFields();
  });
  document.getElementById('log-event-type')?.addEventListener('change', syncLogOtherFields);
  document.getElementById('log-source-select')?.addEventListener('change', syncLogOtherFields);
  document.getElementById('log-municipality-id')?.addEventListener('focus', () => {
    ensureLogMunicipalitiesLoaded();
  });
  const debouncedLogsRender = debounce(renderLogsList, 180);
  ['logs-event-filter', 'logs-search', 'logs-municipality-filter', 'logs-scope-filter', 'logs-sort'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', debouncedLogsRender);
    document.getElementById(id)?.addEventListener('change', renderLogsList);
  });

  const debouncedMunicipalityFilter = debounce(applyMunicipalityFilters, 180);
  ['municipalities-search', 'municipalities-status-filter', 'municipalities-sort'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', debouncedMunicipalityFilter);
    document.getElementById(id)?.addEventListener('change', applyMunicipalityFilters);
  });
  document.getElementById('logs-export')?.addEventListener('click', async () => {
    try {
      await exportLogsCsv();
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  document.getElementById('logs-panel')?.addEventListener('click', async (event) => {
    const openEventButton = event.target.closest('[data-event-open]');
    const eventStatusButton = event.target.closest('[data-event-status]');
    const deleteButton = event.target.closest('[data-log-delete]');
    const editButton = event.target.closest('[data-log-edit]');
    const deleteEventButton = event.target.closest('[data-event-delete]');
    const exportPdfButton = event.target.closest('#event-export-pdf-btn');
    if (openEventButton) {
      openOperationalEventMcoForm(openEventButton.getAttribute('data-event-open'));
      return;
    }
    if (exportPdfButton) {
      generateMcoEventPdf();
      return;
    }

    if (!eventStatusButton && !deleteButton && !editButton && !deleteEventButton) return;
    if (!canEdit()) return;

    try {
      if (eventStatusButton) {
        const eventId = eventStatusButton.getAttribute('data-event-status');
        const status = eventStatusButton.getAttribute('data-event-next');
        const updatedEvent = await api(`/events/${eventId}`, {
          method: 'PATCH',
          highPriority: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        upsertCachedEvent(updatedEvent);
        return;
      }

      if (deleteButton) {
        const logId = deleteButton.getAttribute('data-log-delete');
        const confirmed = window.confirm('Supprimer cette entrée de main courante ?');
        if (!confirmed) return;
        await api(`/logs/${logId}`, { method: 'DELETE', highPriority: true });
        removeCachedLog(logId);
        return;
      }

      if (deleteEventButton) {
        const eventId = deleteEventButton.getAttribute('data-event-delete');
        const confirmed = window.confirm('Supprimer cet évènement et toutes ses entrées MCO ?');
        if (!confirmed) return;
        await api(`/events/${eventId}`, { method: 'DELETE', highPriority: true });
        if (String(selectedOperationalEventId) === String(eventId)) selectedOperationalEventId = null;
        removeCachedEvent(eventId);
        return;
      }

      if (editButton) {
        const logId = editButton.getAttribute('data-log-edit');
        const log = getLogById(logId);
        if (!log) return;
        fillLogFormFromEntry(log);
        document.getElementById('log-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      await loadLogs();
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  syncLogScopeFields();

  // ── MCO: toggle new-event form ────────────────────────────
  document.getElementById('mco-new-event-toggle')?.addEventListener('click', () => {
    const wrap = document.getElementById('mco-new-event-wrap');
    if (!wrap) return;
    const isHidden = wrap.hidden;
    wrap.hidden = !isHidden;
    wrap.classList.toggle('hidden', !isHidden);
    const btn = document.getElementById('mco-new-event-toggle');
    if (btn) btn.textContent = isHidden ? '✕ Annuler' : '+ Nouvel évènement';
  });
  document.getElementById('mco-new-event-cancel')?.addEventListener('click', () => {
    const wrap = document.getElementById('mco-new-event-wrap');
    if (wrap) { wrap.hidden = true; wrap.classList.add('hidden'); }
    const btn = document.getElementById('mco-new-event-toggle');
    if (btn) btn.textContent = '+ Nouvel évènement';
  });

  // ── MCO: event filter buttons ─────────────────────────────
  document.querySelectorAll('.mco-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      mcoEventFilter = btn.dataset.mcoFilter || 'open';
      document.querySelectorAll('.mco-filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderEventsList();
    });
  });

  // ── MCO: back button (mobile) ─────────────────────────────
  document.getElementById('mco-back-btn')?.addEventListener('click', () => {
    selectedOperationalEventId = null;
    updateEventDetailPanel();
    renderEventsList();
    renderLogsList();
  });

  // ── MCO: cancel log edit ──────────────────────────────────
  document.getElementById('mco-cancel-edit-btn')?.addEventListener('click', () => {
    const form = document.getElementById('log-form');
    if (form) { form.reset(); resetLogFormState(); }
    syncLogScopeFields();
  });

  document.getElementById('municipality-edit-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canEdit()) return;
    const form = event.target;
    const municipalityId = form.elements.id.value;
    const payload = {
      name: form.elements.name.value.trim(),
      manager: form.elements.name.value.trim(),
      phone: form.elements.phone.value.trim(),
      email: form.elements.email.value.trim(),
      postal_code: form.elements.postal_code.value.trim() || null,
      insee_code: form.elements.insee_code.value.trim() || null,
      contacts: form.elements.contacts.value.trim() || null,
      additional_info: form.elements.additional_info.value.trim() || null,
      population: Number(form.elements.population.value || 0) || null,
      shelter_capacity: Number(form.elements.shelter_capacity.value || 0) || null,
      vigilance_color: normalizeLevel(form.elements.vigilance_color.value || 'vert'),
      pcs_active: Boolean(form.elements.pcs_active.checked),
    };
    try {
      await api(`/municipalities/${municipalityId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      document.getElementById('municipality-feedback').textContent = 'Fiche commune enregistrée.';
      closeMunicipalityEditor();
      await loadMunicipalities();
    } catch (error) {
      document.getElementById('municipality-feedback').textContent = sanitizeErrorMessage(error.message);
    }
  });
  syncUserCreateMunicipalityVisibility();
  document.getElementById('users-table')?.addEventListener('click', handleUsersTableAction);
  document.getElementById('user-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    document.getElementById('users-error').textContent = '';
    document.getElementById('users-success').textContent = '';
    const form = new FormData(event.target);
    const role = String(form.get('role') || '').trim();
    const municipalityName = role === 'mairie' ? String(form.get('municipality_name') || '').trim() : null;

    try {
      await api('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: String(form.get('username') || '').trim(),
          password: String(form.get('password') || ''),
          role,
          municipality_name: municipalityName || null,
        }),
      });
      event.target.reset();
      populateUserMunicipalityOptions();
      syncUserCreateMunicipalityVisibility();
      document.getElementById('users-success').textContent = 'Utilisateur créé avec succès.';
      await loadUsers();
    } catch (error) {
      document.getElementById('users-error').textContent = sanitizeErrorMessage(error.message);
    }
  });

  document.getElementById('ldap-bind-password-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    document.getElementById('users-error').textContent = '';
    document.getElementById('users-success').textContent = '';
    const form = new FormData(event.target);
    const password = String(form.get('password') || '');
    try {
      const result = await api('/auth/ldap/bind-password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      event.target.reset();
      renderLdapBindPasswordStatus(result);
      document.getElementById('users-success').textContent = 'Mot de passe LDAP enregistre.';
    } catch (error) {
      document.getElementById('users-error').textContent = sanitizeErrorMessage(error.message);
    }
  });

  document.getElementById('ldap-bind-password-clear-btn')?.addEventListener('click', async () => {
    document.getElementById('users-error').textContent = '';
    document.getElementById('users-success').textContent = '';
    try {
      const result = await api('/auth/ldap/bind-password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
      renderLdapBindPasswordStatus(result);
      document.getElementById('users-success').textContent = 'Mot de passe LDAP efface.';
    } catch (error) {
      document.getElementById('users-error').textContent = sanitizeErrorMessage(error.message);
    }
  });

  // Filtres qui n'affectent que les ressources (rendu immédiat, pas de re-fetch réseau)
  async function runLdapTest({ serverOnly = false } = {}) {
    const resultNode = document.getElementById('ldap-test-result');
    const errorNode = document.getElementById('users-error');
    if (resultNode) resultNode.textContent = 'Test LDAP en cours...';
    if (errorNode) errorNode.textContent = '';
    const formEl = document.getElementById('ldap-test-form');
    const form = new FormData(formEl);
    try {
      const result = await api('/auth/ldap/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: serverOnly ? null : (String(form.get('username') || '').trim() || null),
          password: serverOnly ? null : (String(form.get('password') || '') || null),
        }),
      });
      const account = result.username ? ` - ${result.username} (${roleLabel(result.role || 'visiteur')})` : '';
      const checks = Array.isArray(result.checks) && result.checks.length
        ? `\n${result.checks.map((check) => `${check.ok ? 'OK' : 'ECHEC'} ${check.name}: ${check.detail || ''}`).join('\n')}`
        : '';
      if (resultNode) resultNode.textContent = `${result.ok ? 'OK' : 'ECHEC'} - ${result.detail || ''}${account}${checks}`;
      if (result.ok) await loadUsers();
    } catch (error) {
      if (resultNode) resultNode.textContent = '';
      if (errorNode) errorNode.textContent = sanitizeErrorMessage(error.message);
    }
  }

  document.getElementById('ldap-test-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await runLdapTest({ serverOnly: false });
  });
  document.getElementById('ldap-server-test-btn')?.addEventListener('click', async () => {
    await runLdapTest({ serverOnly: true });
  });

  const RESOURCE_ONLY_FILTERS = new Set([
    'filter-resources-command', 'filter-resources-hosting', 'filter-resources-hosting-type',
    'filter-resources-hosting-capacity', 'filter-resources-hosting-surface', 'filter-resources-hosting-accessibility',
    'filter-resources-hosting-sanitary', 'filter-resources-hosting-heating', 'filter-resources-hosting-parking',
    'filter-resources-schools', 'filter-resources-schools-type',
    'filter-resources-security', 'filter-resources-security-type',
    'filter-resources-fire', 'filter-resources-risks', 'filter-resources-risks-type',
    'filter-resources-transport', 'filter-resources-transport-type',
    'filter-resources-health', 'filter-resources-health-type', 'filter-resources-dae',
    'filter-resources-telecom', 'filter-resources-telecom-type',
    'filter-resources-active', 'filter-resources-protcivile',
  ]);
  ['filter-hydro', 'filter-pcs', 'filter-meteo-cities', 'filter-meteo-layer-type', 'filter-seismes', 'filter-feux-foret', 'filter-resources-active', 'filter-resources-command', 'filter-resources-hosting', 'filter-resources-hosting-type', 'filter-resources-hosting-capacity', 'filter-resources-hosting-surface', 'filter-resources-hosting-accessibility', 'filter-resources-hosting-sanitary', 'filter-resources-hosting-heating', 'filter-resources-hosting-parking', 'filter-resources-schools', 'filter-resources-schools-type', 'filter-resources-security', 'filter-resources-security-type', 'filter-resources-fire', 'filter-resources-risks', 'filter-resources-risks-type', 'filter-resources-transport', 'filter-resources-transport-type', 'filter-resources-health', 'filter-resources-health-type', 'filter-resources-dae', 'filter-resources-telecom', 'filter-resources-telecom-type', 'filter-resources-protcivile', 'filter-traffic-incidents', 'filter-bison-type', 'filter-cameras', 'filter-autoroutes', 'filter-autoroutes-type', 'filter-pr-autoroutes', 'filter-tchoo-trains'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', async () => {
      if (RESOURCE_ONLY_FILTERS.has(id)) {
        // Rendu immédiat depuis le cache
        renderResources();
        return;
      }
      // Filtres globaux (hydro, pcs, trafic, caméras) → tout re-rendre
      renderStations(cachedVigicruesPayload);
      await renderMeteoCitiesLayer();
      renderSeismesLayer();
      renderFeuxForetLayer();
      await renderMunicipalitiesOnMap(cachedMunicipalities);
      renderResources();
      await renderPopulationByCityLayer();
      await renderTrafficOnMap();
    });
  });
}


function logout() {
  token = null;
  currentUser = null;
  clearApiCache();
  localStorage.removeItem(STORAGE_KEYS.token);
  if (refreshTimer) clearInterval(refreshTimer);
  if (liveEventsTimer) clearInterval(liveEventsTimer);
  if (stationTimetableTimer) clearInterval(stationTimetableTimer);
  if (apiPanelTimer) clearInterval(apiPanelTimer);
  if (apiResyncTimer) clearInterval(apiResyncTimer);
  if (agentMarkersTimer) clearInterval(agentMarkersTimer);
  agentMarkersTimer = null;
  stopRouteRefreshTimer();
  stopTchooTrainTimer();
  stopMapAnnotationsSync();
  stopExternalRisksSSE();
  finishStartupQueue();
  showLogin();
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function startStationTimetableRefresh() {
  if (stationTimetableTimer) clearInterval(stationTimetableTimer);
  if ((localStorage.getItem(STORAGE_KEYS.activePanel) || '') === 'stations-panel') {
    refreshStationTimetables({ forceRefresh: true, silent: true });
  }
  stationTimetableTimer = setInterval(() => {
    if ((localStorage.getItem(STORAGE_KEYS.activePanel) || '') !== 'stations-panel' || document.hidden) return;
    refreshStationTimetables({ forceRefresh: true, silent: true });
  }, STATION_TIMETABLE_REFRESH_MS);
}

function startAgentMarkersPolling() {
  if (agentMarkersTimer) clearInterval(agentMarkersTimer);
  agentMarkersTimer = null;
  const _doRefresh = () => {
    if (!token || !leafletMap || document.hidden || !isMapPanelActive()) return;
    _ensureAgentLayer();
    _refreshAgentMarkers();
  };
  const _tryStart = () => {
    if (leafletMap) {
      _doRefresh();
      if (!agentMarkersTimer) agentMarkersTimer = setInterval(_doRefresh, 10000);
    }
    else setTimeout(_tryStart, 500);
  };
  setTimeout(_tryStart, 1000);
}

/* ─────────────────────────────────────────────────────────────
   AMÉLIORATIONS OPÉRATIONNELLES
   ───────────────────────────────────────────────────────────── */

/** Horloge temps réel dans le header — mise à jour chaque seconde. */
function startLiveClock() {
  const elTime = document.getElementById('header-time');
  const elDate = document.getElementById('header-date');
  if (!elTime || !elDate) return;
  function tick() {
    const now = new Date();
    elTime.textContent = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    elDate.textContent = now.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  tick();
  setInterval(tick, 1000);
}

/** Badge de vigilance globale dans le header — mis à jour à chaque renderDashboard. */
function updateHeaderVigilanceBadge(level) {
  const badge = document.getElementById('header-vigilance-badge');
  if (!badge) return;
  const lvl = normalizeLevel(level || 'vert');
  const labels = { vert: 'VERT', jaune: 'JAUNE', orange: 'ORANGE', rouge: 'ROUGE', gris: 'SYNC' };
  badge.textContent = labels[lvl] || lvl.toUpperCase();
  ['vert', 'jaune', 'orange', 'rouge', 'gris'].forEach((l) => badge.classList.toggle(`header-vigilance-badge--${l}`, l === lvl));
}

/** Indicateur de fraîcheur : "données de il y a Xs" mis à jour toutes les 15s. */
function startDataFreshnessIndicator() {
  const el = document.getElementById('header-freshness');
  if (!el) return;
  function update() {
    if (!_lastServerSnapshotAt && !_lastRefreshAllTs) { el.textContent = ''; return; }
    if (_serverSnapshotSyncing) {
      el.textContent = _lastServerSnapshotAt
        ? `synchronisation · snapshot ${formatElapsedSince(_lastServerSnapshotAt)}`
        : 'synchronisation des données';
      return;
    }
    const reference = _lastServerSnapshotAt || _lastRefreshAllTs;
    const seconds = Math.floor((Date.now() - reference) / 1000);
    if (seconds < 10)  { el.textContent = 'snapshot serveur à jour'; return; }
    if (seconds < 60)  { el.textContent = `snapshot serveur il y a ${seconds}s`; return; }
    if (seconds < 3600) { el.textContent = `snapshot serveur il y a ${Math.floor(seconds / 60)} min`; return; }
    el.textContent = `snapshot serveur il y a ${Math.floor(seconds / 3600)}h`;
  }
  update();
  setInterval(update, 15000);
}

/** Badge "N événements ouverts" sur le bouton Main courante dans le menu. */
function updateMenuEventsBadge() {
  const badge = document.getElementById('menu-events-badge');
  if (!badge) return;
  const openCount = Array.isArray(cachedEvents)
    ? cachedEvents.filter((e) => String(e.status || '').toLowerCase() === 'ouvert').length
    : 0;
  if (openCount > 0) {
    badge.textContent = String(openCount > 99 ? '99+' : openCount);
    badge.classList.remove('hidden');
    badge.setAttribute('aria-label', `${openCount} événement(s) ouvert(s)`);
  } else {
    badge.classList.add('hidden');
  }
}

/** Génère le SITREP en texte brut pour copie presse-papier. */
function buildSitrepText() {
  const dashboard = cachedDashboardSnapshot || {};
  const externalRisks = cachedExternalRisksSnapshot || {};
  const now = new Date().toLocaleString('fr-FR');
  const vigilance = normalizeLevel(dashboard.vigilance || externalRisks?.meteo_france?.level || 'vert');
  const crises = Number(dashboard.communes_crise ?? 0);
  const prefItems = Array.isArray(externalRisks?.prefecture_isere?.items)
    ? externalRisks.prefecture_isere.items.slice(0, 3) : [];
  const openEvents = Array.isArray(cachedEvents)
    ? cachedEvents.filter((e) => String(e.status || '').toLowerCase() === 'ouvert') : [];
  const recentLogs = Array.isArray(cachedLogs) ? cachedLogs.slice(0, 6) : [];

  const lines = [
    `SITREP ISÈRE · ${now}`,
    '═'.repeat(50),
    '',
    `VIGILANCE MÉTÉO : ${vigilance.toUpperCase()}`,
    `COMMUNES EN CRISE : ${crises}`,
    `RISQUE GLOBAL : ${formatGlobalRiskValue(dashboard).toUpperCase()}`,
    '',
    '── ÉVÉNEMENTS OUVERTS ──────────────────────────',
    ...(openEvents.length
      ? openEvents.map((e) => `• [${String(e.status || '').toUpperCase()}] ${e.title} — ${e.address}`)
      : ['• Aucun événement ouvert.']),
    '',
    '── FIL MCO (6 dernières entrées) ───────────────',
    ...(recentLogs.length
      ? recentLogs.map((l) => {
          const at = new Date(l.event_time || l.created_at).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
          return `• ${at} [${(l.danger_level || 'vert').toUpperCase()}] ${l.description || '(sans description)'}`;
        })
      : ['• Aucune entrée MCO.']),
    '',
    '── PRÉFECTURE ISÈRE ────────────────────────────',
    ...(prefItems.length
      ? prefItems.map((i) => `• ${i.title || 'Actualité'}${i.published_at ? ` (${i.published_at})` : ''}`)
      : ['• Aucune actualité Préfecture.']),
    '',
    `Généré par CRISIS38 · Protection Civile Isère · ${now}`,
  ];
  return lines.join('\n');
}

/** Copie le SITREP dans le presse-papier et feedback visuel sur le bouton. */
async function copySitrepToClipboard() {
  const btn = document.getElementById('situation-copy-sitrep-btn');
  const text = buildSitrepText();
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      btn.textContent = '✅ Copié !';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '📋 Copier SITREP'; btn.classList.remove('copied'); }, 2500);
    }
  } catch {
    // Fallback si clipboard API non disponible
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    if (btn) {
      btn.textContent = '✅ Copié !';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '📋 Copier SITREP'; btn.classList.remove('copied'); }, 2500);
    }
  }
}

// Seuil avant d'afficher une erreur live (absorbe les micro-coupures réseau).
const _LIVE_EVENTS_ERROR_THRESHOLD = 6;

async function refreshLiveEvents() {
  if (!token || document.hidden) return;
  // Ne pas tourner si un refreshAll complet est déjà en cours — il fait le même
  // travail et va de toute façon écraser les données qu'on chargerait ici.
  if (refreshAllInFlight) return;
  return withPreservedScroll(async () => {
    try {
      const [logs, dashboard] = await Promise.all([
        // TTL court pour forcer le re-fetch à chaque cycle live tout en permettant la déduplication
        // in-flight si plusieurs appelants déclenchent la même requête simultanément.
        // bypassCache: true est intentionnellement évité ici car il viderait apiGetCache + apiInFlight.
        api('/logs', { cacheTtlMs: 30000 }),
        api('/dashboard', { cacheTtlMs: 30000 }),
      ]);

      // Succès : réinitialiser le compteur d'échecs et effacer l'erreur si elle
      // avait été posée par ce même chemin (et non par refreshAll).
      _liveEventsFailCount = 0;

      cachedLogs = keepPreviousArray(cachedLogs, logs);
      renderLogsList();

      cachedDashboardSnapshot = dashboard && typeof dashboard === 'object'
        ? {
          ...dashboard,
          latest_logs: cachedLogs.slice(0, 8),
        }
        : {
          ...(cachedDashboardSnapshot || {}),
          latest_logs: cachedLogs.slice(0, 8),
          updated_at: new Date().toISOString(),
        };
      saveSnapshot(STORAGE_KEYS.dashboardSnapshot, cachedDashboardSnapshot);

      renderSituationOverview();
      // Effacer uniquement les erreurs posées par ce chemin (préfixe connu).
      const errEl = document.getElementById('dashboard-error');
      if (errEl && (errEl.textContent || '').startsWith('Actualisation live')) {
        errEl.textContent = '';
      }
    } catch (error) {
      _liveEventsFailCount += 1;
      if (isTransientBackendError(error)) return;
      // N'afficher l'erreur qu'après le seuil d'échecs consécutifs, et
      // seulement si le dashboard-error est vide (ne pas écraser refreshAll).
      if (_liveEventsFailCount >= _LIVE_EVENTS_ERROR_THRESHOLD) {
        const errEl = document.getElementById('dashboard-error');
        if (errEl && !errEl.textContent.trim()) {
          errEl.textContent = `Actualisation live: ${sanitizeErrorMessage(error.message)}`;
        }
      }
    }
  });
}

function startLiveEventsRefresh() {
  if (liveEventsTimer) clearInterval(liveEventsTimer);
  liveEventsTimer = setInterval(refreshLiveEvents, EVENTS_LIVE_REFRESH_MS);
}

function startApiPanelAutoRefresh() {
  if (apiPanelTimer) clearInterval(apiPanelTimer);
  if (apiResyncTimer) clearInterval(apiResyncTimer);
  apiResyncTimer = setInterval(() => {
    const activePanel = localStorage.getItem(STORAGE_KEYS.activePanel);
    if (activePanel === 'api-panel') renderApiResyncClock();
  }, 15000);

  apiPanelTimer = setInterval(() => {
    const activePanel = localStorage.getItem(STORAGE_KEYS.activePanel);
    if (!token || activePanel !== 'api-panel' || document.hidden) return;
    withPreservedScroll(async () => {
      await Promise.all([loadApiInterconnections(false), loadSystemHealth()]);
    }).catch((error) => {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    });
  }, API_PANEL_REFRESH_MS);
}

function renderHomeLiveStatus(data = {}) {
  const dashboard = data?.dashboard || {};
  setRiskText('home-meteo-state', normalizeLevel(dashboard.vigilance || '-'), dashboard.vigilance || 'vert');
  setRiskText('home-river-state', normalizeLevel(dashboard.crues || '-'), dashboard.crues || 'vert');
  setRiskText('home-global-risk', formatGlobalRiskValue(dashboard), dashboard.global_risk || 'vert');
  const crisisCount = keepLastKnownCount('home_crisis_count', dashboard.communes_crise, 0);
  const seismicState = keepLastKnownStatus('home_seismic_state', data.georisques?.highest_seismic_zone_label || 'inconnue');
  const floodDocs = keepLastKnownCount('home_flood_documents_total', data.georisques?.flood_documents_total, 0);
  const itinisereStatus = keepLastKnownStatus('home_itinisere_status', data.itinisere?.status || 'inconnu');
  const itinisereEvents = keepLastKnownCount('home_itinisere_events_count', data.itinisere?.events_count, 0);

  document.getElementById('home-crisis-count').textContent = String(crisisCount);
  document.getElementById('home-seismic-state').textContent = seismicState;
  document.getElementById('home-flood-docs').textContent = String(floodDocs);

  const isereBisonDeparture = keepLastKnownStatus('home_bison_departure', data.bison_fute?.today?.isere?.departure || 'inconnu');
  const isereBisonReturn = keepLastKnownStatus('home_bison_return', data.bison_fute?.today?.isere?.return || 'inconnu');
  const homeAtmoLabel = keepLastKnownStatus('home_atmo_label', String(data.atmo_aura?.today?.label || normalizeLevel(data.atmo_aura?.today?.level || 'inconnu')).toLowerCase());

  document.getElementById('home-feature-itinisere-status').textContent = itinisereStatus;
  document.getElementById('home-feature-itinisere-events').textContent = String(itinisereEvents);
  document.getElementById('home-feature-bison-isere').textContent = `${isereBisonDeparture} / ${isereBisonReturn}`;

  setRiskText('home-indication-meteo', normalizeLevel(dashboard.vigilance || '-'), dashboard.vigilance || 'vert');
  setRiskText('home-indication-crues', normalizeLevel(dashboard.crues || '-'), dashboard.crues || 'vert');
  setRiskText('home-indication-global', formatGlobalRiskValue(dashboard), dashboard.global_risk || 'vert');
  document.getElementById('home-indication-crisis').textContent = String(crisisCount);
  document.getElementById('home-indication-seismic').textContent = seismicState;
  document.getElementById('home-indication-traffic').textContent = String(itinisereEvents);
  document.getElementById('home-indication-flood-docs').textContent = String(floodDocs);
  document.getElementById('home-indication-bison').textContent = `${isereBisonDeparture} / ${isereBisonReturn}`;
  document.getElementById('home-indication-atmo').textContent = homeAtmoLabel;
  document.getElementById('home-indication-itinisere').textContent = `${itinisereStatus} · ${itinisereEvents} évén.`;

  renderHomeMeteoSituation(data.meteo_france?.current_situation || []);

  const updatedLabel = data?.updated_at ? new Date(data.updated_at).toLocaleString() : 'inconnue';
  document.getElementById('home-live-updated').textContent = `Dernière mise à jour: ${updatedLabel}`;
}

async function loadHomeLiveStatus() {
  return withPreservedScroll(async () => {
    try {
      if (!Object.keys(cachedHomeLiveSnapshot).length) {
        const snapshot = readSnapshot(STORAGE_KEYS.homeLiveSnapshot);
        if (snapshot && typeof snapshot === 'object') {
          cachedHomeLiveSnapshot = snapshot;
          renderHomeLiveStatus(cachedHomeLiveSnapshot);
        }
      }

      const data = await api('/public/live', {
        logoutOn401: false,
        omitAuth: true,
        cacheTtlMs: 0,
        bypassCache: true,
      });

      cachedHomeLiveSnapshot = mergeHomeLiveSnapshot(cachedHomeLiveSnapshot, data);
      renderHomeLiveStatus(cachedHomeLiveSnapshot);
      saveSnapshot(STORAGE_KEYS.homeLiveSnapshot, cachedHomeLiveSnapshot);
      document.getElementById('home-live-error').textContent = '';
    } catch (error) {
      document.getElementById('home-live-error').textContent = error.message;
    }
  });
}

function startHomeLiveRefresh() {
  if (homeLiveTimer) clearInterval(homeLiveTimer);
  loadHomeLiveStatus();
  homeLiveTimer = setInterval(loadHomeLiveStatus, HOME_LIVE_REFRESH_MS);
}

function hydrateAppFromSnapshots() {
  const dashboard = readSnapshot(STORAGE_KEYS.dashboardSnapshot);
  if (dashboard && typeof dashboard === 'object') {
    cachedDashboardSnapshot = dashboard;
    renderDashboard(dashboard);
  }

  const externalRisks = readSnapshot(STORAGE_KEYS.externalRisksSnapshot);
  if (externalRisks && typeof externalRisks === 'object') {
    cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, externalRisks);
    renderExternalRisks(cachedExternalRisksSnapshot);
    renderApiInterconnections(cachedExternalRisksSnapshot);
  }

  const events = readSnapshot(STORAGE_KEYS.eventsSnapshot);
  if (Array.isArray(events)) cachedEvents = events;

  const logs = readSnapshot(STORAGE_KEYS.logsSnapshot);
  if (Array.isArray(logs)) cachedLogs = logs;

  if (Array.isArray(cachedEvents) && cachedEvents.length && !selectedOperationalEventId) {
    const firstOpen = sortOperationalEvents(cachedEvents).find((event) => String(event.status || '').toLowerCase() !== 'clos');
    if (firstOpen) selectedOperationalEventId = String(firstOpen.id);
  }
  refreshMcoViews();
}

async function initializeAuthenticatedSession({ runRefreshInBackground = false } = {}) {
  document.getElementById('current-role').textContent = roleLabel(currentUser.role);
  document.getElementById('current-commune').textContent = currentUser.municipality_name || 'Toutes';
  applyRoleVisibility();
  // Show audit button for admins only
  const _auditMenuBtn = document.getElementById('menu-audit-btn');
  if (_auditMenuBtn) {
    if (currentUser.role === 'admin') { _auditMenuBtn.classList.remove('hidden'); _auditMenuBtn.hidden = false; }
    else { _auditMenuBtn.classList.add('hidden'); _auditMenuBtn.hidden = true; }
  }
  _updateNotifBtn();
  showApp();
  buildServiceCards();
  hydrateAppFromSnapshots();
  initMobileNav();
  initMobileGeoLocate();
  startAgentMarkersPolling();
  renderSituationOverview();
  setActivePanel(localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel');
  syncMobileNavWithPanel();
  renderStations(cachedVigicruesPayload);
  syncLogScopeFields();
  syncLogOtherFields();
  prefillEventTime();

  const refreshPromise = refreshAll().catch((error) => {
    document.getElementById('dashboard-error').textContent = `Actualisation différée: ${sanitizeErrorMessage(error.message)}`;
  });

  if (!runRefreshInBackground) await refreshPromise;

  startAutoRefresh();
  startStationTimetableRefresh();
  startLiveEventsRefresh();
  startExternalRisksSSE();
  startLiveClock();
  startDataFreshnessIndicator();
}

// Efface l'erreur de login dès que l'utilisateur recommence à taper
['login-username', 'login-password'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => { setLoginError(''); _setLoginStatus(''); });
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isLoginSubmitting) return;
  isLoginSubmitting = true;
  setLoginError('');
  _setLoginSubmitting(true);

  const form = new FormData(loginForm);
  const username = String(form.get('username') || '').trim();
  const password = String(form.get('password') || '');

  // Tentatives : 1 retry automatique sur erreur réseau/timeout (pas sur 401/403)
  const MAX_LOGIN_ATTEMPTS = 2;
  let lastError = null;

  for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      _setLoginStatus('Reconnexion en cours… (tentative 2/2)');
      await wait(800);
    } else {
      _setLoginStatus('Connexion en cours…');
    }

    try {
      const payload = new URLSearchParams({ username, password });
      const result = await api('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload,
        logoutOn401: false,
        omitAuth: true,
        highPriority: true,
        timeoutMs: LOGIN_REQUEST_TIMEOUT_MS,
        maxRetries: 0,  // géré manuellement ici
      });

      _setLoginStatus('');
      token = result.access_token;
      clearApiCache();
      localStorage.setItem(STORAGE_KEYS.token, token);
      pendingCurrentPassword = password;
      currentUser = result.user;

      if (result.must_change_password) {
        setVisibility(loginForm, false);
        setVisibility(passwordForm, true);
        isLoginSubmitting = false;
        _setLoginSubmitting(false);
        return;
      }

      await initializeAuthenticatedSession({ runRefreshInBackground: true });
      isLoginSubmitting = false;
      _setLoginSubmitting(false);
      return;

    } catch (error) {
      lastError = error;
      // Ne pas retenter si c'est une erreur d'authentification (mauvais mdp)
      const isAuthError = error?.status === 401 || error?.status === 403;
      if (isAuthError) break;
      // Retenter sur timeout, erreur réseau, ou réponse HTML (nginx 502 au démarrage)
      const msg = String(error?.message || '');
      const isRetryable = error?.isTimeout
        || isNetworkFetchError(error)
        || msg.includes('non-JSON')
        || msg.includes('HTML')
        || error?.status === 502
        || error?.status === 503
        || error?.status === 504;
      if (!isRetryable) break;
    }
  }

  _setLoginStatus('');
  setLoginError(lastError?.message || 'Connexion impossible', buildLoginDebugDetails(lastError, username));
  isLoginSubmitting = false;
  _setLoginSubmitting(false);
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  document.getElementById('password-error').textContent = '';
  const form = new FormData(passwordForm);
  try {
    await api('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: pendingCurrentPassword, new_password: String(form.get('new_password')) }),
    });
    setVisibility(passwordForm, false);
    setVisibility(loginForm, true);
    setLoginError('Mot de passe modifié. Reconnectez-vous.');
  } catch (error) {
    document.getElementById('password-error').textContent = error.message;
  }
});


async function fetchMunicipalitiesByPostalCode(postalCode) {
  const code = String(postalCode || '').trim();
  if (!/^\d{5}$/.test(code)) return [];
  const response = await queueApiRequest(() => fetchWithTimeout(`https://geo.api.gouv.fr/communes?codePostal=${encodeURIComponent(code)}&fields=nom,code,population&boost=population`));
  const payload = await parseJsonResponse(response, 'geo-api-commune-by-postal-code');
  if (!Array.isArray(payload) || !payload.length) return [];
  return payload
    .map((commune) => ({
      name: String(commune?.nom || '').trim(),
      insee_code: String(commune?.code || '').trim(),
      population: Number(commune?.population || 0) || null,
    }))
    .filter((commune) => commune.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
}

function setMunicipalityLookupOptions(formEl, municipalities = [], selectedName = '') {
  const select = formEl?.elements?.municipality_lookup;
  if (!select) return;
  const items = Array.isArray(municipalities) ? municipalities : [];
  const normalizedSelected = String(selectedName || '').trim().toLowerCase();
  const options = ['<option value="">Ville trouvée via code postal</option>'].concat(
    items.map((municipality) => {
      const isSelected = normalizedSelected && municipality.name.toLowerCase() === normalizedSelected;
      const populationSuffix = municipality.population ? ` (${Number(municipality.population).toLocaleString('fr-FR')} hab.)` : '';
      return `<option value="${escapeHtml(municipality.name)}" data-insee="${escapeHtml(municipality.insee_code || '')}" data-population="${escapeHtml(String(municipality.population ?? ''))}"${isSelected ? ' selected' : ''}>${escapeHtml(municipality.name)}${populationSuffix}</option>`;
    }),
  );
  select.innerHTML = options.join('');
  select.disabled = items.length === 0;
}

function applyMunicipalityLookupSelection(formEl, selection = null) {
  if (!formEl || !selection) return;
  const nameInput = formEl.elements.name;
  const inseeInput = formEl.elements.insee_code;
  const populationInput = formEl.elements.population;
  if (nameInput) nameInput.value = selection.name || '';
  if (inseeInput) inseeInput.value = selection.insee_code || '';
  if (populationInput && (selection.population != null || !String(populationInput.value || '').trim())) {
    populationInput.value = selection.population ?? '';
  }
}

async function autofillMunicipalityFromPostalCode(formEl) {
  if (!formEl) return;
  const postalInput = formEl.elements.postal_code;
  const nameInput = formEl.elements.name;
  const inseeInput = formEl.elements.insee_code;
  const populationInput = formEl.elements.population;
  const postalCode = String(postalInput?.value || '').trim();
  if (!/^\d{5}$/.test(postalCode)) {
    setMunicipalityLookupOptions(formEl, []);
    return;
  }

  try {
    const municipalities = await fetchMunicipalitiesByPostalCode(postalCode);
    const currentName = String(nameInput?.value || '').trim();
    setMunicipalityLookupOptions(formEl, municipalities, currentName);
    if (!municipalities.length) return;

    const preferred = municipalities.find((municipality) => municipality.name.toLowerCase() === currentName.toLowerCase())
      || (municipalities.length === 1 ? municipalities[0] : null);
    if (preferred) {
      applyMunicipalityLookupSelection(formEl, preferred);
      if (formEl.elements.municipality_lookup) formEl.elements.municipality_lookup.value = preferred.name;
    } else {
      if (inseeInput && !currentName) inseeInput.value = '';
      if (populationInput && !currentName) populationInput.value = '';
    }
  } catch (error) {
    // silence: user can still enter values manually
  }
}

function bindMunicipalityLookup(formId) {
  const formEl = document.getElementById(formId);
  const lookupSelect = formEl?.elements?.municipality_lookup;
  if (!formEl || !lookupSelect) return;
  lookupSelect.addEventListener('change', () => {
    const selectedOption = lookupSelect.options[lookupSelect.selectedIndex];
    if (!selectedOption || !selectedOption.value) return;
    const rawPopulation = selectedOption.getAttribute('data-population') || '';
    const numericPopulation = Number(rawPopulation);
    applyMunicipalityLookupSelection(formEl, {
      name: selectedOption.value,
      insee_code: selectedOption.getAttribute('data-insee') || '',
      population: Number.isFinite(numericPopulation) && numericPopulation > 0 ? numericPopulation : null,
    });
  });
}

document.getElementById('municipality-form')?.elements?.postal_code?.addEventListener('change', async (event) => {
  await autofillMunicipalityFromPostalCode(event.target?.form);
});

document.getElementById('municipality-form')?.elements?.postal_code?.addEventListener('blur', async (event) => {
  await autofillMunicipalityFromPostalCode(event.target?.form);
});

document.getElementById('municipality-edit-form')?.elements?.postal_code?.addEventListener('change', async (event) => {
  await autofillMunicipalityFromPostalCode(event.target?.form);
});

document.getElementById('municipality-edit-form')?.elements?.postal_code?.addEventListener('blur', async (event) => {
  await autofillMunicipalityFromPostalCode(event.target?.form);
});

bindMunicipalityLookup('municipality-form');
bindMunicipalityLookup('municipality-edit-form');

document.getElementById('municipality-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!canEdit()) return;
  const form = new FormData(event.target);
  const errorTarget = document.getElementById('dashboard-error');
  try {
    await api('/municipalities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.get('name'),
        manager: (form.get('name') || '').trim(),
        phone: form.get('phone'),
        email: form.get('email'),
        postal_code: form.get('postal_code'),
        insee_code: form.get('insee_code') || null,
        contacts: form.get('contacts'),
        additional_info: form.get('additional_info'),
        population: Number(form.get('population') || 0) || null,
        shelter_capacity: Number(form.get('shelter_capacity') || 0) || null,
      }),
    });
    event.target.reset();
    setMunicipalityLookupOptions(event.target, []);
    if (errorTarget) errorTarget.textContent = '';
    document.getElementById('municipality-feedback').textContent = 'Commune créée avec succès. Vous pouvez maintenant lancer des actions depuis la fiche.';
    await loadMunicipalities();
  } catch (error) {
    if (errorTarget) errorTarget.textContent = sanitizeErrorMessage(error.message);
  }
});

document.getElementById('log-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!canEdit()) return;
  const form = new FormData(event.target);
  const errorTarget = document.getElementById('dashboard-error');
  await ensureLogMunicipalitiesLoaded();
  try {
    const payload = {
      event_id: selectedOperationalEventId ? Number(selectedOperationalEventId) : null,
      event_type: null,
      description: form.get('description') || null,
      danger_level: form.get('danger_level') || 'vert',
      danger_emoji: LOG_LEVEL_EMOJI[form.get('danger_level') || 'vert'] || '🟢',
      status: 'nouveau',
      target_scope: form.get('target_scope'),
      municipality_id: form.get('municipality_id') ? Number(form.get('municipality_id')) : null,
      location: form.get('location') || null,
      source: form.get('source') || null,
      assigned_to: form.get('assigned_to') || null,
      next_update_due: form.get('next_update_due') || null,
      actions_taken: form.get('actions_taken') || null,
      event_time: form.get('event_time') || new Date().toISOString(),
    };
    const editingLogId = event.target.dataset.editLogId;
    let savedLog = null;
    if (editingLogId) {
      savedLog = await api(`/logs/${editingLogId}`, {
        method: 'PUT',
        highPriority: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      savedLog = await api('/logs', {
        method: 'POST',
        highPriority: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    event.target.reset();
    resetLogFormState();
    if (errorTarget) errorTarget.textContent = '';
    syncLogScopeFields();
    upsertCachedLog(savedLog);
  } catch (error) {
    if (errorTarget) errorTarget.textContent = sanitizeErrorMessage(error.message);
  }
});

document.getElementById('event-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!canEdit()) return;
  const form = new FormData(event.target);
  const errorTarget = document.getElementById('dashboard-error');
  try {
    const createdEvent = await api('/events', {
      method: 'POST',
      highPriority: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.get('title'),
        address: form.get('address'),
        status: 'ouvert',
        municipality_id: form.get('municipality_id') ? Number(form.get('municipality_id')) : null,
      }),
    });
    event.target.reset();
    if (errorTarget) errorTarget.textContent = '';
    selectedOperationalEventId = createdEvent?.id ? String(createdEvent.id) : selectedOperationalEventId;
    upsertCachedEvent(createdEvent);
  } catch (error) {
    if (errorTarget) errorTarget.textContent = sanitizeErrorMessage(error.message);
  }
});

(function initNetworkOfflineBanner() {
  const banner = document.getElementById('network-offline-banner');
  if (!banner) return;
  function update() {
    banner.classList.toggle('visible', !navigator.onLine);
  }
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
})();

(async function bootstrap() {
  // Purger seulement les caches statiques/volumineux. Les snapshots opérationnels
  // restent disponibles pour afficher l'accueil immédiatement pendant le refresh.
  [
    'mapPointsCache', 'municipalitiesCache',
    'staticInstitutionsCacheV3', 'staticFinessCacheV3', 'staticTelecomCacheV1',
    'staticMontagneCacheV1', 'staticHelipadCacheV1', 'staticBarrageCacheV1',
  ].forEach((k) => { try { localStorage.removeItem(k); } catch (_) {} });

  _loadGeocodeCache();
  bindAppInteractions();
  startApiPanelAutoRefresh();
  // Sur mobile, `visibilitychange` et `focus` se déclenchent ensemble quand on
  // déverrouille l'écran. On déduplique avec un court debounce et on recharge
  // seulement la page active, jamais tous les flux externes.
  const _REFRESH_DEBOUNCE_MS = 500;
  const _MIN_REFRESH_INTERVAL_MS = 30000;
  let _visibilityDebounceTimer = null;
  function _scheduleVisibilityRefresh() {
    if (!token) return;
    clearTimeout(_visibilityDebounceTimer);
    _visibilityDebounceTimer = setTimeout(() => {
      if (Date.now() - _lastRefreshAllTs < _MIN_REFRESH_INTERVAL_MS) return;
      refreshActivePanelData().catch(() => {});
      _lastRefreshAllTs = Date.now();
    }, _REFRESH_DEBOUNCE_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    _scheduleVisibilityRefresh();
  });
  window.addEventListener('focus', _scheduleVisibilityRefresh);

  // Afficher le formulaire de login immédiatement — pas de blanc d'écran.
  // Si un token existe, on tente une restauration silencieuse en arrière-plan.
  if (!token) {
    showLogin();
    return;
  }

  // Token présent : montrer le login avec un message discret pendant la vérification.
  showLogin();
  _setLoginStatus('Vérification de la session…');

  try {
    // 1 seule tentative, timeout court — on ne bloque pas l'utilisateur.
    // Si le serveur est lent au démarrage, l'utilisateur peut se connecter manuellement.
    currentUser = await api('/auth/me', {
      timeoutMs: SESSION_RESTORE_TIMEOUT_MS,
      maxRetries: 0,
    });
    _setLoginStatus('');
    await initializeAuthenticatedSession({ runRefreshInBackground: true });
  } catch (error) {
    _setLoginStatus('');
    if (Number(error?.status) === 401) {
      // Token expiré — nettoyage silencieux
      localStorage.removeItem(STORAGE_KEYS.token);
      token = null;
    }
    // Toute autre erreur (réseau, HTML 502, timeout) : login déjà visible, rien à faire.
    // Ne pas afficher de message d'erreur — l'utilisateur peut simplement se connecter.
  }
})();

/* ═══════════════════════════════════════════════════════════════════════════
   NOTIFICATIONS DISCORD — MULTI-RÈGLES
   ═══════════════════════════════════════════════════════════════════════════ */

const _NOTIF_SERVICES = [
  { key: 'meteo_france',          label: 'Météo-France',               icon: '⛅', cat: 'Météo' },
  { key: 'apic_isere',            label: 'APIC · Pluie intense',       icon: '🌧️', cat: 'Météo' },
  { key: 'vigicrues',             label: 'Vigicrues',                  icon: '🌊', cat: 'Eau' },
  { key: 'vigicrues_flash_isere', label: 'Vigicrues Flash',            icon: '⚡', cat: 'Eau' },
  { key: 'vigieau',               label: 'Vigieau · Restrictions eau', icon: '💧', cat: 'Eau' },
  { key: 'atmo_aura',             label: "Atmo AURA · Qualité de l'air", icon: '🌫️', cat: 'Environnement' },
  { key: 'itinisere',             label: 'Itinisère · Transports',     icon: '🚌', cat: 'Transport' },
  { key: 'autoroutes_isere',      label: 'Autoroutes Isère',           icon: '🛣️', cat: 'Transport' },
  { key: 'sncf_isere',            label: 'SNCF Isère',                 icon: '🚆', cat: 'Transport' },
  { key: 'ter_aura',              label: 'TER SNCF · AURA',            icon: '🚄', cat: 'Transport' },
  { key: 'mreseau',               label: 'M Réseau · Grenoble',        icon: '🚊', cat: 'Transport' },
  { key: 'cars_region_aura',      label: 'Cars Région · AURA',         icon: '🚐', cat: 'Transport' },
  { key: 'prefecture_isere',      label: 'Préfecture Isère',           icon: '🏛️', cat: 'Actualités', notifyOnNew: true },
  { key: 'france_bleu_isere',     label: 'France Bleu Isère',          icon: '📻', cat: 'Actualités' },
];

const _NOTIF_LEVELS = [
  { value: 'jaune',  label: '🟡 Jaune (tout)' },
  { value: 'orange', label: '🟠 Orange et +' },
  { value: 'rouge',  label: '🔴 Rouge uniquement' },
];

// État local
let _notifRules = [];

function _notifToast(msg, type = 'info') {
  const el = document.getElementById('notif-toast');
  if (!el) return;
  const colors = { success: '#e8f5e9', error: '#ffebee', info: '#e3f2fd' };
  const borders = { success: '#a5d6a7', error: '#ef9a9a', info: '#90caf9' };
  const textc   = { success: '#2e7d32', error: '#c62828', info: '#1565c0' };
  el.innerHTML = `<div style="padding:.55rem .9rem;border-radius:8px;font-size:.85rem;font-weight:500;
    background:${colors[type]||colors.info};border:1px solid ${borders[type]||borders.info};
    color:${textc[type]||textc.info}">${escapeHtml(msg)}</div>`;
  setTimeout(() => { if (el) el.innerHTML = ''; }, 5000);
}

// ── Rendu de la liste des règles ──────────────────────────────────────────

function _notifRenderRules() {
  const container = document.getElementById('notif-rules-list');
  if (!container) return;
  if (!_notifRules.length) {
    container.innerHTML = `<div class="notif-empty-state">
      <div style="font-size:2.2rem;margin-bottom:.5rem">🔔</div>
      <p style="font-weight:600;margin-bottom:.25rem">Aucune notification configurée</p>
      <p style="font-size:.85rem;color:#888">Cliquez sur <strong>+ Nouvelle notification</strong> pour commencer.</p>
    </div>`;
    return;
  }
  container.innerHTML = _notifRules.map(r => _notifRuleCardHtml(r)).join('');
}

function _notifRuleCardHtml(rule) {
  const id = rule.id;
  const webhookDisplay = rule.discord_webhook
    ? rule.discord_webhook.replace('https://discord.com/api/webhooks/', 'webhooks/…/').substring(0, 38) + '…'
    : 'Aucun webhook configuré';
  const svcs = rule.services || {};
  const activeSvcCount = Object.values(svcs).filter(s => s && s.enabled).length;
  const enabledBadge = rule.enabled
    ? '<span class="notif-badge notif-badge--on">● Actif</span>'
    : '<span class="notif-badge notif-badge--off">○ Inactif</span>';

  const svcRows = _NOTIF_SERVICES.map(svc => {
    const cfg = svcs[svc.key] || {};
    const checked = cfg.enabled ? 'checked' : '';
    const thresholdCell = svc.notifyOnNew
      ? `<span style="display:inline-flex;align-items:center;gap:.3rem;font-size:.78rem;padding:.2rem .45rem;border-radius:999px;background:#edf3ff;color:#1a3568;font-weight:600">🆕 Nouvelle actualité</span>
         <input type="hidden" data-svc-key="${escapeHtml(svc.key)}" class="nrs-threshold" value="jaune" />`
      : `<select data-svc-key="${escapeHtml(svc.key)}" class="nrs-threshold"
          style="font-size:.78rem;padding:.2rem .35rem;border:1.5px solid #d1d9e0;border-radius:6px;background:#fff">${_NOTIF_LEVELS.map(l =>
            `<option value="${l.value}" ${cfg.threshold === l.value ? 'selected' : ''}>${l.label}</option>`
          ).join('')}</select>`;
    return `<tr>
      <td style="padding:.35rem .5rem;font-size:.83rem">${svc.icon} ${escapeHtml(svc.label)}</td>
      <td style="padding:.35rem .5rem">${thresholdCell}</td>
      <td style="padding:.35rem .5rem;text-align:center">
        <input type="checkbox" data-svc-key="${escapeHtml(svc.key)}" class="nrs-svc-chk" ${checked} />
      </td>
    </tr>`;
  }).join('');

  const qh = rule.quiet_hours || {};
  const qChecked = qh.enabled ? 'checked' : '';
  const cooldown = rule.cooldown_minutes || 60;

  // Tous les boutons utilisent data-action + data-rule-id pour la délégation d'événements
  return `<div class="notif-rule-card" data-rule-id="${escapeHtml(id)}">
    <div class="notif-rule-head" data-action="toggle-card" data-rule-id="${escapeHtml(id)}">
      <span class="notif-rule-icon">🔔</span>
      <div class="notif-rule-meta">
        <div class="notif-rule-name">${escapeHtml(rule.name || 'Notification')}</div>
        <div class="notif-rule-url">${escapeHtml(webhookDisplay)}</div>
      </div>
      <span style="font-size:.78rem;color:#888;white-space:nowrap">${activeSvcCount} service(s)</span>
      ${enabledBadge}
      <button class="ghost notif-action-btn" data-action="toggle-enabled" data-rule-id="${escapeHtml(id)}"
        style="font-size:.78rem;padding:.25rem .6rem">${rule.enabled ? 'Désactiver' : 'Activer'}</button>
      <button class="notif-delete-btn" data-action="delete" data-rule-id="${escapeHtml(id)}"
        title="Supprimer">🗑️</button>
      <span class="notif-chevron">▼</span>
    </div>
    <div class="notif-rule-body">
      <div class="form notif-field-row">
        <label style="flex:1">Nom de la notification
          <input type="text" class="nrb-name" value="${escapeHtml(rule.name || '')}" placeholder="Ex: Alertes critiques" />
        </label>
      </div>
      <div class="form notif-field-row">
        <label style="flex:1">URL du Webhook Discord
          <input type="url" class="nrb-webhook" value="${escapeHtml(rule.discord_webhook || '')}"
            placeholder="https://discord.com/api/webhooks/..." style="font-size:.82rem" />
        </label>
        <button type="button" class="nrb-test-btn" data-action="test-webhook"
          style="background:#5865f2;color:#fff;border:none;padding:.5rem .9rem;border-radius:8px;font-weight:600;cursor:pointer;font-size:.85rem;white-space:nowrap;align-self:flex-end">📤 Tester</button>
      </div>
      <div class="notif-field-row" style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:.75rem">
        <label style="min-width:200px">Cooldown entre 2 alertes (min)
          <input type="number" class="nrb-cooldown" value="${cooldown}" min="5" max="1440"
            style="width:100px;display:block;margin-top:.25rem" />
        </label>
        <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;background:#f7f9fc;border:1px solid #e4e7eb;border-radius:8px;padding:.5rem .75rem">
          <span style="font-size:.83rem;font-weight:600">🌙 Heures silencieuses :</span>
          <label style="display:flex;align-items:center;gap:.35rem;margin:0;cursor:pointer;font-size:.82rem">
            <input type="checkbox" class="nrb-quiet-enabled" ${qChecked} /> Activer
          </label>
          <span style="font-size:.82rem;color:#666">De</span>
          <input type="time" class="nrb-quiet-start" value="${escapeHtml(qh.start || '22:00')}"
            style="width:95px;padding:.28rem .45rem;border:1.5px solid #d1d9e0;border-radius:6px;font-size:.82rem" />
          <span style="font-size:.82rem;color:#666">à</span>
          <input type="time" class="nrb-quiet-end" value="${escapeHtml(qh.end || '07:00')}"
            style="width:95px;padding:.28rem .45rem;border:1.5px solid #d1d9e0;border-radius:6px;font-size:.82rem" />
        </div>
      </div>
      <div style="margin-bottom:.75rem">
        <div style="font-size:.82rem;font-weight:600;color:#1a3568;margin-bottom:.4rem">Services à surveiller :</div>
        <div style="border:1px solid #e4e7eb;border-radius:8px;overflow:hidden;max-height:320px;overflow-y:auto">
          <table style="width:100%;border-collapse:collapse">
            <thead style="background:#f4f6fb;position:sticky;top:0">
              <tr>
                <th style="text-align:left;padding:.35rem .5rem;font-size:.78rem;font-weight:600;color:#5f7190">Service</th>
                <th style="text-align:left;padding:.35rem .5rem;font-size:.78rem;font-weight:600;color:#5f7190">Seuil minimum</th>
                <th style="text-align:center;padding:.35rem .5rem;font-size:.78rem;font-weight:600;color:#5f7190">Actif</th>
              </tr>
            </thead>
            <tbody>${svcRows}</tbody>
          </table>
        </div>
      </div>
      <div style="display:flex;gap:.5rem">
        <button data-action="save" data-rule-id="${escapeHtml(id)}">💾 Enregistrer</button>
      </div>
    </div>
  </div>`;
}

function _notifCollectFromBody(body) {
  const name = (body.querySelector('.nrb-name')?.value || '').trim() || 'Notification';
  const webhook = (body.querySelector('.nrb-webhook')?.value || '').trim();
  const cooldown = parseInt(body.querySelector('.nrb-cooldown')?.value) || 60;
  const quietEnabled = !!(body.querySelector('.nrb-quiet-enabled')?.checked);
  const quietStart = body.querySelector('.nrb-quiet-start')?.value || '22:00';
  const quietEnd = body.querySelector('.nrb-quiet-end')?.value || '07:00';
  const services = {};
  body.querySelectorAll('.nrs-svc-chk').forEach(cb => {
    const key = cb.dataset.svcKey;
    const sel = body.querySelector(`.nrs-threshold[data-svc-key="${key}"]`);
    services[key] = { enabled: cb.checked, threshold: sel ? sel.value : 'orange' };
  });
  return { name, discord_webhook: webhook, cooldown_minutes: cooldown,
    quiet_hours: { enabled: quietEnabled, start: quietStart, end: quietEnd }, services };
}

async function _notifLoad() {
  try {
    const data = await api('/api/notifications');
    _notifRules = (data || {}).rules || [];
    _notifRenderRules();
  } catch(e) {
    _notifToast('Impossible de charger les notifications : ' + (e.message || e), 'error');
    _notifRenderRules();
  }
}

async function _notifCreateNew() {
  const btn = document.getElementById('notif-new-btn');
  if (btn) btn.disabled = true;
  try {
    const rule = await api('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nouvelle notification', enabled: true,
        discord_webhook: '', cooldown_minutes: 60,
        quiet_hours: { enabled: false, start: '22:00', end: '07:00' }, services: {} }),
    });
    _notifRules.push(rule);
    _notifRenderRules();
    // Auto-expand la nouvelle carte
    setTimeout(() => {
      const card = document.querySelector(`.notif-rule-card[data-rule-id="${rule.id}"]`);
      if (card) { card.classList.add('expanded'); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    }, 50);
  } catch(e) {
    _notifToast('Erreur création : ' + (e.message || e), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function _notifSaveRule(ruleId, body) {
  const payload = _notifCollectFromBody(body);
  const rule = _notifRules.find(r => r.id === ruleId);
  payload.enabled = rule ? rule.enabled : true;
  try {
    const updated = await api(`/api/notifications/${ruleId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const idx = _notifRules.findIndex(r => r.id === ruleId);
    if (idx >= 0) _notifRules[idx] = updated;
    _notifRenderRules();
    // Ré-expand la carte sauvegardée
    setTimeout(() => {
      const card = document.querySelector(`.notif-rule-card[data-rule-id="${updated.id}"]`);
      if (card) card.classList.add('expanded');
    }, 50);
    _notifToast('✅ Notification enregistrée', 'success');
  } catch(e) {
    _notifToast('Erreur sauvegarde : ' + (e.message || e), 'error');
  }
}

async function _notifToggleEnabled(ruleId) {
  const rule = _notifRules.find(r => r.id === ruleId);
  if (!rule) return;
  try {
    const updated = await api(`/api/notifications/${ruleId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...rule, enabled: !rule.enabled }),
    });
    const idx = _notifRules.findIndex(r => r.id === ruleId);
    if (idx >= 0) _notifRules[idx] = updated;
    _notifRenderRules();
  } catch(e) {
    _notifToast('Erreur : ' + (e.message || e), 'error');
  }
}

async function _notifDelete(ruleId) {
  if (!confirm('Supprimer cette notification définitivement ?')) return;
  try {
    await api(`/api/notifications/${ruleId}`, { method: 'DELETE' });
    _notifRules = _notifRules.filter(r => r.id !== ruleId);
    _notifRenderRules();
    _notifToast('Notification supprimée', 'success');
  } catch(e) {
    _notifToast('Erreur suppression : ' + (e.message || e), 'error');
  }
}

async function _notifTestInCard(btn) {
  const body = btn.closest('.notif-rule-body');
  const webhook = (body?.querySelector('.nrb-webhook')?.value || '').trim();
  if (!webhook) { _notifToast('Renseignez l\'URL du webhook Discord', 'error'); return; }
  const origText = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Envoi…';
  try {
    const r = await api('/api/notifications/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook_url: webhook }),
    });
    if (r.success) _notifToast('✅ Message test envoyé — vérifiez votre canal Discord', 'success');
    else _notifToast('❌ Échec : ' + (r.detail || 'Erreur inconnue'), 'error');
  } catch(e) {
    _notifToast('Erreur : ' + (e.message || e), 'error');
  } finally {
    btn.disabled = false; btn.textContent = origText;
  }
}

async function _notifLoadLog() {
  const el = document.getElementById('notif-log-list');
  if (!el) return;
  try {
    const data = await api('/api/notifications/log');
    const entries = (data || {}).entries || [];
    if (!entries.length) { el.innerHTML = '<div class="muted" style="padding:.75rem">Aucune notification envoyée pour l\'instant.</div>'; return; }
    const LVL_EM = { rouge: '🔴', orange: '🟠', jaune: '🟡', vert: '🟢' };
    el.innerHTML = entries.map(e => {
      const em = LVL_EM[e.level] || 'ℹ️';
      const ok = e.success ? '✅' : '❌';
      let dateStr = '';
      try { dateStr = new Date(e.sent_at).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }); } catch {}
      return `<div style="display:flex;gap:.6rem;align-items:flex-start;padding:.5rem .6rem;border-bottom:1px solid #f0f2f5">
        <span>${em}</span>
        <div style="flex:1">
          ${e.rule_name ? `<span style="font-size:.72rem;background:#edf3ff;color:#2e5c96;border-radius:4px;padding:.1rem .35rem;margin-right:.35rem">${escapeHtml(e.rule_name)}</span>` : ''}
          <span style="font-weight:500">${escapeHtml(e.label || e.service)}</span>
          <span style="color:#999;font-size:.76rem;margin-left:.5rem">${escapeHtml(dateStr)} ${ok}</span>
          ${e.detail ? `<div style="color:#777;font-size:.77rem">${escapeHtml(e.detail)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    el.innerHTML = '<div class="muted">Journal indisponible</div>';
  }
}

// Délégation d'événements sur le conteneur des règles
// (fonctionne même avec le HTML généré dynamiquement)
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const panel = document.getElementById('notifications-panel');
  if (!panel || !panel.contains(el)) return;

  const action = el.dataset.action;
  const ruleId = el.dataset.ruleId;

  if (action === 'toggle-card') {
    const card = document.querySelector(`.notif-rule-card[data-rule-id="${ruleId}"]`);
    if (card) card.classList.toggle('expanded');
    return;
  }
  if (action === 'toggle-enabled') {
    e.stopPropagation();
    _notifToggleEnabled(ruleId);
    return;
  }
  if (action === 'delete') {
    e.stopPropagation();
    _notifDelete(ruleId);
    return;
  }
  if (action === 'save') {
    const body = el.closest('.notif-rule-body');
    if (body) _notifSaveRule(ruleId, body);
    return;
  }
  if (action === 'test-webhook') {
    _notifTestInCard(el);
    return;
  }
});

// Journal
document.addEventListener('click', (e) => {
  if (e.target.id === 'notif-log-refresh-btn') _notifLoadLog();
});

// Force-refresh d'un service individuel (panel API Interconnexions)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="force-refresh-service"]');
  if (!btn) return;
  e.stopPropagation();
  const key = btn.dataset.serviceKey;
  if (!key) return;
  _forceRefreshService(key, btn);
});

async function _forceRefreshService(serviceKey, btn) {
  if (btn.classList.contains('flux-force-btn--loading')) return;
  btn.classList.add('flux-force-btn--loading');
  btn.disabled = true;
  const row = btn.closest('.flux-row');
  if (row) row.classList.add('flux-row--refreshing');
  try {
    await _requestServiceRefreshAndReload(serviceKey);
  } catch (_) {
    // silencieux — l'erreur sera visible dans le statut du service
  } finally {
    btn.classList.remove('flux-force-btn--loading');
    btn.disabled = false;
    if (row) row.classList.remove('flux-row--refreshing');
  }
}

// Les notifications navigateur sont volontairement désactivées: les alertes
// applicatives restent visibles dans l'interface et les notifications Discord.
let notificationsEnabled = false;
function checkServiceAlertsFromSnapshot() {}
function _updateNotifBtn() {
  const btn = document.getElementById('notif-permission-btn');
  if (!btn) return;
  notificationsEnabled = false;
  btn.hidden = true;
  btn.classList.add('hidden');
  btn.style.display = 'none';
}
(function initNotifBtn() { _updateNotifBtn(); })();

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 11 — Copernicus EMS widget
// ════════════════════════════════════════════════════════════════════════════

function renderCopernicusEmsWidget(data = {}) {
  const france = data.france_total ?? 0;
  const total = data.activations_total ?? 0;
  const level = france > 0 ? 'orange' : total > 0 ? 'jaune' : 'vert';
  setRiskText('copernicus-svc-status', `${france} événement(s) France · ${total} Europe`, level);
  const _gdacsTypeIcon = { FL: '🌊', EQ: '🌍', TC: '🌀', VO: '🌋', WF: '🔥', DR: '🏜️', TS: '🌊', LS: '⛰️' };
  const alertColors = { Red: '#c92a2a', Orange: '#e67700', Green: '#2b8a3e' };
  const items = Array.isArray(data.france_activations) && data.france_activations.length
    ? data.france_activations
    : (Array.isArray(data.activations) ? data.activations.slice(0, 10) : []);
  setHtml('copernicus-svc-list', items.map((a) => {
    const icon = _gdacsTypeIcon[a.type] || '⚠️';
    const color = alertColors[a.level] || '#868e96';
    const country = a.country ? ` · ${escapeHtml(a.country)}` : '';
    const typeLabel = a.type_label ? ` <span class="muted">[${escapeHtml(a.type_label)}]</span>` : '';
    return `<li>${icon}${typeLabel} <strong>${escapeHtml(a.title || a.id || '?')}</strong><span class="muted">${country} — ${escapeHtml(a.date || '?')}</span>${a.level ? ` <span style="color:${color};font-weight:600">(${escapeHtml(a.level)})</span>` : ''}</li>`;
  }).join('') || '<li class="muted">Aucune catastrophe active détectée en Europe.</li>');
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 10 — Météo hyper-locale (Open-Meteo)
// ════════════════════════════════════════════════════════════════════════════

let _mapWeatherMode = false;
let _meteoLocalTempChart = null;
let _meteoLocalRainChart = null;

const _WMO_LABELS = {
  0: 'Ciel dégagé', 1: 'Principalement dégagé', 2: 'Partiellement nuageux', 3: 'Couvert',
  45: 'Brouillard', 48: 'Brouillard givrant', 51: 'Bruine légère', 53: 'Bruine modérée', 55: 'Bruine forte',
  61: 'Pluie légère', 63: 'Pluie modérée', 65: 'Pluie forte', 71: 'Neige légère', 73: 'Neige modérée', 75: 'Neige forte',
  80: 'Averses légères', 81: 'Averses modérées', 82: 'Averses violentes',
  95: 'Orage', 96: 'Orage avec grêle légère', 99: 'Orage avec grêle forte',
};

function _toggleMapWeatherMode() {
  _mapWeatherMode = !_mapWeatherMode;
  const btn = document.getElementById('map-weather-btn');
  if (btn) {
    btn.style.background = _mapWeatherMode ? 'rgba(59,130,246,.15)' : '';
    btn.style.borderColor = _mapWeatherMode ? '#3b82f6' : '';
    btn.title = _mapWeatherMode ? 'Cliquez sur la carte pour la météo · Cliquer ici pour désactiver' : 'Cliquer sur la carte pour obtenir la météo locale';
  }
  if (leafletMap) {
    leafletMap.getContainer().style.cursor = _mapWeatherMode ? 'crosshair' : '';
  }
}

async function _fetchAndShowLocalWeather(lat, lon) {
  _toggleMapWeatherMode(); // désactiver après clic
  const modal = document.getElementById('meteo-local-modal');
  const content = document.getElementById('meteo-local-content');
  const titleEl = document.getElementById('meteo-local-title');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.hidden = false;
  if (content) content.innerHTML = '<p class="muted">Chargement des prévisions…</p>';
  if (titleEl) titleEl.textContent = `⛅ Météo · ${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E`;
  try {
    const data = await api(`/api/meteo/local?lat=${lat}&lon=${lon}`);
    await _renderLocalWeatherModal(data, lat, lon);
  } catch (err) {
    if (content) content.innerHTML = `<p class="error">Impossible de charger la météo : ${escapeHtml(sanitizeErrorMessage(err.message))}</p>`;
  }
}

async function _renderLocalWeatherModal(data, lat, lon) {
  await ensureChartAssets();
  const content = document.getElementById('meteo-local-content');
  const hourly = data?.hourly || {};
  const times = (hourly.time || []).slice(0, 24);
  const temps = (hourly.temperature_2m || []).slice(0, 24);
  const rains = (hourly.precipitation || []).slice(0, 24);
  const winds = (hourly.windspeed_10m || []).slice(0, 24);
  const codes = (hourly.weathercode || []).slice(0, 24);

  // Summary info
  const nowHour = new Date().getHours();
  const currTemp = temps[nowHour] ?? temps[0];
  const currWind = winds[nowHour] ?? winds[0];
  const currCode = codes[nowHour] ?? codes[0];
  const currDesc = _WMO_LABELS[currCode] || 'Inconnu';
  const maxTemp = Math.max(...temps.filter(Number.isFinite));
  const minTemp = Math.min(...temps.filter(Number.isFinite));
  const totalRain = rains.filter(Number.isFinite).reduce((a, b) => a + b, 0);

  if (content) {
    content.innerHTML = `
      <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:.75rem">
        <div style="flex:1;min-width:120px;background:var(--panel-bg,#f8f9fa);border-radius:.4rem;padding:.6rem .8rem">
          <div style="font-size:1.4rem;font-weight:700">${currTemp != null ? currTemp + '°C' : '—'}</div>
          <div class="muted" style="font-size:.82rem">${escapeHtml(currDesc)}</div>
        </div>
        <div style="flex:1;min-width:120px;background:var(--panel-bg,#f8f9fa);border-radius:.4rem;padding:.6rem .8rem">
          <div style="font-size:.82rem" class="muted">Min / Max 24h</div>
          <div style="font-weight:600">${minTemp}° / ${maxTemp}°C</div>
        </div>
        <div style="flex:1;min-width:120px;background:var(--panel-bg,#f8f9fa);border-radius:.4rem;padding:.6rem .8rem">
          <div style="font-size:.82rem" class="muted">Précipitations 24h</div>
          <div style="font-weight:600">${totalRain.toFixed(1)} mm</div>
        </div>
        <div style="flex:1;min-width:120px;background:var(--panel-bg,#f8f9fa);border-radius:.4rem;padding:.6rem .8rem">
          <div style="font-size:.82rem" class="muted">Vent actuellement</div>
          <div style="font-weight:600">${currWind != null ? currWind + ' km/h' : '—'}</div>
        </div>
      </div>
      <p class="muted" style="font-size:.78rem">Source : Open-Meteo · ${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E</p>`;
  }

  // Temperature chart
  const labels = times.map((t) => t.slice(11, 16));
  const tempCanvas = document.getElementById('meteo-local-temp-chart');
  if (tempCanvas) {
    if (_meteoLocalTempChart) _meteoLocalTempChart.destroy();
    _meteoLocalTempChart = new Chart(tempCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Température (°C)',
          data: temps,
          borderColor: '#e67700',
          backgroundColor: 'rgba(230,119,0,.1)',
          tension: 0.4,
          pointRadius: 0,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { title: { display: true, text: '°C' } } },
      },
    });
  }

  // Rain chart
  const rainCanvas = document.getElementById('meteo-local-rain-chart');
  if (rainCanvas) {
    if (_meteoLocalRainChart) _meteoLocalRainChart.destroy();
    _meteoLocalRainChart = new Chart(rainCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Précipitations (mm)',
          data: rains,
          backgroundColor: 'rgba(59,130,246,.65)',
          borderColor: 'rgba(59,130,246,1)',
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'mm' } } },
      },
    });
  }
}

(function initMeteoLocalFeature() {
  const weatherBtn = document.getElementById('map-weather-btn');
  if (weatherBtn) weatherBtn.addEventListener('click', _toggleMapWeatherMode);

  const closeBtn = document.getElementById('meteo-local-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      const modal = document.getElementById('meteo-local-modal');
      if (modal) { modal.classList.add('hidden'); modal.hidden = true; }
    });
  }
})();

// Hook on Leaflet map click for weather mode
(function _hookMapClickForWeather() {
  const _waitAndHook = () => {
    if (leafletMap) {
      leafletMap.on('click', (e) => {
        if (!_mapWeatherMode) return;
        _fetchAndShowLocalWeather(e.latlng.lat, e.latlng.lng);
      });
    } else {
      setTimeout(_waitAndHook, 500);
    }
  };
  setTimeout(_waitAndHook, 1000);
})();

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 15 — Journal d'audit
// ════════════════════════════════════════════════════════════════════════════

const auditState = { logs: [], selectedId: null, total: 0 };

function auditModuleLabel(type = '') {
  return {
    auth: 'Authentification',
    users: 'Utilisateurs',
    municipalities: 'Communes',
    logs: 'Main courante',
    events: 'Evenements',
    map: 'Carte',
    interconnections: 'Interconnexions',
    audit: 'Audit',
  }[type] || type || 'Autre';
}

function auditMethodLabel(method = '') {
  return { POST: 'Action', PATCH: 'Modification', PUT: 'Remplacement', DELETE: 'Suppression', GET: 'Export' }[method] || method || '-';
}

function auditStatusMeta(statusCode) {
  const code = Number(statusCode || 0);
  if (!code) return { label: '-', css: 'neutral' };
  if (code >= 400) return { label: String(code), css: 'error' };
  if (code >= 300) return { label: String(code), css: 'warn' };
  return { label: String(code), css: 'ok' };
}

function auditDateLabel(value) {
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? String(value || '-') : dt.toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function syncAuditSelectOptions(selectId, values = [], placeholder = '') {
  const select = document.getElementById(selectId);
  if (!select) return;
  const current = select.value;
  const options = [...new Set(values.filter(Boolean))];
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${options.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(selectId === 'audit-type-filter' ? auditModuleLabel(value) : value)}</option>`).join('')}`;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

async function loadAuditLog() {
  const searchFilter = (document.getElementById('audit-search-filter')?.value || '').trim();
  const userFilter = document.getElementById('audit-user-filter')?.value || '';
  const typeFilter = document.getElementById('audit-type-filter')?.value || '';
  const methodFilter = document.getElementById('audit-method-filter')?.value || '';
  const statusFilter = document.getElementById('audit-status-filter')?.value || '';
  const limit = document.getElementById('audit-limit-select')?.value || '100';
  const [sortBy, sortDir] = String(document.getElementById('audit-sort-select')?.value || 'created_at:desc').split(':');
  const el = document.getElementById('audit-list');
  if (el) el.innerHTML = '<p class="muted" style="padding:1rem">Chargement...</p>';
  const params = new URLSearchParams({ limit, sort_by: sortBy || 'created_at', sort_dir: sortDir || 'desc' });
  if (searchFilter) params.set('search', searchFilter);
  if (userFilter) params.set('username', userFilter);
  if (typeFilter) params.set('resource_type', typeFilter);
  if (methodFilter) params.set('method', methodFilter);
  if (statusFilter) params.set('status', statusFilter);
  try {
    const data = await api(`/api/audit?${params.toString()}`, { bypassCache: true, cacheTtlMs: 0 });
    const logs = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
    auditState.logs = logs;
    auditState.total = Number(data?.total ?? logs.length);
    if (!logs.some((log) => String(log.id) === String(auditState.selectedId))) auditState.selectedId = logs[0]?.id || null;
    syncAuditSelectOptions('audit-user-filter', data?.users || logs.map((log) => log.username), 'Tous les utilisateurs');
    syncAuditSelectOptions('audit-type-filter', data?.resource_types || logs.map((log) => log.resource_type), 'Tous les modules');
    renderAuditLog(logs, auditState.total);
    renderAuditDetails(logs.find((log) => String(log.id) === String(auditState.selectedId)) || null);
  } catch (err) {
    if (el) el.innerHTML = `<p class="error" style="padding:1rem">Erreur : ${escapeHtml(sanitizeErrorMessage(err.message))}</p>`;
  }
}

function renderAuditLog(logs, total = logs.length) {
  const el = document.getElementById('audit-list');
  const summary = document.getElementById('audit-summary');
  if (!el) return;
  const errors = logs.filter((log) => Number(log.status_code || 0) >= 400).length;
  const users = new Set(logs.map((log) => log.username).filter(Boolean)).size;
  const modules = new Set(logs.map((log) => log.resource_type).filter(Boolean)).size;
  if (summary) summary.innerHTML = `<span>${logs.length}/${total} ligne(s)</span><span>${users} utilisateur(s)</span><span>${modules} module(s)</span><span>${errors} erreur(s)</span>`;
  if (!logs.length) {
    el.innerHTML = '<p class="muted" style="padding:1rem">Aucune action enregistrée pour cette recherche.</p>';
    return;
  }
  el.innerHTML = `<table class="audit-table">
    <thead><tr><th>Heure</th><th>Utilisateur</th><th>Module</th><th>Action</th><th>Chemin</th><th>Statut</th><th>IP</th></tr></thead>
    <tbody>${logs.map((a) => {
      const status = auditStatusMeta(a.status_code);
      const selected = String(a.id) === String(auditState.selectedId) ? ' class="is-selected"' : '';
      const userMeta = [a.user_role ? roleLabel(a.user_role) : '', a.user_municipality || ''].filter(Boolean).join(' · ');
      return `<tr${selected} data-audit-id="${escapeHtml(String(a.id))}">
        <td>${escapeHtml(auditDateLabel(a.created_at))}</td>
        <td><strong>${escapeHtml(a.username || 'inconnu')}</strong>${userMeta ? `<br><span class="muted">${escapeHtml(userMeta)}</span>` : ''}</td>
        <td>${escapeHtml(auditModuleLabel(a.resource_type))}</td>
        <td><span class="audit-chip audit-chip--neutral">${escapeHtml(auditMethodLabel(a.method))}</span></td>
        <td class="audit-path" title="${escapeHtml(a.path || a.action || '')}">${escapeHtml(a.path || a.action || '-')}</td>
        <td><span class="audit-chip audit-chip--${status.css}">${escapeHtml(status.label)}</span></td>
        <td>${escapeHtml(a.ip_address || '-')}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function renderAuditDetails(log) {
  const el = document.getElementById('audit-details');
  if (!el) return;
  if (!log) {
    el.classList.add('muted');
    el.innerHTML = 'Sélectionnez une ligne pour afficher le détail.';
    return;
  }
  const status = auditStatusMeta(log.status_code);
  el.classList.remove('muted');
  el.innerHTML = `<h4>${escapeHtml(auditModuleLabel(log.resource_type))}</h4>
    <span class="audit-chip audit-chip--${status.css}">HTTP ${escapeHtml(status.label)}</span>
    <dl>
      <dt>Heure</dt><dd>${escapeHtml(auditDateLabel(log.created_at))}</dd>
      <dt>Utilisateur</dt><dd>${escapeHtml(log.username || 'inconnu')}</dd>
      <dt>Rôle</dt><dd>${escapeHtml(log.user_role ? roleLabel(log.user_role) : '-')}</dd>
      <dt>Commune</dt><dd>${escapeHtml(log.user_municipality || '-')}</dd>
      <dt>Méthode</dt><dd>${escapeHtml(log.method || '-')}</dd>
      <dt>Action</dt><dd>${escapeHtml(log.action || '-')}</dd>
      <dt>Chemin</dt><dd>${escapeHtml(log.path || '-')}</dd>
      <dt>IP</dt><dd>${escapeHtml(log.ip_address || '-')}</dd>
      <dt>Détail</dt><dd>${escapeHtml(log.details || '-')}</dd>
    </dl>`;
}

(function initAuditPanel() {
  const btn = document.getElementById('audit-refresh-btn');
  if (btn) btn.addEventListener('click', loadAuditLog);

  const userFilter = document.getElementById('audit-user-filter');
  if (userFilter) userFilter.addEventListener('change', loadAuditLog);

  ['audit-type-filter', 'audit-method-filter', 'audit-status-filter', 'audit-sort-select', 'audit-limit-select'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', loadAuditLog);
  });

  let auditSearchTimer = 0;
  const searchFilter = document.getElementById('audit-search-filter');
  if (searchFilter) {
    searchFilter.addEventListener('input', () => {
      clearTimeout(auditSearchTimer);
      auditSearchTimer = setTimeout(loadAuditLog, 250);
    });
    searchFilter.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadAuditLog(); });
  }

  document.getElementById('audit-list')?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-audit-id]');
    if (!row) return;
    auditState.selectedId = row.getAttribute('data-audit-id');
    renderAuditLog(auditState.logs, auditState.total);
    renderAuditDetails(auditState.logs.find((log) => String(log.id) === String(auditState.selectedId)) || null);
  });

  document.querySelectorAll('.menu-btn[data-target="audit-panel"]').forEach((b) => {
    b.addEventListener('click', () => loadAuditLog());
  });

  // Show audit button only for admin
  const auditMenuBtn = document.getElementById('menu-audit-btn');
  if (auditMenuBtn && typeof currentUser !== 'undefined') {
    const _showIfAdmin = () => {
      if (currentUser?.role === 'admin') {
        auditMenuBtn.classList.remove('hidden');
        auditMenuBtn.hidden = false;
      }
    };
    setTimeout(_showIfAdmin, 2000);
  }

  // Update export link with auth token
  const exportLink = document.getElementById('audit-export-link');
  if (exportLink && typeof token !== 'undefined') {
    exportLink.addEventListener('click', async (e) => {
      e.preventDefault();
      const url = '/api/audit/export/csv?days=30';
      const response = await queueApiRequest(() => fetchWithTimeout(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }));
      if (!response.ok) {
        const summary = document.getElementById('audit-summary');
        if (summary) summary.innerHTML = `<span class="error">Export impossible (${response.status})</span>`;
        return;
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `audit_${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(objectUrl);
    });
  }
})();

