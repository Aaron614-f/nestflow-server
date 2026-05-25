/**
 * NestFlow — Nesting Server v3.1
 * NFP two-pass nesting with streaming progress events.
 *
 * The /nest endpoint streams newline-delimited JSON events as each phase
 * completes, so the frontend can update in real time:
 *
 *   {"type":"start",    "rectCount":31, "roundedCount":12, "totalParts":43}
 *   {"type":"pass",     "pass":1, "label":"Rectangular parts", "total":31}
 *   {"type":"placed",   "pass":1, "placed":10, "total":31, "sheet":1}
 *   {"type":"placed",   "pass":1, "placed":20, "total":31, "sheet":1}
 *   {"type":"passdone", "pass":1, "sheets":2, "placed":31}
 *   {"type":"pass",     "pass":2, "label":"Rounded parts (filling gaps)", "total":12}
 *   {"type":"placed",   "pass":2, "placed":6,  "total":12, "sheet":1}
 *   {"type":"passdone", "pass":2, "sheets":2,  "placed":12, "overflow":0}
 *   {"type":"done",     "sheets":[...complete result...]}
 *
 * Usage:  node server.js
 * Stop:   Ctrl+C
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const ClipperLib = require('clipper-lib');

const PORT  = process.env.PORT || 3000;
const SCALE = 10000000;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/ping') {
    json(res, 200, { ok: true, engine: 'NFP two-pass v3.1', version: '3.1.0' });
    return;
  }

  if (req.method === 'POST' && req.url === '/nest') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const nParts  = payload.parts?.length || 0;
        const { w, h } = payload.sheet || {};
        console.log(`  Nesting ${nParts} parts on ${w}×${h}mm sheet`);

        // Stream newline-delimited JSON events
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Transfer-Encoding': 'chunked',
          'X-Accel-Buffering': 'no', // disable Railway/nginx buffering
        });

        const emit = obj => res.write(JSON.stringify(obj) + '\n');

        try {
          runNestingStreamed(payload, emit);
        } catch (err) {
          console.error('  Nesting error:', err.message);
          emit({ type: 'error', error: err.message });
        }
        res.end();

      } catch (err) {
        console.error('  Parse error:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
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
  console.log('  |  NestFlow Nesting Server  v3.1          |');
  console.log(`  |  Listening on http://localhost:${PORT}      |`);
  console.log('  |  Engine: NFP two-pass + streaming        |');
  console.log('  +==========================================+');
  console.log('');
  console.log('  Open nestflow.html in Chrome or Edge to start.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point — streams events as each pass completes
// ─────────────────────────────────────────────────────────────────────────────
function runNestingStreamed({ sheet, parts, spacing = 2 }, emit) {
  if (!sheet || !parts || !parts.length) throw new Error('Invalid payload');

  const sw = sheet.w, sh = sheet.h, pad = spacing;

  const polygons = parts.map(p => ({
    pts: (p.points && p.points.length >= 3) ? p.points : rectPoints(p.w, p.h),
    w: p.w, h: p.h, idx: p.idx,
  }));

  const rectPolys    = polygons.filter(p => p.pts.length === 4);
  const roundedPolys = polygons.filter(p => p.pts.length !== 4);

  emit({ type: 'start', rectCount: rectPolys.length, roundedCount: roundedPolys.length, totalParts: polygons.length });

  // ── Pass 1: rectangles ──────────────────────────────────────────────────────
  emit({ type: 'pass', pass: 1, label: 'Rectangular parts', total: rectPolys.length, rotations: 4 });

  const { sheets: pass1Sheets } = nestPolygons(
    rectPolys, sw, sh, pad, 4, null,
    (placed, total, sheetNum) => emit({ type: 'placed', pass: 1, placed, total, sheet: sheetNum })
  );

  emit({ type: 'passdone', pass: 1, sheets: pass1Sheets.length, placed: rectPolys.length });
  console.log(`  Pass 1: ${pass1Sheets.length} sheet(s), ${rectPolys.length} parts`);

  // ── Pass 2: rounded fills gaps ──────────────────────────────────────────────
  emit({ type: 'pass', pass: 2, label: 'Rounded parts — filling gaps', total: roundedPolys.length, rotations: 8 });

  const pass1Occupied = buildOccupiedFromSheets(pass1Sheets, sw, sh, pad);
  const { sheets: pass2Sheets, overflow } = nestPolygons(
    roundedPolys, sw, sh, pad, 8, pass1Occupied,
    (placed, total, sheetNum) => emit({ type: 'placed', pass: 2, placed, total, sheet: sheetNum })
  );

  emit({ type: 'passdone', pass: 2, sheets: pass2Sheets.length, placed: roundedPolys.length - overflow.length, overflow: overflow.length });
  console.log(`  Pass 2: ${pass2Sheets.length} sheet(s), ${overflow.length} overflow`);

  // ── Pass 3: overflow ────────────────────────────────────────────────────────
  let pass3Sheets = [];
  if (overflow.length) {
    emit({ type: 'pass', pass: 3, label: 'Overflow — fresh sheets', total: overflow.length, rotations: 8 });

    const result3 = nestPolygons(
      overflow, sw, sh, pad, 8, null,
      (placed, total, sheetNum) => emit({ type: 'placed', pass: 3, placed, total, sheet: sheetNum })
    );
    pass3Sheets = result3.sheets;

    emit({ type: 'passdone', pass: 3, sheets: pass3Sheets.length, placed: overflow.length, overflow: 0 });
    console.log(`  Pass 3: ${pass3Sheets.length} sheet(s)`);
  }

  // ── Final result ────────────────────────────────────────────────────────────
  const result = mergeSheets(pass1Sheets, pass2Sheets, pass3Sheets);
  console.log(`  Done — ${result.sheets.length} sheet(s) total`);
  emit({ type: 'done', ...result });
}

// ─────────────────────────────────────────────────────────────────────────────
// Core NFP nesting engine
// onProgress(placedSoFar, total, currentSheetNumber) called after each placement
// ─────────────────────────────────────────────────────────────────────────────
function nestPolygons(polygons, sw, sh, pad, rotations, seedOccupied = null, onProgress = null) {
  if (!polygons.length) return { sheets: [], overflow: [], unplaced: [] };

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

  const order = polygons.map((_, i) => i).sort((a, b) =>
    (polygons[b].w * polygons[b].h) - (polygons[a].w * polygons[a].h)
  );

  const sheets   = [];
  let remaining  = order.slice();
  let totalPlaced = 0;
  let sheetOccupied = seedOccupied ? seedOccupied.map(o => [...o]) : null;

  while (remaining.length > 0) {
    if (!sheetOccupied || sheetOccupied.length === 0) {
      sheetOccupied = [[]];
    }

    const occupied     = sheetOccupied[sheetOccupied.length - 1];
    const placements   = [];
    const stillRemaining = [];
    const sheetNum     = sheets.length + 1;

    for (const polyIdx of remaining) {
      let bestPlacement = null;
      let bestScore     = Infinity;

      for (const v of variants[polyIdx]) {
        if (v.w + pad * 2 > sw || v.h + pad * 2 > sh) continue;
        const candidates = getCandidatePositions(v.pts, occupied, sw, sh, pad);
        for (const { x, y } of candidates) {
          const placed = v.pts.map(p => ({ x: p.x + x, y: p.y + y }));
          if (!fitsInSheet(placed, sw, sh, pad)) continue;
          if (overlapsOccupied(placed, occupied)) continue;
          const score = y * sw + x;
          if (score < bestScore) {
            bestScore = score;
            bestPlacement = { polyIdx, x, y, rotation: v.angle, pts: v.pts, w: v.w, h: v.h };
          }
        }
      }

      if (bestPlacement) {
        placements.push(bestPlacement);
        const placed = bestPlacement.pts.map(p => ({ x: p.x + bestPlacement.x, y: p.y + bestPlacement.y }));
        occupied.push(...expandPoly(placed, pad));
        totalPlaced++;
        if (onProgress) onProgress(totalPlaced, polygons.length, sheetNum);
      } else {
        stillRemaining.push(polyIdx);
      }
    }

    if (placements.length === 0) {
      const polyIdx = remaining[0];
      const v = variants[polyIdx][0];
      placements.push({ polyIdx, x: pad, y: pad, rotation: v.angle, pts: v.pts, w: v.w, h: v.h });
      stillRemaining.push(...remaining.slice(1));
    }

    sheets.push(placements.map(p => ({
      idx: polygons[p.polyIdx].idx, x: r3(p.x), y: r3(p.y),
      rotation: p.rotation, placedW: r3(p.w), placedH: r3(p.h),
    })));

    remaining     = stillRemaining;
    sheetOccupied = null;
  }

  return { sheets, overflow: [], unplaced: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// NFP candidate positions via Minkowski sum
// ─────────────────────────────────────────────────────────────────────────────
function getCandidatePositions(pts, occupied, sw, sh, pad) {
  const bb = bbox(pts);
  const candidates = [
    { x: pad,              y: pad },
    { x: sw - bb.w - pad,  y: pad },
    { x: pad,              y: sh - bb.h - pad },
    { x: sw - bb.w - pad,  y: sh - bb.h - pad },
  ];
  if (occupied.length > 0) {
    candidates.push(...computeNFPVertices(pts, occupied, sw, sh, pad));
  }
  return deduplicateCandidates(candidates, 1.0);
}

function computeNFPVertices(pts, occupied, sw, sh, pad) {
  const bb = bbox(pts);
  const ifpPts = [
    { x: pad,              y: pad },
    { x: sw - bb.w - pad,  y: pad },
    { x: sw - bb.w - pad,  y: sh - bb.h - pad },
    { x: pad,              y: sh - bb.h - pad },
  ];
  if (ifpPts[1].x < ifpPts[0].x || ifpPts[2].y < ifpPts[0].y) return [];

  const reflected = pts.map(p => ({ x: -p.x, y: -p.y }));
  const minkowskiPaths = [];
  for (const occPath of occupied) {
    const ms = minkowskiSum(occPath, toClipperPath(reflected));
    if (ms) minkowskiPaths.push(...ms);
  }
  if (!minkowskiPaths.length) return ifpPts;

  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths([toClipperPath(ifpPts)], ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(minkowskiPaths,          ClipperLib.PolyType.ptClip,    true);
  const solution = new ClipperLib.Paths();
  clipper.Execute(ClipperLib.ClipType.ctDifference, solution,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);

  if (!solution || !solution.length) return ifpPts;
  const result = [];
  for (const path of solution) for (const pt of path) {
    result.push({ x: pt.X / SCALE, y: pt.Y / SCALE });
  }
  return result;
}

function minkowskiSum(pathA, pathB) {
  try {
    const solution = new ClipperLib.Paths();
    ClipperLib.Clipper.MinkowskiSum(pathA, pathB, solution, true);
    return solution.length ? solution : null;
  } catch (e) { return null; }
}

function buildOccupiedFromSheets(sheets, sw, sh, pad) {
  return sheets.map(placements => {
    const occupied = [];
    for (const p of placements) {
      const rectPts = [
        { x: p.x,            y: p.y },
        { x: p.x + p.placedW, y: p.y },
        { x: p.x + p.placedW, y: p.y + p.placedH },
        { x: p.x,            y: p.y + p.placedH },
      ];
      occupied.push(...expandPoly(rectPts, pad));
    }
    return occupied;
  });
}

function mergeSheets(pass1, pass2, pass3) {
  const maxShared = Math.max(pass1.length, pass2.length);
  const merged = [];
  for (let i = 0; i < maxShared; i++) {
    merged.push([...(pass1[i] || []), ...(pass2[i] || [])]);
  }
  for (const sheet of pass3) merged.push(sheet);
  return {
    sheets: merged.map((placements, i) => ({
      index: i + 1, placements, utilisation: 0,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────
function rectPoints(w, h) {
  return [{ x:0,y:0 },{ x:w,y:0 },{ x:w,y:h },{ x:0,y:h }];
}
function bbox(pts) {
  const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  return { minX,minY,maxX,maxY,w:maxX-minX,h:maxY-minY };
}
function normalise(pts) {
  const bb=bbox(pts);
  return pts.map(p=>({ x:p.x-bb.minX, y:p.y-bb.minY }));
}
function rotatePoly(pts, angleDeg) {
  if (angleDeg===0) return pts;
  const rad=(angleDeg*Math.PI)/180;
  const cx=pts.reduce((a,p)=>a+p.x,0)/pts.length;
  const cy=pts.reduce((a,p)=>a+p.y,0)/pts.length;
  return pts.map(p=>({
    x: cx+(p.x-cx)*Math.cos(rad)-(p.y-cy)*Math.sin(rad),
    y: cy+(p.x-cx)*Math.sin(rad)+(p.y-cy)*Math.cos(rad),
  }));
}
function fitsInSheet(pts,w,h,pad) {
  return pts.every(p=>p.x>=pad-0.001&&p.y>=pad-0.001&&p.x<=w-pad+0.001&&p.y<=h-pad+0.001);
}
function deduplicateCandidates(pts,tol) {
  const out=[];
  for (const p of pts) if (!out.some(q=>Math.abs(q.x-p.x)<tol&&Math.abs(q.y-p.y)<tol)) out.push(p);
  return out;
}
function r3(n) { return Math.round(n*1000)/1000; }

// ─────────────────────────────────────────────────────────────────────────────
// Clipper helpers
// ─────────────────────────────────────────────────────────────────────────────
function toClipperPath(pts) {
  return pts.map(p=>({ X:Math.round(p.x*SCALE), Y:Math.round(p.y*SCALE) }));
}
function expandPoly(pts,delta) {
  if (delta<=0) return [toClipperPath(pts)];
  const co=new ClipperLib.ClipperOffset();
  co.AddPath(toClipperPath(pts),ClipperLib.JoinType.jtRound,ClipperLib.EndType.etClosedPolygon);
  const solution=new ClipperLib.Paths();
  co.Execute(solution,delta*SCALE);
  return solution;
}
function overlapsOccupied(candidate,occupied) {
  if (!occupied||!occupied.length) return false;
  const clipper=new ClipperLib.Clipper();
  clipper.AddPaths([toClipperPath(candidate)],ClipperLib.PolyType.ptSubject,true);
  clipper.AddPaths(occupied,ClipperLib.PolyType.ptClip,true);
  const solution=new ClipperLib.Paths();
  clipper.Execute(ClipperLib.ClipType.ctIntersection,solution);
  if (!solution||!solution.length) return false;
  return Math.abs(ClipperLib.Clipper.Area(solution[0]))/(SCALE*SCALE)>0.01;
}
function json(res,status,data) {
  res.writeHead(status,{'Content-Type':'application/json'});
  res.end(JSON.stringify(data));
}
