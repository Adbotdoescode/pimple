#!/usr/bin/env python3
"""Pimple app icon: a liquid-glass water droplet on a soft gradient squircle.

Usage: python3 src-tauri/icons/_src/make_icon.py   (writes icon-1024.png next to this file)
Then:  bunx tauri icon src-tauri/icons/_src/icon-1024.png
Rendered per pixel with numpy at 2x and downscaled.
"""
import os
import numpy as np
from PIL import Image, ImageFilter

SS = 2                      # supersampling factor
N = 1024 * SS
yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
X = xx / SS                 # coordinates in 1024-space
Y = yy / SS


def blur(a, r):
    """Gaussian blur of a float array in 0..1 (radius in 1024-space px)."""
    im = Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8))
    return np.asarray(im.filter(ImageFilter.GaussianBlur(r * SS)), dtype=np.float32) / 255


def smooth(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def hexc(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32) / 255


# ── tile: Apple-grid squircle, 824 px, centred ──
HALF = 412.0
u = np.abs(X - 512) / HALF
v = np.abs(Y - 512) / HALF
se = (u ** 5 + v ** 5) ** (1 / 5)                  # superellipse "radius", 1 at the edge
tile_a = np.clip((1 - se) * HALF + 0.5, 0, 1)      # 1 px antialias in 1024-space

SKY, LILAC, PEACH = hexc("#8FD0FF"), hexc("#C3B2FF"), hexc("#FFC3A6")


def tile_color(x, y):
    """Soft sky → lilac → peach diagonal gradient with a light bloom top-left."""
    t = np.clip(((x - 100) * 0.55 + (y - 100) * 1.0) / (824 * 1.55), 0, 1)[..., None]
    a = SKY + (LILAC - SKY) * smooth(0.0, 0.55, t)
    c = a + (PEACH - a) * smooth(0.45, 1.0, t)
    bloom = np.exp(-(((x - 300) / 420) ** 2 + ((y - 230) / 330) ** 2))[..., None]
    c = c + (1 - c) * 0.38 * bloom
    warm = np.exp(-(((x - 800) / 300) ** 2 + ((y - 860) / 260) ** 2))[..., None]
    c = c + (hexc("#FFE1C4") - c) * 0.35 * warm
    return c


tile = tile_color(X, Y)
# glassy tile edge: bright inner top rim, slightly shaded bottom rim
edge = np.clip(1 - (1 - se) * HALF / 5.0, 0, 1)    # 1 at the edge → 0 five px inside
toward_top = np.clip((512 - Y) / HALF, -1, 1)
tile = tile + (1 - tile) * (edge * np.clip(toward_top, 0, 1) * 0.75)[..., None]
tile = tile * (1 - edge * np.clip(-toward_top, 0, 1) * 0.16)[..., None]

# ── droplet: smooth union of a body circle and a small tip circle ──
C1 = (512.0, 574.0); R1 = 236.0
C2 = (512.0, 258.0); R2 = 26.0
K = 228.0
G = R1 / 196.0                                     # scale for everything drawn on the drop
d1 = np.hypot(X - C1[0], Y - C1[1]) - R1
d2 = np.hypot(X - C2[0], Y - C2[1]) - R2
h_ = np.clip(0.5 + 0.5 * (d2 - d1) / K, 0, 1)
sd = d2 + (d1 - d2) * h_ - K * h_ * (1 - h_)       # < 0 inside
di = -sd                                           # depth inside the drop, px
drop_a = np.clip(di + 0.5, 0, 1)

RIM = 132.0 * G / 1.2                                        # width of the curved shoulder
t = np.clip(di / RIM, 0, 1)
height = np.sqrt(np.clip(1 - (1 - t) ** 2, 0, 1))  # dome: steep at the rim, flat on top
gy, gx = np.gradient(blur(height, 1.5))
gx *= SS; gy *= SS                                 # slope per 1024-space px (points uphill = inward)
slope = np.hypot(gx, gy) + 1e-6
nx, ny = -gx / slope, -gy / slope                  # outward unit normal (xy)
steep = np.clip(slope * RIM / 2.2, 0, 1)           # 0 on the flat top → 1 at the rim

# refraction: the lens pulls the picture inward and magnifies it; stronger at the rim
# and, like a real bead of water, it shows the scene behind it upside down.
cx, cy = C1[0], C1[1] - 30 * G
bend = gx * RIM * 60.0, gy * RIM * 60.0
sx = cx - (X - cx) * 1.75 + bend[0]
sy = cy - (Y - cy) * 1.75 + bend[1] + 30
sx = np.clip(sx, 110, 914); sy = np.clip(sy, 110, 914)
inside = tile_color(sx, sy)
inside = inside + (1 - inside) * 0.20              # clear water: lighter than the tile

# light from the top-left
LX, LY = -0.62, -0.78
facing = nx * LX + ny * LY                         # +1 on the lit rim, -1 on the far rim
shade = np.clip(facing, 0, 1) * steep              # refracted shadow just inside the lit side
caust = np.clip(-facing, 0, 1) * steep             # caustic: light gathers on the far side
deep = hexc("#3B4FA8")
inside = inside + (deep - inside) * (0.50 * shade ** 1.3)[..., None]
inside = inside + (1 - inside) * (0.88 * caust ** 1.5)[..., None]

# chromatic fringe hugging the rim (like the lens reference): hue runs round the drop
ang = np.arctan2(Y - C1[1], X - C1[0])
STOPS = [hexc(c) for c in ("#2F6BFF", "#7A45F2", "#FF3D94", "#FF8A2B", "#FFD23F", "#25C8FF")]
hue = ((ang / (2 * np.pi) + 0.5) * 2.0 + 0.02) % 1.0 * len(STOPS)   # two turns round the drop; blue on the left flank
i0 = np.floor(hue).astype(int) % len(STOPS)
fr = (hue - np.floor(hue))[..., None]
pal = np.stack(STOPS)
rgb = pal[i0] * (1 - fr) + pal[(i0 + 1) % len(STOPS)] * fr
band = smooth(2, 12 * G, di) * (1 - smooth(18 * G, 50 * G, di))
side = 0.55 + 0.45 * np.abs(np.cos(ang))           # stronger on the left and right flanks
inside = inside + (rgb - inside) * (0.74 * band * side)[..., None]

# rim: thin dark refracted edge + a bright meniscus line inside it
rim_dark = (1 - smooth(0, 9 * G, di)) * drop_a
inside = inside + (hexc("#2A3A8C") - inside) * (0.68 * rim_dark * (0.6 + 0.4 * np.clip(facing, 0, 1)))[..., None]
rim_light = smooth(4 * G, 9 * G, di) * (1 - smooth(9 * G, 22 * G, di))
inside = inside + (1 - inside) * (rim_light * (0.25 + 0.6 * np.clip(-facing, 0, 1)))[..., None]

# specular highlights: a soft window reflection top-left and a small sparkle
def blob(px, py, rx, ry, rot, soft):
    c, s = np.cos(rot), np.sin(rot)
    dx, dy = X - px, Y - py
    a = (dx * c + dy * s) / rx
    b = (-dx * s + dy * c) / ry
    return 1 - smooth(1 - soft, 1.0, np.hypot(a, b))

def on(dx, dy):                                    # a point in drop-relative units
    return C1[0] + dx * G, C1[1] + dy * G

spec = blob(*on(-84, -92), 66 * G, 34 * G, np.radians(-48), 0.5) * 0.97
spec = np.maximum(spec, blob(*on(-14, -196), 14 * G, 24 * G, np.radians(6), 0.6) * 0.85)
spec = np.maximum(spec, blob(*on(96, 118), 54 * G, 13 * G, np.radians(-42), 0.75) * 0.55)
spec *= smooth(8, 26, di)
inside = inside + (1 - inside) * spec[..., None]

# ── shadows ──
def shifted(a, dx, dy):
    return np.roll(np.roll(a, int(dy * SS), 0), int(dx * SS), 1)

cast = blur(shifted(drop_a, 24, 36), 24) * 0.46    # soft cast shadow, away from the light
contact = blur(shifted(drop_a, 6, 10), 7) * 0.36
sh = np.clip(cast + contact, 0, 0.66)
tile = tile + (hexc("#33307A") - tile) * sh[..., None]
# bright caustic spill where the drop focuses light onto the tile, bottom-right
spill = blur(shifted(drop_a, 30, 44), 12) * blob(*on(120, 180), 170 * G, 80 * G, np.radians(-40), 1.0)
tile = tile + (hexc("#FFF4E6") - tile) * (0.5 * spill * (1 - drop_a))[..., None]

rgb_out = tile + (inside - tile) * drop_a[..., None]

# ── canvas: tile over its own drop shadow ──
tile_sh = blur(shifted(tile_a, 0, 14), 16) * 0.30
alpha = tile_a + (1 - tile_a) * tile_sh
shadow_col = hexc("#1B1F4A")
col = rgb_out * tile_a[..., None] + shadow_col * ((1 - tile_a) * tile_sh)[..., None]
col = col / np.maximum(alpha, 1e-6)[..., None]

out = np.dstack([np.clip(col, 0, 1), np.clip(alpha, 0, 1)])
img = Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA").resize((1024, 1024), Image.LANCZOS)
dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon-1024.png")
img.save(dst)
print(dst)
