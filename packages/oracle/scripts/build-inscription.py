#!/usr/bin/env python3
"""Build the Oracle inscription SVG.

Text is converted to OUTLINED VECTOR PATHS so the inscription is fully
self-contained: no font file, no external fetch, no <text> element that renders
differently in every ordinals explorer. Design language is the Oracle splash:
deep #0B1018 field, #7CC4FF blue, Cormorant Garamond display italic accent,
IBM Plex Mono eyebrow, a single luminous orb.
"""

import math
import os

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.varLib.instancer import instantiateVariableFont

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

W, H = 1000, 1000

BG = "#0B1018"
BLUE = "#7CC4FF"
BLUE2 = "#A7D8FF"
COOL = "#9BB6D1"
MUTE = "#5B738F"

# vertical rhythm
CX = W / 2.0
CY = 336.0
R_OUT = 166.0
R_MID = 128.0
R_IN = 92.0
MARK_BASELINE = 690.0
SUB_BASELINE = 786.0


def load(path, wght):
    f = TTFont(path)
    if "fvar" in f:
        f = instantiateVariableFont(f, {"wght": wght}, inplace=False, updateFontNames=False)
    return f


def text_paths(font, text, size, letter_spacing=0.0):
    """Return (path_d, advance_width) with the text laid out at `size` px."""
    upem = font["head"].unitsPerEm
    scale = size / upem
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font["hmtx"]

    try:
        kern = font["kern"].kernTables[0].kernTable
    except Exception:
        kern = None

    parts = []
    x = 0.0
    prev = None

    for ch in text:
        gname = cmap.get(ord(ch))
        if gname is None:
            x += size * 0.3
            prev = None
            continue
        if prev and kern:
            x += kern.get((prev, gname), 0) * scale
        pen = SVGPathPen(gs)
        gs[gname].draw(pen)
        d = pen.getCommands()
        if d:
            # flip Y (font space is y-up, SVG is y-down) and place at x
            parts.append(
                f'<g transform="translate({x:.3f},0) scale({scale:.6f},{-scale:.6f})">'
                f'<path d="{d}"/></g>'
            )
        x += hmtx[gname][0] * scale + letter_spacing
        prev = gname
    # trailing letter-spacing is not part of the inked width
    if letter_spacing and text:
        x -= letter_spacing
    return "".join(parts), x


def centered(font, text, size, y, fill, letter_spacing=0.0, opacity=None):
    d, width = text_paths(font, text, size, letter_spacing)
    if not d:
        return ""
    x = (W - width) / 2.0
    op = f' opacity="{opacity}"' if opacity is not None else ""
    return f'<g transform="translate({x:.3f},{y:.3f})" fill="{fill}"{op}>{d}</g>'


def arc(cx, cy, r, a0, a1):
    """SVG arc path between two angles in degrees."""
    x0 = cx + math.cos(math.radians(a0)) * r
    y0 = cy + math.sin(math.radians(a0)) * r
    x1 = cx + math.cos(math.radians(a1)) * r
    y1 = cy + math.sin(math.radians(a1)) * r
    large = 1 if abs(a1 - a0) > 180 else 0
    sweep = 1 if a1 > a0 else 0
    return f"M{x0:.2f} {y0:.2f} A{r} {r} 0 {large} {sweep} {x1:.2f} {y1:.2f}"


