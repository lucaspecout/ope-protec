# Lieux d’accueil hébergeables en Isère

La carte utilise le [registre officiel Data ES du ministère chargé des Sports](https://equipements.sports.gouv.fr/explore/dataset/data-es/).
L’ancienne adresse du jeu sur `data.education.gouv.fr` ne fournit plus ce service.
Le collecteur est dans `backend/app/hosting_sources.py` ; l’API authentifiée de
l’application reste `/api/hosting/isere/verified`.

## Périmètre et informations

La collecte cible les salles intérieures du département 38 : gymnases, salles
polyvalentes, salles multisports et autres salles sportives adaptées à un premier
repérage. Elle exclut les installations explicitement hors service et les types
spécialisés retenus comme inadaptés, notamment les bassins, patinoires, murs
d’escalade et salles de musculation. Ce registre sportif ne couvre pas tous les
bâtiments communaux susceptibles de servir de lieu d’accueil.

Un point représente un **équipement**, par exemple une salle. Plusieurs équipements
peuvent appartenir à la même **installation** ; leur identifiant et leur nom sont
conservés pour éviter de compter ces salles comme autant de sites indépendants.
Les équipements sans coordonnées utilisables sont comptabilisés séparément.

Les renseignements publiés peuvent comprendre : adresse et commune, surface,
dimensions, type de salle, propriétaire et gestionnaire, activités, sanitaires,
douches, vestiaires, accessibilité détaillée, classement ERP, énergies et date de
mise à jour de la fiche. Chaque point renvoie à sa fiche officielle. Les champs
absents restent non renseignés ; aucun contact ou parking n’est inventé.
Les énergies recensées peuvent concerner le chauffage ou la climatisation :
elles ne suffisent pas à confirmer que le lieu est chauffé.

Le classement ERP et les places de spectateurs ne sont **pas une capacité de
couchage**. Aucune capacité n’est calculée à partir du type de bâtiment ou de sa
surface. Le registre identifie des lieux potentiels : disponibilité, aptitude et
conditions d’ouverture doivent être confirmées avec le gestionnaire. Le champ
`opening_authorization` correspond à l’arrêté d’ouverture au public renseigné
dans Data ES, sans constituer un accord de mobilisation pour une crise.

## Collecte et conservation

Les pages de l’API officielle sont triées par identifiant d’équipement, avec
100 lignes au maximum par page. Le collecteur contrôle le département, la nature
intérieure, le total annoncé et la progression des pages. La collecte est bornée
à 50 pages, 5 000 lignes, 1 Mio par réponse et 60 secondes au total ; une page
peut être retentée une fois après un incident réseau transitoire.

Seules les collectes complètes du schéma 2 sont mises en cache pendant 24 heures,
avec une copie Redis et une copie fichier sur le volume statique. Après une
panne, la dernière bonne collecte conserve sa date et reçoit le statut `stale`.
Sans historique, le statut est `unavailable` et le nombre de lieux est inconnu.
Une réponse vide après échec ne devient jamais une collecte réussie sans lieu.

Une tentative échouée est temporisée pendant 60 secondes pour éviter les appels
répétés. Une collecte déjà en cours peut produire une réponse `pending` invitant
à retenter après 5 secondes. Le bouton **Actualiser les lieux** transmet
`refresh=true` pour demander une nouvelle tentative.
Un verrou local et, lorsque Redis est disponible, un verrou partagé évitent les
collectes simultanées du même inventaire par plusieurs requêtes ou workers.

La limite `limit` borne uniquement les points renvoyés au demandeur. Elle ne
réduit pas la collecte partagée. Une réponse tronquée indique `truncated: true`,
`complete: false`, `total_count` et `returned_count` ; `collection_complete`
précise si la collecte complète sous-jacente a réussi.

`updated_at` et `last_success_at` datent la collecte ; les dates portées par les
points décrivent leurs fiches source et peuvent être plus anciennes.

## Affichage et vérification

La collecte se déclenche à l’ouverture de la carte. Le statut près des filtres
indique les lieux disponibles, les sites distincts et les informations manquantes.
L’option **Conserver les informations non renseignées** maintient ces lieux dans
les résultats lorsqu’un filtre technique est activé. En la décochant, seuls les
renseignements publiés satisfaisant les filtres sont retenus.

Les tests se trouvent dans `backend/tests/test_hosting_sources.py`,
`backend/tests/test_hosting_cache.py` et `tests/hosting.test.cjs`.
`scripts/smoke_hosting.py --offline` vérifie l’interface et la vraie carte Leaflet
sur ordinateur et mobile, avec des données de test locales. Ses bibliothèques
publiques doivent avoir été téléchargées une première fois par le script.
