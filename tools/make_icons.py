from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"
ICON_DIR.mkdir(exist_ok=True)


def make(size):
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(s):
        t = y / max(1, s - 1)
        r = int(251 + (255 - 251) * t)
        g = int(114 + (159 - 114) * t)
        b = int(153 + (183 - 153) * t)
        d.line([(0, y), (s, y)], fill=(r, g, b, 255))

    mask = Image.new("L", (s, s), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.23), fill=255)
    img.putalpha(mask)
    d = ImageDraw.Draw(img)

    bar_w = max(2, int(s * 0.055))
    gap = int(s * 0.045)
    heights = [0.28, 0.52, 0.34, 0.72, 0.44, 0.22]
    total = len(heights) * bar_w + (len(heights) - 1) * gap
    x0 = (s - total) // 2
    cy = s // 2
    for i, h in enumerate(heights):
        hh = int(s * h)
        x = x0 + i * (bar_w + gap)
        d.rounded_rectangle(
            [x, cy - hh // 2, x + bar_w, cy + hh // 2],
            radius=bar_w // 2,
            fill=(255, 255, 255, 245),
        )
    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    make(size).save(ICON_DIR / f"icon{size}.png")
print("ok")
