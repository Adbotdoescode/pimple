Glass Tutor demo fixtures
=========================

All PNGs are 1568 x 1014 px (same aspect as a 1728 x 1117 pt display, long edge <= 1568).
All JSON files are in WIRE format (WireResponse / WireShape from shared/contracts.ts):
every shape has all fields, unused ones are 0 / "" / [].
Shape coordinates are pixels of the matching PNG.

FILES

incline-light.png   Light textbook page: Problem 4, block on a frictionless 30° incline.
incline-light.json  Canned tutor response for incline-light.png (4 segments, 7 shapes).
incline-dark.png    Same layout in dark mode, same coordinates as light.
incline-dark.json   Same canned response as incline-light.json (identical copy).
colourful.png       Orange/magenta page with teal panel, orbit diagram (sun, planet).
colourful.json      Canned tutor response for colourful.png (3 segments, 5 shapes).
sidenote.json       Side-note payload for the incline image (not a capture on its own):
                    one secondary vector "mg cos 30°" into the ramp, segment n1.
_gen/               Generator script (make_fixtures.py) and debug overlays (debug-*.png).

COMMANDS

Render the light incline with its canned response, no API call:
  cd /Users/adam/Developer/glass-tutor && scripts/gt-debug.sh capture=/Users/adam/Developer/glass-tutor/demo/fixtures/incline-light.png shapes=/Users/adam/Developer/glass-tutor/demo/fixtures/incline-light.json

Dark incline:
  cd /Users/adam/Developer/glass-tutor && scripts/gt-debug.sh capture=/Users/adam/Developer/glass-tutor/demo/fixtures/incline-dark.png shapes=/Users/adam/Developer/glass-tutor/demo/fixtures/incline-dark.json

Colourful stress test:
  cd /Users/adam/Developer/glass-tutor && scripts/gt-debug.sh capture=/Users/adam/Developer/glass-tutor/demo/fixtures/colourful.png shapes=/Users/adam/Developer/glass-tutor/demo/fixtures/colourful.json

Regenerate all PNGs and JSON (only needs Pillow):
  python3 /Users/adam/Developer/glass-tutor/demo/fixtures/_gen/make_fixtures.py
