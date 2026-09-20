// POST /gang-runs/:id/shared's write path, driven for REAL (Task 10, round 2,
// 19 Sep 2026). Both of Task 10's master-safety bugs passed every source pin:
// "Update Product Master(s)" wrote a parent the master's own board could not
// yield, and — once that was fixed — a board-only Lock sheet moved the master's
// board and left its OLD parent behind. So the route's transaction body is
// lockSharedSheet (gangs.js), and this drives it with a stub qc/oc.
//
// The stub is an in-memory run: every statement lockSharedSheet issues (and
// reDeriveMemberSheets, which it calls) is answered from it, and anything it
// does not recognise lands in log.unknown, which every test asserts stays
// empty — the stub never quietly hands back null. Adapted from the final
// review's probe harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockSharedSheet } from './routes/gangs.js';
import { planLockParent } from './helpers.js';

function makeDb({ gang, lines, products, boards, mix = {}, batches = [] }) {
  const db = {
    gang: { ...gang },
    lines: lines.map(l => ({ ...l })),
    products: products.map(p => ({ ...p })),
    boards: boards.map(b => ({ ...b })),
    mix: { ...mix },
    batches: batches.map(b => ({ ...b })),
    log: { sheetWrites: [], mixDeleted: [], audits: [], productUpdates: [], overrideWrites: [], unknown: [] },
  };
  const line = id => db.lines.find(l => +l.id === +id) || null;
  const prod = id => db.products.find(p => +p.id === +id) || null;
  const board = id => db.boards.find(b => +b.id === +id) || null;
  const exec = async (sql, p = []) => {
    const S = sql.replace(/\s+/g, ' ').trim();
    let m;
    if (/^SELECT \* FROM gang_runs WHERE id=\$1( FOR UPDATE)?$/.test(S)) return +p[0] === db.gang.id ? [{ ...db.gang }] : [];
    if (/^SELECT kind, layout_mode FROM gang_runs WHERE id=\$1$/.test(S)) return [{ kind: db.gang.kind, layout_mode: db.gang.layout_mode }];
    if (/^SELECT jc_number, status FROM job_cards WHERE gang_run_id=\$1 LIMIT 1$/.test(S)) return [];
    if (/^SELECT id, jc_number FROM job_cards WHERE gang_run_id=\$1 AND parent_job_card_id IS NULL$/.test(S)) return [];
    if (/^SELECT p\.name AS product_name, ol\.status FROM order_lines ol JOIN products p/.test(S)) {
      const bad = db.lines.find(l => +l.gang_run_id === +p[0] && !['pending', 'planned', 'ready'].includes(l.status));
      return bad ? [{ product_name: 'x', status: bad.status }] : [];
    }
    if (/^SELECT \* FROM order_lines WHERE id=\$1$/.test(S)) { const l = line(p[0]); return l ? [{ ...l }] : []; }
    if (/^SELECT \* FROM order_lines WHERE gang_run_id=\$1 ORDER BY id( FOR UPDATE OF order_lines)?$/.test(S))
      return db.lines.filter(l => +l.gang_run_id === +p[0]).sort((a, b) => a.id - b.id).map(l => ({ ...l }));
    if (/^SELECT MIN\(id\) AS id FROM order_lines WHERE gang_run_id=\$1$/.test(S))
      return [{ id: Math.min(...db.lines.filter(l => +l.gang_run_id === +p[0]).map(l => l.id)) }];
    if (/^SELECT \* FROM products WHERE id=\$1$/.test(S)) { const pr = prod(p[0]); return pr ? [{ ...pr }] : []; }
    if (/^SELECT board_material_id, child_l, child_w, coating, parent_l, parent_w FROM products WHERE id=\$1$/.test(S)) {
      const pr = prod(p[0]);
      return pr ? [{ board_material_id: pr.board_material_id, child_l: pr.child_l, child_w: pr.child_w,
        coating: pr.coating, parent_l: pr.parent_l, parent_w: pr.parent_w }] : [];
    }
    if (/^SELECT \* FROM materials WHERE id=\$1$/.test(S)) { const b = board(p[0]); return b ? [{ ...b }] : []; }
    if (/^SELECT sheet_l, sheet_w FROM materials WHERE id=\$1$/.test(S)) { const b = board(p[0]); return b ? [{ sheet_l: b.sheet_l, sheet_w: b.sheet_w }] : []; }
    if (/^SELECT id FROM materials WHERE id=\$1$/.test(S)) { const b = board(p[0]); return b ? [{ id: b.id }] : []; }
    if (/^SELECT name FROM materials WHERE id=\$1$/.test(S)) { const b = board(p[0]); return b ? [{ name: b.name }] : []; }
    if (/^UPDATE order_lines SET spec_override=\$1 WHERE id=\$2$/.test(S)) {
      line(p[1]).spec_override = p[0]; db.log.overrideWrites.push({ id: p[1], ov: p[0] }); return [];
    }
    if (/^UPDATE order_lines SET sheets_required=\$1, parent_sheets_required=\$2 WHERE id=\$3$/.test(S)) {
      const l = line(p[2]); l.sheets_required = p[0]; l.parent_sheets_required = p[1];
      db.log.sheetWrites.push({ id: p[2], sheets: p[0], parent: p[1] }); return [];
    }
    if ((m = S.match(/^UPDATE products SET (.+) WHERE id=\$(\d+)$/))) {
      const pr = prod(p[+m[2] - 1]);
      const set = {};
      for (const [, col, idx] of m[1].matchAll(/(\w+)=\$(\d+)/g)) { pr[col] = p[+idx - 1]; set[col] = p[+idx - 1]; }
      db.log.productUpdates.push({ id: pr.id, set }); return [];
    }
    if (/FROM job_cards jc JOIN stock_movements/.test(S)) return [];
    if (/^SELECT COUNT\(\*\)::int AS n FROM job_board_mix WHERE order_line_id=\$1/.test(S)) return [{ n: db.mix[p[0]] || 0 }];
    if (/^UPDATE board_allocations SET status='released'/.test(S)) return [];
    if (/^DELETE FROM job_board_mix WHERE order_line_id=\$1/.test(S)) { db.log.mixDeleted.push(p[0]); db.mix[p[0]] = 0; return []; }
    if (/^INSERT INTO audit_log/.test(S)) { db.log.audits.push({ entity: p[0], id: p[1], action: p[2], detail: p[3] }); return []; }
    if (/^SELECT \* FROM stock_batches WHERE batch_no LIKE \$1 ORDER BY id$/.test(S)) {
      const pre = String(p[0]).replace('%', ''); return db.batches.filter(b => b.batch_no.startsWith(pre)).map(b => ({ ...b }));
    }
    if (/^SELECT \* FROM stock_batches WHERE batch_no=\$1 OR batch_no LIKE \$2 ORDER BY id$/.test(S)) {
      const pre = String(p[1]).replace('%', '');
      return db.batches.filter(b => b.batch_no === p[0] || b.batch_no.startsWith(pre)).map(b => ({ ...b }));
    }
    if (/^INSERT INTO stock_movements/.test(S)) return [];
    if (/^UPDATE stock_batches SET qty=0(, initial_qty=0)?, status='exhausted' WHERE id=\$1$/.test(S)) {
      const b = db.batches.find(x => +x.id === +p[0]); b.qty = 0; b.status = 'exhausted'; return [];
    }
    if (/^UPDATE order_lines SET leftover_plan=NULL WHERE id=\$1$/.test(S)) { line(p[0]).leftover_plan = null; return []; }
    // pinParentOnMasterClear's candidates: this product's open lines, the request's own excluded.
    if (/^SELECT ol\.id, ol\.status, ol\.parent_sheets_required, ol\.spec_override, gr\.kind AS run_kind, gr\.layout_mode FROM order_lines ol LEFT JOIN gang_runs gr ON gr\.id = ol\.gang_run_id WHERE ol\.product_id = \$1 AND NOT \(ol\.id = ANY\(\$2::int\[\]\)\) AND ol\.status IN \('pending', 'planned', 'ready', 'in_production'\) ORDER BY ol\.id FOR NO KEY UPDATE OF ol$/.test(S)) {
      return db.lines
        .filter(l => +l.product_id === +p[0] && !p[1].map(Number).includes(+l.id) && ['pending', 'planned', 'ready', 'in_production'].includes(l.status))
        .sort((a, b) => a.id - b.id)
        .map(l => {
          const run = +l.gang_run_id === db.gang.id ? db.gang : null;
          return { id: l.id, status: l.status, parent_sheets_required: l.parent_sheets_required ?? null,
                   spec_override: l.spec_override ?? null, run_kind: run?.kind ?? null, layout_mode: run?.layout_mode ?? null };
        });
    }
    db.log.unknown.push(S.slice(0, 140));
    return [];
  };
  db.qc = async (sql, p) => exec(sql, p);
  db.oc = async (sql, p) => (await exec(sql, p))[0] ?? null;
  return db;
}

