import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardSort, normalise, moveWithin, splitByMachine } from './floor-order.js';

const job = (o) => ({ stage_id: o.id, job_card_id: o.id, stage: 'die_cutting',
  machine_id: null, floor_pos: null, queue_pos: null, delivery_date: null, ...o });

test('boardSort puts the floor order ahead of Print Planning queue_pos', () => {
  const a = job({ id: 1, floor_pos: 2, queue_pos: 1 });
  const b = job({ id: 2, floor_pos: 1, queue_pos: 9 });
  assert.deepEqual([a, b].sort(boardSort).map(j => j.stage_id), [2, 1]);
});

test('boardSort falls back to queue_pos, then delivery date, then job card id', () => {
  const a = job({ id: 1, queue_pos: 2 });
  const b = job({ id: 2, queue_pos: 1 });
  assert.deepEqual([a, b].sort(boardSort).map(j => j.stage_id), [2, 1]);

  const c = job({ id: 3, delivery_date: '2026-08-01' });
  const d = job({ id: 4, delivery_date: '2026-07-30' });
  assert.deepEqual([c, d].sort(boardSort).map(j => j.stage_id), [4, 3]);

  const e = job({ id: 6 });
  const f = job({ id: 5 });
  assert.deepEqual([e, f].sort(boardSort).map(j => j.stage_id), [5, 6]);
});

test('a job with no floor_pos sorts after one that has it', () => {
  const a = job({ id: 1 });
  const b = job({ id: 2, floor_pos: 7 });
  assert.deepEqual([a, b].sort(boardSort).map(j => j.stage_id), [2, 1]);
});

test('normalise numbers a lane 1..N in board order', () => {
  const lane = [job({ id: 1, queue_pos: 3 }), job({ id: 2, queue_pos: 1 }), job({ id: 3, queue_pos: 2 })];
  assert.deepEqual(normalise(lane).map(j => [j.stage_id, j.floor_pos]), [[2, 1], [3, 2], [1, 3]]);
});

test('normalise does not mutate its input', () => {
  const lane = [job({ id: 1 })];
  normalise(lane);
  assert.equal(lane[0].floor_pos, null);
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

test('splitByMachine handles a section with no machines at all', () => {
  const { pinned, unpinned } = splitByMachine([job({ id: 1 })], []);
  assert.equal(pinned.size, 0);
  assert.deepEqual(unpinned.map(j => j.stage_id), [1]);
});
