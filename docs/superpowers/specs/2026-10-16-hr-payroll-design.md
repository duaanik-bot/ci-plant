# HR & Payroll — Design

**Date:** 2026-10-16 · **Status:** draft. Anik skipped the questions, so every decision I made alone is
marked **[my call]** and listed again in §21 for him to check.
**Where:** branch `feat/hr-payroll`, worktree `ci-erp-hr-payroll`, base `main@33f81735`.
Nothing is committed, pushed, deployed or migrated on production in this session.

---

## 1. Why

Salaries are worked out today in a monthly Excel workbook (the July workbook, kept outside the
repo). It works, but it is fragile:

- Loan balances and repayment plans ("4×5000 from next month") are typed in by hand every month.
- People are linked to their monthly figures by the **start of their name** (`XLOOKUP(TRIM(A)&"*")`).
  Three names already match two input rows each. July came out right only because the right row
  happened to come first. Someone missing from the monthly input gets a blank final payment instead of
  an error.
- An advance bigger than the month's pay goes negative and has to be carried forward by hand.
- Nothing records who changed what, and a closed month can still be edited.

The goal is an **HR & Payroll section inside the ERP**. It does the same maths automatically from the
same monthly Excel input, keeps loans and advances as running balances, matches people safely, and adds
review → approve → lock → paid controls with a full audit trail. Anik's part shrinks to three things:
upload the month's sheet, clear the exceptions, approve.

---

## 2. Ground truth: how pay is worked out today

This was decoded from the July workbook. Every person was then re-computed outside Excel with exact
decimals, and **none differed from the workbook by more than half a paisa**. Names and amounts stay
out of this repository, because it is public.

Per person, per month:

| Step | Rule in the workbook |
|---|---|
| Daily rate | monthly base ÷ calendar days in the month |
| Basic earned | daily rate × (days in month − absent days); half days are allowed (2.5) |
| Overtime | OT hours ÷ OT-hours-per-day × daily rate. OT-hours-per-day is 6 or 8 per person; 0 means no OT. There is no multiplier. |
| Holiday pay | base ÷ 30.5 × 1.5 for most who get it; base ÷ 30.5 for a few; a typed amount for others |
| Misc | an **earning**, added (from the monthly input) |
| Gross ("TOTAL SAL") | basic + OT + holiday + misc |
| Deductions | the month's advances, recovered in full, plus the loan instalment |
| Final payment | gross − deductions − an amount paid separately (the column headed "Anik") |
| Negative final | "treat as advance", by hand |
| Contractors (2) | paid their bill amount instead of basic |

- **Monthly input** (the "New data" sheet) holds name, code, firm, department, pay channel, OT hours,
  absent days, misc, advance, bill amount and remarks. Headers carry stray non-breaking spaces.
- **Other facts:**
  - One firm, about 50 people, 12 departments.
  - Four pay channels: a company bank allocation, two other bank allocations, and cash.
  - Increments are kept as base-year columns.
  - The bank-details sheet uses a second code series.
  - ESI flags are kept per person, but nothing statutory (PF, ESI, PT, TDS) is deducted.

**Acceptance test (the bar for Phase 1):** load the July workbook into the system and run July. Every
person's gross and final payment must come out within half a paisa of the workbook's own figures. The
test reads the workbook from outside the repo (env `HR_JULY_XLSX`) and is skipped when it isn't there.

---

## 3. Goals, non-goals, anti-goals

**Phase 1 goals (built now)**

1. People master for everyone on payroll (staff, operators, contractors, cash-paid). It links to the
   ERP's operator list without changing it.
2. Pay setup per person, dated so a revision only applies from its month onwards. It holds pay basis,
   base, absence basis, OT hours-per-day and multiplier, holiday rule and pay channel. This replaces
   the base-year columns with real revision history.
3. Monthly Excel upload in Anik's existing format, with a column mapping the system remembers.
   - People are matched by code, then exact name, then names Anik has approved once.
   - Nothing is processed on an uncertain match.
4. A calculation engine that reproduces the workbook (§2) and shows the formula, rate and quantity
   behind every rupee.
5. Advances as a running balance: given, recovered, carried.
6. Loans as accounts with instalments that recover automatically. Balances move only when a month is
   locked.
7. Monthly run lifecycle: Draft → Submitted → Approved → Finalised (locked), then Paid per person and
   per channel. Corrections after locking go in as next month's adjustments.