const lock = (db, args) => lockSharedSheet({ gangId: db.gang.id, updateMaster: false, scope: null, user: 'test', ...args }, db.qc, db.oc);
const ov = (db, id) => { const s = db.lines.find(l => l.id === id).spec_override; return s ? JSON.parse(s) : null; };
const master = (db, id) => db.products.find(p => p.id === id);
const gangAudit = db => db.log.audits.filter(a => a.entity === 'gang_run');

// ── Fixtures ────────────────────────────────────────────────────────────────
// The final review's J5 shape (probe p2b): SW-251 files board #53 (22×28) with
// a parent that is #53's own sheet. Its combined run sits on a JOB-ONLY board,
// #56 (31.5×41.5) — /board wrote the override. 22×28 cuts 2, #56 cuts 4.
const B53 = { id: 53, name: 'Duplex WB 350 22x28', sheet_l: 22, sheet_w: 28 };
const B56 = { id: 56, name: 'Duplex WB 350 31.5x41.5', sheet_l: 31.5, sheet_w: 41.5 };
const SW251 = { id: 251, name: 'SW-251', code: 'SW-251', ups: 2, child_l: 14, child_w: 20, parent_l: 22, parent_w: 28,
  board_material_id: 53, wastage_pct: 5, coating: 'Gloss', colors: 4 };
