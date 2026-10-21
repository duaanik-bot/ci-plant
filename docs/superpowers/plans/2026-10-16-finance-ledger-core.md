# Finance Ledger Core (SP1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build sub-project 1 of Finance inside the CI ERP without changing any existing behaviour. It covers:
- books, and a Tally-style chart of accounts;
- the voucher lifecycle, with database-enforced hard stops;
- Finance access and an audit trail;
- trial balance, ledger statement and journal register;
- Tally opening-balance import, and the parallel-run report.

**Architecture:**
- **Database:** new `fin_*` tables, from one additive migration that `init()` replays locally.
- **Server:** one Express router, `server/src/routes/finance.js`, over flat `server/src/finance-*.js` modules.
- **Client:** a lazy `/finance/*` page group in React.
- **Shared helpers:** pure money, date and Tally-cell helpers live once, in `client/src/lib/finance/`. The server imports them with literal static imports, the same way `access.js` imports `client/src/modules.js`.
- **API:** amounts are integer paise.

**Tech Stack:** Node 24 ESM, Express 4, node-postgres, PostgreSQL 17 (embedded locally, Supabase in production), PL/pgSQL triggers, React 18 + Vite + Tailwind, `node:test`, ExcelJS (already a client dependency).

**Spec:** `docs/superpowers/specs/2026-10-16-finance-ledger-core-design.md`. Read it first. This plan cites its sections as §n and does not repeat its tables.

**Session rule:** no `git commit`, `git push`, deploy, or production migration. Where a TDD cycle would commit, this plan runs the suite instead ("Checkpoint").

## Global Constraints

**Where to work, and what not to touch**
- Work only in the worktree `~/Documents/CI ERP FInal/ci-erp-finance` (branch `feat/finance-ledger-core`). Never edit, check out or revert anything in the shared tree `~/Documents/CI ERP FInal/ci-erp`.
- **Additive only** (spec §2.3): new `fin_*` tables and new files.
  - The only edits to existing files are the seven in spec §12.
  - No existing table gains a column, constraint, trigger, index or FK.
- **No FK from a `fin_*` table to an existing ERP table** (spec §2.4). ERP ids (`billing_entity_id`, `party_id`, `user_id`) are stored bare.

**Money and dates**
- **Money:** `NUMERIC(18,2)` in the database, integer paise everywhere in JS and in every API field (fields end in `_paise`).
  - Do sums in SQL.
  - Turn pool floats into paise with `finToPaise()` (Task 1). That helper is `Math.round(v * 100)`.
- **Dates:** `'YYYY-MM-DD'` TEXT with a format CHECK. Today is `plantDateStr()`. Never use `toISOString().slice(0,10)` or `now()::date` in `routes/`.

**Numbering and transactions**
- **Voucher numbers:** `<BOOK>-<CODE>-<FYshort>-NNNN` (e.g. `CI-JV-2627-0001`), minted by `nextNumber(prefix, 'fin_vouchers', 'number', oc)`.
  - In any transaction that may post, `lockDocNumber(prefix, oc)` is taken **before** any row lock (spec §7.4).
- **Inside `tx((qc, oc) => …)`:**
  - Use only `qc` / `oc`, never `q` / `one`. The pool is one client on Vercel.
  - No network I/O. `notify()` defers its own push.

**Server code rules**
- **Routes:**
  - Written `r.<verb>('/finance/…'` at column 0, single-quoted.
  - The handler is inline: `async (req, res, next) => { try { … } catch (e) { next(e); } }`. This is how `mint-routes-join-once.test.js` reads them.
- **Errors:**
  - Build them with `finError()` (Task 6), which produces `Object.assign(new Error(sentence), { status, body: { code, … } })`. Structured fields go only inside `body`.
  - Optional text goes through `optionalText()`, never `String(req.body.x)`.
- **Naming:**
  - Never use `kind:` as a property name in `routes/finance.js`; the notification test reads it as a notification kind.
  - Never name anything `coa`; that means Certificate of Analysis in this codebase.
  - Prefix every exported function in `server/src/finance-*.js` with `fin`. The minting scan matches calls by bare function name across every server file.
  - The migration file is `supabase/migrations/<UTC timestamp>_finance_ledger_core.sql`. The timestamp must sort after the newest migration in the repo, `20261006190000`.

**Client code rules**
- No static import of `lib/exporter.js` or `exceljs`; load either on click.
- Storage only through `lib/safeStorage.js`.
- Every portal or fixed-position element carries `data-ci-overlay` or `data-ci-chrome`.
- Running-balance tables set `sortable: false` on every column.

**Defaults pinned by the spec**
- **Setup** (spec §16 step 6):
  - Books: `CI` = billing entity named "Colour Impressions"; `DP` = "Darbi Print Pack".
  - `books_begin = '2027-01-01'`.
  - Grants, on both books: `md@motionci.com` gets `['approver','admin']`; the Accounts login (its email is set at go-live) gets `['accountant']`.
- **Approval rules** (spec §6.8):
  - `always`: journal, opening, reversal, credit_note, debit_note.
  - `above_limit` at 10,000,000 paise (₹1,00,000): payment, contra.
  - `never`: receipt, sales, purchase.

## Review Focus

1. **Amounts a person really types.** Inputs to handle: `1,20,000`, `1,20,000.50`, `10.005`, `-50`, blank, `1e5`, a 15-digit number. Typed entry refuses with a sentence and never rounds silently. Tested in Task 1 (`finToPaiseTyped`) and Task 8 (the API refuses a fractional or negative `debit_paise`).
2. **Tally cells as Tally exports them.** Inputs: `1,23,456.00 Dr`, `1,23,456.00 Cr`, `(1,234.00)`, `-1,234.00`, `₹ 12,000`, blank. Each parses to exact signed paise. Tested in Task 1 (`finParseTallyAmount`).
3. **Dates at the edges.**
   - 31 Mar and 1 Apr fall in different number series.
   - A date with no financial year created yet gets an "add it in Setup" refusal, never a 500.
   - `2027-02-29`, `2027-13-01` and `27-01-05` are refused.

   Tested in Task 1 (`finIsValidDate`) and Task 9 (`FIN_NO_PERIOD`, financial-year-boundary numbering).
4. **Two people on one voucher.** The maker edits after submitting; the approver approves twice; an approve after a reject; approving your own entry. Tested in Task 9.
5. **One-book logins.** A login with CI access only never sees DP data through any list, report, activity row, ledger picker or voucher id. Tested in Tasks 6 and 11.

## Conventions used in this plan

- All paths are relative to the worktree root.
- **Unit tests:** `cd server && node --test src/<file>.test.js`.
- **Real-database tests:** `cd server && FINANCE_PG=1 node --test src/<file>.test.js`. Each one boots its own throwaway Postgres through `finBootPg()` (Task 4).
- **Checkpoint** means: run the task's tests, then the full unit suite (`cd server && npm test`). Both must pass. There is no commit.
- **The API speaks integer paise and `'YYYY-MM-DD'` dates.** Responses wrap lists, e.g. `{ vouchers: [...] }`.

## File map

| File | Responsibility |
|---|---|
| `client/src/lib/finance/money.js` | Paise from database floats, typed text and Tally cells; paise to NUMERIC text and to ₹ display (pure) |
| `client/src/lib/finance/fy.js` | Calendar-date validity, Indian financial year, months, day-before (pure) |
| `client/src/lib/finance/tables.js` | `FINANCE_TABLES` for realtime refresh |
| `server/src/finance-rules.js` | Voucher types and codes, number prefix, approval decision, balance and shape checks, capability matrix (pure) |
| `server/src/finance-groups.js` | Tally group template, system ledgers, bank/cash groups (pure data) |
| `supabase/migrations/<ts>_finance_ledger_core.sql` | All `fin_*` tables, indexes, hard-stop triggers, realtime pings |
| `server/src/finance-pg-harness.js` | `finBootPg()`: throwaway Postgres + app + test users, for `FINANCE_PG` tests |
| `server/src/finance-setup.js` | `finSetupBooks()`: books, years, groups, system ledgers, rules, grants (idempotent) |
| `scripts/finance-setup.mjs` | Dry-run / `--apply` wrapper around `finSetupBooks` |
| `server/src/finance-errors.js` | `finError`, `finMapDbError` (Postgres error → 409 sentence) |
| `server/src/finance-access.js` | Grant lookup with a 10 s cache, `finRequire`, approver ids |
| `server/src/finance-audit.js` | `finAudit()`: one append-only audit row |
| `server/src/finance-masters.js` | Groups, ledgers, years, period transitions |
| `server/src/finance-vouchers.js` | Drafts, submit, approve, reject, discard, reverse, the posting transaction |
| `server/src/finance-reports.js` | Trial balance, ledger statement, journal register, self-approved, activity, parallel run |
| `server/src/finance-import.js` | Import storage, matching proposals, tie-out, build Opening |
| `server/src/routes/finance.js` | The one router: every `/finance/*` route |
| `server/finance-dev.mjs` | Local walkthrough server (embedded Postgres + API); never shipped |
| `client/src/pages/finance/*.jsx` | `Finance.jsx` shell; `Vouchers`, `Reports`, `Setup`, `OpeningBalances`, `VoucherPrint` pages |
| `client/src/components/finance/*.jsx` | `BookSwitch`, `LedgerPicker`, `VoucherForm`, `VoucherDetail`, report tables, setup panels, `TallyUpload` |

**Shared edits, the complete list (spec §12):**
- `client/src/modules.js`
- `client/src/App.jsx`
- `client/src/components/AppLayout.jsx`
- `server/src/app.js`
- `server/src/db.js`
- `client/src/lib/writeOnce.js`
- `server/src/notify-categories.js`

---

### Task 1: Shared money, date and Tally-cell helpers

**Files:**
- Create: `client/src/lib/finance/money.js`, `client/src/lib/finance/fy.js`
- Test: `server/src/finance-money.test.js`

**Interfaces:**
- Produces, in `money.js`:
  - `finToPaise(v: number|string|null) → number`
  - `finToPaiseTyped(text: string) → number`. Throws `Error` whose message contains "amount".
  - `finFromPaise(p: number) → string`
  - `finFormatINR(p: number, { drcr = false } = {}) → string`
  - `finParseTallyAmount(cell: string|number|null) → number` (signed paise)
  - `FIN_MAX_PAISE = 1e14`
- Produces, in `fy.js`:
  - `finIsValidDate(s) → boolean`
  - `finFyOf(date) → { label, short, start, end }`
  - `finMonthsOfFy(label) → Array<{ month_no, label, start_date, end_date }>`
  - `finDayBefore(date) → string`

- [ ] **Step 1: Prepare the worktree.**
  Run: `npm install` at the worktree root, then `npm run verify`.
  Expected: install completes. Verify exits 0 with the existing suite green. This is the baseline; record the pass count. A fresh worktree has no `node_modules`, so tests fail with `ERR_MODULE_NOT_FOUND` until the install runs.

- [ ] **Step 2: Write the failing test** in `server/src/finance-money.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finToPaise, finToPaiseTyped, finFromPaise, finFormatINR, finParseTallyAmount } from '../../client/src/lib/finance/money.js';
import { finIsValidDate, finFyOf, finMonthsOfFy, finDayBefore } from '../../client/src/lib/finance/fy.js';

test('database floats become exact paise', () => {
  assert.equal(finToPaise(1234.56), 123456);
  assert.equal(finToPaise(0.1 + 0.2), 30);
  assert.equal(finToPaise('99999999.99'), 9999999999);
  assert.equal(finToPaise(-12.5), -1250);
  assert.equal(finToPaise(null), 0);
});

test('typed amounts: Indian or Western commas, at most two decimals, never negative', () => {
  assert.equal(finToPaiseTyped('1,20,000'), 12000000);
  assert.equal(finToPaiseTyped('1,20,000.50'), 12000050);
  assert.equal(finToPaiseTyped('120,000.5'), 12000050);
  assert.equal(finToPaiseTyped(' 75 '), 7500);
  assert.equal(finToPaiseTyped('0'), 0);
  for (const bad of ['', '  ', '10.005', '-50', 'abc', '1e5', '12..5', '100000000000000'])
    assert.throws(() => finToPaiseTyped(bad), /amount/i, `should refuse ${JSON.stringify(bad)}`);
});

test('paise back to NUMERIC text and to rupees on screen', () => {
  assert.equal(finFromPaise(123450), '1234.50');
  assert.equal(finFromPaise(-5), '-0.05');
  assert.equal(finFromPaise(0), '0.00');
  assert.equal(finFormatINR(12345600), '₹1,23,456.00');
  assert.equal(finFormatINR(1234567890123), '₹12,34,56,78,901.23');
  assert.equal(finFormatINR(-12345600, { drcr: true }), '₹1,23,456.00 Cr');
  assert.equal(finFormatINR(5, { drcr: true }), '₹0.05 Dr');
  assert.equal(finFormatINR(0, { drcr: true }), '₹0.00');
});

test('Tally cells parse to signed paise', () => {
  assert.equal(finParseTallyAmount('1,23,456.00 Dr'), 12345600);
  assert.equal(finParseTallyAmount('1,23,456.00 Cr'), -12345600);
  assert.equal(finParseTallyAmount('(1,234.00)'), -123400);
  assert.equal(finParseTallyAmount('-1,234.00'), -123400);
  assert.equal(finParseTallyAmount('₹ 12,000'), 1200000);
  assert.equal(finParseTallyAmount(1500.5), 150050);
  assert.equal(finParseTallyAmount(''), 0);
  assert.equal(finParseTallyAmount(null), 0);
  assert.throws(() => finParseTallyAmount('twelve'), /amount/i);
});

test('calendar dates and the Indian financial year', () => {
  assert.ok(finIsValidDate('2027-02-28'));
  assert.ok(finIsValidDate('2028-02-29'));
  for (const bad of ['2027-02-29', '2027-13-01', '27-01-05', '2027-1-5', '', null])
    assert.ok(!finIsValidDate(bad), String(bad));
  assert.deepEqual(finFyOf('2027-03-31'), { label: '2026-27', short: '2627', start: '2026-04-01', end: '2027-03-31' });
  assert.deepEqual(finFyOf('2027-04-01'), { label: '2027-28', short: '2728', start: '2027-04-01', end: '2028-03-31' });
  const m = finMonthsOfFy('2026-27');
  assert.equal(m.length, 12);
  assert.deepEqual(m[0], { month_no: 1, label: 'Apr 2026', start_date: '2026-04-01', end_date: '2026-04-30' });
  assert.deepEqual(m[10], { month_no: 11, label: 'Feb 2027', start_date: '2027-02-01', end_date: '2027-02-28' });
  assert.equal(finDayBefore('2027-01-01'), '2026-12-31');
  assert.equal(finDayBefore('2028-03-01'), '2028-02-29');
});
```

- [ ] **Step 3: Run it.**
  Run: `cd server && node --test src/finance-money.test.js`
  Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `client/src/lib/finance/money.js`.

- [ ] **Step 4: Implement both modules.** They are pure ESM: no React, no DOM, and `.js` extensions on any relative import.
  - **Formatting:** split the paise into integer rupees and two paise digits using integer arithmetic. Format the rupee part with `new Intl.NumberFormat('en-IN')`. Never divide paise by 100 as a float for display.
  - **Typed amounts:**
    - Trim surrounding spaces. Accept only an unbroken digit run, Western grouping `\d{1,3}(,\d{3})+`, or Indian grouping
      `\d{1,2}(,\d{2})+,\d{3}`, then an optional `.d`/`.dd`. Strip commas only after that match (amended after Task 1's review,
      Ruling R10).
    - Refuse anything at or above `FIN_MAX_PAISE`.
    - Every refusal message reads `Enter an amount in rupees with at most two decimals`.
  - **Tally cells:** strip `₹`, spaces and commas. A trailing `Dr` means positive and `Cr` means negative. Parentheses or a leading `-` mean negative.
  - **Dates:** do all date arithmetic with `Date.UTC`, so the local timezone never shifts a day.

- [ ] **Step 5: Run it.**
  Run: `cd server && node --test src/finance-money.test.js`
  Expected: PASS (5 tests).

- [ ] **Step 6: Checkpoint.** Run `cd server && npm test`. Expected: the baseline count from Step 1, plus 5, all passing.

---

### Task 2: Rules and the Tally group template (pure)

**Files:**
- Create: `server/src/finance-rules.js`, `server/src/finance-groups.js`
- Test: `server/src/finance-rules.test.js`, `server/src/finance-groups.test.js`

**Interfaces:**
- Consumes: `finFormatINR` (Task 1).
- Produces:
  - `FIN_VOUCHER_TYPES`: a frozen map from type to `{ code, label, manual }`.

    | Type | Code | Label | Manual |
    |---|---|---|---|
    | journal | JV | Journal | true |
    | receipt | RV | Receipt | true |
    | payment | PV | Payment | true |
    | contra | CV | Contra | true |
    | opening | OB | Opening | false |
    | sales | SV | Sales | false |
    | purchase | PU | Purchase | false |
    | credit_note | CN | Credit Note | false |
    | debit_note | DN | Debit Note | false |

  - `FIN_DEFAULT_RULES: Array<{ rule_key, mode, limit_paise }>` — 10 rows.
  - `finPrefix(bookCode, type, fyShort) → string`
  - `finNeedsApproval({ mode, limit_paise, total_paise, period_status }) → boolean`
  - `finBalanceProblem(lines) → null | { code, message }`
  - `finShapeProblem(type, lines, { isReversal = false } = {}) → null | { code: 'FIN_SHAPE', message }`
  - `FIN_ROLES = ['viewer','accountant','approver','admin']`
  - `finCan(roles: string[], cap: 'view'|'enter'|'ledger'|'approve'|'admin'|'import') → boolean`
  - In `finance-groups.js`:
    - `FIN_GROUP_TEMPLATE: Array<{ name, parent, nature, affects_gross_profit, sort_order }>`
    - `FIN_SYSTEM_LEDGERS = [{ name: 'Cash', group: 'Cash-in-Hand' }, { name: 'Profit & Loss A/c', group: 'Profit & Loss' }]`
    - `FIN_BANK_CASH_GROUPS = ['Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c']`

- [ ] **Step 1: Write the failing tests.**

