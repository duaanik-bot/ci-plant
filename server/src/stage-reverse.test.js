import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageReverseMoves, reverseManifest, gangReverseMerge, reverseNeedsApprover } from './helpers.js';

// ── stageReverseMoves ─────────────────────────────────────────────────
// One hop = one STATION boundary. Leaving a station is a single move even
// from 'completed' (un-complete + un-start in one transaction), because
// "send printing back to cutting" is one intent on the floor. Staying at
// the station to fix its output is the separate 'reopen' move.

test('reverse: a completed stage can reopen in place or go back a station', () => {
  const { moves, blockers } = stageReverseMoves({
    stage: 'printing', status: 'completed', jcStatus: 'in_progress',
    prevStage: { stage: 'cutting', status: 'completed' },
  });
  assert.deepEqual(blockers, []);
  assert.deepEqual(moves.map(m => m.hop), ['reopen', 'send_back', 'pull_back']);
  assert.equal(moves.find(m => m.hop === 'send_back').target, 'cutting');
});

test('reverse: a running stage can only go back a station, not reopen', () => {
  for (const status of ['in_progress', 'partially_completed', 'hold']) {
    const { moves, blockers } = stageReverseMoves({
      stage: 'printing', status, jcStatus: 'in_progress',
      prevStage: { stage: 'cutting', status: 'completed' },
    });
    assert.deepEqual(blockers, [], `${status} should not block`);
    // The point here is that 'reopen' is withheld — there is nothing completed
    // to reopen. Leaving the station is still offered, both one hop and all the
    // way out.
    assert.deepEqual(moves.map(m => m.hop), ['send_back', 'pull_back'], `${status} must not offer reopen`);
  }
});

test('reverse: the first stage hands back to print planning, not a stage', () => {
  const { moves } = stageReverseMoves({
    stage: 'cutting', status: 'in_progress', jcStatus: 'in_progress', prevStage: null,
  });
  assert.equal(moves.find(m => m.hop === 'send_back').target, 'print_planning');
});

test('reverse: a pending stage has nothing to send back', () => {
  const { moves, blockers } = stageReverseMoves({
    stage: 'printing', status: 'pending', jcStatus: 'in_progress',
    prevStage: { stage: 'cutting', status: 'completed' },
  });
  assert.deepEqual(moves, []);
  assert.match(blockers[0], /has not started/i);
});

test('reverse: a started downstream stage blocks and names what to reverse first', () => {
  const { moves, blockers } = stageReverseMoves({
    stage: 'cutting', status: 'completed', jcStatus: 'in_progress', prevStage: null,
    downstreamStages: [{ stage: 'die_cutting', status: 'in_progress' }],
  });
  assert.deepEqual(moves, []);
  assert.match(blockers[0], /die cutting/i);
  assert.match(blockers[0], /reverse it first/i);
});

test('reverse: pending downstream stages do NOT block', () => {
  const { blockers } = stageReverseMoves({
    stage: 'cutting', status: 'completed', jcStatus: 'in_progress', prevStage: null,
    downstreamStages: [{ stage: 'printing', status: 'pending' }],
  });
  assert.deepEqual(blockers, []);
});

test('reverse: a closed or split job card cannot be reversed here', () => {
  for (const jcStatus of ['closed', 'split']) {
    const { moves, blockers } = stageReverseMoves({
      stage: 'printing', status: 'completed', jcStatus,
      prevStage: { stage: 'cutting', status: 'completed' },
    });
    assert.deepEqual(moves, []);
    assert.match(blockers[0], /closed|split/i);
  }
});

test('reverse: the nearest started downstream stage is the one named', () => {
  const { blockers } = stageReverseMoves({
    stage: 'cutting', status: 'completed', jcStatus: 'in_progress', prevStage: null,
    downstreamStages: [
      { stage: 'printing', status: 'completed' },
      { stage: 'die_cutting', status: 'in_progress' },
    ],
  });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /printing/i);
});

