import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reopenToolingPoLines } from './routes/tooling-procurement.js';

// ── Plates, dies and blocks: Closed lines + the reopen form ─────────────────
//
// The board's Closed lines view, mirrored into the tooling registers. The
// reopen had to grow up on the way: closing a PLATE line detaches its
// unreceived plates (they go back to Approved so the job can reuse the rack or
// buy again), and the plate receipt door only receives plates still attached to
// the line — so a bare reopen put plates back in Pendency that no GRN could
// ever receive. A die/block requirement released at close stayed Approved, so
// the reopened line and a fresh PO could both buy it. The reopen now puts back
// what the close took, when it safely can, and refuses when it cannot.

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

// Just the tables the reopen touches. Unknown SQL throws, so an escape to the
// module-level pool cannot pass quietly.
function fakeTooling({ pos = [], lines = [], requests = [], masters = [], components = [] }) {
  const state = {
    pos: new Map(pos.map(p => [p.id, { status: 'open', vendor_id: 5, ...p }])),
    lines: new Map(lines.map(l => [l.id, { closed_short: false, closed_reason: null, closed_by: null,
      closed_at: null, received_qty: 0, tooling_request_id: null, ...l }])),
    requests: new Map(requests.map(r => [r.id, { status: 'procurement', ...r }])),
    masters: new Map(masters.map(m => [m.id, m])),
    components: new Map(components.map(c => [c.id, { po_line_id: null, ...c }])),
    locks: [], audits: [], events: [],
  };
  const linesOf = poId => [...state.lines.values()]
    .filter(l => l.purchase_order_id === poId).sort((a, b) => a.id - b.id);
  const qc = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'SELECT pl.id, pl.purchase_order_id, po.family FROM tooling_po_lines pl JOIN tooling_purchase_orders po ON po.id=pl.purchase_order_id WHERE pl.id=ANY($1::int[])') {
      return params[0].map(id => state.lines.get(id)).filter(Boolean)
        .map(l => ({ id: l.id, purchase_order_id: l.purchase_order_id, family: state.pos.get(l.purchase_order_id).family }));
    }
    if (s === 'SELECT * FROM tooling_po_lines WHERE purchase_order_id=$1 ORDER BY id FOR UPDATE') {
      return linesOf(params[0]).map(l => ({ ...l }));
    }
    if (s === "SELECT prc.id FROM plate_request_components prc JOIN plate_masters pm ON pm.id=prc.plate_master_id WHERE prc.tooling_request_id=$1 AND prc.status='approved' AND prc.po_line_id IS NULL AND pm.inventory_item_id=$2 ORDER BY prc.sequence_no FOR UPDATE OF prc") {
      const [requestId, itemId] = params;
      return [...state.components.values()]
        .filter(c => c.tooling_request_id === requestId && c.status === 'approved' && c.po_line_id == null
          && state.masters.get(c.plate_master_id)?.inventory_item_id === itemId)
        .sort((a, b) => a.sequence_no - b.sequence_no).map(c => ({ id: c.id }));
    }
    if (s === "UPDATE plate_request_components SET status='po_created', po_line_id=$1, updated_at=now() WHERE id=ANY($2::int[])") {
      for (const id of params[1]) Object.assign(state.components.get(id), { status: 'po_created', po_line_id: params[0] });
      return [];
    }
    if (s === "UPDATE tooling_requests SET approval_status=$1, status='procurement', po_number=$2, vendor_id=$3, updated_at=now() WHERE id=$4") {
      Object.assign(state.requests.get(params[3]), { approval_status: params[0], status: 'procurement', po_number: params[1], vendor_id: params[2] });
      return [];
    }
    if (s === "UPDATE tooling_requests SET approval_status='converted', status='procurement', po_number=$1, vendor_id=$2, updated_at=now() WHERE id=$3") {
      Object.assign(state.requests.get(params[2]), { approval_status: 'converted', status: 'procurement', po_number: params[0], vendor_id: params[1] });
      return [];
    }
    if (/^INSERT INTO tooling_request_events/.test(s)) {
      state.events.push({ request: params[0], action: params[1], note: params[7] });
      return [];
    }
    if (/^UPDATE tooling_po_lines SET closed_short=FALSE/.test(s)) {
      for (const id of params[0]) Object.assign(state.lines.get(id), { closed_short: false, closed_reason: null, closed_by: null, closed_at: null });
      return [];
    }
    if (s === 'SELECT qty,received_qty,closed_short FROM tooling_po_lines WHERE purchase_order_id=$1') {
      return linesOf(params[0]).map(({ qty, received_qty, closed_short }) => ({ qty, received_qty, closed_short }));
    }
    if (s === 'UPDATE tooling_purchase_orders SET status=$1, updated_at=now() WHERE id=$2') {
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
    if (s === 'SELECT * FROM tooling_purchase_orders WHERE id=$1 AND family=$2 FOR UPDATE') {
      state.locks.push(params[0]);
      const po = state.pos.get(params[0]);
      return po && po.family === params[1] ? { ...po } : null;
    }
    if (s === 'SELECT * FROM tooling_requests WHERE id=$1 FOR UPDATE') {
      const request = state.requests.get(params[0]);
      return request ? { ...request } : null;
    }
    if (s === "SELECT po.po_number, po.vendor_id FROM plate_request_components prc JOIN tooling_po_lines pl ON pl.id=prc.po_line_id JOIN tooling_purchase_orders po ON po.id=pl.purchase_order_id WHERE prc.tooling_request_id=$1 AND po.status<>'reversed' ORDER BY po.id DESC LIMIT 1") {
      const held = [...state.components.values()]
        .filter(c => c.tooling_request_id === params[0] && c.po_line_id != null)
        .map(c => state.pos.get(state.lines.get(c.po_line_id).purchase_order_id))
        .filter(po => po.status !== 'reversed')
        .sort((a, b) => b.id - a.id);
      return held[0] ? { po_number: held[0].po_number, vendor_id: held[0].vendor_id } : null;
    }
    throw new Error(`fake oc got an unexpected statement: ${s}`);
  };
  return { qc, oc, state };
}

