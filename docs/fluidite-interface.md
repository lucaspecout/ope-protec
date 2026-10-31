# Fluidité de la navigation

Les changements de page affichent le panneau et le titre immédiatement, puis lancent les activations et chargements dans une tâche suivant la prochaine frame. Des clics rapprochés annulent les activations encore en attente. La carte ne recalcule pas sa taille lorsqu'elle est masquée.

Les pages Situation et Interconnexions ne reconstruisent plus leur contenu quand elles sont masquées. Le catalogue des sources conserve les dernières données sans comparer ni redessiner toutes les cartes en arrière-plan. Le JSON brut des interconnexions est généré à l'ouverture de chaque détail ; les détails ouverts restent ouverts lors des mises à jour.

Les chargements utilisent les données en mémoire avant de relire le cache hors ligne. Les écritures des gros snapshots sont regroupées par clé puis effectuées une par tâche quand le navigateur est disponible, avec un délai maximal d'une seconde. Les entrées de main courante en attente restent sauvegardées immédiatement. Les snapshots restants sont enregistrés à la fermeture de la page.

Les régressions sont couvertes dans `tests/frontend-performance.test.cjs`, `tests/source-explorer.test.cjs` et `tests/anfr.test.cjs`. Les vérifications automatisées ne remplacent pas une mesure des longues tâches dans le navigateur de production, avec son volume réel de données.

Redéployer les fichiers web pour appliquer ces changements ; les versions des scripts ont été modifiées pour renouveler le cache du navigateur.
