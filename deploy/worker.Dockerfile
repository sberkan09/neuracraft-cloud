# The worker: the engine at the pinned commit, built for the machine class (NATIVE=ON for a fleet of
# identical CPUs), run as a non-root user.
FROM ubuntu:24.04 AS build
RUN apt-get update && apt-get install -y --no-install-recommends g++ cmake make git ca-certificates libcurl4-openssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY worker worker
ARG NATIVE=OFF
RUN cmake -S worker -B build -DCMAKE_BUILD_TYPE=Release -DNEURACRAFT_NATIVE=${NATIVE} && cmake --build build --parallel --target neuracraft-worker

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends libcurl4t64 ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 worker && mkdir -p /data && chown worker /data
COPY --from=build /src/build/neuracraft-worker /usr/local/bin/neuracraft-worker
USER worker
ENV CACHE_DIR=/data/cache WORK_DIR=/data/jobs
CMD ["neuracraft-worker"]
