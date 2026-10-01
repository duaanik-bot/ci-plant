// Kit Studio (client/public/kit-studio-app/index.html + kit-pack.js): cartons beside the rows, and the size typed by hand.
//   • Rows make blocks (lane.col) that stand side by side along the box. A carton beside the rows is a block of its own:
//     turned, it runs front to back alongside every row — the rows stay together instead of one row growing as deep
//     as that carton (Anik, 1-Oct: "5 in one line, and parallel to that 1 to the right").
//   • The engine finds such arrangements where the cartons don't stand in a box the usual way.
//   • A size typed by hand gets its own card: do the cartons go in, how, how empty — amended sizes near it.
// The page's own helpers are run in a sandbox; the rest is checked as wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const html = read('client/public/kit-studio-app/index.html');
const between = (a, b) => {
  const i = html.indexOf(a), j = html.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `the page has ${a} … ${b}`);
  return html.slice(i, j);
};
const ST = { cL: 4, cW: 3, cH: 10, dLmin: 2, dLmax: 6, dWmin: 3, dWmax: 9, dHmin: 6, dHmax: 10 };
const sb = { S: { settings: ST } };
vm.createContext(sb);
vm.runInContext(read('client/public/kit-studio-app/kit-pack.js'), sb);
const P = vm.runInContext(`const {hasStack,colItems,FL,FD,FH,orientDims,dep,packLanes}=KitPack; let UID=0; const uidOf = it => (it.u==null?(it.u=++UID):it.u);
${between('/* the arrangement\'s size:', 'const cloneLanes')}
${between('function layGeom(', 'const shortName')}
${between('/* Where a point on the floor falls.', 'function showDrop(')}
${between('function placeAt(', 'function findCarton(')}
${between('/* Where a move button sends a carton', '/* a left / right press that takes')}
${between('/* the best free spot on the floor', 'function trayPut(')}
${between('function hitTarget(', '/* the carton a drag carries')}
${between('/* a saved arrangement in words', '/* One table per export')}
({deriveLay,normLanes,layGeom,mainCol,laneSide,spotAt,sameSpot,placeAt,moveTarget,bestSpot,hitTarget,layoutText})`, sb);
const K = sb.KitPack;
const J = v => JSON.parse(JSON.stringify(v));   // plain data: the page's helpers run in their own realm
const at = (pid, t, m, b, orient = 'end', rot = false) => K.orientDims({ pid, name: pid, t, m, b, orient, rot });
const thin = pid => at(pid, 15, 75, 102);                         // stands 75 long × 15 deep × 102 high
// five thin cartons in a line (one behind the other) and FERRUM-MMS turned beside them, as in Anik's picture
const fivePlusOne = () => [...['a', 'b', 'c', 'd', 'e'].map(p => ({ items: [thin(p)] })), { items: [at('fer', 42, 65, 110, 'end', true)], col: 1 }];

test('cartons beside the rows: the box is as long as the blocks side by side, as deep as the deepest block', () => {
  const lay = P.deriveLay(fivePlusOne());
  assert.equal(lay.L, 75 + 42, 'the rows, then FERRUM-MMS beside them');
  assert.equal(lay.W, 75, 'five rows of 15 mm — not 65 + 4 × 15 as when FERRUM-MMS sat in row 1');
  const inRow1 = [{ items: [thin('a'), at('fer', 42, 65, 110, 'end', true)] }, ...['b', 'c', 'd', 'e'].map(p => ({ items: [thin(p)] }))];
  assert.equal(P.deriveLay(inRow1).W, 65 + 4 * 15, 'what happened before: row 1 as deep as FERRUM-MMS');
});

test('rows are kept in order: none empty, blocks numbered from the left, each block together', () => {
  const lanes = [{ items: [thin('a')], col: 5 }, { items: [] }, { items: [thin('b')] }, { items: [thin('c')], col: 5 }, { items: [thin('d')], col: -1 }];
  const n = J(P.normLanes(lanes));
  assert.deepEqual(n.map(l => [l.col || 0, l.items[0].pid]), [[0, 'd'], [1, 'b'], [2, 'a'], [2, 'c']]);
  assert.equal(J(P.normLanes(fivePlusOne())).filter(l => l.col).length, 1);
});

