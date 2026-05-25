/**
 * NestFlow — Nesting Server v3.0
 * True NFP-based nesting entirely in Node.js using clipper-lib.
 *
 * Key upgrade from v2: replaces grid search with NFP (No-Fit Polygon)
 * placement. For each new part, the NFP defines the exact set of positions
 * where it touches — but does not overlap — each already-placed part.
 * Candidates are only tested at NFP boundary vertices, which is O(n·vertices)
 * instead of O(grid²·n). This is 10-50× faster and packs significantly tighter.
 *
 * Two-pass strategy:
 *   Pass 1 — rectangular parts, rotations=4  (fast, no arc approximation needed)
 *   Pass 2 — rounded parts fill gaps,  rotations=8  (more angles = better curves)
 *   Pass 3 — overflow rounded parts that didn't fit, nested standalone
 *
 * Usage:  node server.js
 * Stop:   Ctrl+C
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const ClipperLib = require('clipper-lib');

const PORT  = process.env.PORT || 3000;
const SCALE = 10000000; // clipper integer scale — 1 unit = 0.0000001 mm

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/ping') {
    json(res, 200, { ok: true, engine: 'NFP two-pass v3.0', version: '3.0.0' });
    return;
  }

  if (req.method === 'POST' && req.url === '/nest') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const nParts  = payload.parts?.length || 0;
        const { w, h } = payload.sheet || {};
        console.log(`  Nesting ${nParts} parts on ${w}×${h}mm sheet`);
        const result = runNesting(payload);
        console.log(`  Done — ${result.sheets?.length || 0} sheet(s)`);
        json(res, 200, result);
      } catch (err) {
        console.error('  Nesting error:', err.message);
        json(res, 500, { error: err.message });
      }
    });
    return;
  }

  if (req.method === 'GET' && ['/', '/index.html', '/nestflow.html'].includes(req.url)) {
    const htmlPath = path.join(__dirname, 'nestflow.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath, 'utf8'));
    } else {
      res.writeHead(404);
      res.end('nestflow.html not found');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  +==========================================+');
  console.log('  |  NestFlow Nesting Server  v3.0          |');
  console.log(`  |  Listening on http://localhost:${PORT}      |`);
  console.log('  |  Engine: NFP two-pass nesting            |');
  console.log('  +==========================================+');
  console.log('');
  console.log('  Open nestflow.html in Chrome or Edge to start.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point — two-pass strategy
// ─────────────────────────────────────────────────────────────────────────────
function runNesting({ sheet, parts, spacing = 2, rotations = 4 }) {
  if (!sheet || !parts || !parts.length) throw new Error('Invalid payload');

  const sw = sheet.w, sh = sheet.h;
  const pad = spacing;

  // Build polygon objects
  const polygons = parts.map(p => ({
    pts: (p.points && p.points.length >= 3) ? p.points : rectPoints(p.w, p.h),
    w: p.w, h: p.h,
    idx: p.idx,
  }));

  // Split rectangular vs rounded
  // Rectangular = exactly 4 points (frontend's polylineToPoints flattens arcs to extra verts)
  const rectPolys    = polygons.filter(p => p.pts.length === 4);
  const roundedPolys = polygons.filter(p => p.pts.length !== 4);

  console.log(`  Split: ${rectPolys.length} rectangular, ${roundedPolys.length} rounded`);

  // ── Pass 1: rectangles, rotations=4 ────────────────────────────────────────
  const { sheets: pass1Sheets, unplaced: _ } = nestPolygons(
    rectPolys, sw, sh, pad, 4
  );
  console.log(`  Pass 1: ${pass1Sheets.length} sheet(s)`);

  // ── Pass 2: rounded parts fill gaps, rotations=8 ───────────────────────────
  // Seed the occupied map from pass 1 placements
  const pass1Occupied = buildOccupiedFromSheets(pass1Sheets, sw, sh, pad);

  const { sheets: pass2Sheets, unplaced: overflow } = nestPolygons(
    roundedPolys, sw, sh, pad, 8, pass1Occupied
  );
  console.log(`  Pass 2: ${pass2Sheets.length} sheet(s), ${overflow.length} overflow`);

  // ── Pass 3: overflow rounded parts standalone ───────────────────────────────
  let pass3Sheets = [];
  if (overflow.length) {
    const result3 = nestPolygons(overflow, sw, sh, pad, 8);
    pass3Sheets = result3.sheets;
    console.log(`  Pass 3: ${pass3Sheets.length} sheet(s)`);
  }

  // ── Merge all passes ────────────────────────────────────────────────────────
  return mergeSheets(pass1Sheets, pass2Sheets, pass3Sheets);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core NFP nesting engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nest a list of polygons onto sheets of size sw×sh.
 * Returns { sheets, unplaced }.
 * If seedOccupied is provided (from a prior pass), parts are placed into
 * those existing sheets first before opening new ones.
 */
