# Order finalised — design (13 Nov 2026)

## The owner's request (12 Nov 2026, verbatim in part)

> after we save the costing or send the quotation to the customer, we need one more button at the role level. Once
> the order is finalised with the customer, we need a button to finalise the order … If that is the new die then we
> will be drafting the email to our company, mppchd@gmail.com, saying that these orders have been finalised at these
> and these rates … these are the prices that have been given for these output sizes and these are the die lines. All
> that information needs to be given in the form of a table. Things need to be kept simple … The email will directly
> shoot to mppchd@gmail.com. Also, the price at which the order is being finalised should be pre-filled but still
> editable … Once we finalise that, data also needs to be added into that particular order, and it needs to be
> mentioned what the loss is where we have booked this order … Our team needs to know: the product name, the art
> details, the quantity, the rate at which the order is going to come, what the output size should be, the number
> of ups, the boards and all the relevant details.

13 Nov: "continue for button" — the owner chose to skip further questions. Every choice not in his words is marked
**(my call)** below, so he can change it.

## What it does

1. On the enquiry desk, a row that has a complete costing and has reached Final price, Quotations, Counter or Sent
   gets an **Order finalised** button. A sent quotation gets the same button for all its items. **(my call: "role
   level" read as a button on the row, and pressing it needs the Management right, like Finalise and Mark as sent.)**
2. The button opens one panel for the items of that customer: per item the product and size, the **quantity** and
   the **rate a carton** (both pre-filled and editable), our **cost a carton** from the costing, and the margin or
   **loss** a carton and on the order (red when below cost). Also shown: output sheet, ups, board and GSM, art
   details, New die (tickable) and whether a KLD is drawn. Totals: order value, loss on the order, items below cost.
   - Rate pre-fill **(my call)**: the rate on the customer's quotation for that item. Otherwise the final price, then
     the costing's proposed price. A countered item shows the customer's figure as a one-press choice.
   - Quantity pre-fill: the quotation's quantity, else the first quantity asked.
   - New die pre-fill **(my call)**: ticked when the costing's process charge is the new-die rate (₹3,000), because
     a saved costing does not keep the tick itself.
3. **Finalise order** records it: one order record (CI-OF-0001 …) holding every line as finalised (qty, rate, cost,
   margin/loss, sheet, ups, board, die, KLD), and each enquiry moves to **Order finalised** (a new desk tab,
   **Orders**, listing the records with their value, loss and mail state).
4. **Mail to the team**: when any item is a new die, CI Plant sends the order sheet straight to the company mailbox
   (the desk's business mailbox address, mppchd@gmail.com), from the mailbox in use's connected Gmail. It is not a
   draft. The panel shows the tick, on by default only when a new die is involved, and can be ticked for an order
   on existing dies too **(my call)**.
   - Subject: `Order finalised — <customer> — <n> item(s), <k> new die(s) — CI-OF-0001`.
   - One table: #, product, size and style, art details (colours, coating, specs), quantity, rate a carton, value,
     output sheet (in), ups, board (name, GSM), die (new / existing), KLD.
   - Each drawn KLD goes with it as its PDF (the die lines).
   - **Loss and cost stay in CI Plant (my call)**: the desk keeps the rule that cost, loss and discount never leave
     CI Plant. The mail carries rates, not costs.
5. Gmail not connected, or the send fails: the order is still finalised (no hard blocker), the record says "mail not
   sent" and why, and **Send again** on the Orders tab retries.

## Rules that stay

- Customer mail is still draft-only: nothing in CI Plant sends to a customer.
- The single new send (`sendToCompany`, server/src/gmail.js) can only address the company mailbox: one recipient,
  equal to the business mailbox's address, no Cc or Bcc. The guard test that fails the build on any other Gmail send
  stays, narrowed to allow exactly this function.
- Plant audit log: numbers and actions only (no prices). Prices and losses go to enquiry_events and the order record,
  both read only under the Costing tick.

## Data

Migration `20261113120000_enquiry_orders.sql` (replayed by db.js init, idempotent, needs the owner's word before it is
applied on prod):

- `enquiry_orders`: id, order_no (CI-OF-…), mailbox, customer_id, customer_name, quotation_id, lines jsonb, total,
  loss, items_at_loss, new_dies, mail_wanted, mail_status (`none` | `sent` | `failed`), mail_to, mail_subject,
  mail_message_id, mail_error, mail_sent_at, created_by, created_by_name, created_at.
- `enquiries.order_id`; `enquiries.status` gains `ordered`.
- The realtime ping trigger on the new table, as on the desk's other tables.

## Not in this change

- Linking the record to the sales order keyed later from the customer's PO.
- Undoing a finalised order (a mail may already have gone).
- Layout options for the output sheet (the owner's next request, queued separately).
