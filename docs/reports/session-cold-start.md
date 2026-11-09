# How fast a session's GPU is ready

Measured on 2026-11-09 with `deploy/gpu-check/cold-start.sh` (PR #32): how long a pod that the
capacity manager rents for a session takes before it can answer GM Cebi's first sketch.

## Setup

- Runpod, data centre EU-RO-1, RTX 4090 (secure cloud, $0.89/h), driver CUDA 13.2.
- A 20 GB network volume shared by two pods, mounted at `/runpod-volume`:
  - **control pod**: builds the GPU worker into the volume, runs Postgres and the API (port 8080),
    adds the sketch_to_scene catalog models, and fills the volume's model cache with one job;
  - **worker pod**: started as the capacity manager would start one, image
    `nvidia/cuda:12.4.1-runtime-ubuntu22.04`, runs the worker from the volume against the control
    pod's API (`INTERACTIVE_ONLY=1`, `KEEP_MODELS=8`, `CACHE_DIR` on the volume).
- Job: sketch_to_scene, `mode: map`, the `kopru.png` sketch, seed 1.

## Results

| Step | Time |
|---|---|
| Pod created → its command starts (image already on the host) | 2.5 s |
| Libraries installed (`apt-get`; the published worker image has them) | 12 s |
| Worker registered | **15 s** after the pod was created |
| First job (models read from the volume's cache) | **29.5 s**: load 25.4 s, run 2.4 s, upload 0.8 s, fetch 0.2 s |
| Second job (models loaded) | **3.2 s**: run 1.6 s, upload 0.7 s, fetch 0.3 s |

For comparison, the very first job on an empty volume (the control pod's fill job) took 58 s:
fetching the 3.2 GB of models from the API 28 s, loading 27 s.

## What it means

- Renting is not the slow part: with the image on the host, a pod's worker is there in 15 s. A host
  without the image adds the pull of the worker image (not measured here; tens of seconds).
- Loading the models from the network volume is: 25 s, against 9.5 s from a pod's local disk
  (docs/reports/sketch-to-scene.md). The volume saves the download, not the load.
- So a pod is now **warmed up** before it counts as ready (`WARMUP=1`, `apps/api/src/warmup.ts`): the
  worker runs the preset once on a blank sketch for itself and claims jobs only afterwards. A game
  master's first sketch usually comes minutes after the game (and the session) starts, so the
  first picture takes the warm ~3 s instead of ~30 s. A sketch sent during the warm-up waits for it
  (the session's `capacity` says `warming` with an estimate until then).

## Cost of the measurement

About 8 minutes of the control pod and 1 minute of the worker pod (≈ $0.13); both pods and the
volume were deleted afterwards.
