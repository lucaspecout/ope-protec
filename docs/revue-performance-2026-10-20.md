# Revue du chargement et du code — 20 octobre 2026

## Diagnostic et corrections

Les chemins ci-dessous peuvent expliquer une attente de plusieurs dizaines de secondes. Le délai de 20 secondes signalé n'a pas été reproduit contre une instance en fonctionnement : les corrections s'appuient sur le code et sur des tests isolés.

| Priorité | Problème constaté | Correction appliquée |
| --- | --- | --- |
| Haute | Le démarrage chargeait le dashboard et les risques, puis attendait le bootstrap. La navigation pouvait déclencher d'autres lectures et des actualisations de fournisseurs. | Une seule lecture initiale prioritaire via `/operations/bootstrap`, sans attendre la file des téléchargements cartographiques. La navigation ne déclenche plus de rafale d'actualisations de fournisseurs. Le scheduler serveur et la reprise ciblée des cols en état `pending` sont conservés. |
| Haute | `refreshAll()` attendait VigiEau avant de retirer l'indicateur de chargement, avec un timeout de 45 secondes et une nouvelle tentative possible. | VigiEau se charge en arrière-plan. L'indicateur est retiré dans un `finally`, y compris si un rendu échoue. |
| Haute | Un bootstrap occupait la session de la requête et ouvrait jusqu'à quatre sessions SQL supplémentaires. Plusieurs utilisateurs pouvaient se partager le pool de six connexions par worker jusqu'au timeout de 30 secondes. | Les lecteurs des routes existantes réutilisent la session de la requête. Les limites de résultats et les restrictions par rôle restent appliquées. |
| Haute | Le verrou Redis sélectionnait un worker pour télécharger un flux, mais les autres conservaient leur ancienne copie en mémoire. Chaque worker sauvegardait aussi sa copie complète, écrasant les résultats des autres. | Persistance atomique par service dans Redis et synchronisation des workers en arrière-plan. Les clients SSE reçoivent les mises à jour quel que soit leur worker. |
| Moyenne | Chaque mise à jour d'un service recopiait et sérialisait l'ensemble des sources, y compris les jeux volumineux FINESS et GeoDAE. | Seul le service modifié est persisté et diffusé. La synchronisation compare de petites révisions avant de télécharger les changements. |
| Moyenne | Le bootstrap appliquait ses données, puis `refreshAll()` appliquait à nouveau les mêmes données. L'état LDAP était aussi attendu au démarrage d'un administrateur. | Une seule application du bootstrap ; l'état LDAP est chargé à l'ouverture de la page utilisateurs. |
| Moyenne | Le chargement des communes attendait aussi leur géocodage et leurs contours cartographiques avant de terminer le bootstrap. | Les données et listes restent appliquées immédiatement ; le rendu des communes sur la carte continue en arrière-plan pendant le chargement initial. Une garde de version empêche un ancien géocodage d'écraser un rendu plus récent. |
| Moyenne | Le dashboard pouvait effectuer un appel réseau Météo-France quand le snapshot était vide. | Un état de synchronisation est renvoyé en attendant le scheduler. Aucun fournisseur n'est appelé par ce chemin de chargement. |
| Moyenne | L'authentification SQL des flux SSE et l'envoi du test Discord s'exécutaient directement dans des routes asynchrones. | Ces opérations s'exécutent dans un thread. La session SQL d'authentification est explicitement fermée avant l'ouverture du flux SSE. |

Le serveur ajoute l'en-tête `Server-Timing: app;dur=…` aux réponses traitées par le middleware. Le champ `perf.backend_duration_ms` du bootstrap couvre maintenant sa construction et sa conversion en objets de réponse ; il exclut l'authentification, l'encodage HTTP final et le transfert réseau.

## Autres défauts corrigés dans la revue

Un compte mairie dont la commune ne pouvait plus être retrouvée pouvait recevoir les dernières entrées départementales de la main courante dans le dashboard. La comparaison SQL à une commune absente sélectionnait les entrées sans commune (`IS NULL`). Le filtre renvoie désormais zéro entrée dans ce cas. La résolution des communes ignore aussi la casse et les espaces entourant le nom, comme la liste des communes du bootstrap.

