"""
Build the packaged application icon from the supplied master artwork.

Why a script rather than a checked-in blob: the master PNG has a large
transparent margin and a soft drop shadow. Shipping it as-is would put a
halo of near-transparent pixels into every 16x16 taskbar slot, which reads
as a smudge. This crops to the opaque tile, kills the outer glow, and emits
the exact sizes electron-builder and Windows ask for.

Run:
    python scripts/make-icon.py "<path to master.png>"
"""

import sys
from pathlib import Path

from PIL import Image

# Pixels fainter than this are shadow, not artwork.
ALPHA_CUTOFF = 32

# Everything Windows and electron-builder actually read.
SIZES = (16, 24, 32, 48, 64, 128, 256, 512)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def opaque_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    """Bounding box of the artwork, ignoring the soft shadow."""
    alpha = image.getchannel("A").point(lambda v: 255 if v >= ALPHA_CUTOFF else 0)
    box = alpha.getbbox()
    if box is None:
        raise SystemExit("no opaque artwork found in the master image")
    return box


def square_crop(box: tuple[int, int, int, int], image: Image.Image) -> Image.Image:
    """Crop to a centred square so the tile is not stretched."""
    left, top, right, bottom = box
    cx, cy = (left + right) / 2, (top + bottom) / 2
    side = max(right - left, bottom - top)
    half = side / 2
    out = (
        round(cx - half),
        round(cy - half),
        round(cx + half),
        round(cy + half),
    )
    # A square crop can still touch the canvas edge; refuse rather than pad.
    return image.crop(out)


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit('usage: python scripts/make-icon.py "<master.png>"')
    master = Path(sys.argv[1])
    if not master.is_file():
        raise SystemExit(f"master image not found: {master}")

    build = Path(__file__).resolve().parent.parent / "build"
    build.mkdir(parents=True, exist_ok=True)

    image = Image.open(master).convert("RGBA")
    # Kill the shadow so it cannot bleed into the downscaled sizes.
    r, g, b, a = image.split()
    image = Image.merge("RGBA", (r, g, b, a.point(lambda v: v if v >= ALPHA_CUTOFF else 0)))

    tile = square_crop(opaque_bbox(image), image)
    print(f"master {master.name} {Image.open(master).size} -> tile {tile.size}")

    master_tile = tile.resize((1024, 1024), Image.LANCZOS)
    master_tile.save(build / "cryptoric-icon.png", format="PNG", optimize=True)

    for size in SIZES:
        tile.resize((size, size), Image.LANCZOS).save(
            build / f"{size}x{size}.png", format="PNG", optimize=True
        )

    # Windows reads the .ico; Linux and macOS read a 512 PNG.
    tile.resize((512, 512), Image.LANCZOS).save(build / "icon.png", format="PNG", optimize=True)
    tile.save(build / "icon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES])

    for name in ("cryptoric-icon.png", "icon.png", "icon.ico"):
        print(f"wrote build/{name} ({(build / name).stat().st_size} bytes)")
    for size in SIZES:
        print(f"wrote build/{size}x{size}.png ({(build / f'{size}x{size}.png').stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())