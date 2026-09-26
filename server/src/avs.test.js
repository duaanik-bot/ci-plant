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

// ── The printing lock ────────────────────────────────────────────────────────
import { avsGate, avsSwitchProblem, photoProblem, avsSetFolder, setupProblem, AVS_NO_REPORT } from '../../client/src/lib/avs.js';

const rep = (over = {}) => ({ report_no: 'AVS-2026-0005', report_rev: 1, check_no: 1, status: 'HOLD', closed: false,
  decision: null, decided_by: null, remark: null, decision_rev: null, decision_check: null, ...over });

test('the lock opens only when every report on the job card is released on its latest issue', () => {
  assert.deepEqual(avsGate([]), { released: false, reports: [], reason: AVS_NO_REPORT });
  const released = rep({ decision: 'RELEASE', decided_by: 'QA', decision_rev: 1, decision_check: 1 });
  assert.equal(avsGate([released]).released, true);
  assert.equal(avsGate([released]).reason, null);
  // A release on Rev 0 does not release Rev 1.
  const old = rep({ decision: 'RELEASE', decision_rev: 0, decision_check: 1 });
  assert.equal(avsGate([old]).released, false);
  // A gang card with two cartons: both must be released.
  const other = rep({ report_no: 'AVS-2026-0006', status: 'PASS' });
  const g = avsGate([released, other]);
  assert.equal(g.released, false);
  assert.match(g.reason, /AVS-2026-0006 Rev 1 is PASS and waiting for QA/);
  assert.doesNotMatch(g.reason, /AVS-2026-0005/, 'the released one is not named as a blocker');
});

test('each blocked report says what is needed, in the plant\'s words', () => {
  const line = r => avsGate([r]).reports[0].text;
  assert.match(line(rep()), /HOLD\. QA must clear its points and release it/);
  assert.match(line(rep({ status: 'REJECT' })), /REJECT\. Correct the print and send new photos/);
  assert.match(line(rep({ decision: 'KEEP ON HOLD', remark: 'board awaited', decision_rev: 1, decision_check: 1 })), /QA kept AVS-2026-0005 Rev 1 on hold: board awaited/);
  assert.match(line(rep({ decision: 'REJECT', decision_rev: 1, decision_check: 1 })), /QA rejected AVS-2026-0005 Rev 1/);
  assert.match(line(rep({ closed: true })), /closed without a re-check/);
  assert.match(line(rep({ status: 'PASS', check_no: 2, report_rev: 0 })), /AVS-2026-0005 Check 2 is PASS/);
});

test('Planning switches AVS off after printing started only with a reason; never after printing is done', () => {
  assert.equal(avsSwitchProblem({ on: true }), null);
  assert.equal(avsSwitchProblem({ on: false, printing: 'pending' }), null);
  assert.equal(avsSwitchProblem({ on: false, printing: null }), null);
  for (const printing of ['in_progress', 'partially_completed', 'hold']) {
    const p = avsSwitchProblem({ on: false, printing, reason: 'ok' });
    assert.equal(p.code, 'AVS_REASON_REQUIRED');
    assert.equal(p.status, 409);
    assert.equal(avsSwitchProblem({ on: false, printing, reason: 'customer approved on phone, AVS down' }), null);
  }
  assert.equal(avsSwitchProblem({ on: true, printing: 'completed' }).status, 409);
  // A job already on the press is not disturbed: AVS cannot be switched on for it.
  for (const printing of ['in_progress', 'partially_completed', 'hold']) {
    assert.match(avsSwitchProblem({ on: true, printing }).message, /already started/);
  }
  assert.equal(avsSwitchProblem({ on: true, printing: 'pending' }), null);
  assert.equal(avsSwitchProblem({ on: 'yes' }).status, 400);
});

test('photos: type and size are checked before anything goes to Drive; sets file by date and job card', () => {
  assert.equal(photoProblem({ size: 1000, type: 'image/jpeg' }), null);
  assert.equal(photoProblem({ size: 1000, type: 'image/heic' }), null);
  assert.ok(photoProblem({ size: 1000, type: 'application/pdf' }));
  assert.ok(photoProblem({ size: 5 * 1024 * 1024, type: 'image/jpeg' }));
  assert.ok(photoProblem({ size: 0, type: 'image/jpeg' }));
  assert.equal(avsSetFolder({ id: 12, day: '26-09-2026', jc_number: 'CI-JC-0399' }), 'AVS CHECK/26-09-2026/Set 0012 CI-JC-0399');
  assert.equal(avsSetFolder({ id: 7, day: '26-09-2026', jc_number: null }), 'AVS CHECK/26-09-2026/Set 0007');
  assert.equal(avsSetFolder({ id: 7, day: '26-09-2026', jc_number: 'A/B' }), 'AVS CHECK/26-09-2026/Set 0007 A-B');
});

test('setup accepts only the real link shapes', () => {
  assert.equal(setupProblem({ drive_bridge_url: 'https://script.google.com/macros/s/AKfycbzAbCdEfGhIjKlMnOpQrStUv/exec' }), null);
  assert.ok(setupProblem({ drive_bridge_url: 'https://evil.example.com/exec' }));
  assert.equal(setupProblem({ routine_fire_url: 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGH/fire' }), null);
  assert.ok(setupProblem({ routine_fire_url: 'http://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGH/fire' }));
  assert.ok(setupProblem({ routine_token: 'not-a-token' }));
  assert.equal(setupProblem({ drive_bridge_url: '', routine_fire_url: '', routine_token: '' }), null);
});

const writesIn = file => {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');
  // "ON CONFLICT … DO UPDATE SET" updates the row just inserted, not another table.
  return [...new Set([...src.matchAll(/\b(INSERT\s+INTO|(?<!DO\s)UPDATE|DELETE\s+FROM)\s+([a-z_.]+)/gi)].map(m => m[2].toLowerCase()))].sort();
};

test('the AVS switch writes only the job\'s switch; the photo sets only their own avs tables', () => {
  assert.deepEqual(writesIn('./routes/avs-switch.js'), ['gang_runs', 'order_lines']);
  assert.deepEqual(writesIn('./routes/avs-intake.js'), ['avs.check_photos', 'avs.check_requests', 'avs.settings']);
  assert.doesNotMatch(readFileSync(new URL('./routes/avs-intake.js', import.meta.url), 'utf8'), /DELETE\s/i,
    'nothing uploaded is ever deleted');
});

test('printing is locked before anything is recorded, and the press never switches its own lock', () => {
  const prod = readFileSync(new URL('./routes/production.js', import.meta.url), 'utf8');
  const route = prod.slice(prod.indexOf("r.post('/job-stages/:id/complete'"));
  const gate = route.indexOf('avsGateForCard(');
  assert.ok(gate > 0, 'printing completion asks the AVS lock');
  assert.ok(gate < route.indexOf('applyPlateDispositions('), 'before the plates are recorded');
  const sw = readFileSync(new URL('./routes/avs-switch.js', import.meta.url), 'utf8');
  assert.match(sw, /const canSwitch = requireRole\('planner'\);/);
  assert.doesNotMatch(sw, /PLANNING_ROLES/, 'production logins share planning work but never this switch');
});
