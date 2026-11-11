// Send the quotation, one press (owner, 11 Nov 2026: "once we push to the quotation, it has to be the reply to the same
// mail saved in the drafts … make this whole process very seamless"). ONE server step does it all
// (POST /costing/quotations/send): finalise what has its locked prices, make the quotation (one per customer, the
// approved template: product, details asked, rate) and queue each to Claude as a Gmail reply draft in the customer's
// own thread. Never sends: a person checks the draft and sends it from Gmail. The answer names every row it skipped.
export async function quoteAndDraft(api, enquiryIds) {
  const ids = [...new Set(enquiryIds)].filter(Boolean);
  if (!ids.length) return { quotations: [], drafted: [], failed: [], skipped: [] };
  const r = await api.post('/costing/quotations/send', { ids });
  return { quotations: r.quotations || [], drafted: (r.drafted || []).map(d => d.quotation_no), failed: (r.failed || []).map(f => f.why), skipped: r.skipped || [] };
}
// What the person is told: what was drafted, what failed, and why anything was left out.
export function sendSummary(r) {
  const parts = [];
  if (r.drafted.length) parts.push(`${r.drafted.join(', ')} made — Claude saves it as a reply draft in the customer's mail thread on its next run`);
  if (r.skipped.length) parts.push(`Left out: ${r.skipped.map(s => `${s.enquiry_no} ${s.why}`).join('; ')}`);
  if (!parts.length && !r.failed.length) parts.push('Nothing to send — no enquiry here has a locked final price waiting.');
  return parts.join(' · ');
}
