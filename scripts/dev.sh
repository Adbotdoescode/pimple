#!/usr/bin/env bash
# Launch Glass Tutor in dev (background). Log: /tmp/glass-tutor-dev.log
source ~/.zshrc >/dev/null 2>&1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/glass-tutor-dev.log
"$ROOT/scripts/stop.sh" >/dev/null 2>&1
export GT_TTS=${GT_TTS:-say}
cd "$ROOT"
: > "$LOG"
nohup bun run tauri dev --no-watch >>"$LOG" 2>&1 &
echo "started tauri dev (pid $!), GT_TTS=$GT_TTS, log $LOG"
for i in $(seq 1 300); do
  if pgrep -f "target/debug/glass-tutor" >/dev/null 2>&1; then
    sleep 2
    echo "Glass Tutor is running (pid $(pgrep -f 'target/debug/glass-tutor' | head -1))"
    exit 0
  fi
  if grep -qE "^error(\[|:)|error: could not compile|Error failed|panicked" "$LOG"; then
    echo "Launch failed. Last log lines:"
    tail -30 "$LOG"
    exit 1
  fi
  sleep 1
done
echo "Timed out waiting for the app. Last log lines:"; tail -20 "$LOG"; exit 1
