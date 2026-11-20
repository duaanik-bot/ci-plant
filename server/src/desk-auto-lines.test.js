import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoPill, replyLine, heldLine, approveSummary, autoCostSummary, approveTone, autoCostLines, autoCostTone, moveSummary, moveTone } from '../../client/src/lib/enquiryUi.js';

// Invented rows: only the fields each helper reads.
const toPrice = (over = {}) => ({ stage: 'costed', costing_status: 'draft', costing_auto: true, costing_approved_by: null, ...over });

test('autoPill: an auto draft waits for approval, amber', () => {
  assert.deepEqual(autoPill(toPrice()), { text: 'Auto · waiting for approval', tone: 'amber' });
});
test('autoPill: a person revised it, still waiting for approval', () => {
  assert.deepEqual(autoPill(toPrice({ costing_auto: false })), { text: 'Waiting for approval', tone: 'amber' });
});
test('autoPill: approved, green, by whom', () => {
  assert.deepEqual(autoPill(toPrice({ costing_status: 'approved', costing_approved_by: 'Asha' })), { text: 'Approved by Asha', tone: 'green' });
});
test('autoPill: nothing on a row with no costing or off To price', () => {
  assert.equal(autoPill({ stage: 'new', costing_status: null }), null);
  assert.equal(autoPill(toPrice({ stage: 'quote_ready' })), null);
  assert.equal(autoPill({ stage: 'costed' }), null);
});

test('replyLine: quoted first', () => {
  const e = { reply: { quoted: ['CI-QT-0001', 'CI-ENQ-0002'], waiting: [{ enquiry_no: 'CI-ENQ-0003', why: 'x' }], resume: { why: 'y' }, ready: false } };
  assert.equal(replyLine(e), 'Part of this mail went on CI-QT-0001, CI-ENQ-0002 — send these from here');
});
// Final review I1: Approve is offered on To price only; a finalised row waits in Quoted, whose Send quotation finishes it.
test('replyLine: a reply cut off part-way', () => {
  assert.equal(replyLine({ reply: { quoted: [], waiting: [], resume: { ids: [4], why: 'Finalised, reply not finished — press Send quotation' }, ready: false } }),
    'Finalised, reply not finished — press Send quotation');
});
test('replyLine: a price changed after approval is what the reply waits on', () => {
  const w = [{ enquiry_no: 'CI-ENQ-0003', why: 'price changed after approval — Approve again' }];
  assert.equal(replyLine({ reply: { quoted: [], waiting: w, resume: null, ready: false } }), 'Reply waits on CI-ENQ-0003: price changed after approval — Approve again');
});
test('replyLine: waits on one item, then on several', () => {
  const w = [{ enquiry_no: 'CI-ENQ-0003', why: 'waiting for approval' }];
  assert.equal(replyLine({ reply: { quoted: [], waiting: w, resume: null, ready: false } }), 'Reply waits on CI-ENQ-0003: waiting for approval');
  const more = [...w, { enquiry_no: 'CI-ENQ-0004', why: 'not costed yet' }, { enquiry_no: 'CI-ENQ-0005', why: 'not costed yet' }];
  assert.equal(replyLine({ reply: { quoted: [], waiting: more, resume: null, ready: false } }), 'Reply waits on CI-ENQ-0003: waiting for approval and 2 more');
});
test('replyLine: ready to reply', () => {
  assert.equal(replyLine({ reply: { quoted: [], waiting: [], resume: null, ready: true } }), "Ready to reply — a manager's Approve makes it");
});
test('replyLine: nothing without a mail, or when nothing is said', () => {
  assert.equal(replyLine({}), null);
  assert.equal(replyLine({ reply: null }), null);
  assert.equal(replyLine({ reply: { quoted: [], waiting: [], resume: null, ready: false } }), null);
});

test('heldLine: on To cost stages, why it could not', () => {
  assert.equal(heldLine({ stage: 'new', auto_cost_why: 'needs pasting: side or lock?' }), 'Could not cost it by itself: needs pasting: side or lock?');
  assert.equal(heldLine({ stage: 'ready', auto_cost_why: 'needs pasting: side or lock?' }), 'Could not cost it by itself: needs pasting: side or lock?');
});
test('heldLine: a why that already says Could not stays as it is', () => {
  assert.equal(heldLine({ stage: 'costing', auto_cost_why: 'Could not read the size' }), 'Could not read the size');
});
test('heldLine: a claim that stopped part-way, and one still going', () => {
  assert.equal(heldLine({ stage: 'new', auto_cost_why: 'being costed', auto_cost_stopped: true }), 'Costing stopped part-way — press Cost it for me');
  assert.equal(heldLine({ stage: 'new', auto_cost_why: 'being costed', auto_cost_stopped: false }), 'Being costed by CI Plant now');
});
test('heldLine: nothing off To cost, or with no why', () => {
  assert.equal(heldLine({ stage: 'costed', auto_cost_why: 'x' }), null);
  assert.equal(heldLine({ stage: 'new', auto_cost_why: null }), null);
});

