import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Every "already dispatched" gate in front of a job card's close, reverse or
// adjust asks about the lines THAT CARD closes — helpers.js lineIdsClosedBy() —
// and nothing wider.
//
// The rule used to be re-spelled inline at each gate as
// `ol.id = <card's line> OR ol.gang_run_id = <card's run>`. That is right for a
// combined-run card, which has no line of its own, and wrong for a split gang
// CHILD, which carries both keys: its PARTNER's shipment refused it. Sort &
// Paste could not close CI-JC-0182 or CI-JC-0210 on 17 Sep 2026 for exactly
// that reason, and the same predicate stood in front of the reverse and the
// completed-run adjust. The rule itself is tested in lines-closed-by-card.test.js;
// this file pins that the gates use it.

const prod = readFileSync(new URL('./routes/production.js', import.meta.url), 'utf8');

// SQL lives in template literals, so the odd-indexed backtick splits are the
// query bodies (the same reading gang-anchor-one-spelling.test.js relies on).
const sqlBlocks = (src) => src.split('`').filter((_, i) => i % 2 === 1);

// A dispatched gate: a query over order lines that reads what has shipped —
// by quantity (a part-shipped line never reads 'dispatched') or by status.
const READS_SHIPPED = /ol\.dispatched_qty|ol\.status\s*=\s*'dispatched'/;
const gates = sqlBlocks(prod).filter(b => /FROM order_lines ol\b/.test(b) && READS_SHIPPED.test(b));

test('the three dispatched gates are found — a guard that matches nothing passes forever', () => {
  assert.equal(gates.length, 3,
    'expected the Sort & Paste close, the Sort & Paste reverse and the completed-run adjust (stageImpact)');
});

test('no dispatched gate widens a card to its whole run', () => {
  for (const g of gates)
    assert.doesNotMatch(g, /gang_run_id/,
      'this gate matches on gang_run_id, so a split gang CHILD is refused when its PARTNER ships '
      + '(CI-JC-0182, CI-JC-0210) — gate on lineIdsClosedBy(jc) instead:\n' + g);
});

test('every dispatched gate selects exactly the ids lineIdsClosedBy() returns', () => {
  for (const g of gates)
    assert.match(g, /ol\.id\s*=\s*ANY\(\$1::int\[\]\)/,
      'the gate must select by the closed-line id list, not re-derive the set:\n' + g);
  assert.equal((prod.match(/await lineIdsClosedBy\(/g) || []).length, gates.length,
    'each gate takes its id list from lineIdsClosedBy() — one call per gate');
});
