// GET /job-cards?scope=live|history — the register without its history, and the
// history on its own, and what neither is allowed to change.
//
// The register used to carry every card since go-live on every load: 1,580 KB on
// live prod, 47% of it closed and split cards that only the Completed and All
// tabs show. The default tab is a planner's queue, so the history now waits for
// its own tab. Two things make that more than a WHERE clause, and this file pins
// both:
//
//  1. The board and plate verdicts are computed over a SET of cards, not per
//     card. stampBoardState collapses a gang run to its weakest member and tests
//     the run's combined need; stampPlateState does the same for plates. A gang
//     parent that has SPLIT still sits in that set beside its live children — 8
//     runs on live prod on 2026-09-17. Drop the split parent from the pass and a
//     live child's badge changes. So both scopes stamp over exactly the set the
//     legacy route stamps, and only then filter.
//  2. Plant tablets run OLD bundles for days. No param must answer byte for byte
//     what it answered before, so the legacy route is transcribed below and the
//     new one is held to it with JSON.stringify.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobCardRegister, jobCardRung, JOB_CARD_LIST_DROPS, leanStage } from './routes/production.js';
import { stampBoardState, stampPlateState } from './helpers.js';
import { receiptFor, previousOf } from './stage-runs.js';
import * as clientRegister from '../../client/src/lib/jobCardRegister.js';

// ── Fixture: one gang run (7) whose parent has split, with a live child ─────────
// Rows in JC_VIEW's own order: (status='closed'), id DESC.
const CARDS = [
  // live split child of run 7 — its own line, running
  { id: 9, jc_number: 'CI-JC-0009', status: 'in_progress', gang_run_id: 7, order_line_id: 71,
    anchor_line_id: 71, finalised_at: '2026-09-10T04:00:00.000Z', ups: 1, children_per_parent: 1,
    parent_job_card_id: 5, queue_pos: 3 },
  // unfinalised open card — Pending Finalisation
  { id: 8, jc_number: 'CI-JC-0008', status: 'open', gang_run_id: null, order_line_id: 80,
    anchor_line_id: 80, finalised_at: null, ups: 2, children_per_parent: 1 },
  // finalised, not started — Finalised
  { id: 6, jc_number: 'CI-JC-0006', status: 'open', gang_run_id: null, order_line_id: 60,
    anchor_line_id: 60, finalised_at: '2026-09-12T04:00:00.000Z', ups: 1, children_per_parent: 2 },
  // the SPLIT gang parent of run 7 — history, but still in the stamp set
  { id: 5, jc_number: 'CI-JC-0005', status: 'split', gang_run_id: 7, order_line_id: null,
    anchor_line_id: 70, finalised_at: '2026-09-01T04:00:00.000Z', ups: 4, children_per_parent: 1 },
  // closed history
  { id: 3, jc_number: 'CI-JC-0003', status: 'closed', gang_run_id: null, order_line_id: 30,
    anchor_line_id: 30, finalised_at: '2026-08-20T04:00:00.000Z', ups: 1, children_per_parent: 1 },
  { id: 2, jc_number: 'CI-JC-0002', status: 'closed', gang_run_id: null, order_line_id: null,
    anchor_line_id: null, finalised_at: null, ups: 1, children_per_parent: 1 },
];

const stage = (id, job_card_id, seq, name, status, qty_in, qty_out) => ({
  id, job_card_id, seq, stage: name, status, unit: 'sheets', qty_in, qty_out, qty_scrap: 0,
  operator: 'Ramesh', machine_id: 4, started_at: null, completed_at: null,
  line_clearance: { checks: [1, 2, 3] }, extra_issued_parents: 0, extra_issued_units: 0,
});
const STAGES = [
  stage(1, 2, 1, 'cutting', 'completed', 100, 100), stage(2, 2, 2, 'printing', 'completed', 100, 98),
  stage(3, 3, 1, 'cutting', 'completed', 500, 500),
  stage(4, 5, 1, 'cutting', 'completed', 1000, 1000), stage(5, 5, 2, 'die_cutting', 'completed', 1000, 990),
  stage(6, 6, 1, 'cutting', 'pending', null, null),
  stage(7, 8, 1, 'cutting', 'pending', null, null),
  stage(8, 9, 1, 'sorting', 'in_progress', 400, null), stage(9, 9, 2, 'pasting', 'pending', null, null),
];

