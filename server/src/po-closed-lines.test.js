import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  openLinesOf, closedLinesOf, closedAsWhole, closedLineRows, reopenSummary, unitLabel,
} from '../../client/src/lib/closedPoLines.js';
import { reopenPoLines } from './routes/procurement.js';

// ── Closed lines: out of the register, one view to read them, one form back ──
//
// A line closed short used to stay on its PO card behind a "waived" chip, so
// every order the buyer had trimmed kept showing items nobody expects. The
// card now lists only the lines still in play; the closed ones live in
// Purchase Orders → Closed lines, where each can be read (what, how much was
// waived, why, by whom, when) and brought back through a reopen FORM that asks
// why — the same discipline as the close itself.

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

const PO = (id, status, lines) => ({
  id, po_number: `CI-VPO-${String(id).padStart(4, '0')}`, vendor_name: 'Kansal', status, lines,
});
const L = (id, qty, received_qty, closed = null) => ({
  id, material_name: `Board ${id}`, unit: 'sheets', qty, received_qty,
  closed_short: !!closed, closed_reason: closed?.reason ?? null,
  closed_by: closed?.by ?? null, closed_at: closed?.at ?? null,
});
const AT = '2026-09-10T05:43:48Z';

// ── the client spelling ─────────────────────────────────────────────────────

test('a PO card lists only the lines still in play', () => {
  const po = PO(49, 'partially_received', [
    L(108, 1000, 400),
    L(109, 3600, 0, { reason: 'vendor cannot supply', by: 'Anik', at: AT }),
    L(110, 2880, 0, { reason: 'vendor cannot supply', by: 'Anik', at: AT }),
  ]);
  assert.deepEqual(openLinesOf(po).map(l => l.id), [108]);
  assert.deepEqual(closedLinesOf(po).map(l => l.id), [109, 110]);
  assert.deepEqual(openLinesOf({}), [], 'a PO without lines reads empty, never throws');
});

test('the closed-lines register carries each line with its order, the waived balance and the story', () => {
  const rows = closedLineRows([
    PO(49, 'partially_received', [L(108, 1000, 400), L(109, 3600, 0, { reason: 'vendor cannot supply', by: 'Anik', at: AT })]),
    PO(51, 'closed', [L(120, 500, 200, { reason: 'job cancelled', by: 'Rohit', at: '2026-09-11T09:00:00Z' }), L(121, 300, 300)]),
  ]);
  assert.deepEqual(rows.map(r => r.id), [120, 109], 'the newest closure leads');
  const [late, early] = rows;
  assert.equal(late.po_number, 'CI-VPO-0051');
  assert.equal(late.po_id, 51);
  assert.equal(late.vendor_name, 'Kansal');
  assert.equal(late.po_status, 'closed');
  assert.equal(late.waived, 300, 'waived is what was still owed when the line closed');
  assert.equal(late.closed_reason, 'job cancelled');
  assert.equal(early.waived, 3600);
  assert.equal(late.whole_closed, false, 'an order its waivers finished was not closed as a whole');
});

test('ties on the closing moment still sort one way — the register is a total order', () => {
  // One close stamps every line it waives with the same instant; DataTable's
  // sort is stable, so whatever order arrives here is the order on screen.
  const rows = closedLineRows([PO(49, 'partially_received', [L(109, 3600, 0, { at: AT }), L(110, 2880, 0, { at: AT })])]);
  assert.deepEqual(rows.map(r => r.id), [110, 109], 'same instant → the line id breaks the tie, newest first');
});

test('an order closed as a whole is told apart from one its waivers finished', () => {
  const byWaiver = PO(51, 'closed', [L(120, 500, 200, { at: AT }), L(121, 300, 300)]);
  const asWhole = PO(52, 'closed', [L(130, 400, 0, { at: AT }), L(131, 250, 0), L(132, 100, 100)]);
  assert.equal(closedAsWhole(byWaiver), false);
  assert.equal(closedAsWhole(asWhole), true, 'line 131 still owes and nobody waived it — Close PO did');
  assert.equal(closedAsWhole(PO(53, 'open', [L(140, 10, 0)])), false, 'an open order is not closed at all');
  const [row] = closedLineRows([asWhole]);
  assert.equal(row.whole_closed, true);
  assert.equal(row.others_owing, 1, 'the form must say how many other lines stay closed');
});

