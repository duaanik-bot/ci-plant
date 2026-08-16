// Where a Status Sheet line IS right now — the cascade behind the "Where it is"
// chips and behind the stage the export prints.
//
// The property that matters most is at the bottom: EXACTLY ONE key per line.
// The chips count lines by this key, so a line answering two of them would
// double itself in the rail and in a customer's workbook — the same failure
// LINE_STATUS_SQL is a cascade to prevent (wip-scope.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineStageOf, lineStageRail, PRE_STAGE_KEYS, POST_STAGE_KEYS } from '../../client/src/lib/lineStage.js';

// A plant route, as /status-sheet hands it over.
const route = (...pairs) => pairs.map(([stage, status]) => ({ stage, status }));
const STAGE_ORDER = ['cutting', 'printing', 'coating', 'die_cutting', 'sorting', 'pasting'];

test('a line with no job card and nothing planned is UNPLANNED', () => {
  assert.equal(lineStageOf({ status: 'pending', stages: [] }).key, 'unplanned');
  // No `stages` key at all is the same fact, not a crash.
  assert.equal(lineStageOf({ status: 'pending' }).key, 'unplanned');
});

test('a planned line with no job card yet is PLANNED, not queued', () => {
  // 57 live lines sit here: the planner has committed them, but nothing has
  // reached the floor, so no job card and no stages exist to stand on.
  assert.equal(lineStageOf({ status: 'planned', stages: [] }).key, 'planned');
  assert.equal(lineStageOf({ status: 'ready', stages: [] }).key, 'planned');
});

test('a job card whose route has not been touched is QUEUED', () => {
  const r = lineStageOf({ status: 'in_production', stages: route(['cutting', 'pending'], ['printing', 'pending']) });
  assert.equal(r.key, 'queued');
  assert.equal(r.done, 0);
  assert.equal(r.total, 2);
});

test('a running stage is where the line is', () => {
  const r = lineStageOf({ status: 'in_production',
    stages: route(['cutting', 'completed'], ['printing', 'in_progress'], ['die_cutting', 'pending']) });
  assert.equal(r.key, 'printing');
  assert.equal(r.done, 1);
  assert.equal(r.total, 3);
});

test('a partially completed stage is still the stage it is standing on', () => {
  const r = lineStageOf({ status: 'in_production',
    stages: route(['cutting', 'completed'], ['printing', 'partially_completed']) });
  assert.equal(r.key, 'printing');
});

test('a held stage is where the line is — a hold does not move it on', () => {
  const r = lineStageOf({ status: 'in_production',
    stages: route(['cutting', 'completed'], ['printing', 'hold'], ['die_cutting', 'pending']) });
  assert.equal(r.key, 'printing');
});

test('with nothing running, the line waits at the first stage not yet done', () => {
  // Cutting finished, printing has not begun: the sheets are in the press
  // queue, so the sheet says printing — the same stage the Stages cell points
  // at on screen.
  const r = lineStageOf({ status: 'in_production',
    stages: route(['cutting', 'completed'], ['printing', 'pending'], ['die_cutting', 'pending']) });
  assert.equal(r.key, 'printing');
  assert.equal(r.done, 1);
});

test('a route with every stage completed is DONE', () => {
  const r = lineStageOf({ status: 'produced',
    stages: route(['cutting', 'completed'], ['printing', 'completed']) });
  assert.equal(r.key, 'done');
  assert.equal(r.done, 2);
  assert.equal(r.total, 2);
});

test('a completed stage out of sequence does not skip the line past a waiting one', () => {
  // Stages are not guaranteed to complete front-to-back (a gang parent's
  // stages ride ahead of the member's own). Counting completions and indexing
  // by that count would report `die_cutting` here and quietly declare printing
  // finished — so the rule is "first stage not completed", never "the nth".
  const r = lineStageOf({ status: 'in_production',
    stages: route(['cutting', 'completed'], ['printing', 'pending'], ['die_cutting', 'completed']) });
  assert.equal(r.key, 'printing');
});

test('an in-production line whose job card carries no stages is QUEUED, not unplanned', () => {
  // `stages: []` with a planned status must not read as "nobody planned it" —
  // that would put a job already on the floor under the Unplanned chip.
  assert.equal(lineStageOf({ status: 'in_production', stages: [] }).key, 'queued');
  assert.equal(lineStageOf({ status: 'produced', stages: [] }).key, 'queued');
});

test('the rail keeps every plant stage, at zero, and drops none that has lines', () => {
  const rows = [
    { status: 'pending', stages: [] },
    { status: 'pending', stages: [] },
    { status: 'planned', stages: [] },
    { status: 'in_production', stages: route(['cutting', 'pending']) },
    { status: 'in_production', stages: route(['cutting', 'completed'], ['printing', 'in_progress']) },
    { status: 'produced', stages: route(['cutting', 'completed'], ['printing', 'completed']) },
  ];
  const rail = lineStageRail(rows, STAGE_ORDER);
  const by = Object.fromEntries(rail.map(c => [c.key, c.count]));

  assert.equal(by.unplanned, 2);
  assert.equal(by.planned, 1);
  assert.equal(by.queued, 1);
  assert.equal(by.printing, 1);
  assert.equal(by.done, 1);
  // A stage nobody is standing on still gets its chip — the rail must not
  // change width as the plant works through the day.
  assert.equal(by.pasting, 0);
  assert.equal(by.cutting, 0);
  // Order is the order the plant moves through, so the rail reads as a flow.
  assert.deepEqual(rail.map(c => c.key), [...PRE_STAGE_KEYS, ...STAGE_ORDER, ...POST_STAGE_KEYS]);
});

test('a stage outside the standard route still gets a chip rather than vanishing', () => {
  // Old job cards carry a `qc` stage that new ones never get, so it is not in
  // SECTION_ORDER-minus-qc. A line standing on one must still be reachable.
  const rows = [{ status: 'in_production', stages: route(['cutting', 'completed'], ['qc', 'in_progress']) }];
  const rail = lineStageRail(rows, STAGE_ORDER);
  const qc = rail.find(c => c.key === 'qc');
  assert.ok(qc, 'a stage present in the data must appear on the rail');
  assert.equal(qc.count, 1);
  // Appended after the known stages, before the terminal chips, so the known
  // flow keeps its shape.
  assert.equal(rail.at(-1).key, 'done');
});

test('every line lands on exactly one chip — the rail adds up to the sheet', () => {
  const rows = [
    { status: 'pending', stages: [] },
    { status: 'planned', stages: [] },
    { status: 'in_production', stages: route(['cutting', 'pending'], ['printing', 'pending']) },
    { status: 'in_production', stages: route(['cutting', 'in_progress']) },
    { status: 'in_production', stages: route(['cutting', 'completed'], ['printing', 'hold']) },
    { status: 'in_production', stages: route(['cutting', 'completed'], ['printing', 'pending']) },
    { status: 'produced', stages: route(['cutting', 'completed']) },
    { status: 'in_production', stages: route(['qc', 'in_progress']) },
  ];
  const rail = lineStageRail(rows, STAGE_ORDER);
  const total = rail.reduce((s, c) => s + c.count, 0);
  assert.equal(total, rows.length,
    'the chips must partition the sheet: no line counted twice, none left off');
});