const MRG31 = { id: 31, gang_number: 'CI-MRG-0031', kind: 'merge', layout_mode: 'separate', product_id: 251 };
const on56 = JSON.stringify({ board_material_id: 56 });
const l251 = (id, x = {}) => ({ id, product_id: 251, gang_run_id: 31, qty: 10000, fg_consumed_qty: 0, dispatched_qty: 0,
  wastage_sheets: 0, status: 'pending', sheets_required: null, parent_sheets_required: null, spec_override: on56,
  leftover_plan: null, ...x });
const j5 = (lines = [l251(887, { wastage_sheets: 200 }), l251(888)]) =>
  makeDb({ gang: MRG31, products: [SW251], boards: [B53, B56], lines });
// Step 1 of J5: "Use the board's full sheet" on the red row, then Update Product Masters.
const oneClick = db => lock(db, { patch: { parent_l: 31.5, parent_w: 41.5 }, updateMaster: true, scope: new Set([887, 888]) });
// What Lock sheet → sends for this run: the lead's board, child and coating.
const boardOnly = { board_material_id: 56, child_l: 14, child_w: 20, coating: 'Gloss' };

// (a) ────────────────────────────────────────────────────────────────────────
test('(a) J5 step 1: a parent the master\'s own board cannot yield stays on the jobs; the master is untouched', async () => {
  const db = j5();
  const out = await oneClick(db);
  assert.deepEqual(db.log.unknown, []);
  assert.deepEqual(out.parent_kept_job_only, ['SW-251']);
  assert.deepEqual(db.log.productUpdates, [], 'no products UPDATE at all');
  assert.equal(master(db, 251).board_material_id, 53);
  assert.deepEqual([master(db, 251).parent_l, master(db, 251).parent_w], [22, 28]);
  for (const id of [887, 888]) assert.deepEqual(ov(db, id), { board_material_id: 56, parent_l: 31.5, parent_w: 41.5 });
});

