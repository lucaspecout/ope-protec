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
  staticInstitutionsCache: 'staticInstitutionsCache',
  staticFinessCache: 'staticFinessCacheV3',
  staticTelecomCache: 'staticTelecomCacheV1',
  serviceStatusHistory: 'serviceStatusHistory',
};
const AUTO_REFRESH_MS = 45000;
const EVENTS_LIVE_REFRESH_MS = 45000;
const HOME_LIVE_REFRESH_MS = 60000;
const API_CACHE_TTL_MS = 45000;
const API_PANEL_REFRESH_MS = 60000;
const API_MAX_CONCURRENT_REQUESTS = 8;
const API_REQUEST_TIMEOUT_MS = 20000;
const API_SLOW_ENDPOINT_TIMEOUT_MS = 45000;
const LOGIN_REQUEST_TIMEOUT_MS = 10000;
const API_RETRY_BASE_DELAY_MS = 500;
const API_MAX_RETRIES_GET = 3;
const API_MAX_RETRIES_NON_GET = 1;
const API_ORIGIN_COOLDOWN_MS = 60000;
const STATIC_POINTS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TELECOM_POINTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const OSM_DETAILS_MIN_ZOOM = 15;
const PANEL_TITLES = {
  'situation-panel': 'Situation opérationnelle',
  'services-panel': 'Services connectés',
  'meteo-panel': 'Météo hebdomadaire Isère',
  'georisques-panel': 'Page Géorisques',
  'news-panel': 'Actualités Isère',
  'api-panel': 'Interconnexions API',
  'municipalities-panel': 'Communes partenaires',
  'logs-panel': 'Main courante opérationnelle',
  'map-panel': 'Carte stratégique Isère',
  'users-panel': 'Gestion des utilisateurs',
};

const RESOURCE_TYPE_META = {
  poste_commandement: { label: 'Poste de commandement', icon: '🛰️' },
  gymnase: { label: 'Gymnase', icon: '🏟️' },
  centre_culturel: { label: 'Centre culturel', icon: '🏛️' },
  salle_spectacle_public: { label: 'Salle de spectacle public', icon: '🎭' },
  salle_fetes: { label: 'Salle des fêtes', icon: '🎪' },
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
  anfr_antenna: { label: 'Antenne ANFR', icon: '📡' },
  arcep_mobile_outage: { label: 'Site mobile indisponible (ARCEP)', icon: '🔴' },
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
];

let token = localStorage.getItem(STORAGE_KEYS.token);
let currentUser = null;
let pendingCurrentPassword = '';
let refreshTimer = null;
let liveEventsTimer = null;
let homeLiveTimer = null;
let apiPanelTimer = null;
let apiResyncTimer = null;
let refreshAllInFlight = null;
let photoCameraRefreshTimer = null;
let socialFeedsFallbackTimer = null;
let lastApiResyncAt = null;
let isLoginSubmitting = false;
const apiGetCache = new Map();
const apiInFlight = new Map();
const apiRequestQueue = [];
let apiActiveRequests = 0;
let preferredApiOrigin = window.location.origin;
const apiOriginFailures = new Map();
const startupQueueState = { total: 0, completed: 0, current: '' };

const ISERE_MAJOR_CITIES = [
  { key: 'grenoble', name: 'Grenoble', lat: 45.1885, lon: 5.7245, population: 158180 },
  { key: 'smh', name: 'Saint-Martin-d’Hères', lat: 45.1656, lon: 5.7634, population: 38980 },
  { key: 'echirolles', name: 'Échirolles', lat: 45.146, lon: 5.7144, population: 36500 },
  { key: 'vienne', name: 'Vienne', lat: 45.5257, lon: 4.8748, population: 31320 },
  { key: 'bourgoin', name: 'Bourgoin-Jallieu', lat: 45.5861, lon: 5.2736, population: 28710 },
  { key: 'voiron', name: 'Voiron', lat: 45.3659, lon: 5.5926, population: 20600 },
  { key: 'isle', name: 'L’Isle-d’Abeau', lat: 45.6256, lon: 5.226, population: 16840 },
  { key: 'meylan', name: 'Meylan', lat: 45.2125, lon: 5.7773, population: 17790 },
];

let leafletMap = null;
let boundaryLayer = null;
let hydroLayer = null;
let hydroLineLayer = null;
let pcsBoundaryLayer = null;
let pcsLayer = null;
let resourceLayer = null;
let searchLayer = null;
let customPointsLayer = null;
let mapPointsLayer = null;
let itinisereLayer = null;
let bisonLayer = null;
let bisonCameraLayer = null;
let photoCameraLayer = null;
let institutionLayer = null;
let populationLayer = null;
let mapTileLayer = null;
let mapFloodOverlayLayer = null;
let googleTrafficFlowLayer = null;
let floodZoneWmsLayer = null;
let userLocationMarker = null;
let mapAddPointMode = false;
let mapPoints = [];
let mapAnnotations = [];
let mapAnnotationsSync = null;
let mapDrawControl = null;
let mapAnnotationFeatureGroup = null;
let mapZoneImpactLayer = null;
let mapZoneImpactSelection = null;
let mapZoneImpactDrawHandler = null;
let mapZoneImpactComputationSeq = 0;
let mapZoneImpactReportData = null; // stocke les données brutes pour l'export
const mapPointVisibilityOverrides = new Map();
const resourceVisibilityOverrides = new Map();
let pendingMapPointCoords = null;
let mapIconTouched = false;
let cachedStations = [];
let cachedVigicruesPayload = { stations: [], troncons: [] };
let cachedMunicipalities = [];
let cachedMunicipalityRecords = [];
let cachedItinisereEvents = [];
let cachedBisonFute = {};
let cachedBisonLiveEvents = [];
let geocodeCache = new Map();
let municipalityContourCache = new Map();
const municipalityDocumentsUiState = new Map();
let trafficGeocodeCache = new Map();
let mapStats = { stations: 0, pcs: 0, resources: 0, custom: 0, traffic: 0 };
let mapControlsCollapsed = false;
let cachedCrisisPoints = [];
let cachedEvents = [];
let selectedOperationalEventId = null;
let cachedLogs = [];
let cachedDashboardSnapshot = {};
let cachedExternalRisksSnapshot = {};
let cachedWeeklyMeteo = null;
let weeklyMeteoInFlight = null;
let selectedMeteoCityKey = ISERE_MAJOR_CITIES[0]?.key || 'grenoble';
let isereBoundaryGeometry = null;
let trafficRenderSequence = 0;
let mapSearchController = null;
let osmDetailsController = null;
let osmDetailsMarker = null;

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
let finessPointsCache = [];
let finessLoaded = false;
let finessTypeCounts = {};
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

function keepPreviousValue(previousValue, nextValue) {
  if (nextValue === undefined || nextValue === null) return previousValue;
  if (typeof nextValue === 'string' && nextValue.trim() === '') return previousValue;
  return nextValue;
}

function keepPreviousArray(previousValue, nextValue) {
  if (Array.isArray(nextValue)) return nextValue;
  return Array.isArray(previousValue) ? previousValue : [];
}

function isUnknownStatusValue(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim().toLowerCase();
  return !text || text === '-' || text === 'inconnu' || text === 'inconnue' || text === 'unknown';
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
    sncf_isere: {
      ...prevSncf,
      ...nextSncf,
      alerts_total: keepPreviousValue(prevSncf.alerts_total, nextSncf.alerts_total),
      alerts: keepPreviousArray(prevSncf.alerts, nextSncf.alerts),
    },
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
    arcep_isere: {
      ...prevArcep,
      ...nextArcep,
      outages_total: keepPreviousValue(prevArcep.outages_total, nextArcep.outages_total),
      communes_total: keepPreviousValue(prevArcep.communes_total, nextArcep.communes_total),
      voice_impacted_total: keepPreviousValue(prevArcep.voice_impacted_total, nextArcep.voice_impacted_total),
      data_impacted_total: keepPreviousValue(prevArcep.data_impacted_total, nextArcep.data_impacted_total),
      top_operators: keepPreviousArray(prevArcep.top_operators, nextArcep.top_operators),
    },
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
  };
}

