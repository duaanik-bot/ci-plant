// Kit Studio's carton packing engine (client/public/kit-studio-app/kit-pack.js):
// how the cartons go into a chosen box. A box the cartons always stood in packs
// exactly as before; a box they don't stand in is tried lying flat, turned and
// stacked — so choosing a die re-stacks the cartons for that die. The studio page
// loads this same file, and New kit re-packs whenever a box is chosen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const sandbox = {}; vm.createContext(sandbox);
vm.runInContext(read('client/public/kit-studio-app/kit-pack.js'), sandbox);
const K = sandbox.KitPack;
const J = v => JSON.parse(JSON.stringify(v));   // the engine runs in its own realm: compare plain data
const ST = { cL: 4, cW: 3, cH: 10, dLmin: 2, dLmax: 6, dWmin: 3, dWmax: 9, dHmin: 6, dHmax: 10 };
const carton = (pid, a, b, c, q = 1) => Array.from({ length: q }, () => { const [t, m, bb] = [a, b, c].sort((x, y) => x - y); return { pid, name: pid, t, m, b: bb }; });
const all = c => c.lanes.flatMap(l => l.items.flatMap(K.colItems));

// The studio's fixed-box search before stacking came in, kept here word for word:
// every answer it gave where the cartons fitted must come out the same.
function oldFit(units, size) {
  const L = +size.L, W = +size.W, H = +size.H;
  const groups = {}; units.forEach((u, i) => { (groups[u.t + '-' + u.m + '-' + u.b] = groups[u.t + '-' + u.m + '-' + u.b] || []).push(i); }); const gk = Object.keys(groups);
  let best = null;
  for (const [cl, ch] of [[ST.dLmin, ST.dHmin], [0, 0]]) {
    const cap = L - cl, hc = H - ch;
    const gopts = gk.map(k => { const u = units[groups[k][0]]; const o = []; if (u.m <= hc && u.b <= cap) o.push({ l: u.b, up: u.m, orient: 'edge' }); if (u.b <= hc && u.m <= cap) o.push({ l: u.m, up: u.b, orient: 'end' }); return o; });
    if (gopts.some(o => !o.length)) continue;
    let combos = [[]]; for (const o of gopts) { const nx = []; for (const c of combos) for (const x of o) nx.push([...c, x]); combos = nx; if (combos.length > 1024) break; }
    for (const c of combos.slice(0, 1024)) {
      const its = []; gk.forEach((k, gi) => { for (const i of groups[k]) its.push({ ...units[i], idx: i, l: c[gi].l, up: c[gi].up, orient: c[gi].orient }); });
      const p = K.packLanes(its, cap); if (p.L > cap) continue;
      if (!best || p.W < best.p.W || (p.W === best.p.W && p.lanes.length < best.p.lanes.length)) best = { p };
    }
    if (best) break;
  }
  if (!best) return { status: 'nofit' };
  const spareW = W - best.p.W;
  return { status: spareW >= ST.dWmin ? 'fits' : spareW >= 0 ? 'tight' : 'short', sig: K.sigOf(best.p.lanes) };
}

// F1-O2: three 15 × 102 × 136 cartons, and four smaller ones
const F1O2 = [...carton('ferrum', 15, 102, 136), ...carton('protein', 15, 102, 136), ...carton('cald3', 15, 102, 136),
  ...carton('gold', 12, 70, 90), ...carton('alexa', 12, 77, 100), ...carton('flax', 10, 52, 90)];

test('a carton sits three ways — lying flat, on its long edge, standing up — and turns a quarter turn on the spot', () => {
  const u = { t: 15, m: 75, b: 102 };
  const at = (orient, rot) => { const x = K.orientDims({ ...u, orient, rot }); return [x.l, x.d, x.up]; };
  assert.deepEqual(at('flat'), [102, 75, 15], 'lying flat: lowest');
  assert.deepEqual(at('edge'), [102, 15, 75], 'on its long edge, like a book on a shelf');
  assert.deepEqual(at('end'), [75, 15, 102], 'standing up: tallest');
  assert.deepEqual(at('end', true), [15, 75, 102], 'turned: the floor sides swap');
  // a stack's footprint is its widest carton, its height every carton added up
  const base = K.orientDims({ ...u, orient: 'flat' }), top = K.orientDims({ t: 12, m: 45, b: 98, orient: 'flat', rot: true });
  base.stack = [top];
  assert.deepEqual([K.FL(base), K.FD(base), K.FH(base)], [102, 98, 27]);
});

