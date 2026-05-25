"""
NestFlow — Nesting Server v3.0 (Python + Packaide)
Replaces server.js with a two-pass Packaide nesting engine:
  Pass 1 — rectangular parts,  rotations=4  (fast)
  Pass 2 — rounded parts fill gaps,  rotations=8  (better for curves)
  Pass 3 — overflow rounded parts that didn't fit, nested standalone

Usage:
  pip install flask flask-cors packaide
  python server.py

Stop: Ctrl+C
"""

import os
import sys
import json
import math
import re
import xml.etree.ElementTree as ET
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS

# ── Packaide import with graceful fallback ────────────────────────────────────
try:
    import packaide
    PACKAIDE_AVAILABLE = True
except ImportError:
    PACKAIDE_AVAILABLE = False
    print("  WARNING: packaide not installed — using fallback shelf packer.")
    print("  Install with: pip install packaide")

PORT = int(os.environ.get("PORT", 3000))

app = Flask(__name__)
CORS(app)

# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/ping", methods=["GET"])
def ping():
    engine = "Packaide NFP two-pass v3.0" if PACKAIDE_AVAILABLE else "Fallback shelf packer v3.0"
    return jsonify({"ok": True, "engine": engine, "version": "3.0.0"})


@app.route("/nest", methods=["POST"])
def nest():
    payload = request.get_json(force=True)
    sheet   = payload.get("sheet")
    parts   = payload.get("parts", [])
    spacing = float(payload.get("spacing", 2))

    if not sheet or not parts:
        return jsonify({"error": "Invalid payload — sheet and parts required"}), 400

    sw, sh = float(sheet["w"]), float(sheet["h"])
    print(f"  Nesting {len(parts)} parts on {sw}×{sh}mm sheet")

    try:
        if PACKAIDE_AVAILABLE:
            result = run_two_pass(parts, sw, sh, spacing)
        else:
            result = run_fallback(parts, sw, sh, spacing)

        print(f"  Done — {len(result['sheets'])} sheet(s)")
        return jsonify(result)

    except Exception as e:
        print(f"  Nesting error: {e}", file=sys.stderr)
        return jsonify({"error": str(e)}), 500


@app.route("/", methods=["GET"])
@app.route("/index.html", methods=["GET"])
@app.route("/nestflow.html", methods=["GET"])
def serve_html():
    html_path = os.path.join(os.path.dirname(__file__), "nestflow.html")
    if os.path.exists(html_path):
        return send_file(html_path, mimetype="text/html")
    return "nestflow.html not found — please place it next to server.py", 404


# ─────────────────────────────────────────────────────────────────────────────
# Two-pass Packaide nesting
# ─────────────────────────────────────────────────────────────────────────────

def run_two_pass(parts, sw, sh, spacing):
    """
    Pass 1: rectangular parts, rotations=4
    Pass 2: rounded parts fill gaps left by pass 1, rotations=8
    Pass 3: any overflow rounded parts that didn't fit, nested standalone
    """
    rect_parts    = [p for p in parts if is_rectangular(p)]
    rounded_parts = [p for p in parts if not is_rectangular(p)]

    print(f"  Split: {len(rect_parts)} rectangular, {len(rounded_parts)} rounded")

    sheet_svg = build_sheet_svg(sw, sh)

    # ── Pass 1: rectangles ────────────────────────────────────────────────────
    pass1_sheets = []
    rect_placed  = {}   # idx → (sheet_index, x, y, rotation, w, h)

    if rect_parts:
        rect_svg = build_shapes_svg(rect_parts)
        raw1 = packaide.pack(
            sheet_svg,
            rect_svg,
            tolerance=0.5,
            offset=spacing,
            rotations=4,
            partial_solution=True,
        )
        pass1_sheets = raw1
        rect_placed  = parse_placements(raw1, rect_parts, sw, sh)
        print(f"  Pass 1 done — {len(pass1_sheets)} sheet(s), {len(rect_placed)} rectangles placed")

    # ── Pass 2: rounded parts fill gaps ──────────────────────────────────────
    pass2_sheets      = []
    rounded_placed    = {}
    rounded_overflow  = []

    if rounded_parts:
        rounded_svg = build_shapes_svg(rounded_parts)

        # Feed pass1 result as fixed obstacles so rounded parts fill the gaps
        fixed_svg = pass1_sheets if pass1_sheets else None

        raw2 = packaide.pack(
            sheet_svg,
            rounded_svg,
            fixed=fixed_svg,
            tolerance=0.5,
            offset=spacing,
            rotations=8,
            partial_solution=True,
        )
        pass2_sheets   = raw2
        rounded_placed = parse_placements(raw2, rounded_parts, sw, sh)

        # Detect overflow — rounded parts that didn't get placed into pass1 sheets
        placed_ids     = set(rounded_placed.keys())
        all_rounded_ids = {p["idx"] for p in rounded_parts}
        overflow_ids   = all_rounded_ids - placed_ids
        rounded_overflow = [p for p in rounded_parts if p["idx"] in overflow_ids]

        print(f"  Pass 2 done — {len(rounded_placed)} rounded placed, {len(rounded_overflow)} overflow")

    # ── Pass 3: overflow rounded parts standalone ─────────────────────────────
    pass3_sheets   = []
    overflow_placed = {}

    if rounded_overflow:
        overflow_svg = build_shapes_svg(rounded_overflow)
        raw3 = packaide.pack(
            sheet_svg,
            overflow_svg,
            tolerance=0.5,
            offset=spacing,
            rotations=8,
            partial_solution=True,
        )
        pass3_sheets    = raw3
        overflow_placed = parse_placements(raw3, rounded_overflow, sw, sh)
        print(f"  Pass 3 done — {len(pass3_sheets)} overflow sheet(s)")

    # ── Merge all passes into unified sheet list ──────────────────────────────
    return merge_all(
        rect_placed, rounded_placed, overflow_placed,
        pass1_sheets, pass2_sheets, pass3_sheets,
        parts, sw, sh
    )


