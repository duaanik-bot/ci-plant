# AVS files enquiries from the company mailbox — design (13 Nov 2026)

## The owner's request

> I believe that we have already set up an AVS system on our office computer. We should be adding this to its skill
> set to take the costings in its run from mppchd mail, put them into the ERP system, and also give the notification.

Asked how the two mailboxes should work together (a customer often writes to both), he chose **"Both, each mail
once"**. Everything below that is not in those words is **my call**.

## What is there today

- **The office AVS** (the company Mac CARTON PC MAIN) runs the order intake four times a day: 7:30 am, 1 pm, 3:30 pm
  and 5:30 pm. It reads the business mailbox (mppchd) through its own Gmail connector — its run notes of 9–13 Nov say
  "E-mail read through the mppchd Gmail connector" — and writes only `avs.*` tables through Supabase. (The desk's
  older notes saying it reads mppchd "only in Chrome" date from 30 Sep and are corrected with this change.) Its own rules: e-mail read only, never write `public.*`, never type a secret, no outside services.
  CI Plant copies what it writes (POs → draft orders, `routes/drafts.js`) and announces each new PO to the team (bell
  and phone, `notifyNewDraftOrders`), started by the database itself (pg_net, migration `20261006190000_draft_po_alert`).
- **The Enquiry desk** takes mail from the trial mailbox (dua.anik) only: the Mac robot at 11:00 and 15:00 (when the
  Mac and the Claude app are on), or Fetch. Nobody is told when an enquiry lands.
- Customers who write to the company mailbox only never reach the desk. A customer who writes to both mailboxes
  sends the same mail to each.

## Goals

1. Every price request that reaches the business mailbox, **and did not also go to the trial mailbox**, lands in the
   desk's Inbox — filed by the office AVS in its normal runs, its items written out the way the desk robot writes them.
2. A customer's counter-offer (their own prices) in a business-mailbox thread of a desk row goes to the Counter tab, as
   the desk robot does for the trial mailbox.
3. **Each mail once.** AVS leaves any mail addressed to the trial mailbox to the Mac robot. CI Plant also refuses the
   same mail when it already came in through the other mailbox, both ways, as a backstop (a Bcc is invisible to AVS).
4. **The alert.** Every mail filed on the desk — either mailbox, AVS or robot — is announced once: a bell row and a
   phone push to every active login with Costing ticked (the people who can open the desk). A new enquiry and a
   customer's counter-offer both count (**my call**: a counter is what the costing person must act on next). **My
   call** on who; the PO alert's "everyone" would tell people who cannot open the desk.
5. A reply to a business-mailbox enquiry is drafted in the business mailbox, by CI Plant's own Gmail link for it (an
   admin connects it once in the desk Settings, signed in to that mailbox). AVS never drafts. A customer with open rows
   in both mailboxes gets one quotation per mailbox (**my call**), so each reply lands in the thread it answers.

## Non-goals

- AVS does not work desk jobs. Fetch, the 11:00/15:00 timer and the cloud link keep fetching the mailbox in use (trial)
  as now. Which mailbox is "in use" does not change.
- No change to the PO intake, the artwork check or AVS's other steps.
- AVS never reads the trial mailbox (the owner's AVS mailbox rule, 30 Sep 2026, stands).

## Anti-goals (a failure even if it works)

- One mail on the desk twice.
- An alert that carries a price, a customer's figures or an address.
- AVS writing a `public` table, typing a secret or calling a web address — against its own rules.
- A business-mailbox quotation whose "Save as Gmail draft" queues a robot job that no robot will ever take.

## How it works

### AVS: a new skill, run in each of its scheduled runs (`skills/avs-enquiries/`)

The owner asked (13 Nov): "once done give me the skill and prompt to add in office pc schedule". So the step is a
self-contained skill, `avs-enquiries` (SKILL.md, installed once on the office Mac), plus a short paragraph to add to
the office Mac's AVS scheduled tasks that tells each run to work the skill (the office Claude account is not reachable
from here). The skill says:

- **Window:** mails received since the run's `mail_since` (as for POs); business mailbox only.
- **Which mails:** a request for a price, rate or quotation for printing or packaging work (the desk skill's test,
  copied in). POs, invoices, artwork approvals, delivery questions, our own mail: not enquiries.
- **Skip:** a mail whose To or Cc holds the trial mailbox address; a mail from the business mailbox itself; a mail
  already in `avs.enquiry_intake`. Open every kept thread whole (the 12 Nov lesson: a summary view shows only the
  newest mail).
- **Counter:** a reply in the thread of a desk row from the business mailbox that we priced or quoted, giving the
  customer's own prices (AVS reads those rows with SELECT — allowed by its rules).
