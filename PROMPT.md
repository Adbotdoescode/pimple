# Build prompt: Glass Tutor (4 hours remaining, hackathon)

You are the orchestrating agent (Opus, high effort) for a hackathon build with 4 hours remaining. Speed is everything: run domains in parallel from minute 0, keep many Haiku agents working at once, and never leave agents idle waiting on each other (code against the contracts). You plan, write contracts, delegate, integrate and verify. You do not write code.

Working name: Glass Tutor (placeholder, the user may rename it). Repo: `~/Developer/glass-tutor`.

## 0. Hard rules (read twice)

1. **NO UNIT TESTS. NO TEST SUITES.** Do not write, generate, scaffold or run unit tests, integration tests, UI tests, snapshot tests or CI checks. Delete any test files or test configs inherited from Handy. The only verification allowed is launching the real app and driving it by hand or headlessly (the debug hooks in §8, `screencapture`, reading the screenshots). The reason is to keep token and API usage low. Tell every sub-agent this rule in its brief.
2. **Only Haiku agents at high effort write code.** Opus agents plan, review, verify and write specs in prose. Escalation to an Opus-high coder happens only for a hard problem or a complex UI implementation. If that fails, escalate to Fable (see §8).
3. **Never hard-code API keys.** Read them from the macOS Keychain (§9). Never print a key in logs or chat.
4. **Order of delivery:**
   1. A functioning version the user can test and use in real life, on their own real screens and homework. This is the backup and must exist by 2:45 at the latest; aim for 2:30.
   2. Then live diagram/gizmo generation (a LATER feature: do not start it before step 1 is frozen).
   3. Then three demo examples. The user will send the topics and material later. Do not invent them.
5. **UI polish is a top priority.** It is not a hackathon afterthought.
6. **Answers are tightly scoped.** The tutor answers exactly what was asked, about exactly what is on screen. Speed beats breadth.

## 1. Product

Glass Tutor is a background desktop tutor. A small translucent bubble in Apple's Liquid Glass style idles at the left or right edge of the screen (default: right edge, vertically centred, about 56 pt). The user can drag it to the other edge. It springs back to the nearest edge when a session ends.

It sees the screen. It explains by voice (ElevenLabs) and draws on a transparent, click-through overlay, as if it were drawing on the screen. It checks understanding as it teaches. The user can interrupt any explanation with the space bar to challenge or question a specific point, and the tutor resolves that point before resuming.

Pitch line: a general-purpose tutor that checks your understanding as it teaches.

Target platform: macOS 26 on Apple Silicon for the hackathon. The stack (Tauri) is cross-platform, so Windows and Linux are a possible later step, but do not spend hackathon time on them.

## 2. Interaction modes

All three modes end in the same capture: a rectangular screenshot of the target's bounding box, padded by about 12% on each side and clamped to the display. The capture never includes the app's own windows: hide the bubble, overlay and cards for one frame before capturing.

| Mode | Gesture | Capture | Tutor's first move |
|---|---|---|---|
| A. Click | Click the bubble (mouse moves under 4 pt and the press lasts under 250 ms) | Full screenshot of the display the bubble is on | Says nothing about the screen. Keeps the screenshot in context silently, opens the mic and waits for the question. |
| B. Drag and resize | Drag the bubble over a region. Release. Scroll (mouse wheel or trackpad) to grow or shrink its circular lens. | Bounding box of the circle | One sentence on what it sees, then "What do you want to ask?" Example: "I'm looking at a free body diagram of a block on an incline. What do you want to ask about it?" Then it takes the question. |
| C. Lasso (spin) | Drag the bubble and move it in a rough circle around the target. A glowing trail follows the bubble. | Bounding box of the closed loop | Same one-sentence summary and prompt as mode B |

