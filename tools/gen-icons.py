#!/usr/bin/env python3
"""
gen-icons.py — generate every PWA icon from one 32x32 pixel-art emblem.

Outputs (into ./icons):
  icon-{72,96,128,144,152,192,384,512}.png   purpose "any"   (emblem on a dark rounded tile)
  maskable-{192,512}.png                     purpose "maskable" (emblem inside the 80% safe zone, full-bleed bg)
  monochrome-512.png                         purpose "monochrome" (white silhouette, alpha)
  apple-touch-icon-180.png, favicon-32.png
  shortcut-continue-96.png, shortcut-new-96.png

Run:  python tools/gen-icons.py
Only Pillow is required. Upscaling is nearest-neighbour so the pixel art stays crisp.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
OUT.mkdir(exist_ok=True)

# 32x32 emblem: a crowned hooded pilgrim with a sword, gold on violet.
# . transparent  k dark  s steel  g gold  G bright gold  b blade  r crimson  e eye
EMBLEM = [
    "................................",
    "..............gggg..............",
    ".............g.GG.g.............",
    "...........gg.GGGG.gg...........",
    "...........gGGGGGGGGg...........",
    "............gggggggg............",
    ".............kkkkkk.............",
    "............kkkkkkkk............",
    "...........kkkkkkkkkk...........",
    "...........kksskkkkkk...........",
    "...........kkeekkeekk...........",
    "...........kkkkkkkkkk...........",
    "............kkkkkkkk............",
    ".........rr..kkkkkk..bb.........",
    "........rrrr.ssssss.bb..........",
    ".......rrrrrsssssssbb...........",
    ".......rrrrsssssssbb............",
    "......rrrrssssGGsbb.............",
    "......rrrrsssGGGGb..............",
    "......rrrrsssGGGGbb.............",
    "......rrrrssssGGssbb............",
    ".......rrrssssssssssbb..........",
    ".......rrrssssssssss.bb.........",
    "........rrsssssssss...bb........",
    "........rr.ssssssss....b........",
    "...........sss..sss.............",
    "...........sss..sss.............",
    "...........kkk..kkk.............",
    "..........kkkk..kkkk............",
    "................................",
    "................................",
    "................................",
]
COL = {
    "k": (26, 20, 40, 255),
    "s": (96, 102, 136, 255),
    "g": (160, 120, 40, 255),
    "G": (255, 224, 138, 255),
    "b": (230, 238, 248, 255),
    "r": (179, 34, 58, 255),
    "e": (255, 224, 138, 255),
}
BG_TOP = (58, 32, 96)
BG_BOT = (20, 12, 38)


def emblem(mono=False):
    im = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    px = im.load()
    for y, row in enumerate(EMBLEM):
        for x, ch in enumerate(row):
            if ch in COL:
                px[x, y] = (255, 255, 255, 255) if mono else COL[ch]
    return im


def gradient(size):
    im = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(im)
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(int(BG_TOP[i] * (1 - t) + BG_BOT[i] * t) for i in range(3)) + (255,)
        d.line([(0, y), (size, y)], fill=c)
    return im


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def compose(size, *, maskable=False, mono=False, badge=None):
    if mono:
        base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        art = emblem(mono=True)
        scale = max(1, (size * 0.8) // 32)
    else:
        base = gradient(size)
        if not maskable:
            base.putalpha(rounded_mask(size, int(size * 0.18)))
        art = emblem()
        # Safe zone for maskable icons is the central 80%; keep art inside 64%.
        scale = max(1, int((size * (0.62 if maskable else 0.78)) // 32))
    big = art.resize((32 * int(scale), 32 * int(scale)), Image.NEAREST)
    ox = (size - big.width) // 2
    oy = (size - big.height) // 2
    base.alpha_composite(big, (ox, oy))
    if badge:
        d = ImageDraw.Draw(base)
        r = size // 5
        d.ellipse([size - r * 2 - 4, size - r * 2 - 4, size - 4, size - 4], fill=(224, 179, 74, 255))
        d.text((size - r - 4 - r // 3, size - r - 4 - r // 2), badge, fill=(26, 16, 4, 255))
    return base


def save(im, name):
    im.save(OUT / name, "PNG", optimize=True)
    print("wrote", name, im.size)


for s in (72, 96, 128, 144, 152, 192, 384, 512):
    save(compose(s), f"icon-{s}.png")
for s in (192, 512):
    save(compose(s, maskable=True), f"maskable-{s}.png")
save(compose(512, mono=True), "monochrome-512.png")
save(compose(180, maskable=True), "apple-touch-icon-180.png")
save(compose(32), "favicon-32.png")
save(compose(96, badge=">"), "shortcut-continue-96.png")
save(compose(96, badge="+"), "shortcut-new-96.png")