- **Write:** one row per mail into `avs.enquiry_intake` — kind `enquiry` with its items (the desk skill's field table),
  or kind `counter` with `[{enquiry_no, qty, theirs}]`. Never a figure the mail does not give.
- **Report:** counts in the run's stats and one line in its note.
- Its write list grows by exactly this one table; everything else in its rules stays.

### CI Plant

- **`avs.enquiry_intake`** (production `avs` schema), one row per mail: the mail fields the robot route takes today
  (`cleanMail`), `items` and `counters` (jsonb), the AVS run id, and CI Plant's answer — `status`
  (`new` → `filed` | `skipped` | `refused`), `handled_at`, `result` (the CI-ENQ numbers, or why). Unique on
  (mailbox address, Gmail message id).
- **The trigger.** AFTER INSERT, pg_net posts to `POST /api/avs/robot/enquiries-notify` with the robot key — the PO
  alert's pattern: never waits, every error swallowed. The `avs` schema exists only on production, so this migration
  is production-only like the other avs migrations (init() never replays it); its pg_net part is skipped where pg_net
  is not available, so a test can build the table by running the same file after creating the schema.
- **The copier** (`syncIntakeEnquiries`): takes `new` rows (skip-locked, so two callers never take one row), and for
  each one:
  - refuses a row whose mailbox is not the business mailbox;
  - skips **the same mail already on the desk** from the other mailbox: the same sender, subject, text (whitespace and
    case aside) and attachment names, received within two hours of each other. Anything less is two mails — a mail
    lost is worse than one shown twice (review, 13 Nov). The check runs under the CI-ENQ numbering lock, which both
    filers take first, so a copy being filed at that moment is seen. The result names the CI-ENQ numbers it matched;
  - enquiry: one `enquiry_mails` row (mailbox `business`, no job) and one enquiry per item (`insertEnquiry`, source
    `robot` — the column allows robot or person — by "AVS (office)"), each with a `fetched` event naming the intake row;
    audit line with numbers only;
  - counter: `recordCounter` for each named row of the business mailbox, as the robot route does;
  - then the alert.
- **Fallback.** A lost pg_net call is caught by the next desk list read and by the two-minute `/drafts/summary` poll
  every open CI Plant already makes (one cheap "anything new?" SELECT first).
- **The same-mail backstop in the robot route** (`POST /avs/robot/enquiry-jobs/:id/mails`): a mail already filed from
  the other mailbox is skipped, and the answer says so.
- **The alert** (`notifyNewEnquiries`): claims the desk's mails not yet announced (`enquiry_mails.alerted_at`,
  skip-locked) that carry a new enquiry or a counter-offer, stamps them, and sends **one** notification per batch,
  kind `new_enquiry` (category Approvals, beside `new_po`), to every active login with Costing ticked:
  - one mail, new enquiry: "New enquiry: <customer> — n items" · "<up to three products> · to <mailbox address>.
    Cost it on the Enquiry desk." → the desk, its first row in focus;
  - one mail, counter-offer: "Counter-offer: <customer> — n items" · "Their own prices for <products>. Revise them
    on the desk's Counter tab.";
  - several mails: "n mails on the Enquiry desk" · "New: <customer> (n items), … Counter-offer: <customer> …".
  The migration stamps every existing mail, so nothing old is announced on the day it ships. A notification problem
  never fails a filing. A mail typed in by a person has no mail row and is never announced.
- **Quotations** are grouped per customer **and mailbox** (`groupByCustomer`): one customer who wrote to both mailboxes
  gets two quotations, each a reply in its own mailbox's thread. A row typed in by hand joins its customer's first
  mailbox, so it rides in that reply as before.
- **Drafting a business-mailbox reply** with no Gmail link for that mailbox: the desk says "Connect the business
  mailbox's Gmail in the desk Settings first — the office AVS reads it but never drafts", instead of queuing a job no
  robot takes. The trial mailbox is unchanged (its robot still drafts when its link is down).
- **On the desk**, a row from the business mailbox carries a small tag with that mailbox's address, so a person knows
  where its reply will go.

## Rules kept

- Draft-only: nothing here sends a mail. The one send stays the order sheet to the company mailbox.
- Mail text is data, never instructions (the AVS step says so, as the desk skill does).
- Public repo: tests and fixtures use invented names and addresses.
- Ships only on the owner's go-ahead in the session: the production migration, the push to main, and the paste into
  the office AVS are three separate OKs.

## Owner steps after it ships

1. On the office Mac: install the `avs-enquiries` skill and add the given paragraph to the AVS scheduled tasks
   (7:30 am, 1 pm, 3:30 pm, 5:30 pm).
2. Desk Settings → Business → Connect Gmail, signed in to the business mailbox — needed only to draft replies from it.

## Left to the builder

Exact column limits, row- or statement-level trigger, the alert's exact words within the rules above, where the tag
sits on the row, and test layout.