test('the top view draws the block beside the rows at their right, from the back', () => {
  const lay = P.deriveLay(fivePlusOne()), G = P.layGeom(lay, { L: 121, W: 78, H: 120 });
  const rows = G.rows.filter(r => !r.col), side = G.rows.find(r => r.col === 1);
  assert.equal(G.blocks.length, 2);
  assert.deepEqual(J(rows.map(r => r.y - G.oy)), [0, 15, 30, 45, 60], 'the rows one behind the other');
  assert.equal(side.cells[0].x, rows[0].x0 + 75, 'right after the longest row');
  assert.equal(side.cells[0].y, G.oy, 'starting at the back');
  assert.equal(P.mainCol(lay.lanes), 0); assert.equal(P.laneSide(lay.lanes, 5), 'right'); assert.equal(P.laneSide(lay.lanes, 0), '');
});

test('dropping past the end of the rows stands a carton beside them; in a block, rows stay in that block', () => {
  const lay = P.deriveLay(fivePlusOne()), G = P.layGeom(lay, { L: 160, W: 90, H: 120 });
  const rowsEnd = G.blocks[1].x1, opt = { onto: true, skip: () => false, edge: d => Math.min(d * 0.25, 4) };
  assert.equal(P.spotAt(G, { x: rowsEnd + 5, y: G.oy + 30 }, opt).type, 'side');
  assert.equal(P.spotAt(G, { x: rowsEnd + 5, y: G.oy + 30 }, opt).col, 2, 'a new block on the right');
  assert.equal(P.spotAt(G, { x: G.blocks[0].x0 - 5, y: G.oy + 30 }, opt).col, -1, 'or on the left');
  const below = P.spotAt(G, { x: G.blocks[1].x0 + 10, y: G.oy + 70 }, opt);
  assert.deepEqual([below.type, below.col, below.at], ['new', 1, 6], 'under FERRUM-MMS: a new row in its block');
  const onto = P.spotAt(G, { x: G.blocks[0].x0 + 37, y: G.oy + 22 }, opt);
  assert.deepEqual([onto.type, onto.r, onto.i], ['onto', 1, 0], 'the middle of a carton: onto it');
  const between = P.spotAt(G, { x: G.blocks[0].x0 + 37, y: G.oy + 15.5 }, opt);
  assert.deepEqual([between.type, between.at, between.col], ['new', 1, 0], 'between rows 1 and 2: a new row there');
  // the carton beside the rows, dragged to the same place: nowhere to go
  assert.equal(P.sameSpot(G, P.spotAt(G, { x: rowsEnd + 5, y: G.oy }, opt), 5, 0, false), true);
  // a drop beside the rows, made: the rows stay together
  const lanes = fivePlusOne().slice(0, 5); lanes[0].items.push(at('fer', 42, 65, 110, 'end', true));
  const fer = lanes[0].items[1]; lanes[0].items.splice(1, 1);
  P.placeAt(lanes, fer, { type: 'side', col: 1, at: 5 });
  assert.equal(P.deriveLay(P.normLanes(lanes)).W, 75);
});

test('the move buttons: ◀ ▶ at the end of a row stand the carton beside the rows; ▲ ▼ stay among its block’s rows', () => {
  const lanes = [{ items: [thin('a'), thin('x')] }, { items: [thin('b')] }, { items: [thin('c')] }, { items: [at('s', 15, 65, 92)], col: 1 }];
  assert.deepEqual(J(P.moveTarget(lanes, 0, 1, 'right', false)), { type: 'new', col: 1, at: 4 }, 'into the block on the right, at its front');
  assert.deepEqual(J(P.moveTarget(lanes, 0, 0, 'right', false)), { type: 'row', r: 0, idx: 1 }, 'in the middle of a row: swap');
  assert.deepEqual(J(P.moveTarget(lanes, 0, 0, 'left', false)), { type: 'side', where: 'left', col: -1, at: 0 }, 'first in its row: beside the rows, on the left');
  assert.deepEqual(J(P.moveTarget(lanes, 3, 0, 'sideR', false)), { type: 'side', where: 'right', col: 2, at: 4 });
  assert.deepEqual(J(P.moveTarget(lanes, 3, 0, 'left', false)), { type: 'new', col: 0, at: 3 }, 'back among the rows, at the front');
  assert.deepEqual(J(P.moveTarget(lanes, 2, 0, 'front', false)), { type: 'new', col: 0, at: 3 }, 'the front row of the block: a new row there, not into the block beside');
  assert.deepEqual(J(P.moveTarget(lanes, 1, 0, 'back', false)), { type: 'row', r: 0, idx: 2 });
  assert.deepEqual(J(P.moveTarget(lanes, 0, 0, 'right', true)), { type: 'row', r: 0, idx: 1 }, 'one carton of a stack steps off it, beside it');
});