8. Outputs:
   - payslips, laid out like Anik's current slip, single and bulk;
   - payroll register;
   - payment sheet per channel, laid out like his current payment report;
   - bank transfer lists;
   - loan and advance statements;
   - month-on-month variance explained line by line;
   - import error report.

   Each one exports to PDF and Excel through the existing export engine.
9. An HR dashboard with live figures, a private access wall and an append-only audit log.

**Non-goals for Phase 1 (scheduled, §19):**
- statutory deductions (PF, ESI, PT, LWF, TDS);
- daily attendance records and leave balances;
- daily OT entries with approvals;
- interest-bearing loans;
- HR journal and accounting export;
- posting to Accounts;
- employee documents;
- exit settlement;
- bank-specific transfer file formats;
- self-service.

**Anti-goals** (would count as failure even if everything "works"):
- Any change to production, inventory, procurement, dispatch, costing or Accounts behaviour.
- Cleaners, guards or drivers turning up in production operator pickers.
- Salary, bank or loan data reachable by plant logins, floor tablets, `/timeline`, phone lock-screen
  notifications or browser caches.
- A locked month that can change silently.
- A balance that moves because a preview was generated.
- The same advance, loan instalment or file counted twice.
- A full loan balance deducted without anyone asking for it.
- Real names, salaries or bank numbers committed to this public repo.

---

## 4. Constraints found in the existing ERP (verified in code, main@33f81735)

