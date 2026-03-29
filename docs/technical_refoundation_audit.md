# Audit technique & refonte de stabilisation (mars 2026)

## 1) Constats précis sur l'existant

### Risques de blocage / instabilité
- **Bootstrap SQL exécuté à l'import Python**: le schéma était modifié dès le chargement du module `main.py`, ce qui mélangeait logique métier et migration technique, avec risque de démarrages lents et concurrents. 
- **Boucles de rafraîchissement externes dupliquées**: avec Gunicorn multi-workers, chaque worker lançait ses propres threads de refresh (polling), multipliant les appels externes et créant des effets de charge en rafale.
- **Absence de garde multi-worker pour les tâches planifiées**: aucune élection de leader n’empêchait le démarrage parallèle des mêmes jobs sur plusieurs workers.
- **Time-outs SQL non forcés côté connexion**: en cas de requêtes lentes, risque de sessions accrochées et d'effet domino sur le pool.

### Dette d’architecture
- Fichier `backend/app/main.py` très volumineux (API + orchestration + bootstrap + scheduling), difficile à maintenir et à tester par module.
- Couplage fort entre démarrage applicatif et logique de supervision externe.
- Les mécanismes de résilience existent (retries HTTP, locks), mais l’orchestration globale restait fragile en mode production multi-process.

## 2) Objectif de la refonte implémentée

Refondre le **socle runtime** sans casser les fonctionnalités métier:
- conserver l’ensemble des endpoints et du comportement fonctionnel,
- fiabiliser le démarrage,
- rendre le refresh externe mono-leader,
- éviter les blocages DB prolongés,
- préparer une architecture plus maintenable.

## 3) Refonte implémentée (v1)

### A. Bootstrap base isolé
- Création d’un module dédié `backend/app/bootstrap.py` qui centralise les statements de bootstrap.
- `main.py` n’exécute plus de gros bloc SQL inline; il appelle explicitement `bootstrap_database_schema(engine)`.
- Bénéfice: lisibilité, testabilité, maintenance plus sûre.

### B. Cycle de vie application (lifespan) + orchestration propre
- Remplacement des hooks `@app.on_event(startup/shutdown)` par un **lifespan FastAPI**.
- Démarrage/arrêt des threads de fond encapsulés dans le lifecycle.
- Arrêt contrôlé de l’executor d’authentification en fermeture.

### C. Élection de leader Redis pour le refresh externe
- Ajout d’un verrou distribué Redis (`SET NX EX`) pour élire un seul worker leader.
- Renouvellement TTL via script Lua (atomicité) tant que le leader vit.
- Libération propre du lock au shutdown.
- Si leadership indisponible: worker passe en mode suiveur (pas de polling).

### D. Protection anti-blocage SQL
- Ajout de `statement_timeout` et `idle_in_transaction_session_timeout` dans `create_engine` (API + auth engine).
- Ajout d’`application_name` PostgreSQL pour observabilité opérationnelle.

## 4) Architecture cible recommandée (phase 2)

Pour aller vers une refonte complète durable:
1. **Découper `main.py` par domaines**: `routers/auth.py`, `routers/operations.py`, `routers/external.py`, `services/*`.
2. **Basculer le scheduling externe dans un worker dédié** (ex: service `scheduler`) au lieu de threads API.
3. **Introduire Alembic** pour migrations versionnées (suppression du bootstrap SQL applicatif à terme).
4. **Ajouter cache explicite Redis par source externe** (TTL par flux), invalidation contrôlée.
5. **Instrumentation**: métriques p95/p99, taux d’erreur par endpoint/source, backlog refresh.
6. **Tests de non-régression**: smoke API + tests de concurrence refresh + tests de charge ciblés.

## 5) Résultat attendu après cette itération

- Démarrage plus robuste.
- Disparition des rafales de polling multi-workers.
- Réduction du risque de connexions SQL pendantes.
- Base plus saine pour poursuivre la refonte métier sans régression.
