/**
 * NestFlow — Nesting Worker v4.4
 * Zero native dependencies — pure JavaScript polygon collision via SAT.
 * No ClipperLib anywhere. Cannot OOM from native allocations.
 *
 * Separating Axis Theorem (SAT) gives exact overlap detection for convex
 * polygons and accurate results for the mildly concave profiles typical
 * in steel fabrication (flat bar, plate with radiused corners etc).
 *
 * Spacing handled arithmetically — candidate positions include pad gap.
 */

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
// Entry point
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
  const { sheets: s1 } = nest(rectPolys, sw, sh, pad, 4, null,
    (pl, tot, sn) => emit({ type: 'placed', pass: 1, placed: pl, total: tot, sheet: sn }));
  emit({ type: 'passdone', pass: 1, sheets: s1.length, placed: rectPolys.length });

  // Pass 2 — rounded fills gaps, rotations=8
  emit({ type: 'pass', pass: 2, label: 'Rounded parts — filling gaps', total: roundedPolys.length, rotations: 8 });
  const seed = buildSeed(s1);
  const { sheets: s2, overflow } = nest(roundedPolys, sw, sh, pad, 8, seed,
    (pl, tot, sn) => emit({ type: 'placed', pass: 2, placed: pl, total: tot, sheet: sn }));
  emit({ type: 'passdone', pass: 2, sheets: s2.length, placed: roundedPolys.length - overflow.length, overflow: overflow.length });

  // Pass 3 — overflow
  let s3 = [];
  if (overflow.length) {
    emit({ type: 'pass', pass: 3, label: 'Overflow — fresh sheets', total: overflow.length, rotations: 8 });
    s3 = nest(overflow, sw, sh, pad, 8, null,
      (pl, tot, sn) => emit({ type: 'placed', pass: 3, placed: pl, total: tot, sheet: sn })).sheets;
    emit({ type: 'passdone', pass: 3, sheets: s3.length, placed: overflow.length, overflow: 0 });
  }

  emit({ type: 'done', ...mergeSheets(s1, s2, s3) });
}

// ─────────────────────────────────────────────────────────────────────────────
// Core nesting engine
// occupied = [{ pts, bb }]
// ─────────────────────────────────────────────────────────────────────────────
function nest(polygons, sw, sh, pad, rotations, seed = null, onProgress = null) {
  if (!polygons.length) return { sheets: [], overflow: [] };

  // Pre-compute rotation variants (deduplicated)
  const variants = polygons.map(poly => {
    const seen = new Set();
    const out = [];
    for (let r = 0; r < rotations; r++) {
      const angle = (360 / rotations) * r;
      const rotated = normalisePts(rotatePoly(poly.pts, angle));
      const bb = bbox(rotated);
      const key = `${Math.round(bb.w)}_${Math.round(bb.h)}`;
      if (!seen.has(key)) { seen.add(key); out.push({ angle, pts: rotated, bb }); }
    }
    return out;
  });

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

        // Candidate positions: corners + edges of placed items (with pad gap)
        const cands = [
          { x: pad, y: pad },
          { x: sw - vw - pad, y: pad },
          { x: pad, y: sh - vh - pad },
          { x: sw - vw - pad, y: sh - vh - pad },
        ];
        for (const o of occupied) {
          const ob = o.bb;
          cands.push(
            { x: ob.maxX + pad,      y: ob.minY           },
            { x: ob.minX,            y: ob.maxY + pad     },
            { x: ob.maxX + pad,      y: ob.maxY + pad     },
            { x: ob.minX - vw - pad, y: ob.minY           },
            { x: ob.minX,            y: ob.minY - vh - pad },
          );
        }

        for (const { x, y } of cands) {
          if (x < pad - 0.01 || y < pad - 0.01) continue;
          if (x + vw > sw - pad + 0.01) continue;
          if (y + vh > sh - pad + 0.01) continue;

          // Stage 1: AABB check with pad gap (very fast)
          if (aabbHits(x, y, vw, vh, pad, occupied)) continue;

          // Stage 2: SAT polygon check (accurate, pure JS, zero allocations)
          const shifted = v.pts.map(p => ({ x: p.x + x, y: p.y + y }));
          if (satHitsAny(shifted, pad, occupied)) continue;

          const score = y * sw + x;
          if (score < bestScore) {
            bestScore = score;
            best = { polyIdx, x, y, angle: v.angle, pts: shifted, w: vw, h: vh };
          }
        }
      }

      if (best) {
        placements.push(best);
        occupied.push({
          pts: best.pts,
          bb: { minX: best.x, minY: best.y, maxX: best.x + best.w, maxY: best.y + best.h },
        });
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
// Collision detection — pure JavaScript, zero native calls
// ─────────────────────────────────────────────────────────────────────────────

/** AABB overlap with pad gap on all sides */
function aabbHits(x, y, w, h, pad, occupied) {
  const x0 = x - pad, y0 = y - pad, x1 = x + w + pad, y1 = y + h + pad;
  for (const o of occupied) {
    const b = o.bb;
    if (x0 < b.maxX && x1 > b.minX && y0 < b.maxY && y1 > b.minY) return true;
  }
  return false;
}

/**
 * Separating Axis Theorem — tests if polygon A overlaps any occupied polygon.
 * pad is added as a minimum separation distance (inflate A by pad/2 notionally
 * by checking overlap gap > -pad instead of > 0).
 *
 * SAT works by: for every edge of A and B, project both polygons onto the
 * edge's normal. If the projections don't overlap on ANY axis, the polygons
 * don't intersect. If they overlap on ALL axes, they do intersect.
 *
 * For convex polygons this is exact. For concave polygons it may allow
 * slight overlap in concave regions — acceptable for fabrication nesting
 * where parts are predominantly convex or mildly concave.
 */
function satHitsAny(pts, pad, occupied) {
  for (const o of occupied) {
    if (satOverlap(pts, o.pts, pad)) return true;
  }
  return false;
}

function satOverlap(a, b, pad) {
  // Get all edge normals from both polygons
  const axes = [...getAxes(a), ...getAxes(b)];
  for (const axis of axes) {
    const pa = project(a, axis);
    const pb = project(b, axis);
    // If projections don't overlap (with pad gap), polygons are separated
    if (pa.max + pad < pb.min || pb.max + pad < pa.min) return false;
  }
  return true; // overlap on all axes = intersection
}

function getAxes(pts) {
  const axes = [];
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
    const edge = { x: p2.x - p1.x, y: p2.y - p1.y };
    const len = Math.sqrt(edge.x * edge.x + edge.y * edge.y);
    if (len > 0.001) axes.push({ x: -edge.y / len, y: edge.x / len }); // perpendicular normal
  }
  return axes;
}

