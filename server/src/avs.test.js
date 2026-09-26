import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canDecideAvs, caseState, decisionProblem, reportLabel, AVS_DECISION_KEYS,
} from '../../client/src/lib/avs.js';

// The page greys out exactly what the server refuses: both call decisionProblem.

test('a REJECT report is never released from the ERP', () => {
  assert.match(decisionProblem({ decision: 'RELEASE', remark: 'looks fine', status: 'REJECT' }), /cannot be released/);
});

test('releasing a PASS report needs no remark; releasing a HOLD report does', () => {
  assert.equal(decisionProblem({ decision: 'RELEASE', remark: '', status: 'PASS' }), null);
  assert.match(decisionProblem({ decision: 'RELEASE', remark: '  ', status: 'HOLD' }), /HOLD points/);
  assert.equal(decisionProblem({ decision: 'RELEASE', remark: 'R-3 board OK by customer mail 27 Sep', status: 'HOLD' }), null);
});

test('keep on hold and reject always carry a remark', () => {
  for (const decision of ['KEEP ON HOLD', 'REJECT']) {
    for (const status of ['PASS', 'HOLD', 'REJECT']) {
      assert.ok(decisionProblem({ decision, remark: '', status }), `${decision} on ${status} without a remark`);
      assert.equal(decisionProblem({ decision, remark: 'counted 1,200 cartons to rejection area', status }), null);
    }
  }
});

test('the artwork-alert sign-off exists only when the report has an A- alert', () => {
  assert.ok(decisionProblem({ decision: 'ARTWORK ALERT OK', remark: 'customer confirmed', status: 'HOLD', hasAlert: false }));
  assert.equal(decisionProblem({ decision: 'ARTWORK ALERT OK', remark: 'customer confirmed', status: 'HOLD', hasAlert: true }), null);
});

test('unknown decisions and statuses are refused', () => {
  assert.ok(decisionProblem({ decision: 'APPROVE', remark: 'x', status: 'PASS' }));
  assert.ok(decisionProblem({ decision: 'RELEASE', remark: 'x', status: 'GREEN' }));
  assert.deepEqual(AVS_DECISION_KEYS, ['RELEASE', 'KEEP ON HOLD', 'REJECT', 'ARTWORK ALERT OK']);
});

test('case state follows the decision on the SAME issue only', () => {
  const r = { status: 'HOLD', report_rev: 1, check_no: 1 };
  assert.equal(caseState(r, null), 'open');
  assert.equal(caseState(r, { decision: 'RELEASE', report_rev: 1, check_no: 1 }), 'released');
  assert.equal(caseState(r, { decision: 'REJECT', report_rev: 1, check_no: 1 }), 'rejected');
  // A decision on Rev 0 does not decide Rev 1.
  assert.equal(caseState(r, { decision: 'RELEASE', report_rev: 0, check_no: 1 }), 'open');
  // Keep on hold and the artwork sign-off leave the case where it was.
  assert.equal(caseState(r, { decision: 'KEEP ON HOLD', report_rev: 1, check_no: 1 }), 'open');
  assert.equal(caseState({ ...r, status: 'PASS' }, { decision: 'ARTWORK ALERT OK', report_rev: 1, check_no: 1 }), 'waiting');
  assert.equal(caseState({ ...r, closed: true }, null), 'closed');
});

test('who decides: QA and admin by role, management by flag', () => {
  assert.equal(canDecideAvs({ role: 'qc' }), true);
  assert.equal(canDecideAvs({ role: 'admin' }), true);
  assert.equal(canDecideAvs({ role: 'viewer', is_management: 1 }), true);
  assert.equal(canDecideAvs({ role: 'production' }), false);
  assert.equal(canDecideAvs(null), false);
});

test('report labels read the way the plant says them', () => {
  assert.equal(reportLabel({ report_no: 'AVS-2026-0005', report_rev: 1, check_no: 1 }), 'AVS-2026-0005 Rev 1');
  assert.equal(reportLabel({ report_no: 'AVS-2026-0003', report_rev: 0, check_no: 2 }), 'AVS-2026-0003 Check 2');
});

test('the AVS router writes only avs.decisions, never a plant table', () => {
  const src = readFileSync(new URL('./routes/avs.js', import.meta.url), 'utf8');
  const writes = [...src.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_.]+)/gi)].map(m => m[2].toLowerCase());
  assert.deepEqual([...new Set(writes)], ['avs.decisions']);
});
