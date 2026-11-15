#!/usr/bin/env python3
"""Generate Glass Tutor demo fixtures.

PNGs are 1568 x 1014 (same aspect as a 1728 x 1117 pt display, long edge <= 1568).
JSON files use the WIRE format from shared/contracts.ts (WireResponse / WireShape):
every shape carries all fields; unused ones are 0 / "" / [].
Also writes debug overlays into _gen/ so the shape coordinates can be checked by eye.
"""
import json
import math
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 1568, 1014
FIX = "/Users/adam/Developer/glass-tutor/demo/fixtures"
GEN = os.path.join(FIX, "_gen")
os.makedirs(GEN, exist_ok=True)
HELV = "/System/Library/Fonts/Helvetica.ttc"


def F(size, bold=False):
    return ImageFont.truetype(HELV, size, index=1 if bold else 0)


def r1(p):
    return [round(float(p[0]), 1), round(float(p[1]), 1)]


def wire(id_, seg, kind, role, points=None, radius=0, label="", magnitude="", values=None, target=""):
    return {
        "id": id_, "segment_id": seg, "kind": kind, "color_role": role,
        "points": points or [], "radius": radius, "label": label, "magnitude": magnitude,
        "values": values or [], "target": target,
    }


HEAD = "Problem 4. Block on a frictionless incline"
LINE1 = "A 2.0 kg block rests on a ramp inclined at 30°."
LINE2 = "Find the normal force and the acceleration down the slope."

# ---------- incline geometry (identical for light and dark) ----------
ANG = math.radians(30)
A = (180.0, 780.0)                       # bottom-left vertex, the 30° angle
B = (760.0, 780.0)                       # bottom-right, right angle
C = (760.0, 780.0 - 580.0 * math.tan(ANG))  # top-right, on the slope
_L = math.hypot(C[0] - A[0], C[1] - A[1])
U = ((C[0] - A[0]) / _L, (C[1] - A[1]) / _L)  # up-slope unit vector (0.866, -0.5)
N = (U[1], -U[0])                              # outward normal, up and left (-0.5, -0.866)
K = 6.0                                        # px per newton


def at(p, du, dn):
    return (p[0] + du * U[0] + dn * N[0], p[1] + du * U[1] + dn * N[1])


S = at(A, 330, 0)        # contact point on the slope
CB = at(S, 0, 55)        # block centre (block side 110, bottom face on slope)
WEND = (CB[0], CB[1] + 19.6 * K)          # weight, straight down
NEND = at(CB, 0, 17 * K)                   # normal, outward perpendicular
PEND = at(CB, -9.8 * K, 0)                 # mg sin 30 along slope, down-slope
PERP = at(CB, 0, -17 * K)                  # mg cos 30 into ramp (side note)
BLOCK = [at(CB, su * 55, sn * 55) for su, sn in [(-1, -1), (1, -1), (1, 1), (-1, 1)]]

_dd = ImageDraw.Draw(Image.new("RGB", (10, 10)))
_bb = _dd.textbbox((110, 240), LINE2, font=F(26), anchor="ls")
QBOX = [_bb[0] - 14, _bb[1] - 10, (_bb[2] + 14) - (_bb[0] - 14), (_bb[3] + 10) - (_bb[1] - 10)]

_fh = F(42, True)
_x0 = 110 + _fh.getlength("Problem 4. Block on a ")
_x1 = _x0 + _fh.getlength("frictionless")
STROKE = [[_x0 + (_x1 - _x0) * k / 8.0, 138 + 3 * math.sin(math.pi * k / 8.0)] for k in range(9)]
ANGLE_LABEL = [232.0, 722.0]

THEMES = {
    "light": dict(bg="#FAFAFA", chrome="#E4E4E4", chrome_fg="#666666", box="#FFFFFF",
                  fg="#1A1A1A", muted="#5A5A5A", line="#333333", rule="#C8C8C8",
                  ramp="#D5DAE1", block="#A9C4E8", block_edge="#1F3A5F"),
    "dark": dict(bg="#1E1E1E", chrome="#2A2A2A", chrome_fg="#9A9A9A", box="#262626",
                 fg="#E8E8E8", muted="#A8A8A8", line="#D0D0D0", rule="#4A4A4A",
                 ramp="#3A3F47", block="#4A6FA5", block_edge="#9CC3F0"),
}