test('a box the cartons stand in packs exactly as it always has', () => {
  const r = K.fitBox(F1O2, { L: 138, W: 72, H: 108 }, ST);
  assert.equal(r.house, true); assert.equal(r.stacked, 0); assert.equal(r.status, 'fits');
  assert.equal(r.W, 69, 'three 15 mm rows, two 12 mm rows');
  assert.ok(all(r).every(x => x.orient === 'edge' || x.orient === 'end'), 'standing, as the house style is');
  assert.equal(K.sigOf(r.lanes), oldFit(F1O2, { L: 138, W: 72, H: 108 }).sig);
});

test('every box the old engine fitted keeps its arrangement — on many random kits and boxes', () => {
  let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const sizes = [[15, 75, 102], [15, 102, 136], [12, 45, 98], [38, 38, 55], [30, 30, 93], [12, 70, 90], [10, 52, 90], [15, 55, 115], [52, 75, 150]];
  let compared = 0, gained = 0;
  for (let n = 0; n < 400; n++) {
    const units = []; const kinds = 1 + rnd(4);
    for (let k = 0; k < kinds; k++) { const s = sizes[rnd(sizes.length)]; units.push(...carton('p' + k, s[0], s[1], s[2], 1 + rnd(3))); }
    const box = { L: 100 + rnd(80), W: 40 + rnd(110), H: 50 + rnd(80) };
    const old = oldFit(units, box), now = K.fitBox(units, box, ST);
    if (old.status === 'fits' || old.status === 'tight') {
      compared++;
      assert.equal(now.status, old.status, JSON.stringify(box));
      assert.equal(K.sigOf(now.lanes), old.sig, 'same rows, same cartons, same way up');
      assert.equal(now.house, true);
    } else if (now && now.status !== 'short') {
      gained++;                                            // fits now: lying flat, turned or stacked
      assert.equal(now.house, false);
      assert.ok(now.L <= box.L - ST.dLmin && Math.max(...now.lanes.flatMap(l => l.items.map(K.FH))) <= box.H - ST.dHmin, 'the other ways keep the clearance');
      assert.ok(now.W <= box.W);
    }
  }
  assert.ok(compared > 50 && gained > 10, `compared ${compared}, gained ${gained}`);
});

test('a die the cartons cannot stand in: they lie flat and stack, as high as it allows', () => {
  // F1-O2 in a low, wide die (153 × 138 × 98): standing on edge they are 102 mm high — too high
  assert.equal(oldFit(F1O2, { L: 153, W: 138, H: 98 }).status, 'nofit');
  const r = K.fitBox(F1O2, { L: 153, W: 138, H: 98 }, ST);
  assert.equal(r.house, false); assert.equal(r.status, 'fits');
  assert.ok(r.stacked > 0, 'stacked');
  assert.ok(all(r).every(x => x.orient === 'flat'), 'every carton lying flat');
  const heights = r.lanes.flatMap(l => l.items.map(K.FH));
  assert.ok(Math.max(...heights) <= 98 - ST.dHmin, 'the stack keeps the height clearance');
  // every carton rests on one at least as big
  for (const c of r.lanes.flatMap(l => l.items)) for (const x of c.stack || []) assert.ok(x.l <= c.l && K.dep(x) <= K.dep(c));
  assert.equal(K.wayLabel(r), `Lying flat, stacked ${r.high} high`);
});

