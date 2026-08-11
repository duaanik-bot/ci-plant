// Editing and deleting a Plate PO — the two doors the module never had.
//
// SQL-only invariants asserted on the source, the same way board-hold-origin
// does and for the same reason: these rules live as literal SQL inside route
// handlers, this suite has no database harness, and a silent regression in any
// of them destroys a purchase record or strands a plate component.
//
// DELETE IS NOT REVERSE, and the distinction is the whole safety story.
// `reverse` is the auditable undo: it keeps the PO row, stamps it 'reversed'
// with a reason, and hands the components back to 'approved'. It is correct for
// a PO that has lived — one the vendor has seen, or one that has received
// plates. `delete` is for a PO that never should have existed at all: raised by
// mistake, spotted immediately, never sent, nothing received. Deleting one that
// HAS lived would erase the vendor's paper trail, so the guards below are what
// keep those two cases apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const code = s => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const plates = () => code(src('./routes/plates.js'));

// The body of one route handler, so a guard cannot accidentally pass by
// matching text that belongs to a neighbouring route.
function handler(source, method, path) {
  const at = source.indexOf(`r.${method}('${path}'`);
  if (at < 0) return null;
  const next = source.indexOf('\nr.', at + 1);
  return source.slice(at, next < 0 ? source.length : next);
}

test('a Plate PO can be edited', () => {
  const body = handler(plates(), 'put', '/plates/purchase-orders/:id');
  assert.ok(body, 'PUT /plates/purchase-orders/:id is missing — a PO raised with the wrong vendor, '
    + 'date or rate can only be reversed and retyped, which burns a PO number for a typo');
  assert.match(body, /canBuy/, 'editing a PO is buying work and must carry the same role gate as raising one');
});

test('editing refuses a PO that is reversed or has received plates', () => {
  const body = handler(plates(), 'put', '/plates/purchase-orders/:id');
  assert.match(body, /reversed/,
    'a reversed PO is history — editing one rewrites a document the vendor was already told was cancelled');
  assert.match(body, /received_qty|tooling_grns/,
    'a PO with plates already received must not have its lines edited underneath the GRN: the '
    + 'received quantity would no longer match what was ordered, and fulfilment would read wrong for ever');
});

test('a never-used Plate PO can be deleted outright', () => {
  const body = handler(plates(), 'delete', '/plates/purchase-orders/:id');
  assert.ok(body, 'DELETE /plates/purchase-orders/:id is missing — a PO raised by mistake can only be '
    + 'reversed, which leaves a permanent reversed row for a document that never should have existed');
  assert.match(body, /canBuy/, 'deleting a PO must carry the same role gate as raising one');
});

test('delete refuses the moment a PO has LIVED — sent, received, or already reversed', () => {
  const body = handler(plates(), 'delete', '/plates/purchase-orders/:id');

  assert.match(body, /sent_at/,
    'a PO the vendor has been sent must be REVERSED, not deleted — deleting it erases the paper trail '
    + 'for a document somebody outside this building is holding');
  assert.match(body, /tooling_grns/,
    'a PO with any GRN against it — even a reversed one — must not be deleted: the GRN would point at '
    + 'a purchase order that no longer exists');
  assert.match(body, /status\s*(<>|!==|===|=)\s*'open'|'open'/,
    'only an OPEN PO may be deleted; partially_received, received, closed and reversed all mean it has lived');
});

test('delete hands the plates back, exactly as reverse does', () => {
  const body = handler(plates(), 'delete', '/plates/purchase-orders/:id');

  assert.match(body, /plate_request_components SET status='approved'/,
    "the PO's components must return to 'approved' or they are stranded in 'po_created' pointing at a "
    + 'deleted PO line — invisible to the requirements screen and impossible to buy again');
  assert.match(body, /po_line_id=NULL/,
    'the component must let go of the PO line it is about to lose, or the FK strands it');
  assert.match(body, /tooling_requests SET/,
    "the requirement itself must come back off 'converted', or it keeps a po_number for a PO that is gone");
});

test('delete removes the lines before the PO, and audits what it destroyed', () => {
  const body = handler(plates(), 'delete', '/plates/purchase-orders/:id');
  const lines = body.indexOf('DELETE FROM tooling_po_lines');
  const po = body.indexOf('DELETE FROM tooling_purchase_orders');
  assert.ok(lines >= 0 && po >= 0, 'both the lines and the PO row must be removed');
  assert.ok(lines < po, 'lines must go before the PO they point at, or the FK refuses the delete');
  assert.match(body, /audit\(/,
    'a deleted PO leaves no row behind, so the audit entry is the ONLY surviving record that its '
    + 'number was ever issued — without it the number just vanishes from the series');
});
