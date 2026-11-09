#!/usr/bin/env bash
# How fast a session's GPU gets ready (the capacity manager's cold start), measured with two pods on
# one Runpod network volume (mounted at /runpod-volume):
#
#   control  (first pod): builds the GPU worker into the volume, runs Postgres + the API (port 8080),
#            puts the sketch_to_scene models in the catalog and fills the worker's model cache on the
#            volume with one job. Then it waits for a new GPU worker to register, submits a map job
#            to it at once and prints how long registration and that first job took.
#   worker   (second pod, started by hand once control prints READY, as the capacity manager would):
#            runs the worker from the volume against the control pod's API (API_URL).
#
# Image for both: nvidia/cuda:12.4.1-devel-ubuntu22.04 (control) and nvidia/cuda:12.4.1-runtime-ubuntu22.04
# (worker: what the published GPU worker image is based on).
#   bash cold-start.sh control BRANCH
#   API_URL=https://<control-pod>-8080.proxy.runpod.net WORKER_TOKEN=gpu-check bash cold-start.sh worker
set -uo pipefail
MODE=${1:?control or worker}
V=/runpod-volume
T0=$(date +%s.%N)
stamp() { echo "=== $(date -u +%H:%M:%S.%N | cut -c1-12) (+$(echo "$(date +%s.%N) - $T0" | bc | cut -c1-6) s): $* ==="; }
export DEBIAN_FRONTEND=noninteractive

if [ "$MODE" = worker ]; then
    stamp "container started"
    apt-get update -qq > /dev/null && apt-get install -y -qq libcurl4 libgomp1 bc > /dev/null 2>&1
    stamp "libraries installed (the published image has them)"
    env WORKER_CLASS=gpu INTERACTIVE_ONLY=1 KEEP_MODELS=8 CACHE_DIR=$V/cache WORK_DIR=/tmp/jobs \
        "$V/bin/neuracraft-worker" 2>&1 | while IFS= read -r line; do echo "$(date -u +%H:%M:%S.%N | cut -c1-12) $line"; done
    sleep infinity
fi

BRANCH=${2:-main}
stamp "control: packages"
apt-get update -qq && apt-get install -y -qq git curl ca-certificates g++ make libcurl4-openssl-dev python3-pip postgresql bc > /dev/null
pip3 install -q cmake==3.28.3
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null && apt-get install -y -qq nodejs > /dev/null
rm -rf /cloud && git clone -q -b "$BRANCH" https://github.com/sberkan09/neuracraft-cloud /cloud && cd /cloud
stamp "worker build (CUDA 86;89) into the volume"
mkdir -p $V/bin $V/models $V/cache
if [ ! -x $V/bin/neuracraft-worker ]; then
    cmake -S worker -B /build -DCMAKE_BUILD_TYPE=Release -DNEURACRAFT_USE_CUDA=ON "-DCMAKE_CUDA_ARCHITECTURES=86;89" > /tmp/cmake.log 2>&1 \
        && cmake --build /build --parallel "$(nproc)" --target neuracraft-worker > /tmp/build.log 2>&1 && cp /build/neuracraft-worker $V/bin/ \
        || { tail -30 /tmp/cmake.log /tmp/build.log; sleep infinity; }
fi
stamp "api"
npm ci --no-audit --no-fund > /dev/null 2>&1 && npm run build > /dev/null 2>&1 || { echo "npm build failed"; sleep infinity; }
service postgresql start > /dev/null
su postgres -c "psql -qc \"CREATE USER nc SUPERUSER PASSWORD 'nc'\"" ; su postgres -c "createdb -O nc neuracraft"
export DATABASE_URL=postgres://nc:nc@127.0.0.1:5432/neuracraft STORAGE_DIR=/data/storage WORKER_TOKENS=gpu-check SIGNUP_CREDITS=100000000 PORT=8080
node apps/api/dist/src/main.js > /tmp/api.log 2>&1 &
until curl -sf localhost:8080/v1/health > /dev/null; do sleep 1; done
stamp "models"
ENGINE=$(ls -d /build/_deps/neuracraft-src 2>/dev/null || true)
[ -z "$ENGINE" ] && { git clone -q https://github.com/sberkan09/NeuraCraft /nc && ENGINE=/nc; }
MODELS_DIR=$V/models IN_CONTAINER=$V/models ADD="node apps/api/dist/src/cli/add-model.js" bash deploy/catalog/sketch-to-scene.sh "$ENGINE" > /tmp/models.log 2>&1 || { tail -20 /tmp/models.log; sleep infinity; }
stamp "fill the volume's model cache with one job"
env API_URL=http://127.0.0.1:8080 WORKER_TOKEN=gpu-check WORKER_CLASS=gpu ONCE=1 CACHE_DIR=$V/cache WORK_DIR=/tmp/jobs $V/bin/neuracraft-worker > /tmp/fill.log 2>&1 &
FILL=$!
cat > /tmp/job.mjs <<'JS'
// Signs up, submits a map job, waits for it; prints the job's timings from the database.
import pg from "pg";
import { readFileSync } from "node:fs";
const api = "http://127.0.0.1:8080";
const r = await fetch(`${api}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `c${Date.now()}@example.com`, password: "correct horse battery" }) });
const cookie = r.headers.get("set-cookie").split(";")[0];
const t0 = Date.now();
const sub = await (await fetch(`${api}/v1/presets/sketch_to_scene/jobs`, { method: "POST", headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ params: { mode: "map", prompt: "top-down fantasy battle map, a wooden bridge over a river", seed: 1 }, inputs: { sketch: { inline: readFileSync("/cloud/tests/assets/sketches/kopru.png").toString("base64"), contentType: "image/png" } } }) })).json();
if (!sub.job) { console.log("submit failed", JSON.stringify(sub)); process.exit(1); }
for (;;) {
  const j = (await (await fetch(`${api}/v1/jobs/${sub.job.id}`, { headers: { cookie } })).json()).job;
  if (["succeeded", "failed"].includes(j.state)) {
    const db = new pg.Client(process.env.DATABASE_URL); await db.connect();
    const t = (await db.query("SELECT timings FROM jobs WHERE id = $1", [j.id])).rows[0].timings;
    console.log(`job ${j.state} in ${((Date.now() - t0) / 1000).toFixed(2)} s ${JSON.stringify(t)} ${j.error ? JSON.stringify(j.error) : ""}`);
    await db.end(); break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
JS
cp /tmp/job.mjs apps/api/job.mjs
(cd apps/api && node job.mjs)
wait $FILL
du -sh $V/cache | sed 's/^/  cache on the volume: /'
psql "$DATABASE_URL" -qc "UPDATE workers SET last_seen_at = now() - interval '1 hour'"
SINCE=$(psql "$DATABASE_URL" -Atc "SELECT now()")
stamp "READY: start the worker pod now"
until [ -n "$(psql "$DATABASE_URL" -Atc "SELECT id FROM workers WHERE class = 'gpu' AND registered_at > '$SINCE' LIMIT 1")" ]; do sleep 0.5; done
stamp "a new GPU worker registered"
(cd apps/api && node job.mjs)
stamp "second job (warm)"
(cd apps/api && node job.mjs)
stamp "done"
sleep infinity
