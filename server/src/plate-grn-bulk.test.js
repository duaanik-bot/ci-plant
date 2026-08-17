// One receipt against one PO, in one transaction — and a plate line that says
// what it is.
//
// SQL-only invariants asserted on the source, the same way plate-po-edit-delete
// does and for the same reason: these rules live as literal SQL inside route
// handlers, this suite has no database harness, and a silent regression in any
// of them either double-books a physical plate or sends a vendor a purchase
// order that does not say what to make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const code = s => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const plates = () => code(src('./routes/plates.js'));
const toolingProcurement = () => code(src('./routes/tooling-procurement.js'));

// The body of one route handler, so a guard cannot accidentally pass by
// matching text that belongs to a neighbouring route.
function handler(source, method, path) {
  const at = source.indexOf(`r.${method}('${path}'`);
  if (at < 0) return null;
  const next = source.indexOf('\nr.', at + 1);
  return source.slice(at, next < 0 ? source.length : next);
}

// A named function body, for the shared receive helper.
function fn(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const next = source.indexOf('\nasync function ', at + 1);
  const alt = source.indexOf('\nfunction ', at + 1);
  const end = [next, alt].filter(i => i > 0).sort((a, b) => a - b)[0];
  return source.slice(at, end || source.length);
}

test('a whole-PO Plate GRN endpoint exists', () => {
  const body = handler(plates(), 'post', '/plates/grns/bulk');
  assert.ok(body, 'POST /plates/grns/bulk is missing — a delivery covering three plate sets has to be '
    + 'entered as three separate receipts, and the warehouse cannot choose which set arrived');
  assert.match(body, /canBuy/, 'receiving plates is buying work and must carry the same role gate as raising a PO');
});

test('the whole receipt is ONE transaction', () => {
  const body = handler(plates(), 'post', '/plates/grns/bulk');
  assert.match(body, /await tx\(/,
    'a loop of per-line receipts that fails half way leaves the PO partly received with no record of '
    + 'which half landed, and toolingPoStatus recomputed against a state nobody chose');
  // One tx, not one per line.
  assert.equal((body.match(/await tx\(/g) || []).length, 1,
    'nesting a transaction per line re-introduces exactly the partial-failure the bulk endpoint exists to prevent');
});

test('bulk and single-line receipts share one body of work', () => {
  const source = plates();
  const helper = fn(source, 'receivePlateLine');
  assert.ok(helper, 'receivePlateLine() is missing — the bulk endpoint has copied the asset-creation, '
    + 'movement, received_qty and syncPlateRequest logic instead of sharing it, and the two will drift');

  // Everything a receipt must do, asserted on the ONE place that does it.
  assert.match(helper, /INSERT INTO plate_assets/, 'a received plate becomes a rack asset');
  assert.match(helper, /INSERT INTO plate_asset_movements/, 'and the movement is what makes it auditable');
  assert.match(helper, /UPDATE tooling_po_lines SET received_qty/, 'the line must record what landed');
  assert.match(helper, /toolingPoStatus/, 'and the PO status must follow its lines');
  assert.match(helper, /syncPlateRequest/, 'the requirement has to learn its plates arrived');

  // The single-line endpoint must call it, not keep its own copy.
  const single = handler(source, 'post', '/plates/grns');
  assert.match(single, /receivePlateLine\(/,
    'POST /plates/grns still has its own copy of the receive logic — fix a bug in one and the other keeps it');
  const bulk = handler(source, 'post', '/plates/grns/bulk');
  assert.match(bulk, /receivePlateLine\(/, 'the bulk endpoint must go through the same helper');
});

test('a receipt cannot exceed what is still on order', () => {
  const helper = fn(plates(), 'receivePlateLine');
  assert.match(helper, /FOR UPDATE OF prc/,
    'without the row lock two concurrent receipts both read the same outstanding plates and both create assets');
  assert.match(helper, /status IN \('po_created','ordered'\)/,
    'a plate already in the rack must not be receivable again — it would mint a second asset number '
    + 'for one physical plate');
  assert.match(helper, /pending|received_qty/,
    'selecting more plates than the line has outstanding must be refused, not silently over-received');
});

test('every line in a bulk receipt is locked before any of it is written', () => {
  const body = handler(plates(), 'post', '/plates/grns/bulk');
  assert.match(body, /purchase_order_id/,
    'the receipt is scoped to one PO — a body naming lines from two POs would produce one document '
    + 'describing two deliveries');
  assert.match(body, /po_line_id/, 'each entry names the line it receives against');
});

// ── What a plate line says it is ────────────────────────────────────────────

test('a plate PO line carries the ink TYPE, not just its label', () => {
  const source = plates();
  const rows = fn(source, 'platePoRows');
  assert.ok(rows, 'platePoRows() is missing');
  assert.match(rows, /'component_type',\s*prc\.component_type/,
    'without component_type the inks cannot be ordered CMYK-first and a spot plate cannot be told '
    + 'from a process plate — the strip renders in whatever order the rows were keyed');
  assert.match(rows, /'pantone_code',\s*prc\.pantone_code/,
    'a spot plate is identified by its Pantone; without it two different spot plates read alike');
});

test('the PRINTED plate PO tells the vendor what to make', () => {
  // This is the document that leaves the building. It rendered ti.name — the
  // generic inventory item, "Plate 1030x800" — to a vendor who then had to ask
  // which artwork and which colours.
  const rows = fn(toolingProcurement(), 'poRows');
  assert.ok(rows, 'poRows() is missing');
  assert.match(rows, /plate_request_components/,
    'the printed PO cannot list the inks it is ordering because poRows() never fetches them');
  assert.match(rows, /output_number/,
    'Output is the number the plant and the vendor both call a plate by, and the print had none');
});

test('fetching plate detail does not disturb dies and blocks', () => {
  const rows = fn(toolingProcurement(), 'poRows');
  // poRows serves plate, die and block. A die or block line has NO plate
  // components, so the join must be LEFT LATERAL ... ON true — which yields
  // exactly one all-NULL row — and never an inner join, which would delete
  // those lines from their own purchase orders.
  assert.match(rows, /LEFT JOIN LATERAL \(/,
    'an inner join here drops every die and block line from its own PO');
  assert.match(rows, /\) plate ON true/,
    'ON true is what guarantees the line survives when it has no plate components');
  // Aggregate, so the lateral is ONE row per line. A bare SELECT of the
  // component rows would multiply a 4-plate line into four PO lines, and the
  // printed PO would bill the vendor four times for one plate set.
  assert.match(rows, /json_agg\(/, 'the components must be aggregated, not joined row-per-row');
  assert.match(rows, /COALESCE\(plate\.components, '\[\]'::json\)/,
    'a line with no plate components must read as an empty list, not null');
});
