# VigiEau — zones et mesures détaillées

Les vues **Services connectés → VigiEau** et **Eau potable** affichent maintenant :

- toutes les zones départementales disponibles, par pages de douze ;
- la répartition entre vigilance, alerte, alerte renforcée et crise ;
- la distinction eaux superficielles, eaux souterraines et eau potable ;
- les noms et codes de zones, périodes et documents officiels fournis ;
- les mesures classées par thème, avec leur description et les publics concernés ;
- des filtres par niveau, ressource et public, ainsi qu'une recherche de zone/code.

Les descriptions sont ajoutées au document à l'ouverture d'une zone. Une seule
requête départementale récupère les données ; aucun appel supplémentaire par zone
ni téléchargement des PDF n'est nécessaire pour construire la vue.

## Source et couverture

Le connecteur utilise la [route départementale officielle pour l'Isère](https://api.vigieau.beta.gouv.fr/api/zones/departement/38),
selon la [documentation OpenAPI](https://api.vigieau.beta.gouv.fr/swagger) et le
[contrat publié par le ministère](https://github.com/MTES-MCT/vigieau-api).

L'ancien collecteur cherchait surtout des noms de champs historiques, alors que
la réponse courante fournit notamment `nom`, `niveauGravite`, `type`, `arrete`
et `usages`. Il perdait ainsi les noms, niveaux, périodes et mesures détaillées.
La troncature à vingt zones côté serveur puis douze côté affichage est supprimée.

Lors du contrôle réel du **21 octobre 2026**, la réponse contenait **55 zones**
et **2 238 entrées d'usage** réparties entre ces zones. Ces nombres évoluent ;
ils ne sont pas des constantes de l'application. Les textes et documents sont
ceux de la source, sans ajout de règle générique aux restrictions d'une zone.

La réponse départementale contrôlée ne fournit pas la liste des communes. La vue
l'indique et renvoie vers VigiEau pour une vérification à l'adresse. Une ressource
influencée est signalée lorsqu'elle est identifiée par le fournisseur.

## Cohérence et défaillances

Une réponse départementale complète et vide retire les anciennes restrictions.
Une erreur, une collecte en cours ou une couverture incomplète ne constitue pas
une confirmation d'absence : les dernières restrictions disponibles restent
identifiées comme non confirmées, avec leur date d'observation d'origine.

Les données anciennes sont signalées, y compris après restauration d'un cache
persistant. La version de cache du connecteur est renouvelée pour remplacer
l'ancien format aplati.

Les aperçus Situation et SITREP indiquent le total réel, même si leur aperçu est
limité à huit zones. Les niveaux de notification suivent les niveaux réels des
zones. Les changements de mesures ou de publics sont pris en compte ; une simple
modification d'URL ou de date de collecte ne constitue pas une nouvelle mesure.

## Vérification

Le connecteur modifié a été exécuté contre l'API officielle : réponse complète,
55 zones, 2 238 usages, 55 liens d'arrêté, en une requête. La réponse normalisée
représente environ 702 Ko, ou 37 Ko compressés en gzip lors du contrôle local.

Les tests automatisés couvrent le schéma officiel, les erreurs et caches anciens,
les résultats vides, les niveaux, la pagination, les filtres, les descriptions
dépliables, les liens et l'échappement HTML, les aperçus et les notifications sans
envoyer de message réel.

Vérification finale : **196 tests Python et 70 tests JavaScript réussis**,
plus **66 contrôles dans Edge** avec la réponse officielle enregistrée, sur des
largeurs réelles de 1 440 et 390 pixels. Les deux vues, filtres, descriptions,
liens et états de défaillance sont contrôlés. Le test navigateur est réutilisable :
`python scripts/smoke_vigieau.py` utilise une fixture locale autonome ; l'option
`--payload chemin/observation.json` permet de contrôler une réponse enregistrée.

Après mise à jour des fichiers sur le serveur, redémarrer l'API avec
`docker compose restart api`, puis recharger la page.
