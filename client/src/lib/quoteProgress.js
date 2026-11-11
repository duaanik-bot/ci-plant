// The road a bulk costing travels to the customer's mail, as a progress bar (owner, 11 Nov 2026: "a progress bar
// kind of thing for that particular batch, showing that this is at this stage … like we do in the AVS … the timing,
// how much time has been taken to trigger it all and complete the full process").
//
// Each stage is done when every enquiry of the batch has passed it; its time is the moment the LAST of them did.
// A stage's own time = its moment − the previous stage's moment. Total = first stage → the last one done, live
// (to now) while any stage is still open. Pure: the server suite tests it (server/src/quote-progress.test.js).

export const QUOTE_STAGES = Object.freeze([
  { key: 'costed', label: 'Costed — bulk costing saved' },
  { key: 'approved', label: 'Costing approved' },
  { key: 'locked', label: 'Final prices locked' },
  { key: 'pushed', label: 'Pushed to Quotations' },
  { key: 'quoted', label: 'Quotation made' },
  { key: 'queued', label: 'Gmail draft started' },
  { key: 'drafted', label: 'Draft ready in Gmail — check it and send' },
  { key: 'sent', label: 'Sent to the customer' },
]);

const ms = x => (x ? new Date(x).getTime() : null);
const latest = xs => (xs.length && xs.every(x => x != null) ? Math.max(...xs) : null);

// `p` = { batch_created_at, rows: [{ enquiry_no, approved_at, priced_at, finalised_at, quotation_id, quotation_no,
//   q_status, q_created_at, queued_at, claimed_at, job_status, job_error, finished_at, sent_at, draft_url }] }
export function quoteProgress(p, now = Date.now()) {
  const rows = p?.rows || [];
  const n = rows.length;
  const pick = f => rows.map(f).map(ms);
  const drafted = r => ['drafted', 'sent'].includes(r.q_status);
  const at = {
    costed: n ? ms(p.batch_created_at) : null,
    approved: latest(pick(r => r.approved_at)),
    locked: latest(pick(r => r.priced_at || r.finalised_at)),
    pushed: latest(pick(r => r.finalised_at)),
    quoted: latest(pick(r => r.q_created_at)),
    queued: latest(pick(r => r.queued_at)),
    drafted: rows.every(drafted) ? latest(pick(r => r.finished_at || r.q_updated_at)) : null,
    sent: latest(pick(r => (r.q_status === 'sent' ? r.sent_at : null))),
  };
  const count = {
    costed: n,
    approved: rows.filter(r => r.approved_at).length,
    locked: rows.filter(r => r.priced_at || r.finalised_at).length,
    pushed: rows.filter(r => r.finalised_at).length,
    quoted: rows.filter(r => r.quotation_id).length,
    queued: rows.filter(r => r.queued_at).length,
    drafted: rows.filter(drafted).length,
    sent: rows.filter(r => r.q_status === 'sent').length,
  };
  const failed = rows.find(r => r.job_status === 'failed');
  let prev = null;
  let current = null;
  const stages = QUOTE_STAGES.map(s => {
    const done = n > 0 && count[s.key] === n && at[s.key] != null;
    let state = done ? 'done' : 'pending';
    if (!done && !current) { current = s.key; state = failed && s.key === 'drafted' ? 'failed' : 'current'; }
    const t = done ? at[s.key] : null;
    const out = { ...s, state, done: count[s.key], of: n, at: t ? new Date(t).toISOString() : null,
      ms: done && prev != null ? Math.max(0, t - prev) : state === 'current' && prev != null ? Math.max(0, now - prev) : null };
    if (done) prev = t;
    return out;
  });
  const doneStages = stages.filter(s => s.state === 'done').length;
  const cur = stages.find(s => s.state === 'current' || s.state === 'failed') || null;
  const partial = cur && n ? cur.done / n : 0;
  const start = at.costed;
  const end = cur ? now : prev;
  // What the person does next, and what is only waiting.
  let next = null;
  if (cur?.key === 'approved') next = { kind: 'approve', text: 'Approve the costings (Approve ready, top of the bulk costing)' };
  else if (cur?.key === 'locked' || cur?.key === 'pushed') next = { kind: 'lock', text: 'Lock the final prices and press Send quotation' };
  else if (cur?.key === 'quoted') next = { kind: 'quote', text: 'Send the quotation (it is made and saved as a Gmail reply draft)' };
  else if (cur?.key === 'queued') next = { kind: 'draft', text: 'Save the quotation as a Gmail draft' };
  else if (cur?.key === 'drafted') {
    next = failed
      ? { kind: 'failed', text: `Claude could not make the draft: ${failed.job_error || 'no reason given'} — press Save as Gmail draft again` }
      : { kind: 'wait', text: rows.some(r => r.claimed_at && !r.finished_at)
        ? 'Claude is making the draft in Gmail now'
        : 'Waiting for Claude — the enquiry desk robot picks it up on its next run (11 am and 3 pm, while the Claude app is open on the office Mac — or press Run now on the task)' };
  } else if (cur?.key === 'sent') next = { kind: 'send', text: 'Open the draft in Gmail, check it and press Send — it shows here as sent once you do' };
  return {
    stages, current: cur?.key || null, complete: !cur && n > 0, live: !!cur && n > 0,
    pct: n ? Math.round(((doneStages + partial) / stages.length) * 100) : 0,
    total_ms: start != null && end != null ? Math.max(0, end - start) : null,
    next,
    quotations: [...new Map(rows.filter(r => r.quotation_id).map(r => [r.quotation_id, { id: r.quotation_id, quotation_no: r.quotation_no, status: r.q_status, draft_url: r.draft_url }])).values()],
    to_quote: rows.filter(r => r.finalised_at && !r.quotation_id && r.status === 'quote_ready').map(r => r.id),
  };
}