// The split parent's line has no board on the shelf; the child's line alone
// would fit. Only the RUN verdict — both rows in one group — reads short.
const GATES = {
  70: { material: false, available_sheets: 0 },
  71: { material: true, available_sheets: 5000 },
  80: { material: true, available_sheets: 900 },
  60: { material: false, available_sheets: 10 },
  30: { material: true, available_sheets: 0 },
};
// The plates hinge the other way round: the split parent's own plate is merely
// on order, but the live child still owes one nobody has bought — so the run,
// parent included, reads 'none' only while the child is in the group.
const PLATES = [
  { job_card_id: 5, status: 'ordered', component_type: 'plate', component_label: 'C' },
  { job_card_id: 9, status: 'requested', component_type: 'plate', component_label: 'M' },
  { job_card_id: 6, status: 'in_stock', component_type: 'plate', component_label: 'K' },
];

const clone = x => JSON.parse(JSON.stringify(x));

const fakeDeps = () => {
  const sql = [];
  const q = async (text, params = []) => {
    sql.push(text);
    if (text.includes('AS mix_cuts')) {
      // Honour whichever status filter the route writes, so a route that
      // narrows in SQL is tested on the rows SQL would really hand it.
      let rows = CARDS;
      if (/jc\.status <> 'closed'/.test(text)) rows = rows.filter(c => c.status !== 'closed');
      if (/jc\.status NOT IN \('closed', ?'split'\)/.test(text)) rows = rows.filter(c => !['closed', 'split'].includes(c.status));
      else if (/jc\.status IN \('closed', ?'split'\)/.test(text)) rows = rows.filter(c => ['closed', 'split'].includes(c.status));
      return clone(rows);
    }
    if (/COUNT\(\*\)/.test(text) && text.includes('FROM job_cards jc')) {
      return [{ n: CARDS.filter(c => c.status === 'closed').length }];
    }
    if (text.includes('FROM job_stages js')) {
      const ids = text.includes('ANY($1)') ? new Set(params[0]) : null;
      return clone(STAGES.filter(s => !ids || ids.has(s.job_card_id)));
    }
    if (text.includes('SELECT * FROM order_lines WHERE id = ANY')) {
      return params[0].map(id => ({ id }));
    }
    if (text.includes('requisitions')) return [];        // nothing on order
    if (text.includes('SELECT DISTINCT ol.id')) return []; // nothing drawn
    if (text.includes('AS need')) {
      return params[0].includes(7) ? [{ gang_run_id: 7, need: 1000 }] : [];
    }
    if (text.includes('tooling_requests')) {
      const ids = new Set(params[0]);
      return clone(PLATES.filter(p => ids.has(p.job_card_id)));
    }
    throw new Error(`unexpected query: ${text.slice(0, 80)}`);
  };
  return {
    sql,
    deps: {
      q,
      one: async () => null,
      readinessBatch: async () => ({}),
      readiness: async line => clone(GATES[line.id]),
    },
  };
};

// ── The legacy route, transcribed from production.js @ff94decc ────────────────
// Same deps, same order of work, nothing new. This is the answer an old tablet
// gets, so it is the yardstick for every scope.
const withReceipts = (jc, stages) => stages.map(s => ({
  ...s,
  ...receiptFor({
    stage: s, prev: previousOf(stages, s), ups: jc.ups,
    childrenPerParent: jc.children_per_parent,
    extraParents: s.extra_issued_parents,
    extraStageQty: s.extra_issued_units,
  }),
}));
async function legacyRegister({ q, one, readiness, readinessBatch }) {
  const rows = await q(`SELECT jc.* AS mix_cuts FROM job_cards jc ORDER BY (jc.status='closed'), jc.id DESC`);
  const stages = await q(`SELECT js.* FROM job_stages js ORDER BY js.job_card_id, js.seq`);
  const byJc = {};
  for (const s of stages) (byJc[s.job_card_id] ||= []).push(s);
  const live = rows.filter(jc => jc.status !== 'closed' && jc.anchor_line_id != null);
  const jcAnchorIds = [...new Set(live.map(jc => jc.anchor_line_id))];
  const jcAnchors = jcAnchorIds.length
    ? await q('SELECT * FROM order_lines WHERE id = ANY($1)', [jcAnchorIds])
    : [];
  const jcAnchorById = new Map(jcAnchors.map(l => [l.id, l]));
  const jcRctx = await readinessBatch(jcAnchors);
  const jcGates = new Map();
  for (const jc of live) {
    const line = jcAnchorById.get(jc.anchor_line_id);
    if (line) jcGates.set(jc.id, await readiness(line, one, jcRctx));
  }
  await stampBoardState(live, {
    lineIdOf: jc => jc.anchor_line_id,
    gangIdOf: jc => jc.gang_run_id,
    gatesOf: jc => jcGates.get(jc.id),
    qc: q,
  });
  await stampPlateState(live, {
    jobCardIdOf: jc => jc.id,
    gangIdOf: jc => jc.gang_run_id,
    qc: q,
  });
  return rows.map(jc => {
    const card = { ...jc, stages: withReceipts(jc, byJc[jc.id] || []).map(leanStage) };
    for (const k of JOB_CARD_LIST_DROPS) delete card[k];
    return card;
  });
}

