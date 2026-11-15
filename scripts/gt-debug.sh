#!/usr/bin/env bash
# Hit the dev debug hook: scripts/gt-debug.sh capture=/abs/x.png question="why is N < mg?" mode=region tts=say shapes=/abs/r.json
# Port: contract 47823, but the app falls back to 47824+ if taken and writes the bound port here.
PORT=$(cat /tmp/glass-tutor-debug-port 2>/dev/null || echo 47823)
ARGS=()
for kv in "$@"; do
  k="${kv%%=*}"; v="${kv#*=}"
  ARGS+=(--data-urlencode "$k=$v")
done
curl -sS -G "http://127.0.0.1:$PORT/debug" "${ARGS[@]}"; echo
