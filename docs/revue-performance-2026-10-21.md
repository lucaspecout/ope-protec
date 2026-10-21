# Chargement initial — 21 octobre 2026

Cette intervention cible la connexion et le premier affichage. Elle complète la
[revue précédente](revue-performance-2026-10-20.md), sans remplacer les fonctions
de carte, les sources, les droits d'accès ou les actualisations automatiques.

## Problèmes corrigés

| Problème constaté | Correction |
| --- | --- |
| Le rendu des risques lançait la météo hebdomadaire même quand sa page était masquée : géocodage des communes PCS et téléchargement des prévisions concurrençaient le chargement initial. | Ce travail démarre à l'ouverture de la météo, y compris si elle est la page restaurée. |
| L'application reconstruisait la Situation plusieurs fois en appliquant successivement les jeux du même bootstrap. | Les rendus sont regroupés : une seule reconstruction après application des données. La sortie du regroupement reste garantie en cas d'erreur. |
| Une carte déjà initialisée continuait à déclencher ses téléchargements de référentiels et ses rendus en arrière-plan après fermeture. | Les téléchargements et rendus de ressources démarrent lorsque la carte est visible. Les cinq référentiels restent chargés à son ouverture pour conserver les calculs de zone complets. |
| Une rafale de messages temps réel repoussait sans cesse le rendu et pouvait perdre la demande de mise à jour de la carte. | Un rendu est programmé sans repousser son échéance ; les demandes de carte sont conservées pendant la rafale. |
| Le délai limite des requêtes JSON s'arrêtait aux en-têtes. Un corps bloqué pouvait retenir indéfiniment le chargement, tandis que sa place dans la file réseau était déjà libérée. | Le délai et la place dans la file couvrent la lecture du JSON. La requête prioritaire de bootstrap continue de passer devant les téléchargements secondaires. |
| La feuille de police Google pouvait bloquer le premier affichage. Les scripts étaient chargés comme scripts bloquants. | La police se charge sans bloquer l'affichage avec une police système de secours. Les scripts utilisent `defer`, dans leur ordre de dépendance existant. |
| Les mises à jour SSE étaient encodées séparément pour chaque client sur la boucle qui traite les requêtes HTTP. | Chaque message est encodé une fois dans le thread producteur puis partagé. L'encodage initial du flux est également déplacé dans un thread ; une erreur d'encodage n'interrompt pas les notifications. |
| Les copies de snapshots volumineux retenaient le verrou partagé avec les chargements et publications. | La copie utilise une version publiée stable hors du verrou. Les publications continuent de remplacer atomiquement les objets et les lecteurs reçoivent une copie indépendante. |
| Le résumé RNB téléchargeait jusqu'à 10 000 bâtiments pour ne conserver qu'un total et huit exemples. | Une page suffit lorsque le fournisseur annonce son total. La pagination complète reste utilisée par les calculs de zone et lorsque le total fournisseur manque ; les caches de résumé et de zone sont distincts. |

## Mesures reproductibles

`python scripts/benchmark_loading.py` compare l'ancien traitement SSE aux fonctions
courantes, sur 12 000 ressources par source, dix clients et sept répétitions.
Une exécution locale a donné les médianes suivantes :

| Traitement isolé | Avant | Après |
| --- | ---: | ---: |
| Encodage et préparation de la diffusion SSE | 176,25 ms | 14,07 ms |
| Durée de rétention du verrou pendant une lecture de deux sources | 64,86 ms | 0,003 ms |

La copie du snapshot existe toujours après libération du verrou. Le benchmark
utilise des données synthétiques et mesure du travail CPU local ; il ne mesure
pas le temps de connexion ni le chargement complet du serveur déployé.

## Vérifications

- **169 tests Python réussis**, notamment isolation des snapshots, concurrence,
  flux SSE, droits, connecteurs, pagination RNB et test TomTom.
- **55 tests JavaScript réussis**, notamment premier chargement, erreurs réseau,
  corps JSON bloqué, priorité du bootstrap, météo différée, carte et rafales SSE.
- **108 contrôles Edge réussis** sur les pages réelles avec des API locales de
  test : sources officielles et gestion des accès, ordinateur et mobile,
  administrateur et opérateur. Aucune erreur JavaScript non interceptée constatée.
- Syntaxe JavaScript et `git diff --check` valides.

Les tests navigateur utilisent des données de démonstration dans leurs scripts,
sans ajout de données fictives dans l'application. Ils ne remplacent pas une
mesure de bout en bout contre PostgreSQL, Redis et les fournisseurs déployés.

## Application et mesure sur le serveur

Après mise à jour des fichiers, exécuter `docker compose restart api`, puis
recharger la page. Le backend et les fichiers web sont montés depuis le projet
dans la configuration Compose actuelle.

Comparer plusieurs connexions à cache vide puis chaud dans l'onglet Réseau :
durée de `/auth/me` ou `/auth/login`, de `/operations/bootstrap`, en-tête
`Server-Timing`, et temps jusqu'à une Situation utilisable. Vérifier ensuite
l'ouverture de la météo et de la carte, les calculs de zone et les mises à jour
temps réel avec plusieurs utilisateurs.
