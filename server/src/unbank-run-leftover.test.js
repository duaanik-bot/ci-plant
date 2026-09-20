// unbankRunLeftover skips a batch that is ALREADY fully dead (qty=0 AND
// initial_qty=0 — the mark a prior sweep by this same function leaves), so a
// co-printed run's LAST member settling its layout on every later edit does
// not keep writing a fresh leftover_unplanned audit line over a bank that is
// already gone. A batch CONSUMED TO ZERO BY ANOTHER JOB (qty=0, initial_qty>0)
// is not dead — it is a live bank record being formally closed out here for
// the first time — and must still be swept, per the UPDATE's own comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unbankRunLeftover } from './helpers.js';

function harness(batches) {
  const log = { movements: [], updates: [], audits: [] };
  const qc = async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT \* FROM stock_batches WHERE batch_no LIKE \$1 ORDER BY id/.test(s)) return batches.map(b => ({ ...b }));
    if (/^INSERT INTO stock_movements/.test(s)) { log.movements.push(p); return []; }
    if (/^UPDATE stock_batches SET qty=0, initial_qty=0, status='exhausted' WHERE id=\$1/.test(s)) { log.updates.push(p[0]); return []; }
    if (/^INSERT INTO audit_log/.test(s)) { log.audits.push(p); return []; }
    throw new Error('unexpected qc: ' + s);
  };
  return { qc, log };
}

test('all batches already dead — no UPDATE, no audit, returns false', async () => {
  const h = harness([{ id: 1, batch_no: 'LO-PLAN-RUN-9-544', material_id: 544, qty: 0, initial_qty: 0 }]);
  const moved = await unbankRunLeftover(9, h.qc, null, 'test', 'why');
  assert.deepEqual(h.log.movements, []);
  assert.deepEqual(h.log.updates, []);
  assert.deepEqual(h.log.audits, []);
  assert.equal(moved, false);
});

test('one live, one dead — one movement, one UPDATE, one audit, returns true', async () => {
  const h = harness([
    { id: 1, batch_no: 'LO-PLAN-RUN-9-544', material_id: 544, qty: 500, initial_qty: 500 },
    { id: 2, batch_no: 'LO-PLAN-RUN-9-777', material_id: 777, qty: 0, initial_qty: 0 },
  ]);
  const moved = await unbankRunLeftover(9, h.qc, null, 'test', 'why');
  assert.equal(h.log.movements.length, 1, 'only the live batch gets a reversing movement');
  assert.equal(h.log.movements[0][1], 1, 'the movement is keyed to the live batch');
  assert.deepEqual(h.log.updates, [1], 'the dead batch is not re-written');
  assert.equal(h.log.audits.length, 1);
  assert.equal(moved, true);
});

test('consumed-to-zero with initial_qty > 0 is still zeroed and audited, but returns false — nothing moved', async () => {
  const h = harness([{ id: 3, batch_no: 'LO-PLAN-RUN-9-544', material_id: 544, qty: 0, initial_qty: 500 }]);
  const moved = await unbankRunLeftover(9, h.qc, null, 'test', 'why');
  assert.deepEqual(h.log.movements, [], 'qty is already 0 — nothing left to reverse');
  assert.deepEqual(h.log.updates, [3], 'still formally closed out — it was a live bank until now');
  assert.equal(h.log.audits.length, 1);
  // "Moved" means a leftover_in movement actually fired — qty was already 0,
  // so closing the record out is not the same as reversing stock.
  assert.equal(moved, false);
});
