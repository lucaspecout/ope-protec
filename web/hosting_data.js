/**
 * hosting_data.js — Lieux d'accueil hébergeables de l'Isère (données statiques)
 * Gymnases, salles polyvalentes, complexes sportifs, centres culturels, stades, palais des congrès.
 * Fichier local : chargement instantané, aucune requête réseau nécessaire.
 * Sources : OSM, données communales, PCS Isère.
 */
window.HOSTING_STATIC_VENUES = [

  /* ══════════════════════════════════════════════════════
     GRENOBLE & MÉTROPOLE
  ══════════════════════════════════════════════════════ */
  { id: 'h-palais-sports-grenoble', name: 'Palais des Sports de Grenoble', type: 'salle_omnisports', active: true, lat: 45.1723, lon: 5.7468, address: '1 Rue du Général Ferrié, 38000 Grenoble', priority: 'critical', info: 'Salle omnisports (5 000 places) mobilisable pour hébergement massif en situation de crise.', source: 'https://www.grenoble.fr' },
  { id: 'h-alpexpo-grenoble', name: 'Alpexpo — Parc des Expositions', type: 'palais_congres', active: true, lat: 45.1634, lon: 5.7193, address: 'Esplanade d\'Innsbruck, 38000 Grenoble', priority: 'critical', info: 'Grand complexe événementiel (10 000 m²) utilisé comme centre d\'hébergement en crise majeure.', source: 'https://www.alpexpo.com' },
  { id: 'h-stade-alpes-grenoble', name: 'Stade des Alpes (Groupama Stadium)', type: 'stade', active: true, lat: 45.1906, lon: 5.7137, address: 'Rue Diodore Rahoult, 38000 Grenoble', priority: 'vital', info: 'Stade de 20 000 places, espaces intérieurs mobilisables pour accueil d\'urgence.', source: 'https://www.grenoble.fr' },
  { id: 'h-patinoire-polesud', name: 'Patinoire Polesud', type: 'salle_omnisports', active: true, lat: 45.1660, lon: 5.7167, address: 'Rue Fernand-Braudel, 38000 Grenoble', priority: 'vital', info: 'Patinoire olympique — hall mobilisable pour hébergement temporaire.', source: 'https://www.grenoble.fr' },
  { id: 'h-maison-peuple-grenoble', name: 'Maison du Peuple de Grenoble', type: 'salle_fetes', active: true, lat: 45.1871, lon: 5.7247, address: 'Pl. Dr-Girard, 38000 Grenoble', priority: 'vital', info: 'Monument historique avec grande salle polyvalente, mobilisable en gestion de crise.', source: 'https://www.grenoble.fr' },
  { id: 'h-salle-paul-mistral', name: 'Salle Paul-Mistral', type: 'salle_fetes', active: true, lat: 45.1827, lon: 5.7258, address: 'Parc Paul-Mistral, 38000 Grenoble', priority: 'standard', info: 'Salle polyvalente du parc Paul-Mistral.', source: 'https://www.grenoble.fr' },
  { id: 'h-gymnase-hoche-grenoble', name: 'Gymnase Hoche', type: 'gymnase', active: true, lat: 45.1844, lon: 5.7333, address: 'Rue Hoche, 38000 Grenoble', priority: 'standard', info: 'Gymnase municipal central.', source: 'https://www.grenoble.fr' },
  { id: 'h-gymnase-teisseire-grenoble', name: 'Gymnase Teisseire', type: 'gymnase', active: true, lat: 45.1713, lon: 5.7342, address: 'Rue de Belgrade, 38000 Grenoble', priority: 'standard', info: 'Gymnase quartier Teisseire.', source: 'https://www.grenoble.fr' },
  { id: 'h-gymnase-villeneuve-grenoble', name: 'Gymnase de la Villeneuve', type: 'gymnase', active: true, lat: 45.1584, lon: 5.7348, address: 'Av. de Valmy, 38100 Grenoble', priority: 'standard', info: 'Gymnase de quartier, capacité intermédiaire.', source: 'https://www.grenoble.fr' },

  /* ── Échirolles (38130) ── */
  { id: 'h-centre-aragon-echirolles', name: 'Centre Culturel Aragon', type: 'centre_culturel', active: true, lat: 45.1497, lon: 5.7267, address: 'Place des Fêtes, 38130 Échirolles', priority: 'vital', info: 'Centre culturel (grande salle + hall) mobilisable pour hébergement d\'urgence.', source: 'https://www.echirolles.fr' },
  { id: 'h-complexe-drac-echirolles', name: 'Complexe Sportif du Drac', type: 'complexe_sportif', active: true, lat: 45.1462, lon: 5.7222, address: 'Rue du Drac, 38130 Échirolles', priority: 'vital', info: 'Complexe multi-salles (gymnase + piscine), capacité hébergement 200+ pers.', source: 'https://www.echirolles.fr' },
  { id: 'h-gymnase-condorcet-echirolles', name: 'Gymnase Condorcet', type: 'gymnase', active: true, lat: 45.1524, lon: 5.7296, address: 'Rue Condorcet, 38130 Échirolles', priority: 'standard', info: 'Gymnase scolaire municipal.', source: 'https://www.echirolles.fr' },

  /* ── Saint-Martin-d'Hères (38400) ── */
  { id: 'h-complexe-joliot-smh', name: 'Complexe Joliot-Curie', type: 'complexe_sportif', active: true, lat: 45.1680, lon: 5.7635, address: 'Av. Joliot-Curie, 38400 Saint-Martin-d\'Hères', priority: 'vital', info: 'Grand complexe sportif municipal, plusieurs salles.', source: 'https://www.ville-smh.fr' },
  { id: 'h-salle-izzo-smh', name: 'Salle Polyvalente Jean-Claude Izzo', type: 'salle_fetes', active: true, lat: 45.1695, lon: 5.7612, address: 'Av. Gabriel Péri, 38400 Saint-Martin-d\'Hères', priority: 'standard', info: 'Salle polyvalente modulable.', source: 'https://www.ville-smh.fr' },

  /* ── Meylan (38240) ── */
  { id: 'h-complexe-ravanel-meylan', name: 'Complexe Sportif Roger-Ravanel', type: 'complexe_sportif', active: true, lat: 45.2125, lon: 5.7835, address: 'Av. des Martyrs, 38240 Meylan', priority: 'vital', info: 'Grand complexe sportif intercommunal.', source: 'https://www.meylan.fr' },
  { id: 'h-salle-polyvalente-meylan', name: 'Salle Polyvalente de Meylan', type: 'salle_fetes', active: true, lat: 45.2118, lon: 5.7822, address: 'Av. de Verdun, 38240 Meylan', priority: 'standard', info: 'Salle modulable 400 places.', source: 'https://www.meylan.fr' },

  /* ── Saint-Égrève (38120) ── */
  { id: 'h-complexe-guiers-saintegreve', name: 'Complexe Sportif du Guiers', type: 'complexe_sportif', active: true, lat: 45.2277, lon: 5.6969, address: 'Rue du Dr-Laënnec, 38120 Saint-Égrève', priority: 'vital', info: 'Complexe sportif couvrant gymnase et salles annexes.', source: 'https://www.saint-egreve.fr' },
  { id: 'h-salle-polyvalente-saintegreve', name: 'Espace Culturel Saint-Égrève', type: 'salle_fetes', active: true, lat: 45.2261, lon: 5.6953, address: 'Pl. du Général-de-Gaulle, 38120 Saint-Égrève', priority: 'standard', info: 'Salle polyvalente.', source: 'https://www.saint-egreve.fr' },

  /* ── Fontaine (38600) ── */
  { id: 'h-salle-rampe-fontaine', name: 'Salle de la Rampe', type: 'salle_fetes', active: true, lat: 45.1918, lon: 5.6874, address: 'Allée de la Rampe, 38600 Fontaine', priority: 'standard', info: 'Salle événementielle, modulable pour hébergement.', source: 'https://www.ville-fontaine.fr' },
  { id: 'h-gymnase-jean-luc-fontaine', name: 'Gymnase Jean-Luc Lagardère', type: 'gymnase', active: true, lat: 45.1932, lon: 5.6861, address: 'Rue de la Paix, 38600 Fontaine', priority: 'standard', info: 'Gymnase municipal.', source: 'https://www.ville-fontaine.fr' },

  /* ── Sassenage (38360) ── */
  { id: 'h-complexe-sassenage', name: 'Complexe Sportif de Sassenage', type: 'complexe_sportif', active: true, lat: 45.2118, lon: 5.6617, address: 'Rue des Sports, 38360 Sassenage', priority: 'vital', info: 'Complexe couvert, gymnase + salle annexe.', source: 'https://www.sassenage.fr' },

  /* ── Seyssinet-Pariset (38170) ── */
  { id: 'h-gymnase-seyssinet', name: 'Gymnase de Seyssinet-Pariset', type: 'gymnase', active: true, lat: 45.1742, lon: 5.7012, address: 'Av. de la Libération, 38170 Seyssinet-Pariset', priority: 'standard', info: 'Gymnase municipal.', source: 'https://www.seyssinet-pariset.fr' },

  /* ── Le Pont-de-Claix (38800) ── */
  { id: 'h-salle-neruda-pont-claix', name: 'Salle Polyvalente Pablo-Neruda', type: 'salle_fetes', active: true, lat: 45.1264, lon: 5.7073, address: 'Av. Pablo-Neruda, 38800 Le Pont-de-Claix', priority: 'vital', info: 'Grande salle polyvalente intercommunale.', source: 'https://www.le-pont-de-claix.fr' },
  { id: 'h-gymnase-pont-claix', name: 'Gymnase André-Lacroix', type: 'gymnase', active: true, lat: 45.1248, lon: 5.7059, address: 'Rue André-Lacroix, 38800 Le Pont-de-Claix', priority: 'standard', info: 'Gymnase municipal.', source: 'https://www.le-pont-de-claix.fr' },

  /* ── Claix (38640) ── */
  { id: 'h-gymnase-claix', name: 'Gymnase de Claix', type: 'gymnase', active: true, lat: 45.1021, lon: 5.6734, address: 'Route de Grenoble, 38640 Claix', priority: 'standard', info: 'Gymnase intercommunal.', source: 'https://www.claix.fr' },

  /* ── Varces-Allières-et-Risset (38760) ── */
  { id: 'h-salle-varces', name: 'Salle Polyvalente de Varces', type: 'salle_fetes', active: true, lat: 45.0766, lon: 5.7001, address: 'Rue du Bois-Brun, 38760 Varces', priority: 'standard', info: 'Salle modulable.', source: 'https://www.varces.fr' },

  /* ── Vizille (38220) ── */
  { id: 'h-gymnase-vizille', name: 'Gymnase Municipal de Vizille', type: 'gymnase', active: true, lat: 45.0789, lon: 5.7693, address: 'Rue du Stade, 38220 Vizille', priority: 'vital', info: 'Gymnase et salle annexe, mobilisable pour hébergement d\'urgence.', source: 'https://www.vizille.fr' },
  { id: 'h-salles-fetes-vizille', name: 'Salle des Fêtes de Vizille', type: 'salle_fetes', active: true, lat: 45.0776, lon: 5.7684, address: 'Pl. du 14-Juillet, 38220 Vizille', priority: 'standard', info: 'Salle de 300 places.', source: 'https://www.vizille.fr' },

  /* ── Domène (38420) ── */
  { id: 'h-gymnase-domene', name: 'Gymnase de Domène', type: 'gymnase', active: true, lat: 45.2014, lon: 5.8327, address: 'Rue des Écoles, 38420 Domène', priority: 'standard', info: 'Gymnase municipal.', source: 'https://www.domene.fr' },
  { id: 'h-salle-fetes-domene', name: 'Salle des Fêtes de Domène', type: 'salle_fetes', active: true, lat: 45.2028, lon: 5.8343, address: 'Pl. de la République, 38420 Domène', priority: 'standard', info: 'Salle polyvalente.', source: 'https://www.domene.fr' },

  /* ── Gières (38610) ── */
  { id: 'h-gymnase-gieres', name: 'Salle des Sports de Gières', type: 'gymnase', active: true, lat: 45.1800, lon: 5.7852, address: 'Rue de la Croix, 38610 Gières', priority: 'standard', info: 'Gymnase municipal.', source: 'https://www.gieres.fr' },

  /* ── Montbonnot-Saint-Martin (38330) ── */
  { id: 'h-gymnase-montbonnot', name: 'Gymnase de Montbonnot', type: 'gymnase', active: true, lat: 45.2340, lon: 5.8214, address: 'Rue des Écoles, 38330 Montbonnot-Saint-Martin', priority: 'standard', info: 'Gymnase municipal.', source: 'https://www.montbonnot.fr' },

  /* ── Crolles (38920) ── */
  { id: 'h-salle-polyvalente-crolles', name: 'Espace Culturel et Sportif de Crolles', type: 'complexe_sportif', active: true, lat: 45.2838, lon: 5.8742, address: 'Rue du Stade, 38920 Crolles', priority: 'vital', info: 'Complexe regroupant gymnase et salle polyvalente.', source: 'https://www.crolles.fr' },

  /* ══════════════════════════════════════════════════════
     NORD ISÈRE
  ══════════════════════════════════════════════════════ */

  /* ── Vienne (38200) ── */
  { id: 'h-complexe-alouettes-vienne', name: 'Complexe des Alouettes', type: 'complexe_sportif', active: true, lat: 45.5253, lon: 4.8729, address: 'Av. du 8-Mai-1945, 38200 Vienne', priority: 'critical', info: 'Grand complexe sportif (piscine, gymnases), mobilisable pour hébergement massif.', source: 'https://www.vienne.fr' },
  { id: 'h-espace-jean-vilar-vienne', name: 'Espace Jean-Vilar', type: 'salle_fetes', active: true, lat: 45.5257, lon: 4.8756, address: 'Pl. du Jeu-de-Paume, 38200 Vienne', priority: 'vital', info: 'Grande salle polyvalente de Vienne.', source: 'https://www.vienne.fr' },
  { id: 'h-gymnase-vienne-nord', name: 'Gymnase Nord — Vienne', type: 'gymnase', active: true, lat: 45.5278, lon: 4.8703, address: 'Rue Simone-de-Beauvoir, 38200 Vienne', priority: 'standard', info: 'Gymnase municipal.', source: 'https://www.vienne.fr' },

  /* ── Bourgoin-Jallieu (38300) ── */
  { id: 'h-espace-bonnet-bourgoin', name: 'Espace Saint-Bonnet', type: 'salle_fetes', active: true, lat: 45.5843, lon: 5.2643, address: 'Rue du Jeu-de-Paume, 38300 Bourgoin-Jallieu', priority: 'vital', info: 'Grande salle polyvalente intercommunale.', source: 'https://www.bourgoinjallieu.fr' },
  { id: 'h-omnisports-bourgoin', name: 'Salle Omnisports de Bourgoin-Jallieu', type: 'salle_omnisports', active: true, lat: 45.5857, lon: 5.2701, address: 'Av. de la Gare, 38300 Bourgoin-Jallieu', priority: 'vital', info: 'Salle omnisports, capacité 2 000 spectateurs.', source: 'https://www.bourgoinjallieu.fr' },
  { id: 'h-gymnase-champeaux-bourgoin', name: 'Gymnase Les Champeaux', type: 'gymnase', active: true, lat: 45.5821, lon: 5.2678, address: 'Rue des Champeaux, 38300 Bourgoin-Jallieu', priority: 'standard', info: 'Gymnase municipal.', source: 'https://www.bourgoinjallieu.fr' },

  /* ── Villefontaine (38090) ── */
  { id: 'h-centre-grive-villefontaine', name: 'Centre Sportif de la Grive', type: 'complexe_sportif', active: true, lat: 45.6097, lon: 5.1472, address: 'Allée de la Grive, 38090 Villefontaine', priority: 'vital', info: 'Complexe multi-activités avec grandes salles.', source: 'https://www.villefontaine.fr' },
  { id: 'h-salle-village-villefontaine', name: 'Salle Polyvalente Le Village', type: 'salle_fetes', active: true, lat: 45.6112, lon: 5.1495, address: 'Rue des Dauphinois, 38090 Villefontaine', priority: 'standard', info: 'Salle des fêtes intercommunale.', source: 'https://www.villefontaine.fr' },

  /* ── L'Isle-d'Abeau (38080) ── */
  { id: 'h-espace-aragon-isle-abeau', name: 'Espace Aragon', type: 'salle_fetes', active: true, lat: 45.6247, lon: 5.2356, address: 'Rue des Maraîchers, 38080 L\'Isle-d\'Abeau', priority: 'vital', info: 'Grande salle polyvalente modulable.', source: 'https://www.lisleabeau.fr' },
  { id: 'h-gymnase-isle-abeau', name: 'Gymnase Municipal L\'Isle-d\'Abeau', type: 'gymnase', active: true, lat: 45.6231, lon: 5.2342, address: 'Av. du Dauphiné, 38080 L\'Isle-d\'Abeau', priority: 'standard', info: 'Gymnase municipal.', source: 'https://www.lisleabeau.fr' },

  /* ── La Tour-du-Pin (38110) ── */
  { id: 'h-gymnase-tour-du-pin', name: 'Gymnase de La Tour-du-Pin', type: 'gymnase', active: true, lat: 45.5643, lon: 5.4427, address: 'Rue du Stade, 38110 La Tour-du-Pin', priority: 'vital', info: 'Gymnase municipal, mobilisable pour hébergement.', source: 'https://www.latourdupinpays.fr' },
  { id: 'h-salle-fetes-tour-du-pin', name: 'Salle des Fêtes La Tour-du-Pin', type: 'salle_fetes', active: true, lat: 45.5631, lon: 5.4412, address: 'Pl. Bir-Hakeim, 38110 La Tour-du-Pin', priority: 'standard', info: 'Salle polyvalente.', source: 'https://www.latourdupinpays.fr' },

  /* ── Morestel (38510) ── */
  { id: 'h-salle-fetes-morestel', name: 'Salle des Fêtes de Morestel', type: 'salle_fetes', active: true, lat: 45.6729, lon: 5.4610, address: 'Rue de la Mairie, 38510 Morestel', priority: 'standard', info: 'Salle communale.', source: 'https://www.morestel.fr' },

  /* ── Pont-de-Chéruy (38230) ── */
  { id: 'h-salle-fetes-pont-cheruy', name: 'Salle des Fêtes de Pont-de-Chéruy', type: 'salle_fetes', active: true, lat: 45.7518, lon: 5.1597, address: 'Grande Rue, 38230 Pont-de-Chéruy', priority: 'standard', info: 'Salle municipale.', source: 'https://www.pont-de-cheruy.fr' },

  /* ── Crémieu (38460) ── */
  { id: 'h-salle-fetes-cremieu', name: 'Salle des Fêtes de Crémieu', type: 'salle_fetes', active: true, lat: 45.7243, lon: 5.2583, address: 'Pl. de la République, 38460 Crémieu', priority: 'standard', info: 'Salle polyvalente.', source: 'https://www.cremieu.fr' },

  /* ── Roussillon (38150) ── */
  { id: 'h-salle-fetes-roussillon', name: 'Salle des Fêtes de Roussillon', type: 'salle_fetes', active: true, lat: 45.3740, lon: 4.8136, address: 'Rue de la Mairie, 38150 Roussillon', priority: 'standard', info: 'Salle communale.', source: 'https://www.roussillon38.fr' },

  /* ── Tullins (38210) ── */
  { id: 'h-omnisports-tullins', name: 'Salle Omnisports de Tullins', type: 'salle_omnisports', active: true, lat: 45.2992, lon: 5.4907, address: 'Rue des Sports, 38210 Tullins', priority: 'vital', info: 'Salle omnisports intercommunale.', source: 'https://www.tullins.fr' },

  /* ── Rives (38140) ── */
  { id: 'h-gymnase-rives', name: 'Gymnase Municipal de Rives', type: 'gymnase', active: true, lat: 45.3574, lon: 5.4798, address: 'Rue du Stade, 38140 Rives', priority: 'standard', info: 'Gymnase municipal.', source: 'https://www.rives.fr' },
  { id: 'h-salle-fetes-rives', name: 'Salle des Fêtes de Rives', type: 'salle_fetes', active: true, lat: 45.3564, lon: 5.4781, address: 'Pl. de la Mairie, 38140 Rives', priority: 'standard', info: 'Salle communale.', source: 'https://www.rives.fr' },

  /* ══════════════════════════════════════════════════════
     VOIRON & SUD ISÈRE
  ══════════════════════════════════════════════════════ */

  /* ── Voiron (38500) ── */
  { id: 'h-salle-omnisports-voiron', name: 'Salle Omnisports de Voiron', type: 'salle_omnisports', active: true, lat: 45.3631, lon: 5.5908, address: 'Rue Léon-Blum, 38500 Voiron', priority: 'vital', info: 'Grande salle omnisports, mobilisable pour hébergement massif.', source: 'https://www.ville-voiron.fr' },
  { id: 'h-salle-fetes-voiron', name: 'Salle des Fêtes de Voiron', type: 'salle_fetes', active: true, lat: 45.3659, lon: 5.5914, address: 'Rue Mainssieux, 38500 Voiron', priority: 'standard', info: 'Salle polyvalente du centre-ville.', source: 'https://www.ville-voiron.fr' },

  /* ── Saint-Marcellin (38160) ── */
  { id: 'h-gymnase-saint-marcellin', name: 'Gymnase Municipal Saint-Marcellin', type: 'gymnase', active: true, lat: 45.1513, lon: 5.3236, address: 'Rue du Bief, 38160 Saint-Marcellin', priority: 'vital', info: 'Gymnase mobilisable pour hébergement.', source: 'https://www.saint-marcellin.fr' },
  { id: 'h-salle-fetes-saint-marcellin', name: 'Salle des Fêtes Saint-Marcellin', type: 'salle_fetes', active: true, lat: 45.1522, lon: 5.3224, address: 'Pl. Henri-Dreyfus, 38160 Saint-Marcellin', priority: 'standard', info: 'Salle polyvalente.', source: 'https://www.saint-marcellin.fr' },

  /* ── Villard-de-Lans (38250) ── */
  { id: 'h-complexe-villard-de-lans', name: 'Centre Sportif et Culturel Villard-de-Lans', type: 'complexe_sportif', active: true, lat: 45.0706, lon: 5.5544, address: 'Av. du Bouchet, 38250 Villard-de-Lans', priority: 'vital', info: 'Complexe sportif utilisé pour hébergement en cas d\'évacuation montagne.', source: 'https://www.villarddelans.fr' },
  { id: 'h-gymnase-villard-de-lans', name: 'Gymnase de Villard-de-Lans', type: 'gymnase', active: true, lat: 45.0693, lon: 5.5529, address: 'Chemin du Stade, 38250 Villard-de-Lans', priority: 'standard', info: 'Gymnase communal.', source: 'https://www.villarddelans.fr' },

  /* ── Autrans-Méaudre (38880) ── */
  { id: 'h-salle-sports-autrans', name: 'Salle des Sports d\'Autrans', type: 'gymnase', active: true, lat: 45.1771, lon: 5.5332, address: 'Chemin de la Croix, 38880 Autrans', priority: 'standard', info: 'Gymnase communal de montagne.', source: 'https://www.autrans-meaudre.fr' },

  /* ── Pontcharra (38530) ── */
  { id: 'h-salle-fetes-pontcharra', name: 'Salle des Fêtes de Pontcharra', type: 'salle_fetes', active: true, lat: 45.4313, lon: 6.0194, address: 'Pl. de la Mairie, 38530 Pontcharra', priority: 'standard', info: 'Salle communale polyvalente.', source: 'https://www.pontcharra.fr' },
  { id: 'h-gymnase-pontcharra', name: 'Gymnase Municipal Pontcharra', type: 'gymnase', active: true, lat: 45.4298, lon: 6.0178, address: 'Rue du Stade, 38530 Pontcharra', priority: 'standard', info: 'Gymnase municipal.', source: 'https://www.pontcharra.fr' },

  /* ── Allevard (38580) ── */
  { id: 'h-salle-fetes-allevard', name: 'Salle des Fêtes d\'Allevard', type: 'salle_fetes', active: true, lat: 45.3949, lon: 6.0734, address: 'Rue de la République, 38580 Allevard', priority: 'standard', info: 'Salle communale.', source: 'https://www.allevard.fr' },

  /* ── Goncelin (38570) ── */
  { id: 'h-salle-fetes-goncelin', name: 'Salle des Fêtes de Goncelin', type: 'salle_fetes', active: true, lat: 45.3491, lon: 5.9898, address: 'Pl. du Village, 38570 Goncelin', priority: 'standard', info: 'Salle communale.', source: 'https://www.goncelin.fr' },

  /* ── Bourg-d'Oisans (38520) ── */
  { id: 'h-gymnase-bourg-oisans', name: 'Gymnase de Bourg-d\'Oisans', type: 'gymnase', active: true, lat: 45.0522, lon: 6.0274, address: 'Rue des Alpes, 38520 Bourg-d\'Oisans', priority: 'vital', info: 'Gymnase, point de rassemblement massif pour évacuations alpines.', source: 'https://www.bourgdoisans.fr' },
  { id: 'h-salle-fetes-bourg-oisans', name: 'Salle Communale Bourg-d\'Oisans', type: 'salle_fetes', active: true, lat: 45.0514, lon: 6.0261, address: 'Pl. de la Résistance, 38520 Bourg-d\'Oisans', priority: 'standard', info: 'Salle polyvalente.', source: 'https://www.bourgdoisans.fr' },

  /* ── Corps (38970) ── */
  { id: 'h-salle-fetes-corps', name: 'Salle des Fêtes de Corps', type: 'salle_fetes', active: true, lat: 44.8166, lon: 5.9529, address: 'Pl. du Jeu-de-Boules, 38970 Corps', priority: 'standard', info: 'Salle communale (proximité barrage du Sautet).', source: 'https://www.corps38.fr' },

  /* ── Mens (38710) ── */
  { id: 'h-salle-fetes-mens', name: 'Salle des Fêtes de Mens', type: 'salle_fetes', active: true, lat: 44.8193, lon: 5.7509, address: 'Pl. de la Halle, 38710 Mens', priority: 'standard', info: 'Salle communale du Trièves.', source: 'https://www.mens-en-trieves.fr' },

  /* ── Matheysine / La Mure (38350) ── */
  { id: 'h-gymnase-la-mure', name: 'Gymnase de La Mure', type: 'gymnase', active: true, lat: 44.9009, lon: 5.7915, address: 'Av. du 8-Mai-1945, 38350 La Mure', priority: 'vital', info: 'Gymnase intercommunal Matheysine.', source: 'https://www.pays-matheysine.fr' },
  { id: 'h-salle-fetes-la-mure', name: 'Salle des Fêtes de La Mure', type: 'salle_fetes', active: true, lat: 44.9022, lon: 5.7927, address: 'Pl. Jean-Jaurès, 38350 La Mure', priority: 'standard', info: 'Salle polyvalente.', source: 'https://www.pays-matheysine.fr' },

];
