// Locking a COMBINED RUN's sheet after its card is minted.
//
// The old rule sent every shared-sheet lock through assertPlanningOnlyGangEdit
// — a guard written for BREAKING a run — so CI-MRG-0009 answered a coating
// change with "Gang cannot be broken after job card CI-JC-0048 is created",
// about a run that is not a gang and an edit that breaks nothing. These cases
// are the replacement rule: paperwork is correctable, physics is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSheetEditable } from './routes/gangs.js';

// A fake `oc` that answers by which table the SQL names — the three reads the
// guard makes, in order: the card, its stages, its consumption.
const ocOf = ({ card = null, started = null, consumed = null } = {}) => async sql => {
  if (sql.includes('FROM job_cards')) return card;
  if (sql.includes('FROM job_stages')) return started;
  if (sql.includes('FROM stock_movements')) return consumed;
  throw new Error(`unexpected query: ${sql}`);
};

const MERGE = { id: 4, kind: 'merge', gang_number: 'CI-MRG-0009' };
const GANG = { id: 5, kind: 'gang', gang_number: 'CI-GANG-0012' };
const CARD = { id: 48, jc_number: 'CI-JC-0048' };

test('a gang is never re-judged here — it keeps the old planning-only rule', async () => {
  // A gang splits into child cards at die cutting, so its sheet is load-bearing
  // for a route this guard cannot see. Returning null hands it back to
  // assertPlanningOnlyGangEdit unchanged — the whole point of scoping the
  // relaxation to combined runs.
  assert.equal(await assertSheetEditable(GANG, ocOf({ card: CARD })), null);
});

test('a combined run still in planning is not this rule either', async () => {
  // No card — nothing to protect and nothing to re-stamp; the caller falls
  // through to the ordinary guard exactly as before.
  assert.equal(await assertSheetEditable(MERGE, ocOf({ card: null })), null);
});

test('THE FIX: a minted but unstarted card lets the sheet through, and names itself', async () => {
  // CI-MRG-0009's exact state in the report: the card exists, no stage has
  // moved, no board drawn. The guard returns the card so the caller can keep
  // its sheet figures in step rather than silently half-updating.
  const card = await assertSheetEditable(MERGE, ocOf({ card: CARD }));
  assert.deepEqual(card, CARD);
});

test('a started stage refuses — the sheet under a running press is not a form field', async () => {
  await assert.rejects(
    () => assertSheetEditable(MERGE, ocOf({ card: CARD, started: { stage: 'printing' } })),
    e => {
      assert.equal(e.status, 409);
      assert.match(e.message, /CI-JC-0048 has already started printing/);
      return true;
    });
});

test('issued board refuses — the correction arrives after the physics', async () => {
  await assert.rejects(
    () => assertSheetEditable(MERGE, ocOf({ card: CARD, consumed: { x: 1 } })),
    e => {
      assert.equal(e.status, 409);
      assert.match(e.message, /Board has already been issued to CI-JC-0048/);
      return true;
    });
});

test('the refusals say what to do, not just no', async () => {
  // Every refusal names the one action that unblocks it. The old blocker got
  // this right and it is the part worth keeping.
  for (const state of [{ started: { stage: 'cutting' } }, { consumed: { x: 1 } }]) {
    await assert.rejects(
      () => assertSheetEditable(MERGE, ocOf({ card: CARD, ...state })),
      e => (assert.match(e.message, /Reverse the job card back to Planning first\./), true));
  }
});

test('a stage that has merely been created does not count as started', async () => {
  // job_stages rows are minted pending with the card. Judging on their
  // EXISTENCE rather than their status would refuse every card ever made —
  // the same trap /convert-to-merge documents for CI-GANG-0007.
  const oc = async sql => {
    if (sql.includes('FROM job_cards')) return CARD;
    // The guard must filter on status <> 'pending' in SQL; a fake that ignores
    // the filter and returns a pending row would pass a broken guard, so
    // assert the filter is actually asked for.
    if (sql.includes('FROM job_stages')) {
      assert.match(sql, /status\s*<>\s*'pending'/);
      return null;
    }
    return null;
  };
  assert.deepEqual(await assertSheetEditable(MERGE, oc), CARD);
});

test('only the RUN-level card is consulted, never a split child', async () => {
  // A combined run never splits, but the query is the same shape a gang parent
  // uses; reading a child card would judge the wrong row.
  const oc = async sql => {
    if (sql.includes('FROM job_cards')) {
      assert.match(sql, /parent_job_card_id IS NULL/);
      return CARD;
    }
    return null;
  };
  assert.deepEqual(await assertSheetEditable(MERGE, oc), CARD);
});