const WHO = 'Anik Dua (MD)';

// A plate set of three, closed short with nothing received: its three plates
// went back to Approved. A fourth plate of ANOTHER size sits on the same job
// and was never on this set.
const plateSet = (overrides = {}) => ({
  pos: [{ id: 80, po_number: 'CI-PL-PO-0080', family: 'plate', status: 'closed', vendor_id: 5 }],
  lines: [{ id: 800, purchase_order_id: 80, qty: 3, received_qty: 0, closed_short: true,
    closed_reason: 'artwork changed', tooling_request_id: 8000, inventory_item_id: 11 }],
  requests: [{ id: 8000, request_number: 'CI-TR-0800', approval_status: 'approved', po_number: null, vendor_id: null }],
  masters: [{ id: 101, inventory_item_id: 11 }, { id: 102, inventory_item_id: 12 }],
  components: [
    { id: 1, tooling_request_id: 8000, sequence_no: 1, status: 'approved', plate_master_id: 101 },
    { id: 2, tooling_request_id: 8000, sequence_no: 2, status: 'approved', plate_master_id: 101 },
    { id: 3, tooling_request_id: 8000, sequence_no: 3, status: 'approved', plate_master_id: 101 },
    { id: 4, tooling_request_id: 8000, sequence_no: 4, status: 'approved', plate_master_id: 102 },
  ],
  ...overrides,
});

test('the tooling reopen asks why, like the close does', async () => {
  const { qc, oc, state } = fakeTooling(plateSet());
  await assert.rejects(() => reopenToolingPoLines(qc, oc, { family: 'plate', lineIds: [800], reason: '  ', user: WHO }),
    e => e.status === 400 && /why/i.test(e.message));
  assert.equal(state.lines.get(800).closed_short, true, 'refused before anything moved');
  await assert.rejects(() => reopenToolingPoLines(qc, oc, { family: 'plate', lineIds: [], reason: 'x', user: WHO }),
    e => e.status === 400);
});

