# Menu des filtres de la carte

Le menu démarre sur une liste de catégories. Choisir une catégorie affiche ses
options sans reconstruire les contrôles. Le titre et le bouton **Catégories**
restent visibles pendant le défilement. Les changements de filtres, les nouvelles
données et la fermeture du menu conservent la catégorie courante ; chaque
catégorie retrouve sa position de défilement lorsqu’on y revient.

Les catégories suivent cet ordre :

1. **Vue et fond de carte** : fond standard, satellite, relief et population.
2. **Météo et observations** : mesures Météo-France, radar, APIC et imagerie.
3. **Eau et cours d’eau** : Vigicrues, observations ONDE et zones inondables.
4. **Risques et sites sensibles** : ICPE/Seveso, autres repères, séismes et feux.
5. **Ressources et accueil** : communes PCS, commandement, accueil, secours,
   santé et télécommunications.
6. **Déplacements et carburants** : circulation, caméras, transports et stations-service.
7. **Montagne** : cols et zones d’avalanche.
8. **Outils terrain** : analyse de zone, mesure, itinéraire et annotations.
9. **POI et formes** : points et dessins ajoutés à la carte.

Les badges indiquent les couches activées, sans compter les sous-filtres
techniques comme autant de couches. Les catégories d’outils ne portent pas de
compteur de couches. Le fond de carte est compté ; une imagerie désactivée ne
l’est pas.

## Filtres des sources

| Source | Filtres disponibles dans le menu |
| --- | --- |
| Mesures Météo-France | Station ou commune, mesures récentes/anciennes, disponibilité d’une mesure de température, pluie ou rafales. |
| Stations-service | Commune ou adresse, carburant, rupture temporaire déclarée ou prix déclaré sans rupture signalée. |
| ICPE / Seveso | Nom ou commune, Seveso seuil haut, seuil bas ou autres ICPE non Seveso. |
| ONDE | Commune, station ou cours d’eau, assec, écoulement non visible ou visible. |

Les filtres carburants, industriels et ONDE sont synchronisés dans les deux sens
avec les contrôles de **Sources officielles**. Ils filtrent les mêmes données
pour les marqueurs et les tableaux. Les filtres Météo-France s’appliquent aux
stations et à leurs tableaux de mesures ; les graphiques d’historique gardent
leurs sélecteurs de station et de variable.

Un zéro mesuré reste une valeur. Une mesure sans date n’est classée ni récente
ni ancienne. Les observations ONDE gardent leur date de campagne et les ruptures
de carburants restent des déclarations, sans garantie de stock. Les compteurs
distinguent les résultats et les points disposant de coordonnées.

**Réinitialiser** remet les critères et les couches à leurs valeurs initiales,
dans le menu comme dans les tableaux, en conservant la catégorie ouverte.

## Zones inondables détaillées

Dans **Eau et cours d’eau**, ce filtre superpose deux sources WMS publiques :

| Données | Service | Couche | Zoom minimal |
| --- | --- | --- | --- |
| Surfaces inondables TRI, rapportage 2020 | [Géorisques](https://www.georisques.gouv.fr/services?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0) | `ALEA_SYNT_01_01FOR_FXX`, `ALEA_SYNT_01_02MOY_FXX`, `ALEA_SYNT_01_04FAI_FXX` | 11 |
| Zonage réglementaire PPR inondation | [BRGM / Géorisques](https://mapsref.brgm.fr/wxs/georisques/risques?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0) | `PPRN_ZONE_INOND` | 13 |

Vérification le 21 octobre 2026 : le service `www.georisques.gouv.fr/services`
ne propose pas `PPRN_ZONE_INOND` et renvoie une exception XML `LayerNotDefined`
même avec un statut HTTP 200. Le service BRGM fournit cette couche en PNG.
Les zooms minimaux respectent les échelles maximales annoncées dans les
capacités WMS : 1:500 000 pour les TRI et 1:100 000 pour les PPR, avec les
tuiles Web Mercator de 256 pixels utilisées par la carte.

À l’échelle du département, le menu invite à zoomer. Les images ne sont
demandées qu’une fois leur échelle d’affichage atteinte, sans téléchargement
à la connexion. Une image transparente chargée ne signifie pas que le secteur
est exempt de risque : l’affichage dépend des données publiées par ces sources.

Le statut distingue le chargement, les images chargées, l’échec partiel et
l’indisponibilité. La fin d’un chargement Leaflet ne suffit pas à déclarer un
succès si des tuiles ont échoué. **Réessayer le zonage** recrée les deux couches ;
une erreur sur une source laisse les images de l’autre affichées.
Décocher le filtre ou réinitialiser enlève les deux couches et leur suivi.

`tests/map-flood.test.cjs` vérifie les adresses, les transitions de statut,
les événements tardifs et le nettoyage. `scripts/smoke_flood.py --offline`
teste les vraies couches Leaflet avec des images locales, y compris les pannes
et la reprise, aux largeurs 1440 et 390 pixels. L’option `--live --width 390`
autorise uniquement les deux hôtes WMS pour vérifier leurs images réelles ;
les API de l’application restent simulées localement. `--tile chemin.png`
permet de réutiliser une image WMS enregistrée comme fixture.

## Accessibilité et chargement

Les catégories utilisent des boutons nommés, accessibles au clavier. Les
flèches haut/bas, Début et Fin parcourent la liste. **Échap** revient aux
catégories depuis leurs options ; le sélecteur natif conserve son comportement
habituel. Le focus revient au bouton de la catégorie quittée.

Les filtres utilisent les données déjà reçues. Ils ne lancent aucune collecte
supplémentaire à la connexion et ne reconstruisent que les couches concernées.
Le menu garde un seul défilement, avec des champs adaptés aux écrans tactiles.
Les sections natives restent disponibles si l’amélioration de navigation ne
peut pas s’initialiser.

Les tests sont dans `tests/map-filters.test.cjs`,
`tests/map-source-filters.test.cjs` et `tests/map-webcams.test.cjs`.
Le scénario `scripts/smoke_map_filters.py --offline` vérifie la navigation, les
marqueurs Leaflet, les tableaux et la réinitialisation sur ordinateur et mobile.
Les bibliothèques du navigateur doivent avoir été préparées une première fois
par le scénario de carte.
