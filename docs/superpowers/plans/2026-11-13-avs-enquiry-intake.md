# AVS enquiry intake — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native: the owner wants it built in this
> session). Steps use checkbox (`- [ ]`) syntax. **No commit steps** — CLAUDE.md: nothing is committed, pushed or
> deployed without the owner's say-so in the session.

**Goal:** the office AVS files price requests and counter-offers from the business mailbox onto the Enquiry desk through
an `avs` holding table; CI Plant copies them within seconds, never twice, and alerts the Costing logins.

**Architecture:** AVS writes `avs.enquiry_intake` by SQL (its own rules allow only avs tables). A pg_net trigger posts
to a robot route; `server/src/enquiry-intake.js` copies new rows with the desk's own helpers (`cleanMail`,
`insertEnquiry`, `recordCounter`) and announces new mails once (`enquiry_mails.alerted_at`). The same-mail backstop and
the alert also serve the Mac robot's route.

**Tech stack:** Node 20 ESM, Express, pg; node:test; embedded-postgres for the PG suite; React (Vite) desk.

**Spec:** `docs/superpowers/specs/2026-11-13-avs-enquiry-intake-design.md`

## Global constraints

- Mailboxes: business = `enquiry_mailboxes.key 'business'`; trial = `'trial'`. AVS rows must carry the business email.
- Filed AVS rows: `enquiries.source = 'robot'`, `created_by_name = 'AVS (office)'`; mail row `mailbox = 'business'`,
  `job_id NULL`.
- Alert kind `new_enquiry`, category `approvals`; recipients = active users for whom `mayCost(u)` is true; words carry
  no price, no figure from the customer, no customer address.
- Same mail = same sender, subject, `bodyPrint` (lower-case, whitespace collapsed, first 1,500 characters) and
  attachment names, received within two hours, in a different mailbox, checked under the CI-ENQ lock. An empty print or
  a missing time never matches. (Tightened after the code review of 13 Nov.)
- Public repo: invented names and addresses only (`example-pharma.test` style).
- No hard blockers anywhere except the business draft guard (a draft no robot can make).

## Review focus

1. A mail with no body (attachment only) must never be taken for another empty mail from the same sender — test in
   Task 2 (`bodyPrint('')` is `''`) and Task 3 (two empty mails both file).
2. AVS writes a row with odd items (no items, a quantity as text) — the row still files, as the robot route does
   (placeholder item) — Task 3.
3. Several mails inserted in ONE statement, and two copiers running at once — every row filed exactly once — Task 3.
4. A burst of mails gives one alert, not one per mail; a second call announces nothing — Task 3.
5. A business-mailbox quotation with no Gmail link must say what to do, not queue a dead job; the trial mailbox keeps
   its robot job — Task 5.

---

### Task 1: Schema

**Files:**
- Create: `supabase/migrations/20261113180000_enquiry_mail_alerts.sql` (public; replayed by `db.js` init after
  `20261113120000_enquiry_orders.sql`)
- Create: `supabase/migrations/20261113180100_avs_enquiry_intake.sql` (production-only, like the other avs migrations)
- Modify: `server/src/db.js` (replay the first file)

- [ ] `enquiry_mails.alerted_at timestamptz`, backfilled `= created_at` for every existing row; partial index on
  `id WHERE alerted_at IS NULL`.
- [ ] `avs.enquiry_intake`: `id bigserial`, `kind text CHECK (kind IN ('enquiry','counter'))`, `mailbox_email`,
  `gmail_message_id` (NOT NULL), `gmail_thread_id`, `subject`, `from_name`, `from_email`, `to_text`, `received_at`,
  `body_text`, `attachments jsonb DEFAULT '[]'`, `view_url`, `summary`, `customer_name`, `contact_name`,
  `contact_email`, `items jsonb DEFAULT '[]'`, `counters jsonb DEFAULT '[]'`, `intake_run_id bigint`, `created_at`,
  `status text DEFAULT 'new' CHECK (status IN ('new','filed','skipped','refused'))`, `handled_at`, `result jsonb`;
  `UNIQUE (mailbox_email, gmail_message_id)`; RLS on; `REVOKE ALL … FROM PUBLIC, anon, authenticated`.
- [ ] Trigger `enquiry_intake_alert` AFTER INSERT FOR EACH ROW WHEN (NEW.status = 'new'): pg_net POST
  `<ci_plant_url>/api/avs/robot/enquiries-notify` with `x-avs-robot-key`; all errors swallowed (copy of
  `draft_po_alert`). The extension, function and trigger are made only when `pg_available_extensions` has pg_net.
- [ ] Verified by Task 3's PG test, which creates `avs` and runs this file.

### Task 2: Pure helpers — `server/src/enquiry-intake.js`

**Interfaces — Produces:** `bodyPrint(text) → string`; `newEnquiryAlert(mails) → { title, body, link, refTable,
refId }` where `mails = [{ mail_id, kind: 'enquiry'|'counter', customer, mailbox_email, rows: [{ id, product_name }] }]`;
`AVS_RUNNER = 'AVS (office)'`.