# ─────────────────────────────────────────────────────────────────────────────
# SVG construction helpers
# ─────────────────────────────────────────────────────────────────────────────

def build_sheet_svg(w, h):
    """Build the sheet boundary SVG that Packaide uses as the bin."""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{w}mm" height="{h}mm" viewBox="0 0 {w} {h}">'
        f'<rect id="sheet" x="0" y="0" width="{w}" height="{h}"/>'
        f'</svg>'
    )


def build_shapes_svg(parts):
    """
    Convert a list of parts (each with a 'points' polygon) into a single SVG
    containing one <polygon> or <path> per part, tagged with data-idx.
    """
    shapes = []
    for p in parts:
        idx    = p["idx"]
        points = p.get("points", [])
        w, h   = float(p.get("w", 0)), float(p.get("h", 0))

        if len(points) >= 3:
            pts_str = " ".join(f"{pt['x']},{pt['y']}" for pt in points)
            shape = (
                f'<polygon data-idx="{idx}" '
                f'points="{pts_str}"/>'
            )
        else:
            # Fallback: rectangle
            shape = (
                f'<rect data-idx="{idx}" '
                f'x="0" y="0" width="{w}" height="{h}"/>'
            )
        shapes.append(shape)

    total_w = max((float(p.get("w", 0)) for p in parts), default=100)
    total_h = max((float(p.get("h", 0)) for p in parts), default=100)

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {total_w} {total_h}">'
        + "".join(shapes)
        + "</svg>"
    )


# ─────────────────────────────────────────────────────────────────────────────
# SVG output parser — extract placements from Packaide result SVGs
# ─────────────────────────────────────────────────────────────────────────────

def parse_placements(result_svgs, parts, sw, sh):
    """
    Packaide returns a list of SVG strings, one per output sheet.
    Each placed shape has a transform="translate(x,y) rotate(r)" attribute
    and retains the data-idx from the input.

    Returns dict: { idx → {sheet_index, x, y, rotation, w, h} }
    """
    if not result_svgs:
        return {}

    parts_by_idx = {p["idx"]: p for p in parts}
    placed = {}

    for sheet_i, svg_str in enumerate(result_svgs):
        try:
            root = ET.fromstring(svg_str)
        except ET.ParseError:
            continue

        # Find all elements with data-idx (polygon, rect, path, g)
        ns = {"svg": "http://www.w3.org/2000/svg"}
        for el in root.iter():
            idx = el.get("data-idx")
            if idx is None:
                continue
            idx = int(idx)
            transform = el.get("transform", "")
            x, y, rot = parse_transform(transform)
            part = parts_by_idx.get(idx, {})
            w = float(part.get("w", 0))
            h = float(part.get("h", 0))
            # Swap w/h if rotated 90 or 270
            if rot in (90, 270) or rot in (-90, -270):
                w, h = h, w
            placed[idx] = {
                "sheet_index": sheet_i,
                "x":   round(x, 3),
                "y":   round(y, 3),
                "rotation": rot,
                "w":   round(w, 3),
                "h":   round(h, 3),
            }

    return placed


def parse_transform(t):
    """Extract x, y, rotation from an SVG transform string."""
    x, y, rot = 0.0, 0.0, 0.0
    tr = re.search(r"translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)", t)
    if tr:
        x, y = float(tr.group(1)), float(tr.group(2))
    ro = re.search(r"rotate\(\s*([-\d.]+)", t)
    if ro:
        rot = float(ro.group(1))
    return x, y, rot


# ─────────────────────────────────────────────────────────────────────────────
# Merge passes into the response format the frontend expects
# ─────────────────────────────────────────────────────────────────────────────

