# Prompt: make the Pimple demo video

Copy everything below the line into a fresh agent (Fable or another capable AI agent) running on the same Mac, in the repo `~/Developer/glass-tutor`.

---

You are producing the demo video for Pimple, a hackathon project being submitted to Devpost. Your deliverable is a finished, polished product video built from REAL footage of the real app. Nothing in the video may be faked, mocked up or simulated: every feature shown must be recorded from the running app.

THE PRODUCT

Pimple is a background desktop tutor for macOS. A small translucent bubble in Apple's Liquid Glass style rests on the edge of the screen like a droplet of condensed water. It sees your screen, explains by voice, and draws on top of whatever you are looking at (your homework, a PDF, a web page), as if a teacher were drawing on your screen. It checks your understanding as it teaches.

Pitch line: "A general-purpose tutor that checks your understanding as it teaches."

Features to show, in rough priority order:
1. The liquid bubble. A live glass lens that magnifies and refracts the content under it, with rainbow-tinted edges that intensify as it moves. It jiggles like a soft body when dragged or hovered, and it merges back into the screen edge like a water droplet.
2. Three ways to ask:
   a. Click the bubble: it looks at the whole screen and listens.
   b. Drag the bubble over a region: the lens grows with a scroll.
   c. Circle a target with the bubble (lasso): a glowing rainbow trail follows it.
   In b and c the circled area is the focus, and the full page is still used as context.
3. Voice in, voice out. You just ask out loud. It answers in a natural ElevenLabs voice, and a caption card shows the words in sync.
4. Live drawing on your real screen. Hand-drawn ink arrows, circles, underlines and labels appear sentence by sentence while it speaks: varying line weight, a pencil tip tracing each stroke, a glass pill behind every label. Colours adapt automatically to light pages, dark pages and colourful pages.
5. Interrupt at any moment, the headline feature. Tap or hold space mid-explanation to object ("wait, why is that sin and not cos?"). It stops within a fraction of a second, resolves that exact point as a side note in a different style, says "Back to where we were…" and resumes from the right sentence. The point is logged under "Points you questioned".
6. It checks understanding: after explaining, it asks one question that makes you reason, listens, and gives short feedback.
7. It stays scoped: it answers exactly what was asked. An off-topic question is parked ("Good question, I'll save that for after.") and appears in a Parked list.
8. It is grounded and verified: every answer cites its source ("Source: your screen — Figure 4.3"), and a second model verifies each sentence before it is spoken (the "Verified" badge).
9. Whiteboard fallback: if the screen does not contain what is needed, a glass whiteboard opens and it draws from scratch.
10. Subtle signs that it is active: a thin rainbow glow around the screen border while it listens and talks. Plus Stop (shut up now), minimise and close on the card, and an app window to choose the voice and the bubble's position.

Tech, for one short "how it's built" beat:
- Tauri v2 (Rust + React), forked from the open-source dictation app Handy.
- Offline speech-to-text (Parakeet V3).
- Claude Opus 5.5 with structured output streams the explanation and the drawing instructions together; Claude Haiku 5.5 verifies each sentence.
- ElevenLabs Flash v2.5 for the voice.
- Measured latency: about 3 seconds from question to first spoken word.

TARGET

A 2:00–2:45 video, 1920×1080 or 2560×1440, 30 or 60 fps, H.264 MP4 suitable for YouTube and Devpost. Also deliver a 30-second cut for social media and a thumbnail PNG.

Tone: calm, confident and premium, like an Apple keynote feature segment. Fast-paced, with no dead air. Show, don't tell.

STRUCTURE (adjust timings as needed)
- 0:00–0:08 Hook. A student stares at a hard homework problem. The liquid bubble glides along the screen edge, catching the light. Title card: "Pimple".
- 0:08–0:35 Ask and see. Drag the bubble over the problem and ask out loud. The tutor answers by voice while ink arrows and labels draw themselves onto the actual diagram in sync. The caption card shows the words.
- 0:35–1:05 The headline: interrupt. Mid-explanation, hold space and object. It stops instantly, answers the objection as a side note, says "Back to where we were…" and resumes. Cut to the "Points you questioned" list.
- 1:05–1:25 It checks understanding. The check question, a spoken answer, and short feedback.
- 1:25–1:45 Range. Quick montage: a dark-mode page (colours adapt), a code bug, a chemistry equation, a lasso circle, a question the screen can't answer opening the whiteboard, an off-topic question being parked.
- 1:45–2:10 Trust and speed. Source chip, Verified badge, "~3 s to first word", one architecture slide (glass style).
- 2:10–2:30 Close. The bubble settles into the screen edge as a droplet; the pitch line; the GitHub/Devpost URL.

DEMO MATERIAL

The user will supply three demo topics and their material. Look in `content/sources/` and `demo/` for them, or ask the user. Until they arrive, use the ready-made pages in `demo/pages/`:
- `incline.html`: a physics free-body diagram.
- `dense-paragraph.html`: economics.
- `dark-equation.html`: a dark-mode page.
- `colourful.html`
- `calculus.html`, `chemistry.html`, `history.html` and `code.html`

Serve them at `http://localhost:1420/demo/pages/<name>.html` while the dev server runs, and open them full screen in Safari.

HOW TO RECORD (real footage only)
- Launch the app: `scripts/dev.sh`, with `GT_TTS=elevenlabs` for final takes. ElevenLabs credit is limited, so rehearse with `GT_TTS=say` and record final takes only once each scene works. Spoken lines are cached on disk, so a repeated take of the same answer costs nothing.
- Record the screen with `screencapture -v -V <seconds> -k <file>.mov` (`-k` shows clicks) or QuickTime. Record system audio so the tutor's voice is captured. If system audio capture is not available, record the voice separately and sync it in the edit. Hide the Dock and desktop clutter, and use a clean wallpaper and a clean browser window.
- For scenes the human must perform (speaking, pressing space, dragging the bubble), write a precise shot list with exact lines to say, and coach the user through each take. Drive the rest headlessly where that helps repeatability: `scripts/gt-debug.sh capture=<png> question="<text>"` injects a screenshot and a typed question; `cliclick` synthesises clicks and drags.
- Capture several takes of each scene and keep the best.
- Do not touch application code. If you find a bug, write it down for the team instead of fixing it.

EDITING
- Assemble with ffmpeg, or with Remotion (React video) if you want animated titles. Titles and lower thirds use the app's design language: liquid glass panels, soft shadows, SF Pro / system font, generous spacing.
- Add burned-in captions for the tutor's voice and for the user's spoken questions.
- Add subtle background music (royalty-free, credited) ducked under speech.
- Show a small keystroke overlay when space is pressed for an interrupt.
- Keep cuts tight: remove model thinking time, but never speed up or alter what the app did. An optional "real time" badge on one uncut sequence proves the latency claim.

DELIVERABLES (put them in `demo/video/`)
1. `script.md`: the voiceover and shot list with timings.
2. `pimple-demo.mp4`: the main cut.
3. `pimple-30s.mp4`: the social cut.
4. `thumbnail.png`
5. `devpost.md`:
   - a 2-sentence tagline;
   - "What it does", "How we built it", "Challenges", "Accomplishments", "What we learned" and "What's next" sections, written from the README and this prompt;
   - a "Built with" list.
6. `NOTES.md`: any bugs or rough edges you saw while recording.

Before you start, read `README.md`, `docs/ARCHITECTURE.md`, `demo/MANUAL_TESTS.md` and `PROMPT.md` sections 1–4 so you understand every feature. Then propose the shot list to the user and confirm it before recording.
