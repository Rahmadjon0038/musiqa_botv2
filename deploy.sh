#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker topilmadi. Serverga Docker o‘rnating: https://docs.docker.com/engine/install/"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose topilmadi. Docker Compose plugin’ni o‘rnating."
  exit 1
fi

if [[ ! -f ".env" ]]; then
  echo ".env topilmadi. .env faylni serverga qo‘ying (BOT_TOKEN, RAPIDAPI_KEY, MEDIA/YT/SHAZAM sozlamalari)."
  exit 1
fi

echo "Compose build + up..."
docker compose up -d --build

echo "Status:"
docker compose ps

echo "Loglar (oxirgi 50 qatordan):"
docker compose logs --tail=50 app

