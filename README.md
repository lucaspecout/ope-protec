# Protection Civile de l'Isère – Veille Opérationnelle

Application web professionnelle de veille opérationnelle pour la Protection Civile de l'Isère (38).

## Démarrage rapide

```bash
docker compose up -d
```

Ou via script:

```bash
./scripts/install.sh
```

## Architecture

- `web` : interface dashboard corporate (Nginx + HTML/CSS/JS)
- `backend` : API FastAPI (auth, vigilance, vigicrues, main courante, PDF, partage public)
- `db` : PostgreSQL (persistant)
- `redis` : cache / file de tâches (persistant)

## Fonctionnalités livrées

- Vigilance météo département 38, transitions couleur, validation PCS, rétention 3 mois.
- Vigilance crues via stations, gestion commune associée.
- Main courante horodatée/auteur, pièces jointes filtrées par extension.
- Cartographie métier via entités communes, mode crise, partage public temporaire protégé.
- Export PDF institutionnel incluant chronologie.
- Gestion des utilisateurs (max 20), rôles, mot de passe hashé, sessions JWT.

## Volumes persistants

- `postgres_data`
- `redis_data`
- `uploads_data`
- `reports_data`

## Sécurité

- Hash bcrypt des mots de passe
- JWT bearer auth
- Validation minimale des uploads (extensions autorisées)
- Contrôle d'accès API par authentification

## Endpoints principaux

- `POST /auth/register`
- `POST /auth/login`
- `GET /dashboard`
- `POST /weather` + `POST /weather/{id}/validate`
- `POST /municipalities` + `POST /municipalities/{id}/crisis`
- `POST /logs` + `POST /logs/{id}/attachment`
- `GET /reports/pdf`
- `POST /shares/{municipality_id}?password=...`