| Fact | Consequence for HR |
|---|---|
| `GET /employees` returns every column to every login, floor tablets included (`routes/masters.js:177`) | Pay, bank and ID data can never live on `employees`. HR keeps its own tables. |
| `audit_log` is shown to everyone through `/timeline` | HR writes its own append-only log, never `audit_log`. |
| Server checks roles on writes only. Module ticks don't hide reads, and every office login (MD, Planning, Plant, Accounts) is an admin with unrestricted modules. | HR needs its own access table and a server guard on every `/api/hr` route, read fresh from the DB (the `xs_approver` / `is_management` pattern). |
| `approval_requests` is planning-only (kind CHECK, `order_line_id NOT NULL`) | The payroll run carries its own approval states. |
| Accounts has no chart of accounts and no journal. The Cash & Bank Book is a read-time UNION of `payments` and `vendor_payments` with no extension point. Its delete picks the vendor route by direction alone. Every login can read it. | Posting into Accounts is a separate, later change (Phase 3, needs Anik's OK). Only monthly totals per channel go there, never per-person pay. |
| `pg` turns NUMERIC into a JS float (`db.js:16`); money columns elsewhere are DOUBLE PRECISION | HR stores NUMERIC(12,2) and the engine computes in exact rational paise, not floats. |
| Vercel limits: 4.5 MB request body, 100 KB JSON body, 30 s per call, a one-client pool | Uploads capped at 4 MB. Parsed import rows stay server-side and only decisions are posted back. Inside `tx`, everything goes through `qc`/`oc`. |
| exceljs hangs when reading in the browser | Excel files are parsed on the server only. |
| Schema ships as `supabase/migrations/<ts>_<name>.sql`, replayed by a line at the end of `init()`, applied to prod by hand | One HR migration file plus one replay line. Prod migration is not part of this session. |
| Repo-wide guard tests: `MINTING_POSTS`, plant dates, optional text, notify categories, app imports | HR routes comply: `plantDateStr`, `optionalText`, minting POSTs listed, new notification kinds registered. |
| Dev seed runs `TRUNCATE … CASCADE` on plant tables | HR has no foreign keys into public tables, so the seed can never wipe HR. |
| The GitHub repo is public | Fixtures are synthetic. Real-data checks read files from outside the repo. |
| `main` already has 2 failing tests (`section-lean-rows.test.js`: `%20` in a path with spaces) | Pre-existing, not ours. HR tests build paths with `fileURLToPath`. |

---

## 5. Architecture

- **A separate Postgres schema, `hr`.** Every HR table lives there. It has soft links (ids checked in
  code) to `public.users` and `public.employees`, but **no foreign keys into public tables**. Nothing in
  HR can then block, slow or cascade from plant data. **[my call]**
- **Server.** Pure logic sits in `server/src/hr/`:
  - `money.js`, `engine.js`, `match.js`, `import-parse.js`, `loans.js`, `workbook-loader.js` (pure);
  - `access.js`, `audit.js`, `ledger.js` (DB).

  Routes are in `server/src/routes/hr.js`, all under `/api/hr/*`. One path-scoped guard runs first, and
  every GET is marked uncacheable (the AVS pattern).
- **Client.** One lazy page, `/hr`, with tabs (the Fluence `?tab=` + GroupedTabs pattern):
  - Overview, Payroll, People, Loans & Advances, Reports, Settings.
  - A print page at `/hr/payslips/:month`.
  - Shared UI: DataTable, Modal, Field, Toast and the exporter.
- **Every shared file touched, and why** (no other file changes):

| File | Change | Why it can't be avoided |
|---|---|---|
| `server/src/app.js` | import and mount the HR router | every route file is mounted here |
| `server/src/db.js` | one `migration('<ts>_hr_payroll.sql')` line at the end of `init()` | how local DBs get schema |
| `supabase/migrations/<ts>_hr_payroll.sql` | new file | the schema itself |
| `client/src/App.jsx` | two lazy routes | how pages are registered |
| `client/src/components/AppLayout.jsx` | one "HR & Payroll" nav item, shown only when `/api/hr/me` grants access | how sections appear |
| `client/src/lib/writeOnce.js` | add `/hr/loans` to `MINTING_POSTS` | a repo test requires every number-minting POST listed |
| `server/src/notify-categories.js` (+ `notificationLink.js`) | map the two HR notification kinds | a repo test fails on unmapped kinds |

There is **no** new module key in `modules.js`. Module ticks can't hide anything from admins, so a key
would only suggest a protection that isn't there. The real gate is HR access. **[my call]**

---

## 6. Access and privacy

- **`hr.access`** (user_id, level, granted_by, granted_at, note). Levels, each including the ones
  before it:

  | Level | Can do |
  |---|---|
  | viewer | read registers, payslips, reports |
  | operator | people, pay setups, imports, draft runs, submit, mark paid |
  | approver | approve, send back, finalise, reverse a payment |
  | admin | settings, access grants, workbook loader |

- **Bootstrap.** The migration grants `admin` to the login `md@motionci.com` if it exists. Anik then
  grants others from Settings → Access. The shared `Plant` login gets nothing by default. **[my call]**
- **The guard.** A middleware on the `/hr` path reads `hr.access` fresh on every request (never from the
  JWT) and answers 403 when there's no row. Each route states its minimum level.
- **Separation of duties.** Approving a run you submitted yourself shows a warning but is allowed by
  default, because the team is small. A setting makes it strict. **[my call]**
- **Bank numbers.** Lists show only the last 4 digits. The full number appears only in person detail
  (operator and above) and in the bank transfer export.
- **Notifications** carry no amounts; push shows the title on phone lock screens. Payslips, exports and
  print pages all need HR access.

---

## 7. Data model (schema `hr`, money = NUMERIC(12,2), quantities = NUMERIC(14,4))

| Table | Purpose / key columns | Integrity |
|---|---|---|
| `settings` | key → JSONB value: rounding, caps, OT threshold, holiday divisor default, deduction-warning %, strict separation, blank-as-zero defaults | key PK |
| `pay_channels` | code, label, kind (bank/cash), bank name, account (masked in lists), active | code PK; created by the loader or in Settings, **not seeded** (business data stays out of the public repo) |
| `people` | code (payroll code, TEXT), name, display_name, father_name, firm, department, designation, worker_type (employee/contractor), status (active/on_leave/exited), joined_on, exited_on, phone, address, emergency_contact, pay_channel, bank holder/name/account/IFSC, esi_applicable, esi_no, pf_uan, pan, employee_id (soft link to the ERP operator), legacy (JSONB: the workbook's C STAT, HP, second code), notes | code unique; `employee_id` unique when set |
| `person_aliases` | person_id, alias_norm, source, approved_by/at | alias_norm unique |
| `pay_setups` | person_id, effective_from (1st of month), pay_basis (monthly/daily/hourly/contract), base, absence_basis (calendar_days/fixed_divisor), absence_divisor, ot_hours_per_day, ot_multiplier, ot_fixed_rate, holiday_mode (none/formula/fixed), holiday_divisor, holiday_multiplier, holiday_fixed, note | (person_id, effective_from) unique; never updated after a run has used it, only superseded |
| `import_batches` | month, file_name, file_sha256, sheet, header_row, column_map, status (parsed/applied/superseded/discarded), counts, uploaded_by/at, applied_by/at | (month, sha256) unique while not discarded, so the same file twice is caught |
| `import_rows` | batch_id, row_no, raw JSONB, parsed fields, match (code/exact_name/alias/manual/unmatched/ambiguous/conflict), person_id, issues JSONB, decision (include/ignore), decided_by | (batch_id, row_no) unique |
| `column_maps` | header signature → field map + blank-as-zero flags | signature unique |
| `runs` | month (1st of month), status (draft/submitted/approved/finalised), days_in_month, engine_version, policy snapshot, prepared/submitted/approved/finalised by+at, sent_back_reason, totals | month unique |
| `run_inputs` | run_id, person_id, ot_hours, absent_days, paid_leave_days, hours_worked, misc_earning, misc_deduction, bonus, bill_amount, holiday_override, paid_separately (+note), advance_given, advance_mode (total/extra, §9 item 7), advance_recovery_override, loan_recovery_override, include (bool), remarks, source (import/manual), source_row_id | (run_id, person_id) unique |
| `run_lines` | run_id, person_id, pay_setup_id, inputs_hash, days, present_days, daily_rate, every component amount, gross, deductions, net_before_cap (can be negative, matches the workbook's "Final"), recoveries after the cap, payable, rounding, carried_advance, flags JSONB, breakdown JSONB (code/label/kind/qty/rate/formula/amount), pay_channel snapshot, payment_status, paid_amount/at/ref | (run_id, person_id) unique |
| `advance_txns` | person_id, txn_date, kind (opening/given/recovered/waived/adjustment), amount (>0), run_id, source, note, created_by/at, reverses_id | (run_id, person_id, kind) unique where run_id set, so a run can't post twice |
| `loans` | loan_no (`CI-LN-0001`), person_id, principal, issued_on, purpose, interest_rate (0 in Phase 1), instalment, first_due_month, status (active/closed/cancelled), is_opening, approved_by/at, note | loan_no unique |
| `loan_txns` | loan_id, txn_date, kind (disbursed/opening/payroll_recovery/prepayment/adjustment/waiver), principal_amount, interest_amount, run_id, note, created_by/at | (loan_id, run_id) unique for payroll_recovery |
| `loan_holidays` | loan_id, month (skip that month) | (loan_id, month) unique |
| `adjustments` | person_id, kind (earning/deduction), category, amount, description, reference, recurrence (one_time/recurring), start_month, end_month (required when recurring), status (pending/approved/cancelled), approved_by/at, created_by/at | recurring needs both ends; one-time never repeats |
| `payment_batches` | run_id, pay_channel, count, total, status (prepared/confirmed), reference (UTR/cheque), confirmed_by/at | |
| `audit_log` | at, user_id, user_name, entity, entity_id, action, detail JSONB | trigger rejects UPDATE and DELETE |

- **Balances are never stored.** Advance balance and loan outstanding are always sums over their
  ledgers.
- **Inputs and results are separate.** Source inputs (`run_inputs`, `import_rows`) never share a row
  with calculated results (`run_lines`). Each result records the engine version and setup it used, so a
  locked month can be re-explained exactly.

---

## 8. The calculation engine (`server/src/hr/engine.js`, pure)

`computeLine({ month, daysInMonth, setup, inputs, balances, adjustments, policy })` → a result with
components, totals, flags, and the exact (unrounded) gross and final for verification.

**Exact arithmetic.** `money.js` holds BigInt rationals. Amounts parse to exact paise and quantities to
exact hundredths. Each component is computed exactly, then rounded half-up to paise. Gross is the sum of
the rounded components. Floats are never used for money.

**Earnings, in order**

1. `daysNotEmployed` covers dates before `joined_on` or after `exited_on`. These are added to unpaid
   days and flagged. **[my call]**
2. **Monthly:**
   - `divisor` = days in month (calendar basis) or `absence_divisor` (fixed basis);
   - `daily = base / divisor`;
   - `basic = base − daily × (absent_days + daysNotEmployed)`, floored at 0.

   On calendar basis this equals the workbook's daily rate × present days.
3. **Daily:** `basic = rate × present_days`, where present = days − absent. **Hourly:**
   `basic = rate × hours_worked` (an input). **Contract:** `basic = bill_amount` (a required input).
4. **OT:** `rate = ot_fixed_rate`, else `daily / ot_hours_per_day × ot_multiplier`; `OT = hours × rate`.
   - OT hours against an OT-hours-per-day of 0 pays 0, with a warning (the workbook gives 0 too).
   - More than the high threshold (default 150 h/month) is a warning.
5. **Holiday:** `formula` → `base / holiday_divisor × holiday_multiplier`; `fixed` → the amount;
   `none` → 0. A monthly `holiday_override` input wins when present.
6. **Misc earning, bonus, approved earning adjustments.**
7. **Gross** = sum of the above.

**Deductions and the cap**

- `other` = misc deduction input + approved deduction adjustments.
- `loan` = each active loan's due amount, `min(instalment, outstanding)`, skipping holiday months.
  A `loan_recovery_override` replaces the total, never adds to it, oldest loan first, and can't exceed
  what's outstanding.
- `advance` = the whole advance balance: posted balance + this month's `advance_given`. An
  `advance_recovery_override` can take less, never more.
- `net_before_cap = gross − other − loan − advance − paid_separately` is the workbook's "Final
  Payment", and can be negative.
- **Cap [my call]:** when negative, reduce the advance recovery first, then loans (newest first), then
  other deductions, until net is 0. Whatever isn't recovered **stays in its balance**. This gives the
  same economics as the workbook's "treat as advance": the loan instalment is still recovered and the
  shortfall stays owed as advance. The difference is that it now happens automatically and shows on the
  person's statement.
- `payable = net − paid_separately`, rounded to the nearest rupee by default, with a visible rounding
  line. The setting `rounding = paise` turns rounding off. **[my call]**

**Flags** (warnings and info; each warns, none refuses):
- no pay setup — this one blocks submit;
- insufficient pay — with amounts left in balances;
- loans plus other deductions above 50% of gross — the advance, being earned wages already paid, is
  excluded; "check with your CA", **[my call]**;
- high OT;
- OT with no OT rate;
- absent days above days in month — this one blocks;
- missing bank details on a bank channel;
- change of more than 25% against last month (with explanation);
- joined or left mid-month;
- paid separately above net.

**Breakdown.** Every component carries `{code, label, kind, qty, rate, formula, amount}`, for example
`₹20,150 ÷ 31 days × 1 absent day`, and is stored on the line. The UI and the payslip show it as is.

---

## 9. Monthly Excel import

**Flow:** upload → parse → map columns → match people → review → apply to the month's draft run →
recalculate.

1. **Upload.**
   - `POST /api/hr/imports`: multipart, 4 MB cap, xlsx magic-bytes check, parsed with exceljs on the
     server.
   - Formulas are read as their cached result, and non-breaking spaces are normalised.
   - The same file (sha256) already uploaded for the month → "already uploaded on …, reopen it?"
2. **Map columns.**
   - The header row is found automatically: the first row with three or more known headers.
   - Synonyms:

     | Field | Headers recognised |
     |---|---|
     | name | PERSON / NAME / EMPLOYEE NAME |
     | code | CODE NO / EMPLOYEE ID / EMP CODE |
     | OT | OT / OT HOURS / OVERTIME |
     | absent days | AB / ABSENT / ABSENCE DAYS |
     | misc | MISC / MISCELLANEOUS |
     | advance | ADVANCE / ADV / ADVANCE TAKEN |
     | bill amount | BILL AMOUNT |
     | remarks | REMARKS |

   - Optional fields: paid leave, bonus, misc deduction, holiday, loan repayment, advance recovery,
     paid separately.
   - Read for cross-checking only: department, firm, and pay channel ("CODE 2" / "TRANS MODE").
   - A confirmed map is saved by header signature and applied automatically next month.
   - **Misc maps to an earning by default** (workbook semantics), changeable in the map.
3. **Blank vs zero.** A blank cell is stored as *blank*, never as zero. The saved map carries a
   per-column "blank counts as 0" tick, pre-ticked for OT, absent, misc, advance and bill amount,
   because that is how Anik's sheet behaves. The preview marks those cells. Text in a number column, a
   negative number, or absent days above the month length is an **error**. Absent days that aren't a
   multiple of 0.5 is a warning.
4. **Match, strictly in this order** (`match.js`, pure):
   - **Code** given and found:
     - if the name agrees (exact after normalising, or an approved alias), it's matched;
     - if the name clearly differs, it's a **conflict**: held for review, never auto-assigned.
   - **Code** given but unknown: error.
   - **No code:** an exact normalised name against the master's name or display name. Exactly one hit
     is matched; two or more is **ambiguous**.
   - **Approved alias**: matched.
   - Otherwise **unmatched**. Anik picks the person (optionally saving the spelling as an alias), marks
     the row *ignore* (today's "ignored per instruction"), or creates a new person.
   - Candidates found by prefix or likeness are **suggestions only** and need a click. Nothing is ever
     assigned on a guess.
5. **Duplicates.** Two rows resolving to one person both block until he keeps one or sums them
   explicitly.
6. **People missing from the file.** Active people with a pay setup but no row are listed. Each needs an
   explicit choice: *include with no OT and no absences*, or *leave out this month*. Never a silent zero
   or blank.
7. **Advances already entered in the ERP this month** (in-app, §10). The preview shows both figures. By
   default the Excel figure is taken as the **month's total including them**, so only the difference is
   added. If Excel is lower than what's already recorded, that's a warning. A per-row switch says
   "Excel is extra". This is the "no double deductions" control.
8. **Apply.** One transaction writes `run_inputs` for every included row and recalculates the run.
   - A corrected file for the same month while the run is a draft supersedes the earlier batch. Manual
     edits made since are listed, each to keep or overwrite.
   - Once the run is submitted or finalised, imports for that month are refused with the reason.
9. **Error report.** Every issue exports to Excel.

---

## 10. Advances

- **Ledger:** `opening`, `given`, `recovered`, `waived`, `adjustment`.
  `Balance = opening + given + adjustment − recovered − waived`, over posted rows only.
- **Two doors in:**
  - the monthly sheet's ADVANCE column, which is today's practice;
  - HR → Advances → *Give advance*, for one paid mid-month that should show up straight away.
- **No balance moves on a preview.** The monthly sheet's advances are posted as `given` when the month
  is **finalised**, together with the `recovered` row (the capped amount). Unrecovered advance simply
  stays in the balance.
- Recovery defaults to the full balance, which is today's practice. A partial recovery needs a reason.
- **"Give advance" in the app** posts a `given` row immediately, with date and who.
- The person's statement shows every row with a running balance.

---

## 11. Loans

- **Creating a loan:** person, principal, issue date, purpose, instalment, first due month and how it
  was paid out. It gets a number `CI-LN-0001` (`nextNumber` with its advisory lock) and posts a
  `disbursed` row.
  - Interest is stored but must be 0 in Phase 1. Anik's loans are interest-free. Interest comes in
    Phase 2. **[my call]**
- **What's due each month:** `min(instalment, outstanding)` for every active loan whose first month has
  arrived and which isn't on a repayment holiday that month.
- **The schedule** shows past rows from actual recoveries and future rows projected from the
  outstanding balance. So early repayment, partial recovery and holidays reschedule it automatically,
  and the history stays intact.
- **Changes allowed:**
  - prepayment: a `prepayment` row;
  - repayment holiday: a `loan_holidays` row;
  - instalment change: from a given month, audited;
  - closing: automatic at zero.

  Several active loans per person are allowed.
- **Recovery** is posted only at **finalise**, at most once per loan per run (unique key). A shortfall
  isn't recovered: the schedule simply runs one month longer.
- **Never** deduct more than what's outstanding. Never deduct the full balance unless it's typed as an
  override.

---

## 12. Payroll run lifecycle

| State | Who | What happens |
|---|---|---|
| **Draft** | operator | Import, edit inputs (reason logged), recalculate. Lines recompute on every change. |
| **Submitted** | operator | Blocked while rows are unmatched or undecided, a setup is missing, or a blocking flag remains. Inputs freeze. Approvers get a notification with no amounts. |
| **Sent back** | approver | Back to Draft with a reason; the preparer is notified. |
| **Approved** | approver | Decision recorded (warning if approver = submitter). |
| **Finalised** | approver | One transaction. It locks the run, recomputes against current balances, and refuses if anything moved since approval (asking for re-approval). It then posts advance and loan rows (unique keys stop double posting) and freezes the lines. All or nothing. |
| **Paid** | operator | Per channel, a payment batch with reference and date marks its lines paid. Single lines can be paid, failed or reversed (reversal is approver only). Finalised is never treated as proof of payment. |

- **One run per month.** A finalised run is never edited.
- **Corrections** go into the next month as arrears or recovery adjustments that reference the old run.
  Full reversal of a finalised month is Phase 2. **[my call]**
- **Variance check.** Each line is compared with the person's last finalised month, and the difference
  is split into revision, attendance, OT, holiday, misc, advance, loan and other. Any leftover the split
  can't explain is flagged. This is the "no unexplained salary changes" control.

---

## 13. Outputs (Phase 1)

1. **Payslip.**
   - Print page, single or bulk; bulk can be filtered by channel or department.
   - Mirrors Anik's current slip: company header, employee details, earnings | deductions, gross, total
     deductions, net, loan details (total, instalment, outstanding), advance balance, a note when pay
     was insufficient, amount in words, "Prepared by / Employee signature".
2. **Payroll register**: every component per person, filterable, exportable, grouped by department or
   channel.
3. **Payment sheet**: summary by channel (count, payable, carried as advance) plus detail with
   subtotals, like today's payment report.
4. **Bank transfer list** per bank channel: holder, account, IFSC, amount, reference. Excel.
5. **Loan register and statement; advance register and statement**: per person and in total.
6. **Variance report** (§12) and **import error report** (§9).

All of them use the existing exporter, so they come out as branded PDF and Excel.

---

## 14. Dashboard (HR → Overview)

All figures come from the database, and each links to the rows behind it:
- headcount: active, new this month, exited;
- this month's run status and totals by channel;
- paid against pending;
- loans outstanding (count and total);
- advances outstanding;
- exceptions: unmatched rows, people without a setup, insufficient pay, high OT, missing bank details,
  unexplained variance.

---

## 15. Go-live: loading from the workbook

Settings → **Load from salary workbook** (admin only) reads any month's workbook in the July layout:

- **People:** from FINAL SHEET. Name, code, firm, department, pay channel and legacy fields are read by
  header name, tolerating stray spaces. BANK DETAILS rows are matched by name for bank and ESI fields;
  rows that don't match are listed.
- **Pay setups:**
  - Base, OT hours-per-day and holiday rule come from the HOLIDAY formula or constant.
  - A typed holiday amount loads as a *fixed monthly* amount and is highlighted for review.
  - Contractors are detected from a typed BASIC.
- **Opening balances** as at the workbook's month end:
  - each loan's OS becomes an opening loan with its instalment;
  - each negative final becomes an opening advance.
- **Preview first.** Everything shows before anything is written, and every row can be edited or
  dropped.

**Rollout recommendation.** Run one month in parallel, Excel and ERP side by side. The variance report
shows any difference per person.

---

## 16. Accounting (Phases 2 and 3)

- **Phase 2, inside HR.** At finalise, a balanced journal is generated:
  - Dr salaries & wages;
  - Cr advances recoverable (recovered);
  - Cr employee loans (principal recovered);
  - Cr salary payable.

  When paid: Dr salary payable / Cr the channel's bank or cash. When a loan or advance goes out:
  Dr loans or advances / Cr bank or cash.
  - Account names are configurable.
  - Each journal has a unique source reference and can never post twice.
  - Exports to Excel; a Tally format can follow.
- **Phase 3, touches Accounts, needs Anik's OK.** Monthly totals per channel appear in the Cash & Bank
  Book. That means teaching its UNION, voucher types, labels and delete path first.

---

## 17. Statutory (Phase 2)

- ESI, PF, Punjab PT, LWF and TDS rules, each with effective dates, **off by default**, switched on per
  person.
- Employer contributions are kept separate and never taken from net pay.
- Rates and thresholds are entered, not hard-coded, and **checked by Anik's CA before use**.
- Phase 1 already stores the ESI, UAN and PAN fields, and leaves the engine hook (an empty statutory
  list).

---

## 18. Testing

- **Unit, pure:**
  - money: rational maths, half-up rounding to paise;
  - engine: every basis, OT 6/8/0, multiplier, fixed rate, holiday modes, half days, mid-month
    joining, paid separately, cap order, rounding modes, overrides, each flag;
  - matching: code agrees, code conflicts, unknown code, exact, ambiguous, alias, the prefix-collision
    pattern (a short name plus a longer name that starts with it), no guessing;
  - parsing: header detection with non-breaking spaces, synonyms, formulas as cached values, blank vs
    zero, text in number columns, duplicates, missing people;
  - loan projection: holidays, prepayment, shortfall, closure.
- **DB-backed** (opt-in `HR_PG=1`, own embedded Postgres, `PG_POOL_MAX=1`, the `batch-gang-pg` template):
  - access guard (none → 403 on every route; viewer can't write; approver needed to finalise);
  - preview leaves balances alone;
  - finalise posts loans and advances once;
  - a second finalise is refused;
  - a failure mid-finalise rolls back everything;
  - the same file twice is caught;
  - a superseding import works;
  - imports are refused after submit;
  - payments are separate from finalise.
- **July acceptance** (opt-in `HR_JULY_XLSX=<path>`): workbook loader, then import, then compute. Every
  person within half a paisa on gross and final.
- **Repo gates:** `npm run verify` green except the 2 pre-existing failures; client build.
- **Browser check** on a local copy: the whole month flow, with screenshots.

---

## 19. Phases

| Phase | Contents | Gate |
|---|---|---|
| **1 (now)** | §3 goals 1–9: people, pay setups, import, engine, advances, loans, run lifecycle, outputs, dashboard, access, audit, workbook loader | July acceptance + DB tests + browser check |
| **2** | statutory (off by default), daily attendance and leave, daily OT entries and approvals, interest-bearing loans, HR journal and export, full reversal of a finalised month, employee documents, exit settlement, department cost and statutory reports, bank file formats | per item |
| **3** | monthly per-channel totals into the Accounts Cash & Bank Book | **Anik's OK** (touches Accounts) |

**How the 18 submodules of the original prompt map:**

| Submodule | Phase |
|---|---|
| Dashboard | 1 |
| Employee master | 1 |
| Salary structure | 1, plus allowance components in 2 |
| Attendance | 1 as monthly totals; 2 for daily records and leave |
| Overtime | 1 as monthly hours, rates and flags; 2 for daily entries and approvals |
| Monthly payroll | 1 |
| Advances | 1 |
| Loans | 1 interest-free; 2 with interest |
| Misc earnings and deductions | 1 |
| Approval | 1 |
| Payslips | 1 |
| Salary payments | 1, plus bank file formats in 2 |
| Statutory | 2 |
| Documents | 2 |
| Reports | 1 core set, 2 the rest |
| Accounting | 2 inside HR, 3 into Accounts |
| Excel import and reconciliation | 1 |
| Settings and rules | 1 |

---

## 20. Go-live (not in this session)

1. Back up production.
2. Apply `<ts>_hr_payroll.sql` to `colour-impressions-prod` as a named migration.
3. Run `db:check`.
4. Deploy.
5. Anik loads the latest workbook.
6. Run one month in parallel with Excel.
7. Switch over.

Every step needs Anik's say-so in that session.

---

## 21. Decisions I made, for Anik to check

1. A separate `hr` schema with no foreign keys into plant tables (§5).
2. HR access is its own list, read fresh on every request; only `md@motionci.com` starts with it; the
   shared Plant login doesn't (§6).
3. Approving a run you submitted yourself warns but is allowed (§6).
4. People joining or leaving mid-month have the days outside their dates added as unpaid automatically
   (§8).
5. When pay is short: advance recovery shrinks first, then loans, then other deductions; the rest stays
   owed (§8). This is the workbook's "treat as advance", done automatically.
6. Payable rounds to the nearest rupee, shown as its own line (§8).
7. The deductions warning at 50% of gross leaves out advances, since those are wages already paid
   (§8). Worth checking with the CA.
8. High-OT warning at 150 hours a month (§8).
9. Misc is an earning by default (§9), and blank cells count as 0 for the usual columns (§9). This
   matches today's sheet; both can be changed.
10. The Excel advance figure is taken as the month's total including advances already entered in the
    ERP (§9).
11. Phase 1 loans are interest-free (§11).
12. Corrections to a locked month go into the next month; full reversal comes in Phase 2 (§12).
13. Typed holiday amounts load as fixed monthly amounts, highlighted (§15).
14. No HR tile among the module ticks; the HR access list is the gate (§5).

## 22. Questions for Anik (non-blocking; the build doesn't wait)

1. What do **Darbi** and **Darbi Special** stand for: another firm's bank, or a person's?
2. What does **C STAT** mean (A for 47 people, S for 2)?
3. The column headed **"Anik"**: is it salary you pay personally, outside the bank or cash run? It is
   modelled here as "paid separately".
4. Are the **typed holiday amounts** standing monthly amounts, or one-offs for July?
5. **ESI**: 10 people are marked "ESI payable", but nothing is deducted. Does a consultant handle it,
   or should the ERP work it out (Phase 2)?
6. Which **month's workbook** should seed go-live: September's, so October is the first ERP month?