test('the reopen dock names the pile — lines, orders and the balance coming back', () => {
  const rows = closedLineRows([
    PO(49, 'partially_received', [L(109, 3600, 0, { at: AT }), L(110, 2880, 0, { at: AT })]),
    PO(51, 'closed', [L(120, 500, 200, { at: '2026-09-11T09:00:00Z' })]),
  ]);
  assert.deepEqual(reopenSummary(rows), { lines: 3, orders: 2, waived: 6780 });
  assert.deepEqual(reopenSummary([]), { lines: 0, orders: 0, waived: 0 });
});

test('one of a unit reads singular — "1 die", never "1 dies"', () => {
  assert.equal(unitLabel(1, 'dies'), 'die');
  assert.equal(unitLabel(1, 'plates'), 'plate');
  assert.equal(unitLabel(1, 'sheets'), 'sheet');
  assert.equal(unitLabel(2, 'dies'), 'dies');
  assert.equal(unitLabel(0, 'plates'), 'plates', 'none of them is still plural');
  assert.equal(unitLabel(1, 'nos'), 'nos', 'an abbreviation is not a plural');
  assert.equal(unitLabel(1, ''), '');
});

test('the closed-lines view and the reopen form count units in words that agree', () => {
  assert.match(read('client/src/components/ClosedPoLinesView.jsx'), /unitLabel\(/);
  assert.match(read('client/src/components/ReopenPoLines.jsx'), /unitLabel\(/);
});

// ── the server spelling, against an in-memory stand-in ─────────────────────
//
// Just the two tables the reopen touches. Unknown SQL throws, so an escape to
// the module-level pool cannot pass quietly.
function fakeDb({ pos, lines, closeAudit = null }) {
  const state = {
    pos: new Map(pos.map(p => [p.id, { ...p }])),
    lines: new Map(lines.map(l => [l.id,
      { closed_short: false, closed_reason: null, closed_by: null, closed_at: null, ...l }])),
    locks: [], audits: [],
  };
  const linesOf = poId => [...state.lines.values()]
    .filter(l => l.purchase_order_id === poId).sort((a, b) => a.id - b.id);
  const qc = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT id, purchase_order_id, closed_short FROM po_lines WHERE id=ANY\(\$1::int\[\]\)$/.test(s)) {
      return params[0].map(id => state.lines.get(id)).filter(Boolean)
        .map(({ id, purchase_order_id, closed_short }) => ({ id, purchase_order_id, closed_short }));
    }
    if (/^SELECT \* FROM po_lines WHERE purchase_order_id=\$1 ORDER BY id FOR UPDATE$/.test(s)) {
      return linesOf(params[0]).map(l => ({ ...l }));
    }
    if (/^UPDATE po_lines SET closed_short=TRUE/.test(s)) {
      const [reason, by, at, ids] = params;
      for (const id of ids) Object.assign(state.lines.get(id), { closed_short: true, closed_reason: reason, closed_by: by, closed_at: at ?? 'now' });
      return [];
    }
    if (/^UPDATE po_lines SET closed_short=FALSE/.test(s)) {
      for (const id of params[0]) Object.assign(state.lines.get(id), { closed_short: false, closed_reason: null, closed_by: null, closed_at: null });
      return [];
    }
    if (s === 'SELECT qty, received_qty, closed_short FROM po_lines WHERE purchase_order_id=$1') {
      return linesOf(params[0]).map(({ qty, received_qty, closed_short }) => ({ qty, received_qty, closed_short }));
    }
    if (s === 'UPDATE purchase_orders SET status=$1 WHERE id=$2') {
      state.pos.get(params[1]).status = params[0];
      return [];
    }
    if (/^INSERT INTO audit_log/.test(s)) {
      state.audits.push({ entity: params[0], id: params[1], action: params[2], detail: params[3], user: params[4] });
      return [];
    }
    throw new Error(`fake qc got an unexpected statement: ${s}`);
  };
  const oc = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE') {
      state.locks.push(params[0]);
      const po = state.pos.get(params[0]);
      return po ? { ...po } : null;
    }
    if (/FROM audit_log WHERE entity='purchase_order' AND entity_id=\$1 AND action='close'/.test(s)) return closeAudit;
    throw new Error(`fake oc got an unexpected statement: ${s}`);
  };
  return { qc, oc, state };
}

