#!/usr/bin/env python3
"""Generate Nocturne's toolbar icons.

No third-party dependencies: PNGs are assembled from zlib-compressed scanlines.
The mark is a crescent moon (one disc minus an offset disc) on a rounded
square, rendered with 4x supersampling for clean edges at 16px.
"""
import math
import struct
import zlib
from pathlib import Path

SS = 4  # supersampling factor

BG = (28, 28, 28)
EDGE = (58, 58, 58)
MOON = (212, 212, 212)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"


def rounded_square(x, y, size, radius):
    """Coverage test for a rounded square inset in a `size` box."""
    left, top, right, bottom = 0.0, 0.0, float(size), float(size)
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    if left <= x <= right and top <= y <= bottom:
        dx, dy = x - cx, y - cy
        return dx * dx + dy * dy <= radius * radius or (
            left + radius <= x <= right - radius or top + radius <= y <= bottom - radius
        )
    return False


def crescent(x, y, size):
    """A disc with a second, offset disc subtracted out of it."""
    r = size * 0.315
    cx, cy = size * 0.47, size * 0.5
    bite_r = size * 0.265
    bx, by = size * 0.655, size * 0.355
    inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    bitten = (x - bx) ** 2 + (y - by) ** 2 <= bite_r * bite_r
    return inside and not bitten


def render(size):
    radius = size * 0.26
    edge_w = max(size * 0.045, 0.75)
    rows = []
    samples = SS * SS
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    if not rounded_square(x, y, size, radius):
                        continue
                    if crescent(x, y, size):
                        color = MOON
                    elif not rounded_square(x, y, size, radius - edge_w):
                        color = EDGE
                    else:
                        color = BG
                    acc[0] += color[0]
                    acc[1] += color[1]
                    acc[2] += color[2]
                    acc[3] += 255.0
            if acc[3] == 0:
                row += bytes((0, 0, 0, 0))
                continue
            alpha = acc[3] / samples
            # Un-premultiply so edge pixels keep their colour.
            weight = acc[3] / 255.0
            row += bytes((
                int(round(acc[0] / weight)),
                int(round(acc[1] / weight)),
                int(round(acc[2] / weight)),
                int(round(alpha)),
            ))
        rows.append(bytes(row))
    return rows


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(OUT / f"icon{size}.png", size, render(size))
        print(f"icons/icon{size}.png")


if __name__ == "__main__":
    main()
