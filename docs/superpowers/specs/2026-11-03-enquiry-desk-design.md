# Enquiry desk — customer enquiry → costing → final price → quotation → reply

Written 2026-11-03 from the owner's brief (sections 1–12, an AI-polished paste) and his steer, the same day:
"Since we are already using AVS … continue to that only so that the same keys can be used and we don't have
to do all the labour work from scratch." He handed every other choice over ("You decide and do the
needful"), so the calls below are mine unless quoted.

## Why

Enquiries arrive by e-mail and are costed, priced and answered by hand. The owner wants them gathered in one
place, pushed into the Costing module one by one or in bulk, priced by a person (the costing proposes, a
person decides), turned into a customer quotation and answered in the customer's own e-mail conversation —
with the internal costing never reaching the customer.

## Built on AVS (the owner's call)

The AVS robot already reads the company mailbox with Claude (the order intake keys POs from mppchd@gmail.com)
and CI Plant already holds its keys in `avs.settings`: the robot key (`x-avs-robot-key`) for CI Plant's robot
routes and the Claude link (the AVS routine's API trigger) that CI Plant fires. The enquiry desk uses those
and nothing new:

- **Reading the mailbox and writing the reply is Claude's job, through the Gmail connector of the Claude
  account that runs it.** No Google Cloud project, OAuth client or Apps Script change. The mailbox is
  whichever Gmail that Claude has connected — the same skill works on any account. Each account is
  authorised once, in its own Claude, by Google's own consent screen.
- **CI Plant queues the work** (`enquiry_jobs`): Fetch and Draft in Gmail (never a send). It fires the AVS routine with
  `CI Plant enquiry job <n>`; the routine (or anyone running the skill) claims the job through the robot
  routes, does it, and reports back. A job nobody claims waits; nothing is lost.
- **The procedure lives once**, in `skills/enquiry-desk/SKILL.md`. CI Plant serves it to the routine
  (`GET /api/avs/robot/enquiry-desk/procedure`), and the same folder zips into a Claude skill — so the cloud
  routine, the office PC and a person's Claude follow one text.

## Two mailboxes, never confused

`enquiry_mailboxes` holds two rows: **trial** (dua.anik@gmail.com) and **business** (mppchd@gmail.com).
One is "in use" (admin switches it in the desk's Settings). Every job carries its mailbox, and Claude checks
its own Gmail is that mailbox before it reads or writes (a `deliveredto:` search must find mail), so a job
can never run on the wrong account.

- Trial drafts are addressed **only to the trial address itself** (`send_to = 'own'`): CI Plant puts that address in
  the job, the subject starts `[TRIAL]`, and the procedure refuses any other recipient. No customer is
  written to from the trial account unless an admin switches its `send_to` to `customers`.
- Business replies go to the customer, in the customer's own thread.

## The desk (Costing → Enquiry desk)

One screen, five stages as tabs (the brief's own recommendation): **Inbox · Costing · Final price ·
Quotations · Sent**, plus Settings. Search and chips filter by customer, product, date and status. Rows
tick for bulk actions (the plant's SelectionDock).

Statuses, as the brief lists them: New enquiry → Ready for costing → Costing in progress → Costing
completed → Final price pending → Quotation ready → Quotation sent; plus **Dropped** (not an enquiry, or
no quote) which can be brought back. "Costing completed" is read from the linked costing (complete), never
stored, so it cannot drift.

One e-mail can hold several enquiries: each item is its own row (CI-ENQ-0001…), keeping a link to the mail
(`enquiry_mails`: Gmail message and thread ids, sender, subject, received, text, attachment names, a link
to open it in Gmail). The same mail filed twice is refused by its Gmail message id (per mailbox).

Enquiries can also be added by hand (phone, WhatsApp).

### Costing

- **Push to single costing** opens New costing filled from the enquiry (customer, product, size, pasting,
  first quantity, GSM, colours) with the module's normal auto-fill; saving links the costing to the
  enquiry (`enquiry_id` on the save).
- **Push to bulk costing** opens Bulk costing with one row per ticked enquiry; saving the batch links each
  row's costing to its enquiry.
- The costing stays the Costing module's own: revisions, approval and the Size Library question as before.

### Final price (the person's decision)

- For each quantity the customer asked about, the desk shows the **proposed price** — the costing's quote
  price per carton at that quantity (CI-1 quantity breaks) — and an editable **final price**, started at the
  proposed price rounded **up** to the paisa (never below it).
- Bulk adjust on ticked rows: + ₹ a carton, + %, round up to ₹0.05.
- Every save of a final price is kept (`enquiry_events`: who, when, proposed and final), and the proposal
  it was set against is remembered, so "the costing changed since" is flagged.
- **Finalise prices** needs the Management right (the same `users.is_management` that approves costings)
  and moves the rows to Quotation ready. Changing a finalised price reopens it (Final price pending).

### Quotations

- **Generate quotation** on ticked Quotation-ready rows. Rows are grouped by customer (customer master,
  else the contact e-mail); one quotation (CI-QTN-0001…) per customer — different customers are never
  mixed. A quotation of one row is the "single" quotation.
- Lines: product, size, the customer's specs as the enquiry recorded them, quantity, final rate a carton.
  **No amount column and no total on the customer's copy** (owner, after the trial, 3 Nov). The quotation row
  keeps a value inside (each item's first quantity) for the desk's own list.
- The reply always opens "Dear Sir/Madam," — never a name (owner, 3 Nov). The standard terms name no validity
  period (owner, 3 Nov).
- **Strict separation:** a quotation is a snapshot built by one whitelist function
  (`customerLine()`) from the enquiry and the final price only. The PDF and the e-mail are made from the
  quotation row and never read a costing. A test files a costing full of marked internal figures and
  proves none of them reaches the snapshot, the e-mail or the PDF text.
- Preview: the customer's PDF (server-side, pdf-lib, the default billing entity's letterhead) and the reply.
- **Draft e-mail reply**: CI Plant writes it (greeting, a rates table, the PDF attached); the person edits
  the opening and closing words.
- **Never sent from here** (owner, 3 Nov): the only way out is **Save as a Gmail draft**. The job carries
  exactly that text and that PDF (kept with the job, with its sha256), and Claude saves them as a draft in the
  customer's thread — Claude composes nothing and has no send step. The person checks the draft and sends it
  from Gmail; the next Fetch notices a draft that went and marks the quotation sent (or "Mark as sent",
  Management right). There is no send job: the jobs table allows only fetch and draft.
- The audit timeline (read by every login) gets numbers and actions only, never a price or an address.

## The robot routes (robot key, mounted before login)

    GET  /api/avs/robot/enquiry-desk/procedure      the procedure (skills/enquiry-desk/SKILL.md)
    GET  /api/avs/robot/enquiry-jobs                queued jobs
    POST /api/avs/robot/enquiry-jobs/:id/claim      queued → working; the job's full brief
    POST /api/avs/robot/enquiry-jobs/:id/mails      a Fetch job files mails and their items
    GET  /api/avs/robot/enquiry-jobs/:id/attachment the quotation PDF of a Draft job
    POST /api/avs/robot/enquiry-jobs/:id/sent-drafts a Fetch reports drafts the person has sent from Gmail
    POST /api/avs/robot/enquiry-jobs/:id/done       result (sent / draft ids) or an error

## Owner's one-time steps (none needs a developer)

1. Business: in the AVS routine at claude.ai, paste the updated prompt from AVS → Setup (it adds the enquiry
   branch at the top; AVS checks run as before). Its Gmail connector is already the business mailbox.
2. Trial: nothing — Claude on this Mac has dua.anik@gmail.com connected; the skill runs here.
3. After the trial is approved: upload `enquiry-desk.zip` to the Claude account(s) that will run it.

## Non-goals

- No Gmail access from CI Plant's own server (no OAuth tokens stored in CI Plant).
- No sending at all from CI Plant or Claude: every reply is a Gmail draft a person sends (owner, 3 Nov).
- No change to the AVS check, the order intake or the costing rule (CI-1).

## Calls I made (check these)

- The desk is a tab of Costing, open to the Costing tick; Finalise and Mark as sent need the Management right; anyone with the tick can save a draft.
- Final price starts at the proposal rounded up to the paisa.
- The value kept inside counts each item's first quantity only (the customer sees no total).
- Trial drafts are addressed to itself only; an admin can widen that.
- New tables carry no foreign key to plant tables (as Costing), and get the realtime ping triggers.
