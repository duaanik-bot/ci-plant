# Enquiry Fetch buttons, highlights and repeats — implementation plan

> Native execution in the session. **No commit steps** (CLAUDE.md): nothing is committed, pushed or applied to
> production without the owner's OK in the session.

**Goal:** mppchd as the desk's mailbox with on-demand Fetch for each mailbox, new enquiries highlighted, repeat
requests marked on the existing row, Costing landing on the desk.

**Spec:** `docs/superpowers/specs/2026-11-14-enquiry-fetch-buttons-design.md`

## Global constraints

- Open = enquiries.status NOT IN ('dropped', 'ordered'); repeat window 90 days on COALESCE(updated_at, created_at).
- Business fetch jobs: `fire_status = 'office'`, never the cloud routine (that routine reads the trial mailbox).
- Public waiting answer is `{ waiting: boolean }` only.
- Alert kind stays `new_enquiry`; recipients = mayCost logins.

## Review focus

1. A repeat must not swallow a genuinely new quantity — Task 1 tests.
2. A mail that is all repeats keeps its mail row and still alerts once ("Asked again") — Task 4 PG test.
3. The timer must not queue a trial fetch when mppchd is in use, nor fire the trial routine for a business job — Task 3.
4. A business fetch taken by the office is closed only by its finish call; a stale take (>1 h) can be taken again — Task 2.
5. Logins without Costing never see the badge (no 403 storm) — Task 5.

### Task 1 — pure rules (`server/src/enquiry-desk.js`, `server/src/enquiry-intake.js`)
- `productKey(name)`, `isRepeat(existing, item)`; `newEnquiryAlert` learns kind `again`. Unit tests first.

### Task 2 — schema
- `20261114120000_enquiry_asked_again.sql` (public, replayed): `enquiries.asked_again_at`, `asked_again_count`,
  `asked_again_mail_id`.
- `20261114120100_avs_enquiry_fetch.sql` (production-only): `avs.take_enquiry_fetch()`, `avs.finish_enquiry_fetch(id,
  result)`; the mailbox in use switched to business.

### Task 3 — server
- `startFetch({ mailbox })`; business → fire_status `office`, no cloud fire; timer skips while business is in use.
- `POST /costing/enquiry-desk/fetch { mailbox }`; `GET /enquiry-desk/waiting?mailbox=`; `GET /costing/enquiry-desk/summary`.
- `askedAgain()` used by the robot `/mails` route and the AVS copier; `notifyNewEnquiries` builds `again` mails.

### Task 4 — PG tests (`server/src/enquiry-pg.test.js`)
- Fetch per mailbox, waiting answer, take/finish, timer skip, repeat marking + alert, summary counts and 403.

### Task 5 — client
- Costing default tab `enquiries` (+ badge on its tab); desk bar buttons; JobLine words for `office`; orange Inbox rows +
  "New" tag + "Asked again" chip; side-menu badge for `/costing`.

### Task 6 — office kit
- `skills/avs-enquiries/SKILL.md` v2 (no dua.anik skip; take/finish a waiting Fetch), `skills/avs-enquiries/office/`
  watcher script + LaunchAgent + run prompt; one setup message for the office Claude. Mac watcher: back off when the
  command-line Claude is not signed in.

### Task 7 — verify
- Unit suite, `ENQUIRY_PG=1`, `DRAFTS_PG=1`, client build, harness screenshot; leak scan.
