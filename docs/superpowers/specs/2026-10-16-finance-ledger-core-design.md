# Finance — Ledger Core (sub-project 1 of 8) — Design

- **Date:** 2026-10-16
- **Status:** Built locally, uncommitted (2026-10-18). It awaits Anik's review and a go-live session.
  - **History:** the design was approved section by section in chat on 2026-10-16; the spec and the
    19-task plan were approved; the build ran task by task, each task reviewed, then a whole-branch review.
  - **Build changes:** decisions taken during the build that change this design are in §18.
  - **Go-live:** the checklist is in §18.3.
- **Repository:** `~/Documents/CI ERP FInal/ci-erp`, built in the worktree
  `~/Documents/CI ERP FInal/ci-erp-finance` (branch `feat/finance-ledger-core`, cut from
  `origin/main` @ `33f81735`).
- **Session rule:** plan → code → run locally. No `git commit`, no push, no deploy, no migration on
  production in this session. The go-live runbook (§16) is executed only in a later session that Anik
  sanctions out loud.

---

## 1. Why this exists

Anik handed over a brief for a complete Accounting & Financial Management System (FMS) inside the plant
ERP at motionci.in, built as a new isolated module that disturbs nothing existing. That brief describes
roughly eight systems. It is split into eight sub-projects (§3), each with its own spec → plan → build →
sign-off. **This spec designs sub-project 1, the Ledger Core**, which every other sub-project stands on,
and records the programme-level decisions that constrain all eight.

### 1.1 Decisions Anik made on 2026-10-16

| Question | Decision |
|---|---|
| What is the module for? | **Official books of account.** Built to audit standard; runs in parallel with the current books until they match for a full quarter, then the switch happens at a quarter/year boundary. |
| Which businesses? | **Both, as separate books** — Colour Impressions and Darbi Print Pack (different PANs, so different legal persons). Every entry belongs to exactly one book. |
| Where are the books today? | **Tally, kept by an in-house accountant**, who becomes the main Finance user. |
| Timeline | **Parallel run Jan–Mar 2027; Finance becomes official on 1 Apr 2027.** Ledger opens 1 Jan 2027 with balances as at 31 Dec 2026 from Tally. |
| Approvals | **The MD approves the risky ones:** manual journals, payments above a limit, every reversal. The accountant posts routine entries directly. |
| Architecture | **Approach A — Finance inside the ERP**: own tables, routes, pages and menu group; same logins and database; reads ERP documents, never changes the code that creates them. (B, a separate app, and C, building into existing invoice code, were rejected.) |
| Design sections 1–6 | Approved as presented, including all seven shared-file changes (§12). |

### 1.2 What the ERP looks like today (read-only audit, 2026-10-16)

- The ERP already issues the plant's tax invoices, under both billing entities (Colour Impressions and
  Darbi Print Pack). All are `open`. (Counts and values are kept out of this public repo.)
- An **Accounts** area went live 2026-10-05/06 (`routes/accounts.js`): purchase bills, vendor payments,
  payables, party statements, cash & bank book. **None of it is in use**: production has 0 receipts,
  0 purchase bills and 0 vendor payments. Money in and out is recorded in Tally today.
- There is **no ledger** anywhere: no chart of accounts, no journals, no trial balance, P&L or balance
  sheet. Every existing "book" is a live sum over documents.
- ERP money columns are `DOUBLE PRECISION`; the shared pool parses every `NUMERIC` to a JS float
  (`db.js:16`). Dates are stored as `'YYYY-MM-DD'` TEXT to avoid a timezone day-shift.
- ERP financial documents are **hard-deleted, never cancelled**; invoices can be renumbered, re-dated and
  re-totalled; a deleted invoice's number can be re-issued. (This drives sub-project 2's design, §3.)
