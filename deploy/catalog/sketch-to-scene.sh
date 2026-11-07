#!/usr/bin/env bash
# The catalog models of the sketch_to_scene preset (issue #14), each with its license:
#   dreamshaper-8        Lykon/dreamshaper-8 (SD 1.5), CreativeML OpenRAIL-M
#   controlnet-scribble  lllyasviel/control_v11p_sd15_scribble, OpenRAIL
#   lcm-lora-sd15        latent-consistency/lcm-lora-sdv1-5, OpenRAIL++
#   taesd                madebyollin/taesd, MIT
#   nsfw-classifier      Falconsai/nsfw_image_detection (ONNX export), Apache-2.0: the output classifier
#                        every preset job ends with (issue #18; moderation.ts)
# Downloads them with the engine's scripts into MODELS_DIR (default deploy/models, mounted at /models in
# the API container) and adds them to the catalog with those slugs (re-running replaces them).
#   deploy/catalog/sketch-to-scene.sh /path/to/NeuraCraft
# ADD: how to run add-model (default: in the compose API container).
set -euo pipefail
ENGINE=${1:?usage: sketch-to-scene.sh /path/to/NeuraCraft}
MODELS_DIR=${MODELS_DIR:-deploy/models}
IN_CONTAINER=${IN_CONTAINER:-/models}
ADD=${ADD:-docker compose -f deploy/docker-compose.yml exec -T api node apps/api/dist/src/cli/add-model.js}
SD_TURBO_BASE_URL=https://huggingface.co/Lykon/dreamshaper-8/resolve/main bash "$ENGINE/scripts/download_sd_turbo.sh" "$MODELS_DIR/dreamshaper-8" vae text_encoder unet
bash "$ENGINE/scripts/download_controlnet.sh" "$MODELS_DIR/controlnet-scribble" scribble
bash "$ENGINE/scripts/download_lcm_lora.sh" "$MODELS_DIR/loras"
TAESD_BASE_URL=https://huggingface.co/madebyollin/taesd/resolve/main bash "$ENGINE/scripts/download_sd_turbo.sh" "$MODELS_DIR/taesd-tmp" taesd
mkdir -p "$MODELS_DIR/taesd" && cp "$MODELS_DIR/taesd-tmp/taesd/"* "$MODELS_DIR/taesd/" && rm -rf "$MODELS_DIR/taesd-tmp"
bash "$ENGINE/scripts/download_nsfw_classifier.sh" "$MODELS_DIR/nsfw-classifier"
$ADD "$IN_CONTAINER/dreamshaper-8" --kind sd --slug dreamshaper-8 --name "DreamShaper 8" \
    --license "CreativeML OpenRAIL-M (https://huggingface.co/spaces/CompVis/stable-diffusion-license)"
$ADD "$IN_CONTAINER/controlnet-scribble" --kind controlnet --slug controlnet-scribble --name "ControlNet 1.1 scribble (SD 1.5)" \
    --license "OpenRAIL (https://huggingface.co/lllyasviel/control_v11p_sd15_scribble)"
$ADD "$IN_CONTAINER/loras/lcm-lora-sdv1-5.safetensors" --kind lora --slug lcm-lora-sd15 --name "LCM-LoRA SD 1.5" \
    --license "OpenRAIL++ (https://huggingface.co/latent-consistency/lcm-lora-sdv1-5)"
$ADD "$IN_CONTAINER/taesd" --kind taesd --slug taesd --name "TAESD" --license "MIT (https://github.com/madebyollin/taesd)"
$ADD "$IN_CONTAINER/nsfw-classifier" --kind onnx --entry nsfw.onnx --slug nsfw-classifier --name "NSFW classifier (ViT)" \
    --license "Apache-2.0 (https://huggingface.co/Falconsai/nsfw_image_detection)"