test('nothing goes in: the answer is the one it always was', () => {
  assert.equal(K.fitBox(F1O2, { L: 60, W: 60, H: 60 }, ST), null, 'too small every way');
  const narrow = K.fitBox(carton('tab', 15, 75, 102, 8), { L: 110, W: 40, H: 108 }, ST);
  assert.equal(narrow.house, true); assert.equal(narrow.status, 'short', 'standing, needing more width — as before');
});

test('stacking: up to k high, within the height, never on a smaller carton', () => {
  const flat = (pid, t, m, b) => K.orientDims({ pid, t, m, b, orient: 'flat' });
  const its = [flat('a', 15, 75, 102), flat('a', 15, 75, 102), flat('a', 15, 75, 102), flat('b', 12, 45, 98), flat('c', 20, 110, 125)];
  const two = J(K.makeColumns(its.map(x => ({ ...x })), 2, 200));
  assert.ok(two.every(c => 1 + (c.stack || []).length <= 2));
  assert.equal(two.reduce((s, c) => s + 1 + (c.stack || []).length, 0), 5, 'every carton is in a column');
  const low = J(K.makeColumns(its.map(x => ({ ...x })), 8, 40));
  assert.ok(low.every(c => c.up + (c.stack || []).reduce((s, x) => s + x.up, 0) <= 40));
  for (const c of J(K.makeColumns(its.map(x => ({ ...x })), 8, 200))) for (const x of c.stack || []) assert.ok(x.l <= c.l && x.d <= c.d);
  const standing = K.makeColumns([K.orientDims({ pid: 'e', t: 15, m: 75, b: 102, orient: 'end' }), K.orientDims({ pid: 'e', t: 15, m: 75, b: 102, orient: 'end' })], 4, 400);
  assert.equal(standing.length, 2, 'only cartons lying flat are stacked');
});

test('the ways to pack one box: each once, the box’s own arrangement first', () => {
  const tabs = carton('tab', 15, 75, 102, 4);
  const ways = K.packWays(tabs, { L: 138, W: 96, H: 108 }, ST);
  const labels = ways.map(w => w.label);
  assert.equal(ways[0].best, true);
  assert.equal(K.sigOf(ways[0].lanes), K.sigOf(K.fitBox(tabs, { L: 138, W: 96, H: 108 }, ST).lanes));
  assert.equal(new Set(ways.map(w => w.sig)).size, ways.length, 'no way twice');
  assert.ok(labels.includes('Lying flat, stacked 4 high'), labels.join(' | '));
  assert.ok(labels.includes('Standing up'), labels.join(' | '));
  assert.ok(ways.length <= 4);
});

test('the studio packs with this engine, and choosing a box re-packs the new kit for it', () => {
  const html = read('client/public/kit-studio-app/index.html');
  assert.ok(html.indexOf('<script src="kit-pack.js"></script>') > 0 && html.indexOf('<script src="kit-pack.js"></script>') < html.indexOf('<script>\n'), 'the engine loads before the studio');
  assert.match(html, /const \{dep,orientDims,hasStack,colItems,FL,FD,FH,packLanes\}=window\.KitPack;/, 'one copy of the geometry');
  assert.match(html, /const b=KitPack\.fitBox\(units,\{L,W,H\},st\);/);
  assert.doesNotMatch(html, /function packLanes\(/, 'not a second packer in the page');
  // a box chosen for a new kit clears the hand-made arrangement, as a step Undo takes back
  const pick = html.slice(html.indexOf('function pickBox('), html.indexOf('function startFromScratch('));
  assert.match(pick, /pushHist\('b',what\|\|`choosing the box \$\{dimTxt\(box\)\}`\);\n\s+b\.choice=box; b\.ovr=\{L:'',W:'',H:''\}; b\.custom=null;/);
  assert.match(html, /else pickBox\(\{L,W,H\}\); return; \}/, 'Top sizes, dies in hand and the size comparison all go through it');
  // moving or turning a carton by hand keeps the box chosen
  assert.match(html, /function afterLay\(ctx\)\{ if\(ctx==='b'\) render\(\); else renderDrawer\(\); \}/);
});
