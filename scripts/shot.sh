#!/usr/bin/env bash
# Screenshot the whole screen: scripts/shot.sh <name> → /tmp/gt-shots/<name>.png
mkdir -p /tmp/gt-shots
NAME=${1:-shot-$(date +%H%M%S)}
OUT=/tmp/gt-shots/$NAME.png
screencapture -x "$OUT" && echo "$OUT"
