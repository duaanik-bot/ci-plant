import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canDecideAvs, caseState, decisionProblem, reportLabel, AVS_DECISION_KEYS,
} from '../../client/src/lib/avs.js';

// The page greys out exactly what the server refuses: both call decisionProblem.

test('a REJECT report may be released, with a remark saying why (no hard block)', () => {
  assert.match(decisionProblem({ decision: 'RELEASE', remark: '', status: 'REJECT' }), /REJECT report is released/);
  assert.equal(decisionProblem({ decision: 'RELEASE', remark: 'Customer approved the deviation', status: 'REJECT' }), null);
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
  // By the AVS decision right, never by role=admin or the management tick.
  assert.equal(canDecideAvs({ role: 'admin' }), false, 'CTP is an admin login too');
  assert.equal(canDecideAvs({ role: 'admin', avs_approver: 1 }), true);
  assert.equal(canDecideAvs({ role: 'planner', avs_approver: 1 }), true);
  assert.equal(canDecideAvs({ role: 'viewer', is_management: 1 }), false);
  assert.equal(canDecideAvs({ role: 'production' }), false);
  assert.equal(canDecideAvs(null), false);
  const route = readFileSync(new URL('./routes/avs.js', import.meta.url), 'utf8');
  assert.match(route, /SELECT avs_approver FROM users WHERE id = \$1 AND active = 1/, 'read fresh, not from the token');
});

test('report labels read the way the plant says them', () => {
  assert.equal(reportLabel({ report_no: 'AVS-2026-0005', report_rev: 1, check_no: 1 }), 'AVS-2026-0005 Rev 1');
  assert.equal(reportLabel({ report_no: 'AVS-2026-0003', report_rev: 0, check_no: 2 }), 'AVS-2026-0003 Check 2');
});

test('the AVS router writes only QA decisions and report deletions, never a plant table', () => {
  const src = readFileSync(new URL('./routes/avs.js', import.meta.url), 'utf8');
  const writes = [...src.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_.]+)/gi)].map(m => m[2].toLowerCase());
  assert.deepEqual([...new Set(writes)].sort(), ['avs.check_requests', 'avs.decisions', 'avs.deleted_reports']);
  assert.doesNotMatch(src, /\bDELETE\s+FROM\b/i, 'a deleted report is marked, never erased');
  assert.deepEqual(writesIn('./avs-audit.js'), ['avs.audit_log']);
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
  assert.deepEqual(writesIn('./routes/avs-intake.js'),
    ['avs.check_photo_bytes', 'avs.check_photos', 'avs.check_requests', 'avs.settings']);
  assert.doesNotMatch(readFileSync(new URL('./routes/avs-intake.js', import.meta.url), 'utf8'), /\bDELETE\s+FROM\b/i,
    'nothing uploaded is ever deleted');
});

