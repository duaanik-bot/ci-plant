import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── TICKING ONE APPROVAL PILL MUST NOT MOVE THE ROW ─────────────────────────
//
// Anik, 2026-09-02: "in artwork module when i am clicking on approval pill, on
// just click on 1 pill it moves the whole row to the end, however it should
// stay there."
//
// Approving posts and then re-loads the whole queue, so the row's position is
// decided entirely by the order `GET /artwork` hands back. That ORDER BY was
// `ol.artwork_locked, o.delivery_date NULLS LAST` — which on the plant's own
// data resolves almost nothing: every line in Awaiting Approval carries
// artwork_locked = 0 AND a NULL delivery_date, so all 28 of them sat in ONE tie
// group (the Locked tab: 200 in one group). An ORDER BY with no unique final
// term is not a TOTAL order, so Postgres was free to emit those ties in any
// order — and the order it chose tracked physical tuple state, which an UPDATE
// changes. Approving re-wrote the row, and the queue handed it back at the
// bottom of the tie group. Measured on prod the same morning: the four lines
// last artwork-updated (audit_log 09:59:13–09:59:46) came back as the last four
// rows of twenty-eight.
//
// Both ends are pinned here, because each is separately load-bearing:
//
//   1. The SERVER must impose a total order. The client cannot repair a
//      non-deterministic one — DataTable's comparator returns 0 on equal keys
//      and Array#sort is stable, so whatever arrives is what survives inside
//      every group of equal sort keys.
//
//   2. The CLIENT must DECLARE its sort. Given no defaultSort DataTable takes
//      the first sortable column ascending, so the queue's order was an
//      accident of column order — and that is exactly how this regressed:
//      3b4f09cd (2026-07-22) moved the client ahead of the PO number as the
//      leading column. A PO number is all but unique, so the old default was a
//      near-total order and the server's ties never showed; a client name is
//      shared by fifteen of these rows, which handed the whole question back to
//      the server on the same day the server had no answer.

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

const orders = read('./routes/orders.js');
const artworkPage = read('../../client/src/pages/Artwork.jsx');
const ui = read('../../client/src/components/ui.jsx');

// The route, bounded by the next one — a fixed character window is either too
// short to reach the query or long enough to borrow a neighbour's.
const artworkRoute = (() => {
  const at = orders.indexOf("r.get('/artwork'");
  assert.ok(at > 0, 'GET /artwork is missing');
  const end = orders.indexOf("r.post('/order-lines/:id/artwork'", at);
  assert.ok(end > at, 'could not bound the artwork route');
  const body = orders.slice(at, end);
  assert.ok(body.length > 500, 'the artwork route slice proves nothing');
  return body;
})();

// The SQL ITSELF — the backticked template the queue is fetched with. Read the
// literal rather than the route text: the prose above the query says "ORDER BY"
// too, and a regex over the whole route happily matched the COMMENT and then
// asserted against it. A guard that parses the wrong text passes for the wrong
// reason, which is worse than no guard.
const artworkSql = (() => {
  const open = artworkRoute.indexOf('const rows = await q(`');
  assert.ok(open > 0, 'the artwork queue query is missing');
  const from = open + 'const rows = await q('.length;
  const close = artworkRoute.indexOf('`', from + 1);
  assert.ok(close > from, 'the artwork query template literal is unterminated');
  const sql = artworkRoute.slice(from + 1, close);
  assert.ok(/WHERE ol\.status IN/.test(sql), 'the SQL slice is not the artwork query');
  return sql;
})();

const orderByTerms = () => {
  const at = artworkSql.indexOf('ORDER BY');
  assert.ok(at >= 0, 'the artwork queue must state an ORDER BY');
  const terms = artworkSql.slice(at + 'ORDER BY'.length).split(',').map(t => t.trim()).filter(Boolean);
  assert.ok(terms.length >= 2, `the ORDER BY parsed to ${terms.length} term(s) — the parse is wrong`);
  return terms;
};

test('the artwork queue is returned in a TOTAL order — it ends on the primary key', () => {
  assert.match(orderByTerms().at(-1), /^ol\.id\b/,
    'the artwork queue must end its ORDER BY on ol.id. Every other term it sorts by is '
    + 'shared or NULL across the whole open tab, so without a unique final term the '
    + 'queue has no defined order at all and any UPDATE — a single approval tick — is '
    + 'free to move the row it touched.');
});

test('the tie-breaker is the LAST term, not merely present somewhere', () => {
  // ol.id ahead of delivery_date would silently re-order the queue by insertion
  // and throw the EDD away — a different bug wearing the same fix.
  const terms = orderByTerms();
  assert.match(terms[0], /^ol\.artwork_locked\b/, 'unapproved work still leads the queue');
  assert.match(terms[1], /^o\.delivery_date\b/, 'the delivery date still orders it');
});

test('the artwork queue DECLARES its sort instead of inheriting column order', () => {
  const at = artworkPage.indexOf('<DataTable');
  assert.ok(at > 0, 'the artwork queue table is missing');
  const table = artworkPage.slice(at, at + 400);
  assert.match(table, /defaultSort=\{\{\s*key:\s*'customer_name',\s*dir:\s*'asc'\s*\}\}/,
    'the artwork queue declares no defaultSort, so DataTable sorts it by whichever column '
    + 'happens to be listed first — which is how this broke, and which no reviewer can see '
    + 'from the diff that reorders the columns.');
});

test('DataTable really does fall back to first-column-ascending — why the declaration matters', () => {
  const at = ui.indexOf('const [sort, setSort] = useState(');
  assert.ok(at > 0, 'DataTable\'s sort state is missing');
  const init = ui.slice(at, at + 500);
  assert.match(init, /if \(defaultSort\) return defaultSort;/);
  assert.match(init, /columns\.find\(c => c\.sortable !== false/,
    'an undeclared sort is first-sortable-column-ascending, not "keep the given order"');
});

test('DataTable adds NO tie-break of its own — so the server order is the last word', () => {
  // This is the property that makes the server half mandatory rather than
  // belt-and-braces. If the comparator ever grew a stable secondary key, the
  // ORDER BY's tie-breaker would look redundant and someone would delete it.
  const at = ui.indexOf('return [...filtered].sort((a, b) => {');
  assert.ok(at > 0, "DataTable's comparator is missing");
  const cmp = ui.slice(at, at + 420);
  assert.match(cmp, /if \(av > bv\) return sort\.dir === 'asc' \? 1 : -1;\s*\n\s*return 0;/,
    'the comparator returns 0 on equal keys, so rows tied on the sort key keep the order '
    + 'the API sent — which is precisely why that API order has to be deterministic.');
});
