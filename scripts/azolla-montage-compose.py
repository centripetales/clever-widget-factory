#!/usr/bin/env python3
"""Composes a labeled photo grid from a manifest JSON produced by
azolla-weekly-montage.js. Names are intentionally left off the tiles (dates
only) per how these have been shared so far — edit LABEL_MODE below if that
should change.

Usage: python3 azolla-montage-compose.py manifest.json output.jpg
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont, ImageOps

LABEL_MODE = "date_only"  # "date_only" or "name_and_date"

TILE_W, TILE_H = 400, 400
LABEL_H = 44 if LABEL_MODE == "date_only" else 70
COLS = 4
PAD = 10


def main():
    manifest_path, out_path = sys.argv[1], sys.argv[2]
    with open(manifest_path) as f:
        entries = json.load(f)

    rows = (len(entries) + COLS - 1) // COLS
    canvas_w = COLS * TILE_W + (COLS + 1) * PAD
    canvas_h = rows * (TILE_H + LABEL_H) + (rows + 1) * PAD
    canvas = Image.new("RGB", (canvas_w, canvas_h), (20, 20, 20))
    draw = ImageDraw.Draw(canvas)

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 20)
        font_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 16)
    except Exception:
        font = ImageFont.load_default()
        font_small = font

    for i, entry in enumerate(entries):
        col, row = i % COLS, i // COLS
        x = PAD + col * (TILE_W + PAD)
        y = PAD + row * (TILE_H + LABEL_H + PAD)

        img = Image.open(entry["file"])
        img = ImageOps.exif_transpose(img)
        if img.mode != "RGB":
            img = img.convert("RGB")
        img = ImageOps.fit(img, (TILE_W, TILE_H), method=Image.LANCZOS)
        canvas.paste(img, (x, y))

        text_y = y + TILE_H + (12 if LABEL_MODE == "date_only" else 8)
        if LABEL_MODE == "name_and_date":
            draw.text((x + 4, text_y), entry["label"], fill=(255, 255, 255), font=font)
            draw.text((x + 4, text_y + 26), entry["date"], fill=(180, 180, 180), font=font_small)
        else:
            draw.text((x + 4, text_y), entry["date"], fill=(180, 180, 180), font=font_small)

    canvas.save(out_path, quality=90)
    print(f"saved {canvas.size} -> {out_path}")


if __name__ == "__main__":
    main()
