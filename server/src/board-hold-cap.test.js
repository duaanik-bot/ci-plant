import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceMixPlan } from './helpers.js';

// The Board Mix used to REFUSE when it outgrew free stock — a 409 carrying
// BOARD_NOT_FREE, a code that sat in the client's HANDLED_CODES (which
// suppresses the central toast) with no screen drawing a dialog for it. So the
// refusal arrived as nothing at all: Lock Plan did not save, did not complain,
// did not move. The planner who raised the wastage past what the board covered
// saw only that the last figure which saved was the default, and reported it as
// "the wastage will not go above 200".
//
// It now CAPS instead, the same rule the no-mix freeze in orders.js has always
// applied ("physics hard, paperwork soft"). These tests pin the two halves that
// make capping safe: the PLAN is written whole (coverage reads job_board_mix,
// so a job planned onto board the shelf cannot yet cover still reads covered),
// and the HOLD never exceeds what is actually free.

// A `qc` that records every statement and answers the two the writer reads.
function recorder() {
  const calls = [];
  let mixId = 0;
  const qc = async (sql, params = []) => {
    calls.push({ sql, params });
    if (/INSERT INTO job_board_mix/.test(sql)) return [{ id: ++mixId }];
    return [];                                  // releases, deletes, absorbs
  };
  const inserts = kind => calls
    .filter(c => new RegExp(`INSERT INTO ${kind}`).test(c.sql))
    .map(c => c.params);
  return { qc, calls, inserts };
}

const MIX = m => inserts => inserts.map(p => ({ material_id: p[1], sheets: p[3] })).filter(x => x.material_id === m);
const HOLD = m => inserts => inserts.map(p => ({ material_id: p[0], qty: p[2] })).filter(x => x.material_id === m);

test('no caps at all holds exactly what is planned — the pre-cap behaviour', async () => {
  const r = recorder();
  await replaceMixPlan(7, [{ material_id: 3, sheets: 900, ups: 2, covers: 900, role: 'planned' }],
    r.qc, 'anik');
  assert.deepEqual(HOLD(3)(r.inserts('board_allocations')), [{ material_id: 3, qty: 900 }]);
});

test('a mix beyond free stock still PLANS in full but only HOLDS what is free', async () => {
  const r = recorder();
  await replaceMixPlan(7, [{ material_id: 3, sheets: 900, ups: 2, covers: 900, role: 'planned' }],
    r.qc, 'anik', new Map([[3, 500]]));
  // The plan is the planner's intent, untouched — this is what coverage reads.
  assert.deepEqual(MIX(3)(r.inserts('job_board_mix')), [{ material_id: 3, sheets: 900 }]);
  // The reservation is only ever what the warehouse can actually back.
  assert.deepEqual(HOLD(3)(r.inserts('board_allocations')), [{ material_id: 3, qty: 500 }]);
});

test('two rows on the SAME board share one ceiling instead of each spending it', async () => {
  const r = recorder();
  await replaceMixPlan(7, [
    { material_id: 3, sheets: 400, ups: 2, covers: 400, role: 'planned' },
    { material_id: 3, sheets: 400, ups: 2, covers: 400, role: 'substitute' },
  ], r.qc, 'anik', new Map([[3, 500]]));
  assert.deepEqual(HOLD(3)(r.inserts('board_allocations')),
    [{ material_id: 3, qty: 400 }, { material_id: 3, qty: 100 }],
    'the second row may only take the 100 the first left behind');
});

test('a row capped to nothing writes no hold, and still writes its mix row', async () => {
  const r = recorder();
  await replaceMixPlan(7, [{ material_id: 3, sheets: 900, ups: 2, covers: 900, role: 'planned' }],
    r.qc, 'anik', new Map([[3, 0]]));
  assert.equal(r.inserts('board_allocations').length, 0,
    'a zero hold must not be written — there is no board on the shelf to reserve');
  assert.deepEqual(MIX(3)(r.inserts('job_board_mix')), [{ material_id: 3, sheets: 900 }],
    'the plan survives a shelf that cannot cover it — that is the whole point');
});

test('a board the cap never measured is held in full, not silently held at nothing', async () => {
  const r = recorder();
  await replaceMixPlan(7, [{ material_id: 9, sheets: 250, ups: 2, covers: 250, role: 'substitute' }],
    r.qc, 'anik', new Map([[3, 0]]));
  assert.deepEqual(HOLD(9)(r.inserts('board_allocations')), [{ material_id: 9, qty: 250 }]);
});

// A gang measures its run mix ONCE and then writes it member by member. If each
// member got a private copy of the ceiling, every one of them would hold the
// whole free shelf — the exact double-hold the cap exists to prevent.
test('a run’s members draw down ONE shared ceiling across separate calls', async () => {
  const r = recorder();
  const caps = new Map([[3, 500]]);
  await replaceMixPlan(11, [{ material_id: 3, sheets: 300, ups: 2, covers: 300, role: 'planned' }],
    r.qc, 'anik', caps);
  await replaceMixPlan(12, [{ material_id: 3, sheets: 300, ups: 2, covers: 300, role: 'planned' }],
    r.qc, 'anik', caps);
  assert.deepEqual(HOLD(3)(r.inserts('board_allocations')),
    [{ material_id: 3, qty: 300 }, { material_id: 3, qty: 200 }],
    'the second member takes only the 200 the first left');
  assert.equal(caps.get(3), 0, 'the shared ceiling must be spent, not reset per member');
});
