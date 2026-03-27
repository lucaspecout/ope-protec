# Plan d'optimisation performance API / backend / DB / Docker

## 1) Diagnostic probable

### Constat architecture actuel
- Stack actuelle: `web` (Nginx) + `api` (FastAPI/Gunicorn) + `db` (PostgreSQL) + `redis`.【F:docker-compose.yml†L1-L72】
- Le backend a déjà un middleware de timing et de concurrence (`active_requests`) mais pas d'export métrique Prometheus natif à ce stade.【F:backend/app/main.py†L310-L332】
- L'agrégation des flux externes est gérée via `ThreadPoolExecutor`, snapshots globaux en mémoire et un thread de refresh périodique.【F:backend/app/main.py†L540-L555】【F:backend/app/main.py†L1066-L1091】
- Le backend utilise Gunicorn (3 workers) et pool SQLAlchemy configurable, ce qui est une bonne base mais nécessite calibration par charge réelle.【F:backend/Dockerfile†L8】【F:backend/app/database.py†L6-L23】【F:backend/app/config.py†L18-L24】

### Risques de performance les plus probables
1. **Contention sur les flux externes**: nombreuses sources I/O + retries + thread pool pouvant saturer CPU/threads lors de pics.
2. **Blocage indirect de requêtes API**: endpoints qui consolident beaucoup d'informations peuvent dépasser p95/p99 visés.
3. **Couche DB potentiellement sous-observée**: pool présent, mais absence de budget strict de latence SQL et de suivi des requêtes lentes dans l'app.
4. **Secrets/runtime non durcis**: token sensible par défaut dans `docker-compose.yml`; impact sécurité + variabilité env/prod.【F:docker-compose.yml†L41-L45】
5. **Redis non figé**: `redis:latest` augmente le risque d'instabilité lors des rebuilds.【F:docker-compose.yml†L19-L23】

---

## 2) Causes possibles

### Backend / API
- Endpoints de consolidation (dashboard, supervision, external risks) avec dépendances multiples externes.
- Timeouts Nginx à 120s (1h pour stream), ce qui peut masquer des lenteurs au lieu de les corriger à la source.【F:web/nginx.conf†L5-L37】
- Sérialisation JSON importante sur payloads volumineux (risques de latence CPU côté Python).

### Base de données
- Multiples accès `count()/order_by().first()` fréquemment appelés (charges répétées possibles sur dashboards).
- Schéma enrichi dynamiquement au startup dans `main.py` (DDL runtime): risque de rallonger les démarrages et créer de l'incertitude en prod lors de scale-out.

### Docker / infra
- `mem_limit` présent, mais pas de `cpus`, pas de réservations explicites ni politique de tuning par service.【F:docker-compose.yml†L5-L63】
- Pas de reverse proxy dédié à la protection contre surcharge (rate-limit/circuit-breaking avancés non présents).

---

## 3) Ce qu'il faut vérifier en priorité (avant toute décision de scaling)

### Mesures indispensables (7 jours mini)
1. **API**
   - p50/p95/p99 latence par endpoint.
   - taux d'erreur 4xx/5xx.
   - taux de timeout amont/aval.
2. **DB**
   - Top N requêtes lentes (`pg_stat_statements`).
   - saturation pool SQLAlchemy (timeouts pool, overflow).
   - locks et durée transaction.
3. **Infra**
   - CPU throttling par conteneur.
   - RSS mémoire + OOM kills.
   - latence réseau sortante vers APIs tierces.
4. **Queue/concurrence**
   - nombre de requêtes inflight côté API (déjà loggé).【F:backend/app/main.py†L312-L332】
   - backlog des tâches externes et fréquence des refresh.

### Seuils décisionnels conseillés
- **Scaler horizontalement** seulement si:
  - CPU API > 70% soutenu et DB saine,
  - p95 reste élevé malgré optimisation SQL + cache,
  - pas de contention lock DB majeure.
