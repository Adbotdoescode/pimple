# Manual tests

Manual checks for a human tester. Nothing here is automated. Run each entry yourself and compare what you see and hear with the expected result.

Setup for every live test: start the app with `scripts/dev.sh` (uses the free macOS `say` voice). With the app running, the test pages are also served at `http://localhost:1420/demo/pages/<name>.html` (handy in Safari, which asks for confirmation on `file://` pages). Make the browser window large (about 1440×900 or full screen).

Wear headphones: the microphone otherwise hears the tutor's own voice through the speakers and mis-transcribes.

## How to use (quick reference)

- Mode A, whole screen: click the glass bubble (or press ctrl+option+space anywhere). The mic opens; ask your question and pause for about 1 s, and the turn ends on its own.
- Mode B, a region: drag the bubble over what you mean; a lens follows it. Release (or press Return) to commit. The mic opens straight away (no summary); just ask. The region is the focus, and the full screen is sent as context.
- Mode C, lasso: while dragging the bubble, circle around the thing you mean (one full loop); the trail shows the loop. Release (or Return) to commit.
- Typed fallback: type into "Type a question instead…" in the card and press Return.
- Space tap at ANY moment (thinking, checking, drawing, speaking): pauses, pulses the current shapes, says "go ahead" / "Which part?", then listens. The card's Interrupt button does the same.
- Space hold during an answer: pauses and listens while you hold; release to send your objection. You get a short side answer (dashed), then "Back to where we were…" and it resumes. The point is listed under "Points you questioned".
- Check question: after an answer the card shows "Check yourself"; answer it by voice and you get short feedback.
- Off-topic questions are parked under "Parked for later" in the card; click one to ask it later.
- Shut up: Esc while it is thinking, speaking or checking, or the red Stop button in the card: audio stops at once, the drawings stay, and the mic opens for your next question.
- Card buttons: minimise (–) collapses the card to a small pill (click to expand); close (×) ends the session, clears the drawings and sends the bubble back to its edge. ctrl+option+space while a session runs also ends it.
- If your screen does not show enough to answer (e.g. "how does a pulley system work?" on the incline page), the whiteboard opens by itself on the side away from the bubble and draws from scratch, marked "Drawn from scratch".

Test pages: `incline.html` (physics problem + free-body diagram), `dense-paragraph.html` (economics textbook text), `dark-equation.html` (dark mode, equations, spring diagram), `colourful.html` (saturated water-cycle page), `supply-demand.html` (economics graph).

## 1. Mode A: click the bubble and ask about the whole screen

Feature: one click captures the screen, you ask by voice (or type), the tutor answers in 2–4 sentences and draws on the page.