const WHO = 'Anik Dua (MD)';

test('reopening asks why, like closing does', async () => {
  const { qc, oc, state } = fakeDb({
    pos: [{ id: 49, po_number: 'CI-VPO-0049', status: 'partially_received' }],
    lines: [{ id: 109, purchase_order_id: 49, qty: 3600, received_qty: 0, closed_short: true }],
  });
  await assert.rejects(() => reopenPoLines(qc, oc, { lineIds: [109], reason: '   ', user: WHO }),
    e => e.status === 400 && /why/i.test(e.message));
  assert.equal(state.lines.get(109).closed_short, true, 'refused before the line was touched');
  await assert.rejects(() => reopenPoLines(qc, oc, { lineIds: [], reason: 'x', user: WHO }),
    e => e.status === 400);
});

test('lines from several orders reopen together, each order re-reading its own status', async () => {
  const { qc, oc, state } = fakeDb({
    pos: [
      { id: 51, po_number: 'CI-VPO-0051', status: 'closed' },
      { id: 49, po_number: 'CI-VPO-0049', status: 'partially_received' },
    ],
    lines: [
      { id: 108, purchase_order_id: 49, qty: 1000, received_qty: 400 },
      { id: 109, purchase_order_id: 49, qty: 3600, received_qty: 0, closed_short: true, closed_reason: 'vendor cannot supply', closed_by: 'Anik' },
      { id: 120, purchase_order_id: 51, qty: 500, received_qty: 200, closed_short: true },
      { id: 121, purchase_order_id: 51, qty: 300, received_qty: 300 },
    ],
  });
  const out = await reopenPoLines(qc, oc, { lineIds: [120, 109], reason: 'vendor is shipping after all', user: WHO });
  assert.deepEqual(state.locks, [49, 51], 'orders lock in id order, whatever order the lines were picked in');
  assert.equal(state.lines.get(109).closed_short, false);
  assert.equal(state.lines.get(109).closed_reason, null, 'the waiver story clears with the waiver');
  assert.equal(state.lines.get(120).closed_short, false);
  assert.equal(state.lines.get(121).closed_short, false, 'a waiver-finished order had nothing else given up');
  assert.equal(state.pos.get(49).status, 'partially_received');
  assert.equal(state.pos.get(51).status, 'partially_received', 'the order its waiver finished is receivable again');
  assert.equal(out.reopened, 2);
  assert.equal(out.skipped, 0);
  assert.deepEqual(out.orders.map(o => [o.po_number, o.reopened, o.kept_closed, o.status]), [
    ['CI-VPO-0049', 1, 0, 'partially_received'],
    ['CI-VPO-0051', 1, 0, 'partially_received'],
  ]);
  assert.equal(state.audits.length, 2, 'one audit row per order');
  for (const a of state.audits) {
    assert.equal(a.entity, 'purchase_order');
    assert.equal(a.action, 'reopen_lines');
    assert.equal(a.user, WHO);
    assert.match(a.detail, /vendor is shipping after all/, 'the reason is on record');
  }
  assert.match(state.audits[0].detail, /line 109: 3600 back to pending/);
});

