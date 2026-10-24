#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu server:  sudo bash deploy/install.sh pos.example.ly admin@example.ly
set -euo pipefail
DOMAIN=${1:?usage: install.sh <domain> <platform admin email>}
ADMIN=${2:?usage: install.sh <domain> <platform admin email>}
cd "$(dirname "$0")"

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -f .env ]; then
  PASS=$(openssl rand -base64 18)
  cat > .env <<ENV
DOMAIN=$DOMAIN
DB_PASSWORD=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)
PLATFORM_ADMIN_EMAIL=$ADMIN
PLATFORM_ADMIN_PASSWORD=$PASS
ENV
  chmod 600 .env
  echo "Platform admin: $ADMIN / $PASS  (write it down; it is also in deploy/.env)"
fi

mkdir -p backups
docker compose up -d --build
echo "Done. Open https://$DOMAIN once DNS points here (the certificate takes a minute)."
