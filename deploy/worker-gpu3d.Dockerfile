# The 3D GPU worker: the GPU worker plus the engine's services on 127.0.0.1: the 3D service (TRELLIS.2,
# services/trellis2) for image_to_3d jobs and the rigging service (SkinTokens, services/rigging) for rig
# jobs. Needs a 48 GB NVIDIA GPU (both models stay loaded) and, at run time, HF_TOKEN of a Hugging Face
# account with access to facebook/dinov3-vitl16-pretrain-lvd1689m (gated). Large (~30 GB) and slow to
# build (CUDA extensions): built for releases, not in pull request CI. Mount /data on a disk that
# survives restarts (models: ~15 GB under /data/hf).
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS worker
RUN apt-get update && apt-get install -y --no-install-recommends g++ make git ca-certificates libcurl4-openssl-dev python3-pip \
    && pip3 install --no-cache-dir cmake==3.28.3 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY worker worker
ARG CUDA_ARCHS="86;89"
RUN cmake -S worker -B build -DCMAKE_BUILD_TYPE=Release -DNEURACRAFT_USE_CUDA=ON "-DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCHS}" \
    && cmake --build build --parallel --target neuracraft-worker

FROM nvidia/cuda:12.4.1-devel-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends software-properties-common \
    && add-apt-repository -y ppa:deadsnakes/ppa && apt-get update \
    && apt-get install -y --no-install-recommends git g++ python3 python3-venv python3-dev python3.11 python3.11-venv python3.11-dev \
        libgl1 libegl1 libglib2.0-0 libxrender1 libxxf86vm1 libxfixes3 libxi6 libxkbcommon0 libsm6 libusb-1.0-0 libgomp1 \
        libcurl4 ca-certificates \
    && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 worker && mkdir -p /data && chown worker /data
# The 3D service of the engine commit the worker is built with (worker/CMakeLists.txt).
COPY worker/CMakeLists.txt /tmp/worker-cmake.txt
ARG TORCH_CUDA_ARCH_LIST="8.6;8.9"
RUN commit=$(sed -n 's/^set(NEURACRAFT_COMMIT \([0-9a-f]*\) .*/\1/p' /tmp/worker-cmake.txt) \
    && git clone -q https://github.com/sberkan09/NeuraCraft.git /tmp/nc && git -C /tmp/nc checkout -q "$commit" \
    && TORCH_CUDA_ARCH_LIST="$TORCH_CUDA_ARCH_LIST" MAX_JOBS=4 bash /tmp/nc/services/trellis2/install.sh /opt/trellis2 \
    && PYTHON=python3.11 bash /tmp/nc/services/rigging/install.sh /opt/skintokens \
    && chown -R worker /opt/skintokens/SkinTokens \
    && rm -rf /tmp/nc /tmp/worker-cmake.txt /root/.cache
COPY --from=worker /src/build/neuracraft-worker /usr/local/bin/neuracraft-worker
COPY deploy/worker-gpu3d-entry.sh /usr/local/bin/worker-gpu3d-entry
USER worker
ENV CACHE_DIR=/data/cache WORK_DIR=/data/jobs WORKER_CLASS=gpu HF_HOME=/data/hf \
    NEURACRAFT_3D_URL=http://127.0.0.1:8188 NEURACRAFT_RIG_URL=http://127.0.0.1:8189
CMD ["worker-gpu3d-entry"]