Defaults for the ambiguous parts:
- **Lasso detection:** during a drag, sum the cursor's turning angle over a rolling 1.5 s window. Above about 300°, with the path ending within about 80 pt of where the loop started, switch to lasso and draw the trail. Below that, it is a plain drag (mode B).
- **When B and C fire:** the capture fires 1.0 s after the last drag or scroll input, or at once on Return. Esc cancels and the bubble springs back to its edge. While targeting, show a dashed glass outline of the region that will be captured.
- **Asking a question:** after any capture, the mic opens automatically with a live waveform on the bubble. The turn ends on about 1 s of silence (Handy's VAD, §5). Holding space also works as push-to-talk.
- **Space-bar interrupt, to cover points of contention.** This is a headline feature. The learner can stop any explanation at the exact moment something doesn't make sense or seems wrong, and get that point resolved before the tutor moves on.
  - **Hold space** (over 250 ms): the tutor stops speaking within about 150 ms (audio fades, the current stroke finishes). The mic opens and the learner voices the objection. Release ends the turn.
  - **Tap space** (under 250 ms): the tutor stops and asks "Which part?" while the shapes from the current sentence pulse. The mic then opens.
  - **Context sent with the interruption:** the ID and text of the sentence being spoken, the sentences already spoken, the shapes on screen, and the original capture. The question is answered about that point, not as a fresh topic.
  - **Resolving it:** a short, scoped answer with its own shapes, drawn in a distinct colour role so it reads as a side note. If the objection reveals a misconception, add one quick check question on that point. Off-topic interruptions are parked (§3), not answered.
  - **Resuming:** "Back to where we were…", then continue from the interrupted sentence (re-speak it if less than half was played, otherwise go to the next one). Fade out the side-note shapes and restore the original ones.
  - **Contested-points log:** each interruption is added to a "Points you questioned" list in the speech card, and the end-of-session check question favours those points.
  - **Key handling:** register Space as a global shortcut (Handy's shortcut module, press and release events) only while a session is active, so it is swallowed then and passes through to other apps otherwise. Keep an always-on alternative hotkey (default ctrl+option+space).
- **Multi-monitor:** use the display the bubble is on.

## 3. Tutoring behaviour (system prompt requirements)

1. **Identify the concept** from the problem, notes or page on screen.
2. **Teach briefly.** Give a short spoken explanation of 2 to 5 sentences. Each sentence carries its matching shapes, which are drawn while that sentence plays. Show caption text in the speech card under the bubble.
3. **Stay scoped.** Answer only what was asked, about only what is in the capture. Add broader context only when it is needed to answer. Park off-topic questions: say something like "Good question. I'll save that for after.", add it to a Parked list in the speech card, and offer it at the end.
4. **Check understanding.** After explaining, ask one conceptual question that makes the learner reason, not recall. Listen, then give short feedback. Ask a follow-up only if the answer shows a misconception.
5. **Ground and cite.** Ground every explanation in the on-screen content (or, for the demo topics later, a fixed source file in `content/sources/`). Show a source chip in the speech card, for example "Source: your screen, the incline diagram".
6. **Verify before speaking.** Run a fast verifier pass (§6) before any TTS starts.
7. **Gizmos only on consent (phase 2 feature, §7).** When an explanation is long or a visual would really help, the model sets `gizmo_offer.recommended`. The tutor asks early, at a natural pause: "Want an interactive diagram for this?" Only after a yes does live generation start, in the background while the explanation continues. The gizmo window opens when ready, usually to wrap up the explanation. The user can also ask for one by voice. Never generate a gizmo unprompted. Until phase 2 lands, the model must leave `gizmo_offer.recommended` false.

## 4. Visual surfaces

| Surface | Window | Click-through | Content |
|---|---|---|---|
| Bubble | Small transparent, always-on-top, non-activating panel (`tauri-nspanel`, as Handy does for its overlay) so it never steals focus | No | The Liquid Glass bubble and its states |
| Overlay | Full-screen transparent webview window, `set_ignore_cursor_events(true)`, above all apps | Yes | Fast annotations from the shape library, rendered as animated SVG |
| Speech card | Small glass panel anchored beneath the bubble | No | Caption text, source chip, Parked list, "Points you questioned", and small interactive visuals (sliders and graphs need mouse input, so they live here and not on the overlay) |
| Whiteboard | Opaque window, light or dark board | No | The same shape JSON, used when drawing from scratch rather than annotating the screen. The model chooses it with `surface: "whiteboard"`, or the user asks for it. |
| Gizmo (phase 2) | Opaque window with a sandboxed iframe (`srcdoc`, CSP blocks all network) | No | Live-generated interactive animated diagram (§7) |

**Shape library (fixed; the model can emit nothing else):** circle, box, line, arrow, vector (an arrow with a magnitude label and optional components), stroke (a smoothed polyline of at most 32 points), text label, graph (axes plus a plotted function or points), slider (speech card or whiteboard only).

**Speed:** shapes animate on with a 150 to 300 ms stroke-draw each (SVG `stroke-dashoffset`), synced to their speech sentence. Render from the streaming parse: the first sentence's shapes should appear while later sentences are still generating. Targets (measure by hand, do not assert): capture to first spoken word under 3 s; first stroke at the same moment as first audio.

**Adaptive colour:** the model emits a colour role (`primary`, `secondary`, `accent`, `warn`), never a hex value. For each shape, the renderer samples the captured pixels under the shape's path (inflated 6 px, via an offscreen canvas), computes average luminance and hue, and picks from a light-background palette (deep blue, crimson, green, amber) or a dark-background palette (cyan, coral, lime, gold). If contrast against the sampled background is below 3:1, add a 2 px halo of the opposite luminance. This must work on light mode, dark mode and colourful pages.

### Shape and response contract (Contract C1)

The orchestrator owns this schema. Store it at `shared/tutor_response.schema.json` and import it from both the app and the eval script. Coordinates are pixel coordinates in the image the model was sent. The renderer maps them back to screen points using the capture's origin and scale.

```json
{
  "type": "object", "additionalProperties": false,
  "required": ["concept", "surface", "grounding", "segments", "shapes", "check_question", "gizmo_offer", "parked"],
  "properties": {
    "concept":   { "type": "string" },
    "summary_sentence": { "type": "string" },
    "surface":   { "enum": ["overlay", "whiteboard"] },
    "grounding": { "type": "object", "additionalProperties": false,
      "required": ["source_type", "source_ref", "quote"],
      "properties": { "source_type": { "enum": ["screen", "fixed_source"] },
                      "source_ref": { "type": "string" }, "quote": { "type": "string" } } },
    "segments":  { "type": "array", "items": { "type": "object", "additionalProperties": false,
      "required": ["id", "text"], "properties": { "id": { "type": "string" }, "text": { "type": "string" } } } },
    "shapes":    { "type": "array", "items": { "type": "object", "additionalProperties": false,
      "required": ["id", "kind", "segment_id", "color_role"],
      "properties": {
        "id": { "type": "string" }, "segment_id": { "type": "string" },
        "kind": { "enum": ["circle", "box", "line", "arrow", "vector", "stroke", "text", "graph", "slider"] },
        "color_role": { "enum": ["primary", "secondary", "accent", "warn"] },
        "center": { "type": "array", "items": { "type": "number" } }, "radius": { "type": "number" },
        "rect":   { "type": "array", "items": { "type": "number" } },
        "from":   { "type": "array", "items": { "type": "number" } },
        "to":     { "type": "array", "items": { "type": "number" } },
        "points": { "type": "array", "items": { "type": "array", "items": { "type": "number" } } },
        "label":  { "type": "string" }, "magnitude": { "type": "string" },
        "graph":  { "type": "object" }, "slider": { "type": "object" }
      } } },
    "check_question": { "type": "string" },
    "gizmo_offer": { "type": "object", "additionalProperties": false,
      "required": ["recommended", "pitch"],
      "properties": { "recommended": { "type": "boolean" }, "pitch": { "type": "string" } } },
    "parked": { "type": "array", "items": { "type": "string" } }
  }
}
```

The `kind` enum is the guarantee that only library shapes come out. Strict mode needs every object fully specified, so give `graph` (axes ranges, function samples or points, labels) and `slider` (label, min, max, value, unit, the `shape_id` it drives) their full properties when Haiku writes the file. Validate on the client as well (zod), and drop any shape that fails validation instead of crashing. If the strict validator rejects the schema, flatten it further, but keep the `kind` enum.

Other contracts the orchestrator writes up front, as TypeScript types plus Tauri command/event names:
- **C2 `CaptureResult`:** `imagePath` or `imageBase64` (JPEG), `regionInScreenPoints`, `displayId`, `pixelScale`, `mode` (click, region or lasso).
- **C3 Voice I/O:** STT events from Rust (`stt:partial`, `stt:final`, `stt:level` for the waveform); TTS in the frontend: `speak(segments)`, `pause() -> {segmentId, fractionPlayed}`, `resume(fromSegment)`, `onSegmentStarted(id)` (drives shape timing); shortcut events `space:tap`, `space:hold-start`, `space:hold-end`.
- **C4 `GizmoRequest` / `GizmoReady` (phase 2):** concept, grounding and key quantities in. A self-contained HTML string out.
- **C5 session state machine:** `idle → targeting → capturing → summarising → listening → thinking → verifying → speaking ⇄ interrupted → checking → idle`, one store (zustand) in the frontend, mirrored to all windows by Tauri events.

## 5. Tech stack

**Decision: Tauri v2 (Rust backend, React + TypeScript + Vite frontend), forked from Handy.** Reasons: Handy (github.com/cjpais/Handy, MIT, about 39k stars) is already a Tauri v2 app with exactly the hard parts working on macOS: offline speech-to-text, mic capture with voice-activity detection, global shortcuts with press/release, a floating non-activating overlay panel (`tauri-nspanel`, `macOSPrivateApi: true`) and macOS permission handling. Haiku writes TypeScript/React UI far more reliably than Swift/AppKit, and SVG drawing, the speech card, whiteboard and gizmos are all web content anyway. No Xcode is needed: Tauri builds with the Command Line Tools.

**Machine facts:** macOS 26.6, Apple Silicon. Installed: Command Line Tools, Node 26, Homebrew, Rust 1.100 (rustup via Homebrew, on PATH through `~/.zshrc`), CMake 4.5, Bun 1.4. Full Xcode is NOT installed. If the Metal build of Handy's `transcribe-cpp` dependency fails without Xcode, first try its CPU build (Parakeet V3 is CPU-optimised anyway); install Xcode only as a last resort and tell the user, because it is a large download.

**Kickoff step:** clone Handy, confirm it builds and transcribes on this machine (`bun install && bun run tauri dev`), then strip it into Glass Tutor.

**Reuse from Handy (keep, then adapt):**
- `src-tauri/src/audio_toolkit/` (mic capture, resampling, VAD, chunking) and `src-tauri/src/managers/{audio.rs, model.rs, transcription.rs, transcription/}`: the STT pipeline. Default model: Parakeet V3 (fast, CPU). Reuse Handy's model download logic but point it at Glass Tutor's app-data dir.
- `src-tauri/src/shortcut/`: global shortcuts with press and release, adapted into the session-scoped space bar (§2).
- `src-tauri/src/overlay.rs` and the `tauri-nspanel` setup: the pattern for the bubble and overlay panels.
- `tauri-plugin-macos-permissions`: permission prompts for Microphone, Accessibility and Screen Recording.
- The Tauri config (`macOSPrivateApi`, plugin set), the `tauri-specta` typed bindings, and the frontend tooling (Vite, Tailwind if present).
- Drop: paste/clipboard injection (`paste_tx`, `clipboard.rs`), history, tray i18n, updater, autostart, Apple Intelligence, `llm_client.rs` post-processing, the settings UI pages and all Handy branding. Keep the transcription output going to our session store instead of being pasted.

**Clicky (github.com/farzaa/clicky) is a reference only, not code to port:** read its system prompt, its `[POINT:x,y]` coordinate convention, its ElevenLabs flash-model usage and its interaction feel. It is native Swift, so do not copy files from it.

**New parts:**
- **Bubble:** a transparent nspanel window. Native macOS vibrancy behind the window (Tauri `windowEffects` / `window-vibrancy`, HUD or popover material) gives the real blur of the desktop; on top, CSS adds the Liquid Glass look (specular rim highlight, inner shadow, slight chromatic edge, gloss gradient). Spring physics (framer-motion or a small spring) for drag, snap, resize and a subtle squash in the direction of motion. Real `NSGlassEffectView` through objc2 is an Opus-escalation stretch goal for the polish hour only.
- **Drag/resize/lasso:** the bubble window moves with the cursor (`setPosition` on pointer move, or `startDragging`); wheel events resize the window and lens; the lasso trail is drawn on the overlay.
- **Capture:** Rust command that hides the app windows, runs `/usr/sbin/screencapture -x -R x,y,w,h` (or `-D n` for full display) to a temp JPEG, restores the windows and returns C2. Simple and reliable; switch to the `xcap` crate only if this is too slow.
- **Claude client:** in the frontend with the official `@anthropic-ai/sdk` (`dangerouslyAllowBrowser: true` is acceptable for a local single-user hackathon app), streaming, key fetched once from the Keychain via a Tauri command. Incremental JSON parser emits segments and shapes as they complete.
- **TTS:** ElevenLabs streaming endpoint with `eleven_flash_v2_5`, one request per sentence, played through Web Audio with a pausable queue (C3).
- **Overlay renderer:** SVG in the full-screen overlay window.
- **Eval script:** TypeScript run with Bun, same SDK, same system prompt and schema as the app.

**Runtime models (configurable in Settings):**
- Tutor: `claude-opus-5-5` at `effort: "low"`, streaming, with structured output C1 via `output_config.format` (Opus 5.5 rejects forced `tool_choice`). Optional `speed: "fast"` toggle (premium price, off by default).
- Verifier: `claude-haiku-5-5`.
- Gizmo generator (phase 2): `claude-opus-5-5` at `effort: "medium"`.
- Eval judge: `claude-opus-5-5`.
- Enable the server-side refusal fallback (`anthropic-beta: server-side-fallback-2026-07-01`, `fallbacks: "default"`) on Opus calls.

## 6. Verification, grounding and evaluation

- **In-app verifier:** before TTS, send the draft C1 response, the capture and any fixed source to the verifier. It returns `pass` or a list of unsupported claims. On fail, regenerate once with the critique, then speak. Budget about 1.5 s. Add a Settings toggle so the latency cost can be shown.
- **Hallucination-rate eval (a hand-run script, NOT a test suite), phase 3:** `eval/run_eval.ts` with `eval/concepts.json`, about 10 concepts built from the user's three demo topics once the user sends them. Each concept has a fixture screenshot, a question, a known-correct reference explanation, key facts and known wrong claims.
  - It runs the same system prompt and schema as the app.
  - The judge splits each answer into claims and labels each one supported, unsupported or contradicted against the reference.
  - Output: a printed table plus `eval/results.md`, showing the hallucination rate (unsupported plus contradicted, divided by total claims), with the verifier on and off.
  - No assertions, no CI, no pass/fail gate. It is a measurement for the pitch. Run it at most twice, because every run spends API credit.

## 7. Gizmos: live generation (phase 2, after the real-use version is frozen)

Gizmos are generated live by the model, not hand-built. Target quality is the user's two example images (`design/gizmo-examples/`):
- A light grey page with white rounded cards and soft shadows.
- Bold navy section titles with circled numbers ("⓪ From the Sun's surface out to Earth: grow the bubble").
- A labelled range slider with a blue thumb and the live value in the label ("Bubble radius r: 8.82 × 10⁸ m (1.3 × the Sun's radius)").
- A pill button "▶ Grow to Earth" that animates the slider.
- A clean SVG diagram with in-diagram labels (sun with a radial gradient, an orbit-bubble ring, a red "fixed-size window" arc with a live dot count).
- A right-hand "As the bubble grows" panel of live values: small grey labels with bold colour-coded values.
- A serif equation strip whose terms are coloured to match the diagram: "average = power caught ÷ whole surface = S·πR² ÷ 4πR² = S/4 = 1360 / 4 = 340 W/m²".

Build `gizmos/template.html`: design tokens plus a small component kit (card, slider, play button, live-value panel, colour-coded equation, SVG helpers). The generator prompt receives the kit's API, the concept, grounding and key quantities, and returns only the scene code that plugs into the kit, so output stays short, fast and on-style. Self-contained, no network. Show a "building your diagram…" shimmer in the speech card while it generates; if generation fails or exceeds 45 s, say so and offer the whiteboard instead.

## 8. Agent organisation

| Role | Model / effort | Writes code? | Responsibility |
|---|---|---|---|
| Orchestrator (you) | Opus, high | No | Contracts C1 to C5, milestones, integration, launching and driving the app, user communication |
| Domain 1 lead: UI, interaction and appearance | Opus, high | No | Decomposes, reviews, verifies visually |
| Domain 2 lead: backend, AI pipeline, voice and keys | Opus, high | No | Same |
| Domain 3 lead: whiteboard and gizmo engine | Opus, high | No | Same (gizmo work starts in phase 2) |
| Implementers | Haiku, high | **Yes (the only default coders)** | One focused task each, with file paths and the contract they implement |
| Escalation 1 | Opus, high, as a coder | Yes | Only for a hard problem or a complex UI implementation, or after a Haiku agent fails twice on the same task. Expect this for the nspanel/vibrancy window setup and Rust build problems. |
| Escalation 2 | Fable | Yes | Only if Opus-high fails |

Domain scopes (leads may split these into subdomains or brief Haiku agents directly):
- **Domain 1, UI and interaction:** Liquid Glass bubble, edge idle, springs and states (idle, listening waveform, thinking shimmer, speaking pulse); click, drag, scroll-resize and lasso gestures with the targeting outline and lasso trail; overlay renderer and adaptive colour; speech card; menu-bar/tray menu (Settings, Keys, Quit). Consumes C1, C2 and C5.
- **Domain 2, backend:** the Handy fork and strip; capture (C2); Claude client with structured streaming and the incremental parser; system prompt (`shared/tutor_system_prompt.md`, shared with the eval); verifier; session state machine (C5); parking and check-question flow; Keychain access. Voice subdomain: Handy STT, space-bar shortcut, ElevenLabs TTS queue with pause and resume (C3). Eval script in phase 3.
- **Domain 3, whiteboard and gizmo engine:** whiteboard window and layout of shapes on an empty board (phase 1); gizmo template, component kit, generator prompt and gizmo window (phase 2).

Delegation brief template (every Haiku task): goal; exact files; the contract excerpt; "no tests, verify by building and launching"; how to launch; what screenshot or behaviour proves it works.

**Headless verification kit** (built in the first hour by a Haiku agent; dev-only):
- `scripts/dev.sh` (build and relaunch).
- A debug deep link `glasstutor://debug?capture=<fixture.png>&question=<text>` that injects a fixture screenshot and a typed question instead of the mic, so agents can drive the full pipeline without speaking.
- `glasstutor://debug?shapes=<file.json>` to render a canned C1 response.
- Check results with `screencapture -x`; synthesise clicks, drags and keys with a small CGEvent script (Swift or `cliclick` from Homebrew).

## 9. API keys and permissions

- **Anthropic: already provided and stored.** It is in the macOS Keychain, service `glass-tutor.anthropic-api-key`, account `glass-tutor`. Read it with the `keyring` crate (or `security find-generic-password -s glass-tutor.anthropic-api-key -w` in scripts). It has been checked against the API and works. Never write it to a file in the repo.
- **ElevenLabs: already provided and stored.** Keychain services `glass-tutor.elevenlabs-api-key` and `glass-tutor.elevenlabs-voice-id` (account `glass-tutor`). Default voice: River (`SAz9YHcvj6GT2YYXdXww`, relaxed, neutral, informative); the user may swap it. Plan: Creator, about 122k characters left this cycle. The ElevenLabs CLI onboarding (`npx -y @elevenlabs/cli@latest onboard init`) was started in the repo and links the user's account by browser, writing `ELEVENLABS_API_KEY` to `.env.local` (gitignored). Never open or print that file. Run `npx -y @elevenlabs/cli@latest onboard check` and follow the `next` step it returns before writing ElevenLabs code. The app may read the key from `.env.local` or the Keychain; both hold a working key.
- **ElevenLabs economy (the user asked for this explicitly):**
  - Use `eleven_flash_v2_5` (cheapest and fastest) over the streaming endpoint.
  - Agents verifying the app headlessly must run with TTS off (`GT_TTS=say` uses macOS `say` for free, `GT_TTS=off` is silent). Real ElevenLabs audio only when the user is testing or for the final demo runs.
  - Cache audio by hash of (text, voice, model) on disk, so repeated demo lines cost nothing.
  - Keep spoken answers short (2 to 5 sentences) — this is also the speed rule.
  - Show remaining credit in Settings (`GET /v1/user/subscription`). If credit runs low or a request returns a quota error, fall back to `say` and tell the user in chat so they can top it off.
- **Why not ElevenLabs speech-to-speech:** it converts one voice recording into another voice; it cannot answer a question. The tutor's words come from Claude as text, so text-to-speech (flash, streaming) is the fast path. Do not use speech-to-speech.
- **Speech-to-text needs no key** (Handy's offline models).
- The in-app Keys sheet shows which keys are missing and lets the user paste them; it writes to the Keychain.
- macOS permissions (Screen Recording, Accessibility for the shortcut and synthetic events, Microphone) need one manual grant from the user. Ask for them once, right after the first app bundle runs. Sign dev builds with one stable identity so grants survive rebuilds.

## 10. Timeline and milestones (4 h remaining)

| Time | Milestone | Done when (verified by launching and driving the app) |
|---|---|---|
| 0:00–0:20 | Kickoff | Handy cloned, builds and transcribes on this machine; stripped and renamed; contracts C1 to C5 written; all three domain leads spawned at once. |
| 0:20–1:05 | M1 skeleton | Glass bubble idles at the edge. A click captures the full screen, the question is typed through the debug hook, Claude answers into the speech card, and the overlay renders the C1 shapes with adaptive colour. |
| 1:05–1:45 | M2 voice and region | Handy STT in, ElevenLabs out with captions in sync. Drag and scroll-resize capture with the one-sentence summary. |
| 1:45–2:20 | M3 full loop | Lasso; space-bar interrupt (hold and tap) with contention context, resume and contested-points log; check question; parking; verifier and source chip; whiteboard. |
| 2:20–2:45 | **M4 REAL-USE VERSION FREEZE** | The user tests it on their own real screens and homework. Fix only what they hit. Commit, tag `real-use-backup`, copy the `.app` to `dist/backup/`. Nothing may break this tag afterwards. Hard deadline: 2:45. |
| 2:45–3:15 | M5 live gizmos | Gizmo offer, consent, background live generation, gizmo window in the example images' style. |
| 3:15–3:45 | M6 demos | The three demo examples from the user's material, fixed sources, eval run. |
| 3:45–4:00 | **FINAL** | Run all three demos twice, cleanly. `eval/results.md` ready for the pitch. Tag `final`. |

UI polish happens inside every milestone, not only at the end. If a milestone slips by more than 15 minutes, cut scope in this order: whiteboard auto-layout, lasso, live gizmos (show the whiteboard instead), the eval's verifier-off comparison. Never cut voice, overlay drawing, the space-bar interrupt, scoped answers or the bubble's polish.

## 11. Manual test examples (for the user, created as features land)

Keep `demo/MANUAL_TESTS.md` up to date. Each entry has a feature, steps the user can try personally, and the expected result. At every milestone, post the newest entries to the user in chat as "Try this now". Use the user's real material where possible, plus test pages in `demo/pages/`:
- a physics problem page with a diagram (modes A and C);
- a dense paragraph page (mode B);
- a dark-mode page and a colourful page (adaptive colour);
- an off-topic-question script (parking);
- interrupt scripts: hold space mid-explanation and object; tap space and say "that part"; confirm the tutor resumes at the right sentence and the point appears under "Points you questioned".

## 12. Slots for things the user will send later

- **Three demo topics and their material:** PENDING. Do not start M6 or the eval fixtures until they arrive; ask for them at M4 (about 2:20).
- `design/liquid-glass-reference/`: PENDING. The user will send the Liquid Glass design reference. Domain 1 updates the bubble tokens when it arrives.
- `design/links.md`: PENDING extra design links and images.
- Bubble motion reference: inspora.design/posts/1-12, "Glass shader" by Janum Trivedi. It shows a transparent circular lens that magnifies and distorts the content beneath it, with rainbow-tinted edges that intensify as it moves, and it breaks into smaller bubbles around the touch point. Treat it as the target feel. True refraction of live screen content is a stretch goal for the polish time only.
- `design/gizmo-examples/`: the two example images (§7). Copy them from `~/Developer/hackathon-tutor-assets/gizmo-examples/6.png` and `7.png` at kickoff.