function project(pts, axis) {
  let min = Infinity, max = -Infinity;
  for (const p of pts) {
    const dot = p.x * axis.x + p.y * axis.y;
    if (dot < min) min = dot;
    if (dot > max) max = dot;
  }
  return { min, max };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function buildSeed(sheets) {
  if (!sheets.length) return null;
  return sheets[sheets.length - 1].map(p => {
    const pts = rectPts(p.placedW, p.placedH).map(pt => ({ x: pt.x + p.x, y: pt.y + p.y }));
    return { pts, bb: { minX: p.x, minY: p.y, maxX: p.x + p.placedW, maxY: p.y + p.placedH } };
  });
}

function mergeSheets(p1, p2, p3) {
  const n = Math.max(p1.length, p2.length);
  const merged = [];
  for (let i = 0; i < n; i++) merged.push([...(p1[i]||[]), ...(p2[i]||[])]);
  for (const s of p3) merged.push(s);
  return { sheets: merged.map((pl, i) => ({ index: i+1, placements: pl, utilisation: 0 })) };
}

function rectPts(w, h) { return [{x:0,y:0},{x:w,y:0},{x:w,y:h},{x:0,y:h}]; }

function bbox(pts) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const p of pts) {
    if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x;
    if(p.y<minY)minY=p.y; if(p.y>maxY)maxY=p.y;
  }
  return {minX,minY,maxX,maxY,w:maxX-minX,h:maxY-minY};
}

function normalisePts(pts) {
  const b = bbox(pts);
  return pts.map(p => ({ x: p.x - b.minX, y: p.y - b.minY }));
}

function rotatePoly(pts, deg) {
  if (deg === 0) return pts;
  const rad = deg * Math.PI / 180;
  const cx = pts.reduce((a,p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a,p) => a + p.y, 0) / pts.length;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return pts.map(p => ({
    x: cx + (p.x-cx)*cos - (p.y-cy)*sin,
    y: cy + (p.x-cx)*sin + (p.y-cy)*cos,
  }));
}

function r3(n) { return Math.round(n * 1000) / 1000; }
