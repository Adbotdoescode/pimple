# Manual tests

Manual checks for a human tester. Nothing here is automated. Run each entry yourself and compare what you see with the expected result.

## (a) Open each test page

Feature: The demo pages look like real, finished web pages.

Steps:
1. Open `demo/pages/incline.html` in a desktop browser at about 1440×900.
2. Open `demo/pages/dense-paragraph.html` the same way.
3. Check the text, the diagram, and the layout on each page.

Expected: Both pages look like real course and textbook pages. Text is not clipped or overlapping, and nothing important needs scrolling at 1440×900.

## (b) Overlay canned render on the physics problem

Feature: The overlay draws canned shapes over the incline diagram, segment by segment.

Steps:
1. Start the app with `scripts/dev.sh`.
2. Open `demo/pages/incline.html` in a browser and make it full screen.
3. In a terminal, run `scripts/gt-debug.sh capture=/Users/adam/Developer/glass-tutor/demo/fixtures/incline.png shapes=/Users/adam/Developer/glass-tutor/demo/fixtures/canned-incline.json`.
4. Watch the overlay while the tutor speaks.

Expected: The shapes animate on, one segment at a time, over the diagram. The circle sits around the block, the blue weight arrow starts at the block centre, and the normal and friction arrows and the underline appear in the right places.

## (c) Overlay canned render on the dark page

Feature: Overlay colour adapts to a dark background.

Steps:
1. With the app running, open `demo/pages/dark-equation.html` full screen in a browser.
2. In a terminal, run `scripts/gt-debug.sh capture=/Users/adam/Developer/glass-tutor/demo/fixtures/dark-equation.png shapes=/Users/adam/Developer/glass-tutor/demo/fixtures/canned-dark.json`.

Expected: The shapes are clearly visible on the dark page. Their colours adapt, and the shapes stay legible without washing out or disappearing.

## (d) Whiteboard canned render

Feature: The whiteboard window draws the canned diagram.

Steps:
1. With the app running, run `scripts/gt-debug.sh shapes=/Users/adam/Developer/glass-tutor/demo/fixtures/canned-whiteboard.json`.

Expected: The whiteboard window opens and the diagram is drawn on the board.

## (e) Live question on the physics page

Feature: A spoken question on a real page gets a spoken answer with shapes on the diagram.

Steps:
1. With the app running, open `demo/pages/incline.html` in a browser.
2. Click the Glass Tutor bubble.
3. Select the diagram when the targeting prompt appears.
4. Ask: "why is the normal force smaller than the weight?"

Expected: The tutor answers out loud, and shapes appear on the diagram that support the explanation.
