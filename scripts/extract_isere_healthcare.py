#!/usr/bin/env python3
"""Extrait des établissements de l'Isère (38) depuis FINESS.

Génère:
- docs/data/isere_chu.csv
- docs/data/isere_hopitaux.csv
- docs/data/isere_cliniques.csv
- docs/data/isere_ehpad.csv
"""

from __future__ import annotations

import csv
import io
import pathlib
import urllib.request
from typing import Iterable

FINESS_URL = (
    "https://static.data.gouv.fr/resources/"
    "finess-extraction-du-fichier-des-etablissements/"
    "20260312-094813/etalab-cs1100502-stock-20260311-0344.csv"
)

OUT_DIR = pathlib.Path("docs/data")
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Colonnes utiles du flux FINESS structureet
IDX = {
    "finess": 1,
    "raison_sociale": 3,
    "raison_sociale_longue": 4,
    "num_voie": 7,
    "type_voie": 8,
    "voie": 9,
    "comp_voie": 10,
    "bp": 11,
    "code_postal": 15,
    "telephone": 16,
    "categetab": 18,
    "libcategetab": 19,
    "categagretab": 20,
    "libcategagretab": 21,
    "siret": 22,
    "code_ape": 23,
    "date_ouverture": 28,
    "date_maj": 30,
}

OUTPUT_FIELDS = [
    "finess",
    "raison_sociale",
    "raison_sociale_longue",
    "libcategetab",
    "libcategagretab",
    "code_ape",
    "siret",
    "adresse",
    "telephone",
    "date_ouverture",
    "date_maj",
]


def normalize(text: str) -> str:
    return (text or "").upper().replace("Ã", "A")


def make_adresse(row: list[str]) -> str:
    parts = [
        row[IDX["num_voie"]],
        row[IDX["type_voie"]],
        row[IDX["voie"]],
        row[IDX["comp_voie"]],
        row[IDX["bp"]],
        row[IDX["code_postal"]],
    ]
    return " ".join(p for p in parts if p).strip()


def read_isere_rows() -> Iterable[list[str]]:
    with urllib.request.urlopen(FINESS_URL, timeout=120) as response:
        blob = response.read()
    try:
        raw = blob.decode("utf-8")
    except UnicodeDecodeError:
        raw = blob.decode("latin-1")

    reader = csv.reader(io.StringIO(raw), delimiter=";")
    next(reader, None)  # ligne metadata

    for row in reader:
        if len(row) < 31:
            continue
        if row[0] != "structureet":
            continue
        if row[13] != "38":
            continue
        yield row


def row_text(row: list[str]) -> str:
    return " ".join(
        [
            normalize(row[IDX["raison_sociale"]]),
            normalize(row[IDX["raison_sociale_longue"]]),
            normalize(row[IDX["libcategetab"]]),
            normalize(row[IDX["libcategagretab"]]),
        ]
    )


def to_output_row(row: list[str]) -> dict[str, str]:
    return {
        "finess": row[IDX["finess"]],
        "raison_sociale": row[IDX["raison_sociale"]],
        "raison_sociale_longue": row[IDX["raison_sociale_longue"]],
        "libcategetab": row[IDX["libcategetab"]],
        "libcategagretab": row[IDX["libcategagretab"]],
        "code_ape": row[IDX["code_ape"]],
        "siret": row[IDX["siret"]],
        "adresse": make_adresse(row),
        "telephone": row[IDX["telephone"]],
        "date_ouverture": row[IDX["date_ouverture"]],
        "date_maj": row[IDX["date_maj"]],
    }


def save_csv(name: str, rows: list[dict[str, str]]) -> None:
    path = OUT_DIR / name
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_FIELDS)
        writer.writeheader()
        writer.writerows(sorted(rows, key=lambda r: (r["raison_sociale"], r["finess"])))


def main() -> None:
    chu: list[dict[str, str]] = []
    hopitaux: list[dict[str, str]] = []
    cliniques: list[dict[str, str]] = []
    ehpad: list[dict[str, str]] = []

    for row in read_isere_rows():
        text = row_text(row)
        out = to_output_row(row)

        if "CHU" in text or "UNIVERSITAIRE" in text:
            chu.append(out)
        if "HOPITAL" in text or "HOSPITALIER" in text:
            hopitaux.append(out)
        if "CLINIQUE" in text:
            cliniques.append(out)
        if "EHPAD" in text or "HEBERGEMENT POUR PERSONNES AGEES" in text:
            ehpad.append(out)

    save_csv("isere_chu.csv", chu)
    save_csv("isere_hopitaux.csv", hopitaux)
    save_csv("isere_cliniques.csv", cliniques)
    save_csv("isere_ehpad.csv", ehpad)

    print(f"CHU: {len(chu)}")
    print(f"Hopitaux: {len(hopitaux)}")
    print(f"Cliniques: {len(cliniques)}")
    print(f"EHPAD: {len(ehpad)}")


if __name__ == "__main__":
    main()
