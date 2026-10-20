# Sources officielles A à F

Les nouvelles données stations-service, ONDE, CatNat, électricité régionale et RappelConso sont documentées dans le [guide des données publiques supplémentaires](sources_publiques.md).

Les six sources sont raccordées au collecteur en arrière-plan, au snapshot partagé Redis et au flux SSE existants. La page **Sources officielles** regroupe leurs dates, leurs états et les données détaillées. Les pages **Météo**, **Services connectés**, **Interconnexions API** et la carte utilisent les mêmes résultats ; elles ne relancent pas une collecte au chargement.

## Données et vues

| Source | Intégration | Actualisation prévue |
| --- | --- | --- |
| A — INSEE Filosofi 2021 | Import régional des carreaux de 200 m ; population, ménages et classes d'âge dans l'analyse de zone ; méthode et couverture conservées dans le rapport exporté. | Vérification hebdomadaire ; premier import en arrière-plan. |
| B — Observations Météo-France | Stations de l'Isère, températures, pluie sur six minutes, rafales ; table, graphique et couche cartographique. | Six minutes, jusqu'à 40 stations par collecte. |
| C — Prévisions Vigicrues | Courbes de hauteur et débit, bornes publiées, dates d'émission et d'échéance ; sélection par station. | Deux minutes ; collecte limitée aux simulations réellement publiées pour les stations déjà suivies. |
| D — Radar Météo-France | Image de pluie sur cinq minutes reprojetée pour la carte ; légende, curseur temporel et animation. | Cinq minutes ; douze images locales au maximum sur une heure. |
| E — Géorisques ICPE / Seveso | Référentiel départemental officiel, filtre par commune/nom/classement, couche carte et établissements dans l'analyse de zone. | Quotidienne. |
| F — Enedis | Accès au diagnostic officiel à l'adresse, au portail Collectivités et aux informations de dépannage. | Le statut précise qu'aucun flux privé de coupures n'est connecté. |

## Activer les accès et déployer

INSEE, ICPE et les prévisions Vigicrues ne nécessitent pas de nouvelle clé. Les collecteurs ont besoin d'un accès sortant HTTPS aux producteurs officiels. L'import initial INSEE télécharge environ 92 Mo puis conserve seulement le cache régional, d'environ 6 Mo. Ce téléchargement ne bloque pas le bootstrap ni les analyses : tant que l'import n'est pas prêt, l'estimation surfacique précédente reste affichée avec sa méthode.

Les administrateurs peuvent renseigner les accès dans **Interconnexions API → Accès aux services**. Les formulaires couvrent Météo-France (observations et radar), Géorisques v2, NASA FIRMS et TomTom. Le catalogue et les opérations d’enregistrement, de suppression et de test sont protégés côté API par le rôle administrateur ; les autres utilisateurs ne voient pas ces formulaires.

Le bouton **Tester la connexion** contacte le fournisseur avec les valeurs saisies et les accès actuels pour les champs vides, sans rien enregistrer. Météo-France renvoie un résultat distinct pour Observations et Radar. Les tests distinguent les accès manquants/refusés et les réponses invalides ; ils signalent également les indisponibilités réseau ou liées aux quotas. Un test consomme des requêtes du quota fournisseur, en particulier un court calcul de trajet pour TomTom. Les erreurs ne contiennent ni clé ni réponse brute du fournisseur.

**Enregistrer les accès** applique les nouvelles valeurs et relance les collectes concernées en arrière-plan, sans redémarrage. Un champ vide conserve l’accès actuel. Pour retirer une valeur saisie, cocher **Effacer la valeur enregistrée** puis enregistrer : la configuration serveur redevient prioritaire pour ce champ, si elle existe. Les valeurs saisies sont prioritaires sur les variables d’environnement correspondantes ; les clés Météo-France propres à chaque produit restent prioritaires sur la clé commune. Le jeton Bearer sert en l’absence de clé API.

Les secrets sont chiffrés dans la table `app_settings`, sans cache Redis ni stockage navigateur. La clé de chiffrement est générée à la première sauvegarde dans `/data/api_credentials.key` (variable `API_CREDENTIALS_KEY_PATH`), sur le volume persistant `app_data`, hors des fichiers web. **Sauvegarder cette clé avec la base de données**, et conserver les mêmes fichiers privés pour tous les processus/conteneurs de l’API. En cas de clé perdue ou altérée, les valeurs enregistrées ne sont plus utilisables ; restaurer la clé depuis une sauvegarde ou supprimer explicitement les accès concernés avant de les saisir à nouveau. Une clé existante n’est jamais remplacée automatiquement. Les valeurs restent masquées à la réouverture de la page et les champs sont vidés après enregistrement ou déconnexion.