// ── Photos kept in CI Plant while the Drive link is not set up ──────────────
test('an upload never needs the Drive link: without it the photo is kept in CI Plant', () => {
  const src = readFileSync(new URL('./routes/avs-intake.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf('async function addPhoto('), src.indexOf("r.post('/avs/uploads/:id/verify'"));
  assert.match(route, /if \(linked\(cfg\)\.drive && !keepOnly\) \{\s*try \{\s*put = await callDrive\(/, 'Drive is tried only when linked, and its refusal is caught');
  assert.match(route, /INSERT INTO avs\.check_photo_bytes/, 'otherwise the photo itself is kept');
  assert.match(route, /await tx\(/, 'the photo row and its bytes are saved together or not at all');
  assert.match(route, /keptMaxBytes\(\)/, 'with a ceiling, so a check that never runs cannot fill the database');
});

test('the check fetches a kept photo with its key; it writes only the runner heartbeat and its own report', () => {
  const src = readFileSync(new URL('./routes/avs-robot.js', import.meta.url), 'utf8');
  // The office runner's heartbeat (GET /avs/robot/queue) and, since 5 Oct 2026,
  // the check's report in one post (POST /avs/robot/file-report, avs-file-report.js).
  assert.deepEqual(writesIn('./routes/avs-robot.js'), ['avs.settings']);
  assert.deepEqual(writesIn('./avs-file-report.js'), ['avs.check_docs', 'avs.check_photos', 'avs.check_requests', 'avs.problems', 'avs.reports']);
  assert.doesNotMatch(src + readFileSync(new URL('./avs-file-report.js', import.meta.url), 'utf8'), /\bDELETE\s+FROM\b/i,
    'the check never deletes a row');
  assert.doesNotMatch(readFileSync(new URL('./avs-file-report.js', import.meta.url), 'utf8'), /avs\.decisions/,
    'QA decides in CI Plant: the check never writes a decision');
  assert.match(src, /VALUES \('local_runner_seen_at'/);
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /'Cache-Control', 'no-store'/);
  // Outside the ERP login (the check has none), but inside the statement ledger.
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const robot = app.indexOf("app.use('/api', avsRobot)");
  assert.ok(robot > app.indexOf("app.use('/api', dataTablesMiddleware)"));
  assert.ok(robot < app.indexOf("app.use('/api', requireAuth)"));
  // The key never goes to a browser.
  assert.doesNotMatch(readFileSync(new URL('./routes/avs-intake.js', import.meta.url), 'utf8'), /robot_key:/);
});

test('filing a kept photo in Drive drops the copy kept in CI Plant', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20260926170000_avs_photos_kept_in_ci_plant.sql', import.meta.url), 'utf8');
  assert.match(sql, /CHECK \(stored IN \('drive', 'ci_plant'\)\)/);
  assert.match(sql, /AFTER UPDATE OF stored ON avs\.check_photos\s+FOR EACH ROW WHEN \(NEW\.stored = 'drive'\)/);
  assert.match(sql, /REFERENCES avs\.check_photos\(id\) ON DELETE CASCADE/);
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

// ── The photo-set list: status chips and the progress bar ───────────────────
import { AVS_CHECK_STEPS, AVS_SET_GROUPS, AVS_SET_STATUS_LABEL, setGroupOf, setProgress } from '../../client/src/lib/avs.js';

test('every set status belongs to exactly one chip, and a finished set leaves In progress', () => {
  for (const status of Object.keys(AVS_SET_STATUS_LABEL)) {
    assert.equal(AVS_SET_GROUPS.filter(g => g.statuses.includes(status)).length, 1, status);
  }
  assert.deepEqual(['uploading', 'queued', 'checking'].map(setGroupOf), ['active', 'active', 'active']);
  assert.equal(setGroupOf('done'), 'done');
  assert.equal(setGroupOf('failed'), 'failed');
  assert.equal(setGroupOf('cancelled'), 'cancelled');
});

test('the bar follows the set: photos, the queue, each step Claude writes, the report', () => {
  assert.equal(setProgress({ status: 'uploading' }).pct, 5);
  assert.equal(setProgress({ status: 'queued' }).pct, 10);
  const pcts = AVS_CHECK_STEPS.map(s => s.pct);
  assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b), 'the steps only go forward');
  assert.ok(pcts[0] > 10 && pcts.at(-1) < 100);
  const po = setProgress({ status: 'checking', progress: 'Reading the PO' });
  assert.equal(po.pct, 50);
  assert.equal(po.label, 'Reading the PO');
  assert.equal(po.live, true);
  assert.equal(po.step, AVS_CHECK_STEPS.findIndex(s => s.words === 'Reading the PO') + 1);
  // Detail after a colon is kept; case does not matter.
  const master = setProgress({ status: 'checking', progress: 'finding the approved master: PCS-G305-R0' });
  assert.equal(master.pct, 35);
  assert.equal(master.detail, 'PCS-G305-R0');
  // Words the page does not know still show, at the start of the check.
  const other = setProgress({ status: 'checking', progress: 'Waiting for another AVS check to finish' });
  assert.equal(other.pct, 15);
  assert.equal(other.label, 'Waiting for another AVS check to finish');
  assert.equal(setProgress({ status: 'done', progress: 'Report ready' }).pct, 100);
});

import { elapsedText, setClock } from '../../client/src/lib/avs.js';

test('the clock on a set: waiting, checking live, and how long a finished check took', () => {
  assert.equal(elapsedText(45_000), '45 s');
  assert.equal(elapsedText(272_000), '4 min 32 s');
  assert.equal(elapsedText(65_000), '1 min 05 s');
  assert.equal(elapsedText(3_900_000), '1 h 5 min');
  assert.equal(elapsedText(-5_000), '0 s', 'a browser clock a little behind the server never shows a negative time');
  const now = Date.parse('2026-09-26T14:50:00Z');
  assert.deepEqual(setClock({ status: 'queued', queued_at: '2026-09-26T14:45:00Z' }, now), { label: 'waiting', text: '5 min 00 s', live: true });
  assert.equal(setClock({ status: 'checking', claimed_at: '2026-09-26T14:49:15Z' }, now).text, '45 s');
  const done = setClock({ status: 'done', claimed_at: '2026-09-26T14:45:45Z', finished_at: '2026-09-26T14:47:30Z' }, now);
  assert.deepEqual(done, { label: 'checked in', text: '1 min 45 s', live: false });
  assert.equal(setClock({ status: 'uploading' }, now), null);
  // Not linked: the waiting bar says what starts it.
  assert.match(setProgress({ status: 'queued', fire_status: 'not_linked' }).label, /Cowork \(\/avs\)/);
});

import { AVS_REMARK_MAX, foldEarlierChecks, redoProblem } from '../../client/src/lib/avs.js';

// ── Redo verification ────────────────────────────────────────────────────────
test('a redo needs a reason, kept within the remark limit', () => {
  assert.match(redoProblem({ reason: '' }), /why/);
  assert.match(redoProblem({ reason: '  ok ' }), /why/);
  assert.equal(redoProblem({ reason: 'board changed to 350 GSM' }), null);
  assert.match(redoProblem({ reason: 'x'.repeat(AVS_REMARK_MAX + 1) }), /under/);
});

test('Report ready shows one row per report — the newest check — with the earlier ones folded under it', () => {
  const sets = [
    { id: 9, report_no: 'AVS-2026-0006', check_no: 2, result: 'PASS' },
    { id: 7, report_no: 'AVS-2026-0007', check_no: 1, result: 'PASS' },
    { id: 4, report_no: 'AVS-2026-0006', check_no: 1, result: 'HOLD' },
    { id: 3, report_no: null },
  ];
  const out = foldEarlierChecks(sets);
  assert.deepEqual(out.map(s => s.id), [9, 7, 3]);
  assert.deepEqual(out[0].earlier.map(s => s.id), [4]);
  assert.deepEqual(out[1].earlier, []);
  assert.equal(out[2].earlier, undefined);
});

test('the redo route: a reason, the report\'s own number, one open redo at a time, never a closed case', () => {
  const src = readFileSync(new URL('./routes/avs-intake.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("r.post('/avs/redo'"), src.indexOf('const istDay'));
  assert.match(route, /canUpload/);
  assert.match(route, /redoProblem\(\{ reason \}\)/);
  assert.match(route, /row_type = 'CLOSE'/);
  assert.match(route, /status IN \('uploading', 'queued', 'checking'\)/);
  assert.match(route, /redo_report_no, redo_of_set_id, redo_reason/);
  const sql = readFileSync(new URL('../../supabase/migrations/20260928180000_avs_redo_verification.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS check_requests_one_open_redo/);
});

import { inPeriod, istStamp, setEndedAt } from '../../client/src/lib/avs.js';

test('finished sets are shown by time window, by when they ended (India time for Today)', () => {
  const now = Date.parse('2026-09-28T12:00:00Z'); // 17:30 IST
  assert.equal(inPeriod('2026-09-27T19:00:00Z', 'today', now), true, '00:30 IST today');
  assert.equal(inPeriod('2026-09-27T18:00:00Z', 'today', now), false, '23:30 IST yesterday');
  assert.equal(inPeriod('2026-09-22T12:00:00Z', '7d', now), true);
  assert.equal(inPeriod('2026-09-20T12:00:00Z', '7d', now), false);
  assert.equal(inPeriod('2026-09-01T12:00:00Z', '30d', now), true);
  assert.equal(inPeriod(null, 'all', now), true);
  assert.equal(inPeriod(null, '7d', now), false);
  assert.equal(setEndedAt({ finished_at: 'f', created_at: 'c' }), 'f');
  assert.equal(setEndedAt({ cancelled_at: 'x', created_at: 'c' }), 'x');
  assert.match(istStamp('2026-09-28T10:35:00Z'), /28 Sept? 2026, 4:05 pm/i);
});

import {
  AVS_REGISTER_FILTERS, DECISION_IN_FORCE_SQL, JOB_CARD_MATCH_SQL, decisionsInForce, jobCardNumbers, qaStamp, rowMatches, undoProblem,
} from '../../client/src/lib/avs.js';

test('an undo is a row of its own: the decision before it is in force again', () => {
  const { list, last } = decisionsInForce([
    { id: 5, decision: 'UNDO', undoes_id: 4 },
    { id: 4, decision: 'RELEASE' },
    { id: 3, decision: 'ARTWORK ALERT OK' },
    { id: 2, decision: 'KEEP ON HOLD' },
  ]);
  assert.equal(last.id, 2);
  assert.deepEqual(list.map(d => d.undone), [false, true, false, false]);
  assert.equal(decisionsInForce([]).last, null);
  assert.equal(undoProblem({ remark: '' }), null, 'no questions asked');
  assert.equal(undoProblem({ remark: 'released the wrong one' }), null);
  assert.match(DECISION_IN_FORCE_SQL('dd'), /NOT IN \('ARTWORK ALERT OK', 'UNDO'\)/);
  assert.match(DECISION_IN_FORCE_SQL('dd'), /undoes_id = dd\.id/);
});

test('a report may name several job cards; each one is found', () => {
  assert.deepEqual(jobCardNumbers('CI-JC-0446, ci-jc-0447 + CI-GANG-JC-0126'), ['CI-JC-0446', 'CI-JC-0447', 'CI-GANG-JC-0126']);
  assert.deepEqual(jobCardNumbers('NO JOB CARD'), []);
  assert.match(JOB_CARD_MATCH_SQL('l.job_card', '$1'), /regexp_split_to_array/);
});

test('the QA stamp says QA Approved only when every report on the card is released', () => {
  const rel = { report_no: 'AVS-2026-0001', report_rev: 0, check_no: 1, status: 'HOLD', decision: 'RELEASE', decision_rev: 0, decision_check: 1 };
  assert.equal(qaStamp([]), null);
  assert.deepEqual([qaStamp([rel]).state, qaStamp([rel]).text], ['approved', 'QA Approved']);
  assert.equal(qaStamp([{ report_no: 'AVS-2026-0009', status: 'HOLD' }]).text, 'QA Hold');
  assert.equal(qaStamp([rel, { report_no: 'AVS-2026-0002', status: 'PASS' }]).state, 'pending');
  assert.equal(qaStamp([{ report_no: 'AVS-2026-0003', status: 'REJECT' }]).state, 'rejected');
  assert.equal(qaStamp([{ report_no: 'AVS-2026-0004', status: 'HOLD' }]).state, 'hold');
  // Released on an older issue: not approved.
  assert.equal(qaStamp([{ ...rel, report_rev: 1 }]).state, 'hold');
});

test('the register: filters and a search that finds any text on the row', () => {
  const f = k => AVS_REGISTER_FILTERS.find(x => x.key === k).match;
  assert.equal(f('open')({ case_state: 'waiting' }), true);
  assert.equal(f('open')({ case_state: 'released' }), false);
  assert.equal(f('released')({ case_state: 'released' }), true);
  assert.equal(f('rejected')({ case_state: 'rejected' }), true);
  assert.equal(rowMatches(['AVS-2026-0006', 'Levexx 1g Tablets', 'CI-JC-0446'], 'levexx 0446'), true);
  assert.equal(rowMatches(['AVS-2026-0006'], 'jc0446'), false);
  assert.equal(rowMatches(['CI-JC-0446'], 'jc0446'), true);
  assert.equal(rowMatches(['x'], '   '), true);
});

import { stepTimes } from '../../client/src/lib/avs.js';
test('where a check\'s time went: each step until the next, the last until it finished', () => {
  const t = [
    { step: 'Claude started', ms: 60000 }, { step: 'Reading the PO', ms: 300000 }, { step: 'Filing the report', ms: 120000 },
  ];
  assert.deepEqual(stepTimes({
    finished_at: '2026-09-28T10:08:00Z',
    progress_log: [
      { p: 'Claude started', at: '2026-09-28T10:00:00Z' }, { p: 'Reading the PO: 02512', at: '2026-09-28T10:01:00Z' },
      { p: 'Filing the report', at: '2026-09-28T10:06:00Z' }, { p: 'Report ready', at: '2026-09-28T10:08:00Z' },
    ],
  }), t);
  assert.deepEqual(stepTimes({}), []);
});

// ── Total time and the step checklist (owner's request, 1 Oct 2026) ──────────
import { stepChecklist, totalTime } from '../../client/src/lib/avs.js';

test('total time to verify: from Verify to the report, split into waiting and checking; live while in progress', () => {
  const done = totalTime({ status: 'done', queued_at: '2026-10-01T06:00:00Z', claimed_at: '2026-10-01T06:06:10Z', finished_at: '2026-10-01T06:18:40Z' });
  assert.deepEqual(done, { live: false, totalMs: 1_120_000, waitMs: 370_000, checkMs: 750_000 });
  const now = Date.parse('2026-10-01T06:05:00Z');
  const waiting = totalTime({ status: 'queued', queued_at: '2026-10-01T06:00:00Z' }, now);
  assert.deepEqual(waiting, { live: true, totalMs: 300_000, waitMs: 300_000, checkMs: null });
  const checking = totalTime({ status: 'checking', queued_at: '2026-10-01T06:00:00Z', claimed_at: '2026-10-01T06:02:00Z' }, now);
  assert.equal(checking.totalMs, 300_000);
  assert.equal(checking.checkMs, 180_000);
  assert.equal(totalTime({ status: 'uploading' }), null, 'no total before Verify');
  assert.equal(totalTime({ status: 'cancelled', queued_at: '2026-10-01T06:00:00Z' }), null);
  assert.equal(totalTime({ status: 'done', queued_at: '2026-10-01T06:00:00Z' }), null, 'no finish time, no total');
});

test('the step checklist: green ticks behind, the running step, nothing ahead', () => {
  const now = Date.parse('2026-10-01T06:10:00Z');
  const set = {
    status: 'checking', created_at: '2026-10-01T05:58:00Z', queued_at: '2026-10-01T06:00:00Z', claimed_at: '2026-10-01T06:02:00Z',
    progress: 'Reading the PO: 02037',
    progress_log: [
      { p: 'Claude started', at: '2026-10-01T06:02:00Z' },
      { p: 'Reading the photos', at: '2026-10-01T06:03:00Z' },
      { p: 'Finding the approved master: PMC-N042-R0', at: '2026-10-01T06:05:00Z' },
      { p: 'Reading the PO: 02037', at: '2026-10-01T06:08:00Z' },
    ],
  };
  const rows = stepChecklist(set, now);
  const by = Object.fromEntries(rows.map(r => [r.label, r]));
  assert.equal(by['Photos uploaded'].state, 'done');
  assert.equal(by['Photos uploaded'].ms, 120_000);
  assert.equal(by['Waiting for Claude to start'].state, 'done');
  assert.equal(by['Waiting for Claude to start'].ms, 120_000);
  assert.equal(by['Claude started'].state, 'done');
  assert.equal(by['Reading the photos'].ms, 120_000);
  assert.equal(by['Finding the approved master'].state, 'done');
  assert.equal(by['Finding the approved master'].ms, 180_000);
  assert.equal(by['Reading the PO'].state, 'current');
  assert.equal(by['Reading the PO'].ms, 120_000, 'the running step counts up to now');
  assert.equal(by['Checking the order book'].state, 'pending');
  assert.equal(by['Report ready'].state, 'pending');
  assert.ok(!by['Filing the photos'], 'filing the photos is listed only when the check did it');
  assert.deepEqual(rows.map(r => r.label).slice(0, 3), ['Photos uploaded', 'Waiting for Claude to start', 'Claude started']);

  const done = stepChecklist({ ...set, status: 'done', progress: 'Report ready', finished_at: '2026-10-01T06:20:00Z' }, now);
  assert.ok(done.every(r => r.state === 'done'), 'a finished check ticks every step');
  assert.equal(done.at(-1).label, 'Report ready');

  const failed = stepChecklist({ ...set, status: 'failed', progress: 'Not checked', finished_at: '2026-10-01T06:09:00Z' }, now);
  const f = Object.fromEntries(failed.map(r => [r.label, r.state]));
  assert.equal(f['Finding the approved master'], 'done');
  assert.equal(f['Reading the PO'], 'failed', 'the step it stopped at is marked');
  assert.equal(f['Comparing the panels'], 'pending');
  assert.equal(failed.at(-1).label, 'Check failed');

  const queued = stepChecklist({ status: 'queued', created_at: '2026-10-01T05:58:00Z', queued_at: '2026-10-01T06:00:00Z' }, now);
  assert.equal(queued[1].state, 'current');
  assert.equal(queued[1].ms, 600_000);
  assert.ok(queued.slice(2).every(r => r.state === 'pending'));

  const kept = stepChecklist({ ...set, progress: 'Filing the photos', progress_log: [{ p: 'Claude started', at: '2026-10-01T06:02:00Z' }, { p: 'Filing the photos', at: '2026-10-01T06:02:30Z' }] }, now);
  assert.equal(kept.find(r => r.label === 'Filing the photos').state, 'current');
});

// ── Severity, time taken and the decision stamp (owner's request, 1 Oct 2026) ─
import { AVS_SEVERITIES, SEVERITY_SQL, pdfStamp, problemSeverity, reportTime } from '../../client/src/lib/avs.js';
import { stampPdf } from './avs-stamp.js';
import { PDFDocument } from 'pdf-lib';

test('each point to clear is Critical, Major or Minor; old points get REJECT → Critical, D- → Major, R- → Minor', () => {
  assert.deepEqual(AVS_SEVERITIES, ['CRITICAL', 'MAJOR', 'MINOR']);
  assert.equal(problemSeverity({ ref: 'R-3', result: 'HOLD', severity: 'major' }), 'MAJOR', 'what Claude wrote wins');
  assert.equal(problemSeverity({ ref: 'D-001', result: 'REJECT' }), 'CRITICAL');
  assert.equal(problemSeverity({ ref: 'D-002', result: 'HOLD' }), 'MAJOR');
  assert.equal(problemSeverity({ ref: 'R-2', result: 'HOLD' }), 'MINOR');
  assert.equal(problemSeverity({ ref: 'A-1', result: 'VERIFY' }), null, 'an artwork alert is not a point to clear');
  assert.match(SEVERITY_SQL('p'), /COALESCE\(p\.severity/);
});

test('time taken for a report: Verify to the report, from its photo set; none for a Cowork report', () => {
  assert.deepEqual(reportTime({ set_queued_at: '2026-10-01T06:26:21Z', set_claimed_at: '2026-10-01T06:26:57Z', set_finished_at: '2026-10-01T06:36:45Z' }),
    { totalMs: 624_000, waitMs: 36_000, checkMs: 588_000 });
  assert.equal(reportTime({}), null);
});

test('the PDF stamp follows QA\'s decision on this issue', () => {
  const d = { decision: 'RELEASE', decided_by: 'Plant', decided_at: '2026-10-01T06:50:00Z', remark: 'Board GSM accepted by customer' };
  const s = pdfStamp('released', d);
  assert.equal(s.words, 'RELEASED BY QA');
  assert.equal(s.tone, 'green');
  assert.match(s.line, /^Plant · 01 Oct 2026, 12:20 pm IST$/);
  assert.equal(s.remark, 'Board GSM accepted by customer');
  assert.equal(pdfStamp('rejected', { decision: 'REJECT' }).words, 'REJECTED BY QA');
  assert.equal(pdfStamp('open', { decision: 'KEEP ON HOLD' }).words, 'KEPT ON HOLD BY QA');
  assert.equal(pdfStamp('open', null), null, 'no decision, no stamp');
  assert.equal(pdfStamp('waiting', null), null);
});

test('stampPdf draws on every page and leaves an undecided PDF untouched', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]); doc.addPage([595, 842]);
  const plain = await doc.save();
  assert.equal(await stampPdf(plain, null), plain);
  const out = await stampPdf(plain, pdfStamp('released', { decision: 'RELEASE', decided_by: 'Anik Dua (MD)', decided_at: '2026-10-01T06:50:00Z', remark: 'OK – ₹ rate checked' }));
  const back = await PDFDocument.load(out);
  assert.equal(back.getPageCount(), 2);
  assert.match(back.getSubject(), /^RELEASED BY QA Anik Dua \(MD\)/);
  assert.ok(out.length > plain.length);
});

// ── Cancel, delete and redo (1 Oct 2026) ────────────────────────────────────
import { reasonProblem, setDeletable, stepChecklist as steps, AVS_CANCELLABLE, auditLabel } from '../../client/src/lib/avs.js';

test('cancel and delete always carry a reason; a set with a report is deleted with its report', () => {
  assert.ok(reasonProblem(''));
  assert.ok(reasonProblem('  x '));
  assert.equal(reasonProblem('Wrong photos'), null);
  assert.ok(reasonProblem('x'.repeat(700)));
  assert.deepEqual(AVS_CANCELLABLE, ['uploading', 'queued', 'checking'], 'a check can be stopped while Claude works on it');
  assert.equal(setDeletable({ status: 'failed' }), true);
  assert.equal(setDeletable({ status: 'checking' }), true);
  assert.equal(setDeletable({ status: 'done' }), false);
  assert.equal(setDeletable({ status: 'failed', deleted_at: '2026-10-01' }), false);
  assert.equal(auditLabel('REPORT_DELETED'), 'Report deleted');
});

test('a set cancelled while checking shows where it stopped', () => {
  const t0 = Date.parse('2026-10-01T05:00:00Z');
  const at = m => new Date(t0 + m * 60000).toISOString();
  const rows = steps({ status: 'cancelled', created_at: at(0), queued_at: at(1), claimed_at: at(3), progress: 'Reading the PO',
    progress_log: [{ p: 'Claude started', at: at(3) }, { p: 'Reading the photos', at: at(4) }, { p: 'Reading the PO', at: at(6) }] }, t0 + 9 * 60000);
  const by = Object.fromEntries(rows.map(r => [r.label, r.state]));
  assert.equal(by['Reading the photos'], 'done');
  assert.equal(by['Reading the PO'], 'failed');
  assert.equal(by['Writing the report'], 'pending');
  assert.equal(rows.at(-1).label, 'Cancelled');
});

test('the database stops a cancelled run and voids a deleted report; the trail is append only', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261001180000_avs_cancel_delete_audit.sql', import.meta.url), 'utf8');
  assert.match(sql, /RAISE EXCEPTION 'AVS_CANCELLED:/);
  assert.match(sql, /RAISE EXCEPTION 'AVS_DELETED:/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON avs\.audit_log/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM avs\.deleted_reports dr WHERE dr\.report_no = reports\.report_no\)/,
    'a deleted report leaves avs.latest_reports: the register and the printing lock');
  assert.match(sql, /REVOKE ALL ON avs\.audit_log, avs\.deleted_reports FROM anon, authenticated/);
  const route = readFileSync(new URL('./routes/avs.js', import.meta.url), 'utf8');
  assert.match(route, /Undo the release first/, 'a released report is not deleted by accident');
});

test('the routine stops on AVS_CANCELLED and never reuses a deleted number', () => {
  const prompt = readFileSync(new URL('../../client/src/lib/avs-robot/routine-prompt.md', import.meta.url), 'utf8');
  assert.match(prompt, /AVS_CANCELLED/);
  assert.match(prompt, /avs\.deleted_reports/);
  assert.match(prompt, /replaces_report_no/);
});
