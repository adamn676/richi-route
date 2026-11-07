"""The RichiRoute logo: an R drawn as one route line that ends at a waypoint. Builds every file in this folder and the
shapes of the iPhone app's icon (ios/RichiRoute/AppIcon.icon/Assets) from the construction below; see README.md.
"""
import math
import os

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from picosvg import svg_pathops
from picosvg.svg_transform import Affine2D
from picosvg.svg_types import SVGCircle, SVGPath

INK, LIGHT_INK, GREEN, WHITE, BLACK = "#121816", "#e6ebe9", "#0b7d58", "#ffffff", "#000000"
# line and waypoint colour of each version, by file-name suffix; the name takes the line's colour
COLOURWAYS = {"": (INK, GREEN), "-reversed": (LIGHT_INK, GREEN), "-ink": (INK, INK), "-black": (BLACK, BLACK),
              "-white": (WHITE, WHITE)}
FONT = os.environ.get("RICHIROUTE_LOGO_FONT", "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf")
OUT = os.path.dirname(os.path.abspath(__file__))
APP_ICON_ASSETS = os.path.join(OUT, "..", "..", "ios", "RichiRoute", "AppIcon.icon", "Assets")

# The construction on a 256 grid: the stem at STEM_X from TOP down, its top corner rounded by CORNER; the bowl of radius
# BOWL right of BOWL_X; at its foot a loop of radius LOOP from LOOP_X; then the leg at about 33° to the waypoint.
STEM_X, TOP, CORNER, BOWL_X, BOWL, LOOP_X, LOOP, DOT_X, DOT_Y = 76, 70, 22, 140, 34, 130, 16, 192, 214
# line width, waypoint radius and ring around it
REGULAR = (28, 24, 6)
# for 16–31 px: a heavier line and a wider ring, so the gap and the waypoint survive the pixels
SMALL = (34, 26, 10)


def circle(r):
    return list(SVGCircle(cx=DOT_X, cy=DOT_Y, r=r).as_path().arcs_to_cubics().as_cmd_seq())


def mark(width, dot, ring):
    """The line, its end cut back by the ring, and the waypoint, as filled outlines."""
    foot = TOP + 2 * BOWL
    a = math.atan2(DOT_Y - foot, DOT_X - LOOP_X)
    for _ in range(40):  # the leg leaves the loop on its tangent
        t = math.pi - a
        ex, ey = LOOP_X - LOOP * math.sin(t), foot + LOOP - LOOP * math.cos(t)
        a = math.atan2(DOT_Y - ey, DOT_X - ex)
    d = (f"M{STEM_X} {DOT_Y + dot - width / 2} V{TOP + CORNER} A{CORNER} {CORNER} 0 0 1 {STEM_X + CORNER} {TOP} "
         f"H{BOWL_X} A{BOWL} {BOWL} 0 0 1 {BOWL_X} {foot} H{LOOP_X} A{LOOP} {LOOP} 0 0 0 {ex} {ey} L{DOT_X} {DOT_Y}")
    # round caps and joins as the route on the map; the miter limit plays no part with them
    line = svg_pathops.stroke(SVGPath(d=d).arcs_to_cubics().as_cmd_seq(), "round", "round", width, 4, 0.05)
    line = list(svg_pathops.remove_overlaps(line, "nonzero"))
    line = list(svg_pathops.difference([line, circle(dot + ring)], ["nonzero", "nonzero"]))
    return [line, circle(dot)]


def bbox(parts):
    return svg_pathops.bounding_box([c for p in parts for c in p])


def placed(parts, transform):
    return [SVGPath.from_commands(p).apply_transform(transform).round_floats(2).d for p in parts]


def fit(parts, size, height, centre=None):
    """Scales the mark to a height and centres it, a little above the middle (optical centre)."""
    x0, y0, x1, y1 = bbox(parts)
    s = height / (y1 - y0)
    cx, cy = centre or (size / 2, size / 2 - size * 0.01)
    return Affine2D(s, 0, 0, s, cx - s * (x0 + x1) / 2, cy - s * (y0 + y1) / 2)


