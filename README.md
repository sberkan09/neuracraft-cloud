# NeuraCraft Cloud

[NeuraCraft](https://github.com/sberkan09/NeuraCraft) workflows — image, video and ONNX pipelines —
as a hosted service: many users at once, on a pool of CPU (and later GPU) workers that grows with
demand.

* [Architecture and decisions](docs/ARCHITECTURE.md)

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

Then open http://localhost:8000. Catalog models (offered to everyone, each with its license):

```
docker compose -f deploy/docker-compose.yml exec api \
  node apps/api/dist/src/cli/add-model.js /models/u2netp --kind onnx --license Apache-2.0 --entry u2netp.onnx
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
