const STORAGE_KEYS = {
  token: 'token',
  activePanel: 'activePanel',
  appSidebarCollapsed: 'appSidebarCollapsed',
  mapPointsCache: 'mapPointsCache',
  municipalitiesCache: 'municipalitiesCache',
  dashboardSnapshot: 'dashboardSnapshot',
  externalRisksSnapshot: 'externalRisksSnapshot',
  apiInterconnectionsSnapshot: 'apiInterconnectionsSnapshot',
};
const AUTO_REFRESH_MS = 60000;
const EVENTS_LIVE_REFRESH_MS = 60000;
const HOME_LIVE_REFRESH_MS = 300000;
const API_CACHE_TTL_MS = 300000;
const API_PANEL_REFRESH_MS = 300000;
const PANEL_TITLES = {
  'situation-panel': 'Situation opérationnelle',
  'services-panel': 'Services connectés',
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
  centre_hebergement: { label: 'Centre d\'hébergement', icon: '🏘️' },
  hopital: { label: 'Hôpital', icon: '🏥' },
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
  energie: { label: 'Énergie / barrage', icon: '⚡' },
};

const RESOURCE_POINTS = [
  { id: 'pc-grenoble', name: 'Préfecture de l’Isère (PC départemental ORSEC)', type: 'poste_commandement', active: true, lat: 45.188179265241644, lon: 5.732620255019881, address: '12 Pl. de Verdun, 38000 Grenoble', priority: 'critical', info: 'Centre de commandement départemental activé en gestion de crise majeure.', source: 'https://www.isere.gouv.fr' },
  { id: 'hebergement-voiron', name: 'Gymnase municipal de Voiron (site d’hébergement d’urgence)', type: 'centre_hebergement', active: true, lat: 45.36495, lon: 5.59244, address: 'Avenue Jules Ravat, 38500 Voiron', priority: 'vital', info: 'Structure mobilisable pour mise à l’abri temporaire et accueil évacués.', source: 'https://www.ville-voiron.fr' },
  { id: 'chu-grenoble', name: 'CHU Grenoble Alpes – Site Nord (Hôpital Michallon)', type: 'hopital', active: true, lat: 45.19890130472817, lon: 5.745337307337676, address: 'Bd de la Chantourne, 38700 La Tronche', priority: 'critical', info: 'Pôle sanitaire de référence (SAMU 38, urgences, réanimation, trauma center).', source: 'https://www.chu-grenoble.fr' },
  { id: 'chu-grenoble-sud', name: 'CHU Grenoble Alpes - Site SUD', type: 'hopital', active: true, lat: 45.14824137405201, lon: 5.732509610468402, address: 'Hôpital Michallon, Chu de Grenoble, 38043 Grenoble', priority: 'vital', info: 'Site hospitalier mobilisable pour la continuité de la réponse sanitaire en crise.', source: 'https://www.chu-grenoble.fr' },
  { id: 'ch-vienne', name: 'Centre hospitalier Lucien Hussel', type: 'hopital', active: true, lat: 45.533846044381946, lon: 4.880350896438764, address: 'Montee Dr Maurice Chapuis, 38200 Vienne', priority: 'vital', info: 'Hôpital pivot pour le sud-ouest du département et la vallée du Rhône.', source: 'https://www.ch-vienne.fr' },
  { id: 'sdis-bj', name: 'SDIS 38 – CSP Bourgoin-Jallieu', type: 'caserne', active: true, lat: 45.59259063641058, lon: 5.259705725092601, address: '59 Rue Lavoisier, 38300 Bourgoin-Jallieu', priority: 'vital', info: 'Point de projection stratégique sur l’axe A43 et Nord-Isère.', source: 'https://www.sdis38.fr' },
  { id: 'sdis38-em', name: 'État-major du Service Départemental d\'Incendie et de Secours de l\'Isère', type: 'poste_commandement', active: true, lat: 45.187614671926696, lon: 5.683126256547923, address: '24 Rue René Camphin, 38600 Fontaine', priority: 'critical', info: 'État-major départemental de coordination des moyens d\'incendie et de secours.', source: 'https://www.sdis38.fr' },
  { id: 'cea-grenoble', name: 'CEA Grenoble – Presqu’île scientifique', type: 'centrale_nucleaire', active: true, lat: 45.201145835693275, lon: 5.705203927562952, address: '17 Av. des Martyrs, 38000 Grenoble', priority: 'critical', info: 'Site de recherche sensible avec enjeux continuité d’activité et sûreté.', source: 'https://www.cea.fr' },
  { id: 'cnpe-saint-alban', name: 'CNPE EDF Saint-Alban / Saint-Maurice', type: 'centrale_nucleaire', active: true, lat: 45.405422953042404, lon: 4.757081312357517, address: 'Rte de la Centrale, 38550 Saint-Maurice-l\'Exil', priority: 'risk', info: 'Installation nucléaire majeure sous surveillance pour la frange sud-ouest Isère.', source: 'https://www.edf.fr/centrale-nucleaire-saint-alban' },
  { id: 'pont-de-claix-chem', name: 'Plateforme chimique de Pont-de-Claix', type: 'lieu_risque', active: true, lat: 45.13180530005534, lon: 5.706618216387599, address: 'Francia, Rue Lavoisier, Le Pont-de-Claix', priority: 'risk', info: 'Cluster industriel SEVESO de l’agglomération grenobloise.', source: 'https://www.pontdeclaix.fr' },
  { id: 'gare-grenoble', name: 'Gare de Grenoble', type: 'transport', active: true, lat: 45.19142, lon: 5.71472, address: '1 place de la Gare, 38000 Grenoble', priority: 'vital', info: 'Hub ferroviaire principal pour mobilité de crise et évacuation.', source: 'https://www.garesetconnexions.sncf/fr/gares-services/grenoble' },
  { id: 'barrage-verney', name: 'Barrage du Verney', type: 'energie', active: true, lat: 45.12920201985221, lon: 6.043436022227785, address: '38114 Allemond', priority: 'risk', info: 'Ouvrage hydraulique structurant de la vallée de l’Eau d’Olle.', source: 'https://www.edf.fr/hydraulique-isere' },
  { id: 'plateforme-chem-jarrie', name: 'Plateforme chimique de Jarrie', type: 'lieu_risque', active: true, lat: 45.08694132318529, lon: 5.736251871908567, address: 'N85 BP 16, 38560 Jarrie', priority: 'risk', info: 'Zone industrielle sensible en continuité du couloir chimique sud grenoblois.', source: 'https://www.jarrie.fr' },
  { id: 'centrale-barrage-grandmaison', name: 'STEP de Grand’Maison', type: 'energie', active: true, lat: 45.206053828393784, lon: 6.116978747872993, address: '38114 Vaujany', priority: 'risk', info: 'Infrastructure énergétique stratégique pour la stabilité du réseau.', source: 'https://www.edf.fr/hydraulique-isere' },
  { id: 'aeroport-grenoble', name: 'Aéroport Grenoble Alpes Isère', type: 'transport', active: true, lat: 45.361, lon: 5.33056, address: '38590 Saint-Étienne-de-Saint-Geoirs', priority: 'vital', info: 'Plateforme aérienne de soutien logistique et d’évacuation sanitaire.', source: 'https://www.grenoble-airport.com' },
  { id: 'palais-sports', name: 'Palais des Sports de Grenoble (centre d’accueil)', type: 'centre_hebergement', active: true, lat: 45.18565564489357, lon: 5.7408451908719655, address: '14 Bd Clemenceau, 38029 Grenoble', priority: 'vital', info: 'Site de regroupement mobilisable pour accueil population/renforts.', source: 'https://www.grenoble.fr' },
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
let photoCameraRefreshTimer = null;
let lastApiResyncAt = null;
const apiGetCache = new Map();
const apiInFlight = new Map();

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
let userLocationMarker = null;
let mapAddPointMode = false;
let mapPoints = [];
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
let geocodeCache = new Map();
let municipalityContourCache = new Map();
const municipalityDocumentsUiState = new Map();
let trafficGeocodeCache = new Map();
let mapStats = { stations: 0, pcs: 0, resources: 0, custom: 0, traffic: 0 };
let mapControlsCollapsed = false;
let cachedCrisisPoints = [];
let cachedLogs = [];
let cachedDashboardSnapshot = {};
let cachedExternalRisksSnapshot = {};
let isereBoundaryGeometry = null;
let trafficRenderSequence = 0;
let currentMunicipalityPreviewUrl = null;
let institutionPointsCache = [];
let institutionsLoaded = false;
let finessPointsCache = [];
let finessLoaded = false;
let iserePopulationPointsCache = [];
let iserePopulationLoaded = false;

const SCHOOL_RESOURCE_TYPES = new Set(['ecole_primaire', 'college', 'lycee', 'universite', 'creche']);
const SECURITY_RESOURCE_TYPES = new Set(['gendarmerie', 'commissariat_police_nationale', 'police_municipale']);
const FIRE_RESOURCE_TYPES = new Set(['caserne_pompier']);
const HEALTH_RESOURCE_TYPES = new Set(['hopital', 'ehpad']);

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
  { name: 'Bifurcation A43/A48 près de Bourgoin vers Chambéry', road: 'A43 / A48', lat: 45.56699881012449, lon: 5.344117226835471, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area06.mp4' },
  { name: 'A48 Châbons voie Sud', road: 'A48', lat: 45.44780572102549, lon: 5.399438919782866, manager: 'AREA', streamUrl: 'https://www.bison-fute.gouv.fr/camera-upload/at_area11.mp4' },
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
  const statusKey = String(log.status || 'nouveau');
  const status = LOG_STATUS_LABEL[statusKey] || 'Nouveau';
  const municipality = log.municipality_id ? ` · ${escapeHtml(getMunicipalityName(log.municipality_id))}` : '';
  const place = log.location ? ` · 📍 ${escapeHtml(log.location)}` : '';
  const source = log.source ? ` · Source: ${escapeHtml(log.source)}` : '';
  const owner = log.assigned_to ? ` · 👤 ${escapeHtml(log.assigned_to)}` : '';
  const next = log.next_update_due ? ` · ⏱️ MAJ ${new Date(log.next_update_due).toLocaleString()}` : '';
  const actions = log.actions_taken ? `<div class="muted">Actions: ${escapeHtml(log.actions_taken)}</div>` : '';
  const statusActions = canEdit() ? `<div class="map-inline-actions"><button type="button" class="ghost inline-action" data-log-status="${log.id}" data-log-next="en_cours">En cours</button><button type="button" class="ghost inline-action" data-log-status="${log.id}" data-log-next="suivi">Suivi</button><button type="button" class="ghost inline-action" data-log-status="${log.id}" data-log-next="clos">Clôturer</button><button type="button" class="ghost inline-action danger" data-log-delete="${log.id}">Supprimer</button></div>` : '';
  return `<li><strong>${new Date(log.event_time || log.created_at).toLocaleString()}</strong> · <span class="badge neutral">${formatLogScope(log)}${municipality}</span> ${log.danger_emoji || LOG_LEVEL_EMOJI[normalizeLevel(log.danger_level)] || '🟢'} <strong style="color:${levelColor(log.danger_level)}">${escapeHtml(log.event_type || 'MCO')}</strong> · <span class="badge neutral">${status}</span>${place}${owner}${source}${next}<div>${escapeHtml(log.description || '')}</div>${actions}${statusActions}</li>`;
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
  municipalitySelect.required = requiresMunicipality;
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

function showHome() { setVisibility(homeView, true); setVisibility(loginView, false); setVisibility(appView, false); }
function showLogin() { setVisibility(homeView, false); setVisibility(loginView, true); setVisibility(appView, false); setVisibility(passwordForm, false); setVisibility(loginForm, true); }
function showApp() { setVisibility(homeView, false); setVisibility(loginView, false); setVisibility(appView, true); }

function apiOrigins() {
  return Array.from(new Set([
    window.location.origin,
    'http://localhost:1182',
    'http://127.0.0.1:1182',
  ]));
}

function buildApiUrl(path, origin) {
  if (origin === window.location.origin) return path;
  return `${origin}${path}`;
}

function sanitizeErrorMessage(message) {
  const normalized = typeof message === 'string' ? message : String(message || '');
  if (!normalized) return 'Erreur inconnue';
  if (normalized.includes('Failed to fetch') || normalized.includes('NetworkError')) {
    return "Connexion API indisponible (Failed to fetch). Vérifiez le backend, le port 1182 et le proxy web.";
  }
  if (normalized.includes('<!doctype') || normalized.includes('<html')) {
    return "L'API renvoie une page HTML au lieu d'un JSON. Vérifiez que le backend tourne bien sur le même hôte (docker compose up -d).";
  }
  return normalized;
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

function clonePayload(payload) {
  if (payload == null) return payload;
  return JSON.parse(JSON.stringify(payload));
}

function isCacheableRequest(path, fetchOptions = {}) {
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  if (method !== 'GET') return false;
  return !path.includes('/auth/login');
}


function createApiError(message, status = null) {
  const error = new Error(message);
  if (status !== null && status !== undefined) error.status = Number(status);
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

async function api(path, options = {}) {
  const {
    logoutOn401 = true,
    omitAuth = false,
    cacheTtlMs = API_CACHE_TTL_MS,
    bypassCache = false,
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

  const headers = { ...(fetchOptions.headers || {}) };
  if (token && !omitAuth) headers.Authorization = `Bearer ${token}`;

  const requestPromise = (async () => {
    let lastError = null;
    for (const origin of apiOrigins()) {
      const url = buildApiUrl(path, origin);
      try {
        const response = await fetch(url, { ...fetchOptions, headers });
        const payload = await parseJsonResponse(response, path);
        if (!response.ok) {
          const message = normalizeApiErrorMessage(payload, response.status);
          if (response.status === 401 && logoutOn401) logout();
          throw createApiError(message, response.status);
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (!String(error.message || '').includes('Réponse non-JSON')) break;
      }
    }

    throw createApiError(sanitizeErrorMessage(lastError?.message || 'API indisponible'), lastError?.status);
  })();

  if (!cacheable) {
    const responsePayload = await requestPromise;
    clearApiCache();
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
      const response = await fetch(url, { headers });
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
      lastError = error;
    }
  }
  throw createApiError(sanitizeErrorMessage(lastError?.message || 'API indisponible'), lastError?.status);
}

function setActivePanel(panelId) {
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
  if (panelId === 'api-panel' && token) {
    loadApiInterconnections(false).catch((error) => {
      document.getElementById('dashboard-error').textContent = sanitizeErrorMessage(error.message);
    });
  }
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
      options: { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' },
    },
    topo: {
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 17, attribution: '&copy; OpenTopoMap contributors' },
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
    'isere-flood': {
      url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
      options: { maxZoom: 19, attribution: '&copy; Etat (Géorisques) · fond IGN/Geoportail' },
      floodOverlay: {
        url: 'https://georisques.gouv.fr/services',
        options: {
          layers: 'PPRN_COMMUNE_RISQINOND_APPROUV,PPRN_COMMUNE_RISQINOND_PRESCRIT',
          format: 'image/png',
          transparent: true,
          version: '1.3.0',
          opacity: 0.62,
          attribution: '&copy; Etat / Géorisques',
        },
      },
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
  itinisereLayer = window.L.layerGroup().addTo(leafletMap);
  bisonLayer = window.L.layerGroup().addTo(leafletMap);
  bisonCameraLayer = window.L.layerGroup().addTo(leafletMap);
  photoCameraLayer = window.L.layerGroup().addTo(leafletMap);
  institutionLayer = window.L.layerGroup().addTo(leafletMap);
  populationLayer = window.L.layerGroup().addTo(leafletMap);
  leafletMap.on('click', onMapClickAddPoint);
  leafletMap.on('popupopen', refreshPhotoCameraImages);
  startPhotoCameraAutoRefresh();
}

function setMapFeedback(message = '', isError = false) {
  const target = document.getElementById('map-feedback');
  if (!target) return;
  target.textContent = message;
  target.className = isError ? 'error' : 'muted';
}


async function resetMapFilters() {
  const defaults = {
    'map-search': '',
    'resource-target-category-filter': 'all',
    'poi-target-category-filter': 'all',
    'filter-resources-schools-type': 'all',
    'filter-resources-security-type': 'all',
    'filter-resources-health-type': 'all',
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
  const trafficIncidents = document.getElementById('filter-traffic-incidents');
  const cameras = document.getElementById('filter-cameras');
  const googleFlow = document.getElementById('filter-google-traffic-flow');
  const healthResources = document.getElementById('filter-resources-health');
  if (hydro) hydro.checked = true;
  if (pcs) pcs.checked = true;
  if (activeOnly) activeOnly.checked = true;
  if (schools) schools.checked = false;
  if (security) security.checked = false;
  if (fireStations) fireStations.checked = false;
  if (trafficIncidents) trafficIncidents.checked = true;
  if (cameras) cameras.checked = true;
  if (healthResources) healthResources.checked = true;
  if (googleFlow) googleFlow.checked = false;
  resourceVisibilityOverrides.clear();
  if (searchLayer) searchLayer.clearLayers();
  applyBasemap('osm');
  renderStations(cachedVigicruesPayload);
  renderCustomPoints();
  renderResources();
  await renderMunicipalitiesOnMap(cachedMunicipalities);
  await renderPopulationByCityLayer();
  await renderTrafficOnMap();
  renderMapChecks([]);
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
  document.getElementById('map-source').textContent = `Source carte: ${data.source}`;
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
      const response = await fetch(url);
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
      const response = await fetch(url);
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
      .bindPopup(`<strong>${municipality.name}</strong><br>Code postal: ${municipality.postal_code || '-'}<br>Responsable: ${municipality.manager}<br>PCS: actif<br>Statut: ${isInCrisis ? 'CRISE' : 'veille'}`)
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

function refreshResourceTargetOptions() {
  const button = document.getElementById('resource-target-toggle-btn');
  if (!button) return;
  const targetCategory = document.getElementById('resource-target-category-filter')?.value || 'all';
  const allResources = [...RESOURCE_POINTS, ...institutionPointsCache, ...finessPointsCache]
    .filter((resource) => targetCategory === 'all' || resource.type === targetCategory);
  const hasVisible = allResources.some((resource) => resourceVisibilityOverrides.get(resource.id) !== false);
  button.disabled = allResources.length === 0;
  button.textContent = hasVisible ? 'Masquer les ressources' : 'Afficher les ressources';
}

function toggleSelectedResourceVisibility() {
  const targetCategory = document.getElementById('resource-target-category-filter')?.value || 'all';
  const allResources = [...RESOURCE_POINTS, ...institutionPointsCache, ...finessPointsCache]
    .filter((resource) => targetCategory === 'all' || resource.type === targetCategory);
  if (!allResources.length) return;
  const hasVisible = allResources.some((resource) => resourceVisibilityOverrides.get(resource.id) !== false);
  allResources.forEach((resource) => {
    resourceVisibilityOverrides.set(resource.id, !hasVisible);
  });
  renderResources();
  const targetLabel = targetCategory === 'all'
    ? 'toutes catégories'
    : (RESOURCE_TYPE_META[targetCategory]?.label || targetCategory.replace(/_/g, ' '));
  setMapFeedback(`Ressources: ${hasVisible ? 'masquées' : 'affichées'} (${targetLabel}).`);
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
  const name = String(tags.name || '').toLowerCase();
  const policeType = String(tags.police || '').toLowerCase();

  if (amenity === 'kindergarten') return 'creche';
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
  return null;
}

function shouldDisplayInstitutionType(type = '') {
  const schoolTypeFilter = document.getElementById('filter-resources-schools-type')?.value || 'all';
  const securityTypeFilter = document.getElementById('filter-resources-security-type')?.value || 'all';
  const healthTypeFilter = document.getElementById('filter-resources-health-type')?.value || 'all';

  if (SCHOOL_RESOURCE_TYPES.has(type)) {
    const schoolsEnabled = document.getElementById('filter-resources-schools')?.checked ?? false;
    if (!schoolsEnabled) return false;
    return schoolTypeFilter === 'all' || schoolTypeFilter === type;
  }
  if (SECURITY_RESOURCE_TYPES.has(type)) {
    const securityEnabled = document.getElementById('filter-resources-security')?.checked ?? false;
    if (!securityEnabled) return false;
    return securityTypeFilter === 'all' || securityTypeFilter === type;
  }
  if (FIRE_RESOURCE_TYPES.has(type)) return document.getElementById('filter-resources-fire')?.checked ?? false;
  if (HEALTH_RESOURCE_TYPES.has(type)) {
    const healthEnabled = document.getElementById('filter-resources-health')?.checked ?? true;
    if (!healthEnabled) return false;
    return healthTypeFilter === 'all' || healthTypeFilter === type;
  }
  return false;
}

async function loadFinessIsereResources() {
  if (finessLoaded) return finessPointsCache;
  try {
    const payload = await api('/api/finess/isere/resources', { cacheTtlMs: 12 * 60 * 60 * 1000 });
    const resources = Array.isArray(payload?.resources) ? payload.resources : [];
    finessPointsCache = resources
      .map((resource) => {
        const lat = Number(resource?.lat);
        const lon = Number(resource?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        const type = resource?.type === 'ehpad' ? 'ehpad' : 'hopital';
        return {
          id: String(resource?.id || `finess-${resource?.finess_id || Math.random().toString(36).slice(2)}`),
          name: String(resource?.name || 'Établissement FINESS'),
          type,
          lat,
          lon,
          active: true,
          address: String(resource?.address || resource?.city || 'Adresse non renseignée'),
          priority: type === 'hopital' ? 'critical' : 'vital',
          info: String(resource?.info || 'Source FINESS data.gouv.fr'),
          source: String(resource?.source || 'https://www.data.gouv.fr/fr/datasets/finess-extraction-du-fichier-des-etablissements/'),
          dynamic: true,
        };
      })
      .filter(Boolean);
  } catch {
    finessPointsCache = [];
  }
  finessLoaded = true;
  return finessPointsCache;
}

async function loadIserePopulationPoints() {
  if (iserePopulationLoaded) return iserePopulationPointsCache;
  try {
    const payload = await fetch('https://geo.api.gouv.fr/departements/38/communes?fields=nom,population,centre&format=json').then((r) => r.json());
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
  const query = `[out:json][timeout:40];
area["boundary"="administrative"]["admin_level"="6"]["name"="Isère"]->.searchArea;
(
  nwr["amenity"~"school|college|university|kindergarten|police|fire_station"](area.searchArea);
);
out center tags;`;
  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: query,
    });
    const payload = await parseJsonResponse(response, 'overpass-institutions');
    const elements = Array.isArray(payload?.elements) ? payload.elements : [];
    institutionPointsCache = elements
      .map((element) => {
        const type = classifyInstitutionPoint(element);
        if (!type) return null;
        const lat = Number(element.lat ?? element.center?.lat);
        const lon = Number(element.lon ?? element.center?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        const name = String(element.tags?.name || '').trim() || 'Établissement';
        const address = [element.tags?.['addr:housenumber'], element.tags?.['addr:street'], element.tags?.['addr:city']].filter(Boolean).join(' ') || 'Adresse non renseignée';
        return {
          id: `osm-${element.type}-${element.id}`,
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
  } catch {
    institutionPointsCache = [];
  }
  institutionsLoaded = true;
  return institutionPointsCache;
}

function getDisplayedResources() {
  const targetCategory = document.getElementById('resource-target-category-filter')?.value || 'all';
  const query = (document.getElementById('map-search')?.value || '').trim().toLowerCase();
  const staticResources = RESOURCE_POINTS
    .filter((r) => r.active)
    .filter((r) => resourceVisibilityOverrides.get(r.id) !== false)
    .filter((r) => !HEALTH_RESOURCE_TYPES.has(r.type) || shouldDisplayInstitutionType(r.type))
    .filter((r) => targetCategory === 'all' || r.type === targetCategory)
    .filter((r) => !query || `${r.name} ${r.address}`.toLowerCase().includes(query))
    .map((r) => ({ ...r, dynamic: false }));
  const dynamicResources = [...institutionPointsCache, ...finessPointsCache]
    .filter((r) => shouldDisplayInstitutionType(r.type))
    .filter((r) => resourceVisibilityOverrides.get(r.id) !== false)
    .filter((r) => targetCategory === 'all' || r.type === targetCategory)
    .filter((r) => !query || `${r.name} ${r.address}`.toLowerCase().includes(query));
  return [...staticResources, ...dynamicResources];
}

async function renderResources() {
  await Promise.all([loadIsereInstitutions(), loadFinessIsereResources()]);
  const resources = getDisplayedResources();
  const priorityLabel = { critical: 'critique', vital: 'vital', risk: 'à risque', standard: 'standard' };
  const markerColor = { critical: '#e03131', vital: '#1971c2', risk: '#f08c00', standard: '#2f9e44' };
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
  }).join('') || '<li>Aucune ressource avec ces filtres.</li>');
  mapStats.resources = resources.length;
  updateMapSummary();
  refreshResourceTargetOptions();
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
      .bindPopup(`<strong>${meta.icon} ${r.name}</strong><br>Type: ${meta.label}<br>Niveau: ${priorityLabel[r.priority] || 'standard'}<br>Adresse: ${r.address}<br>${escapeHtml(r.info || '')}<br><a href="${escapeHtml(r.source || '#')}" target="_blank" rel="noreferrer">Source publique</a>`)
      .addTo(resourceLayer);
  });
  setMapFeedback(`${resources.length} ressource(s) affichée(s).`);
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
  searchLayer.clearLayers();
  window.L.marker([coords.lat, coords.lon]).bindPopup(`Résultat: ${escapeHtml(label)}`).addTo(searchLayer).openPopup();
  leafletMap.setView([coords.lat, coords.lon], 12);
}

async function handleMapSearch() {
  const query = (document.getElementById('map-search')?.value || '').trim();
  renderResources();
  if (!query || !leafletMap) {
    setMapFeedback('Saisissez un lieu ou une commune pour lancer la recherche.');
    return;
  }
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query + ', Isère, France')}`);
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
  } catch {
    const localResult = tryLocalMapSearch(query);
    if (!localResult) {
      setMapFeedback('Service de recherche temporairement indisponible.', true);
      return;
    }
    placeSearchResult(localResult.lat, localResult.lon, localResult.label);
    setMapFeedback(`Service externe indisponible, résultat local: ${localResult.label}`);
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

function itinisereStyleType(point = {}) {
  const blob = `${point.category || ''} ${point.title || ''} ${point.description || ''}`.toLowerCase();
  if (/col\b/.test(blob)) return 'pass';
  if (/ferm|barr|interdit|coup/.test(blob)) return 'closure';
  if (/travaux|chantier/.test(blob)) return 'works';
  return 'warning';
}

function itinisereDivIcon(point = {}) {
  const styleType = itinisereStyleType(point);
  const roadBadge = itinisereRoadBadge(point);
  const road = roadBadge || '?';
  const warning = styleType === 'works' ? '🚧' : '⚠️';
  if (styleType === 'closure') {
    return window.L.divIcon({
      className: 'itinisere-icon-wrap',
      html: '<span class="itinisere-icon itinisere-icon--closure">ROUTE<br/>BARRÉE</span>',
      iconSize: [52, 30],
      iconAnchor: [26, 22],
      popupAnchor: [0, -18],
    });
  }

  if (styleType === 'pass') {
    return window.L.divIcon({
      className: 'itinisere-icon-wrap',
      html: `<span class="itinisere-icon itinisere-icon--pass">Col</span><span class="itinisere-pass-state">${escapeHtml(road)}</span>`,
      iconSize: [64, 32],
      iconAnchor: [32, 22],
      popupAnchor: [0, -19],
    });
  }

  return window.L.divIcon({
    className: 'itinisere-icon-wrap',
    html: `<span class="itinisere-icon itinisere-icon--warning">${warning}</span><span class="itinisere-road-dot">${escapeHtml(road)}</span>`,
    iconSize: [42, 42],
    iconAnchor: [21, 30],
    popupAnchor: [0, -26],
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
    const communeResponse = await fetch(communeUrl);
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
    const response = await fetch(nominatimUrl, { headers: { Accept: 'application/json' } });
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
    const communeResponse = await fetch(communeUrl);
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
  const overlapCounters = new Map();
  return points.map((point) => {
    const key = `${Number(point.lat).toFixed(4)},${Number(point.lon).toFixed(4)}`;
    const count = overlapCounters.get(key) || 0;
    overlapCounters.set(key, count + 1);
    if (count === 0) return point;
    const angle = (count * 42) * (Math.PI / 180);
    const radius = 0.0015 + (Math.floor(count / 8) * 0.0006);
    return {
      ...point,
      lat: Number((point.lat + (Math.sin(angle) * radius)).toFixed(6)),
      lon: Number((point.lon + (Math.cos(angle) * radius)).toFixed(6)),
      precision: `${point.precision || 'estimée'} · ajustée`,
    };
  });
}

async function buildItinisereMapPoints(events = []) {
  const points = [];
  for (const event of events.slice(0, 80)) {
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

    if (isClosureEvent) {
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

    const providedCoords = normalizeMapCoordinates(event.lat, event.lon);
    if (!isClosureEvent && providedCoords && !roads.length) {
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

    points.push({
      ...event,
      lat: position.lat,
      lon: position.lon,
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
    const points = await buildItinisereMapPoints(cachedItinisereEvents || []);
    if (renderSequence !== trafficRenderSequence) return;
    mapStats.traffic += points.length;
    points.forEach((point) => {
      const roadsText = point.precision === 'commune' ? '' : (point.roads?.length ? `Axes détectés: ${point.roads.join(', ')}<br/>` : '');
      const locations = Array.isArray(point.locations) && point.locations.length ? point.locations.join(', ') : point.anchor;
      const icon = trafficMarkerIcon('itinisere', point.category, `${point.title || ''} ${point.description || ''}`);
      const marker = window.L.marker([point.lat, point.lon], { icon: itinisereDivIcon(point) });
      marker.bindPopup(`<strong>${escapeHtml(icon)} ${escapeHtml(point.title || 'Évènement Itinisère')}</strong><br/><span class="badge neutral">${escapeHtml(point.category || 'trafic')} · ${escapeHtml(point.severity || 'jaune')}</span><br/>${escapeHtml(point.description || '')}<br/>Localisation: ${escapeHtml(locations || 'Commune Isère')} (${escapeHtml(point.precision || 'estimée')})<br/>${roadsText}<a href="${escapeHtml(point.link || '#')}" target="_blank" rel="noreferrer">Détail Itinisère</a>`);
      marker.addTo(itinisereLayer);
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

async function loadMapPoints() {
  let loadedPoints = [];
  let usedCacheFallback = false;

  try {
    const response = await api('/map/points');
    loadedPoints = Array.isArray(response) ? response : [];
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
  cachedItinisereEvents = Array.isArray(events) ? events : [];
  const target = document.getElementById(targetId);
  if (!target) return;
  setHtml(targetId, events.slice(0, 20).map((e) => {
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

function bisonSquareCell(label, level) {
  const normalized = normalizeLevel(level || 'inconnu');
  const safeLabel = escapeHtml(label);
  const safeLevel = escapeHtml(level || 'inconnu');
  return `<div class="bison-isere-square__cell ${normalized}"><span>${safeLabel}</span><strong>${safeLevel}</strong></div>`;
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
  const today = bison.today || {};
  const tomorrow = bison.tomorrow || {};
  const isereToday = today.isere || {};
  const isereTomorrow = tomorrow.isere || {};
  const nationalToday = today.national || {};
  const nationalTomorrow = tomorrow.national || {};
  setText('bison-status', `${bison.status || 'inconnu'} · Isère départ ${isereToday.departure || 'inconnu'} / retour ${isereToday.return || 'inconnu'}`);
  setText('bison-info', `National J0: ${nationalToday.departure || 'inconnu'} / ${nationalToday.return || 'inconnu'} · J1: ${nationalTomorrow.departure || 'inconnu'} / ${nationalTomorrow.return || 'inconnu'}`);
  setText('map-bison-isere', `${isereToday.departure || 'inconnu'} (retour ${isereToday.return || 'inconnu'})`);
  setText('home-feature-bison-isere', `${isereToday.departure || 'inconnu'} / ${isereToday.return || 'inconnu'}`);
  setHtml('bison-isere-square', [
    bisonSquareCell('Départs', isereToday.departure || 'inconnu'),
    bisonSquareCell('Retours', isereToday.return || 'inconnu'),
  ].join(''));

  const bisonMarkup = [
    `<li><strong>Aujourd'hui (${today.date || '-'})</strong><br>Isère départ: ${isereToday.departure || 'inconnu'} · Isère retour: ${isereToday.return || 'inconnu'}<br>National départ: ${nationalToday.departure || 'inconnu'} · National retour: ${nationalToday.return || 'inconnu'}<br><a href="https://www.bison-fute.gouv.fr" target="_blank" rel="noreferrer">Voir la carte Bison Futé</a></li>`,
    `<li><strong>Demain (${tomorrow.date || '-'})</strong><br>Isère départ: ${isereTomorrow.departure || 'inconnu'} · Isère retour: ${isereTomorrow.return || 'inconnu'}<br>National départ: ${nationalTomorrow.departure || 'inconnu'} · National retour: ${nationalTomorrow.return || 'inconnu'}</li>`,
  ].join('');
  setHtml('bison-list', bisonMarkup);
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

function renderGeorisquesPcsRisks(monitored = []) {
  const pcsByName = new Map(
    cachedMunicipalities
      .filter((municipality) => municipality?.pcs_active)
      .map((municipality) => [String(municipality.name || '').trim().toLowerCase(), municipality]),
  );

  const pcsMonitored = monitored
    .filter((commune) => pcsByName.has(String(commune.name || commune.commune || '').trim().toLowerCase()))
    .sort((a, b) => {
      const levelA = georisquesDangerLevel(a);
      const levelB = georisquesDangerLevel(b);
      const rank = { 'Très élevé': 4, 'Élevé': 3, 'Modéré': 2, 'Faible': 1 };
      return rank[levelB.label] - rank[levelA.label];
    });

  const markup = pcsMonitored.map((commune) => {
    const danger = georisquesDangerLevel(commune);
    const gasparRisks = Array.isArray(commune.gaspar_risks) ? commune.gaspar_risks : [];
    const gasparDanger = commune.gaspar_danger_level || danger.label;
    return `<li><strong>${escapeHtml(commune.name || commune.commune || 'Commune inconnue')}</strong> <span class="danger-chip ${danger.css}">${escapeHtml(gasparDanger)}</span><br>INSEE: <strong>${escapeHtml(commune.code_insee || '-')}</strong> · Sismicité: <strong>${escapeHtml(commune.seismic_zone || commune.zone_sismicite || 'inconnue')}</strong> · Inondation: <strong>${Number(commune.flood_documents || commune.nb_documents || 0)}</strong> · PPR: <strong>${Number(commune.ppr_total || 0)}</strong> · Mouvements: <strong>${Number(commune.ground_movements_total || 0)}</strong><br>Risques GASPAR: ${gasparRisks.length ? gasparRisks.slice(0, 6).map((risk) => escapeHtml(risk)).join(', ') : 'non détaillés'}</li>`;
  }).join('') || '<li>Aucune commune PCS active avec détails Géorisques.</li>';

  setHtml('georisques-pcs-risks-list', markup);
}

function switchGeorisquesTab(tab = 'overview') {
  const isOverview = tab !== 'pcs';
  document.getElementById('georisques-overview-section')?.toggleAttribute('hidden', !isOverview);
  document.getElementById('georisques-overview-section')?.classList.toggle('hidden', !isOverview);
  document.getElementById('georisques-pcs-section')?.toggleAttribute('hidden', isOverview);
  document.getElementById('georisques-pcs-section')?.classList.toggle('hidden', isOverview);
  document.getElementById('georisques-tab-overview')?.classList.toggle('is-active', isOverview);
  document.getElementById('georisques-tab-pcs')?.classList.toggle('is-active', !isOverview);
  document.getElementById('georisques-tab-overview')?.setAttribute('aria-selected', isOverview ? 'true' : 'false');
  document.getElementById('georisques-tab-pcs')?.setAttribute('aria-selected', isOverview ? 'false' : 'true');
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

  const markup = monitored.map((commune) => {
    const docs = Array.isArray(commune.flood_documents_details) ? commune.flood_documents_details : [];
    const pprByRisk = commune.ppr_by_risk && typeof commune.ppr_by_risk === 'object' ? commune.ppr_by_risk : {};
    const pprText = Object.entries(pprByRisk).map(([risk, count]) => `${escapeHtml(risk)} (${Number(count || 0)})`).join(', ') || 'Aucun PPR détaillé';
    const communeErrors = Array.isArray(commune.errors) ? commune.errors.filter(Boolean) : [];

    const docsMarkup = docs.length
      ? `<ul class="list compact">${docs.slice(0, 6).map((doc) => `<li><strong>${escapeHtml(doc.title || doc.libelle_azi || 'Document inondation')}</strong>${doc.code ? ` (${escapeHtml(doc.code)})` : ''}${doc.river_basin ? ` · Bassin: ${escapeHtml(doc.river_basin)}` : ''}${doc.published_at ? ` · Diffusion: ${escapeHtml(doc.published_at)}` : ''}</li>`).join('')}</ul>`
      : '<span class="muted">Aucun détail de document remonté.</span>';

    const gasparRisks = Array.isArray(commune.gaspar_risks) ? commune.gaspar_risks : [];
    return `<li><strong>${escapeHtml(commune.name || commune.commune || 'Commune inconnue')}</strong> (${escapeHtml(commune.code_insee || commune.insee || '-')})<br>Sismicité: <strong>${escapeHtml(commune.seismic_zone || commune.zone_sismicite || 'inconnue')}</strong> · Radon: <strong>${escapeHtml(commune.radon_label || 'inconnu')}</strong><br>Inondation (AZI): <strong>${Number(commune.flood_documents || commune.nb_documents || 0)}</strong> · PPR: <strong>${Number(commune.ppr_total || 0)}</strong> · Mouvements: <strong>${Number(commune.ground_movements_total || 0)}</strong> · Cavités: <strong>${Number(commune.cavities_total || 0)}</strong><br>DICRIM: <strong>${escapeHtml(commune.dicrim_publication_year || 'non renseigné')}</strong> · TIM: <strong>${Number(commune.tim_total || 0)}</strong> · Info-risques: <strong>${Number(commune.risques_information_total || 0)}</strong><br>Risques GASPAR: <strong>${Number(commune.gaspar_risk_total || gasparRisks.length || 0)}</strong>${gasparRisks.length ? ` · ${gasparRisks.slice(0, 6).map((risk) => escapeHtml(risk)).join(', ')}` : ''}<br>PPR par risque: ${pprText}${communeErrors.length ? `<br><span class="muted">Anomalies commune: ${escapeHtml(communeErrors.join(' | '))}</span>` : ''}<br>${docsMarkup}</li>`;
  }).join('') || '<li>Aucune commune remontée par Géorisques.</li>';
  setHtml('georisques-communes-list', markup);
  renderGeorisquesPcsRisks(monitored);

  const allDocs = monitored.flatMap((commune) => {
    const docs = Array.isArray(commune.flood_documents_details) ? commune.flood_documents_details : [];
    const communeName = commune.name || commune.commune || 'Commune inconnue';
    return docs.map((doc) => ({ communeName, doc }));
  });

  const docsListMarkup = allDocs.map(({ communeName, doc }) => (`
    <li><strong>${escapeHtml(communeName)}</strong> · ${escapeHtml(doc.title || doc.libelle_azi || 'Document inondation')}${doc.code ? ` (${escapeHtml(doc.code)})` : ''}${doc.river_basin ? ` · Bassin: ${escapeHtml(doc.river_basin)}` : ''}${doc.published_at ? ` · Diffusion: ${escapeHtml(doc.published_at)}` : ''}</li>
  `)).join('') || '<li>Aucun document Géorisques associé affichable.</li>';
  setHtml('georisques-documents-list', docsListMarkup);
}


function openMunicipalityEditor(municipality) {
  const panel = document.getElementById('municipality-editor');
  const form = document.getElementById('municipality-edit-form');
  if (!panel || !form || !municipality) return;
  form.elements.id.value = municipality.id;
  form.elements.manager.value = municipality.manager || '';
  form.elements.phone.value = municipality.phone || '';
  form.elements.email.value = municipality.email || '';
  form.elements.postal_code.value = municipality.postal_code || '';
  form.elements.insee_code.value = municipality.insee_code || '';
  form.elements.contacts.value = municipality.contacts || '';
  form.elements.additional_info.value = municipality.additional_info || '';
  form.elements.population.value = municipality.population ?? '';
  form.elements.shelter_capacity.value = municipality.shelter_capacity ?? '';
  form.elements.radio_channel.value = municipality.radio_channel || '';
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
    <p><strong>Responsable:</strong> ${escapeHtml(municipality.manager || '-')}</p>
    <p><strong>Téléphone:</strong> ${escapeHtml(municipality.phone || '-')} · <strong>Email:</strong> ${escapeHtml(municipality.email || '-')}</p>
    <p><strong>Code postal:</strong> ${escapeHtml(municipality.postal_code || '-')} · <strong>Code INSEE:</strong> ${escapeHtml(municipality.insee_code || '-')} · <strong>PCS:</strong> ${municipality.pcs_active ? 'actif' : 'inactif'}</p>
    <p><strong>Statut:</strong> ${municipality.crisis_mode ? 'CRISE' : 'veille'} · <strong>Vigilance:</strong> ${escapeHtml(normalizeLevel(municipality.vigilance_color || 'vert'))}</p>
    <p><strong>Population:</strong> ${municipality.population ?? '-'} · <strong>Capacité d'accueil:</strong> ${municipality.shelter_capacity ?? '-'}</p>
    <p><strong>Canal radio:</strong> ${escapeHtml(municipality.radio_channel || '-')}</p>
    <p><strong>Contacts d'astreinte:</strong><br>${escapeHtml(municipality.contacts || 'Aucun')}</p>
    <p><strong>Informations complémentaires:</strong><br>${escapeHtml(municipality.additional_info || 'Aucune')}</p>
    <h5>Documents partagés</h5>
    <p class="muted">Total: <strong>${files.length}</strong>${Object.entries(byType).map(([type, count]) => ` · ${escapeHtml(type)}: ${count}`).join('')}</p>
    ${municipalityDocumentFiltersMarkup(state, municipality.id)}
    <ul class="list compact">${municipalityFilesMarkup(filteredFiles, municipality.id)}</ul>
    <h5>Main courante liée à la commune</h5>
    <ul class="list compact">${municipalityLogs.map((log) => {
      const status = LOG_STATUS_LABEL[String(log.status || 'nouveau')] || 'Nouveau';
      return `<li><strong>${new Date(log.created_at).toLocaleString()}</strong> · ${log.danger_emoji || '🟢'} <strong>${escapeHtml(log.event_type || 'MCO')}</strong> · <span class="badge neutral">${status}</span><br>${escapeHtml(log.description || '')}</li>`;
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
  const crues = normalizeLevel(dashboard.crues || externalRisks?.vigicrues?.water_alert_level || 'vert');
  const globalRisk = normalizeLevel(dashboard.global_risk || vigilance);
  const crisisCount = Number(dashboard.communes_crise ?? 0);

  const logs = Array.isArray(cachedLogs) && cachedLogs.length
    ? cachedLogs.slice(0, 8)
    : (Array.isArray(dashboard.latest_logs) ? dashboard.latest_logs : []);
  const activeSituationStatuses = new Set(['nouveau', 'en_cours', 'suivi']);
  const activeLogs = logs.filter((log) => activeSituationStatuses.has(String(log.status || '').toLowerCase()));
  const prefectureItems = Array.isArray(externalRisks?.prefecture_isere?.items)
    ? sortPrefectureItemsByRecency(externalRisks.prefecture_isere.items).slice(0, 4)
    : [];
  const kpiCards = [
    { label: 'Vigilance météo', value: vigilance, info: 'Source Météo-France', css: normalizeLevel(vigilance) },
    { label: 'Niveau crues', value: crues, info: 'Source Vigicrues', css: normalizeLevel(crues) },
    { label: 'Risque global', value: globalRisk, info: 'Calcul consolidé', css: normalizeLevel(globalRisk) },
    { label: 'Communes en crise', value: String(crisisCount), info: 'PCS actif', css: crisisCount > 0 ? 'rouge' : 'vert' },
  ];
  const bisonDeparture = normalizeLevel(externalRisks?.bison_fute?.today?.isere?.departure || 'inconnu');
  const bisonReturn = normalizeLevel(externalRisks?.bison_fute?.today?.isere?.return || 'inconnu');
  const vigieauAlertsCount = Number((externalRisks?.vigieau?.alerts || []).length);
  const atmoLevel = normalizeLevel(externalRisks?.atmo_aura?.today?.level || 'inconnu');
  const sncfIncidentsCount = Number(externalRisks?.sncf_isere?.alerts_total ?? (externalRisks?.sncf_isere?.alerts || []).length);
  const mobilityCards = [
    { label: 'Bison Futé (38) · Départs', value: bisonDeparture, info: 'Tendance départ Isère', css: bisonDeparture },
    { label: 'Bison Futé (38) · Retours', value: bisonReturn, info: 'Tendance retour Isère', css: bisonReturn },
    { label: 'Vigieau', value: `${vigieauAlertsCount}`, info: "Restriction(s) d'eau active(s)", css: vigieauAlertsCount > 0 ? 'jaune' : 'vert' },
    { label: "Qualité de l'air", value: atmoLevel, info: 'Source Atmo AURA', css: atmoLevel },
    { label: 'Incidents SNCF', value: `${sncfIncidentsCount}`, info: 'Accidents / travaux Isère', css: sncfIncidentsCount > 0 ? 'orange' : 'vert' },
  ];
  const generatedAt = safeDateToLocale(Date.now());

  setHtml('situation-content', `
    <div class="situation-toolbar">
      <div>
        <h3>SITREP journalier · Isère</h3>
        <p class="muted">Synthèse météo, risques et signaux d'intérêt · mise à jour ${escapeHtml(generatedAt)}</p>
      </div>
      <div class="situation-toolbar__actions">
        <button id="situation-export-pdf-btn" type="button">📄 Générer et télécharger le SITREP PDF</button>
      </div>
    </div>

    <div class="situation-top-grid">
      ${kpiCards.map((card) => `<article class="tile situation-tile"><h3>${card.label}</h3><p class="kpi-value ${card.css}">${escapeHtml(card.value)}</p><p class="muted">${card.info}</p></article>`).join('')}
    </div>

    <div class="situation-top-grid">
      ${mobilityCards.map((card) => `<article class="tile situation-tile"><h3>${card.label}</h3><p class="kpi-value ${card.css}">${escapeHtml(card.value)}</p><p class="muted">${card.info}</p></article>`).join('')}
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

    <h3>Fil de situation</h3>
    <div class="situation-log-columns">
      <div>
        <h4>Nouveaux / En cours / Suivi</h4>
        <ul class="list">${activeLogs.slice(0, 8).map((log) => buildSituationLogMarkup(log)).join('') || '<li>Aucune crise nouvelle / en cours / suivie.</li>'}</ul>
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

function buildSitrepMapSvg(title, points = [], lines = []) {
  const width = 480;
  const height = 280;
  const frame = '<path d="M90 26 L376 26 L450 82 L432 246 L120 258 L40 194 L36 88 Z" fill="rgba(255,255,255,0.25)" stroke="#163a87" stroke-width="2.4" />';
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
    return `<circle cx="${position.x.toFixed(1)}" cy="${position.y.toFixed(1)}" r="4.2" fill="${escapeHtml(point.color || '#0d4b8e')}" stroke="#ffffff" stroke-width="1.2" />`;
  }).join('');

  const background = 'https://staticmap.openstreetmap.de/staticmap.php?center=45.2,5.72&zoom=8&size=960x560&maptype=mapnik';
  return `<figure style="margin:10px 0 16px;">
    <figcaption style="font-weight:700; margin-bottom:6px;">${escapeHtml(title)} (centrée Isère)</figcaption>
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="220" role="img" aria-label="${escapeHtml(title)}">
      <image href="${background}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" opacity="0.95"/>
      <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(255,255,255,0.10)" />
      ${frame}
      ${lineSvg}
      ${pointsSvg}
    </svg>
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
    ? cachedItinisereEvents
      .filter((event) => (event.lat != null && event.lon != null) || (event.position?.lat != null && event.position?.lon != null))
      .map((event) => ({ lat: event.lat ?? event.position?.lat, lon: event.lon ?? event.position?.lon, color: '#d9480f' }))
    : [];
  const itinisereRoadLines = Object.values(ITINISERE_ROAD_CORRIDORS).map((corridor) => ({
    color: '#f76707',
    weight: 2.5,
    points: corridor.map((coord) => ({ lat: coord[0], lon: coord[1] })),
  }));

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
    <h2>Situation météo du jour</h2>
    <ul>${toSitrepBulletItems(meteoItems)}</ul>
  </section>
  <section class="grid">
    <div>
      <h2>Hydrologie & mobilité</h2>
      <p><strong>Vigicrues :</strong> ${escapeHtml(normalizeLevel(vigicrues.water_alert_level || 'inconnu'))}</p>
      <ul>${toSitrepBulletItems(vigicruesItems)}</ul>
      <p><strong>Bison Futé (38)</strong> · Départs: ${escapeHtml(normalizeLevel(bison.departure || 'inconnu'))} · Retours: ${escapeHtml(normalizeLevel(bison.return || 'inconnu'))}</p>
      <p><strong>Qualité de l'air:</strong> ${escapeHtml(normalizeLevel(atmo?.today?.level || 'inconnu'))}</p>
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
    ${buildSitrepMapSvg('Carte communes en crise', crisisPoints)}
  </section>
  <section>
    <h2>Cartographie opérationnelle</h2>
    ${buildSitrepMapSvg('Carte Itinisère · routes barrées', itinisereTrafficPoints, itinisereRoadLines)}
    ${buildSitrepMapSvg('Carte générale · tous les points', allPoints.map((point) => ({ lat: point.lat, lon: point.lon, color: '#0d4b8e' })))}
    ${buildSitrepMapSvg('Carte générale · filtre trafic continu', itinisereTrafficPoints)}
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
}

function renderDashboard(dashboard = {}) {
  cachedDashboardSnapshot = dashboard && typeof dashboard === 'object' ? dashboard : {};
  renderSituationOverview();
}

function renderSncfAlerts(sncf = {}) {
  const alerts = Array.isArray(sncf?.alerts) ? sncf.alerts : [];
  const total = Number(sncf?.alerts_total ?? alerts.length);
  setRiskText('sncf-status', `${sncf.status || 'inconnu'} · ${total} alerte(s)`, sncf.status === 'online' ? 'vert' : 'jaune');
  setText('sncf-info', `Filtre Isère · accidents/travaux de voie · source ${sncf.source || '-'}`);
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

async function loadDashboard() {
  const cached = readSnapshot(STORAGE_KEYS.dashboardSnapshot);
  if (cached) renderDashboard(cached);
  else renderSituationOverview();

  try {
    const dashboard = await api('/dashboard');
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
  cachedExternalRisksSnapshot = data && typeof data === 'object' ? data : {};
  const meteo = data?.meteo_france || {};
  const vigicrues = data?.vigicrues || {};
  cachedVigicruesPayload = {
    stations: Array.isArray(vigicrues.stations) ? vigicrues.stations : [],
    troncons: Array.isArray(vigicrues.troncons) ? vigicrues.troncons : [],
  };
  const itinisere = data?.itinisere || {};
  const bisonFute = data?.bison_fute || {};
  const prefecture = data?.prefecture_isere || {};
  const dauphine = data?.dauphine_isere || {};
  const sncf = data?.sncf_isere || {};
  const vigieau = data?.vigieau || {};
  const atmo = data?.atmo_aura || {};
  const electricity = data?.electricity_isere || {};
  const georisquesPayload = data?.georisques || {};
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
  renderVigieauAlerts(vigieau);
  renderElectricityStatus(electricity);
  const atmoToday = atmo?.today || {};
  const atmoLevel = normalizeLevel(atmoToday.level || 'inconnu');
  setRiskText('atmo-status', `${atmo.status || 'inconnu'} · indice ${atmoToday.index ?? '-'}`, atmoToday.level || 'vert');
  setText('atmo-info', `${atmoToday.date || 'date inconnue'} · niveau ${atmoLevel}${atmo.has_pollution_episode ? ' · épisode en cours' : ''}`);
  setRiskText('georisques-status', `${georisques.status || 'inconnu'} · sismicité ${georisques.highest_seismic_zone_label || 'inconnue'}`, georisques.status === 'online' ? 'vert' : 'jaune');
  setText('georisques-info', `${georisques.flood_documents_total ?? 0} AZI · ${georisques.ppr_total ?? 0} PPR · ${georisques.ground_movements_total ?? 0} mouvements`);
  renderGeorisquesDetails(georisques);
  renderMeteoAlerts(meteo);
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
}

async function loadExternalRisks() {
  const cached = readSnapshot(STORAGE_KEYS.externalRisksSnapshot);
  if (cached) {
    renderExternalRisks(cached);
    renderTrafficOnMap().catch(() => {});
  }

  const data = await api('/external/isere/risks');
  renderExternalRisks(data);
  saveSnapshot(STORAGE_KEYS.externalRisksSnapshot, data);
  await renderTrafficOnMap();
}

function renderApiInterconnections(data = {}) {
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
  ];

  const cards = services.map((service) => {
    const payload = data[service.key] || {};
    const status = String(payload.status || 'inconnu');
    const degraded = status !== 'online' || Boolean(payload.error);
    const errorLabel = serviceErrorLabel(payload);
    return `<article class="api-card"><h4>${service.label}</h4><p>Statut: <span class="${degraded ? 'ko' : 'ok'}">${status}</span></p><p>Indicateur: <strong>${escapeHtml(service.level)}</strong></p><p class="muted">${escapeHtml(service.details)}</p><p class="${degraded ? 'ko' : 'muted'}">Erreur actuelle: ${escapeHtml(errorLabel)}</p></article>`;
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
}

async function loadApiInterconnections(forceRefresh = false) {
  const suffix = forceRefresh ? '?refresh=true' : '';
  if (!forceRefresh) {
    const cached = readSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot);
    if (cached) renderApiInterconnections(cached);
  }
  const data = await api(`/external/isere/risks${suffix}`);
  renderApiInterconnections(data);
  saveSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot, data);
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
      <p><strong>${escapeHtml(m.manager)}</strong> · ${escapeHtml(m.phone)} · ${escapeHtml(m.email)}</p>
      <p style="color:${dangerColor}">Statut: ${m.crisis_mode ? 'CRISE' : 'veille'} · PCS ${m.pcs_active ? 'actif' : 'inactif'} · ${m.postal_code || 'CP ?'}</p>
      <div class="municipality-stats">
        <p>Population<br><strong>${m.population ?? '-'}</strong></p>
        <p>Accueil<br><strong>${m.shelter_capacity ?? '-'}</strong></p>
        <p>Radio<br><strong>${escapeHtml(m.radio_channel || '-')}</strong></p>
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
      item.manager,
      item.phone,
      item.email,
      item.postal_code,
      item.contacts,
      item.additional_info,
      item.radio_channel,
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
  let municipalities = [];
  if (Array.isArray(preloaded)) {
    municipalities = preloaded;
    localStorage.setItem(STORAGE_KEYS.municipalitiesCache, JSON.stringify(municipalities));
  } else {
    try {
      const payload = await api('/municipalities');
      municipalities = Array.isArray(payload) ? payload : [];
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
  const statusKey = String(log.status || 'nouveau');
  const status = LOG_STATUS_LABEL[statusKey] || 'Nouveau';
  const municipality = log.municipality_id ? ` · ${escapeHtml(getMunicipalityName(log.municipality_id))}` : '';
  const place = log.location ? `📍 ${escapeHtml(log.location)}` : 'Lieu non précisé';
  const source = log.source ? `Source: ${escapeHtml(log.source)}` : 'Source non précisée';
  const owner = log.assigned_to ? `👤 ${escapeHtml(log.assigned_to)}` : '👤 Non assigné';
  const next = log.next_update_due ? `⏱️ MAJ ${new Date(log.next_update_due).toLocaleString()}` : '';
  const actions = canEdit()
    ? `<div class="map-inline-actions"><button type="button" class="ghost inline-action" data-log-status="${log.id}" data-log-next="en_cours">En cours</button><button type="button" class="ghost inline-action" data-log-next="suivi" data-log-status="${log.id}">Suivi</button><button type="button" class="ghost inline-action" data-log-next="clos" data-log-status="${log.id}">Clôturer</button><button type="button" class="ghost inline-action danger" data-log-delete="${log.id}">Supprimer</button></div>`
    : '—';
  return `<tr><td>${new Date(log.event_time || log.created_at).toLocaleString()}</td><td><span class="badge neutral">${formatLogScope(log)}${municipality}</span></td><td>${log.danger_emoji || LOG_LEVEL_EMOJI[normalizeLevel(log.danger_level)] || '🟢'}</td><td><strong style="color:${levelColor(log.danger_level)}">${escapeHtml(log.event_type || 'MCO')}</strong></td><td><span class="badge neutral">${status}</span></td><td>${place}<br/><span class="muted">${owner} · ${source}${next ? ` · ${next}` : ''}</span><br/>${escapeHtml(log.description || '')}${log.actions_taken ? `<br/><span class="muted">Actions: ${escapeHtml(log.actions_taken)}</span>` : ''}</td><td>${actions}</td></tr>`;
}

function renderLogsList() {
  const search = String(document.getElementById('logs-search')?.value || '').trim().toLowerCase();
  const municipalityFilter = String(document.getElementById('logs-municipality-filter')?.value || 'all');
  const scopeFilter = String(document.getElementById('logs-scope-filter')?.value || 'all');
  const sort = String(document.getElementById('logs-sort')?.value || 'date_desc');

  let filtered = [...cachedLogs];
  if (scopeFilter !== 'all') filtered = filtered.filter((log) => String(log.target_scope || 'departemental') === scopeFilter);
  if (municipalityFilter !== 'all') filtered = filtered.filter((log) => String(log.municipality_id || '') === municipalityFilter);
  if (search) {
    filtered = filtered.filter((log) => {
      const haystack = [log.event_type, log.description, log.target_scope, log.status, log.location, log.source, log.tags, getMunicipalityName(log.municipality_id)]
        .map((value) => String(value || '').toLowerCase()).join(' ');
      return haystack.includes(search);
    });
  }

  filtered.sort((a, b) => {
    if (sort === 'date_asc') return new Date(a.event_time || a.created_at).getTime() - new Date(b.event_time || b.created_at).getTime();
    if (sort === 'danger_desc') return computeLogCriticality(b.danger_level) - computeLogCriticality(a.danger_level);
    if (sort === 'type_asc') return String(a.event_type || '').localeCompare(String(b.event_type || ''), 'fr');
    return new Date(b.event_time || b.created_at).getTime() - new Date(a.event_time || a.created_at).getTime();
  });

  const openLogs = filtered.filter((log) => ['nouveau', 'en_cours', 'suivi'].includes(String(log.status || '').toLowerCase()));
  const closedLogs = filtered.filter((log) => String(log.status || '').toLowerCase() === 'clos');

  setText('logs-count', String(filtered.length));
  setHtml('logs-table-open', openLogs.map((log) => buildLogTableRow(log)).join('') || '<tr><td colspan="7">Aucun évènement nouveau / en cours / suivi.</td></tr>');
  setHtml('logs-table-closed', closedLogs.map((log) => buildLogTableRow(log)).join('') || '<tr><td colspan="7">Aucun évènement clos.</td></tr>');
}

async function loadLogs(preloaded = null) {
  const logs = Array.isArray(preloaded) ? preloaded : await api('/logs');
  cachedLogs = Array.isArray(logs) ? logs : [];
  renderLogsList();
  renderSituationOverview();
}

async function exportLogsCsv() {
  const response = await fetch('/logs/export/csv', { headers: { Authorization: `Bearer ${token}` } });
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
  const users = Array.isArray(preloaded) ? preloaded : await api('/auth/users');
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
  return withPreservedScroll(async () => {
    try {
      await loadOperationsBootstrap(forceRefresh);
      await loadMapPoints();
      await renderTrafficOnMap();
      renderResources();
      document.getElementById('dashboard-error').textContent = '';
      return;
    } catch (bootstrapError) {
      setText('operations-perf', 'Perf: mode dégradé (chargement par modules)');
      const loaders = [
        { label: 'tableau de bord', loader: loadDashboard, optional: true },
        { label: 'risques externes', loader: loadExternalRisks, optional: false },
        { label: 'communes', loader: loadMunicipalities, optional: false },
        { label: 'main courante', loader: loadLogs, optional: false },
        { label: 'utilisateurs', loader: loadUsers, optional: true },
        { label: 'interconnexions API', loader: loadApiInterconnections, optional: true },
        { label: 'points cartographiques', loader: loadMapPoints, optional: true },
      ];

      const results = await Promise.allSettled(loaders.map(({ loader }) => loader()));
      const failures = results
        .map((result, index) => ({ result, config: loaders[index] }))
        .filter(({ result }) => result.status === 'rejected');

      const blockingFailures = failures.filter(({ config }) => !config.optional);
      const optionalFailures = failures.filter(({ config }) => config.optional);

      renderResources();

      if (!blockingFailures.length) {
        const errorTarget = document.getElementById('dashboard-error');
        if (errorTarget && !errorTarget.textContent.trim()) {
          const warning = optionalFailures.length
            ? `Modules secondaires indisponibles: ${optionalFailures.map(({ config, result }) => `${config.label}: ${sanitizeErrorMessage(result.reason?.message || 'erreur')}`).join(' · ')}`
            : '';
          errorTarget.textContent = warning || `Bootstrap indisponible: ${sanitizeErrorMessage(bootstrapError.message)}`;
        }
        return;
      }

      const message = blockingFailures.map(({ config, result }) => `${config.label}: ${sanitizeErrorMessage(result.reason?.message || 'erreur')}`).join(' · ');
      document.getElementById('dashboard-error').textContent = `Bootstrap: ${sanitizeErrorMessage(bootstrapError.message)} · ${message}`;
      setMapFeedback(message, true);
    }
  });
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
  if (!workspace || !controls || !toggle) return;
  workspace.classList.toggle('map-workspace--collapsed', mapControlsCollapsed);
  controls.setAttribute('aria-hidden', String(mapControlsCollapsed));
  toggle.setAttribute('aria-expanded', String(!mapControlsCollapsed));
  toggle.textContent = mapControlsCollapsed ? '🧰' : '📌';
  const toggleLabel = mapControlsCollapsed ? 'Afficher les options de la carte' : 'Ranger les options de la carte';
  toggle.title = toggleLabel;
  toggle.setAttribute('aria-label', toggleLabel);
  if (leafletMap) setTimeout(() => leafletMap.invalidateSize(), 160);
}

function updateMapFullscreenButton() {
  const button = document.getElementById('map-fullscreen-toggle');
  const mapWrapper = document.querySelector('#map-panel .map-canvas-wrap');
  if (!button || !mapWrapper) return;
  const isFullscreen = document.fullscreenElement === mapWrapper;
  button.textContent = isFullscreen ? '🡼' : '⛶';
  button.setAttribute('aria-pressed', String(isFullscreen));
  const label = isFullscreen ? 'Quitter le plein écran de la carte' : 'Passer la carte en plein écran';
  button.title = label;
  button.setAttribute('aria-label', label);
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
  document.getElementById('georisques-tab-overview')?.addEventListener('click', () => switchGeorisquesTab('overview'));
  document.getElementById('georisques-tab-pcs')?.addEventListener('click', () => switchGeorisquesTab('pcs'));
  switchGeorisquesTab('overview');
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
  document.getElementById('map-fullscreen-toggle')?.addEventListener('click', toggleMapFullscreen);
  document.addEventListener('fullscreenchange', updateMapFullscreenButton);
  updateMapFullscreenButton();
  document.getElementById('map-fit-btn')?.addEventListener('click', () => fitMapToData(true));
  document.getElementById('map-locate-btn')?.addEventListener('click', locateUserOnMap);
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
    renderResources();
    setMapFeedback('Recherche effacée, ressources remises à jour.');
  });
  document.getElementById('resources-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-resource-toggle]');
    if (!button) return;
    toggleResourceActive(button.dataset.resourceToggle || '');
  });
  document.getElementById('resource-target-category-filter')?.addEventListener('change', () => {
    renderResources();
  });
  document.getElementById('resource-target-toggle-btn')?.addEventListener('click', toggleSelectedResourceVisibility);
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
  document.getElementById('municipality-details-content')?.addEventListener('click', async (event) => {
    const crisisButton = event.target.closest('[data-muni-detail-crisis]');
    const openFileButton = event.target.closest('[data-muni-file-open]');
    const downloadFileButton = event.target.closest('[data-muni-file-download]');
    const uploadFileButton = event.target.closest('[data-muni-file-upload]');
    const deleteFileButton = event.target.closest('[data-muni-file-delete]');
    if (!crisisButton && !openFileButton && !downloadFileButton && !uploadFileButton && !deleteFileButton) return;

    const getMunicipality = (id) => cachedMunicipalityRecords.find((m) => String(m.id) === String(id));

    try {
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
  ['logs-search', 'logs-municipality-filter', 'logs-scope-filter', 'logs-sort'].forEach((id) => {
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
    const statusButton = event.target.closest('[data-log-status]');
    const deleteButton = event.target.closest('[data-log-delete]');
    if (!statusButton && !deleteButton) return;
    if (!canEdit()) return;

    try {
      if (statusButton) {
        const logId = statusButton.getAttribute('data-log-status');
        const status = statusButton.getAttribute('data-log-next');
        await api(`/logs/${logId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
      }

      if (deleteButton) {
        const logId = deleteButton.getAttribute('data-log-delete');
        const confirmed = window.confirm('Supprimer cette entrée de main courante ?');
        if (!confirmed) return;
        await api(`/logs/${logId}`, { method: 'DELETE' });
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
      manager: form.elements.manager.value.trim(),
      phone: form.elements.phone.value.trim(),
      email: form.elements.email.value.trim(),
      postal_code: form.elements.postal_code.value.trim() || null,
      insee_code: form.elements.insee_code.value.trim() || null,
      contacts: form.elements.contacts.value.trim() || null,
      additional_info: form.elements.additional_info.value.trim() || null,
      population: Number(form.elements.population.value || 0) || null,
      shelter_capacity: Number(form.elements.shelter_capacity.value || 0) || null,
      radio_channel: form.elements.radio_channel.value.trim() || null,
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

  ['filter-hydro', 'filter-pcs', 'filter-resources-active', 'filter-resources-schools', 'filter-resources-schools-type', 'filter-resources-security', 'filter-resources-security-type', 'filter-resources-fire', 'filter-resources-health', 'filter-resources-health-type', 'filter-traffic-incidents', 'filter-cameras'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', async () => {
      renderStations(cachedVigicruesPayload);
      await renderMunicipalitiesOnMap(cachedMunicipalities);
      await renderResources();
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
  showHome();
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => token && refreshAll(false), AUTO_REFRESH_MS);
}

async function refreshLiveEvents() {
  if (!token || document.hidden) return;
  return withPreservedScroll(async () => {
    try {
      const [logs, risks, dashboard] = await Promise.all([
        api('/logs', { cacheTtlMs: 0, bypassCache: true }),
        api('/external/isere/risks', { cacheTtlMs: 0, bypassCache: true }),
        api('/dashboard', { cacheTtlMs: 0, bypassCache: true }),
      ]);

      cachedLogs = Array.isArray(logs) ? logs : [];
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
      saveSnapshot(STORAGE_KEYS.externalRisksSnapshot, risks);
      saveSnapshot(STORAGE_KEYS.apiInterconnectionsSnapshot, risks);
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

async function loadHomeLiveStatus() {
  return withPreservedScroll(async () => {
    try {
      const data = await api('/public/live', {
        logoutOn401: false,
        omitAuth: true,
        cacheTtlMs: 0,
        bypassCache: true,
      });
      const dashboard = data?.dashboard || {};
      setRiskText('home-meteo-state', normalizeLevel(dashboard.vigilance || '-'), dashboard.vigilance || 'vert');
      setRiskText('home-river-state', normalizeLevel(dashboard.crues || '-'), dashboard.crues || 'vert');
      setRiskText('home-global-risk', normalizeLevel(dashboard.global_risk || '-'), dashboard.global_risk || 'vert');
      document.getElementById('home-crisis-count').textContent = String(dashboard.communes_crise ?? 0);
      document.getElementById('home-seismic-state').textContent = data.georisques?.highest_seismic_zone_label || 'inconnue';
      document.getElementById('home-flood-docs').textContent = String(data.georisques?.flood_documents_total ?? 0);

      document.getElementById('home-feature-global-risk').textContent = normalizeLevel(dashboard.global_risk || '-');
      document.getElementById('home-feature-river-risk').textContent = normalizeLevel(dashboard.crues || '-');
      document.getElementById('home-feature-seismic-risk').textContent = data.georisques?.highest_seismic_zone_label || 'inconnue';

      setRiskText('home-feature-meteo', normalizeLevel(dashboard.vigilance || '-'), dashboard.vigilance || 'vert');
      setRiskText('home-feature-vigicrues', normalizeLevel(data.vigicrues?.water_alert_level || '-'), data.vigicrues?.water_alert_level || 'vert');
      document.getElementById('home-feature-crisis-count').textContent = String(dashboard.communes_crise ?? 0);

      document.getElementById('home-feature-itinisere-status').textContent = data.itinisere?.status || 'inconnu';
      document.getElementById('home-feature-itinisere-events').textContent = String(data.itinisere?.events_count ?? 0);
      document.getElementById('home-feature-bison-isere').textContent = `${data.bison_fute?.today?.isere?.departure || 'inconnu'} / ${data.bison_fute?.today?.isere?.return || 'inconnu'}`;
      renderHomeMeteoSituation(data.meteo_france?.current_situation || []);
      const updatedLabel = data?.updated_at ? new Date(data.updated_at).toLocaleString() : 'inconnue';
      document.getElementById('home-live-updated').textContent = `Dernière mise à jour: ${updatedLabel}`;
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

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  document.getElementById('login-error').textContent = '';
  const form = new FormData(loginForm);
  const username = String(form.get('username') || '');
  const password = String(form.get('password') || '');

  try {
    const payload = new URLSearchParams({ username, password });
    const result = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: payload, logoutOn401: false, omitAuth: true });
    token = result.access_token;
    localStorage.setItem(STORAGE_KEYS.token, token);
    pendingCurrentPassword = password;

    if (result.must_change_password) {
      setVisibility(loginForm, false);
      setVisibility(passwordForm, true);
      return;
    }

    currentUser = await api('/auth/me');
    document.getElementById('current-role').textContent = roleLabel(currentUser.role);
    document.getElementById('current-commune').textContent = currentUser.municipality_name || 'Toutes';
    applyRoleVisibility();
    showApp();
    setActivePanel(localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel');
    await loadIsereBoundary();
    syncLogScopeFields();
    syncLogOtherFields();
    await refreshAll();
    startAutoRefresh();
    startLiveEventsRefresh();
  } catch (error) {
    document.getElementById('login-error').textContent = error.message;
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
    document.getElementById('login-error').textContent = 'Mot de passe modifié. Reconnectez-vous.';
  } catch (error) {
    document.getElementById('password-error').textContent = error.message;
  }
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
        manager: form.get('manager'),
        phone: form.get('phone'),
        email: form.get('email'),
        postal_code: form.get('postal_code'),
        insee_code: form.get('insee_code') || null,
        contacts: form.get('contacts'),
        additional_info: form.get('additional_info'),
        population: Number(form.get('population') || 0) || null,
        shelter_capacity: Number(form.get('shelter_capacity') || 0) || null,
        radio_channel: form.get('radio_channel'),
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
    await api('/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: form.get('event_type'),
        description: form.get('description'),
        danger_level: form.get('danger_level') || 'vert',
        danger_emoji: LOG_LEVEL_EMOJI[form.get('danger_level') || 'vert'] || '🟢',
        status: form.get('status') || 'nouveau',
        target_scope: form.get('target_scope'),
        municipality_id: form.get('municipality_id') ? Number(form.get('municipality_id')) : null,
        location: form.get('location') || null,
        source: form.get('source') || null,
        assigned_to: form.get('assigned_to') || null,
        tags: form.get('tags') || null,
        next_update_due: form.get('next_update_due') || null,
        actions_taken: form.get('actions_taken') || null,
      }),
    });
    event.target.reset();
    if (errorTarget) errorTarget.textContent = '';
    syncLogScopeFields();
    await refreshAll();
  } catch (error) {
    if (errorTarget) errorTarget.textContent = sanitizeErrorMessage(error.message);
  }
});

(async function bootstrap() {
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
    document.getElementById('current-role').textContent = roleLabel(currentUser.role);
    document.getElementById('current-commune').textContent = currentUser.municipality_name || 'Toutes';
    applyRoleVisibility();
    showApp();
    setActivePanel(localStorage.getItem(STORAGE_KEYS.activePanel) || 'situation-panel');
    await loadIsereBoundary();
    syncLogScopeFields();
    await refreshAll();
    startAutoRefresh();
    startLiveEventsRefresh();
  } catch (error) {
    if (Number(error?.status) === 401) {
      logout();
      return;
    }
    document.getElementById('login-error').textContent = `Session conservée mais API indisponible: ${sanitizeErrorMessage(error?.message || 'erreur inconnue')}`;
    showLogin();
  }
})();