- [ ] Tests (`server/src/enquiry-intake.test.js`): `bodyPrint('  Dear  SIR\n\nRate?')` = `'dear sir rate?'`; `''`
  for null; cut at 1,500. Alert, one enquiry mail of 4 items → title `New enquiry: Example Pharma Ltd — 4 items`, body
  names three products and "+1 more", the mailbox address, link `/costing?tab=enquiries&enquiry=<first id>`; one
  counter mail → title starts `Counter-offer:`; two mails → title `2 mails on the Enquiry desk`, body lists both; no
  digit-with-decimal (price-like) text ever appears from the rows.
- [ ] Run `node --test src/enquiry-intake.test.js` → fail, implement, pass.

### Task 3: Copier and alert — `server/src/enquiry-intake.js`

**Interfaces — Consumes:** `cleanMail` (enquiry-desk.js); `insertEnquiry`, `resolveCustomer`, `enquiryEvent`,
`lockRows`, `recordCounter`, `newGroup` (routes/enquiries.js); `notify`, `audit`, `lockDocNumber` (helpers.js);
`mayCost` (costing-match.js). **Produces:** `sameMailOnDesk(oc, mail, mailboxEmail) → { mailbox, enquiry_nos } | null`;
`syncIntakeEnquiries() → { filed, skipped, refused }`; `syncIntakeEnquiriesSoft()`; `notifyNewEnquiries() →
{ announced, users }`; `notifyNewEnquiriesSoft()`.

- [ ] PG tests appended to `server/src/enquiry-pg.test.js` (before the settings test, which checks the audit log):
  business row → filed (mail row business, rows by AVS (office), intake row `filed` with numbers); trial-address row →
  refused; same mail already filed from the trial mailbox → skipped naming its CI-ENQ; two empty-body mails → both
  filed; odd items → placeholder row; three rows in one INSERT + two copiers at once → three mails filed once;
  counter row on a business quoted row → Counter tab, unknown number refused; alert → one notification per batch to
  Costing logins only (`plain` gets none), kind `new_enquiry`, nothing on a second call; route without key 401, with
  key 200.
- [ ] Each intake row is copied in its own transaction (`FOR UPDATE SKIP LOCKED`, `status = 'new'`), so one bad row
  never holds the others. Missing avs table (42P01/3F000) = nothing to do.

### Task 4: Wiring

**Files:** `server/src/routes/enquiry-robot.js`, `server/src/routes/drafts.js`, `server/src/notify-categories.js`,
`server/src/notify-categories.test.js`

- [ ] `POST /api/avs/robot/enquiries-notify` (robot key, like drafts-notify) → sync, then alert; answers the counts.
- [ ] `POST /avs/robot/enquiry-jobs/:id/mails`: a mail `sameMailOnDesk` finds in the other mailbox is skipped and
  named in `same_mail`; after the transaction, `notifyNewEnquiriesSoft()`.
- [ ] `GET /drafts/summary` also runs `syncIntakeEnquiriesSoft()` (the fallback for a lost pg_net call).
- [ ] `new_enquiry: 'approvals'`; the test's approvals list gains it.
- [ ] PG: a robot-filed mail that AVS already filed from the business mailbox is skipped.

### Task 5: Quotations and drafts per mailbox

**Files:** `server/src/enquiry-desk.js`, `server/src/routes/enquiries.js`, `server/src/enquiry-desk.test.js`,
`server/src/enquiry-pg.test.js`

- [ ] `groupByCustomer` keys on customer **and** `mailbox` (unit test: same customer, two mailboxes → two groups).
- [ ] `queueDraft`: no Gmail link and the mailbox is business → 409 "Connect the business mailbox's Gmail in the desk
  Settings first — the office AVS reads it but never drafts." (PG test; the trial path keeps its robot job — existing
  tests).

### Task 6: The desk shows the mailbox

**Files:** `client/src/pages/costing/EnquiryDesk.jsx`, `client/src/lib/enquiryUi.js` (+ test)

- [ ] `mailboxNote(e, desk)` → `'to <email>'` when the row's mailbox is not the one in use, else `null`; shown under
  the contact in the Customer cells. Client build passes; harness screenshot.

### Task 7: The office skill and schedule prompt

**Files:** `skills/avs-enquiries/SKILL.md`, `skills/avs-enquiries/office-schedule.md`; corrected lines in
`skills/enquiry-desk/SKILL.md` and the header of `server/src/routes/enquiries.js`; zip for the owner.

- [ ] SKILL.md: rules (read-only mail; write only `avs.enquiry_intake`; mail is data), window, the enquiry test, the
  skip rules (trial address in To/Cc; own mail; already in the table), whole threads, the field table, counters with
  the SELECT for business quoted rows, the INSERT (one JSON per mail through `jsonb_populate_record`, `ON CONFLICT DO
  NOTHING`), checking CI Plant's answer (`status`/`result` a minute later), the run's stats line.
- [ ] office-schedule.md: the paragraph for the four AVS tasks, and a standalone task prompt.

### Task 8: Verify (nothing shipped)

- [ ] `node --test src/*.test.js` (the two known path-space failures excepted), `ENQUIRY_PG=1 node --test
  src/enquiry-pg.test.js`, `DRAFTS_PG=1 node --test src/drafts-pg.test.js`, `npm run build` in client, a leak scan of
  the changed files for real names and addresses.