Steps:
1. Open `incline.html`.
2. Click the glass bubble at the right edge of the screen.
3. Say: "Why is the normal force smaller than the weight?" (or type it in the card's "Type a question instead…" box and press Return).

Expected: the card shows "Thinking…", then the tutor speaks 2–4 short sentences about mg cos θ vs mg. While each sentence is spoken, its shapes animate on (circle around the block, arrows from the block centre). Shapes are crisp and sit on the diagram. The card shows the caption, a "Source: your screen — …" chip and a "Check yourself" question. The footer shows "First word in X s" (target under 3 s; measured about 3.2 s with the ElevenLabs voice and 4.5–5.5 s with the free `say` voice).

## 2. Mode B: drag the bubble onto a paragraph (lens)

Feature: drag-to-target a region; the mic opens immediately (no summary) and the answer focuses on the region, with the full screen as context.

Steps:
1. Open `dense-paragraph.html`.
2. Drag the bubble onto the third paragraph ("The principle of comparative advantage…") and release.
3. As soon as the card says "Listening…", say: "What does this mean in plain words?"

Expected: a lens outline follows the bubble while dragging; after release a soft glass rim marks the region and the card goes straight to "Listening…". The answer is 2–4 sentences about that paragraph, may use the page's Atlantis/Borealia table as context, and the shapes (underline on the definition, circles on the table) land in the right places. Verified with injected events 14:48.

## 3. Mode C: lasso a part of the diagram

Steps:
1. Open `incline.html`.
2. Press on the bubble and draw a loop around the block and its arrows, release.
3. Ask: "Which arrow is the friction?"

Expected: the lasso trail is drawn while you move, the answer is about the lassoed area only, and a shape marks the friction arrow f.

## 4. Adaptive colour on a dark page and a colourful page

Steps:
1. Open `dark-equation.html`, click the bubble and ask: "What does omega mean in this equation?"
2. Open `colourful.html`, click the bubble and ask: "What happens in step two?"

Expected: on the dark page the shapes use bright colours (cyan, coral, lime, gold) and stay readable; on the colourful page every shape and label stays legible against orange, magenta, teal and yellow blocks (a thin halo appears where contrast is low).

## 5. Off-topic question (parking)

Steps:
1. On `incline.html`, click the bubble and ask about the page, let it answer.
2. Click again and ask something unrelated, e.g. "What's a good pizza place near me?"

Expected: the tutor does not answer it. It says something like "Good question, I'll save that for after; for now, let's stick with the block on the rough incline", and the question appears under "Parked for later" in the card (verified headlessly 14:01). Clicking it later asks it.

## 5b. Check question

Steps:
1. After any answer, read the "Check yourself" question in the card and answer it out loud (e.g. "it would get smaller").

Expected: a short spoken feedback (right / not quite + one sentence why), at most one follow-up.

## 5c. Shut up, minimise, close

Steps:
1. Start any question; while it speaks press Esc (or click the red Stop button).
2. Ask a follow-up out loud.
3. Click the card's minimise (–) button, then the pill to expand it again.
4. Click the card's close (×) button.

Expected: (1) audio stops immediately, the shapes stay, the card shows "Listening…" (verified 14:49). (2) The follow-up is answered with the same screen as context. (3) The card collapses to a pill and comes back. (4) The session ends, the drawings clear, the bubble returns to its edge. Known issue (being fixed): without headphones the mic can pick up the end of the tutor's voice right after Stop and start a new turn on its own.

## 6. Interrupt by holding space

Steps:
1. Ask a question on `incline.html` and, while the second sentence is being spoken, hold the space bar.
2. While holding, say: "Wait, why cos and not sin?" and release.

Expected: speech fades out within about 150 ms, the mic opens, the side answer is drawn in a distinct dashed style, then the tutor says "Back to where we were…" and resumes at the interrupted sentence. Your objection appears under "Points you questioned".

## 7. Interrupt by tapping space ("which part?"), also while it is still thinking

Steps:
1. During an answer, or even while the card still says "Thinking…", tap the space bar once (or click Interrupt).
2. When it asks "Which part?", say "that part" or name it.

Expected: speech pauses (or the pending answer is dropped if it was still thinking), the card says "Paused — go ahead", the current shapes pulse, it listens, answers your new words briefly with the same screen as context, then resumes if there was an answer in progress (interrupt-while-thinking verified 14:49).

## 8. Whiteboard

Steps:
1. Ask something the screen can't show, e.g. on `incline.html`: "How does a pulley system reduce the force I need to lift something?" (verified 14:24: it opened by itself and drew a pulley from scratch), or ask "can you draw this on the whiteboard?". Or open it from the tray menu: Glass Tutor → Whiteboard.
2. Canned version (no API call): `scripts/gt-debug.sh shapes=/Users/adam/Developer/glass-tutor/demo/fixtures/canned-whiteboard.json`.
3. Drag the "Angle θ" slider; click the moon/sun icon.

Expected: the whiteboard window opens by itself only for whiteboard answers, and draws in sync with each spoken sentence (progress dots under the caption). Dragging the slider moves a dot along the N = mg cos θ graph with a live read-out. The theme toggles between paper and chalkboard. Asking a new on-screen (overlay) question hides the whiteboard again; opening it from the tray shows that answer drawn over a picture of the captured screen.

## 9. Canned overlay renders (no API call)

Steps:
1. Open `incline.html` full screen, then run `scripts/gt-debug.sh capture=/Users/adam/Developer/glass-tutor/demo/fixtures/incline.png shapes=/Users/adam/Developer/glass-tutor/demo/fixtures/canned-incline.json`.
2. Open `dark-equation.html` full screen, then run the same with `dark-equation.png` and `canned-dark.json`.

Expected: shapes animate on segment by segment. On a full-screen 1440×900 browser they line up with the page (circle around the block, weight arrow from the block centre, box around the GIVEN row). On other screen sizes they are positioned for the fixture image, so small offsets are expected.

## 10. Gizmo design kit (static, phase 2 preview)

Steps:
1. Open `gizmos/template.html` in a browser.
2. Drag the "Bubble radius r" slider, then press "▶ Grow to Earth".

Expected: looks like the reference images in `design/gizmo-examples/`. Live values on the right update as you drag; Play animates the slider to Earth's distance and the Sun shrinks to a dot as the view zooms out.
