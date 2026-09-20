// A co-printed (shared-layout) gang's lock prices the run on the SHARED child
// cut from the board's own sheet (gangs.js plan route, shared arm). Its card
// stamped children_per_parent from readiness(lead) instead, which counts on
// the lead's parent on file. CI-GANG-0019's shape (FP-157: parent 20×38 on
// the 23×38 board, child 19×21): the lock plans 2 per parent, the card would
// tell cutting 1 — half the print sheets the job needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coPrintedCardCuts, cuttingParent, childFit, createJobCardForGang } from './helpers.js';

const FP157 = { parent_l: 20, parent_w: 38, child_l: 19, child_w: 21 };
const B380 = { sheet_l: 23, sheet_w: 38 };

test('the mismatch is real: readiness counts 1, the co-printed lock 2', () => {
  assert.equal(childFit(cuttingParent(FP157, B380), FP157).count, 1);
  assert.equal(childFit(B380, FP157).count, 2);
});

test('coPrintedCardCuts is the divisor the co-printed lock used', () => {
  assert.equal(coPrintedCardCuts(B380, { l: 19, w: 21 }), 2);
  // parentSheetsRequired clamps an unsized or a zero fit to 1 — so does the card.
  assert.equal(coPrintedCardCuts({ sheet_l: null, sheet_w: 38 }, { l: 19, w: 21 }), 1);
  assert.equal(coPrintedCardCuts(B380, { l: 30, w: 40 }), 1);
});

const HELPERS = readFileSync(new URL('./helpers.js', import.meta.url), 'utf8');
const fn = HELPERS.slice(HELPERS.indexOf('export async function createJobCardForGang'),
                         HELPERS.indexOf('export async function createJobCardForMergeRun'));

test('createJobCardForGang stamps coPrintedCardCuts on a co-printed run', () => {
  assert.match(fn, /sharedChild = ov\[0\];/);
  assert.match(fn, /cardCuts = coPrintedCardCuts\(board, sharedChild\);/);
  assert.match(fn, /anchor\.machine_id, totalChild, totalParent,\s*cardCuts, totalChild\]/);
});

// ── Behaviour, not text ─────────────────────────────────────────────────────
// The REAL createJobCardForGang, driven with stub qc/oc (no database), reading
// back what its job_cards INSERT would write. The text pin above let a flipped
// kind check and a wrong board id through in review (19 Sep 2026); these do not.
// Every statement the function issues is answered; an unrecognised one fails
// the test, so the stub cannot quietly hand back null.
function pushCard({ gang, board, products, lines }) {
  const inserts = [];
  const unknown = [];
  const byId = (arr, id) => arr.find(x => +x.id === +id) || null;
  const oc = async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/FROM job_cards WHERE gang_run_id=\$1 AND parent_job_card_id IS NULL/.test(s)) return null;
    if (/^SELECT \* FROM gang_runs WHERE id=\$1/.test(s)) return gang;
    if (/^SELECT \* FROM products WHERE id=\$1/.test(s)) return byId(products, p[0]);
    if (/^SELECT \* FROM materials WHERE id=\$1/.test(s)) return +p[0] === board.id ? board : null;
    if (/^SELECT sheet_l, sheet_w FROM materials WHERE id=\$1/.test(s)) return +p[0] === board.id ? { sheet_l: board.sheet_l, sheet_w: board.sheet_w } : null;
    if (/FROM stock_batches WHERE material_id=\$1 AND status='available'/.test(s)) return { q: 1e9 };
    if (/FROM tools t WHERE t.product_id/.test(s)) return { list: [] };
    if (/FROM tooling_requests tr JOIN plate_request_components/.test(s)) return null;
    if (/FROM shade_cards/.test(s)) return null;
    if (/FROM requisitions/.test(s)) return { qty: 0 };
    if (/FROM job_board_mix x WHERE x.order_line_id/.test(s)) return { list: [] };
    if (/^SELECT \* FROM order_lines WHERE id=\$1/.test(s)) return byId(lines, p[0]);
    if (/pg_advisory_xact_lock/.test(s)) return {};
    if (/^SELECT jc_number AS n FROM job_cards/.test(s)) return null;
    unknown.push(s.slice(0, 90));
    return null;
  };
  const qc = async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT ol\.\* FROM order_lines ol WHERE ol\.gang_run_id=\$1/.test(s)) return lines.map(l => ({ ...l }));
    if (/^UPDATE order_lines SET status/.test(s)) { const l = byId(lines, p[1]); if (l) l.status = p[0]; return []; }
    if (/^INSERT INTO job_cards/.test(s)) { inserts.push(p); return [{ id: 9001 }]; }
    if (/^INSERT INTO job_stages/.test(s)) return [];
    if (/^INSERT INTO audit_log/.test(s)) return [];
    unknown.push('qc: ' + s.slice(0, 90));
    return [];
  };
  return createJobCardForGang(gang.id, qc, oc, 'test').then(
    () => ({ cpp: inserts[0]?.[6], unknown }),
    e => ({ error: `${e.status || ''} ${e.message}`, unknown }));
}

