import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitBoardForLine } from './routes/board.js';

// commitBoardForLine runs INSIDE its caller's transaction, and every statement
// it issues must therefore go through the `qc` it is handed.
//
// A read that reaches for the module-level pool helpers (`q` / `one`) instead
// is not merely a stale read — on Vercel it is a deadlock. poolLimits() caps a
// serverless pool at ONE client (db.js), tx() holds that client for the whole
// transaction, and a pool query issued from inside the callback queues for a
// client that only the blocked transaction can release. After
// connectionTimeoutMillis the pool gives up with "timeout exceeded when trying
// to connect", the transaction rolls back, and the planner sees a dead button.
//
// Both tests below drive the real function with a stub `qc`. No pool is ever
// connected, so `pool` is undefined and any escape to `q`/`one` throws a
// TypeError — which is exactly the signal these tests exist to catch.

// A `qc` that answers every statement commitBoardForLine legitimately issues,
// and records them. Anything it does not recognise is a test bug, not a pass.
function stubQc({ available = 5_000, lines = [], allocations = [], material = 'FBB 250 GSM 25×36' } = {}) {
  const seen = [];
  const inserts = [];
  const qc = async (sql, params = []) => {
    seen.push({ sql, params });
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/FROM stock_batches/.test(sql)) return [{ q: available }];
    if (/FROM order_lines ol/.test(sql)) return lines;                 // linesFor()
    if (/FROM board_allocations/.test(sql)) return allocations;        // allocationsFor()
    if (/INSERT INTO board_allocations/.test(sql)) { inserts.push(params); return []; }
    if (/FROM order_lines\s+WHERE id/.test(sql)) return [{ id: params[0], status: 'pending' }];
    if (/FROM materials\s+WHERE id/.test(sql)) return [{ name: material }];
    throw new Error(`stub qc got an unexpected statement: ${sql}`);
  };
  return { qc, seen, inserts };
}

// The engine freezes board while the line is still 'pending' — the status flip
// to 'planned' happens AFTER the freeze block in POST /order-lines/:id/plan. So
// linesFor(), which filters on BOARD_DEMAND_STATUSES ('planned','ready',
// 'in_production'), never contains the line being planned, and the fallback
// lookup fires on EVERY first plan save. That makes this the common path, not
// an edge case: board.js's own comment above /board/:materialId/position/:lineId
// already records that the line "is usually still 'pending' while the Planning
// Engine is open on it".
test('freezing board for a line not yet in the demand set stays inside the caller transaction', async () => {
  const { qc, seen, inserts } = stubQc({ available: 5_000, lines: [], allocations: [] });

  let out, err = null;
  try {
    out = await commitBoardForLine({
      materialId: 3021, lineId: 8814, want: 1_200,
      reason: 'Frozen by the planning engine', origin: 'plan_lock', user: 'Anik',
    }, qc);
  } catch (e) { err = e; }

  assert.equal(err, null,
    'commitBoardForLine escaped its caller\'s transaction — it must resolve the order line '
    + `through qc, never the pool. Got: ${err?.message}`);
  assert.equal(out.committed, 1_200, 'the whole want should be frozen against 5,000 free sheets');
  assert.equal(inserts.length, 1, 'exactly one board_allocations row');
  assert.equal(inserts[0][5], 'plan_lock', 'the freeze must be marked origin=plan_lock');
  assert.ok(seen.some(s => /FROM order_lines\s+WHERE id/.test(s.sql)),
    'the line lookup must be one of the statements qc was asked to run');
});

// The same escape sits in the refusal path: naming the board in the
// COMMIT_EXCEEDS_FREE message reads `materials` off the pool. It is reached
// from POST /board/commit, where `want` is the planner's own figure and is not
// capped at free.
test('refusing an over-commit names the board through the caller transaction', async () => {
  const { qc } = stubQc({ available: 400, lines: [], allocations: [] });

  const err = await commitBoardForLine({
    materialId: 3021, lineId: 8814, want: 1_200,
    reason: 'Committed from the planning engine', origin: null, user: 'Anik',
  }, qc).then(() => null, e => e);

  assert.ok(err, 'committing 1,200 against 400 free sheets must be refused');
  assert.equal(err.status, 409,
    `the refusal must be a structured 409, not a pool failure. Got: ${err.message}`);
  assert.equal(err.body?.code, 'COMMIT_EXCEEDS_FREE');
  assert.match(err.message, /FBB 250 GSM 25×36/,
    'the refusal names the board, read through qc');
});