test('a plate set gets its released plates back while the job has not re-sourced them', async () => {
  const { qc, oc, state } = fakeTooling(plateSet());
  const out = await reopenToolingPoLines(qc, oc, { family: 'plate', lineIds: [800], reason: 'vendor made them anyway', user: WHO });
  assert.equal(state.lines.get(800).closed_short, false);
  for (const id of [1, 2, 3]) {
    assert.deepEqual([state.components.get(id).status, state.components.get(id).po_line_id], ['po_created', 800],
      `plate ${id} must be back on the set, or the GRN has nothing to receive`);
  }
  assert.deepEqual([state.components.get(4).status, state.components.get(4).po_line_id], ['approved', null],
    'a plate of another size was never on this set and stays where it was');
  const request = state.requests.get(8000);
  assert.deepEqual([request.approval_status, request.po_number, request.vendor_id], ['converted', 'CI-PL-PO-0080', 5],
    'the requirement is bought again — on this order — so nobody buys it twice');
  assert.equal(state.pos.get(80).status, 'open');
  assert.equal(out.reopened, 1);
  assert.equal(out.reattached_plates, 3);
  assert.ok(state.events.some(e => e.request === 8000 && e.action === 'reopen_po_line'), 'the requirement log says why it came back');
  assert.match(state.audits[0].detail, /3 plates back on their set/);
  assert.match(state.audits[0].detail, /vendor made them anyway/);
});

test('a plate set is refused when its plates were re-sourced after it closed', async () => {
  const data = plateSet();
  data.pos.push({ id: 90, po_number: 'CI-PL-PO-0090', family: 'plate', status: 'open', vendor_id: 6 });
  data.lines.push({ id: 900, purchase_order_id: 90, qty: 1, tooling_request_id: 8000, inventory_item_id: 11 });
  data.components[2] = { id: 3, tooling_request_id: 8000, sequence_no: 3, status: 'po_created', plate_master_id: 101, po_line_id: 900 };
  const { qc, oc, state } = fakeTooling(data);
  await assert.rejects(() => reopenToolingPoLines(qc, oc, { family: 'plate', lineIds: [800], reason: 'x', user: WHO }),
    e => e.status === 409 && /re-sourced/.test(e.message));
  assert.equal(state.lines.get(800).closed_short, true, 'the set stays closed');
  assert.deepEqual([state.components.get(1).status, state.components.get(1).po_line_id], ['approved', null], 'nothing re-attached');
  assert.equal(state.audits.length, 0);
});

test('a plate set is refused when its plates can no longer be told apart', async () => {
  const data = plateSet();
  data.components[3] = { id: 4, tooling_request_id: 8000, sequence_no: 4, status: 'approved', plate_master_id: 101 };
  const { qc, oc, state } = fakeTooling(data);
  await assert.rejects(() => reopenToolingPoLines(qc, oc, { family: 'plate', lineIds: [800], reason: 'x', user: WHO }),
    e => e.status === 409 && /told apart/.test(e.message));
  assert.equal(state.lines.get(800).closed_short, true);
});

test('a direct plate line with no requirement behind it simply reopens', async () => {
  const { qc, oc, state } = fakeTooling({
    pos: [{ id: 81, po_number: 'CI-PL-PO-0081', family: 'plate', status: 'closed' }],
    lines: [{ id: 810, purchase_order_id: 81, qty: 2, closed_short: true, inventory_item_id: 11 }],
  });
  const out = await reopenToolingPoLines(qc, oc, { family: 'plate', lineIds: [810], reason: 'stock plates after all', user: WHO });
  assert.equal(state.lines.get(810).closed_short, false);
  assert.equal(out.reattached_plates, 0);
});

