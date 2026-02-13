# Protection Civile de l'Isère – Veille Opérationnelle

Application web de veille opérationnelle (conteneur web unique, sans backend séparé).

## Démarrage rapide

```bash
docker compose up -d
```

Ou via script:

```bash
./scripts/install.sh
```

Application disponible sur `http://localhost:1182`.

## Authentification par défaut

- Utilisateur initial : `admin`
- Mot de passe initial : `admin`
- Le changement du mot de passe est obligatoire à la première connexion.

## Architecture

- `web` : interface dashboard (Nginx + HTML/CSS/JS)
- Données applicatives stockées dans le navigateur (`localStorage`)

## Fonctionnalités livrées

- Connexion locale et changement de mot de passe obligatoire au premier login.
- Dashboard synthétique (vigilance, crues, risque global, communes en crise, derniers événements).
- Gestion des communes (ajout + bascule mode crise).
- Main courante locale (ajout d’évènements horodatés).
- Carte opérationnelle embarquée (OpenStreetMap).
