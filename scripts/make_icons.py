"""Render the PWA icon set as PNGs (iOS ignores SVG apple-touch-icons; badges must be monochrome).

Run with any Python that has Pillow:  python scripts/make_icons.py
Writes into frontend/public/icons/ (copied to dist by the frontend build).
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "frontend" / "public" / "icons"

BG = (7, 26, 24, 255)        # #071a18
GOLD = (214, 173, 92, 255)   # #d6ad5c
MINT = (113, 225, 193, 255)  # #71e1c1
PALE = (240, 214, 149, 255)  # #f0d695

SUPERSAMPLE = 4


def _bezier(points: list[tuple[float, float]], steps: int = 64) -> list[tuple[float, float]]:
    """Flatten a cubic Bézier chain (SVG-like c-segments already expanded to absolute points)."""
    out: list[tuple[float, float]] = []
    for i in range(0, len(points) - 3, 3):
        p0, p1, p2, p3 = points[i], points[i + 1], points[i + 2], points[i + 3]
        for step in range(steps + 1):
            t = step / steps
            u = 1 - t
            x = u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0]
            y = u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1]
            out.append((x, y))
    return out


# Curves traced from icon.svg (512 viewBox), expressed as absolute cubic control points.
MINT_CURVE = _bezier([(142, 319), (194, 309), (209, 219), (255, 228), (290, 235), (289, 301), (370, 260)])
GOLD_CURVE = _bezier([(143, 266), (200, 298), (234, 306), (269, 264), (306, 220), (328, 214), (370, 198)])


def _draw_polyline(draw: ImageDraw.ImageDraw, pts: list[tuple[float, float]], width: float, fill, scale: float) -> None:
    scaled = [(x * scale, y * scale) for x, y in pts]
    draw.line(scaled, fill=fill, width=max(1, round(width * scale)), joint="curve")
    radius = width * scale / 2
    for x, y in (scaled[0], scaled[-1]):
        draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=fill)


def render_icon(size: int, *, maskable: bool = False, transparent_bg: bool = False) -> Image.Image:
    big = size * SUPERSAMPLE
    scale = big / 512
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if maskable:
        # Maskable icons must fill the whole square; keep the artwork inside the 80% safe zone.
        draw.rectangle([0, 0, big, big], fill=BG)
        inset = 0.1
    else:
        if not transparent_bg:
            draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=round(116 * scale), fill=BG)
        inset = 0.0

    def tf(x: float, y: float) -> tuple[float, float]:
        return (x * (1 - 2 * inset) + 512 * inset, y * (1 - 2 * inset) + 512 * inset)

    art_scale = scale * (1 - 2 * inset)
    cx, cy = tf(256, 256)
    r = 174 * art_scale
    ring_w = max(1, round(24 * art_scale))
    draw.ellipse([cx * scale - r, cy * scale - r, cx * scale + r, cy * scale + r], outline=GOLD, width=ring_w)

    mint_pts = [tf(x, y) for x, y in MINT_CURVE]
    gold_pts = [tf(x, y) for x, y in GOLD_CURVE]
    _draw_polyline(draw, mint_pts, 29 * (1 - 2 * inset), MINT, scale)
    _draw_polyline(draw, gold_pts, 19 * (1 - 2 * inset), GOLD, scale)
    dx, dy = tf(370, 198)
    dr = 17 * art_scale
    draw.ellipse([dx * scale - dr, dy * scale - dr, dx * scale + dr, dy * scale + dr], fill=PALE)

    return image.resize((size, size), Image.LANCZOS)


def render_badge(size: int) -> Image.Image:
    """Monochrome badge: white artwork on transparent, as Android/Chrome expects."""
    icon = render_icon(size, transparent_bg=True)
    alpha = icon.getchannel("A")
    white = Image.new("RGBA", icon.size, (255, 255, 255, 255))
    white.putalpha(alpha)
    return white


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    render_icon(180).save(OUT / "icon-180.png")
    render_icon(192).save(OUT / "icon-192.png")
    render_icon(512).save(OUT / "icon-512.png")
    render_icon(512, maskable=True).save(OUT / "icon-maskable-512.png")
    render_badge(96).save(OUT / "badge-96.png")
    for path in sorted(OUT.glob("*.png")):
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
