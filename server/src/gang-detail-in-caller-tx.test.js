import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gangDetail } from './routes/gangs.js';

// gangDetail() is read-only for most of its callers, but POST
// /gang-runs/:id/raise-pr calls it INSIDE its transaction — it has to, because
// the PR's quantity is the position the transaction just locked the gang to
// read. Every statement it issues from there must therefore go through the
// `qc`/`oc` it is handed.
//
// A read that reaches for the module-level pool helpers (`q` / `one`) instead
// is not a stale read — on Vercel it is a deadlock. poolLimits() caps a
// serverless pool at ONE client (db.js), tx() holds that client for the whole
// transaction, and a pool query issued from inside the callback queues for a
// client only the blocked transaction can release. After
// connectionTimeoutMillis the pool gives up with "timeout exceeded when trying
// to connect", the transaction rolls back and no requisition is written — the
// planner clicks "Raise ONE PR", waits ten seconds and gets an error toast.
//
// This test drives the real function with stub qc/oc. No pool is ever
// connected, so `pool` is undefined and any escape to `q`/`one` throws a
// TypeError — which is exactly the signal this test exists to catch. Where the
// escaping call sits behind a `.catch()` (the die lookup) the symptom is
// silent instead: the payload simply loses a field, so the assertions below
// check the VALUES, not just the absence of a throw.

// The plant's board names carry the `·` separators parseBoardName reads — a
// name without them parses as null and every substitute is silently blocked.
const PLANNED_BOARD = { id: 3021, name: 'Saffire · 320 GSM · 23x36', category: 'board', sheet_l: 23, sheet_w: 36, gsm: 320, grade: 'Saffire', sheets_per_packet: 100 };
// Same grade, same sheet size, lighter GSM: a legal substitute that cuts the
// same number of children, so it survives the candidate filter and the mix
// panel has to cost it. That costing is where the first escape sits.
const SUBSTITUTE_BOARD = { id: 3022, name: 'Saffire · 300 GSM · 23x36', category: 'board', sheet_l: 23, sheet_w: 36, gsm: 300, grade: 'Saffire', sheets_per_packet: 100 };

const GANG = {
  id: 77, gang_number: 'CI-GANG-0008', kind: 'gang', layout_mode: 'shared',
  stock_booking: 'fresh_pr', notes: null, created_by: 'Anik',
};

const member = (id, productId, name) => ({
  id, order_id: 900 + id, product_id: productId, product_name: name,
  product_code: `SW-${productId}`, qty: 1700, status: 'planned', gang_run_id: GANG.id,
  sheets_required: 1075, parent_sheets_required: 538, wastage_sheets: 200,
  fg_consumed_qty: 0, dispatched_qty: 0, po_number: 'PO-99', delivery_date: '2026-09-10',
  customer_name: 'Fluence', ups: 2, master_ups: 2, wastage_pct: 5,
  child_l: 18, child_w: 23, coating: 'Aqueous Varnish', colors: 4,
  gsm: 350, master_gsm: 350, board_material_id: PLANNED_BOARD.id,
  board_name: PLANNED_BOARD.name, sheet_l: PLANNED_BOARD.sheet_l, sheet_w: PLANNED_BOARD.sheet_w,
  board_grade: 'Saffire', job_card_id: null, jc_number: null,
  spec_override: { child_l: 18, child_w: 23, ups: 2 },
});

const MEMBERS = [member(8801, 501, 'ONTEL AM TABLETS CARTON'), member(8802, 502, 'ROSUAID-F10 CARTON')];

const productMaster = m => ({
  id: m.product_id, name: m.product_name, code: m.product_code, ups: 2,
  child_l: 18, child_w: 23, gsm: 350, coating: 'Aqueous Varnish', colors: 4,
  board_material_id: PLANNED_BOARD.id, wastage_pct: 5,
});

const DIE = {
  id: 12, name: 'SW-526 + SW-584', active: 1, fingerprint: '501-502',
  child_l: 18, child_w: 23, last_gang_number: 'CI-GANG-0008', updated_at: '2026-08-14',
};

// The run's saved plan mix — one row on the planned board. Its costing is the
// second escape.
const MIX_ROWS = [{
  id: 5, order_line_id: 8801, material_id: PLANNED_BOARD.id, phase: 'plan', role: 'planned',
  sheets: 300, covers: 600, ups: 2, reason: null, stock_batch_id: null,
  board_name: PLANNED_BOARD.name, sheet_l: 23, sheet_w: 36, sheets_per_packet: 100,
}];

