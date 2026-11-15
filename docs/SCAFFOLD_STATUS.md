# Scaffold status (Glass Tutor)

## What exists
- Renamed: productName "Glass Tutor", identifier `com.glasstutor.app`, crate `glass-tutor`, lib `glass_tutor_lib`, binary `glass-tutor`. Version 0.1.0.
- Handy frontend deleted (App, components, overlay, i18n, stores, hooks, bindings.ts, root index.html, public/). Tray i18n kept for Handy's Rust code via the English locale copied to `src-tauri/i18n/en/translation.json` (build.rs reads it).
- Rust STT pipeline still compiled and initialized: audio/model/transcription managers, engine_supervisor, catalog, settings, shortcut module, tauri-nspanel, macos-permissions.
- Unwired: updater plugin + config (removed), autostart (plugin removed, `autostart.rs` is a no-op), Handy main window, Handy tray, Handy recording overlay, SIGUSR signal handlers, secure-input monitor, tauri-specta TS export. Handy shortcuts are never initialized, so nothing grabs keys. `clipboard::paste` is hard-disabled (`GLASS_ALLOW_PASTE = false`), so nothing can paste even if Handy's action path ran. Modules like actions.rs, llm_client.rs, apple_intelligence.rs, history are still compiled but unreachable from the UI. `#![allow(dead_code)]` is on lib.rs.
- Windows (`src-tauri/src/glass/windows.rs`, created at startup):
  - `brain`: hidden webview, `background_throttling(Disabled)`.
  - `bubble`: nspanel (non-activating, cannot become key), 72×72 pt at the right edge of the main display (8 pt margin), vertically centred, level 27, all spaces, no shadow. Native vibrancy applied (Tauri `effects`: HudWindow, radius 36). Domain 1 can `setEffects` / `clearEffects` from JS when resizing.
  - `overlay`: nspanel covering the main display, level 25, ignores mouse events (set both in PanelBuilder and via `set_ignore_cursor_events(true)`), not focusable, all spaces. Shown at start.
  - `card`: nspanel 380×260 left of the bubble, CAN become key (for the typed-question box), hidden at start.
  - `whiteboard`, `settings`: normal windows, hidden.
  - `gizmo`: not created (phase 2).
- Vite: one entry per label at `src/windows/<label>/index.html` + `main.tsx` + `App.tsx`. Aliases `@shared/*` → `shared/*`, `@/*` → `src/*`.
- Capability `src-tauri/capabilities/default.json` covers every label (events, window show/hide/position/size/ignore-cursor/drag/monitors, etc.).
- `src/lib/ipc.ts`: `invokeCmd(name, args)`, `onEvent(name, cb)`, `emitEvent`, `emitEventTo`, typed against CMD/EV. `src/lib/sessionMirror.ts`: zustand mirror of `session:state` + `useSession(selector)`, `getSession()`.
- Tray (English): Settings…, Keys…, Whiteboard, Quit. Emits `tray:action {action}`; Settings/Keys show `settings`, Whiteboard shows `whiteboard`.
- App runs as an Accessory app (no Dock icon).
- Scripts: `scripts/dev.sh`, `stop.sh`, `shot.sh`, `gt-debug.sh`.

## Commands (all registered with the exact CMD names; dispatched before Handy's specta handler)
Implemented: `show_window`, `hide_window` (panels use orderFrontRegardless/orderOut on the main thread), `overlay_set_ignore_cursor`, `bubble_display`, `get_secret`, `set_secret`, `keys_status`, `read_source_file` (repo `content/sources/<name>` in dev).
Stubs returning `"not implemented: <name>"`: `capture` (capture.rs), `stt_start`, `stt_stop`, `stt_cancel`, `stt_model_status` (stt.rs), `tts_synthesize`, `tts_credit` (tts.rs), `set_session_keys` (shortcuts.rs).

Args are flat camelCase objects: `invokeCmd("capture", {mode, region})`, `invokeCmd("tts_synthesize", {text, voiceId})`, `invokeCmd("set_session_keys", {space, returnEsc})`.

## Handy STT entry points
See the comment block at the top of `src-tauri/src/glass/stt.rs`. Summary: `AudioRecordingManager::try_start_recording("glass", VadPolicy::Offline)` → `readiness.wait()`; stop with `stop_recording("glass", rm.cancel_generation())` → `Option<Vec<f32>>`; transcribe with `TranscriptionManager::transcribe_recording(samples)` or `transcribe(samples)`; then `emit("stt:final", {text})`. Handy's VAD trims silence but does not end a turn: implement the ~1 s silence auto-stop yourself. Mic levels flow through `overlay::emit_levels` (hook it to emit `stt:level`). Do not use `actions.rs` / `TranscriptionCoordinator`.

## Deviations from the contract
- Debug hook port: 47823 is held on this Mac by an unrelated system process (`vaultagen`). The hook tries 47823, then 47824..47833, and writes the bound port to `/tmp/glass-tutor-debug-port`. `scripts/gt-debug.sh` reads that file. Today it binds **47824**. `GT_DEBUG_PORT` overrides the first choice.
- `bubble_display.displayId` is the 1-based index into the monitor list (1 = main), which matches `screencapture -D`. It is not a CGDirectDisplayID.
- `lucide-react` is kept because Domain 1's card uses it.

## Not verified
- Click-through on the overlay was not verified with a real click: cliclick has no Accessibility permission in this terminal, and running it raised a system Accessibility prompt for Herdr Core. The overlay is configured to ignore the mouse in two ways (see above).
- Whether JS in the hidden brain window is throttled is not measured yet.
