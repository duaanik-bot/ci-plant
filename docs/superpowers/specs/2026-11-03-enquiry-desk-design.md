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
and CI Plant already holds its key in `avs.settings`: the robot key (`x-avs-robot-key`) for CI Plant's robot
routes. The enquiry desk uses that and nothing new:

- **Reading the mailbox and writing the reply is Claude's job, through the Gmail connector of the Claude
  account that runs it.** No Google Cloud project, OAuth client or Apps Script change. The mailbox is
  whichever Gmail that Claude has connected — the same skill works on any account. Each account is
  authorised once, in its own Claude, by Google's own consent screen.
- **CI Plant queues the work** (`enquiry_jobs`): Fetch and Draft in Gmail (never a send). The job waits for
  the enquiry desk robot — the Claude that has that mailbox's Gmail, running the skill — which claims it
  through the robot routes, does it, and reports back. A job nobody claims waits; nothing is lost.
  Since 5 Nov a scheduled task on the owner's Mac works the trial queue every 15 minutes (see "The robot on a
  schedule" below).
- **Never the AVS photo-check routine** (found in the live trial, 4 Nov): the owner's AVS mailbox rule (30 Sep)
  keeps AVS's Claude off dua.anik@gmail.com, and AVS reads mppchd@gmail.com only in Chrome on the office
  computer. So CI Plant does not start that routine for an enquiry job, and its prompt has no enquiry branch.
- **The procedure lives once**, in `skills/enquiry-desk/SKILL.md`. CI Plant serves it
  (`GET /api/avs/robot/enquiry-desk/procedure`), and the same folder zips into a Claude skill.

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

## The robot on a schedule (5 Nov)

A Claude desktop scheduled task, `enquiry-desk-robot`, runs every 15 minutes on the owner's Mac.

- **Each run:** it lists the trial mailbox's jobs first. With none waiting it stops in seconds. Otherwise it works
  each job with the skill.
- **Permissions:** an unattended run cannot answer permission prompts, so the task runs with Bypass permissions.
- **The guard:** a hook in the task's folder keeps the run to the skill's own work. Gmail is read-only apart from
  `create_draft`. Sending, forwarding, trashing and labels, other connectors, the web and subagents are refused,
  and so is Bash that reaches outside. A hook's refusal holds in Bypass mode (tested 5 Nov).

The setup, the guard and its tests, and the prompt are in `skills/enquiry-desk/robot/`.

**Live test, 5 Nov:** fetch job 2 was queued like the Fetch button. The 15-minute run picked it up and finished
it in 23 s: 77 mails since 3 Nov, none an enquiry. Nothing was refused, and Gmail works in scheduled runs.

## Owner's one-time steps (none needs a developer)

1. Trial: done. Claude on the owner's Mac has dua.anik@gmail.com connected and the skill installed, with the
   scheduled task and its guard (5 Nov).
2. Business, when the trial is approved: a Claude whose Gmail connector is mppchd@gmail.com, with the skill
   (`enquiry-desk-skill.zip`) added and the same scheduled task and guard (`robot/scheduled-task.md`). Then
   switch the desk to Business in Settings.

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
- The robot runs every 15 minutes round the clock, with Bypass permissions, kept to its job by the guard hook
  (5 Nov). Narrow its hours if idle runs cost too much.
