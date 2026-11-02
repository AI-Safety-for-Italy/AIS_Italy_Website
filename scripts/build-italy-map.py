#!/usr/bin/env python3
"""Generate src/components/italy-map.njk, the inside of the home hero map:
the 20 Italian regions, the community's cities, and the links between them.

Source: Natural Earth 1:10m admin-1 provinces (public domain), merged into
regions.
Mercator in a 0 0 420 560 viewBox, the same projection as the map on the
Community page, whose cities (data/about.yaml, map.cities) it reads as they
are. The map is tilted into a slab (TILT), cities are pins, and LINKS are arcs
above straight shadows on the map: a decorative mesh anchored at Milano and
Roma, not a record of collaborations or official chapters.

Regions get a decorative tricolore band (BANDS) and CSS custom properties:
  --dx/--dy  unit direction away from the centre (scroll drift)
  --rnd      0-1 pseudo-random value (drift spin)
Links and cities get --t0 (start, seconds) and links --dur: the network draws
outward from Milano and Roma within a fixed, short drawing window. Long links
also get --pulse/--pulse-delay for a light that travels them a few times.

Usage: python3 scripts/build-italy-map.py (requires scripts/requirements.txt)
"""
import json
import math
import os
import random
import urllib.request
from pathlib import Path

import yaml

# Public domain, so the map needs no attribution. About 40 MB: the whole world.
URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson"
# Natural Earth's English region names, in Italian
NAMES = {"Apulia": "Puglia", "Sicily": "Sicilia"}
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "components", "italy-map.njk")

# The Community map's city list; this script only reads it.
ABOUT = Path(__file__).resolve().parents[1] / "data" / "about.yaml"

# Decorative flag bands: western, central, eastern/southern regions.
# These colours do not encode member counts or regional activity.
BANDS = {
    "Valle d'Aosta": "g",
    "Piemonte": "g",
    "Liguria": "g",
    "Lombardia": "g",
    "Sardegna": "g",
    "Trentino-Alto Adige": "w",
    "Veneto": "w",
    "Emilia-Romagna": "w",
    "Toscana": "w",
    "Umbria": "w",
    "Marche": "w",
    "Lazio": "w",
    "Friuli-Venezia Giulia": "r",
    "Abruzzo": "r",
    "Molise": "r",
    "Campania": "r",
    "Puglia": "r",
    "Basilicata": "r",
    "Calabria": "r",
    "Sicilia": "r",
}
# Hero links: a chain through the north down to Napoli, plus long arcs from
# Milano and Roma. Each pair is drawn once.
LINKS = [
    ("Torino", "Milano"),
    ("Milano", "Padova"),
    ("Padova", "Udine"),
    ("Udine", "Trieste"),
    ("Padova", "Bologna"),
    ("Bologna", "Firenze"),
    ("Firenze", "Roma"),
    ("Roma", "Napoli"),
    ("Milano", "Roma"),
    ("Roma", "Cagliari"),
]
START = 0.35  # seconds before the network starts, as the map settles
DRAW_TIME = 1.35  # seconds for the entire network to draw

# The map lies on a tilted plane: an oblique view that leans the boot back and
# shortens it vertically. Up on screen is "up" off the map, so pins stand on
# stems and links rise as arcs above their shadows. main.js reads the matrix
# from the SVG and uses the same arc() below, so keep the two in step.
TILT = (1.0, 0.0, -0.12, 0.8, 0.12 * 280, 66.0)  # SVG matrix(a b c d e f)
PIN = 5.0  # stem height of a city pin
ANCHOR_PIN = 9.0  # Milano and Roma stand taller
PULSE_MIN = 60  # links at least this long carry a travelling pulse


def tilt(x, y):
    a, b, c, d, e, f = TILT
    return (a * x + c * y + e, b * x + d * y + f)


def arc(head1, head2, length, bend):
    """Control point of a link arc between two pin heads (screen coordinates).

    The arc rises by up to 26 units, in proportion to the link's length on the
    map, and bows a little sideways so north-south links still read as curves.
    """
    (x1, y1), (x2, y2) = head1, head2
    dx, dy = x2 - x1, y2 - y1
    bow = min(0.14, 18 / (math.hypot(dx, dy) or 1)) * bend
    lift = min(26, 0.14 * length)
    return ((x1 + x2) / 2 - dy * bow, (y1 + y2) / 2 + dx * bow - 2 * lift)

