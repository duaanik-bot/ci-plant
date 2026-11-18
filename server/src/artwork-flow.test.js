import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, actionsFor, proofNo, matchExport, groupByThread, proofMailText, applyVerdict } from './artwork-flow.js';

// The artwork workflow's rules (17 Nov 2026). Invented jobs, codes and names.

test('each stage offers only its own next button; deleted and superseded versions offer none', () => {
  assert.deepEqual(Object.keys(STAGES), ['new', 'designer_file', 'proof_ready', 'approval_sent', 'approved', 'changes', 'to_confirm', 'released']);
  assert.deepEqual(actionsFor({ stage: 'new' }), []);
  assert.deepEqual(actionsFor({ stage: 'designer_file' }), ['send_for_approval']);
  assert.deepEqual(actionsFor({ stage: 'proof_ready' }), ['send_email', 'cancel_draft']);
  assert.deepEqual(actionsFor({ stage: 'approval_sent' }), ['decide']);
  assert.deepEqual(actionsFor({ stage: 'to_confirm' }), ['decide']);
  assert.deepEqual(actionsFor({ stage: 'changes' }), ['decide']);
  assert.deepEqual(actionsFor({ stage: 'approved' }), ['release']);
  assert.deepEqual(actionsFor({ stage: 'released' }), []);
  assert.deepEqual(actionsFor({ stage: 'designer_file', deleted_at: '2026-11-17' }), []);
  assert.deepEqual(actionsFor({ stage: 'designer_file', superseded: true }), []);
  assert.deepEqual(actionsFor({ stage: 'designer_file', status: 'not_artwork' }), []);
});

test('a proof number names the job, the version and the count', () => {
  assert.equal(proofNo('CI-AW-0012', 'R0.2', 3), 'PRF-CI-AW-0012-R0.2-3');
});

test('an export is matched by the code and revision in its file name, to the newest open version', () => {
  const vs = [
    { version_id: 1, client_item_code: 'PCS-X398', client_rev: 'R2', stage: 'approved' },
    { version_id: 2, client_item_code: 'PCS-X398', client_rev: 'R3', stage: 'new' },
    { version_id: 3, client_item_code: 'PCS-X398', client_rev: 'R3', stage: 'changes' },
    { version_id: 4, client_item_code: 'PMC-X028', client_rev: 'R1', stage: 'new' },
  ];
  assert.deepEqual(matchExport('PCS-X398-R3 - ALPHA SUSPENSION - CARTON.cdr', vs), { version_id: 3 });
  assert.deepEqual(matchExport('pmc-x028 - beta 10 -r1 - carton.CDR', vs), { version_id: 4 });
  assert.match(matchExport('PCS-X398-R9 - ALPHA.cdr', vs).why, /no open version .*PCS-X398 R9/);
  assert.match(matchExport('NEO KIT 7 OUTER.cdr', vs).why, /no item code/);
  assert.match(matchExport('PCS-X398-R2 - ALPHA.cdr', vs).why, /no open version/, 'an approved version is not reopened by an export');
  // no revision in the name: only when one open version of that code exists
  assert.deepEqual(matchExport('PMC-X028 BETA.cdr', vs), { version_id: 4 });
  assert.match(matchExport('PCS-X398 ALPHA.cdr', vs).why, /2 open versions/);
});

test('versions from one client thread go in one mail; a version with no thread goes alone', () => {
  const g = groupByThread([
    { version_id: 1, gmail_thread_id: 't1' }, { version_id: 2, gmail_thread_id: 't2' },
    { version_id: 3, gmail_thread_id: 't1' }, { version_id: 4, gmail_thread_id: null }, { version_id: 5 },
  ]);
  assert.deepEqual(g.map(x => x.map(v => v.version_id)), [[1, 3], [2], [4], [5]]);
});

test('the approval mail lists each proof with what the client must check, in the house words', () => {
  const m = proofMailText({ subject: 'Artwork PCS-X001 R0', proofs: [
    { proof_no: 'PRF-CI-AW-0001-R0.1-1', product_name: 'ALPHA CARTON', client_item_code: 'PCS-X001', label: 'R0.1', page_w_mm: 138, page_h_mm: 96.5, colours: ['Cyan', 'Magenta', 'PANTONE 286 C'] },
    { proof_no: 'PRF-CI-AW-0002-v1-1', product_name: 'ALPHA LABEL', client_item_code: null, label: 'v1', colours: [] },
  ] });
  assert.equal(m.subject, 'Re: Artwork PCS-X001 R0');
  assert.match(m.text, /^Dear Sir\/Madam,\n\nPlease Provide Approval,/);
  assert.match(m.text, /1\. PRF-CI-AW-0001-R0\.1-1 — ALPHA CARTON — PCS-X001 R0\.1 — 138 × 96\.5 mm — Cyan, Magenta, PANTONE 286 C/);
  assert.match(m.text, /2\. PRF-CI-AW-0002-v1-1 — ALPHA LABEL — v1/);
  assert.match(m.text, /quote the proof number/i);
  assert.equal(proofMailText({ subject: 'RE: x', proofs: [] }).subject, 'RE: x', 'no second Re:');
});

test('a reply moves the versions it names; a reply naming none in a mail of several goes to a person', () => {
  const mail = [{ version_id: 1, proof_no: 'PRF-A-1' }, { version_id: 2, proof_no: 'PRF-B-1' }];
  assert.deepEqual(applyVerdict({ verdict: 'approval', proof_nos: ['prf-a-1'] }, mail), [{ version_id: 1, stage: 'approved' }]);
  assert.deepEqual(applyVerdict({ verdict: 'changes', proof_nos: ['PRF-A-1', 'PRF-B-1'] }, mail),
    [{ version_id: 1, stage: 'changes' }, { version_id: 2, stage: 'changes' }]);
  assert.deepEqual(applyVerdict({ verdict: 'approval', proof_nos: [] }, mail), [{ version_id: 1, stage: 'to_confirm' }, { version_id: 2, stage: 'to_confirm' }]);
  assert.deepEqual(applyVerdict({ verdict: 'approval', proof_nos: [] }, [mail[0]]), [{ version_id: 1, stage: 'approved' }]);
  assert.deepEqual(applyVerdict({ verdict: 'unclear', proof_nos: ['PRF-A-1'] }, mail), [{ version_id: 1, stage: 'to_confirm' }]);
  assert.deepEqual(applyVerdict({ verdict: 'whatever', proof_nos: ['PRF-A-1'] }, mail), [{ version_id: 1, stage: 'to_confirm' }], 'an unknown verdict is never an approval');
});

test('a reply naming a proof that is not the one out — an older proof, another job\'s — never approves: a person decides', () => {
  const out = [{ version_id: 1, proof_no: 'PRF-A-2' }];
  assert.deepEqual(applyVerdict({ verdict: 'approval', proof_nos: ['PRF-A-1'] }, out), [{ version_id: 1, stage: 'to_confirm' }]);
  assert.deepEqual(applyVerdict({ verdict: 'approval', proof_nos: ['PRF-ZZ-1'] }, out), [{ version_id: 1, stage: 'to_confirm' }]);
  assert.deepEqual(applyVerdict({ verdict: 'changes', proof_nos: ['PRF-ZZ-1'] }, out), [{ version_id: 1, stage: 'to_confirm' }]);
  // naming the right one still works
  assert.deepEqual(applyVerdict({ verdict: 'approval', proof_nos: ['PRF-A-2'] }, out), [{ version_id: 1, stage: 'approved' }]);
});