- **Ne pas scaler d'abord** si:
  - p95 causé par quelques requêtes SQL lentes,
  - dépendance externe dominante (timeouts externes),
  - contention I/O disque ou locks DB.

---

## 4) Ce qu'il faut corriger dans le code

### A. Réduire la latence API
- Mettre des **budgets de latence** par endpoint (ex: auth 300ms p95, dashboard 800ms p95, external risks 1.5s p95 en cache chaud).
- Implémenter **cache applicatif TTL** ciblé pour endpoints agrégés (clé = endpoint + paramètres).
- Introduire une **déduplication des requêtes concurrentes** (single-flight) pour éviter 20 appels identiques simultanés.

### B. Concurrence intelligente
- Isoler les appels externes dans des workers dédiés + file interne.
- Appliquer un **bulkhead pattern**: une source externe lente ne doit pas dégrader les endpoints locaux critiques.
- Encadrer retries avec **jitter + circuit breaker** (éviter tempêtes de retries).

### C. Timeouts / retries / connexions
- Timeout strict par type d'appel externe (connect, read, total).
- Limiter retries à 1-2 avec backoff exponentiel (déjà amorcé dans services).
- Ajouter stratégie de fallback en cache stale-if-error.

### D. Optimisation sérialisation
- Éviter payloads très larges par défaut; ajouter paramètres `fields`, `include`, pagination stricte.
- Activer compression API conditionnelle déjà aidée par GZip middleware; calibrer taille min (actuellement 800).【F:backend/app/main.py†L258-L260】

### E. Frontend -> backend
- Regrouper les appels UI en un bootstrap endpoint (déjà présent, à renforcer côté cache).【F:backend/app/main.py†L1216-L1244】
- Éviter polling agressif côté frontend (passer en long-poll/SSE ciblé pour flux utiles).

---

## 5) Ce qu'il faut corriger côté base de données

### Priorités DB
1. Activer et exploiter `pg_stat_statements`.
2. Mettre en place un log des requêtes > 250 ms (`log_min_duration_statement`).
3. Revue des index via `EXPLAIN (ANALYZE, BUFFERS)` sur top endpoints.

### Recommandations pratiques
- Réduire les N+1 avec `selectinload/joinedload` sur relations lues en boucle.
- Encadrer les transactions: courtes, ciblées, idempotentes.
- Vérifier correspondance **workers Gunicorn ↔ pool SQL** (éviter sur-allocation).
- Ajouter cache Redis pour objets lus souvent (dashboard snapshot, métadonnées communes).

---

## 6) Ce qu'il faut corriger côté Docker / infrastructure

### Docker Compose (court terme)
- Figer Redis (`redis:7-alpine`) au lieu de `latest`.【F:docker-compose.yml†L19-L23】
- Sortir secrets/tokens du compose vers `.env`/secrets manager.【F:docker-compose.yml†L41-L45】
- Ajouter contraintes CPU (`cpus`) + réservations mémoire.
- Ajouter healthcheck web Nginx (actuellement surtout API/DB/Redis).

### Reverse proxy
- Ajouter:
  - `limit_req` sur routes sensibles,
  - cache GET public court TTL,
  - propagation `X-Request-ID`.

### Moyen/long terme
- Si charge > 2-3 replicas API et besoins d'auto-healing avancés:
  - migrer vers orchestrateur (Kubernetes/Nomad) + HPA.
- Sinon Compose suffit pour mono-hôte maîtrisé avec SLO modestes.

---

## 7) Quand augmenter le nombre de conteneurs

### Réponse claire
- **D'abord optimisation méthode/code/DB**, ensuite scale horizontal.
- Augmenter les conteneurs API est utile si le bottleneck est CPU web/app ou parallélisme de traitement.
- Cela sert peu (voire aggrave) si le vrai problème est:
  - SQL lent/locks,
  - appels externes lents,
  - contention Redis/DB unique.

### Matrice de décision rapide
- p95 élevé + DB basse + CPU API élevé -> **scale API**.
- p95 élevé + DB lente (top SQL > 500ms) -> **optimiser SQL/index avant scale**.
- p95 élevé + erreurs upstream -> **circuit breaker/cache/fallback avant scale**.

