// A saved draft (pending lines with figures stored — LINE_VIEW's plan_draft)
// is a cut plan too. reDeriveMemberSheets skipped it, so a sheet change on a
// draft run left the server's figures (Board Position, Short, Raise PR) on the
// old parent while the screen counted the new one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const GANGS = readFileSync(new URL('./routes/gangs.js', import.meta.url), 'utf8');
const start = GANGS.indexOf('async function reDeriveMemberSheets');
const fn = GANGS.slice(start, GANGS.indexOf('\n}\n', start));

test('a saved draft is re-derived like a planned line', () => {
  assert.match(fn, /const isDraft = l => l\.status === 'pending' && l\.parent_sheets_required != null;/);
  // Round 4 split the single-line guard into hasPlan (this line's own plan)
  // plus a co-printed exception (a sibling's plan can still carry the call) —
  // see the "trailing never-saved member" test below for why. The plain,
  // non-co-printed refusal is what is left of the original one-line guard.
  assert.match(fn, /const hasPlan = l => editable\.includes\(l\.status\) \|\| isDraft\(l\);/);
  assert.match(fn, /if \(!hasPlan\(line\)\) \{\s*\n\s*if \(!coPrinted\) return \{ mixCleared: 0, leftoverUnbanked: false \};/);
});

test('a co-printed run re-splits its drafts too', () => {
  assert.match(fn, /if \(!\['planned', 'ready'\]\.includes\(lines\[i\]\.status\) && !isDraft\(lines\[i\]\)\) continue;/);
});

// ── Round 2 → Round 3 ────────────────────────────────────────────────────
// Round 2 fixed two bugs the quality review found:
//
// (1) The regression: reDeriveMemberSheets clears the member's board mix and
// sweeps its bank on EVERY call from its three callers, even when nothing it
// derives from changed — a coating-only Lock sheet, a board re-pick of the
// board the run already has, a die-number PATCH that happens to carry an
// unrelated qty. That cost a PLANNED line's mix before; now that a draft is
// also eligible (round 1), it costs a saved DRAFT's mix too — the very thing
// a draft Save deliberately protects.
//
// (2) Pre-existing: the co-printed (shared-layout) branch never reached the
// bottom-of-function sweep — it returns from inside its own block. A
// co-printed run's banked strip outlived every sheet it was ever measured on.
// Round 1 made drafts reach this branch too, so it was fixed here — and it
// stays exactly where round 2 put it (the top of the branch); round 3 did not
// move it.
//
// Round 2 fixed (1) by gating each caller on cutPlanInputs(): a key over the
// EFFECTIVE (override-over-master) cut fields. That is wrong for a CO-PRINTED
// run — its child is read from the OVERRIDE alone (sharedLayoutState, this
// file, ~179: a master's child size describes some OTHER product's own sheet,
// never this layout's) — so a layout still pending, where the master's own
// size shows through as "effective", read as unchanged the moment a patch
// happened to match that master value, and the re-derive that settles the
// layout never ran. Round 3 replaced the gate with requestChangesCut
// (helpers.js): a request-level pre-check, computed once before any write,
// that compares the PATCH against what reDeriveMemberSheets actually reads
// for that gang kind — the override alone for a co-printed child, the
// effective value everywhere else. See request-changes-cut.test.js for the
// function itself; what is pinned below is each caller's wiring to it.
//
// All of this is proven by DRIVING the real function, not by reading its
// text — a text pin can't tell a caller "changed nothing" from "changed
// everything".
import { reDeriveMemberSheets } from './routes/gangs.js';

// A stub harness in the style of pushCard in co-printed-card-cuts.test.js:
// every statement reDeriveMemberSheets issues is answered from the fixture,
// and any statement the stubs don't recognise is recorded in `unknown` —
// which every test asserts stays empty — rather than quietly handed back
// null. No database, no server.
function harness({ gang, lines, products, board, mixRows = {}, runBatches = [], lineBatches = {} }) {
  const log = { writes: [], released: [], mixDeleted: [], audits: [], runUnbankSelect: 0, lineUnbankSelect: 0,
    movements: [], leftoverNulled: [], unknown: [] };
  const byId = (arr, id) => arr.find(x => +x.id === +id) || null;
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const oc = async (sql, p = []) => {
    const s = norm(sql);
    if (/^SELECT \* FROM order_lines WHERE id=\$1/.test(s)) return { ...byId(lines, p[0]) };
    if (/^SELECT \* FROM gang_runs WHERE id=\$1/.test(s)) return gang;
    if (/^SELECT kind, layout_mode FROM gang_runs WHERE id=\$1/.test(s)) return { kind: gang.kind, layout_mode: gang.layout_mode };
    if (/^SELECT \* FROM products WHERE id=\$1/.test(s)) return byId(products, p[0]);
    if (/^SELECT \* FROM materials WHERE id=\$1/.test(s)) return +p[0] === board.id ? board : null;
    if (/^SELECT MIN\(id\) AS id FROM order_lines WHERE gang_run_id=\$1/.test(s)) return { id: Math.min(...lines.map(l => l.id)) };
    log.unknown.push('oc: ' + s.slice(0, 100));
    return null;
  };
  const qc = async (sql, p = []) => {
    const s = norm(sql);
    if (/^SELECT \* FROM order_lines WHERE gang_run_id=\$1 ORDER BY id/.test(s)) return lines.map(l => ({ ...l }));
    if (/^UPDATE order_lines SET sheets_required=\$1, parent_sheets_required=\$2 WHERE id=\$3/.test(s)) {
      log.writes.push({ id: p[2], sheets: p[0], parent: p[1] }); return [];
    }
    // orderLineBoardConsumed, inside clearMixPlan — [] means "not consumed",
    // so clearMixPlan clears both the plan and issued phases.
    if (/FROM job_cards jc JOIN stock_movements/.test(s)) return [];
    if (/^SELECT COUNT\(\*\)::int AS n FROM job_board_mix/.test(s)) return [{ n: mixRows[p[0]] || 0 }];
    if (/^UPDATE board_allocations SET status='released'/.test(s)) { log.released.push(p[0]); return []; }
    if (/^DELETE FROM job_board_mix/.test(s)) { log.mixDeleted.push(p[0]); return []; }
    if (/^INSERT INTO audit_log/.test(s)) { log.audits.push(`${p[0]}#${p[1]} ${p[2]}: ${p[3]}`); return []; }
    if (/^SELECT \* FROM stock_batches WHERE batch_no LIKE \$1 ORDER BY id/.test(s)) { log.runUnbankSelect++; return runBatches.map(b => ({ ...b })); }
    if (/^SELECT \* FROM stock_batches WHERE batch_no=\$1 OR batch_no LIKE \$2/.test(s)) { log.lineUnbankSelect++; return (lineBatches[p[0]] || []).map(b => ({ ...b })); }
    if (/^INSERT INTO stock_movements/.test(s)) { log.movements.push(p); return []; }
    if (/^UPDATE stock_batches SET qty=0/.test(s)) return [];
    if (/^UPDATE order_lines SET leftover_plan=NULL WHERE id=\$1/.test(s)) { log.leftoverNulled.push(p[0]); return []; }
    log.unknown.push('qc: ' + s.slice(0, 100));
    return [];
  };
  return { oc, qc, log };
}

const BOARD = { id: 544, name: 'SW 23x38', sheet_l: 23, sheet_w: 38 };
// SW-544 shape: a 22x28 parent on file, on a 23x38 board — CI-MRG-0028's own.
const prod = (id, extra = {}) => ({ id, name: `P${id}`, code: `SW-${id}`, ups: 4, child_l: 10, child_w: 13,
  parent_l: 22, parent_w: 28, board_material_id: BOARD.id, wastage_pct: 5, ...extra });
const gline = (id, product_id, gang_run_id, extra = {}) => ({ id, product_id, gang_run_id, qty: 40000,
  fg_consumed_qty: 0, dispatched_qty: 0, wastage_sheets: 200, status: 'pending',
  sheets_required: 10200, parent_sheets_required: 3550, spec_override: null, ...extra });

test('a. a merge-run draft: figures re-derived, its mix cleared, its run bank swept, return = rows cleared', async () => {
  const MRG = { id: 28, gang_number: 'CI-MRG-0028', kind: 'merge', layout_mode: 'separate' };
  const h = harness({
    gang: MRG, board: BOARD, products: [prod(544)],
    lines: [gline(101, 544, 28), gline(102, 544, 28, { wastage_sheets: 0 })],
    mixRows: { 101: 2 },
    runBatches: [{ id: 9, batch_no: 'LO-PLAN-RUN-28-544', material_id: 7001, qty: 3550, initial_qty: 3550 }],
  });
  const result = await reDeriveMemberSheets(101, h.qc, h.oc, 'test', 'sheet changed');
  assert.deepEqual(h.log.unknown, []);
  assert.deepEqual(h.log.writes, [{ id: 101, sheets: 10200, parent: 2550 }]);
  assert.deepEqual(h.log.released, [101]);
  assert.deepEqual(h.log.mixDeleted, [101]);
  assert.equal(h.log.movements.length, 1, 'the run bank is swept — one reversing movement');
  assert.ok(h.log.movements[0][2] < 0, 'the movement reverses the bank (negative qty)');
  assert.deepEqual(result, { mixCleared: 2, leftoverUnbanked: true },
    'returns the mix rows it cleared and whether the run bank actually moved');
});

test('b. a never-saved pending line is a complete no-op, returning 0', async () => {
  const MRG = { id: 28, gang_number: 'CI-MRG-0028', kind: 'merge', layout_mode: 'separate' };
  const h = harness({
    gang: MRG, board: BOARD, products: [prod(544)],
    lines: [gline(101, 544, 28, { sheets_required: null, parent_sheets_required: null })],
  });
  const result = await reDeriveMemberSheets(101, h.qc, h.oc, 'test', 'sheet changed');
  assert.deepEqual(h.log.unknown, []);
  assert.deepEqual(h.log.writes, []);
  assert.deepEqual(h.log.mixDeleted, []);
  assert.equal(h.log.movements.length, 0);
  assert.deepEqual(h.log.audits, []);
  assert.deepEqual(result, { mixCleared: 0, leftoverUnbanked: false });
});

const CO = { id: 19, gang_number: 'CI-GANG-0019', kind: 'gang', layout_mode: 'shared' };
const coOv = JSON.stringify({ child_l: 19, child_w: 21 });
// [draft(328), planned(394), pending-never-saved(395)], one stamped child,
// and a banked RUN strip — shared by both tests below, which check the two
// different things this one call must get right.
const coFixture = () => ({
  gang: CO, board: BOARD, products: [prod(157, { ups: 4 }), prod(216, { ups: 2 }), prod(300, { ups: 2 })],
  lines: [
    gline(328, 157, 19, { spec_override: coOv, sheets_required: 1300, parent_sheets_required: 650 }),
    gline(394, 216, 19, { spec_override: coOv, status: 'planned', wastage_sheets: 0, sheets_required: 650, parent_sheets_required: 325 }),
    gline(395, 300, 19, { spec_override: coOv, wastage_sheets: 0, sheets_required: null, parent_sheets_required: null }),
  ],
  mixRows: { 328: 1, 394: 1 },
  runBatches: [{ id: 11, batch_no: 'LO-PLAN-RUN-19-544', material_id: 7002, qty: 1300, initial_qty: 1300 }],
});

test('c. a co-printed run re-splits and re-derives only its draft and planned members', async () => {
  const h = harness(coFixture());
  const result = await reDeriveMemberSheets(328, h.qc, h.oc, 'test', 'sheet changed');
  assert.deepEqual(h.log.unknown, []);
  assert.deepEqual(h.log.writes, [
    { id: 328, sheets: 10100, parent: 5050 },
    { id: 394, sheets: 5050, parent: 2525 },
  ], 'the never-saved member (395) gets no write');
  assert.deepEqual(h.log.mixDeleted, [328, 394]);
  assert.deepEqual(result, { mixCleared: 2, leftoverUnbanked: true },
    'sum of both members’ cleared mix rows, plus the run bank it swept');
});

// ── Round 4 — the fix relies on this exact scenario ─────────────────────────
// Round 3's in-loop call relies on the highest-id member's turn through the
// loop to be the one that finally sees the whole run settled and does the
// real (single) re-split — see /board's and /shared's own comments. But the
// per-line guard at the top of reDeriveMemberSheets bails on THAT call before
// it ever reaches the co-printed branch, whenever the highest-id member
// itself has no cut plan of its own (a job added to the run after it was
// last saved: pending, never saved, no figures) — exactly coFixture's 395.
// The saved members (328, 394) then silently keep their stale figures on
// every Lock sheet and every board change. This test calls on 395 directly,
// the same as the last iteration of /board's and /shared's write loop would.
test('a co-printed run still re-splits its saved members when the call lands on the trailing never-saved one', async () => {
  const h = harness(coFixture());
  const result = await reDeriveMemberSheets(395, h.qc, h.oc, 'test', 'sheet changed');
  assert.deepEqual(h.log.unknown, []);
  assert.deepEqual(h.log.writes, [
    { id: 328, sheets: 10100, parent: 5050 },
    { id: 394, sheets: 5050, parent: 2525 },
  ], 'both SAVED members are re-split even though the call landed on the never-saved one');
  assert.deepEqual(h.log.mixDeleted, [328, 394]);
  assert.deepEqual(result, { mixCleared: 2, leftoverUnbanked: true });
});

test('e. a co-printed run with a banked run strip sweeps it — settled or still pending', async () => {
  // Settled layout: the sweep runs as part of a real re-split.
  const h1 = harness(coFixture());
  const r1 = await reDeriveMemberSheets(328, h1.qc, h1.oc, 'test', 'sheet changed');
  assert.deepEqual(h1.log.unknown, []);
  assert.ok(h1.log.runUnbankSelect > 0,
    'the run-bank sweep must be reached from inside the co-printed branch');
  assert.equal(h1.log.movements.length, 1, 'the banked strip is reversed');
  assert.deepEqual(r1, { mixCleared: 2, leftoverUnbanked: true });

  // Pending layout: the sweep is the ONLY thing that happens before the
  // function returns — sharedLayoutState sees no override on line 328 and
  // refuses. A mutant that moved the sweep below `if (layout.pending) return
  // ...;` would still pass the settled case above (the sweep still runs, later,
  // as part of the real split) but would miss this one entirely, where
  // nothing else in the branch ever executes.
  const pending = coFixture();
  pending.lines[0].spec_override = null;   // no override — nothing for the layout to agree on
  const h2 = harness(pending);
  const r2 = await reDeriveMemberSheets(328, h2.qc, h2.oc, 'test', 'sheet changed');
  assert.deepEqual(h2.log.unknown, []);
  assert.ok(h2.log.runUnbankSelect > 0, 'swept even though the layout is still pending');
  assert.equal(h2.log.movements.length, 1);
  assert.deepEqual(h2.log.writes, [], 'nothing downstream of the pending check ran');
  assert.deepEqual(r2, { mixCleared: 0, leftoverUnbanked: true },
    'layout.pending: no split, but leftoverUnbanked survives from the sweep that already ran');
});

test('d. a separate-layout gang draft sweeps its own line bank and nulls leftover_plan', async () => {
  const SEP = { id: 40, gang_number: 'CI-GANG-0040', kind: 'gang', layout_mode: 'separate' };
  const h = harness({
    gang: SEP, board: BOARD, products: [prod(544)],
    lines: [gline(501, 544, 40), gline(502, 544, 40, { wastage_sheets: 0 })],
    mixRows: { 501: 1 },
    lineBatches: { 'LO-PLAN-501': [{ id: 21, batch_no: 'LO-PLAN-501-544', material_id: 7003, qty: 900, initial_qty: 900 }] },
  });
  const result = await reDeriveMemberSheets(501, h.qc, h.oc, 'test', 'sheet changed');
  assert.deepEqual(h.log.unknown, []);
  assert.ok(h.log.lineUnbankSelect > 0);
  assert.deepEqual(h.log.leftoverNulled, [501]);
  assert.equal(h.log.movements.length, 1);
  assert.deepEqual(result, { mixCleared: 1, leftoverUnbanked: true });
});

// ── The three callers compute requestChangesCut before writing, and gate ───
// reDeriveMemberSheets can't tell a no-op save from a real one by itself (it
// only ever sees the AFTER state) — the pre-check has to live in the callers,
// BEFORE they write, which is why it's a pure function tested directly above
// (request-changes-cut.test.js) rather than driven through these routes: what
// needs proving here is wiring — that each route reads pre-write state and
// actually gates the call on what it found — not the decision itself.
// A route slice runs from its own anchor to the NEXT route's — never a fixed
// length. Round 3 sized these to measured lengths plus slack (board 3612,
// shared 9580, PATCH lines 5644 chars), and round 4 outgrew all three just by
// destructuring reDeriveMemberSheets' new { mixCleared, leftoverUnbanked }
// return — see the fixed-window note in run-leftover-wiring.test.js for why
// that keeps happening to a hand-picked number. A route never contains its
// own next `\nr.`, so this is exact, not a guess with slack to run out of.
const sliceRoute = (src, anchor) => {
  const i = src.indexOf(anchor);
  assert.notEqual(i, -1, `anchor not found: ${anchor}`);
  const next = src.indexOf('\nr.', i + 1);
  assert.notEqual(next, -1, `no following route found after ${anchor}`);
  return src.slice(i, next);
};

const ROUTE_ANCHORS = [
  "r.post('/gang-runs/:id/board'",
  "r.post('/gang-runs/:id/shared'",
  "r.patch('/gang-runs/:id/lines/:lineId'",
];

test('the board pick, the sheet lock and a member edit compute requestChangesCut before their first write', () => {
  for (const [anchor, firstWrite] of [
    [ROUTE_ANCHORS[0], 'for (const line of lines)'],
    [ROUTE_ANCHORS[1], 'for (const line of lines)'],
    [ROUTE_ANCHORS[2], 'UPDATE order_lines SET qty='],
  ]) {
    const route = sliceRoute(GANGS, anchor);
    const checkAt = route.indexOf('requestChangesCut(');
    const writeAt = route.indexOf(firstWrite);
    assert.notEqual(checkAt, -1, `${anchor} must call requestChangesCut`);
    assert.notEqual(writeAt, -1, `${anchor}: could not find its first-write anchor ${JSON.stringify(firstWrite)}`);
    assert.ok(checkAt < writeAt,
      `${anchor} must compute requestChangesCut before ${JSON.stringify(firstWrite)} (at ${checkAt} vs ${writeAt})`);
  }
});

// PATCH's ups is a separate, legacy top-level field (the UI's saveGangMember
// sends it outside `spec`) folded into `spec.ups` before GANG_SPEC/provided
// are built — the same values requestChangesCut's patch is drawn from. Move
// that fold-in below the gate and an ups-only edit stops computing a patch
// for it at all: requestChangesCut would see an empty patch and never notice
// the ups changed, so it would silently stop re-deriving.
test("PATCH folds the legacy top-level ups into spec BEFORE requestChangesCut reads it", () => {
  const route = sliceRoute(GANGS, ROUTE_ANCHORS[2]);
  const foldAt = route.indexOf("if (req.body.ups !== undefined) spec.ups = req.body.ups;");
  const checkAt = route.indexOf('requestChangesCut(');
  assert.notEqual(foldAt, -1, 'the legacy top-level ups fold-in must still be there');
  assert.notEqual(checkAt, -1, 'PATCH must call requestChangesCut');
  assert.ok(foldAt < checkAt,
    `the ups fold-in must come before requestChangesCut (at ${foldAt} vs ${checkAt})`);
});

test("the re-derive call in all three routes is guarded by requestChangesCut's result", () => {
  // /shared (lockSharedSheet) also re-derives a job whose cut a CLEARED master
  // parent moved — Task 10, round 2; lock-shared-sheet.test.js (g) drives it.
  // Still only inside the guard, exactly as written here, never unconditionally.
  const GUARD = {
    [ROUTE_ANCHORS[0]]: /if \(reDerive\)[\s\S]{0,220}?reDeriveMemberSheets\(/,
    [ROUTE_ANCHORS[1]]: /if \(reDerive \|\| parentMoved\)[\s\S]{0,220}?reDeriveMemberSheets\(/,
    [ROUTE_ANCHORS[2]]: /if \(reDerive\)[\s\S]{0,220}?reDeriveMemberSheets\(/,
  };
  for (const anchor of ROUTE_ANCHORS) {
    const route = sliceRoute(GANGS, anchor);
    assert.match(route, GUARD[anchor], `${anchor} must call reDeriveMemberSheets only inside its guard`);
  }
  assert.match(sliceRoute(GANGS, ROUTE_ANCHORS[1]),
    /const parentMoved = !coPrinted && masterParentCleared\.has\(line\.product_id\)\s*&& !\('parent_l' in next && 'parent_w' in next\);/,
    'parentMoved: a cleared master parent, on a job with no parent of its own, never on a co-printed run');
});

test("the same three routes fold reDeriveMemberSheets' { mixCleared, leftoverUnbanked } into a boolean mix_cleared and leftover_unbanked response", () => {
  for (const anchor of ROUTE_ANCHORS) {
    const route = sliceRoute(GANGS, anchor);
    assert.match(route, /result\??\.mixCleared/, `${anchor} must read mixCleared off reDeriveMemberSheets' result`);
    assert.match(route, /result\??\.leftoverUnbanked/, `${anchor} must read leftoverUnbanked off the same result`);
    assert.match(route, /mix_cleared:\s*mixCleared\s*>\s*0/,
      `${anchor} must reduce the count to a boolean before returning it`);
    assert.match(route, /leftover_unbanked:\s*leftoverUnbanked/,
      `${anchor} must carry leftoverUnbanked into its own returned field`);
    assert.match(route, /mix_cleared:\s*out\?\.mix_cleared\s*\?\?\s*false/,
      `${anchor} must respond with mix_cleared, defensively defaulting a tx that returned nothing to false`);
    assert.match(route, /leftover_unbanked:\s*out\?\.leftover_unbanked\s*\?\?\s*false/,
      `${anchor} must respond with leftover_unbanked the same way — /shared's early return answers false for both`);
  }
});