def draw_incline(t, path):
    img = Image.new("RGB", (W, H), t["bg"])
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 44], fill=t["chrome"])
    d.rounded_rectangle([170, 8, 900, 36], radius=14, fill=t["box"])
    d.text((190, 28), "textbook.example/ch4/problem-4", font=F(18), fill=t["chrome_fg"], anchor="ls")
    d.text((110, 128), HEAD, font=F(42, True), fill=t["fg"], anchor="ls")
    d.text((110, 200), LINE1, font=F(26), fill=t["fg"], anchor="ls")
    d.text((110, 240), LINE2, font=F(26), fill=t["fg"], anchor="ls")

    d.rounded_rectangle([980, 330, 1430, 540], radius=12, outline=t["line"], width=2, fill=t["box"])
    d.text((1005, 372), "Given:", font=F(26, True), fill=t["fg"], anchor="ls")
    for i, s in enumerate(["mass m = 2.0 kg", "angle = 30°", "g = 9.8 m/s²"]):
        d.text((1005, 412 + 34 * i), s, font=F(24), fill=t["fg"], anchor="ls")
    d.text((980, 600), "N = ________ N", font=F(24), fill=t["fg"], anchor="ls")
    d.text((980, 640), "a = ________ m/s²", font=F(24), fill=t["fg"], anchor="ls")
    d.text((980, 700), "Work:", font=F(24, True), fill=t["fg"], anchor="ls")
    for y in (730, 770, 810, 850):
        d.line([(980, y), (1430, y)], fill=t["rule"], width=2)

    d.line([(120, 780), (900, 780)], fill=t["line"], width=3)
    d.polygon([A, B, C], fill=t["ramp"])
    d.line([A, C], fill=t["line"], width=4)
    d.line([A, B], fill=t["line"], width=3)
    d.line([B, C], fill=t["line"], width=3)
    d.line([(B[0] - 18, B[1]), (B[0] - 18, B[1] - 18), (B[0], B[1] - 18)], fill=t["line"], width=2)
    d.arc([A[0] - 60, A[1] - 60, A[0] + 60, A[1] + 60], start=-30, end=0, fill=t["muted"], width=3)
    d.text((470, 835), "Figure 4.2", font=F(20), fill=t["muted"], anchor="ms")

    d.polygon(BLOCK, fill=t["block"], outline=t["block_edge"], width=3)
    d.text(CB, "m", font=F(28, True), fill=t["block_edge"], anchor="mm")
    d.text((1480, 990), "118", font=F(20), fill=t["muted"], anchor="rs")
    img.save(path)


def incline_shapes():
    return [
        wire("block_circle", "s1", "circle", "primary", points=[r1(CB)], radius=100, label="block"),
        wire("weight", "s2", "vector", "warn", points=[r1(CB), r1(WEND)], label="mg", magnitude="19.6 N", values=[]),
        wire("normal", "s3", "vector", "primary", points=[r1(CB), r1(NEND)], label="N", magnitude="17 N", values=[]),
        wire("parallel", "s3", "vector", "secondary", points=[r1(CB), r1(PEND)], label="mg sin 30°", values=[1]),
        wire("question_box", "s4", "box", "accent",
             points=[r1([QBOX[0], QBOX[1]]), r1([QBOX[0] + QBOX[2], QBOX[1] + QBOX[3]])]),
        wire("angle_label", "s4", "text", "accent", points=[r1(ANGLE_LABEL)], label="30°"),
        wire("friction_stroke", "s4", "stroke", "accent", points=[r1(p) for p in STROKE]),
    ]