def write(path, view, ds, colours):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    body = "".join(f'<path fill="{c}" d="{d}"/>' for d, c in zip(ds, colours))
    with open(path, "w") as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {view[0]:g} {view[1]:g}" role="img">'
                f"<title>RichiRoute</title>{body}</svg>\n")


def wordmark(text="RichiRoute"):
    """The name in Noto Sans Bold, kerned, as outlines: its path commands and the font's cap height, in font units."""
    font = hb.Font(hb.Face(hb.Blob.from_file_path(FONT)))
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, {"kern": True, "liga": True})
    pen, x = SVGPathPen(None), 0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        # fonts point up, SVG down
        font.draw_glyph_with_pen(info.codepoint, TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, -pos.y_offset)))
        x += pos.x_advance
    word = list(SVGPath(d=pen.getCommands()).as_cmd_seq())
    return word, font.get_metric_position_with_fallback(hb.OTMetricsTag.CAP_HEIGHT)


def lockup(name, view, mark_t, word_t, symbol, word):
    for suffix, (line, dot) in COLOURWAYS.items():
        write(os.path.join(OUT, "lockup", f"richiroute-{name}{suffix}.svg"), view, placed(symbol, mark_t) + placed([word], word_t),
              [line, dot, line])


def main():
    symbol = mark(*REGULAR)
    for suffix, parts, height in [("", symbol, 200), ("-small", mark(*SMALL), 216)]:
        ds = placed(parts, fit(parts, 256, height))
        for variant, (line, dot) in COLOURWAYS.items():
            write(os.path.join(OUT, "symbol", f"richiroute-symbol{suffix}{variant}.svg"), (256, 256), ds, [line, dot])

    # app icon, 1024 square (the system rounds the corners); the mark about 56 % of the height
    route, waypoint = placed(symbol, fit(symbol, 1024, 570, centre=(512, 506)))
    # flat, for the web and the App Store page
    write(os.path.join(OUT, "app-icon", "richiroute-app-icon.svg"), (1024, 1024),
          ["M0 0H1024V1024H0Z", route, waypoint], [INK, LIGHT_INK, GREEN])
    # the shapes of the iPhone's Icon Composer icon, whose look (glass, shadow, the waypoint in front) is in its icon.json
    write(os.path.join(APP_ICON_ASSETS, "route.svg"), (1024, 1024), [route], [LIGHT_INK])
    write(os.path.join(APP_ICON_ASSETS, "waypoint.svg"), (1024, 1024), [waypoint], [GREEN])

    # lockups placed by what the eye sees: the ink of symbol and name, not the letters' advance widths
    word, cap = wordmark()
    x0, y0, x1, y1 = bbox(symbol)
    wx0, wy0, wx1, wy1 = bbox([word])
    sym_w, sym_h = x1 - x0, y1 - y0
    # the symbol 78 % of the lockup's height; the gap one bowl wide
    s = 256 / sym_h * 0.78
    pad, gap = (256 - sym_h * s) / 2, sym_h * 0.32 * s
    # horizontal: the name's cap height half the symbol's, its ink centred on the symbol
    k = sym_h * 0.5 / cap * s
    word_x = pad + sym_w * s + gap
    lockup("horizontal", (word_x + (wx1 - wx0) * k + pad, 256), Affine2D(s, 0, 0, s, pad - x0 * s, pad - y0 * s),
           Affine2D(k, 0, 0, k, word_x - wx0 * k, 128 - (wy0 + wy1) / 2 * k), symbol, word)
    # stacked: the symbol leads, the name centred under it, its cap height a third of the symbol's
    k = sym_h * 0.3 / cap * s
    width = max((wx1 - wx0) * k, sym_w * s) + 2 * pad
    word_y = pad + sym_h * s + gap * 0.6 - wy0 * k
    lockup("stacked", (width, word_y + wy1 * k + pad), Affine2D(s, 0, 0, s, (width - sym_w * s) / 2 - x0 * s, pad - y0 * s),
           Affine2D(k, 0, 0, k, (width - (wx1 - wx0) * k) / 2 - wx0 * k, word_y), symbol, word)


if __name__ == "__main__":
    main()
