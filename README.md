# NeuraCraft Cloud

[NeuraCraft](https://github.com/sberkan09/NeuraCraft) workflows — image, video and ONNX pipelines —
as a hosted service: many users at once, on a pool of CPU (and later GPU) workers that grows with
demand.

* [Architecture and decisions](docs/ARCHITECTURE.md)
* [Data, retention and sub-processors](docs/PRIVACY.md)

Status: milestone 2, the local MVP — accounts, uploads, jobs with live progress, a C++ worker running
the engine in a sandbox, credits, English and Turkish.

## Layout

```
apps/api        Fastify API + scheduler (TypeScript)        npm test -w @neuracraft/api
apps/web        web app (React, Vite, i18next: en, tr)       npm run dev -w @neuracraft/web
packages/shared types shared by API and web, the engine's workflow schema
worker          C++ worker on the NeuraCraft engine (CMake, libcurl)
db/migrations   SQL migrations (applied by the API at start)
deploy          Dockerfiles, docker-compose, Caddyfile
tests/e2e.mjs   API + worker + engine end to end
```

## Running it

With Docker:

```
cp deploy/.env.example deploy/.env      # fill in the secrets (openssl rand -hex 32)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up --build
```

Then open http://localhost:8000. Catalog models (offered to everyone, each with its license) are
read from `deploy/models` (`MODELS_DIR`). An ONNX picture model takes its pre- and post-processing
from a manifest next to it, `<model>.json` (see the engine's README); u2netp's is in the repository,
the weights are not:

```
curl -L -o deploy/models/u2netp/u2netp.onnx https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx
sha256sum deploy/models/u2netp/u2netp.onnx   # 309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8
docker compose -f deploy/docker-compose.yml exec api \
  node apps/api/dist/src/cli/add-model.js /models/u2netp --kind onnx --license Apache-2.0 --entry u2netp.onnx
```

Catalog models can carry a stable `--slug`, which presets refer to; adding another model with the same
slug retires the old one. `deploy/catalog/sketch-to-scene.sh /path/to/NeuraCraft` downloads and adds the
`sketch_to_scene` preset's four (DreamShaper 8, ControlNet scribble, LCM-LoRA, TAESD), each with its
license.

Motion captures for the animate step are catalog models of kind `mocap` (`.bvh`). The engine's
`scripts/download_cmu_motions.sh` fetches five from CMU's free database (walk, run, jump, dance,
cartwheel):

```
bash path/to/NeuraCraft/scripts/download_cmu_motions.sh deploy/models/motions
for m in walk run jump dance cartwheel; do
  docker compose -f deploy/docker-compose.yml exec api node apps/api/dist/src/cli/add-model.js /models/motions/$m.bvh \
    --kind mocap --license "CMU Graphics Lab Motion Capture Database (free for research and commercial use)" --name "$m"
done
```

Without Docker (Node 22, PostgreSQL 16, CMake, libcurl):

```
npm ci && npm run build
DATABASE_URL=postgres://... WORKER_TOKENS=dev node apps/api/dist/src/main.js
cmake -S worker -B worker/build && cmake --build worker/build -j
API_URL=http://localhost:8080 WORKER_TOKEN=dev worker/build/neuracraft-worker
API_URL=http://localhost:8080 npm run dev -w @neuracraft/web
```

## Tests

```
TEST_DATABASE_URL=postgres://user@host/postgres npm test -w @neuracraft/api   # a database per run
npm test -w @neuracraft/web                                                    # translations complete
DATABASE_URL=postgres://user@host/empty_db node tests/e2e.mjs                  # needs the built worker
```