// ── reverseManifest ───────────────────────────────────────────────────
// What a send_back will undo, itemised. This is both the confirm dialog the
// operator signs off and the audit line, so it must never claim an effect the
// reverse does not actually make.

test('manifest: a stage that never produced has nothing to undo', () => {
  const { items, warnings } = reverseManifest({ isFirstStage: false });
  assert.deepEqual(items, []);
  assert.deepEqual(warnings, []);
});

test('manifest: the first stage returns the board it consumed', () => {
  const { items } = reverseManifest({ isFirstStage: true, boardNet: 1200 });
  const board = items.find(i => i.kind === 'board_return');
  assert.equal(board.qty, 1200);
  assert.match(board.text, /1200/);
});

test('manifest: a later stage never returns board — it never consumed any', () => {
  const { items } = reverseManifest({ isFirstStage: false, boardNet: 1200 });
  assert.equal(items.find(i => i.kind === 'board_return'), undefined);
});

test('manifest: a float-hair board net is not a phantom sheet to return', () => {
  const { items } = reverseManifest({ isFirstStage: true, boardNet: 1e-9 });
  assert.deepEqual(items, []);
});

test('manifest: banked offcut is un-banked only as far as it still exists', () => {
  const { items, warnings } = reverseManifest({ leftoverBanked: 500, leftoverAvailable: 200 });
  const lo = items.find(i => i.kind === 'leftover_unbank');
  assert.equal(lo.qty, 200);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /300/);
});

test('manifest: a fully consumed offcut bank warns and un-banks nothing', () => {
  const { items, warnings } = reverseManifest({ leftoverBanked: 500, leftoverAvailable: 0 });
  assert.equal(items.find(i => i.kind === 'leftover_unbank'), undefined);
  assert.match(warnings[0], /500/);
});

test('manifest: recorded scrap is reversed out of wastage', () => {
  const { items } = reverseManifest({ qtyScrap: 40 });
  assert.equal(items.find(i => i.kind === 'wastage_reversal').qty, 40);
});

test('manifest: extra sheets issued to the stage are clawed back', () => {
  const { items } = reverseManifest({ extraIssued: 250 });
  assert.equal(items.find(i => i.kind === 'extra_sheets_return').qty, 250);
});

test('manifest: day-wise runs are listed for deletion', () => {
  const { items } = reverseManifest({ runCount: 3 });
  assert.equal(items.find(i => i.kind === 'runs_deleted').qty, 3);
});

// ── gangReverseMerge ──────────────────────────────────────────────────
// A gang is one physical run across several job cards, so a stage can only
// leave a station if EVERY member can leave it — reversing one card's printing
// while its gang-mates stay printed desyncs the run on the floor.

test('gang: all members clear — the hop is offered once', () => {
  const { moves, blockers } = gangReverseMerge([
    { jc_number: 'JC-1', moves: [{ hop: 'send_back', target: 'cutting' }], blockers: [] },
    { jc_number: 'JC-2', moves: [{ hop: 'send_back', target: 'cutting' }], blockers: [] },
  ]);
  assert.deepEqual(blockers, []);
  assert.deepEqual(moves.map(m => m.hop), ['send_back']);
});

test('gang: one blocked member blocks the whole run and is named', () => {
  const { moves, blockers } = gangReverseMerge([
    { jc_number: 'JC-1', moves: [{ hop: 'send_back', target: 'cutting' }], blockers: [] },
    { jc_number: 'JC-2', moves: [], blockers: ['die cutting is already in progress — reverse it first'] },
  ]);
  assert.deepEqual(moves, []);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /JC-2/);
  assert.match(blockers[0], /die cutting/);
});

test('gang: every blocked member is listed, not just the first', () => {
  const { blockers } = gangReverseMerge([
    { jc_number: 'JC-1', moves: [], blockers: ['printing is already completed — reverse it first'] },
    { jc_number: 'JC-2', moves: [], blockers: ['die cutting is already in progress — reverse it first'] },
  ]);
  assert.equal(blockers.length, 2);
  assert.match(blockers[0], /JC-1/);
  assert.match(blockers[1], /JC-2/);
});

