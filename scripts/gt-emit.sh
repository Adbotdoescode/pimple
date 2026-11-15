#!/usr/bin/env bash
# Inject an allowlisted Tauri event into the running dev app via the debug hook (GET /emit).
# Usage: scripts/gt-emit.sh <event> ['<json>']
# Examples:
#   scripts/gt-emit.sh space:tap
#   scripts/gt-emit.sh stt:final '{"text":"wait, why cos and not sin?"}'
#   scripts/gt-emit.sh ui:intent '{"type":"target-commit","mode":"region","region":{"x":200,"y":150,"w":600,"h":400}}'
# Port: read from /tmp/glass-tutor-debug-port (written by the app), default 47823.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <event> ['<json>']" >&2
  exit 2
fi

PORT=$(tr -d '[:space:]' < /tmp/glass-tutor-debug-port 2>/dev/null || true)
PORT=${PORT:-47823}
PAYLOAD=${2:-'{}'}

curl -sS -G "http://127.0.0.1:$PORT/emit" --data-urlencode "event=$1" --data-urlencode "payload=$PAYLOAD"
echo