`server/src/finance-rules.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finPrefix, finNeedsApproval, FIN_DEFAULT_RULES, finBalanceProblem, finShapeProblem, finCan } from './finance-rules.js';

test('voucher number prefix', () => {
  assert.equal(finPrefix('CI', 'journal', '2627'), 'CI-JV-2627-');
  assert.equal(finPrefix('DP', 'receipt', '2627'), 'DP-RV-2627-');
  assert.equal(finPrefix('CI', 'opening', '2627'), 'CI-OB-2627-');
  assert.throws(() => finPrefix('CI', 'nonsense', '2627'));
});

test('approval decision', () => {
  const L = 10000000;
  assert.equal(finNeedsApproval({ mode: 'always', total_paise: 1, period_status: 'open' }), true);
  assert.equal(finNeedsApproval({ mode: 'never', total_paise: 9e12, period_status: 'open' }), false);
  assert.equal(finNeedsApproval({ mode: 'above_limit', limit_paise: L, total_paise: L, period_status: 'open' }), false);
  assert.equal(finNeedsApproval({ mode: 'above_limit', limit_paise: L, total_paise: L + 1, period_status: 'open' }), true);
  assert.equal(finNeedsApproval({ mode: 'never', total_paise: 1, period_status: 'closing' }), true);
});

test('default rules are spec §6.8', () => {
  const by = Object.fromEntries(FIN_DEFAULT_RULES.map(r => [r.rule_key, r]));
  assert.equal(FIN_DEFAULT_RULES.length, 10);
  for (const k of ['journal', 'opening', 'reversal', 'credit_note', 'debit_note']) assert.equal(by[k].mode, 'always');
  for (const k of ['payment', 'contra']) assert.deepEqual([by[k].mode, by[k].limit_paise], ['above_limit', 10000000]);
  for (const k of ['receipt', 'sales', 'purchase']) assert.equal(by[k].mode, 'never');
});

test('balance problems carry the spec sentence', () => {
  const l = (d, c) => ({ debit_paise: d, credit_paise: c });
  assert.equal(finBalanceProblem([l(500, 0), l(0, 500)]), null);
  assert.equal(finBalanceProblem([l(500, 0)]).code, 'FIN_TOO_FEW_LINES');
  assert.equal(finBalanceProblem([l(0, 0), l(0, 0)]).code, 'FIN_BAD_LINE');
  assert.equal(finBalanceProblem([l(5, 5), l(0, 10)]).code, 'FIN_BAD_LINE');
  const u = finBalanceProblem([l(12000000, 0), l(0, 11800000)]);
  assert.equal(u.code, 'FIN_UNBALANCED');
  assert.equal(u.message, "Debits ₹1,20,000.00 and credits ₹1,18,000.00 don't match — difference ₹2,000.00.");
});

test('voucher shapes (spec §6.5)', () => {
  const b = (d, c) => ({ debit_paise: d, credit_paise: c, is_bank_cash: true });
  const o = (d, c) => ({ debit_paise: d, credit_paise: c, is_bank_cash: false });
  assert.equal(finShapeProblem('journal', [o(1, 0), o(0, 1)]), null);
  assert.equal(finShapeProblem('journal', [b(1, 0), o(0, 1)]).code, 'FIN_SHAPE');
  assert.equal(finShapeProblem('journal', [b(1, 0), o(0, 1)], { isReversal: true }), null);
  assert.equal(finShapeProblem('receipt', [b(1, 0), o(0, 1)]), null);
  assert.equal(finShapeProblem('receipt', [o(1, 0), b(0, 1)]).code, 'FIN_SHAPE');
  assert.equal(finShapeProblem('payment', [o(1, 0), b(0, 1)]), null);
  assert.equal(finShapeProblem('payment', [b(1, 0), o(0, 1)]).code, 'FIN_SHAPE');
  assert.equal(finShapeProblem('contra', [b(1, 0), b(0, 1)]), null);
  assert.equal(finShapeProblem('contra', [b(1, 0), o(0, 1)]).code, 'FIN_SHAPE');
  assert.equal(finShapeProblem('opening', [b(1, 0), o(0, 1)]), null);
});

test('capability matrix is spec §8.1', () => {
  assert.ok(finCan(['viewer'], 'view') && !finCan(['viewer'], 'enter'));
  assert.ok(finCan(['accountant'], 'enter') && finCan(['accountant'], 'ledger') && finCan(['accountant'], 'import'));
  assert.ok(!finCan(['accountant'], 'approve') && !finCan(['accountant'], 'admin'));
  assert.ok(finCan(['approver'], 'approve') && finCan(['approver'], 'enter') && !finCan(['approver'], 'ledger'));
  assert.ok(finCan(['admin'], 'admin') && finCan(['admin'], 'ledger') && finCan(['admin'], 'import') && !finCan(['admin'], 'enter'));
  assert.ok(finCan(['approver', 'admin'], 'ledger'));
  assert.ok(!finCan([], 'view'));
});
```

`server/src/finance-groups.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIN_GROUP_TEMPLATE, FIN_SYSTEM_LEDGERS, FIN_BANK_CASH_GROUPS } from './finance-groups.js';

test('Tally template: 15 primary + Profit & Loss + 13 sub-groups (spec §6.3)', () => {
  assert.equal(FIN_GROUP_TEMPLATE.length, 29);
  assert.equal(FIN_GROUP_TEMPLATE.filter(g => !g.parent).length, 16);
  const by = new Map(FIN_GROUP_TEMPLATE.map(g => [g.name, g]));
  for (const g of FIN_GROUP_TEMPLATE) if (g.parent) {
    assert.ok(by.has(g.parent), `${g.name} → ${g.parent}`);
    assert.equal(g.nature, by.get(g.parent).nature, `${g.name} inherits nature`);
  }
  assert.deepEqual(FIN_GROUP_TEMPLATE.filter(g => g.affects_gross_profit).map(g => g.name).sort(),
    ['Direct Expenses', 'Direct Incomes', 'Purchase Accounts', 'Sales Accounts']);
  assert.equal(by.get('Sundry Debtors').parent, 'Current Assets');
  assert.equal(by.get('Bank OD A/c').parent, 'Loans (Liability)');
  assert.equal(by.get('Profit & Loss').nature, 'liability');
  for (const n of FIN_BANK_CASH_GROUPS) assert.ok(by.has(n), n);
  for (const l of FIN_SYSTEM_LEDGERS) assert.ok(by.has(l.group), l.group);
});
```

- [ ] **Step 2: Run them.**
  Run: `cd server && node --test src/finance-rules.test.js src/finance-groups.test.js`
  Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement both modules from spec §6.3, §6.5, §6.8 and §8.1.**
  - The template names are exactly the spec's §6.3 table, with `parent` set to the primary group's name.
  - **Capabilities:**

    | Capability | Roles |
    |---|---|
    | view | viewer, accountant, approver, admin |
    | enter | accountant, approver |
    | ledger | accountant, admin |
    | import | accountant, admin |
    | approve | approver |
    | admin | admin |

  - **Shape messages:**
    - journal: "A journal can't use bank or cash ledgers — use a Payment, Receipt or Contra voucher."
    - receipt: "A receipt needs money coming into a bank or cash ledger."
    - payment: "A payment needs money going out of a bank or cash ledger."
    - contra: "A contra moves money between bank and cash ledgers only."

- [ ] **Step 4: Run them.** Same command. Expected: PASS (7 tests).

- [ ] **Step 5: Checkpoint.**

---

### Task 3: Schema migration, local replay, and the real-database test harness

**Files:**
- Create: `supabase/migrations/<ts>_finance_ledger_core.sql`. Get `<ts>` from `date -u +%Y%m%d%H%M%S` at build time.
- Create: `server/src/finance-pg-harness.js`.
- Modify: `server/src/db.js`. Append one line as the last statement of `init()`, directly after `await pool.query(migration('20261006180000_sales_order_drafts.sql'));`.
- Test: `server/src/finance-migration-pins.test.js`, `server/src/finance-pg-schema.test.js`.

**Interfaces:**
- Produces the tables of spec §6.1–§6.8, plus these names that later tasks map errors on:
  - **CHECK constraints**
    - `fin_voucher_lines_one_side`: one side positive, never both, never zero.
    - `fin_vouchers_posted_shape`: §6.6's posted ⇔ number/period/posted_at.
    - A `'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'` CHECK on every date column.
  - **Composite foreign keys**
    - `fin_ledgers_group_book_fk`: (group_id, book_id) → fin_groups(id, book_id).
    - `fin_voucher_lines_voucher_book_fk`: (voucher_id, book_id) → fin_vouchers(id, book_id).
    - `fin_voucher_lines_ledger_book_fk`: (ledger_id, book_id) → fin_ledgers(id, book_id).
    - These need `UNIQUE (id, book_id)` on fin_groups, fin_ledgers and fin_vouchers.
  - **Unique indexes**
    - `fin_groups_book_name_key` on (book_id, lower(name)).
    - `fin_ledgers_book_name_key` on (book_id, lower(name)).
    - `fin_ledgers_book_code_key` on (book_id, code), WHERE code IS NOT NULL.
    - `fin_ledgers_party_key` on (book_id, party_type, party_id), WHERE party_id IS NOT NULL.
    - `fin_vouchers_one_live_opening`, `fin_vouchers_one_live_source` and `fin_vouchers_one_reversal`, with exactly the predicates in spec §6.6.
    - `fin_access_user_book_key`, `fin_approval_rules_book_rule_key`, `fin_periods_book_start_key`, `fin_years_book_start_key`.
  - **Column uniques:** `fin_vouchers.number`, `fin_vouchers.client_key`, `fin_vouchers.reversed_by_id`.
  - **Extra import columns.** `fin_import_ledgers` also carries `group_id` (FK `fin_groups`), `party_type`, `party_id` and `is_party`. These hold the proposal for a `create` row (Task 13). Spec §6.8 leaves this detail implicit.
  - **Plain indexes**
    - `idx_fin_vouchers_book_date` on fin_vouchers (book_id, voucher_date, status).
    - `idx_fin_voucher_lines_ledger` on fin_voucher_lines (ledger_id).
    - `idx_fin_audit_book_at` on fin_audit_log (book_id, at).
    - `idx_fin_audit_entity` on fin_audit_log (entity, entity_id).
    - `idx_fk_<table>_<col>` for every remaining FK.
- Produces, from `finance-pg-harness.js`:
  - `FIN_TEST_USERS`: a frozen map from key to `{ email, role }`.

    | Key | Email | Plant role |
    |---|---|---|
    | md | md@fin.test | admin |
    | acct | acct@fin.test | admin |
    | appr2 | appr2@fin.test | planner |
    | viewer | viewer@fin.test | viewer |
    | dpOnly | dp@fin.test | admin |
    | plant | plant@fin.test | admin |

  - `FIN_TEST_GRANTS`: md → `['approver','admin']` on CI and DP; acct → `['accountant']` on CI and DP; appr2 → `['approver']` on CI; viewer → `['viewer']` on CI, with `can_export: false`; dpOnly → `['accountant']` on DP. plant gets nothing.
  - `finBootPg(label, { setup = true } = {}) → Promise<{ db, base, users, call, close }>`:
    - `users[key] = { id, token }`.
    - `call(method, url, body = null, who = 'md') → { status, body }`.
    - `close()` tears everything down.
    - When `setup` is true, it runs `finSetupBooks` (Task 4) with `FIN_TEST_GRANTS`, loaded by dynamic import so Task 3 does not need it.

- [ ] **Step 1: Write the failing static pins** in `server/src/finance-migration-pins.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(DIR).filter(f => f.endsWith('_finance_ledger_core.sql'));
const sql = files.length === 1 ? readFileSync(new URL(files[0], DIR), 'utf8') : '';
const FIN_TABLES = ['fin_books', 'fin_years', 'fin_periods', 'fin_groups', 'fin_ledgers', 'fin_vouchers', 'fin_voucher_lines',
  'fin_access', 'fin_approval_rules', 'fin_audit_log', 'fin_imports', 'fin_import_ledgers', 'fin_import_bills'];

test('one finance migration, after the newest existing one, never named like a plate migration', () => {
  assert.equal(files.length, 1);
  assert.ok(files[0] > '20261006190000', files[0]);
  assert.doesNotMatch(files[0], /plate/i);
});

test('standard header, short lock, idempotent DDL, no DROP TRIGGER', () => {
  assert.match(sql, /^-- /);
  assert.match(sql, /set local lock_timeout = '1s';/);
  assert.match(sql, /Mirrored locally by server\/src\/db\.js init\(\)/);
  assert.doesNotMatch(sql, /drop trigger/i);
  assert.doesNotMatch(sql, /CREATE TABLE (?!IF NOT EXISTS)/i);
  assert.doesNotMatch(sql, /CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/i);
});

test('every finance table, each in the guarded realtime block', () => {
  for (const t of FIN_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`), t);
    assert.ok(sql.includes(`'${t}'`), `${t} missing from the realtime array`);
  }
  assert.match(sql, /to_regprocedure\('public\.ci_erp_realtime_ping\(\)'\) is null/);
  assert.match(sql, /create or replace trigger ci_erp_realtime_ping after insert or update or delete on public\.%I for each row/);
  assert.match(sql, /create or replace trigger ci_erp_realtime_ping_truncate after truncate on public\.%I for each statement/);
});

test('isolation: everything the migration alters, indexes, triggers on or references is a fin_ table', () => {
  const targets = [
    ...[...sql.matchAll(/ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?(\w+)/gi)].map(m => m[1]),
    ...[...sql.matchAll(/REFERENCES (?:public\.)?(\w+)/gi)].map(m => m[1]),
    ...[...sql.matchAll(/INDEX IF NOT EXISTS \w+\s+ON (?:public\.)?(\w+)/gi)].map(m => m[1]),
    ...[...sql.matchAll(/\b(?:BEFORE|AFTER)\s+[A-Z ,]+?\s+ON (?:public\.)?(\w+)/gi)].map(m => m[1]),
  ];
  assert.ok(targets.length >= 25, `non-vacuous: only ${targets.length} targets found`);
  assert.deepEqual(targets.filter(t => !t.startsWith('fin_')), []);
});

test('init() replays the finance migration as its last statement', () => {
  const db = readFileSync(new URL('./db.js', import.meta.url), 'utf8');
  assert.match(db, new RegExp(`await pool\\.query\\(migration\\('${files[0]}'\\)\\);\\n\\}`));
});
```

- [ ] **Step 2: Run them.**
  Run: `cd server && node --test src/finance-migration-pins.test.js`
  Expected: FAIL. `files.length` is 0.

- [ ] **Step 3: Write the migration's tables, indexes, constraints and realtime block.**
  - Header as spec §6.9. Write the `LOCKS:` line as "new tables only; no FK onto any existing table, so no existing table is locked".
  - Use the guarded realtime `do $$ … $$` block from `20261005180000_accounts_books.sql` lines 72–89, with the 13-table array.
  - **No trigger functions yet** (Task 5).
  - Append the replay line to `init()`.

- [ ] **Step 4: Run them.** Same command. Expected: PASS (5 tests).

- [ ] **Step 5: Write the harness** `server/src/finance-pg-harness.js`, following `direct-invoice-pg.test.js` lines 22–82:
  1. Start an embedded Postgres in an `fs.mkdtempSync` directory on a free port, non-persistent.
  2. Set `DATABASE_URL` to `postgresql://postgres:postgres@127.0.0.1:<port>/postgres` and `PG_POOL_MAX='1'`.
  3. Run `db.connect()`, `db.init()`, `seedIfEmpty()`.
  4. Insert the six `FIN_TEST_USERS` with `password_hash` `'x'`.
  5. Sign each user's JWT with `JWT_SECRET` from `auth.js`.
  6. If `setup`, run `db.tx((qc, oc) => finSetupBooks(qc, oc, { grants: FIN_TEST_GRANTS }))`. The grants are keyed by email.
  7. Listen with `app.listen(0)`.

  The file is not a `*.test.js`, so `npm test` never runs it, and no app code imports it.

- [ ] **Step 6: Write the failing schema smoke test** in `server/src/finance-pg-schema.test.js`. Gate it with `{ skip: process.env.FINANCE_PG === '1' ? false : 'set FINANCE_PG=1' }`.

```js
test('init() builds every fin_ table, and replaying the migration changes nothing', async () => {
  const h = await finBootPg('schema', { setup: false });
  try {
    const tables = (await h.db.q(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'fin\\_%' ORDER BY 1`)).map(r => r.tablename);
    assert.equal(tables.length, 13);
    const snap = () => h.db.q(`SELECT table_name, column_name, data_type FROM information_schema.columns
                               WHERE table_schema='public' ORDER BY 1, 2`);
    const before = await snap();
    await h.db.init();
    assert.deepEqual(await snap(), before);
  } finally { await h.close(); }
});
```

- [ ] **Step 7: Run it.**
  Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-schema.test.js`
  Expected: PASS. If it fails, the migration has a syntax error or is not idempotent; fix the SQL, not the test.

- [ ] **Step 8: Checkpoint.** Also run `npm run db:baseline -- --check` from the root. Expected: exit 0. The baseline file must not change, because replayed files are not captured.

---

### Task 4: Setup — books, years, groups, system ledgers, rules, grants

**Files:**
- Create: `server/src/finance-audit.js`, `server/src/finance-setup.js`, `scripts/finance-setup.mjs`
- Test: `server/src/finance-pg-setup.test.js`

**Interfaces:**
- Consumes:
  - `FIN_GROUP_TEMPLATE`, `FIN_SYSTEM_LEDGERS` (Task 2)
  - `FIN_DEFAULT_RULES` (Task 2)
  - `finMonthsOfFy`, `finFyOf` (Task 1)
- Produces:
  - `finAudit(qc, { bookId, entity, entityId = null, action, userId = null, userName, reason = null, before = null, after = null }) → Promise<void>`. It inserts one `fin_audit_log` row; `before` and `after` are stored as JSONB.
  - `FIN_SETUP_BOOKS = [{ code: 'CI', name: 'Colour Impressions', entity_name: 'Colour Impressions' }, { code: 'DP', name: 'Darbi Print Pack', entity_name: 'Darbi Print Pack' }]`
  - `FIN_SETUP_GRANTS = [{ email: 'md@motionci.com', roles: ['approver', 'admin'], books: ['CI', 'DP'] }]`, and the Accounts login's grant, `{ roles: ['accountant'], books: ['CI', 'DP'] }`, for the Accounts login (its email is set at go-live, from `FIN_SETUP_ACCOUNTANT_EMAIL`; ruling R68)
  - `finCreateYear(qc, oc, { bookId, label, booksBegin, actor }) → Promise<{ year, created: boolean }>`. Months before `booksBegin` get `before_books`, the rest `open`. It is idempotent on `(book_id, start_date)`.
  - `finSetupBooks(qc, oc, { booksBegin = '2027-01-01', books = FIN_SETUP_BOOKS, grants = FIN_SETUP_GRANTS, actor = 'system (go-live)' } = {}) → Promise<{ books: [{ code, id, created }], grants: [{ email, found }] }>`.
    - A grant's `books` holds codes. When a user already has a row for a book, the role lists are merged (union).

- [ ] **Step 1: Write the failing test** in `server/src/finance-pg-setup.test.js` (FINANCE_PG gated):

```js
test('setup creates both books once, and a second run creates nothing', async () => {
  const h = await finBootPg('setup', { setup: false });
  try {
    const { finSetupBooks } = await import('./finance-setup.js');
    const { FIN_TEST_GRANTS } = await import('./finance-pg-harness.js');
    const grants = [...FIN_TEST_GRANTS, { email: 'nobody@fin.test', roles: ['viewer'], books: ['CI'] }];
    const run = () => h.db.tx((qc, oc) => finSetupBooks(qc, oc, { grants }));
    const first = await run();
    assert.deepEqual(first.books.map(b => [b.code, b.created]), [['CI', true], ['DP', true]]);
    assert.deepEqual(first.grants.find(g => g.email === 'nobody@fin.test'), { email: 'nobody@fin.test', found: false });
    const count = async () => h.db.one(`SELECT
      (SELECT COUNT(*)::int FROM fin_books) books, (SELECT COUNT(*)::int FROM fin_groups) groups,
      (SELECT COUNT(*)::int FROM fin_ledgers) ledgers, (SELECT COUNT(*)::int FROM fin_approval_rules) rules,
      (SELECT COUNT(*)::int FROM fin_periods) periods, (SELECT COUNT(*)::int FROM fin_access) access,
      (SELECT COUNT(*)::int FROM fin_audit_log) audit`);
    const c1 = await count();
    const grantRows = FIN_TEST_GRANTS.reduce((n, g) => n + g.books.length, 0);   // the unknown email adds none
    assert.deepEqual([c1.books, c1.groups, c1.ledgers, c1.rules, c1.periods, c1.access], [2, 58, 4, 20, 24, grantRows]);
    assert.ok(c1.audit >= 2 + grantRows, 'one setup row per book and one per grant');
    const be = await h.db.q(`SELECT b.code, e.name FROM fin_books b JOIN billing_entities e ON e.id = b.billing_entity_id ORDER BY b.code`);
    assert.deepEqual(be.map(r => [r.code, r.name]), [['CI', 'Colour Impressions'], ['DP', 'Darbi Print Pack']]);
    const st = await h.db.q(`SELECT p.status, COUNT(*)::int n FROM fin_periods p JOIN fin_books b ON b.id=p.book_id
                             WHERE b.code='CI' GROUP BY 1 ORDER BY 1`);
    assert.deepEqual(st.map(r => [r.status, r.n]), [['before_books', 9], ['open', 3]]);
    const second = await run();
    assert.deepEqual(second.books.map(b => b.created), [false, false]);
    assert.deepEqual(await count(), c1);
  } finally { await h.close(); }
});

test('the script dry-runs by default and writes nothing', async () => {
  const h = await finBootPg('setup-script', { setup: false });
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, ['../scripts/finance-setup.mjs'],
      { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL }, encoding: 'utf8' });
    assert.match(out, /DRY RUN — nothing written/);
    assert.equal((await h.db.one('SELECT COUNT(*)::int n FROM fin_books')).n, 0);
  } finally { await h.close(); }
});
```

