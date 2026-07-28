import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  naturalSort, laneKey, orderLane, orderBoard, orderForBoard, normalise, moveWithin, splitByMachine,
} from './floor-order.js';

const job = (o) => ({ stage_id: o.id, job_card_id: o.id, stage: 'die_cutting',
  machine_id: null, floor_pos: null, queue_pos: null, delivery_date: null, ...o });

// ── naturalSort — the order the plant had before floor_pos existed ────────
test('naturalSort follows Print Planning queue_pos, then delivery date, then job card id', () => {
  const a = job({ id: 1, queue_pos: 2 });
  const b = job({ id: 2, queue_pos: 1 });
  assert.deepEqual([a, b].sort(naturalSort).map(j => j.stage_id), [2, 1]);

  const c = job({ id: 3, delivery_date: '2026-08-01' });
  const d = job({ id: 4, delivery_date: '2026-07-30' });
  assert.deepEqual([c, d].sort(naturalSort).map(j => j.stage_id), [4, 3]);

  const e = job({ id: 6 });
  const f = job({ id: 5 });
  assert.deepEqual([e, f].sort(naturalSort).map(j => j.stage_id), [5, 6]);

  const g = job({ id: 7 });
  const h = job({ id: 8, queue_pos: 1 });
  assert.deepEqual([g, h].sort(naturalSort).map(j => j.stage_id), [8, 7]);
});

// ── orderLane — floor_pos is an override, not an absolute rank ────────────
test('orderLane puts the floor order ahead of Print Planning queue_pos', () => {
  const a = job({ id: 1, floor_pos: 2, queue_pos: 1 });
  const b = job({ id: 2, floor_pos: 1, queue_pos: 9 });
  assert.deepEqual(orderLane([a, b]).map(j => j.stage_id), [2, 1]);
});

test('a new job lands in its NATURAL place in a lane someone has already reordered', () => {
  // The regression that mattered: one arrow press stamps the whole lane 1..N,
  // and every stage created afterwards arrives with floor_pos NULL. Ranking
  // NULL last would sink a rush order below the frozen cohort — and out of the
  // board's top-3 slice, so nobody on the floor would ever see it.
  const lane = [
    job({ id: 1, floor_pos: 1, queue_pos: 5 }),
    job({ id: 2, floor_pos: 2, queue_pos: 6 }),
    job({ id: 3, floor_pos: 3, queue_pos: 7 }),
    job({ id: 9, queue_pos: 1, delivery_date: '2026-07-29' }), // booked this morning, urgent
  ];
  assert.equal(orderLane(lane)[0].stage_id, 9);
});

test('orderLane keeps a fully untouched lane in exactly the plant order', () => {
  const lane = [job({ id: 1, queue_pos: 3 }), job({ id: 2, queue_pos: 1 }), job({ id: 3, queue_pos: 2 })];
  assert.deepEqual(orderLane(lane).map(j => j.stage_id), [2, 3, 1]);
});

test('orderLane does not mutate its input', () => {
  const lane = [job({ id: 1, floor_pos: 3 }), job({ id: 2, floor_pos: 1 })];
  const before = lane.map(j => j.stage_id);
  orderLane(lane);
  assert.deepEqual(lane.map(j => j.stage_id), before);
});

// ── laneKey / orderBoard — floor_pos never crosses lanes ──────────────────
test('laneKey separates stages, machines, and an unstarted printing press pin', () => {
  assert.notEqual(laneKey(job({ id: 1, stage: 'sorting' })), laneKey(job({ id: 2, stage: 'pasting' })));
  assert.notEqual(laneKey(job({ id: 1, machine_id: 10 })), laneKey(job({ id: 2, machine_id: 11 })));
  assert.equal(
    laneKey({ stage: 'printing', machine_id: null, press_machine_id: 8 }),
    laneKey({ stage: 'printing', machine_id: null, press_machine_id: 8 }));
});

test('reordering one lane never reshuffles another — the Sort & Paste station regression', () => {
  // Sort & Paste pours sorting rows and pasting rows into ONE list. Once the
  // sorting lane is stamped 1..N, comparing those numbers against the pasting
  // rows' NULLs would float every unsorted job above every job waiting to be
  // pasted and dispatched today.
  const rows = [
    job({ id: 1, stage: 'sorting', floor_pos: 1, delivery_date: '2026-08-10' }),
    job({ id: 2, stage: 'sorting', floor_pos: 2, delivery_date: '2026-08-11' }),
    job({ id: 3, stage: 'pasting', delivery_date: '2026-07-29' }), // ships today
  ];
  assert.equal(orderBoard(rows)[0].stage_id, 3);
});

test('orderBoard applies a lane’s manual order within the slots that lane holds', () => {
  const rows = [
    job({ id: 1, machine_id: 10, floor_pos: 2, delivery_date: '2026-07-29' }),
    job({ id: 2, machine_id: 11, delivery_date: '2026-07-30' }),
    job({ id: 3, machine_id: 10, floor_pos: 1, delivery_date: '2026-07-31' }),
  ];
  // Machine 10 holds slots 0 and 2 by delivery; its own order swaps them.
  assert.deepEqual(orderBoard(rows).map(j => j.stage_id), [3, 2, 1]);
});

