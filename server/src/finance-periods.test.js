import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIN_PERIOD_TRANSITIONS, finPeriodMove } from '../../client/src/lib/finance/periods.js';
import * as P from '../../client/src/lib/finance/periods.js';
import { finSetPeriodStatus } from './finance-masters.js';

test('month moves are spec §6.2 exactly', () => {
  assert.deepEqual(finPeriodMove('open', 'closing'), { ok: true, needsReason: false });
  assert.deepEqual(finPeriodMove('closing', 'locked'), { ok: true, needsReason: false });
  assert.deepEqual(finPeriodMove('closing', 'open'), { ok: true, needsReason: true });
  assert.deepEqual(finPeriodMove('locked', 'closing'), { ok: true, needsReason: true });
  for (const [a, b] of [['locked', 'open'], ['open', 'locked'], ['before_books', 'open'], ['open', 'before_books']])
    assert.equal(finPeriodMove(a, b).ok, false, `${a}→${b}`);
  assert.deepEqual(FIN_PERIOD_TRANSITIONS.before_books, []);
});

// ── Beyond the brief ──────────────────────────────────────────────────────────────────────────────────────────────
// Read off the namespace (P.) so a helper that is missing fails its own test, by name, while red.

const STATUSES = ['before_books', 'open', 'closing', 'locked'];

test('of the sixteen pairs of statuses exactly four are moves, and a move that is never allowed does not ask for a reason', () => {
  const allowed = [];
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const move = finPeriodMove(from, to);
      assert.deepEqual(Object.keys(move).sort(), ['needsReason', 'ok'], `${from}→${to} answers exactly ok and needsReason`);
      if (move.ok) allowed.push(`${from}→${to}${move.needsReason ? ' (reason)' : ''}`);
      else assert.equal(move.needsReason, false, `${from}→${to}: a refused move is not refused for want of a reason`);
    }
  }
  assert.deepEqual(allowed, ['open→closing', 'closing→open (reason)', 'closing→locked', 'locked→closing (reason)']);
});

test('a name that is not a status moves nowhere, whether or not Object.prototype has a property of that name', () => {
  const odd = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', ' open', 'OPEN', 'opened', undefined, null, 7, true, {}, ['open']];
  for (const bad of odd) {
    assert.deepEqual(finPeriodMove(bad, 'closing'), { ok: false, needsReason: false }, `from ${String(bad)}`);
    assert.deepEqual(finPeriodMove('open', bad), { ok: false, needsReason: false }, `to ${String(bad)}`);
    assert.deepEqual(P.finPeriodMoves(bad), [], `moves of ${String(bad)}`);
  }
});

test('the table is frozen all the way down, so no screen can change what a month may do', () => {
  assert.ok(Object.isFrozen(FIN_PERIOD_TRANSITIONS));
  for (const [status, moves] of Object.entries(FIN_PERIOD_TRANSITIONS)) {
    assert.ok(Object.isFrozen(moves), `${status}'s list`);
    for (const move of moves) assert.ok(Object.isFrozen(move), `${status} to ${move.to}`);
  }
  assert.deepEqual(Object.keys(FIN_PERIOD_TRANSITIONS), ['open', 'closing', 'locked', 'before_books']);
});

test('finPeriodMoves: the buttons a month offers, in the table\'s order; a month before the books begin offers none', () => {
  assert.deepEqual(P.finPeriodMoves('open'), [{ to: 'closing', reason: false }]);
  assert.deepEqual(P.finPeriodMoves('closing'), [{ to: 'locked', reason: false }, { to: 'open', reason: true }]);
  assert.deepEqual(P.finPeriodMoves('locked'), [{ to: 'closing', reason: true }]);
  assert.deepEqual(P.finPeriodMoves('before_books'), []);
  // every move it lists is a move finPeriodMove allows, with the same reason rule: one table, two readers
  for (const from of STATUSES) {
    for (const { to, reason } of P.finPeriodMoves(from)) assert.deepEqual(finPeriodMove(from, to), { ok: true, needsReason: reason });
  }
});

test('every status has a name and every move a button label, and nothing else does', () => {
  assert.deepEqual(Object.keys(P.FIN_PERIOD_STATUS_LABELS).sort(), [...STATUSES].sort());
  for (const label of Object.values(P.FIN_PERIOD_STATUS_LABELS)) assert.match(label, /\S/);
  assert.equal(P.finPeriodLabel('open'), 'Open');
  assert.equal(P.finPeriodLabel('before_books'), 'Before books');
  assert.equal(P.finPeriodLabel('constructor'), 'constructor', 'an unknown status is shown as it came, never as a function');
  assert.equal(P.finPeriodLabel(null), '—');
  const labels = [];
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const label = P.finPeriodMoveLabel(from, to);
      if (finPeriodMove(from, to).ok) { assert.match(label, /\S/, `${from}→${to} needs a label`); labels.push(label); }
      else assert.equal(label, '', `${from}→${to} is not a move, so it has no button`);
    }
  }
  assert.deepEqual(labels.sort(), ['Lock', 'Reopen', 'Start closing', 'Unlock']);
  assert.equal(P.finPeriodMoveLabel('constructor', 'x'), '');
});

test('what each move does, in a sentence the confirmation can use', () => {
  const sentence = P.finPeriodMoveEffect;
  assert.match(sentence('open', 'closing'), /only .*Approver/i, 'a closing month takes only entries an Approver approves');
  assert.match(sentence('closing', 'locked'), /nothing .*post/i, 'a locked month takes nothing');
  assert.match(sentence('closing', 'open'), /normal posting|posting .*again|open again/i);
  assert.match(sentence('locked', 'closing'), /Approver/);
  assert.equal(sentence('open', 'locked'), '');
  // Ruling R73: a month carries into every month after it, so closing or locking one holds back the months before it too
  assert.match(sentence('open', 'closing'), /this month, or any month before it,/);
  assert.match(sentence('closing', 'locked'), /this month, or any month before it,/);
  assert.match(sentence('locked', 'closing'), /or into any month before it/);
  assert.match(sentence('closing', 'open'), /unless a month after it is still closing or locked/);
});

