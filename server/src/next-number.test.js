import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextNumberFrom, nextNumber } from './helpers.js';

// Document numbers (CI-JC-0001, CI-PR-0001 …) are minted by reading what is
// already on the table and adding one. The original implementation read the
// NEWEST ROW ONLY — `ORDER BY id DESC LIMIT 1` — and incremented its trailing
// digits. That is wrong in two independent ways, and both were live:
//
//   • A number with no trailing digits made the regex miss, so the sequence
//     silently restarted at 0001 — which already exists. Every mint after it
//     failed on the unique constraint, permanently. Reproduced on the shared
//     dev DB on 2026-08-05: a job card hand-numbered `UAT-BSV-JC-D` was the
//     newest row, so POST /order-lines/:id/job-card was broken for everyone.
//   • Newest ≠ highest. Any row inserted out of sequence (import, data fix,
//     renumber) hands back a number that is already taken.
//
// The fix derives from the MAXIMUM NUMERIC SUFFIX among rows that match the
// prefix, so a hand-written number is ignored rather than obeyed.

// ── nextNumberFrom — the pure decision ───────────────────────────────────────
// The SQL narrows to prefix + digits and orders numerically, so in production
// this sees one candidate. It takes the max over whatever it is handed anyway:
// the guarantee must not rest on the caller's ORDER BY being right.

// (a) empty table
test('nextNumberFrom: an empty table starts the sequence at 0001', () => {
  assert.equal(nextNumberFrom('CI-JC-', []), 'CI-JC-0001');
});

// (b) normal sequence
test('nextNumberFrom: a normal sequence continues from the highest', () => {
  assert.equal(nextNumberFrom('CI-JC-', ['CI-JC-0001', 'CI-JC-0002', 'CI-JC-0003']), 'CI-JC-0004');
});

// (c) newest row has a non-numeric suffix — the reproduced outage
test('nextNumberFrom: a hand-written number with no trailing digits is ignored, not obeyed', () => {
  // `UAT-BSV-JC-D` was the newest row on the dev DB. The old code restarted at
  // CI-JC-0001 and collided forever; the sequence must simply step past it.
  assert.equal(nextNumberFrom('CI-JC-', ['CI-JC-0001', 'CI-JC-0002', 'UAT-BSV-JC-D']), 'CI-JC-0003');
});

test('nextNumberFrom: a trailing-digit number that is NOT our prefix is still ignored', () => {
  // The old regex matched any trailing digits, so `UAT-BSV-JC-7` would have
  // minted CI-JC-0008 over a live card. Prefix membership is what counts.
  assert.equal(nextNumberFrom('CI-JC-', ['CI-JC-0042', 'UAT-BSV-JC-7']), 'CI-JC-0043');
});

// (d) mixed table — the newest row is numerically LOWER than an older one
test('nextNumberFrom: the highest wins even when it is not the newest row', () => {
  // Insertion order 0009 then 0003 (an import, a renumber, a data fix). The old
  // code read 0003 and handed back 0004, which was already taken.
  assert.equal(nextNumberFrom('CI-JC-', ['CI-JC-0009', 'CI-JC-0003']), 'CI-JC-0010');
});

// ── prefix isolation ─────────────────────────────────────────────────────────
// job_cards.jc_number carries BOTH `CI-JC-` and `CI-GANG-JC-`. Neither prefix
// may consume the other's numbers — the unique constraint is on the whole
// string, so the two sequences are independent and must stay that way.
test('nextNumberFrom: CI-JC- does not inherit CI-GANG-JC- numbers', () => {
  assert.equal(nextNumberFrom('CI-JC-', ['CI-GANG-JC-0500']), 'CI-JC-0001');
});

test('nextNumberFrom: CI-GANG-JC- counts only its own, not the plain cards', () => {
  assert.equal(
    nextNumberFrom('CI-GANG-JC-', ['CI-JC-0900', 'CI-GANG-JC-0004', 'CI-JC-0901']),
    'CI-GANG-JC-0005');
});

// ── shape and robustness ─────────────────────────────────────────────────────
test('nextNumberFrom: padding is a minimum, not a ceiling — 9999 rolls to 10000', () => {
  assert.equal(nextNumberFrom('CI-JC-', ['CI-JC-9999']), 'CI-JC-10000');
  assert.equal(nextNumberFrom('CI-JC-', ['CI-JC-10000']), 'CI-JC-10001');
});

test('nextNumberFrom: leading zeros are read as decimal, not octal', () => {
  assert.equal(nextNumberFrom('CI-JC-', ['CI-JC-0008']), 'CI-JC-0009');
  assert.equal(nextNumberFrom('CI-JC-', ['CI-JC-0070']), 'CI-JC-0071');
});

test('nextNumberFrom: nulls and junk rows do not derail the sequence', () => {
  assert.equal(nextNumberFrom('CI-PR-', [null, undefined, '', 'CI-PR-0002', 'CI-PR-']), 'CI-PR-0003');
});

test('nextNumberFrom: a suffix with interior punctuation is not our sequence', () => {
  // `CI-JC-2026-01` ends in digits but is not `prefix + digits`.
  assert.equal(nextNumberFrom('CI-JC-', ['CI-JC-0005', 'CI-JC-2026-01']), 'CI-JC-0006');
});

// ── nextNumber — the query contract ──────────────────────────────────────────
// The unit suite cannot execute SQL, so these pin the contract the DB is asked
// to honour: scoped to the prefix, ordered by the number, never by insertion
// order. The SQL semantics themselves are proved against a real Postgres.
const spy = (row = null) => {
  const calls = [];
  return { calls, oc: async (sql, params = []) => (calls.push({ sql, params }), row) };
};

test('nextNumber: scopes the SELECT to the prefix and never orders by id', async () => {
  const { calls, oc } = spy({ n: 'CI-JC-0007' });
  const out = await nextNumber('CI-JC-', 'job_cards', 'jc_number', oc);

  assert.equal(out, 'CI-JC-0008');
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0];
  assert.match(sql, /FROM job_cards/);
  assert.doesNotMatch(sql, /ORDER BY\s+id\s+DESC/i,
    'ordering by insertion order is the bug — the newest row is not the highest');
  assert.ok(params.includes('CI-JC-'), 'the prefix must be bound as a parameter, not interpolated');
});

test('nextNumber: an empty table yields the first number', async () => {
  const { oc } = spy(null);
  assert.equal(await nextNumber('CI-GRN-', 'grns', 'grn_number', oc), 'CI-GRN-0001');
});

test('nextNumber: a row the DB should have filtered out is still refused', async () => {
  // Belt and braces: if the WHERE clause is ever loosened, the JS must not
  // restart the sequence at 0001 on top of live numbers.
  const { oc } = spy({ n: 'UAT-BSV-JC-D' });
  assert.equal(await nextNumber('CI-JC-', 'job_cards', 'jc_number', oc), 'CI-JC-0001');
});
