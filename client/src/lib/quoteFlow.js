// Send the quotation, one press (owner, 11 Nov 2026: "once we push to the quotation, it has to be the reply to the same
// mail saved in the drafts … make this whole process very seamless"). ONE server step does it all
// (POST /costing/quotations/send): finalise what has its locked prices, make the quotation (one per customer, the
// approved template: product, details asked, rate) and save each as a Gmail reply draft in the customer's own thread —
// by CI Plant itself when the mailbox's Gmail is connected, else queued to the Claude robot. Never sends: a person checks the draft and sends it from Gmail. The answer names every row it skipped.
export async function quoteAndDraft(api, enquiryIds) {
  const ids = [...new Set(enquiryIds)].filter(Boolean);
  if (!ids.length) return { quotations: [], drafted: [], failed: [], skipped: [] };
  const r = await api.post('/costing/quotations/send', { ids });
  const d = r.drafted || [];
  return {
    quotations: r.quotations || [], drafted: d.map(x => x.quotation_no),
    // `now`: saved in Gmail by CI Plant this very press; otherwise queued to the robot (a mailbox not connected).
    draftedNow: d.filter(x => x.now).map(x => x.quotation_no), queued: d.filter(x => !x.now).map(x => x.quotation_no),
    links: d.filter(x => x.view_url).map(x => ({ quotation_no: x.quotation_no, url: x.view_url })),
    failed: (r.failed || []).map(f => f.why), skipped: r.skipped || [],
  };
}
// What the person is told: what was drafted, what failed, and why anything was left out.
export function sendSummary(r) {
  const parts = [];
  const now = r.draftedNow || [], later = r.queued || (r.draftedNow ? [] : r.drafted);
  if (now.length) parts.push(`${now.join(', ')} — reply draft saved in Gmail, in the customer's thread. Check it and press Send there`);
  if (later.length) parts.push(`${later.join(', ')} made — Claude saves it as a reply draft in the customer's mail thread on its next run`);
  if (r.skipped.length) parts.push(`Left out: ${r.skipped.map(s => `${s.enquiry_no} ${s.why}`).join('; ')}`);
  if (!parts.length && !r.failed.length) parts.push('Nothing to send — no enquiry here has a locked final price waiting.');
  return parts.join(' · ');
}
