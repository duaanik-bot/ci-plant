import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pendingOf, lineReceipt, toolingGrnLines } from '../../client/src/lib/toolingGrnSelection.js';
import { commitmentSummary } from '../../client/src/lib/poCommitment.js';

// ── Line-level "no more receipts" ─────────────────────────────────────────
//
// Closing a whole PO was the only way to stop one board arriving, so orders
// with one dead line sat open for ever, and the dead line kept counting as
// on-order everywhere. A line the buyer closes SHORT waives its unreceived
// balance: it leaves Pendency and every on-order figure, refuses receipts, and
// the order can finish. The same system serves boards, plates, dies and blocks.

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('a closed-short line owes nothing and can take no receipt (client spelling)', () => {
  assert.equal(pendingOf({ qty: 5, received_qty: 2 }), 3);
  assert.equal(pendingOf({ qty: 5, received_qty: 2, closed_short: true }), 0,
    'a waived balance is not pending');
  const [line] = toolingGrnLines({ lines: [{ id: 1, qty: 5, received_qty: 2, closed_short: true }] });
  assert.equal(line.receivable, false, 'the GRN form must not offer a closed line');
  const chip = lineReceipt({ qty: 4, received_qty: 2, closed_short: true, unit: 'nos' });
  assert.equal(chip.state, 'closed');
  assert.match(chip.label, /closed short/,
    '"2/4 closed" is a different fact from "2/4 pending" and the chip must say which');
});

test('the board register keeps ONE spelling of "where does this order stand"', () => {
  const route = read('server/src/routes/procurement.js');
  assert.match(route, /export function poCompletion/);
  assert.match(route, /l\.closed_short \|\| Number\(l\.received_qty\) >= Number\(l\.qty\)/);
  // The five inline copies this replaced must stay dead — a sixth spelling is
  // exactly how the closed-short rule would silently go missing on one path.
  assert.doesNotMatch(route, /every\(l => l\.received_qty >= l\.qty\)/,
    'an inline full-receipt derivation survives — route it through poCompletion');
  // And a finished order with a waiver reads closed, never received.
  assert.match(route, /lines\.some\(l => l\.closed_short\) \? 'closed' : 'received'/);
});

