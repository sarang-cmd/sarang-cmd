#!/usr/bin/env python3
import sys
import os
import shutil
from PIL import Image, ImageDraw

def round_image(path, radius_frac=0.5, backup=True):
    path = os.path.abspath(path)
    if not os.path.isfile(path):
        print(f"skipping (not found): {path}")
        return False
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    try:
        r = int(min(w, h) * float(radius_frac))
    except Exception:
        r = int(min(w, h) * 0.5)
    # create mask
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), (w, h)], radius=r, fill=255)
    im.putalpha(mask)
    if backup:
        bak = path + ".bak"
        if not os.path.exists(bak):
            shutil.copy2(path, bak)
    im.save(path)
    print(f"rounded: {path} (radius={r})")
    return True

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: round_icons.py <-r RADIUS_FRAC> file1 [file2 ...]")
        sys.exit(1)
    args = sys.argv[1:]
    radius = 0.5
    files = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ('-r', '--radius') and i + 1 < len(args):
            try:
                radius = float(args[i+1])
            except Exception:
                radius = 0.5
            i += 2
            continue
        files.append(a)
        i += 1
    for f in files:
        round_image(f, radius_frac=radius)
