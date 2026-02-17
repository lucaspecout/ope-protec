# Sources de données Vigicrues – Isère / Territoire Alpes du Nord

## 1) API officielle Vigicrues (publique, sans clé)
Base documentation: `https://www.vigicrues.gouv.fr/services/v1.1`

### a) Territoires de vigilance
- Liste des territoires:
  - `https://www.vigicrues.gouv.fr/services/v1.1/TerEntVigiCru.json`
- Le territoire **Alpes du Nord** est identifié avec:
  - `CdEntVigiCru=19`
  - `TypEntVigiCru=5`

### b) Tronçons du territoire Alpes du Nord
- `https://www.vigicrues.gouv.fr/services/v1.1/TronEntVigiCru.json?CdEntVigiCru=19&TypEntVigiCru=5`
- Exemples de tronçons renvoyés: `AN11 Isère moyenne`, `AN12 Isère grenobloise`, `AN20 Isère aval`, etc.

### c) Stations de vigilance (référentiel)
- Toutes les stations:
  - `https://www.vigicrues.gouv.fr/services/v1.1/StaEntVigiCru.json`
- Détail d’une station (exemple Grenoble Bastille):
  - `https://www.vigicrues.gouv.fr/services/v1.1/StaEntVigiCru.json?CdEntVigiCru=W141001001&TypEntVigiCru=7`
  - Dans la réponse: `CdCommune=38185` (commune de Grenoble, Isère).

### d) Données temps réel (observations)
- Observations JSON d’une station:
  - `https://www.vigicrues.gouv.fr/services/observations.json?CdStationHydro=W141001001&FormatDate=iso`
- Observations JSON en débit:
  - `https://www.vigicrues.gouv.fr/services/observations.json?CdStationHydro=W141001001&FormatDate=iso&GrdSerie=Q`
- Observations XML (utile comme "flux" machine-to-machine):
  - `https://www.vigicrues.gouv.fr/services/observations.xml?CdStationHydro=W141001001&FormatDate=iso`

## 2) RSS
Je n’ai pas trouvé de flux RSS public direct stable du type `/rss` sur Vigicrues lors de la vérification (404 sur `/rss`).

👉 En pratique, l’endpoint `observations.xml` peut être utilisé comme alternative de syndication (polling régulier) si tu voulais un usage de type RSS.

## 3) Source complémentaire (Hub’Eau)
- API hydrométrie nationale (souvent utile pour filtrer par département `38`):
  - `https://hubeau.eaufrance.fr/api/v1/hydrometrie/referentiel/stations?code_departement=38`
  - `https://hubeau.eaufrance.fr/api/v1/hydrometrie/observations_tr?code_departement=38`

Note: depuis cet environnement d’exécution, ces endpoints Hub’Eau répondent `403 Forbidden`, mais ils restent des endpoints publics documentés côté Hub’Eau.