Pour B et D, créer un compte sur le [portail API Météo-France](https://portail-api.meteofrance.fr/), souscrire aux produits Observations et Radar, puis saisir les accès dans cette page. Il reste aussi possible de renseigner la clé dans le fichier `.env` à côté de `docker-compose.yml` :

```env
METEO_FRANCE_API_KEY=votre_cle_application
```

Si les souscriptions ont des clés différentes :

```env
METEO_FRANCE_OBSERVATIONS_API_KEY=cle_observations
METEO_FRANCE_RADAR_API_KEY=cle_radar
```

Les valeurs restent côté serveur dans les en-têtes HTTP. Elles ne sont jamais ajoutées aux URL des images ni aux snapshots envoyés au navigateur. `.env` est ignoré par Git ; [.env.example](../.env.example) contient uniquement des valeurs vides. Un jeton Bearer temporaire peut aussi être fourni avec `METEO_FRANCE_ACCESS_TOKEN` ; il nécessite un renouvellement à son expiration.

Reconstruire l'API pour installer les dépendances géographiques et radar, puis recharger le navigateur :

```sh
docker compose up -d --build api web
```

Sans clé, B et D affichent **Accès à configurer**, sans mesure inventée. Un accès refusé affiche un diagnostic distinct d'une indisponibilité réseau. Les prévisions météo habituelles restent disponibles.

Pour Enedis, aucun compte Collectivités ni contrat partenaire n'est actuellement fourni. Le diagnostic public fonctionne via son lien officiel ; aucune API de coupures non documentée n'a été simulée. Un futur suivi automatique des coupures devra être développé à partir du service et des droits effectivement accordés par Enedis.

## Utilisation

- **Sources officielles** : consulter les stations, changer la grandeur du graphique, choisir une station hydrologique et rechercher les établissements industriels. Les boutons d'actualisation demandent une collecte en arrière-plan.
- **Carte Isère → Alertes et surveillance** : activer les stations officielles, le radar ou les ICPE. Le curseur radar choisit une image collectée et le bouton de lecture lance l'animation. Les PNG sont obtenus avec l'authentification existante, sans jeton dans l'URL.
- **Analyse de zone** : tracer un polygone. Le total utilise le carroyage si la zone est entièrement couverte ; sinon le rapport indique la limite et conserve la méthode surfacique pour le total. Les nouveaux établissements officiels participent à la liste des risques industriels.

## Limites des données

Le carroyage décrit les résidents des ménages fiscaux en **2021**, avec des données partiellement imputées. Il ne mesure pas les personnes présentes actuellement et ne couvre pas tous les hébergements collectifs. Les surfaces de chaque carreau intersectées par la zone sont pondérées dans la projection officielle EPSG:3035 ; les trous des polygones sont retirés. Les personnes de 80 ans et plus sont déjà incluses dans les 65 ans et plus.

Vigicrues ne publie pas des prévisions chiffrées pour toutes les stations en permanence. L'interface distingue une absence de prévision publiée, une courbe expirée et une défaillance du service. Ces courbes ne sont pas transformées en une emprise d'inondation simulée.

L'API radar ciblée fournit la dernière image. L'animation se constitue progressivement au fil des collectes, sans prétendre fournir un historique antérieur à leur démarrage. Les zones sans mesure utilisable apparaissent en gris, distinctement des zones sans précipitation. Les établissements ICPE constituent un référentiel réglementaire, pas un flux d'incidents.

## Validation

Les fichiers officiels complets INSEE et ICPE ont été téléchargés puis traités par les fonctions de production : 133 271 carreaux dans l'enveloppe régionale, 1 847 établissements localisés, dont 38 Seveso seuil haut et 20 seuil bas au moment du contrôle. Les catalogues et un détail de prévision Vigicrues ont aussi été vérifiés sur le service officiel. Ces chiffres sont un contrôle daté du 20 octobre 2026, pas des constantes de l'application.

Les tests comprennent les intersections géographiques réelles, les matrices HDF5 et les PNG radar, les dates/unités, les erreurs d'authentification, les contrats HTTP FastAPI et les interactions JavaScript. Un test Edge invisible charge la vraie page avec une API locale de test ; ses données de démonstration sont limitées au script de test, sans ajout dans l'application.

Résultat de la vérification après ajout des accès administrateur : **131 tests Python et 27 tests JavaScript réussis**, plus **56 contrôles Edge** sur les formulaires avec les rôles administrateur/opérateur, sur ordinateur et écran mobile. Les tests comprennent le chiffrement réel avec une base SQLite isolée, les refus d’accès, la mise à jour des clés entre sessions, la sauvegarde pendant une collecte et les erreurs des fournisseurs. Le verrou de fusion des modifications cible PostgreSQL en production ; son utilisation est vérifiée sans ouvrir de connexion de production.

```sh
python -m unittest discover -s backend/tests -p "test_*.py" -v
node --test tests/frontend-performance.test.cjs tests/official-sources.test.cjs tests/api-credentials.test.cjs
python scripts/smoke_official_sources.py --browser "/chemin/vers/chrome-ou-edge"
python scripts/smoke_api_credentials.py --browser "/chemin/vers/chrome-ou-edge"
```

Le flux réel Météo-France ne peut pas être validé sans clé et souscriptions. Les traitements radar sont testés avec de vrais fichiers HDF5 générés pour les tests. Aucun déploiement ni aucune donnée de production n'a été modifié.

## Documentation des producteurs

- [INSEE — carreaux de 200 m](https://www.insee.fr/fr/statistiques/8735162)
- [Météo-France — observations](https://www.data.gouv.fr/dataservices/api-donnees-dobservation) et [radar](https://www.data.gouv.fr/dataservices/api-donnees-radar)
- [Vigicrues — API des prévisions](https://www.vigicrues.gouv.fr/services/v1.1)
- [Géorisques — installations industrielles](https://www.georisques.gouv.fr/donnees/bases-de-donnees/installations-industrielles)
- [Enedis — diagnostic des coupures](https://www.enedis.fr/panne-et-interruption)