function updateApiQueueVisual() {
  const summaryNode = document.getElementById('api-queue-summary');
  const progressNode = document.getElementById('api-queue-progress-bar');
  const currentNode = document.getElementById('api-queue-current');
  const progressWrap = document.querySelector('.api-queue-progress');
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
const HEALTH_URGENT_CARE_TYPES = new Set(['chu', 'hopital', 'hopital_public', 'hopital_prive', 'clinique']);
const FINESS_DYNAMIC_RESOURCE_TYPES = new Set();
const RISK_RESOURCE_TYPES = new Set(['lieu_risque', 'centrale_nucleaire', 'energie']);
const TRANSPORT_RESOURCE_TYPES = new Set(['transport', 'transport_gare_sncf', 'transport_gare_routiere', 'transport_aeroport']);
const COMMAND_RESOURCE_TYPES = new Set(['poste_commandement']);
const HOSTING_RESOURCE_TYPES = new Set(['gymnase', 'centre_culturel', 'salle_spectacle_public', 'salle_fetes']);
const TELECOM_RESOURCE_TYPES = new Set(['anfr_antenna', 'arcep_mobile_outage']);

const ISERE_BOUNDARY_STYLE = { color: '#163a87', weight: 2, fillColor: '#63c27d', fillOpacity: 0.2 };
const TRAFFIC_COMMUNES = ['Grenoble', 'Voiron', 'Vienne', 'Bourgoin-Jallieu', 'Pont-de-Claix', 'Meylan', 'Échirolles', 'L\'Isle-d\'Abeau', 'Saint-Martin-d\'Hères', 'La Tour-du-Pin', 'Rives', 'Sassenage', 'Crolles', 'Tullins'];
const ITINISERE_ROAD_CORRIDORS = {
  A41: [[45.1885, 5.7245], [45.3656, 5.9494]],
  A48: [[45.1885, 5.7245], [45.3667, 5.5906]],
  A49: [[45.0541, 5.0536], [45.1885, 5.7245]],
  A43: [[45.5866, 5.2732], [45.529, 5.96]],
  A7: [[45.5265, 4.8746], [45.3647, 4.7896]],
  N85: [[45.1885, 5.7245], [44.9134, 5.7861]],
  N87: [[45.1487, 5.7169], [45.1885, 5.7245]],
  D1075: [[45.1885, 5.7245], [44.9134, 5.7861]],
  D1090: [[45.1885, 5.7245], [45.3608, 5.9234]],
};
const BISON_CORRIDORS = [
  { name: 'A43 · Axe Lyon ⇄ Chambéry', points: [[45.5866, 5.2732], [45.7257, 5.9191]] },
  { name: 'A48 · Axe Grenoble ⇄ Lyon', points: [[45.1885, 5.7245], [45.5866, 5.2732]] },
  { name: 'A41 · Axe Grenoble ⇄ Savoie', points: [[45.1885, 5.7245], [45.3656, 5.9494]] },
  { name: 'A49 · Axe Grenoble ⇄ Valence', points: [[45.1885, 5.7245], [45.0541, 5.0536]] },
  { name: 'N85 · Route Napoléon', points: [[45.1885, 5.7245], [44.9134, 5.7861]] },
];
const BISON_FUTE_CAMERAS = [
  { name: 'Meylan N87 PR10+590', road: 'N87', lat: 45.201217282265034, lon: 5.7812657653824875, manager: 'DIR Centre-Est', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/nce_27.mp4' },
  { name: 'Eybens N87 PR4+200', road: 'N87', lat: 45.15652758486637, lon: 5.7475476745737355, manager: 'DIR Centre-Est', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/nce_31.mp4' },
  { name: 'A480 Grenoble vers Grenoble Sud', road: 'A480', lat: 45.15873823197743, lon: 5.7005336069172925, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area09.mp4' },
  { name: 'A480/RN481 direction Ouest/Sud', road: 'A480 / RN481', lat: 45.21650958839951, lon: 5.6784500109717335, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area10.mp4' },
  { name: 'A48 aire de l’Île rose', road: 'A48', lat: 45.272598746702336, lon: 5.625897585313137, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area08.mp4' },
  { name: 'A41S près de Grenoble vers Grenoble', road: 'A41S', lat: 45.203406837349334, lon: 5.7762608185576765, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area05.mp4' },
  { name: 'Bifurcation A43/A48 près de Bourgoin vers Chambéry', road: 'A43 / A48', lat: 45.56699881012449, lon: 5.344117226835471, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area06.mp4' },
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

const ITINISERE_PHOTO_CAMERAS = [
  {
    name: 'La Diat',
    road: 'D520B',
    lat: 45.33981893625896,
    lon: 5.807674386173609,
    streamUrl: 'https://traffic.itiniserev2.cityway.fr/api/v1/Camera/D520BLaDiat',
  },
  {
    name: 'Les Fontaines',
    road: 'D525',
    lat: 45.35574122911768,
    lon: 5.992340889751027,
    streamUrl: 'https://traffic.itiniserev2.cityway.fr/api/v1/Camera/D525LesFontaines',
  },
  {
    name: 'Fond de France',
    road: 'D525A',
    lat: 45.28221936272868,
    lon: 6.074009634997554,
    streamUrl: 'https://traffic.itiniserev2.cityway.fr/api/v1/Camera/D525AFonddeFrance',
  },
  {
    name: 'Rochetaillée',
    road: 'D1091 / D526',
    lat: 45.1144099370023,
    lon: 6.005238134016191,
    streamUrl: 'https://traffic.itiniserev2.cityway.fr/api/v1/Camera/D1091D526Rochetaillee',
  },
  {
    name: 'Seiglières',
    road: 'D111',
    lat: 45.15474818390343,
    lon: 5.869930116196619,
    streamUrl: 'https://traffic.itiniserev2.cityway.fr/api/v1/Camera/D111Seiglieres',
  },
  {
    name: 'Clavaux Grenoble',
    road: 'D1091',
    lat: 45.07592699481376,
    lon: 5.883116163700038,
    streamUrl: 'https://traffic.itiniserev2.cityway.fr/api/v1/Camera/D1091ClavauxGrenoble',
  },
];

function cameraPopupMarkup(camera = {}) {
  const name = escapeHtml(camera.name || 'Caméra routière');
  const road = escapeHtml(camera.road || 'Réseau principal');
  const manager = escapeHtml(camera.manager || 'Bison Futé');
  const sourceUrl = escapeHtml(camera.streamUrl || 'https://www.bison-fute.gouv.fr');
  const mediaType = camera.mediaType === 'image' ? 'image' : 'video';
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
      <a href="${sourceUrl}" target="_blank" rel="noreferrer">Voir le flux caméra</a>
    </article>
  `;
}

function photoCameraPopupMarkup(camera = {}) {
  return cameraPopupMarkup({
    manager: 'Photo route',
    mediaType: 'image',
    ...camera,
  });
}

function refreshPhotoCameraImages(event) {
  const popupElement = event?.popup?.getElement?.();
  if (!popupElement) return;
  popupElement.querySelectorAll('img').forEach((image) => {
    const originalUrl = image.getAttribute('data-original-src') || image.getAttribute('src');
    if (!originalUrl) return;
    if (!image.getAttribute('data-original-src')) image.setAttribute('data-original-src', originalUrl);
    const separator = originalUrl.includes('?') ? '&' : '?';
    image.setAttribute('src', `${originalUrl}${separator}t=${Date.now()}`);
  });
}

function startPhotoCameraAutoRefresh() {
  if (photoCameraRefreshTimer) clearInterval(photoCameraRefreshTimer);
  photoCameraRefreshTimer = setInterval(() => {
    if (document.hidden || !leafletMap) return;
    leafletMap.eachLayer((layer) => {
      if (!(layer instanceof window.L.Marker)) return;
      const popup = layer.getPopup?.();
      if (!popup?.isOpen?.()) return;
      refreshPhotoCameraImages({ popup });
    });
  }, 30000);
}

const homeView = document.getElementById('home-view');
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const passwordForm = document.getElementById('password-form');

const normalizeLevel = (level) => ({ verte: 'vert', green: 'vert', yellow: 'jaune', red: 'rouge' }[(level || '').toLowerCase()] || (level || 'vert').toLowerCase());
const levelColor = (level) => ({ vert: '#2f9e44', jaune: '#f59f00', orange: '#f76707', rouge: '#e03131' }[normalizeLevel(level)] || '#2f9e44');
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

function stationStatusLevel(station = {}) {
  const status = normalizeLevel(station.control_status || station.status || '');
  if (['vert', 'jaune', 'orange', 'rouge'].includes(status)) return status;
  return normalizeLevel(station.level || 'vert');
}

function formatLogLine(log = {}) {
  const municipality = log.municipality_id ? ` · ${escapeHtml(getMunicipalityName(log.municipality_id))}` : '';
  const place = log.location ? ` · 📍 ${escapeHtml(log.location)}` : '';
  const source = log.source ? ` · Source: ${escapeHtml(log.source)}` : '';
  const owner = log.assigned_to ? ` · 👤 ${escapeHtml(log.assigned_to)}` : '';
  const next = log.next_update_due ? ` · ⏱️ MAJ ${new Date(log.next_update_due).toLocaleString()}` : '';
  const actions = log.actions_taken ? `<div class="muted">Actions: ${escapeHtml(log.actions_taken)}</div>` : '';
  const deleteAction = canEdit() ? `<div class="map-inline-actions"><button type="button" class="ghost inline-action" data-log-edit="${log.id}">Modifier</button><button type="button" class="ghost inline-action danger" data-log-delete="${log.id}">Supprimer MCO</button></div>` : '';
  return `<li><strong>${new Date(log.event_time || log.created_at).toLocaleString()}</strong> · <span class="badge neutral">${formatLogScope(log)}${municipality}</span> ${log.danger_emoji || LOG_LEVEL_EMOJI[normalizeLevel(log.danger_level)] || '🟢'} <strong style="color:${levelColor(log.danger_level)}">${escapeHtml(log.event_type || 'MCO')}</strong> · <span class="muted">${escapeHtml(getEventTitle(log.event_id))}</span>${place}${owner}${source}${next}<div>${escapeHtml(log.description || '')}</div>${actions}${deleteAction}</li>`;
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
  try {
    const local = JSON.parse(localStorage.getItem(STORAGE_KEYS.municipalitiesCache) || '[]');
    const fromLocal = Array.isArray(local) ? local.find((municipality) => String(municipality.id) === id) : null;
    if (fromLocal?.name) return fromLocal.name;
  } catch (_) {
    // ignore cache parsing issues
  }
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
  form.elements.next_update_due.value = log.next_update_due ? toDatetimeLocal(log.next_update_due) : '';
  form.elements.description.value = log.description || '';
  form.elements.actions_taken.value = log.actions_taken || '';
  form.dataset.editLogId = String(log.id);
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) submitButton.textContent = 'Enregistrer la modification';
  syncLogScopeFields();
}

function resetLogFormState() {
  const form = document.getElementById('log-form');
  if (!form) return;
  delete form.dataset.editLogId;
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) submitButton.textContent = "Ajouter l'entrée";
}

function renderEventsList() {
  const target = document.getElementById('events-list');
  if (!target) return;

  const sortedEvents = sortOperationalEvents(cachedEvents);
  const markup = sortedEvents.map((event) => {
    const isSelected = String(event.id) === String(selectedOperationalEventId);
    const municipality = event.municipality_id ? ` · ${escapeHtml(getMunicipalityName(event.municipality_id))}` : ' · Départemental';
    const status = EVENT_STATUS_LABEL[event.status] || event.status || 'Ouvert';
    const actionLabel = isSelected ? 'Fiche ouverte' : 'Ouvrir la fiche';
    const deleteAction = canEdit()
      ? `<button type="button" class="ghost inline-action danger" data-event-delete="${event.id}">Supprimer</button>`
      : '';
    return `<li class="event-list-item${isSelected ? ' active' : ''}"><strong>${escapeHtml(event.title || 'Évènement')}</strong><br/><span class="muted">${escapeHtml(event.address || '-')}${municipality}</span><br/><span class="badge neutral">${escapeHtml(status)}</span> <button type="button" class="ghost inline-action" data-event-open="${event.id}">${actionLabel}</button> ${deleteAction}</li>`;
  }).join('');

  target.innerHTML = markup || '<li>Aucun évènement pour le moment.</li>';
}

function updateEventDetailPanel() {
  const detailPanel = document.getElementById('event-detail');
  const selectedEvent = getSelectedOperationalEvent();
  if (!detailPanel) return;
  if (!selectedEvent) {
    setVisibility(detailPanel, false);
    renderEventMcoSuggestions();
    return;
  }

  setVisibility(detailPanel, true);
  setText('event-detail-title', selectedEvent.title || 'Fiche évènement');
  const status = EVENT_STATUS_LABEL[selectedEvent.status] || selectedEvent.status || 'Ouvert';
  const locality = selectedEvent.municipality_id ? getMunicipalityName(selectedEvent.municipality_id) : 'Départemental';
  setText('event-detail-meta', `${selectedEvent.address || 'Adresse non renseignée'} · ${locality} · Statut: ${status}`);

  const normalizedStatus = String(selectedEvent.status || '').toLowerCase();
  const closeButton = document.getElementById('event-close-btn');
  if (closeButton) {
    const isClosed = normalizedStatus === 'clos';
    closeButton.setAttribute('data-event-status', String(selectedEvent.id));
    closeButton.setAttribute('data-event-next', isClosed ? 'ouvert' : 'clos');
    closeButton.textContent = isClosed ? "Réouvrir l'évènement" : "Clôturer l'évènement";
  }

  const deleteButton = document.getElementById('event-delete-btn');
  if (deleteButton) {
    deleteButton.setAttribute('data-event-delete', String(selectedEvent.id));
  }

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
  if (!source.length) {
    try {
      const local = JSON.parse(localStorage.getItem(STORAGE_KEYS.municipalitiesCache) || '[]');
      if (Array.isArray(local)) source = local;
    } catch (_) {
      source = [];
    }
  }

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
function canCreateMapPoints() { return ['admin', 'ope', 'mairie'].includes(currentUser?.role); }
function canMunicipalityFiles() { return ['admin', 'ope', 'mairie'].includes(currentUser?.role); }
function canManageUsers() { return ['admin', 'ope'].includes(currentUser?.role); }
function roleLabel(role) { return { admin: 'Admin', ope: 'Opérateur', securite: 'Sécurité', visiteur: 'Visiteur', mairie: 'Mairie' }[role] || role; }
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
  const code = String(doc?.code || doc?.idGaspar || doc?.code_national_azi || '').trim();
  const params = new URLSearchParams({ code_insee: codeInsee });

  if (title === 'DICRIM') return `https://www.georisques.gouv.fr/api/v1/gaspar/dicrim?${params.toString()}`;
  if (title === 'TIM') return `https://www.georisques.gouv.fr/api/v1/gaspar/tim?${params.toString()}`;
  if (title.includes('RISQUE')) return `https://www.georisques.gouv.fr/api/v1/gaspar/risques?${params.toString()}`;

  // Les endpoints pprn/pprm/pprt ne sont plus exposés en GET sur l'API publique v1.
  // On bascule vers la fiche risque de la commune (plus stable) pour éviter les liens 404.
  if (title === 'PPRN' || title === 'PPRM' || title === 'PPRT') return buildGeorisquesCommuneUrl(commune);

  if (code) params.set('code_national_azi', code);
  return `https://www.georisques.gouv.fr/api/v1/gaspar/azi?${params.toString()}`;
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

function showHome() { setVisibility(homeView, true); setVisibility(loginView, false); setVisibility(appView, false); }
function showLogin() { setVisibility(homeView, false); setVisibility(loginView, true); setVisibility(appView, false); setVisibility(passwordForm, false); setVisibility(loginForm, true); }
function showApp() { setVisibility(homeView, false); setVisibility(loginView, false); setVisibility(appView, true); }

function apiOrigins() {
  const origins = [];
  const { protocol, hostname, port } = window.location;
  const isDefaultWebPort = (protocol === 'https:' && (port === '' || port === '443')) || (protocol === 'http:' && (port === '' || port === '80'));
  const lowerHostname = String(hostname || '').toLowerCase();
  const isLocalHostname = ['localhost', '127.0.0.1', '::1'].includes(lowerHostname);
  const isPrivateNetworkHostname = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(lowerHostname);
  const canProbeLoopbackAliases = isLocalHostname || isPrivateNetworkHostname;

  origins.push(window.location.origin);

  if (hostname) {
    const preferredProtocol = protocol === 'https:' ? 'https:' : 'http:';
    if (isDefaultWebPort) origins.push(`${preferredProtocol}//${hostname}`);
    origins.push(`${preferredProtocol}//${hostname}:1182`);
  }

  if (canProbeLoopbackAliases) {
    origins.push(
      'http://localhost:1182',
      'http://127.0.0.1:1182',
    );
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
    return "L'API renvoie une page HTML au lieu d'un JSON. Vérifiez que le backend tourne bien sur le même hôte (docker compose up -d).";
  }
  if (normalized.includes('502') || normalized.includes('Bad Gateway')) {
    return "Erreur passerelle (502) — le backend est inaccessible depuis Nginx. Vérifiez les conteneurs Docker.";
  }
  if (normalized.includes('503') || normalized.includes('Service Unavailable')) {
    return "Service temporairement indisponible (503) — réessayez dans quelques instants.";
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


function setLoginError(message = '', debugDetails = '') {
  const errorTarget = document.getElementById('login-error');
  const debugWrap = document.getElementById('login-error-debug-wrap');
  const debugTarget = document.getElementById('login-error-debug');

  if (errorTarget) errorTarget.textContent = message;

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

function renderApiResyncClock() {
  setText('api-resync-ago', formatElapsedSince(lastApiResyncAt));
}

function normalizeApiErrorMessage(payload, status) {
  if (!payload) return `Erreur API (${status})`;
  const detail = payload.detail ?? payload.message;
  if (typeof detail === 'string' && detail.trim()) return detail;
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


function saveSnapshot(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), payload }));
  } catch (_) {
    // ignore localStorage saturation
  }
}

function readSnapshot(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    return raw.payload;
  } catch (_) {
    return null;
  }
}

function readSnapshotWithMetadata(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch (_) {
    return null;
  }
}

function readFreshSnapshot(key, ttlMs) {
  const snapshot = readSnapshotWithMetadata(key);
  if (!snapshot) return null;
  const savedAt = Number(snapshot.savedAt || 0);
  if (!Number.isFinite(savedAt) || savedAt <= 0) return null;
  if ((Date.now() - savedAt) > ttlMs) return null;
  return snapshot.payload;
}

function hydrateUiFromLocalCache() {
  const cachedDashboard = readSnapshot(STORAGE_KEYS.dashboardSnapshot);
  if (cachedDashboard) renderDashboard(cachedDashboard);

  const cachedRisks = readSnapshot(STORAGE_KEYS.externalRisksSnapshot);
  if (cachedRisks) {
    renderExternalRisks(cachedRisks);
    renderApiInterconnections(cachedRisks);
  }

  try {
    const cachedMunicipalities = JSON.parse(localStorage.getItem(STORAGE_KEYS.municipalitiesCache) || '[]');
    if (Array.isArray(cachedMunicipalities) && cachedMunicipalities.length) {
      loadMunicipalities(cachedMunicipalities);
    }
  } catch (_) {
    // ignore malformed cache
  }

  const cachedLogsSnapshot = readSnapshot(STORAGE_KEYS.logsSnapshot);
  if (Array.isArray(cachedLogsSnapshot) && cachedLogsSnapshot.length) {
    cachedLogs = cachedLogsSnapshot;
    renderLogsList();
    renderSituationOverview();
  }

  const cachedEventsSnapshot = readSnapshot(STORAGE_KEYS.eventsSnapshot);
  if (Array.isArray(cachedEventsSnapshot) && cachedEventsSnapshot.length) {
    cachedEvents = cachedEventsSnapshot;
    populateEventOptions(cachedEvents);
  }

  const cachedUsersSnapshot = readSnapshot(STORAGE_KEYS.usersSnapshot);
  if (Array.isArray(cachedUsersSnapshot) && cachedUsersSnapshot.length && canManageUsers()) {
    loadUsers(cachedUsersSnapshot);
  }

  const homeLiveSnapshot = readSnapshot(STORAGE_KEYS.homeLiveSnapshot);
  if (homeLiveSnapshot && typeof homeLiveSnapshot === 'object') {
    cachedHomeLiveSnapshot = homeLiveSnapshot;
    renderHomeLiveStatus(cachedHomeLiveSnapshot);
  }
}

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
  const headers = { ...(fetchOptions.headers || {}) };
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
          throw createApiError(message, response.status);
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

function setActivePanel(panelId) {
  // Fermer automatiquement le menu latéral sur mobile
  document.getElementById('app-sidebar')?.classList.remove('open');
  document.getElementById('app-menu-btn')?.setAttribute('aria-expanded', 'false');
  localStorage.setItem(STORAGE_KEYS.activePanel, panelId);
  document.querySelectorAll('.menu-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.target === panelId));
  document.querySelectorAll('.view').forEach((panel) => setVisibility(panel, panel.id === panelId));
  document.getElementById('panel-title').textContent = PANEL_TITLES[panelId] || 'Centre opérationnel';
  if (panelId === 'map-panel' && leafletMap) {
    setTimeout(() => {
      leafletMap.invalidateSize();
      centerMapOnIsere();
    }, 100);
  }
  if (panelId === 'logs-panel') ensureLogMunicipalitiesLoaded();
  if (panelId === 'news-panel') ensureSocialFeedsRendered();
  if (panelId === 'api-panel' && token) {
    loadApiInterconnections(false).catch((error) => {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    });
  }
}

function ensureSocialFeedsRendered() {
  const panel = document.getElementById('news-panel');
  if (!panel) return;

  panel.querySelectorAll('.twitter-timeline').forEach((timelineLink) => {
    const card = timelineLink.closest('.social-feed-card');
    if (!card || card.querySelector('.social-feed-fallback')) return;
    const fallback = document.createElement('p');
    fallback.className = 'muted social-feed-fallback hidden';
    fallback.hidden = true;
    fallback.textContent = 'Le flux intégré ne se charge pas sur ce navigateur. Utilisez le lien du profil ci-dessous.';
    timelineLink.insertAdjacentElement('afterend', fallback);
  });

  if (window.twttr?.widgets?.load) {
    window.twttr.widgets.load(panel);
  }

  if (socialFeedsFallbackTimer) window.clearTimeout(socialFeedsFallbackTimer);
  socialFeedsFallbackTimer = window.setTimeout(() => {
    panel.querySelectorAll('.social-feed-card').forEach((card) => {
      const fallback = card.querySelector('.social-feed-fallback');
      if (!fallback) return;
      const hasEmbeddedTimeline = Boolean(card.querySelector('iframe.twitter-timeline, iframe[data-testid="twitter-timeline"]'));
      setVisibility(fallback, !hasEmbeddedTimeline);
    });
  }, 4500);
}

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

function renderZoneImpactPanel(html = '') {
  if (!html) {
    setHtml('map-zone-impact-list', '<li>Aucune zone d&rsquo;analyse active.</li>');
    return;
  }
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

async function computeZoneImpact() {
  const runSeq = ++mapZoneImpactComputationSeq;
  const geometry = selectedZoneGeometry();
  if (!geometry) {
    renderZoneImpactPanel();
    return;
  }

  renderZoneImpactPanel('<li>⏳ Analyse en cours…</li>');

  // ─── Chargements parallèles ────────────────────────────────────────────────
  const [inseePopulationMap, zonePopulationMetrics, streetInsights, geoCtx] = await Promise.all([
    loadIserePopulationByInsee(),
    (async () => {
      const muns = zoneImpactDepartmentCommunesInZone(geometry);
      return estimatePopulationInZoneByArea(geometry, muns, await loadIserePopulationByInsee());
    })(),
    fetchZoneStreetInsights(geometry),
    fetchZoneGeographicContext(geometry),
  ]);
  if (runSeq !== mapZoneImpactComputationSeq) return;

  const municipalitiesInZone = zoneImpactDepartmentCommunesInZone(geometry);
  const resources = getResourcesForZoneImpact();
  const resourcesInZone = resources.filter((r) => {
    const c = normalizeMapCoordinates(r.lat, r.lon);
    return c ? isPointInsideGeometry(c, geometry) : false;
  });

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

  const nameList = (arr, max = 5) => arr.slice(0, max).map((r) => `<em>${_zoneResourceName(r)}</em>`).join(', ')
    + (arr.length > max ? ` <span class="muted">+${arr.length - max}</span>` : '');

  const parts = [];

  // 1. Identification de la zone
  parts.push(`<li style="margin-bottom:.7em;padding:.5em;background:#f0f4ff;border-radius:6px">
    <strong>${scaleIcons[scale]} ${scaleLabels[scale]}${geoLabel ? ` · ${escapeHtml(geoLabel)}` : ''}</strong><br>
    ${zoneAreaM2 > 0 ? `Surface : <strong>${(zoneAreaM2 / 1_000_000).toFixed(2).replace('.', ',')} km²</strong> · ` : ''}
    ${municipalitiesInZone.length} commune(s) couverte(s)${municipalitiesInZone.length ? ` (${municipalitiesInZone.slice(0, 3).map((m) => escapeHtml(m.name || m.commune || '')).filter(Boolean).join(', ')}${municipalitiesInZone.length > 3 ? '…' : ''})` : ''}
  </li>`);

  // 2. Population
  parts.push(`<li style="margin-bottom:.6em;padding:.4em;background:#fff7e6;border-radius:6px">
    <strong>👥 Population exposée : <span style="font-size:1.2em;color:#c05900">${population > 0 ? population.toLocaleString('fr-FR') : 'inconnue'}</span> habitants</strong><br>
    <span class="muted">${popSource}</span><br>
    ${childrenEstimate > 0 ? `👶 ~${childrenEstimate.toLocaleString('fr-FR')} enfants scolarisés estimés · ` : ''}
    ${ehpadResidents > 0 ? `🧓 ~${ehpadResidents.toLocaleString('fr-FR')} résidents EHPAD (personnes à mobilité réduite)` : ''}
  </li>`);

  // 3. Dangers dans la zone
  if (dangers.length) {
    parts.push(section('⚠️', `DANGERS DANS LA ZONE (${dangers.length})`, [
      dangers.map((r) => {
        const meta = RESOURCE_TYPE_META[r.type] || {};
        return `${meta.icon || '⚠️'} <strong>${_zoneResourceName(r)}</strong> <span class="muted">(${escapeHtml(r.address || '')})</span>`;
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

  // Stocker les données brutes pour l'export
  mapZoneImpactReportData = {
    generatedAt: new Date(),
    scale, geoLabel, geoCtx, zoneAreaM2, population, popSource,
    childrenEstimate, ehpadResidents,
    municipalitiesInZone, resourcesInZone,
    schools, ehpads, hospitals, fireStations, police, hostings, dangers, transports,
    allDistricts, streetInsights,
  };

  const actionBar = `<div style="display:flex;gap:.5em;margin-top:.7em;flex-wrap:wrap">
    <button id="zone-impact-export-btn" type="button" class="map-btn-lite" style="background:#1971c2;color:#fff;border:none;padding:.4em .9em;border-radius:6px;cursor:pointer;font-size:.82rem">📄 Exporter le rapport</button>
    <button id="zone-impact-clear-btn" type="button" class="ghost map-btn-lite" style="padding:.4em .9em;border-radius:6px;font-size:.82rem">🗑️ Effacer la zone</button>
  </div>`;

  renderZoneImpactPanel(`<ul style="list-style:none;padding:0;margin:0">${parts.join('')}</ul>${actionBar}`);

  document.getElementById('zone-impact-export-btn')?.addEventListener('click', exportZoneImpactReport);
  document.getElementById('zone-impact-clear-btn')?.addEventListener('click', clearZoneImpactSelection);
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
      <thead><tr><th>Nom</th><th>Adresse</th><th>Priorité</th></tr></thead>
      <tbody>${arr.map((r) => `<tr>
        <td>${toText(r.name || 'Sans nom')}</td>
        <td>${toText(r.address || '–')}</td>
        <td class="tag-${r.priority || 'standard'}">${priorityText(r.priority)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  };

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
    <tr><th>Communes intersectées</th><td class="communes-list">${d.municipalitiesInZone.map((m) => toText(m.name || m.commune || '')).filter(Boolean).join(', ') || 'Non déterminées'}</td></tr>
    ${d.geoCtx.city ? `<tr><th>Ville / commune centre</th><td>${toText(d.geoCtx.city)}${d.geoCtx.postcode ? ` (${toText(d.geoCtx.postcode)})` : ''}</td></tr>` : ''}
    ${d.geoCtx.district ? `<tr><th>Quartier</th><td>${toText(d.geoCtx.district)}</td></tr>` : ''}
    ${d.geoCtx.street ? `<tr><th>Rue / voie</th><td>${toText(d.geoCtx.street)}</td></tr>` : ''}
    ${d.allDistricts.length ? `<tr><th>Quartiers OSM</th><td>${d.allDistricts.map(toText).join(', ')}</td></tr>` : ''}
    ${d.streetInsights.streets.length ? `<tr><th>Principales rues</th><td>${d.streetInsights.streets.slice(0, 10).map(toText).join(', ')}</td></tr>` : ''}
  </tbody>
</table>

<h2>2. Population exposée</h2>
<div class="pop-block">
  <div class="pop-num">${d.population > 0 ? d.population.toLocaleString('fr-FR') : '?'} habitants</div>
  <div style="font-size:9.5pt;color:#666;margin-top:.2em">${toText(d.popSource)}</div>
  ${d.childrenEstimate > 0 ? `<div style="margin-top:.4em">👶 Enfants scolarisés estimés : <strong>~${d.childrenEstimate.toLocaleString('fr-FR')}</strong></div>` : ''}
  ${d.ehpadResidents > 0 ? `<div>🧓 Résidents EHPAD (mobilité réduite) : <strong>~${d.ehpadResidents.toLocaleString('fr-FR')}</strong></div>` : ''}
</div>

<h2>3. Dangers dans la zone</h2>
${d.dangers.length ? `<div class="danger-block">
  <strong>⚠️ ${d.dangers.length} site(s) dangereux détecté(s) — plan d'évacuation à adapter</strong>
</div>
<table>
  <thead><tr><th>Nom</th><th>Type</th><th>Adresse</th></tr></thead>
  <tbody>${d.dangers.map((r) => `<tr>
    <td>${toText(r.name || 'Sans nom')}</td>
    <td>${toText((RESOURCE_TYPE_META[r.type] || {}).label || r.type)}</td>
    <td>${toText(r.address || '–')}</td>
  </tr>`).join('')}</tbody>
</table>` : '<p class="empty">⚠️ Aucun site dangereux détecté dans la zone.</p>'}

<h2>4. Secours disponibles dans la zone</h2>
${resourceTable('Casernes de pompiers', '🚒', d.fireStations)}
${resourceTable('Police / Gendarmerie', '🛡️', d.police)}
${resourceTable('Hôpitaux et cliniques', '🏥', d.hospitals)}

<h2>5. Points d'évacuation et d'accueil</h2>
${resourceTable("Lieux d'accueil hébergeables", '🏟️', d.hostings)}
${resourceTable('Nœuds de transport', '🚆', d.transports)}

<h2>6. Populations vulnérables — évacuation prioritaire</h2>
${schoolsByType.creche.length ? resourceTable('Crèches', '🍼', schoolsByType.creche) : ''}
${schoolsByType.ecole_primaire.length ? resourceTable('Écoles primaires', '🧒', schoolsByType.ecole_primaire) : ''}
${schoolsByType.college.length ? resourceTable('Collèges', '🎒', schoolsByType.college) : ''}
${schoolsByType.lycee.length ? resourceTable('Lycées', '📘', schoolsByType.lycee) : ''}
${schoolsByType.universite.length ? resourceTable('Universités', '🎓', schoolsByType.universite) : ''}
${d.ehpads.length ? resourceTable('EHPAD (évacuation médicalisée requise)', '🧓', d.ehpads) : ''}
${!d.schools.length && !d.ehpads.length ? '<p class="empty">Aucun établissement scolaire ni EHPAD détecté dans la zone.</p>' : ''}

<div class="footer">
  Rapport généré automatiquement par OPE-Protec · Sources : INSEE, geo.api.gouv.fr, FINESS data.gouv.fr, OpenStreetMap, Géorisques<br>
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

function clearZoneImpactSelection() {
  if (mapZoneImpactLayer) mapZoneImpactLayer.clearLayers();
  mapZoneImpactSelection = null;
  if (mapZoneImpactDrawHandler?.disable) mapZoneImpactDrawHandler.disable();
  setMapFeedback('Analyse de zone effacée.');
  renderZoneImpactPanel();
}

function startZoneImpactSelection() {
  if (!leafletMap || typeof window.L === 'undefined') return;
  if (mapZoneImpactDrawHandler?.enable) mapZoneImpactDrawHandler.enable();
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
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
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
    floodZoneWmsLayer.bringToFront();
    return;
  }
  // Créer un pane dédié au-dessus des markers (overlayPane = 400) mais sous les popups (700)
  if (!leafletMap.getPane('floodZonePane')) {
    const pane = leafletMap.createPane('floodZonePane');
    pane.style.zIndex = 450;
    pane.style.pointerEvents = 'none';
  }
  // Couches WMS Géorisques : PPRI approuvés + prescrits (colorés par niveau d'aléa côté serveur)
  // Rouge = aléa fort · Orange = aléa moyen · Bleu = aléa faible
  floodZoneWmsLayer = window.L.tileLayer.wms('https://georisques.gouv.fr/services', {
    layers: 'PPRN_COMMUNE_RISQINOND_APPROUV,PPRN_COMMUNE_RISQINOND_PRESCRIT',
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    opacity: 0.65,
    pane: 'floodZonePane',
    attribution: '&copy; État / Géorisques — Zones inondables PPRI Isère',
  }).addTo(leafletMap);
}

function initMap() {
  if (leafletMap || typeof window.L === 'undefined') return;
  leafletMap = window.L.map('isere-map-leaflet', { zoomControl: true }).setView([45.2, 5.72], 9);
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
  initMapAnnotationModule();
  itinisereLayer = window.L.layerGroup().addTo(leafletMap);
  bisonLayer = window.L.layerGroup().addTo(leafletMap);
  bisonCameraLayer = window.L.layerGroup().addTo(leafletMap);
  photoCameraLayer = window.L.layerGroup().addTo(leafletMap);
  institutionLayer = window.L.layerGroup().addTo(leafletMap);
  populationLayer = window.L.layerGroup().addTo(leafletMap);
  leafletMap.on('click', onMapClickAddPoint);
  leafletMap.on('click', handleOsmDetailsClick);
  leafletMap.on('popupopen', refreshPhotoCameraImages);
  leafletMap.on('zoomend', updateTrafficZoomClass);
  updateTrafficZoomClass();
  startPhotoCameraAutoRefresh();
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
  if (!leafletMap || mapAddPointMode || typeof fetch !== 'function') return;
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
  if (!panel || !coordsNode || !googleLink) return;
  const formattedCoords = formatCoordinates(lat, lon);
  const hasCoords = formattedCoords !== '-';
  coordsNode.textContent = formattedCoords;
  if (hasCoords) {
    const latNumber = Number(lat);
    const lonNumber = Number(lon);
    googleLink.href = `https://www.google.com/maps?q=${encodeURIComponent(`${latNumber},${lonNumber}`)}`;
    panel.hidden = false;
    return;
  }
  googleLink.href = '#';
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
    'filter-resources-telecom-type': 'all',
    'map-basemap-select': 'osm',
  };
  Object.entries(defaults).forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.value = value;
  });
  const hydro = document.getElementById('filter-hydro');
  const pcs = document.getElementById('filter-pcs');
  const activeOnly = document.getElementById('filter-resources-active');
  const schools = document.getElementById('filter-resources-schools');
  const security = document.getElementById('filter-resources-security');
  const fireStations = document.getElementById('filter-resources-fire');
  const riskResources = document.getElementById('filter-resources-risks');
  const transportResources = document.getElementById('filter-resources-transport');
  const trafficIncidents = document.getElementById('filter-traffic-incidents');
  const cameras = document.getElementById('filter-cameras');
  const googleFlow = document.getElementById('filter-google-traffic-flow');
  const healthResources = document.getElementById('filter-resources-health');
  const commandResources = document.getElementById('filter-resources-command');
  const hostingResources = document.getElementById('filter-resources-hosting');
  const telecomResources = document.getElementById('filter-resources-telecom');
  if (hydro) hydro.checked = true;
  if (pcs) pcs.checked = true;
  if (activeOnly) activeOnly.checked = true;
  if (schools) schools.checked = false;
  if (security) security.checked = false;
  if (fireStations) fireStations.checked = false;
  if (riskResources) riskResources.checked = false;
  if (transportResources) transportResources.checked = false;
  if (trafficIncidents) trafficIncidents.checked = true;
  if (cameras) cameras.checked = true;
  if (healthResources) healthResources.checked = false;
  if (commandResources) commandResources.checked = true;
  if (hostingResources) hostingResources.checked = false;
  if (telecomResources) telecomResources.checked = false;
  if (googleFlow) googleFlow.checked = false;
  resourceVisibilityOverrides.clear();
  syncTelecomFilterState();
  if (searchLayer) searchLayer.clearLayers();
  applyBasemap('osm');
  renderStations(cachedVigicruesPayload);
  renderCustomPoints();
  renderResources();
  await renderMunicipalitiesOnMap(cachedMunicipalities);
  await renderPopulationByCityLayer();
  await renderTrafficOnMap();
  renderMapChecks([]);
  clearZoneImpactSelection();
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
  const layers = [boundaryLayer, hydroLayer, hydroLineLayer, pcsBoundaryLayer, pcsLayer, resourceLayer, institutionLayer, populationLayer, searchLayer, customPointsLayer, mapPointsLayer, itinisereLayer, bisonLayer, bisonCameraLayer, photoCameraLayer].filter(Boolean);
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
  const visible = document.getElementById('filter-hydro')?.checked ?? true;
  setHtml('hydro-stations-list', stations.slice(0, 40).map((s) => {
    const statusLevel = stationStatusLevel(s);
    return `<li><strong>${s.station || s.code}</strong> · ${s.river || ''} · <span style="color:${levelColor(statusLevel)}">${statusLevel}</span> · Contrôle: ${escapeHtml(s.control_status || 'inconnu')} · ${s.height_m} m</li>`;
  }).join('') || '<li>Aucune station.</li>');
  if (!hydroLayer || !hydroLineLayer) return;
  hydroLayer.clearLayers();
  hydroLineLayer.clearLayers();
  if (!visible) {
    mapStats.stations = 0;
    updateMapSummary();
    return;
  }

  const stationsWithPoints = stations
    .map((s) => {
      const coords = normalizeMapCoordinates(s.lat, s.lon);
      return coords ? { ...s, ...coords } : null;
    })
    .filter(Boolean);
  mapStats.stations = stationsWithPoints.length;
  stationsWithPoints.forEach((s) => {
    const statusLevel = stationStatusLevel(s);
    const counter = ({ vert: 'V', jaune: 'J', orange: 'O', rouge: 'R' }[statusLevel] || 'V');
    window.L.marker([s.lat, s.lon], { icon: vigicruesStationIcon(statusLevel, counter) })
      .bindPopup(`<strong>${s.station || s.code}</strong><br>${s.river || ''}<br>Département: Isère (38)<br>Statut: ${statusLevel}<br>Contrôle station: ${escapeHtml(s.control_status || 'inconnu')}<br>Hauteur: ${s.height_m} m`)
      .addTo(hydroLayer);
  });

  troncons.forEach((troncon) => {
    const polyline = Array.isArray(troncon?.polyline) ? troncon.polyline : [];
    if (!polyline.length) return;
    const points = polyline
      .map((point) => Array.isArray(point) && point.length >= 2 ? normalizeMapCoordinates(point[0], point[1]) : null)
      .filter(Boolean);
    if (points.length < 2) return;
    const level = normalizeLevel(troncon.level || 'vert');
    window.L.polyline(points.map((point) => [point.lat, point.lon]), { color: levelColor(level), weight: 6, opacity: 0.9 })
      .bindPopup(`<strong>${escapeHtml(troncon.name || 'Tronçon Isère')}</strong><br>Code: ${escapeHtml(troncon.code || 'N/A')}<br>Niveau: ${escapeHtml(level)}${troncon.rss ? `<br><a href="${escapeHtml(troncon.rss)}" target="_blank" rel="noopener noreferrer">Flux RSS</a>` : ''}`)
      .addTo(hydroLineLayer);
  });

  updateMapSummary();
  setMapFeedback(`${stations.length} station(s) Vigicrues Isère chargée(s).`);
}

async function geocodeMunicipality(municipality) {
  const key = `${municipality.name}|${municipality.postal_code || ''}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  try {
    const queries = municipality.postal_code
      ? [
          `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&codePostal=${encodeURIComponent(municipality.postal_code)}&fields=centre&limit=1`,
          `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&fields=centre&limit=1`,
        ]
      : [`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(municipality.name)}&fields=centre&limit=1`];

    for (const url of queries) {
      const response = await queueApiRequest(() => fetchWithTimeout(url));
      const payload = await parseJsonResponse(response, url);
      const center = payload?.[0]?.centre?.coordinates;
      if (!Array.isArray(center) || center.length !== 2) continue;
      const point = normalizeMapCoordinates(center[1], center[0]);
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
      })
        .bindPopup(`<strong>${municipality.name}</strong><br>Contour communal PCS`)
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

  if (amenity === 'kindergarten') return 'creche';
  if (amenity === 'community_centre' || amenity === 'arts_centre') return 'centre_culturel';
  if (amenity === 'theatre') return 'salle_spectacle_public';
  if (amenity === 'social_facility' || socialFacility.includes('shelter') || socialFacility.includes('group_home')) return 'salle_fetes';
  if (amenity === 'university') return 'universite';
  if (amenity === 'college') return 'college';
  if (amenity === 'school') {
    if (name.includes('lycée') || name.includes('lycee')) return 'lycee';
    if (name.includes('collège') || name.includes('college')) return 'college';
    return 'ecole_primaire';
  }
  if (amenity === 'fire_station') return 'caserne_pompier';
  if (amenity === 'police') {
    if (name.includes('gendarmerie') || policeType.includes('gendarmerie')) return 'gendarmerie';
    if (name.includes('municipale') || policeType.includes('municipal')) return 'police_municipale';
    return 'commissariat_police_nationale';
  }
  if (amenity === 'bus_station') return 'transport_gare_routiere';
  if (railway === 'station') return 'transport_gare_sncf';
  if (aeroway === 'aerodrome' || aeroway === 'airport') return 'transport_aeroport';
  if (leisure === 'sports_hall' || building === 'sports_hall') return 'gymnase';
  if (name.includes('gymnase') || name.includes('complexe sportif')) return 'gymnase';
  if (name.includes('maison des associations') || name.includes('centre social') || name.includes('maison de quartier')) return 'centre_culturel';
  if (name.includes('salle des fêtes') || name.includes('salle des fetes') || name.includes('salle polyvalente')) return 'salle_fetes';
  return null;
}

function shouldDisplayBaseResourceType(type = '') {
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
  if (RISK_RESOURCE_TYPES.has(type)) {
    const risksEnabled = document.getElementById('filter-resources-risks')?.checked ?? false;
    const risksTypeFilter = document.getElementById('filter-resources-risks-type')?.value || 'all';
    if (!risksEnabled) return false;
    return risksTypeFilter === 'all' || risksTypeFilter === type;
  }
  if (TRANSPORT_RESOURCE_TYPES.has(type)) {
    const transportEnabled = document.getElementById('filter-resources-transport')?.checked ?? false;
    const transportTypeFilter = document.getElementById('filter-resources-transport-type')?.value || 'all';
    if (!transportEnabled) return false;
    if (transportTypeFilter === 'all') return true;
    if (type === 'transport' && transportTypeFilter === 'transport_gare_sncf') return true;
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
    return hostingTypeFilter === 'all' || hostingTypeFilter === type;
  }
  return true;
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
    // Cache court (2 min) pour pouvoir reessayer rapidement si le backend charge encore
    const payload = await api('/api/finess/isere/resources?limit=20000', { cacheTtlMs: 2 * 60 * 1000 });
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
  } else {
    // Données vides : le backend est probablement en train de charger le CSV FINESS
    // Planifier un seul retry automatique dans 90s pour ne pas bloquer les interactions
    finessLoaded = true; // bloquer les appels répétés pendant le délai
    const retryDelay = backendPending ? 90 * 1000 : 3 * 60 * 1000;
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

async function loadIsereInstitutions() {
  if (institutionsLoaded) return institutionPointsCache;
  // Cache localStorage valide (7j) — affichage immédiat, ne charger que si non vide
  const cached = readFreshSnapshot(STORAGE_KEYS.staticInstitutionsCache, STATIC_POINTS_CACHE_TTL_MS);
  if (Array.isArray(cached) && cached.length > 0) {
    institutionPointsCache = cached;
    institutionsLoaded = true;
    return institutionPointsCache;
  }
  // Utiliser le cache périmé immédiatement comme fallback pendant que l'API charge
  const staleImmediate = readSnapshot(STORAGE_KEYS.staticInstitutionsCache);
  if (Array.isArray(staleImmediate) && staleImmediate.length > 0) {
    institutionPointsCache = staleImmediate;
  }
  const areaQueries = [
    '["boundary"="administrative"]["admin_level"="6"]["ref:INSEE"="38"]',
    '["boundary"="administrative"]["admin_level"="6"]["name"="Isère"]',
    '["boundary"="administrative"]["admin_level"="6"]["name"="Isere"]',
  ];
  const overpassEndpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const buildQuery = (areaFilter) => `[out:json][timeout:70];
area${areaFilter}->.searchArea;
(
  nwr["amenity"~"school|college|university|kindergarten|police|fire_station|bus_station|community_centre|arts_centre|theatre|social_facility"](area.searchArea);
  nwr["leisure"="sports_hall"](area.searchArea);
  nwr["building"="sports_hall"](area.searchArea);
  nwr["railway"="station"](area.searchArea);
  nwr["aeroway"~"aerodrome|airport"](area.searchArea);
  nwr["name"~"gymnase|salle des fetes|salle des fêtes|salle polyvalente|maison des associations|centre social", i](area.searchArea);
);
out center tags;`;

  let points = [];
  for (const endpoint of overpassEndpoints) {
    for (const areaFilter of areaQueries) {
      try {
        const response = await queueApiRequest(() => fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: buildQuery(areaFilter),
        }));
        const payload = await parseJsonResponse(response, `overpass-institutions-${areaFilter}`);
        const elements = Array.isArray(payload?.elements) ? payload.elements : [];
        const seenIds = new Set();
        points = elements
          .map((element) => {
            const type = classifyInstitutionPoint(element);
            if (!type) return null;
            const lat = Number(element.lat ?? element.center?.lat);
            const lon = Number(element.lon ?? element.center?.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            const id = `osm-${element.type}-${element.id}`;
            if (seenIds.has(id)) return null;
            seenIds.add(id);
            const name = String(element.tags?.name || '').trim() || 'Établissement';
            const address = [element.tags?.['addr:housenumber'], element.tags?.['addr:street'], element.tags?.['addr:city']].filter(Boolean).join(' ') || 'Adresse non renseignée';
            return {
              id,
              name,
              type,
              lat,
              lon,
              active: true,
              address,
              priority: 'standard',
              info: `Source OSM · amenity=${String(element.tags?.amenity || '-')}`,
              source: `https://www.openstreetmap.org/${element.type}/${element.id}`,
              dynamic: true,
            };
          })
          .filter(Boolean);
        if (points.length) break;
      } catch {
        points = [];
      }
    }
    if (points.length) break;
  }
  if (points.length > 0) {
    institutionPointsCache = points;
    saveSnapshot(STORAGE_KEYS.staticInstitutionsCache, institutionPointsCache);
    institutionsLoaded = true;
  } else {
    // Overpass n'a rien retourné : utiliser le cache périmé si disponible
    const staleCached = readSnapshot(STORAGE_KEYS.staticInstitutionsCache);
    if (Array.isArray(staleCached) && staleCached.length > 0) {
      institutionPointsCache = staleCached;
    }
    // Planifier un retry automatique dans 2 min (Overpass peut être temporairement surchargé)
    institutionsLoaded = true; // bloquer les appels répétés pendant le délai
    setTimeout(async () => {
      institutionsLoaded = false;
      const prev = institutionPointsCache.length;
      _institutionsLoadInFlight = true;
      await loadIsereInstitutions();
      _institutionsLoadInFlight = false;
      if (institutionPointsCache.length > prev) _drawResourceMarkers();
    }, 2 * 60 * 1000);
  }
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

    telecomPointsCache = [...anfrResources, ...arcepResources];

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
  const staticResources = RESOURCE_POINTS
    .filter((r) => r.active)
    .filter((r) => resourceVisibilityOverrides.get(r.id) !== false)
    .filter((r) => shouldDisplayBaseResourceType(r.type))
    .filter((r) => !query || `${r.name} ${r.address}`.toLowerCase().includes(query))
    .map((r) => ({ ...r, dynamic: false }));
  const dynamicResources = [...institutionPointsCache, ...finessPointsCache, ...telecomPointsCache]
    .filter((r) => shouldDisplayBaseResourceType(r.type))
    .filter((r) => resourceVisibilityOverrides.get(r.id) !== false)
    .filter((r) => !query || `${r.name} ${r.address}`.toLowerCase().includes(query));
  return [...staticResources, ...dynamicResources];
}

function getResourcesForZoneImpact() {
  const staticResources = RESOURCE_POINTS
    .filter((resource) => resource.active)
    .map((resource) => ({ ...resource, dynamic: false }));
  const dynamicResources = [...institutionPointsCache, ...finessPointsCache, ...telecomPointsCache];
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
let _telecomLoadInFlight = false;

/** Retourne true si au moins un loader de données statiques est encore en cours. */
function _staticDataLoading() {
  return _institutionsLoadInFlight || _finessLoadInFlight || _telecomLoadInFlight;
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
    const meta = RESOURCE_TYPE_META[r.type] || { label: r.type.replace(/_/g, ' '), icon: '📍' };
    const statusLabel = r.active ? 'affichée' : 'masquée';
    const toggleButton = r.dynamic ? '' : `<button type="button" class="ghost" data-resource-toggle="${escapeHtml(r.id)}">${r.active ? 'Masquer' : 'Afficher'}</button>`;
    return `<li>
      <strong>${meta.icon} ${r.name}</strong> · ${r.address}<br/>
      <span class="muted">${meta.label} · ${statusLabel} · ${priorityLabel[r.priority] || 'standard'}</span><br/>
      <span class="muted">${escapeHtml(r.info || 'Aucune information complémentaire.')}</span><br/>
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
    const meta = RESOURCE_TYPE_META[r.type] || { label: r.type.replace(/_/g, ' '), icon: '📍' };
    const markerHtml = `<span class="map-resource-icon" style="background:${markerColor[r.priority] || '#2f9e44'}">${meta.icon}</span>`;
    window.L.marker([coords.lat, coords.lon], {
      icon: window.L.divIcon({ className: 'map-resource-icon-wrap', html: markerHtml, iconSize: [24, 24], iconAnchor: [12, 12] }),
    })
      .bindPopup(`<strong>${meta.icon} ${r.name}</strong><br>Type: ${meta.label}<br>Niveau: ${priorityLabel[r.priority] || 'standard'}<br>Adresse: ${r.address}<br>${escapeHtml(r.info || '')}${formatFinessDetailsHtml(r)}<br><a href="${escapeHtml(r.source || '#')}" target="_blank" rel="noreferrer">Source publique</a>`)
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
function _ensureStaticDataLoaded() {
  if (!institutionsLoaded && !_institutionsLoadInFlight) {
    _institutionsLoadInFlight = true;
    loadIsereInstitutions()
      .then(() => { _institutionsLoadInFlight = false; _drawResourceMarkers(); })
      .catch(() => { _institutionsLoadInFlight = false; });
  }
  if (!finessLoaded && !_finessLoadInFlight) {
    _finessLoadInFlight = true;
    loadFinessIsereResources()
      .then(() => { _finessLoadInFlight = false; _drawResourceMarkers(); })
      .catch(() => { _finessLoadInFlight = false; });
  }
  if (!telecomLoaded && !_telecomLoadInFlight) {
    _telecomLoadInFlight = true;
    loadTelecomPoints()
      .then(() => { _telecomLoadInFlight = false; _drawResourceMarkers(); })
      .catch(() => { _telecomLoadInFlight = false; });
  }
}

/**
 * Point d'entrée principal pour afficher les ressources sur la carte.
 * 1. Rendu immédiat depuis le cache (0 ms d'attente pour l'utilisateur).
 * 2. Lance les loaders manquants en arrière-plan — quand ils arrivent,
 *    les marqueurs se mettent à jour automatiquement sans action utilisateur.
 */
function renderResources() {
  _drawResourceMarkers();
  _ensureStaticDataLoaded();
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
  const resources = [...RESOURCE_POINTS, ...institutionPointsCache];
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

function serviceErrorLabel(service) {
  return service?.error || (service?.status && service.status !== 'online' ? 'Service indisponible ou dégradé.' : 'Aucune erreur détectée.');
}

const MAP_POINT_ICONS = {
  incident: '🚨',
  evacuation: '🏃',
  water: '💧',
  roadblock: '🚧',
  medical: '🏥',
  logistics: '📦',
  command: '🛰️',
  poi: '📌',
  autre: '📍',
};

const MAP_ICON_SUGGESTIONS = {
  incident: ['🚨', '🔥', '⚠️', '💥', '🚓', '🚒', '🧯'],
  evacuation: ['🏃', '🏘️', '🚌', '🚶', '🏟️', '🏫', '🧒'],
  water: ['💧', '🌊', '🛶', '🌧️', '🏞️', '🚤', '🪵'],
  roadblock: ['⛔', '🚧', '🚦', '🛑', '🚫', '🚓', '⚠️'],
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

function trafficLevelColor(level) {
  const normalized = normalizeTrafficSeverity(level);
  return ({ rouge: '#d9480f', orange: '#f08c00', jaune: '#f59f00', vert: '#2f9e44' }[normalized] || '#2f9e44');
}

function trafficLevelEmoji(level) {
  return ({ vert: '🟢', jaune: '🟡', orange: '🟠', rouge: '🔴' })[normalizeTrafficSeverity(level)] || '⚪';
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

const ISERE_BOUNDS = {
  latMin: 44.6,
  latMax: 46.0,
  lonMin: 4.2,
  lonMax: 6.8,
};

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
  return `<strong>${escapeHtml(point.title || 'Évènement circulation Isère')}</strong><br/>
    <span class="badge neutral">${escapeHtml(sourceLabel)} · ${escapeHtml(trafficType)} · ${escapeHtml(level)}</span><br/>
    ${escapeHtml(point.description || 'Aucun détail complémentaire fourni.')}<br/>
    Axe(s): ${escapeHtml(roads)}<br/>
    Localisation: ${escapeHtml(locations)} (${escapeHtml(point.precision || 'estimée')})<br/>
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

function normalizeRoadCode(rawRoad = '') {
  const upper = String(rawRoad || '').toUpperCase().replace(/\s+/g, '');
  const compact = upper.replace(/^(?:RD|RN|CD)/, (prefix) => (prefix === 'RN' ? 'N' : 'D'));
  const match = compact.match(/^(A|N|D)(\d{1,4})$/);
  if (!match) return '';
  return `${match[1]}${match[2]}`;
}

function detectRoadCodes(text = '') {
  const roads = new Set();
  const matches = String(text).toUpperCase().match(/\b(?:A|N|D|RN|RD|CD)\s?\d{1,4}\b/g) || [];
  matches
    .map((road) => normalizeRoadCode(road))
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

async function geocodeTrafficLabel(label) {
  const key = String(label || '').trim().toLowerCase();
  if (!key) return null;
  if (trafficGeocodeCache.has(key)) return trafficGeocodeCache.get(key);
  try {
    const communeUrl = `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(label)}&fields=centre,codeDepartement&codeDepartement=38&limit=1`;
    const communeResponse = await queueApiRequest(() => fetchWithTimeout(communeUrl));
    const communePayload = await parseJsonResponse(communeResponse, communeUrl);
    const center = communePayload?.[0]?.centre?.coordinates;
    if (Array.isArray(center) && center.length === 2) {
      const point = { lat: Number(center[1]), lon: Number(center[0]), precision: 'commune' };
      if (isPointInIsere(point)) {
        trafficGeocodeCache.set(key, point);
        return point;
      }
    }
  } catch {
    // fallback nominatim
  }

  try {
    const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(`${label}, Isère, France`)}`;
    const response = await queueApiRequest(() => fetchWithTimeout(nominatimUrl, { headers: { Accept: 'application/json' } }));
    const payload = await parseJsonResponse(response, nominatimUrl);
    const first = payload?.[0];
    const point = first ? { lat: Number(first.lat), lon: Number(first.lon), precision: 'adresse' } : null;
    if (!isPointInIsere(point || {})) {
      trafficGeocodeCache.set(key, null);
      return null;
    }
    trafficGeocodeCache.set(key, point);
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
  const scopedMatches = [...blob.matchAll(/\b(?:sur|secteur|entre|vers|au niveau de)\s+([^\n.;:]+)/gi)];
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

async function buildItinisereMapPoints(events = []) {
  const points = [];
  for (const event of events.slice(0, 80)) {
    const isBisonEvent = String(event.source || '').toLowerCase().includes('bison');
    const fullText = `${event.title || ''} ${event.description || ''}`;
    const roads = (Array.isArray(event.roads) && event.roads.length ? event.roads : detectRoadCodes(fullText))
      .map((road) => normalizeRoadCode(road))
      .filter(Boolean);
    const isClosureEvent = /ferm|barr|interdit|coup/.test(fullText.toLowerCase())
      || String(event.category || '').toLowerCase() === 'fermeture';
    const locationHints = extractItinisereLocationHints(event, fullText, roads);
    const dynamicAlertHints = extractAlertDynamicHints(fullText);
    const locations = Array.isArray(event.locations) ? event.locations.filter(Boolean) : locationHints;
    const communeHints = TRAFFIC_COMMUNES.filter((commune) => {
      const escaped = commune.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(`${fullText} ${locationHints.join(' ')}`);
    });
    const candidateLocationHints = [...new Set([...locations, ...locationHints, ...dynamicAlertHints, ...communeHints])];
    let position = null;
    let anchor = '';
    let precision = 'estimée';
    let communeAnchor = null;

    const providedCoords = normalizeMapCoordinates(event.lat, event.lon);
    if (isBisonEvent && !providedCoords) continue;
    if (providedCoords && !roads.length) {
      position = providedCoords;
      anchor = locations[0] || roads[0] || 'Itinisère';
      precision = 'source';
    }
    if (!position && providedCoords) {
      position = providedCoords;
      anchor = locations[0] || roads[0] || 'Itinisère';
      precision = 'source';
    }
    if (!position) {
      for (const location of candidateLocationHints) {
        position = await geocodeTrafficLabel(location);
        anchor = location;
        if (position) {
          precision = position.precision === 'commune' ? 'commune' : (position.precision || 'localité');
          break;
        }
      }
    }

    if (!position && isClosureEvent) {
      const closureCommuneHints = extractClosureCommuneHints(event, fullText);
      for (const commune of closureCommuneHints) {
        const communePoint = await geocodeClosureCommune(commune) || await geocodeTrafficLabel(commune);
        if (!communePoint) continue;
        position = { lat: communePoint.lat, lon: communePoint.lon };
        anchor = `Mairie de ${communePoint.communeName || commune}`;
        precision = 'mairie';
        break;
      }
    }

    if (!position && communeHints.length) {
      for (const commune of communeHints) {
        communeAnchor = await geocodeTrafficLabel(commune);
        if (communeAnchor) break;
      }
    }

    if (!position) {
      for (const road of roads) {
        const corridor = ITINISERE_ROAD_CORRIDORS[road];
        if (!corridor) continue;
        const roadPoint = nearestPointOnCorridor(corridor, communeAnchor);
        if (!roadPoint) continue;
        position = roadPoint;
        anchor = communeHints[0] ? `${road} · ${communeHints[0]}` : `Axe ${road}`;
        precision = communeAnchor ? 'axe+commune' : 'axe';
        break;
      }
    }

    if (!position) {
      for (const road of roads) {
        const corridor = ITINISERE_ROAD_CORRIDORS[road];
        if (!corridor) continue;
        position = { lat: corridor[0][0], lon: corridor[0][1] };
        anchor = `Axe ${road}`;
        precision = 'axe';
        break;
      }
    }

    if (!position) {
      for (const commune of [...communeHints, ...TRAFFIC_COMMUNES]) {
        const escaped = commune.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`\\b${escaped}\\b`, 'i').test(`${fullText} ${candidateLocationHints.join(' ')}`)) continue;
        position = await geocodeTrafficLabel(commune);
        anchor = commune;
        if (position) {
          precision = 'commune';
          break;
        }
      }
    }

    if (!position) {
      position = await geocodeTrafficLabel((event.title || '').slice(0, 90));
      anchor = 'Localisation estimée';
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
      severity: normalizeTrafficSeverity(event.severity || (event.category === 'fermeture' ? 'rouge' : 'jaune')),
    });
  }
  return spreadOverlappingTrafficPoints(points);
}

async function renderTrafficOnMap() {
  if (!itinisereLayer || !bisonLayer || !bisonCameraLayer || !photoCameraLayer || typeof window.L === 'undefined') return;
  const renderSequence = ++trafficRenderSequence;
  itinisereLayer.clearLayers();
  bisonLayer.clearLayers();
  bisonCameraLayer.clearLayers();
  photoCameraLayer.clearLayers();
  mapStats.traffic = 0;

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
    BISON_FUTE_CAMERAS.forEach((camera) => {
      const coords = normalizeMapCoordinates(camera.lat, camera.lon);
      if (!coords) return;
      const popupHtml = cameraPopupMarkup(camera);
      const pointIcon = emojiDivIcon('🎥', { iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -11] });
      window.L.marker([coords.lat, coords.lon], { icon: pointIcon }).bindPopup(popupHtml).addTo(bisonCameraLayer);
    });
    mapStats.traffic += BISON_FUTE_CAMERAS.length;

    ITINISERE_PHOTO_CAMERAS.forEach((camera) => {
      const coords = normalizeMapCoordinates(camera.lat, camera.lon);
      if (!coords) return;
      const popupHtml = photoCameraPopupMarkup(camera);
      const pointIcon = emojiDivIcon('📷', { iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -11] });
      window.L.marker([coords.lat, coords.lon], { icon: pointIcon }).bindPopup(popupHtml).addTo(photoCameraLayer);
    });
    mapStats.traffic += ITINISERE_PHOTO_CAMERAS.length;
  }



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
      shapeOptions: { color: '#7c3aed', weight: 2, fillOpacity: 0.12 },
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
        mapZoneImpactSelection.setStyle({ color: '#7c3aed', weight: 2, fillOpacity: 0.12 });
      }
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
        if (typeof layer.setStyle === 'function') layer.setStyle({ color, weight, fillOpacity: 0.2 });
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
        window.L.marker([coords[1], coords[0]], { icon: mapTextAnnotationIcon(record) })
          .bindPopup(`<strong>Texte tactique</strong><br/>${escapeHtml(record.text_label || '-')}`)
          .addTo(mapAnnotationFeatureGroup);
      }
    } else {
      const geo = window.L.geoJSON(record.geojson, { style });
      geo.eachLayer((layer) => {
        const description = record.text_label ? `<br/>${escapeHtml(record.text_label)}` : '';
        layer.bindPopup(`<strong>Annotation ${escapeHtml(record.annotation_type)}</strong>${description}`);
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

async function loadMapPoints() {
  let loadedPoints = [];
  let usedCacheFallback = false;
  const previousPoints = Array.isArray(mapPoints) ? mapPoints : [];

  try {
    const response = await api('/map/points');
    loadedPoints = keepPreviousArray(previousPoints, response);
    localStorage.setItem(STORAGE_KEYS.mapPointsCache, JSON.stringify(loadedPoints));
  } catch (error) {
    usedCacheFallback = true;
    try {
      const cached = JSON.parse(localStorage.getItem(STORAGE_KEYS.mapPointsCache) || '[]');
      loadedPoints = Array.isArray(cached) ? cached : [];
    } catch (_) {
      loadedPoints = [];
    }
    setMapFeedback(`Points personnalisés indisponibles (API): ${sanitizeErrorMessage(error.message)}. Affichage du cache local (${loadedPoints.length}).`, true);
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
  await api('/map/points', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await loadMapPoints();
}

async function deleteMapPoint(pointId) {
  await api(`/map/points/${pointId}`, { method: 'DELETE' });
  await loadMapPoints();
}

function renderCustomPoints(showFeedback = true) {
  if (customPointsLayer) customPointsLayer.clearLayers();
  if (mapPointsLayer) mapPointsLayer.clearLayers();

  const selectedCategory = document.getElementById('map-point-category-filter')?.value || 'all';
  const targetedCategory = document.getElementById('poi-target-category-filter')?.value || 'all';
  const filteredPoints = mapPoints.filter((point) => {
    const isVisible = mapPointVisibilityOverrides.get(point.id) !== false;
    if (!isVisible) return false;
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
    const marker = window.L.marker([point.lat, point.lon], { icon: markerIconForPoint(point) });
    const popupIcon = point.icon_url ? '🖼️' : (point.icon || iconForCategory(point.category));
    marker.bindPopup(`<strong>${escapeHtml(popupIcon)} ${escapeHtml(point.name)}</strong><br/>Catégorie: ${escapeHtml(point.category)}${point.icon_url ? '<br/>Type: POI avec icône personnalisée' : ''}<br/>${escapeHtml(point.notes || 'Sans note')}`);
    marker.addTo(mapPointsLayer);
  });
  if (showFeedback) setMapFeedback(`${filteredPoints.length} marqueur(s) opérationnel(s)/POI affiché(s).`);
}

function onMapClickAddPoint(event) {
  if (!mapAddPointMode) return;
  pendingMapPointCoords = event.latlng;
  openMapPointModal('poi');
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

function renderElectricityStatus(electricity = {}) {
  const status = electricity.status || 'inconnu';
  const level = normalizeLevel(electricity.level || 'inconnu');
  const consumption = Number.isFinite(Number(electricity.consumption_mw)) ? `${Number(electricity.consumption_mw)} MW` : '-';
  const generation = Number.isFinite(Number(electricity.regional_generation_mw)) ? `${Number(electricity.regional_generation_mw)} MW` : '-';
  const margin = Number.isFinite(Number(electricity.supply_margin_mw)) ? `${Number(electricity.supply_margin_mw)} MW` : '-';
  const observedAt = electricity.observed_at ? escapeHtml(electricity.observed_at) : 'non précisé';
  const scope = escapeHtml(electricity.scope || 'Proxy régional ARA');

  setRiskText('electricity-status', `${status} · niveau ${level}`, electricity.level || 'vert');
  setText('electricity-info', `Conso ${consumption} · Prod ${generation} · Marge ${margin}`);

  const breakdown = electricity.production_breakdown_mw && typeof electricity.production_breakdown_mw === 'object'
    ? Object.entries(electricity.production_breakdown_mw)
      .map(([key, value]) => `${escapeHtml(key)}: ${Number.isFinite(Number(value)) ? Number(value) : '-' } MW`)
      .join(' · ')
    : '';

  const rows = [
    `<li><strong>Dernière mesure:</strong> ${observedAt}</li>`,
    `<li><strong>Périmètre:</strong> ${scope}</li>`,
    `<li><strong>Consommation:</strong> ${consumption}</li>`,
    `<li><strong>Production:</strong> ${generation}</li>`,
    `<li><strong>Marge offre/demande:</strong> ${margin}</li>`,
    breakdown ? `<li><strong>Mix régional:</strong> ${breakdown}</li>` : '',
    electricity.error ? `<li><strong>Erreur:</strong> ${escapeHtml(electricity.error)}</li>` : '',
  ].filter(Boolean);

  setHtml('electricity-list', rows.join('') || '<li>Aucune donnée électrique disponible.</li>');
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
    setHtml('georisques-pcs-detail', '<p class="muted">Sélectionnez une commune PCS pour afficher ses informations.</p>');
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
      return `<li><strong>${escapeHtml(String(hazard.label || 'Risque'))}</strong> · <span class="hazard-chip ${tone}">${escapeHtml(String(hazard.knownDanger || 'inconnu'))}</span> · Applicabilité ville: <strong>${hazard.applies ? 'Oui' : 'Non confirmé'}</strong>${hazard.detail ? `<br><span class="muted">${escapeHtml(String(hazard.detail))}</span>` : ''}</li>`;
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
  const cityDocuments = [];
  if (commune.dicrim_publication_year) {
    cityDocuments.push(`DICRIM · publication ${escapeHtml(String(commune.dicrim_publication_year))}`);
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

  setHtml('georisques-pcs-detail', `
    <p><strong>${escapeHtml(communeName)}</strong> <span class="danger-chip ${danger.css}">${escapeHtml(commune.gaspar_danger_level || danger.label)}</span></p>
    <p>INSEE: <strong>${escapeHtml(insee || '-')}</strong> · Danger agrégé: <strong>${escapeHtml(commune.gaspar_danger_level || danger.label)}</strong> · Sismicité: <strong>${escapeHtml(commune.seismic_zone || commune.zone_sismicite || 'inconnue')}</strong> · Radon: <strong>${escapeHtml(commune.radon_label || 'inconnu')}</strong></p>
    <p><strong>Liste complète des risques et applicabilité pour la ville</strong></p>
    <ul class="list compact">${risksMarkup}</ul>
    <p><strong>Documents inondation (AZI)</strong></p>
    <ul class="list compact">${docsText}</ul>
    <p><strong>Documents communaux disponibles (DICRIM, PPR, TIM…)</strong></p>
    <ul class="list compact">${cityDocumentsMarkup}</ul>
    <p><a href="${georisquesSearchUrl}" target="_blank" rel="noreferrer">Rechercher cette commune sur Géorisques</a> · <a href="${georisquesMainUrl}" target="_blank" rel="noreferrer">Site Géorisques</a></p>
  `);
}

function renderGeorisquesPcsRisks(monitored = []) {
  const pcsByName = new Map(
    cachedMunicipalities
      .filter((municipality) => municipality?.pcs_active)
      .map((municipality) => [String(municipality.name || '').trim().toLowerCase(), municipality]),
  );

  const pcsMonitored = monitored
    .filter((commune) => pcsByName.has(String(commune.name || commune.commune || '').trim().toLowerCase()))
    .sort((a, b) => georisquesDangerRank(b) - georisquesDangerRank(a));

  if (!selectedGeorisquesPcsCommuneKey && pcsMonitored.length) {
    selectedGeorisquesPcsCommuneKey = georisquesCommuneKey(pcsMonitored[0]);
  }

  if (selectedGeorisquesPcsCommuneKey && !pcsMonitored.some((commune) => georisquesCommuneKey(commune) === selectedGeorisquesPcsCommuneKey)) {
    selectedGeorisquesPcsCommuneKey = pcsMonitored.length ? georisquesCommuneKey(pcsMonitored[0]) : '';
  }

  const select = document.getElementById('georisques-pcs-select');
  if (select) {
    const options = pcsMonitored.map((commune) => {
      const key = georisquesCommuneKey(commune);
      return `<option value="${escapeHtml(key)}">${escapeHtml(commune.name || commune.commune || 'Commune inconnue')} (${escapeHtml(commune.code_insee || '-')})</option>`;
    }).join('');
    setHtml('georisques-pcs-select', `<option value="">Sélectionnez une commune PCS</option>${options}`);
    if (selectedGeorisquesPcsCommuneKey) {
      select.value = selectedGeorisquesPcsCommuneKey;
    }
  }

  const selectedCommune = pcsMonitored.find((commune) => georisquesCommuneKey(commune) === selectedGeorisquesPcsCommuneKey) || null;
  renderGeorisquesPcsDetail(selectedCommune);
}

function renderGeorisquesDetails(georisques = {}) {
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
  setText('municipality-editor-title', `Éditer ${municipality.name}`);
  setVisibility(panel, true);
}

function closeMunicipalityEditor() {
  const panel = document.getElementById('municipality-editor');
  if (!panel) return;
  setVisibility(panel, false);
}

async function loadMunicipalityFiles(municipalityId) {
  const files = await api(`/municipalities/${municipalityId}/files`);
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
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || typeof onProgress !== 'function') return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error('Failed to fetch'));
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

  const [files, logs] = await Promise.all([
    loadMunicipalityFiles(municipality.id).catch(() => []),
    api('/logs').catch(() => []),
  ]);
  const municipalityLogs = (Array.isArray(logs) ? logs : [])
    .filter((log) => String(log.municipality_id || '') === String(municipality.id))
    .slice(0, 8);
  const municipalityEvents = sortOperationalEvents(cachedEvents)
    .filter((event) => String(event.municipality_id || '') === String(municipality.id) && isOpenOrActiveEvent(event))
    .slice(0, 8);
  const previousState = municipalityDocumentsUiState.get(String(municipality.id)) || { search: '', type: 'all', sort: 'date_desc', uploading: false, progress: 0 };
  const state = { ...previousState, uploading: false, progress: 0 };
  municipalityDocumentsUiState.set(String(municipality.id), state);
  const filteredFiles = files
    .filter((file) => {
      const search = (state.search || '').trim().toLowerCase();
      if (state.type !== 'all' && file.doc_type !== state.type) return false;
      if (!search) return true;
      return [file.title, file.doc_type, file.uploaded_by].some((value) => String(value || '').toLowerCase().includes(search));
    })
    .sort((left, right) => {
      if (state.sort === 'title') return String(left.title || '').localeCompare(String(right.title || ''), 'fr');
      const leftDate = new Date(left.created_at).getTime();
      const rightDate = new Date(right.created_at).getTime();
      if (state.sort === 'date_asc') return leftDate - rightDate;
      return rightDate - leftDate;
    });
  const byType = files.reduce((acc, file) => {
    const key = file.doc_type || 'document';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const quickActions = canMunicipalityFiles()
    ? `<div class="municipality-actions municipality-actions--modal">
         ${canEdit() ? `<button type="button" class="ghost inline-action" data-muni-detail-crisis="${municipality.id}">${municipality.crisis_mode ? 'Sortir de crise' : 'Passer en crise'}</button>
         ` : ''}
         <form class="municipality-upload-form" data-muni-upload-form="${municipality.id}">
           <input name="title" placeholder="Titre du document" required />
           <select name="doc_type">
             <option value="pcs">PCS</option>
             <option value="orsec">ORSEC</option>
             <option value="convention">Convention</option>
             <option value="cartographie">Cartographie</option>
             <option value="annexe">Annexe</option>
             <option value="document" selected>Document</option>
           </select>
           <input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg" required />
           <button type="submit" class="ghost inline-action">Ajouter</button>
         </form>
         <div class="municipality-upload-progress hidden" data-muni-upload-progress="${municipality.id}" hidden>
           <div class="municipality-upload-progress__bar" style="width:${state.progress}%"></div>
           <span data-muni-upload-progress-label="${municipality.id}">${state.progress}%</span>
         </div>
       </div>`
    : '';

  setHtml('municipality-details-content', `
    <h4>${escapeHtml(municipality.name)}</h4>
    <p><strong>Téléphone:</strong> ${escapeHtml(municipality.phone || '-')} · <strong>Email:</strong> ${escapeHtml(municipality.email || '-')}</p>
    <p><strong>Code postal:</strong> ${escapeHtml(municipality.postal_code || '-')} · <strong>Code INSEE:</strong> ${escapeHtml(municipality.insee_code || '-')} · <strong>PCS:</strong> ${municipality.pcs_active ? 'actif' : 'inactif'}</p>
    <p><strong>Statut:</strong> ${municipality.crisis_mode ? 'CRISE' : 'veille'} · <strong>Vigilance:</strong> ${escapeHtml(normalizeLevel(municipality.vigilance_color || 'vert'))}</p>
    <p><strong>Population:</strong> ${municipality.population ?? '-'} · <strong>Capacité d'accueil:</strong> ${municipality.shelter_capacity ?? '-'}</p>
    <p><strong>Contacts d'astreinte:</strong><br>${escapeHtml(municipality.contacts || 'Aucun')}</p>
    <p><strong>Informations complémentaires:</strong><br>${escapeHtml(municipality.additional_info || 'Aucune')}</p>
    <h5>Documents partagés</h5>
    <p class="muted">Total: <strong>${files.length}</strong>${Object.entries(byType).map(([type, count]) => ` · ${escapeHtml(type)}: ${count}`).join('')}</p>
    ${municipalityDocumentFiltersMarkup(state, municipality.id)}
    <ul class="list compact">${municipalityFilesMarkup(filteredFiles, municipality.id)}</ul>
    <h5>Évènements actifs de la commune (accès direct)</h5>
    <ul class="list compact">${municipalityEvents.map((event) => {
      const status = EVENT_STATUS_LABEL[event.status] || event.status || 'Ouvert';
      return `<li><strong>${escapeHtml(event.title || 'Évènement')}</strong> · <span class="badge neutral">${escapeHtml(status)}</span><br>${escapeHtml(event.address || 'Adresse non renseignée')}<br><button type="button" class="ghost inline-action" data-muni-open-event="${event.id}">Ouvrir la fiche évènement</button></li>`;
    }).join('') || '<li>Aucun évènement ouvert/en cours lié à cette commune.</li>'}</ul>
    <h5>Main courante liée à la commune</h5>
    <ul class="list compact">${municipalityLogs.map((log) => {
      const status = LOG_STATUS_LABEL[String(log.status || 'nouveau')] || 'Nouveau';
      const eventTitle = getEventTitle(log.event_id);
      const openAction = log.event_id ? `<br><button type="button" class="ghost inline-action" data-muni-open-event="${log.event_id}">Accéder à l'évènement</button>` : '';
      return `<li><strong>${new Date(log.created_at).toLocaleString()}</strong> · ${log.danger_emoji || '🟢'} <strong>${escapeHtml(log.event_type || 'MCO')}</strong> · <span class="badge neutral">${status}</span><br><span class="muted">${escapeHtml(eventTitle)}</span><br>${escapeHtml(log.description || '')}${openAction}</li>`;
    }).join('') || '<li>Aucune entrée main courante associée.</li>'}</ul>
    ${quickActions}
  `);

  content.querySelectorAll('button').forEach((button) => {
    if ((button.textContent || '').trim().toLowerCase() === 'éditer la fiche') button.remove();
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
    await loadMunicipalities();
    const refreshed = cachedMunicipalityRecords.find((m) => String(m.id) === String(municipalityId));
    if (refreshed) await openMunicipalityDetailsModal(refreshed);
  };
  picker.click();
}

async function submitMunicipalityUploadForm(form, municipalityId) {
  const file = form.elements.file.files?.[0];
  if (!file) return;
  const title = form.elements.title.value.trim() || file.name;
  const docType = form.elements.doc_type.value || 'document';
  const formData = new FormData();
  formData.append('file', file);
  formData.append('title', title);
  formData.append('doc_type', docType);

  const progressWrap = document.querySelector(`[data-muni-upload-progress="${municipalityId}"]`);
  const progressLabel = document.querySelector(`[data-muni-upload-progress-label="${municipalityId}"]`);
  if (progressWrap) {
    progressWrap.hidden = false;
    progressWrap.classList.remove('hidden');
  }

  await uploadMunicipalityDocumentWithFallback(municipalityId, formData, (progress) => {
    const bar = progressWrap?.querySelector('.municipality-upload-progress__bar');
    if (bar) bar.style.width = `${progress}%`;
    if (progressLabel) progressLabel.textContent = `${progress}%`;
  });

  await loadMunicipalities();
  const refreshed = cachedMunicipalityRecords.find((m) => String(m.id) === String(municipalityId));
  if (refreshed) await openMunicipalityDetailsModal(refreshed);
}

function safeDateToLocale(value, options = {}) {
  const timestamp = new Date(value || 0);
  return Number.isFinite(timestamp.getTime()) && timestamp.getTime() > 0
    ? timestamp.toLocaleString('fr-FR', options)
    : '-';
}

function toDatetimeLocal(value) {
  const date = new Date(value || 0);
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
  return `<li><strong>${at}</strong> · <span class="badge neutral">${status}</span> · <span class="badge neutral">${scope}</span><br>${icon} <strong style="color:${levelColor(log.danger_level)}">${escapeHtml(log.event_type || 'Évènement')}</strong> · ${escapeHtml(log.description || '')}</li>`;
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
  const georisques = externalRisks?.georisques?.data && typeof externalRisks.georisques.data === 'object'
    ? { ...externalRisks.georisques.data, ...externalRisks.georisques }
    : (externalRisks?.georisques || {});

  risks.push(`<li><strong>Itinisère</strong> · ${(itinisereEvents || []).length} événement(s) actif(s) · Statut ${escapeHtml(externalRisks?.itinisere?.status || 'inconnu')}</li>`);
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

function buildOpenEventsSituationMarkup(events = []) {
  const openEvents = sortOperationalEvents(events).filter((event) => String(event.status || '').toLowerCase() === 'ouvert');
  if (!openEvents.length) return '<li>Aucun évènement ouvert.</li>';
  return openEvents.slice(0, 10).map((event) => {
    const status = EVENT_STATUS_LABEL[event.status] || event.status || 'Ouvert';
    const locality = event.municipality_id ? getMunicipalityName(event.municipality_id) : 'Départemental';
    return `<li><strong>${escapeHtml(event.title || 'Évènement')}</strong> · <span class="badge neutral">${escapeHtml(status)}</span><br/><span class="muted">${escapeHtml(locality)} · ${escapeHtml(event.address || 'Adresse non renseignée')}</span></li>`;
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
    case 'crues':
      return `<p><strong>Niveau Vigicrues:</strong> ${escapeHtml(normalizeLevel(vigicrues.water_alert_level || 'inconnu'))}</p><p><strong>Stations suivies:</strong> ${Number((vigicrues.stations || []).length || 0)}</p>`;
    case 'global-risk':
      return `<p><strong>Risque global consolidé:</strong> ${escapeHtml(normalizeLevel(dashboard.global_risk || meteo.level || 'inconnu'))}</p><p class="muted">Consolidation météo + crues + alertes externes.</p>`;
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

  // ── Niveau crues : tronçons AN11/12/20 + règle 5 stations orange/rouge ──
  const vigicruesTroncons = Array.isArray(externalRisks?.vigicrues?.troncons)
    ? externalRisks.vigicrues.troncons : [];
  const mainTronconCodes = new Set(['AN11', 'AN12', 'AN20']);
  const mainTronconLevels = vigicruesTroncons
    .filter((t) => mainTronconCodes.has(String(t.code || '')))
    .map((t) => normalizeLevel(t.level || 'vert'));

  const vigicruesStations = Array.isArray(externalRisks?.vigicrues?.stations)
    ? externalRisks.vigicrues.stations : [];
  const alertStations = vigicruesStations
    .filter((s) => ['orange', 'rouge'].includes(normalizeLevel(s.level || 'vert')))
    .sort((a, b) => riskRank(b.level) - riskRank(a.level));
  const alertCount = alertStations.length;
  const stationsRuleLevel = alertCount >= 5
    ? (alertStations.some((s) => normalizeLevel(s.level) === 'rouge') ? 'rouge' : 'orange')
    : 'vert';

  const crues = [
    ...mainTronconLevels,
    stationsRuleLevel,
    normalizeLevel(dashboard.crues || externalRisks?.vigicrues?.water_alert_level || 'vert'),
  ].reduce((max, lvl) => riskRank(lvl) > riskRank(max) ? lvl : max, 'vert');

  const globalRisk = normalizeLevel(dashboard.global_risk || vigilance);
  const crisisCount = Number(dashboard.communes_crise ?? 0);

  const logs = Array.isArray(cachedLogs) && cachedLogs.length
    ? cachedLogs.slice(0, 8)
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
  const cruesAlertHtml = alertCount > 0
    ? `<ul class="list compact" style="margin-top:6px;font-size:0.82em">${
        alertStations.slice(0, 6).map((s) => {
          const lvl = normalizeLevel(s.level || 'vert');
          return `<li><span style="color:${levelColor(lvl)};font-weight:600">${escapeHtml(s.station || s.code)}</span>${s.river ? ` · <span class="muted">${escapeHtml(s.river)}</span>` : ''} · ${escapeHtml(lvl)}</li>`;
        }).join('')
      }${alertCount > 6 ? `<li class="muted">… et ${alertCount - 6} autre(s)</li>` : ''}</ul>`
    : `<p class="muted" style="font-size:0.82em;margin-top:4px">Aucune station en alerte</p>`;

  const kpiCards = [
    { key: 'meteo', label: 'Vigilance météo', value: vigilance, info: 'Source Météo-France', css: normalizeLevel(vigilance) },
    { key: 'crues', label: 'Niveau crues', value: crues, info: `Tronçons AN11/12/20 · ${alertCount} station(s) en alerte`, css: normalizeLevel(crues), detail: cruesAlertHtml },
    { key: 'global-risk', label: 'Risque global', value: globalRisk, info: 'Calcul consolidé', css: normalizeLevel(globalRisk) },
    { key: 'communes-crise', label: 'Communes en crise', value: String(crisisCount), info: 'PCS actif', css: crisisCount > 0 ? 'rouge' : 'vert' },
  ];
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
  const orangeOrRedLogsCount = activeLogs.filter((log) => ['orange', 'rouge'].includes(normalizeLevel(log.danger_level))).length;
  const mobilityCards = [
    { key: 'bison', label: 'Bison Futé (38) · Départ / Arrivée', value: `${bisonDeparture} / ${bisonReturn}`, info: 'Tendance Isère départ / arrivée', css: bisonCombinedLevel },
    { key: 'sncf', label: 'SNCF · alertes Isère', value: `${sncfAlerts}`, info: 'Accidents / travaux de voie', css: sncfAlerts > 0 ? 'orange' : 'vert' },
    { key: 'arcep', label: 'ARCEP · Sites mobiles indisponibles Isère', value: `${arcepOutages}`, info: 'Source data.gouv.fr / ARCEP', css: arcepOutages > 0 ? 'jaune' : 'vert' },
    { key: 'vigieau', label: 'Vigieau', value: `${vigieauAlertsCount}`, info: "Restriction(s) d'eau active(s)", css: vigieauAlertsCount > 0 ? 'jaune' : 'vert' },
    { key: 'atmo', label: "Qualité de l'air", value: atmoLabel, info: 'Source Atmo AURA', css: atmoLevel },
    { key: 'apic', label: 'APIC · alertes Isère', value: `${apicAlerts}`, info: 'Pluie intense à l’échelle communale', css: apicAlerts > 0 ? 'orange' : 'vert' },
    { key: 'vigicrues-flash', label: 'Vigicrues Flash · alertes Isère', value: `${vigicruesFlashAlerts}`, info: 'Avertissements crues rapides', css: vigicruesFlashAlerts > 0 ? 'orange' : 'vert' },
  ];
  const generatedAt = safeDateToLocale(Date.now());

  setHtml('situation-content', `
    <div class="situation-toolbar">
      <div>
        <h3>SITREP prêt à diffusion · Isère</h3>
        <p class="muted">Version claire et moderne pour envoi immédiat · mise à jour ${escapeHtml(generatedAt)}</p>
      </div>
      <div class="situation-toolbar__actions">
        <button id="situation-export-pdf-btn" type="button">📄 Générer et télécharger le SITREP PDF</button>
      </div>
    </div>

    <div class="situation-top-grid">
      ${kpiCards.map((card) => `<article class="tile situation-tile situation-tile--interactive" role="button" tabindex="0" data-kpi-key="${escapeHtml(card.key)}" data-kpi-label="${escapeHtml(card.label)}"><h3>${card.label}</h3><p class="kpi-value ${card.css}">${escapeHtml(card.value)}</p><p class="muted">${escapeHtml(card.info)}</p>${card.detail || ''}</article>`).join('')}
    </div>

    <div class="situation-top-grid">
      ${mobilityCards.map((card) => `<article class="tile situation-tile situation-tile--interactive" role="button" tabindex="0" data-kpi-key="${escapeHtml(card.key)}" data-kpi-label="${escapeHtml(card.label)}"><h3>${card.label}</h3><p class="kpi-value ${card.css}">${escapeHtml(card.value)}</p><p class="muted">${card.info}</p></article>`).join('')}
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
        <ul class="list">${activeLogs.slice(0, 8).map((log) => buildSituationLogMarkup(log)).join('') || '<li>Aucune crise nouvelle / en cours / suivie liée à un évènement ouvert.</li>'}</ul>
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

function buildSitrepHtml() {
  const dashboard = cachedDashboardSnapshot && Object.keys(cachedDashboardSnapshot).length
    ? cachedDashboardSnapshot
    : (readSnapshot(STORAGE_KEYS.dashboardSnapshot) || {});
  const externalRisks = cachedExternalRisksSnapshot && Object.keys(cachedExternalRisksSnapshot).length
    ? cachedExternalRisksSnapshot
    : (readSnapshot(STORAGE_KEYS.externalRisksSnapshot) || {});

  const meteo = externalRisks?.meteo_france || {};
  const vigicrues = externalRisks?.vigicrues || {};
  const prefecture = Array.isArray(externalRisks?.prefecture_isere?.items) ? sortPrefectureItemsByRecency(externalRisks.prefecture_isere.items).slice(0, 5) : [];
  const atmo = externalRisks?.atmo_aura || {};
  const bison = externalRisks?.bison_fute?.today?.isere || {};
  const vigieau = Array.isArray(externalRisks?.vigieau?.alerts) ? externalRisks.vigieau.alerts.slice(0, 5) : [];
  const sncf = Array.isArray(externalRisks?.sncf_isere?.alerts) ? externalRisks.sncf_isere.alerts.slice(0, 5) : [];
  const logs = Array.isArray(cachedLogs) && cachedLogs.length ? cachedLogs.slice(0, 8) : (Array.isArray(dashboard.latest_logs) ? dashboard.latest_logs.slice(0, 8) : []);

  const meteoItems = Array.isArray(meteo.current_alerts) && meteo.current_alerts.length
    ? meteo.current_alerts.map((alert) => {
      const details = Array.isArray(alert.details) && alert.details.length ? ` (${escapeHtml(alert.details.slice(0, 2).join(' · '))})` : '';
      return `<strong>${escapeHtml(alert.phenomenon || 'Phénomène')}</strong> : ${escapeHtml(normalizeLevel(alert.level || 'inconnu'))}${details}`;
    })
    : [escapeHtml(sanitizeMeteoInformation(meteo.info_state) || 'Aucune vigilance significative signalée.')];

  const vigicruesItems = Array.isArray(vigicrues.stations) && vigicrues.stations.length
    ? vigicrues.stations.slice(0, 6).map((station) => {
      const level = normalizeLevel(station.level || station.vigilance || vigicrues.water_alert_level || 'inconnu');
      return `<strong>${escapeHtml(station.station || station.name || 'Station')}</strong> · niveau ${escapeHtml(level)}`;
    })
    : ['Aucune station prioritaire transmise.'];

  const prefectureItems = prefecture.map((item) => `<strong>${escapeHtml(item.title || 'Actualité')}</strong>${item.published_at ? ` · ${escapeHtml(item.published_at)}` : ''}`);
  const vigieauItems = vigieau.map((item) => `<strong>${escapeHtml(item.level || 'Restriction')}</strong> · ${escapeHtml(item.zone || item.title || 'Isère')}`);
  const sncfItems = sncf.map((item) => `<strong>${escapeHtml(item.type || 'Alerte')}</strong> · ${escapeHtml(item.title || 'Incident réseau')}`);
  const now = new Date();
  const detailedLogItems = logs.map((log) => {
    const at = safeDateToLocale(log.event_time || log.created_at || Date.now());
    const municipalityName = log.municipality_id ? getMunicipalityName(log.municipality_id) : 'Non précisée';
    return {
      when: new Date(log.event_time || log.created_at || Date.now()),
      html: `<strong>${escapeHtml(at)}</strong> · ${escapeHtml(log.event_type || 'Évènement')} · ${escapeHtml(normalizeLevel(log.danger_level || 'vert'))}<br/>Commune concernée: <strong>${escapeHtml(municipalityName)}</strong> · Portée: ${escapeHtml(formatLogScope(log))}<br/>Statut: ${escapeHtml(LOG_STATUS_LABEL[String(log.status || 'nouveau')] || 'Nouveau')} · Lieu: ${escapeHtml(log.location || 'non précisé')}<br/>Source: ${escapeHtml(log.source || 'non précisée')} · Responsable: ${escapeHtml(log.assigned_to || 'non assigné')}<br/>Description: ${escapeHtml(log.description || 'Aucune description')} · Actions: ${escapeHtml(log.actions_taken || 'Aucune')}`,
    };
  });
  const logItemsToday = detailedLogItems.filter((entry) => isSameDayLocal(entry.when, now)).map((entry) => entry.html);
  const logItemsYesterday = detailedLogItems.filter((entry) => isPreviousDayLocal(entry.when, now)).map((entry) => entry.html);

  const generatedAt = safeDateToLocale(Date.now(), { dateStyle: 'full', timeStyle: 'short' });
  const crisisCount = Number(dashboard.communes_crise ?? 0);
  const globalRisk = escapeHtml(normalizeLevel(dashboard.global_risk || meteo.level || 'vert'));
  const weatherLevel = escapeHtml(normalizeLevel(meteo.level || dashboard.vigilance || 'vert'));
  const waterStations = Array.isArray(vigicrues.stations) ? vigicrues.stations : [];
  const nonGreenWaterStations = waterStations.filter((station) => ['jaune', 'orange', 'rouge'].includes(stationStatusLevel(station)));
  const waterSummary = nonGreenWaterStations.length
    ? `Stations eau à surveiller: ${nonGreenWaterStations.map((station) => `${station.station || station.name || station.code || 'Station'} (${stationStatusLevel(station)})`).join(', ')}`
    : `Toutes les stations eau sont vertes · score global ${escapeHtml(normalizeLevel(vigicrues.water_alert_level || globalRisk || 'vert'))}`;
  const crisisMunicipalities = (Array.isArray(cachedMunicipalityRecords) ? cachedMunicipalityRecords : [])
    .filter((municipality) => municipality.crisis_mode)
    .map((municipality) => municipality.name)
    .filter(Boolean);
  const crisisMunicipalityLabel = crisisMunicipalities.length ? crisisMunicipalities.join(', ') : 'Aucune commune en crise';
  const allPoints = [
    ...RESOURCE_POINTS,
    ...(Array.isArray(cachedStations) ? cachedStations.filter((station) => station.lat != null && station.lon != null) : []),
    ...(Array.isArray(mapPoints) ? mapPoints.filter((point) => point.lat != null && point.lon != null) : []),
  ];
  const crisisPoints = (Array.isArray(cachedMunicipalityRecords) ? cachedMunicipalityRecords : [])
    .filter((municipality) => municipality.crisis_mode && municipality.lat != null && municipality.lon != null)
    .map((municipality) => ({ lat: municipality.lat, lon: municipality.lon, color: '#e03131' }));
  const itinisereTrafficPoints = Array.isArray(cachedItinisereEvents)
    ? [...cachedItinisereEvents, ...(Array.isArray(cachedBisonLiveEvents) ? cachedBisonLiveEvents : [])]
      .filter((event) => (event.lat != null && event.lon != null) || (event.position?.lat != null && event.position?.lon != null))
      .map((event) => ({ lat: event.lat ?? event.position?.lat, lon: event.lon ?? event.position?.lon, color: '#d9480f' }))
    : [];
  const itinisereRoadLines = Object.values(ITINISERE_ROAD_CORRIDORS).map((corridor) => ({
    color: '#f76707',
    weight: 2.5,
    points: corridor.map((coord) => ({ lat: coord[0], lon: coord[1] })),
  }));
  const operationalCards = [
    { label: 'Alertes météo actives', value: Array.isArray(meteo.current_alerts) ? meteo.current_alerts.length : 0 },
    { label: 'Stations Vigicrues suivies', value: waterStations.length },
    { label: 'Restrictions eau', value: vigieau.length },
    { label: 'Évènements trafic Isère', value: itinisereTrafficPoints.length },
    { label: 'Alertes SNCF', value: sncf.length },
    { label: 'Actualités Préfecture', value: prefecture.length },
  ];
  const vigilance = normalizeLevel(dashboard.vigilance || meteo.level || 'vert');
  const crues = normalizeLevel(dashboard.crues || vigicrues.water_alert_level || 'vert');
  const bisonDeparture = normalizeLevel(bison.departure || 'inconnu');
  const bisonReturn = normalizeLevel(bison.return || 'inconnu');
  const bisonCombinedLevel = riskRank(bisonReturn) > riskRank(bisonDeparture) ? bisonReturn : bisonDeparture;
  const apicAlerts = Number(externalRisks?.apic_isere?.alerts_total ?? (externalRisks?.apic_isere?.alerts || []).length);
  const vigicruesFlashAlerts = Number(externalRisks?.vigicrues_flash_isere?.alerts_total ?? (externalRisks?.vigicrues_flash_isere?.alerts || []).length);
  const orangeOrRedLogsCount = logs.filter((log) => ['orange', 'rouge'].includes(normalizeLevel(log.danger_level))).length;
  const overviewCards = [
    { label: 'Vigilance météo', value: vigilance },
    { label: 'Niveau crues', value: crues },
    { label: 'Risque global', value: globalRisk },
    { label: 'Communes en crise', value: String(crisisCount) },
    { label: 'Bison Futé (départ / retour)', value: `${bisonDeparture} / ${bisonReturn}` },
    { label: 'Alertes APIC', value: String(apicAlerts) },
    { label: 'Alertes Vigicrues Flash', value: String(vigicruesFlashAlerts) },
    { label: 'Main courante orange / rouge', value: String(orangeOrRedLogsCount) },
  ];
  const overviewRisks = buildCriticalRisksMarkup(dashboard, externalRisks);

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>SITREP Isère</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: Inter, Arial, sans-serif; color: #0f1c2f; margin: 0; }
  .header { border: 3px solid #f39200; border-radius: 14px; padding: 14px 16px; background: linear-gradient(135deg, #fff7ec, #ffffff); }
  .badge { display: inline-block; background: #0d4b8e; color: #fff; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; }
  h1 { margin: 8px 0 4px; color: #0d4b8e; font-size: 24px; }
  h2 { margin: 16px 0 8px; color: #0d4b8e; font-size: 18px; border-bottom: 2px solid #f39200; padding-bottom: 4px; }
  p { margin: 4px 0; line-height: 1.4; }
  .kpi { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
  .card { border: 1px solid #d8e4f5; border-radius: 10px; padding: 10px; background: #f8fbff; }
  .card strong { display: block; font-size: 20px; margin-top: 4px; }
  ul { margin: 6px 0 0; padding-left: 18px; }
  li { margin-bottom: 5px; }
  .muted { color: #53627a; font-size: 12px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
</style>
</head>
<body>
  <header class="header">
    <span class="badge">Protection Civile · Isère (38)</span>
    <h1>SITREP quotidien · Conditions météo & points d'intérêt</h1>
    <p><strong>Émis le :</strong> ${escapeHtml(generatedAt)}</p>
    <p class="muted">Document opérationnel d'aide à la décision.</p>
    <div class="kpi">
      <article class="card"><p>Niveau météo</p><strong>${weatherLevel}</strong></article>
      <article class="card"><p>Risque global</p><strong>${globalRisk}</strong></article>
      <article class="card"><p>Communes en crise</p><strong>${escapeHtml(String(crisisCount))}</strong></article>
    </div>
  </header>
  <section>
    <h2>Vue d'ensemble opérationnelle</h2>
    <div class="kpi">
      ${overviewCards.map((card) => `<article class="card"><p>${escapeHtml(card.label)}</p><strong>${escapeHtml(String(card.value))}</strong></article>`).join('')}
    </div>
    <p><strong>Risque mobilité dominant :</strong> ${escapeHtml(bisonCombinedLevel)}</p>
    <ul>${overviewRisks}</ul>
  </section>
  <section>
    <h2>Situation météo du jour</h2>
    <ul>${toSitrepBulletItems(meteoItems)}</ul>
  </section>
  <section>
    <h2>Indicateurs consolidés SITREP</h2>
    <div class="kpi">
      ${operationalCards.map((card) => `<article class="card"><p>${escapeHtml(card.label)}</p><strong>${escapeHtml(String(card.value))}</strong></article>`).join('')}
    </div>
  </section>
  <section class="grid">
    <div>
      <h2>Hydrologie & mobilité</h2>
      <p><strong>Vigicrues :</strong> ${escapeHtml(normalizeLevel(vigicrues.water_alert_level || 'inconnu'))}</p>
      <ul>${toSitrepBulletItems(vigicruesItems)}</ul>
      <p><strong>Bison Futé (38)</strong> · Départs: ${escapeHtml(normalizeLevel(bison.departure || 'inconnu'))} · Retours: ${escapeHtml(normalizeLevel(bison.return || 'inconnu'))}</p>
      <p><strong>Qualité de l'air:</strong> ${escapeHtml(String(atmo?.today?.label || normalizeLevel(atmo?.today?.level || 'inconnu')).toLowerCase())}</p>
    </div>
    <div>
      <h2>Infos institutionnelles</h2>
      <ul>${toSitrepBulletItems(prefectureItems, 'Aucune actualité Préfecture.')}</ul>
    </div>
  </section>
  <section class="grid">
    <div>
      <h2>Restrictions eau</h2>
      <p><strong>${waterSummary}</strong></p>
      <ul>${toSitrepBulletItems(vigieauItems, 'Aucune restriction Vigieau remontée.')}</ul>
    </div>
    <div>
      <h2>Alertes SNCF</h2>
      <ul>${toSitrepBulletItems(sncfItems, 'Aucune alerte SNCF accidents/travaux en Isère.')}</ul>
    </div>
  </section>
  <section>
    <h2>Main courante opérationnelle du jour</h2>
    <ul>${toSitrepBulletItems(logItemsToday, 'Aucun évènement aujourd\'hui.')}</ul>
  </section>
  <section>
    <h2>Main courante opérationnelle de veille (J-1)</h2>
    <ul>${toSitrepBulletItems(logItemsYesterday, 'Aucun évènement sur la veille.')}</ul>
  </section>
  <section>
    <h2>Communes en crise</h2>
    <p><strong>${escapeHtml(crisisMunicipalityLabel)}</strong></p>
  </section>
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

function getSelectedMeteoCity() {
  return ISERE_MAJOR_CITIES.find((city) => city.key === selectedMeteoCityKey) || ISERE_MAJOR_CITIES[0];
}

function cityForecastCacheKey(city) {
  return `city:${city.key}`;
}

async function fetchWeeklyForecastForCity(city) {
  const key = cityForecastCacheKey(city);
  if (cachedWeeklyMeteo?.[key]) return cachedWeeklyMeteo[key];
  if (weeklyMeteoInFlight?.[key]) return weeklyMeteoInFlight[key];

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(city.lat)}&longitude=${encodeURIComponent(city.lon)}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max&hourly=temperature_2m,precipitation_probability,weathercode&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weathercode&timezone=Europe%2FParis&forecast_days=7`;

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
        wind_speed_max_kmh: daily.wind_speed_10m_max?.[index],
      })) : [];
      const hourly = payload?.hourly || {};
      const hourlyEntries = Array.isArray(hourly.time) ? hourly.time.map((dateTime, index) => ({
        date_time: dateTime,
        weather_code: hourly.weathercode?.[index],
        temp_c: hourly.temperature_2m?.[index],
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

function renderMeteoCitySelector() {
  const select = document.getElementById('meteo-city-select');
  if (!select) return;
  const previousValue = select.value || selectedMeteoCityKey;
  select.innerHTML = ISERE_MAJOR_CITIES.map((city) => `<option value="${escapeHtml(city.key)}">${escapeHtml(city.name)}</option>`).join('');
  const found = ISERE_MAJOR_CITIES.some((city) => city.key === previousValue);
  select.value = found ? previousValue : ISERE_MAJOR_CITIES[0].key;
  selectedMeteoCityKey = select.value;
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
  renderMeteoCitySelector();
  const selectedCity = getSelectedMeteoCity();
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
  const dauphine = mergedData?.dauphine_isere || {};
  const sncf = mergedData?.sncf_isere || {};
  const vigieau = mergedData?.vigieau || {};
  const atmo = mergedData?.atmo_aura || {};
  const electricity = mergedData?.electricity_isere || {};
  const anfr = mergedData?.anfr_isere || {};
  const arcep = mergedData?.arcep_isere || {};
  const apic = mergedData?.apic_isere || {};
  const vigicruesFlash = mergedData?.vigicrues_flash_isere || {};
  const georisquesPayload = mergedData?.georisques || {};
  const georisques = georisquesPayload?.data && typeof georisquesPayload.data === 'object'
    ? { ...georisquesPayload.data, ...georisquesPayload }
    : georisquesPayload;

  setRiskText('meteo-status', `${meteo.status || 'inconnu'} · niveau ${normalizeLevel(meteo.level || 'inconnu')}`, meteo.level || 'vert');
  setText('meteo-info', sanitizeMeteoInformation(meteo.info_state) || meteo.bulletin_title || '');
  setRiskText('vigicrues-status', `${vigicrues.status || 'inconnu'} · niveau ${normalizeLevel(vigicrues.water_alert_level || 'inconnu')}`, vigicrues.water_alert_level || 'vert');
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
  renderDauphineNews(dauphine);
  renderSncfAlerts(sncf);
  renderApicAlerts(apic);
  renderVigicruesFlashAlerts(vigicruesFlash);
  renderVigieauAlerts(vigieau);
  renderElectricityStatus(electricity);
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
  renderGeorisquesDetails(georisques);
  renderMeteoAlerts(meteo);
  renderWeeklyWeatherPanel(mergedData).catch(() => {});
  renderItinisereEvents(itinisereEvents);
  setText('meteo-level', normalizeLevel(meteo.level || 'vert'));
  setText('meteo-hazards', (meteo.hazards || []).join(', ') || 'non précisé');
  setText('river-level', normalizeLevel(vigicrues.water_alert_level || 'vert'));
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
  return true;
}

async function loadExternalRisks(forceRefresh = false) {
  const cached = readSnapshot(STORAGE_KEYS.externalRisksSnapshot);
  if (cached) {
    cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, cached);
    renderExternalRisks(cachedExternalRisksSnapshot);
    renderTrafficOnMap().catch(() => {});
  }

  const suffix = forceRefresh ? '?refresh=true' : '';
  const data = await api(`/external/isere/risks${suffix}`, {
    bypassCache: forceRefresh,
    cacheTtlMs: forceRefresh ? 0 : API_CACHE_TTL_MS,
    timeoutMs: API_SLOW_ENDPOINT_TIMEOUT_MS,
  });
  cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, data);
  renderExternalRisks(cachedExternalRisksSnapshot);
  saveSnapshot(STORAGE_KEYS.externalRisksSnapshot, cachedExternalRisksSnapshot);
  await renderTrafficOnMap();
}

function renderApiInterconnections(data = {}) {
  const signature = createPayloadSignature(data, ['updated_at', 'fetched_at', 'retrieved_at']);
  if (signature === lastRenderedApiInterconnectionsSignature) return false;

  lastRenderedApiInterconnectionsSignature = signature;
  const services = [
    { key: 'meteo_france', label: 'Météo-France', level: normalizeLevel(data.meteo_france?.level || 'inconnu'), details: data.meteo_france?.info_state || data.meteo_france?.bulletin_title || '-' },
    { key: 'vigicrues', label: 'Vigicrues', level: normalizeLevel(data.vigicrues?.water_alert_level || 'inconnu'), details: `${(data.vigicrues?.stations || []).length} station(s)` },
    { key: 'itinisere', label: 'Itinisère', level: `${data.itinisere?.events_total ?? (data.itinisere?.events || []).length} événement(s)`, details: data.itinisere?.source || '-' },
    { key: 'bison_fute', label: 'Bison Futé', level: data.bison_fute?.today?.isere?.departure || 'inconnu', details: data.bison_fute?.source || '-' },
    { key: 'georisques', label: 'Géorisques', level: data.georisques?.highest_seismic_zone_label || 'inconnue', details: `${data.georisques?.flood_documents_total ?? 0} document(s) inondation` },
    { key: 'prefecture_isere', label: "Préfecture Isère · Actualités", level: `${(data.prefecture_isere?.items || []).length} actualité(s)`, details: data.prefecture_isere?.source || '-' },
    { key: 'dauphine_isere', label: 'Le Dauphiné Libéré · Isère', level: `${(data.dauphine_isere?.items || []).length} article(s)`, details: data.dauphine_isere?.source || '-' },
    { key: 'sncf_isere', label: 'SNCF Isère · Accidents/Travaux voies', level: `${(data.sncf_isere?.alerts || []).length} alerte(s)`, details: data.sncf_isere?.source || '-' },
    { key: 'vigieau', label: 'Vigieau · Restrictions eau', level: `${(data.vigieau?.alerts || []).length} alerte(s)`, details: data.vigieau?.source || '-' },
    { key: 'electricity_isere', label: 'Électricité Isère · RTE éCO2mix', level: normalizeLevel(data.electricity_isere?.level || 'inconnu'), details: `marge ${data.electricity_isere?.supply_margin_mw ?? '-'} MW` },
    { key: 'atmo_aura', label: "Atmo AURA · Qualité de l'air", level: `indice ${data.atmo_aura?.today?.index ?? '-'}`, details: data.atmo_aura?.source || '-' },
    { key: 'anfr_isere', label: 'ANFR · Antennes mobiles Isère', level: `${data.anfr_isere?.supports_total ?? 0} support(s)`, details: data.anfr_isere?.data_release || '-' },
    { key: 'arcep_isere', label: 'ARCEP · Sites mobiles indisponibles', level: `${data.arcep_isere?.outages_total ?? 0} indisponibilité(s)`, details: data.arcep_isere?.resource_date || '-' },
    { key: 'apic_isere', label: 'APIC · Avertissements pluie intense Isère', level: `${data.apic_isere?.alerts_total ?? 0} alerte(s)`, details: data.apic_isere?.source_data || data.apic_isere?.source || '-' },
    { key: 'vigicrues_flash_isere', label: 'Vigicrues Flash · Crues rapides Isère', level: `${data.vigicrues_flash_isere?.alerts_total ?? 0} alerte(s)`, details: data.vigicrues_flash_isere?.source_data || data.vigicrues_flash_isere?.source || '-' },
  ];

  const cards = services.map((service) => {
    const payload = data[service.key] || {};
    const status = String(payload.status || 'inconnu');
    const degraded = status !== 'online' || Boolean(payload.error);
    const errorLabel = serviceErrorLabel(payload);
    const updatedAt = payload.updated_at ? safeDateToLocale(payload.updated_at, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
    const rawDetails = String(service.details || '');
    const detailsWithoutLinks = rawDetails.replace(/https?:\/\/\S+/gi, '').replace(/\s{2,}/g, ' ').trim();
    const detailsText = detailsWithoutLinks || 'Détail disponible dans la source officielle.';
    const sourceCandidates = [
      payload.source_data,
      payload.source,
      payload.source_reseaux,
      payload.dataset_url,
      payload.source_url,
      payload.link,
    ];
    const sourceUrl = sourceCandidates.find((candidate) => String(candidate || '').startsWith('http'));
    const openSourceButton = sourceUrl
      ? `<a class="ghost inline-action api-card-open-link" href="${escapeHtml(String(sourceUrl))}" target="_blank" rel="noreferrer noopener">Ouvrir</a>`
      : '';
    return `<article class="api-card"><h4>${service.label}</h4><p>Statut: <span class="${degraded ? 'ko' : 'ok'}">${status}</span></p><p>Indicateur: <strong>${escapeHtml(service.level)}</strong></p><p class="muted">${escapeHtml(detailsText)}</p>${openSourceButton ? `<p>${openSourceButton}</p>` : ''}<p class="${degraded ? 'ko' : 'muted'}">Erreur actuelle: ${escapeHtml(errorLabel)}</p><p class="muted api-card-refresh">Dernière récupération API: ${escapeHtml(updatedAt)}</p></article>`;
  }).join('');

  const rawBlocks = services.map((service) => {
    const payload = data[service.key] || {};
    return `<details class="api-raw-item"><summary>${service.label}</summary><pre>${formatApiJson(payload)}</pre></details>`;
  }).join('');

  const activeErrors = services
    .map((service) => ({ label: service.label, payload: data[service.key] || {} }))
    .filter(({ payload }) => payload.status !== 'online' || payload.error)
    .map(({ label, payload }) => `${label}: ${serviceErrorLabel(payload)}`);

  setText('api-updated-at', data.updated_at ? new Date(data.updated_at).toLocaleString() : 'inconnue');
  lastApiResyncAt = data.updated_at || new Date().toISOString();
  renderApiResyncClock();
  setText('api-error-banner', activeErrors.join(' · ') || 'Aucune erreur active sur les interconnexions.');
  setHtml('api-service-grid', cards || '<p>Aucun service disponible.</p>');
  setHtml('api-raw-list', rawBlocks || '<p>Aucun retour JSON disponible.</p>');
  return true;
}

async function loadApiInterconnections(forceRefresh = false) {
  const suffix = forceRefresh ? '?refresh=true' : '';
  if (!forceRefresh) {
    const cached = readSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot);
    if (cached) {
      cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, cached);
      renderApiInterconnections(cachedExternalRisksSnapshot);
    }
  }
  const data = await api(`/external/isere/risks${suffix}`, { timeoutMs: API_SLOW_ENDPOINT_TIMEOUT_MS });
  cachedExternalRisksSnapshot = mergeExternalRisksSnapshot(cachedExternalRisksSnapshot, data);
  renderApiInterconnections(cachedExternalRisksSnapshot);
  saveSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot, cachedExternalRisksSnapshot);
}

function renderMunicipalitiesList(municipalities = []) {
  const municipalitiesMarkup = municipalities.map((m) => {
    const dangerColor = levelColor(m.vigilance_color || 'vert');
    const actions = canEdit()
      ? `<div class="municipality-actions">
           <button type="button" class="ghost inline-action" data-muni-view="${m.id}">Voir</button>
           <button type="button" class="ghost inline-action" data-muni-edit="${m.id}">Éditer</button>
           <button type="button" class="ghost inline-action" data-muni-crisis="${m.id}">${m.crisis_mode ? 'Sortir de crise' : 'Passer en crise'}</button>
           <button type="button" class="ghost inline-action" data-muni-files="${m.id}">Documents</button>
           <button type="button" class="ghost inline-action danger" data-muni-delete="${m.id}">Supprimer</button>
         </div>`
      : canMunicipalityFiles()
        ? `<div class="municipality-actions"><button type="button" class="ghost inline-action" data-muni-view="${m.id}">Voir</button><button type="button" class="ghost inline-action" data-muni-files="${m.id}">Documents</button></div>`
        : `<div class="municipality-actions"><button type="button" class="ghost inline-action" data-muni-view="${m.id}">Voir</button></div>`;
    return `<article class="municipality-card" data-muni-id="${m.id}">
      <header>
        <h4>${escapeHtml(m.name)}</h4>
        <span class="badge ${normalizeLevel(m.vigilance_color || 'vert') === 'rouge' ? 'red' : normalizeLevel(m.vigilance_color || 'vert') === 'orange' ? 'orange' : normalizeLevel(m.vigilance_color || 'vert') === 'jaune' ? 'yellow' : 'green'}">${normalizeLevel(m.vigilance_color || 'vert')}</span>
      </header>
      <p><strong>${escapeHtml(m.phone)}</strong> · ${escapeHtml(m.email)}</p>
      <p style="color:${dangerColor}">Statut: ${m.crisis_mode ? 'CRISE' : 'veille'} · PCS ${m.pcs_active ? 'actif' : 'inactif'} · ${m.postal_code || 'CP ?'}</p>
      <div class="municipality-stats">
        <p>Population<br><strong>${m.population ?? '-'}</strong></p>
        <p>Accueil<br><strong>${m.shelter_capacity ?? '-'}</strong></p>
        <p>Contacts<br><strong>${escapeHtml(m.contacts || '-')}</strong></p>
      </div>
      <p class="municipality-docs">Documents: personnalisés</p>
      <p class="muted">${escapeHtml(m.additional_info || 'Aucune information complémentaire')}</p>
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
    localStorage.setItem(STORAGE_KEYS.municipalitiesCache, JSON.stringify(municipalities));
  } else {
    try {
      const payload = await api('/municipalities');
      municipalities = keepPreviousArray(previousMunicipalities, payload);
      localStorage.setItem(STORAGE_KEYS.municipalitiesCache, JSON.stringify(municipalities));
    } catch (error) {
      try {
        const cached = JSON.parse(localStorage.getItem(STORAGE_KEYS.municipalitiesCache) || '[]');
        municipalities = Array.isArray(cached) ? cached : [];
      } catch (_) {
        municipalities = [];
      }
      setMapFeedback(`Liste des communes indisponible via API, affichage du cache local (${municipalities.length}).`, true);
    }
  }

  cachedMunicipalityRecords = municipalities;
  cachedMunicipalities = municipalities;
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
  const municipality = log.municipality_id ? ` · ${escapeHtml(getMunicipalityName(log.municipality_id))}` : '';
  const place = log.location ? `📍 ${escapeHtml(log.location)}` : 'Lieu non précisé';
  const source = log.source ? `Source: ${escapeHtml(log.source)}` : 'Source non précisée';
  const owner = log.assigned_to ? `👤 ${escapeHtml(log.assigned_to)}` : '👤 Non assigné';
  const next = log.next_update_due ? `⏱️ MAJ ${new Date(log.next_update_due).toLocaleString()}` : '';
  const actions = canEdit()
    ? `<div class="map-inline-actions"><button type="button" class="ghost inline-action" data-log-edit="${log.id}">Modifier</button><button type="button" class="ghost inline-action danger" data-log-delete="${log.id}">Supprimer MCO</button></div>`
    : '—';
  const eventTitle = escapeHtml(getEventTitle(log.event_id));
  return `<tr><td>${new Date(log.event_time || log.created_at).toLocaleString()}</td><td><span class="badge neutral">${formatLogScope(log)}${municipality}</span></td><td>${log.danger_emoji || LOG_LEVEL_EMOJI[normalizeLevel(log.danger_level)] || '🟢'}</td><td><strong style="color:${levelColor(log.danger_level)}">${escapeHtml(log.event_type || 'MCO')}</strong><br/><span class="muted">${eventTitle}</span></td><td>${place}<br/><span class="muted">${owner} · ${source}${next ? ` · ${next}` : ''}</span><br/>${escapeHtml(log.description || '')}${log.actions_taken ? `<br/><span class="muted">Actions: ${escapeHtml(log.actions_taken)}</span>` : ''}</td><td>${actions}</td></tr>`;
}

function renderLogsList() {
  let filtered = [...cachedLogs];
  if (selectedOperationalEventId) {
    filtered = filtered.filter((log) => String(log.event_id || '') === String(selectedOperationalEventId));
  } else {
    filtered = [];
  }

  filtered.sort((a, b) => new Date(b.event_time || b.created_at).getTime() - new Date(a.event_time || a.created_at).getTime());

  setText('logs-count', String(filtered.length));
  setHtml('logs-table-stream', filtered.map((log) => buildLogTableRow(log)).join('') || '<tr><td colspan="6">Aucune entrée MCO pour cet évènement.</td></tr>');
}

async function loadLogs(preloaded = null) {
  const previousLogs = Array.isArray(cachedLogs) ? cachedLogs : [];
  const logs = Array.isArray(preloaded) ? preloaded : await api('/logs');
  cachedLogs = keepPreviousArray(previousLogs, logs);
  saveSnapshot(STORAGE_KEYS.logsSnapshot, cachedLogs);
  renderLogsList();
  renderSituationOverview();
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
  const users = keepPreviousArray(Array.isArray(usersSnapshot) ? usersSnapshot : [], Array.isArray(preloaded) ? preloaded : await api('/auth/users'));
  saveSnapshot(STORAGE_KEYS.usersSnapshot, users);
  const isAdmin = currentUser?.role === 'admin';
  setHtml('users-table', users.map((u) => {
    const actionButtons = isAdmin
      ? `<div class="users-actions"><button type="button" data-user-edit="${u.id}">Modifier</button><button type="button" data-user-reset="${u.id}">Réinitialiser mot de passe</button><button type="button" class="ghost" data-user-delete="${u.id}">Supprimer</button></div>`
      : '-';
    return `<tr><td>${escapeHtml(u.username)}</td><td>${roleLabel(u.role)}</td><td>${escapeHtml(u.municipality_name || '-')}</td><td>${new Date(u.created_at).toLocaleDateString()}</td><td>${u.must_change_password ? 'Changement requis' : 'Actif'}</td><td>${actionButtons}</td></tr>`;
  }).join('') || '<tr><td colspan="6">Aucun utilisateur.</td></tr>');
}

async function loadOperationsBootstrap(forceRefresh = false) {
  const suffix = forceRefresh ? '?refresh=true' : '';
  const payload = await api(`/operations/bootstrap${suffix}`, { cacheTtlMs: 5000 });
  if (!payload || typeof payload !== 'object') throw new Error('Réponse bootstrap invalide');

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

  const perf = payload.perf || {};
  const duration = Number(perf.backend_duration_ms || 0);
  const countM = Number(perf.municipality_count || (payload.municipalities || []).length || 0);
  const countL = Number(perf.log_count || (payload.logs || []).length || 0);
  setText('operations-perf', `Perf: ${duration} ms · ${countM} communes · ${countL} événements`);
  return payload;
}

async function refreshAll(forceRefresh = false) {
  if (refreshAllInFlight) return refreshAllInFlight;

  refreshAllInFlight = withPreservedScroll(async () => {
    const loaders = [
      { label: 'tableau de bord', loader: () => loadDashboard(forceRefresh), optional: true },
      { label: 'flux API (Météo / Vigicrues / Itinisère / Bison / Géorisques)', loader: () => loadExternalRisks(forceRefresh), optional: false },
      { label: 'interconnexions API', loader: async () => renderApiInterconnections(cachedExternalRisksSnapshot), optional: true },
      { label: 'communes', loader: loadMunicipalities, optional: false },
      { label: 'évènements', loader: loadEvents, optional: false },
      { label: 'main courante', loader: loadLogs, optional: false },
      { label: 'utilisateurs', loader: loadUsers, optional: true },
      { label: 'points cartographiques', loader: loadMapPoints, optional: true },
      { label: 'annotations tactiques', loader: loadMapAnnotations, optional: true },
      { label: 'trafic cartographique', loader: renderTrafficOnMap, optional: true },
    ];
    startStartupQueue(loaders.length);
    const results = await Promise.all(loaders.map(async ({ label, loader }) => {
      setStartupQueueCurrent(`Chargement: ${label}…`);
      try {
        const value = await loader();
        return { status: 'fulfilled', value };
      } catch (error) {
        return { status: 'rejected', reason: error };
      } finally {
        advanceStartupQueue(label);
      }
    }));
    const failures = results
      .map((result, index) => ({ result, config: loaders[index] }))
      .filter(({ result }) => result.status === 'rejected');

    const blockingFailures = failures.filter(({ config }) => !config.optional);
    const optionalFailures = failures.filter(({ config }) => config.optional);

    renderResources();
    // Pré-chauffer les données statiques (OSM, FINESS, Télécom) en arrière-plan
    // dès le démarrage, pour qu'elles soient prêtes quand l'utilisateur ouvre la carte.
    _ensureStaticDataLoaded();

    if (!blockingFailures.length) {
      finishStartupQueue();
      const errorTarget = document.getElementById('dashboard-error');
      if (errorTarget && !errorTarget.textContent.trim()) {
        const warning = optionalFailures.length
          ? `Modules secondaires indisponibles: ${optionalFailures.map(({ config, result }) => `${config.label}: ${sanitizeErrorMessage(result.reason?.message || 'erreur')}`).join(' · ')}`
          : '';
        errorTarget.textContent = warning;
      }
      return;
    }

    const message = blockingFailures.map(({ config, result }) => `${config.label}: ${sanitizeErrorMessage(result.reason?.message || 'erreur')}`).join(' · ');
    document.getElementById('dashboard-error').textContent = message;
    setMapFeedback(message, true);
    finishStartupQueue();
  });

  try {
    await refreshAllInFlight;
  } finally {
    refreshAllInFlight = null;
  }
}

function applyRoleVisibility() {
  document.querySelectorAll('[data-requires-edit]').forEach((node) => setVisibility(node, canEdit()));
  document.querySelectorAll('[data-requires-map-point]').forEach((node) => setVisibility(node, canCreateMapPoints()));
  document.querySelectorAll('[data-admin-only]').forEach((node) => setVisibility(node, currentUser?.role === 'admin'));
  setVisibility(document.querySelector('[data-target="users-panel"]'), canManageUsers());
}


function syncUserCreateMunicipalityVisibility() {
  const role = document.getElementById('user-create-role')?.value;
  setVisibility(document.getElementById('user-create-municipality-wrap'), role === 'mairie');
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
    appSidebar?.classList.remove('open');
    appMenuButton?.setAttribute('aria-expanded', 'false');
  }));
  document.getElementById('georisques-pcs-select')?.addEventListener('change', (event) => {
    selectedGeorisquesPcsCommuneKey = String(event.target?.value || '').trim().toLowerCase();
    const georisquesPayload = cachedExternalRisksSnapshot?.georisques || {};
    const georisquesData = georisquesPayload?.data && typeof georisquesPayload.data === 'object'
      ? { ...georisquesPayload.data, ...georisquesPayload }
      : georisquesPayload;
    renderGeorisquesPcsRisks(georisquesData.monitored_communes || georisquesData.monitored_municipalities || georisquesData.communes || []);
  });
  appMenuButton?.addEventListener('click', () => {
    const isOpen = appSidebar?.classList.toggle('open');
    appMenuButton.setAttribute('aria-expanded', String(Boolean(isOpen)));
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
  document.addEventListener('fullscreenchange', updateMapFullscreenButton);
  updateMapFullscreenButton();
  document.getElementById('map-fit-btn')?.addEventListener('click', () => fitMapToData(true));
  document.getElementById('map-locate-btn')?.addEventListener('click', locateUserOnMap);
  document.getElementById('map-zone-impact-start')?.addEventListener('click', startZoneImpactSelection);
  document.getElementById('map-zone-impact-clear')?.addEventListener('click', clearZoneImpactSelection);
  document.getElementById('map-add-point-btn')?.addEventListener('click', () => {
    if (!canEdit()) {
      setMapFeedback('Vous n\'avez pas le droit de créer un POI.', true);
      return;
    }
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
  document.getElementById('filter-resources-telecom')?.addEventListener('change', () => {
    syncTelecomFilterState();
    renderResources();
  });
  document.getElementById('api-refresh-btn')?.addEventListener('click', async () => {
    try {
      await loadApiInterconnections(true);
      document.getElementById('dashboard-error').textContent = '';
    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
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
    const openEventButton = event.target.closest('[data-muni-open-event]');
    const openFileButton = event.target.closest('[data-muni-file-open]');
    const downloadFileButton = event.target.closest('[data-muni-file-download]');
    const uploadFileButton = event.target.closest('[data-muni-file-upload]');
    const deleteFileButton = event.target.closest('[data-muni-file-delete]');
    if (!crisisButton && !openEventButton && !openFileButton && !downloadFileButton && !uploadFileButton && !deleteFileButton) return;

    const getMunicipality = (id) => cachedMunicipalityRecords.find((m) => String(m.id) === String(id));

    try {
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

      if (openFileButton) {
        if (!canMunicipalityFiles()) return;
        const municipalityId = openFileButton.getAttribute('data-muni-id');
        const fileId = openFileButton.getAttribute('data-muni-file-open');
        await openMunicipalityFile(municipalityId, fileId);
        return;
      }

      if (downloadFileButton) {
        if (!canMunicipalityFiles()) return;
        const municipalityId = downloadFileButton.getAttribute('data-muni-id');
        const fileId = downloadFileButton.getAttribute('data-muni-file-download');
        const name = downloadFileButton.getAttribute('data-muni-file-name') || 'document';
        await downloadMunicipalityFile(municipalityId, fileId, name);
        return;
      }

      if (uploadFileButton) {
        if (!canMunicipalityFiles()) return;
        await pickMunicipalityFile(uploadFileButton.getAttribute('data-muni-file-upload'));
        return;
      }

      if (deleteFileButton) {
        if (!canMunicipalityFiles()) return;
        const municipalityId = deleteFileButton.getAttribute('data-muni-id');
        const fileId = deleteFileButton.getAttribute('data-muni-file-delete');
        await api(`/municipalities/${municipalityId}/files/${fileId}`, { method: 'DELETE' });
        const municipality = getMunicipality(municipalityId);
        if (municipality) await openMunicipalityDetailsModal(municipality);
        return;
      }

    } catch (error) {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    }
  });
  document.getElementById('municipality-details-content')?.addEventListener('change', async (event) => {
    const search = event.target.closest('[data-muni-doc-search]');
    const typeFilter = event.target.closest('[data-muni-doc-type-filter]');
    const sortFilter = event.target.closest('[data-muni-doc-sort]');
    if (!search && !typeFilter && !sortFilter) return;
    const municipalityId = search?.getAttribute('data-muni-doc-search') || typeFilter?.getAttribute('data-muni-doc-type-filter') || sortFilter?.getAttribute('data-muni-doc-sort');
    const municipality = cachedMunicipalityRecords.find((m) => String(m.id) === String(municipalityId));
    if (!municipality) return;
    const state = municipalityDocumentsUiState.get(String(municipalityId)) || { search: '', type: 'all', sort: 'date_desc' };
    municipalityDocumentsUiState.set(String(municipalityId), {
      ...state,
      search: search ? search.value || '' : state.search,
      type: typeFilter ? typeFilter.value : state.type,
      sort: sortFilter ? sortFilter.value : state.sort,
    });
    await openMunicipalityDetailsModal(municipality);
  });
  document.getElementById('municipality-details-content')?.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-muni-upload-form]');
    if (!form) return;
    event.preventDefault();
    try {
      await submitMunicipalityUploadForm(form, form.getAttribute('data-muni-upload-form'));
      document.getElementById('municipality-feedback').textContent = 'Document chargé avec succès.';
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
    if (openEventButton) {
      openOperationalEventMcoForm(openEventButton.getAttribute('data-event-open'));
      return;
    }

    if (!eventStatusButton && !deleteButton && !editButton && !deleteEventButton) return;
    if (!canEdit()) return;

    try {
      if (eventStatusButton) {
        const eventId = eventStatusButton.getAttribute('data-event-status');
        const status = eventStatusButton.getAttribute('data-event-next');
        await api(`/events/${eventId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        await loadEvents();
      }

      if (deleteButton) {
        const logId = deleteButton.getAttribute('data-log-delete');
        const confirmed = window.confirm('Supprimer cette entrée de main courante ?');
        if (!confirmed) return;
        await api(`/logs/${logId}`, { method: 'DELETE' });
      }

      if (deleteEventButton) {
        const eventId = deleteEventButton.getAttribute('data-event-delete');
        const confirmed = window.confirm('Supprimer cet évènement et toutes ses entrées MCO ?');
        if (!confirmed) return;
        await api(`/events/${eventId}`, { method: 'DELETE' });
        if (String(selectedOperationalEventId) === String(eventId)) selectedOperationalEventId = null;
        await loadEvents();
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

  document.getElementById('municipality-edit-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canEdit()) return;
    const form = event.target;
    const municipalityId = form.elements.id.value;
    const payload = {
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
      syncUserCreateMunicipalityVisibility();
      document.getElementById('users-success').textContent = 'Utilisateur créé avec succès.';
      await loadUsers();
    } catch (error) {
      document.getElementById('users-error').textContent = sanitizeErrorMessage(error.message);
    }
  });

  // Filtres qui n'affectent que les ressources (rendu immédiat, pas de re-fetch réseau)
  const RESOURCE_ONLY_FILTERS = new Set([
    'filter-resources-command', 'filter-resources-hosting', 'filter-resources-hosting-type',
    'filter-resources-schools', 'filter-resources-schools-type',
    'filter-resources-security', 'filter-resources-security-type',
    'filter-resources-fire', 'filter-resources-risks', 'filter-resources-risks-type',
    'filter-resources-transport', 'filter-resources-transport-type',
    'filter-resources-health', 'filter-resources-health-type',
    'filter-resources-telecom', 'filter-resources-telecom-type',
    'filter-resources-active',
  ]);
  ['filter-hydro', 'filter-pcs', 'filter-resources-active', 'filter-resources-command', 'filter-resources-hosting', 'filter-resources-hosting-type', 'filter-resources-schools', 'filter-resources-schools-type', 'filter-resources-security', 'filter-resources-security-type', 'filter-resources-fire', 'filter-resources-risks', 'filter-resources-risks-type', 'filter-resources-transport', 'filter-resources-transport-type', 'filter-resources-health', 'filter-resources-health-type', 'filter-resources-telecom', 'filter-resources-telecom-type', 'filter-traffic-incidents', 'filter-bison-type', 'filter-cameras'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', async () => {
      if (RESOURCE_ONLY_FILTERS.has(id)) {
        // Rendu immédiat depuis le cache + lancement background si besoin
        renderResources();
        return;
      }
      // Filtres globaux (hydro, pcs, trafic, caméras) → tout re-rendre
      renderStations(cachedVigicruesPayload);
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
  if (apiPanelTimer) clearInterval(apiPanelTimer);
  if (apiResyncTimer) clearInterval(apiResyncTimer);
  if (photoCameraRefreshTimer) clearInterval(photoCameraRefreshTimer);
  stopMapAnnotationsSync();
  finishStartupQueue();
  showHome();
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => token && refreshAll(true), AUTO_REFRESH_MS);
}

async function refreshLiveEvents() {
  if (!token || document.hidden) return;
  return withPreservedScroll(async () => {
    try {
      const [logs, risks, dashboard] = await Promise.all([
        // TTL court pour forcer le re-fetch à chaque cycle live tout en permettant la déduplication
        // in-flight si plusieurs appelants déclenchent la même requête simultanément.
        // bypassCache: true est intentionnellement évité ici car il viderait apiGetCache + apiInFlight.
        api('/logs', { cacheTtlMs: 30000 }),
        api('/external/isere/risks', { cacheTtlMs: 30000, timeoutMs: API_SLOW_ENDPOINT_TIMEOUT_MS }),
        api('/dashboard', { cacheTtlMs: 30000 }),
      ]);

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

      renderExternalRisks(risks);
      renderSituationOverview();
      saveSnapshot(STORAGE_KEYS.externalRisksSnapshot, cachedExternalRisksSnapshot);
      saveSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot, cachedExternalRisksSnapshot);
      document.getElementById('dashboard-error').textContent = '';
    } catch (error) {
      document.getElementById('dashboard-error').textContent = `Actualisation live des évènements: ${sanitizeErrorMessage(error.message)}`;
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
  }, 1000);

  apiPanelTimer = setInterval(() => {
    const activePanel = localStorage.getItem(STORAGE_KEYS.activePanel);
    if (!token || activePanel !== 'api-panel' || document.hidden) return;
    withPreservedScroll(async () => {
      await loadApiInterconnections(false);
    }).catch((error) => {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    });
  }, API_PANEL_REFRESH_MS);
}

function renderHomeLiveStatus(data = {}) {
  const dashboard = data?.dashboard || {};
  setRiskText('home-meteo-state', normalizeLevel(dashboard.vigilance || '-'), dashboard.vigilance || 'vert');
  setRiskText('home-river-state', normalizeLevel(dashboard.crues || '-'), dashboard.crues || 'vert');
  setRiskText('home-global-risk', normalizeLevel(dashboard.global_risk || '-'), dashboard.global_risk || 'vert');
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
  setRiskText('home-indication-global', normalizeLevel(dashboard.global_risk || '-'), dashboard.global_risk || 'vert');
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

async function initializeAuthenticatedSession({ runRefreshInBackground = false } = {}) {
  document.getElementById('current-role').textContent = roleLabel(currentUser.role);
  document.getElementById('current-commune').textContent = currentUser.municipality_name || 'Toutes';
  applyRoleVisibility();
  showApp();
  setActivePanel(localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel');
  hydrateUiFromLocalCache();
  await loadIsereBoundary();
  syncLogScopeFields();
  syncLogOtherFields();

  const refreshPromise = refreshAll().catch((error) => {
    document.getElementById('dashboard-error').textContent = `Actualisation différée: ${sanitizeErrorMessage(error.message)}`;
  });

  if (!runRefreshInBackground) await refreshPromise;

  startAutoRefresh();
  startLiveEventsRefresh();
  startMapAnnotationsSync();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isLoginSubmitting) return;
  isLoginSubmitting = true;
  setLoginError('');
  const submitBtn = loginForm.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  const form = new FormData(loginForm);
  const username = String(form.get('username') || '');
  const password = String(form.get('password') || '');

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
      maxRetries: 0,
    });
    token = result.access_token;
    localStorage.setItem(STORAGE_KEYS.token, token);
    pendingCurrentPassword = password;

    if (result.must_change_password) {
      setVisibility(loginForm, false);
      setVisibility(passwordForm, true);
      return;
    }

    currentUser = await api('/auth/me');
    await initializeAuthenticatedSession({ runRefreshInBackground: true });
  } catch (error) {
    setLoginError(error.message, buildLoginDebugDetails(error, username));
  } finally {
    isLoginSubmitting = false;
    if (submitBtn) submitBtn.disabled = false;
  }
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


async function fetchMunicipalityByPostalCode(postalCode) {
  const code = String(postalCode || '').trim();
  if (!/^\d{5}$/.test(code)) return null;
  const response = await queueApiRequest(() => fetchWithTimeout(`https://geo.api.gouv.fr/communes?codePostal=${encodeURIComponent(code)}&fields=nom,code,population&boost=population&limit=1`));
  const payload = await parseJsonResponse(response, 'geo-api-commune-by-postal-code');
  if (!Array.isArray(payload) || !payload.length) return null;
  const commune = payload[0] || {};
  return {
    name: String(commune.nom || '').trim(),
    insee_code: String(commune.code || '').trim(),
    population: Number(commune.population || 0) || null,
  };
}

async function autofillMunicipalityFromPostalCode(formEl) {
  if (!formEl) return;
  const postalInput = formEl.elements.postal_code;
  const nameInput = formEl.elements.name;
  const inseeInput = formEl.elements.insee_code;
  const populationInput = formEl.elements.population;
  const postalCode = String(postalInput?.value || '').trim();
  if (!/^\d{5}$/.test(postalCode)) return;

  try {
    const municipality = await fetchMunicipalityByPostalCode(postalCode);
    if (!municipality) return;
    if (nameInput && !String(nameInput.value || '').trim()) nameInput.value = municipality.name || '';
    if (inseeInput) inseeInput.value = municipality.insee_code || '';
    if (populationInput && !String(populationInput.value || '').trim()) {
      populationInput.value = municipality.population ?? '';
    }
  } catch (error) {
    // silence: user can still enter values manually
  }
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
    };
    const editingLogId = event.target.dataset.editLogId;
    if (editingLogId) {
      await api(`/logs/${editingLogId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      await api('/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    event.target.reset();
    resetLogFormState();
    if (errorTarget) errorTarget.textContent = '';
    syncLogScopeFields();
    await refreshAll();
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
    await loadEvents();
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
  updateApiQueueVisual();
  bindHomeInteractions();
  bindAppInteractions();
  startHomeLiveRefresh();
  startApiPanelAutoRefresh();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    loadHomeLiveStatus();
    if (token) refreshAll(false);
  });
  window.addEventListener('focus', () => {
    loadHomeLiveStatus();
    if (token) refreshAll(false);
  });

  try {
    const cachedMunicipalities = JSON.parse(localStorage.getItem(STORAGE_KEYS.municipalitiesCache) || '[]');
    if (Array.isArray(cachedMunicipalities)) {
      populateLogMunicipalityOptions(cachedMunicipalities);
      syncLogScopeFields();
    }
  } catch (_) {
    // ignore cache parsing issues
  }

  if (!token) return showHome();
  try {
    currentUser = await api('/auth/me');
    await initializeAuthenticatedSession({ runRefreshInBackground: true });
  } catch (error) {
    if (Number(error?.status) === 401) {
      logout();
      return;
    }
    setLoginError(`Session conservée mais API indisponible: ${sanitizeErrorMessage(error?.message || 'erreur inconnue')}`, buildLoginDebugDetails(error, currentUser?.username || 'session existante'));
    showLogin();
  }
})();
