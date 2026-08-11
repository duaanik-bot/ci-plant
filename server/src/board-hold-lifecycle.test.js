import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOARD_DRAWN_EXISTS } from './helpers.js';

const src = readFileSync(new URL('./helpers.js', import.meta.url), 'utf8');

// "DRAWN" IS A NET QUESTION. It asks whether the sheets are off the shelf right
// now — and a reversal puts them back. sendStageBack returns the board to its
// own batches and books the return as an 'adjustment' against the SAME
// ref_type='job_card' the draw used ("the original consumption rows always STAY
// and a return is a new 'adjustment' row"). An EXISTS on the consumption row
// therefore stayed true forever: a reversed job kept reading DRAWN while its
// board sat back in the racks, claimsByBoard netted its claim off as a closed
// board question, and the returned sheets read 100% free to everyone — the same
// board promised twice.
test('drawn is a NET test over the card, not an EXISTS on a consumption row', () => {
  assert.match(BOARD_DRAWN_EXISTS, /sm\.type IN \('consumption','adjustment'\)/,
    'the return is an adjustment — a consumption-only test can never see it');
  assert.match(BOARD_DRAWN_EXISTS, /HAVING SUM\(sm\.qty\) < 0/,
    'net negative = still off the shelf');
  assert.doesNotMatch(BOARD_DRAWN_EXISTS, /WHERE sm\.type='consumption'\s*\n?\s*AND \(jc\.order_line_id/,
    'the old existence-only spelling is gone');
});

test('the drawn test keeps its gang branch and stays ONE string', () => {
  assert.match(BOARD_DRAWN_EXISTS, /ol\.gang_run_id IS NOT NULL AND jc\.order_line_id IS NULL/,
    "a run's board is drawn against the RUN card, which carries no order line");
  // boardDrawnLineIds must interpolate the shared constant, never hand-roll a
  // second copy — "a second hand-written copy of this predicate is how 'drawn'
  // starts meaning two different things".
  const fn = src.slice(src.indexOf('export async function boardDrawnLineIds'), src.indexOf('export async function boardDrawnLineIds') + 400);
  assert.match(fn, /\$\{BOARD_DRAWN_EXISTS\}/, 'the twin interpolates the one string');
});

// A CANCELLED LINE STOPS BEING DEMAND BUT DOES NOT STOP BEING A HOLDER. It falls
// out of BOARD_DEMAND_STATUSES, so its hold is counted at face value forever and
// no un-plan route will ever run for it again. releasePlanLockHolds is scoped
// origin='plan_lock', so mix mirrors, GRN cover holds and hand-placed Commits
// survived a cancellation — frozen board on a line nobody will ever look at.
test('cancelling a line releases EVERY stock hold on it, whatever wrote it', () => {
  const fn = src.slice(src.indexOf('export async function setLineStatus'),
                       src.indexOf('export async function forceLineStatus'));
  assert.match(fn, /releasePlanLockHolds\(lineId, qc, user, 'order line cancelled'\)/,
    'the plan_lock release stays — board-hold-origin.test.js pins it');
  assert.match(fn, /WHERE order_line_id=\$1 AND status='active' AND source='stock'/,
    'and an origin-AGNOSTIC sweep runs beside it');
  // The STATEMENT, not the prose: the comment above it names plan_lock on
  // purpose, and a blunt grep would forbid explaining the bug.
  const stmt = fn.slice(fn.indexOf('UPDATE board_allocations'), fn.indexOf('RETURNING material_id, qty'));
  assert.doesNotMatch(stmt, /origin/,
    'the sweep must not re-scope itself to any origin — that is the bug it fixes');
  assert.match(fn, /board_hold_released/, 'every released hold is audited against its material');
  // source='stock' only: a requisition mirror reserves no shelf and dies with
  // its PR, not with the line.
  assert.doesNotMatch(fn, /source='requisition'/);
});
