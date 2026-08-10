import test from 'node:test';
import assert from 'node:assert/strict';
import { plateStateOf, stampPlateState, worstPlateState } from './helpers.js';

// One vocabulary for "can this job print?", mirroring boardStateOf. Green means the
// plates are PHYSICALLY IN HAND — the same bar assertPlateReadyForPrinting enforces
// when the press tries to start — so the badge and the gate can never disagree.
//
// The two troubled states split on who has to act, exactly as the board's do:
//   on_order — somebody has already bought them; wait.
//   none     — nobody has; act.

test('plates are OK only when every component is physically in hand', () => {
  assert.equal(plateStateOf([
    { status: 'available' }, { status: 'issued' }, { status: 'reserved' }, { status: 'verified_existing' },
  ]), 'ready');
});

test('one component still to arrive holds the whole job back', () => {
  // Three of four on the rack is not a job that can print.
  assert.equal(plateStateOf([
    { status: 'available' }, { status: 'available' }, { status: 'available' }, { status: 'ordered' },
  ]), 'on_order');
});

test('bought-and-coming reads differently from nobody-has-acted', () => {
  for (const status of ['approved', 'po_created', 'ordered', 'grn_received']) {
    assert.equal(plateStateOf([{ status }]), 'on_order', `${status} means someone has acted`);
  }
  for (const status of ['pr_required', 'replacement_required', 'not_found', 'verification_required']) {
    assert.equal(plateStateOf([{ status }]), 'none', `${status} still needs somebody to act`);
  }
});

test('the worst component decides, not the best', () => {
  assert.equal(plateStateOf([{ status: 'available' }, { status: 'pr_required' }]), 'none');
  assert.equal(plateStateOf([{ status: 'ordered' }, { status: 'pr_required' }]), 'none');
});

test('cancelled components are not a reason to hold a job', () => {
  assert.equal(plateStateOf([{ status: 'available' }, { status: 'cancelled' }]), 'ready');
});

test('stamping reads one query and gives every row its own verdict', async () => {
  const rows = [{ job_card_id: 1 }, { job_card_id: 2 }, { job_card_id: 3 }];
  let queries = 0;
  const qc = async () => {
    queries += 1;
    return [
      { job_card_id: 1, status: 'available' }, { job_card_id: 1, status: 'issued' },
      { job_card_id: 2, status: 'available' }, { job_card_id: 2, status: 'ordered' },
      // job 3 has no components at all
    ];
  };
  await stampPlateState(rows, { jobCardIdOf: row => row.job_card_id, qc });
  // Job 3 has no plate components: not tracked, so no verdict and no badge.
  assert.deepEqual(rows.map(row => row.plate_state), ['ready', 'on_order', null]);
  assert.equal(queries, 1, 'one query for the whole page, not one per row');
});

test('a line with no job card yet has no plate verdict at all', async () => {
  // Plate requirements are raised when a Job Card is finalised. Before that the
  // question has not started, and stamping `none` would paint every unplanned line
  // on Planning solid red — noise, not information. null means "not asked yet" and
  // the screens render nothing.
  const rows = [{ job_card_id: null }, { job_card_id: 4 }];
  const qc = async () => [{ job_card_id: 4, status: 'available' }];
  await stampPlateState(rows, { jobCardIdOf: row => row.job_card_id, qc });
  assert.equal(rows[0].plate_state, null, 'no job card, no verdict');
  assert.equal(rows[1].plate_state, 'ready');
});

test('a gang prints as one job, so its weakest member decides for all of them', async () => {
  // Same rule the board collapse follows: three members ready and one waiting on a
  // plate is a RUN that cannot go on press.
  const rows = [
    { job_card_id: 1, gang_run_id: 7 },
    { job_card_id: 2, gang_run_id: 7 },
  ];
  const qc = async () => [
    { job_card_id: 1, status: 'available' },
    { job_card_id: 2, status: 'pr_required' },
  ];
  await stampPlateState(rows, { jobCardIdOf: row => row.job_card_id, gangIdOf: row => row.gang_run_id, qc });
  assert.deepEqual(rows.map(row => row.plate_state), ['none', 'none']);
});

test('worstPlateState ranks none above on_order above ready', () => {
  assert.equal(worstPlateState(['ready', 'on_order', 'none']), 'none');
  assert.equal(worstPlateState(['ready', 'on_order']), 'on_order');
  assert.equal(worstPlateState(['ready', 'ready']), 'ready');
  assert.equal(worstPlateState([]), 'ready');
});

test('a job with no plate requirement is NOT TRACKED, which is not the same as missing', () => {
  // The plant flow does not raise plate requirements at all right now — the module
  // is detached from finalisation, printing start and completion (9aedf20). So an
  // empty requirement is the ORDINARY case, and reading it as 'none' would paint a
  // solid red "No Plates — act" on every job card in the plant for a question
  // nobody is currently asking. null renders nothing; the screens stay quiet until
  // a job actually has plates to talk about.
  assert.equal(plateStateOf([]), null);
  assert.equal(plateStateOf(null), null);
  // A requirement that EXISTS and is unmet is still red — that is a real shortage.
  assert.equal(plateStateOf([{ status: 'pr_required' }]), 'none');
});
