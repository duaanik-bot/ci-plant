// The bulk costing's progress bar to the customer's mail. Invented enquiries and times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteProgress, QUOTE_STAGES } from '../../client/src/lib/quoteProgress.js';

const T = m => new Date(Date.UTC(2026, 10, 11, 9, 0) + m * 60000).toISOString();
const row = (id, over = {}) => ({ id, enquiry_no: `CI-ENQ-90${id}`, status: 'costing', approved_at: null, priced_at: null, finalised_at: null,
  quotation_id: null, q_status: null, q_created_at: null, queued_at: null, claimed_at: null, finished_at: null, job_status: null, sent_at: null, ...over });

test('pushed but no quotation yet: the next step is to make it, and the clock runs', () => {
  const p = quoteProgress({ batch_created_at: T(0), rows: [
    row(1, { status: 'quote_ready', approved_at: T(1), priced_at: T(3), finalised_at: T(4) }),
    row(2, { status: 'quote_ready', approved_at: T(1), priced_at: T(2), finalised_at: T(4) }),
  ] }, new Date(T(10)).getTime());
  assert.deepEqual(p.stages.map(s => s.state), ['done', 'done', 'done', 'done', 'current', 'pending', 'pending', 'pending']);
  assert.equal(p.current, 'quoted');
  assert.equal(p.next.kind, 'quote');
  assert.deepEqual(p.to_quote, [1, 2]);
  assert.equal(p.stages[2].ms, 2 * 60000, 'locked at the LAST row (3 min) − approved (1 min)');
  assert.equal(p.stages[4].ms, 6 * 60000, 'the open stage runs from the last done one to now');
  assert.equal(p.total_ms, 10 * 60000);
  assert.ok(p.live);
  assert.equal(p.pct, 50);
});

test('a stage done for some rows only stays current, with its count', () => {
  const p = quoteProgress({ batch_created_at: T(0), rows: [row(1, { approved_at: T(1) }), row(2)] }, new Date(T(5)).getTime());
  const s = p.stages.find(x => x.key === 'approved');
  assert.equal(s.state, 'current');
  assert.equal(s.done, 1);
  assert.equal(p.next.kind, 'approve');
});

test('queued for Claude: waiting; claimed: drafting; failed: shows why', () => {
  const base = { status: 'quote_ready', approved_at: T(1), priced_at: T(2), finalised_at: T(3), quotation_id: 7, quotation_no: 'CI-QTN-0001', q_created_at: T(4), queued_at: T(4) };
  const waiting = quoteProgress({ batch_created_at: T(0), rows: [row(1, { ...base, q_status: 'queued', job_status: 'queued' })] });
  assert.equal(waiting.current, 'drafted');
  assert.equal(waiting.next.kind, 'wait');
  assert.match(waiting.next.text, /every 15 minutes/);
  const drafting = quoteProgress({ batch_created_at: T(0), rows: [row(1, { ...base, q_status: 'queued', job_status: 'working', claimed_at: T(9) })] });
  assert.match(drafting.next.text, /making the draft/);
  const failed = quoteProgress({ batch_created_at: T(0), rows: [row(1, { ...base, q_status: 'ready', job_status: 'failed', job_error: 'Gmail refused' })] });
  assert.equal(failed.stages.find(s => s.key === 'drafted').state, 'failed');
  assert.match(failed.next.text, /Gmail refused/);
});

test('drafted then sent: complete, the total stops at the send', () => {
  const r = { status: 'sent', approved_at: T(1), priced_at: T(2), finalised_at: T(3), quotation_id: 7, quotation_no: 'CI-QTN-0001', q_created_at: T(4),
    queued_at: T(4), claimed_at: T(15), finished_at: T(16), job_status: 'done', draft_url: 'https://mail.google.com/x' };
  const drafted = quoteProgress({ batch_created_at: T(0), rows: [row(1, { ...r, status: 'quote_ready', q_status: 'drafted' })] }, new Date(T(30)).getTime());
  assert.equal(drafted.current, 'sent');
  assert.equal(drafted.next.kind, 'send');
  assert.equal(drafted.stages.find(s => s.key === 'drafted').ms, 12 * 60000);
  assert.equal(drafted.quotations[0].draft_url, 'https://mail.google.com/x');
  const sent = quoteProgress({ batch_created_at: T(0), rows: [row(1, { ...r, q_status: 'sent', sent_at: T(40) })] }, new Date(T(90)).getTime());
  assert.ok(sent.complete);
  assert.equal(sent.pct, 100);
  assert.equal(sent.total_ms, 40 * 60000, 'not to now — the road ended at the send');
  assert.equal(sent.next, null);
});

test('no enquiry rows: nothing to show', () => {
  const p = quoteProgress({ batch_created_at: T(0), rows: [] });
  assert.equal(p.pct, 0);
  assert.equal(p.stages.length, QUOTE_STAGES.length);
});