- [ ] **Step 2: Run it.**
  Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-setup.test.js`
  Expected: FAIL. `finance-setup.js` is not found.

- [ ] **Step 3: Implement `finance-audit.js` and `finance-setup.js`.**
  - Resolve each book's `billing_entity_id` by `lower(name) = lower(entity_name)`. If none is found, throw `Error('Billing entity "<name>" not found')`.
  - Groups are created in template order, so each parent exists before its children.
  - `is_system` is true for every template group and for both system ledgers.
  - `Cash` gets `manual_entry = true`. `Profit & Loss A/c` gets `manual_entry = false`, because only year-end closing posts to it (SP3). Task 6 asserts this.
  - Audit rows:
    - one `{ entity: 'book', action: 'setup' }` per created book, with the counts in `after`;
    - one `{ entity: 'access', action: 'grant' }` per new or changed grant.
  - Only `qc` and `oc` are used; no import of `db.js`.

- [ ] **Step 4: Implement `scripts/finance-setup.mjs`** in the shape of `scripts/import-grn.mjs` lines 24–45:
  - `DATABASE_URL` defaults to `postgresql://postgres:postgres@localhost:5439/cierp`.
  - Build `qc` and `oc` over a `pg.Client`, the same way `tx()` does.
  - Run `BEGIN`, then `finSetupBooks`, then print the summary.
  - Without `--apply`, `ROLLBACK` and print `DRY RUN — nothing written. Re-run with --apply to write it.`. With it, `COMMIT`.
  - Refuse a URL that is not `localhost` / `127.0.0.1` unless `--prod` is also passed: exit 1 with `Refusing a non-local database without --prod`.
  - Resolve the import as `new URL('../server/src/finance-setup.js', import.meta.url)`.

- [ ] **Step 5: Run it.** Same command. Expected: PASS (2 tests).

- [ ] **Step 6: Checkpoint.**

---

### Task 5: Hard stops in the database (H1–H10)

**Files:**
- Modify: `supabase/migrations/<ts>_finance_ledger_core.sql`. Append the trigger functions and triggers after the tables, before the realtime block.
- Test: `server/src/finance-pg-db.test.js`; also extend `finance-migration-pins.test.js`.

**Interfaces:**
- Produces: Postgres exceptions raised as `RAISE EXCEPTION USING MESSAGE = <sentence>, DETAIL = <code>, ERRCODE = 'P0001'`. node-pg exposes `e.detail`.
  - Codes from triggers: `FIN_UNBALANCED`, `FIN_TOO_FEW_LINES`, `FIN_POSTED_IMMUTABLE`, `FIN_PERIOD_LOCKED`, `FIN_PERIOD_CLOSING`, `FIN_BEFORE_BOOKS`, `FIN_BAD_DATE`, `FIN_WRONG_BOOK`, `FIN_LEDGER_INACTIVE`, `FIN_SYSTEM_LEDGER`, `FIN_AUDIT_APPEND_ONLY`, `FIN_NO_TRUNCATE`.
  - Constraint names (Task 3) cover H2, H7 and H8.
- The functions and triggers, all `CREATE OR REPLACE`:

```sql
-- H3: a posted voucher is frozen except reversed_by_id null → value
create or replace trigger fin_voucher_guard before update or delete on fin_vouchers
  for each row execute function fin_voucher_guard();
-- H4: lines of a posted voucher
create or replace trigger fin_line_guard before insert or update or delete on fin_voucher_lines
  for each row execute function fin_line_guard();
-- H1 + H5 + H6, checked at COMMIT, only on the way INTO posted
create or replace constraint trigger fin_voucher_post_check_ins after insert on fin_vouchers
  deferrable initially deferred for each row when (new.status = 'posted') execute function fin_voucher_post_check();
create or replace constraint trigger fin_voucher_post_check_upd after update on fin_vouchers
  deferrable initially deferred for each row when (new.status = 'posted' and old.status <> 'posted')
  execute function fin_voucher_post_check();
-- H9, H10
create or replace trigger fin_audit_guard before update or delete on fin_audit_log
  for each row execute function fin_audit_guard();
create or replace trigger fin_no_truncate before truncate on fin_vouchers for each statement execute function fin_no_truncate();
create or replace trigger fin_no_truncate before truncate on fin_voucher_lines for each statement execute function fin_no_truncate();
create or replace trigger fin_no_truncate before truncate on fin_audit_log for each statement execute function fin_no_truncate();
```

  - **`fin_voucher_guard`:** allow the update only when `OLD.reversed_by_id IS NULL AND NEW.reversed_by_id IS NOT NULL AND (to_jsonb(NEW) - 'reversed_by_id') = (to_jsonb(OLD) - 'reversed_by_id')`. Otherwise raise.
  - **`fin_voucher_post_check`** runs these checks in order, raising at the first failure:
    1. `voucher_date::date` cast. A failure raises `FIN_BAD_DATE`.
    2. The period exists, belongs to the same book (else `FIN_WRONG_BOOK`) and contains the date (else `FIN_BAD_DATE`).
    3. Period status:
       - `locked` → `FIN_PERIOD_LOCKED`.
       - `closing` with `approved_by_id IS NULL` → `FIN_PERIOD_CLOSING`.
       - `before_books`, unless the type is `opening` or `reversal_of_id` points at an `opening` voucher → `FIN_BEFORE_BOOKS`.
    4. At least two lines (`FIN_TOO_FEW_LINES`). Σdebit = Σcredit > 0, and `total` = Σdebit (`FIN_UNBALANCED`).
    5. Each line's ledger is active, unless this is a reversal (`FIN_LEDGER_INACTIVE`).
    6. A `manual_entry = false` ledger appears only when `source_type` is set, the type is `opening`, or `reversal_of_id` is set (`FIN_SYSTEM_LEDGER`).

- [ ] **Step 1: Write the failing tests** in `server/src/finance-pg-db.test.js`. FINANCE_PG gated, one `finBootPg('db')` in `before()`.
  - **Fixtures:**
    - `ledger(code, name, group, extra = {})` inserts a ledger by group name and book code.
    - `draft(code, type, date, lines, extra = {})` inserts a draft voucher plus lines, with `total` = Σdebit.
    - `post(id, extra = {})` runs in one `tx`. It sets `status='posted'`, a unique test `number`, `period_id` (the period covering the date, or `extra.period_id`), `posted_at=now()`, and any `extra`.
  - **`expectCode(promise, code)`:** awaits the promise and asserts `e.detail === code` or `e.constraint === code`.
  - **Opening voucher setup:** set `books_begin` to the real default, `2027-01-01`. December 2026 is `before_books`; January–March 2027 are `open`.

```js
test('H1 unbalanced, one-line and wrong-total vouchers do not post', async () => {
  await expectCode(post(await draft('CI', 'journal', '2027-01-10', [[A, 100, 0], [B, 0, 90]])), 'FIN_UNBALANCED');
  await expectCode(post(await draft('CI', 'journal', '2027-01-10', [[A, 100, 0]])), 'FIN_TOO_FEW_LINES');
  await expectCode(post(await draft('CI', 'journal', '2027-01-10', [[A, 100, 0], [B, 0, 100]], { total: 90 })), 'FIN_UNBALANCED');
  await post(await draft('CI', 'journal', '2027-01-10', [[A, 100, 0], [B, 0, 100]]));   // balanced posts
});
test('H2 a line is one side, never both, never zero', async () => {
  await expectCode(draft('CI', 'journal', '2027-01-10', [[A, 5, 5], [B, 0, 0]]), 'fin_voucher_lines_one_side');
});
test('H3 a posted voucher cannot change or vanish; reversed_by_id is set once', async () => { /* UPDATE narration → FIN_POSTED_IMMUTABLE; DELETE → FIN_POSTED_IMMUTABLE; set reversed_by_id → ok; change it again → FIN_POSTED_IMMUTABLE */ });
test('H4 lines of a posted voucher are frozen', async () => { /* INSERT, UPDATE, DELETE a line → FIN_POSTED_IMMUTABLE */ });
test('H5 months: locked, closing without approval, before books, bad and foreign dates', async () => {
  /* lock Feb → posting in Feb = FIN_PERIOD_LOCKED; closing Mar without approved_by_id = FIN_PERIOD_CLOSING, with it posts;
     journal dated 2026-12-31 = FIN_BEFORE_BOOKS, opening dated 2026-12-31 posts; '2027-02-29' = FIN_BAD_DATE;
     period_id of a DP month on a CI voucher = FIN_WRONG_BOOK */
});
test('H6 inactive and system-only ledgers', async () => {
  /* inactive ledger in a journal = FIN_LEDGER_INACTIVE; manual_entry=false ledger in a journal = FIN_SYSTEM_LEDGER;
     the same ledger in an opening voucher, in a voucher with source_type set, and in a reversal → all post */
});
test('H7 a line cannot use the other book\'s ledger', async () => {
  await expectCode(draft('CI', 'journal', '2027-01-10', [[A, 1, 0], [DP_LEDGER, 0, 1]]), 'fin_voucher_lines_ledger_book_fk');
});
test('H8 one live opening per book, one reversal per voucher, one live posting per source', async () => {
  /* second posted opening for CI → fin_vouchers_one_live_opening; two non-discarded reversals of one voucher →
     fin_vouchers_one_reversal; two submitted/posted vouchers with the same (source_type, source_id) → fin_vouchers_one_live_source */
});
test('H9 H10 the audit log is append-only and nothing in the books can be truncated', async () => {
  /* UPDATE/DELETE fin_audit_log → FIN_AUDIT_APPEND_ONLY; TRUNCATE each of the three tables → FIN_NO_TRUNCATE */
});
test('a voucher in a month locked after posting can still be marked reversed', async () => {
  /* post in Jan, lock Jan, set reversed_by_id on it → succeeds */
});
```

  Write each commented test body out in full with `expectCode`, using the fixtures. Each comment lists the assertions to write.

- [ ] **Step 2: Run them.**
  Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-db.test.js`
  Expected:
  - FAIL for every H1, H3–H6 and H9–H10 refusal. The write succeeds, so `expectCode` reports "no error".
  - H2, H7 and H8 already pass, because their constraints come from Task 3. Confirm they still FAIL when you temporarily delete the constraint line from the migration, then restore it.

- [ ] **Step 3: Add the functions and triggers above to the migration.**

- [ ] **Step 4: Run them.** Same command. Expected: PASS, all tests.

- [ ] **Step 5: Extend the pins.** In `finance-migration-pins.test.js`, assert that the SQL contains each of the eight trigger names above, and `deferrable initially deferred` twice. Run the pins. Expected: PASS.

- [ ] **Step 6: Checkpoint.**

---

### Task 6: Errors, access, the router, and the read routes

**Files:**
- Create: `server/src/finance-errors.js`, `server/src/finance-access.js`, `server/src/routes/finance.js`
- Modify: `server/src/app.js`. Add `import finance from './routes/finance.js';` after the `kitStudio` import, and `app.use('/api', finance);` after `app.use('/api', kitStudio);`.
- Test: `server/src/finance-wiring.test.js`, `server/src/finance-pg-access.test.js`

**Interfaces:**
- Consumes: `finCan`, `FIN_ROLES` (Task 2); `FIN_BANK_CASH_GROUPS` (Task 2).
- Produces, in `finance-errors.js`:
  - `finError(status, code, message, extra = {}) → Error`, carrying `status` and `body = { code, ...extra }`.
  - `finMapDbError(e) → Error`. It maps:
    - any `e.detail` beginning `FIN_` → 409 with that code;
    - unique violations, by constraint:
      - `fin_vouchers_one_live_opening` → `FIN_OPENING_EXISTS`
      - `fin_vouchers_one_reversal`, or a unique violation on `reversed_by_id` → `FIN_ALREADY_REVERSED`
      - `fin_vouchers_one_live_source` → `FIN_SOURCE_POSTED`
      - `fin_groups_book_name_key` and `fin_ledgers_book_name_key` → `FIN_DUPLICATE_NAME`
      - `fin_ledgers_book_code_key` → `FIN_DUPLICATE_CODE`
      - `fin_ledgers_party_key` → `FIN_PARTY_LINKED`
    - `fin_voucher_lines_one_side` → `FIN_BAD_LINE`;
    - `fin_voucher_lines_ledger_book_fk` and `fin_ledgers_group_book_fk` → `FIN_WRONG_BOOK`;
    - a FK RESTRICT on delete → `FIN_IN_USE`.

    Anything else becomes a 500 `FIN_SERVER_ERROR` with a fixed sentence and the original kept as `cause` (Ruling R20, after Task 6's review).
  - `FIN_SENTENCES`: code → the plain sentence shown to the user. App-level codes used from Task 7 onward:
    - 403: `FIN_FORBIDDEN`, `FIN_NOT_MAKER`
    - 404: `FIN_NOT_FOUND`
    - 400: `FIN_BAD_INPUT`, `FIN_BAD_AMOUNT`, `FIN_BAD_DATE`, `FIN_REASON_REQUIRED`
    - 409: `FIN_NO_PERIOD`, `FIN_SHAPE`, `FIN_NOT_DRAFT`, `FIN_NOT_SUBMITTED`, `FIN_NOT_POSTED`, `FIN_OWN_VOUCHER`, `FIN_CHANGED`, `FIN_EXISTS`, `FIN_BAD_TRANSITION`, `FIN_LAST_ADMIN`, `FIN_TIE_OUT`, `FIN_DUPLICATE_KEY`
- Produces, in `finance-access.js`:
  - `finAccessOf(userId) → Promise<Map<number, { roles: string[], can_export: boolean }>>`. Held for 10 s per instance and read inside `withoutLedger`, as `access.js` does.
  - `finForgetAccess(userId = null)`.
  - `finRequire(req, cap, bookId) → Promise<{ roles, can_export }>`. Throws 403 `FIN_FORBIDDEN` when the user has no grant on that book or the grant does not carry the capability.
  - `finBookIdsFor(req, cap = 'view') → Promise<number[]>`.
  - `finApproverIds(bookId, qc) → Promise<number[]>`: active users holding `approver` on the book.
- Produces, as routes (read-only, capability `view` on the book):
  - `GET /finance/me` → `{ user: { id, name }, books: [{ id, code, name, billing_entity_id, books_begin, roles, can_export }] }`. Only books the caller has a grant on; `[]` when none, with status 200.
  - `GET /finance/books` → `{ books }`, the same list.
  - `GET /finance/books/:bookId/groups` → `{ groups: [{ id, parent_id, name, nature, affects_gross_profit, is_system, sort_order, ledger_count }] }`.
  - `GET /finance/books/:bookId/ledgers` (`?include_inactive=1`) → `{ ledgers: [{ id, book_id, group_id, group_name, name, code, tally_name, party_type, party_id, party_name, name_differs, manual_entry, is_system, active, is_bank_cash }] }`. Task 7 adds `notes`.
    - `party_name` comes from a LEFT JOIN on `customers` or `vendors`.
    - `name_differs` is a case- and space-insensitive comparison.
    - `is_bank_cash` follows the group ancestry, through a recursive CTE, into `FIN_BANK_CASH_GROUPS`.
  - `GET /finance/books/:bookId/years` → `{ years: [{ id, label, short, start_date, end_date, periods: [{ id, month_no, label, start_date, end_date, status, status_changed_by, status_changed_at }] }] }`.
- **Route rule:** every handler ends `catch (e) { next(finMapDbError(e)); }`.

- [ ] **Step 1: Write the failing wiring pin** in `server/src/finance-wiring.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');

test('the finance router is mounted behind requireAuth and moduleGate', () => {
  const app = src('./app.js');
  assert.match(app, /import finance from '\.\/routes\/finance\.js';/);
  const mount = app.indexOf("app.use('/api', finance);");
  assert.ok(mount > app.indexOf("app.use('/api', moduleGate);"), 'mounted after moduleGate');
  assert.ok(mount < app.indexOf('// Central error handler'), 'mounted before the error handler');
});
```

- [ ] **Step 2: Write the failing access tests** in `server/src/finance-pg-access.test.js`. FINANCE_PG gated, `finBootPg('access')`. `CI` and `DP` are book ids read from `/finance/books` as md.

```js
test('a plant admin with no Finance grant sees no books and is refused every book route', async () => {
  const me = await h.call('GET', '/finance/me', null, 'plant');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.books, []);
  for (const url of [`/finance/books/${CI}/groups`, `/finance/books/${CI}/ledgers`, `/finance/books/${CI}/years`]) {
    const r = await h.call('GET', url, null, 'plant');
    assert.equal(r.status, 403, url);
    assert.equal(r.body.code, 'FIN_FORBIDDEN');
  }
});

test('one-book logins see only their book', async () => {
  const v = await h.call('GET', '/finance/me', null, 'viewer');
  assert.deepEqual(v.body.books.map(b => [b.code, b.roles, b.can_export]), [['CI', ['viewer'], false]]);
  const d = await h.call('GET', '/finance/me', null, 'dpOnly');
  assert.deepEqual(d.body.books.map(b => b.code), ['DP']);
  assert.equal((await h.call('GET', `/finance/books/${DP}/ledgers`, null, 'viewer')).status, 403);
  assert.equal((await h.call('GET', `/finance/books/${CI}/ledgers`, null, 'dpOnly')).status, 403);
});

