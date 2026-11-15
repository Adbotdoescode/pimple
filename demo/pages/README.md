# Demo test pages

Realistic web pages used as screenshot fixtures for the tutor overlay. Each page is rendered at exactly 1440×900 into `demo/fixtures/<name>.png`.

## Pages

- `incline.html`: physics homework page (Physics 101, Problem 4.3) with an inline SVG free-body diagram of a block on a 30° ramp. Exercises the physics problem case with a free-body diagram, measured shape coordinates, and modes A and C. Its canned response is `demo/fixtures/canned-incline.json`.
- `dense-paragraph.html`: textbook page (Principles of Microeconomics, 8.2) with dense justified serif paragraphs, a bold key term, a sidebar "Key idea" box with a small table, and a footnote. Exercises dense text and the mode B region case.
- `dark-equation.html`: dark-mode page with an equation and a diagram. Exercises adaptive colour on a dark background. Canned response: `demo/fixtures/canned-dark.json`.
- `colourful.html`: saturated, colourful backgrounds. Exercises adaptive colour and halos on busy colour.
- `supply-demand.html`: economics page with a supply and demand graph. Good for graph shapes and the whiteboard redraw. Canned response: `demo/fixtures/canned-whiteboard.json`.

## Fixtures

- Fixture PNGs live in `demo/fixtures/<name>.png` at 1440×900.
- Canned tutor responses: `demo/fixtures/canned-incline.json`, `demo/fixtures/canned-dark.json`, and `demo/fixtures/canned-whiteboard.json`. All are in the flat wire format defined by `shared/tutor_response.schema.json`. Pixel coordinates are in the 1440×900 fixture image.

## Re-rendering a fixture

```
cd /Users/adam/Developer/glass-tutor && npx -y playwright@1.64.0 screenshot --viewport-size=1440,900 file:///Users/adam/Developer/glass-tutor/demo/pages/incline.html demo/fixtures/incline.png
```

Use the same command for `dense-paragraph`, `dark-equation`, and the other pages, changing the input and output names.
