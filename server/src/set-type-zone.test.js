import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowSetType, holdReasonOf, cardSetType } from '../../client/src/lib/setType.js';

// The zone a job wears, on the two screens that triage by it.
//
// Planning triages ORDER LINES: the stored tag is the planner's intent, and
// facts outrank it. Print Planning triages JOB CARDS, which carry no tag at
// all and are classified purely by fact. Both must agree about what a RUN is,
// or one screen calls a job Single while the other calls it Gang — which is
// exactly what shipped, because both tested `gang_run_id`, a column a
// combined run shares with a gang by design.

const line = (over = {}) => ({ status: 'pending', set_type: 'single', ...over });

// ── a lone line: the tag is the whole answer ──────────────────────────
test('zone: an uncombined line wears its own tag', () => {
  for (const t of ['single', 'gang', 'new_output'])
    assert.equal(rowSetType(line({ set_type: t })), t);
});

test('zone: a line with no tag at all reads Single', () => {
  assert.equal(rowSetType({ status: 'pending' }), 'single');
});

// ── hold outranks everything, always ──────────────────────────────────
test('zone: one held member parks the whole row', () => {
  const r = { ...line(), _gang: [line({ set_type: 'single' }), line({ set_type: 'hold' })] };
  assert.equal(rowSetType(r), 'hold');
});

test('zone: the hold reason is whichever member carries one', () => {
  const r = { _gang: [line({ hold_reason: null }), line({ hold_reason: 'shade card pending' })] };
  assert.equal(holdReasonOf(r), 'shade card pending');
  assert.equal(holdReasonOf(line()), '');
});

// ── a real gang: the shared sheet outranks the tag ────────────────────
test('zone: a gang run is Gang whatever the tag says', () => {
  const r = { ...line({ set_type: 'single' }), gang_run_id: 7, run_kind: 'gang', _gang: [line(), line()] };
  assert.equal(rowSetType(r), 'gang');
});

// ── the press board: facts only, no stored tag ────────────────────────
test('zone: a card on a gang run is Gang; a plain card is Single', () => {
  assert.equal(cardSetType({ gang_run_id: 7, run_kind: 'gang' }), 'gang');
  assert.equal(cardSetType({ gang_run_id: null, run_kind: null }), 'single');
});

test('zone: a press hold IS the hold — never a second flag', () => {
  assert.equal(cardSetType({ printing_status: 'hold' }), 'hold');
  assert.equal(cardSetType({ printing_status: 'hold', gang_run_id: 7, run_kind: 'gang' }), 'hold');
});

// ── a COMBINED RUN is a Single ────────────────────────────────────────
// The whole point: a merge reuses `gang_run_id` so every "which card is this
// line riding?" lateral keeps working, which left the zone classifier unable
// to tell the two apart. It filed a run that never splits under a chip whose
// entire meaning is "this splits after die cutting".
const mergeRow = (over = {}) => ({
  ...line(), gang_run_id: 7, run_kind: 'merge',
  _gang: [line(), line()], ...over,
});

test('zone: a combined run is Single, not Gang', () => {
  assert.equal(rowSetType(mergeRow()), 'single');
});

test('zone: a combined run needing plates is New Output — the tag is not overridden', () => {
  assert.equal(rowSetType(mergeRow({
    set_type: 'new_output', _gang: [line({ set_type: 'new_output' }), line({ set_type: 'new_output' })],
  })), 'new_output',
  'pinning a merge to "single" would make New Output unreachable on a combined run');
});

test('zone: hold still outranks the merge fact', () => {
  assert.equal(rowSetType(mergeRow({ _gang: [line(), line({ set_type: 'hold' })] })), 'hold',
    'this is what keeps the live Hold count at 10 rather than moving a held run to Single');
});

test('zone: a combined-run CARD is Single on the press board too', () => {
  assert.equal(cardSetType({ gang_run_id: 7, run_kind: 'merge' }), 'single',
    'Planning and the press board disagreeing about one run is the drift the shared lib prevents');
});

test('zone: the two run kinds are told apart by kind, never by gang_run_id', () => {
  assert.equal(rowSetType({ ...line(), gang_run_id: 7, run_kind: 'gang' }), 'gang');
  assert.equal(rowSetType({ ...line(), gang_run_id: 7, run_kind: 'merge' }), 'single');
});
