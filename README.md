# Pimple

**A tutor that lives on your screen, explains out loud, draws on top of what you're looking at, and checks your understanding as it teaches.**

Pimple is a small bubble that sits at the edge of your screen. Click it (or point it at part of the screen) and ask a question out loud about whatever you're working on: a physics problem, a chemistry equation, a paragraph of history, a bug in your code. It answers in a few spoken sentences while it circles, underlines and draws arrows and vectors directly on your screen, in sync with each sentence. When it's done, it asks you one question that makes you think, and gives quick feedback on your answer.

You can stop it at any moment. Hold Space to challenge a point mid-sentence and it answers that exact point as a side note, then picks up where it left off. If your screen doesn't show what it needs, it opens a whiteboard and draws from scratch.

Built in four hours at a hackathon, on top of [Handy](https://github.com/cjpais/Handy).

## Features

- **Sees your screen.** Click the bubble to use the whole screen, drag it over a region (scroll to resize the lens), or circle something with a lasso. For a region, the tutor gets the full screen as context plus a sharp crop of what you pointed at.
- **Voice in, voice out.** Offline speech-to-text (Parakeet V3, on-device). The tutor speaks with an ElevenLabs voice (flash model, cached on disk), falling back to the system voice.
- **Draws while it talks.** Circles, boxes, arrows, force vectors with components, strokes, labels and graphs, rendered as animated ink on a click-through overlay. Each sentence's drawings appear while that sentence is spoken. Colours adapt to whatever is underneath.
- **Tightly scoped answers.** Two to four short spoken sentences about exactly what you asked. Off-topic asides are parked in the card for later.
- **Interrupt anything.** Hold Space (or press Interrupt) while it's thinking, talking or checking. Tap Space and it asks "Which part?". The objection is answered as a dashed side note, logged under "Points you questioned", and the explanation resumes. Stop (or Esc) silences it immediately and opens the mic.
- **Checks understanding.** One conceptual check question per explanation, weighted toward the points you questioned, with short feedback on your spoken answer.
- **Grounded and verified.** Every answer cites what on screen it relied on. A fast verifier checks each sentence against the screenshot before it is spoken; a flagged sentence is rewritten once or shown with a badge.
- **Whiteboard.** When the screen doesn't contain what's needed, the tutor draws the explanation from scratch on a whiteboard window.
- **Fast.** About 3 s from question to first spoken word (Claude Opus 5.5 at low effort, streamed, with prompt caching).

## How to use

1. **Ask about anything on screen:** click the bubble. It captures the screen and opens the mic. Ask your question; it answers after about a second of silence.
2. **Point at a region:** drag the bubble over it (scroll to resize the lens) and let go, or circle the target to lasso it. Return captures at once; Esc cancels.
3. **Interrupt:** hold Space while it talks, say what's wrong, and release. Tap Space instead and it asks "Which part?". Stop / Esc makes it stop talking right away.
4. **Answer the check question** out loud. Off-topic questions are parked in the card; click one to ask it later.
5. **No mic or a noisy room?** Type in the card's "Type a question instead…" box. `ctrl + option + space` starts or cancels a session from anywhere. Headphones help, so it doesn't hear itself.

## Architecture

```
            ┌──────────────────────────── Rust (Tauri v2) ────────────────────────────┐
            │ capture.rs   screencapture → JPEG (full display + focus crop), hides    │
            │              our own windows for one frame                              │
            │ stt.rs       Handy's mic + Silero VAD + Parakeet V3 → stt:final         │
            │ tts.rs       ElevenLabs flash / macOS say, disk cache, voices, credit   │
            │ shortcuts.rs session-scoped Space / Return / Esc, ctrl+option+space     │
            │ keys.rs      macOS Keychain (get/set secret)                            │
            └───────────────▲───────────────────────────────┬─────────────────────────┘
                     commands│                               │events
            ┌────────────────┴───────────────────────────────▼─────────────────────────┐
            │ brain (hidden webview): session state machine (zustand)                  │
            │   idle → capturing → listening → thinking → verifying → speaking         │
            │        ⇄ interrupted → checking → idle                                   │
            │   Claude client: Opus 5.5 streaming, structured output, incremental      │
            │   JSON parse → sentences + shapes as they complete; Haiku verifier;      │
            │   Web Audio TTS player (pausable queue, prefetch)                        │
            └───────────────┬──────────────────────────────────▲───────────────────────┘
          session:state snapshot│                              │ui:intent
            ┌───────────────▼──────────────────────────────────┴───────────────────────┐
            │ bubble (glass panel) · overlay (click-through SVG ink) · card (caption,  │
            │ source chip, check question, parked, controls) · whiteboard · settings   │
            └──────────────────────────────────────────────────────────────────────────┘
```

Contracts between the parts (response schema, capture, voice I/O, session snapshot, intents) live in `shared/contracts.ts`; the tutor's response schema is `shared/tutor_response.schema.json` and its system prompt is `shared/tutor_system_prompt.md`. More detail in `docs/ARCHITECTURE.md`.

## Install (download)

1. Download **Pimple_0.1.0_aarch64.dmg** (or **Pimple.app.zip**) from the [Releases](../../releases) page. Apple Silicon Macs (tested on macOS 26).
2. Open the dmg and drag **Pimple** into **Applications**.
3. The first time, right-click Pimple in Applications and choose **Open**, then **Open** again. The build is ad-hoc signed and not notarized, so macOS asks once. If macOS says the app is damaged, run:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Pimple.app
   ```
4. Pimple lives in the menu bar (no Dock icon). On first launch it opens a short setup:
   - your **Anthropic API key** (required; get one at console.anthropic.com);
   - an optional **ElevenLabs API key** (from elevenlabs.io; without it Pimple uses the Mac voice), then a voice;
   - the macOS permissions it needs: **Screen Recording**, **Microphone** and **Accessibility**.
   Keys are checked with one quick request and stored only in your macOS Keychain. They never leave your Mac except to call those APIs, and never live in this repo.
5. The speech model (about 700 MB) downloads in the background on first launch. Then click the bubble and ask.

## Setup (from source)

### macOS

Requirements: Apple Silicon, [Rust](https://rustup.rs), [Bun](https://bun.sh), and Xcode Command Line Tools.

```bash
bun install
bun run tauri dev          # or scripts/dev.sh (logs to /tmp/glass-tutor-dev.log)
```

**API keys are never stored in the repo.** On first run Pimple opens its setup screen (or use the menu-bar icon → Keys… later; "Reset keys" clears them) and asks for:

- an Anthropic API key (required);
- an ElevenLabs API key and optionally a voice ID (optional; without them the macOS voice is used).

They are saved in the macOS Keychain (service `glass-tutor.*`, account `glass-tutor`; internal identifiers keep the original working name "Glass Tutor"). `GT_TTS=say` or `GT_TTS=off` forces the free macOS voice or silence, which is useful while developing.

macOS will ask once for **Screen Recording** (to see the screen), **Microphone** (to hear you) and **Accessibility** (for the Space-bar shortcut). The speech model (Parakeet V3, about 700 MB) downloads on first launch.

### Windows

Install Rust with the MSVC toolchain, Bun, CMake, Microsoft C++ Build Tools with the **Desktop development with C++** workload, and Edge WebView2 Runtime.

```powershell
bun install --frozen-lockfile
bun run tauri build --no-bundle
Copy-Item -LiteralPath src-tauri\resources -Destination src-tauri\target\release -Recurse -Force
```

Launch `src-tauri\target\release\glass-tutor.exe` from its build directory. Pimple lives in the system tray. Enter an Anthropic API key in setup and allow microphone access for desktop apps if you want to speak your questions. Windows Credential Manager stores the keys, and the Windows voice works without an ElevenLabs key. The bubble and card use a frosted effect on Windows. Press `Ctrl+Alt+Space` to start a session.

## Build

```bash
scripts/build-release.sh   # bun run tauri build --bundles app,dmg → dist/release/
```

The release app is ad-hoc signed; macOS treats it as a separate app for permissions, so grant them again for the built app.

## Evaluation

`bun eval/run_eval.ts` measures the hallucination rate (unsupported or contradicted claims, judged by Claude against a reference) with the verifier on and off, using the same prompt and schema as the app. See `eval/README.md`. It spends API credit, so run it by hand.

## Credits

- Forked from **[Handy](https://github.com/cjpais/Handy)** by CJ Pais (MIT): offline speech-to-text, VAD, global shortcuts and the macOS panel plumbing.
- Tutoring, vision, verification and diagrams by **Claude** (Anthropic): Opus 5.5 for the tutor, Haiku 5.5 for the verifier.
- Voice by **ElevenLabs** (eleven_flash_v2_5).
- Speech recognition: NVIDIA Parakeet V3; voice activity detection: Silero VAD.

## License

MIT. See [LICENSE](LICENSE). Includes Handy, © 2025 CJ Pais.