test('die lines on several orders reopen together, a released requirement back on its order', async () => {
  const { qc, oc, state } = fakeTooling({
    pos: [
      { id: 70, po_number: 'CI-DI-PO-0070', family: 'die', status: 'closed', vendor_id: 5 },
      { id: 60, po_number: 'CI-DI-PO-0060', family: 'die', status: 'partially_received', vendor_id: 6 },
      { id: 99, po_number: 'CI-DI-PO-0099', family: 'die', status: 'open', vendor_id: 7 },
    ],
    lines: [
      { id: 700, purchase_order_id: 70, qty: 2, closed_short: true, tooling_request_id: 7000, inventory_item_id: 21 },
      { id: 600, purchase_order_id: 60, qty: 1, closed_short: true, tooling_request_id: 6000, inventory_item_id: 22 },
      { id: 601, purchase_order_id: 60, qty: 2, received_qty: 2, tooling_request_id: 6001, inventory_item_id: 23 },
      { id: 990, purchase_order_id: 99, qty: 1, tooling_request_id: 6000, inventory_item_id: 22 },
    ],
    requests: [
      // Released at close — Approved, on no order.
      { id: 7000, request_number: 'CI-TR-0700', approval_status: 'approved', po_number: null, vendor_id: null },
      // Re-sourced since: already converted on another order.
      { id: 6000, request_number: 'CI-TR-0600', approval_status: 'converted', po_number: 'CI-DI-PO-0099', vendor_id: 7 },
    ],
  });
  const out = await reopenToolingPoLines(qc, oc, { family: 'die', lineIds: [700, 600], reason: 'vendor shipping after all', user: WHO });
  assert.deepEqual(state.locks, [60, 70], 'orders lock in id order, whatever order the lines were picked in');
  assert.equal(state.lines.get(700).closed_short, false);
  assert.equal(state.lines.get(600).closed_short, false);
  assert.equal(state.pos.get(60).status, 'partially_received');
  assert.equal(state.pos.get(70).status, 'open');
  assert.deepEqual([state.requests.get(7000).approval_status, state.requests.get(7000).po_number, state.requests.get(7000).vendor_id],
    ['converted', 'CI-DI-PO-0070', 5], 'the released requirement is back on the order that will now deliver it');
  assert.deepEqual([state.requests.get(6000).approval_status, state.requests.get(6000).po_number], ['converted', 'CI-DI-PO-0099'],
    'a requirement bought elsewhere since is never pulled off that order');
  assert.equal(out.reopened, 2);
  assert.equal(out.relinked_requirements, 1);
  assert.deepEqual(out.orders.map(o => [o.po_number, o.reopened, o.status]),
    [['CI-DI-PO-0060', 1, 'partially_received'], ['CI-DI-PO-0070', 1, 'open']]);
  assert.equal(state.audits.length, 2, 'one audit row per order');
  for (const a of state.audits) {
    assert.equal(a.entity, 'tooling_purchase_order');
    assert.equal(a.action, 'reopen_lines');
    assert.match(a.detail, /vendor shipping after all/);
  }
  assert.match(state.audits.find(a => a.id === 70).detail, /1 requirement back on this order/);
});

test('a reversed order, or one closed as a whole, cannot have a line pulled back', async () => {
  const reversed = fakeTooling({
    pos: [{ id: 83, po_number: 'CI-DI-PO-0083', family: 'die', status: 'reversed' }],
    lines: [{ id: 830, purchase_order_id: 83, qty: 1, closed_short: true }],
  });
  await assert.rejects(() => reopenToolingPoLines(reversed.qc, reversed.oc, { family: 'die', lineIds: [830], reason: 'x', user: WHO }),
    e => e.status === 409 && /reversed/.test(e.message));
  const whole = fakeTooling({
    pos: [{ id: 84, po_number: 'CI-DI-PO-0084', family: 'die', status: 'closed' }],
    lines: [
      { id: 840, purchase_order_id: 84, qty: 1, closed_short: true },
      { id: 841, purchase_order_id: 84, qty: 3, received_qty: 1 },
    ],
  });
  await assert.rejects(() => reopenToolingPoLines(whole.qc, whole.oc, { family: 'die', lineIds: [840], reason: 'x', user: WHO }),
    e => e.status === 409 && /as a whole/.test(e.message));
  assert.equal(whole.state.lines.get(840).closed_short, true);
});

test('a line of another family, on another order than the door, or gone, is refused', async () => {
  const { qc, oc } = fakeTooling(plateSet({
    pos: [
      { id: 80, po_number: 'CI-PL-PO-0080', family: 'plate', status: 'closed' },
      { id: 85, po_number: 'CI-PL-PO-0085', family: 'plate', status: 'open' },
    ],
  }));
  await assert.rejects(() => reopenToolingPoLines(qc, oc, { family: 'die', lineIds: [800], reason: 'x', user: WHO }),
    e => e.status === 409 && /reload/i.test(e.message), 'the die door cannot reopen a plate line');
  await assert.rejects(() => reopenToolingPoLines(qc, oc, { family: 'plate', lineIds: [800], reason: 'x', user: WHO, poId: 85 }),
    e => e.status === 409, 'the one-order door cannot reach a line on another order');
  await assert.rejects(() => reopenToolingPoLines(qc, oc, { family: 'plate', lineIds: [999], reason: 'x', user: WHO }),
    e => e.status === 409 && /reload/i.test(e.message));
});