test('the MD holds approver + admin on both books; the books read the template', async () => {
  const m = await h.call('GET', '/finance/me', null, 'md');
  assert.deepEqual(m.body.books.map(b => [b.code, [...b.roles].sort()]), [['CI', ['admin', 'approver']], ['DP', ['admin', 'approver']]]);
  const g = await h.call('GET', `/finance/books/${CI}/groups`);
  assert.equal(g.body.groups.length, 29);
  const l = await h.call('GET', `/finance/books/${CI}/ledgers`);
  const cash = l.body.ledgers.find(x => x.name === 'Cash');
  assert.equal(cash.is_bank_cash, true);
  assert.equal(l.body.ledgers.find(x => x.name === 'Profit & Loss A/c').manual_entry, false);
  const y = await h.call('GET', `/finance/books/${CI}/years`);
  assert.deepEqual(y.body.years.map(x => [x.label, x.periods.length]), [['2026-27', 12]]);
});
```


- [ ] **Step 3: Run both.**
  Run: `cd server && node --test src/finance-wiring.test.js && FINANCE_PG=1 node --test src/finance-pg-access.test.js`
  Expected: FAIL. There is no import in `app.js`, and the API answers 404 for `/api/finance/*`.

- [ ] **Step 4: Implement `finance-errors.js`, `finance-access.js`, and the router with the five read routes; mount it in `app.js`.**
  - `bookId` is parsed with `+req.params.bookId`. A non-integer gets 404 `FIN_NOT_FOUND`.

- [ ] **Step 5: Run both.** Same command. Expected: PASS.

- [ ] **Step 6: Checkpoint.** `npm test` must stay green, including the source-scanning guards: `structured-errors`, `mint-routes-join-once`, `notify-categories`, `plant-date-routes`, `optional-text-guard` and `app-imports`.

---

### Task 7: Chart of accounts and months — the writes

**Files:**
- Create: `server/src/finance-masters.js`
- Modify: `server/src/routes/finance.js`
- Test: `server/src/finance-pg-masters.test.js`

**Interfaces:**
- Consumes: `finRequire` and `finAccessOf` (Task 6), `finAudit` (Task 4), `finCreateYear` (Task 4), `finError` (Task 6).
- Produces, in `finance-masters.js`. Each function takes `(qc, oc, …, actor)` with `actor = { id, name }`, runs inside the route's `tx`, and writes one `finAudit` row with `before` / `after`.
  - `finCreateGroup(qc, oc, { book_id, parent_id, name }, actor) → group`. The parent is required. `nature` and `affects_gross_profit` are inherited from the parent.
  - `finUpdateGroup(qc, oc, id, { name, parent_id, sort_order }, actor) → group`.
    - A system group can be neither renamed nor moved (Ruling R19): bank/cash, party and P&L detection key off template names.
    - The new parent must have the same nature and must not be the group itself or one of its descendants. Otherwise 400 `FIN_BAD_INPUT`.
  - `finDeleteGroup(qc, oc, id, actor)`. Refused with 400 `FIN_BAD_INPUT` for a system group, and with 409 `FIN_IN_USE` when the group has ledgers or child groups.
  - `finCreateLedger(qc, oc, { book_id, group_id, name, code, tally_name, party_type, party_id, notes }, actor) → ledger`.
    - The party must exist in `customers` or `vendors`; otherwise `FIN_BAD_INPUT`.
  - `finUpdateLedger(qc, oc, id, fields, actor, { isAdmin }) → ledger`.
    - `group_id`, `manual_entry`, `active`, `party_type` and `party_id` need `isAdmin`; otherwise 403 `FIN_FORBIDDEN`.
    - A system ledger cannot be moved or deactivated (`FIN_BAD_INPUT`).
  - `finSetPeriodStatus(qc, oc, periodId, { status, reason }, actor) → period`.
    - Locks the period `FOR UPDATE`.
    - Allowed moves: open→closing, closing→locked, closing→open (reason required), locked→closing (reason required).
    - `before_books` never changes. Any other move is 409 `FIN_BAD_TRANSITION`. A missing reason is 400 `FIN_REASON_REQUIRED`.
- **Names:** group and ledger names are stored trimmed, with internal whitespace collapsed to single spaces.
- Produces, as routes:

  | Route | Capability | Notes |
  |---|---|---|
  | `POST /finance/groups` | admin | |
  | `PUT /finance/groups/:id` | admin | |
  | `DELETE /finance/groups/:id` | admin | |
  | `POST /finance/ledgers` | ledger | |
  | `PUT /finance/ledgers/:id` | ledger | `isAdmin` comes from the admin capability |
  | `POST /finance/years` | admin | Body `{ book_id, label }`. The label must be a real `YYYY-YY` financial year; a duplicate is 409 `FIN_EXISTS`. Responds `{ year: { …year, periods } }` |
  | `PUT /finance/periods/:id/status` | approver | |

- [ ] **Step 1: Write the failing tests** in `server/src/finance-pg-masters.test.js` (FINANCE_PG gated):

```js
test('ledgers: the accountant adds, names are unique however they are typed, admin-only fields stay admin-only', async () => {
  const add = (body, who = 'acct') => h.call('POST', '/finance/ledgers', { book_id: CI, ...body }, who);
  const pnb = await add({ name: 'Beta Bank', group_id: G.BankAccounts });
  assert.equal(pnb.status, 200);
  assert.equal((await add({ name: '  beta   bank ', group_id: G.BankAccounts })).body.code, 'FIN_DUPLICATE_NAME');
  assert.equal((await add({ name: 'Rent', group_id: G.IndirectExpenses }, 'viewer')).status, 403);
  const id = pnb.body.ledger.id;
  assert.equal((await h.call('PUT', `/finance/ledgers/${id}`, { active: false }, 'acct')).body.code, 'FIN_FORBIDDEN');
  assert.equal((await h.call('PUT', `/finance/ledgers/${id}`, { active: false }, 'md')).status, 200);
  assert.equal((await h.call('PUT', `/finance/ledgers/${CASH}`, { group_id: G.BankAccounts }, 'md')).body.code, 'FIN_BAD_INPUT');
});

test('party ledgers link to an existing customer, once per book', async () => {
  const c = await h.db.one('SELECT id, name FROM customers ORDER BY id LIMIT 1');
  const add = name => h.call('POST', '/finance/ledgers', { book_id: CI, group_id: G.SundryDebtors, name, party_type: 'customer', party_id: c.id }, 'acct');
  assert.equal((await add('Tally Name For Customer')).status, 200);
  assert.equal((await add('Another Name')).body.code, 'FIN_PARTY_LINKED');
  const l = (await h.call('GET', `/finance/books/${CI}/ledgers`)).body.ledgers.find(x => x.party_id === c.id);
  assert.equal(l.party_name, c.name);
  assert.equal(l.name_differs, true);
  assert.equal((await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: G.SundryDebtors, name: 'Ghost', party_type: 'customer', party_id: 999999 }, 'acct')).body.code, 'FIN_BAD_INPUT');
});

test('groups: sub-groups inherit nature; system groups cannot be deleted; groups in use cannot be deleted', async () => {
  const sg = await h.call('POST', '/finance/groups', { book_id: CI, parent_id: G.DirectExpenses, name: 'Packing Material' }, 'md');
  assert.equal(sg.body.group.nature, 'expense');
  assert.equal((await h.call('DELETE', `/finance/groups/${G.SundryDebtors}`, null, 'md')).body.code, 'FIN_BAD_INPUT');
  await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: sg.body.group.id, name: 'Corrugated Boxes' }, 'acct');
  assert.equal((await h.call('DELETE', `/finance/groups/${sg.body.group.id}`, null, 'md')).body.code, 'FIN_IN_USE');
  assert.equal((await h.call('PUT', `/finance/groups/${sg.body.group.id}`, { parent_id: G.SundryDebtors }, 'md')).body.code, 'FIN_BAD_INPUT');
  assert.equal((await h.call('POST', '/finance/groups', { book_id: CI, parent_id: G.DirectExpenses, name: 'X' }, 'acct')).status, 403);
});

test('years: an admin adds the next year once; months follow books_begin', async () => {
  const y = await h.call('POST', '/finance/years', { book_id: CI, label: '2027-28' }, 'md');
  assert.equal(y.status, 200);
  assert.ok(y.body.year.periods.every(p => p.status === 'open'));
  assert.equal((await h.call('POST', '/finance/years', { book_id: CI, label: '2027-28' }, 'md')).body.code, 'FIN_EXISTS');
  assert.equal((await h.call('POST', '/finance/years', { book_id: CI, label: '2027-29' }, 'md')).body.code, 'FIN_BAD_INPUT');
  assert.equal((await h.call('POST', '/finance/years', { book_id: CI, label: '2028-29' }, 'acct')).status, 403);
});

test('months: approver-only transitions, reasons where the spec demands them, audited', async () => {
  const jan = PERIOD.CI['2027-01-01'];
  const set = (status, reason, who = 'appr2') => h.call('PUT', `/finance/periods/${jan}/status`, { status, reason }, who);
  assert.equal((await set('closing', null, 'acct')).status, 403);
  assert.equal((await set('closing')).status, 200);
  assert.equal((await set('locked')).status, 200);
  assert.equal((await set('open')).body.code, 'FIN_BAD_TRANSITION');
  assert.equal((await set('closing')).body.code, 'FIN_REASON_REQUIRED');
  assert.equal((await set('closing', 'CA adjustment')).status, 200);
  assert.equal((await set('open', 'reopened by mistake')).status, 200);
  const a = await h.db.one(`SELECT reason FROM fin_audit_log WHERE entity='period' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [jan]);
  assert.equal(a.reason, 'reopened by mistake');
  assert.equal((await h.call('PUT', `/finance/periods/${PERIOD.DP['2027-01-01']}/status`, { status: 'closing' }, 'appr2')).status, 403);
  assert.equal((await h.call('PUT', `/finance/periods/${PERIOD.CI['2026-12-01']}/status`, { status: 'open', reason: 'x' }, 'md')).body.code, 'FIN_BAD_TRANSITION');
});
```

  - **Fixtures:** `G` maps group name → id for CI, built from `GET /finance/books/:CI/groups` with spaces and punctuation stripped from the names. `CASH` is the CI Cash ledger id. `PERIOD[book][start_date]` → period id.
  - **Order:** the months test runs last, so the other tests see Jan open.

- [ ] **Step 2: Run it.**
  Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-masters.test.js`
  Expected: FAIL. The write routes don't exist, so they answer 404.

- [ ] **Step 3: Implement `finance-masters.js` and the seven routes.** Each write route runs `tx(async (qc, oc) => …)` and passes `qc` and `oc` to every helper.
  - After a write that changes access, call `finForgetAccess` (none in this task).

- [ ] **Step 4: Run it.** Same command. Expected: PASS (5 tests).

- [ ] **Step 5: Checkpoint.**

---

### Task 8: Voucher drafts — create, edit, discard, list, open

**Files:**
- Create: `server/src/finance-vouchers.js` (first part)
- Modify: `server/src/routes/finance.js`
- Test: `server/src/finance-pg-vouchers.test.js`

**Interfaces:**
- Consumes: `finRequire`, `finBookIdsFor` (Task 6); `finAudit` (Task 4); `finIsValidDate` (Task 1); `FIN_VOUCHER_TYPES` (Task 2).
- **Actor shape**, used from here on: `actor = { id, name, roles }`. `roles` are the caller's Finance roles on the voucher's book, as returned by `finRequire`.
- **Line input:** `{ ledger_id, debit_paise, credit_paise, narration, bill_ref, bill_date, due_date }`.
  - Amounts must be safe integers ≥ 0, otherwise 400 `FIN_BAD_AMOUNT`. Exactly one side must be positive, otherwise 409 `FIN_BAD_LINE`.
  - The ledger must be in the book (`FIN_WRONG_BOOK`), active (`FIN_LEDGER_INACTIVE`) and `manual_entry` (`FIN_SYSTEM_LEDGER`).
  - Bill fields are allowed only on party ledgers (`FIN_BAD_INPUT`), and their dates must be valid (`FIN_BAD_DATE`).
  - At most 200 lines. A draft may be unbalanced.
- Produces:
  - `finCreateDraft(qc, oc, { book_id, voucher_type, voucher_date, narration, reference, client_key, lines }, actor) → voucher`
    - The type must be one with `manual: true`, otherwise `FIN_BAD_INPUT`.
    - A repeated `client_key` from the same user and book returns the existing draft. From anyone else it is 409 `FIN_DUPLICATE_KEY`.
  - `finUpdateDraft(qc, oc, id, { voucher_date, narration, reference, lines }, actor) → voucher`
    - Maker only (403 `FIN_NOT_MAKER`); `draft` status only (409 `FIN_NOT_DRAFT`).
    - Lines are replaced wholesale.
  - `finDiscardDraft(qc, oc, id, actor, { isAdmin }) → voucher`. Allowed for the maker or an admin, on a `draft` only.
  - `finVoucherView(id, req) → { voucher, lines, history, can }`
    - A pool read. A voucher the caller cannot view is 404 `FIN_NOT_FOUND` — the same answer as "no such voucher".
    - `can` is `{ edit, submit, discard, approve, reject, reverse }`, booleans from status, maker and roles.
    - `history` is the voucher's `fin_audit_log` rows, oldest first.
  - **Amounts in responses:** voucher fields carry `total_paise`; line fields `debit_paise` / `credit_paise`.
- Routes:

  | Route | Capability | Notes |
  |---|---|---|
  | `POST /finance/vouchers` | enter | |
  | `PUT /finance/vouchers/:id` | enter | |
  | `POST /finance/vouchers/:id/discard` | enter, or admin | |
  | `GET /finance/vouchers` | view | Query: `book, from, to, type, status, q, view=daybook\|approvals\|drafts` |
  | `GET /finance/vouchers/:id` | view | |

  - **Views for `GET /finance/vouchers`:**
    - `daybook`: every status except `discarded`.
    - `approvals`: `submitted` vouchers in a book where the caller is an approver and not the maker.
    - `drafts`: the caller's own drafts.
  - The response is `{ vouchers: [{ id, book_id, number, voucher_date, voucher_type, status, narration, reference, total_paise, created_by, created_at, submitted_at, posted_at, reversal_of_id, reversed_by_id, self_approved, last_reject_reason }] }`.
  - The list is always limited to `finBookIdsFor(req)`.
- Every write appends a `finAudit` row (entity `voucher`, action `create` / `edit` / `discard`), with `before` / `after` including the lines.

- [ ] **Step 1: Write the failing tests** in `server/src/finance-pg-vouchers.test.js`.
  - FINANCE_PG gated; one `finBootPg('vouchers')` in `before()`.
  - Then, as acct and through the API, create CI ledgers: `Alpha Bank` (Bank Accounts), `Rent` (Indirect Expenses), `Freight` (Direct Expenses), and `Customer A` (Sundry Debtors, linked to the first seeded customer). Also create DP ledger `DP Rent`.
  - `jv(lines, extra)` returns a journal body dated `'2027-01-10'` with `client_key: randomUUID()`. A line is written `[ledgerId, debit_paise, credit_paise]`.

```js
test('the accountant saves a draft; the same save key twice is one draft', async () => {
  const body = jv([[RENT, 500000, 0], [FREIGHT, 0, 400000]]);           // unbalanced is fine in a draft
  const a = await h.call('POST', '/finance/vouchers', body, 'acct');
  assert.equal(a.status, 200);
  assert.equal(a.body.voucher.status, 'draft');
  assert.equal(a.body.voucher.number, null);
  const b = await h.call('POST', '/finance/vouchers', body, 'acct');
  assert.equal(b.body.voucher.id, a.body.voucher.id);
  assert.equal((await h.db.one('SELECT COUNT(*)::int n FROM fin_vouchers WHERE client_key=$1', [body.client_key])).n, 1);
});

test('typed amounts arrive as whole paise or are refused', async () => {
  const bad = async (lines, code) => assert.equal((await h.call('POST', '/finance/vouchers', jv(lines), 'acct')).body.code, code);
  await bad([[RENT, 12.5, 0], [FREIGHT, 0, 12.5]], 'FIN_BAD_AMOUNT');
  await bad([[RENT, -100, 0], [FREIGHT, 0, 100]], 'FIN_BAD_AMOUNT');
  await bad([[RENT, 100, 100], [FREIGHT, 0, 100]], 'FIN_BAD_LINE');
  await bad([[RENT, 100, 0], [DP_RENT, 0, 100]], 'FIN_WRONG_BOOK');
  await bad([[RENT, 100, 0], [PL, 0, 100]], 'FIN_SYSTEM_LEDGER');
  assert.equal((await h.call('POST', '/finance/vouchers', { ...jv([[RENT, 1, 0], [FREIGHT, 0, 1]]), voucher_date: '2027-02-29' }, 'acct')).body.code, 'FIN_BAD_DATE');
  assert.equal((await h.call('POST', '/finance/vouchers', { ...jv([[RENT, 1, 0], [FREIGHT, 0, 1]]), voucher_type: 'opening' }, 'acct')).body.code, 'FIN_BAD_INPUT');
  assert.equal((await h.call('POST', '/finance/vouchers', jv([[RENT, 1, 0], [FREIGHT, 0, 1]]), 'viewer')).status, 403);
});

test('only the maker edits a draft; a one-book login cannot even see the voucher', async () => {
  const v = (await h.call('POST', '/finance/vouchers', jv([[RENT, 100, 0], [FREIGHT, 0, 100]]), 'acct')).body.voucher;
  assert.equal((await h.call('PUT', `/finance/vouchers/${v.id}`, { lines: [] }, 'appr2')).body.code, 'FIN_NOT_MAKER');
  assert.equal((await h.call('PUT', `/finance/vouchers/${v.id}`, { narration: 'June rent', lines: [[RENT, 200, 0], [FREIGHT, 0, 200]].map(L) }, 'acct')).status, 200);
  assert.equal((await h.call('GET', `/finance/vouchers/${v.id}`, null, 'dpOnly')).status, 404);
  const list = await h.call('GET', `/finance/vouchers?book=${CI}`, null, 'dpOnly');
  assert.equal(list.status, 403);
  const d = await h.call('POST', `/finance/vouchers/${v.id}/discard`, null, 'acct');
  assert.equal(d.body.voucher.status, 'discarded');
  const day = await h.call('GET', `/finance/vouchers?book=${CI}&view=daybook`, null, 'acct');
  assert.ok(!day.body.vouchers.some(x => x.id === v.id));
  const hist = (await h.call('GET', `/finance/vouchers/${v.id}`, null, 'acct')).body.history.map(x => x.action);
  assert.deepEqual(hist, ['create', 'edit', 'discard']);
});
```

  `L` turns `[ledgerId, debit_paise, credit_paise]` into a line object; `jv` uses it.

- [ ] **Step 2: Run it.**
  Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-vouchers.test.js`
  Expected: FAIL. The routes answer 404.

- [ ] **Step 3: Implement** the four functions and five routes. A route resolves the voucher's book with a pool read before `finRequire`. Writes run in `tx`.

- [ ] **Step 4: Run it.** Same command. Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint.**

---

### Task 9: Submit, approve, reject — posting, numbering, notifications

**Files:**
- Modify: `server/src/finance-vouchers.js`, `server/src/routes/finance.js`
- Modify (shared, spec §12):
  - `client/src/lib/writeOnce.js`: add `'/finance/vouchers/:id/approve'` and `'/finance/vouchers/:id/submit'` to `MINTING_POSTS`, in alphabetical position.
  - `server/src/notify-categories.js`: add to `OF_KIND`, with a one-line comment each, `fin_approval: 'approvals'` and `fin_decision: 'decisions'`.
- Test: extend `server/src/finance-pg-vouchers.test.js` and `server/src/finance-wiring.test.js`

**Interfaces:**
- Consumes:
  - `finPrefix`, `finNeedsApproval`, `finBalanceProblem`, `finShapeProblem` (Task 2)
  - `lockDocNumber`, `nextNumber`, `notify` from `./helpers.js`
  - `finApproverIds` (Task 6)
- Produces:
  - `finVoucherCtx(qc, oc, voucherId) → { v, book, period, year, prefix }`. The lock order is the decision here:
    1. Read the voucher, book, covering period and year without locks. No period gives 409 `FIN_NO_PERIOD`: "No financial year covers <date> — add it in Finance → Setup → Months & Years."
    2. `await lockDocNumber(prefix, oc)`.
    3. `SELECT … FOR UPDATE` the voucher. If its book, type or date no longer yield the same prefix → 409 `FIN_CHANGED`.
  - `finPostLocked(qc, oc, ctx, actor, { approvedBy = null, selfApproved = false }) → voucher`:
    1. Re-read the period `FOR SHARE`. A `locked` month is 409 `FIN_PERIOD_LOCKED`; `closing` with no `approvedBy` is `FIN_PERIOD_CLOSING`; `before_books` outside the opening rules is `FIN_BEFORE_BOOKS`.
    2. Load the lines with their ledgers' `active`, `manual_entry` and `is_bank_cash`, and apply the same rules as the database (H6). The app gives the nicer sentence.
    3. Run `finBalanceProblem`, then `finShapeProblem(type, lines, { isReversal: !!v.reversal_of_id })`. Either problem → 409 with its code and message.
    4. Mint `number = await nextNumber(ctx.prefix, 'fin_vouchers', 'number', oc)`.
    5. Update the voucher: `status='posted'`, `number`, `period_id`, `posted_by*`, `approved_by*` (when `approvedBy`), `self_approved`.
    6. For a reversal: `UPDATE fin_vouchers SET reversed_by_id=$v WHERE id=$orig AND reversed_by_id IS NULL`. Zero rows → `FIN_ALREADY_REVERSED`.
    7. Write `finAudit` (action `post`).
  - `finSubmitVoucher(qc, oc, id, actor) → voucher`:
    - Maker only (`FIN_NOT_MAKER`), `draft` only (`FIN_NOT_DRAFT`).
    - Balance and shape problems are refused here too, before anything changes.
    - A `locked` month is refused here too (`FIN_PERIOD_LOCKED`), as is a `before_books` month outside the opening rules (`FIN_BEFORE_BOOKS`). A voucher that could never be approved never waits in the queue.
    - The rule is the voucher type's, or `reversal` for a reversal. `needs = finNeedsApproval(...)`.
    - If `needs` and the actor is not an approver: status becomes `submitted`; write `finAudit` `submit`; call `notify(approvers minus actor, { kind: 'fin_approval', title: 'Finance entry waiting for approval', body: '<BOOK> <Type> ₹<amount> — <maker>', link: '/finance?tab=approvals&voucher=<id>', refTable: 'fin_vouchers', refId: id }, qc)`.
    - Otherwise: `finPostLocked`, with `approvedBy: needs ? actor : null` and `selfApproved: needs`.
  - `finApproveVoucher(qc, oc, id, actor) → voucher`:
    - `submitted` only (`FIN_NOT_SUBMITTED`).
    - The actor must not be the maker (`FIN_OWN_VOUCHER`).
    - Writes `finAudit` action `approve` (spec §8.3 lists it separately from `post`), then calls `finPostLocked` with `{ approvedBy: actor }`.
    - Notifies the maker: `{ kind: 'fin_decision', title: 'Your Finance entry was approved', body: '<number>', … }`.
  - `finRejectVoucher(qc, oc, id, actor, reason) → voucher`:
    - Locks the voucher row only; it does not mint.
    - `submitted` only. A reason is required (`FIN_REASON_REQUIRED`).
    - Status returns to `draft`, and `last_rejected_*` is set.
    - Writes `finAudit` `reject` with the reason, and notifies the maker with `fin_decision` "…was rejected" and the reason.
- Routes:

  | Route | Capability | Mints? |
  |---|---|---|
  | `POST /finance/vouchers/:id/submit` | enter | yes |
  | `POST /finance/vouchers/:id/approve` | approve | yes |
  | `POST /finance/vouchers/:id/reject` | approve | — |

  - An inaccessible voucher id answers 404 `FIN_NOT_FOUND`.

- [ ] **Step 1: Write the failing tests.**
  - In `finance-wiring.test.js`, add:
    - `categoryOf('fin_approval') === 'approvals'` and `categoryOf('fin_decision') === 'decisions'`;
    - `MINTING_POSTS` includes both paths.
  - In `finance-pg-vouchers.test.js`, add:

```js
const submit = (id, who = 'acct') => h.call('POST', `/finance/vouchers/${id}/submit`, null, who);
const make = async (body, who = 'acct') => (await h.call('POST', '/finance/vouchers', body, who)).body.voucher;
const pay = (paise, date = '2027-01-12') => ({ book_id: CI, voucher_type: 'payment', voucher_date: date, client_key: randomUUID(),
  narration: 'rent', lines: [L([RENT, paise, 0]), L([ALPHA, 0, paise])] });
const rcpt = (paise, date) => ({ ...pay(paise, date), voucher_type: 'receipt', lines: [L([ALPHA, paise, 0]), L([CUST_A, 0, paise])] });

test('a journal from the accountant waits for the MD, who is told', async () => {
  const v = await make(jv([[RENT, 250000, 0], [FREIGHT, 0, 250000]]));
  const s = await submit(v.id);
  assert.equal(s.body.voucher.status, 'submitted');
  assert.equal(s.body.voucher.number, null);
  const bell = await h.db.q(`SELECT user_id FROM notifications WHERE kind='fin_approval' AND ref_id=$1`, [v.id]);
  assert.deepEqual(bell.map(r => r.user_id).sort(), [h.users.md.id, h.users.appr2.id].sort());
  assert.equal((await h.call('PUT', `/finance/vouchers/${v.id}`, { narration: 'x' }, 'acct')).body.code, 'FIN_NOT_DRAFT');
  const a = await h.call('POST', `/finance/vouchers/${v.id}/approve`, null, 'md');
  assert.equal(a.body.voucher.status, 'posted');
  assert.match(a.body.voucher.number, /^CI-JV-2627-\d{4}$/);
  assert.equal(a.body.voucher.approved_by_id, h.users.md.id);
  assert.equal((await h.call('POST', `/finance/vouchers/${v.id}/approve`, null, 'md')).body.code, 'FIN_NOT_SUBMITTED');
  assert.equal((await h.db.one(`SELECT COUNT(*)::int n FROM notifications WHERE kind='fin_decision' AND ref_id=$1 AND user_id=$2`, [v.id, h.users.acct.id])).n, 1);
});

test('payments post directly up to the limit and wait above it', async () => {
  const small = await make(pay(5000000));
  const s1 = await submit(small.id);
  assert.equal(s1.body.voucher.status, 'posted');
  assert.equal(s1.body.voucher.self_approved, false);
  assert.match(s1.body.voucher.number, /^CI-PV-2627-\d{4}$/);
  const big = await make(pay(10000001));
  assert.equal((await submit(big.id)).body.voucher.status, 'submitted');
});

test('reject needs a reason, returns the entry to its maker, and an approval after that is refused', async () => {
  const v = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]]));
  await submit(v.id);
  assert.equal((await h.call('POST', `/finance/vouchers/${v.id}/reject`, {}, 'md')).body.code, 'FIN_REASON_REQUIRED');
  const r = await h.call('POST', `/finance/vouchers/${v.id}/reject`, { reason: 'wrong ledger' }, 'md');
  assert.equal(r.body.voucher.status, 'draft');
  assert.equal(r.body.voucher.last_reject_reason, 'wrong ledger');
  assert.equal((await h.call('POST', `/finance/vouchers/${v.id}/approve`, null, 'md')).body.code, 'FIN_NOT_SUBMITTED');
});

test('an approver\'s own entry posts as self-approved; nobody approves their own submitted entry', async () => {
  const v = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]]), 'md');
  const s = await submit(v.id, 'md');
  assert.equal(s.body.voucher.status, 'posted');
  assert.equal(s.body.voucher.self_approved, true);
  const own = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]]), 'md');
  await h.db.q(`UPDATE fin_vouchers SET status='submitted' WHERE id=$1`, [own.id]);
  assert.equal((await h.call('POST', `/finance/vouchers/${own.id}/approve`, null, 'md')).body.code, 'FIN_OWN_VOUCHER');
});

test('closing months force approval; locked months refuse; no year means a sentence, not a 500', async () => {
  await h.call('PUT', `/finance/periods/${PERIOD.CI['2027-02-01']}/status`, { status: 'closing' }, 'md');
  const feb = await make(rcpt(1000, '2027-02-10'));
  assert.equal((await submit(feb.id)).body.voucher.status, 'submitted');
  assert.equal((await h.call('POST', `/finance/vouchers/${feb.id}/approve`, null, 'md')).body.voucher.status, 'posted');
  await h.call('PUT', `/finance/periods/${PERIOD.CI['2027-02-01']}/status`, { status: 'locked' }, 'md');
  const late = await make(rcpt(1000, '2027-02-11'));
  assert.equal((await submit(late.id)).body.code, 'FIN_PERIOD_LOCKED');
  const april = await make(rcpt(1000, '2027-04-05'));
  const n = await submit(april.id);
  assert.equal(n.status, 409);
  assert.equal(n.body.code, 'FIN_NO_PERIOD');
  assert.match(n.body.error, /Setup/);
});

test('31 March and 1 April number in different series', async () => {
  await h.call('POST', '/finance/years', { book_id: CI, label: '2027-28' }, 'md');
  const mar = await submit((await make(rcpt(1000, '2027-03-31'))).id);
  const apr = await submit((await make(rcpt(1000, '2027-04-01'))).id);
  assert.match(mar.body.voucher.number, /^CI-RV-2627-\d{4}$/);
  assert.equal(apr.body.voucher.number, 'CI-RV-2728-0001');
});

test('the database sentence reaches the user: unbalanced and wrong-shape entries', async () => {
  const u = await submit((await make(jv([[RENT, 12000000, 0], [FREIGHT, 0, 11800000]]))).id);
  assert.equal(u.body.code, 'FIN_UNBALANCED');
  assert.equal(u.body.error, "Debits ₹1,20,000.00 and credits ₹1,18,000.00 don't match — difference ₹2,000.00.");
  const s = await submit((await make(jv([[ALPHA, 100, 0], [FREIGHT, 0, 100]]))).id);
  assert.equal(s.body.code, 'FIN_SHAPE');
});
```

- [ ] **Step 2: Run them.**
  Run: `cd server && node --test src/finance-wiring.test.js && FINANCE_PG=1 node --test src/finance-pg-vouchers.test.js`
  Expected: FAIL. The kinds and paths are not registered, and the submit, approve and reject routes don't exist.

- [ ] **Step 3: Implement** the five functions, the three routes, and both shared edits.

- [ ] **Step 4: Run them.** Same command. Expected: PASS.

- [ ] **Step 5: Checkpoint.** `npm test` must also pass `mint-routes-join-once.test.js`. The scan derives the two minting routes through `finSubmitVoucher` → `finPostLocked` → `nextNumber`, and `finApproveVoucher` → `finPostLocked` → `nextNumber`. It must not report `/finance/vouchers/:id/reject` as minting.

---

### Task 10: Reversal, and what happens when two people act at once

**Files:**
- Modify: `server/src/finance-vouchers.js`, `server/src/routes/finance.js`
- Modify (shared): `client/src/lib/writeOnce.js`, adding `'/finance/vouchers/:id/reverse'`
- Test: extend `server/src/finance-pg-vouchers.test.js`; create `server/src/finance-pg-race.test.js`

**Interfaces:**
- Consumes: `finVoucherCtx`, `finPostLocked`, `finSubmitVoucher` (Task 9); `finSetPeriodStatus` (Task 7).
- Produces: `finReverseVoucher(qc, oc, id, actor, { date, reason }) → reversal voucher`. The steps, in lock order:
  1. **Unlocked reads:** the original and its book; the period covering `date` (`FIN_NO_PERIOD`); `prefix = finPrefix(book.code, 'journal', year.short)`.
  2. **Locks:** `lockDocNumber(prefix, oc)`, then the original `FOR UPDATE`.
  3. **Checks:** the original is `posted` (`FIN_NOT_POSTED`) and has no `reversed_by_id` (`FIN_ALREADY_REVERSED`). A reason is required (`FIN_REASON_REQUIRED`); the date must be valid (`FIN_BAD_DATE`).
  4. **Insert the reversal:** a `journal` with `reversal_of_id` set, `voucher_date = date`, narration `Reversal of <number> — <reason>`, the same `total`, and every line mirrored (debit ↔ credit, same narration and bill fields). It starts as a `draft` made by the actor.
  5. **Approver:** if the actor's roles include `approver`, call `finVoucherCtx` on the new id (re-entering the same prefix lock is a no-op), then `finPostLocked(…, { approvedBy: actor, selfApproved: true })`.
  6. **Otherwise:** status becomes `submitted`, and approvers get `fin_approval`.
  7. **Audit:** write `finAudit` on the original: action `reverse`, with the reason.
- Route: `POST /finance/vouchers/:id/reverse`, body `{ date, reason }`, capability enter. It mints.

- [ ] **Step 1: Write the failing tests.**

  In `finance-pg-vouchers.test.js`:

```js
test('an approver reverses at once; both entries stay; every ledger nets to zero', async () => {
  const p = (await submit((await make(pay(300000, '2027-01-15'))).id)).body.voucher;
  const r = await h.call('POST', `/finance/vouchers/${p.id}/reverse`, { date: '2027-01-16', reason: 'duplicate' }, 'md');
  assert.equal(r.body.voucher.status, 'posted');
  assert.equal(r.body.voucher.self_approved, true);
  assert.match(r.body.voucher.number, /^CI-JV-2627-\d{4}$/);
  const o = (await h.call('GET', `/finance/vouchers/${p.id}`, null, 'md')).body;
  assert.equal(o.voucher.reversed_by_id, r.body.voucher.id);
  assert.equal(o.can.reverse, false);
  const net = await h.db.q(`SELECT ledger_id, SUM(debit - credit)::float s FROM fin_voucher_lines WHERE voucher_id = ANY($1) GROUP BY 1`, [[p.id, r.body.voucher.id]]);
  assert.ok(net.every(x => Math.round(x.s * 100) === 0));
  assert.equal((await h.call('POST', `/finance/vouchers/${p.id}/reverse`, { date: '2027-01-17', reason: 'again' }, 'md')).body.code, 'FIN_ALREADY_REVERSED');
});

test('an accountant asks; the MD approves; drafts and reasonless reversals are refused', async () => {
  const p = (await submit((await make(pay(1000, '2027-01-15'))).id)).body.voucher;
  assert.equal((await h.call('POST', `/finance/vouchers/${p.id}/reverse`, { date: '2027-01-16' }, 'acct')).body.code, 'FIN_REASON_REQUIRED');
  const r = await h.call('POST', `/finance/vouchers/${p.id}/reverse`, { date: '2027-01-16', reason: 'wrong vendor' }, 'acct');
  assert.equal(r.body.voucher.status, 'submitted');
  await h.call('POST', `/finance/vouchers/${r.body.voucher.id}/approve`, null, 'md');
  assert.equal((await h.call('GET', `/finance/vouchers/${p.id}`, null, 'md')).body.voucher.reversed_by_id, r.body.voucher.id);
  const d = await make(pay(1000, '2027-01-15'));
  assert.equal((await h.call('POST', `/finance/vouchers/${d.id}/reverse`, { date: '2027-01-16', reason: 'x' }, 'md')).body.code, 'FIN_NOT_POSTED');
});

test('a voucher in a locked month is reversed into an open one, never into a locked one', async () => {
  const jan = (await submit((await make(pay(1000, '2027-01-25'))).id)).body.voucher;
  await h.call('PUT', `/finance/periods/${PERIOD.CI['2027-01-01']}/status`, { status: 'closing' }, 'md');
  await h.call('PUT', `/finance/periods/${PERIOD.CI['2027-01-01']}/status`, { status: 'locked' }, 'md');
  assert.equal((await h.call('POST', `/finance/vouchers/${jan.id}/reverse`, { date: '2027-01-26', reason: 'x' }, 'md')).body.code, 'FIN_PERIOD_LOCKED');
  assert.equal((await h.call('POST', `/finance/vouchers/${jan.id}/reverse`, { date: '2027-03-02', reason: 'x' }, 'md')).body.voucher.status, 'posted');
});
```

  **Ordering:** these run after Task 9's tests, which lock February. The January lock here runs last, so it never blocks an earlier test.

  In `server/src/finance-pg-race.test.js` (FINANCE_PG gated):
  - **Setup:** `finBootPg('race')`, plus two raw `pg.Client`s on `process.env.DATABASE_URL`.
  - **`inTx(client, fn)`:** builds `qc` / `oc` the way `tx()` does, runs `BEGIN` → `fn` → `COMMIT`, and `ROLLBACK`s on throw.
  - **`MD`:** `{ id: h.users.md.id, name: 'MD', roles: ['approver', 'admin'] }`.

```js
test('two postings in one series at the same moment get two consecutive numbers', async () => {
  const [a, b] = [await draftReceipt('2027-01-05'), await draftReceipt('2027-01-05')];
  const [x, y] = await Promise.all([
    inTx(c1, (qc, oc) => finSubmitVoucher(qc, oc, a, MD)),
    inTx(c2, (qc, oc) => finSubmitVoucher(qc, oc, b, MD)),
  ]);
  const n = [x.number, y.number].map(s => +s.slice(-4)).sort((p, q) => p - q);
  assert.equal(n[1] - n[0], 1);
});

test('the same draft submitted twice at once posts once', async () => {
  const a = await draftReceipt('2027-01-06');
  const results = await Promise.allSettled([
    inTx(c1, (qc, oc) => finSubmitVoucher(qc, oc, a, MD)),
    inTx(c2, (qc, oc) => finSubmitVoucher(qc, oc, a, MD)),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.body.code, 'FIN_NOT_DRAFT');
});

test('a posting that waits on a month being locked is refused once the lock lands', async () => {
  const jan = PERIOD.CI['2027-01-01'];
  await inTx(c1, (qc, oc) => finSetPeriodStatus(qc, oc, jan, { status: 'closing' }, MD));
  await c2.query('BEGIN');
  const q2 = async (t, p) => (await c2.query(t, p)).rows;
  await finSetPeriodStatus(q2, async (t, p) => (await q2(t, p))[0] ?? null, jan, { status: 'locked' }, MD);
  const v = await draftReceipt('2027-01-07');
  let settled = false;
  const posting = inTx(c1, (qc, oc) => finSubmitVoucher(qc, oc, v, MD)).finally(() => { settled = true; });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(settled, false, 'the posting waits for the lock');
  await c2.query('COMMIT');
  await assert.rejects(posting, e => e.body?.code === 'FIN_PERIOD_LOCKED');
});
```

  `draftReceipt(date)` creates a CI receipt draft through the API as md and returns its id.

- [ ] **Step 2: Run them.**
  Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-vouchers.test.js src/finance-pg-race.test.js`
  Expected: FAIL.
  - The reverse route answers 404.
  - The race tests fail on the missing route or function. If the two race tests on posting **pass** before Task 9's lock order exists, that shows nothing: temporarily move `lockDocNumber` after the voucher's `FOR UPDATE` in `finVoucherCtx`, and confirm the first test then fails on a duplicate number (23505). Restore it.

- [ ] **Step 3: Implement** `finReverseVoucher`, its route, and the `MINTING_POSTS` line.

- [ ] **Step 4: Run them.** Same command. Expected: PASS.

- [ ] **Step 5: Checkpoint.**

---

### Task 11: Reports — trial balance, ledger, journal register, self-approved, activity

**Files:**
- Create: `server/src/finance-reports.js`
- Modify: `server/src/routes/finance.js`
- Test: `server/src/finance-pg-reports.test.js`

**Interfaces:**
- Consumes: `finToPaise` (Task 1); `finRequire`, `finBookIdsFor` (Task 6).
- **Rules for every report:**
  - Only `posted` vouchers count.
  - Balances are signed: positive = Dr.
  - Sums are done in SQL, then converted to paise with `finToPaise`.
- Produces:
  - `finTrialBalance(bookId, { from = null, to }) → { book_id, from, to, groups, ledgers, totals }`
    - `opening_paise` = lines dated before `from`. With no `from`, opening is 0 and every line up to `to` is movement.
    - `groups: [{ id, parent_id, name, nature, depth, opening_paise, debit_paise, credit_paise, closing_paise }]`, rolled up through the tree, in template `sort_order`.
    - `ledgers: [{ id, group_id, name, opening_paise, debit_paise, credit_paise, closing_paise }]`. All-zero ledgers are omitted unless `all=1`.
    - `totals: { opening_dr, opening_cr, debit, credit, closing_dr, closing_cr }`, all in paise.
  - `finLedgerStatement(ledgerId, { from, to }) → { ledger: { id, name, book_id, group_name }, opening_paise, entries, total_debit_paise, total_credit_paise, closing_paise }`
    - `entries: [{ voucher_id, number, voucher_date, voucher_type, narration, against, debit_paise, credit_paise, balance_paise }]`, ordered by `voucher_date`, then `posted_at`, then voucher id, then `line_no`.
    - `against` is the other ledgers' names in the same voucher, comma-joined, at most three, then "…".
  - `finJournalRegister(bookId, { from, to, type }) → { vouchers: [{ id, number, voucher_date, voucher_type, narration, total_paise, lines: [{ ledger_name, debit_paise, credit_paise }] }] }`
  - `finSelfApproved(bookId, { from, to }) → { vouchers }`. Same shape as the register, without lines.
  - `finActivity(bookIds, { book, from, to, user, entity }) → { rows: [{ id, at, book_id, user_name, entity, entity_id, action, reason, before, after }] }`. Newest first, at most 500 rows, and never a row outside `bookIds`.
- Routes, all capability view:

  | Route | Notes |
  |---|---|
  | `GET /finance/reports/trial-balance?book&from&to` | |
  | `GET /finance/reports/ledger?ledger&from&to` | The book is the ledger's |
  | `GET /finance/reports/journal-register?book&from&to&type` | |
  | `GET /finance/reports/self-approved?book&from&to` | |
  | `GET /finance/activity?book&from&to&user&entity` | |

- [ ] **Step 1: Write the failing tests** in `server/src/finance-pg-reports.test.js` (FINANCE_PG gated).
  - **Fixture:** `finBootPg('reports')`, plus the CI ledgers of Task 8. Then, as md (self-approved), post:
    - a receipt of ₹1,00,000 on 2027-01-05 (Alpha Bank Dr / Customer A Cr);
    - a payment of ₹25,000 on 2027-01-20 (Rent Dr / Alpha Bank Cr);
    - a journal of ₹5,000 on 2027-02-03 (Freight Dr / Rent Cr), then reverse it on 2027-02-10.

```js
const R = 100; // paise per rupee
test('trial balance as at 31 Jan balances and shows each ledger signed Dr/Cr', async () => {
  const tb = (await h.call('GET', `/finance/reports/trial-balance?book=${CI}&to=2027-01-31`, null, 'viewer')).body;
  const by = Object.fromEntries(tb.ledgers.map(l => [l.name, l.closing_paise]));
  assert.deepEqual([by['Alpha Bank'], by['Customer A'], by['Rent']], [75000 * R, -100000 * R, 25000 * R]);
  assert.equal(tb.totals.closing_dr, tb.totals.closing_cr);
  assert.equal(tb.totals.closing_dr, 100000 * R);
});

test('a February range carries January in its opening and nets the reversed journal to zero', async () => {
  const tb = (await h.call('GET', `/finance/reports/trial-balance?book=${CI}&from=2027-02-01&to=2027-02-28`)).body;
  const f = tb.ledgers.find(l => l.name === 'Freight');
  assert.deepEqual([f.opening_paise, f.debit_paise, f.credit_paise, f.closing_paise], [0, 5000 * R, 5000 * R, 0]);
  assert.equal(tb.ledgers.find(l => l.name === 'Rent').opening_paise, 25000 * R);
  assert.equal(tb.totals.opening_dr, tb.totals.opening_cr);
  assert.equal(tb.totals.debit, tb.totals.credit);
});

test('groups roll up their ledgers', async () => {
  const tb = (await h.call('GET', `/finance/reports/trial-balance?book=${CI}&to=2027-01-31`)).body;
  assert.equal(tb.groups.find(g => g.name === 'Current Assets').closing_paise, (75000 - 100000) * R);
});

test('a ledger statement runs its balance and closes on the trial balance figure', async () => {
  const s = (await h.call('GET', `/finance/reports/ledger?ledger=${ALPHA}&from=2027-01-01&to=2027-01-31`)).body;
  assert.deepEqual(s.entries.map(e => e.balance_paise), [100000 * R, 75000 * R]);
  assert.equal(s.closing_paise, 75000 * R);
  assert.match(s.entries[0].against, /Customer A/);
});

test('journal register and self-approved list what was posted', async () => {
  const j = (await h.call('GET', `/finance/reports/journal-register?book=${CI}&from=2027-02-01&to=2027-02-28&type=journal`)).body;
  assert.equal(j.vouchers.length, 2);
  const sa = (await h.call('GET', `/finance/reports/self-approved?book=${CI}&from=2027-01-01&to=2027-03-31`)).body;
  assert.equal(sa.vouchers.length, 2); // the journal (rule always) and its reversal; receipt and small payment need no approval
});

test('one-book logins never see the other book', async () => {
  assert.equal((await h.call('GET', `/finance/reports/trial-balance?book=${DP}&to=2027-03-31`, null, 'viewer')).status, 403);
  assert.equal((await h.call('GET', `/finance/reports/ledger?ledger=${ALPHA}&from=2027-01-01&to=2027-01-31`, null, 'dpOnly')).status, 403);
  const act = (await h.call('GET', '/finance/activity', null, 'dpOnly')).body.rows;
  assert.ok(act.length > 0 && act.every(r => r.book_id === DP));
});
```

  **One-book fixture:** dpOnly first posts one DP draft, so its activity list is not empty.

- [ ] **Step 2: Run it.**
  Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-reports.test.js`
  Expected: FAIL. The routes answer 404.

- [ ] **Step 3: Implement** `finance-reports.js` and the five routes.

- [ ] **Step 4: Run it.** Same command. Expected: PASS (6 tests).

- [ ] **Step 5: Checkpoint.**

---

### Task 12: Approval rules and Finance access management

**Files:**
- Create: `server/src/finance-admin.js`
- Modify: `server/src/routes/finance.js`
- Test: `server/src/finance-pg-admin.test.js`

**Interfaces:**
- Consumes: `FIN_ROLES` (Task 2); `finForgetAccess` (Task 6); `finAudit` (Task 4).
- Produces:
  - `finUpdateRule(qc, oc, ruleId, { mode, limit_paise }, actor) → rule`
    - `mode` must be one of `always` / `above_limit` / `never`.
    - `limit_paise` is required exactly when the mode is `above_limit`, and must be a safe integer ≥ 0. Otherwise `FIN_BAD_INPUT`.
  - `finGrantAccess(qc, oc, { user_id, book_id, roles, can_export = true }, actor) → grant`
    - An upsert on (user_id, book_id).
    - `roles` must be a non-empty subset of `FIN_ROLES`.
    - The user must exist and be active; otherwise `FIN_BAD_INPUT`.
  - `finRevokeAccess(qc, oc, grantId, actor)`.
  - **Last-admin guard:** removing the last `admin` role on a book, by grant or revoke, is 409 `FIN_LAST_ADMIN`.
  - Grant and revoke call `finForgetAccess(user_id)` after the transaction commits.
- Routes:

  | Route | Capability | Response / notes |
  |---|---|---|
  | `GET /finance/approval-rules?book` | view | `{ rules: [{ id, book_id, rule_key, mode, limit_paise, updated_by, updated_at }] }` |
  | `PUT /finance/approval-rules/:id` | admin | |
  | `GET /finance/access` | admin on at least one book | `{ grants: [{ id, user_id, user_name, email, book_id, roles, can_export }], users: [{ id, name, email, role }] }`. Grants only for books the caller administers; users are active users only |
  | `POST /finance/access` | admin on that book | |
  | `DELETE /finance/access/:id` | admin on that book | |

- [ ] **Step 1: Write the failing tests** in `server/src/finance-pg-admin.test.js` (FINANCE_PG gated, `finBootPg('admin')`):

```js
test('the MD lowers the payment limit and the next payment waits', async () => {
  const rule = (await h.call('GET', `/finance/approval-rules?book=${CI}`)).body.rules.find(r => r.rule_key === 'payment');
  assert.equal((await h.call('PUT', `/finance/approval-rules/${rule.id}`, { mode: 'above_limit', limit_paise: 5000000 }, 'acct')).status, 403);
  assert.equal((await h.call('PUT', `/finance/approval-rules/${rule.id}`, { mode: 'above_limit' }, 'md')).body.code, 'FIN_BAD_INPUT');
  assert.equal((await h.call('PUT', `/finance/approval-rules/${rule.id}`, { mode: 'above_limit', limit_paise: 5000000 }, 'md')).status, 200);
  assert.equal((await submitPayment(6000000)).status, 'submitted');
});

test('a grant takes effect at once and a revoke removes it at once', async () => {
  const g = await h.call('POST', '/finance/access', { user_id: h.users.plant.id, book_id: CI, roles: ['viewer'] }, 'md');
  assert.equal(g.status, 200);
  assert.deepEqual((await h.call('GET', '/finance/me', null, 'plant')).body.books.map(b => b.code), ['CI']);
  await h.call('DELETE', `/finance/access/${g.body.grant.id}`, null, 'md');
  assert.deepEqual((await h.call('GET', '/finance/me', null, 'plant')).body.books, []);
  assert.equal((await h.call('GET', '/finance/access', null, 'acct')).status, 403);
  assert.equal((await h.call('POST', '/finance/access', { user_id: h.users.plant.id, book_id: CI, roles: ['owner'] }, 'md')).body.code, 'FIN_BAD_INPUT');
});

test('the last admin of a book cannot remove themself', async () => {
  const mine = (await h.call('GET', '/finance/access', null, 'md')).body.grants.find(x => x.user_id === h.users.md.id && x.book_id === DP);
  assert.equal((await h.call('POST', '/finance/access', { user_id: h.users.md.id, book_id: DP, roles: ['approver'] }, 'md')).body.code, 'FIN_LAST_ADMIN');
  assert.equal((await h.call('DELETE', `/finance/access/${mine.id}`, null, 'md')).body.code, 'FIN_LAST_ADMIN');
});

test('rule and access changes are in the activity log with before and after', async () => {
  const rows = (await h.call('GET', `/finance/activity?book=${CI}`)).body.rows;
  assert.ok(rows.some(r => r.entity === 'rule' && r.before && r.after));
  assert.ok(rows.some(r => r.entity === 'access' && r.action === 'revoke'));
});
```

  `submitPayment(paise)` creates and submits a CI payment as acct, using ledgers created in `before()`, and returns the voucher.

- [ ] **Step 2: Run it.**
  Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-admin.test.js`
  Expected: FAIL (404).

- [ ] **Step 3: Implement** `finance-admin.js` and the five routes.

- [ ] **Step 4: Run it.** Expected: PASS (4 tests).

- [ ] **Step 5: Checkpoint.**

---

### Task 13: Tally import — matching, tie-out, the Opening voucher, the parallel-run report

**Files:**
- Create:
  - `client/src/lib/finance/tally.js` — pure: header detection, sheet rows, Tally dates.
  - `server/src/finance-import.js`
- Modify: `server/src/routes/finance.js`
- Modify (shared): `client/src/lib/writeOnce.js`, adding `'/finance/imports/:id/build-opening'`
- Test: `server/src/finance-import.test.js` (pure), `server/src/finance-pg-import.test.js`

**Interfaces:**
- Consumes:
  - `finParseTallyAmount`, `finIsValidDate`, `finDayBefore` (Task 1)
  - `finCreateLedger` (Task 7)
  - `finSubmitVoucher`, `finVoucherCtx` (Task 9)
  - `finTrialBalance` (Task 11)
- Produces, in `tally.js`:
  - `finDetectColumns(headerCells, kind) → mapping | null`, where `kind` is `'tb' | 'accounts' | 'bills'`.
    - Matching is case-insensitive, trimmed and exact against these aliases:

      | Column | Aliases |
      |---|---|
      | name | `Particulars`, `Ledger`, `Name of Ledger`, `Account` |
      | group | `Group`, `Under`, `Parent` |
      | debit | `Debit`, `Dr`, `Closing Balance Debit` |
      | credit | `Credit`, `Cr`, `Closing Balance Credit` |
      | date | `Date` |
      | ref | `Ref. No.`, `Ref No`, `Reference`, `Bill No` |
      | party | `Party's Name`, `Party Name` |
      | amount | `Pending Amount`, `Pending`, `Amount`, `Balance` |
      | due | `Due on`, `Due Date` |

    - It returns column indexes, or `null` when a required column is missing.
  - `finRowsFromSheet(rows: any[][], kind, mapping) → rows`. It skips rows with a blank name and the `Grand Total` row.
    - `tb` rows: `{ tally_name, debit_paise, credit_paise }`
    - `accounts` rows: `{ tally_name, tally_group }`
    - `bills` rows: `{ tally_ledger_name, bill_ref, bill_date, due_date, amount_paise, side }`, with `side` = `'dr'` when the parsed amount is positive and `'cr'` when negative.
  - `finTallyDate(cell) → 'YYYY-MM-DD' | null`. Accepts a JS `Date` (ExcelJS date cells; take its UTC parts), `1-Dec-26`, `01-12-2026` (day-month-year) and `2026-12-01`.
- Produces, in `finance-import.js` (pure parts):
  - `finNormName(s) → string`: lower-case, trimmed, internal whitespace collapsed, trailing dots removed.
  - `finProposeMatches({ rows, ledgers, groups, parties }) → Array<{ tally_name, action: 'match'|'create'|'unmatched', ledger_id?, group_id?, party_type?, party_id? }>`
    - Match an existing ledger by `tally_name`, then by normalised name.
    - Otherwise `create`, under the Finance group whose normalised name equals the row's `tally_group`.
    - Under a party group, propose `party_type` / `party_id` from `parties`, by normalised name. `groups` arrive as `[{ id, name, is_party }]`, where the caller sets `is_party` when the group is, or descends from, Sundry Debtors or Sundry Creditors.
    - With no such group, `unmatched`.
  - `finTieOut({ ledgers, bills }) → { ok, problems: [{ code, message }], warnings: [string], totals: { dr, cr } }`
    - `TB_UNBALANCED`: Σdebit ≠ Σcredit.
    - `UNMATCHED`: one per `unmatched` row.
    - `BILLS_MISMATCH`: a party's signed bills ≠ its TB net, with the message `<party>: bills ₹X, trial balance ₹Y.`.
    - A party with no bills is a **warning**, not a problem.
- Produces, in `finance-import.js` (database parts):
  - `finCreateImport(qc, oc, { book_id, purpose, as_at, file_names, accounts, tb, bills }, actor) → importId`
    - TB rows are kept only when a ledger names them: the accounts list for `opening`, or the book's ledgers for `parallel_tb`.
    - Rows whose normalised name is a Finance group, or `grand total`, are counted in `summary.ignored_rows` and not stored.
    - Proposals are stored on `fin_import_ledgers`.
    - **Audit:** `finCreateImport`, `finSaveMatches` and `finBuildOpening` each append one `finAudit` row: entity `import`, actions `upload` / `match` / `build` (spec §8.3).
    - **Real Tally headers:** the alias table in `tally.js` is a starting point. When the accountant's real exports arrive (spec §11.1), add any header they use that the table misses, test-first, before the January import.
  - `finSaveMatches(qc, oc, importId, matches, actor)`, with `matches: [{ row_id, action, ledger_id?, group_id?, party_type?, party_id? }]`.
  - `finImportView(importId) → { import, ledgers, bills, tie_out }`
  - `finBuildOpening(qc, oc, importId, actor) → voucher`
    - **Refusals:** `purpose` must be `opening`, and the import not yet `used` (`FIN_BAD_INPUT`). The tie-out must be `ok`, otherwise 409 `FIN_TIE_OUT` with `body.problems`.
    - **Lock first:** `lockDocNumber(finPrefix(code, 'opening', fyShort(day before books_begin)), oc)`.
    - **Create ledgers:** call `finCreateLedger` for each `create` row, with `tally_name` set.
    - **Insert the voucher:** one `opening` voucher dated the day before `books_begin`, with one line per ledger's net balance (Dr if positive, Cr if negative), or one line per bill for party ledgers that have bills.
    - **Submit:** call `finSubmitVoucher`. Mark the import `used` and set `opening_voucher_id`.
    - **Line cap:** the 200-line cap is for `POST /finance/vouchers` only. An Opening voucher may have up to 5,000 lines.
  - `finParallelRun(importId) → { import: { id, book_id, as_at }, rows, unmatched, totals }`
    - `rows: [{ ledger_id, ledger_name, tally_name, tally_closing_paise, finance_closing_paise, difference_paise }]`
    - `unmatched: [{ tally_name, tally_closing_paise }]`
    - `totals: { differing }`
    - Finance closings come from `finTrialBalance(book, { to: as_at })`. A Finance ledger with a balance but no Tally row appears with `tally_closing_paise: 0`.
- Routes:

  | Route | Capability | Notes |
  |---|---|---|
  | `POST /finance/imports` | import | Rows parsed in the browser |
  | `GET /finance/imports?book&purpose` | view | |
  | `GET /finance/imports/:id` | view | |
  | `PUT /finance/imports/:id/matches` | import | |
  | `POST /finance/imports/:id/build-opening` | import | Mints |
  | `GET /finance/reports/parallel-run?import` | view | |

- [ ] **Step 1: Write the failing pure tests** in `server/src/finance-import.test.js`:

```js
import { finDetectColumns, finRowsFromSheet, finTallyDate } from '../../client/src/lib/finance/tally.js';
import { finNormName, finProposeMatches, finTieOut } from './finance-import.js';

test('Tally headers are found by their own names', () => {
  assert.deepEqual(finDetectColumns(['Particulars', 'Debit', 'Credit'], 'tb'), { name: 0, debit: 1, credit: 2 });
  assert.deepEqual(finDetectColumns(['Date', 'Ref. No.', "Party's Name", 'Pending Amount', 'Due on', 'Overdue by days'], 'bills'),
    { date: 0, ref: 1, party: 2, amount: 3, due: 4 });
  assert.equal(finDetectColumns(['Item', 'Qty'], 'tb'), null);
});

test('sheet rows become paise, Tally dates become ISO, the total row is skipped', () => {
  const m = { name: 0, debit: 1, credit: 2 };
  assert.deepEqual(finRowsFromSheet([['Alpha Bank', '1,00,000.00', ''], ['Grand Total', '1,00,000.00', '1,00,000.00'], ['', '', '']], 'tb', m),
    [{ tally_name: 'Alpha Bank', debit_paise: 10000000, credit_paise: 0 }]);
  const b = finRowsFromSheet([['1-Dec-26', 'INV-12', 'Acme Pharma Ltd', '59,000.00 Dr', '31-Dec-26']], 'bills', { date: 0, ref: 1, party: 2, amount: 3, due: 4 });
  assert.deepEqual(b, [{ tally_ledger_name: 'Acme Pharma Ltd', bill_ref: 'INV-12', bill_date: '2026-12-01', due_date: '2026-12-31', amount_paise: 5900000, side: 'dr' }]);
  assert.equal(finTallyDate(new Date(Date.UTC(2026, 11, 1))), '2026-12-01');
  assert.equal(finTallyDate('01-12-2026'), '2026-12-01');
  assert.equal(finTallyDate('31-Feb-27'), null);
});

test('matching prefers the Tally name, then the normalised name, then proposes a ledger under the Tally group', () => {
  const out = finProposeMatches({
    rows: [{ tally_name: 'Cash', tally_group: 'Cash-in-Hand' }, { tally_name: 'Alpha Bank.', tally_group: 'Bank Accounts' },
           { tally_name: 'Acme  Pharma Ltd', tally_group: 'Sundry Debtors' }, { tally_name: 'Mystery', tally_group: 'Nowhere' }],
    ledgers: [{ id: 1, name: 'Cash', tally_name: null }],
    groups: [{ id: 10, name: 'Bank Accounts', is_party: false }, { id: 11, name: 'Sundry Debtors', is_party: true }, { id: 12, name: 'Cash-in-Hand', is_party: false }],
    parties: [{ party_type: 'customer', id: 7, name: 'Acme Pharma Ltd' }],
  });
  assert.deepEqual(out.map(o => [o.action, o.ledger_id ?? o.group_id ?? null]), [['match', 1], ['create', 10], ['create', 11], ['unmatched', null]]);
  assert.deepEqual([out[2].party_type, out[2].party_id], ['customer', 7]);
  assert.equal(finNormName('  Alpha   Bank. '), 'alpha bank');
});

test('tie-out: balanced, unmatched, and a party whose bills disagree with its balance', () => {
  const ok = finTieOut({ ledgers: [{ tally_name: 'A', debit_paise: 500, credit_paise: 0, action: 'match', is_party: false },
                                   { tally_name: 'B', debit_paise: 0, credit_paise: 500, action: 'create', is_party: true }],
                         bills: [{ tally_ledger_name: 'B', amount_paise: -500, side: 'cr' }] });
  assert.equal(ok.ok, true);
  const bad = finTieOut({ ledgers: [{ tally_name: 'A', debit_paise: 500, credit_paise: 0, action: 'unmatched', is_party: false },
                                    { tally_name: 'B', debit_paise: 0, credit_paise: 400, action: 'create', is_party: true }],
                          bills: [{ tally_ledger_name: 'B', amount_paise: -300, side: 'cr' }] });
  assert.deepEqual(bad.problems.map(p => p.code).sort(), ['BILLS_MISMATCH', 'TB_UNBALANCED', 'UNMATCHED']);
  assert.match(bad.problems.find(p => p.code === 'BILLS_MISMATCH').message, /^B: bills ₹3\.00 Cr, trial balance ₹4\.00 Cr\.$/);
});
```

  `finTieOut` formats amounts with `finFormatINR(…, { drcr: true })`. The expected message above reflects that.

- [ ] **Step 2: Run it.**
  Run: `cd server && node --test src/finance-import.test.js`
  Expected: FAIL (module not found).

- [ ] **Step 3: Implement `tally.js` and the pure half of `finance-import.js`.** Run it again. Expected: PASS (4 tests).

- [ ] **Step 4: Write the failing database tests** in `server/src/finance-pg-import.test.js` (FINANCE_PG gated):
  - **Fixture:** `finBootPg('import')`, and a customer named `Acme Pharma Ltd` inserted by SQL.
  - **`ACCOUNTS`:**

    | Ledger | Tally group |
    |---|---|
    | Proprietor Capital A/c | Capital Account |
    | Alpha Bank | Bank Accounts |
    | Acme Pharma Ltd | Sundry Debtors |
    | Sales @ 5% | Sales Accounts |
    | Output IGST | Duties & Taxes |
    | Profit & Loss A/c | Profit & Loss |
    | Cash | Cash-in-Hand |

  - **`TB` as at 2026-12-31**, with a group row `Current Assets` mixed in to prove it is ignored, and Dr total = Cr total = ₹6,59,000:

    | Ledger | Dr | Cr |
    |---|---|---|
    | Alpha Bank | 5,00,000 | |
    | Acme Pharma Ltd | 1,59,000 | |
    | Proprietor Capital A/c | | 3,00,000 |
    | Sales @ 5% | | 3,00,000 |
    | Output IGST | | 15,000 |
    | Profit & Loss A/c | | 44,000 |

  - **`BILLS`:** Acme has two bills, ₹1,00,000 Dr and ₹59,000 Dr.

```js
test('opening: upload, confirm matches, tie out, build, MD posts — and the 31 Dec trial balance is Tally\'s', async () => {
  const up = await h.call('POST', '/finance/imports', { book_id: CI, purpose: 'opening', as_at: '2026-12-31', file_names: ['tb.xlsx'], accounts: ACCOUNTS, tb: TB, bills: BILLS }, 'acct');
  assert.equal(up.status, 200);
  assert.equal(up.body.import.summary.ignored_rows, 1);
  const galpha = up.body.ledgers.find(r => r.tally_name === 'Acme Pharma Ltd');
  assert.equal(galpha.match_status, 'create');
  await h.call('PUT', `/finance/imports/${up.body.import.id}/matches`, { matches: up.body.ledgers.map(r => ({ row_id: r.id, action: r.match_status === 'matched' ? 'match' : r.match_status, ledger_id: r.ledger_id, group_id: r.group_id, party_type: r.party_type, party_id: r.party_id })) }, 'acct');
  const view = (await h.call('GET', `/finance/imports/${up.body.import.id}`)).body;
  assert.equal(view.tie_out.ok, true, JSON.stringify(view.tie_out.problems));
  const built = await h.call('POST', `/finance/imports/${up.body.import.id}/build-opening`, null, 'acct');
  assert.equal(built.body.voucher.status, 'submitted');
  assert.equal(built.body.voucher.voucher_type, 'opening');
  assert.equal(built.body.voucher.voucher_date, '2026-12-31');
  const posted = await h.call('POST', `/finance/vouchers/${built.body.voucher.id}/approve`, null, 'md');
  assert.equal(posted.body.voucher.number, 'CI-OB-2627-0001');
  const tb = (await h.call('GET', `/finance/reports/trial-balance?book=${CI}&to=2026-12-31`)).body;
  const by = Object.fromEntries(tb.ledgers.map(l => [l.name, l.closing_paise]));
  for (const r of TB.filter(r => r.tally_name !== 'Current Assets'))
    assert.equal(by[r.tally_name] ?? 0, r.debit_paise - r.credit_paise, r.tally_name);
  const lines = (await h.call('GET', `/finance/vouchers/${built.body.voucher.id}`)).body.lines.filter(l => l.bill_ref);
  assert.equal(lines.length, 2);
});

test('a second opening for the same book is refused', async () => { /* new import + build → 409 FIN_OPENING_EXISTS after MD approves */ });

