# Sources et extraction — Isère (38)

Mise à jour réalisée le **2026-03-25**.

## Sources retenues

1. **FINESS (source principale, officielle)**
   - Dataset: https://www.data.gouv.fr/datasets/finess-extraction-du-fichier-des-etablissements
   - Fichier exploité: `etalab-cs1100502-stock-20260311-0344.csv` (ressource du dataset ci-dessus)

2. **Source complémentaire (consultation terrain / contrôle visuel)**
   - Annuaire Santé: https://annuaire.sante.fr/
   - Annuaire EHPAD Isère (service public): https://www.pour-les-personnes-agees.gouv.fr/annuaire-ehpad-et-comparateur-de-prix-et-restes-a-charge/isere-38

## Fichiers générés

Le script `scripts/extract_isere_healthcare.py` génère:

- `docs/data/isere_chu.csv`
- `docs/data/isere_hopitaux.csv`
- `docs/data/isere_cliniques.csv`
- `docs/data/isere_ehpad.csv`

## Commande de génération

```bash
python scripts/extract_isere_healthcare.py
```

## Résultat de l'extraction (FINESS)

- CHU: 27
- Hôpitaux: 60
- Cliniques: 17
- EHPAD: 93

> Note: la catégorisation est faite par mots-clés (`CHU`, `UNIVERSITAIRE`, `HOPITAL/HOSPITALIER`, `CLINIQUE`, `EHPAD/HEBERGEMENT POUR PERSONNES AGEES`) sur les champs raison sociale + libellés de catégorie FINESS.
