import { test } from 'node:test';
import assert from 'node:assert/strict';
// Client-only module — tested from here because the server test runner is the
// only one in the repo. Same precedent as board-math.test.js.
import {
  autoAssigns, resolveMachine, resolveOperator, resolveAssignment,
} from '../../client/src/lib/runAssignment.js';

// The real plant machines this is designed against.
const BOARD  = { id: 11, name: 'Board Cutting Machine', is_default: 1, operators: [{ id: 1, name: 'Ankit' }] };
const LABEL  = { id: 12, name: 'Automatic Label Cutting Machine', is_default: 0, operators: [{ id: 1, name: 'Ankit' }] };
const PRESS1 = { id: 8,  name: 'Offset Printing Press No. 1', is_default: 0, operators: [{ id: 2, name: 'Modi' }] };
const PRESS3 = { id: 13, name: 'Offset Printing Press No. 3', is_default: 0, operators: [{ id: 4, name: 'Shiv Kumar' }] };
const CUTTING = [LABEL, BOARD];      // deliberately alphabetical — LABEL sorts first
const PRESSES = [PRESS1, PRESS3];

// ── autoAssigns ───────────────────────────────────────────────────────
test('autoAssigns: only cutting and printing prefill', () => {
  assert.equal(autoAssigns('cutting'), true);
  assert.equal(autoAssigns('printing'), true);
  assert.equal(autoAssigns('die_cutting'), false);
  assert.equal(autoAssigns('coating'), false);
  assert.equal(autoAssigns('qc'), false);
  assert.equal(autoAssigns(undefined), false);
});

// ── resolveMachine ────────────────────────────────────────────────────
test('resolveMachine: printing takes the press Print Planning assigned', () => {
  const row = { machine_id: null, press_machine_id: 13 };
  assert.equal(resolveMachine('printing', row, PRESSES).id, 13);
});
test('resolveMachine: the planned press beats list order', () => {
  // Press No. 1 sorts first — the old code posted it regardless. Regression guard.
  const row = { machine_id: null, press_machine_id: 13 };
  assert.notEqual(resolveMachine('printing', row, PRESSES).id, 8);
});
test('resolveMachine: a machine already on the stage wins over the plan', () => {
  const row = { machine_id: 8, press_machine_id: 13 };
  assert.equal(resolveMachine('printing', row, PRESSES).id, 8);
});
test('resolveMachine: a planned press outside this station list falls through', () => {
  // Press-scoped operator, or a deactivated press: id 99 is not in the list.
  const row = { machine_id: null, press_machine_id: 99 };
  assert.equal(resolveMachine('printing', row, PRESSES), null);
});
test('resolveMachine: cutting takes the flagged default, not the first in the list', () => {
  const row = { machine_id: null, press_machine_id: 13 };
  assert.equal(resolveMachine('cutting', row, CUTTING).id, 11);
});
test('resolveMachine: cutting ignores the job press entirely', () => {
  // jc.machine_id is the PRESS — it must never resolve a cutting machine.
  const row = { machine_id: null, press_machine_id: 8 };
  assert.equal(resolveMachine('cutting', row, [LABEL]).id, 12);
});
test('resolveMachine: a lone machine wins when nothing is flagged', () => {
  assert.equal(resolveMachine('cutting', { machine_id: null }, [LABEL]).id, 12);
});
test('resolveMachine: several machines, none flagged → nothing resolved', () => {
  const plain = [{ ...LABEL }, { ...BOARD, is_default: 0 }];
  assert.equal(resolveMachine('cutting', { machine_id: null }, plain), null);
});
test('resolveMachine: non-auto sections never resolve', () => {
  assert.equal(resolveMachine('die_cutting', { machine_id: null }, CUTTING), null);
});
test('resolveMachine: empty or missing machine list is safe', () => {
  assert.equal(resolveMachine('cutting', { machine_id: null }, []), null);
  assert.equal(resolveMachine('cutting', { machine_id: null }, undefined), null);
});

// ── resolveOperator ───────────────────────────────────────────────────
test('resolveOperator: a machine with one crew member needs no choice', () => {
  assert.equal(resolveOperator(PRESS3, { operator: null }), 'Shiv Kumar');
  assert.equal(resolveOperator(BOARD, { operator: null }), 'Ankit');
});
test('resolveOperator: rejects an operator who is not on this machine', () => {
  // A pending CUTTING row reports the press operator via STAGE_VIEW's fallback
  // join. Shiv Kumar must never be filled in as the board cutter.
  const twoCrew = { id: 11, name: 'Board Cutting Machine', operators: [{ id: 1, name: 'Ankit' }, { id: 9, name: 'Vikas' }] };
  assert.equal(resolveOperator(twoCrew, { operator: 'Shiv Kumar' }), '');
});
test('resolveOperator: honours a planned operator who IS on this machine', () => {
  const twoCrew = { id: 11, name: 'Board Cutting Machine', operators: [{ id: 1, name: 'Ankit' }, { id: 9, name: 'Vikas' }] };
  assert.equal(resolveOperator(twoCrew, { operator: 'Vikas' }), 'Vikas');
});
test('resolveOperator: several crew and no plan → blank, the picker decides', () => {
  const twoCrew = { id: 11, name: 'Board Cutting Machine', operators: [{ id: 1, name: 'Ankit' }, { id: 9, name: 'Vikas' }] };
  assert.equal(resolveOperator(twoCrew, { operator: null }), '');
});
test('resolveOperator: an uncrewed machine leaves the operator blank', () => {
  assert.equal(resolveOperator({ id: 38, name: 'Manual Pasting', operators: [] }, { operator: 'Ankit' }), '');
  assert.equal(resolveOperator(null, { operator: 'Ankit' }), '');
});

// ── resolveAssignment ─────────────────────────────────────────────────
test('resolveAssignment: printing resolves press + its operator, flagged auto', () => {
  const a = resolveAssignment('printing', { machine_id: null, press_machine_id: 13, operator: 'Shiv Kumar' }, PRESSES);
  assert.deepEqual(
    { machineId: a.machineId, operator: a.operator, auto: a.auto },
    { machineId: '13', operator: 'Shiv Kumar', auto: true });
});
test('resolveAssignment: cutting resolves the default machine + its operator', () => {
  const a = resolveAssignment('cutting', { machine_id: null, press_machine_id: 13, operator: 'Shiv Kumar' }, CUTTING);
  assert.deepEqual(
    { machineId: a.machineId, operator: a.operator, auto: a.auto },
    { machineId: '11', operator: 'Ankit', auto: true });
});
test('resolveAssignment: machineId is a string — Select values are strings', () => {
  assert.equal(typeof resolveAssignment('printing', { press_machine_id: 13 }, PRESSES).machineId, 'string');
});
test('resolveAssignment: a manual section resolves to nothing at all', () => {
  assert.deepEqual(
    resolveAssignment('coating', { machine_id: null, press_machine_id: 13, operator: 'Shiv Kumar' }, PRESSES),
    { machine: null, machineId: '', operator: '', auto: false });
});
