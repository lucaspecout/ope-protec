# Données publiques supplémentaires — A, B, C, E et F

Les cinq sources sont collectées en arrière-plan, partagées entre les processus de l’API via le mécanisme Redis existant et diffusées par SSE. Elles apparaissent dans **Sources officielles**, **Services connectés** et **Interconnexions API**. Les stations-service et les relevés ONDE disposent également de couches sur la carte. Aucune nouvelle clé ni inscription n’est requise pour ces flux publics.

| Données | Actualisation de l’application | Utilisation |
| --- | --- | --- |
| A — Stations-service | Toutes les 10 minutes | Recherche par commune/adresse, carburant et rupture temporaire ; prix et dates, horaires déclarés, services et localisation. |
| B — Observations ONDE | Toutes les 6 heures | Dernier relevé de chaque station sur les 400 derniers jours ; recherche, filtre sur l’écoulement et carte. |
| C — Historique CatNat | Quotidienne | Publications récentes du département et historique complet collecté pour la commune sélectionnée. |
| E — RTE éCO2mix | Horaire | Derniers créneaux renseignés d’Auvergne-Rhône-Alpes, consommation et six filières de production, en MW. |
| F — RappelConso | Horaire | Publications des 90 derniers jours, recherche produit/marque/distributeur, zone déclarée et procédure en cours ou terminée. |

Le bouton **Actualiser** demande une collecte en arrière-plan. L’ouverture d’une page lit le snapshot ; elle ne télécharge pas les données chez le fournisseur. La première collecte peut donc encore apparaître en attente pendant quelques instants après le démarrage.

## Sources et interprétation