def merge_all(
    rect_placed, rounded_placed, overflow_placed,
    pass1_svgs, pass2_svgs, pass3_svgs,
    parts, sw, sh
):
    """
    Combine placements from all three passes into the unified
    { sheets: [ { index, placements: [{idx, x, y, rotation, placedW, placedH}] } ] }
    format that nestflow.html expects.
    """
    parts_by_idx = {p["idx"]: p for p in parts}

    # Count how many sheets pass1/pass2 together produced
    # (pass2 uses fixed= so it operates on the same sheets as pass1,
    #  with possible new sheets for overflow that pass3 handles better)
    n_shared_sheets = max(len(pass1_svgs), len(pass2_svgs), 1)

    # Build per-sheet placement lists
    sheet_map = {}  # sheet_index → [placement, ...]

    def add_to_sheet(placed_dict):
        for idx, pl in placed_dict.items():
            si = pl["sheet_index"]
            if si not in sheet_map:
                sheet_map[si] = []
            part = parts_by_idx.get(idx, {})
            sheet_map[si].append({
                "idx":      idx,
                "x":        pl["x"],
                "y":        pl["y"],
                "rotation": pl["rotation"],
                "placedW":  pl["w"],
                "placedH":  pl["h"],
                "partName": part.get("partName", ""),
                "w":        float(part.get("w", pl["w"])),
                "h":        float(part.get("h", pl["h"])),
            })

    add_to_sheet(rect_placed)
    add_to_sheet(rounded_placed)

    # Pass 3 overflow sheets get new indices after the shared sheets
    pass3_offset = n_shared_sheets
    overflow_shifted = {
        idx: {**pl, "sheet_index": pl["sheet_index"] + pass3_offset}
        for idx, pl in overflow_placed.items()
    }
    add_to_sheet(overflow_shifted)

    # Sort and build final sheet list
    sheets = []
    for si in sorted(sheet_map.keys()):
        placements = sheet_map[si]
        util = calc_utilisation(placements, sw, sh)
        sheets.append({
            "index":      si + 1,
            "placements": placements,
            "utilisation": util,
        })

    return {"sheets": sheets}


def calc_utilisation(placements, sw, sh):
    area = sum(p["placedW"] * p["placedH"] for p in placements)
    return min(99, round(area / (sw * sh) * 100))


# ─────────────────────────────────────────────────────────────────────────────
# Rectangular detection
# ─────────────────────────────────────────────────────────────────────────────

def is_rectangular(part):
    """
    A part is rectangular if its outline has exactly 4 points.
    The frontend's polylineToPoints() flattens DXF bulge arcs into
    extra intermediate vertices, so rounded parts always arrive with >4 points.
    """
    pts = part.get("points", [])
    if len(pts) == 0:
        # No polygon data — treat as rectangular (will use w/h rect fallback)
        return True
    return len(pts) == 4


# ─────────────────────────────────────────────────────────────────────────────
# Fallback shelf packer (used when Packaide is not installed)
# ─────────────────────────────────────────────────────────────────────────────

def run_fallback(parts, sw, sh, spacing):
    """Simple shelf packer — no NFP, no rotation optimisation."""
    pad = spacing
    sheets = []
    cur_placements = []
    x, y, row_h = pad, pad, 0

    for p in parts:
        idx = p["idx"]
        w   = float(p.get("w", 10))
        h   = float(p.get("h", 10))
        pw  = w + pad
        ph  = h + pad

        if x + pw > sw - pad:
            x = pad
            y += row_h + pad
            row_h = 0

        if y + ph > sh - pad:
            sheets.append(cur_placements)
            cur_placements = []
            x, y, row_h = pad, pad, 0

        cur_placements.append({
            "idx":      idx,
            "x":        round(x, 3),
            "y":        round(y, 3),
            "rotation": 0,
            "placedW":  round(w, 3),
            "placedH":  round(h, 3),
            "partName": p.get("partName", ""),
            "w":        w,
            "h":        h,
        })
        if ph > row_h:
            row_h = ph
        x += pw

    if cur_placements:
        sheets.append(cur_placements)

    return {
        "sheets": [
            {
                "index":       i + 1,
                "placements":  pl,
                "utilisation": calc_utilisation(pl, sw, sh),
            }
            for i, pl in enumerate(sheets)
        ]
    }


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print()
    print("  +==========================================+")
    print("  |  NestFlow Nesting Server  v3.0          |")
    print(f"  |  Listening on http://localhost:{PORT}      |")
    if PACKAIDE_AVAILABLE:
        print("  |  Engine: Packaide NFP two-pass           |")
    else:
        print("  |  Engine: Fallback shelf packer           |")
    print("  +==========================================+")
    print()
    if not PACKAIDE_AVAILABLE:
        print("  To enable Packaide:")
        print("    pip install packaide")
        print("  (requires cmake, gcc, boost — see github.com/DanielLiamAnderson/Packaide)")
        print()
    print("  Open nestflow.html in Chrome or Edge to start.")
    print("  Press Ctrl+C to stop.")
    print()

    app.run(host="0.0.0.0", port=PORT, debug=False)