test('(a) …and it says so: nothing reached a master, so the lock is "locked", never "saved to product masters"', async () => {
  const db = j5();
  const out = await oneClick(db);
  assert.deepEqual(out.masters_updated, []);
  const [a] = gangAudit(db);
  assert.equal(a.action, 'lock_sheet');
  assert.match(a.detail, /^CI-MRG-0031 shared sheet locked \(parent_l, parent_w\) for 2 of the 2 jobs/);
  assert.match(a.detail, /parent kept job-only on SW-251 — the master's own board cannot yield it/);
  assert.doesNotMatch(a.detail, /saved to product masters/);
});

// (b) THE CRITICAL ─────────────────────────────────────────────────────────
test('(b) J5 step 2: the board-only Lock sheet moves the master\'s board AND clears its old parent', async () => {
  const db = j5();
  await oneClick(db);
  const out = await lock(db, { patch: boardOnly, updateMaster: true });
  assert.deepEqual(db.log.unknown, []);
  const m = master(db, 251);
  assert.equal(m.board_material_id, 56);
  assert.deepEqual([m.parent_l, m.parent_w], [null, null], 'no parent: the master cuts its board\'s full sheet');
  assert.deepEqual(out.master_parent_cleared, [{ code: 'SW-251', from: '22×28' }]);
  assert.deepEqual(out.masters_updated, ['SW-251']);
  // one master write carries the board AND the clear
  assert.equal(db.log.productUpdates.length, 1);
  assert.deepEqual(db.log.productUpdates[0].set.parent_l, null);
  // the jobs keep their parent: the override is left alone, and the effective parent does not move
  for (const id of [887, 888]) assert.deepEqual(ov(db, id), { parent_l: 31.5, parent_w: 41.5 });
  const detail = db.log.audits.find(a => a.entity === 'product' && a.action === 'master_update').detail;
  assert.match(detail, /parent_l, parent_w: 22×28 → none \(follows the board\)/);
  const [, g] = gangAudit(db);
  assert.equal(g.action, 'lock_sheet_master');
  assert.match(g.detail, /master parent cleared on SW-251 \(22×28\)/);
});

test('(b) the p5 variant: a master parent too big for the new board is cleared, and the next order locks', async () => {
  const B60 = { id: 60, name: 'Saffire 25.6x28', sheet_l: 25.6, sheet_w: 28 };
  const B399 = { id: 399, name: 'Saffire 23x38', sheet_l: 23, sheet_w: 38 };
  const SW097 = { id: 97, name: 'SW-097', code: 'SW-097', ups: 2, child_l: 12, child_w: 13, parent_l: 25.6, parent_w: 28,
    board_material_id: 60, wastage_pct: 5, coating: 'Gloss', colors: 4 };
  const L = (id, x = {}) => ({ id, product_id: 97, gang_run_id: 50, qty: 10000, fg_consumed_qty: 0, dispatched_qty: 0,
    wastage_sheets: 0, status: 'pending', sheets_required: null, parent_sheets_required: null,
    spec_override: JSON.stringify({ board_material_id: 399 }), leftover_plan: null, ...x });
  const db = makeDb({ gang: { id: 50, gang_number: 'CI-MRG-0050', kind: 'merge', layout_mode: 'separate', product_id: 97 },
    products: [SW097], boards: [B60, B399], lines: [L(1, { wastage_sheets: 200 }), L(2)] });
  const kept = await lock(db, { patch: { parent_l: 23, parent_w: 38 }, updateMaster: true, scope: new Set([1, 2]) });
  assert.deepEqual(kept.parent_kept_job_only, ['SW-097']);
  const out = await lock(db, { patch: { board_material_id: 399, child_l: 12, child_w: 13, coating: 'Gloss' }, updateMaster: true });
  assert.deepEqual(db.log.unknown, []);
  const m = master(db, 97);
  assert.equal(m.board_material_id, 399);
  assert.deepEqual([m.parent_l, m.parent_w], [null, null]);
  assert.deepEqual(out.master_parent_cleared, [{ code: 'SW-097', from: '25.6×28' }]);
  assert.doesNotThrow(() => planLockParent(m, B399, 'SW-097 next order'), 'the 14-Sep rule has nothing to refuse');
  for (const id of [1, 2]) assert.deepEqual(ov(db, id), { parent_l: 23, parent_w: 38 });
});

// (c) ────────────────────────────────────────────────────────────────────────
// Probe p1b: a separate-layout gang of three products; only SW-544's red row is clicked.
const B399g = { id: 399, name: 'SW 23x38', sheet_l: 23, sheet_w: 38 };
const SW544 = { id: 544, name: 'SW-544', code: 'SW-544', ups: 2, child_l: 12.6, child_w: 23, parent_l: 22, parent_w: 28,
  board_material_id: 399, wastage_pct: 5, coating: 'Gloss', colors: 4 };
const SW258 = { id: 258, name: 'SW-258', code: 'SW-258', ups: 2, child_l: 11, child_w: 18, parent_l: 22, parent_w: 36,
  board_material_id: 399, wastage_pct: 5, coating: 'Gloss', colors: 4 };
const SW777 = { id: 777, name: 'SW-777', code: 'SW-777', ups: 2, child_l: 11, child_w: 18, parent_l: null, parent_w: null,
  board_material_id: 399, wastage_pct: 5, coating: 'Gloss', colors: 4 };
const G40 = { id: 40, gang_number: 'CI-GANG-0040', kind: 'gang', layout_mode: 'separate' };
const g40 = () => {
  const L = (id, product_id, x = {}) => ({ id, product_id, gang_run_id: 40, qty: 10000, fg_consumed_qty: 0, dispatched_qty: 0,
    wastage_sheets: 0, status: 'planned', sheets_required: 5000, parent_sheets_required: 2500, spec_override: null,
    leftover_plan: null, ...x });
  return makeDb({ gang: G40, products: [SW544, SW258, SW777], boards: [B399g],
    lines: [L(501, 258, { wastage_sheets: 200 }), L(502, 544), L(503, 777)] });
};

test('(c) the scoped one-click touches only its own orders — other products\' parents and masters stay', async () => {
  for (const updateMaster of [true, false]) {
    const db = g40();
    const out = await lock(db, { patch: { parent_l: 23, parent_w: 38 }, updateMaster, scope: new Set([502]) });
    assert.deepEqual(db.log.unknown, []);
    assert.deepEqual(db.log.overrideWrites.map(w => w.id), [502], 'only the scoped line is written');
    assert.deepEqual(db.log.sheetWrites.map(w => w.id), [502], 'only the scoped line is re-derived');
    assert.deepEqual(db.log.sheetWrites[0], { id: 502, sheets: 5000, parent: 1667 }, '3 cuts on 23×38');
    assert.deepEqual([master(db, 258).parent_l, master(db, 258).parent_w], [22, 36]);
    assert.deepEqual([master(db, 777).parent_l, master(db, 777).parent_w], [null, null]);
    assert.equal(ov(db, 501), null);
    assert.equal(ov(db, 503), null);
    assert.deepEqual(out.master_parent_cleared, []);
    if (updateMaster) {
      assert.deepEqual([master(db, 544).parent_l, master(db, 544).parent_w], [23, 38], 'its own board yields it');
      assert.deepEqual(db.log.productUpdates.map(u => u.id), [544]);
      assert.equal(ov(db, 502), null);
    } else {
      assert.deepEqual([master(db, 544).parent_l, master(db, 544).parent_w], [22, 28]);
      assert.deepEqual(db.log.productUpdates, []);
      assert.deepEqual(ov(db, 502), { parent_l: 23, parent_w: 38 });
    }
    assert.match(gangAudit(db)[0].detail, /for 1 of the 3 jobs — SW-544 \(line 502\)/);
  }
});

// (d) ────────────────────────────────────────────────────────────────────────
test('(d) J2: a board change carrying a parent writes BOTH to the master — no clear', async () => {
  const B401 = { id: 401, name: 'Duplex 25x38', sheet_l: 25, sheet_w: 38 };
  const P = { ...SW544, parent_l: 23, parent_w: 38 };           // a copy of #399's sheet
  const L = (id, x = {}) => ({ id, product_id: 544, gang_run_id: 28, qty: 10000, fg_consumed_qty: 0, dispatched_qty: 0,
    wastage_sheets: 0, status: 'pending', sheets_required: null, parent_sheets_required: null,
    spec_override: JSON.stringify({ board_material_id: 401 }), leftover_plan: null, ...x });
  const db = makeDb({ gang: { id: 28, gang_number: 'CI-MRG-0028', kind: 'merge', layout_mode: 'separate', product_id: 544 },
    products: [P], boards: [B399g, B401], lines: [L(1, { wastage_sheets: 200 }), L(2)] });
  const out = await lock(db, { patch: { board_material_id: 401, child_l: 12.6, child_w: 23, coating: 'Gloss', parent_l: 25, parent_w: 38 },
    updateMaster: true });
  assert.deepEqual(db.log.unknown, []);
  const m = master(db, 544);
  assert.equal(m.board_material_id, 401);
  assert.deepEqual([m.parent_l, m.parent_w], [25, 38]);
  assert.deepEqual(out.master_parent_cleared, []);
  assert.deepEqual(out.parent_kept_job_only, []);
  assert.equal(ov(db, 1), null);
  assert.equal(ov(db, 2), null);
});

// (e) ────────────────────────────────────────────────────────────────────────
test('(e) a coating-only lock changes no parent and re-derives nothing', async () => {
  for (const updateMaster of [true, false]) {
    const db = g40();
    db.mix = { 501: 1, 502: 2 };
    const out = await lock(db, { patch: { coating: 'Matt' }, updateMaster });
    assert.deepEqual(db.log.unknown, []);
    assert.deepEqual(db.log.sheetWrites, []);
    assert.deepEqual(db.log.mixDeleted, [], 'a saved mix survives a coating change');
    assert.deepEqual(out.master_parent_cleared, []);
    for (const p of [SW544, SW258, SW777]) {
      assert.deepEqual([master(db, p.id).parent_l, master(db, p.id).parent_w], [p.parent_l, p.parent_w]);
      assert.equal(master(db, p.id).board_material_id, 399);
    }
    if (updateMaster) {
      assert.deepEqual(db.log.productUpdates.map(u => u.set), [{ coating: 'Matt' }, { coating: 'Matt' }, { coating: 'Matt' }]);
      assert.deepEqual(out.masters_updated, ['SW-258', 'SW-544', 'SW-777']);
    } else {
      assert.deepEqual(db.log.productUpdates, []);
      assert.deepEqual(ov(db, 502), { coating: 'Matt' });
    }
  }
});

// (f) ────────────────────────────────────────────────────────────────────────
// CI-GANG-0019's shape: a CO-PRINTED gang; every master files a 20×38 trim of
// the 23×38 board #380. Its lock cuts the board's own sheet and never reads a
// parent — but the masters' parents matter the day a job is planned alone.
const B380 = { id: 380, name: 'Met Saffire 23x38', sheet_l: 23, sheet_w: 38 };
const B381 = { id: 381, name: 'Met Saffire 25x36', sheet_l: 25, sheet_w: 36 };
const B382 = { id: 382, name: 'Met Saffire 25x40', sheet_l: 25, sheet_w: 40 };
const co = (id, ups) => ({ id, name: `FP-${id}`, code: `FP-${id}`, ups, child_l: 19, child_w: 21, parent_l: 20, parent_w: 38,
  board_material_id: 380, wastage_pct: 5, coating: 'Gloss' });
const coRun = () => {
  const layout = JSON.stringify({ child_l: 19, child_w: 21 });
  const L = (id, product_id, x = {}) => ({ id, product_id, gang_run_id: 19, qty: 10000, fg_consumed_qty: 0, dispatched_qty: 0,
    wastage_sheets: 0, status: 'pending', spec_override: layout, leftover_plan: null, ...x });
  return makeDb({ gang: { id: 19, gang_number: 'CI-GANG-0019', kind: 'gang', layout_mode: 'shared' },
    products: [co(157, 4), co(216, 2), co(300, 2)], boards: [B380, B381, B382],
    lines: [L(328, 157, { wastage_sheets: 200, sheets_required: 1300, parent_sheets_required: 650 }),
            L(394, 216, { sheets_required: 650, parent_sheets_required: 325 }),
            L(395, 300, { status: 'planned', sheets_required: 650, parent_sheets_required: 325 })] });
};

test('(f) a co-printed run\'s board move to masters clears a master parent that cannot stay — and never writes the patch\'s', async () => {
  const db = coRun();
  const out = await lock(db, { patch: { board_material_id: 381, parent_l: 23, parent_w: 38 }, updateMaster: true });
  assert.deepEqual(db.log.unknown, []);
  for (const id of [157, 216, 300]) {
    assert.equal(master(db, id).board_material_id, 381);
    assert.deepEqual([master(db, id).parent_l, master(db, id).parent_w], [null, null], '20×38 cannot be cut from 25×36');
  }
  assert.deepEqual(out.master_parent_cleared, [
    { code: 'FP-157', from: '20×38' }, { code: 'FP-216', from: '20×38' }, { code: 'FP-300', from: '20×38' }]);
  for (const u of db.log.productUpdates) assert.notEqual(u.set.parent_l, 23, 'the patch\'s parent never reaches a master');
  for (const id of [328, 394, 395]) assert.deepEqual(ov(db, id), { child_l: 19, child_w: 21 }, 'no parent on any job');
});

test('(f) …while a master parent the new board can still yield stays', async () => {
  const db = coRun();
  const out = await lock(db, { patch: { board_material_id: 382 }, updateMaster: true });
  assert.deepEqual(db.log.unknown, []);
  for (const id of [157, 216, 300]) {
    assert.equal(master(db, id).board_material_id, 382);
    assert.deepEqual([master(db, id).parent_l, master(db, id).parent_w], [20, 38]);
  }
  assert.deepEqual(out.master_parent_cleared, []);
});

// (g) ────────────────────────────────────────────────────────────────────────
// The clear MOVES the cut of a job with no parent of its own: it cut the
// master's 22×28 (2 per sheet) and now cuts #56's full sheet (4). The patch
// itself changes nothing on these jobs (their board is already #56), so the
// request-level check says "no cut change" — the saved figures must still follow.
test('(g) jobs with no parent of their own are re-derived when the master parent they cut on is cleared', async () => {
  const db = j5([l251(887, { wastage_sheets: 200, sheets_required: 5200, parent_sheets_required: 2600 }),
                 l251(888, { sheets_required: 5000, parent_sheets_required: 2500 })]);
  const out = await lock(db, { patch: boardOnly, updateMaster: true });
  assert.deepEqual(db.log.unknown, []);
  assert.deepEqual(out.master_parent_cleared, [{ code: 'SW-251', from: '22×28' }]);
  assert.deepEqual(db.log.sheetWrites, [{ id: 887, sheets: 5200, parent: 1300 }, { id: 888, sheets: 5000, parent: 1250 }]);
  for (const id of [887, 888]) assert.equal(ov(db, id), null);
});

test('(g) …but a job-only lock (no master written) moves no master parent and re-derives nothing', async () => {
  const db = j5([l251(887, { wastage_sheets: 200, sheets_required: 5200, parent_sheets_required: 2600 }),
                 l251(888, { sheets_required: 5000, parent_sheets_required: 2500 })]);
  const out = await lock(db, { patch: boardOnly, updateMaster: false });
  assert.deepEqual(db.log.unknown, []);
  assert.deepEqual(out.master_parent_cleared, []);
  assert.deepEqual(db.log.sheetWrites, []);
  assert.deepEqual([master(db, 251).parent_l, master(db, 251).parent_w], [22, 28]);
});

// (h) ────────────────────────────────────────────────────────────────────────
// A parent the planner TYPES equal to the master's own is a parent this write
// carries — the split only dropped it as "already the master's". It stays on
// the master while the new board can yield it (the planner's call); when the
// new board cannot, the master is cleared and the jobs keep what was typed.
// Every order of the product ends the same, whichever the loop reaches first.
test('(h) a typed parent equal to the master\'s own stays on the master when the new board yields it', async () => {
  const db = j5();
  await oneClick(db);
  const out = await lock(db, { patch: { ...boardOnly, parent_l: 22, parent_w: 28 }, updateMaster: true });
  assert.deepEqual(db.log.unknown, []);
  const m = master(db, 251);
  assert.equal(m.board_material_id, 56);
  assert.deepEqual([m.parent_l, m.parent_w], [22, 28]);
  assert.deepEqual(out.master_parent_cleared, []);
  for (const id of [887, 888]) assert.equal(ov(db, id), null, 'both orders cut the typed 22×28, the master\'s');
});

test('(h) …and when the new board cannot yield it, the master is cleared and every order keeps the typed parent', async () => {
  const B60 = { id: 60, name: 'Saffire 25.6x28', sheet_l: 25.6, sheet_w: 28 };
  const B399 = { id: 399, name: 'Saffire 23x38', sheet_l: 23, sheet_w: 38 };
  const SW097 = { id: 97, name: 'SW-097', code: 'SW-097', ups: 2, child_l: 12, child_w: 13, parent_l: 25.6, parent_w: 28,
    board_material_id: 60, wastage_pct: 5, coating: 'Gloss', colors: 4 };
  const L = (id, x = {}) => ({ id, product_id: 97, gang_run_id: 50, qty: 10000, fg_consumed_qty: 0, dispatched_qty: 0,
    wastage_sheets: 0, status: 'pending', sheets_required: null, parent_sheets_required: null,
    spec_override: JSON.stringify({ board_material_id: 399, parent_l: 23, parent_w: 38 }), leftover_plan: null, ...x });
  const db = makeDb({ gang: { id: 50, gang_number: 'CI-MRG-0050', kind: 'merge', layout_mode: 'separate', product_id: 97 },
    products: [SW097], boards: [B60, B399], lines: [L(1, { wastage_sheets: 200 }), L(2)] });
  const out = await lock(db, { patch: { board_material_id: 399, child_l: 12, child_w: 13, coating: 'Gloss', parent_l: 25.6, parent_w: 28 },
    updateMaster: true });
  assert.deepEqual(db.log.unknown, []);
  const m = master(db, 97);
  assert.equal(m.board_material_id, 399);
  assert.deepEqual([m.parent_l, m.parent_w], [null, null]);
  assert.deepEqual(out.master_parent_cleared, [{ code: 'SW-097', from: '25.6×28' }]);
  for (const id of [1, 2]) assert.deepEqual(ov(db, id), { parent_l: 25.6, parent_w: 28 }, 'typed values are used as typed');
});

// The early return: a parent-only request to a co-printed run leaves nothing to
// lock — no write at all, and the route answers its defaults ([] for both lists).
test('a parent-only request to a co-printed run writes nothing and returns nothing', async () => {
  const db = coRun();
  const out = await lock(db, { patch: { parent_l: 23, parent_w: 38 }, updateMaster: true });
  assert.deepEqual(db.log.unknown, []);
  assert.equal(out, undefined);
  assert.deepEqual(db.log.overrideWrites, []);
  assert.deepEqual(db.log.productUpdates, []);
  assert.deepEqual(db.log.audits, []);
});

// (i) ────────────────────────────────────────────────────────────────────────
// Round 3: the clear must not move a plan made elsewhere. SW-251's OTHER open
// orders — outside this run, cutting the master's 22×28 — keep it as their own;
// only future orders follow the board. An order with no plan yet follows it now.
test('(i) the clear pins the old parent on the product\'s other open plans; an order with no plan yet follows the board', async () => {
  const outside = (id, x) => ({ id, product_id: 251, gang_run_id: null, qty: 10000, fg_consumed_qty: 0, dispatched_qty: 0,
    wastage_sheets: 200, spec_override: null, leftover_plan: null, ...x });
  const db = j5([l251(887, { wastage_sheets: 200 }), l251(888),
    outside(950, { status: 'planned', sheets_required: 5200, parent_sheets_required: 2600 }),
    outside(951, { status: 'pending', sheets_required: null, parent_sheets_required: null })]);
  await oneClick(db);
  assert.deepEqual(ov(db, 950), null, 'the one-click clears nothing, so it pins nothing');
  const out = await lock(db, { patch: boardOnly, updateMaster: true });
  assert.deepEqual(db.log.unknown, []);
  assert.deepEqual(out.master_parent_cleared, [{ code: 'SW-251', from: '22×28' }]);
  assert.deepEqual(out.parent_pinned_lines, [950]);
  assert.deepEqual(ov(db, 950), { parent_l: 22, parent_w: 28 }, 'the plan keeps the sheet it was made on');
  assert.equal(ov(db, 951), null, 'no plan yet: it follows the board');
  const a = db.log.audits.find(x => x.entity === 'order_line' && x.id === 950);
  assert.equal(a.action, 'parent_pinned');
  assert.match(a.detail, /^parent 22×28 pinned — the product master's parent was cleared; this plan keeps the sheet it was made on \(from gang CI-MRG-0031\)$/);
  // the run's own orders follow their own rule: overrides left alone (they hold 31.5×41.5)
  for (const id of [887, 888]) assert.deepEqual(ov(db, id), { parent_l: 31.5, parent_w: 41.5 });
});

test('(i) …and a lock that clears nothing pins nothing', async () => {
  const outside = { id: 950, product_id: 251, gang_run_id: null, qty: 10000, fg_consumed_qty: 0, dispatched_qty: 0,
    wastage_sheets: 200, status: 'planned', sheets_required: 5200, parent_sheets_required: 2600, spec_override: null, leftover_plan: null };
  const db = j5([l251(887, { wastage_sheets: 200 }), l251(888), outside]);
  const out = await lock(db, { patch: { coating: 'Matt' }, updateMaster: true });
  assert.deepEqual(db.log.unknown, []);
  assert.deepEqual(out.parent_pinned_lines, []);
  assert.equal(ov(db, 950), null);
});