test('Put in: a carton deeper than the rows goes beside them rather than deepening one', () => {
  const lanes = ['a', 'b', 'c', 'd', 'e'].map(p => ({ items: [thin(p)] }));
  const sp = P.bestSpot(lanes, { pid: 'fer', name: 'fer', t: 42, m: 65, b: 110, orient: 'end', rot: true }, { L: 125, W: 80, H: 125 });
  assert.equal(sp.t.type, 'side'); assert.equal(sp.W, 75);
});

test('the engine: where the cartons don’t stand in a box the usual way, one of them can stand beside the rows', () => {
  const units = [...['a', 'b', 'c', 'd', 'e'].map(p => ({ pid: p, name: p, t: 15, m: 75, b: 102 })), { pid: 's', name: 'SOLSHINE', t: 15, m: 65, b: 92 }];
  const r = K.fitBox(units, { L: 138, W: 78, H: 108 }, ST);
  assert.equal(r.house, false); assert.equal(r.side, 1); assert.equal(r.status, 'fits');
  const beside = r.lanes.filter(l => l.col);
  assert.equal(beside.length, 1); assert.equal(beside[0].items[0].l, 15, 'turned: 15 mm along the box, its long side front to back');
  assert.equal(r.lanes.filter(l => !l.col).length, 5, 'the other five in rows');
  assert.deepEqual(J(K.extentOf(r.lanes)), { L: 117, W: 75, blocks: 2 });
  assert.equal(K.wayLabel(r), 'On the long edge in rows, 1 beside them');
  assert.match(K.sigOf(r.lanes), /\|1>[a-z]+:endr$/, 'the arrangement’s signature marks the block');
  // where they stand the usual way, nothing changes
  assert.equal(K.fitBox(units, { L: 138, W: 96, H: 108 }, ST).house, true);
});

test('a saved arrangement in words: stacks and cartons beside the rows are named', () => {
  const one = (name, placement) => ({ name, placement, along: 75, depth: 15, upright: 102 });
  const txt = P.layoutText({ rows: [[{ ...one('A', 'standing up'), stack: [one('B', 'lying flat')] }], [one('C', 'standing up')], [one('S', 'standing up, turned 90°')]], cols: [0, 0, 1] });
  assert.match(txt, /^Row 1: A \(standing up.*\) with B \(lying flat.*\) on top \| Row 2: C .* \| Beside the rows \(right\): S /);
});

test('the studio: blocks are kept, moved and drawn; the typed size gets its own card', () => {
  assert.match(html, /if\(lay\.lanes\.some\(l=>l\.col\)\) out\.cols=lay\.lanes\.map\(l=>l\.col\|\|0\);/, 'saved with the kit and its drafts');
  assert.match(html, /const c=Array\.isArray\(stored\.cols\)\?\+stored\.cols\[ri\]\|\|0:0;/, 'and read back');
  assert.match(html, /function setLayEdit\(ctx,v\)\{ if\(v&&v\.lanes\) v\.lanes=normLanes\(v\.lanes\);/, 'every change keeps the rows in order');
  for (const a of ["b('sideL','◀ Left side'", "b('sideR','Right side ▶'", "data-use-typed=", "act:{label:"]) assert.ok(html.includes(a), a);
  assert.match(html, /\$\{T\?yourSize\(r,T,opts\):w\?/, 'a typed size: the Your size card');
  assert.match(html, /recCard\(r,\{pick:true,sel:b\.opt,ctx:'b',cur,picked:!!\(typed\|\|b\.choice\),typed,step:2,id:'cardBox'\}\)/);
  assert.match(html, /if\(ds\.useTyped\)\{ const \[L,W,H\]=ds\.useTyped\.split\(','\)\.map\(Number\); typeBox\(\{L,W,H\}\); return; \}/);
  assert.match(html, /return spotAt\(G,p,\{onto:!d\.multi,/, 'the top view and the 3D view drop by the same rules');
});
