import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { GANG_ANCHOR_LINE } from './helpers.js';

// ONE spelling of the gang-anchor rule.
//
// A gang parent / combined-run parent job card carries `order_line_id = NULL` —
// the run serves several sales orders, so no single line is "the" line
// (helpers.js createJobCardForGang and createJobCardForMergeRun both INSERT it
// as a literal NULL while setting product_id from the anchor). Any query that
// walks a CARD to its LINE must therefore LEFT JOIN and fall back to the run's
// ANCHOR member — the lowest-id line on the run — or the card silently drops
// out of the result: `JOIN order_lines ol ON ol.id = jc.order_line_id` is an
// INNER join on NULL.
//
// helpers.js GANG_ANCHOR_LINE is that fallback, written once and documented.
// The rule had nonetheless been re-derived by hand in twelve more places, in
// three further spellings: an inline copy of the lateral, a COALESCE
// subselect, and a JS ternary choosing between two whole SQL strings. All of
// them resolved to the same anchor, so nothing was visibly broken — which is
// exactly what makes it dangerous. The cost is already proven: when the anchor
// was added to extrasheets.js, XS_VIEW and the eligible-stages picker were
// converted and the warehouse-issue handler was missed. The picker then
// advertised a stage that the Issue button crashed on — a TypeError served as
// a raw 500, on all twelve gang/combined-run parent cards on the live plant.
//
// A rule with one spelling can be fixed once. A rule with five gets fixed four
// times and stays broken in the fifth.

const HERE = new URL('./', import.meta.url);

// Every non-test source file under server/src. Test files are excluded because
// this file necessarily quotes the very patterns it bans.
function sourceFiles(dir = HERE, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    if (e.isDirectory()) sourceFiles(u, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js'))
      out.push([e.name, readFileSync(u, 'utf8')]);
  }
  return out;
}

// SQL lives in template literals, so the odd-indexed backtick splits are the
// query bodies. `${GANG_ANCHOR_LINE}` survives the split as literal text, which
// is what lets this file tell an interpolated helper from a hand-rolled copy.
const sqlBlocks = (src) => src.split('`').filter((_, i) => i % 2 === 1);

