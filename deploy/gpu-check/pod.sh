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
# ENGINE_BRANCH: build against an engine branch instead of the pinned commit (and run its GPU tests).
ENGINE_FLAG=""
if [ -n "${ENGINE_BRANCH:-}" ]; then
    git clone -q -b "$ENGINE_BRANCH" https://github.com/sberkan09/NeuraCraft /nc && ENGINE_FLAG="-DNEURACRAFT_DIR=/nc"
    echo "engine: $ENGINE_BRANCH $(git -C /nc rev-parse --short HEAD)"
fi
cmake -S worker -B /build -DCMAKE_BUILD_TYPE=Release -DNEURACRAFT_USE_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$ARCH" $ENGINE_FLAG > /tmp/cmake.log 2>&1 \
    && cmake --build /build --parallel "$(nproc)" --target neuracraft-worker NeuraCraft > /tmp/build.log 2>&1 || { tail -30 /tmp/cmake.log /tmp/build.log; sleep infinity; }
NC=$(find /build /nc/bin -name NeuraCraft -type f -perm -u+x 2>/dev/null | head -1)
if [ -n "${ENGINE_BRANCH:-}" ]; then
    ( cmake -S /nc -B /nc/build-cuda -DCMAKE_BUILD_TYPE=Release -DNEURACRAFT_USE_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$ARCH" > /tmp/cmake-t.log 2>&1 \
      && cmake --build /nc/build-cuda --parallel "$(nproc)" --target neuracraft_tests > /tmp/build-t.log 2>&1 \
      && /nc/build-cuda/neuracraft_tests > /tmp/tests.log 2>&1; echo "engine tests (GPU): $(grep -E 'passed|failed' /tmp/tests.log | tail -1)"; \
      grep -E "FAIL|gpu graph differs" /tmp/tests.log | head -10 ) &
    TESTS_PID=$!
fi
step "api"
npm ci --no-audit --no-fund > /dev/null 2>&1 && npm run build > /dev/null 2>&1 || { echo "npm build failed"; sleep infinity; }
service postgresql start > /dev/null
su postgres -c "psql -qc \"CREATE USER nc SUPERUSER PASSWORD 'nc'\"" && su postgres -c "createdb -O nc neuracraft"
export DATABASE_URL=postgres://nc:nc@127.0.0.1:5432/neuracraft STORAGE_DIR=/data/storage WORKER_TOKENS=gpu-check SIGNUP_CREDITS=100000000 PORT=8080
node apps/api/dist/src/main.js > /tmp/api.log 2>&1 &
until curl -sf localhost:8080/v1/health > /dev/null; do sleep 1; done
step "models"
ENGINE=/build/_deps/neuracraft-src; [ -n "${ENGINE_BRANCH:-}" ] && ENGINE=/nc
MODELS_DIR=/models IN_CONTAINER=/models ADD="node apps/api/dist/src/cli/add-model.js" bash deploy/catalog/sketch-to-scene.sh "$ENGINE" > /tmp/models.log 2>&1 \
    || { tail -30 /tmp/models.log; sleep infinity; }
du -sh /models/* | sed 's/^/  /'
step "engine profile (the preset's workflow, run directly, twice in one process)"
cat > /tmp/wf.json <<WF
{"steps": [{"op": "load", "path": "/cloud/tests/assets/sketches/kopru.png", "out": "sketch"},
 {"op": "resize", "in": "sketch", "width": 512, "height": 512, "out": "sized"},
 {"op": "scribble", "in": "sized", "thickness": 2, "out": "lines"},
 {"op": "txt2img", "model": "/models/dreamshaper-8", "prompt": "top-down fantasy battle map, a wooden bridge over a river", "negative": "blurry, text",
  "seed": 1, "width": 512, "height": 512, "controlnet": "/models/controlnet-scribble", "control": "lines", "control_scale": 0.9,
  "tiny_vae": "/models/taesd", "steps": 4, "sampler": "lcm", "guidance": 1.5, "lora": ["/models/loras/lcm-lora-sdv1-5.safetensors"], "out": "a"},
 {"op": "txt2img", "model": "/models/dreamshaper-8", "prompt": "top-down fantasy battle map, a stone castle wall", "negative": "blurry, text",
  "seed": 2, "width": 512, "height": 512, "controlnet": "/models/controlnet-scribble", "control": "lines", "control_scale": 0.9,
  "tiny_vae": "/models/taesd", "steps": 4, "sampler": "lcm", "guidance": 1.5, "lora": ["/models/loras/lcm-lora-sdv1-5.safetensors"], "out": "b"},
 {"op": "classify", "model": "/models/nsfw-classifier/nsfw.onnx", "in": "b", "path": "/tmp/m.json"},
 {"op": "save", "in": "b", "path": "/tmp/b.png"}]}
WF
"$NC" --gpu --profile workflow /tmp/wf.json 2>&1 | grep -v "^  *$" | tail -60
[ -n "${TESTS_PID:-}" ] && wait "$TESTS_PID"  # (the engine tests, so they do not slow the latency run)
step "workers"
# Two worker processes share the GPU: each gets a weight budget of its own (the default is 60 % of
# the device per process, so two would run out of memory).
for w in interactive general; do
    extra="KEEP_MODELS=3"; [ "$w" = interactive ] && extra="INTERACTIVE_ONLY=1 KEEP_MODELS=8"
    env API_URL=http://127.0.0.1:8080 WORKER_TOKEN=gpu-check WORKER_CLASS=gpu NEURACRAFT_CUDA_WEIGHTS_GB=${WEIGHTS_GB:-7} CACHE_DIR=/data/cache-$w WORK_DIR=/data/jobs-$w $extra \
        /build/neuracraft-worker > /tmp/worker-$w.log 2>&1 &
done
sleep 5
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
step "check"
API=http://127.0.0.1:8080 node deploy/gpu-check/latency.mjs "$JOBS" 2>&1
step "server percentiles"
node apps/api/dist/src/cli/latency.js --hours 2
psql "$DATABASE_URL" -Atc "SELECT preset_variant, timings FROM jobs WHERE preset IS NOT NULL ORDER BY created_at LIMIT 8"
nvidia-smi --query-gpu=memory.used --format=csv,noheader
grep -h "failed" /tmp/worker-*.log | head -5
step "done"
sleep infinity
