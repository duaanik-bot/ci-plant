import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// THE CUSTOMER CHIP IS KEYED ON customer_id, SO EVERY PAYLOAD THAT WEARS ONE
// HAS TO CARRY IT.
//
// Artwork, Job Cards and Print Planning all grew Planning's customer filter
// chips — a graphite pill with the company's colour in a dot, plus the same dot
// on every row. The colour comes from customerHue(customer_id) and the chips are
// built by grouping rows on customer_id. NEVER on the name: one customer is
// stored as "Fluence Pharamceuticals Pvt. Ltd. ", misspelled with a trailing
// space, and a name-keyed colour reassigns itself the day someone corrects it.
//
// That makes a dropped column a SILENT failure, which is the only reason this
// file exists. There is no error and no blank cell to notice:
//
//   · customerHue(undefined) returns null, and CustomerDot renders nothing at
//     all rather than a wrong colour — by design, so the dot never lies.
//   · the chip builder skips rows whose customer_id is null, so the rail simply
//     comes up empty, and an empty rail is indistinguishable from "this board
//     has fewer than two customers", which is a state we deliberately hide in.
//
// So the page looks FINE with the feature entirely gone. Both queries below
// already LEFT JOIN customers to print a name, which is exactly the trap: the
// Customer column keeps rendering perfectly while the colour system it sits
// beside has no key to work from.
//
// Asserted against the SOURCE because these are SQL string literals — there is
// no exported symbol to test, the same reason output-number-one-spelling.test.js
// reads its rule out of the file.

const SRC = (f) => readFileSync(new URL(`./routes/${f}`, import.meta.url), 'utf8');

// SQL line comments are stripped before every assertion below. Both queries
// discuss the customer at length in prose — "Customer WIP — the customer is
// chasing this item" sits a few lines above the SELECT list in each — so a
// naive match on the whole block passes on a comment while the column is gone.
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, '');

// The template literal opened at `open`, in full.
//
// Nesting-aware on purpose: JC_VIEW interpolates helpers that open template
// literals of their OWN — `${outputNumberSql({ override: \`…\` })}` — so
// scanning to the next backtick ends the block 100 lines early, several columns
// before the one being asserted. That truncation FAILS a correct file, which is
// how it was caught; the mirror-image risk is a match found outside the query
// entirely, which is why this stops at the real close rather than reading on.
function templateLiteralAt(src, open) {
  let i = open + 1, depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }                       // escape
    if (ch === '$' && src[i + 1] === '{') { depth += 1; i += 2; continue; }
    if (ch === '{' && depth > 0) { depth += 1; i += 1; continue; }
    if (ch === '}' && depth > 0) { depth -= 1; i += 1; continue; }
    if (ch === '`') {
      if (depth === 0) return src.slice(open + 1, i);
      const inner = templateLiteralAt(src, i);                    // nested — skip whole
      i += inner.length + 2;
      continue;
    }
    i += 1;
  }
  throw new Error('unterminated template literal');
}

// The SQL of the first template literal after `marker`.
function sqlAfter(src, marker) {
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `could not find ${marker} — this guard needs rewiring`);
  const open = src.indexOf('`', at);
  assert.notEqual(open, -1, `no template literal after ${marker}`);
  return stripSqlComments(templateLiteralAt(src, open));
}

// ── Job Cards ─────────────────────────────────────────────────────────
// GET /job-cards. The register's rows, and the source of its chip rail.
test('JC_VIEW selects customer_id, not just the customer name', () => {
  const sql = sqlAfter(SRC('production.js'), 'const JC_VIEW');
  assert.match(sql, /\bo\.customer_id\b/,
    'the Job Cards chips group on customer_id; c.name alone leaves the rail empty');
  assert.match(sql, /c\.name AS customer_name/,
    'and the name still has to come through — it is what the chip is LABELLED with');
});

// A gang parent is ONE row standing for several cartons, and those cartons can
// belong to different companies. The row answers to every one of their chips,
// so the members blob needs the key too — a gang whose members carry only names
// drops out of every customer chip on the page while still showing a Customer
// column, which is the worst version of this bug: visibly fine, silently gone.
test('a gang parent’s members carry customer_id, so the run answers to each company', () => {
  const sql = sqlAfter(SRC('production.js'), 'const JC_VIEW');
  const at = sql.indexOf('json_build_object');
  assert.notEqual(at, -1, 'the gang members blob moved — this guard needs rewiring');
  const members = sql.slice(at);
  assert.match(members, /'customer_id', o3\.customer_id/,
    'gang_members is what a gang row is grouped by; without the id it belongs to nobody');
  assert.match(members, /'customer_name', c3\.name/,
    'the member name stays — the export and the member list both read it');
});

// ── Print Planning ────────────────────────────────────────────────────
// GET /print-planning. One customer per card: the query resolves a gang through
// its lead line (o.id = COALESCE(ol.order_id, gol.order_id)), which is the
// existing behaviour the Customer column already shows, and the chips inherit.
test('the print-planning card query selects customer_id', () => {
  const sql = sqlAfter(SRC('production.js'), `r.get('/print-planning'`);
  assert.match(sql, /\bo\.customer_id\b/,
    'the board rail groups cards on customer_id');
  assert.match(sql, /c\.name AS customer_name/,
    'the label still comes from the join that is already there');
});

// ── Artwork ───────────────────────────────────────────────────────────
// GET /artwork rides LINE_VIEW, which has carried customer_id since Planning's
// own chips shipped. Nothing was added for Artwork — this pins it so a tidy-up
// of that SELECT list cannot quietly take Artwork's rail down with it.
test('LINE_VIEW still carries customer_id — Artwork and Planning both ride it', () => {
  const sql = sqlAfter(SRC('orders.js'), 'const LINE_VIEW');
  assert.match(sql, /\bo\.customer_id\b/,
    'Planning AND Artwork both build their chips off this one view');
});
