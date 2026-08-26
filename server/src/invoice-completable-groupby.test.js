// A source guard for the invoice `completable` query.
//
// The bug it protects against: the SELECT list grew to carry p.code,
// p.party_item_code and a spec_override COALESCE while the GROUP BY still said
// p.name. Postgres rejects the whole statement — and because this query runs
// AFTER tx() has committed, every invoice creation wrote the bill and then
// answered 500. The screen said it had failed while the invoice existed.
//
// A runtime test cannot catch this: the suite has no database, and the defect
// only surfaces when Postgres plans the statement. So the invariant is guarded
// where it lives — in the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./routes/billing.js', import.meta.url), 'utf8');

// The completable query, from its assignment to the closing backtick.
function completableQuery() {
  const start = src.indexOf('invoice.completable = await q(`');
  assert.notEqual(start, -1, 'the completable query has moved — update this guard');
  const from = src.indexOf('`', start) + 1;
  const end = src.indexOf('`', from);
  assert.notEqual(end, -1, 'could not find the end of the completable query');
  // SQL comments carry the words this guard looks for; strip them first.
  return src.slice(from, end).replace(/--[^\n]*/g, '');
}

test('completable groups products by their KEY, never by a name', () => {
  const sql = completableQuery();
  const groupBy = sql.slice(sql.lastIndexOf('GROUP BY'));
  assert.equal(/\bp\.id\b/.test(groupBy), true,
    'GROUP BY must carry p.id — grouping on p.name leaves every other p.* column '
    + 'functionally undetermined and Postgres rejects the statement');
  assert.equal(/\bp\.name\b/.test(groupBy), false,
    'p.name in GROUP BY is the original defect; group on p.id instead');
});

test('every products column the SELECT reads is covered by the grouping', () => {
  const sql = completableQuery();
  const groupIdx = sql.lastIndexOf('GROUP BY');
  const selectPart = sql.slice(0, groupIdx);
  const groupBy = sql.slice(groupIdx);
  // Any p.<col> read outside an aggregate needs p.id (its key) in the GROUP BY.
  const read = [...selectPart.matchAll(/\bp\.([a-z_]+)\b/g)].map(m => m[1]);
  if (read.length) {
    assert.equal(/\bp\.id\b/.test(groupBy), true,
      `the SELECT reads p.${read.join(', p.')} — GROUP BY p.id is what makes that legal`);
  }
});

test('the same trap is not reintroduced elsewhere in billing.js', () => {
  // Strip SQL comments across the whole file, then check every GROUP BY.
  const clean = src.replace(/--[^\n]*/g, '');
  const offenders = [...clean.matchAll(/GROUP BY[^`;]*/g)]
    .map(m => m[0].trim())
    .filter(g => /\bp\.name\b/.test(g) && !/\bp\.id\b/.test(g));
  assert.deepEqual(offenders, []);
});
