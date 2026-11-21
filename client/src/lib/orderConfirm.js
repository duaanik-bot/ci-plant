// The order confirmation to the customer (owner, 21 Nov 2026: "draft the order confirmation reply in the same thread"):
// saved by CI Plant as a Gmail DRAFT, a reply in the customer's own thread — never sent; the person sends it from Gmail.
// The mailbox is asked as for a quotation (askSender); closing that question drafts nothing.
import { askSender } from './pickSender.js';

export async function draftOrderConfirmation(api, order) {
  const from = await askSender(api, { current: order.customer_draft_mailbox || null });
  if (from === undefined) return null;
  return api.post(`/costing/enquiry-orders/${order.id}/confirm-draft`, from ? { from } : {});
}
// What the person is told.
export const confirmSaid = (r, orderNo) => (r.replaced
  ? `${orderNo}: the confirmation draft is updated in ${r.from}'s Gmail`
  : `${orderNo}: order confirmation saved as a draft in ${r.from}'s Gmail${r.threaded ? ', in the customer\'s thread' : ''} — check it and send it from Gmail`)
  + (r.trial ? ' (trial mailbox: addressed to itself)' : '');
