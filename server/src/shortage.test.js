// A shortage is a line that will NEVER get what it is owed, not one that is
// merely waiting. Everything here defends that distinction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isShortage, shortfallOf, productionOver } from './shortage.js';
import { netProduceQty } from './helpers.js';

const L = o => ({ qty: o.qty, dispatched_qty: o.done || 0,
  suggested_dispatch: o.sugg ?? 0, jc_status: o.jc || 'closed' });

test('production still running is NOT a shortage, however short it looks', () => {
  // The whole trap: mid-run a line always looks short. Closing or re-planning
  // it here would abandon a job that is still on the floor.
  for (const jc of ['open', 'in_progress', 'split']) {
    const l = L({ qty: 10000, sugg: 1000, jc });
    assert.equal(productionOver(l), false, `${jc} must not read as finished`);
    assert.equal(isShortage(l), false, `${jc} must not read as a shortage`);
  }
});

test('closed card that still cannot fill the order IS a shortage', () => {
  const l = L({ qty: 10000, sugg: 9000, jc: 'closed' });
  assert.equal(isShortage(l), true);
  assert.equal(shortfallOf(l), 1000);
});

test('closed card that CAN fill the order is not a shortage', () => {
  assert.equal(isShortage(L({ qty: 10000, sugg: 10000 })), false);
  assert.equal(isShortage(L({ qty: 10000, sugg: 11000 })), false);  // over-run
  assert.equal(shortfallOf(L({ qty: 10000, sugg: 11000 })), 0);
});

test('what already shipped counts towards the order', () => {
  const l = L({ qty: 10000, done: 7000, sugg: 2000 });
  assert.equal(shortfallOf(l), 1000);   // 3000 still owed, 2000 available
  assert.equal(isShortage(l), true);
});

test('a fully shipped line is not short even with nothing left in stock', () => {
  assert.equal(isShortage(L({ qty: 10000, done: 10000, sugg: 0 })), false);
});

// ── the re-plan quantity ─────────────────────────────────────────────────────
test('a re-planned short line makes only the BALANCE, not the whole order again', () => {
  // This is the 10x over-production trap: before dispatched_qty was netted,
  // sending this line back to Planning raised a card for all 10,000.
  assert.equal(netProduceQty({ qty: 10000, dispatched_qty: 9000 }), 1000);
});

test('netting stacks with FG already consumed, and never goes negative', () => {
  assert.equal(netProduceQty({ qty: 10000, fg_consumed_qty: 2000, dispatched_qty: 7000 }), 1000);
  assert.equal(netProduceQty({ qty: 10000, fg_consumed_qty: 4000, dispatched_qty: 9000 }), 0);
});

test('an ordinary line is untouched — nothing dispatched, nothing netted', () => {
  assert.equal(netProduceQty({ qty: 10000 }), 10000);
  assert.equal(netProduceQty({ qty: 10000, dispatched_qty: 0 }), 10000);
});
