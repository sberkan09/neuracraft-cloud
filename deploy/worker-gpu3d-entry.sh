#!/usr/bin/env bash
# Starts the 3D and rigging services (local only), then the worker; the worker reports the "3d" and
# "rig" features once the services have loaded their models. When any of them stops, the container
# stops (and is restarted).
set -euo pipefail
PORT=8188 /opt/trellis2/run.sh &
trellis=$!
PORT=8189 /opt/skintokens/run.sh &
rigging=$!
neuracraft-worker &
worker=$!
trap 'kill -TERM "$worker" "$trellis" "$rigging" 2> /dev/null' TERM INT
wait -n "$trellis" "$rigging" "$worker" || true
kill -TERM "$worker" "$trellis" "$rigging" 2> /dev/null || true
wait
exit 1