---

## 8) Plan d'action priorisé

### Niveau 1: Gains rapides (0-2 semaines)
| Problème | Cause probable | Solution | Gain attendu | Complexité | Priorité |
|---|---|---|---|---|---|
| Variabilité runtime Redis | Tag `latest` | Fixer image Redis versionnée | Stabilité déploiement | Faible | P0 |
| Secrets exposés | Token en compose | Externaliser secrets | Sécurité + cohérence env | Faible | P0 |
| Manque de visibilité SLO | logs non corrélés | Ajouter `request_id`, métriques latence/erreurs | Diagnostic rapide | Faible | P0 |
| Endpoints agrégés lents | appels externes coûteux | Cache TTL 30-120s + stale fallback | -30/-70% latence p95 | Moyen | P0 |
| Saturation ponctuelle | concurrence non bornée | limiter workers externes dynamiquement | stabilité sous charge | Faible | P1 |

### Niveau 2: Optimisations intermédiaires (2-6 semaines)
| Problème | Cause probable | Solution | Gain attendu | Complexité | Priorité |
|---|---|---|---|---|---|
| SQL imprévisible | index incomplets | audit EXPLAIN + index ciblés | -20/-60% latence DB | Moyen | P1 |
| N+1 potentiels | accès ORM relationnels | eager loading ciblé | baisse requêtes DB | Moyen | P1 |
| Latence frontend | appels redondants | batching + cache HTTP + ETag | moins de trafic API | Moyen | P1 |
| Timeouts tardifs | budgets non définis | timeout chainée (nginx->api->outbound) | moins de blocages | Moyen | P1 |

### Niveau 3: Améliorations structurelles (6-16 semaines)
| Problème | Cause probable | Solution | Gain attendu | Complexité | Priorité |
|---|---|---|---|---|---|
| Couplage sync fort | traitements lourds inline | file de jobs async (RQ/Celery) | robustesse forte | Élevée | P2 |
| Scalabilité limitée | mono-DB write/read | read-replicas + partitionnement ciblé | capacité x2-x5 lecture | Élevée | P2 |
| Pilotage perf incomplet | observabilité partielle | OpenTelemetry + APM + alerting SLO | réduction MTTR | Moyen/Élevé | P1 |

---

## 9) Exemples techniques concrets

### Exemple A - budget timeout cohérent
- Nginx read timeout endpoint standard: 15-30s (pas 120s par défaut).
- API timeout métier: 3-8s selon use case.
- Appel externe unitaire: connect 1s / read 2-4s / total 5s.

### Exemple B - cache anti-doublons
- Clé: `external:isere:risks:v1`.
- TTL chaud: 60s.
- `stale_if_error`: 10 min.
- Mutex de régénération (single-flight).

### Exemple C - benchmark avant/après
1. **Baseline**
   - `k6` ou `locust` sur `/dashboard`, `/operations/bootstrap`, `/external/isere/risks`.
2. **Scénarios**
   - charge nominale, pic x3, dégradation API tierce.
3. **KPIs comparés**
   - p95/p99, erreurs, saturation CPU/RAM, temps SQL moyen, taux cache hit.
4. **Critère GO prod**
   - p95 sous SLO 7 jours glissants, error rate < 1%, aucune OOM.

### Métriques à surveiller (minimum viable)
- API: rps, latence p50/p95/p99, 5xx, timeout.
- DB: TPS, top requêtes lentes, lock waits, pool usage.
- Redis: hit ratio, évictions, mémoire.
- Infra: CPU throttling, RSS, I/O wait, redémarrages.
- Métier: temps de chargement dashboard, disponibilité flux critiques.

### Logs/indicateurs à ajouter
- `request_id`, `user_id` (si auth), endpoint, status, duration_ms.
- upstream service, timeout/retry count.
- évènements de circuit-breaker (open/half-open/closed).