// ── The server follows the table ────────────────────────────────────────────────────────────────────────────────
// finSetPeriodStatus is driven against a fake transaction for every pair of statuses. What it does with each is what the table
// says: a move that is not in it is a 409, one that needs a reason and has none is a 400, and the rest write the month and ONE audit
// row. A private copy of the moves in finance-masters.js would fail here the day the table and the copy differ.

function fakeMonth(status) {
  const calls = { updates: [], audits: [] };
  const month = { id: 5, book_id: 1, year_id: 1, month_no: 10, label: 'Jan 2027', start_date: '2027-01-01', end_date: '2027-01-31', status, status_changed_by: null, status_changed_at: null };
  const oc = async (text, params = []) => {
    if (/FROM fin_periods WHERE id = \$1 FOR UPDATE/.test(text)) return month;
    if (/^\s*UPDATE fin_periods/.test(text)) { calls.updates.push(params); return { ...month, status: params[1], status_changed_by: params[2] }; }
    throw new Error(`unexpected statement: ${text}`);
  };
  const qc = async (text, params = []) => {
    if (/INSERT INTO fin_audit_log/.test(text)) { calls.audits.push(params); return []; }
    throw new Error(`unexpected statement: ${text}`);
  };
  return { qc, oc, calls };
}
const MD = { id: 3, name: 'Test MD' };

test('finSetPeriodStatus: every pair of statuses goes where finPeriodMove says, with the reason it says', async () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const move = finPeriodMove(from, to);
      const where = `${from}→${to}`;
      const refused = async (reason, status, code) => {
        const { qc, oc, calls } = fakeMonth(from);
        await assert.rejects(finSetPeriodStatus(qc, oc, 5, { status: to, reason }, MD), e => e.status === status && e.body.code === code, `${where} (${JSON.stringify(reason)})`);
        assert.deepEqual([calls.updates.length, calls.audits.length], [0, 0], `${where}: a refused move leaves no trace`);
      };
      if (!move.ok) {
        await refused('a reason does not help', 409, 'FIN_BAD_TRANSITION');
        await refused(undefined, 409, 'FIN_BAD_TRANSITION');
        continue;
      }
      if (move.needsReason) { await refused(undefined, 400, 'FIN_REASON_REQUIRED'); await refused('   ', 400, 'FIN_REASON_REQUIRED'); }
      const { qc, oc, calls } = fakeMonth(from);
      const after = await finSetPeriodStatus(qc, oc, 5, { status: to, reason: move.needsReason ? '  CA wants one more entry ' : undefined }, MD);
      assert.equal(after.status, to, where);
      assert.deepEqual(calls.updates, [[5, to, 'Test MD']], `${where}: the month is written once`);
      assert.equal(calls.audits.length, 1, `${where}: and audited once`);
      assert.equal(calls.audits[0][6], move.needsReason ? 'CA wants one more entry' : null, `${where}: the reason is kept trimmed, or nothing`);
    }
  }
});

test('finSetPeriodStatus: the refusal says why, in the month\'s own words, and a status that is no status is a 400 before the month is read', async () => {
  const sentence = async (from, to) => {
    const { qc, oc } = fakeMonth(from);
    return finSetPeriodStatus(qc, oc, 5, { status: to, reason: 'x' }, MD).then(() => null, e => e.message);
  };
  assert.equal(await sentence('before_books', 'open'), 'Jan 2027 comes before the books begin, so its status never changes.');
  assert.equal(await sentence('closing', 'closing'), 'Jan 2027 is already closing.');
  assert.equal(await sentence('open', 'locked'), 'Jan 2027 is open, so it can only move to closing.');
  assert.equal(await sentence('closing', 'before_books'), 'Jan 2027 is closing, so it can only move to locked or open.');
  assert.equal(await sentence('locked', 'open'), 'Jan 2027 is locked, so it can only move to closing.');
  for (const bad of ['bogus', undefined, 7, null, 'constructor']) {
    const { qc, oc, calls } = fakeMonth('open');
    await assert.rejects(finSetPeriodStatus(qc, oc, 5, { status: bad }, MD), e => e.status === 400 && e.body.code === 'FIN_BAD_INPUT' && e.body.field === 'status', String(bad));
    assert.equal(calls.updates.length, 0);
  }
});

// ── Source pins ─────────────────────────────────────────────────────────────────────────────────────────────────
const code = f => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

test('the server judges a move with finPeriodMove from periods.js and keeps no table of moves of its own', () => {
  const masters = code('./finance-masters.js');
  assert.match(masters, /import \{[^}]*\bfinPeriodMove\b[^}]*\} from '\.\.\/\.\.\/client\/src\/lib\/finance\/periods\.js';/);
  assert.match(masters, /finPeriodMove\(month\.status, status\)/);
  assert.doesNotMatch(masters, /FIN_PERIOD_MOVES/, 'the private copy of the moves is gone');
  assert.doesNotMatch(masters, /closing:\s*\{\s*locked/, 'and so is anything shaped like it');
});

test('periods.js is pure: no imports, no Object.hasOwn, and the screens read the same table', () => {
  const periods = code('../../client/src/lib/finance/periods.js');
  assert.doesNotMatch(periods, /^\s*import\b/m);
  assert.doesNotMatch(periods, /Object\.hasOwn\s*\(/);
  assert.match(periods, /Object\.prototype\.hasOwnProperty\.call/);
});
