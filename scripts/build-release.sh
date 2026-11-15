#!/usr/bin/env bash
# Reproducible standalone release build of Glass Tutor (macOS).
# Output: dist/release/ ("Glass Tutor.app", plus the .dmg when it builds).
# Log: /tmp/glass-tutor-release.log. Does not launch the app.
source ~/.zshrc >/dev/null 2>&1 || true
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/glass-tutor-release.log
SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle"
OUT="$ROOT/dist/release"
VAD_REL="resources/models/silero-vad-v6.2-F32.gguf"

# beforeBuildCommand runs `vite build`, which empties dist/ by default and would
# wipe dist/backup. Build with emptyOutDir off and clear the rest of dist/ by hand.
BUILD_OVERRIDE='{"build":{"beforeBuildCommand":"bunx tsc && bunx vite build --no-emptyOutDir"}}'

main() {
  echo "== Glass Tutor release build: $(date)"
  cd "$ROOT"

  if [ -d "$SDK" ]; then
    export SDKROOT="$SDK"
    echo "SDKROOT=$SDKROOT"
  fi

  # Clear the previous frontend output, keeping dist/backup and dist/release.
  find "$ROOT/dist" -mindepth 1 -maxdepth 1 ! -name backup ! -name release -exec rm -rf {} +

  DMG_SKIPPED=0
  if ! bun run tauri build --bundles app,dmg --config "$BUILD_OVERRIDE"; then
    echo "NOTE: the dmg step failed. Retrying with --bundles app only; the dmg is SKIPPED."
    DMG_SKIPPED=1
    bun run tauri build --bundles app --config "$BUILD_OVERRIDE"
  fi

  APP=""
  for app in "$BUNDLE_DIR"/macos/*.app; do
    if [ -d "$app" ]; then
      APP="$app"
      break
    fi
  done
  if [ -z "$APP" ]; then
    echo "ERROR: no .app found in $BUNDLE_DIR/macos"
    exit 1
  fi
  APP_NAME="$(basename "$APP")"

  VAD_IN_APP="$APP/Contents/Resources/$VAD_REL"
  if [ ! -f "$VAD_IN_APP" ]; then
    echo "ERROR: VAD model missing from the bundle: $VAD_IN_APP"
    exit 1
  fi

  rm -rf "$OUT"
  mkdir -p "$OUT"
  ditto "$APP" "$OUT/$APP_NAME"
  for dmg in "$BUNDLE_DIR"/dmg/*.dmg; do
    if [ -e "$dmg" ]; then
      cp "$dmg" "$OUT/"
    fi
  done

  echo
  echo "== Output"
  for item in "$OUT"/*; do
    echo "$(du -sh "$item" | cut -f1)  $item"
  done
  echo "VAD model in bundle: $VAD_IN_APP"
  if [ "$DMG_SKIPPED" = "1" ]; then
    echo "NOTE: no .dmg was produced (dmg step skipped)."
  fi
  echo "== Done. Log: $LOG"
}

main "$@" 2>&1 | tee "$LOG"