test('a tie-out problem blocks the build and says why', async () => { /* TB with one ledger off by ₹1 → build-opening 409 FIN_TIE_OUT, body.problems[0].code TB_UNBALANCED */ });

test('the parallel run shows the one ledger that differs from Tally', async () => {
  /* md posts a ₹10,000 receipt on 2027-01-10 (Alpha Bank Dr / Acme Cr). Import a parallel_tb as at 2027-01-31 whose Alpha Bank row is
     ₹1,000 higher than Finance's and whose other rows equal Finance. Expect: report.rows for Alpha Bank has difference_paise 100000,
     every other row 0, totals.differing === 1, and the 'Current Assets' group row in neither rows nor unmatched. */
});
```

  Write each commented test body out in full. The comment lists its exact steps and assertions.

- [ ] **Step 5: Run it.**
  Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-import.test.js`
  Expected: FAIL (404).

- [ ] **Step 6: Implement** the database half and the six routes, and add the `MINTING_POSTS` line.

- [ ] **Step 7: Run it.** Same command. Expected: PASS (4 tests).

- [ ] **Step 8: Checkpoint.** `mint-routes-join-once` must list `/finance/imports/:id/build-opening`, and nothing else from imports.

---

### Task 14: Client shell — module, route, sidebar, book switch, no-access state