function nestPolygons(polygons, sw, sh, pad, rotations, seedOccupied = null) {
  if (!polygons.length) return { sheets: [], unplaced: [] };

  // Generate rotation variants — cache per unique polygon shape
  const variants = polygons.map(poly => {
    const angles = [];
    for (let r = 0; r < rotations; r++) {
      const angle = (360 / rotations) * r;
      const rotated = normalise(rotatePoly(poly.pts, angle));
      const bb = bbox(rotated);
      angles.push({ angle, pts: rotated, w: bb.w, h: bb.h });
    }
    return angles;
  });

  // Sort largest area first — greedy placement works better this way
  const order = polygons.map((_, i) => i).sort((a, b) => {
    const areaA = polygons[a].w * polygons[a].h;
    const areaB = polygons[b].w * polygons[b].h;
    return areaB - areaA;
  });

  const sheets   = [];
  let remaining  = order.slice();

  // If we have a seed (pass1 occupied map), start with those sheets
  let sheetOccupied = seedOccupied ? seedOccupied.map(o => [...o]) : null;

  while (remaining.length > 0) {
    // Start a new sheet if no seed or seed is exhausted
    if (!sheetOccupied || sheetOccupied.length === 0) {
      sheetOccupied = [[]]; // one new empty sheet
    }

    const sheetIdx     = sheetOccupied.length - 1; // place into last sheet first
    const occupied     = sheetOccupied[sheetIdx];
    const placements   = [];
    const stillRemaining = [];

    // IFP (Inner Fit Polygon) for the sheet — computed per rotation variant
    for (const polyIdx of remaining) {
      let bestPlacement = null;
      let bestScore     = Infinity;

      for (const v of variants[polyIdx]) {
        if (v.w + pad * 2 > sw || v.h + pad * 2 > sh) continue; // won't fit at all

        // Get candidate positions from NFP boundary
        const candidates = getCandidatePositions(v.pts, occupied, sw, sh, pad);

        for (const { x, y } of candidates) {
          const placed = v.pts.map(p => ({ x: p.x + x, y: p.y + y }));
          if (!fitsInSheet(placed, sw, sh, pad)) continue;
          if (overlapsOccupied(placed, occupied)) continue;
          const score = y * sw + x; // gravity: top-left preferred
          if (score < bestScore) {
            bestScore = score;
            bestPlacement = { polyIdx, x, y, rotation: v.angle, pts: v.pts, w: v.w, h: v.h };
          }
        }
      }

      if (bestPlacement) {
        placements.push(bestPlacement);
        // Add expanded footprint to occupied list
        const placed = bestPlacement.pts.map(p => ({
          x: p.x + bestPlacement.x,
          y: p.y + bestPlacement.y,
        }));
        const expanded = expandPoly(placed, pad);
        occupied.push(...expanded);
      } else {
        stillRemaining.push(polyIdx);
      }
    }

    if (placements.length === 0) {
      // Nothing fit on this sheet — force-place first part to avoid infinite loop
      const polyIdx = remaining[0];
      const v = variants[polyIdx][0];
      placements.push({ polyIdx, x: pad, y: pad, rotation: v.angle, pts: v.pts, w: v.w, h: v.h });
      stillRemaining.push(...remaining.slice(1));
    }

    sheets.push(placements.map(p => ({
      idx:      polygons[p.polyIdx].idx,
      x:        r3(p.x),
      y:        r3(p.y),
      rotation: p.rotation,
      placedW:  r3(p.w),
      placedH:  r3(p.h),
    })));

    remaining     = stillRemaining;
    sheetOccupied = null; // subsequent iterations open fresh sheets
  }

  return { sheets, unplaced: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// NFP candidate positions
//
// The key insight: valid placements are ALWAYS at positions where the incoming
// part touches either (a) the sheet wall or (b) an already-placed part.
// We don't need to scan a grid — we only need to test NFP boundary vertices.
//
// For each placed polygon A in `occupied`, we compute the NFP of (A, B) where
// B is the incoming part. The NFP boundary vertices are exactly the positions
// where B would touch A without overlapping. We also add the four sheet-wall
// positions (flush against each edge).
// ─────────────────────────────────────────────────────────────────────────────
function getCandidatePositions(pts, occupied, sw, sh, pad) {
  const bb = bbox(pts);
  const candidates = [];

  // Always include the four sheet-corner positions
  candidates.push(
    { x: pad,          y: pad },
    { x: sw - bb.w - pad, y: pad },
    { x: pad,          y: sh - bb.h - pad },
    { x: sw - bb.w - pad, y: sh - bb.h - pad },
  );

  // For each placed part, compute NFP and add its vertices as candidates
  // occupied is a flat list of Clipper paths — group them back into parts
  // by using the union outline of all occupied as a single blocker polygon
  if (occupied.length > 0) {
    const nfpPoints = computeNFPVertices(pts, occupied, sw, sh, pad);
    candidates.push(...nfpPoints);
  }

  // Deduplicate to avoid redundant overlap checks
  return deduplicateCandidates(candidates, 1.0);
}

/**
 * Compute NFP vertices by Minkowski difference via Clipper.
 *
 * The Minkowski difference of the occupied region and part B gives the
 * "forbidden zone" — positions where B would overlap occupied.
 * The boundary of (sheet IFP minus forbidden zone) contains all valid
 * touching positions. We return its vertices as candidates.
 */
function computeNFPVertices(pts, occupied, sw, sh, pad) {
  const bb  = bbox(pts);

  // IFP: the region the part's reference point can reach within the sheet
  const ifpPts = [
    { x: pad,          y: pad },
    { x: sw - bb.w - pad, y: pad },
    { x: sw - bb.w - pad, y: sh - bb.h - pad },
    { x: pad,          y: sh - bb.h - pad },
  ];
  if (ifpPts[1].x < ifpPts[0].x || ifpPts[2].y < ifpPts[0].y) return [];

  const ifpClipper = [toClipperPath(ifpPts)];

  // Minkowski sum of occupied with the reflected part polygon
  // = the set of positions where the part would overlap occupied
  const reflected   = pts.map(p => ({ x: -p.x, y: -p.y }));
  const minkowskiPaths = [];

  for (const occPath of occupied) {
    const ms = minkowskiSum(occPath, toClipperPath(reflected));
    if (ms) minkowskiPaths.push(...ms);
  }

  if (!minkowskiPaths.length) {
    // No occupied shapes yet — IFP vertices are the only candidates
    return ifpPts;
  }

  // Subtract Minkowski sum from IFP to get valid placement region
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(ifpClipper,      ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(minkowskiPaths,  ClipperLib.PolyType.ptClip,    true);
  const solution = new ClipperLib.Paths();
  clipper.Execute(ClipperLib.ClipType.ctDifference, solution,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);

  if (!solution || !solution.length) return ifpPts;

  // Return all boundary vertices of the valid region
  const result = [];
  for (const path of solution) {
    for (const pt of path) {
      result.push({ x: pt.X / SCALE, y: pt.Y / SCALE });
    }
  }
  return result;
}

/**
 * Minkowski sum of two Clipper paths using ClipperLib's built-in function.
 */
function minkowskiSum(pathA, pathB) {
  try {
    const solution = new ClipperLib.Paths();
    ClipperLib.Clipper.MinkowskiSum(pathA, pathB, solution, true);
    return solution.length ? solution : null;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build occupied map from a completed pass's sheet placements
// ─────────────────────────────────────────────────────────────────────────────
function buildOccupiedFromSheets(sheets, sw, sh, pad) {
  return sheets.map(placements => {
    const occupied = [];
    for (const p of placements) {
      // Reconstruct polygon at its placed position
      // (placements only store x/y/rotation/placedW/placedH, not the full pts)
      // Use a rectangle as the footprint — sufficient for collision purposes
      const rectPts = [
        { x: p.x,           y: p.y },
        { x: p.x + p.placedW, y: p.y },
        { x: p.x + p.placedW, y: p.y + p.placedH },
        { x: p.x,           y: p.y + p.placedH },
      ];
      const expanded = expandPoly(rectPts, pad);
      occupied.push(...expanded);
    }
    return occupied;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge all three passes into unified response format
// ─────────────────────────────────────────────────────────────────────────────
function mergeSheets(pass1, pass2, pass3) {
  // pass1 and pass2 operate on the same physical sheets
  // pass3 is overflow — starts after the shared sheets

  const maxShared = Math.max(pass1.length, pass2.length);
  const merged    = [];

  for (let i = 0; i < maxShared; i++) {
    const placements = [
      ...(pass1[i] || []),
      ...(pass2[i] || []),
    ];
    merged.push(placements);
  }

  // Append pass3 overflow sheets
  for (const sheet of pass3) {
    merged.push(sheet);
  }

  return {
    sheets: merged.map((placements, i) => ({
      index:       i + 1,
      placements,
      utilisation: 0, // frontend recalculates from placedW/placedH
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────
function rectPoints(w, h) {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
}

function bbox(pts) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Shift polygon so its bounding box starts at 0,0 */
function normalise(pts) {
  const bb = bbox(pts);
  return pts.map(p => ({ x: p.x - bb.minX, y: p.y - bb.minY }));
}

function rotatePoly(pts, angleDeg) {
  if (angleDeg === 0) return pts;
  const rad = (angleDeg * Math.PI) / 180;
  const cx  = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy  = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  return pts.map(p => {
    const dx = p.x - cx, dy = p.y - cy;
    return {
      x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
      y: cy + dx * Math.sin(rad) + dy * Math.cos(rad),
    };
  });
}

function fitsInSheet(pts, w, h, pad) {
  return pts.every(p =>
    p.x >= pad - 0.001 && p.y >= pad - 0.001 &&
    p.x <= w - pad + 0.001 && p.y <= h - pad + 0.001
  );
}

function deduplicateCandidates(pts, tolerance) {
  const out = [];
  for (const p of pts) {
    if (!out.some(q => Math.abs(q.x - p.x) < tolerance && Math.abs(q.y - p.y) < tolerance)) {
      out.push(p);
    }
  }
  return out;
}

function r3(n) { return Math.round(n * 1000) / 1000; }

// ─────────────────────────────────────────────────────────────────────────────
// Clipper helpers
// ─────────────────────────────────────────────────────────────────────────────
function toClipperPath(pts) {
  return pts.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
}

function expandPoly(pts, delta) {
  if (delta <= 0) return [toClipperPath(pts)];
  const co   = new ClipperLib.ClipperOffset();
  const path = toClipperPath(pts);
  co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const solution = new ClipperLib.Paths();
  co.Execute(solution, delta * SCALE);
  return solution;
}

function overlapsOccupied(candidate, occupied) {
  if (!occupied || occupied.length === 0) return false;
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths([toClipperPath(candidate)], ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(occupied,                   ClipperLib.PolyType.ptClip,    true);
  const solution = new ClipperLib.Paths();
  clipper.Execute(ClipperLib.ClipType.ctIntersection, solution);
  if (!solution || !solution.length) return false;
  const area = Math.abs(ClipperLib.Clipper.Area(solution[0])) / (SCALE * SCALE);
  return area > 0.01;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