- **Carburants** : [jeu officiel du ministère de l’Économie](https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/) et [documentation gouvernementale](https://www.prix-carburants.gouv.fr/rubrique/opendata/). L’API est filtrée sur `code_departement='38'`. Les coordonnées entières historiques sont converties si le point géographique est absent. Un prix absent reste inconnu ; un prix daté de plus de sept jours est signalé comme ancien. Une rupture définitive est présentée comme un arrêt de distribution, distinct d’une rupture temporaire. Les informations sont déclaratives : un prix renseigné et une absence de rupture ne garantissent pas le stock ni l’ouverture. L’indication 24 h/24 concerne l’automate.
- **ONDE** : [OFB / API Hub’Eau écoulement](https://www.data.gouv.fr/dataservices/hubeau-ecoulement-des-cours-deau). Le filtre départemental et la fenêtre de 400 jours bornent les téléchargements. L’application conserve le dernier relevé daté de chaque station, sans interpoler. Les observations de campagne, principalement estivales, ne représentent pas l’état instantané d’un cours d’eau. La date reste visible sur la carte et dans le tableau.
- **CatNat** : [API Géorisques v1](https://www.georisques.gouv.fr/doc-api), `/api/v1/gaspar/catnat`. Les codes INSEE actuels proviennent de [l’API Découpage administratif](https://geo.api.gouv.fr/). Le fournisseur autorise dix codes au maximum par requête : la collecte respecte cette limite et pagine avec des URL HTTPS fixes, sans suivre ses liens `next` qui peuvent pointer vers un hôte HTTP interne. Les communes en échec conservent leurs éventuelles données antérieures et sont signalées comme non vérifiées. Le nombre affiché compte des couples commune/arrêté et non des catastrophes distinctes. Les anciennes communes fusionnées peuvent nécessiter une recherche spécifique chez le fournisseur. Aucun niveau d’alerte actuel n’est déduit de cet historique.
- **Électricité** : [RTE éCO2mix régional](https://www.rte-france.com/donnees-publications/eco2mix-donnees-temps-reel/donnees-regionales), jeu `eco2mix-regional-tr` sur ODRÉ, région INSEE `84`. Les créneaux futurs, vides ou sans consommation renseignée sont exclus. Zéro est conservé comme une véritable valeur ; une production absente reste inconnue. Les six filières affichées sont nucléaire, hydraulique, thermique, éolien, solaire et bioénergies. Les puissances sont exprimées en MW, avec la date de mesure. Une mesure de plus de trois heures est signalée comme ancienne. Ces données régionales incluent des estimations et ne renseignent pas les coupures locales.
- **Rappels** : [RappelConso V2, GTIN espacés](https://data.economie.gouv.fr/explore/dataset/rappelconso-v2-gtin-espaces/). Les versions d’une même fiche sont dédoublonnées. La vue initiale retient les zones déclarées France entière, Auvergne-Rhône-Alpes ou Isère, avec une procédure non terminée ou une échéance inconnue. Le filtre **Autres zones / portée à vérifier** conserve les publications dont le texte libre ne permet pas ce classement, y compris les autres territoires et les listes de magasins jointes. Ce filtrage ne certifie pas la présence du produit en Isère. Les détails reprennent les références, lots, motifs et consignes publiés, avec un lien vers la fiche officielle. La couverture est celle du jeu V2 publié ; certaines fiches sans GTIN peuvent manquer.

## Performance et disponibilité

Les collecteurs se trouvent dans `backend/app/public_sources.py`, sans dépendance à la base de données. Les requêtes utilisent des hôtes fixes, TLS, une pagination et des volumes bornés ; les réponses gzip sont décompressées avec une limite de taille. Les redirections vers un autre hôte sont refusées. CatNat utilise trois téléchargements simultanés au maximum et une durée de collecte bornée. Les erreurs envoyées à l’interface restent génériques, sans corps d’erreur du fournisseur.

Le cache local est conservé sous `/data/static/public_sources` dans le volume existant. Une indisponibilité conserve le dernier résultat avec un statut ancien et sa dernière date de collecte réussie. Au premier échec sans historique, aucun zéro ni mesure n’est fabriqué. Une réponse incomplète ou plafonnée est signalée.

Le snapshot CatNat contient seulement un aperçu de 150 reconnaissances et le résumé par commune. L’historique complet est lu dans le cache local via `GET /api/catnat/isere/history?code_insee=38185`. Les longues listes de lots et consignes RappelConso sont également conservées hors du bootstrap, puis lues via `GET /api/recalls/{id}` à l’ouverture d’une fiche. Ces routes sont authentifiées, valident les identifiants et ne contactent aucun fournisseur. Les tables affichent progressivement leurs résultats ; les couches cartographiques sont mises à jour uniquement lorsque leurs données ou leurs filtres changent.

## Validation du 20 octobre 2026

Les fonctions de production ont été exécutées sur les flux officiels, sans accès à la base de production :

- 190 stations-service de l’Isère ;
- 41 stations ONDE disposant d’une observation dans la fenêtre retenue, dernière campagne datée du 25 septembre 2026 ;
- 3 461 reconnaissances CatNat pour les 512 communes actuelles, avec couverture de collecte complète ;
- dernières puissances électriques régionales renseignées, avec exclusion des créneaux futurs sans mesure ;
- 905 publications RappelConso sur les 90 derniers jours, avant filtrage par zone et échéance.

Ces nombres sont un contrôle daté et ne sont pas inscrits dans l’application. Les exemples du navigateur restent limités au serveur de test.

La suite complète passe avec **153 tests Python et 37 tests JavaScript**. Les scénarios Edge des sources passent **26 contrôles sur ordinateur et 26 sur mobile**, et les 56 contrôles de configuration API administrateur/opérateur restent valides. Au contrôle réel, les cinq snapshots supplémentaires occupent environ 804 ko en JSON et 89 ko compressés en gzip, hors historique CatNat complet et détails RappelConso chargés à la demande. Cette mesure concerne seulement ces cinq sources, pas la taille totale du bootstrap ni un délai garanti sur l’instance déployée.

Les tests couvrent les champs des producteurs, la pagination, les dates françaises, les absences de mesure, les valeurs nulles/zéro, le cache ancien, la couverture partielle, les identifiants et autorisations HTTP, les réponses compressées, l’échappement HTML, les filtres, les couches de carte et les réponses reçues après déconnexion. Les scénarios Edge chargent la vraie page sur un serveur local et bloquent les domaines externes.

```sh
python -m unittest discover -s backend/tests -p "test_*.py"
node --test tests/frontend-performance.test.cjs tests/official-sources.test.cjs tests/api-credentials.test.cjs tests/public-sources.test.cjs
python scripts/smoke_official_sources.py
python scripts/smoke_official_sources.py --width 390 --height 844
```

Pour charger la nouvelle version du serveur et des fichiers web :

```sh
docker compose up -d --build api web
```

Aucun changement des dépendances Python, des tables SQL ou des accès API n’est nécessaire. Aucun déploiement n’a été effectué par ces vérifications.