**Files:**
- Modify (shared, spec §12):
  - `client/src/modules.js`: insert `{ key: 'finance', label: 'Finance', path: '/finance' },` immediately before the Fluence entry, with a one-line comment.
  - `client/src/App.jsx`:
    - add `const Finance = lazy(() => import('./pages/finance/Finance.jsx'));` after the `Accounts` lazy import;
    - add `<Route path="/finance/*" element={<Finance />} />` after the `/accounts` route.
  - `client/src/components/AppLayout.jsx`:
    - import `BookOpenCheck`, `FileSpreadsheet` and `SlidersHorizontal` from lucide;
    - add a `Finance` group between `Supply` and `Admin` (below);
    - add `SHORT_LABEL` entries `'/finance/reports': 'Fin Reports'` and `'/finance/setup': 'Fin Setup'`, so the tablet rail never shows two "Reports".
- Create:
  - `client/src/lib/finance/caps.js`
  - `client/src/lib/finance/tables.js`
  - `client/src/pages/finance/Finance.jsx`
  - `client/src/components/finance/BookSwitch.jsx`
- Modify: `server/src/finance-rules.js`. Move `FIN_ROLES`, the capability table and `finCan` into `caps.js` and re-export them from `finance-rules.js`, so the screens hide exactly what the server refuses.
- Test: extend `server/src/finance-wiring.test.js`