// One dispatcher behind both stubs. Anything it does not recognise is a test
// bug — a silently-empty answer would let a future escape pass unnoticed.
function stubs() {
  const seen = [];
  const materials = new Map([[PLANNED_BOARD.id, PLANNED_BOARD], [SUBSTITUTE_BOARD.id, SUBSTITUTE_BOARD]]);
  const run = async (sql, params = []) => {
    seen.push(sql);
    if (/FROM gang_runs WHERE id=/.test(sql)) return [GANG];
    if (/ol\.order_id/.test(sql)) return MEMBERS;                          // MEMBER_VIEW
    if (/FROM materials WHERE id=/.test(sql)) {
      const m = materials.get(Number(params[0]));
      return m ? [m] : [];
    }
    if (/FROM products WHERE id=/.test(sql)) {
      const m = MEMBERS.find(x => x.product_id === Number(params[0]));
      return m ? [productMaster(m)] : [];
    }
    // Substitute-board candidates: every sized board with stock, minus the planned one.
    if (/FROM materials m/.test(sql) && /m\.category='board'/.test(sql)) {
      return [{ ...SUBSTITUTE_BOARD, available: 4_000 }];
    }
    // Availability for the saved mix's boards.
    if (/FROM materials m/.test(sql) && /WHERE m\.id = ANY/.test(sql)) {
      return [...materials.values()].map(m => ({ id: m.id, available: 4_000 }));
    }
    if (/LEFT JOIN gang_runs g/.test(sql)) return [];                      // boardClaimLines
    if (/SELECT DISTINCT ol\.id/.test(sql)) return [];                     // boardDrawnLineIds
    if (/FROM board_allocations/.test(sql)) return [];
    if (/FROM stock_batches\s+WHERE material_id = ANY/.test(sql)) return [{ material_id: PLANNED_BOARD.id, q: 0 }];
    if (/FROM stock_batches sb/.test(sql)) return [];                      // banked leftover strips
    if (/FROM job_board_mix/.test(sql)) {
      return MIX_ROWS.filter(r => r.order_line_id === Number(params[0]));
    }
    if (/FROM requisitions/.test(sql)) return [];                          // open_prs / other_prs
    if (/FROM job_cards/.test(sql)) return [];
    if (/FROM gang_templates WHERE active=1 AND fingerprint=/.test(sql)) return [DIE];
    if (/FROM gang_template_slots s/.test(sql)) {
      return MEMBERS.map(m => ({ product_id: m.product_id, ups: 2, product_code: m.product_code }));
    }
    throw new Error(`stub got an unexpected statement: ${sql}`);
  };
  const qc = run;
  const oc = async (sql, params) => (await run(sql, params))[0] ?? null;
  return { qc, oc, seen };
}

test('the gang detail a raise-pr transaction reads stays inside that transaction', async () => {
  const { qc, oc } = stubs();

  const detail = await gangDetail(GANG.id, oc, qc).catch(e => e);

  assert.ok(!(detail instanceof Error),
    'gangDetail escaped its caller\'s transaction — every read must go through the qc/oc it '
    + `is handed, never the module-level pool. Got: ${detail?.message}`);
  assert.equal(detail.gang_number, 'CI-GANG-0008');
  assert.ok(detail.position, 'the run must quote a board position — that is what the PR is sized on');
});

test('a mix candidate offered inside the transaction is costed through it', async () => {
  const { qc, oc } = stubs();

  const detail = await gangDetail(GANG.id, oc, qc);

  const cand = (detail.mix?.candidates || []).find(c => c.id === SUBSTITUTE_BOARD.id);
  assert.ok(cand, 'the lighter same-size Saffire is a legal substitute and must be offered');
  assert.equal(cand.free, 4_000,
    'a candidate must advertise what it is FREE to give this run, costed through the '
    + 'caller transaction — reaching for the pool here is the deadlock');
  const row = (detail.mix?.rows || []).find(r => r.material_id === PLANNED_BOARD.id);
  assert.ok(row, 'the saved plan mix row must come back');
  assert.equal(row.free, 4_000, 'the saved row is costed on the same books as the candidates');
});

test('the remembered die survives being read inside the transaction', async () => {
  const { qc, oc } = stubs();

  const detail = await gangDetail(GANG.id, oc, qc);

  // The die lookup is best-effort (`.catch`), so an escape here does not throw
  // — it silently blanks the panel the planner reads the layout off.
  assert.ok(detail.die_memory,
    'the remembered die must be read through the caller transaction — a pool read here is '
    + 'swallowed by the lookup\'s .catch and the engine loses DIE REMEMBERED entirely');
  assert.equal(detail.die_memory.name, 'SW-526 + SW-584');
  assert.deepEqual(detail.die_memory.ups.map(u => u.ups), [2, 2]);
});
