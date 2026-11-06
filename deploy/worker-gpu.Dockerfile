# The GPU worker: the engine with its CUDA backend (cuBLAS), for NVIDIA GPUs (Runpod and alike).
# Set CUDA_ARCHS to the fleet's GPUs (86: RTX 30xx / A-series, 89: RTX 40xx / L4 / L40, 90: H100).
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS build
RUN apt-get update && apt-get install -y --no-install-recommends g++ make git ca-certificates libcurl4-openssl-dev python3-pip \
    && pip3 install --no-cache-dir cmake==3.28.3 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY worker worker
ARG CUDA_ARCHS="86;89"
RUN cmake -S worker -B build -DCMAKE_BUILD_TYPE=Release -DNEURACRAFT_USE_CUDA=ON "-DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCHS}" \
    && cmake --build build --parallel --target neuracraft-worker

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y --no-install-recommends libcurl4 ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 worker && mkdir -p /data && chown worker /data
COPY --from=build /src/build/neuracraft-worker /usr/local/bin/neuracraft-worker
USER worker
ENV CACHE_DIR=/data/cache WORK_DIR=/data/jobs WORKER_CLASS=gpu
CMD ["neuracraft-worker"]
