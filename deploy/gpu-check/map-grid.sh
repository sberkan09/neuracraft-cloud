#!/usr/bin/env bash
# Map-mode look (issue #42): runs prompt / ControlNet-strength / VAE variants of sketch_to_scene's map
# workflow on reference sketches with the engine CLI, and prints one contact sheet per sketch as base64
# JPEG in the log (between "SHEET <name> BEGIN" and "SHEET <name> END"), since a pod's log is the only
# way out. Image: nvidia/cuda:12.8.1-devel-ubuntu22.04 (any GPU of the fleet).
#   bash deploy/gpu-check/map-grid.sh BRANCH
set -uo pipefail
BRANCH=${1:-main}
export DEBIAN_FRONTEND=noninteractive
T0=$(date +%s)
step() { echo "=== $(( $(date +%s) - T0 )) s: $* ==="; }
step "packages"
apt-get update -qq && apt-get install -y -qq git curl ca-certificates g++ make python3-pip > /dev/null
pip3 install -q cmake==3.28.3 pillow
[ -d /cloud ] || git clone -q -b "$BRANCH" https://github.com/sberkan09/neuracraft-cloud /cloud
git clone -q https://github.com/sberkan09/NeuraCraft /nc
ARCH=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d .)
step "engine build (sm_$ARCH)"
cmake -S /nc -B /nc/build -DCMAKE_BUILD_TYPE=Release -DNEURACRAFT_USE_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$ARCH" > /tmp/cmake.log 2>&1 \
    && cmake --build /nc/build --parallel "$(nproc)" --target NeuraCraft > /tmp/build.log 2>&1 || { tail -30 /tmp/cmake.log /tmp/build.log; sleep infinity; }
NC=$(find /nc/bin /nc/build -name NeuraCraft -type f -perm -u+x | head -1)
step "models"
MODELS_DIR=/models ADD=true bash /cloud/deploy/catalog/sketch-to-scene.sh /nc > /tmp/models.log 2>&1 || { tail -20 /tmp/models.log; sleep infinity; }
step "workflow"
python3 /cloud/deploy/gpu-check/map-grid.py write /tmp/wf.json /out
"$NC" --gpu --profile workflow /tmp/wf.json 2>&1 | grep -E "step [0-9]+ txt2img|workflow done|device" | head -40
step "sheets"
python3 /cloud/deploy/gpu-check/map-grid.py sheets /out
step "done"
sleep infinity
