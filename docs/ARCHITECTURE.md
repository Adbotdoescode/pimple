# Glass Tutor — architecture and team rules (read fully before working)

Product spec: `PROMPT.md` (sections 1–4 are the product). Contracts: `shared/contracts.ts` (C1–C5, command and event names) and `shared/tutor_response.schema.json` (C1, strict structured-output schema). Contracts are owned by the orchestrator: do not rename or reshape anything in `shared/` without asking.

## Hard rules for every agent

1. NO TESTS. Do not write, scaffold or run unit/integration/UI/snapshot tests or CI. Verify only by compiling (`bunx tsc --noEmit`, `cargo check`) and by launching the real app and taking screenshots.
2. Haiku agents write code. Opus agents plan, review and verify (an Opus coder only on explicit escalation).
3. Never hard-code or print API keys. Keys come from the macOS Keychain through the Rust `get_secret` command (which shells out to `/usr/bin/security find-generic-password -s <service> -a glass-tutor -w`, so no Keychain prompt appears). Never open or print `.env.local`.
4. ElevenLabs credit is scarce. When you launch the app to verify, use `GT_TTS=say` (free macOS voice) or `GT_TTS=off`. `scripts/dev.sh` defaults to `say`.
5. Stay inside the files your task owns (ownership table below). Shared "hotspot" files may only receive small targeted edits, never rewrites.
6. UI polish matters as much as function. Liquid Glass look, springs, smooth 150–300 ms stroke animations.

## Process layout

Tauri v2 app (forked from Handy). Rust backend in `src-tauri/`, React + TS + Vite frontend in `src/`. Every window is its own Vite entry at `src/windows/<label>/index.html`.

| Window label | Kind | Owner | Role |
|---|---|---|---|
| `brain` | hidden webview, never shown | Domain 2 | The session controller: zustand store (C5), Claude client, verifier, TTS player, STT handling. Broadcasts `session:state` snapshots; listens for `ui:intent` and Rust events. |
| `bubble` | transparent nspanel, always on top, non-activating | Domain 1 | Liquid Glass bubble, gestures (click / drag-lens / lasso), state visuals. Emits `ui:intent` and `targeting:update`. |
| `overlay` | full-display transparent nspanel, ignores cursor | Domain 1 | Renders C1 shapes as animated SVG, adaptive colour, targeting outline, lasso trail. |
| `card` | small glass nspanel under the bubble | Domain 1 | Caption, source chip, Parked list, "Points you questioned", check question, typed-question fallback box, verifier badge. |
| `whiteboard` | normal opaque window | Domain 3 | Same shapes on a light/dark board (virtual 1600 × 1000 coordinate space). |
| `settings` | normal window, from tray | Domain 1 | Keys sheet (missing keys, paste → Keychain), toggles (verifier, fast mode, TTS provider, voice), ElevenLabs credit. |
| `gizmo` | phase 2 | Domain 3 | Sandboxed iframe for live-generated diagrams. Not before the M4 freeze. |

Data flow: Rust events and `ui:intent` → brain store → `session:state` snapshot → every view window renders from its read-only mirror (`src/lib/sessionMirror.ts`). High-frequency targeting geometry goes bubble → overlay directly via `targeting:update`.

Coordinates: everything on screen is macOS points in global desktop space. The model sees a JPEG of `CaptureResult.regionInScreenPoints`; its shape coordinates are pixels of that JPEG; map with `imagePxToScreen()` from `shared/contracts.ts`. The overlay window covers the bubble's display, so subtract the display origin when drawing.

## Pipeline (brain)

1. Mode A: `bubble-click` → hide app windows → `capture({mode:"click"})` → phase `listening` → `stt_start` → `stt:final` → question.
   Modes B/C: `target-commit` → capture region → phase `summarising`: quick `claude-haiku-5-5` vision call returns ONE sentence on what it sees; speak it + "What do you want to ask?" → `listening`.
2. `thinking`: stream `claude-opus-5-5` (`output_config: {effort: "low", format: {type: "json_schema", schema}}`, betas `server-side-fallback-2026-07-01`, `fallbacks: "default"`), system prompt from `shared/tutor_system_prompt.md`, image + question. Incremental JSON parse emits segments and shapes as they complete.
3. `verifying` (if enabled): `claude-haiku-5-5` with the image + draft → `shared/verifier.schema.json`. On fail, regenerate once with the critique.
4. `speaking`: TTS player plays segment by segment; on `onSegmentStarted(id)` the brain sets `currentSegmentId`, and the overlay animates that segment's shapes on.
5. Space interrupt: hold → `pause()` → `interrupted` + mic; tap → pause, say "Which part?", pulse current shapes, then mic. Send interruption context (segment id/text, spoken segments, shapes, original capture). Answer goes to `sideNote` (distinct style). Then "Back to where we were…" and resume (re-speak the segment if < 50% played, else next one). Log to `contested`.
6. `checking`: speak `check_question`, listen, call the tutor again for short feedback (same schema).
7. Off-topic → `parked`. End of session → `idle`, bubble springs back to its edge.

