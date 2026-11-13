# Order finalised Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Order finalised button on the enquiry desk that records the order (rate, quantity, cost, loss) and sends
the order sheet to the company mailbox when a new die is involved.

**Architecture:** A pure module (`server/src/order-finalise.js`) builds lines, totals and the mail; routes in
`server/src/routes/enquiries.js` lock the rows, write `enquiry_orders`, move the rows to `ordered` and send through a
single guarded `sendToCompany` in `server/src/gmail.js`; the desk gets `OrderPanel.jsx` and an Orders tab.

**Tech Stack:** Express + pg (node:test), React/Vite, pdf-lib (KLD PDFs), Gmail REST via the mailbox's link.

**Spec:** `docs/superpowers/specs/2026-11-13-order-finalised-design.md`

## Global Constraints

- No commit, push, deploy or prod migration without the owner's word in the session (CLAUDE.md).
- Customer mail stays draft-only; `sendToCompany` is the only Gmail send and addresses only the business mailbox.
- Cost and loss never go into the mail; audit_log gets numbers only.
- Tests run as `node --test src/<file>.test.js` (never the bare `src/` directory); DB tests: `ENQUIRY_PG=1`.
- Invented names and figures in fixtures (public repo).

## Review Focus

- A row whose costing is incomplete or hidden: refused with a reason, the rest of the press goes through.
- Two presses at once on the same rows: the second finds them `ordered` and refuses them (rows are locked).
- Rate typed as 0, blank or text: refused per line ("rate a carton is needed"), nothing half-written.
- Gmail link missing or answering an error: order kept, `mail_status = failed` with the reason; Send again works.
- The business mailbox address empty or malformed: no send attempted, reason recorded.

---

### Task 1: Order lines, totals and the mail (pure)

**Files:** Create `server/src/order-finalise.js`, `server/src/order-finalise.test.js`

**Interfaces — Produces:**
- `NEW_DIE_PROCESS` (= `HOUSE_RULES.process_new_die`), `newDieFromInputs(inputs) → boolean`
- `orderLine(enquiry, { inputs, quotationLine = null, kld = null }) → { enquiry_id, enquiry_no, product, size, style,
  art, board, gsm, qty, rate, cost, margin, margin_total, value, sheet: {l, w} | null, ups, new_die, kld: {rev, size_id} | null,
  counter: number | null }` (pre-filled values)
- `applyEdits(line, { qty, rate, new_die }) → line` (recomputes value, margin, margin_total); throws on a missing rate/qty
- `orderTotals(lines) → { total, loss, items_at_loss, new_dies }` (loss = sum of negative margin_total, as a positive number)
- `orderMail({ order_no, customer, quotation_no, lines, by, at }) → { subject, text, html }` — no cost or loss anywhere

Tests (each asserts the named behaviour): rate pre-fill order (quotation line > final > proposed);
loss when rate < cost (margin −0.6 × 2,050 = −1,230); totals; new die from process 3000 vs 2000;
mail table holds product/qty/rate/sheet/ups/board/die and **does not** contain the cost figure or the word "loss".

### Task 2: The one send

**Files:** Modify `server/src/gmail.js`, `server/src/gmail-link.test.js`

**Produces:** `sendToCompany(token, { raw, to, company }) → { message_id, thread_id }` — refuses unless `to` is exactly
one address equal (case-insensitive) to `company`; posts `/messages/send`.

Tests: refuses another address / a list / an empty company; guard test now passes only when `/messages/send` appears
in gmail.js inside `sendToCompany` and nowhere else on the server.

### Task 3: Migration + replay

**Files:** Create `supabase/migrations/20261113120000_enquiry_orders.sql`; Modify `server/src/db.js` (replay line),
`server/src/enquiry-desk.js` (STATUS_LABEL `ordered: 'Order finalised'`).

### Task 4: Routes

**Files:** Modify `server/src/routes/enquiries.js`, `server/src/enquiry-pg.test.js`

- `GET /costing/enquiries/order-preview?ids=` → `{ lines, company: {email}, can_send, sender }` (Costing tick)
- `POST /costing/enquiries/order` body `{ items: [{ id, qty, rate, new_die }], mail }` (Management) →
  `{ order: {...}, done: [enquiry_no], refused: [{ enquiry_no, why }], mail: { status, error } }`
- `GET /costing/enquiry-orders` (Costing tick); `POST /costing/enquiry-orders/:id/mail` (Management) — send again.

PG tests: Costing-only login refused (403); finalise moves rows to `ordered` and writes one order with lines and loss;
the fake Google receives exactly one `/messages/send` with To = the business address and the KLD PDF attached;
Gmail refusing → order kept, `mail_status = failed`; Send again → `sent`; a second press on the same rows refused.

### Task 5: Desk UI

**Files:** Create `client/src/pages/costing/OrderPanel.jsx`; Modify `client/src/lib/enquiryUi.js` (Orders tab),
`client/src/pages/costing/EnquiryDesk.jsx` (row button, Sent-tab button, Orders tab list).

Verify: client build; harness page with stubbed api (TEMP-VERIFY, removed after) — panel pre-fills, edits recompute
the loss in red, Finalise posts the edited lines.
