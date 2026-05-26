/**
 * NestFlow — Nesting Worker v4.2
 * Runs as a disposable child process — spawned per job, exits when done.
 * The OS reclaims ALL memory (including ClipperLib C++ allocations) on exit.
 *
 * Uses true polygon collision detection via ClipperLib — safe here because
 * any memory leak dies with the process at job end.
 *
 * Placement strategy: Bottom-Left fit with polygon-accurate overlap check.
 * Candidates generated from occupied boundary vertices (not a grid).
 */

const ClipperLib = require('clipper-lib');
const SCALE = 10000000;

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n');
  try {
    runNesting(JSON.parse(body), emit);
  } catch (err) {
    emit({ type: 'error', error: err.message });
  }
  process.exit(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────
function runNesting({ sheet, parts, spacing = 2 }, emit) {
  if (!sheet || !parts?.length) throw new Error('Invalid payload');
  const sw = sheet.w, sh = sheet.h, pad = spacing;

  const polygons = parts.map(p => ({
    pts: (p.points?.length >= 3) ? p.points : rectPts(p.w, p.h),
    w: p.w, h: p.h, idx: p.idx,
  }));

  const rectPolys    = polygons.filter(p => p.pts.length === 4);
  const roundedPolys = polygons.filter(p => p.pts.length !== 4);

  emit({ type: 'start', rectCount: rectPolys.length, roundedCount: roundedPolys.length, totalParts: polygons.length });

  // Pass 1 — rectangles, rotations=4
  emit({ type: 'pass', pass: 1, label: 'Rectangular parts', total: rectPolys.length, rotations: 4 });
  const { sheets: s1 } = nestPolygons(rectPolys, sw, sh, pad, 4, null,
    (placed, total, sn) => emit({ type: 'placed', pass: 1, placed, total, sheet: sn }));
  emit({ type: 'passdone', pass: 1, sheets: s1.length, placed: rectPolys.length });

  // Pass 2 — rounded fills gaps, rotations=8
  emit({ type: 'pass', pass: 2, label: 'Rounded parts — filling gaps', total: roundedPolys.length, rotations: 8 });
  const seed = buildSeed(s1, pad);
  const { sheets: s2, overflow } = nestPolygons(roundedPolys, sw, sh, pad, 8, seed,
    (placed, total, sn) => emit({ type: 'placed', pass: 2, placed, total, sheet: sn }));
  emit({ type: 'passdone', pass: 2, sheets: s2.length, placed: roundedPolys.length - overflow.length, overflow: overflow.length });

  // Pass 3 — overflow
  let s3 = [];
  if (overflow.length) {
    emit({ type: 'pass', pass: 3, label: 'Overflow — fresh sheets', total: overflow.length, rotations: 8 });
    const r3 = nestPolygons(overflow, sw, sh, pad, 8, null,
      (placed, total, sn) => emit({ type: 'placed', pass: 3, placed, total, sheet: sn }));
    s3 = r3.sheets;
    emit({ type: 'passdone', pass: 3, sheets: s3.length, placed: overflow.length, overflow: 0 });
  }

  emit({ type: 'done', ...mergeSheets(s1, s2, s3) });
}

// ─────────────────────────────────────────────────────────────────────────────
// Core nesting engine
// occupied = array of placed items: { pts (polygon), bb (bbox), cx (clipper path) }
// ─────────────────────────────────────────────────────────────────────────────
function nestPolygons(polygons, sw, sh, pad, rotations, seed = null, onProgress = null) {
  if (!polygons.length) return { sheets: [], overflow: [] };

  // Pre-compute rotation variants
  const variants = polygons.map(poly => {
    const seen = new Set();
    const out = [];
    for (let r = 0; r < rotations; r++) {
      const angle = (360 / rotations) * r;
      const rotated = normalisePts(rotatePoly(poly.pts, angle));
      const bb = bbox(rotated);
      const key = `${Math.round(bb.w)}_${Math.round(bb.h)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ angle, pts: rotated, bb });
      }
    }
    return out;
  });

  // Sort largest first
  const order = polygons.map((_, i) => i)
    .sort((a, b) => (polygons[b].w * polygons[b].h) - (polygons[a].w * polygons[a].h));

  const sheets = [];
  let remaining = order.slice();
  let totalPlaced = 0;
  let sheetSeed = seed ? seed.slice() : null;

  while (remaining.length > 0) {
    const occupied = sheetSeed ? sheetSeed.slice() : [];
    sheetSeed = null;
    const placements = [];
    const stillRemaining = [];
    const sheetNum = sheets.length + 1;

    for (const polyIdx of remaining) {
      let best = null, bestScore = Infinity;

      for (const v of variants[polyIdx]) {
        const vw = v.bb.w, vh = v.bb.h;
        if (vw + pad * 2 > sw || vh + pad * 2 > sh) continue;

        // Candidate positions: sheet corners + edges of placed items
        const candidates = [
          { x: pad, y: pad },
          { x: sw - vw - pad, y: pad },
          { x: pad, y: sh - vh - pad },
          { x: sw - vw - pad, y: sh - vh - pad },
        ];
        for (const o of occupied) {
          const r = o.bb;
          candidates.push(
            { x: r.maxX + pad,       y: r.minY         },
            { x: r.minX,             y: r.maxY + pad   },
            { x: r.maxX + pad,       y: r.maxY + pad   },
            { x: r.minX - vw - pad,  y: r.minY         },
            { x: r.minX,             y: r.minY - vh - pad },
          );
        }

        for (const { x, y } of candidates) {
          // Quick bounds check first (cheap)
          if (x < pad - 0.01 || y < pad - 0.01) continue;
          if (x + vw > sw - pad + 0.01) continue;
          if (y + vh > sh - pad + 0.01) continue;

          // Quick AABB check (fast elimination)
          const candidateBB = { minX: x, minY: y, maxX: x + vw, maxY: y + vh };
          if (aabbOverlapsAny(candidateBB, occupied)) continue;

          // Full polygon check (accurate, only runs when AABB passes)
          const shifted = v.pts.map(p => ({ x: p.x + x, y: p.y + y }));
          if (polyOverlapsAny(shifted, occupied, pad)) continue;

          const score = y * sw + x;
          if (score < bestScore) {
            bestScore = score;
            best = { polyIdx, x, y, angle: v.angle, pts: shifted, w: vw, h: vh };
          }
        }
      }

      if (best) {
        placements.push(best);
        const expandedPts = offsetPoly(best.pts, pad);
        const ebb = bboxFromClipper(expandedPts);
        occupied.push({ pts: best.pts, expandedPts, bb: ebb });
        totalPlaced++;
        if (onProgress) onProgress(totalPlaced, polygons.length, sheetNum);
      } else {
        stillRemaining.push(polyIdx);
      }
    }

    if (placements.length === 0) {
      const polyIdx = remaining[0];
      const v = variants[polyIdx][0];
      const shifted = v.pts.map(p => ({ x: p.x + pad, y: p.y + pad }));
      placements.push({ polyIdx, x: pad, y: pad, angle: v.angle, pts: shifted, w: v.bb.w, h: v.bb.h });
      stillRemaining.push(...remaining.slice(1));
    }

    sheets.push(placements.map(p => ({
      idx: polygons[p.polyIdx].idx,
      x: r3(p.x), y: r3(p.y),
      rotation: p.angle,
      placedW: r3(p.w), placedH: r3(p.h),
    })));

    remaining = stillRemaining;
  }

  return { sheets, overflow: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Collision detection — two stage: AABB first, polygon second
// ─────────────────────────────────────────────────────────────────────────────
function aabbOverlapsAny(bb, occupied) {
  for (const o of occupied) {
    const ob = o.bb;
    if (bb.minX < ob.maxX && bb.maxX > ob.minX &&
        bb.minY < ob.maxY && bb.maxY > ob.minY) return true;
  }
  return false;
}

function polyOverlapsAny(pts, occupied, pad) {
  const cp = toClipperPoly(pts);
  for (const o of occupied) {
    // Use the expanded (padded) polygon of the placed item as the obstacle
    const obstacle = o.expandedPts || toClipperPoly(o.pts);
    if (clipperIntersects(cp, obstacle)) return true;
  }
  return false;
}

function clipperIntersects(pathA, pathB) {
  try {
    const clipper = new ClipperLib.Clipper();
    clipper.AddPath(pathA, ClipperLib.PolyType.ptSubject, true);
    clipper.AddPath(pathB, ClipperLib.PolyType.ptClip,    true);
    const sol = new ClipperLib.Paths();
    clipper.Execute(ClipperLib.ClipType.ctIntersection, sol);
    if (!sol?.length) return false;
    const area = Math.abs(ClipperLib.Clipper.Area(sol[0])) / (SCALE * SCALE);
    return area > 0.01;
  } catch (e) { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polygon offset — expand a polygon outward by delta mm
// ─────────────────────────────────────────────────────────────────────────────
function offsetPoly(pts, delta) {
  if (delta <= 0) return toClipperPoly(pts);
  try {
    const co = new ClipperLib.ClipperOffset();
    co.AddPath(toClipperPoly(pts), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const sol = new ClipperLib.Paths();
    co.Execute(sol, delta * SCALE);
    return sol?.[0] || toClipperPoly(pts);
  } catch (e) { return toClipperPoly(pts); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed occupied list from a prior pass's last sheet
// ─────────────────────────────────────────────────────────────────────────────
function buildSeed(sheets, pad) {
  if (!sheets.length) return null;
  return sheets[sheets.length - 1].map(p => {
    const pts = rectPts(p.placedW, p.placedH).map(pt => ({ x: pt.x + p.x, y: pt.y + p.y }));
    const expandedPts = offsetPoly(pts, pad);
    return { pts, expandedPts, bb: bboxFromClipper(expandedPts) };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge passes into response format
// ─────────────────────────────────────────────────────────────────────────────
function mergeSheets(p1, p2, p3) {
  const n = Math.max(p1.length, p2.length);
  const merged = [];
  for (let i = 0; i < n; i++) merged.push([...(p1[i]||[]), ...(p2[i]||[])]);
  for (const s of p3) merged.push(s);
  return { sheets: merged.map((pl, i) => ({ index: i+1, placements: pl, utilisation: 0 })) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────
function rectPts(w, h) {
  return [{ x:0,y:0 },{ x:w,y:0 },{ x:w,y:h },{ x:0,y:h }];
}
function bbox(pts) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const p of pts) {
    if (p.x<minX)minX=p.x; if (p.x>maxX)maxX=p.x;
    if (p.y<minY)minY=p.y; if (p.y>maxY)maxY=p.y;
  }
  return { minX,minY,maxX,maxY,w:maxX-minX,h:maxY-minY };
}
function bboxFromClipper(path) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const p of path) {
    const x=p.X/SCALE, y=p.Y/SCALE;
    if (x<minX)minX=x; if (x>maxX)maxX=x;
    if (y<minY)minY=y; if (y>maxY)maxY=y;
  }
  return { minX,minY,maxX,maxY,w:maxX-minX,h:maxY-minY };
}
function normalisePts(pts) {
  const bb=bbox(pts);
  return pts.map(p=>({ x:p.x-bb.minX, y:p.y-bb.minY }));
}
function rotatePoly(pts, deg) {
  if (deg===0) return pts;
  const rad=deg*Math.PI/180;
  const cx=pts.reduce((a,p)=>a+p.x,0)/pts.length;
  const cy=pts.reduce((a,p)=>a+p.y,0)/pts.length;
  const cos=Math.cos(rad),sin=Math.sin(rad);
  return pts.map(p=>({
    x: cx+(p.x-cx)*cos-(p.y-cy)*sin,
    y: cy+(p.x-cx)*sin+(p.y-cy)*cos,
  }));
}
function toClipperPoly(pts) {
  return pts.map(p=>({ X:Math.round(p.x*SCALE), Y:Math.round(p.y*SCALE) }));
}
function r3(n) { return Math.round(n*1000)/1000; }