test('approveSummary: the count, each reply, what still waits', () => {
  const r = {
    approved: [{}, {}, {}], skipped: [{ enquiry_no: 'CI-ENQ-0009', why: 'has no complete costing' }],
    replies: [
      { mail_id: 1, quotations: [{ id: 5, quotation_no: 'CI-QT-0005' }], drafted: [{ id: 5, quotation_no: 'CI-QT-0005' }], failed: [] },
      { mail_id: 2, quotations: [{ id: 6, quotation_no: 'CI-QT-0006' }], drafted: [], failed: [{ id: 6, why: 'Gmail is not connected' }] },
    ],
    waiting: [{ mail_id: 3, waiting: [{ enquiry_no: 'CI-ENQ-0012', why: 'not costed yet' }], quoted: [] }],
    later: [{ mail_id: 4 }, { mail_id: 5 }],
  };
  assert.deepEqual(approveSummary(r), [
    'Approved 3',
    'Quotation CI-QT-0005 made · draft saved',
    'Quotation CI-QT-0006 made · draft not made: Gmail is not connected',
    '2 more mails: reply not made yet — press Approve again',
    'M3 still waits on CI-ENQ-0012: not costed yet',
    'Not approved: CI-ENQ-0009 has no complete costing',
  ]);
});
test('approveSummary: one later mail, a mail with part quoted, undo-less answer', () => {
  const r = { approved: [{}], skipped: [], replies: [], waiting: [{ mail_id: 7, waiting: [], quoted: ['CI-QT-0001'] }], later: [{ mail_id: 8 }], undo: null };
  assert.deepEqual(approveSummary(r), [
    'Approved 1', '1 more mail: reply not made yet — press Approve again', 'M7: part of it went on CI-QT-0001 — send the rest from here',
  ]);
});

test('autoCostSummary: costed and the ones that need a person', () => {
  assert.equal(autoCostSummary({ costed: 3, held: [{}, {}] }), 'Costed 3 · 2 need a person');
  assert.equal(autoCostSummary({ costed: 0, held: [] }), 'Costed 0 · 0 need a person');
  assert.equal(autoCostSummary({ costed: [1, 2], held: [{}] }), 'Costed 2 · 1 need a person');
});

test('autoCostLines: the summary, the held reasons and the failed reasons', () => {
  const r = { costed: 2, held: [{ enquiry_no: 'CI-ENQ-0003', why: 'needs pasting: side or lock?' }], failed: [{ enquiry_no: 'CI-ENQ-0004', why: 'the costing stopped' }] };
  assert.deepEqual(autoCostLines(r), [
    'Costed 2 · 2 need a person',
    'Needs a person: CI-ENQ-0003 needs pasting: side or lock?',
    'Not costed, it failed: CI-ENQ-0004 the costing stopped',
  ]);
  assert.deepEqual(autoCostLines({ costed: [1], held: [], failed: [] }), ['Costed 1 · 0 need a person']);
});
test('autoCostSummary: a failed entry counts in the summary line too', () => {
  assert.equal(autoCostSummary({ costed: 1, held: [], failed: [{ enquiry_no: 'CI-ENQ-0004', why: 'x' }] }), 'Costed 1 · 1 need a person');
});
test('approveSummary: a failed reply and a failed draft give their reason', () => {
  const r = { approved: [{}], replies: [{ mail_id: 1, quotations: [], drafted: [], failed: [{ why: 'Gmail refused' }] }], waiting: [], later: [], skipped: [] };
  assert.ok(approveSummary(r).includes('Reply not made: Gmail refused'));
});
test('tone: error when anything failed, else info when there is more than one line, else success', () => {
  const bad = { approved: [{}], replies: [{ quotations: [{ id: 1, quotation_no: 'CI-QT-0001' }], drafted: [], failed: [{ id: 1, why: 'x' }] }] };
  assert.equal(approveTone(bad), 'error');
  assert.equal(approveTone({ approved: [{}], replies: [{ quotations: [], drafted: [], failed: [{ why: 'x' }] }] }), 'error');
  assert.equal(approveTone({ approved: [{}], replies: [], later: [{ mail_id: 2 }] }), 'info');
  assert.equal(approveTone({ approved: [{}], replies: [] }), 'success');
  assert.equal(autoCostTone({ costed: 1, held: [], failed: [{ enquiry_no: 'a', why: 'x' }] }), 'error');
  assert.equal(autoCostTone({ costed: 1, held: [{ enquiry_no: 'a', why: 'x' }], failed: [] }), 'info');
  assert.equal(autoCostTone({ costed: 1, held: [], failed: [] }), 'success');
});