test('the fixture really does hinge on the split parent', async () => {
  // Guard the guard: stamp either member of run 7 ALONE and it must read
  // differently, or the scope tests below would pass against a route that
  // dropped the other member from the pass.
  const { deps } = fakeDeps();
  const legacy = await legacyRegister(deps);
  const alone = async id => {
    const row = clone(CARDS.find(c => c.id === id));
    await stampBoardState([row], {
      lineIdOf: jc => jc.anchor_line_id, gangIdOf: jc => jc.gang_run_id,
      gatesOf: jc => clone(GATES[jc.anchor_line_id]), qc: deps.q,
    });
    await stampPlateState([row], { jobCardIdOf: jc => jc.id, gangIdOf: jc => jc.gang_run_id, qc: deps.q });
    return row;
  };
  const child = legacy.find(c => c.id === 9);
  const parent = legacy.find(c => c.id === 5);
  assert.equal(child.board_state, 'short', 'the run is short once the parent is in the group');
  assert.equal((await alone(9)).board_state, 'covered', 'the child alone fits its own line');
  assert.equal(parent.plate_state, 'none', 'the child’s unbought plate holds the whole run');
  assert.equal((await alone(5)).plate_state, 'on_order', 'the parent alone is merely on order');
});

test('no scope answers byte for byte what the legacy route answered', async () => {
  const a = fakeDeps();
  const b = fakeDeps();
  const legacy = await legacyRegister(a.deps);
  const now = await jobCardRegister(null, b.deps);
  assert.equal(Array.isArray(now), true, 'an old bundle reads a bare array');
  assert.equal(JSON.stringify(now), JSON.stringify(legacy));
  // Unknown values are not a new contract: they fall back to the legacy answer.
  const c = fakeDeps();
  assert.equal(JSON.stringify(await jobCardRegister('everything', c.deps)), JSON.stringify(legacy));
});

test('scope=live carries only live cards, stamped exactly as the legacy route stamps them', async () => {
  const legacy = await legacyRegister(fakeDeps().deps);
  const { deps, sql } = fakeDeps();
  const out = await jobCardRegister('live', deps);
  assert.deepEqual(out.cards.map(c => c.id), [9, 8, 6]);
  for (const card of out.cards) {
    assert.deepEqual(card, legacy.find(c => c.id === card.id), `card ${card.id} must match the legacy row`);
  }
  assert.equal(out.cards.find(c => c.id === 9).board_state, 'short');
  // The saving is real: the closed cards never leave the database, and the stage
  // scan asks only for the cards being returned.
  assert.ok(sql.some(s => s.includes('AS mix_cuts') && /jc\.status <> 'closed'/.test(s)),
    'the live register query must exclude closed cards in SQL');
  const stageSql = sql.find(s => s.includes('FROM job_stages js'));
  assert.match(stageSql, /js\.job_card_id = ANY\(\$1\)/);
});

test('scope=history carries closed and split cards, the split parent stamped with its live child', async () => {
  const legacy = await legacyRegister(fakeDeps().deps);
  const out = await jobCardRegister('history', fakeDeps().deps);
  assert.deepEqual(out.cards.map(c => c.id), [5, 3, 2]);
  for (const card of out.cards) {
    assert.deepEqual(card, legacy.find(c => c.id === card.id), `card ${card.id} must match the legacy row`);
  }
  assert.equal(out.cards.find(c => c.id === 5).plate_state, 'none');
});