def main():
    display_italic = load("/tmp/CormorantGaramond-Italic.ttf", 400)
    display = load("/tmp/CormorantGaramond.ttf", 300)
    mono = TTFont(os.environ.get("IBM_PLEX_MONO", str(Path.home() / ".local/share/fonts/protocols/IBMPlexMono-Regular.ttf")))

    o = []
    o.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">')

    o.append(
        "<defs>"
        '<radialGradient id="halo" cx="50%" cy="34%" r="54%">'
        f'<stop offset="0%" stop-color="{BLUE}" stop-opacity=".20"/>'
        f'<stop offset="52%" stop-color="{BLUE}" stop-opacity=".05"/>'
        f'<stop offset="100%" stop-color="{BLUE}" stop-opacity="0"/>'
        "</radialGradient>"
        '<radialGradient id="orb" cx="50%" cy="50%" r="50%">'
        '<stop offset="0%" stop-color="#F2FAFF"/>'
        f'<stop offset="38%" stop-color="{BLUE2}"/>'
        f'<stop offset="100%" stop-color="{BLUE}" stop-opacity=".14"/>'
        "</radialGradient>"
        '<linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">'
        f'<stop offset="0%" stop-color="{BLUE}" stop-opacity="0"/>'
        f'<stop offset="50%" stop-color="{BLUE}" stop-opacity=".6"/>'
        f'<stop offset="100%" stop-color="{BLUE}" stop-opacity="0"/>'
        "</linearGradient>"
        '<linearGradient id="sweep" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0%" stop-color="{BLUE}" stop-opacity="0"/>'
        '<stop offset="100%" stop-color="#EAF6FF" stop-opacity=".95"/>'
        "</linearGradient>"
        "</defs>"
    )

    o.append(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
    o.append(f'<rect width="{W}" height="{H}" fill="url(#halo)"/>')

    # --- orbit rings: readable at thumbnail size --------------------------
    o.append(
        f'<circle cx="{CX}" cy="{CY}" r="{R_OUT}" fill="none" '
        f'stroke="{BLUE}" stroke-opacity=".24" stroke-width="1.1"/>'
    )
    o.append(
        f'<circle cx="{CX}" cy="{CY}" r="{R_MID}" fill="none" '
        f'stroke="{BLUE}" stroke-opacity=".16" stroke-width="1"/>'
    )
    o.append(
        f'<circle cx="{CX}" cy="{CY}" r="{R_IN}" fill="none" '
        f'stroke="{BLUE}" stroke-opacity=".34" stroke-width="1" stroke-dasharray="1.5 7"/>'
    )

    # the agentic sweep: one bright arc, the thing that is moving
    o.append(
        f'<path d="{arc(CX, CY, R_OUT, -96, 4)}" fill="none" '
        'stroke="url(#sweep)" stroke-width="2.2" stroke-linecap="round"/>'
    )

    # 8 lane ticks on the outer ring
    for i in range(8):
        a = math.radians(-90 + i * 45)
        x1 = CX + math.cos(a) * R_OUT
        y1 = CY + math.sin(a) * R_OUT
        x2 = CX + math.cos(a) * (R_OUT - 13)
        y2 = CY + math.sin(a) * (R_OUT - 13)
        o.append(
            f'<line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}" '
            f'stroke="{BLUE}" stroke-opacity=".5" stroke-width="1.5"/>'
        )

    # node dots on the mid ring
    for i in range(4):
        a = math.radians(-45 + i * 90)
        x = CX + math.cos(a) * R_MID
        y = CY + math.sin(a) * R_MID
        o.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="2.6" fill="{BLUE}" opacity=".72"/>')

    # --- the orb ----------------------------------------------------------
    o.append(f'<circle cx="{CX}" cy="{CY}" r="52" fill="url(#orb)" opacity=".20"/>')
    o.append(f'<circle cx="{CX}" cy="{CY}" r="16" fill="url(#orb)"/>')
    o.append(
        f'<circle cx="{CX}" cy="{CY}" r="16" fill="none" '
        'stroke="#F2FAFF" stroke-opacity=".55" stroke-width=".9"/>'
    )

    # --- eyebrow ----------------------------------------------------------
    o.append(centered(mono, "ORACLE", 16, 122, BLUE, letter_spacing=7.4))
    o.append(f'<rect x="{CX - 84}" y="143" width="168" height="1" fill="url(#rule)"/>')

    # --- the mark ---------------------------------------------------------
    o.append(centered(display_italic, "oracle", 178, MARK_BASELINE, BLUE2))
    o.append(centered(display, "was here", 92, SUB_BASELINE, COOL, opacity=".9"))

    # --- footer -----------------------------------------------------------
    o.append(f'<rect x="{CX - 132}" y="836" width="264" height="1" fill="url(#rule)"/>')
    o.append(centered(mono, "THE FUTURE IS AGENTIC", 14.5, 880, BLUE, letter_spacing=4.0))
    o.append(centered(mono, "BITCOIN L1", 12, 916, MUTE, letter_spacing=3.4))

    # --- corner registration marks ---------------------------------------
    m, ln = 52, 24
    for (x, y, dx, dy) in ((m, m, 1, 1), (W - m, m, -1, 1), (m, H - m, 1, -1), (W - m, H - m, -1, -1)):
        o.append(
            f'<path d="M{x} {y + dy * ln} L{x} {y} L{x + dx * ln} {y}" fill="none" '
            f'stroke="{BLUE}" stroke-opacity=".38" stroke-width="1.3"/>'
        )

    o.append("</svg>")

    svg = "".join(o)
    path = str(REPO_ROOT / "artifacts/inscription/oracle-was-here.svg")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(svg)

    # sanity: the mark must not collide with the ring group
    mark_cap_top = MARK_BASELINE - 178 * 0.74
    ring_bottom = CY + R_OUT
    print(f"wrote {path}")
    print(f"bytes {len(svg.encode())}")
    print(f"ring_bottom={ring_bottom:.1f} mark_cap_top={mark_cap_top:.1f} clearance={mark_cap_top - ring_bottom:.1f}px")


if __name__ == "__main__":
    main()