# Mercator fitted to the existing Community map coordinate system.
A, B, C, D = 33.06092650497609, -205.1500934915567, -33.064321196790914, 1817.2888772983285


def merc(lat):
    return math.degrees(math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def project(lon, lat):
    return (A * lon + B, C * merc(lat) + D)


def simplify(pts, eps):
    """Douglas-Peucker on an open polyline."""
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    length = math.hypot(x2 - x1, y2 - y1) or 1e-9
    idx, dmax = 0, 0
    for k in range(1, len(pts) - 1):
        x, y = pts[k]
        d = abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / length
        if d > dmax:
            idx, dmax = k, d
    if dmax > eps:
        return simplify(pts[: idx + 1], eps)[:-1] + simplify(pts[idx:], eps)
    return [pts[0], pts[-1]]


def simplify_chain(chain, eps):
    # Always simplify in the same direction, so a border shared by two regions
    # comes out identical in both and the regions meet without gaps.
    if chain[0] > chain[-1]:
        return simplify(chain[::-1], eps)[::-1]
    return simplify(chain, eps)


def simplify_ring(ring, owners, eps=0.45):
    """Simplify a closed ring border by border.

    `owners` maps each vertex to the set of rings it belongs to. The ring is cut
    wherever that set changes, each piece (a coast, or a border with one
    neighbour) is simplified on its own, and the cut points are kept.
    """
    ring = ring[:-1]  # drop the closing duplicate
    n = len(ring)
    cuts = [i for i in range(n) if owners[ring[i]] != owners[ring[i - 1]]]
    if not cuts:
        # An island: split at the farthest point so both halves have distinct ends.
        far = max(range(n), key=lambda k: math.dist(ring[k], ring[0]))
        return simplify_chain(ring[: far + 1], eps)[:-1] + simplify_chain(ring[far:] + ring[:1], eps)[:-1]
    out = []
    for a, b in zip(cuts, cuts[1:] + [cuts[0] + n]):
        # piece from cut a up to (but not including) cut b; the last vertex
        # before b is kept, since it is also an endpoint of a border
        piece = [ring[i % n] for i in range(a, b)]
        out += simplify_chain(piece, eps) if len(piece) > 1 else piece
    return out


def dissolve(rings):
    """Merge polygons that share borders into the rings of their union.

    Provinces of a region meet along identical vertices, so every inner border
    edge appears twice (once each way) and cancels; the edges left over chain
    into the region's outlines.
    """
    edges = {}
    for ring in rings:
        for a, b in zip(ring, ring[1:]):
            if (b, a) in edges:
                del edges[(b, a)]
            else:
                edges[(a, b)] = True
    nexts = {}
    for a, b in edges:
        nexts.setdefault(a, []).append(b)
    out = []
    while nexts:
        start = next(iter(nexts))
        ring, pt = [start], start
        while True:
            after = nexts[pt].pop()
            if not nexts[pt]:
                del nexts[pt]
            ring.append(after)
            if after == start:
                break
            pt = after
        out.append(ring)
    return out


def inside(pt, ring):
    """Even-odd test: is the point inside the polygon ring?"""
    x, y = pt
    hit = False
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            hit = not hit
    return hit


def area_centroid(ring):
    a = cx = cy = 0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        cr = x0 * y1 - x1 * y0
        a += cr
        cx += (x0 + x1) * cr
        cy += (y0 + y1) * cr
    a /= 2
    return abs(a), (cx / (6 * a), cy / (6 * a))


def main():
    with urllib.request.urlopen(URL) as resp:
        geo = json.load(resp)

    provinces = {}
    for feat in geo["features"]:
        if feat["properties"]["adm0_a3"] != "ITA":
            continue
        geom = feat["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        region = feat["properties"]["region"]
        provinces.setdefault(NAMES.get(region, region), []).extend(
            [tuple(pt) for pt in poly[0]] for poly in polys)

    features = []
    owners = {}
    for f, (name, outlines) in enumerate(provinces.items()):
        rings = [[project(*pt) for pt in ring] for ring in dissolve(outlines)]
        for r, ring in enumerate(rings):
            for pt in ring:
                owners.setdefault(pt, set()).add((f, r))
        features.append((name, rings))
    owners = {pt: frozenset(o) for pt, o in owners.items()}

    regions = []
    for name, rings in features:
        parts, best = [], (0, None)
        for ring in rings:
            xs, ys = [p[0] for p in ring], [p[1] for p in ring]
            if (max(xs) - min(xs)) * (max(ys) - min(ys)) < 6:
                continue  # drop islets too small to see
            simple = simplify_ring(ring, owners)
            if len(simple) < 3:
                continue
            parts.append("M" + "L".join("%.1f,%.1f" % p for p in simple) + "Z")
            area, cen = area_centroid(ring)
            if area > best[0]:
                best = (area, cen)
        regions.append({"path": "".join(parts), "c": best[1], "band": BANDS[name], "name": name, "rings": rings})

    # Animation parameters
    centre = (210, 280)
    rng = random.Random(7)
    for r in regions:
        vx, vy = r["c"][0] - centre[0], r["c"][1] - centre[1]
        n = math.hypot(vx, vy) or 1
        r["dx"], r["dy"] = vx / n, vy / n
        r["rnd"] = rng.random()

    cities = yaml.safe_load(ABOUT.read_text())["map"]["cities"]
    pts = [(city["x"], city["y"]) for city in cities]
    n = len(pts)
    by_name = {city["name"]: i for i, city in enumerate(cities)}
    edges = sorted((tuple(sorted((by_name[a], by_name[b]))) for a, b in LINKS),
                   key=lambda edge: math.dist(pts[edge[0]], pts[edge[1]]))

    # Each pin rides on the region it stands in (or, for a city right on the
    # coast, the region with the nearest boundary point) when the map drifts.
    def region_of(pt):
        for index, r in enumerate(regions):
            if any(inside(pt, ring) for ring in r["rings"]):
                return index
        return min(range(len(regions)),
                   key=lambda k: min(math.dist(pt, q) for ring in regions[k]["rings"] for q in ring))

    city_regions = [region_of(pt) for pt in pts]

    # Draw outward from both visual anchors at the same time.
    def arrivals(sources):
        t = {src: 0.0 for src in sources}
        todo = set(range(n))
        while todo:
            u = min((c for c in todo if c in t), key=t.get)
            todo.remove(u)
            for i, j in edges:
                if u in (i, j):
                    v = j if u == i else i
                    t[v] = min(t.get(v, math.inf), t[u] + math.dist(pts[u], pts[v]))
        return t

    t = arrivals([by_name["Milano"], by_name["Roma"]])
    # Keep total entrance time stable when the city list or long island links change.
    finish = max(min(t[i], t[j]) + math.dist(pts[i], pts[j]) for i, j in edges)
    speed = finish / DRAW_TIME

    # Screen geometry on the tilted plane: pin feet sit on the map, heads above.
    anchors = ("Milano", "Roma")
    stems = [ANCHOR_PIN if city["name"] in anchors else PIN for city in cities]
    feet = [tilt(*p) for p in pts]
    heads = [(x, y - h) for (x, y), h in zip(feet, stems)]

    lines = [
        "{#- GENERATED by scripts/build-italy-map.py; do not edit by hand.",
        "    Region boundaries: Natural Earth (public domain). -#}",
        # The slab: the map's silhouette swept a few units down makes a solid
        # side (coloured by .map-side-colour), under a soft drop shadow.
        '<defs><filter id="map-slab" x="-10%" y="-10%" width="120%" height="125%" color-interpolation-filters="sRGB">',
        "".join('<feOffset in="SourceAlpha" dy="%d" result="s%d"/>' % (k, k) for k in range(1, 7)),
        '<feMerge result="sweep">' + "".join('<feMergeNode in="s%d"/>' % k for k in range(1, 7)) + "</feMerge>",
        '<feFlood class="map-side-colour"/><feComposite in2="sweep" operator="in" result="side"/>',
        '<feGaussianBlur in="SourceAlpha" stdDeviation="5"/><feOffset dy="14" result="drop"/>'
        '<feComponentTransfer in="drop" result="shadow"><feFuncA type="linear" slope="0.2"/></feComponentTransfer>',
        '<feMerge><feMergeNode in="shadow"/><feMergeNode in="side"/><feMergeNode in="SourceGraphic"/></feMerge>',
        "</filter></defs>",
        '<g class="map-plane" transform="matrix(%s)">' % " ".join("%g" % v for v in TILT),
        '<g class="map-regions" filter="url(#map-slab)">',
    ]
    for r in regions:
        lines.append(
            '<path class="rg" data-name="%s" data-band="%s" style="--dx:%.2f;--dy:%.2f;--rnd:%.2f" d="%s"/>'
            % (r["name"], r["band"], r["dx"], r["dy"], r["rnd"], r["path"])
        )
    lines.append('</g>\n</g>\n<g class="map-shadows">')
    # Longest links first, so the short local arcs are drawn on top.
    order = edges[::-1]
    for k, (i, j) in enumerate(order):
        (x1, y1), (x2, y2) = feet[i], feet[j]
        lines.append('<path style="--t0:%.2fs;--dur:%.2fs" d="M%.1f,%.1f L%.1f,%.1f"/>'
                     % (START + min(t[i], t[j]) / speed, math.dist(pts[i], pts[j]) / speed, x1, y1, x2, y2))
    lines.append('</g>\n<g class="map-links">')
    pulse = random.Random(11)
    for i, j in order:
        u, v = (i, j) if t[i] <= t[j] else (j, i)  # draw from the city reached first
        length = math.dist(pts[u], pts[v])
        bend = 1 if u == i else -1
        (x1, y1), (x2, y2) = heads[u], heads[v]
        mx, my = arc(heads[u], heads[v], length, bend)
        d = "M%.1f,%.1f Q%.1f,%.1f %.1f,%.1f" % (x1, y1, mx, my, x2, y2)
        style = "--t0:%.2fs;--dur:%.2fs" % (START + t[u] / speed, length / speed)
        extra = ""
        if length >= PULSE_MIN:
            # A light travels the link a few times, at a common speed.
            style += ";--pulse:%.2fs;--pulse-delay:%.2fs" % (2 + length / 45, 2.5 + pulse.random() * 4)
            extra = '<path class="link-pulse" pathLength="1" d="%s"/>' % d
        lines.append(
            '<g class="link" data-from="%d" data-to="%d" data-bend="%d" style="%s">'
            '<path class="link-case" pathLength="1" d="%s"/><path class="link-line" pathLength="1" d="%s"/>%s</g>'
            % (u, v, bend, style, d, d, extra)
        )
    lines.append('</g>\n<g class="map-cities">')
    for c, city in enumerate(cities):
        name = city["name"]
        (x, y), h = feet[c], stems[c]
        nearest = min(math.dist(heads[c], other) for i, other in enumerate(heads) if i != c)
        hit = min(12, max(4, nearest / 2))
        anchor = name in anchors
        lines.append(
            '<g class="city%s" data-region="%d" data-x="%.1f" data-y="%.1f" data-h="%.1f" tabindex="0" role="img" aria-label="%s" style="--t0:%.2fs" transform="translate(%.1f %.1f)">'
            '<g class="city-pin"><ellipse class="city-foot" rx="2.2" ry="1"/><path class="city-stem" d="M0,0V%.1f"/>'
            '<circle class="city-hit" cy="%.1f" r="%.1f"/>%s<circle class="city-dot" cy="%.1f" r="%.1f"/></g></g>'
            % (" city--anchor" if anchor else "", city_regions[c], pts[c][0], pts[c][1], h, name,
               START + t[c] / speed, x, y, -h, -h, hit,
               '<circle class="city-ring" cy="%.1f" r="3.6"/>' % -h if anchor else "", -h, 3.6 if anchor else 2.4)
        )
    lines.append("</g>")
    with open(OUT, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    print("wrote", OUT, sum(len(r["path"]) for r in regions), "bytes of path data")


if __name__ == "__main__":
    main()