- `coa` / `coas` already means **Certificate of Analysis** in this codebase. Finance calls its chart of
  accounts **groups and ledgers** (Tally's words) and never uses `coa` in a name.
- The server's `moduleGate` only fences Fluence-only logins; **any staff login can call any route**.
  Finance must authorise every request itself (§8).

---

## 2. Principles (apply to all eight sub-projects)

1. **Finance never blocks the plant.** No invoice, dispatch, GRN, receipt or master edit is ever refused
   because of an accounting rule. Problems surface inside Finance (exceptions, warnings) for the accountant.
2. **Inside Finance, the books' rules are hard stops** — enforced by the database, not only the screens
   (§7). This deliberately differs from Anik's "warn, don't block" rule for the planning engines, because
   books without these rules are not books.
3. **Additive only.** New `fin_*` tables, new files. No existing table gains a column, constraint, trigger
   or foreign key; no existing route, screen or behaviour changes. The seven shared-file edits in §12 are
   the complete list.
4. **No database links from Finance onto existing ERP tables.** Finance stores ERP ids (customer, vendor,
   user, billing entity, later invoice/receipt) without foreign keys, so no existing delete flow in
   Masters, Users or Billing changes behaviour. Integrity inside Finance is enforced with foreign keys
   between `fin_*` tables only.
5. **Tally-familiar.** Groups, ledgers, voucher types and keyboard flow mirror Tally so the accountant
   reads Finance without retraining, and imports/comparisons with Tally line up by name.
6. **Exact money.** Stored as `NUMERIC(18,2)`; all server and client arithmetic in integer paise.

---

## 3. Programme roadmap (sub-projects 2–8 get their own specs)

| # | Sub-project | Needed by | Notes / open questions carried forward |
|---|---|---|---|
| 1 | **Ledger core** (this spec) | early Jan 2027 (opening import) | — |
| 2 | **Auto-posting from ERP documents** | 1 Jan 2027 | Pull model: reads invoices / receipts / bills / vendor payments, posts with a source pointer, detects later edits and hard deletes by fingerprint and lists them as exceptions; never posts twice (`fin_vouchers` partial unique index, §6.8). **Open:** where receipts and vendor payments are recorded from now on (ERP "Record Payment" vs Finance receipt vouchers with bank account and bill-wise allocation) so they are never counted twice; how Darbi ↔ Colour Impressions inter-company supply is booked; purchase bills carry one tax figure (no CGST/SGST/IGST split) and board GRNs carry no value. |
| 3 | **Financial statements** | 1 Jan 2027 | P&L, Balance Sheet, Cash Flow, comparatives, year-end close of P&L to capital, Excel/PDF. |
| 4 | **Cash & bank** | 1 Jan 2027 | Bank account master on bank ledgers, cheques, bank statement import, bank reconciliation, daily cash position. Supporting-document attachments (storage choice) decided here. |
| 5 | **Receivables & payables depth** | 1 Apr 2027 | GST-correct credit/debit notes, bill-wise allocation (on-account, advances, partials), due dates, credit limits, statements, TDS. Uses the bill references captured in §6.7 from day one. |
| 6 | **GST & TDS reports** | 1 Apr 2027 (first returns from Finance due May 2027) | GSTR-1 / 3B summaries, tax ledgers, TDS payable/receivable. |
| 7 | **Expenses, cost centres, fixed assets, depreciation** | FY 2027-28 | Asset register loaded at 1 Apr 2027; depreciation can be a year-end journal until then. |
| 8 | **FMS layer** | after go-live | Dashboard, working capital, cash-flow forecast, budgets, loans/EMIs, profitability. |

Also open, outside the eight: **closing-stock valuation** — the ERP stores quantities but no rupee values,
so closing stock enters as a figure from Tally / a month-end journal until a costing sub-project exists.

### 3.1 Brief coverage map

| Brief section | Where it lands |
|---|---|
| 4A Chart of accounts | SP1 (§6.3–6.4) |
| 4B General ledger, 4C Journal management (except recurring journals, attachments, depreciation journals) | SP1 (§6.6–7, §10) |
| 4C recurring journals | SP4 |
| 4C attachments | SP4 |
| 4C depreciation journals | SP7 |
| 4D Accounts receivable, 4E Accounts payable | SP2 + SP5 |
| 4F Cash & bank | SP4 (cash/bank ledgers and receipt/payment/contra vouchers exist in SP1) |
| 4G Fixed assets, 4H Expense management | SP7 |
| 5 FMS (dashboard, forecasting, working capital, budgeting, loans, profitability) | SP8 |
| 6 Taxation | SP2 (tax ledgers in postings), SP5 (TDS), SP6 (reports) |
| 7 Reports — trial balance, GL, journal register | SP1 |
| 7 Reports — P&L, BS, CF | SP3 |
| 7 Reports — cash/bank book | SP4 |
| 7 Reports — the rest | SP5–SP8 |
| 8 Lifecycle & controls | SP1 (§7) |
| 9 Data integrity | SP1 (§6–7) |
| 10 ERP integration | SP2 |
| 11 UI | SP1 shell (§10), extended by each SP |
| 12 Security & permissions | SP1 (§8) |
| 13 Testing | every SP; SP1 §14 |
| 14 Phases | §3 order |
| 15 Deliverables, 16 Definition of done | per SP; programme done after SP8 |

---

## 4. Sub-project 1 scope

**In:**
- Books (one per business).
- Financial years and months, with Open / Closing / Locked.
- Tally-style groups and ledgers.
- Vouchers: Journal, Receipt, Payment, Contra, and the Opening voucher.
- The draft → approval → posted lifecycle, plus reversal.
- Database-enforced hard stops.
- Finance roles and access.
- Append-only audit log.
- Approval rules and limits.
- Bell and phone notification for approvals.
- Trial balance, ledger statement and journal register, with drill-down and Excel/PDF export.
- Opening-balance import from Tally.
- The month-end Parallel Run comparison report.
- A setup script for books and first grants.

**Out:** everything in sub-projects 2–8, including:
- Auto-posting.
- P&L, Balance Sheet and Cash Flow.
- Bank reconciliation.
- Credit/debit note and sales/purchase screens. The voucher types exist in the schema; their screens and rules come in SP2 and SP5.
- Cost centres, attachments, multi-currency, e-invoicing.

---

## 5. Architecture

```
client/src/pages/finance/*  ──fetch──▶  /api/finance/*  (server/src/routes/finance.js, one router)
                                             │
                    ┌────────────────────────┼─────────────────────────┐
                    ▼                        ▼                         ▼
        finance-access.js        finance-vouchers.js          finance-reports.js
        (who may do what)        (lifecycle, posting tx)      (TB, ledger, register)
                    │                        │                         │
                    └──────────── fin_* tables (Postgres, public schema) ┘
                                  + fin_* trigger functions (hard stops, append-only audit)
```

- **One router file** `server/src/routes/finance.js` keeps routes thin. Logic lives in flat modules
  `server/src/finance-*.js`. Flat, because `npm test` runs only `src/*.test.js` and that is the
  codebase's convention.
- **Same database, same pool, same login token.** Finance authorises each request against its own
  `fin_access` table (§8). It ignores the plant `role`, because five plant logins are `admin`.
- **Pure units** have no database access and are unit-tested directly: `finance-money.js`,
  `finance-calendar.js`, `finance-rules.js`, `finance-groups.js` (the Tally group template) and the
  matcher in `finance-import.js`.
- **Client:** one lazy page shell `client/src/pages/finance/Finance.jsx` with nested routes. Components
  live in `client/src/components/finance/`. Pure helpers live in `client/src/lib/finance/`:
  - money: paise and ₹ formatting with 2 decimals and Indian grouping, which the ERP has nowhere today;
  - financial-year ranges;
  - the realtime table list.

---

## 6. Data model

All new tables live in `public` and are named `fin_*`. Dates are `'YYYY-MM-DD'` TEXT with a format
CHECK, following ERP convention; the trigger in §7.2 additionally proves each one is a real calendar date.
Money is `NUMERIC(18,2)`. Every table gets the ERP's guarded realtime-ping triggers (row + truncate),
copied from `20261005180000_accounts_books.sql`.

### 6.1 `fin_books`
| Column | Type / rule |
|---|---|
| id | INT identity PK |
| code | TEXT NOT NULL UNIQUE, `^[A-Z]{2,4}$` — `CI`, `DP`; prefixes voucher numbers |
| name | TEXT NOT NULL — display name; legal identity (GSTIN, address) is read from `billing_entities` |
| billing_entity_id | INT NOT NULL UNIQUE — `billing_entities.id`, **no FK** (principle 4) |
| books_begin | TEXT NOT NULL — `2027-01-01` for both books |
| active | BOOLEAN NOT NULL DEFAULT true |
| created_by, created_at | audit columns |

Indian financial year (April–March) is fixed; no setting.

### 6.2 `fin_years`, `fin_periods`

**`fin_years`**
- book_id (FK), label (`2026-27`), short (`2627`), start_date, end_date.
- UNIQUE(book_id, start_date).

**`fin_periods`** — one row per calendar month:
- book_id, year_id (FKs), month_no 1–12 (1 = April), label (`Jan 2027`), start_date, end_date.
- status, plus status_changed_by and status_changed_at.
- UNIQUE(book_id, start_date).

| status | Meaning |
|---|---|
| `before_books` | Months before `books_begin` (Apr–Dec 2026). Only the Opening voucher, or a reversal of it, may be dated here (§7.2). |
| `open` | Normal posting. |
| `closing` | Only entries approved by an Approver post (CA finalising; audit adjustments). |
| `locked` | Nothing posts. Unlock = Approver, with a reason, audited. |

Allowed transitions, all by an Approver and all audited:
- open → closing
- closing → locked
- closing → open (needs a reason)
- locked → closing (needs a reason; this is the "unlock")

Creating a year generates its twelve months: those before `books_begin` as `before_books`, the rest
`open`. Years and months with vouchers cannot be deleted (FK RESTRICT).

**A lock freezes balances, not only entries (rulings R70, R73).** A voucher posting into any month takes
the most restrictive status among that month and every later month of the book:
- if any of them is `locked`, the voucher is refused with `FIN_PERIOD_LOCKED`, which names the month;
- if any of them is `closing`, the voucher needs an Approver.

So nothing dated before a locked month can change the balances that month carries. This includes the
Opening voucher and its reversal, which are dated in `before_books`. To correct an earlier month, or the
Opening, the later locked months are first reopened (`locked → closing`), each with an audited reason.

`books_begin` must be the 1st of a month (R74), so the Opening's month is always `before_books`.

### 6.3 `fin_groups` — Tally's tree, per book
| Column | Type / rule |
|---|---|
| id | INT identity PK; also UNIQUE(id, book_id) for composite FKs |
| book_id | FK `fin_books` |
| parent_id | FK `fin_groups` NULL (NULL = primary group) |
| name | TEXT NOT NULL; UNIQUE (book_id, lower(name)) |
| nature | `asset` / `liability` / `income` / `expense` |
| affects_gross_profit | BOOLEAN (Sales, Purchase, Direct Incomes/Expenses) |
| is_system | BOOLEAN — predefined; cannot be deleted; nature fixed |
| sort_order | INT |

**Seeded per book by the setup script** (`finance-groups.js`): Tally's 15 primary and 13 sub-groups, plus one system group "Profit & Loss" for the system ledger of that name.

| Group | Nature | Sub-groups |
|---|---|---|
| Capital Account | liability | Reserves & Surplus |
| Loans (Liability) | liability | Bank OD A/c, Secured Loans, Unsecured Loans |
| Current Liabilities | liability | Duties & Taxes, Provisions, Sundry Creditors |
| Suspense A/c | liability | — |
| Branch / Divisions | liability | — |
| Fixed Assets | asset | — |
| Investments | asset | — |
| Current Assets | asset | Bank Accounts, Cash-in-Hand, Deposits (Asset), Loans & Advances (Asset), Stock-in-Hand, Sundry Debtors |
| Misc. Expenses (ASSET) | asset | — |
| Sales Accounts | income | — (affects gross profit) |
| Direct Incomes | income | — (affects gross profit) |
| Indirect Incomes | income | — |
| Purchase Accounts | expense | — (affects gross profit) |
| Direct Expenses | expense | — (affects gross profit) |
| Indirect Expenses | expense | — |
| Profit & Loss (system) | liability | — |

Users may add sub-groups. Only a Finance Admin may change structure or delete a non-system group with no ledgers.

### 6.4 `fin_ledgers`
| Column | Type / rule |
|---|---|
| id | INT identity PK; UNIQUE(id, book_id) |
| book_id, group_id | FKs; composite FK (group_id, book_id) → fin_groups(id, book_id) keeps a ledger in its own book's tree |
| name | TEXT NOT NULL; UNIQUE (book_id, lower(name)) |
| code | TEXT NULL; UNIQUE (book_id, code) where not null |
| tally_name | TEXT NULL — the ledger's name in Tally, used to match month-end TB imports even if renamed here |
| party_type, party_id | `customer` / `vendor` + ERP id, both null or both set, **no FK**; UNIQUE (book_id, party_type, party_id) where set |
| manual_entry | BOOLEAN DEFAULT true — false = "system only": refused in hand-typed vouchers (§7.2) |
| is_system | BOOLEAN — `Cash`, `Profit & Loss A/c` (seeded); cannot be deleted |
| active | BOOLEAN DEFAULT true — inactive ledgers refuse new postings; history stays |
| notes, created_by, created_at, updated_at | — |

- **Naming refinement (after design approval).** A party ledger keeps the name it was imported with
  from Tally. It shows its linked ERP customer or vendor beside it, and flags it if that name now
  differs. It does not rename itself when Masters renames the party. That way the month-end comparison
  with Tally keeps lining up by name.
- **Bank and cash.** A ledger is "bank or cash" when its group is, or descends from, Bank Accounts,
  Cash-in-Hand or Bank OD A/c. There is no separate flag.

### 6.5 Voucher types (`voucher_type`)
| type | Number code | SP1 screen | Notes |
|---|---|---|---|
| journal | JV | yes | no bank/cash ledgers (use Receipt/Payment/Contra) |
| receipt | RV | yes | ≥1 debit to a bank/cash ledger |
| payment | PV | yes | ≥1 credit to a bank/cash ledger |
| contra | CV | yes | every line a bank/cash ledger |
| opening | OB | via Opening Balances import | dated the day before `books_begin`; one live per book |
| sales | SV | SP2 | auto-posted |
| purchase | PU | SP2 | auto-posted |
| credit_note | CN | SP5 | — |
| debit_note | DN | SP5 | — |

A **reversal** is a `journal` voucher with `reversal_of_id` set, shown as "Reversal of CI-RV-2627-0012".
The exception is a reversal of an Opening voucher: it may be dated on the opening date (§7.2).

### 6.6 `fin_vouchers`
| Column | Type / rule |
|---|---|
| id | INT identity PK; UNIQUE(id, book_id) |
| book_id | FK fin_books |
| voucher_type | CHECK in §6.5 list |
| number | TEXT NULL UNIQUE — minted at posting (§7.4) |
| voucher_date | TEXT NOT NULL (format CHECK) |
| period_id | FK fin_periods NULL — set and verified at posting |
| narration, reference | TEXT |
| status | `draft` / `submitted` / `posted` / `discarded` |
| total | NUMERIC(18,2) — sum of debits, kept by the app, re-verified at posting |
| reversal_of_id | FK fin_vouchers NULL; partial UNIQUE where status ≠ `discarded` |
| reversed_by_id | FK fin_vouchers NULL UNIQUE — the only column a posted voucher may ever change (null → value) |
| source_type, source_id, source_fingerprint | ERP document pointer (SP2); NULL for hand-made |
| client_key | UUID NULL UNIQUE — idempotent create |
| created_by_id / created_by / created_at, updated_at | — |
| submitted_by_id / submitted_by / submitted_at | — |
| approved_by_id / approved_by / approved_at, self_approved | — |
| posted_by_id / posted_by / posted_at | — |
| last_rejected_by / last_rejected_at / last_reject_reason | — |

**Constraints**
- `(status = 'posted') = (number IS NOT NULL AND period_id IS NOT NULL AND posted_at IS NOT NULL)`.
- At most one live Opening voucher per book: partial UNIQUE (book_id) where type = `opening`, status =
  `posted` and `reversed_by_id IS NULL`.
- Never posted twice: partial UNIQUE (source_type, source_id) where the source is set, status is
  `submitted` or `posted`, and the voucher is not reversed and is not itself a reversal.

### 6.7 `fin_voucher_lines`
| Column | Type / rule |
|---|---|
| id | INT identity PK |
| voucher_id, book_id | composite FK → fin_vouchers(id, book_id) |
| line_no | SMALLINT; UNIQUE (voucher_id, line_no) |
| ledger_id | composite FK (ledger_id, book_id) → fin_ledgers(id, book_id) — a line can only use its own book's ledger |
| debit, credit | NUMERIC(18,2) NOT NULL DEFAULT 0; CHECK `debit >= 0 AND credit >= 0 AND ((debit > 0) <> (credit > 0))` — exactly one side, never zero |
| narration | TEXT |
| bill_ref, bill_date, due_date | TEXT NULL — on party lines; bill-wise matching is SP5, capture starts now (opening balances) |

### 6.8 Access, rules, audit, imports
| Table | Purpose / key columns |
|---|---|
| `fin_access` | One row per (user_id, book_id), UNIQUE. `roles` is TEXT[], a non-empty subset of {viewer, accountant, approver, admin}. Also `can_export` BOOLEAN, `granted_by`, `updated_at`. `user_id` has no FK. |
| `fin_approval_rules` | (book_id, rule_key) UNIQUE. `rule_key` is any §6.5 type or `reversal`. `mode` is `always` / `above_limit` / `never`, with `limit_amount` set if and only if the mode is `above_limit`. Also `updated_by`, `updated_at`. |
| `fin_audit_log` | BIGINT identity. `book_id`, `entity`, `entity_id`, `action`, `user_id`, `user_name`, `reason`, `before` JSONB, `after` JSONB, `at`. **Append-only** (§7.2). |
| `fin_imports` | `book_id`, `purpose` (`opening` / `parallel_tb`), `as_at`, `status` (`draft` / `matched` / `used` / `discarded`), `file_names`, `uploaded_by` / `uploaded_at`, `opening_voucher_id` FK, `summary` JSONB. |
| `fin_import_ledgers` | `import_id` FK, `tally_name`, `tally_group`, `debit`, `credit`, `ledger_id` FK NULL, `match_status` (`unmatched` / `matched` / `create`). |
| `fin_import_bills` | `import_id` FK, `tally_ledger_name`, `bill_ref`, `bill_date`, `due_date`, `amount`, `side` (`dr` / `cr`). |

**Default approval rules**, created per book by the setup script and editable by a Finance Admin:

| Rule key | Default |
|---|---|
| journal | always |
| opening | always |
| reversal | always |
| credit_note | always |
| debit_note | always |
| payment | above_limit ₹1,00,000 |
| contra | above_limit ₹1,00,000 |
| receipt | never |
| sales | never |
| purchase | never |

### 6.9 Migration
- **File:** `supabase/migrations/<timestamp>_finance_ledger_core.sql`. The timestamp is taken at build time and must sort after production's newest applied migration. The name avoids "plate" (which also matches "tem*plate*s"), because `plate-schema-bootstrap.test.js` treats any such file as a plate migration.
- **Header:** the standard one — purpose, `APPLIED …` filled in at go-live, `Mirrored locally by server/src/db.js init()…`, a `LOCKS:` paragraph (new tables only; no locks on any existing table, because there are no FKs onto existing tables), then `set local lock_timeout = '1s';`.
- **Idempotent throughout:** `CREATE TABLE/INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, and `create or replace trigger` for every trigger, never `DROP TRIGGER`.
- **Local replay:** one appended line at the end of `init()`, `await pool.query(migration('<file>'));`. The generated `0001_baseline_schema.sql` does not change.
- **No data.** Books, years, groups, rules and grants are created by `scripts/finance-setup.mjs` (§16).

---

## 7. Lifecycle and hard stops

### 7.1 States

```
          save                 submit (needs approval)            approve (Approver ≠ maker)
 (new) ───────▶ draft ─────────────────────────────▶ submitted ─────────────────────────────▶ posted
                 │  ▲                                    │                                       │
       discard   │  └──────── reject (reason) ───────────┘                       reverse (§7.5) │
                 ▼                                                                              ▼
             discarded         submit when no approval needed, or maker is an Approver   reversed_by set
                 draft ──────────────────────────────────────────────────────────────▶ posted
```

- **Drafts** may be unbalanced while being worked on. A submitted voucher is frozen.
- **Reject** returns the voucher to `draft` with the reason, which is kept on the row and in the audit log. Only the maker may edit a draft. The maker or a Finance Admin may discard one (housekeeping); nobody edits someone else's entry, so authorship stays clear.
- **Discarded** drafts stay in the database (`status = 'discarded'`) for the trail. They never get a number.
- **Self-approved:** an Approver who submits their own voucher posts it directly, with `self_approved = true`. It is listed on the Self-approved report (§10).

### 7.2 Database-enforced rules — `fin_*` trigger functions

Every rule raises a Postgres exception whose `DETAIL` carries a stable code. The route maps that code
to a 409 with a plain sentence (§9.3).

| # | Rule | Mechanism | Code |
|---|---|---|---|
| H1 | Debits = credits to the paisa, ≥2 lines, total > 0, `total` = Σdebit | deferred constraint trigger on the transition to `posted` | `FIN_UNBALANCED` / `FIN_TOO_FEW_LINES` |
| H2 | One side per line, no zero line, never NaN | CHECK on `fin_voucher_lines` | `FIN_BAD_LINE` |
| H3 | A posted voucher is immutable. No DELETE. No UPDATE except `reversed_by_id` null → the id of this voucher's own posted reversal, in the same book | BEFORE UPDATE/DELETE trigger on `fin_vouchers` | `FIN_POSTED_IMMUTABLE` |
| H4 | Lines of a posted voucher can't be inserted, updated or deleted | BEFORE trigger on `fin_voucher_lines` (reads the parent's status) | `FIN_POSTED_IMMUTABLE` |
| H5 | Period, judged on the most restrictive of the voucher's month and every later month of the book (R70, R73): `open` OK, `closing` only if `approved_by_id` is set, `locked` never. `before_books` only for `opening` or a reversal of one. The reversal is dated the Opening's own date (R42), and an Opening's reversal is never itself reversed (R45). The date is real and inside `period_id`, and the period is in the same book | same deferred trigger as H1 | `FIN_PERIOD_LOCKED` / `FIN_PERIOD_CLOSING` / `FIN_BEFORE_BOOKS` / `FIN_BAD_DATE` |
| H6 | Every line's ledger is active. A `manual_entry = false` ledger only appears when `source_type` is set, the voucher is the `opening` voucher, or it is a reversal. A reversal mirrors history exactly, so it may also use a ledger deactivated since | same deferred trigger | `FIN_LEDGER_INACTIVE` / `FIN_SYSTEM_LEDGER` |
| H7 | A line's ledger belongs to the voucher's book | composite FKs | `FIN_WRONG_BOOK` |
| H8 | A voucher is reversed at most once. One live Opening per book. One live posting per ERP document | unique / partial unique indexes | `FIN_ALREADY_REVERSED` / `FIN_OPENING_EXISTS` / `FIN_SOURCE_POSTED` |
| H9 | The audit log can't be edited or deleted | BEFORE UPDATE/DELETE trigger | `FIN_AUDIT_APPEND_ONLY` |
| H10 | No TRUNCATE of `fin_vouchers`, `fin_voucher_lines` or `fin_audit_log` | BEFORE TRUNCATE trigger | `FIN_NO_TRUNCATE` |
| H11 | A reversal is proved before any exemption applies. The original is posted, in the same book, marked `reversed_by_id` = this voucher at COMMIT, and the lines mirror it exactly (debit ↔ credit). Amounts are never NaN | same deferred trigger as H1, and line/total CHECKs | `FIN_BAD_REVERSAL` |

Two usage rules are checked by the app in `finance-rules.js`, not the database, because they are usage rules rather than integrity rules:
- Voucher-type shape: a journal has no bank/cash lines; receipt, payment and contra as in §6.5.
- The Opening voucher is dated exactly the day before `books_begin`.

H1, H5 and H6 run as `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`. They fire `AFTER INSERT`
when the new status is `posted`, and `AFTER UPDATE` when the status changes into `posted`. They do not
fire on the later `reversed_by_id` update, so a voucher in a since-locked month can still be reversed
into an open month.

### 7.3 Who may post what — approval rules (`finance-rules.js`, pure)

`needsApproval(voucher, rule, amount)`:
- `always` → yes.
- `never` → no.
- `above_limit` → `total > limit`.
- Reversal always uses the `reversal` rule.
- Posting into a `closing` month always needs approval, whatever the rule says.

On submit:
- If approval is needed and the maker is not an Approver → `submitted`. All Approvers of that book are notified (`fin_approval`).
- Otherwise → posted in the same request. The maker must be an Accountant or Approver. It is self-approved if approval was needed.

### 7.4 Posting transaction and numbering

- **Number:** `<BOOK>-<CODE>-<FYshort>-NNNN`, e.g. `CI-JV-2627-0001`, `DP-RV-2627-0012`. Minted by the
  ERP's own `nextNumber(prefix, 'fin_vouchers', 'number', oc)` (literal prefix match, 4-digit pad,
  advisory-locked).
- **Gap-free:** a number is minted only at posting, and a rolled-back posting re-uses its number.

Inside one `tx((qc, oc) => …)`. No `q` or `one` inside it, because the pool is 1 client on Vercel.
1. Compute the prefix from the voucher's book, type and FY, then `lockDocNumber(prefix, oc)`. This is the prefix-first rule from `helpers.js`.
2. `SELECT … FOR UPDATE` the voucher. If book, type or date changed the prefix since step 1 → 409 "changed while posting — try again". Check the status is postable.
3. `SELECT` the covering period `FOR SHARE`, which serialises against a concurrent status change (that takes `FOR UPDATE`).
4. App checks: permission (§8), type shape, balance in paise, approval rule.
5. Mint the number. Set `status = 'posted'`, `period_id`, posted_by/at, approved_by/at and `self_approved`. For a reversal, also set the original's `reversed_by_id`.
6. Insert the `fin_audit_log` row and call `notify(…, qc)`.
7. COMMIT. The deferred triggers H1, H5 and H6 re-verify at commit. A failure rolls back everything, including the number.

**Idempotency:**
- Draft creation carries a client-generated `client_key`; a retry returns the existing draft.
- Submit, approve and reverse are `MINTING_POSTS` (§12, item 6), so the client joins a double-click to the request already in flight.
- A second approve that arrives anyway finds `posted` and answers 409 "already posted".

### 7.5 Reversal
- Allowed only for a `posted` voucher that has not been reversed.
- It creates a `journal` with `reversal_of_id` set and every line mirrored (debit ↔ credit). It is dated by the requester and defaults to today; the date must fall in an `open` month (or `closing` with approval). A reversal of an Opening voucher may be dated on the opening date.
- When an Approver requests it, it posts immediately (self-approved) and sets the original's `reversed_by_id` in the same transaction.
- When an Accountant requests it, it is `submitted` for MD approval, under the `reversal` rule.
- The original remains visible, marked "Reversed by …". Both appear in the books, so the net effect is zero.

---

## 8. Access and audit

### 8.1 Capabilities
| Capability | Viewer | Accountant | Approver | Admin |
|---|:-:|:-:|:-:|:-:|
| View vouchers, ledgers, reports | ✓ | ✓ | ✓ | ✓ |
| Export (also needs `can_export`) | ✓ | ✓ | ✓ | ✓ |
| Create / edit / discard own drafts, submit, post routine | | ✓ | ✓ | |
| Add a ledger under an existing group; edit a ledger's name, code, Tally name, notes | | ✓ | | ✓ |
| Upload Tally files, match ledgers, build the Opening voucher (posting it still needs an Approver) | | ✓ | | ✓ |
| Approve / reject / reverse / move months Open→Closing→Locked and back | | | ✓ | |
| Groups; a ledger's group, system-only and active flags; years; approval rules; Finance access; discard anyone's draft | | | | ✓ |

- Roles combine; the MD holds Approver and Admin.
- A user with no `fin_access` row for a book sees nothing of that book.
- With no row at all, the Finance page shows "Finance isn't switched on for this login — ask the MD." and no data.

### 8.2 Enforcement
- `finance-access.js` loads the caller's `fin_access` rows by `req.user.id` (the JWT carries only id, name and role). It holds them for 10 s per instance, as `access.js` does, and forgets them immediately when a grant changes on that instance.
- Every route resolves the book it acts on (from params, body or the voucher row) and calls `requireFinance(cap, bookId)` before doing anything. The plant `role` is never consulted.
- The client hides what a login can't do, but that is cosmetic. The server refuses regardless, with 403 `{code:'FIN_FORBIDDEN'}`.
- **Separation of duties:** an Approver cannot approve a voucher they made. Their own vouchers post directly as self-approved (§7.1).

### 8.3 Audit log
- **Every write appends one `fin_audit_log` row:** who (`user_id`, name), when, entity, action, `before` / `after` (full JSON including lines), and a `reason`. The reason is required for reject, reverse, unlock and reopen.
- **Actions:** create, edit, submit, approve, reject, post, discard, reverse, ledger and group create/edit, period status change, rule change, access grant/revoke, import upload/match/build.
- The plant's shared `audit_log` is not used, so Finance never shows up in plant timelines. The Timeline drawer on Finance pages keeps showing plant activity; this is unchanged behaviour, accepted.

---

## 9. Server API (all under `/api/finance`, one router)

Route declarations follow `mint-routes-join-once.test.js`: `r.<verb>('/finance/…'` at column 0, single-quoted path, inline handler.

### 9.1 Routes
| Method + path | Capability | Mints? |
|---|---|---|
| GET `/finance/me` | any grant | — |
| GET `/finance/books` | any grant | — |
| GET `/finance/books/:bookId/groups`, `/ledgers`, `/years` | view | — |
| POST `/finance/groups` · PUT `/finance/groups/:id` | admin | — |
| POST `/finance/ledgers` · PUT `/finance/ledgers/:id` | accountant (create) / admin (flags, group moves) | — |
| POST `/finance/years` (creates 12 months) | admin | — |
| PUT `/finance/periods/:id/status` | approver | — |
| GET `/finance/vouchers` (book, from, to, type, status, q) · GET `/finance/vouchers/:id` (lines + history) | view | — |
| POST `/finance/vouchers` (create draft, `client_key`) · PUT `/finance/vouchers/:id` (edit draft) | accountant / approver | — |
| POST `/finance/vouchers/:id/submit` | accountant / approver | **yes** |
| POST `/finance/vouchers/:id/approve` | approver | **yes** |
| POST `/finance/vouchers/:id/reject` (reason) | approver | — |
| POST `/finance/vouchers/:id/discard` (drafts only) | maker / admin | — |
| POST `/finance/vouchers/:id/reverse` (date, reason) | accountant (request) / approver (post) | **yes** |
| GET `/finance/reports/trial-balance` (book, from, to) | view | — |
| GET `/finance/reports/ledger` (ledger, from, to) | view | — |
| GET `/finance/reports/journal-register` (book, from, to, type) | view | — |
| GET `/finance/reports/parallel-run` (import) | view | — |
| GET `/finance/reports/self-approved` (book, from, to) | view | — |
| GET `/finance/approval-rules` · PUT `/finance/approval-rules/:id` | view / admin | — |
| GET `/finance/access` · POST `/finance/access` · DELETE `/finance/access/:id` | admin | — |
| GET `/finance/activity` (book, from, to, user, entity) | view | — |
| POST `/finance/imports` (parsed rows) · GET `/finance/imports/:id` · PUT `/finance/imports/:id/matches` | accountant / admin | — |
| POST `/finance/imports/:id/build-opening` (creates the Opening draft and submits it) | accountant / admin | **yes** (when the submit posts) |

"Mints?" = the route is added to `client/src/lib/writeOnce.js` `MINTING_POSTS`; the test derives this from the source.

### 9.2 Reports — definitions
- **Trial balance** (book, from, to):
  - Per ledger: opening (posted lines dated < from), period debits, period credits, closing.
  - Shown in Tally group order, rolled up through the group tree. Totals Dr = Cr.
  - "As at a date" is every posted line dated on or before that date, with no lower bound. This includes the Opening voucher dated 31 Dec 2026.
  - Drill-down: group → ledgers → ledger statement.
- **Ledger statement** (ledger, from, to): opening, then each posted line ordered by voucher date then posting order, with the voucher number, narration, the other side's ledger(s), debit, credit, running balance with Dr/Cr, and closing. Its closing equals the trial-balance closing for that ledger.
- **Journal register:** posted vouchers in a range with their lines, filterable by type.
- **Parallel run:** for a `parallel_tb` import as at a month end:
  - Per ledger: Tally closing, Finance closing, difference, all matched by `tally_name`, then by name.
  - Differences highlighted, with drill-down into the ledger.
  - Unmatched Tally ledgers listed separately.
- **Self-approved:** vouchers with `self_approved = true`.
- **Arithmetic:** all sums are done in SQL on `NUMERIC`, then converted to paise with `Math.round(v * 100)`. That is exact for any |v| < 9×10¹³. Totals are compared in paise.

### 9.3 Errors
- Business errors throw `Object.assign(new Error(sentence), { status, body: { code, … } })`, with structured fields inside `body`, as `structured-errors.test.js` requires.
- Trigger exceptions are mapped by their `DETAIL` code to the same sentences. Example: "Debits ₹1,20,000.00 and credits ₹1,18,000.00 don't match — difference ₹2,000.00."
- An unknown database error is still a 500 and is logged.

---

## 10. Screens

The sidebar gets a new **Finance** group between Supply and Admin, with three items:
- **Vouchers** → `/finance`
- **Reports** → `/finance/reports`
- **Setup** → `/finance/setup`

Visibility:
- Nav `roles: ['admin']`, so the five plant-admin logins see it.
- Any other login sees it only when Finance is explicitly ticked for it in Masters → Users. A CA's read-only login would be set up this way.

Every Finance page:
- Starts with a **book switch** (Colour Impressions | Darbi Print Pack), remembered per user via `safeStorage`.
- Follows the ERP's `PageHeader → KpiRow → Tabs → DataTable` recipe and existing tokens.
- Refreshes on change via `useRealtimeRefresh(load, FINANCE_TABLES)`.
- Running-balance tables set `sortable: false` on every column. DataTable otherwise sorts by default.

**Vouchers** (tabs: Day Book · Approvals · Drafts)
- **Day Book:** filters for date, type, status and person. KPIs: drafts, waiting approval, posted today, posted this month. Clicking a row opens the voucher detail.
- **New Voucher** (Journal, Receipt, Payment, Contra), keyboard-first for a Tally user:
  - Tab and Enter move field to field.
  - The ledger picker autocompletes on name or code.
  - Dr/Cr is set per line.
  - The live "Difference ₹… Dr/Cr" sits beside Save.
  - The date defaults to the last used date.
  - Ctrl+Enter saves.
  - Bill reference fields appear on party lines.
- **Approvals:** what is waiting for this approver; Approve, or Reject with a reason. Works on a phone.
- **Voucher detail:**
  - Lines, totals, status and a history timeline from the audit log.
  - Actions (Submit / Approve / Reject / Reverse / Discard) by capability.
  - A print view following the ERP's print pattern (`.print-fit`, A4).

**Reports** (tabs: Trial Balance · Ledger · Journal Register · Parallel Run · Self-approved)
- Each report has a date range or as-at date, drill-down, and Excel + PDF export through the existing `ExportMenu` / `lib/exporter.js`.
- Amounts show with 2 decimals and Indian grouping.
- No CSV: the ERP has no shared CSV helper, and Excel covers it.

**Setup** (tabs: Chart of Accounts · Months & Years · Opening Balances · Approval Rules · Access · Activity Log)
- **Chart of Accounts:** group/ledger tree with closing balances; add, edit, deactivate and system-only by capability. The party link is shown, with a name-differs flag.
- **Months & Years:** a grid of months with status and transitions; "Add next financial year".
- **Opening Balances:** the import wizard (§11).
- **Approval Rules:** rules and limits per book.
- **Access:** grant or revoke roles per login per book, plus `can_export`.
- **Activity Log:** a filterable audit-log view.

**Devices:**
- Desktop and tablet first.
- On a phone: Approvals and read-only reports work.
- New Voucher on a phone says "use a computer or tablet".

---

## 11. Opening balances and the parallel run

### 11.1 Inputs from Tally
For each company, as at 31 Dec 2026, Excel exports of:
1. Trial Balance with ledgers shown.
2. List of Accounts (ledger → group).
3. Bills Receivable / Bills Payable outstanding, bill-wise.

**Action before building the importer:** get one real sample of each from the accountant. Tally
layouts vary with configuration; the parser is built against the real files, not guesses.

### 11.2 Wizard (Setup → Opening Balances)
1. **Upload.** The browser reads the files with ExcelJS, which the client already loads for export, so there is no new dependency. A column-mapping step confirms which columns are name, group, Dr and Cr, and the parsed rows go to `POST /finance/imports`.
2. **Match ledgers.**
   - Each Tally ledger is matched to an existing Finance ledger by `tally_name`, then by name (case- and space-insensitive), or proposed as "create under <group>".
   - Party ledgers (under Sundry Debtors / Sundry Creditors) are proposed against ERP customers and vendors by GSTIN, then by name.
   - Every match is shown, and the accountant confirms each one. Nothing is matched silently.
3. **Bills.** Party balances are split bill by bill from the bills export. The bills for each party must sum to that party's TB balance, or the screen says which party is off and by how much.
4. **Tie-out.**
   - The proposed Opening voucher's per-ledger amounts must equal the Tally TB, ledger by ledger, to the paisa, and Dr must equal Cr.
   - Only then does "Build opening voucher" enable.
   - It creates one `opening` voucher, dated 31 Dec 2026, with one line per ledger, and bill-wise lines for parties.
   - It is submitted for MD approval under rule `opening` = always.
5. **Approve.** The MD posts it. The trial balance as at 31 Dec 2026 now equals Tally's.

The Opening voucher includes **every** ledger, including income and expense year-to-date (Apr–Dec), so
FY 2026-27 profit in Finance equals Tally's.

### 11.3 Monthly comparison (Jan, Feb, Mar 2027)
- At each month end the accountant uploads Tally's TB for that date (`purpose = 'parallel_tb'`; same upload and mapping steps, no voucher).
- The **Parallel Run** report compares it with Finance. The target is zero differences for all three months. That, plus the CA's agreement, is the go-live test for 1 Apr 2027.

### 11.4 Cut-over
- FY 2027-28 opens from Finance's own 31 Mar 2027 balances. Balances are always computed from postings, so there is no second import.
- March 2027 stays `closing` while the CA's audit adjustments for FY 2026-27 are posted (Approver-approved), then is `locked`.
- The year-end transfer of profit and loss to capital belongs to SP3.

---

## 12. Changes outside Finance (approved list — complete)

| # | File | Exact change |
|---|---|---|
| 1 | `client/src/modules.js` | Insert `{ key: 'finance', label: 'Finance', path: '/finance' }` immediately **before** the Fluence entry (`kit-studio.test.js` requires Fluence last). |
| 2 | `client/src/App.jsx` | One `lazy(() => import('./pages/finance/Finance.jsx'))` and one `<Route path="/finance/*" element={<Finance />} />` inside the AppLayout route. |
| 3 | `client/src/components/AppLayout.jsx` | One `{ group: 'Finance', items: [Vouchers (end: true), Reports, Setup] }` between Supply and Admin, plus the icon imports. |
| 4 | `server/src/app.js` | `import finance from './routes/finance.js';` and `app.use('/api', finance);` after the existing routers. **Amendment approved by Anik on 2026-10-22 (R35, R41):** one more entry in the existing per-path JSON-ceiling switch, so that `POST /api/finance/imports` and `PUT /api/finance/imports/:id/matches` accept up to 4 MB. A real Tally upload is far over the 100 KB default; a 1,501-account upload measured 453 KB. The routes cap row counts themselves. To revert, remove those lines. |
| 5 | `server/src/db.js` | One line at the end of `init()`: `await pool.query(migration('<file>'));`. Local only; production gets the named migration at go-live. |
| 6 | `client/src/lib/writeOnce.js` | Add the Finance minting POST paths from §9.1 to `MINTING_POSTS`. |
| 7 | `server/src/notify-categories.js` | `fin_approval: 'approvals'` (to Approvers when something waits) and `fin_decision: 'decisions'` (to the maker when approved or rejected). |

Nothing else changes:
- No existing table gains a column, constraint, trigger or FK.
- No existing route, screen, or behaviour of Accounts, Invoices, Dispatch, Procurement, Masters or Users changes.
- Masters → Users gets a Finance tick box automatically, because it renders `MODULES`.

As built, the modified tracked files are these seven, plus `server/src/notify-categories.test.js`. That
test's pinned category list gained the two new kinds (R26).

`client/src/components/Timeline.jsx` is untouched (R52). Its drawer is mounted nowhere today. If it is ever
mounted, exclude `'finance'` there as `'dashboard'` and `'reports'` are, or a "Finance" scope would list
the whole plant.

---

## 13. Money, dates, time

- **Server:** `finance-money.js` provides:
  - `toPaise(input)` — strings or numbers; refuses more than 2 decimals for typed input; `Math.round(v*100)` for database floats.
  - `fromPaise(p)` — a `'1234.50'` string written to `NUMERIC`, so the value is exact.
  - Pure tests cover rounding and limits.
- **Client:** `lib/finance/money.js` handles formatting: `₹1,23,456.00`, Indian grouping, Dr/Cr suffix.
- **Dates:** `'YYYY-MM-DD'` TEXT everywhere. "Today" is `plantDateStr()` (IST). Routes never use `toISOString().slice(0,10)` or `now()::date`, per `plant-date-routes.test.js`.
- **FY helpers:** `finance-calendar.js` and `lib/finance/fy.js` — FY label and short form, month boundaries, the period for a date.

---

## 14. Testing

Every guard must be shown failing on the reinstated bug before it is trusted (`ci-erp-guard-must-fail-first`).

1. **Pure unit tests** (`server/src/finance-*.test.js`, run by `npm test`):
   - money;
   - calendar;
   - approval rules and capability matrix;
   - voucher-shape rules per type;
   - the importer's matcher and tie-out.
2. **Source pins:**
   - The migration has `set local lock_timeout`.
   - Every `fin_*` table has both realtime triggers.
   - No `drop trigger`.
   - `db.js` replays the file.
   - **Isolation pin:** the migration's SQL never names a non-`fin_` table in `ALTER`, `CREATE TRIGGER … ON` or `REFERENCES`.
3. **Real-database tests**, opt-in with `FINANCE_PG=1`, modelled on `direct-invoice-pg.test.js`: throwaway embedded Postgres, `PG_POOL_MAX=1`, `init()` run twice, the setup script, the real API over HTTP.
   - Each of H1–H10 refuses through the API **and** through a direct SQL write that bypasses the app. Each is first shown passing with its rule removed.
   - Two concurrent postings in one series → distinct consecutive numbers. A double-submitted approve → one posting. A posting racing a month lock → exactly one wins, consistently.
   - Accounting checks:
     - The trial balance balances.
     - A ledger statement's closing equals the trial balance.
     - A reversal nets every ledger to zero.
     - Opening import of a sample TB plus bills ties out, and the 31 Dec TB equals the sample.
   - Permissions: every route refuses a login without the capability, including plant `admin` logins with no grant, with 403 `FIN_FORBIDDEN`.
   - Isolation: a snapshot of every non-`fin_` table's columns, constraints and triggers is identical before and after the migration.
4. **Whole repo:** `npm run verify` stays green. That covers the baseline freshness gate, ~3,000 existing tests including every registry and lint pin in §12, and the client build.
5. **Browser walkthrough** on a local database. Screenshots of each step are shared with Anik:
   - setup, then creating a ledger;
   - a journal posted by the accountant and refused by the database when unbalanced;
   - a payment above the limit, approved by the MD;
   - a reversal;
   - a month lock;
   - the opening import against a sample;
   - the trial balance, then the ledger statement, then the voucher;
   - exports;
   - phone approvals.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Tally export layouts differ from assumptions | Build the parser against real sample files (§11.1); column-mapping step. |
| Double keying during Jan–Mar burdens the accountant | SP2 auto-posts ERP invoices/bills; keyboard-first entry; parallel run limited to one quarter. |
| Timeline: SP1–SP4 before 1 Jan 2027 | SP1 kept tight; Opening import can run in the first week of January on the live system once Tally's December is final. |
| Finance load on the plant database | Volumes are small (hundreds of vouchers/month); indexed by (book, date, status) and (ledger); reports read only `fin_*` tables. |
| A plant admin with no grant opens Finance | Server refuses every Finance route (403); page shows the no-access message. |
| Concurrent editing of the shared canonical tree by other sessions | Work happens only in the `ci-erp-finance` worktree; the shared tree is never touched. |

---

## 16. Go-live runbook (later session, only when Anik says "deploy" in that session)

1. Rebase the branch on the latest `origin/main`. Then `npm install` and `npm run verify` in the worktree. Then `FINANCE_PG=1` tests.
2. `npm run db:backup` against production.
3. Apply the migration to `colour-impressions-prod` (`ylbfeptgefzimcqnwphy`) as a named migration:
   - dry-run first inside `BEGIN … ROLLBACK`, with before/after assertions that no non-`fin_` object changed;
   - then apply;
   - fill in the header's `APPLIED` line.
4. `npm run db:check` against production: schemas match.
5. Deploy, migration first and then code: push `main` or `vercel deploy --prod`. Verify:
   - `/api/health` is ok;
   - Finance pages load;
   - a plant flow reads normally.
6. Run `scripts/finance-setup.mjs` against production. It:
   - creates books `CI` (billing entity 1) and `DP` (billing entity 2) with `books_begin = 2027-01-01`;
   - creates FY 2026-27 with Apr–Dec `before_books` and Jan–Mar `open`;
   - seeds the group trees, the `Cash` and `Profit & Loss A/c` ledgers, and the default approval rules;
   - grants **MD → approver + admin, both books** and **Accounts → accountant, both books**, matched by email: `md@motionci.com`, and the Accounts login (its email is set at go-live, in `FIN_SETUP_ACCOUNTANT_EMAIL`, and is not kept in the repository); audited as "system (go-live)".
   - It is idempotent and re-run safe.
7. In early January 2027: the opening import (§11), approved by the MD.

**Rollback:**
- Revoking Finance access hides Finance instantly with no data loss.
- A code rollback is promoting the previous Vercel deployment.
- The `fin_*` tables are additive and unread by the rest of the ERP, so they stay in place. They are never dropped.

---

## 17. Refinements made while writing this spec (flagged for review)

1. Voucher numbers are `CI-JV-2627-0001`, matching the ERP's `CI-INV-0001` style and its tested
   `nextNumber`. Section 2 of the chat showed `CI/JV/26-27/0001`.
2. Party ledgers keep their Tally name rather than following Masters renames (§6.4). Section 1 of the
   chat said the ledger follows a rename.
3. Books, years, groups, default rules and the first grants come from a one-off, audited setup script
   (§16 step 6). Before any Finance Admin exists, nobody could do it in the app.
4. Credit note, debit note, sales and purchase types exist in the schema from day one. Their screens
   arrive in SP2 and SP5; SP1's New Voucher offers Journal, Receipt, Payment and Contra.
5. No foreign keys from Finance onto existing ERP tables (principle 4), so no existing delete flow
   changes behaviour.
6. Default payment and contra approval limit is ₹1,00,000 per book until the MD changes it in Setup.

---

## 18. Decisions made during the build (2026-10-17/18)

The build was run task by task, with a review of each task and a whole-branch review at the end.
Wherever this spec, the plan and the code disagreed, the controller made a ruling. Every ruling is
recorded with its reason in the build ledger, `.superpowers/sdd/2026-10-16-finance-ledger-core/progress.md`
in the worktree; that folder is git-ignored. The rulings below change or extend this design.

### 18.1 Books, posting and locks
- **Opening date.** The Opening voucher is dated exactly the day before `books_begin` (R12).
- **Opening reversals.** An Opening voucher is reversed as at its own date (R42). Its reversal can never be reversed (R45). A second Opening is refused while one is posted or waiting, through the build and through a resubmit alike (R37, M-5).
- **Locks hold carried balances.** A lock freezes the balances a month carries (R70, R73; see §6.2). A voucher dated before a locked month is refused, and one dated before a closing month needs an Approver. The rule covers the Opening as well.
- **Start date.** `books_begin` must be the 1st of a month (R74).
- **Reversal dates.** A reversal cannot be dated before the entry it reverses (R28). It is submitted under the `reversal` approval rule (R29).
- **Party ledgers.** A party ledger is one with a party link, or one whose group is or descends from Sundry Debtors or Sundry Creditors. One server helper defines it for drafts, the import and the reads (R23, R39, R65). The ledger and group reads carry `is_party` and `is_bank_cash`.
- **Locked drafts.** Opening and reversal drafts cannot be edited (R24).
- **Database CHECKs:**
  - no NaN amounts or limits;
  - `reversed_by_id` only on a posted voucher;
  - a reversal is always a journal.

### 18.2 Tally import (§11)
- **Matching.** Parties are proposed by GSTIN first, then by name (R32). The proposals take only active ERP parties and real GSTIN shapes. The accountant confirms every row, then builds (R33).
- **As-at dates.** An Opening import must be as at the day before `books_begin`. A month-end import must fall inside one of the book's years (R34).
- **Ignored rows.** Group-named rows are read as group totals. They are named, with their amounts, in the summary and in an unbalanced tie-out (R36, R43). Nothing is dropped silently.
- **Signs.** Bills are signed (Dr +, Cr −). The parallel-run difference is Tally minus Finance (R38).
- **Line cap.** The tie-out flags in advance the 5,000-line cap on the Opening voucher.
- **Excel reading.** It unwraps rich-text cells and refuses a formula cell with no saved value.

### 18.3 Changes that need Anik, and the go-live checklist
- **Approved 2026-10-22:** the `app.js` 4 MB JSON ceiling for the two import paths (§12, item 4).
- **Accountant login.** `scripts/finance-setup.mjs --apply` needs `FIN_SETUP_ACCOUNTANT_EMAIL`, the Accounts login's email. It is no longer written into the public repo (R68). The host guard checks the host `pg` will really use. A re-run prints added, changed or unchanged for each grant. Note that a re-run restores a revoked default grant.
- **Rebase onto main.** HR & Payroll shipped on 2026-10-17 and touches the same shared files, so merge or rebase the branch onto main. Then rename the migration to a fresh UTC timestamp, because it now sorts before main's newest. Update `db.js` and the pins that name the file.
- **Real Tally exports, test-first.** Get the accountant's real List of Accounts, Trial Balance and Bills files (§11.1) and test against them first. Likely gaps:
  - a single signed balance column;
  - Bills Payable amounts with no Cr marker;
  - Tally sub-groups that Finance lacks (consider a bulk group pick).

  Time the Opening build with the real list. About 1,000 new ledgers should take roughly 7 s, against Vercel's 30 s limit (R44).
- **Production dry run.** Check that:
  - nothing outside `fin_*` changes;
  - the 26 realtime triggers exist;
  - the app's database role owns the tables. Then decide on `REVOKE` and RLS for the `fin_*` tables.
- **Vercel plan.** Confirm it. If the team is still on Hobby, merge the Day Book's five count requests into one before deploying.
- **Small follow-ups:**
  - the trial-balance PDF tiles at ₹10 crore and above (shared exporter);
  - checking long voucher print in Safari and Firefox.
- **Separate ERP bug:** shared `ui.jsx` menus throw on a window resize while open. This predates Finance.
- **Operating note for year-end (R73).** Do not lock any month of the new financial year until the
  previous year's audit adjustments are posted (§11.4). Under R73, any later lock blocks those entries
  until it is reopened with a reason.
- **Screen wording to tidy.** Four help sentences still describe each month in isolation. These are
  `periods.js` (Start closing, Unlock), `MonthsYears.jsx` (the header line) and `ApprovalRules.jsx`.
  They should add "unless a later month is closing or locked". This is wording only; behaviour is correct.