// Final review M1: Cost it for me also says which ticked rows it left as they are, and why, and how many it did not reach.
test('autoCostLines: the rows left as they are, with why, and the rows not reached', () => {
  const r = { costed: [], held: [], failed: [], left: 3,
    skipped: [{ enquiry_no: 'CI-ENQ-0005', why: 'already has a costing' }, { enquiry_no: 'CI-ENQ-0006', why: 'is quotation ready' }] };
  assert.deepEqual(autoCostLines(r), [
    'Costed 0 · 0 need a person',
    'Not costed: CI-ENQ-0005 already has a costing; CI-ENQ-0006 is quotation ready',
    '3 not reached — press Cost it for me again',
  ]);
  assert.equal(autoCostTone(r), 'info', 'more to read');
  assert.equal(autoCostTone({ costed: [1], held: [], failed: [], skipped: [], left: 1 }), 'info');
  assert.equal(autoCostTone({ costed: [1], held: [], failed: [], skipped: [{ enquiry_no: 'a', why: 'x' }], left: 0 }), 'info');
  assert.deepEqual(autoCostLines({ costed: [1], held: [], failed: [], skipped: [], left: 0 }), ['Costed 1 · 0 need a person']);
  assert.equal(autoCostTone({ costed: [1], held: [], failed: [], skipped: [], left: 0 }), 'success');
});

// Final review I5: a Management drop or delete can leave a mail with nothing waiting, and the server makes its reply then.
// The desk says so, with Approve's own lines and tone, on the bar.
const MOVED = no => ({ moved: [{ id: 9, enquiry_no: no, to: 'dropped' }], skipped: [] });
test('moveSummary: a drop that made the mail\'s reply says what the reply did', () => {
  const r = { ...MOVED('CI-ENQ-0009'), undo: null, waiting: [], later: [],
    replies: [{ mail_id: 4, quotations: [{ id: 2, quotation_no: 'CI-QT-0002' }], drafted: [{ id: 2, quotation_no: 'CI-QT-0002' }], failed: [] }] };
  assert.deepEqual(moveSummary(r, 'CI-ENQ-0009 dropped.'), ['CI-ENQ-0009 dropped.', 'Quotation CI-QT-0002 made · draft saved']);
  assert.equal(moveTone(r), 'info');
  const failed = { ...r, replies: [{ mail_id: 4, quotations: [{ id: 2, quotation_no: 'CI-QT-0002' }], drafted: [], failed: [{ id: 2, why: 'Gmail is not connected' }] }] };
  assert.deepEqual(moveSummary(failed, 'CI-ENQ-0009 dropped.'), ['CI-ENQ-0009 dropped.', 'Quotation CI-QT-0002 made · draft not made: Gmail is not connected']);
  assert.equal(moveTone(failed), 'error');
});
test('moveSummary: what still waits and the mails not reached; an ordinary move says only its own words', () => {
  const r = { ...MOVED('CI-ENQ-0010'), replies: [], later: [{ mail_id: 6 }],
    waiting: [{ mail_id: 5, waiting: [{ enquiry_no: 'CI-ENQ-0011', why: 'waiting for approval' }], quoted: [] }] };
  assert.deepEqual(moveSummary(r, 'CI-ENQ-0010 deleted.'), [
    'CI-ENQ-0010 deleted.', '1 more mail: reply not made yet — press Approve again', 'M5 still waits on CI-ENQ-0011: waiting for approval']);
  assert.equal(moveTone(r), 'info');
  // a move with no reply step (any other move, or a login without the Management right): its words only, nothing to toast
  assert.deepEqual(moveSummary({ ...MOVED('CI-ENQ-0012'), undo: 'g' }, 'CI-ENQ-0012 dropped.'), ['CI-ENQ-0012 dropped.']);
  assert.equal(moveTone({ ...MOVED('CI-ENQ-0012') }), null);
  // nothing moved, but the reply step still answered
  assert.deepEqual(moveSummary({ moved: [], skipped: [], replies: [], waiting: [], later: [{ mail_id: 7 }] }, null),
    ['1 more mail: reply not made yet — press Approve again']);
});
test('approveSummary keeps its lines: the count, the reply lines, then what was not approved', () => {
  const r = { approved: [{}], skipped: [{ enquiry_no: 'CI-ENQ-0013', why: 'has no complete costing' }], later: [],
    replies: [{ mail_id: 1, quotations: [{ id: 5, quotation_no: 'CI-QT-0005' }], drafted: [{ id: 5 }], failed: [] }], waiting: [] };
  assert.deepEqual(approveSummary(r), ['Approved 1', 'Quotation CI-QT-0005 made · draft saved', 'Not approved: CI-ENQ-0013 has no complete costing']);
});
