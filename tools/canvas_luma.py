#!/usr/bin/env python3
"""Measure the brightness of just the emulator canvas inside a page screenshot.

    canvas_luma.py <png> <css_x> <css_y> <css_w> <css_h> <css_viewport_w>

pngstat.luma() takes its crop box as fractions of the image, while the page
reports the canvas rect in CSS pixels. Converting between the two needs the
device-pixel scale, and that is exactly the kind of thing that silently becomes
NaN and quietly widens the crop to the whole page -- at which point a black
emulator surrounded by bright page chrome still scores as "a picture".

So the scale is derived from the screenshot's own width against the page's
reported viewport width, and anything that does not come out finite and sane is
a hard error rather than a default. pngstat.py itself is left untouched: it is a
copy of a harness validated pixel-for-pixel against PIL elsewhere on this fleet,
and its provenance is worth more than the convenience of editing it.

Prints one JSON object: {"mean", "lit", "w", "h", "scale", "box_px"}.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pngstat  # noqa: E402


def main(argv):
    if len(argv) != 7:
        print(__doc__, file=sys.stderr)
        return 2
    path = argv[1]
    cx, cy, cw, ch, vw = (float(v) for v in argv[2:7])

    w, h, _, _ = pngstat.decode(pathlib.Path(path).read_bytes())
    if vw <= 0:
        raise SystemExit("viewport width must be positive")
    scale = w / vw
    if not (0.1 < scale < 8.0):
        raise SystemExit(f"implausible device-pixel scale {scale!r} "
                         f"(image {w}px wide, viewport {vw}px) -- refusing to guess")

    x0, y0 = cx * scale, cy * scale
    x1, y1 = (cx + cw) * scale, (cy + ch) * scale
    if not (x1 > x0 and y1 > y0):
        raise SystemExit(f"empty crop box {(x0, y0, x1, y1)} -- the canvas has no area")
    # Clamp into the image, then hand pngstat fractions as it expects.
    x0, y0 = max(0.0, x0), max(0.0, y0)
    x1, y1 = min(float(w), x1), min(float(h), y1)
    box = (x0 / w, y0 / h, x1 / w, y1 / h)

    stat = pngstat.luma(path, box)
    stat["scale"] = round(scale, 4)
    stat["box_px"] = [round(v) for v in (x0, y0, x1, y1)]
    print(json.dumps(stat))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
