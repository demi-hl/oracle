#!/usr/bin/env python3
"""Generate an art-direction variant of the Oracle splash.

The splash keeps its structure; only the colour story moves. 191 rgba() values
are baked into the CSS, but 72 of them are the accent tint (124,196,255) and 34
are the bg/panel greys -- those are SEMANTIC, not literal, so they can be
retargeted per variant instead of hand-edited.

Usage: make-variant.py <ivory|ice> <out.html>
"""
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "public/oracle-splash/index.html"

# (r,g,b) triplets that carry meaning in the source art direction.
ACCENT = (124, 196, 255)
ACCENT2 = (167, 216, 255)
GLOW = (184, 240, 255)
BG = (11, 16, 24)
PANEL = (17, 25, 37)

VARIANTS = {
    # Private-bank editorial. Warm paper, ink, bronze. Full light/dark flip.
    "ivory": {
        "tokens": {
            "--bg": "#FBF9F5",
            "--panel": "#F4F0E7",
            "--panel-2": "#EDE7DA",
            "--blue": "#8C6A3F",
            "--blue2": "#A8814E",
            "--blue-dim": "#B9A88C",
            "--ink": "#101113",
            "--cool": "#3A3D42",
            "--mute": "#6B6F76",
            "--line": "rgba(140,106,63,.20)",
            "--line-2": "rgba(140,106,63,.34)",
            "--evm": "#8C6A3F",
        },
        "rgb": {
            ACCENT: (140, 106, 63),
            ACCENT2: (168, 129, 78),
            GLOW: (196, 168, 122),
            BG: (251, 249, 245),
            PANEL: (244, 240, 231),
        },
        # On paper, white glows vanish and black shadows do the work.
        "white_to": (16, 17, 19),
        "scheme": "light",
    },
    # Stays dark, but colder and higher contrast: steel instead of navy,
    # ice-cyan accent instead of soft blue.
    "ice": {
        "tokens": {
            "--bg": "#06080B",
            "--panel": "#0C1117",
            "--panel-2": "#131A22",
            "--blue": "#B8F0FF",
            "--blue2": "#DEF8FF",
            "--blue-dim": "#4E7C8C",
            "--ink": "#FFFFFF",
            "--cool": "#D7E4EE",
            "--mute": "#8A9AA8",
            "--line": "rgba(184,240,255,.13)",
            "--line-2": "rgba(184,240,255,.26)",
            "--evm": "#B8F0FF",
        },
        "rgb": {
            ACCENT: (184, 240, 255),
            ACCENT2: (222, 248, 255),
            GLOW: (222, 248, 255),
            BG: (6, 8, 11),
            PANEL: (12, 17, 23),
        },
        "white_to": None,
        "scheme": "dark",
    },
}


def build(name: str, out: Path) -> None:
    v = VARIANTS[name]
    s = SRC.read_text()

    root = re.search(r":root\{(.*?)\}", s, re.S)
    block = root.group(0)
    new_block = block
    for tok, val in v["tokens"].items():
        new_block = re.sub(
            rf"(\s{re.escape(tok)}:)[^;]+;", rf"\g<1>{val};", new_block, count=1
        )
    s = s.replace(block, new_block, 1)

    # Retarget the semantic rgba bases everywhere else in the stylesheet.
    def swap(m):
        r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
        tail = m.group(4) or ""
        repl = v["rgb"].get((r, g, b))
        if repl:
            return f"rgba({repl[0]},{repl[1]},{repl[2]}{tail})"
        if (r, g, b) == (255, 255, 255) and v["white_to"]:
            w = v["white_to"]
            return f"rgba({w[0]},{w[1]},{w[2]}{tail})"
        return m.group(0)

    s = re.sub(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(,[^)]*)?\)", swap, s)

    # Hex forms of the same accent appear inline too.
    hex_map = {
        "#7CC4FF": v["tokens"]["--blue"],
        "#A7D8FF": v["tokens"]["--blue2"],
        "#B8F0FF": v["tokens"]["--blue2"],
    }
    for old, new in hex_map.items():
        s = s.replace(old, new).replace(old.lower(), new)

    if v["scheme"] == "light":
        # Let form controls and scrollbars follow the flip.
        s = s.replace(
            "<style>", "<style>\n:root{color-scheme:light}\n", 1
        )
        # Dark-tuned lifts read as smudges on paper; soften every shadow.
        s = re.sub(r"box-shadow:0 0 (\d+)px", lambda m: f"box-shadow:0 0 {max(2, int(m.group(1))//3)}px", s)


    # Variants are served from _variants/, one level below the splash root, so
    # every relative asset path needs to climb out. Done here rather than by
    # hand: a regenerate would otherwise silently reintroduce 404s.
    s = re.sub(r'(src|href)="(assets|brand)/', r'\g<1>="../\g<2>/', s)
    # 192 logos are injected from JS string literals, which the attribute regex
    # above never sees. Retarget those too or they 404 under _variants/.
    s = re.sub(r'(["\'])(assets/(?:wordmarks|llms|hero)/)', r'\g<1>../\g<2>', s)
    s = re.sub(r'(["\'])(brand/)', r'\g<1>../\g<2>', s)
    s = s.replace('../../', '../')

    # The hero orb is a VP9 plate baked onto a background colour, not alpha.
    # On dark, screen-blend drops the plate. On paper that fails, and inverting
    # smears the glow to grey (measured hero centre rgb ~181 vs ~251 expected),
    # so ivory gets an orb rendered onto paper and composited with NO blend mode.
    if v["scheme"] == "light":
        s = re.sub(r"mix-blend-mode:\s*screen", "mix-blend-mode:multiply", s)
        s = re.sub(
            r'\.\./assets/hero/orb\.webm(\?[^"\']*)?',
            '../assets/hero/orb-ivory.webm?v=30fps',
            s,
        )
    else:
        s = re.sub(
            r'\.\./assets/hero/orb\.webm(\?[^"\']*)?',
            '../assets/hero/orb.webm?v=30fps',
            s,
        )

    out.write_text(s)
    print(f"{name}: wrote {out} ({len(s)} bytes)")


if __name__ == "__main__":
    build(sys.argv[1], Path(sys.argv[2]))
