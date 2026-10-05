#!/usr/bin/env python3
"""Measure a PNG's brightness with nothing but the standard library.

The test needs to know whether the emulator actually drew a picture, and the
only trustworthy source for that is the screenshot Chrome hands back -- reading
the page's own WebGL canvas with drawImage() returns an empty buffer, because
the context has no preserveDrawingBuffer.  So: decode the PNG here.

Handles what Page.captureScreenshot emits: 8-bit RGB / RGBA / grey, no
interlacing.  That is deliberately narrow; anything else raises.
"""
import pathlib
import struct
import sys
import zlib

_CHANNELS = {0: 1, 2: 3, 4: 2, 6: 4}


def decode(data: bytes):
    """-> (width, height, channels, bytes) with one byte per sample."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, w = 8, [], None
    while pos < len(data):
        ln, typ = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            w, h, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or interlace or color not in _CHANNELS:
                raise ValueError(f"unsupported PNG: depth={depth} color={color} "
                                 f"interlace={interlace}")
            ch = _CHANNELS[color]
        elif typ == b"IDAT":
            idat.append(body)
        elif typ == b"IEND":
            break
    if w is None:
        raise ValueError("no IHDR")

    raw = zlib.decompress(b"".join(idat))
    stride = w * ch
    out = bytearray(stride * h)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                c = prev[i - ch] if i >= ch else 0
                b = prev[i]
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif f != 0:
            raise ValueError(f"bad filter {f}")
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, ch, bytes(out)


def luma(path, box=None):
    """Mean luma 0..255 and the fraction of pixels above a dark threshold.

    box = (left, top, right, bottom) as fractions of the image, so a caller can
    exclude page chrome and look only at the emulator's screen.
    """
    w, h, ch, px = decode(pathlib.Path(path).read_bytes())
    x0, y0, x1, y1 = (0, 0, w, h) if box is None else (
        int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h))
    total = 0
    lit = 0
    n = 0
    for y in range(y0, y1):
        row = y * w * ch
        for x in range(x0, x1, 2):            # every other pixel: plenty, and 2x faster
            i = row + x * ch
            if ch >= 3:
                v = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
            else:
                v = px[i]
            total += v
            if v > 24:
                lit += 1
            n += 1
    return {"mean": round(total / n, 2), "lit": round(lit / n, 4), "w": w, "h": h}


if __name__ == "__main__":
    for f in sys.argv[1:]:
        print(f, luma(f))
