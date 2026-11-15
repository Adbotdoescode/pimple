#!/bin/bash
# Headless screenshot of a preview view.
# Usage: shoot.sh <name> "<query>" [width] [height] [dark]
#   e.g. shoot.sh card-full-light "view=card&state=full&theme=light" 1200 800
#        shoot.sh bubblegrid-dark "view=bubblegrid&bg=dark" 1200 800 dark
# Output: /tmp/gt-shots/<name>.png (path echoed on stdout).
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <name> \"<query>\" [width] [height] [dark]" >&2
  exit 1
fi

NAME="$1"
QUERY="$2"
W="${3:-1200}"
H="${4:-800}"
DARK="${5:-}"

CHROME="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell"
OUT_DIR="/tmp/gt-shots"
OUT="$OUT_DIR/$NAME.png"
mkdir -p "$OUT_DIR"

EXTRA=()
if [ "$DARK" = "dark" ]; then
  EXTRA=(--force-dark-mode --blink-settings=preferredColorScheme=0)
fi

"$CHROME" --headless --hide-scrollbars --force-device-scale-factor=1 \
  --window-size="$W,$H" --virtual-time-budget=2500 \
  ${EXTRA[@]+"${EXTRA[@]}"} \
  --screenshot="$OUT" \
  "http://localhost:1420/src/ui/preview/index.html?$QUERY" >/dev/null 2>&1 || {
    echo "shoot failed: $NAME" >&2
    exit 1
  }

echo "$OUT"