**Interfaces:**
- `caps.js`: `FIN_ROLES`, `finCan(roles, cap)`. These are the Task 2 definitions, unchanged.
- `tables.js`: `FINANCE_TABLES`, the 13 table names from Task 3's pin test.
- `Finance.jsx`: the default export renders the Finance shell.
  - It loads `GET /finance/me` once.
  - The current book is kept in `storage` under `fin_book`, validated against `me.books`, and defaults to the first book.
  - It passes `{ me, book, can: cap => finCan(book.roles, cap) }` to its children.
  - **Routes:**

    | Route | Page |
    |---|---|
    | `index` | `Vouchers` |
    | `reports/*` | `Reports` |
    | `setup/*` | `Setup` |
    | `vouchers/:id/print` | `VoucherPrint` |

  - **No grant:** when `me.books` is empty, it renders only the sentence **"Finance isn't switched on for this login — ask the MD."**
- `BookSwitch({ books, value, onChange })`: a segmented control of book names, using ui `Tabs` with `{ key: id, label: name }`.
- NAV group:

```js
{
  group: 'Finance',
  items: [
    { label: 'Vouchers', to: '/finance', end: true, icon: BookOpenCheck, roles: ['admin'], module: 'finance' },
    { label: 'Reports', to: '/finance/reports', icon: FileSpreadsheet, roles: ['admin'], module: 'finance' },
    { label: 'Setup', to: '/finance/setup', icon: SlidersHorizontal, roles: ['admin'], module: 'finance' },
  ],
},
```

- [ ] **Step 1: Write the failing pins** (append to `finance-wiring.test.js`):

```js
import { MODULES } from '../../client/src/modules.js';
import { finCan as clientCan } from '../../client/src/lib/finance/caps.js';
import { finCan as serverCan } from './finance-rules.js';
import { FINANCE_TABLES } from '../../client/src/lib/finance/tables.js';

test('Finance sits immediately before Fluence in MODULES', () => {
  const i = MODULES.findIndex(m => m.key === 'finance');
  assert.deepEqual(MODULES[i], { key: 'finance', label: 'Finance', path: '/finance' });
  assert.equal(MODULES[i + 1].key, 'fluence');
});

test('the /finance/* route is lazy and the sidebar group sits between Supply and Admin', () => {
  const app = src('../../client/src/App.jsx');
  assert.match(app, /const Finance = lazy\(\(\) => import\('\.\/pages\/finance\/Finance\.jsx'\)\);/);
  assert.match(app, /<Route path="\/finance\/\*" element={<Finance \/>} \/>/);
  const nav = src('../../client/src/components/AppLayout.jsx');
  const [s, f, a] = ["group: 'Supply'", "group: 'Finance'", "group: 'Admin'"].map(g => nav.indexOf(g));
  assert.ok(s < f && f < a, 'Supply < Finance < Admin');
  for (const t of ["to: '/finance', end: true", "to: '/finance/reports'", "to: '/finance/setup'"]) assert.ok(nav.includes(t), t);
  assert.equal((nav.match(/module: 'finance'/g) || []).length, 3);
});

test('one capability table for screens and server', () => {
  assert.equal(clientCan, serverCan);
  assert.equal(FINANCE_TABLES.length, 13);
});
```

- [ ] **Step 2: Run them.**
  Run: `cd server && node --test src/finance-wiring.test.js`
  Expected: FAIL. Finance is not in `MODULES`, and `caps.js` is missing.

- [ ] **Step 3: Implement** the three shared edits and the four new files. Move the capabilities, and keep Task 2's tests passing.

- [ ] **Step 4: Run them**, then build.
  Run: `cd server && node --test src/finance-wiring.test.js src/finance-rules.test.js && cd .. && npm run build -w client`
  Expected: PASS; the client build succeeds. The pages `Vouchers`, `Reports`, `Setup` and `VoucherPrint` exist as one-line placeholders that Tasks 15–17 replace. Create them now so the shell compiles.

- [ ] **Step 5: Checkpoint.** `npm test` must stay green, including `kit-studio.test.js` (Fluence last), `landing-path.test.js`, `customer-login.test.js` (a customer login is refused `finance`), `startup-entry-lean`, `client-storage-safety` and `reload-overlay-markers`.

---

### Task 15: Vouchers — Day Book, Approvals, Drafts, the entry form, detail and print

**Files:**
- Create:
  - `client/src/lib/finance/voucher.js` (pure)
  - `client/src/pages/finance/Vouchers.jsx`, `client/src/pages/finance/VoucherPrint.jsx`
  - `client/src/components/finance/LedgerPicker.jsx`, `VoucherForm.jsx`, `VoucherDetail.jsx`
- Test: `server/src/finance-voucher-ui.test.js`

**Interfaces:**
- Pure, in `voucher.js`. A form line is `{ ledger_id, debit_paise, credit_paise, narration, bill_ref, bill_date, due_date }`:
  - `finDifference(lines) → number`: Σdebit − Σcredit, in paise.
  - `finBalancingLine(lines) → null | { debit_paise, credit_paise }`: what the next line should hold to balance. Tally behaviour.
  - `finFormLinesToApi(lines) → lines`: drops empty lines (no ledger and no amount) wherever they are.
  - `finVoucherKey({ key, ctrlKey, metaKey, shiftKey }, { atLastField, difference }) → 'save' | 'add-line' | 'next' | 'prev' | null`:
    - Ctrl/Cmd+Enter → `save`.
    - Enter on a line's last field while unbalanced → `add-line`.
    - Enter → `next`; Shift+Enter → `prev`.
- **`Vouchers.jsx`** (props `{ me, book, can }`):
  - Tabs **Day Book · Approvals · Drafts**, kept in `?tab=`. `?voucher=<id>` opens that voucher.
  - Day Book:
    - KpiRow: Drafts, Waiting approval, Posted today, Posted this month. "Today" is the browser's local date; plant devices run on IST.
    - Filters: date range, type, status, person, search.
    - DataTable columns: Date · Number · Type · Narration · Amount · Status · Made by.
  - "New Voucher" menu (Journal / Receipt / Payment / Contra), shown when `can('enter')` and the tier is not phone. On a phone, the menu says: "Use a computer or tablet to enter vouchers."
  - Approvals shows `view=approvals` with Approve, and Reject (reason modal); it is phone-friendly through DataTable card mode.
  - Drafts: Edit · Submit · Discard.
  - Refreshes with `useRealtimeRefresh(load, FINANCE_TABLES)`.
- **`VoucherForm`** (props `{ book, type, voucher?, onClose, onSaved }`), inside the shared `Modal`:
  - Date: the last used date (`storage` `fin_last_date`) or today.
  - Narration, reference, and the lines grid: `LedgerPicker`, Dr, Cr (typed text through `finToPaiseTyped` on blur; an error shows under the cell), line narration, bill fields on party ledgers.
  - A live **"Difference ₹… Dr/Cr"** beside Save.
  - Keys follow `finVoucherKey`; an `add-line` pre-fills `finBalancingLine`.
  - Buttons: **Keep as draft** (POST or PUT) and **Save** (draft, then `/submit`).
  - `client_key = crypto.randomUUID()` is made once per opened form.
  - On a 4xx the form stays open; the central toast already shows the sentence.
- **`LedgerPicker`** (props `{ bookId, value, onChange }`):
  - Wraps ui `Select`, with options from `GET /finance/books/:id/ledgers`, active ones only.
  - `data-search` = name, code and group. Each option shows its group as a hint.
- **`VoucherDetail`** (props `{ id, book, can, onClose, onChanged }`):
  - Header: number or "Draft", type, date, status, made / approved / posted by.
  - Lines table (`sortable: false`), totals, history timeline.
  - Actions follow the API's `can`: Submit, Approve, Reject (reason), Reverse (date + reason), Discard, Edit, Print.
- **`VoucherPrint`:**
  - The `POPrint.jsx` pattern: an `.print-fit` A4 sheet with the book's name, number, date, lines, totals, narration, amount in words (`rupeesInWords` from `lib/amountWords.js`), and "Prepared by / Approved by".
  - A `no-print` toolbar with Back and Print.

- [ ] **Step 1: Write the failing pure tests** in `server/src/finance-voucher-ui.test.js`:

```js
import { finDifference, finBalancingLine, finFormLinesToApi, finVoucherKey } from '../../client/src/lib/finance/voucher.js';
const l = (d, c, ledger_id = 1) => ({ ledger_id, debit_paise: d, credit_paise: c });

test('difference and the balancing next line', () => {
  assert.equal(finDifference([l(500, 0), l(0, 300)]), 200);
  assert.deepEqual(finBalancingLine([l(500, 0), l(0, 300)]), { debit_paise: 0, credit_paise: 200 });
  assert.deepEqual(finBalancingLine([l(0, 500)]), { debit_paise: 500, credit_paise: 0 });
  assert.equal(finBalancingLine([l(500, 0), l(0, 500)]), null);
});

test('empty lines never reach the API', () => {
  assert.equal(finFormLinesToApi([l(5, 0), { ledger_id: null, debit_paise: 0, credit_paise: 0 }, l(0, 5, 2)]).length, 2);
});

test('keyboard: Ctrl/Cmd+Enter saves, Enter moves, Enter at an unbalanced line end adds a line', () => {
  assert.equal(finVoucherKey({ key: 'Enter', ctrlKey: true }, { atLastField: false, difference: 0 }), 'save');
  assert.equal(finVoucherKey({ key: 'Enter', metaKey: true }, { atLastField: true, difference: 9 }), 'save');
  assert.equal(finVoucherKey({ key: 'Enter' }, { atLastField: true, difference: 9 }), 'add-line');
  assert.equal(finVoucherKey({ key: 'Enter' }, { atLastField: true, difference: 0 }), 'next');
  assert.equal(finVoucherKey({ key: 'Enter', shiftKey: true }, { atLastField: false, difference: 0 }), 'prev');
  assert.equal(finVoucherKey({ key: 'a' }, { atLastField: false, difference: 0 }), null);
});
```

- [ ] **Step 2: Run it.**
  Run: `cd server && node --test src/finance-voucher-ui.test.js`
  Expected: FAIL (module not found).

- [ ] **Step 3: Implement `voucher.js`.** Run it again. Expected: PASS (3 tests).

- [ ] **Step 4: Build the five components** to the interface above. Follow the ERP recipe `PageHeader → KpiRow → Tabs → DataTable`, using `fmt`-style money through `finFormatINR`.
  - No `localStorage`; use `storage` from `lib/safeStorage.js`.
  - Every popover or fixed layer is the shared `Modal` (it already carries `data-ci-overlay`), or declares the attribute itself.

- [ ] **Step 5: Build and checkpoint.**
  Run: `npm run build -w client` (root), then `cd server && npm test`.
  Expected: the build succeeds and the suite is green. The UI is exercised end to end in Task 19.

---

### Task 16: Reports — trial balance tree, ledger, journal register, parallel run, self-approved

