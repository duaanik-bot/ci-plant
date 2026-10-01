// Kit Studio (client/public/kit-studio-app/index.html): stacked cartons and
// packing a box from scratch.
//   • The cartons of a stack are separate — each is picked, turned, moved and
//     taken out on its own — unless the stack is grouped: then they act as one.
//   • Re-pack fresh forgets the hand arrangement; Empty the box takes every
//     carton out into "Cartons to place", to be put in by hand (or Auto-pack
//     the rest). A kit with cartons still outside the box is not saved, pushed
//     or reported.
// The helpers are run straight from the page; the rest is checked as wiring.
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

// the page's own helpers, in a sandbox with the packing engine and a selection
const sb = { S: { sel: null, settings: { cL: 4, cW: 3, cH: 10, dLmin: 2, dWmin: 3, dHmin: 6 } }, shown: null };
vm.createContext(sb);
vm.runInContext(read('client/public/kit-studio-app/kit-pack.js'), sb);
const P = vm.runInContext(`const {hasStack,colItems,FL,FD,FH,orientDims,dep}=KitPack; const shownCol=()=>shown;
${between('function deriveLay(', 'const cloneLanes')}
${between('const isLoose =', 'function findCarton(')}
${between('function bestSpot(', 'function trayPut(')}
({isLoose,selLevel,detachLevel,placeAt,bestSpot})`, sb);
const J = v => JSON.parse(JSON.stringify(v));
const c = (pid, t = 15, m = 75, b = 102, orient = 'flat') => sb.KitPack.orientDims({ pid, name: pid, t, m, b, orient });
const stackOf = (...pids) => { const [base, ...up] = pids.map(p => c(p)); base.stack = up; return base; };
const ids = col => J(sb.KitPack.colItems(col).map(x => x.pid));   // plain data: the engine runs in its own realm

test('a stack is separate cartons unless it is grouped', () => {
  const col = stackOf('a', 'b', 'c');
  assert.equal(P.isLoose(col), true, 'separate: the default');
  col.group = true;
  assert.equal(P.isLoose(col), false, 'grouped: one');
  assert.equal(P.isLoose(c('d')), false, 'one carton is not a stack');
});

test('clicking a separate stack picks its top carton; a grouped stack is picked whole', () => {
  const col = stackOf('a', 'b', 'c');
  sb.shown = col;
  sb.S.sel = { ctx: 'b', r: 0, i: 0 };
  assert.equal(P.selLevel('b', 0, 0), 2, 'the top one (what you see from above)');
  sb.S.sel.lv = 0;
  assert.equal(P.selLevel('b', 0, 0), 0, 'the one chosen under Change');
  sb.S.sel.lv = 7;
  assert.equal(P.selLevel('b', 0, 0), 2, 'a carton no longer there: the top one again');
  sb.S.sel = { ctx: 'b', r: 0, i: 0, list: [[0, 0], [1, 0]] };
  assert.equal(P.selLevel('b', 0, 0), null, 'several spots selected: each whole');
  sb.S.sel = { ctx: 'b', r: 0, i: 0 };
  col.group = true;
  assert.equal(P.selLevel('b', 0, 0), null, 'grouped: the whole stack');
  assert.equal(P.selLevel('d', 0, 0), null, 'a selection in the other view');
});

test('one carton comes off its stack and the rest stays where it is', () => {
  const lanes = [{ items: [stackOf('a', 'b', 'c')] }];
  const top = P.detachLevel(lanes, 0, 0, 2);
  assert.equal(top.pid, 'c'); assert.equal(top.stack, undefined);
  assert.deepEqual(ids(lanes[0].items[0]), ['a', 'b']);
  // the bottom one: the next one up becomes the bottom, and a grouped stack stays grouped
  const g = stackOf('a', 'b', 'c'); g.group = true;
  const L2 = [{ items: [g] }];
  const bottom = P.detachLevel(L2, 0, 0, 0);
  assert.equal(bottom.pid, 'a'); assert.equal(bottom.group, undefined);
  assert.deepEqual(ids(L2[0].items[0]), ['b', 'c']); assert.equal(L2[0].items[0].group, true);
  // the last two: no stack left, no group
  const L3 = [{ items: [Object.assign(stackOf('a', 'b'), { group: true })] }];
  P.detachLevel(L3, 0, 0, 1);
  assert.deepEqual(J(L3[0].items[0]).stack, undefined); assert.equal(L3[0].items[0].group, undefined);
  assert.equal(P.detachLevel([{ items: [c('x')] }], 0, 0, 0), null, 'a single carton is not taken off anything');
});