## Render API (shared by overlay and whiteboard; Domain 1 builds it, Domain 3 imports it)

```ts
// src/render/ShapeLayer.tsx
import type { Shape, Pt } from "@shared/contracts";
export interface ShapeStyle { stroke: string; halo?: string; fill?: string }
export interface ShapeLayerProps {
  shapes: Shape[];
  visibleSegmentIds: string[];      // shapes whose segment_id is listed are drawn; each animates on (150–300 ms stroke-dashoffset) the first time it appears
  pulseShapeIds?: string[];         // gentle pulse (space-tap "Which part?")
  variant?: "main" | "sidenote";    // sidenote: dashed strokes, distinct accent hue, fades out on resume
  toView: (p: Pt) => Pt;            // shape coordinates → SVG user coordinates
  scale: number;                    // shape units → view px, for radius and label sizes
  styleFor: (shape: Shape) => ShapeStyle; // overlay: adaptive colour from capture pixels; whiteboard: fixed board palette
}
export function ShapeLayer(props: ShapeLayerProps): JSX.Element; // returns an <g>, caller owns the <svg>
// src/render/palette.ts
export function adaptiveStyle(role: ColorRole, sampledBg: {lum: number; hue: number}): ShapeStyle;
export function boardStyle(role: ColorRole, theme: "light" | "dark"): ShapeStyle;
```

## Ownership (who may edit what)

| Path | Owner |
|---|---|
| `shared/*` (except the system prompt) | Orchestrator |
| `shared/tutor_system_prompt.md` | Domain 2 lead |
| `src/windows/brain/**`, `src/core/**` | Domain 2 |
| `src-tauri/src/glass/{capture,keys,tts,stt,shortcuts,debug_server}.rs` | Domain 2 |
| `scripts/**`, `eval/**` | Domain 2 |
| `src/windows/{bubble,overlay,card,settings}/**`, `src/ui/**`, `src/render/**` | Domain 1 |
| `src-tauri/src/glass/windows.rs` | Domain 1 |
| `src/windows/{whiteboard,gizmo}/**`, `gizmos/**` | Domain 3 (imports shapes from `src/render/`) |
| `demo/**` | Orchestrator (agents may add pages under `demo/pages/` when asked) |
| Hotspots: `package.json`, `bun.lock`, `vite.config.ts`, `tsconfig*.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/*`, `src-tauri/src/lib.rs`, `src-tauri/src/glass/mod.rs`, `src/lib/ipc.ts`, `src/lib/sessionMirror.ts` | Scaffold agent until it finishes, then small targeted edits only. Dependencies are added only by domain leads (`bun add x`, one at a time). |

## Build and launch

- Toolchain: `source ~/.zshrc` first (puts rustup's cargo on PATH). The macOS 27 beta SDK breaks the linker; `src-tauri/.cargo/config.toml` pins `SDKROOT` to `MacOSX26.5.sdk`. If you run cargo outside `src-tauri`, export `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`.
- Type check: `bunx tsc --noEmit` (repo root). Rust check: `cd src-tauri && cargo check`.
- Launch: `scripts/dev.sh` (kills any running instance, starts `bun run tauri dev --no-watch` in the background, logs to `/tmp/glass-tutor-dev.log`). Frontend edits hot-reload in the running app; Rust edits need `scripts/dev.sh` again. Only one instance can run, so only domain leads and the orchestrator launch; implementers compile-check and report.
- Drive it headlessly (no microphone, no real screen needed): `scripts/gt-debug.sh capture=/abs/fixture.png question="why is the normal force smaller?"` → hits the dev hook `http://127.0.0.1:47823/debug?...`, which emits `debug:inject` to the brain. `shapes=/abs/canned.json` renders a canned C1 response with no API call. Fixtures live in `demo/fixtures/`.
- Look at the result: `scripts/shot.sh name` → `screencapture -x /tmp/gt-shots/name.png`, then read the PNG. `cliclick` (Homebrew) synthesises clicks and drags.
- Permissions in dev are inherited from the terminal that launched the app (Screen Recording, Microphone, Accessibility).

## Delegation brief template (leads → Haiku implementers)

Goal; exact files to create or edit (and that nothing else may be touched); the contract excerpt they implement (paste it); "NO TESTS — verify with bunx tsc --noEmit / cargo check"; how the lead will launch and what screenshot or behaviour proves it works; report back in under 150 words with what changed and anything unfinished.