def incline_response():
    return {
        "concept": "Forces on a block on a frictionless incline",
        "surface": "overlay",
        "grounding": {"source_type": "screen", "source_ref": "Problem 4 on the page", "quote": LINE1},
        "segments": [
            {"id": "s1", "text": "Start with the block itself, the part inside this circle, and we will pull out every force acting on it."},
            {"id": "s2", "text": "Gravity pulls straight down on it, with a weight of about 19.6 newtons."},
            {"id": "s3", "text": "The ramp pushes back straight out from its surface, that is the normal force, about 17 newtons. The part of gravity that runs along the slope, about 9.8 newtons, is what pulls the block down the ramp."},
            {"id": "s4", "text": "Because the surface is frictionless, nothing else acts along the slope, so that 9.8 newton part alone accelerates the block at about 4.9 metres per second squared. The 30 degree angle sets both pieces."},
        ],
        "shapes": incline_shapes(),
        "check_question": "If the ramp were steeper, would the normal force get bigger or smaller?",
        "gizmo_offer": {"recommended": False, "pitch": ""},
        "parked": ["Why do ramps reduce effort?"],
    }


def sidenote_response():
    return {
        "segments": [
            {"id": "n1", "text": "Only part of gravity presses into the ramp, so the normal force is smaller than the full weight."},
        ],
        "shapes": [
            wire("perp_component", "n1", "vector", "secondary", points=[r1(CB), r1(PERP)], label="mg cos 30°"),
        ],
    }


# ---------- colourful page ----------
PCX, PCY, PR = 820.0, 500.0, 280.0
PLANET = (PCX + PR * math.cos(math.radians(-40)), PCY + PR * math.sin(math.radians(-40)))


def draw_colourful(path):
    grad = Image.linear_gradient("L").resize((W, H))
    top = Image.new("RGB", (W, H), (255, 154, 60))
    bottom = Image.new("RGB", (W, H), (215, 38, 111))
    img = Image.composite(bottom, top, grad)
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([60, 150, 500, 860], radius=24, fill=(12, 140, 140))
    d.text((100, 215), "Orbit basics", font=F(36, True), fill="white", anchor="ls")
    for i, s in enumerate(["Planets follow closed paths", "around the sun. Their distance",
                           "from the sun keeps changing", "as they go round the orbit."]):
        d.text((100, 270 + 36 * i), s, font=F(24), fill="white", anchor="ls")
    d.ellipse([400, 760, 470, 830], fill=(255, 216, 77))

    d.ellipse([PCX - PR, PCY - PR, PCX + PR, PCY + PR], outline="white", width=4)
    d.ellipse([PCX - 60, PCY - 60, PCX + 60, PCY + 60], fill=(255, 228, 77), outline=(90, 14, 42), width=4)
    d.ellipse([PLANET[0] - 26, PLANET[1] - 26, PLANET[0] + 26, PLANET[1] + 26],
              fill=(46, 196, 255), outline="white", width=3)
    d.text((820, 830), "Figure 3.1  Orbit of a planet", font=F(22), fill="white", anchor="ms")

    d.rounded_rectangle([1110, 560, 1480, 780], radius=18, fill="white")
    d.text((1140, 610), "Kepler's second law", font=F(26, True), fill=(30, 30, 40), anchor="ls")
    for i, s in enumerate(["The line from the sun to the planet", "sweeps equal areas in equal times.",
                           "Closer means faster."]):
        d.text((1140, 650 + 34 * i), s, font=F(22), fill=(30, 30, 40), anchor="ls")
    img.save(path)