test('a carton goes where it is dropped: on a carton, into a row, or into a new row', () => {
  const lanes = [{ items: [c('a'), c('b')] }];
  assert.equal(P.placeAt(lanes, c('x'), { type: 'onto', r: 0, i: 1 }), true);
  assert.deepEqual(ids(lanes[0].items[1]), ['b', 'x']);
  P.placeAt(lanes, c('y'), { type: 'row', r: 0, idx: 0 });
  assert.deepEqual(lanes[0].items.map(x => x.pid), ['y', 'a', 'b']);
  P.placeAt(lanes, c('z'), { type: 'new', at: 0 });
  assert.deepEqual(J(lanes.map(l => l.items.map(x => x.pid))), [['z'], ['y', 'a', 'b']]);
  const empty = [];
  P.placeAt(empty, c('w'), { type: 'new', at: 0 });
  assert.deepEqual(J(empty.map(l => l.items.map(x => x.pid))), [['w']], 'the first carton into an empty box');
});

test('Put in: the best free spot — standing as the carton is, in the row it widens least', () => {
  const box = { L: 138, W: 72, H: 108 };   // inside: 136 long, 102 high
  const tab = (pid, orient = 'edge') => sb.KitPack.orientDims({ pid, name: pid, t: 15, m: 102, b: 136, orient });
  const first = P.bestSpot([], tab('a'), box);
  assert.deepEqual(J(first), { W: 15, t: { type: 'new', at: 0 }, o: 'edge', rot: false });
  const second = P.bestSpot([{ items: [tab('a')] }], tab('b'), box);
  assert.deepEqual(J(second.t), { type: 'new', at: 1 }, 'a row of 136 has no room left: a new row');
  assert.equal(second.W, 30);
  // a short carton fits beside a short one in the same row
  const gold = (pid) => sb.KitPack.orientDims({ pid, name: pid, t: 12, m: 52, b: 60, orient: 'edge' });
  const beside = P.bestSpot([{ items: [gold('g1')] }], gold('g2'), box);
  assert.deepEqual(J(beside.t), { type: 'row', r: 0, idx: 1 });
  // lying flat would not fit standing up: the first way that does
  const tall = sb.KitPack.orientDims({ pid: 't', name: 't', t: 30, m: 110, b: 130, orient: 'end' });
  const sp = P.bestSpot([], tall, { L: 140, W: 140, H: 60 });
  assert.equal(sp.o, 'flat');
  assert.equal(P.bestSpot([], tall, { L: 60, W: 60, H: 60 }), null, 'no way at all: it stays out');
});

test('the studio: Group / Separate, the cartons to place, Re-pack fresh and Empty the box are wired in', () => {
  // kept with the kit: a grouped stack, and the cartons still outside the box
  assert.match(html, /stack:it\.stack\.map\(storeIt\),\.\.\.\(it\.group\?\{group:true\}:\{\}\)/);
  assert.match(html, /if\(tray&&tray\.length\) out\.tray=tray\.map\(storeIt\);/);
  assert.match(html, /it\.stack=st; if\(x\.group\) it\.group=true;/);
  assert.match(html, /if\(unitKey\(\[\.\.\.allUnits\(lanes\),\.\.\.tray\]\)!==key\) return null;/, 'a layout with every carton — placed or still to place');
  // the controls
  for (const a of ['data-lop="ungroup"', 'data-lop="group"', 'data-repack-fresh="${ctx}"', 'data-empty-box="${ctx}"', 'data-tray-zone="${ctx}"', 'data-tray-put="${ctx}"', 'data-tray-auto="${ctx}"']) {
    assert.ok(html.includes(a), a);
  }
  for (const h of ['ds.repackFresh', 'ds.emptyBox', 'ds.trayPut', 'ds.trayAuto']) assert.ok(html.includes(h), h);
  // nothing leaves with cartons outside the box
  assert.match(html, /if\(ds\.push\)\{ if\(ds\.push==='b'&&trayBlock\('b'\)\) return;/);
  assert.match(html, /if\(ds\.saveKit!==undefined\)\{ const D=S\.drawer, d=D\.d; if\(trayBlock\('d'\)\) return;/);
  assert.match(html, /if\(\(ds\.rep==='b'\|\|ds\.rep==='d'\)&&trayBlock\(ds\.rep\)\) return;/);
  assert.match(between('function openPush(', '\n}'), /layout\.tray&&d\.layout\.tray\.length/);
  // a kit on the list, packed our way again and saved: the arrangement kept by hand goes
  assert.match(html, /else if\(after\.layout&&after\.items\.length&&after\.items\.every\(i=>dimsOf\(i\.pid\)\)\) after\.layout=null;/);
  // the whole kit is cleared from the step bar — not the same as packing from scratch
  assert.match(html, /data-scratch \$\{ro\?'disabled':''\}[^>]*>\$\{ICON\.scratch\}Clear the whole kit<\/button>/);
});
