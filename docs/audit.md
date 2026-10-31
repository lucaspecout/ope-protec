# Journal d'audit

Le journal conserve les 500 derniers événements : connexions et tentatives refusées, déconnexions, créations, modifications, suppressions et exports. Les lectures ordinaires et les requêtes vers des routes inexistantes ne sont pas enregistrées.

Chaque nouvelle action conserve l'identité vérifiée et son contexte au moment de la requête : ID du compte, rôle, commune, origine locale ou LDAP, ressource ciblée, résultat HTTP, durée et navigateur. Le contexte métier est limité à une liste de champs autorisés ; mots de passe, jetons, clés API et contenu libre des rapports ne sont pas copiés.

Les tentatives de connexion refusées affichent l'identifiant saisi sans le présenter comme une identité vérifiée. Les anciens événements ne permettent pas de reconstituer les informations absentes : leur identité historique est signalée comme non documentée.

Les lignes `anonymous` sont masquées par défaut, sans supprimer l'historique. La case « Inclure les requêtes non authentifiées » permet de les consulter. Le CSV suit cette option et contient les événements encore conservés des 30 derniers jours, avec le rôle, la commune, le libellé d'action et le résultat. Les autres filtres de recherche de la page ne restreignent pas cet export.

La correction s'applique après redéploiement du backend et des fichiers web. Aucune migration de base n'est nécessaire ; les nouvelles métadonnées utilisent le champ JSON existant.

Vérifications : `python -m unittest discover -s backend/tests -p test_audit.py` et `node --test tests/audit.test.cjs`.
