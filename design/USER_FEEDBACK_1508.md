# User feedback after the second real test (15:08)

Frozen before these changes: tag `real-use-backup` (37efce7), backup app in dist/backup/.

CARD (design/liquid-glass-reference/card-before-1508.png shows the current card):
1. The card MUST use the same liquid-glass design as the bubble, but slightly more opaque.
2. It must never get stuck in place: the user can drag it anywhere on screen with the cursor.

APPLICATION:
3. A subtle, thin rainbow glow around the border of the screen while the tutor is active
   (like Apple Intelligence Siri on iPhone, but much more subtle and thinner).
4. The bubble jiggles and reacts to the mouse hovering over or near it, even when not clicked.
5. A standalone background app (menu bar, no Dock clutter) that the user can push to GitHub and post on Devpost.
   Its app window MUST share the bubble's liquid-glass language, more translucent so the content behind shows:
   organic shapes, jiggle physics, the works. In it:
   a. adjust the bubble's resting location on screen;
   b. choose the assistant's ElevenLabs voice (list the account's voices, preview, select).
6. Shift + drag/click moves the bubble wherever the user wants (no capture); on release it sticks to the
   nearest wall at that same y.
7. LAST, done well (Fable): fix the lasso tool, which is buggy and glitchy.

ALREADY DONE: demo video prompt in demo/VIDEO_PROMPT.md.
