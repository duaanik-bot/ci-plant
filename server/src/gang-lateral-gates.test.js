// The gang laterals must carry their ON-clause gate INSIDE their own WHERE.
//
// Every station board, the Sort & Paste queue and the job-card register join a
// handful of gang roll-ups (members, sheet-mates, the combined run's earliest
// delivery, the run's artwork approvals) with a LEFT JOIN LATERAL … ON <gate>,
// where the gate is a fact about the OUTER card alone: "this is a gang parent",
// "this card split off a run", "this run is a merge". Written only in the ON
// clause, Postgres cannot use it to skip the lateral — it runs the sub-select
// for EVERY stage row and throws most answers away afterwards with a Join
// Filter. EXPLAIN (ANALYZE, BUFFERS) on prod, STAGE_VIEW over the open floor
// (1,147 rows): gm, runagg and rmate each looped 1,147 times and were 80% of
// the query's buffer touches, discarding 833 / 1,080 / 1,119 of their answers.
//
// Repeated inside the WHERE, the gate becomes a One-Time Filter: a solo card
// never opens the sub-select at all. The answer cannot change — each of these
// is an aggregate with no GROUP BY, so a false gate still yields one all-NULL
// row, and the ON clause (kept exactly as it was) still discards it, which is
// what an unmatched LEFT JOIN gave before.
//
// Pinned as source text because the saving IS the placement: a lateral that
// loses its inner gate still answers correctly and silently costs the floor
// its speed back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GANG_RUN_MATES_LATERAL } from './helpers.js';

const src = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const squash = s => s.replace(/\s+/g, ' ').trim();

// The lateral aliased `alias`: its ON clause, and the WHERE of its OUTERMOST
// SELECT (a nested sub-select or lateral inside it has its own WHERE, which
// says nothing about whether this one is gated).
function lateral(sql, alias) {
  const text = sql.replace(/--[^\n]*/g, '');             // comments may hold parens
  const m = new RegExp(`\\)\\s*${alias} ON ([^\\n\\x60]*)`).exec(text);
  assert.ok(m, `lateral "${alias}" not found`);
  const close = m.index;
  let depth = 0, open = -1;
  for (let i = close; i >= 0; i--) {
    if (text[i] === ')') depth++;
    else if (text[i] === '(' && --depth === 0) { open = i; break; }
  }
  assert.ok(open >= 0, `unbalanced lateral "${alias}"`);
  const body = text.slice(open + 1, close);
  let where = -1;
  depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if (depth === 0 && /^\bWHERE\b/.test(body.slice(i, i + 6)) && /\s/.test(body[i - 1] || ' ')) where = i;
  }
  assert.ok(where >= 0, `lateral "${alias}" has no top-level WHERE`);
  return { on: squash(m[1]), where: squash(body.slice(where + 'WHERE'.length)) };
}

const floor = src('./routes/floor.js');
const production = src('./routes/production.js');

const CASES = [
  // [where it lives, sql, alias, the ON gate exactly as it stands today]
  ['floor.js GANG_MEMBERS_LATERAL', floor, 'gm', 'jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL'],
  ['floor.js GANG_MEMBERS_LATERAL', floor, 'runagg', "jc.order_line_id IS NULL AND gg.kind = 'merge'"],
  ['helpers.js GANG_RUN_MATES_LATERAL', GANG_RUN_MATES_LATERAL, 'rmate', 'jc.parent_job_card_id IS NOT NULL AND jc.gang_run_id IS NOT NULL'],
  ['production.js JC_VIEW', production, 'gagg', 'jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL'],
  ['production.js JC_VIEW', production, 'gmm', 'jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL'],
];

for (const [where, sql, alias, gate] of CASES) {
  test(`${where}: ${alias} keeps its ON gate and repeats it inside its WHERE`, () => {
    const l = lateral(sql, alias);
    assert.equal(l.on, gate,
      `${alias}'s ON clause is the correctness half — it must stay exactly as it was`);
    for (const cond of gate.split(' AND ')) {
      assert.ok(l.where.includes(cond),
        `${alias} must repeat "${cond}" inside its own WHERE, or Postgres runs the `
        + `sub-select for every stage row and discards the answer afterwards (WHERE is: ${l.where})`);
    }
  });
}
