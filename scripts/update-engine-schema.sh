#!/usr/bin/env bash
# After changing the engine commit in worker/CMakeLists.txt: export that engine's workflow schema
# into packages/shared (the API validates submissions with it). Needs a built worker tree.
set -euo pipefail
cd "$(dirname "$0")/.."
cmake --build worker/build --target NeuraCraft >/dev/null
bin=$(find worker -path '*/bin/NeuraCraft' -type f | head -1)
"$bin" ops > packages/shared/src/engine-schema.json
echo "packages/shared/src/engine-schema.json updated"
