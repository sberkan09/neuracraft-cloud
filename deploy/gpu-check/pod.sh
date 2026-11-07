#!/usr/bin/env bash
# The whole service on one rented GPU, for the sketch_to_scene check (issues #14 and #20): Postgres,
# the API, two GPU workers (one kept for interactive jobs, INTERACTIVE_ONLY=1), the preset's catalog
# models, then deploy/gpu-check/latency.mjs. Everything goes to stdout (the pod's log); the API is
# on port 8080 (expose it as 8080/http to open the sample pictures).
# Image: nvidia/cuda:12.4.1-devel-ubuntu22.04 (or runpod/pytorch:*-cuda12.4*-devel), >= 16 GB VRAM.
#   bash deploy/gpu-check/pod.sh BRANCH [JOBS]
set -uo pipefail
BRANCH=${1:-main}
JOBS=${2:-50}
export DEBIAN_FRONTEND=noninteractive
T0=$(date +%s)
step() { echo "=== $(( $(date +%s) - T0 )) s: $* ==="; }
step "packages"
apt-get update -qq && apt-get install -y -qq git curl ca-certificates g++ make libcurl4-openssl-dev python3-pip postgresql > /dev/null
pip3 install -q cmake==3.28.3
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null && apt-get install -y -qq nodejs > /dev/null
[ -d /cloud ] || git clone -q -b "$BRANCH" https://github.com/sberkan09/neuracraft-cloud /cloud
cd /cloud && git pull -q
step "worker build (CUDA)"
ARCH=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d .)
cmake -S worker -B /build -DCMAKE_BUILD_TYPE=Release -DNEURACRAFT_USE_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$ARCH" > /tmp/cmake.log 2>&1 \
    && cmake --build /build --parallel "$(nproc)" --target neuracraft-worker > /tmp/build.log 2>&1 || { tail -30 /tmp/cmake.log /tmp/build.log; sleep infinity; }
step "api"
npm ci --no-audit --no-fund > /dev/null 2>&1 && npm run build > /dev/null 2>&1 || { echo "npm build failed"; sleep infinity; }
service postgresql start > /dev/null
su postgres -c "psql -qc \"CREATE USER nc SUPERUSER PASSWORD 'nc'\"" && su postgres -c "createdb -O nc neuracraft"
export DATABASE_URL=postgres://nc:nc@127.0.0.1:5432/neuracraft STORAGE_DIR=/data/storage WORKER_TOKENS=gpu-check SIGNUP_CREDITS=100000000 PORT=8080
node apps/api/dist/src/main.js > /tmp/api.log 2>&1 &
until curl -sf localhost:8080/v1/health > /dev/null; do sleep 1; done
step "models"
ENGINE=/build/_deps/neuracraft-src
MODELS_DIR=/models IN_CONTAINER=/models ADD="node apps/api/dist/src/cli/add-model.js" bash deploy/catalog/sketch-to-scene.sh "$ENGINE" > /tmp/models.log 2>&1 \
    || { tail -30 /tmp/models.log; sleep infinity; }
du -sh /models/* | sed 's/^/  /'
step "workers"
for w in interactive general; do
    extra=""; [ "$w" = interactive ] && extra="INTERACTIVE_ONLY=1"
    env API_URL=http://127.0.0.1:8080 WORKER_TOKEN=gpu-check WORKER_CLASS=gpu KEEP_MODELS=8 CACHE_DIR=/data/cache-$w WORK_DIR=/data/jobs-$w $extra \
        /build/neuracraft-worker > /tmp/worker-$w.log 2>&1 &
done
sleep 5
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
step "check"
API=http://127.0.0.1:8080 node deploy/gpu-check/latency.mjs "$JOBS" 2>&1
step "server percentiles"
node apps/api/dist/src/cli/latency.js --hours 2
psql "$DATABASE_URL" -Atc "SELECT preset_variant, timings FROM jobs WHERE preset IS NOT NULL ORDER BY created_at LIMIT 3"
nvidia-smi --query-gpu=memory.used --format=csv,noheader
grep -h "failed" /tmp/worker-*.log | head -5
step "done"
sleep infinity