// ── orderForBoard — running work is never sliced off a machine card ───────
test('a running job stays on top of its lane, whatever the queue order says', () => {
  const lane = [
    job({ id: 1, state: 'queued', floor_pos: 1 }),
    job({ id: 2, state: 'queued', floor_pos: 2 }),
    job({ id: 3, state: 'queued', floor_pos: 3 }),
    job({ id: 4, state: 'running', floor_pos: 9 }), // actually on the press
  ];
  // The board slices each machine to three rows; without this the operator
  // loses Complete / Hold / extra-sheets on the job that is actually running.
  assert.equal(orderForBoard(lane).slice(0, 3).some(j => j.state === 'running'), true);
  assert.equal(orderForBoard(lane)[0].stage_id, 4);
});

test('held work outranks queued work but yields to running', () => {
  const lane = [
    job({ id: 1, state: 'queued' }), job({ id: 2, state: 'hold' }), job({ id: 3, state: 'running' }),
  ];
  assert.deepEqual(orderForBoard(lane).map(j => j.state), ['running', 'hold', 'queued']);
});

// ── normalise / moveWithin ────────────────────────────────────────────────
test('normalise numbers a lane 1..N in board order', () => {
  const lane = [job({ id: 1, queue_pos: 3 }), job({ id: 2, queue_pos: 1 }), job({ id: 3, queue_pos: 2 })];
  assert.deepEqual(normalise(lane).map(j => [j.stage_id, j.floor_pos]), [[2, 1], [3, 2], [1, 3]]);
});

test('normalise does not mutate its input', () => {
  const lane = [job({ id: 1, queue_pos: 3 }), job({ id: 2, queue_pos: 1 }), job({ id: 3, queue_pos: 2 })];
  const idsBefore = lane.map(j => j.stage_id);
  const floorPosBefore = lane.map(j => j.floor_pos);

  normalise(lane);

  assert.deepEqual(lane.map(j => j.stage_id), idsBefore);
  assert.deepEqual(lane.map(j => j.floor_pos), floorPosBefore);
});

test('moveWithin lifts a job one place up its lane', () => {
  const lane = [job({ id: 1, floor_pos: 1 }), job({ id: 2, floor_pos: 2 }), job({ id: 3, floor_pos: 3 })];
  assert.deepEqual(moveWithin(lane, 3, 'up'), [{ stage_id: 3, floor_pos: 2 }, { stage_id: 2, floor_pos: 3 }]);
});

test('moveWithin pushes a job one place down its lane', () => {
  const lane = [job({ id: 1, floor_pos: 1 }), job({ id: 2, floor_pos: 2 })];
  assert.deepEqual(moveWithin(lane, 1, 'down'), [{ stage_id: 1, floor_pos: 2 }, { stage_id: 2, floor_pos: 1 }]);
});

test('the first move on an all-null lane writes every row, not two nulls', () => {
  const lane = [job({ id: 1, queue_pos: 1 }), job({ id: 2, queue_pos: 2 }), job({ id: 3, queue_pos: 3 })];
  const writes = moveWithin(lane, 3, 'up');
  assert.deepEqual(writes, [{ stage_id: 1, floor_pos: 1 }, { stage_id: 3, floor_pos: 2 }, { stage_id: 2, floor_pos: 3 }]);
});

test('moving off either end is a no-op, not an error', () => {
  const lane = [job({ id: 1, floor_pos: 1 }), job({ id: 2, floor_pos: 2 })];
  assert.deepEqual(moveWithin(lane, 1, 'up'), []);
  assert.deepEqual(moveWithin(lane, 2, 'down'), []);
});

test('moving a job that is not in the lane is a no-op', () => {
  assert.deepEqual(moveWithin([job({ id: 1, floor_pos: 1 })], 99, 'up'), []);
});

// ── splitByMachine ────────────────────────────────────────────────────────
test('splitByMachine gives each machine only its own pinned jobs', () => {
  const jobs = [job({ id: 1, machine_id: 10 }), job({ id: 2, machine_id: 11 })];
  const { pinned } = splitByMachine(jobs, [10, 11]);
  assert.deepEqual(pinned.get(10).map(j => j.stage_id), [1]);
  assert.deepEqual(pinned.get(11).map(j => j.stage_id), [2]);
});

test('an unpinned job is listed ONCE for the section, not under every machine', () => {
  const jobs = [job({ id: 1 })];
  const { pinned, unpinned } = splitByMachine(jobs, [10, 11, 12]);
  assert.deepEqual(unpinned.map(j => j.stage_id), [1]);
  for (const id of [10, 11, 12]) assert.deepEqual(pinned.get(id), []);
});

test('a job pinned to a machine outside this board still appears in the section', () => {
  const jobs = [job({ id: 1, machine_id: 99 })];
  const { unpinned } = splitByMachine(jobs, [10]);
  assert.deepEqual(unpinned.map(j => j.stage_id), [1]);
});

test('splitByMachine returns every lane in board order', () => {
  const jobs = [job({ id: 1, machine_id: 10, floor_pos: 2 }), job({ id: 2, machine_id: 10, floor_pos: 1 })];
  assert.deepEqual(splitByMachine(jobs, [10]).pinned.get(10).map(j => j.stage_id), [2, 1]);
});

test('splitByMachine keeps the running job at the head of its machine lane', () => {
  const jobs = [
    job({ id: 1, machine_id: 10, floor_pos: 1, state: 'queued' }),
    job({ id: 2, machine_id: 10, floor_pos: 5, state: 'running' }),
  ];
  assert.deepEqual(splitByMachine(jobs, [10]).pinned.get(10).map(j => j.stage_id), [2, 1]);
});

test('splitByMachine handles a section with no machines at all', () => {
  const { pinned, unpinned } = splitByMachine([job({ id: 1 })], []);
  assert.equal(pinned.size, 0);
  assert.deepEqual(unpinned.map(j => j.stage_id), [1]);
});
