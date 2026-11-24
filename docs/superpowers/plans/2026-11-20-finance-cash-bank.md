# Finance Cash & Bank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Finance a Cash & Bank screen:
- accounts with live balances;
- Receive, Pay and Transfer;
- cash holders and cash counts.

Every receipt and payment settles bills by Auto or Pick, and is never refused for not matching. HR's staff money reaches the books as totals. A wrong opening figure can be corrected without rebuilding the Opening.

**Architecture:**
- **Database:** one Finance migration (new `fin_*` tables and columns, and a widened posting check) and one HR migration (four nullable "paid from" columns). `init()` replays both locally.
- **Server:** new flat modules `server/src/finance-allocations.js`, `finance-cash.js`, `finance-corrections.js`, `finance-hr-setup.js` and `finance-hr-feed.js`, wired into the existing router `server/src/routes/finance.js`. HR routes call the feed after their own commit.
- **Client:** a `/finance/cash` page and additions to Setup. The pure Auto/Pick and cash helpers live in `client/src/lib/finance/`, and the server imports them too (the SP1 pattern).
- **Model:** every entry is an ordinary SP1 voucher (receipt, payment, contra or journal). Bill-wise allocation is a separate layer that never changes a balance.

**Tech Stack:** Node 24 ESM, Express 4, node-postgres, PostgreSQL 17 (embedded locally, Supabase in production), PL/pgSQL triggers, React 18 + Vite + Tailwind, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-20-finance-cash-bank-design.md`, approved by Anik on 2026-11-20.
- It builds on `docs/superpowers/specs/2026-10-16-finance-ledger-core-design.md` (SP1). Read both.
- This plan cites the cash spec as §n and the SP1 spec as SP1 §n.

**Session rule:** no `git commit`, `git push`, deploy, or production migration. Where a TDD cycle would commit, this plan runs the suite instead ("Checkpoint").

## Global Constraints

**Where to work, and what to touch**
- Work only in the worktree `~/Documents/CI ERP FInal/ci-erp-finance-cash` (branch `feat/finance-cash-bank`, which has no upstream).
- Never edit, check out or revert anything in the shared tree `~/Documents/CI ERP FInal/ci-erp`.
- **Outside Finance, touch exactly spec §11's list:**
  - the HR migration (Task 3) and the HR files of Task 12;
  - `client/src/pages/Invoices.jsx`, `client/src/components/AccountsBooks.jsx`, and one constant in `server/src/routes/accounts.js` (Task 16);
  - the shared files `client/src/components/AppLayout.jsx`, `client/src/lib/writeOnce.js` and `server/src/db.js`.

  Everything else lives in `fin_*` tables, `server/src/finance-*.js`, `server/src/routes/finance.js`, or `client/src/{pages,components,lib}/finance/`.

**Inherited unchanged from SP1's plan** (`docs/superpowers/plans/2026-10-16-finance-ledger-core.md`, Global Constraints):
- **Money and dates:**
  - NUMERIC(18,2) in the database; integer paise in JS and in every API field, which ends in `_paise`.
  - `finToPaise()` turns pool floats into paise.
  - Dates are `'YYYY-MM-DD'` TEXT; today comes from `plantDateStr()`.
- **Transactions:**
  - `lockDocNumber(prefix, oc)` comes before any row lock.
  - Inside `tx()`, use only `qc`/`oc`.
- **Server code:**
  - Routes are inline, at column 0, written `r.<verb>('/finance/…'` with single quotes.
  - Errors come from `finError()`.
  - Every export is prefixed `fin`.
  - No property is named `kind:` in `routes/finance.js`. That is why this plan's request field is `entry_type`.
  - Nothing is named `coa`.
- **Client code:**
  - No static import of `lib/exporter.js` or `exceljs`.
  - Storage only through `lib/safeStorage.js`.
  - Overlays carry `data-ci-overlay` / `data-ci-chrome`.
  - Running-balance tables are `sortable: false`.

**Fixed by the spec (copy these exactly)**
- **Auto's order**, first to last:
  1. the opening lump (an Opening line with no `bill_ref`);
  2. item date (`bill_date`, else the voucher date);
  3. `due_date`, with null last;
  4. `bill_ref` in natural order, with null last;
  5. line id.

  *Ruling:* §6.3 says opening items come first because they are the oldest, and §9.3 says the lump is settled first. The lump carries the Opening's own date (31 Dec), so it is placed first explicitly.
- **Cash warnings:**
  - `S269ST` when cash received from one party in one day, this entry included, is ≥ 20,000,000 paise (₹2,00,000).
  - `S40A3` when cash paid to one party in one day, this entry included, is > 1,000,000 paise (₹10,000).
- **Approval:**
  - The seeded rules are unchanged (SP1 §6.8).
  - New rule key `cash_difference`, mode `always`.
  - Opening corrections use the `opening` rule.
  - HR entries (§7.6): when an HR approver approved it in HR, it posts with that approval; otherwise the seeded rules apply.
- **Payroll booking per book:** `month_end` (the default) or `when_paid`.
- **The book that carries the payroll:** `COLOUR` → CI, `DARBI` → DP, NULL firm → CI.
- **HR "paid from" codes:** `cash`, an HR pay channel code, or `fin:<ledger id>`.
- **Party allocation lock:** `SELECT pg_advisory_xact_lock(7300, $1)` for each party ledger id, in ascending order, right after the voucher lock (§6.6).
- **ERP vendor payment prefix:** `CI-VP-`.
- **Switch date for the ERP doors:** the earliest `books_begin` of the active books (`2027-01-01`).
- **Narrations of HR-sourced vouchers.** They never contain a name. Write "1 person", and "N people" for any other count:
  - `Advance · Pay staff · 1 person`
  - `Advance · Loans & Advances · 1 person`
  - `Advances · sheet CI-ADV-0001 · 31 people`
  - `Loan · CI-LN-0004 · 1 person`
  - `Loan repaid · CI-LN-0004`
  - `Advances on the Jan payroll sheet · 6 people`
  - `Salary Nov · cash · CI-PAY-0041 · 9 people` (the channel label, lower-cased)
  - `Salary Nov · cash · 1 person` (a single line)
  - `Payroll Jan 2027 · 52 people`
  - `Advance waived · 1 person`
  - `Salary · combined · 3 people`
  - `Salary Nov · paid by Darbi Print Pack · CI-PAY-0041` (in CI)
  - `Salary Nov · paid for Colour Impressions · CI-PAY-0041` (in DP)
- **Staff ledgers made by `finEnsureStaffLedgers`** (exact names):

  | Ledger | Group | Hand-typed entries |
  |---|---|---|
  | `Staff Advances` | Loans & Advances (Asset) | refused (`manual_entry = false`) |
  | `Staff Loans` | Loans & Advances (Asset) | refused (`manual_entry = false`) |
  | `Salary Payable` | Current Liabilities | refused (`manual_entry = false`) |
  | `Salaries & Wages` | Indirect Expenses | refused (`manual_entry = false`) |
  | `MD's Account` | Unsecured Loans | allowed |
- **New `FIN_SENTENCES` (exact copy):**

  | Code | Sentence |
  |---|---|
  | `FIN_BAD_ALLOCATION` | "That adjustment doesn't fit those entries." |
  | `FIN_OVER_ALLOCATED` | "That would settle more than the entry holds." |
  | `FIN_NOT_PARTY_LINE` | "Only a posted party entry that hasn't been reversed can be adjusted." |
  | `FIN_STAFF_IN_HR` | "Staff advances and salaries are paid in HR." |
  | `FIN_ROLE_MISSING` | "Set this ledger in Finance Setup → HR & payroll first." |
  | `FIN_HOLDER_NOT_CASH` | "Only a Cash-in-Hand ledger can have a holder." |
  | `FIN_NO_OPENING` | "There is no Opening to correct yet." |
  | `FIN_UNMAPPED_CHANNEL` | "Map this HR pay channel to an account in Finance Setup first." |
  | `FIN_HR_OWNED` | "This entry comes from HR; correct it there." |
- **Names:** only invented names in code, tests, fixtures and seeds ("Test Person A", "Holder A", "Acme Pharma"). Never a real worker's name, code or pay, and never the accountant's login email (SP1 R68).

## Review Focus

1. **Money as the accountant types it.** On Receive, Pay and Transfer: `1,20,000.50`, `10.005`, blank, `-50`, `0`.
   - The form turns typed text into paise with SP1's `finToPaiseTyped`, which refuses with a sentence.
   - The route refuses an `amount_paise` that is not a whole positive number, with `FIN_BAD_INPUT`.
   - Tested in Task 6 (route) and Task 14 (the form uses `finToPaiseTyped`).
2. **A party with nothing to settle.** The party has no open bills, or a credit balance of its own (an advance). An opening lump is not "nothing": it is open, so Auto settles it first (spec §9.3; ledger ruling R8).
   - Auto and Pick put the money on account, with no error.
   - Pick shows an empty list that reads "Nothing open".
   - Tested in Task 5.
3. **The same bill picked from two screens at once.**
   - The bill is never over-settled. The later receipt gets what is left, and the rest goes on account. Nobody sees a refusal.
   - Tested in Task 5 (concurrency).
4. **An HR event Finance can't post** (a locked month, an unmapped channel, a missing staff ledger, a date before the books begin).
   - HR's request succeeds and HR's rows are unchanged.
   - Finance lists an exception with its reason (or skips the event, before the books begin).
   - Retrying after the fix posts exactly once.
   - Tested in Tasks 10 and 13.
5. **Undoing after adjusting.**
   - Reversing a receipt reopens its bills.
   - A redo on a reversed voucher is refused with `FIN_NOT_PARTY_LINE`.
   - Reversing an HR-sourced voucher by hand in Finance is refused with `FIN_HR_OWNED`, because the next catch-up would post it again.
   - Tested in Tasks 5 and 10.

## Conventions used in this plan

- **Paths** are relative to the worktree root.
- **Test commands:**
  - Unit tests: `cd server && node --test src/<file>.test.js`.
  - Finance real-database tests: `cd server && FINANCE_PG=1 node --test src/<file>.test.js`. Each boots its own Postgres through `finBootPg()` (`server/src/finance-pg-harness.js`). `init()` creates the HR tables too, so HR rows are inserted with SQL through the fixtures of Task 10.
  - HR real-database tests: `cd server && HR_PG=1 node --test src/<file>.test.js`.
- **Checkpoint** means three things, and there is no commit:
  - the task's tests pass;
  - `cd server && npm test` shows no failures beyond Task 1's baseline;
  - for a task that touches `client/`, `npm run build -w client` exits 0.
- **New minting routes:** every new route that can post a voucher goes into `MINTING_POSTS` in `client/src/lib/writeOnce.js`. `mint-routes-join-once.test.js` fails until it is there.
- **The isolation sweep:** every new `/finance` route goes into `finance-pg-isolation.test.js`'s route sweep, in the task that adds the route.
- **The API speaks integer paise and `'YYYY-MM-DD'`.** Lists are wrapped, e.g. `{ accounts: [...] }`.

## File map

| File | Responsibility |
|---|---|
| `client/src/lib/finance/allocation.js` | Auto, Pick, item order (pure, shared) |
| `client/src/lib/finance/cash.js` | Entry lines, warnings, top-up (pure, shared) |
| `client/src/lib/finance/tables.js` | `FINANCE_TABLES` gains the new tables |
| `supabase/migrations/20261121090000_hr_paid_from.sql` | Four nullable "paid from" columns on HR tables |
| `supabase/migrations/20261121090100_finance_cash_bank.sql` | New `fin_*` tables and columns, the `cash_difference` rule, allocation guards, the widened `fin_voucher_post_check()` |
| `server/src/finance-allocations.js` | Open items, the party lock, apply a plan, redo, release, the party check |
| `server/src/finance-cash.js` | Receive / Pay / Transfer, tiles, account book, counts, clearing a difference |
| `server/src/finance-corrections.js` | Opening corrections |
| `server/src/finance-hr-setup.js` | Channel map, ledger roles, expense map, payroll setting, staff ledgers, paid-from options |
| `server/src/finance-hr-feed.js` | HR event → Finance voucher; reversals; hidden combine; Darbi pair; catch-up; control check |
| `server/src/finance-hr-fixtures.js` | Test-only: invented HR people, channels, runs, lines and batches through SQL |
| `server/src/finance-import.js` | Several Tally staff ledgers onto one Finance staff ledger (§7.9) |
| `server/src/routes/finance.js` | The new `/finance/*` routes |
| `server/src/routes/hr-ledgers.js`, `server/src/routes/hr-payroll.js` | Validate and store "paid from"; call the feed after commit; `GET /hr/paid-from-options` |
| `client/src/pages/finance/CashBank.jsx` + `client/src/components/finance/{CashTiles,CashBookTable,CashEntryForm,AdjustPanel,CashCountDialog,HrInbox,HrSetup,OpeningCorrection,PartyStatement}.jsx` | The screens |
| `client/src/pages/hr/PaidFromSelect.jsx` | HR's "paid from" picker |
| `server/finance-dev.mjs` | Gains a `--cash-demo` invented seed for the walkthrough |

---

### Task 1: Auto and Pick, as pure functions

**Files:**
- Create: `client/src/lib/finance/allocation.js`
- Test: `server/src/finance-allocation.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (pure ESM, no imports). The type `Item` is `{ line_id: int, date: 'YYYY-MM-DD', due_date: string|null, bill_ref: string|null, is_opening_lump: boolean, open_paise: int }`. Only items with `open_paise > 0` are ever used.
  - `finNormRef(s: string|null): string`: upper-case, keeping letters and digits only.
  - `finItemOrder(a: Item, b: Item): number`: the order in Global Constraints.
  - `finPickOrder(items: Item[], reference: string|null): Item[]`: items whose `finNormRef(bill_ref)` contains a non-empty `finNormRef(reference)` come first, then `finItemOrder`.
  - `finAutoAllocate(items: Item[], amountPaise: int): { allocations: { line_id, amount_paise }[], on_account_paise: int }`
  - `finPickAllocate(items: Item[], picks: { line_id, amount_paise: int|null }[], amountPaise: int)`: the same shape. Picks are applied in tick order. `null` means "fill what is open". Each pick is capped at what is open and at what money is left. Picks for unknown or closed lines are dropped.
  - Both allocate functions throw `RangeError` when `amountPaise` is not a safe integer ≥ 0.

- [ ] **Step 1: Install and record the baseline.**
  - Run `npm install` at the root, then `cd server && npm test`.
  - Record the pass and fail counts, and the name of every failing test. Some fail only under a path with spaces (memory: `section-lean-rows`).
  - From here on, "no new failures" means none beyond these.

- [ ] **Step 2: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finAutoAllocate, finPickAllocate, finPickOrder, finItemOrder } from '../../client/src/lib/finance/allocation.js';

const it = (line_id, date, open_paise, extra = {}) =>
  ({ line_id, date, due_date: null, bill_ref: null, is_opening_lump: false, open_paise, ...extra });
const LUMP = it(1, '2026-12-31', 2_000_000, { is_opening_lump: true });
const B91 = it(2, '2026-12-02', 3_500_000, { bill_ref: 'Opening bill 0091' });
const B104 = it(3, '2026-12-18', 4_000_000, { bill_ref: 'Opening bill 0104' });

test('Auto settles the opening lump first, then bills oldest first (spec §5.1 sketch: 80,000 + TDS 1,600)', () => {
  assert.deepEqual(finAutoAllocate([B104, B91, LUMP], 8_160_000), {
    allocations: [{ line_id: 1, amount_paise: 2_000_000 }, { line_id: 2, amount_paise: 3_500_000 }, { line_id: 3, amount_paise: 2_660_000 }],
    on_account_paise: 0,
  });
});
test('Auto: more money than is open goes on account', () => {
  assert.equal(finAutoAllocate([it(5, '2026-09-02', 3_000_000), it(6, '2026-09-18', 3_500_000)], 8_000_000).on_account_paise, 1_500_000);
});
test('Auto: nothing open puts it all on account, with no error', () => {
  assert.deepEqual(finAutoAllocate([], 500_000), { allocations: [], on_account_paise: 500_000 });
});
test('Pick: tick order; null fills the bill; the last tick is trimmed to the money left', () => {
  assert.deepEqual(finPickAllocate([B91, B104], [{ line_id: 3, amount_paise: null }, { line_id: 2, amount_paise: null }], 5_000_000).allocations,
    [{ line_id: 3, amount_paise: 4_000_000 }, { line_id: 2, amount_paise: 1_000_000 }]);
});
test('Pick: an edited amount is capped at what is open; an unknown line is dropped', () => {
  assert.deepEqual(finPickAllocate([B91], [{ line_id: 2, amount_paise: 9_999_999 }, { line_id: 99, amount_paise: 100 }], 5_000_000),
    { allocations: [{ line_id: 2, amount_paise: 3_500_000 }], on_account_paise: 1_500_000 });
});
test('order: lump, then date, then due date (null last), then bill ref naturally (INV-9 before INV-10), then line id', () => {
  const list = [it(9, '2027-01-05', 1, { bill_ref: 'INV-10' }), it(8, '2027-01-05', 1, { bill_ref: 'INV-9' }),
    it(7, '2027-01-05', 1, { due_date: '2027-02-01' }), it(6, '2027-01-04', 1), LUMP];
  assert.deepEqual(list.sort(finItemOrder).map(x => x.line_id), [1, 6, 7, 8, 9]);
});
test('Pick order: a typed reference moves its bill to the top', () => {
  assert.equal(finPickOrder([B91, B104], 'bill-0104')[0].line_id, 3);
});
test('amounts must be whole paise ≥ 0', () => {
  for (const bad of [-1, 1.5, NaN, '100']) assert.throws(() => finAutoAllocate([], bad), RangeError);
});
```

- [ ] **Step 3: Run it to make sure it fails.** Run: `cd server && node --test src/finance-allocation.test.js`. Expected: FAIL, because the module isn't found.
- [ ] **Step 4: Implement `client/src/lib/finance/allocation.js`.** Natural order uses `new Intl.Collator('en', { numeric: true, sensitivity: 'base' })`.
- [ ] **Step 5: Run it.** Expected: PASS.
- [ ] **Step 6: Checkpoint.**

### Task 2: Entry lines, warnings and top-up, as pure functions

**Files:**
- Create: `client/src/lib/finance/cash.js`
- Test: `server/src/finance-cash-lib.test.js`

**Interfaces:**
- Consumes: `finFormatINR(paise)` from `client/src/lib/finance/money.js`.
- Produces. The type `Line` is `{ ledger_id, debit_paise, credit_paise }`.
  - `FIN_CASH_LIMITS = Object.freeze({ s269stPaise: 20_000_000, s40a3Paise: 1_000_000 })`
  - `finCashLines({ entry_type, account_ledger_id, other_ledger_id, amount_paise, tds_paise = 0, tds_ledger_id = null }): Line[]`
    - `receive`: Dr account (amount) · Dr TDS (if > 0) · Cr other (amount + TDS).
    - `pay`: Dr other (amount + TDS) · Cr account (amount) · Cr TDS (if > 0).
    - `transfer`: Dr other, the to-account · Cr account, the from-account.
    - Throws `RangeError` for TDS > 0 without `tds_ledger_id`, or TDS on a transfer.
  - `finCashWarnings({ entry_type, is_cash, is_holder, account_name, amount_paise, party_cash_today_paise, balance_after_paise, on_account_paise }): { code, sentence }[]`. The codes, and their exact sentences:
    - `ON_ACCOUNT`: "`₹x` stays on account."
    - `S269ST`: "Cash received from this party today reaches ₹2,00,000 (Income-tax Act s.269ST)." (receive, cash only)
    - `S40A3`: "Cash paid to this party today is over ₹10,000 (Income-tax Act s.40A(3))." (pay, cash only)
    - `BELOW_ZERO`: "This takes `{account_name}` below zero."
    - `HOLDER_SHORT`: "`{account_name}` holds less than this." (instead of `BELOW_ZERO` for a holder)
  - `finTopUpPaise({ float_paise, holds_paise }): int`: `max(0, float − holds)`, or 0 when `float_paise` is null.

- [ ] **Step 1: Write the failing tests.**
  - `receive with TDS: [[A, 8_000_000, 0], [T, 160_000, 0], [P, 0, 8_160_000]]`.
  - `pay with TDS: [[P, 1_020_000, 0], [A, 0, 1_000_000], [T, 0, 20_000]]`.
  - `transfer: [[TO, 25_000_000, 0], [FROM, 0, 25_000_000]]`.
  - `TDS 0 adds no line`.
  - `TDS without a ledger throws RangeError`.
  - `S269ST`: present at a `party_cash_today_paise` of `20_000_000`, absent at `19_999_999`, absent when `is_cash` is false.
  - `S40A3`: present at `1_000_001`, absent at `1_000_000`.
  - `a holder going below zero gives HOLDER_SHORT, not BELOW_ZERO`.
  - `ON_ACCOUNT names finFormatINR(on_account_paise)`.
  - `finTopUpPaise`: `{5_000_000, 1_000_000}` → `4_000_000`; holds ≥ float → `0`; a null float → `0`.

  Write these as `assert.deepEqual` on the returned arrays.
- [ ] **Step 2: Run it to make sure it fails.** Run: `cd server && node --test src/finance-cash-lib.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `client/src/lib/finance/cash.js`.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 3: The HR migration (where the money came from)

**Files:**
- Create: `supabase/migrations/20261121090000_hr_paid_from.sql`
- Modify: `server/src/db.js`. Add one `await pool.query(migration('20261121090000_hr_paid_from.sql'));` right after the last existing HR migration line, and before the Finance core line.
- Test: `server/src/hr-paid-from-schema.test.js` (static), and a check in `server/src/finance-pg-cash-schema.test.js` (Task 4).

**Interfaces:**
- Produces four nullable TEXT columns:
  - `hr.advance_txns.paid_via`
  - `hr.loan_txns.paid_via`
  - `hr.payment_batches.paid_from`
  - `hr.run_lines.paid_from`

- [ ] **Step 1: Write the failing static test.** It asserts:
  - the file exists and sorts after `20261120100000`;
  - it starts with `-- `;
  - it contains `set local lock_timeout = '1s';` and `Mirrored locally by server/src/db.js init()`;
  - it contains the four `add column if not exists <col> text`;
  - it has no `drop`;
  - `db.js` contains the new `migration('20261121090000_hr_paid_from.sql')` line before `migration('20261027104320_finance_ledger_core.sql')`.
- [ ] **Step 2: Run it to make sure it fails.** Run: `cd server && node --test src/hr-paid-from-schema.test.js`. Expected: FAIL.
- [ ] **Step 3: Write the migration.** Header comment as in `20261105150000_hr_advance_sheets.sql`, naming the four columns and why (§7.3, §11 item 1). Add the `db.js` line.
- [ ] **Step 4: Run it.** Expected: PASS. Also run `npm run db:baseline -- --check` at the root. Expected: exit 0, because replayed files are not captured in the baseline.
- [ ] **Step 5: Checkpoint.**

### Task 4: The Finance migration

**Files:**
- Create: `supabase/migrations/20261121090100_finance_cash_bank.sql`
- Modify:
  - `server/src/db.js`: one line, after the Finance core line, so it becomes the last migration line.
  - `server/src/finance-rules.js`: `FIN_DEFAULT_RULES` gains `finRule('cash_difference', 'always')`.
  - `server/src/finance-rules.test.js`: the rule count 10 → 11.
  - `client/src/lib/finance/tables.js`: `FINANCE_TABLES` gains the seven new tables.
  - `server/src/finance-wiring.test.js`: it collects tables from both Finance migrations.
  - `server/src/finance-errors.js`: new constraint names → codes in `finMapDbError`, and every sentence in Global Constraints.
  - Any pin that required the Finance core line to be last: it is now second-to-last, followed by `finance_cash_bank`.
- Test: `server/src/finance-cash-migration-pins.test.js` (static) and `server/src/finance-pg-cash-schema.test.js` (`FINANCE_PG`).

**Interfaces — exactly these objects:**

`fin_ledgers` gains:
- `holder_name TEXT`;
- `float_amount NUMERIC(18,2)`;
- `CONSTRAINT fin_ledgers_float_needs_holder CHECK (float_amount IS NULL OR (holder_name IS NOT NULL AND float_amount >= 0 AND float_amount <> 'NaN'::numeric))`.

`fin_vouchers` gains:
- `allocation_plan JSONB`, shaped `{ line_no, mode: 'auto'|'pick', picks: [{ line_id, amount_paise|null }] }`;
- `is_opening_correction BOOLEAN NOT NULL DEFAULT false`;
- `CONSTRAINT fin_vouchers_correction_is_journal CHECK (NOT is_opening_correction OR voucher_type = 'journal')`.

`fin_allocations`:
- Columns: `id` (identity), `book_id` (FK `fin_books`), `ledger_id`, `debit_line_id` and `credit_line_id` (both FK `fin_voucher_lines`, no cascade), `amount NUMERIC(18,2)` with a CHECK `> 0` and not NaN, `mode` with a CHECK in `('auto','pick')`, `made_by_id INT`, `made_by TEXT`, `made_at TIMESTAMPTZ DEFAULT now()`.
- Keys and indexes: `UNIQUE (debit_line_id, credit_line_id)`; a composite FK `(ledger_id, book_id) → fin_ledgers(id, book_id)`; indexes on `debit_line_id`, `credit_line_id` and `ledger_id`.
- `fin_allocation_guard()`, `BEFORE INSERT OR UPDATE`, raises with `DETAIL 'FIN_BAD_ALLOCATION'` unless all of these hold:
  - both lines are on `NEW.ledger_id` and `NEW.book_id`;
  - the debit line has `debit > 0` and the credit line has `credit > 0`;
  - both vouchers are `posted`, with `reversed_by_id IS NULL` and `reversal_of_id IS NULL`.
- `fin_allocation_sum_check()`: a `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED AFTER INSERT OR UPDATE`. Σ amount per `debit_line_id` must be ≤ that line's debit, and per `credit_line_id` ≤ its credit; otherwise `DETAIL 'FIN_OVER_ALLOCATED'`.

`fin_cash_counts`:
- `id`, `book_id`, `ledger_id` (composite FK), `count_date TEXT` with the date CHECK, `counted NUMERIC(18,2) CHECK (>= 0 and not NaN)`, `book_balance NUMERIC(18,2)`, `note TEXT`, `counted_by_id INT`, `counted_by TEXT`, `counted_at TIMESTAMPTZ DEFAULT now()`, `cleared_voucher_id INT REFERENCES fin_vouchers`.

`fin_ledger_roles`:
- `id`, `book_id`, `ledger_id` (composite FK), and `role`, with a CHECK in `('staff_advances','staff_loans','salary_payable','salary_expense','md_account','advance_waiver','other_deductions','rounding','tds_receivable','tds_payable','cash_difference','intercompany')`.
- `UNIQUE (book_id, role)`.

`fin_hr_channels`:
- `channel_code TEXT PRIMARY KEY`, `book_id`, `ledger_id` (composite FK).
- A channel can map to a ledger in either book.

`fin_hr_expense_map`:
- `id`, `book_id`, `hr_key TEXT CHECK (hr_key ~ '^(type|dept):.+$')`, `ledger_id` (composite FK).
- `UNIQUE (book_id, hr_key)`.

`fin_book_settings`:
- `book_id INT PRIMARY KEY REFERENCES fin_books`, `payroll_booking TEXT NOT NULL DEFAULT 'month_end' CHECK (payroll_booking IN ('month_end','when_paid'))`, `updated_by TEXT`, `updated_at TIMESTAMPTZ`.
- One row is inserted for every existing book, `ON CONFLICT DO NOTHING`.

`fin_hr_exceptions`:
- `id`, `source_type TEXT NOT NULL`, `source_id INT NOT NULL`, `book_id INT`, `reason_code TEXT NOT NULL`, `reason TEXT NOT NULL`, `first_seen_at TIMESTAMPTZ DEFAULT now()`, `last_tried_at TIMESTAMPTZ`, `resolved_at TIMESTAMPTZ`, `voucher_id INT REFERENCES fin_vouchers`.
- `UNIQUE (source_type, source_id)`.

`fin_approval_rules`:
- Replace the rule-key CHECK so it adds `cash_difference`. Guard it the way `20261105120000_hr_access_privacy.sql` replaces a CHECK: only when the current definition lacks it.
- Insert `(book_id, 'cash_difference', 'always', NULL, 'migration')` for every book, `ON CONFLICT (book_id, rule_key) DO NOTHING`.

`fin_voucher_post_check()`:
- `CREATE OR REPLACE`: copy the function from the core migration verbatim, then change only two things.
- **(a) The `before_books` branch (H5)** also accepts a voucher with `is_opening_correction`, when all of these hold:
  - `voucher_date` is the day before `books_begin`;
  - `approved_by_id IS NOT NULL`;
  - the same later-months rule (R70/R73) applies as for the Opening.

  Any other journal in `before_books` keeps `FIN_BEFORE_BOOKS`.
- **(b) The system-only/inactive ledger exemption (H6)** extends to `is_opening_correction` vouchers, as for the Opening.

Security and realtime:
- RLS goes on every new table, and anon/authenticated are revoked, in the guarded block as in the core migration.
- The guarded realtime block covers the seven new tables.

- [ ] **Step 1: Write the failing static pins** in `finance-cash-migration-pins.test.js`:
  - the file sorts after `20261121090000_hr_paid_from.sql`;
  - it carries the core migration's header rules: `-- ` first, `set local lock_timeout = '1s';`, the "Mirrored locally" line, `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` only, and no `drop trigger`;
  - each of the seven tables is created and appears in the realtime array and the RLS block;
  - `'cash_difference'` appears in both the CHECK and the insert;
  - `FINANCE_TABLES` has length 20 and equals the union of both migrations' tables.
- [ ] **Step 2: Write the failing database tests** in `finance-pg-cash-schema.test.js`. Build lines with posted journals by `md` (self-approved), as `finance-pg-vouchers.test.js` does:
  - `an allocation between a posted debit and a posted credit of one party ledger is accepted`.
  - `an allocation onto a draft, a reversed voucher, two debits, or lines of two ledgers is refused with FIN_BAD_ALLOCATION`. Assert `e.body.code` through the API mapping, or `e.detail` on raw SQL.
  - `allocations totalling more than a line holds are refused at COMMIT with FIN_OVER_ALLOCATED`.
  - `an opening correction posts in before_books when dated the opening day and approved; dated any other day it is refused FIN_BEFORE_BOOKS; with Jan 2027 locked it is refused FIN_PERIOD_LOCKED`.
  - `a plain journal in before_books is still refused FIN_BEFORE_BOOKS`.
  - `cash_difference is 'always' in both books, and fin_book_settings holds month_end for both`.
  - `a float without a holder name is refused by fin_ledgers_float_needs_holder`.
  - `the four HR columns exist, nullable text` (Task 3's check).
- [ ] **Step 3: Run both to make sure they fail.** Run: `cd server && node --test src/finance-cash-migration-pins.test.js && FINANCE_PG=1 node --test src/finance-pg-cash-schema.test.js`. Expected: FAIL.
- [ ] **Step 4: Write the migration, the `db.js` line, and the rules, tables and errors edits.**
- [ ] **Step 5: Run both, plus the SP1 Finance suites they touch.** Run: `FINANCE_PG=1 node --test src/finance-pg-schema.test.js src/finance-pg-db.test.js src/finance-pg-opening-locks.test.js`. Expected: PASS.
- [ ] **Step 6: Checkpoint**, plus `npm run db:baseline -- --check` exits 0.

### Task 5: The allocation engine

**Files:**
- Create: `server/src/finance-allocations.js`
- Modify: `server/src/finance-vouchers.js`:
  - `finPostLocked` takes the party locks first, applies a plan after posting, and releases the original's allocations when it posts a reversal.
  - `finReverseVoucher` refuses a voucher whose `source_type` starts `hr_` unless it is called with `{ fromHr: true }` (`FIN_HR_OWNED`).
- Test: `server/src/finance-pg-allocations.test.js`

**Interfaces:**
- Consumes: Task 1's functions; SP1's `finGroupKinds`, `finIsPartyLedger` and `finAudit`.
- Produces:
  - `FIN_ALLOC_LOCK_NS = 7300`
  - `finPartyLock(oc, ledgerId: int): Promise<void>`
  - `finOpenItems(qc, ledgerId: int): Promise<{ ledger_id, side: 'customer'|'vendor', balance_paise, debits: OpenItem[], credits: OpenItem[] }>`
    - `OpenItem` is `Item` (Task 1) plus `{ voucher_id, number, label, amount_paise }`.
    - `label` is the `bill_ref`; or "Opening balance" for an opening line without one; otherwise the voucher number.
    - Only posted, non-reversed, non-reversal vouchers count.
    - It throws `FIN_NOT_PARTY_LINE` for a ledger that is not a party's.
  - `finApplyPlan(qc, oc, voucherId: int, actor): Promise<{ allocations, on_account_paise } | null>`
    - It reads `allocation_plan` and finds the party line by `line_no`.
    - It recomputes the plan against the current open items of the opposite side, because a plan is never refused (no hard blocker).
    - It inserts `fin_allocations` rows (`mode` from the plan) and audits `{ entity: 'allocation', action: 'apply' }`.
    - It returns `null` when there is no plan.
  - `finRedoAllocations(qc, oc, lineId: int, { mode, picks }, actor): Promise<{ allocations, on_account_paise }>`
    - It takes the party lock, deletes the line's allocations, recomputes and inserts.
    - It audits `{ action: 'redo', before, after }`, and works in any month status.
    - `FIN_NOT_PARTY_LINE` unless the line is a posted line on a party ledger of a live voucher.
  - `finReleaseAllocations(qc, oc, voucherId: int): Promise<int>`: deletes the allocations touching any line of that voucher, and returns how many.
  - `finPartyCheck(qc, ledgerId): Promise<{ outstanding_paise, on_account_paise, balance_paise, ok }>`
    - Customers: `outstanding − on_account === balance` (debit positive).
    - Vendors: the mirror image.

- [ ] **Step 1: Write the failing database tests.**
  - Build the CI Opening through the import routes, as `finance-pg-opening-locks.test.js` does. It holds a customer with a lump of ₹20,000 and bills `0091` (02 Dec, ₹35,000) and `0104` (18 Dec, ₹40,000).
  - Make receipts with a draft (`allocation_plan` set) followed by a submit by `acct`. Receipts never need approval, so they post.
  - The tests:
    - `Auto: the receipt of ₹81,600 settles the lump, 0091, then ₹26,600 of 0104; finPartyCheck ok`.
    - `Auto with ₹1,00,000 against ₹95,000 open leaves ₹5,000 on account; the invariant holds`.
    - `Pick ticks 0104 then 0091 with ₹50,000: 0104 ₹40,000, 0091 ₹10,000; an unknown line in the plan is ignored`.
    - `nothing open (Review Focus 2): a vendor with no bills, a customer with only a lump, and a customer already in credit all take the money on account without an error`.
    - `redo replaces the allocations, changes no ledger balance, writes an audit row with before and after, and works with January locked`.
    - `reversing a receipt releases its allocations in the same transaction; its bills are open again (Review Focus 5)`.
    - `redo on a reversed receipt, a draft, or a non-party line is refused FIN_NOT_PARTY_LINE`.
    - `two receipts for one customer at once never over-settle a bill (Review Focus 3)`.
      - Client A begins, takes `finPartyLock`, and holds.
      - Client B's posting waits: poll `pg_stat_activity` for `wait_event_type = 'Lock'`, as in `finance-pg-race.test.js`.
      - A commits, then B commits.
      - The totals are ≤ the bills, and B's remainder is on account.
- [ ] **Step 2: Run it to make sure it fails.** Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-allocations.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the module.** Side comes from `finGroupKinds`: Sundry Debtors → customer, Sundry Creditors → vendor. Open amounts are computed in SQL from `fin_voucher_lines` minus `fin_allocations` sums.
- [ ] **Step 4: Wire `finPostLocked`.**
  - Its first statement takes `finPartyLock` for every party ledger among the posting voucher's own lines, in ascending id. A reversal's lines mirror the original's, so a reversal serialises with any allocation onto the original even when it has none yet (ledger ruling R7: the allocation guard takes no voucher lock; the party lock protects allocations).
  - After the `UPDATE … status = 'posted'` it calls `finApplyPlan`. For a reversal it calls `finReleaseAllocations(original)`.
- [ ] **Step 5: Run it, plus SP1's voucher suites.** Run: `FINANCE_PG=1 node --test src/finance-pg-vouchers.test.js src/finance-pg-race.test.js src/finance-pg-allocations.test.js`. Expected: PASS.
- [ ] **Step 6: Checkpoint.**

### Task 6: Receive, Pay and Transfer on the server

**Files:**
- Create: `server/src/finance-cash.js`
- Modify:
  - `server/src/finance-vouchers.js`: `finCreateBuiltDraft`'s first argument also takes `{ allocation_plan = null, source_type = null, source_id = null, source_fingerprint = null, is_opening_correction = false }`, and writes them.
  - `server/src/routes/finance.js`
  - `client/src/lib/writeOnce.js`
  - `server/src/finance-pg-isolation.test.js` (the sweep)
- Test: `server/src/finance-pg-cash.test.js`

**Interfaces:**
- Consumes: Task 2's `finCashLines` and `finCashWarnings`; Task 5's `finOpenItems`; SP1's `finCreateBuiltDraft`, `finSubmitVoucher` and `finLedgerStatement`.
- Produces:
  - **`finEnterCash(qc, oc, input, actor): Promise<{ voucher, allocations: [...]|null, on_account_paise: int|null, warnings }>`**
    - `input` is `{ book_id, entry_type, voucher_date, account_ledger_id, other_ledger_id, amount_paise, tds_paise, reference, narration, adjust: { mode, picks }|null, client_key }`.
    - It builds the lines, and when `other_ledger_id` is a party it sets `allocation_plan = { line_no: <the party line>, ...adjust }`.
    - It creates the draft and submits it. The result is posted, or submitted with the plan kept for posting.
  - **`finCashAccounts(bookId, { today }): Promise<{ accounts, unadjusted: { count, amount_paise } }>`**
    - An account is `{ ledger_id, name, account_kind: 'cash'|'bank'|'holder', balance_paise, holder_name, float_paise, top_up_paise, last_count: { count_date, difference_paise }|null }`.
    - "Unadjusted" is a count-only read of credit items (customers) or debit items (vendors) with `open_paise > 0`.
  - **`finCashBook(ledgerId, { from, to }): Promise<{ ledger, opening_paise, closing_paise, entries, pending }>`**
    - It is built on `finLedgerStatement`.
    - An entry is `{ date, voucher_id, number, particulars, adjustment: 'Auto: 3 bills, ₹0 on account'|null, in_paise, out_paise, balance_paise }`.
    - `pending` lists submitted vouchers touching the ledger.
    - With no `from`/`to`, the window is the current month.
  - **The routes:**

    | Route | Capability | Notes |
    |---|---|---|
    | `GET /finance/cash/switch` | any logged-in user | `{ date }` |
    | `GET /finance/cash/accounts?book=` | view | |
    | `GET /finance/cash/book?ledger=&from=&to=` | view | |
    | `POST /finance/cash/entries` | enter | mints |
    | `GET /finance/ledgers/:id/open-items` | view | |
    | `POST /finance/allocations/preview` `{ ledger_id, side, amount_paise, mode, picks, reference }` | view | `{ allocations, on_account_paise, items }`; writes nothing |
    | `PUT /finance/lines/:id/allocations` `{ mode, picks }` | enter | redo |
    | `GET /finance/cash/unadjusted?book=` | view | `{ items: [{ line_id, ledger_id, party, number, date, open_paise }] }`: party money still on account (§6.3) |
    | `GET /finance/reports/party?ledger=` | view | §6.7: open items with outstanding and age in days as at today, on-account credits, and `finPartyCheck`'s figures |
- **Rules:**
  - The account must be bank or cash: `FIN_BAD_INPUT` otherwise.
  - The other ledger can't be a staff role ledger: `FIN_STAFF_IN_HR`.
  - TDS is only allowed when the other ledger is a customer (receive) or a vendor (pay). It uses the `tds_receivable` / `tds_payable` role, with `FIN_ROLE_MISSING` when unset.
  - A party with `adjust: null` goes on account. That is not a refusal.
  - `amount_paise` must be a safe integer > 0, and `tds_paise` a safe integer ≥ 0: `FIN_BAD_INPUT` otherwise.
  - A retried `client_key` returns the existing voucher.

- [ ] **Step 1: Write the failing database tests.**
  - `receipt with TDS: lines Dr Cash 80,000 · Dr TDS Receivable 1,600 · Cr Acme Pharma 81,600; Auto settles as Task 5`.
  - `a payment of ₹1,50,000 by acct waits (submitted) with its plan; when md approves, the picked bills are settled`.
  - `a transfer of ₹2,50,000 to Holder A by acct waits for md`.
  - `paying Staff Advances is refused FIN_STAFF_IN_HR`.
  - `TDS without the role set is refused FIN_ROLE_MISSING`.
  - `amount_paise 0, -1, 1.5 and "100" are refused FIN_BAD_INPUT (Review Focus 1)`.
  - `warnings: ₹2,00,000 cash from Acme in a day returns S269ST; ₹10,001 cash to a vendor returns S40A3; the same by bank returns neither; leftover returns ON_ACCOUNT`.
  - `the book: opening, entries in order with running balance, the receipt's "Auto: 3 bills, ₹0 on account", a pending payment listed apart and outside the balance; with no dates it is the current month`.
  - `a retried client_key returns the same voucher`.
  - `the unadjusted list holds the ₹5,000 left on account; the party report shows 0104 part-open with its age in days, and ok: true`.
  - `GET /finance/cash/switch answers a login with no Finance grant: { date: '2027-01-01' }`.
  - Isolation sweep: `a CI-only login sees no DP account, book, open item or preview`.
- [ ] **Step 2: Run it to make sure it fails.** Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-cash.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `finance-cash.js` and the routes.** Add `'/finance/cash/entries'` to `MINTING_POSTS`. The tiles and unadjusted counts are aggregate SQL reads, never row downloads (§3, Vercel).
- [ ] **Step 4: Run it, plus `finance-pg-isolation.test.js` and `mint-routes-join-once.test.js`.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 7: Cash holders, counts and clearing a difference

**Files:**
- Modify:
  - `server/src/finance-masters.js`: `finCreateLedger` and `finUpdateLedger` take `holder_name` and `float_paise`.
  - `server/src/finance-cash.js`
  - `server/src/finance-vouchers.js`: in `finSubmitVoucher` the rule key is `'cash_difference'` when `v.source_type === 'cash_count'`.
  - `server/src/routes/finance.js`
  - `client/src/lib/writeOnce.js`
  - the isolation sweep.
- Test: `server/src/finance-pg-cash-counts.test.js`

**Interfaces:**
- **Holder fields:** accepted only on a ledger whose group is or descends from Cash-in-Hand (`FIN_HOLDER_NOT_CASH`). An Accountant may set them, as for a ledger's name and notes (SP1 §8.1).
- **`finRecordCount(qc, oc, { ledger_id, count_date, counted_paise, note }, actor): Promise<{ count }>`:** `book_balance` comes from posted lines dated ≤ `count_date`; the difference is counted minus book balance. It posts nothing.
- **`finClearCount(qc, oc, countId, actor): Promise<{ voucher }>`:**
  - A difference > 0 is a receipt: Dr cash, Cr the `cash_difference` role ledger.
  - A difference < 0 is a payment: Dr the role ledger, Cr cash.
  - `source_type = 'cash_count'` and `source_id = countId`, so H8 allows one clearing per count.
  - It submits: the rule is `always`, so an Accountant's clearing waits and an Approver's posts self-approved.
  - It sets `cleared_voucher_id` once the voucher posts.
- **Routes:** `POST /finance/cash/counts` (enter), `GET /finance/cash/counts?ledger=` (view), and `POST /finance/cash/counts/:id/clear` (enter; mints).
- **Cash Short & Excess is system-only (ledger ruling R10):**
  - The ledger holding the `cash_difference` role is `manual_entry = false`, so only `finClearCount`'s vouchers (`source_type = 'cash_count'`) can touch it. H6 allows them because their source is set.
  - `finEnterCash` refuses Receive or Pay naming it as the other side, with a new code `FIN_DIFFERENCE_VIA_COUNT` and the sentence "Cash differences are cleared from a cash count: Count cash → Clear."
  - SP1's voucher form is refused by H6.
  - Task 9 makes setting the role flip the flag. In this task's tests, set the role and the flag with SQL.

- [ ] **Step 1: Write the failing database tests.**
  - `holder fields only on a Cash-in-Hand ledger (else FIN_HOLDER_NOT_CASH); a float needs a holder name`.
  - `tile top_up_paise is float − holds, and 0 at or above the float`.
  - `a count stores the book balance and the difference, and no voucher appears`.
  - `clearing a ₹300 shortage by acct makes a payment against Cash Short & Excess that waits for md, though it is under ₹1,00,000`.
  - `md clearing an excess posts it self-approved and sets cleared_voucher_id`.
  - `clearing the same count twice is refused FIN_SOURCE_POSTED`.
- [ ] **Step 2: Run it to make sure it fails.** Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-cash-counts.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `'/finance/cash/counts/:id/clear'` to `MINTING_POSTS`.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 8: Opening corrections

**Files:**
- Create: `server/src/finance-corrections.js`
- Modify:
  - `server/src/finance-rules.js`: `finShapeProblem(type, lines, { isReversal = false, isOpeningCorrection = false } = {})`. A correction skips "a journal has no bank/cash lines".
  - `server/src/finance-vouchers.js`:
    - `finPostingProblem` treats `v.is_opening_correction` like the Opening in its `before_books` branch.
    - `finSubmitVoucher` uses the rule key `'opening'` for a correction.
  - `server/src/routes/finance.js`
  - `client/src/lib/writeOnce.js`
  - the isolation sweep.
- Test: `server/src/finance-pg-opening-correction.test.js`

**Interfaces:**
- **`finCreateOpeningCorrection(qc, oc, { book_id, lines, narration, client_key }, actor): Promise<{ voucher }>`:**
  - It needs a live Opening (`FIN_NO_OPENING`).
  - It is dated `finDayBefore(book.books_begin)`, with `voucher_type 'journal'` and `is_opening_correction true`.
  - It creates the draft and submits it.
- **`finOpeningCorrections(bookId): Promise<{ corrections: { id, number, status, narration, total_paise }[], by_ledger: { ledger_id, name, opening_paise, corrections_paise, total_paise }[] }>`:** `by_ledger` lists each ledger a posted correction touched: its Opening figure, the corrections' net, and the two together ("Opening + corrections", §9.4).
- **Routes:** `GET /finance/opening-corrections?book=` (view) and `POST /finance/opening-corrections` (enter; mints when an Approver makes it).

- [ ] **Step 1: Write the failing database tests.**
  - `acct's correction waits; md approves; the trial balance as at 2026-12-31 moves by exactly the correction`.
  - `a correction may move ₹10,000 from Office cash to Holder A (cash lines allowed)`.
  - `after that move, by_ledger shows Office cash's opening, −₹10,000 and the total, and Holder A's opening, +₹10,000 and the total`.
  - `with Jan 2027 locked it is refused FIN_PERIOD_LOCKED; with Jan closing it still needs md`.
  - `with no Opening, FIN_NO_OPENING`.
  - `a posted correction reverses like any voucher (the reversal rule)`.
- [ ] **Step 2: Run it to make sure it fails.** Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-opening-correction.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `'/finance/opening-corrections'` to `MINTING_POSTS`.
- [ ] **Step 4: Run it, plus `finance-pg-opening-locks.test.js` and `finance-rules.test.js`.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 9: HR setup in Finance (channels, roles, expense map, payroll setting, staff ledgers at import)

**Files:**
- Create: `server/src/finance-hr-setup.js`
- Modify:
  - `server/src/routes/finance.js` and the isolation sweep.
  - `server/src/finance-import.js` (`finSaveMatches`, `finBuildOpening`, `finParallelRun`): several Tally ledgers onto one staff ledger (§7.9).
- Test: `server/src/finance-pg-hr-setup.test.js`

**Interfaces:**
- **`FIN_LEDGER_ROLES`:** the frozen list of the twelve role names (Task 4).
- **`finHrSetupOf(bookId): Promise<{ channels: { channel_code, book_id, ledger_id }[], roles: { [role]: ledger_id }, expense_map: { hr_key, ledger_id }[], payroll_booking }>`**
- **`finSaveHrSetup(qc, oc, { book_id, channels, roles, expense_map, payroll_booking }, actor)`:** Admin only.
  - A channel's ledger must be bank or cash.
  - A role's ledger must be in the book.
  - Saving the `cash_difference` role sets that ledger `manual_entry = false` (ledger ruling R10). Moving the role to another ledger leaves the old one's flag as it is. The Admin can switch it back in the chart of accounts.
  - It audits `{ entity: 'book', action: 'hr_setup' }`.
- **`finEnsureStaffLedgers(qc, oc, bookId, actor): Promise<{ created: string[] }>`:** creates whichever of Global Constraints' five ledgers are missing, and sets the roles `staff_advances`, `staff_loans`, `salary_payable`, `salary_expense` and `md_account`.
- **`finPaidFromOptions(qc): Promise<{ code, label }[]>`:**
  - `cash`, labelled "Office cash (the CASH channel)";
  - `fin:<id>` for every active cash or bank ledger in the CI book, with a holder labelled `Holder · <holder_name>`;
  - each mapped bank channel code.
- **`finResolvePaidFrom(qc, code: string|null, channelCode: string|null): Promise<{ book_id, ledger_id }|null>`:**
  - `fin:<id>` → that ledger;
  - a channel code → its map;
  - `cash` → the CASH map;
  - `null` → `channelCode`'s map.
- **Many Tally ledgers onto one staff ledger (§7.9):** several Tally rows may match one Finance ledger when that ledger holds the `staff_advances` or `staff_loans` role. `finBuildOpening` then writes one line for that ledger with their sum, and `finParallelRun` compares the sum. Every other ledger keeps SP1's one-to-one rule.
- **Routes:** `GET /finance/hr-setup?book=` (view), `PUT /finance/hr-setup` (admin), `POST /finance/hr-setup/ledgers` `{ book_id }` (admin).

- [ ] **Step 1: Write the failing database tests.**
  - `ensure staff ledgers creates the five once (a second call creates none), the four staff ledgers manual_entry false, MD's Account true, and sets the roles`.
  - `a channel mapped to a non-bank ledger is refused FIN_BAD_INPUT`.
  - `payroll_booking reads month_end and saves when_paid`.
  - `paid-from options list office cash, Holder A and the mapped bank, and each resolves back to its ledger`.
  - `an accountant or viewer saving HR setup gets 403 FIN_FORBIDDEN`.
  - `two Tally rows matched to Staff Advances build one opening line with their sum, and the parallel run shows one row with that sum; two rows on any other ledger are still refused`.
- [ ] **Step 2: Run it to make sure it fails.** Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-hr-setup.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 10: The HR feed, part 1: money given and paid

**Files:**
- Create:
  - `server/src/finance-hr-feed.js`
  - `server/src/finance-hr-fixtures.js` (test-only, imported only by tests). It inserts invented `hr.people`, `hr.pay_channels`, runs, lines, batches, advances, loans and sheets through SQL, with names like "Test Person A".
- Modify: `server/src/finance-vouchers.js`: `finReverseVoucher(qc, oc, id, actor, { date, reason, fromHr = false })` refuses `FIN_HR_OWNED` for a source starting `hr_` unless `fromHr`.
- Test: `server/src/finance-pg-hr-feed.test.js`

**Interfaces:**
- Consumes: Task 9's `finResolvePaidFrom` and roles; SP1's `finCreateBuiltDraft` (with Task 6's source fields), `finVoucherCtx`, `finPostLocked` and `finApproverIds`.
- Produces:
  - **The source keys:** `FIN_HR_SOURCES = Object.freeze({ advance: 'hr_advance', sheet: 'hr_sheet', loan: 'hr_loan', prepay: 'hr_prepay', sheetAdvances: 'hr_sheet_adv', batch: 'hr_batch', line: 'hr_line_pay', run: 'hr_run', waiver: 'hr_waiver', hidden: 'hr_hidden', intercompany: 'hr_ic' })`.
    - A voucher in the DP book uses `<key>:DP`. For example, `hr_run:DP` keeps H8's one-live-per-source unique.
  - **`finHrPost(event: { type, id }, who: { id, name, hrLevel }): Promise<{ result: 'posted'|'submitted'|'skipped'|'exception', voucher_id?, reason_code? }>`:**
    - It never throws: an error becomes an upsert of `fin_hr_exceptions` on `(source_type, source_id)`.
    - `voucher_date < books_begin` → `skipped`, reason `before_books`, and no exception.
  - **`finHrAfter(req, events): Promise<void>`:** runs `finHrPost` for each event in turn, after HR's commit. It swallows everything and logs the code only.
  - **`finHrVoucherFor(qc, event): Promise<{ skip?, book_id, voucher_type, voucher_date, narration, reference, lines, source_type, source_id, hr_approved_by: { id, name }|null }>`** (exported for tests).
- **The events in this task** (§7.2 rows):
  - `advance`: an `hr.advance_txns` row with kind `given` and a manual source.
  - `sheet`: a posted `hr.advance_sheets` row.
  - `loan`: an `hr.loans` row, its disbursal.
  - `prepay`: an `hr.loan_txns` row with kind `prepayment` (a receipt).
  - `batch`: a confirmed `hr.payment_batches` row.
  - `line`: a run line marked paid without a batch.
  - `waiver`: an `hr.advance_txns` row with kind `waived`.
- **The account:** `finResolvePaidFrom(row.paid_via ?? row.paid_from, channel)`. If it is null, the event becomes an exception with `FIN_UNMAPPED_CHANNEL`.
- **Approval (§7.6):**
  - `hr_approved_by` is set for a batch or line (the line's per-person approver), a sheet (the deciding approver), and a waiver (its approver).
  - For an advance, loan or prepay it is set only when `who.hrLevel` is at least `approver`.
  - **Posting:**
    - No approval needed → `finPostLocked(… { approvedBy: null })`.
    - Approval needed and `hr_approved_by` set → `finPostLocked(… { approvedBy: hr_approved_by })`.
    - Otherwise the voucher is left `submitted` and the Approvers are notified, as `finSubmitVoucher` does.
  - **The actor** is `{ id: who.id, name: `${who.name} (HR)`, roles: ['accountant'] }`.
- **Hidden people:** paid lines whose person appears in `hr.access_hidden` (for any login) are left out of a batch or line voucher. Task 11 posts them.

- [ ] **Step 1: Write the failing database tests**, using the fixtures. The CASH channel maps to Office cash, and COLOUR to Bank – current.
  - `an advance given in cash posts Dr Staff Advances / Cr Office cash, narrated "Advance · Pay staff · 1 person"`.
  - `an advance paid from fin:<Holder A> credits Holder A`.
  - `a confirmed CASH batch of 9 lines posts Dr Salary Payable / Cr Office cash, narrated "Salary Jan · cash · CI-PAY-0001 · 9 people"`.
  - `a loan prepayment posts a receipt Dr Office cash / Cr Staff Loans`.
  - `the same event posted twice leaves one live voucher (H8)`.
  - `an unmapped channel makes an exception FIN_UNMAPPED_CHANNEL; after mapping, a second finHrPost posts it and marks it resolved`.
  - `an event dated 2026-12-30 is skipped as before_books, with no exception`.
  - `a ₹1,50,000 advance by an accounts-level login waits for md; by md it posts`.
  - `a batch whose lines md approved posts with approved_by = md though it is over ₹1,00,000`.
  - `with Jan 2027 locked the event becomes an exception and the HR rows are unchanged (Review Focus 4)`.
  - `reversing an hr_ voucher by hand is refused FIN_HR_OWNED (Review Focus 5)`.
  - `privacy: no hr.people name appears in any fin_vouchers narration, fin_voucher_lines narration, or fin_audit_log before/after written by the feed`.
- [ ] **Step 2: Run it to make sure it fails.** Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-hr-feed.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the builders, `finHrPost` and `finHrAfter`.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 11: The HR feed, part 2: the payroll month, reversals, hidden people, the Darbi pair

**Files:**
- Modify: `server/src/finance-hr-feed.js`
- Test: `server/src/finance-pg-hr-payroll.test.js`

**Interfaces:**
- Produces:
  - **`finHrRunLines(qc, runId, bookId): Promise<Line[]>`:** the payroll month's journal from HR's line fields, totals only.
    - **Dr** gross. It is split by `fin_hr_expense_map`: `type:<person type>` first, then `dept:<department>`, else the `salary_expense` role.
    - **Cr** `staff_advances` Σ `advance_recovery`; **Cr** `staff_loans` Σ `loan_recovery`; **Cr** `other_deductions` Σ (`misc_deduction` + `adj_deductions`); **Cr** `md_account` Σ `paid_separately`; **Cr** `salary_payable` Σ `payable`.
    - Any non-zero remainder from HR's rupee rounding goes to the `rounding` role. When the remainder is non-zero and no rounding role is set → `FIN_ROLE_MISSING`.
    - A role a non-zero line needs that is unset → `FIN_ROLE_MISSING`.
  - **`finHrReverse(qc, oc, sourceType, sourceId, who): Promise<{ result }>`:**
    - It reverses the live voucher of that source with `fromHr: true`, dated today.
    - It posts straight away when `who` is an HR approver (passing `approvedBy`). Otherwise it is submitted under the `reversal` rule.
    - While it waits, the corrected entry for the same source waits too (H8) and is counted under "HR entries waiting".
- **Events in this task:**
  - **`run`** (finalise):
    - With `payroll_booking = 'month_end'`, it is dated the run month's last day.
    - With `when_paid`, it is dated the `paid_on` of the run's first confirmed batch. Until one exists it is `skipped`, reason `awaiting_first_payment`.
  - **`sheetAdvances`** (finalise): one payment, Dr `staff_advances` / Cr the CASH channel's account, dated the finalise day.
  - **Un-finalise:** `finHrReverse` for `run` and `sheetAdvances`.
  - **A line marked failed or reversed inside a batch:** `finHrReverse` for the batch, then the batch posted again for its still-paid lines.
  - **A cancelled loan, or an advance with `reverses_id`:** `finHrReverse` for that source.
- **Firm → book:** a run with people in both books gives one journal per book.
- **Hidden people:**
  - One payment per (account, calendar month): Dr `salary_payable` / Cr the account, dated that month's last such payout.
  - `source_type = 'hr_hidden:<ledger_id>'` and `source_id = YYYYMM`, narrated `Salary · combined · N people`.
  - It posts only once that month has ended: at Bring-in, or at the first later HR event.
- **The Darbi pair:**
  - **When:** the resolved account's book differs from the payroll book.
  - **In the payroll book:** Dr `salary_payable` / Cr the `intercompany` role ledger, with source `hr_batch`.
  - **In the account's book:** Dr its `intercompany` role ledger / Cr the bank, with source `hr_ic`. Both use the batch id and the narrations in Global Constraints.

- [ ] **Step 1: Write the failing database tests**, using the fixtures. The run is for January 2027: 52 lines, invented gross, recoveries, deductions and paid-separately amounts.
  - `finalise posts "Payroll Jan 2027 · 52 people" dated 2027-01-31; debits = credits; MD's Account is credited with Σ paid_separately; Salary Payable with Σ payable`.
  - `with when_paid the journal is skipped until the first batch, then dated its paid_on`.
  - `advances on the payroll sheet post at finalise from the CASH account, narrated "Advances on the Jan payroll sheet · N people"`.
  - `un-finalise by the accounts login submits the reversal for md, and the re-finalised journal waits behind it; by md it reverses at once`.
  - `a line marked failed in a batch reverses the batch voucher and posts it again for the remaining people`.
  - `payouts to two hidden people in January post nothing until February; then one "Salary · combined · 2 people" dated the last of those payouts`.
  - `a DARBI batch for Colour staff posts the pair: CI Dr Salary Payable / Cr Darbi Print Pack; DP Dr Colour Impressions / Cr the DP bank`.
  - `a person with no firm books to CI`.
  - `a contractor mapped 'type:Contractor' → Contract Labour has its gross there`.
  - `a missing other_deductions role with non-zero deductions makes an exception FIN_ROLE_MISSING`.
- [ ] **Step 2: Run it to make sure it fails.** Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-hr-payroll.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it, plus Task 10's test.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 12: HR wiring: paid-from choices, and the call after commit

**Files:**
- Modify:
  - `server/src/routes/hr-ledgers.js`: `POST /hr/staff-payments`, `/hr/advances`, `/hr/loans`, `/hr/loans/:id/prepay`, `/hr/loans/:id/cancel`, `/hr/advances/:personId/waive` and `/hr/advance-sheets/:id/post`; plus a new `GET /hr/paid-from-options` (`requireHr('accounts')`, answering `{ options }` from `finPaidFromOptions`).
  - `server/src/routes/hr-payroll.js`: `POST /hr/runs/:month/payments`, `PUT /hr/runs/:month/lines/:personId/payment`, `POST /hr/runs/:month/finalise` and `/unfinalise`.
  - `client/src/lib/hr.js`: `paidFromOptions: () => api.get('/hr/paid-from-options')`.
  - The HR screens: `client/src/pages/hr/PayStaffModal.jsx`, `BulkAdvances.jsx`, `LoansAdvances.jsx` (Give advance, New loan, Prepay), `Payroll.jsx` (the batch Mark paid for the cash channel) and `RunLineDrawer.jsx` (Mark paid).
  - `client/src/lib/writeOnce.js`, for any HR route `mint-routes-join-once.test.js` now reports.
- Create: `client/src/pages/hr/PaidFromSelect.jsx`. Its props are `{ value, onChange, channelCode, required }`. It loads the options once and shows the labels.
- Test: `server/src/hr-finance-wiring.test.js` (source scan) and `server/src/finance-pg-hr-wiring.test.js`.

**Rules:**
- **Validating the code:** each route takes `paid_via` (or `paid_from`) and accepts only `cash`, a pay channel code, or a `fin:<id>` that is among `finPaidFromOptions`. Anything else is a 400 with "Choose where it was paid from". New loans therefore no longer take free text. Old loans keep theirs.
- **Storing it:** in the Task 3 columns, and on `hr.loans.paid_via` for a new loan.
- **After the tx commits:** `await finHrAfter(req, [{ type, id }, …])`, with the HR response sent after it.

- [ ] **Step 1: Write the failing tests.**
  - **Source scan:** each route above contains `finHrAfter(req,` after its `await tx(` block; `PaidFromSelect` is used in each of the five screens.
  - **Database:**
    - `Pay staff with paid_via fin:<Holder A> stores it on hr.advance_txns.paid_via and Finance credits Holder A`.
    - `Give advance now stores paid_via`.
    - `New loan with free text is refused 400 "Choose where it was paid from"`.
    - `Mark paid (cash channel) with paid_from fin:<Holder A> stores it on the batch`.
    - `an HR request still answers 200 when the feed records an exception (unmapped channel)`.
    - `GET /hr/paid-from-options answers the accounts level and refuses a viewer`.
- [ ] **Step 2: Run them to make sure they fail.** Run: `cd server && node --test src/hr-finance-wiring.test.js && FINANCE_PG=1 node --test src/finance-pg-hr-wiring.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement the routes, then the screens.**
- [ ] **Step 4: Run them, plus HR's suites.** Run: `HR_PG=1 node --test src/hr-ledgers-routes-pg.test.js src/hr-payroll-routes-pg.test.js src/hr-privacy-pg.test.js`. Expected: PASS.
- [ ] **Step 5: Checkpoint**, including the client build.

### Task 13: Catch-up, exceptions and the control check

**Files:**
- Modify: `server/src/finance-hr-feed.js`, `server/src/routes/finance.js`, `client/src/lib/writeOnce.js`, and the isolation sweep.
- Test: `server/src/finance-pg-hr-catchup.test.js`

**Interfaces:**
- **`finHrPending(qc, bookId): Promise<{ type, id }[]>`:** HR events dated on or after `books_begin` that have no live voucher for their source and no open exception. Hidden-month events count once their month has ended.
- **`finBringInFromHr(bookId, who): Promise<{ posted, submitted, skipped, exceptions }>`**
- **`finHrControl(qc, bookId, asAt): Promise<{ advances: { finance_paise, hr_paise, gap_paise }, loans: { … }, salary_payable: { … } | null, matches }>`:**
  - `hr_paise` comes from HR's balance rules, summed over people: opening + given + adjustment − recovered − waived for advances, and the same for loans from `hr.loan_txns`.
  - `salary_payable` exists only with the `month_end` setting, and is null with `when_paid`. It compares Finance's Salary Payable as at `asAt` with Σ `payable` of the finalised runs' lines dated on or before `asAt` and not yet paid on `asAt` (§9.5).
  - `matches` is true when every gap present is 0.
- **Routes:**

  | Route | Capability | Notes |
  |---|---|---|
  | `GET /finance/hr/status?book=` | view | `{ waiting, exceptions, control }`, count-only |
  | `POST /finance/hr/bring-in` `{ book_id }` | enter | mints |
  | `GET /finance/hr/exceptions?book=` | view | |
  | `POST /finance/hr/exceptions/:id/retry` | enter | mints |

- [ ] **Step 1: Write the failing database tests.**
  - `an event the after-commit call missed shows as waiting 1; Bring in posts it once; waiting 0`.
  - `retry after mapping the channel posts the exception's event and sets resolved_at and voucher_id`.
  - `control matches after a month of advances and recoveries; an HR adjustment made with the feed switched off shows gap_paise equal to it`.
  - `as at 2026-12-31 with month_end, salary_payable's gap is December's payable still unpaid when the opening lacks it (§9.5); with when_paid it is null`.
  - `GET /finance/hr/status answers in under 2 KB`.
- [ ] **Step 2: Run it to make sure it fails.** Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-hr-catchup.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the two minting routes to `MINTING_POSTS`.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 14: The Cash & Bank page

**Files:**
- Create:
  - `client/src/pages/finance/CashBank.jsx`
  - `client/src/components/finance/CashTiles.jsx`, `CashBookTable.jsx`, `CashEntryForm.jsx`, `AdjustPanel.jsx`, `CashCountDialog.jsx` and `HrInbox.jsx`
- Modify:
  - `client/src/pages/finance/Finance.jsx`: `<Route path="cash/*" …>`.
  - `client/src/components/AppLayout.jsx`: in the Finance group, first, `{ label: 'Cash & Bank', to: '/finance/cash', icon: Wallet, roles: ['admin'], module: 'finance' }`, plus `SHORT_LABEL['/finance/cash'] = 'Cash'`.
- Test: `server/src/finance-cash-wiring.test.js` (source scans).

**Behaviour (spec §5, the sketches in §5 and §5.1):**
- **Tiles, the book and the header counts.** The header counts are unadjusted money, HR waiting and exceptions, and control.
- **Receive, Pay and Transfer:**
  - The keys `r`, `p` and `t` open them, when no input has focus.
  - Ctrl+Enter saves, Esc closes, and Clone repeats the last entry with the last-used date.
  - Amount fields use `finToPaiseTyped`.
- **`AdjustPanel` for a party:**
  - Its state starts `null`, so neither choice is pre-chosen.
  - It renders "Auto – oldest first" before "I'll pick".
  - Before saving it shows a preview from `/finance/allocations/preview`.
  - When nothing is open it reads "Nothing open".
- **Redo** works from a book row.
- **Holder shortcuts:** Give cash, Top up (only when `top_up_paise > 0`) and Return.
- **Count cash, with Clear.**
- **The staff note:** "Staff advances and salaries are paid in HR", with a link to `/hr` for a login with HR access.
- **Pending vouchers** show greyed, with their own subtotal.
- **Links in:** the query `?receive_customer=<id>` / `?pay_vendor=<id>` opens Receive or Pay with that party's ledger.
- **The From picker** lists customers first on Receive and vendors first on Pay, then every other ledger the entry type allows (§5.1).
- **Unadjusted money** opens the list from `/finance/cash/unadjusted`. Each item has Adjust (Auto or Pick, through `PUT /finance/lines/:id/allocations`).

- [ ] **Step 1: Write the failing source-scan tests:**
  - the nav item is the first Finance item;
  - the Finance route exists;
  - `CashBank` calls `useRealtimeRefresh(` with `FINANCE_TABLES`;
  - every `CashBookTable` column has `sortable: false`;
  - `CashEntryForm` handles `'r'`, `'p'`, `'t'` and `ctrlKey && key === 'Enter'`;
  - `AdjustPanel`'s state starts `useState(null)`, and "Auto – oldest first" precedes "I'll pick" in the source;
  - `CashEntryForm` imports `finToPaiseTyped`;
  - `CashBank` reads `/finance/cash/unadjusted` and offers Adjust;
  - nothing statically imports `exporter` or `exceljs`.
- [ ] **Step 2: Run it to make sure it fails.** Run: `cd server && node --test src/finance-cash-wiring.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**, following the ERP recipe (`PageHeader → KpiRow → Tabs → DataTable`, as `Vouchers.jsx` does).
- [ ] **Step 4: Run it**, then `npm run build -w client`. Expected: PASS, and exit 0.
- [ ] **Step 5: Checkpoint.**

### Task 15: Setup and report screens: HR & payroll, opening corrections, holder fields, the new rule's label, the party report

**Files:**
- Create:
  - `client/src/components/finance/HrSetup.jsx`: a new Setup tab, "HR & payroll". It holds the channel map, the ledger roles, the expense map, the payroll booking, and the "Create the staff ledgers" button.
  - `client/src/components/finance/OpeningCorrection.jsx`: on the Opening Balances page. It shows "Opening + corrections" for each ledger (Task 8's `by_ledger`) and the list of corrections, plus a form whose lines are picked with `LedgerPicker`.
  - `client/src/components/finance/PartyStatement.jsx`: a new Reports tab, "Party bills", fed by `/finance/reports/party`. It shows open items with their age, on-account credits, and the check against the ledger balance (§6.7).
- Modify:
  - `client/src/pages/finance/Setup.jsx`: the tab.
  - `client/src/pages/finance/Reports.jsx`: the "Party bills" tab.
  - `client/src/pages/finance/OpeningBalances.jsx`
  - `client/src/components/finance/LedgerForm.jsx`: holder name and float, shown only under Cash-in-Hand.
  - `client/src/components/finance/ApprovalRules.jsx`: the label "Cash count differences" for `cash_difference` is already in place (added in Task 7); keep it. Add a line under the Opening rule: "Opening corrections always need an Approver."
  - `client/src/lib/finance/opening.js` and `client/src/components/finance/OpeningMatch.jsx` (ruling R16): `finMatchView` lets several Tally rows map to ONE ledger when that ledger holds the `staff_advances` or `staff_loans` role. It reads the roles from `GET /finance/hr-setup` (Task 9). Every other ledger still refuses a second row, exactly as now. The server (Task 9's `finance-import.js`) already allows it.
  - `client/src/components/finance/VoucherDetail.jsx` (`ReverseDialog`): for a voucher with `is_opening_correction`, hide the date field and say "A correction is reversed on the opening day." The server ignores the date anyway (R15).
  - `client/src/pages/finance/OpeningBalances.jsx`: warn when draft corrections exist: "A draft correction is checked against the Opening that stands when it is submitted."
  - `client/src/lib/finance/setup.js` / `ActivityLog.jsx`: a plain label for the `hr_setup` activity ("HR & payroll setup changed").
- Test: extend `server/src/finance-cash-wiring.test.js`, and add the R16 case to `server/src/finance-opening-ui.test.js`.

- [ ] **Step 1: Write the failing source scans and tests:**
  - Setup lists "HR & payroll";
  - `HrSetup` posts to `/finance/hr-setup/ledgers`;
  - `OpeningCorrection` posts to `/finance/opening-corrections`;
  - `LedgerForm` shows `holder_name` only when the group is under Cash-in-Hand;
  - `ApprovalRules` maps `cash_difference` to "Cash count differences" and says opening corrections always need an Approver;
  - Reports lists "Party bills", and `PartyStatement` reads `/finance/reports/party`;
  - `finance-opening-ui.test.js`: `finMatchView` accepts two Tally rows on a ledger with role `staff_advances` (and on one with `staff_loans`), and still refuses two rows on an ordinary ledger;
  - `ReverseDialog` hides the date input when `is_opening_correction` is true;
  - `ActivityLog` has a label for `hr_setup`.
- [ ] **Step 2: Run it to make sure it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it**, then `npm run build -w client`. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 16: The ERP's doors: Record Payment, Accounts tabs, vendor payment numbers

**Files:**
- Modify:
  - `server/src/routes/accounts.js:25`: `const PAY_PREFIX = 'CI-VP-';`
  - `client/src/pages/Invoices.jsx`: the Record Payment button.
  - `client/src/components/AccountsBooks.jsx`: the Cash & Bank Book, Party Ledger and Payables tabs, and the vendor-payment button.
- Test: `server/src/finance-erp-doors.test.js` (source scans), plus one `FINANCE_PG` case.

**Behaviour:**
- **The switch date:** the page reads `/finance/cash/switch` once.
- **On or after that date:**
  - Record Payment navigates to `/finance/cash?receive_customer=<customer_id>` for a login holding an Accountant or Approver grant on the invoice's book (looked up by its billing entity). Any other login sees "Receipts are recorded in Finance".
  - The three Accounts tabs show "These books are kept in Finance from 1 January 2027" with a link to `/finance/cash`.
  - The vendor-payment button navigates to `/finance/cash?pay_vendor=<vendor_id>`.
- **Before the date:** everything behaves exactly as today.

- [ ] **Step 1: Write the failing tests:**
  - `POST /vendor-payments numbers the first one CI-VP-0001 while HR batches hold CI-PAY-0001…` (`FINANCE_PG`);
  - the source scans for `'/finance/cash/switch'`, "Receipts are recorded in Finance" and the two query links.
- [ ] **Step 2: Run them to make sure they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them**, then `npm run build -w client`. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 17: Whole-branch verification and the walkthrough with invented data

**Files:**
- Modify: `server/finance-dev.mjs`, which gains `--cash-demo`. It seeds, all invented:
  - a CI Opening with a customer and two bills plus a lump;
  - Office cash, Holder A and Bank – current;
  - the HR channels mapped;
  - the staff ledgers ensured;
  - five Test People with one January run;
  - an advance sheet;
  - two batches.
- Test: the suites below, then the browser.

- [ ] **Step 1: Run everything.**
  - `cd server && npm test`: no failures beyond the baseline.
  - `FINANCE_PG=1 node --test src/finance-pg-*.test.js`
  - `HR_PG=1 node --test src/hr-*pg*.test.js`
  - `npm run build -w client`
  - `npm run db:baseline -- --check`

  Expected: all pass, and exit 0.
- [ ] **Step 2: Privacy and leak checks.**
  - `git diff origin/main | grep -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' | sort -u` lists only invented addresses (`@fin.test`, `@fin.dev`) and `md@motionci.com`, which is already public.
  - Every person or holder name added on this branch is invented: run `git diff origin/main --stat`, then read the fixtures, the seed and the tests.
- [ ] **Step 3: Payload sizes.**
  - With the demo plus 2,000 generated cash lines in one month, `GET /finance/cash/book` stays under 300 KB.
  - `GET /finance/cash/accounts` and `/finance/hr/status` each stay under 5 KB.
- [ ] **Step 4: The browser walkthrough.**
  - Start `node server/finance-dev.mjs --cash-demo` and open the Cash & Bank page as `acct@fin.dev`.
  - Walk through:
    1. the tiles and book;
    2. Receive ₹80,000 with TDS ₹1,600 by Auto (the §5.1 sketch);
    3. Pick on a second receipt;
    4. Pay ₹1,50,000, which waits, then approve it as `md@fin.dev`;
    5. Give cash to Holder A and Top up;
    6. Count with a ₹300 shortage, Clear it, and see it wait;
    7. HR Bring in;
    8. an opening correction;
    9. Redo a receipt;
    10. the keyboard: R, P, T and Ctrl+Enter.
  - Screenshot the page.
- [ ] **Step 5: Checkpoint.** Note every command run and its result in the build ledger.
