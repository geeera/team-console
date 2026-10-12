#!/usr/bin/env python3
"""Environment variants of the app icon (#237): the production icon with a band across the bottom that names the
environment, so dev, stage and a local run never look like production on a Home Screen, in the Dock or in a tab.

Run from the repository root after the production icon changes, then commit the output:

    python3 -m pip install Pillow   # once, in a virtualenv; not a dependency of the workspace
    python3 tools/env-icons/generate.py

Reads   apps/console/public/icons/production/{icon-192,icon-512,apple-touch-icon}.png
Writes  apps/console/public/icons/{dev,stage,local}/{icon-192,icon-512,apple-touch-icon}.png + favicon.ico

Band colours come from the light palette of libs/console/shared/ui/src/tokens/tokens.css, the text is
`--accent-contrast`. The label is horizontal and fills most of the band: rotated corner text is unreadable at the
60 px an iPhone Home Screen shows. A favicon is 16-48 px, so it carries the initial only on a taller band.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ICONS = ROOT / 'apps/console/public/icons'
TOKENS = ROOT / 'libs/console/shared/ui/src/tokens/tokens.css'

# environment -> (label, band colour token)
VARIANTS: dict[str, tuple[str, str]] = {
    'dev': ('DEV', '--warning-text'),
    'stage': ('STAGE', '--danger'),
    'local': ('LOCAL', '--text-2'),
}
TEXT_TOKEN = '--accent-contrast'
PNGS = ('icon-192.png', 'icon-512.png', 'apple-touch-icon.png')
FAVICON_SIZES = (16, 32, 48)

# The production card ends at 70 % of the height; the band starts just below it so the glyph stays whole.
BAND_TOP = 0.72
FAVICON_BAND_TOP = 0.5

FONT_CANDIDATES = (
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
)


def light_token(name: str) -> tuple[int, int, int]:
    css = TOKENS.read_text(encoding='utf-8')
    # The first definition is the light palette (group 9); dark comes later in the file.
    match = re.search(rf'{re.escape(name)}:\s*#([0-9a-fA-F]{{6}})\s*;', css)
    if match is None:
        raise SystemExit(f'{name} is not a 6-digit hex colour in {TOKENS}')
    value = match.group(1)
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def find_font(explicit: str | None) -> str:
    for candidate in (explicit, *FONT_CANDIDATES):
        if candidate is not None and Path(candidate).is_file():
            return candidate
    raise SystemExit('no bold sans font found; pass --font /path/to/Bold.ttf')


def fit_font(font_path: str, text: str, max_width: float, max_height: float) -> ImageFont.FreeTypeFont:
    size = max(1, int(max_height))
    while size > 1:
        font = ImageFont.truetype(font_path, size)
        left, top, right, bottom = font.getbbox(text)
        if right - left <= max_width and bottom - top <= max_height:
            return font
        size -= 1
    return ImageFont.truetype(font_path, 1)


def with_band(
    source: Image.Image,
    label: str,
    band: tuple[int, int, int],
    ink: tuple[int, int, int],
    font_path: str,
    band_top: float,
) -> Image.Image:
    image = source.convert('RGBA')
    width, height = image.size
    top = round(height * band_top)
    pixels = image.load()
    assert pixels is not None
    # The icon is a moss shape on white: how far a pixel is from white is how much of the shape covers it, so the
    # band follows the rounded corners with their antialiasing. Between a row's first and last solid pixel it is all
    # shape, the light card included, so the band paints over the card where the two meet.
    for y in range(top, height):
        row = [min(1.0, max(0.0, (255 - pixels[x, y][0]) / (255 - 62))) for x in range(width)]
        solid = [x for x, coverage in enumerate(row) if coverage >= 0.99]
        first, last = (solid[0], solid[-1]) if solid else (width, -1)
        for x in range(width):
            a = pixels[x, y][3]
            coverage = 1.0 if first <= x <= last else row[x]
            pixels[x, y] = (
                round(255 + (band[0] - 255) * coverage),
                round(255 + (band[1] - 255) * coverage),
                round(255 + (band[2] - 255) * coverage),
                a,
            )
    band_height = height - top
    font = fit_font(font_path, label, width * 0.74, band_height * 0.56)
    draw = ImageDraw.Draw(image)
    left, glyph_top, right, bottom = font.getbbox(label)
    x = (width - (right - left)) / 2 - left
    y = top + (band_height - (bottom - glyph_top)) / 2 - glyph_top
    draw.text((x, y), label, font=font, fill=(*ink, 255))
    return image


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--font', help='a bold sans-serif TrueType font (defaults to Arial Bold / DejaVu Sans Bold)')
    args = parser.parse_args()
    font_path = find_font(args.font)
    ink = light_token(TEXT_TOKEN)

    for environment, (label, token) in VARIANTS.items():
        band = light_token(token)
        target = ICONS / environment
        target.mkdir(parents=True, exist_ok=True)
        for name in PNGS:
            source = Image.open(ICONS / 'production' / name)
            with_band(source, label, band, ink, font_path, BAND_TOP).save(target / name, optimize=True)
        large = Image.open(ICONS / 'production/icon-512.png').convert('RGBA')
        favicons = [
            with_band(large.resize((size, size), Image.Resampling.LANCZOS), label[0], band, ink, font_path, FAVICON_BAND_TOP)
            for size in FAVICON_SIZES
        ]
        favicons[-1].save(
            target / 'favicon.ico',
            sizes=[(size, size) for size in FAVICON_SIZES],
            append_images=favicons[:-1],
        )
        print(f'{environment}: {", ".join((*PNGS, "favicon.ico"))}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
