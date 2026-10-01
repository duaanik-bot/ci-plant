/* Kit Studio — the carton packing engine.
   Pure functions only — no page, no saved state — so the studio (index.html,
   which loads this file before its own script) and the server's tests
   (server/src/kit-pack.test.js) run exactly the same code.

   An inner carton's sides are t ≤ m ≤ b (mm). It sits one of three ways:
     flat  lying flat, its biggest face down          → t high
     edge  on its long edge, like a book on a shelf    → m high
     end   standing up on its end                      → b high
   rot turns it a quarter turn on the spot, so its long floor side runs front
   to back instead of left to right. Placed, a carton has
     l   length along the box, left to right
     d   depth, back to front
     up  height
   A spot on the floor may hold a stack: it.stack = the cartons resting on it,
   bottom to top. Cartons stand in rows (lanes) that run the box's length; the
   rows sit one behind the other across its width. Rows make blocks (lane.col,
   0 = the left-most; absent = 0) that stand side by side along the length: a
   carton beside the rows is a block of its own, so it can run front to back
   alongside all of them instead of making one row deep. */
(function (root) {
'use strict';

const dep = it => it.d ?? it.t;
const hasStack = it => !!(it && it.stack && it.stack.length);
const colItems = it => hasStack(it) ? [it, ...it.stack] : [it];
// A stack's footprint is its widest carton; its height, every carton's added up.
const FL = it => hasStack(it) ? Math.max(it.l, ...it.stack.map(s => s.l)) : it.l;
const FD = it => hasStack(it) ? Math.max(dep(it), ...it.stack.map(dep)) : dep(it);
const FH = it => hasStack(it) ? it.up + it.stack.reduce((a, x) => a + x.up, 0) : it.up;

/* The blocks of rows, left to right: each as long as its longest row, as deep as its rows together. The kit is the
   blocks side by side — their lengths added up, as deep as the deepest block. */
const colOf = ln => ln.col || 0;
function blocksOf(lanes) {
  const m = new Map();
  for (const ln of lanes) {
    if (!ln.items || !ln.items.length) continue;
    const c = colOf(ln); let b = m.get(c);
    if (!b) { b = { col: c, len: 0, dep: 0, lanes: [] }; m.set(c, b); }
    b.len = Math.max(b.len, ln.items.reduce((s, x) => s + FL(x), 0)); b.dep += Math.max(...ln.items.map(FD)); b.lanes.push(ln);
  }
  return [...m.values()].sort((a, b) => a.col - b.col);
}
function extentOf(lanes) {
  const bs = blocksOf(lanes);
  return { L: bs.reduce((s, b) => s + b.len, 0), W: bs.length ? Math.max(...bs.map(b => b.dep)) : 0, blocks: bs.length };
}

function orientDims(it) {
  let l, d, up;
  if (it.orient === 'end') { up = it.b; l = it.m; d = it.t; }
  else if (it.orient === 'flat') { up = it.t; l = it.b; d = it.m; }
  else { it.orient = 'edge'; up = it.m; l = it.b; d = it.t; }
  if (it.rot) { const x = l; l = d; d = x; }
  it.l = l; it.d = d; it.up = up; return it;
}

/* Cartons into rows no longer than cap: the narrowest total width wins. */
function packLanes(its, cap) {
  const orders = [(a, b) => dep(b) - dep(a) || b.l - a.l, (a, b) => b.l - a.l || dep(b) - dep(a), (a, b) => b.l * dep(b) - a.l * dep(a)];
  let best = null;
  for (const o of orders) {
    const arr = [...its].sort(o), lanes = [];
    for (const it of arr) {
      let pick = null, ps = null;
      for (const ln of lanes) {
        if (ln.len + it.l > cap) continue;
        const s0 = Math.max(ln.dep, dep(it)) - ln.dep, s1 = cap - ln.len - it.l;
        if (!pick || s0 < ps[0] || (s0 === ps[0] && s1 < ps[1])) { pick = ln; ps = [s0, s1]; }
      }
      if (pick) { pick.len += it.l; pick.dep = Math.max(pick.dep, dep(it)); pick.items.push(it); }
      else lanes.push({ len: it.l, dep: dep(it), items: [it] });
    }
    const W = lanes.reduce((s, l) => s + l.dep, 0), L = Math.max(...lanes.map(l => l.len));
    if (!best || W < best.W || (W === best.W && L < best.L)) best = { W, L, lanes };
  }
  return best;
}

const statusOf = (spareW, st) => spareW >= st.dWmin ? 'fits' : spareW >= 0 ? 'tight' : 'short';
const RANK = { fits: 0, tight: 1, short: 2 };

/* The house style, as the studio has always packed a box: each kind of carton
   on its long edge or standing up, one layer, nothing turned. */
function standingSearch(units, cap, hc) {
  const groups = {};
  units.forEach((u, i) => { const k = u.t + '-' + u.m + '-' + u.b; (groups[k] = groups[k] || []).push(i); });
  const gk = Object.keys(groups);
  const gopts = gk.map(k => {
    const u = units[groups[k][0]], o = [];
    if (u.m <= hc && u.b <= cap) o.push({ l: u.b, up: u.m, orient: 'edge' });
    if (u.b <= hc && u.m <= cap) o.push({ l: u.m, up: u.b, orient: 'end' });
    return o;
  });
  if (gopts.some(o => !o.length)) return null;
  let combos = [[]];
  for (const o of gopts) { const nx = []; for (const c of combos) for (const x of o) nx.push([...c, x]); combos = nx; if (combos.length > 1024) break; }
  let best = null;
  for (const c of combos.slice(0, 1024)) {
    const its = [];
    gk.forEach((k, gi) => { for (const i of groups[k]) its.push({ ...units[i], idx: i, l: c[gi].l, up: c[gi].up, orient: c[gi].orient }); });
    const p = packLanes(its, cap); if (p.L > cap) continue;
    if (!best || p.W < best.W || (p.W === best.W && p.lanes.length < best.lanes.length)) best = p;
  }
  return best && { lanes: best.lanes.map(l => ({ items: l.items })), W: best.W, L: best.L, rows: best.lanes.length, stacked: 0, house: true };
}

/* Every other way: lying flat, on edge or standing up, turned or not — and
   cartons lying flat stacked on one another, up to k high, wherever the box's
   height allows. A carton only rests on one at least as big under it. */
const PREF = { flat: ['flat', 'edge', 'end'], edge: ['edge', 'end', 'flat'], end: ['end', 'edge', 'flat'] };
const POLICIES = [['flat', 0], ['flat', 1], ['edge', 0], ['edge', 1], ['end', 0], ['end', 1]];
function poseFor(u, pol, rot, cap, hc, Wb) {
  for (const o of PREF[pol]) for (const r of rot ? [1, 0] : [0, 1]) {
    const x = orientDims({ ...u, orient: o, rot: !!r });
    if (x.l <= cap && x.up <= hc && x.d <= Wb) return x;
  }
  return null;
}
function makeColumns(its, k, hc) {
  const order = [...its].sort((a, b) => b.l * dep(b) - a.l * dep(a) || b.up - a.up), cols = [];
  for (const it of order) {
    let pick = null, ps = null;
    if (k > 1 && it.orient === 'flat') for (const c of cols) {
      const base = c[0]; if (base.orient !== 'flat' || c.length >= k) continue;
      const h = c.reduce((s, x) => s + x.up, 0);
      if (h + it.up > hc || it.l > base.l || dep(it) > dep(base)) continue;
      const sc = [it.pid === base.pid ? 0 : 1, base.l * dep(base) - it.l * dep(it), h];
      if (!pick || sc[0] < ps[0] || (sc[0] === ps[0] && (sc[1] < ps[1] || (sc[1] === ps[1] && sc[2] < ps[2])))) { pick = c; ps = sc; }
    }
    if (pick) pick.push(it); else cols.push([it]);
  }
  return cols.map(c => { const base = c[0]; if (c.length > 1) base.stack = c.slice(1); else delete base.stack; return base; });
}
function packColumns(cols, cap) {
  const p = packLanes(cols.map(x => ({ ref: x, l: FL(x), d: FD(x), t: FD(x), up: FH(x) })), cap);
  return { W: p.W, L: p.L, lanes: p.lanes.map(l => ({ items: l.items.map(x => x.ref) })) };
}
function poseSearch(units, cap, hc, Wb) {
  const out = [];
  for (const [pol, rot] of POLICIES) {
    const posed = units.map(u => poseFor(u, pol, rot, cap, hc, Wb)); if (posed.some(x => !x)) continue;
    const lows = posed.filter(x => x.orient === 'flat').map(x => x.up);
    const kmax = pol === 'flat' && lows.length ? Math.max(1, Math.min(8, Math.floor(hc / Math.min(...lows)))) : 1;
    for (let k = 1; k <= kmax; k++) {
      const cols = makeColumns(posed.map(x => ({ ...x })), k, hc);
      if (k > 1 && cols.length === posed.length) break;            // nothing stacks: a higher k won't either
      const p = packColumns(cols, cap); if (p.L > cap) continue;
      out.push({ lanes: p.lanes, W: p.W, L: p.L, rows: p.lanes.length, stacked: posed.length - cols.length, high: Math.max(...cols.map(c => colItems(c).length)), pol, rot: !!rot, house: false });
      if (cols.length === 1) break;
    }
  }
  return out;
}

/* Beside the rows: one kind of carton — one, two or three of it — taken out of
   the rows and stood at the box's side (a block of its own, lane.col 1), turned
   or not, one behind the other; the rest stand in rows the house way, in the
   length left. Standing only, nothing stacked. Tried thinnest along the length
   first. Where one carton made its row as deep as itself, it now runs front to
   back beside every row. */
function sideSearch(units, cap, hc, Wb) {
  const kinds = {};
  units.forEach((u, i) => { const k = u.t + '-' + u.m + '-' + u.b; (kinds[k] = kinds[k] || []).push(i); });
  const out = [];
  // the floor a carton takes standing in a row (the house way), or Infinity where it can't stand in that length
  const foot = (r, room) => Math.min(r.m <= hc && r.b <= room ? r.t * r.b : Infinity, r.b <= hc && r.m <= room ? r.t * r.m : Infinity);
  for (const k of Object.keys(kinds)) {
    const idx = kinds[k], u = units[idx[0]], poses = [], seen = new Set();
    for (const o of ['end', 'edge']) for (const rot of [true, false]) {
      const x = orientDims({ ...u, orient: o, rot });
      const pk = x.l + 'x' + dep(x) + 'x' + x.up;
      if (x.up <= hc && x.l < cap && dep(x) <= Wb && !seen.has(pk)) { seen.add(pk); poses.push(x); }
    }
    poses.sort((a, b) => a.l - b.l || dep(a) - dep(b));
    for (let n = 1; n <= Math.min(3, idx.length) && n < units.length; n++) {
      const take = new Set(idx.slice(0, n)), rest = units.filter((_, i) => !take.has(i));
      for (const x of poses) {
        if (dep(x) * n > Wb) continue;
        const room = cap - x.l;
        const area = rest.reduce((s, r) => s + foot(r, room), 0);
        if (!(area / room <= Wb)) continue;                         // the rows can't be that shallow in the length left
        const main = standingSearch(rest, room, hc); if (!main || main.L > room) continue;
        const side = [...take].map(i => ({ items: [orientDims({ ...units[i], idx: i, orient: x.orient, rot: x.rot })], col: 1 }));
        const lanes = [...main.lanes, ...side];
        out.push({ lanes, W: Math.max(main.W, dep(x) * n), L: main.L + x.l, rows: lanes.length, stacked: 0, side: n, house: false, pol: 'side' });
      }
    }
  }
  return out;
}

/* Rank among arrangements that fit: the house style first; no stack before a
   stack; a proper fit before a tight one; cartons beside the rows before
   cartons laid down or turned; the fewest cartons stacked; the narrowest; the
   fewest rows. */
const okOf = c => c.status !== 'short';
const keyOf = c => [okOf(c) ? 0 : 1, c.house ? 0 : 1, c.stacked ? 1 : 0, RANK[c.status], c.side ? 0 : 1, c.stacked, c.W, c.rows];
function better(a, b) { const x = keyOf(a), y = keyOf(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; }

/* The house style in a box, exactly as the studio has always worked it out:
   with the box's length and height clearance, and only when that is
   impossible, without (pass 1). */
function houseFit(units, L, W, H, st) {
  for (const [pass, cl, ch] of [[0, st.dLmin, st.dHmin], [1, 0, 0]]) {
    const a = standingSearch(units, L - cl, H - ch);
    if (a) { a.pass = pass; a.status = statusOf(W - a.W, st); return a; }
  }
  return null;
}
/* Every arrangement found for a box, each with its status (by the spare
   width). The other ways — flat, turned, stacked — always keep the clearance,
   and are only looked for when the house style doesn't fit, or when every way
   is asked for (all). */
function candidates(units, size, st, all) {
  const L = +size.L, W = +size.W, H = +size.H, out = [];
  if (!units.length || !(L > 0 && W > 0 && H > 0)) return out;
  const a = houseFit(units, L, W, H, st); if (a) out.push(a);
  if (!all && a && okOf(a)) return out;
  for (const c of [...sideSearch(units, L - st.dLmin, H - st.dHmin, W), ...poseSearch(units, L - st.dLmin, H - st.dHmin, W)]) { c.pass = 0; c.status = statusOf(W - c.W, st); out.push(c); }
  return out;
}

/* The arrangement for a given box: { lanes, W, L, rows, status, pass, stacked,
   house } or null. Where the house style fits, it is the answer — a box the
   cartons always fitted packs as before. Where it doesn't, the best other way
   that fits; and where nothing fits, the house style's answer as before. */
function fitBox(units, size, st) {
  const cs = candidates(units, size, st, false); let best = null;
  for (const c of cs) if (okOf(c) && (!best || better(c, best))) best = c;
  return best || cs.find(c => c.house) || null;
}

/* How an arrangement sits, in plain words — for the "ways to pack" choices. */
function kindOf(c) {
  const all = c.lanes.flatMap(l => l.items.flatMap(colItems));
  const os = new Set(all.map(x => x.orient || 'edge')), turned = all.filter(x => x.rot).length * 2 > all.length;
  const k = c.stacked ? 'stack' : c.side ? 'side' : os.size === 1 ? [...os][0] : os.has('flat') ? 'mixed' : 'standing';
  return { kind: k + (turned ? '-turned' : ''), turned, base: k };
}
const WAY_LABEL = { flat: 'Lying flat', edge: 'On the long edge', end: 'Standing up', standing: 'Standing up and on edge', mixed: 'Some flat, some standing' };
function wayLabel(c) {
  const k = kindOf(c), t = k.turned ? ', turned 90°' : '';
  if (k.base === 'stack') return `Lying flat, stacked ${c.high} high${t}`;
  if (k.base === 'side') {
    const os = new Set(c.lanes.filter(l => !colOf(l)).flatMap(l => l.items.flatMap(colItems)).map(x => x.orient || 'edge'));
    return `${os.size === 1 ? WAY_LABEL[[...os][0]] : WAY_LABEL.standing} in rows, ${c.side} beside them`;
  }
  return WAY_LABEL[k.base] + t;
}
/* an arrangement in a few characters: the same arrangement, the same string (a block beside the rows marked c>) */
const sigOf = lanes => lanes.map(l => (colOf(l) ? colOf(l) + '>' : '') + l.items.map(c => colItems(c).map(x => x.pid + ':' + (x.orient || 'edge') + (x.rot ? 'r' : '')).join('/')).join(',')).join('|');

/* The different ways these cartons go into one box — one per way of sitting,
   best first, the box's own arrangement (fitBox) among them. */
function packWays(units, size, st, max = 5) {
  const cs = candidates(units, size, st, true), by = new Map();
  for (const c of cs) { const k = kindOf(c).kind, o = by.get(k); if (!o || better(c, o)) by.set(k, c); }
  const best = fitBox(units, size, st), list = [...by.values()].sort((a, b) => better(a, b) ? -1 : better(b, a) ? 1 : 0);
  const seen = new Set(), out = [];
  for (const c of best ? [best, ...list] : list) {
    const s = sigOf(c.lanes); if (seen.has(s)) continue; seen.add(s);
    out.push({ ...c, sig: s, label: wayLabel(c), kind: kindOf(c).base, best: c === best });
    if (out.length >= max) break;
  }
  return out;
}

root.KitPack = { dep, hasStack, colItems, FL, FD, FH, colOf, blocksOf, extentOf, orientDims, packLanes, statusOf, standingSearch, poseSearch, sideSearch, makeColumns, fitBox, packWays, wayLabel, sigOf };
})(typeof window !== 'undefined' ? window : globalThis);
