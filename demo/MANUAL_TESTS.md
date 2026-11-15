# Manual tests

Manual checks for a human tester. Nothing here is automated. Run each entry yourself and compare what you see and hear with the expected result.

Setup for every live test: start the app with `scripts/dev.sh` (uses the free macOS `say` voice). With the app running, the test pages are also served at `http://localhost:1420/demo/pages/<name>.html` (handy in Safari, which asks for confirmation on `file://` pages). Make the browser window large (about 1440×900 or full screen).

Test pages: `incline.html` (physics problem + free-body diagram), `dense-paragraph.html` (economics textbook text), `dark-equation.html` (dark mode, equations, spring diagram), `colourful.html` (saturated water-cycle page), `supply-demand.html` (economics graph).

## 1. Mode A: click the bubble and ask about the whole screen

Feature: one click captures the screen, you ask by voice (or type), the tutor answers in 2–4 sentences and draws on the page.

Steps:
1. Open `incline.html`.
2. Click the glass bubble at the right edge of the screen.
3. Say: "Why is the normal force smaller than the weight?" (or type it in the card's "Type a question instead…" box and press Return).

Expected: the card shows "Thinking…", then the tutor speaks 2–4 short sentences about mg cos θ vs mg. While each sentence is spoken, its shapes animate on (circle around the block, arrows from the block centre). Shapes are crisp and sit on the diagram. The card shows the caption, a "Source: your screen — …" chip and a "Check yourself" question. The footer shows "First word in X s" (target under 3 s).

## 2. Mode B: drag the bubble onto a paragraph (lens)

Feature: drag-to-target a region; the tutor summarises what it sees in one sentence and asks what you want to know.

Steps:
1. Open `dense-paragraph.html`.
2. Drag the bubble onto the third paragraph ("The principle of comparative advantage…") and release.
3. Listen for the one-sentence summary and "What do you want to ask?", then say: "What does comparative advantage mean here, in plain words?"

Expected: a lens outline follows the bubble while dragging; after release the summary is about that paragraph only. The answer is 2–4 sentences, uses the page's Atlantis/Borealia numbers, and the shapes (underline, box) land on that paragraph.

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

Expected: the tutor does not answer it. It says it has parked the question and steers back; the question appears under "Parked" in the card, and clicking it later asks it.

## 6. Interrupt by holding space

Steps:
1. Ask a question on `incline.html` and, while the second sentence is being spoken, hold the space bar.
2. While holding, say: "Wait, why cos and not sin?" and release.

Expected: speech fades out within about 150 ms, the mic opens, the side answer is drawn in a distinct dashed style, then the tutor says "Back to where we were…" and resumes at the interrupted sentence. Your objection appears under "Points you questioned".

## 7. Interrupt by tapping space ("which part?")

Steps:
1. During an answer, tap the space bar once.
2. When it asks "Which part?", say "that part" or name it.

Expected: speech pauses, the current sentence's shapes pulse gently, it asks "Which part?", answers briefly, then resumes.

## 8. Whiteboard

Steps:
1. Ask something that needs a drawing from scratch, e.g. on `dense-paragraph.html`: "Can you draw this on the whiteboard?" Or open it from the tray menu: Glass Tutor → Whiteboard.
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
