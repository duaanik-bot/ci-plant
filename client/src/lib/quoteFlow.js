// Push → quotation → Gmail reply draft, in one go (owner, 11 Nov 2026: "once we push to the quotation, it has to be
// the reply to the same mail saved in the drafts"). Finalised enquiries not yet on a quotation get one per customer
// (the approved template: product, details asked, rate) and each quotation is queued to Claude as a Gmail draft in
// the customer's own thread. Never sends: a person checks the draft and sends it from Gmail.
export async function quoteAndDraft(api, enquiryIds) {
  const ids = [...new Set(enquiryIds)].filter(Boolean);
  if (!ids.length) return { quotations: [], drafted: [], failed: [] };
  const list = await api.get(`/costing/enquiries?ids=${ids.join(',')}`);
  const todo = list.filter(e => e.status === 'quote_ready' && !e.quotation_id).map(e => e.id);
  if (!todo.length) return { quotations: [], drafted: [], failed: [] };
  const r = await api.post('/costing/quotations', { ids: todo });
  const drafted = [], failed = [];
  for (const qt of r.quotations) {
    try { await api.post(`/costing/quotations/${qt.id}/draft`, {}); drafted.push(qt.quotation_no); }
    catch (e) { failed.push(`${qt.quotation_no}: ${e?.message || 'could not queue the draft'}`); }
  }
  return { quotations: r.quotations, drafted, failed };
}
export const draftedText = r => (r.drafted.length
  ? `${r.drafted.join(', ')} made — Claude saves it as a reply draft in the customer's mail thread on its next run`
  : '');