def colourful_response():
    orbit = [[PCX + PR * math.cos(math.radians(t)), PCY + PR * math.sin(math.radians(t))]
             for t in [-170 + 70 * k / 11.0 for k in range(12)]]
    return {
        "concept": "Planetary orbits and Kepler's second law",
        "surface": "overlay",
        "grounding": {"source_type": "screen", "source_ref": "Figure 3.1 on the page",
                      "quote": "The line from the sun to the planet sweeps equal areas in equal times."},
        "segments": [
            {"id": "s1", "text": "The sun sits in the middle, and this circle marks it as the thing the planet is orbiting."},
            {"id": "s2", "text": "The distance r from the sun to the planet is the key quantity here, and it keeps changing as the planet moves."},
            {"id": "s3", "text": "The curve traced here is the orbit, and the box holds the rule for how fast the planet moves along it."},
        ],
        "shapes": [
            wire("sun_circle", "s1", "circle", "primary", points=[[PCX, PCY]], radius=95, label="sun"),
            wire("r_arrow", "s2", "arrow", "secondary", points=[[PCX, PCY], r1(PLANET)], label="r"),
            wire("planet_label", "s2", "text", "accent", points=[[1034.5, 268.0]], label="planet"),
            wire("orbit_stroke", "s3", "stroke", "accent", points=[r1(p) for p in orbit]),
            wire("law_box", "s3", "box", "warn", points=[[1100.0, 550.0], [1490.0, 790.0]]),
        ],
        "check_question": "Where on this orbit would the planet move fastest, and why?",
        "gizmo_offer": {"recommended": False, "pitch": ""},
        "parked": ["Why are orbits ellipses rather than circles?"],
    }


# ---------- debug overlay: draws the wire shapes on top of the PNG ----------
ROLE_RGB = {"primary": (0, 120, 255), "secondary": (0, 170, 90), "accent": (220, 0, 200), "warn": (255, 60, 0)}


def debug_overlay(src, shapes, out):
    img = Image.open(src).convert("RGB")
    d = ImageDraw.Draw(img)
    for s in shapes:
        c = ROLE_RGB[s["color_role"]]
        p, k = s["points"], s["kind"]
        if k == "circle":
            cx, cy = p[0]
            r = s["radius"]
            d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=c, width=3)
            d.text((cx, cy - r - 6), s["label"], font=F(18, True), fill=c, anchor="ms")
        elif k == "box":
            (x1, y1), (x2, y2) = p
            d.rectangle([x1, y1, x2, y2], outline=c, width=3)
        elif k in ("vector", "arrow", "line"):
            d.line([tuple(p[0]), tuple(p[1])], fill=c, width=4)
            d.ellipse([p[1][0] - 5, p[1][1] - 5, p[1][0] + 5, p[1][1] + 5], fill=c)
            if s["label"]:
                d.text((p[1][0] + 8, p[1][1]), s["label"], font=F(18, True), fill=c, anchor="lm")
        elif k == "stroke":
            d.line([tuple(q) for q in p], fill=c, width=4)
        elif k == "text":
            x, y = p[0]
            d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=c)
            d.text((x + 8, y), s["label"], font=F(18, True), fill=c, anchor="lm")
    img.save(out)


def dump(name, obj):
    path = os.path.join(FIX, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return path


def main():
    draw_incline(THEMES["light"], os.path.join(FIX, "incline-light.png"))
    draw_incline(THEMES["dark"], os.path.join(FIX, "incline-dark.png"))
    draw_colourful(os.path.join(FIX, "colourful.png"))

    inc = incline_response()
    dump("incline-light.json", inc)
    dump("incline-dark.json", inc)
    dump("colourful.json", colourful_response())
    dump("sidenote.json", sidenote_response())

    debug_overlay(os.path.join(FIX, "incline-light.png"), inc["shapes"],
                  os.path.join(GEN, "debug-incline-light.png"))
    debug_overlay(os.path.join(FIX, "colourful.png"), colourful_response()["shapes"],
                  os.path.join(GEN, "debug-colourful.png"))
    debug_overlay(os.path.join(FIX, "incline-light.png"), sidenote_response()["shapes"],
                  os.path.join(GEN, "debug-sidenote.png"))

    print("block centre", r1(CB), "slope angle deg", round(math.degrees(math.atan2(-U[1], U[0])), 2))
    print("weight end", r1(WEND), "normal end", r1(NEND), "parallel end", r1(PEND))
    print("question box", [round(v, 1) for v in QBOX], "planet", r1(PLANET))


if __name__ == "__main__":
    main()