test('an order closed as a whole keeps its other lines closed when one comes back', async () => {
  const { qc, oc, state } = fakeDb({
    pos: [{ id: 52, po_number: 'CI-VPO-0052', status: 'closed' }],
    lines: [
      { id: 130, purchase_order_id: 52, qty: 400, received_qty: 0, closed_short: true, closed_reason: 'size discontinued' },
      { id: 131, purchase_order_id: 52, qty: 250, received_qty: 0 },
      { id: 132, purchase_order_id: 52, qty: 100, received_qty: 100 },
    ],
    closeAudit: { user_name: 'Rohit', created_at: '2026-09-05T10:00:00Z', detail: null },
  });
  const out = await reopenPoLines(qc, oc, { lineIds: [130], reason: 'vendor found stock', user: WHO });
  assert.equal(state.lines.get(130).closed_short, false, 'the line asked for comes back');
  const kept = state.lines.get(131);
  assert.equal(kept.closed_short, true, 'Close PO gave up on 131 too — reopening 130 must not resurrect it');
  assert.match(kept.closed_reason, /closed with the whole order/i);
  assert.equal(kept.closed_by, 'Rohit', 'attributed to whoever closed the order, not to the reopener');
  assert.equal(kept.closed_at, '2026-09-05T10:00:00Z');
  assert.equal(state.lines.get(132).closed_short, false, 'a fully received line owes nothing and is left alone');
  assert.equal(state.pos.get(52).status, 'partially_received', 'the order is live again for the reopened line');
  assert.equal(out.orders[0].kept_closed, 1);
  assert.match(state.audits[0].detail, /1 other unreceived line kept closed/);
});

test('a pick that is not closed short is skipped and reported, never an error', async () => {
  const { qc, oc, state } = fakeDb({
    pos: [{ id: 49, po_number: 'CI-VPO-0049', status: 'partially_received' }],
    lines: [
      { id: 108, purchase_order_id: 49, qty: 1000, received_qty: 400 },
      { id: 109, purchase_order_id: 49, qty: 3600, received_qty: 0, closed_short: true },
    ],
  });
  const out = await reopenPoLines(qc, oc, { lineIds: [108, 109], reason: 'x', user: WHO });
  assert.equal(out.reopened, 1);
  assert.equal(out.skipped, 1);
  assert.equal(state.lines.get(108).closed_short, false);
  assert.equal(state.lines.get(109).closed_short, false);
});

test('nothing closed among the picks is refused with a reload message', async () => {
  const { qc, oc } = fakeDb({
    pos: [{ id: 49, po_number: 'CI-VPO-0049', status: 'open' }],
    lines: [{ id: 108, purchase_order_id: 49, qty: 1000, received_qty: 0 }],
  });
  await assert.rejects(() => reopenPoLines(qc, oc, { lineIds: [108], reason: 'x', user: WHO }),
    e => e.status === 409 && /reload/i.test(e.message));
});

test('a line that is gone, or on another order than the door, is refused', async () => {
  const { qc, oc } = fakeDb({
    pos: [{ id: 49, po_number: 'CI-VPO-0049', status: 'open' }, { id: 51, po_number: 'CI-VPO-0051', status: 'closed' }],
    lines: [{ id: 120, purchase_order_id: 51, qty: 500, received_qty: 200, closed_short: true }],
  });
  await assert.rejects(() => reopenPoLines(qc, oc, { lineIds: [999], reason: 'x', user: WHO }),
    e => e.status === 409 && /reload/i.test(e.message));
  await assert.rejects(() => reopenPoLines(qc, oc, { lineIds: [120], reason: 'x', user: WHO, poId: 49 }),
    e => e.status === 409, 'the per-order door cannot reach a line on another order');
});

// ── the wiring ──────────────────────────────────────────────────────────────

