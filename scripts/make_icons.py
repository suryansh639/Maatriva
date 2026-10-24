"""Generate the Maatriva PWA icons using only the Python standard library.

Writes solid-color PNGs (theme color #7a1f5c) with a simple white "M" glyph:

    web/public/icons/icon-192.png
    web/public/icons/icon-512.png
    web/public/icons/maskable-512.png   (glyph kept inside the 80% maskable safe zone)

Usage (from the repository root):  py -3.10 scripts/make_icons.py
The output is deterministic, so re-running produces byte-identical files.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

BG = (0x7A, 0x1F, 0x5C)
FG = (0xFF, 0xFF, 0xFF)

OUT_DIR = Path(__file__).resolve().parent.parent / "web" / "public" / "icons"


def _chunk(kind: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(kind + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)


def encode_png(width: int, height: int, pixels: list[bytearray]) -> bytes:
    """Encode 8-bit RGB rows (each row is width*3 bytes) as a PNG file."""
    raw = b"".join(b"\x00" + bytes(row) for row in pixels)  # filter type 0 per row
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit, RGB
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(raw, 9))
        + _chunk(b"IEND", b"")
    )


def _in_m_glyph(x: float, y: float) -> bool:
    """Return True if the unit-square point (x, y) lies on the "M" glyph.

    The glyph spans [0, 1] x [0, 1]: two vertical stems plus two diagonals that meet
    at the centre.
    """
    stroke = 0.2
    if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
        return False
    if x <= stroke or x >= 1.0 - stroke:
        return True  # left and right stems
    if y > 0.62:
        return False  # diagonals stop at the centre vertex
    # Left diagonal from (0, 0) to (0.5, 0.62); right diagonal mirrors it.
    xm = x if x <= 0.5 else 1.0 - x
    centre_line = 0.62 * (xm / 0.5)
    return abs(y - centre_line) <= stroke * 0.75


def render(size: int, glyph_fraction: float) -> list[bytearray]:
    """Render a size x size icon with the glyph occupying glyph_fraction of the side."""
    glyph = size * glyph_fraction
    origin = (size - glyph) / 2.0
    rows: list[bytearray] = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            gx = (px + 0.5 - origin) / glyph
            gy = (py + 0.5 - origin) / glyph
            row.extend(FG if _in_m_glyph(gx, gy) else BG)
        rows.append(row)
    return rows


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, 0.6),
        ("icon-512.png", 512, 0.6),
        ("maskable-512.png", 512, 0.44),  # well inside the 80% safe-zone circle
    ]
    for name, size, fraction in targets:
        path = OUT_DIR / name
        path.write_bytes(encode_png(size, size, render(size, fraction)))
        print(f"wrote {path} ({size}x{size})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
