#!/usr/bin/env bash
set -euo pipefail

echo "[1/3] Vérification Docker"
docker --version
docker compose version

echo "[2/3] Build et démarrage"
python3 scripts/prepare_security_env.py "$@"
docker compose up -d --build

echo "[3/3] Application disponible sur http://localhost:1182"