**Files:**
- Create:
  - `client/src/lib/finance/tb.js` (pure)
  - `client/src/pages/finance/Reports.jsx`
  - `client/src/components/finance/TrialBalance.jsx`, `LedgerStatement.jsx`, `JournalRegister.jsx`, `ParallelRun.jsx`
- Test: `server/src/finance-tb-ui.test.js`

**Interfaces:**
- `finTbRows(tb, expanded: Set<number>) → Array<{ kind: 'group'|'ledger', id, name, depth, opening_paise, debit_paise, credit_paise, closing_paise }>`
  - Rows come in tree order: root groups by `sort_order`, each group's child groups, then its ledgers by name.
  - A group's children appear only when the group is in `expanded`.
  - The API's `tb` shape is from Task 11.
- **`Reports.jsx`:** tabs **Trial Balance · Ledger · Journal Register · Parallel Run · Self-approved**, routed as `/finance/reports/:tab?`. The ledger tab reads `?ledger&from&to`.
- **Columns:** Opening · Debit · Credit · Closing, shown with `finFormatINR(p, { drcr: true })` where signed. Every running-balance table sets `sortable: false` on every column.
- **Drill-down:** a ledger row opens the Ledger tab; a statement row opens `VoucherDetail` (Task 15).
- **Defaults:** from = start of the financial year containing today (`finFyOf`), to = today.
- **Export:** set `DataTable`'s `exportName` / `exportSubtitle` only when `book.can_export`. Without them no export is offered.
  - This gate is necessarily on screen: exports are built in the browser from data the login may already view. The server enforces viewing itself (Task 6).
- **`ParallelRun`:** pick an import from `GET /finance/imports?book&purpose=parallel_tb`, then show the Task 13 report.
  - Rows with `difference_paise !== 0` are highlighted with the existing `ci-row-alarm` class.
  - Unmatched Tally rows are listed below.
  - Its "Upload Tally TB" button arrives in Task 18.

- [ ] **Step 1: Write the failing pure test** in `server/src/finance-tb-ui.test.js`:

```js
import { finTbRows } from '../../client/src/lib/finance/tb.js';
const tb = {
  groups: [{ id: 1, parent_id: null, name: 'Current Assets', sort_order: 8, closing_paise: 100 },
           { id: 2, parent_id: 1, name: 'Bank Accounts', sort_order: 1, closing_paise: 100 },
           { id: 3, parent_id: null, name: 'Capital Account', sort_order: 1, closing_paise: -100 }],
  ledgers: [{ id: 9, group_id: 2, name: 'Alpha Bank', closing_paise: 100 }, { id: 8, group_id: 3, name: 'Capital', closing_paise: -100 }],
};
test('collapsed shows the roots in template order; expanding opens one level at a time', () => {
  assert.deepEqual(finTbRows(tb, new Set()).map(r => r.name), ['Capital Account', 'Current Assets']);
  assert.deepEqual(finTbRows(tb, new Set([1])).map(r => [r.name, r.depth]), [['Capital Account', 0], ['Current Assets', 0], ['Bank Accounts', 1]]);
  assert.deepEqual(finTbRows(tb, new Set([1, 2, 3])).map(r => r.name), ['Capital Account', 'Capital', 'Current Assets', 'Bank Accounts', 'Alpha Bank']);
});
```

- [ ] **Step 2: Run it.**
  Run: `cd server && node --test src/finance-tb-ui.test.js`
  Expected: FAIL (module not found).

- [ ] **Step 3: Implement `tb.js`.** Run it again. Expected: PASS.

- [ ] **Step 4: Build the five components** to the interface above.

- [ ] **Step 5: Build and checkpoint.** Run `npm run build -w client` and `cd server && npm test`. Expected: both green.

---

### Task 17: Setup — chart of accounts, months & years, approval rules, access, activity log

**Files:**
- Create:
  - `client/src/lib/finance/periods.js` (pure)
  - `client/src/pages/finance/Setup.jsx`
  - `client/src/components/finance/ChartOfAccounts.jsx`, `MonthsYears.jsx`, `ApprovalRules.jsx`, `FinanceAccess.jsx`, `ActivityLog.jsx`
- Modify: `server/src/finance-masters.js`. `finSetPeriodStatus` uses `finPeriodMove` from `periods.js`, so the screens offer exactly the moves the server allows.
- Test: `server/src/finance-periods.test.js`; re-run `finance-pg-masters.test.js`.

**Interfaces:**
- `periods.js`:
  - `FIN_PERIOD_TRANSITIONS = { open: [{ to: 'closing', reason: false }], closing: [{ to: 'locked', reason: false }, { to: 'open', reason: true }], locked: [{ to: 'closing', reason: true }], before_books: [] }`
  - `finPeriodMove(from, to) → { ok, needsReason }`
- `Setup.jsx`: tabs **Chart of Accounts · Months & Years · Opening Balances · Approval Rules · Access · Activity Log**, routed `/finance/setup/:tab?`. A tab whose capability the login lacks is not shown:

  | Tab | Capability |
  |---|---|
  | Approval Rules | admin |
  | Access | admin |
  | Opening Balances | import |
  | The rest | view |

- **`ChartOfAccounts`:**
  - The group/ledger tree, with closings as at today (Task 11 trial balance, through `finTbRows` with everything expanded).
  - Add group (admin).
  - Add ledger (capability ledger): name, code, group, Tally name, and an optional party link picked from the existing `GET /customers` / `GET /vendors`.
  - Edit ledger:
    - name, code, Tally name, notes (ledger);
    - group, active, system-only, party link (admin).
  - An amber "name differs" chip when `name_differs`.
- **`MonthsYears`:** each year as a 12-month grid with status chips.
  - The buttons come from `FIN_PERIOD_TRANSITIONS` (approver), with a reason prompt where `reason: true`.
  - "Add next financial year" (admin) posts the label after the latest year.
- **`ApprovalRules`:** the 10 rules. An admin edits the mode and the limit; the limit is typed in rupees through `finToPaiseTyped`.
- **`FinanceAccess`:**
  - The grants table: user, book, role chips, export.
  - A Grant form: a user from `GET /finance/access` `users`, a book the caller administers, role checkboxes, `can_export`.
  - Revoke goes through `ConfirmDialog`.
- **`ActivityLog`:** filters for date range, person and entity, and a DataTable of When · Who · Action · Entity · Reason. A row opens a modal showing `before` and `after` side by side as pretty-printed JSON.

- [ ] **Step 1: Write the failing test** in `server/src/finance-periods.test.js`:

```js
import { FIN_PERIOD_TRANSITIONS, finPeriodMove } from '../../client/src/lib/finance/periods.js';
test('month moves are spec §6.2 exactly', () => {
  assert.deepEqual(finPeriodMove('open', 'closing'), { ok: true, needsReason: false });
  assert.deepEqual(finPeriodMove('closing', 'locked'), { ok: true, needsReason: false });
  assert.deepEqual(finPeriodMove('closing', 'open'), { ok: true, needsReason: true });
  assert.deepEqual(finPeriodMove('locked', 'closing'), { ok: true, needsReason: true });
  for (const [a, b] of [['locked', 'open'], ['open', 'locked'], ['before_books', 'open'], ['open', 'before_books']])
    assert.equal(finPeriodMove(a, b).ok, false, `${a}→${b}`);
  assert.deepEqual(FIN_PERIOD_TRANSITIONS.before_books, []);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (module not found).

- [ ] **Step 3: Implement `periods.js`, and switch `finSetPeriodStatus` to it.**
  Run: `cd server && node --test src/finance-periods.test.js && FINANCE_PG=1 node --test src/finance-pg-masters.test.js`
  Expected: PASS for both. Task 7's tests are unchanged.

- [ ] **Step 4: Build the six components** to the interface above.

- [ ] **Step 5: Build and checkpoint.** Run `npm run build -w client` and `cd server && npm test`. Expected: both green.

---

### Task 18: Opening Balances wizard and the Tally upload

**Files:**
- Create: `client/src/components/finance/TallyUpload.jsx`, `client/src/pages/finance/OpeningBalances.jsx`
- Modify:
  - `client/src/lib/finance/tally.js`: add `finFindHeaderRow`.
  - `client/src/components/finance/ParallelRun.jsx`: add the Upload button.
  - `client/src/pages/finance/Setup.jsx`: mount `OpeningBalances`.
- Test: extend `server/src/finance-import.test.js`

**Interfaces:**
- `finFindHeaderRow(rows, kind, { scan = 15 } = {}) → { index, mapping } | null`. It returns the first row, within `scan`, for which `finDetectColumns` returns a mapping.
- **`TallyUpload`** (props `{ kind, label, onRows }`):
  - A file input (`.xlsx`).
  - On pick, `const ExcelJS = (await import('exceljs')).default` loads ExcelJS. This is the `lib/exporter.js` pattern; never import it statically.
  - It reads the first worksheet into arrays of cell values: rich text becomes its text, a formula becomes its result, a date stays a `Date`.
  - It finds the header with `finFindHeaderRow`. If none is found, it offers column-mapping selects for that kind's required columns.
  - It previews the first 10 parsed rows (`finRowsFromSheet`), then calls `onRows(rows, { fileName })`.
  - An `.xls` file gets the message: "Save the Tally export as .xlsx and upload that."
- **`OpeningBalances`** (props `{ me, book, can }`) is a four-step wizard. It can be resumed: it lists `GET /finance/imports?book&purpose=opening` and continues the newest one that is not `used`.
  1. **Upload.** List of Accounts, Trial Balance, and Bills Receivable / Payable. Bills are optional and may be several files, concatenated. "As at" is fixed to the day before `books_begin`. Then `POST /finance/imports`.
  2. **Match.** The proposal rows, each with an action: `match` (ledger picker) or `create` (group select, plus a party picker under party groups). Then `PUT …/matches`.
  3. **Check.** `tie_out` problems in red, warnings in amber, and the Dr/Cr totals.
  4. **Build.** The button is enabled only when `tie_out.ok`. It sends `POST …/build-opening` and shows the voucher number or "Waiting for MD approval", with a link to it.
- **`ParallelRun` "Upload Tally TB":** a `TallyUpload` of kind `tb` plus a month-end "As at" picker. It sends `POST /finance/imports { purpose: 'parallel_tb', tb }`, then opens the new report.

- [ ] **Step 1: Write the failing test** (append to `finance-import.test.js`):

```js
import { finFindHeaderRow } from '../../client/src/lib/finance/tally.js';
test('the header row is found below Tally\'s title block', () => {
  const rows = [['Colour Impressions'], ['Trial Balance'], ['1-Apr-26 to 31-Dec-26'], ['Particulars', 'Debit', 'Credit'], ['Alpha Bank', '1,000.00', '']];
  assert.deepEqual(finFindHeaderRow(rows, 'tb'), { index: 3, mapping: { name: 0, debit: 1, credit: 2 } });
  assert.equal(finFindHeaderRow([['nothing here']], 'tb'), null);
});
```

- [ ] **Step 2: Run it.** Expected: FAIL (`finFindHeaderRow` is not exported).

- [ ] **Step 3: Implement `finFindHeaderRow`.** Run it again. Expected: PASS.

- [ ] **Step 4: Build the two components and the `ParallelRun` button** to the interface above.

- [ ] **Step 5: Build and checkpoint.** Run `npm run build -w client` and `cd server && npm test`. Expected: both green.

---

### Task 19: Whole-branch verification, the isolation proof, and the browser walkthrough

**Files:**
- Create: `server/src/finance-pg-isolation.test.js`, `server/finance-dev.mjs`
- Modify (outside the repo, untracked): `~/Documents/Projects/Colour Imp Production/.claude/launch.json`. Add two entries.
- Modify: the spec's **Status** line, and the memory file `ci-erp-finance-module-programme.md`.

**Interfaces:**
- **`server/finance-dev.mjs`** is the local walkthrough server. It lives in `server/`, not `src/`, because `embedded-postgres` resolves from the script's folder. It is never imported, tested or shipped.
  1. Start embedded Postgres, persistent, in `FIN_DEV_DIR` (default `$TMPDIR/ci-erp-finance-dev`), on a free port.
  2. Run `connect()`, `init()`, `seedIfEmpty()`.
  3. Create `md@fin.dev`, `acct@fin.dev` and `plant@fin.dev` (plant role `admin`, random passwords).
  4. Run `finSetupBooks` with grants: md → approver + admin, acct → accountant, both books; plant gets none.
  5. Write `FIN_DEV_DIR/tokens.json` = `{ md: { token, user }, acct: {…}, plant: {…} }`.
  6. `app.listen(FIN_DEV_PORT || 4931)`.
- **Launch entries:**
  - `finance-dev-api`: `node server/finance-dev.mjs`, cwd = the worktree.
  - `finance-dev-client`: `npm run dev -w client -- --port <p> --strictPort`, with `VITE_API_TARGET=http://localhost:<api port>`, cwd = the worktree.
  - Read the existing file and pick ports above every port it already lists. 4931 / 5931 were free on 2026-10-16; re-check.

- [ ] **Step 1: Write the isolation test** in `server/src/finance-pg-isolation.test.js` (FINANCE_PG gated):

```js
const SNAP = `
  SELECT 'col' k, table_name t, column_name n, data_type d FROM information_schema.columns
   WHERE table_schema='public' AND table_name NOT LIKE 'fin\\_%'
  UNION ALL SELECT 'con', conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint
   WHERE connamespace='public'::regnamespace AND conrelid <> 0 AND conrelid::regclass::text NOT LIKE 'fin\\_%'
  UNION ALL SELECT 'idx', tablename, indexname, indexdef FROM pg_indexes
   WHERE schemaname='public' AND tablename NOT LIKE 'fin\\_%'
  UNION ALL SELECT 'trg', tgrelid::regclass::text, tgname, pg_get_triggerdef(oid) FROM pg_trigger
   WHERE NOT tgisinternal AND tgrelid::regclass::text NOT LIKE 'fin\\_%'
  ORDER BY 1, 2, 3`;

test('Finance attaches nothing to the rest of the ERP schema', async () => {
  const h = await finBootPg('isolation', { setup: false });
  try {
    const withFinance = await h.db.q(SNAP);
    assert.ok(withFinance.length > 500, `non-vacuous: ${withFinance.length}`);
    assert.deepEqual(withFinance.filter(r => /\bfin_/.test(r.n) || /\bfin_/.test(r.d)), [], 'a fin_ object sits on a non-finance table');
    await h.db.tx(async qc => {
      const tables = (await qc(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'fin\\_%'`)).map(r => r.tablename);
      await qc(`DROP TABLE ${tables.join(', ')} CASCADE`);
      for (const { f } of await qc(`SELECT oid::regprocedure::text f FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fin\\_%'`))
        await qc(`DROP FUNCTION ${f} CASCADE`);
      assert.deepEqual(await qc(SNAP), withFinance, 'dropping Finance changed the rest of the schema');
      throw Object.assign(new Error('rollback'), { rollback: true });
    }).catch(e => { if (!e.rollback) throw e; });
  } finally { await h.close(); }
});
```

- [ ] **Step 2: Watch it fail first.**
  - Temporarily append `CREATE INDEX IF NOT EXISTS fin_probe ON customers (name);` to the migration.
  - Run: `cd server && FINANCE_PG=1 node --test src/finance-pg-isolation.test.js`
  - Expected: FAIL with "a fin_ object sits on a non-finance table". The static isolation pin from Task 3 fails too.
  - Remove the probe, run again, and expect PASS.

- [ ] **Step 2b: Sweep every route with a login that has no Finance grant** (spec §14). Add to `finance-pg-isolation.test.js`:

```js
test('every Finance route refuses a plant admin with no Finance grant', async () => {
  const h = await finBootPg('sweep');
  try {
    const { default: router } = await import('./routes/finance.js');
    const routes = router.stack.filter(l => l.route).flatMap(l => Object.keys(l.route.methods).map(m => [m.toUpperCase(), l.route.path]));
    assert.ok(routes.length >= 35, `non-vacuous: ${routes.length} routes`);
    const ci = (await h.db.one(`SELECT id FROM fin_books WHERE code='CI'`)).id;
    const bad = [];
    for (const [method, path] of routes) {
      if (path === '/finance/me' || path === '/finance/books') continue;          // these answer 200 with an empty list
      const url = path.replace(/:\w+/g, String(ci)) + `?book=${ci}&ledger=${ci}&import=${ci}`;
      const r = await h.call(method, url, method === 'GET' ? null : { book_id: ci }, 'plant');
      if (![403, 404].includes(r.status)) bad.push(`${method} ${path} → ${r.status}`);
    }
    assert.deepEqual(bad, []);
  } finally { await h.close(); }
});
```

  - Before the routes exist this cannot fail usefully, so the falsification is local: comment out the `finRequire` call in one route (say `GET /finance/reports/trial-balance`), confirm the sweep names that route, then restore it.
  - `404` is accepted because a voucher or import id the caller cannot see answers `FIN_NOT_FOUND` by design (Review Focus 5).

- [ ] **Step 3: Run the whole branch.**
  - `npm run verify` (root): exit 0. The test count is the Task 1 baseline plus every new unit test.
  - `cd server && FINANCE_PG=1 node --test src/finance-pg-*.test.js`: every file passes.

- [ ] **Step 4: Audit the change set.**
  - Run: `git status --porcelain` in the worktree.
  - Expected: the modified tracked files are **exactly** the seven in spec §12. Everything else is untracked new files under the paths in the File map.
  - In `git diff` for the seven, a deletion appears only where an existing import list or array gained an item.

- [ ] **Step 5: Walk it through in the built-in browser.**
  - Start both launch entries.
  - Sign in by writing `ci_token` and `ci_user` from `tokens.json` into the page's storage (`javascript_tool`), then reload.
  - Screenshot each step. After every page, `read_console_messages({ onlyErrors: true })` must be empty.
  1. **plant@**: the Finance menu shows; the page says "Finance isn't switched on for this login — ask the MD."
  2. **acct@**, Setup → Chart of Accounts:
     - add `Alpha Bank` (Bank Accounts), `Rent` (Indirect Expenses), `Freight` (Direct Expenses);
     - add a party ledger linked to a seeded customer under a different name; the "name differs" chip shows.
  3. **acct@**, New Voucher → Journal:
     - with a bank line: the shape sentence appears;
     - unbalanced: "Debits ₹… and credits ₹… don't match — difference ₹…";
     - balanced Rent/Freight with Ctrl+Enter: "Waiting for approval".
  4. **md@**: the bell shows the entry. Approvals → Approve gives `CI-JV-2627-0001`.
  5. **acct@**: a payment of ₹50,000 posts directly; ₹1,50,000 waits. **md@**, at `resize_window({ preset: 'mobile' })`, approves it from the Approvals cards. Reset to `desktop`.
  6. **md@**: reverse a payment. The reversal posts, and the original shows "Reversed by …".
  7. **md@**, Months & Years: February → Closing → Locked. **acct@**: a receipt dated February is refused with the locked-month sentence.
  8. **Opening Balances.** Write the Task 13 fixture as three `.xlsx` files with a small ExcelJS script in the scratchpad, upload them, then match, check, build. md approves, and the trial balance as at 31 Dec equals the fixture.
  9. **Reports:** Trial Balance → expand groups → a ledger → a voucher. Export is offered to md and hidden for a login whose grant has `can_export = false`.
  10. **Regression:** `/accounts` and `/dispatch-invoice?tab=invoices` load and behave as before, with no console errors.

- [ ] **Step 6: Close out (no commit).**
  - Set the spec's Status line to `Built locally, uncommitted (<date>) — awaiting Anik's review and a go-live session`.
  - Update `ci-erp-finance-module-programme.md`, and its line in `MEMORY.md`, to **SP1 BUILT, UNCOMMITTED**, with the worktree path and the verify and FINANCE_PG counts.
