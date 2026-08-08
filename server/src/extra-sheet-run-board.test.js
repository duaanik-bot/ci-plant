import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GANG_ANCHOR_LINE } from './helpers.js';

// A gang parent / combined-run job card carries `order_line_id = NULL` — the
// run serves several sales orders, so no single line is "the" line (helpers.js
// createJobCardForGang and createJobCardForMergeRun both INSERT it as literal
// NULL). Every query that walks a card to its line therefore has to LEFT JOIN
// and fall back to the run's ANCHOR member (GANG_ANCHOR_LINE), or the card
// silently drops out of the result — `JOIN order_lines ol ON ol.id =
// jc.order_line_id` is an INNER join on NULL.
//
// extrasheets.js learned that rule twice — XS_VIEW and the eligible-stages
// picker were both converted, precisely so a request COULD be raised on a
// running run stage. The warehouse-issue handler's own effective-board lookup
// was missed: it still keyed a bare `WHERE ol.id=$1` off jc.order_line_id, so
// on exactly the cards the other two queries were fixed to admit it matched
// zero rows, oc() handed back null, and the next line dereferenced
// `eff.board_material_id` on it. Not a clean 409 — a TypeError, which
// Express's `catch (e) { next(e); }` serves as a raw 500. The operator has
// already carried the sheets off the floor and the plant head has already
// approved the quantity; the warehouse clicks Issue and the ERP crashes.
const src = readFileSync(new URL('./routes/extrasheets.js', import.meta.url), 'utf8');

// The shared effective-board helper used by approval and the Cutting handoff.
const effQuery = (() => {
  const from = src.indexOf('async function effectiveBoardForJob');
  assert.notEqual(from, -1, 'the Extra Sheets loop must still resolve an effective board');
  const to = src.indexOf('\n}', from);
  assert.notEqual(to, -1, 'could not find the end of the effective-board helper');
  return src.slice(from, to + 2);
})();

test('the issue handler resolves a RUN card board through the gang anchor', () => {
  assert.match(effQuery, /gol\.spec_override/,
    'a gang/combined-run parent has no order line of its own — the warehouse pick must be '
    + 'read through the run anchor too, exactly as XS_VIEW does');
  assert.match(effQuery, /GANG_ANCHOR_LINE/,
    'the anchor must come from the shared helper, not a hand-rolled second spelling of it');
});

test('the issue handler keys its board lookup off the job card, never the nullable line', () => {
  assert.doesNotMatch(effQuery, /WHERE\s+ol\.id\s*=\s*\$1/,
    'keying on order_lines.id matches ZERO rows for a run parent (order_line_id IS NULL), '
    + 'and the null that comes back is dereferenced on the very next line');
  assert.doesNotMatch(effQuery, /\[\s*jc\.order_line_id\s*\]/,
    'jc.order_line_id is NULL on a run parent — the card id is the only safe key');
  assert.match(effQuery, /\[\s*jobCardId\s*\]/,
    'every job card has an id; only some have an order line');
});

test('order_lines is reached by LEFT JOIN so a run parent survives the lookup', () => {
  assert.match(effQuery, /LEFT JOIN order_lines ol ON ol\.id = jc\.order_line_id/,
    'an INNER join on a NULL order_line_id is what drops the run card');
  // GANG_ANCHOR_LINE's doc comment: "Expects the query to alias job_cards as
  // `jc`; produces the alias `gol`." Aliasing it anything else leaves the
  // lateral referencing a table that is not in the FROM clause — Postgres
  // rejects the whole statement, so the run card fails just as hard, only
  // louder. job_cards must also precede the lateral that references it.
  assert.match(effQuery, /FROM job_cards jc\b/,
    'GANG_ANCHOR_LINE references jc.gang_run_id and jc.order_line_id by that exact alias');
  assert.ok(effQuery.indexOf('FROM job_cards jc') < effQuery.indexOf('GANG_ANCHOR_LINE'),
    'the lateral may only reference a table already in the FROM clause');
  assert.match(GANG_ANCHOR_LINE, /\bjc\.gang_run_id\b/,
    'guards the assumption above: if the helper stops keying off `jc`, this query must be re-checked');
});

test('the product comes from the job card, which a run parent always carries', () => {
  // Both gang paths INSERT product_id (the anchor member's) while forcing
  // order_line_id to NULL, so jc.product_id is the one product reference a run
  // card is guaranteed to have. It is also what XS_VIEW and the eligible
  // picker already join on, which is the point — one rule, three queries.
  assert.match(effQuery, /JOIN products p ON p\.id\s*=\s*jc\.product_id/,
    'p.id = ol.product_id reintroduces the same NULL dependency through the back door');
});

// The three board reads in this file must agree. If they drift, the picker
// offers a stage, the approver sees one board, and the warehouse issues
// another — the failure this file has already had twice.
test('all three board reads in extrasheets.js use one effective-board rule', () => {
  const rule = /COALESCE\(ol\.spec_override, gol\.spec_override\)->>'board_material_id'/g;
  assert.equal((src.match(rule) || []).length, 3,
    'XS_VIEW, the eligible-stages picker and the fulfilment helper must resolve the board identically');
  assert.doesNotMatch(src, /\(ol\.spec_override->>'board_material_id'\)/,
    'a lone ol.spec_override read is the override going missing on every run card');
});