Les noms, responsables et codes postaux des communes étaient insérés sans échappement dans la liste PCS et les popups de la carte. Ces champs sont désormais échappés dans ce rendu pour empêcher leur interprétation comme HTML.

## Points importants restant à traiter

1. **Signature des connexions et clés de services — haute priorité.** `docker-compose.yml` définit une clé de signature JWT par défaut connue et contient des identifiants de services. Une personne connaissant cette clé peut fabriquer un jeton pour un compte existant. Externaliser ces valeurs et renouveler les secrets exposés. Renouveler la signature invalidera les sessions existantes ; les valeurs déployées n'ont pas été modifiées dans cette intervention.
2. **Persistance des règles de notification — haute priorité.** `_load_notif_rules()` et `_save_notif_rules()` utilisent Redis comme seul stockage, alors que Redis est configuré avec `allkeys-lru`. Une pression mémoire peut supprimer ces règles. Stocker la configuration dans PostgreSQL ou dans un stockage séparé du cache. Changer uniquement la politique Redis sans prévoir les erreurs d'écriture déplacerait le problème.
3. **Fraîcheur du cache — haute priorité.** `_cached_external_payload()` recharge le cache persistant de sept jours quand le cache court expire et lui redonne un TTL court, sans tenter le fournisseur. Les sources sans scheduler forcé, notamment les horaires SNCF et les webcams, peuvent ainsi rester anciennes. Réserver le stockage persistant au secours, conserver la date réelle de la donnée et réactualiser les sources à l'expiration du cache court. Cette modification transversale mérite des tests propres à chaque connecteur.
4. **Téléchargements et délais — priorité moyenne.** Le résumé RNB récupère jusqu'à 10 000 bâtiments pour un total et un échantillon de huit éléments ; réduire cette collecte éviterait d'occuper longtemps un thread du scheduler. Côté navigateur, `fetchWithTimeout()` arrête son délai à la réception des en-têtes, avant la lecture du corps JSON : la lecture complète devrait aussi être bornée.
5. **Découpage du code — amélioration progressive.** `web/script.js`, `main.py` et `services.py` regroupent de nombreux domaines. Extraire progressivement les modules de chargement, les connecteurs externes et les notifications faciliterait les tests et limiterait les régressions. Éviter une réécriture complète pendant la correction des temps de chargement.

## Vérifications et limites

Les tests de régression ne nécessitent ni accès réseau, ni base de production. Les tests Python extraient les fonctions par AST pour éviter les migrations et connexions exécutées lors de l'import de `main.py`. Ils utilisent des doublures de Redis et des dépendances SQL : ils ne remplacent pas un test d'intégration PostgreSQL/Redis/Gunicorn.

Résultat local : 19 tests Python et 11 tests JavaScript réussis, syntaxe Python/JavaScript valide et `git diff --check` sans erreur.

```sh
python -m unittest discover -s backend/tests -p "test_*.py" -v
node --test tests/frontend-performance.test.cjs
node --check web/script.js
```

Docker et les bibliothèques Python applicatives ne sont pas disponibles dans cet environnement de travail. Aucun déploiement ni changement de données de production n'a été effectué.

## Mesure sur l'instance déployée

1. Déployer les fichiers modifiés et redémarrer les workers de l'API. Recharger le navigateur pour obtenir le nouveau JavaScript.
2. Dans l'onglet Réseau du navigateur, vérifier qu'un démarrage réussi effectue une seule lecture `/operations/bootstrap`, sans préchargement successif de `/dashboard` et `/external/isere/risks` ni rafale de POST d'actualisation liée à l'ouverture des panneaux. Un POST ciblé pour reprendre les cols en état `pending` reste possible.
3. Comparer le temps jusqu'à l'affichage utilisable, la durée totale de la requête et l'en-tête `Server-Timing`, sur plusieurs rechargements. Une source externe lente doit laisser l'interface utilisable.
4. Ouvrir plusieurs sessions simultanées. Vérifier l'absence de délai d'attente du pool SQL et la réception des mêmes mises à jour de services dans chaque session. Contrôler aussi la carte et le rôle mairie.

Le premier téléchargement d'un fournisseur après un démarrage sans cache peut toujours prendre du temps. Son résultat arrive ensuite par SSE sans conditionner l'affichage initial.