test('live ∪ history is the legacy register, and the client merge restores its order', async () => {
  const legacy = await legacyRegister(fakeDeps().deps);
  const live = await jobCardRegister('live', fakeDeps().deps);
  const history = await jobCardRegister('history', fakeDeps().deps);
  const merged = clientRegister.mergeRegister(live.cards, history.cards);
  assert.equal(JSON.stringify(merged), JSON.stringify(legacy));
  // Before history has loaded, the merge is just the live cards.
  assert.deepEqual(clientRegister.mergeRegister(live.cards, null).map(c => c.id), [9, 8, 6]);
});

test('a live refresh that loses a card, or overlaps the history, marks the history stale', () => {
  const { historyIsStale, mergeRegister } = clientRegister;
  const a = { id: 9, status: 'in_progress' }, b = { id: 8, status: 'open' };
  const h = [{ id: 5, status: 'split' }, { id: 3, status: 'closed' }];
  assert.equal(historyIsStale([a, b], [a, b], h), false);
  assert.equal(historyIsStale([a, b], [a, b], null), false, 'no history, nothing to refresh');
  assert.equal(historyIsStale([a, b], [a], h), true, 'card 8 closed — the history lacks it');
  const reopened = { id: 3, status: 'in_progress' };
  assert.equal(historyIsStale([a, b], [a, b, reopened], h), true, 'card 3 reopened');
  // …and until the refetch lands, the reopened card is listed once, as live.
  const merged = mergeRegister([a, b, reopened], h);
  assert.deepEqual(merged.map(j => [j.id, j.status]),
    [[9, 'in_progress'], [8, 'open'], [5, 'split'], [3, 'in_progress']]);
});

test('every scope serves the count of every rung, so the badges never wait for a tab', async () => {
  const expected = { pending: 1, finalised: 1, running: 1, closed: 3, all: 6 };
  const live = await jobCardRegister('live', fakeDeps().deps);
  const history = await jobCardRegister('history', fakeDeps().deps);
  assert.deepEqual(live.counts, expected);
  assert.deepEqual(history.counts, expected);
});

test('the server and the register agree on which rung a card sits on', () => {
  const cases = [
    { status: 'open', finalised_at: null },
    { status: 'open', finalised_at: '2026-09-01' },
    { status: 'in_progress', finalised_at: null },
    { status: 'in_progress', finalised_at: '2026-09-01' },
    { status: 'split', finalised_at: '2026-09-01' },
    { status: 'closed', finalised_at: null },
  ];
  for (const c of cases) assert.equal(jobCardRung(c), clientRegister.jobCardRung(c), JSON.stringify(c));
  assert.deepEqual(cases.map(jobCardRung), ['pending', 'finalised', 'running', 'running', 'closed', 'closed']);
});

// The live count of closed cards comes from a COUNT, not from JC_VIEW, so it has
// to drop exactly the rows JC_VIEW drops. JC_VIEW's only INNER joins at the top
// level are the product and its master board; every other join is LEFT and one
// row per card. If somebody adds an inner join, the closed badge could overcount.
test('the closed count joins exactly what JC_VIEW inner-joins', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./routes/production.js', import.meta.url), 'utf8');
  const view = src.slice(src.indexOf('const JC_VIEW = `'), src.indexOf('${MIX_CUTS_LATERAL}`;'));
  const topLevelInner = view.split('\n').filter(l => /^  JOIN /.test(l)).map(l => l.trim());
  assert.deepEqual(topLevelInner, [
    'JOIN products p ON p.id = jc.product_id',
    'JOIN materials bm ON bm.id = p.board_material_id',
  ]);
  const probe = fakeDeps();
  await jobCardRegister('live', probe.deps);
  const count = probe.sql.find(s => /COUNT\(\*\)/.test(s) && !s.includes('AS mix_cuts'));
  assert.ok(count, 'the live register must count the closed cards it does not carry');
  for (const join of topLevelInner) assert.ok(count.includes(join), `the closed count must ${join}`);
  assert.equal(count.match(/\bJOIN\b/g).length, topLevelInner.length, 'and join nothing else');
});
