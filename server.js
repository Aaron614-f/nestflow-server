/**
 * NestFlow — Nesting Server v2.0
 * Runs the SVGnest/Deepnest algorithm directly in Node.js
 * No GUI required — works entirely headless
 *
 * Usage:  node server.js
 * Stop:   Ctrl+C
 */

const http = require('http');
const ClipperLib = require('clipper-lib');

const PORT = process.env.PORT || 3000;
const SCALE = 10000000; // clipper integer scale

// ─────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/ping') {
    json(res, 200, { ok: true, engine: 'NFP nesting v2.0', version: '2.0.0' });
    return;
  }

  if (req.method === 'POST' && req.url === '/nest') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        console.log(`  Nesting ${payload.parts?.length || 0} parts on ${payload.sheet?.w}×${payload.sheet?.h}mm sheet`);
        const result = await runNesting(payload);
        console.log(`  Done — ${result.sheets?.length || 0} sheets`);
        json(res, 200, result);
      } catch (err) {
        console.error('  Nesting error:', err.message);
        json(res, 500, { error: err.message });
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  +==========================================+');
  console.log('  |  NestFlow Nesting Server  v2.0          |');
  console.log('  |  Listening on http://localhost:3000      |');
  console.log('  |  Engine: NFP true-shape nesting          |');
  console.log('  +==========================================+');
  console.log('');
  console.log('  OK: Server ready — no external dependencies needed.');
  console.log('');
  console.log('  Open nestflow.html in Chrome or Edge to start.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

// ─────────────────────────────────────────────
// Main nesting entry point
// ─────────────────────────────────────────────
async function runNesting({ sheet, parts, spacing = 2, rotations = 4 }) {
  if (!sheet || !parts || !parts.length) throw new Error('Invalid payload');

  // Build polygon list for each part
  const polygons = parts.map(p => {
    const pts = p.points && p.points.length >= 3
      ? p.points
      : rectPoints(p.w, p.h);
    return { pts, w: p.w, h: p.h };
  });

  // Run placement with NFP
  const result = nestParts(polygons, sheet, spacing, rotations);
  return result;
}

// ─────────────────────────────────────────────
// NFP-based nesting
// ─────────────────────────────────────────────
function nestParts(polygons, sheet, spacing, rotations) {
  const sheetW = sheet.w, sheetH = sheet.h;
  const pad = spacing;

  // Generate rotation variants for each part
  const variants = polygons.map((poly, idx) => {
    const angles = [];
    for (let r = 0; r < rotations; r++) {
      const angle = (360 / rotations) * r;
      const rotated = rotatePoly(poly.pts, angle);
      const bb = bbox(rotated);
      angles.push({ idx, angle, pts: rotated, w: bb.w, h: bb.h });
    }
    return angles;
  });

  // Sort by area largest first
  const order = polygons.map((p, i) => i)
    .sort((a, b) => (polygons[b].w * polygons[b].h) - (polygons[a].w * polygons[a].h));

  const sheets = [];
  let placed = new Array(polygons.length).fill(false);
  let remaining = order.slice();

  while (remaining.length > 0) {
    const sheetPlacements = [];
    const stillRemaining = [];
    // Clipper path for occupied area
    let occupied = []; // array of clipper paths

    for (const idx of remaining) {
      // Try each rotation, find best fit using NFP
      let bestPlacement = null;
      let bestScore = Infinity;

      for (const v of variants[idx]) {
        const pos = findBestPosition(v.pts, occupied, sheetW, sheetH, pad);
        if (pos && pos.score < bestScore) {
          bestScore = pos.score;
          bestPlacement = { idx, x: pos.x, y: pos.y, rotation: v.angle, pts: v.pts, w: v.w, h: v.h };
        }
      }

      if (bestPlacement) {
        sheetPlacements.push(bestPlacement);
        // Add this part's footprint to occupied (offset to position)
        const offsetPts = bestPlacement.pts.map(p => ({
          x: p.x + bestPlacement.x,
          y: p.y + bestPlacement.y
        }));
        // Expand by spacing using Clipper offset
        const expanded = expandPoly(offsetPts, pad);
        occupied = occupied.concat(expanded);
      } else {
        stillRemaining.push(idx);
      }
    }

    if (sheetPlacements.length === 0) {
      // Nothing fit — force-place first item to avoid infinite loop
      const idx = remaining[0];
      const v = variants[idx][0];
      sheetPlacements.push({ idx, x: pad, y: pad, rotation: v.angle, pts: v.pts, w: v.w, h: v.h });
      stillRemaining.push(...remaining.slice(1));
    }

    sheets.push({
      index: sheets.length + 1,
      placements: sheetPlacements.map(p => ({
        idx: p.idx,
        x: Math.round(p.x * 1000) / 1000,
        y: Math.round(p.y * 1000) / 1000,
        rotation: p.rotation
      }))
    });

    remaining = stillRemaining;
  }

  return { sheets };
}

// ─────────────────────────────────────────────
// Find the best position for a polygon on the sheet
// Uses a gravity-based placement: scan positions left-to-right, top-to-bottom
// ─────────────────────────────────────────────
function findBestPosition(pts, occupied, sheetW, sheetH, pad) {
  const bb = bbox(pts);
  if (bb.w + pad * 2 > sheetW || bb.h + pad * 2 > sheetH) return null;

  // Shift polygon so its bbox starts at 0,0
  const norm = pts.map(p => ({ x: p.x - bb.minX, y: p.y - bb.minY }));

  // Grid search — try positions in a grid pattern
  const stepX = Math.max(10, Math.min(50, sheetW / 30));
  const stepY = Math.max(10, Math.min(50, sheetH / 30));

  let bestX = null, bestY = null, bestScore = Infinity;

  for (let gy = pad; gy <= sheetH - bb.h - pad; gy += stepY) {
    for (let gx = pad; gx <= sheetW - bb.w - pad; gx += stepX) {
      const candidate = norm.map(p => ({ x: p.x + gx, y: p.y + gy }));

      // Check within sheet
      if (!fitsInSheet(candidate, sheetW, sheetH, 0)) continue;

      // Check no overlap with occupied using Clipper
      if (overlaps(candidate, occupied)) continue;

      // Score: prefer top-left (gravity)
      const score = gy * sheetW + gx;
      if (score < bestScore) {
        bestScore = score;
        bestX = gx;
        bestY = gy;
      }
    }
  }

  // Fine-tune: try to push further toward top-left
  if (bestX !== null) {
    // Try smaller steps around best position
    const fineStep = 2;
    for (let fy = Math.max(pad, bestY - stepY); fy <= bestY; fy += fineStep) {
      for (let fx = Math.max(pad, bestX - stepX); fx <= bestX; fx += fineStep) {
        const candidate = norm.map(p => ({ x: p.x + fx, y: p.y + fy }));
        if (!fitsInSheet(candidate, sheetW, sheetH, 0)) continue;
        if (overlaps(candidate, occupied)) continue;
        const score = fy * sheetW + fx;
        if (score < bestScore) {
          bestScore = score;
          bestX = fx;
          bestY = fy;
        }
      }
    }
  }

  if (bestX === null) return null;
  return { x: bestX, y: bestY, score: bestScore };
}

// ─────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────
function rectPoints(w, h) {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
}

function bbox(pts) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function rotatePoly(pts, angleDeg) {
  if (angleDeg === 0) return pts;
  const rad = (angleDeg * Math.PI) / 180;
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  return pts.map(p => {
    const dx = p.x - cx, dy = p.y - cy;
    return {
      x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
      y: cy + dx * Math.sin(rad) + dy * Math.cos(rad)
    };
  });
}

function fitsInSheet(pts, w, h, pad) {
  return pts.every(p => p.x >= pad && p.y >= pad && p.x <= w - pad && p.y <= h - pad);
}

// ─────────────────────────────────────────────
// Clipper helpers for overlap detection
// ─────────────────────────────────────────────
function toClipperPath(pts) {
  return pts.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
}

function expandPoly(pts, delta) {
  const co = new ClipperLib.ClipperOffset();
  const path = toClipperPath(pts);
  co.AddPath(path, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const solution = new ClipperLib.Paths();
  co.Execute(solution, delta * SCALE);
  return solution;
}

function overlaps(candidate, occupied) {
  if (!occupied || occupied.length === 0) return false;
  const clipper = new ClipperLib.Clipper();
  const subj = [toClipperPath(candidate)];
  clipper.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(occupied, ClipperLib.PolyType.ptClip, true);
  const solution = new ClipperLib.Paths();
  clipper.Execute(ClipperLib.ClipType.ctIntersection, solution);
  // If intersection area > tiny threshold, they overlap
  if (!solution || solution.length === 0) return false;
  const area = Math.abs(ClipperLib.Clipper.Area(solution[0])) / (SCALE * SCALE);
  return area > 0.5; // 0.5 mm² threshold
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
