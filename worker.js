/**
 * NestFlow — Nesting Worker v4.5
 * Pure JavaScript. Zero dependencies. Zero allocations in the inner loop.
 *
 * Key change from v4.4: collision detection uses no array creation.
 * All geometry computed with scalar arithmetic only.
 */

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n');
  try { runNesting(JSON.parse(body), emit); }
  catch (err) { emit({ type: 'error', error: err.message }); }
  process.exit(0);
});

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

  emit({ type: 'pass', pass: 1, label: 'Rectangular parts', total: rectPolys.length, rotations: 4 });
  const { sheets: s1 } = nest(rectPolys, sw, sh, pad, 4, null,
    (pl, tot, sn) => emit({ type: 'placed', pass: 1, placed: pl, total: tot, sheet: sn }));
  emit({ type: 'passdone', pass: 1, sheets: s1.length, placed: rectPolys.length });

  emit({ type: 'pass', pass: 2, label: 'Rounded parts — filling gaps', total: roundedPolys.length, rotations: 8 });
  const seed = buildSeed(s1);
  const { sheets: s2, overflow } = nest(roundedPolys, sw, sh, pad, 8, seed,
    (pl, tot, sn) => emit({ type: 'placed', pass: 2, placed: pl, total: tot, sheet: sn }));
  emit({ type: 'passdone', pass: 2, sheets: s2.length, placed: roundedPolys.length - overflow.length, overflow: overflow.length });

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
// Core nesting — Bottom-Left fit, AABB collision only, zero allocations in loop
// ─────────────────────────────────────────────────────────────────────────────
function nest(polygons, sw, sh, pad, rotations, seed = null, onProgress = null) {
  if (!polygons.length) return { sheets: [], overflow: [] };

  // Pre-compute variants once — this allocation is fine, it's outside the loop
  const variants = polygons.map(poly => {
    const seen = new Set();
    const out = [];
    for (let r = 0; r < rotations; r++) {
      const angle = (360 / rotations) * r;
      const rotated = normalisePts(rotatePoly(poly.pts, angle));
      const bb = bbox(rotated);
      const key = `${Math.round(bb.w)}_${Math.round(bb.h)}`;
      if (!seen.has(key)) { seen.add(key); out.push({ angle, w: bb.w, h: bb.h }); }
    }
    return out;
  });

  const order = polygons.map((_, i) => i)
    .sort((a, b) => (polygons[b].w * polygons[b].h) - (polygons[a].w * polygons[a].h));

  const sheets = [];
  let remaining = order.slice();
  let totalPlaced = 0;
  let sheetSeed = seed ? seed.slice() : null;

  // Reusable flat arrays for occupied boxes — avoids repeated allocation
  // Each box: [x, y, w, h] packed into a Float64Array for cache efficiency
  const MAX_PLACED = 2000;
  const boxBuf = new Float64Array(MAX_PLACED * 4); // x,y,w,h per box
  let boxCount = 0;

  while (remaining.length > 0) {
    // Load seed into box buffer
    boxCount = 0;
    if (sheetSeed) {
      for (const s of sheetSeed) {
        const i = boxCount * 4;
        boxBuf[i]   = s.x;
        boxBuf[i+1] = s.y;
        boxBuf[i+2] = s.w;
        boxBuf[i+3] = s.h;
        boxCount++;
      }
    }
    sheetSeed = null;

    const placements = [];
    const stillRemaining = [];
    const sheetNum = sheets.length + 1;

    for (const polyIdx of remaining) {
      let bestX = -1, bestY = -1, bestAngle = 0, bestW = 0, bestH = 0;
      let bestScore = Infinity;

      for (const v of variants[polyIdx]) {
        const vw = v.w, vh = v.h;
        if (vw + pad * 2 > sw || vh + pad * 2 > sh) continue;

        // Test sheet corners
        if (tryPos(pad, pad, vw, vh, pad, sw, sh, boxBuf, boxCount)) {
          const s = pad * sw + pad;
          if (s < bestScore) { bestScore = s; bestX = pad; bestY = pad; bestAngle = v.angle; bestW = vw; bestH = vh; }
        }

        // Test positions derived from placed box edges
        for (let bi = 0; bi < boxCount; bi++) {
          const bx = boxBuf[bi*4], by = boxBuf[bi*4+1], bw = boxBuf[bi*4+2], bh = boxBuf[bi*4+3];

          // Right of box
          const rx = bx + bw + pad, ry = by;
          if (tryPos(rx, ry, vw, vh, pad, sw, sh, boxBuf, boxCount)) {
            const s = ry * sw + rx;
            if (s < bestScore) { bestScore = s; bestX = rx; bestY = ry; bestAngle = v.angle; bestW = vw; bestH = vh; }
          }

          // Below box
          const dx = bx, dy = by + bh + pad;
          if (tryPos(dx, dy, vw, vh, pad, sw, sh, boxBuf, boxCount)) {
            const s = dy * sw + dx;
            if (s < bestScore) { bestScore = s; bestX = dx; bestY = dy; bestAngle = v.angle; bestW = vw; bestH = vh; }
          }

          // Bottom-right corner
          const crx = bx + bw + pad, cry = by + bh + pad;
          if (tryPos(crx, cry, vw, vh, pad, sw, sh, boxBuf, boxCount)) {
            const s = cry * sw + crx;
            if (s < bestScore) { bestScore = s; bestX = crx; bestY = cry; bestAngle = v.angle; bestW = vw; bestH = vh; }
          }
        }
      }

      if (bestX >= 0) {
        placements.push({ polyIdx, x: bestX, y: bestY, angle: bestAngle, w: bestW, h: bestH });
        if (boxCount < MAX_PLACED) {
          const i = boxCount * 4;
          boxBuf[i] = bestX; boxBuf[i+1] = bestY;
          boxBuf[i+2] = bestW + pad; boxBuf[i+3] = bestH + pad;
          boxCount++;
        }
        totalPlaced++;
        if (onProgress) onProgress(totalPlaced, polygons.length, sheetNum);
      } else {
        stillRemaining.push(polyIdx);
      }
    }

    if (placements.length === 0) {
      const polyIdx = remaining[0];
      const v = variants[polyIdx][0];
      placements.push({ polyIdx, x: pad, y: pad, angle: v.angle, w: v.w, h: v.h });
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
// tryPos — check if a box fits at (x,y) with no allocations
// Pure scalar arithmetic, reads directly from Float64Array buffer
// ─────────────────────────────────────────────────────────────────────────────
function tryPos(x, y, w, h, pad, sw, sh, buf, count) {
  if (x < pad - 0.01 || y < pad - 0.01) return false;
  if (x + w > sw - pad + 0.01) return false;
  if (y + h > sh - pad + 0.01) return false;
  const x0 = x - pad, y0 = y - pad, x1 = x + w + pad, y1 = y + h + pad;
  for (let i = 0; i < count; i++) {
    const bi = i * 4;
    const bx = buf[bi], by = buf[bi+1], bw = buf[bi+2], bh = buf[bi+3];
    if (x0 < bx + bw && x1 > bx && y0 < by + bh && y1 > by) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function buildSeed(sheets) {
  if (!sheets.length) return null;
  return sheets[sheets.length - 1].map(p => ({
    x: p.x, y: p.y, w: p.placedW, h: p.placedH,
  }));
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
  const cx = pts.reduce((a,p) => a+p.x, 0) / pts.length;
  const cy = pts.reduce((a,p) => a+p.y, 0) / pts.length;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return pts.map(p => ({
    x: cx + (p.x-cx)*cos - (p.y-cy)*sin,
    y: cy + (p.x-cx)*sin + (p.y-cy)*cos,
  }));
}

function r3(n) { return Math.round(n*1000)/1000; }