// ── the three hand-rolled spellings ───────────────────────────────────
const INLINE_LATERAL = /SELECT ol2\.\* FROM order_lines ol2/g;
const COALESCE_SUBSELECT = /COALESCE\(\s*jc\.order_line_id\s*,\s*\(?\s*SELECT id FROM order_lines/;

test('the anchor lateral is written once — in the helper, nowhere else', () => {
  const counts = sourceFiles()
    .map(([name, src]) => [name, (src.match(INLINE_LATERAL) || []).length])
    .filter(([, n]) => n > 0);
  assert.deepEqual(counts, [['helpers.js', 1]],
    'an inline copy of the lateral is a second spelling of the rule — it drifts silently, '
    + 'because both copies resolve the same anchor right up until one of them is edited');
});

test('no query re-derives the anchor as a COALESCE subselect', () => {
  for (const [name, src] of sourceFiles())
    assert.doesNotMatch(src, COALESCE_SUBSELECT,
      `${name}: COALESCE(jc.order_line_id, (SELECT id FROM order_lines ...)) is the anchor `
      + 'rule spelled a third way — and it forces an INNER join, so a card with neither a '
      + 'line nor a run vanishes instead of falling back to its product master');
});

test('no board lookup is chosen by a JS ternary on jc.order_line_id', () => {
  const prod = readFileSync(new URL('./routes/production.js', HERE), 'utf8');
  assert.doesNotMatch(prod, /jc\.order_line_id\s*\n?\s*\?\s*await oc\(\s*`/,
    'branching in JS between two entire SQL strings is the same rule spelled a fourth way, '
    + 'and the only one a source-grep for the anchor cannot find at all');
});

// ── the guard the extrasheets 500 would have caught ───────────────────
// A "card-driven board resolution" is a query that walks a CARD to its LINE and
// resolves the effective board from it — the product-master fallback
// `p.board_material_id` is that resolution's signature. Every such query is
// reachable with a run parent, so every one must carry the anchor.
//
// Deliberately NOT in scope, and both would be wrong to convert:
//   · helpers.js BOARD_DEMAND_SQL is LINE-driven — it joins job_cards only to
//     net off consumption, and documents that a gang parent matches nothing so
//     its demand stays counted in full (the cautious direction for a warehouse).
//   · the Cutting Variances register reads the board STORED on the discrepancy
//     row (cd.board_material_id); it resolves nothing. Handing it the anchor
//     would also print one member's customer and PO as the run's own — the very
//     per-member facts GANG_ANCHOR_LINE's own doc comment forbids taking from
//     `gol` alone.
const WALKS_CARD_TO_LINE = /ol\.id\s*=\s*jc\.order_line_id|COALESCE\(\s*jc\.order_line_id\s*,/;

// The cutting leftover-plan lookup is line-only BY DESIGN: the caller returns
// early on `!jcForLeftover?.order_line_id`, because a gang parent's offcut is
// never booked automatically (the parent may represent mixed child layouts —
// the split children carry the traceability after die-cutting). Keying it on
// the bare order_line_id is what makes it fail SAFE if that guard is ever
// removed: no row, no booking. Given the anchor it would instead start quietly
// banking a whole run's offcut against one member's leftover plan.
const EXEMPT = /leftover_plan/;

const resolvesBoardFromCard = (name, src) => sqlBlocks(src)
  .filter(b => WALKS_CARD_TO_LINE.test(b) && /p\.board_material_id/.test(b))
  .map(b => [name, b]);

const found = sourceFiles().flatMap(([n, s]) => resolvesBoardFromCard(n, s));
const guarded = found.filter(([, b]) => !EXEMPT.test(b));

test('every card-driven board resolution exists and is found by this guard', () => {
  // A guard that silently matches nothing passes forever. Pin the surfaces.
  const files = [...new Set(guarded.map(([n]) => n))].sort();
  assert.deepEqual(files, ['extrasheets.js', 'floor.js', 'production.js'],
    'the job card, the live floor and the extra-sheet flow all resolve a board off a card');
  assert.ok(guarded.length >= 9,
    `expected at least the nine known card-driven board resolutions, found ${guarded.length}`);
  assert.equal(found.length - guarded.length, 1,
    'exactly one query is exempt — the cutting leftover plan. A second exemption means '
    + 'someone widened the escape hatch instead of using the anchor');
});

test('every card-driven board lookup resolves through GANG_ANCHOR_LINE', () => {
  for (const [name, block] of guarded) {
    const head = block.trim().split('\n')[0].slice(0, 60);
    assert.match(block, /\$\{GANG_ANCHOR_LINE\}/,
      `${name} — "${head}…": a board read off a job card must fall back to the run anchor, `
      + 'and must take it from the shared helper rather than spell it again');
  }
});

test('card-driven board lookups reach order_lines by LEFT JOIN only', () => {
  for (const [name, block] of guarded) {
    const head = block.trim().split('\n')[0].slice(0, 60);
    const joins = [...block.matchAll(/(LEFT\s+)?JOIN order_lines ol ON ol\.id\s*=\s*jc\.order_line_id/g)];
    assert.ok(joins.length > 0, `${name} — "${head}…": expected the card's own line to be joined`);
    for (const m of joins)
      assert.ok(m[1], `${name} — "${head}…": an INNER join on a NULL order_line_id is what drops `
        + 'the run card out of the result entirely');
  }
});

test('the product on a card-driven board lookup comes from the card', () => {
  for (const [name, block] of guarded) {
    const head = block.trim().split('\n')[0].slice(0, 60);
    assert.doesNotMatch(block, /JOIN products p ON p\.id\s*=\s*ol\.product_id/,
      `${name} — "${head}…": p.id = ol.product_id reintroduces the NULL dependency through the `
      + 'back door. job_cards.product_id is NOT NULL and both gang paths set it from the anchor '
      + 'member, so the card is the one product reference a run parent always carries');
    assert.match(block, /JOIN products p ON p\.id\s*=\s*jc\.product_id/,
      `${name} — "${head}…": the card's own product is the safe join`);
  }
});

test('a card-driven board lookup reads the override through the anchor too', () => {
  for (const [name, block] of guarded) {
    const head = block.trim().split('\n')[0].slice(0, 60);
    assert.doesNotMatch(block, /\(ol\.spec_override->>'board_material_id'\)/,
      `${name} — "${head}…": a lone ol.spec_override read is the planner's warehouse pick going `
      + 'missing on every run card — the card falls back to the product master and cutting '
      + 'consumes a board nobody planned');
  }
});

// ── the assumptions above, pinned to the helper itself ────────────────
test('GANG_ANCHOR_LINE still keys off jc and still yields gol', () => {
  assert.match(GANG_ANCHOR_LINE, /\bjc\.gang_run_id\b/,
    'every call site aliases job_cards as `jc`; if the helper stops assuming that, they all break');
  assert.match(GANG_ANCHOR_LINE, /\bjc\.order_line_id IS NULL\b/,
    'the lateral must fire only where the card has no line of its own');
  assert.match(GANG_ANCHOR_LINE, /\)\s*gol\b/,
    'call sites COALESCE(ol.x, gol.x) by that alias');
  assert.match(GANG_ANCHOR_LINE, /ORDER BY ol2\.id LIMIT 1/,
    'the anchor is the LOWEST-ID member — the same line createJobCardForGang took product_id from');
});

test('the lateral may only reference a table already in the FROM clause', () => {
  for (const [name, src] of sourceFiles()) {
    for (const block of sqlBlocks(src)) {
      const at = block.indexOf('${GANG_ANCHOR_LINE}');
      if (at === -1) continue;
      const jcAt = block.search(/\bjob_cards jc\b/);
      assert.ok(jcAt !== -1 && jcAt < at,
        `${name}: GANG_ANCHOR_LINE references jc.gang_run_id, so job_cards must be aliased `
        + '`jc` and must appear before the lateral — otherwise Postgres rejects the statement');
    }
  }
});
