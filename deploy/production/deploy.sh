#!/usr/bin/env bash
# Runs on the server (as the deploy user, from GitHub Actions; docs/DEPLOY.md):
#   TAG=<commit> bash /opt/neuracraft/deploy.sh
# Joins the settings into .env, pulls the images of that commit, starts them, installs the catalog
# models the first time, and waits until the API answers.
set -euo pipefail
cd /opt/neuracraft
: "${TAG:?TAG}"
grep -q '^SITE_DOMAIN=api.neuracraft.example$' settings.env && { echo "set SITE_DOMAIN in deploy/production/settings.env"; exit 1; }
[ -f internal.env ] || { echo "internal.env is missing (cloud-init makes it)"; exit 1; }
touch secrets.env
umask 077
{ cat settings.env; echo; cat internal.env; echo; cat secrets.env; echo; echo "TAG=$TAG"; } > .env
mkdir -p models backups
docker compose pull --quiet
docker compose up -d --remove-orphans
for i in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' neuracraft-api-1 2>/dev/null)" = healthy ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' neuracraft-api-1)" = healthy ] || { docker compose logs --tail 50 api; exit 1; }
if [ ! -f models/.installed ]; then
  echo "installing the catalog models (once; a few minutes)"
  [ -d engine ] || git clone -q --depth 1 https://github.com/sberkan09/NeuraCraft engine
  MODELS_DIR=/opt/neuracraft/models IN_CONTAINER=/models \
    ADD="docker compose exec -T api node apps/api/dist/src/cli/add-model.js" \
    bash catalog-sketch-to-scene.sh /opt/neuracraft/engine
  touch models/.installed
fi
docker image prune -f > /dev/null
echo "deployed $TAG"
