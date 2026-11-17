#!/usr/bin/env python3
"""Makes the app icons from the logo (build/logo/agent-cody-ping.png). Needs Pillow: pip install pillow

  build/icon.png            1024x1024 rounded tile with the standard macOS margin (electron-builder → .icns/.ico)
  src/assets/logo-256.png   256x256 rounded tile, shown in Windows notifications
"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
src = Image.open(root / 'build/logo/agent-cody-ping.png').convert('RGBA')


def tile(size, inner, radius):
    ss = 4
    mask = Image.new('L', (size * ss, size * ss), 0)
    o = (size - inner) // 2
    ImageDraw.Draw(mask).rounded_rectangle([o * ss, o * ss, (o + inner) * ss - 1, (o + inner) * ss - 1], radius * ss, fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(src.resize((inner, inner), Image.LANCZOS), (o, o))
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


tile(1024, 824, 185).save(root / 'build/icon.png', optimize=True)
tile(256, 256, 58).save(root / 'src/assets/logo-256.png', optimize=True)
print('Wrote build/icon.png and src/assets/logo-256.png')