const BOARD380 = { id: 380, name: 'Met Saffire 23x38', sheet_l: 23, sheet_w: 38 };
const master = (id, code, extra = {}) => ({ id, code, name: code, ups: 4, child_l: 19, child_w: 21,
  parent_l: 20, parent_w: 38, board_material_id: 380, wastage_pct: 5, pasting_type: 'lock bottom', ...extra });
const line = (id, product_id, extra = {}) => ({ id, product_id, machine_id: 3, gang_run_id: 19, qty: 10000,
  status: 'planned', artwork_locked: 1, tooling_ok: 1, stock_booking: 'book', wastage_sheets: 0,
  fg_consumed_qty: 0, dispatched_qty: 0,
  sheets_required: 1300, parent_sheets_required: 650,   // the co-printed lock: 2 cuts on 23×38
  spec_override: JSON.stringify({ child_l: 19, child_w: 21 }), ...extra });
const GANG = { id: 19, gang_number: 'CI-GANG-0019', kind: 'gang', layout_mode: 'shared' };
const PRODUCTS = [master(157, 'FP-157'), master(216, 'FP-216')];

test('behaviour: a co-printed card carries its lock\'s 2 cuts; a separate-layout card keeps readiness\'s 1', async () => {
  const shared = await pushCard({ gang: GANG, board: BOARD380, products: PRODUCTS,
    lines: [line(328, 157), line(394, 216)] });
  assert.equal(shared.error, undefined);
  assert.deepEqual(shared.unknown, []);
  assert.equal(shared.cpp, 2);
  const separate = await pushCard({ gang: { ...GANG, layout_mode: 'separate' }, board: BOARD380, products: PRODUCTS,
    lines: [line(328, 157, { spec_override: null }), line(394, 216, { spec_override: null })] });
  assert.deepEqual(separate.unknown, []);
  assert.equal(separate.cpp, 1);
});

test('behaviour: an unsized board or a child bigger than the board gives the lock\'s clamp, 1', async () => {
  const unsized = await pushCard({ gang: GANG, board: { id: 380, name: 'placeholder', sheet_l: null, sheet_w: null },
    products: [master(157, 'FP-157', { parent_l: 25, parent_w: 36, child_l: 12, child_w: 18 }),
               master(216, 'FP-216', { parent_l: 25, parent_w: 36, child_l: 12, child_w: 18 })],
    lines: [line(328, 157, { spec_override: JSON.stringify({ child_l: 12, child_w: 18 }) }),
            line(394, 216, { spec_override: JSON.stringify({ child_l: 12, child_w: 18 }) })] });
  assert.deepEqual(unsized.unknown, []);
  assert.equal(unsized.cpp, 1);
  const tooBig = await pushCard({ gang: GANG, board: BOARD380,
    products: [master(157, 'FP-157', { parent_l: null, parent_w: null }), master(216, 'FP-216', { parent_l: null, parent_w: null })],
    lines: [line(328, 157, { spec_override: JSON.stringify({ child_l: 30, child_w: 40 }) }),
            line(394, 216, { spec_override: JSON.stringify({ child_l: 30, child_w: 40 }) })] });
  assert.deepEqual(tooBig.unknown, []);
  assert.equal(tooBig.cpp, 1);
});

test('behaviour: a co-printed run with its layout pending still refuses the push', async () => {
  const pending = await pushCard({ gang: GANG, board: BOARD380, products: PRODUCTS,
    lines: [line(328, 157), line(394, 216, { spec_override: null })] });
  assert.match(pending.error, /Layout Pending/);
});