test('a pick that is not closed short narrows, and nothing closed at all is refused', async () => {
  const { qc, oc, state } = fakeTooling({
    pos: [{ id: 86, po_number: 'CI-BL-PO-0086', family: 'block', status: 'partially_received' }],
    lines: [
      { id: 860, purchase_order_id: 86, qty: 2, received_qty: 1 },
      { id: 861, purchase_order_id: 86, qty: 1, closed_short: true },
    ],
  });
  const out = await reopenToolingPoLines(qc, oc, { family: 'block', lineIds: [860, 861], reason: 'x', user: WHO });
  assert.equal(out.reopened, 1);
  assert.equal(out.skipped, 1);
  assert.equal(state.lines.get(861).closed_short, false);
  await assert.rejects(() => reopenToolingPoLines(qc, oc, { family: 'block', lineIds: [860], reason: 'x', user: WHO }),
    e => e.status === 409 && /reload/i.test(e.message));
});

// ── the wiring ──────────────────────────────────────────────────────────────

test('one spelling: both tooling reopen doors run reopenToolingPoLines, and only it clears a waiver', () => {
  const route = read('server/src/routes/tooling-procurement.js');
  assert.match(route, /export async function reopenToolingPoLines/);
  assert.match(route, /r\.post\('\/tooling\/procurement\/:family\/po-lines\/reopen', canBuy/,
    'the Closed lines view reopens across orders through one door');
  assert.match(route, /r\.post\('\/tooling\/procurement\/:family\/purchase-orders\/:id\/lines\/reopen', canBuy/);
  const calls = (route.match(/tx\(\(qc, oc\) => reopenToolingPoLines\(qc, oc,/g) || []).length;
  assert.equal(calls, 2, `both doors must share the helper, found ${calls} call(s)`);
  const clears = (route.match(/SET closed_short=FALSE/g) || []).length;
  assert.equal(clears, 1, `a second waiver-clearing UPDATE is a second spelling of reopen (found ${clears})`);
});

test('the close and the reopen re-point a plate requirement through one helper', () => {
  const route = read('server/src/routes/tooling-procurement.js');
  assert.match(route, /async function repointPlateRequirement/);
  const calls = (route.match(/repointPlateRequirement\(qc, oc,/g) || []).length;
  assert.ok(calls >= 2, `the close and the reopen must share the re-point, found ${calls} call(s)`);
});

test('both tooling registers list only open lines and gather the closed ones in their own view', () => {
  const plates = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(plates, /<ClosedPoLinesView/);
  assert.match(plates, /openLinesOf\(row\)\.map\(\(line, index\) =>/, 'a plate PO row must list only sets still in play');
  assert.doesNotMatch(plates, /row\.lines\.map\(\(line, index\) =>/, 'the plate register still maps every set, closed ones included');
  const tooling = read('client/src/components/ToolingProcurement.jsx');
  assert.match(tooling, /<ClosedPoLinesView/);
  assert.match(tooling, /\{ key: 'closed', label: 'Closed lines'/, 'dies/blocks Purchase Orders needs a Closed lines view');
  assert.match(tooling, /openLinesOf\(po\)\.map\(\(line, index\) =>/, 'a die/block PO row must list only lines still in play');
  assert.doesNotMatch(tooling, /po\.lines\.map\(\(line, index\) =>/, 'the die/block register still maps every line');
});

test('the tooling Closed lines view reopens through the form, across orders, with a reason', () => {
  const view = read('client/src/components/ClosedPoLinesView.jsx');
  assert.match(view, /closedLineRows\(/, 'the view reads the one flattening');
  assert.match(view, /<ReopenPoLinesModal/);
  assert.match(view, /<SelectionDock/);
  assert.match(view, /`\/tooling\/procurement\/\$\{family\}\/po-lines\/reopen`, \{ line_ids, reason \}/);
  assert.match(view, /defaultSort=\{\{ key: 'closed_at', dir: 'desc' \}\}/, 'newest closure first, declared');
  assert.match(view, /key: 'waived', label: 'Waived'/);
});

test('the reopen notes tell the truth about what comes back', () => {
  const plates = read('client/src/components/PlatesLifecycle.jsx');
  assert.doesNotMatch(plates, /does not re-attach them/, 'reopening DOES put the released plates back now');
  assert.doesNotMatch(plates, /not re-attached on reopen/, 'the close note must not promise the opposite either');
  const tooling = read('client/src/components/ToolingProcurement.jsx');
  assert.doesNotMatch(tooling, /does not re-link it/, 'reopening DOES put a released requirement back now');
  const form = read('client/src/components/ReopenPoLines.jsx');
  assert.match(form, /reattached_plates/, 'the toast says how many plates went back on their sets');
});