test('one spelling: every board reopen door runs reopenPoLines, and only it clears a waiver', () => {
  const route = read('server/src/routes/procurement.js');
  assert.match(route, /export async function reopenPoLines/);
  assert.match(route, /r\.post\('\/po-lines\/reopen', canBuy/, 'the register reopens across orders through one door');
  assert.match(route, /r\.post\('\/purchase-orders\/:id\/lines\/reopen', canBuy/, 'the per-order door stays');
  const calls = (route.match(/tx\(\(qc, oc\) => reopenPoLines\(qc, oc,/g) || []).length;
  assert.equal(calls, 2, `both doors must share the helper, found ${calls} call(s)`);
  const clears = (route.match(/SET closed_short=FALSE/g) || []).length;
  assert.equal(clears, 1, `a second waiver-clearing UPDATE is a second spelling of reopen (found ${clears})`);
});

test('the tooling reopen asks why too, and keeps it on record', () => {
  // Both tooling doors now run reopenToolingPoLines (see
  // tooling-closed-lines.test.js), so the rule lives in the helper.
  const route = read('server/src/routes/tooling-procurement.js');
  const from = route.indexOf('export async function reopenToolingPoLines');
  assert.ok(from > 0, 'the tooling reopen helper is missing');
  const helper = route.slice(from, route.indexOf('\nr.', from));
  assert.match(helper, /Record why these lines are being reopened/);
  assert.match(helper, /'reopen_lines',[\s\S]*?\$\{why\}/, 'the audit row must carry the reason');
});

test('the PO register hides closed lines and gives them their own view', () => {
  const page = read('client/src/pages/Procurement.jsx');
  assert.match(page, /\{ key: 'closed', label: 'Closed lines'/, 'Purchase Orders needs a Closed lines view');
  assert.match(page, /openLinesOf\(po\)\.map\(l =>/, 'a PO card must list only the lines still in play');
  assert.doesNotMatch(page, /\{po\.lines\.map\(l =>/, 'a card still maps every line, closed ones included');
  assert.match(page, /closedLineRows\(pos\)/, 'the view reads the one flattening');
  assert.match(page, /<ReopenPoLinesModal/, 'reopen goes through the form');
  assert.match(page, /'\/po-lines\/reopen', \{ line_ids, reason \}/);
  assert.match(page, /key: 'waived', label: 'Waived'/, 'the view says what was waived, not a bare 0');
});

test('every "still owed" filter on the board page leaves closed-short lines out', () => {
  const page = read('client/src/pages/Procurement.jsx');
  const filters = page.match(/\.filter\(l => l\.received_qty < l\.qty[^)]*\)/g) || [];
  assert.ok(filters.length >= 2, `expected the GRN prefills to be found, got ${filters.length}`);
  for (const f of filters) assert.match(f, /!l\.closed_short/, `${f} offers a waived line`);
});

test('the close modal keeps closed lines out of its list, and reopens only through the form', () => {
  const modal = read('client/src/components/ClosePoLines.jsx');
  assert.doesNotMatch(modal, /onReopenLines\(\[line\.id\]\)/, 'the one-click reopen skipped the form');
  assert.doesNotMatch(modal, /<span>Closed short<\/span>/, 'closed lines are listed inline again');
  assert.match(modal, /<ReopenPoLinesModal/);
});

test('the reopen form ticks lines, asks why, and says where the balance goes', () => {
  const form = read('client/src/components/ReopenPoLines.jsx');
  assert.match(form, /type="checkbox"/);
  assert.match(form, /disabled=\{busy \|\| !picked\.size \|\| !reason\.trim\(\)\}/, 'no reopen without a line and a reason');
  assert.match(form, /Pendency/, 'the form says the balance goes back to Pendency');
  assert.match(form, /onReopen\(\[\.\.\.picked\], reason\.trim\(\)\)/);
});

test('all three registers hand the reason to their reopen door', () => {
  for (const file of ['client/src/components/PlatesLifecycle.jsx', 'client/src/components/ToolingProcurement.jsx']) {
    const source = read(file);
    assert.match(source, /onReopenLines=\{\(line_ids, reason\) =>/, `${file} drops the reason`);
    assert.match(source, /lines\/reopen[^\n]*\{ line_ids, reason \}/, `${file} does not send the reason`);
  }
  assert.match(read('client/src/pages/Procurement.jsx'), /onReopenLines=\{\(line_ids, reason\) =>/);
});
