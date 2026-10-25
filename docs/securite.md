# Sécurité et continuité de service

## Mise en service

Depuis la racine du projet :

```bash
python3 scripts/prepare_security_env.py
docker compose up -d --build
```

Le script est réexécutable. Il déplace les valeurs précédemment présentes dans Compose vers `.env`, ignorée par Git, et conserve les accès PostgreSQL et API. Pour une installation entièrement neuve avec une base vide, ajouter `--new-install` afin de générer les secrets initiaux. Sans accès PostgreSQL existant ni cette option, il s'arrête pour éviter de changer involontairement le mot de passe attendu par une base existante. Une clé de session faible est remplacée : les utilisateurs doivent alors se reconnecter avec leur mot de passe habituel. Ne pas remplacer une `.env` existante par `.env.example`.

## Déploiement d'une stack dans Portainer

Une stack récupérée depuis Git ne reçoit pas le fichier `.env` privé conservé sur le poste de travail. Le message `required variable POSTGRES_PASSWORD is missing a value` signifie que les variables de déploiement manquent ; il ne signifie pas que PostgreSQL a changé de mot de passe.

Depuis la copie du projet qui contient les accès conservés, la commande `python scripts/prepare_security_env.py --export-portainer` prépare `.env.portainer` (avec le module `python-dotenv` des dépendances backend). Ce fichier privé, ignoré par Git, contient des valeurs résolues pour l'importeur de variables. Il ne doit pas être publié.

Dans Portainer : **Stacks → la stack concernée → Environment variables → Load variables from .env file**, sélectionner `.env.portainer`, puis mettre à jour la stack. Conserver les autres variables propres au serveur. Vérifier la présence de `POSTGRES_PASSWORD`, `DATABASE_URL` et `SECRET_KEY` ; les accès API conservés sont également inclus. Ne pas ajouter un simple `env_file` au conteneur pour résoudre cette erreur : les variables sont nécessaires lors de l'interpolation du fichier Compose, avant le lancement des services.

Ne pas supprimer le volume PostgreSQL ni utiliser `--new-install` pour une stack qui contient déjà des données.

Le fichier `.env` préparé localement doit être présent sur la machine qui exécute Docker. Ne pas le publier ni le joindre à un ticket. Sauvegarder ensemble `.env`, la base, les documents et `/data/api_credentials.key`, qui permet de déchiffrer les accès API enregistrés. La suppression des secrets du fichier Compose ne les retire pas des anciens commits. S'ils ont été partagés, renouveler les clés auprès des fournisseurs ; un changement de mot de passe PostgreSQL doit être coordonné avec la base existante, une variable Docker seule ne changeant pas celui du volume.

## Sessions et accès

Le navigateur reçoit un cookie de session `HttpOnly`, `SameSite=Lax`, avec `Secure` en HTTPS, et un cookie CSRF distinct. Aucun nouveau jeton d'accès n'est enregistré dans localStorage ou ajouté aux URL des flux SSE. Les requêtes qui modifient les données doivent présenter le jeton CSRF. La déconnexion révoque la session côté serveur ; un changement ou une réinitialisation du mot de passe invalide les sessions précédentes. Les flux en direct réévaluent leurs droits au maximum toutes les cinquante secondes, sans immobiliser une connexion SQL.

La migration des anciens jetons locaux encore valides est limitée à 24 heures à partir de la première migration, avec la même clé de signature. Une clé remplacée impose une nouvelle connexion. Les clients API continuent d'utiliser `POST /auth/login` et l'en-tête `Authorization: Bearer …`. Pour fermer une session API : `POST /auth/logout` avec cet en-tête.

Les tentatives de connexion sont limitées sur cinq minutes : 60 par adresse et 10 par couple adresse/compte. Redis partage ces compteurs entre workers. En cas de panne Redis, un compteur borné par worker conserve une protection locale. La connexion LDAP existante est conservée.

CORS accepte uniquement la même origine par défaut. `CORS_ORIGINS` permet de déclarer des origines supplémentaires ; l'interface déployée utilise ses cookies sur la même origine. Le proxy conserve le port de l'hôte pour que `http://localhost:1182` reste utilisable et remplace l'en-tête d'adresse fourni par le client.

Pour une installation exclusivement HTTPS, définir `SESSION_COOKIE_SECURE=true`. Ne pas l'activer sur une installation HTTP : les navigateurs n'y transmettraient plus les cookies. Le mode automatique reconnaît HTTPS au niveau de l'application ou une origine HTTPS correspondant à l'hôte. TLS et le certificat du point d'entrée public restent à configurer sur l'hébergement ; cette modification ne fournit pas un certificat.

## Documents, sources et disponibilité

Les dépôts sont limités à 15 Mio et aux signatures PDF, PNG et JPEG. Les images sont vérifiées avec Pillow, les noms de stockage sont aléatoires, et un échec d'enregistrement en base retire le fichier créé. Le contrôle de signature PDF ne constitue pas une analyse antivirus. Les droits par rôle et par commune restent appliqués.

Tous les transports HTTPS vérifient le certificat et le nom d'hôte. L'adaptateur TLS 1.2 reste limité aux appels qui l'utilisaient ; la configuration OpenSSL permissive globale a été retirée du conteneur. Une source inaccessible suit les mécanismes existants de cache et de statut d'erreur.

`GET /health` contrôle PostgreSQL et Redis : base indisponible → HTTP 503 ; cache seul indisponible → HTTP 200 avec `status=degraded`, car l'application peut fonctionner sans Redis. Les erreurs publiques ne détaillent pas les requêtes SQL. Les réponses API ne sont pas mises en cache ; les journaux applicatifs ne conservent plus les valeurs des paramètres de requête dans les traces d'audit. Nginx journalise le chemin sans ses paramètres.

Les indicateurs globaux sans mesure exploitable apparaissent en gris. Le score interne est affiché sur 100, sans être présenté comme une probabilité.

## Vérifications

Les tests couvrent les cookies HTTPS, la connexion navigateur et API, CSRF, la révocation, l'expiration, le changement de mot de passe, les anciens jetons, le stockage borné, la migration des secrets, TLS et les états de disponibilité. Les contrôles navigateur locaux couvrent également Géorisques, Sources et services, les communes et l'eau.

Après reconstruction sur l'hôte : vérifier `/health`, se connecter, ouvrir les flux en direct, déposer un document autorisé et se déconnecter. Docker n'étant pas disponible dans l'environnement de travail, la reconstruction et ces vérifications sur le déploiement réel restent à effectuer sur l'hôte.
