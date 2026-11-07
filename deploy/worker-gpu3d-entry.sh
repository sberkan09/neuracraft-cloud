#!/usr/bin/env bash
# Starts the 3D service (local only), then the worker; the worker reports the "3d" feature once the
# service has loaded its model. When either stops, the container stops (and is restarted).
set -euo pipefail
/opt/trellis2/run.sh &
service=$!
neuracraft-worker &
worker=$!
trap 'kill -TERM "$worker" "$service" 2> /dev/null' TERM INT
wait -n "$service" "$worker" || true
kill -TERM "$worker" "$service" 2> /dev/null || true
wait
exit 1