test('gang: a single-card run behaves exactly like a lone stage', () => {
  const { moves, blockers } = gangReverseMerge([
    { jc_number: 'JC-9', moves: [{ hop: 'reopen', target: 'printing' }, { hop: 'send_back', target: 'cutting' }], blockers: [] },
  ]);
  assert.deepEqual(blockers, []);
  assert.deepEqual(moves.map(m => m.hop), ['reopen', 'send_back']);
});

// ── reverseNeedsApprover ──────────────────────────────────────────────
// A station supervisor may hand work back to the station before them — that is
// ordinary floor traffic. Two things are not: moving stock, and taking a job
// off the floor entirely. Those need the plant head's flag, the same way an
// extra-sheet approval does (a flag, never a role — plant logins carry
// role=admin and must not inherit the decision).

test('approver: handing work back one station is ordinary floor traffic', () => {
  assert.equal(reverseNeedsApprover({ target: 'cutting', items: [] }), false);
});

test('approver: leaving the floor for print planning needs the flag', () => {
  assert.equal(reverseNeedsApprover({ target: 'print_planning', items: [] }), true);
});

test('approver: anything that moves stock needs the flag', () => {
  for (const kind of ['board_return', 'leftover_unbank', 'extra_sheets_return']) {
    assert.equal(reverseNeedsApprover({ target: 'cutting', items: [{ kind }] }), true, kind);
  }
});

test('approver: deleting run rows or reversing wastage is not a stock move', () => {
  assert.equal(reverseNeedsApprover({
    target: 'cutting', items: [{ kind: 'runs_deleted' }, { kind: 'wastage_reversal' }],
  }), false);
});

// ── pull_back: one action, off the floor and back to the Job Card ─────
// Walking a job back one station at a time is the safe MECHANISM, not the
// intent. When the plant decides a job is wrong they want it OUT — editable
// again at the Job Card station, board returned, press released — without
// clicking through every station it passed. Offered under exactly the same
// guard as send_back: nothing downstream may have started.

test('pull_back: offered alongside send_back on a running stage', () => {
  const { moves } = stageReverseMoves({
    stage: 'cutting', status: 'in_progress', jcStatus: 'in_progress', prevStage: null,
  });
  assert.deepEqual(moves.map(m => m.hop), ['send_back', 'pull_back']);
  assert.equal(moves.find(m => m.hop === 'pull_back').target, 'job_card');
});

test('pull_back: offered from a mid-route stage too, not just the first', () => {
  const { moves } = stageReverseMoves({
    stage: 'printing', status: 'in_progress', jcStatus: 'in_progress',
    prevStage: { stage: 'cutting', status: 'completed' },
  });
  const pb = moves.find(m => m.hop === 'pull_back');
  assert.equal(pb.target, 'job_card');
  assert.match(pb.label, /job card/i);
});

test('pull_back: withheld the moment anything downstream has started', () => {
  const { moves, blockers } = stageReverseMoves({
    stage: 'cutting', status: 'completed', jcStatus: 'in_progress', prevStage: null,
    downstreamStages: [{ stage: 'printing', status: 'in_progress' }],
  });
  assert.deepEqual(moves, []);
  assert.match(blockers[0], /printing/i);
});

test('pull_back: a completed stage can still be pulled out', () => {
  const { moves } = stageReverseMoves({
    stage: 'cutting', status: 'completed', jcStatus: 'in_progress', prevStage: null,
  });
  assert.deepEqual(moves.map(m => m.hop), ['reopen', 'send_back', 'pull_back']);
});

test('approver: leaving the floor for the job card needs the flag', () => {
  assert.equal(reverseNeedsApprover({ target: 'job_card', items: [] }), true);
});