test('close and reopen exist per line, on the board and on every tooling family', () => {
  const board = read('server/src/routes/procurement.js');
  assert.match(board, /r\.post\('\/purchase-orders\/:id\/lines\/close', canBuy/);
  assert.match(board, /r\.post\('\/purchase-orders\/:id\/lines\/reopen', canBuy/);
  // Narrowing bulk: already-done lines are skipped, not an error.
  assert.match(board, /!l\.closed_short && Number\(l\.received_qty\) < Number\(l\.qty\)/);
  const tooling = read('server/src/routes/tooling-procurement.js');
  assert.match(tooling, /r\.post\('\/tooling\/procurement\/:family\/purchase-orders\/:id\/lines\/close', canBuy/);
  assert.match(tooling, /r\.post\('\/tooling\/procurement\/:family\/purchase-orders\/:id\/lines\/reopen', canBuy/);
});

test('every receive door refuses a closed-short line', () => {
  const board = read('server/src/routes/procurement.js');
  // /grns, /grns/bulk and the substitution commit each hold the door.
  assert.equal((board.match(/closed short — no more receipts were asked for/g) || []).length >= 2, true,
    'the single-line and bulk GRN doors must both refuse');
  assert.match(board, /ctx\.poLine\?\.closed_short/,
    'a substitution receipt lands on the line too and must be refused the same way');
  const tooling = read('server/src/routes/tooling-procurement.js');
  assert.match(tooling, /poLine\.closed_short/, 'the die/block receive loop must refuse');
  const plates = read('server/src/routes/plates.js');
  assert.match(plates, /poLine\.closed_short/, 'the plate receive door must refuse');
});

test('a waived line leaves Pendency and every on-order figure', () => {
  const board = read('server/src/routes/procurement.js');
  const boardPendency = board.slice(board.indexOf('AS pending_qty'));
  assert.match(boardPendency, /AND NOT pl\.closed_short/, 'board pendency still lists waived lines');
  const tooling = read('server/src/routes/tooling-procurement.js');
  const toolingPendency = tooling.slice(tooling.indexOf("'/tooling/procurement/:family/pendency'"));
  assert.match(toolingPendency, /AND NOT pl\.closed_short/, 'tooling pendency still lists waived lines');
  // On-order sums: materials list, stock strip, master-history, planning
  // coverage (×2 + the converted-PR EXISTS), verification, orders panel, both
  // tooling stock_ordered laterals. Each carries the exclusion; losing ANY one
  // resurrects board that will never arrive.
  for (const [file, atLeast] of [
    ['server/src/routes/inventory.js', 3],
    ['server/src/routes/master-history.js', 1],
    ['server/src/helpers.js', 3],
    ['server/src/routes/verification.js', 1],
    ['server/src/routes/orders.js', 1],
    ['server/src/routes/tooling-procurement.js', 2],
    ['server/src/routes/tooling.js', 1],
  ]) {
    const source = read(file);
    const hits = (source.match(/NOT (pl|tpl)\.closed_short/g) || []).length;
    assert.ok(hits >= atLeast, `${file}: expected ≥${atLeast} closed_short exclusions, found ${hits}`);
  }
});

test('closing a plate line releases its unreceived plates back to Approved', () => {
  const tooling = read('server/src/routes/tooling-procurement.js');
  // Without this, a waived plate sits in po_created for ever and its job can
  // never pass the printing readiness gate.
  assert.match(tooling, /UPDATE plate_request_components SET status='approved', po_line_id=NULL/);
  assert.match(tooling, /status IN \('po_created','ordered'\)/);
  // And the parent requirement is re-pointed the way the PO reverse does it:
  // converted while any live PO still holds its plates, approved otherwise.
  assert.match(tooling, /anchor \? 'converted' : 'approved'/);
});

test('the schema carries the waiver on both line tables, and the baseline knows it', () => {
  const migration = read('supabase/migrations/20260826090000_po_line_close_short.sql');
  assert.match(migration, /ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS closed_short/);
  assert.match(migration, /ALTER TABLE tooling_po_lines ADD COLUMN IF NOT EXISTS closed_short/);
  const baseline = read('supabase/migrations/0001_baseline_schema.sql');
  assert.match(baseline, /po_lines ADD COLUMN IF NOT EXISTS closed_short/,
    'init() gained the columns but the committed baseline was not regenerated — run npm run db:baseline');
});

test('all four registers open the same close-lines modal', () => {
  const modal = read('client/src/components/ClosePoLines.jsx');
  assert.match(modal, /no more receipts/i);
  assert.match(modal, /Reopen/);
  for (const file of [
    'client/src/pages/Procurement.jsx',
    'client/src/components/ToolingProcurement.jsx',
    'client/src/components/PlatesLifecycle.jsx',
  ]) {
    const source = read(file);
    assert.match(source, /ClosePoLinesModal/, `${file} does not mount the shared modal`);
    assert.match(source, /preselectId/, `${file}'s Pendency row door must pre-tick its line`);
  }
});

test('the board queue neither offers Receive nor pre-fills a GRN for a waived line', () => {
  const page = read('client/src/pages/Procurement.jsx');
  assert.match(page, /l\.received_qty < l\.qty && po\.status !== 'closed' && !l\.closed_short/,
    'the row Receive button must hide on a closed line');
  assert.match(page, /l\.received_qty < l\.qty && !l\.closed_short/,
    'the bulk GRN prefill must not offer a closed line');
  assert.match(page, /waived/, 'the Pending cell must say waived, not 0 — 0 reads as fully received');
});

// ── Releasing the jobs' incoming cover, with the buyer's approval ─────────

test('the impact the buyer approves is the impact the close can release — one spelling', () => {
  const route = read('server/src/routes/procurement.js');
  assert.match(route, /async function poLineAllocationImpact/);
  assert.match(route, /r\.post\('\/purchase-orders\/:id\/lines\/close-impact', canBuy/);
  // Both the preview and the close's validation call the same function; a
  // second spelling is how the panel would show one set and release another.
  const calls = (route.match(/poLineAllocationImpact\(po\.id/g) || []).length;
  assert.ok(calls >= 2, `expected the preview AND the close to share the query, found ${calls} call(s)`);
  // Anchored the same way GRN acceptance shrinks cover: requisition → PO,
  // scoped to the closing lines' materials.
  assert.match(route, /rq\.purchase_order_id=\$1\s*\n\s*AND ba\.material_id IN \(SELECT material_id FROM po_lines/);
});

test('a release shrinks partial and releases full — the GRN-acceptance spelling', () => {
  const route = read('server/src/routes/procurement.js');
  const close = route.slice(route.indexOf("'/purchase-orders/:id/lines/close'"));
  assert.match(close, /UPDATE board_allocations SET qty=\$1 WHERE id=\$2/,
    'an edited (partial) release must SHRINK the allocation, not delete it');
  assert.match(close, /SET status='released', released_by=\$1, released_at=now\(\)/,
    'a full release must use the released status the table already speaks');
  // And it is the buyer's list, validated — never everything by default.
  assert.match(close, /req\.body\.release_allocations/);
  assert.match(close, /no longer riding these lines/,
    'a stale tick must be refused with a reload message, not silently released');
});

test('every release tells the planners which JOB to plan again, with a live link', () => {
  const route = read('server/src/routes/procurement.js');
  const close = route.slice(route.indexOf("'/purchase-orders/:id/lines/close'"));
  assert.match(close, /role IN \('planner','admin'\)/);
  assert.match(close, /kind: 'po_line_closed_replan'/);
  assert.match(close, /link: `\/planning\?line=\$\{g\.order_line_id\}`/,
    'the deep link must land on the job — /planning?line= is read by Planning.jsx');
  // Grouped per job, not per allocation — two claims on one job is one buzz.
  assert.match(close, /byJob/);
});

test('the impact panel asks per job, editable, and never blocks the close', () => {
  const modal = read('client/src/components/ClosePoLines.jsx');
  assert.match(modal, /loadImpact/);
  assert.match(modal, /Jobs riding on these lines — plan again/);
  assert.match(modal, /type="number" min="0" max=\{row\.qty\}/,
    'the release quantity must be editable, capped at the cover that exists');
  assert.match(modal, /Re-reads as short once released — plan this job again\./);
  assert.match(modal, /shelf stock only/,
    'an empty impact is said out loud, and the close proceeds — no hard blocker');
  assert.match(modal, /Open job/);
  const board = read('client/src/pages/Procurement.jsx');
  assert.match(board, /lines\/close-impact/);
  assert.match(board, /release_allocations/);
});

test('the tooling families mirror the impact popup — one spelling, snapshot before release', () => {
  const route = read('server/src/routes/tooling-procurement.js');
  assert.match(route, /async function toolingLineImpact/);
  assert.match(route, /r\.post\('\/tooling\/procurement\/:family\/purchase-orders\/:id\/lines\/close-impact', canBuy/);
  const calls = (route.match(/toolingLineImpact\(family, po\.id/g) || []).length;
  assert.ok(calls >= 2, `preview AND close must share the query, found ${calls}`);
  // The snapshot runs BEFORE the component release, or the notification would
  // report zero plates released — they detach in the same transaction.
  const closeAt = route.indexOf('Snapshot the jobs standing on these lines');
  const releaseAt = route.indexOf("UPDATE plate_request_components SET status='approved'");
  assert.ok(closeAt > 0 && releaseAt > closeAt, 'impact must be read before the plate release detaches components');
});

test('a die requirement releases back to Approved only on a tick, only with nothing received', () => {
  const route = read('server/src/routes/tooling-procurement.js');
  assert.match(route, /req\.body\.release_requirements/);
  assert.match(route, /Number\(row\.received_qty\) === 0/,
    'a part-received requirement keeps its converted anchor — a quantity cannot half-re-approve');
  assert.match(route, /no longer eligible for release — reload and reselect/);
  // Plates never take the tick — their release is a functional necessity.
  assert.match(route, /family === 'plate' \? \[\]/);
});

test('every tooling job standing on a closing line buzzes the planners, with a live link', () => {
  const route = read('server/src/routes/tooling-procurement.js');
  const close = route.slice(route.indexOf("'/tooling/procurement/:family/purchase-orders/:id/lines/close'"));
  assert.match(close, /kind: 'po_line_closed_replan'/);
  assert.match(close, /role IN \('planner','admin'\)/);
  // /planning?line= where the requirement knows its job; the family hub
  // otherwise — never a link that opens nothing.
  assert.match(route, /row\.order_line_id \? `\/planning\?line=\$\{row\.order_line_id\}` : FAMILY_PAGE\[family\]/);
});

test('the modal serves all three impact flavours from one shape', () => {
  const modal = read('client/src/components/ClosePoLines.jsx');
  assert.match(modal, /row\.selectable/);
  assert.match(modal, /Released with the close — not optional/,
    'a plate row must say its release is automatic, not offer a tick it would ignore');
  // Each register maps its own vocabulary into the shared rows.
  const tooling = read('client/src/components/ToolingProcurement.jsx');
  assert.match(tooling, /lines\/close-impact/);
  assert.match(tooling, /release_requirements/);
  assert.match(tooling, /stays converted; raise a fresh requirement/);
  const plates = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(plates, /lines\/close-impact/);
  assert.match(plates, /return to Approved — reuse the rack or buy again\./);
});

// ── Ordered For: names in the column itself ───────────────────────────────

test('a commitment carries the product NAME for the cell, not only its code', () => {
  const s = commitmentSummary([{
    order_line_id: 1, product_code: 'SW-290', product_name: 'GLYCOMET TRIO FORTE',
    customer_name: 'Swiss Garnier', on_board: true,
  }]);
  assert.equal(s.names[0].name, 'SW-290', 'the code stays the short spelling');
  assert.equal(s.names[0].product_name, 'GLYCOMET TRIO FORTE',
    'the full name must ride along or the cell has nothing to print');
});

test('the Ordered For cell prints the product name, with the code beside it', () => {
  const cell = read('client/src/components/OrderedFor.jsx');
  assert.match(cell, /\{n\.product_name \|\| n\.name\}/,
    'the name must lead in the cell — the code alone was the old rendering');
  assert.match(cell, /n\.product_name && n\.name !== n\.product_name/,
    'the code rides after the name, and never repeats when they are the same');
  assert.match(cell, /font-mono text-\[10px\]/, 'the code is the lighter, mono suffix');
});
