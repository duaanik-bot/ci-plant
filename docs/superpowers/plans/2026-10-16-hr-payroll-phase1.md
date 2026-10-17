# HR & Payroll — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A walled-off HR & Payroll section inside the CI ERP. It turns Anik's monthly Excel input into
calculated, approved, locked and paid payroll. It keeps loans and advances as running balances and
reproduces his July workbook to within half a paisa.

**Architecture:** Postgres schema `hr` (no foreign keys into public tables). Pure logic lives in
`server/src/hr/` (money, engine, matching, parsing, loans, workbook loader). DB orchestration is in
`server/src/hr/{access,audit,ledger,runs}.js`. Three Express route files sit under `/api/hr/*` behind
one path-scoped guard. On the client, one lazy page `/hr` with tabs, plus a payslip print page.

**Tech Stack:**
- Node ESM, Express, node-postgres, exceljs, multer (server).
- React 18, Vite, Tailwind, existing `components/ui.jsx` and `lib/exporter.js` (client).
- `node:test`; embedded-postgres 17 for opt-in DB tests.

**Spec:** `docs/superpowers/specs/2026-10-16-hr-payroll-design.md`. Read it first. Section numbers
below (§n) refer to it.

## Global Constraints

- **No `git commit`, `git push`, deploy, or production migration.** Files stay on disk. Skip every
  commit step a skill suggests.
- **Work only in** the `ci-erp-hr-payroll` worktree. Its path has spaces: in
  tests, build file paths with `fileURLToPath(new URL(…, import.meta.url))`, never `.pathname`.
- **The repo is public.** No real names, salaries, bank or account numbers in any repo file. Fixtures
  are synthetic. Real data enters only through `HR_JULY_XLSX=<path outside repo>`.
- **Money.**
  - Columns are `NUMERIC(12,2)`, quantities `NUMERIC(14,4)`.
  - The engine computes with `server/src/hr/money.js` rationals and rounds half away from zero to
    paise, per component.
  - Never do float arithmetic on money. `pg` returns NUMERIC as a JS number (`db.js:16`); convert with
    `rat(value)`.
- **Every HR route lives under `/api/hr`**:
  - guarded by `hrGuard` and a per-route `requireHr(level)`;
  - every GET calls `markUncacheable()` (`server/src/data-tables.js:180`);
  - writes go to `hr.audit_log` through `hrAudit`, never `public.audit_log`;
  - notification titles and bodies carry no amounts.
- **Inside `tx((qc, oc) => …)`, use only `qc`/`oc`.** `nextNumber(prefix, table, column, oc)`
  (`helpers.js:2650`) runs first, before row locks.
- **Repo scanners must stay green:**
  - dates via `plantDateStr` (`plant-calendar.js:58`) or `PLANT_TODAY_SQL`;
  - optional text via `optionalText` (`helpers.js:204`);
  - number-minting POSTs listed in `MINTING_POSTS` (`client/src/lib/writeOnce.js`);
  - write routes take an inline final handler, never a named one (`mint-routes-join-once.test.js:185`);
  - every `kind:` literal mapped in `server/src/notify-categories.js`.
- **Shared files touched** are exactly those in spec §5. Nothing else outside `hr` paths.
- **Excel** is parsed on the server only (exceljs), uploads are capped at 4 MB, and JSON request bodies
  stay under 100 KB (parsed rows stay server-side).
- **Blocking is reserved for** a missing pay setup, absent days above days in month, unresolved import
  rows, a contract without a bill amount, paid-separately above pay, and wrong-state transitions.
  Everything else is a warning (`level:'warn'`) or information (`level:'info'`).
- **Baseline:** `main@33f81735` has 2 pre-existing failures (`section-lean-rows.test.js`). Ignore them.
  Every other test must stay green.
- **Tests** are top-level `server/src/hr-*.test.js`, run with `node --test src/hr-*.test.js` from
  `server/`. DB tests are opt-in with `HR_PG=1` and copy `server/src/batch-gang-pg.test.js`.

## Review Focus

1. **February and 30-day months.** The divisor must follow the month: 28 for `2026-02`, 29 for
   `2028-02`, 30 for `2026-09`. Test in Task 2.
2. **A corrected file uploaded after manual edits.** Edits must be listed and kept unless overwrite is
   chosen, never silently lost. Test in Task 10.
3. **An exited person still in the monthly file.** Flag `PERSON_EXITED` and count days after
   `exited_on` as not employed; never pay silently. Tests in Tasks 2 and 10.
4. **Finalising a month while an earlier month is still open.** Advance and loan balances would be
   wrong, so refuse with 409 `PREVIOUS_MONTH_OPEN`. Test in Task 13.
5. **Numbers typed as text** ("10,000", "₹ 5,000", " 86.37 ") or **columns in a different order with
   extra columns**. These must parse, and must not shift columns. Test in Task 4.

---

## File map

| File | Responsibility |
|---|---|
| `server/src/hr/money.js` | exact rational arithmetic; paise rounding and formatting |
| `server/src/hr/engine.js` | `computeLine`, `daysInMonthOf`, `effectiveSetup`; pure |
| `server/src/hr/match.js` | name and code normalising, row matching, suggestions, duplicates; pure |
| `server/src/hr/import-parse.js` | xlsx → grid → header → column map → typed rows |
| `server/src/hr/loans.js` | loan outstanding, monthly due, schedule projection; pure |
| `server/src/hr/workbook-loader.js` | reads a July-layout salary workbook into people, setups, opening balances, month inputs, expected results |
| `server/src/hr/access.js` | `HR_LEVELS`, `levelAtLeast`, `hrAccessFor`, `hrGuard`, `requireHr` |
| `server/src/hr/audit.js` | `hrAudit` |
| `server/src/hr/ledger.js` | advance balances, loan positions, in-app advances in a month (DB reads) |
| `server/src/hr/runs.js` | `ensureRun`, `recalcRun`, `finaliseRun` (DB orchestration) |
| `server/src/routes/hr.js` | me, people, setups, aliases, settings, channels, access, audit, dashboard, ERP-operator list |
| `server/src/routes/hr-payroll.js` | imports, runs, inputs, transitions, payments, payslip data, variance |
| `server/src/routes/hr-ledgers.js` | loans, advances, adjustments, workbook loader |
| `supabase/migrations/20261016120000_hr_payroll.sql` | the whole `hr` schema |
| `client/src/lib/hr.js` | HR API helpers, `inr2`, constants |
| `client/src/pages/HR.jsx` | shell: access check, tabs |
| `client/src/pages/hr/*.jsx` | Overview, People (+PersonDrawer), Payroll (+ImportWizard, RunLineDrawer), LoansAdvances, Reports, Settings (+WorkbookLoader) |
| `client/src/pages/HRPayslips.jsx` | payslip print page |

Modified: `server/src/app.js`, `server/src/db.js`, `client/src/App.jsx`,
`client/src/components/AppLayout.jsx`, `client/src/lib/writeOnce.js`,
`server/src/notify-categories.js`, `client/src/lib/notificationLink.js`.

## API contract (all paths under `/api`, JSON; errors are `{error, code?}`; money is JSON numbers with ≤2 dp)

| Method & path | Min level | Request | Response |
|---|---|---|---|
| GET `/hr/me` | viewer | — | `{level, user:{id,name}}` |
| GET `/hr/people?status=` | viewer | — | `[{id,code,name,display_name,department,designation,worker_type,status,pay_channel,joined_on,exited_on,bank_last4,employee_id,current_setup:{…}|null}]` |
| GET `/hr/people/:id` | viewer | — | person (full bank only for operator+) + `setups[]`, `aliases[]`, `advance_balance`, `loans[]` |
| POST `/hr/people` · PUT `/hr/people/:id` | operator | person fields | person |
| POST `/hr/people/:id/setups` | operator | setup fields, `effective_from` = `YYYY-MM-01` | setup (409 `SETUP_EXISTS` if that month exists) |
| POST `/hr/people/:id/aliases` · DELETE `/hr/aliases/:id` | operator | `{alias}` | alias / `{ok:true}` |
| GET `/hr/settings` · PUT `/hr/settings` | viewer / admin | `{key: value}` | settings object |
| GET `/hr/pay-channels` · POST · PUT `/hr/pay-channels/:code` | viewer / admin | `{code,label,kind,bank_name,account}` | channel(s) |
| GET `/hr/access` · PUT `/hr/access/:userId` | admin | `{level|null}` | `[{user_id,name,email,role,level}]` (409 `LAST_ADMIN`) |
| GET `/hr/audit?entity=&entity_id=` | approver | — | rows |
| GET `/hr/dashboard?month=` | viewer | — | §14 figures |
| GET `/hr/erp-operators` | operator | — | `[{id,name,section,active}]` from `public.employees` |
| POST `/hr/imports` | operator | multipart `file`, field `month` | `{batch, rows, missing, duplicates}` (409 `DUPLICATE_FILE` + `batch_id`) |
| GET `/hr/column-maps` · DELETE `/hr/column-maps/:id` | viewer / admin | — | `[{id, signature, map, blank_zero, last_used}]` / `{ok:true}` |
| GET `/hr/imports/:id` | viewer | — | `{batch, rows, missing, duplicates}` |
| PUT `/hr/imports/:id/map` | operator | `{column_map, blank_as_zero}` | re-extracted `{batch, rows, …}` |
| PUT `/hr/imports/:id/rows/:rowId` | operator | `{person_id?, decision?, save_alias?, advance_mode?}` | row |
| POST `/hr/imports/:id/apply` | operator | `{missing:[{person_id, choice:'include'|'exclude'}], overwrite_manual:[person_id]}` | `{run, applied, manual_edits_kept:[…]}` |
| GET `/hr/runs` · GET `/hr/runs/:month` | viewer | — | runs / `{run, lines, inputs, flags_summary}` |
| PUT `/hr/runs/:month/inputs/:personId` | operator | input fields + `reason` | `{line}` |
| POST `/hr/runs/:month/recalc` · `/submit` | operator | — | run |
| POST `/hr/runs/:month/send-back` · `/approve` · `/finalise` | approver | `{reason}` (send-back) | run |
| POST `/hr/runs/:month/payments` | operator | `{pay_channel, reference, paid_on, person_ids?}` | batch |
| PUT `/hr/runs/:month/lines/:personId/payment` | operator (approver for `reversed`) | `{status, reference}` | line |
| GET `/hr/runs/:month/payslips?person_ids=&channel=` | viewer | — | `{company, run, slips:[…]}` |
| GET `/hr/runs/:month/variance` | viewer | — | `[{person_id, parts:{revision,attendance,ot,holiday,misc,advance,loan,other}, unexplained}]` |
| GET `/hr/loans` · GET `/hr/loans/:id` | viewer | — | loans / `{loan, txns, schedule}` |
| POST `/hr/loans` | operator | `{person_id, principal, issued_on, purpose, instalment, first_due_month, paid_via, is_opening}` | loan (mints `CI-LN-####`) |
| POST `/hr/loans/:id/prepay` · `/holiday` · `/cancel`; PUT `/hr/loans/:id/instalment` | operator | `{amount,date}` / `{month}` / — / `{instalment, from_month}` | loan |
| GET `/hr/advances` · GET `/hr/advances/:personId` | viewer | — | balances / statement |
| POST `/hr/advances` | operator | `{person_id, amount, txn_date, note}` | txn |
| POST `/hr/advances/:personId/waive` | approver | `{amount, note}` | txn |
| GET `/hr/adjustments?month=` · POST · POST `/:id/approve` · `/:id/cancel` | viewer / operator / approver / operator | §7 fields | adjustment |
| POST `/hr/loader/preview` · `/hr/loader/apply` | admin | multipart `file` (+ `decisions` JSON field on apply) | preview / `{created, updated, opening_loans, opening_advances}` |

---

### Task 1: Exact money arithmetic

**Files:** Create `server/src/hr/money.js`. Test `server/src/hr-money.test.js`.

**Interfaces — Produces** (rationals are frozen `{n: bigint, d: bigint}`, `d > 0n`, reduced):
- `rat(value: string|number|bigint|Rat) → Rat`. Numbers go through `String(value)`. Accepts commas,
  `₹`, `Rs`, spaces, exponent notation. Throws `TypeError` on non-numeric or empty input.
- `add, sub, mul, div(a, b) → Rat` (`div` throws `RangeError` on zero); `neg(a)`;
  `cmp(a, b) → -1|0|1`; `isZero`, `isNeg`; `min(a, b)`, `max(a, b)`.
- `toPaise(r) → bigint`: half away from zero. `fromPaise(p: bigint) → Rat`.
- `fmtPaise(p: bigint) → string` (`-150n → '-1.50'`). `fmtExact(r, dp = 6) → string` (truncating).
- `fmtDecimal(r) → string`: the shortest exact decimal (`'10000'`, `'86.37'`, `'0.1'`). Inputs always
  terminate. If one doesn't, fall back to `fmtExact(r, 10)`.
- `roundRupee(p: bigint) → bigint`: paise rounded half-up to whole rupees, returned in paise.

- [ ] **Step 1: Write the failing tests** in `hr-money.test.js`. Compare rationals with `cmp`, never
  with `deepEqual`.

```js
assert.equal(cmp(rat('86.37'), div(rat(8637), rat(100))), 0);
assert.equal(fmtDecimal(rat('10,000')), '10000'); assert.equal(fmtDecimal(rat('86.370')), '86.37');
assert.equal(fmtDecimal(rat('0.1')), '0.1');
assert.equal(toPaise(div(rat('36000'), rat('31'))), 116129n);               // 1161.2903… → 1161.29
assert.equal(toPaise(rat('0.005')), 1n);
assert.equal(toPaise(rat('0.0049')), 0n);
assert.equal(toPaise(rat('-0.005')), -1n);
assert.equal(cmp(add(rat(0.1), rat(0.2)), rat('0.3')), 0);
assert.throws(() => div(rat(1), rat(0)), RangeError);
assert.equal(fmtPaise(-150n), '-1.50');
assert.equal(fmtPaise(5n), '0.05');
assert.equal(cmp(rat(1e-7), div(rat(1), rat(10000000))), 0);
assert.equal(cmp(rat('₹ 10,000'), rat(10000)), 0);
assert.throws(() => rat('abc'), TypeError);
assert.equal(roundRupee(2400049n), 2400000n);
assert.equal(roundRupee(2400050n), 2400100n);
```

- [ ] **Step 2: Run them and see them fail.** From `server/`: `node --test src/hr-money.test.js`.
  Expected: FAIL, `Cannot find module './hr/money.js'`.
- [ ] **Step 3: Implement** `server/src/hr/money.js`. Parse a decimal string into `n/10^k`, reduce with
  a BigInt gcd. Exponent notation: shift `k`.
- [ ] **Step 4: Run them again.** Expected: PASS.

---

### Task 2: Calculation engine

**Files:** Create `server/src/hr/engine.js`. Test `server/src/hr-engine.test.js`.

**Interfaces**

**Consumes:** Task 1.

**Produces:**
- `ENGINE_VERSION = 'hr-engine-1'`.
- `daysInMonthOf(month: 'YYYY-MM') → number`.
- `effectiveSetup(setups: {effective_from:'YYYY-MM-DD'}[], month) → setup|null`: the latest
  `effective_from` ≤ `${month}-01`.
- `computeLine(p) → LineResult`.

`p` shape:
```
{ month, daysInMonth,
  setup: {pay_basis, base, absence_basis, absence_divisor, ot_hours_per_day, ot_multiplier, ot_fixed_rate,
          holiday_mode, holiday_divisor, holiday_multiplier, holiday_fixed},
  person: {joined_on, exited_on, status, pay_channel_kind, has_bank_details},
  inputs: {ot_hours, absent_days, paid_leave_days, hours_worked, misc_earning, misc_deduction, bonus,
           bill_amount, holiday_override, paid_separately, advance_given,
           advance_recovery_override, loan_recovery_override},          // null = not given
  balances: {advance, loans:[{loan_id, loan_no, due, outstanding}]},   // advance = posted balance only
  adjustments: [{id, kind:'earning'|'deduction', label, amount}],
  previous: null | {gross, components:{BASIC, OT, HOLIDAY, MISC, ADVANCE, LOAN}},
  policy: {rounding:'rupee'|'paise', ot_high_hours:'150', deduction_warn_pct:'50', variance_warn_pct:'25'} }
```

`LineResult`: amounts are strings with 2 dp; quantities are strings.
```
{ engine_version, present_days, days_not_employed, daily_rate,
  components:[{code, label, kind:'earning'|'deduction'|'info', qty, rate, formula, amount}],
  basic, ot_amount, holiday_amount, misc_earning, bonus, adj_earnings, gross,
  misc_deduction, adj_deductions, loan_recoveries:[{loan_id, amount}], loan_recovery, advance_recovery,
  total_deductions, paid_separately, net_before_cap, net, payable, rounding,
  unrecovered:{advance, loans:[{loan_id, amount}], other}, advance_given, carried_advance,
  flags:[{level:'block'|'warn'|'info', code, message}],
  exact:{gross, net_before_cap} }                                        // fmtExact, 6 dp
```

- **Component codes:** `BASIC` (`BILL` for contract), `OT`, `HOLIDAY`, `MISC`, `BONUS`, `ADJ:<id>`,
  `MISC_DED`, `LOAN:<loan_id>`, `ADVANCE`, `PAID_SEPARATELY` (info), `ROUNDING` (info).
- **Flag codes:** `NO_SETUP`, `ABSENT_EXCEEDS_DAYS`, `BILL_AMOUNT_MISSING`, `HOURS_WORKED_MISSING`,
  `PAID_SEPARATELY_EXCEEDS` (all block); `INSUFFICIENT_PAY`, `DEDUCTIONS_OVER_PCT`, `HIGH_OT`, `OT_NO_RATE`,
  `NO_BANK_DETAILS`, `OVERRIDE_CLAMPED`, `PERSON_EXITED`, `NOT_EMPLOYED_THIS_MONTH` (warn);
  `JOINED_MID_MONTH`, `LEFT_MID_MONTH`, `VARIANCE` (info). (HOURS_WORKED_MISSING and NOT_EMPLOYED_THIS_MONTH
  added by rulings T2-a and T2-e during execution.)
- **Rules:** exactly spec §8.
  - On monthly calendar basis, `basic = base − base/days × (absent + days_not_employed)`, floored at 0.
  - `advance_recovery` defaults to `balances.advance + inputs.advance_given`.
  - Cap order when `net_before_cap < 0`: advance, then loans newest first, then other.
  - `carried_advance = balances.advance + advance_given − advance_recovery`.
  - `exited_on` before the month starts, or `status = 'exited'`, raises `PERSON_EXITED`.

- [ ] **Step 1: Write the failing tests.** All amounts are exact strings.

```js
const base = (o = {}) => ({ month:'2026-07', daysInMonth:31, setup:{pay_basis:'monthly', base:'36000',
  absence_basis:'calendar_days', ot_hours_per_day:'6', ot_multiplier:'1', holiday_mode:'none'},
  person:{status:'active', pay_channel_kind:'cash', has_bank_details:false},
  inputs:{}, balances:{advance:'0', loans:[]}, adjustments:[], previous:null,
  policy:{rounding:'paise', ot_high_hours:'150', deduction_warn_pct:'50', variance_warn_pct:'25'}, ...o });
test('days in month follows the month', () => {
  assert.equal(daysInMonthOf('2026-02'), 28); assert.equal(daysInMonthOf('2028-02'), 29);
  assert.equal(daysInMonthOf('2026-09'), 30); assert.equal(daysInMonthOf('2026-07'), 31); });
test('calendar basic', () => {
  assert.equal(computeLine(base()).basic, '36000.00');
  assert.equal(computeLine(base({ inputs:{absent_days:'2'} })).basic, '33677.42'); });
test('February divides by 28', () => {
  assert.equal(computeLine(base({ month:'2026-02', daysInMonth:28, inputs:{absent_days:'1'} })).basic, '34714.29'); });
test('overtime at 6 h/day', () => {
  const r = computeLine(base({ setup:{...base().setup, base:'20150'}, inputs:{ot_hours:'71.55'} }));
  assert.equal(r.ot_amount, '7751.25'); });
test('OT hours with no OT rate pay 0 and warn', () => {
  const r = computeLine(base({ setup:{...base().setup, ot_hours_per_day:'0'}, inputs:{ot_hours:'10'} }));
  assert.equal(r.ot_amount, '0.00'); assert.ok(r.flags.some(f => f.code === 'OT_NO_RATE')); });
test('holiday formula ×1.5 and ×1', () => {
  const s = {...base().setup, base:'20150', holiday_mode:'formula', holiday_divisor:'30.5'};
  assert.equal(computeLine(base({ setup:{...s, holiday_multiplier:'1.5'} })).holiday_amount, '990.98');
  assert.equal(computeLine(base({ setup:{...s, holiday_multiplier:'1'} })).holiday_amount, '660.66'); });
test('the prompt\'s worked example', () => {
  const r = computeLine(base({ month:'2026-06', daysInMonth:30,
    setup:{...base().setup, base:'30000', absence_basis:'fixed_divisor', absence_divisor:'30', ot_fixed_rate:'150'},
    inputs:{absent_days:'2', ot_hours:'10', misc_deduction:'500'},
    balances:{advance:'2000', loans:[{loan_id:1, loan_no:'CI-LN-0001', due:'3000', outstanding:'9000'}]} }));
  assert.equal(r.basic,'28000.00'); assert.equal(r.ot_amount,'1500.00'); assert.equal(r.gross,'29500.00');
  assert.equal(r.total_deductions,'5500.00'); assert.equal(r.net,'24000.00'); assert.equal(r.payable,'24000.00'); });
test('workbook equivalence row', () => {
  const r = computeLine(base({ setup:{...base().setup, base:'14300', holiday_mode:'formula',
      holiday_divisor:'30.5', holiday_multiplier:'1'},
    inputs:{absent_days:'2.5', ot_hours:'30.48', misc_earning:'210', advance_given:'9000'} }));
  assert.equal(r.gross, '16168.97'); assert.equal(r.net_before_cap, '7168.97');
  assert.match(r.exact.gross, /^16168\.981491/); });
test('contract pays the bill, blocks without it', () => {
  const c = {...base().setup, pay_basis:'contract'};
  assert.equal(computeLine(base({ setup:c, inputs:{bill_amount:'50000'} })).basic, '50000.00');
  assert.ok(computeLine(base({ setup:c })).flags.some(f => f.code==='BILL_AMOUNT_MISSING' && f.level==='block')); });
test('cap: advance shrinks first, loan still recovered', () => {
  const r = computeLine(base({ month:'2026-09', daysInMonth:30, setup:{...base().setup, base:'10000'},
    balances:{advance:'12000', loans:[{loan_id:7, loan_no:'CI-LN-0007', due:'3000', outstanding:'20000'}]} }));
  assert.equal(r.net_before_cap, '-5000.00'); assert.equal(r.advance_recovery, '7000.00');
  assert.equal(r.loan_recovery, '3000.00'); assert.equal(r.net, '0.00'); assert.equal(r.payable, '0.00');
  assert.equal(r.unrecovered.advance, '5000.00'); assert.equal(r.carried_advance, '5000.00');
  assert.ok(r.flags.some(f => f.code === 'INSUFFICIENT_PAY')); });
test('cap reaches loans when advance is gone', () => {
  const r = computeLine(base({ month:'2026-09', daysInMonth:30, setup:{...base().setup, base:'2000'},
    balances:{advance:'0', loans:[{loan_id:7, loan_no:'X', due:'3000', outstanding:'20000'}]} }));
  assert.equal(r.loan_recovery, '2000.00'); assert.equal(r.unrecovered.loans[0].amount, '1000.00'); });
test('rounding to the rupee shows a rounding line', () => {
  const p = base({ setup:{...base().setup, base:'32550'}, policy:{...base().policy, rounding:'rupee'},
    inputs:{misc_earning:'0.49'} });
  const r = computeLine(p); assert.equal(r.payable, '32550.00'); assert.equal(r.rounding, '-0.49');
  assert.equal(computeLine({...p, inputs:{misc_earning:'0.50'}}).payable, '32551.00'); });
test('absent above month length blocks', () => {
  assert.ok(computeLine(base({ inputs:{absent_days:'32'} })).flags.some(f => f.code==='ABSENT_EXCEEDS_DAYS' && f.level==='block')); });
test('paid separately reduces payable, blocks when above pay', () => {
  assert.equal(computeLine(base({ setup:{...base().setup, base:'32550'}, inputs:{paid_separately:'5500'} })).payable, '27050.00');
  assert.ok(computeLine(base({ setup:{...base().setup, base:'3255'}, inputs:{paid_separately:'5500'} })).flags
    .some(f => f.code==='PAID_SEPARATELY_EXCEEDS')); });
test('joined mid-month', () => {
  const r = computeLine(base({ setup:{...base().setup, base:'32550'}, person:{...base().person, joined_on:'2026-07-10'} }));
  assert.equal(r.days_not_employed, '9'); assert.equal(r.basic, '23100.00');
  assert.ok(r.flags.some(f => f.code === 'JOINED_MID_MONTH')); });
test('left mid-month and exited', () => {
  const r = computeLine(base({ setup:{...base().setup, base:'32550'}, person:{...base().person, exited_on:'2026-07-21'} }));
  assert.equal(r.days_not_employed, '10'); assert.equal(r.basic, '22050.00');
  assert.ok(computeLine(base({ person:{...base().person, status:'exited', exited_on:'2026-06-30'} })).flags
    .some(f => f.code === 'PERSON_EXITED')); });
test('overrides replace and clamp', () => {
  const r = computeLine(base({ balances:{advance:'10000', loans:[]}, inputs:{advance_recovery_override:'4000'} }));
  assert.equal(r.advance_recovery, '4000.00'); assert.equal(r.carried_advance, '6000.00');
  const c = computeLine(base({ balances:{advance:'10000', loans:[]}, inputs:{advance_recovery_override:'15000'} }));
  assert.equal(c.advance_recovery, '10000.00'); assert.ok(c.flags.some(f => f.code === 'OVERRIDE_CLAMPED'));
  const l = computeLine(base({ balances:{advance:'0', loans:[{loan_id:1, loan_no:'A', due:'2000', outstanding:'2500'},
    {loan_id:2, loan_no:'B', due:'3000', outstanding:'9000'}]}, inputs:{loan_recovery_override:'4000'} }));
  assert.deepEqual(l.loan_recoveries, [{loan_id:1, amount:'2500.00'}, {loan_id:2, amount:'1500.00'}]); });
test('warnings: deductions %, high OT, bank details, variance', () => {
  assert.ok(computeLine(base({ setup:{...base().setup, base:'10000'}, balances:{advance:'0',
    loans:[{loan_id:1, loan_no:'A', due:'6000', outstanding:'9000'}]} })).flags.some(f => f.code==='DEDUCTIONS_OVER_PCT'));
  assert.ok(computeLine(base({ inputs:{ot_hours:'151'} })).flags.some(f => f.code==='HIGH_OT'));
  assert.ok(computeLine(base({ person:{status:'active', pay_channel_kind:'bank', has_bank_details:false} })).flags
    .some(f => f.code==='NO_BANK_DETAILS'));
  const v = computeLine(base({ setup:{...base().setup, base:'26000'}, previous:{gross:'20000', components:{}} }));
  assert.ok(v.flags.some(f => f.code==='VARIANCE' && /30%/.test(f.message))); });
test('effectiveSetup picks the latest revision not after the month', () => {
  const s = [{effective_from:'2026-04-01', base:'1'}, {effective_from:'2026-08-01', base:'2'}];
  assert.equal(effectiveSetup(s, '2026-07').base, '1'); assert.equal(effectiveSetup(s, '2026-08').base, '2');
  assert.equal(effectiveSetup(s, '2026-03'), null); });
test('every component explains itself', () => {
  const r = computeLine(base({ inputs:{absent_days:'1', ot_hours:'12'} }));
  for (const c of r.components) assert.ok(c.formula && c.label && c.amount, c.code);
  assert.match(r.components.find(c => c.code==='BASIC').formula, /31/); });
```

- [ ] **Step 2: Run them and see them fail.** `node --test src/hr-engine.test.js`: FAIL, module not
  found.
- [ ] **Step 3: Implement `computeLine`, `daysInMonthOf`, `effectiveSetup`** in
  `server/src/hr/engine.js`, using Task 1 only.
  - **Formula strings** use Indian digit grouping (`₹20,150 ÷ 31 days × 30 days present`).
  - **Variance** is `|gross − previous.gross| / previous.gross > variance_warn_pct`. The message
    states the % change as an integer, e.g. `+30% vs last month`.
- [ ] **Step 4: Run them again.** Expected: PASS (all tests).

---

### Task 3: Safe matching

**Files:** Create `server/src/hr/match.js`. Test `server/src/hr-match.test.js`.

**Interfaces — Produces:**
- `normName(s) → string`: NBSP to space, collapse whitespace, trim, upper-case; `''` for null.
- `normCode(s) → string|null`: trim. An all-digits value (optionally `.0`) loses leading zeros and the
  trailing `.0`; otherwise upper-case. Empty gives null.
- `buildIndex(people:[{id, code, name, display_name}], aliases:[{person_id, alias_norm}]) → Index`.
- `matchRow({code, name}, index) → {status, person_id, candidates, note}`. `status` is one of
  `'code'|'exact_name'|'alias'|'conflict'|'unknown_code'|'ambiguous'|'unmatched'`.
  - A code is found and the name is blank, equals that person's name or display name (normalised), or
    is one of that person's aliases → `'code'`.
  - A code is found but the name differs → `'conflict'`, with `person_id: null` and
    `candidates: [codePerson, …nameHits]`.
  - An unknown code → `'unknown_code'`, with candidates from the name.
  - No code: exactly one exact name or display hit → `'exact_name'`; several → `'ambiguous'`; an alias
    → `'alias'`; otherwise `'unmatched'` with `suggest()` candidates.
  - `person_id` is set **only** for `code | exact_name | alias`.
- `suggest(name, index, limit = 5) → person_id[]`: prefix either way, then shared word tokens.
  Suggestions only.
- `findDuplicates(results:[{row_id, person_id}]) → [[row_id, …]]`: groups of two or more sharing a
  `person_id`.

- [ ] **Step 1: Write the failing tests:**

```js
const people = [{id:1, code:'101', name:'Arun'}, {id:2, code:'129', name:'Arun Press Tara'},
  {id:3, code:'130', name:'Bhola', display_name:'BHOLA PASTING'}, {id:4, code:'140', name:'Kiran Admin', display_name:'KIRAN'},
  {id:5, code:'141', name:'Kiran Sorting', display_name:'KIRAN'}, {id:6, code:'50', name:'Raj Kumar'}];
const ix = buildIndex(people, [{person_id:6, alias_norm:'RAJKUMAR'}]);
test('prefix collisions never cross', () => {
  assert.equal(matchRow({name:'ARUN'}, ix).person_id, 1);
  assert.equal(matchRow({name:'ARUN PRESS TARA'}, ix).person_id, 2);
  const r = matchRow({name:'ARU'}, ix); assert.equal(r.status, 'unmatched'); assert.equal(r.person_id, null);
  assert.deepEqual(r.candidates.sort(), [1, 2]); });
test('NBSP and case', () => assert.equal(matchRow({name:'bhola '}, ix).person_id, 3));
test('display name matches', () => assert.equal(matchRow({name:'BHOLA PASTING'}, ix).person_id, 3));
test('code wins when the name agrees; leading zeros ignored', () => {
  const r = matchRow({code:'0130', name:'BHOLA'}, ix); assert.equal(r.status, 'code'); assert.equal(r.person_id, 3); });
test('code with a different person\'s name is a conflict', () => {
  const r = matchRow({code:'130', name:'ARUN'}, ix); assert.equal(r.status, 'conflict'); assert.equal(r.person_id, null); });
test('unknown code', () => assert.equal(matchRow({code:'99', name:'X'}, ix).status, 'unknown_code'));
test('two people share a display name: ambiguous', () => {
  const r = matchRow({name:'KIRAN'}, ix); assert.equal(r.status, 'ambiguous'); assert.equal(r.person_id, null); });
test('approved alias', () => {
  const r = matchRow({name:'Rajkumar'}, ix); assert.equal(r.status, 'alias'); assert.equal(r.person_id, 6); });
test('duplicates', () => assert.deepEqual(findDuplicates([{row_id:10, person_id:1}, {row_id:11, person_id:1}, {row_id:12, person_id:2}]), [[10, 11]]));
test('normCode', () => { assert.equal(normCode(' 0130 '), '130'); assert.equal(normCode('130.0'), '130');
  assert.equal(normCode('ci101'), 'CI101'); assert.equal(normCode('  '), null); });
```

- [ ] **Step 2: Run them and see them fail.** `node --test src/hr-match.test.js`: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** PASS.

---

### Task 4: Excel import parsing

**Files:** Create `server/src/hr/import-parse.js`. Test `server/src/hr-import-parse.test.js`.

**Interfaces — Produces:**
- `FIELDS`: an ordered array of `{key, kind:'text'|'code'|'number', synonyms:string[], blankZero:boolean, info?:true}`:

  | key | kind | synonyms (normalised) | blankZero |
  |---|---|---|---|
  | name | text | PERSON, NAME, EMPLOYEE NAME, EMPLOYEE | – |
  | code | code | CODE NO., CODE NO, CODE, EMPLOYEE ID, EMP CODE, EMP ID | – |
  | ot_hours | number | OT, OT HOURS, OVERTIME, OVERTIME HOURS | true |
  | absent_days | number | AB, ABSENT, ABSENT DAYS, ABSENCE DAYS | true |
  | paid_leave_days | number | PAID LEAVE, PAID LEAVE DAYS, PL | false |
  | hours_worked | number | HOURS WORKED, HOURS | false |
  | misc_earning | number | MISC., MISC, MISCELLANEOUS, MISC EARNING | true |
  | misc_deduction | number | MISC DEDUCTION, OTHER DEDUCTION, DEDUCTION | false |
  | bonus | number | BONUS, INCENTIVE, BONUS/INCENTIVE | false |
  | advance_given | number | ADVANCE, ADV, ADVANCE TAKEN | true |
  | bill_amount | number | BILL AMOUNT, BILL | true |
  | holiday_override | number | HOLIDAY, HOLIDAY PAY | false |
  | loan_recovery_override | number | LOAN REPAYMENT, LOAN INST, INST | false |
  | advance_recovery_override | number | ADVANCE RECOVERY, ADV RECOVERY | false |
  | paid_separately | number | PAID SEPARATELY, ANIK | false |
  | remarks | text | REMARKS, REMARK, NOTES | – |
  | department | text, info | DEPT, DEPARTMENT | – |
  | firm | text, info | FIRM | – |
  | pay_channel | text, info | CODE 2, TRANS MODE, BANK ALLOCATION, MODE | – |

- `async readWorkbook(buffer) → {sheets:[{name, grid:string[][]}]}`. Cells become text:
  - numbers via `String()`;
  - formula cells → their cached `result`;
  - rich text → joined text;
  - dates → `YYYY-MM-DD`;
  - errors → `'#ERR'`;
  - NBSP → space; trailing empty cells are kept so columns don't shift.
- `normHeader(s) → string`: `normName`, then strip a trailing `.` only when matching synonyms that
  lack it.
- `detectHeader(grid) → {headerRow, headers}|null`: the first of the first 15 rows with ≥3 cells
  matching any synonym.
- `pickSheet(sheets) → {name, headerRow, headers}`: the sheet whose detected header scores best.
- `autoMap(headers) → {map:{[key]: colIndex}, unmapped:number[], signature}`. `signature` is the
  normalised headers joined by `|`. Each column maps to at most one field; on a tie, the first
  synonym list wins.
- `extractRows(grid, headerRow, map, {blankZero, daysInMonth}) → [{row_no, raw, fields, issues}]`:
  - `row_no` is 1-based;
  - rows with neither name nor code are skipped;
  - numbers parse through `rat` and are stored as `fmtDecimal(r)` strings (exact, never truncated);
  - a blank is `null`, or `'0'` when `blankZero[key]`;
  - issues: `NOT_A_NUMBER` (error), `NEGATIVE` (error), `ABSENT_EXCEEDS_DAYS` (error),
    `ABSENT_NOT_HALF` (warn).

- [ ] **Step 1: Write the failing tests.** Build the workbook in the test with exceljs, synthetic names
  only.
  - Row 1 is the title `'MONTH '`.
  - Row 2 headers: `['PERSON ','Code No. ','DEPT','OT','AB','MISC. ','ADVANCE ','BILL AMOUNT ','REMARKS ','EXTRA']`.
  - Data rows:
    - `Alpha` — code 130, OT `{formula:'40+46.37', result:86.37}`, AB 3, MISC 410, ADVANCE `'11,000'`;
    - `Beta` — OT blank, AB `'abc'`;
    - a fully blank row;
    - `Gamma` — ADVANCE −5;
    - `Delta` — AB 2.25, OT typed as the text `' 12.5 '`;
    - `Echo` — ADVANCE `'₹ 5,000'`, AB 32.

```js
const { sheets } = await readWorkbook(buf); const s = pickSheet(sheets);
assert.equal(s.headerRow, 1);
const { map, signature } = autoMap(s.headers);
assert.deepEqual([map.name, map.code, map.department, map.ot_hours, map.absent_days, map.misc_earning,
  map.advance_given, map.bill_amount, map.remarks], [0,1,2,3,4,5,6,7,8]);
assert.equal(autoMap(['person',' code no.','dept','ot','ab','misc.','advance','bill  amount','remarks','extra']).signature, signature);
const rows = extractRows(sheets[0].grid, s.headerRow, map, { blankZero:{ot_hours:true, absent_days:true}, daysInMonth:31 });
assert.equal(rows.length, 5);                                              // blank row skipped
assert.equal(rows[0].fields.ot_hours, '86.37'); assert.equal(rows[0].fields.advance_given, '11000');
assert.equal(rows[1].fields.ot_hours, '0');                                // blank-as-zero
assert.ok(rows[1].issues.some(i => i.code==='NOT_A_NUMBER' && i.field==='absent_days'));
assert.ok(rows[2].issues.some(i => i.code==='NEGATIVE'));
assert.ok(rows[3].issues.some(i => i.code==='ABSENT_NOT_HALF' && i.level==='warn'));
assert.equal(rows[3].fields.ot_hours, '12.5');                             // text number with spaces
assert.equal(rows[4].fields.advance_given, '5000');
assert.ok(rows[4].issues.some(i => i.code==='ABSENT_EXCEEDS_DAYS'));
const noZero = extractRows(sheets[0].grid, s.headerRow, map, { blankZero:{}, daysInMonth:31 });
assert.equal(noZero[1].fields.ot_hours, null);
// columns re-ordered with an extra leading column still map by header
assert.equal(autoMap(['SR','ADVANCE','PERSON','AB','OT']).map.name, 2);
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement**, reusing `normName` from Task 3 and `rat`/`fmtExact` from Task 1.
- [ ] **Step 4: Run them again.** PASS.

---

### Task 5: Loan positions and schedule

**Files:** Create `server/src/hr/loans.js`. Test `server/src/hr-loans.test.js`.

**Interfaces**

**Consumes:** Task 1.

**Produces:**
- `loanOutstanding(loan, txns) → string`. The loan is `{principal}`. Txns are
  `{kind, principal_amount}`. `disbursed` and `opening` add; `payroll_recovery`, `prepayment` and
  `waiver` subtract; `adjustment` is signed.
- `dueForMonth(loan, txns, holidays:string[], month) → {due, outstanding}`. The loan is
  `{status, instalment, first_due_month}`. `due` is `'0.00'` when the status isn't `active`,
  `month < first_due_month`, the month is a holiday, or the outstanding is ≤ 0. Otherwise it is
  `min(instalment, outstanding)`.
- `projectSchedule(loan, txns:[{kind, principal_amount, run_month?}], holidays, fromMonth, max = 120) → [{month, opening, due, recovered, closing, status}]`.
  `status` is one of `'recovered'|'partial'|'holiday'|'projected'`. Past months come from
  `payroll_recovery` txns by `run_month`; future months project `min(instalment, outstanding)`.
- `nextMonth(month) → 'YYYY-MM'`.

- [ ] **Step 1: Write the failing tests:**

```js
const loan = {principal:'20000', status:'active', instalment:'5000', first_due_month:'2026-08'};
const tx0 = [{kind:'disbursed', principal_amount:'20000'}];
assert.deepEqual(dueForMonth(loan, tx0, [], '2026-07'), {due:'0.00', outstanding:'20000.00'});
assert.equal(dueForMonth(loan, tx0, [], '2026-08').due, '5000.00');
const tx1 = [...tx0, {kind:'payroll_recovery', principal_amount:'5000', run_month:'2026-08'},
                     {kind:'payroll_recovery', principal_amount:'2000', run_month:'2026-09'}];
assert.equal(loanOutstanding(loan, tx1), '13000.00');
const sch = projectSchedule(loan, tx1, [], '2026-08');
assert.deepEqual(sch.map(r => [r.month, r.due, r.status]), [['2026-08','5000.00','recovered'],
  ['2026-09','5000.00','partial'], ['2026-10','5000.00','projected'], ['2026-11','5000.00','projected'],
  ['2026-12','3000.00','projected']]);
const hol = projectSchedule(loan, tx1, ['2026-11'], '2026-10');
assert.deepEqual(hol.map(r => [r.month, r.due]), [['2026-10','5000.00'], ['2026-11','0.00'], ['2026-12','5000.00'], ['2027-01','3000.00']]);
assert.equal(dueForMonth(loan, [...tx1, {kind:'prepayment', principal_amount:'13000'}], [], '2026-10').due, '0.00');
assert.equal(dueForMonth({...loan, status:'closed'}, tx0, [], '2026-08').due, '0.00');
assert.equal(nextMonth('2026-12'), '2027-01');
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** PASS.

---

### Task 6: Schema, access guard, audit

**Files:**
- Create `supabase/migrations/20261016120000_hr_payroll.sql`.
- Create `server/src/hr/access.js` and `server/src/hr/audit.js`.
- Modify `server/src/db.js`: one line after the last `migration(…)` call (currently line 2855).
- Test `server/src/hr-schema.test.js` and `server/src/hr-access.test.js`.

**Interfaces — Produces:**
- **The schema.** Every table and column of spec §7, in schema `hr`:
  - checks for every enum listed there;
  - the unique keys listed there;
  - the partial uniques `advance_txns (run_id, person_id, kind) WHERE run_id IS NOT NULL` and
    `loan_txns (loan_id, run_id) WHERE kind = 'payroll_recovery'`;
  - `import_batches (month, file_sha256) WHERE status <> 'discarded'`.

  Audit is `hr.audit_log` plus `hr.audit_log_immutable()`, a trigger function raising on
  UPDATE/DELETE.
- **The bootstrap:**
  ```sql
  insert into hr.access(user_id, level, granted_by, note)
  select id, 'admin', id, 'bootstrap' from public.users where lower(email) = 'md@motionci.com'
  on conflict do nothing;
  ```
- **Settings defaults** are seeded with `on conflict do nothing`:
  - `rounding='rupee'`, `ot_high_hours=150`, `deduction_warn_pct=50`, `variance_warn_pct=25`;
  - `holiday_divisor_default=30.5`, `strict_separation=false`;
  - `blank_zero={ot_hours, absent_days, misc_earning, advance_given, bill_amount: true}`.
- **Access module:**
  - `HR_LEVELS = ['viewer','operator','approver','admin']`;
  - `levelAtLeast(level, min) → boolean`;
  - `async hrAccessFor(userId) → level|null` (pool read of `hr.access`);
  - `hrGuard(req, res, next)`: memoises `req.hr = {level}`, 403 `{error:'You do not have access to HR & Payroll', code:'HR_NO_ACCESS'}`;
  - `requireHr(min)`: 403 `{error:\`Needs HR ${min} access\`, code:'HR_LEVEL'}`.
- `async hrAudit(qc, req, entity, entityId, action, detail = null)` inserts `user_id`/`user_name`
  from `req.user`.

- [ ] **Step 1: Write the failing tests.**

`hr-schema.test.js` reads the SQL with `fileURLToPath`:
```js
assert.match(sql, /set local lock_timeout/i);
assert.match(sql, /create schema if not exists hr/i);
for (const m of sql.matchAll(/create table if not exists\s+([\w.]+)/gi)) assert.match(m[1], /^hr\./, m[1]);
assert.doesNotMatch(sql, /references\s+(public\.|users\b|employees\b)/i);
assert.doesNotMatch(sql, /\bdrop\s+(table|trigger|schema)\b/i);
assert.match(sql, /before update or delete on hr\.audit_log/i);
assert.match(sql, /numeric\(12,\s*2\)/i);
assert.doesNotMatch(sql, /double precision/i);
assert.match(fs.readFileSync(dbJs, 'utf8'), /migration\('20261016120000_hr_payroll\.sql'\)/);
```
`hr-access.test.js` (no DB):
```js
assert.equal(levelAtLeast('approver', 'operator'), true); assert.equal(levelAtLeast('viewer', 'operator'), false);
assert.equal(levelAtLeast(null, 'viewer'), false);
const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
requireHr('approver')({ hr: { level: 'operator' } }, res, () => assert.fail('must not pass'));
assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'HR_LEVEL');
let passed = false; requireHr('operator')({ hr: { level: 'admin' } }, res, () => { passed = true; }); assert.ok(passed);
```
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - **Migration:** open with `set local lock_timeout = '1s';`, keep every statement idempotent, and use
    `create or replace trigger` (PG ≥14).
  - **db.js:** append
    `await pool.query(migration('20261016120000_hr_payroll.sql'));` with a one-line comment
    `// HR & Payroll (schema hr) — 2026-10-16`.
- [ ] **Step 4: Run them again.** PASS. Then run the whole suite: `npm test -w server`. Expected: only
  the 2 known failures.

---

### Task 7: Ledger reads and run orchestration

**Files:** Create `server/src/hr/ledger.js` and `server/src/hr/runs.js`. Its tests live in Task 13
(DB). The pure part (`linesHash`) is tested in `server/src/hr-runs.test.js`.

**Interfaces**

**Consumes:** Tasks 1, 2, 5, 6.

**Produces:**
- `async advanceBalances(qc, personIds) → Map<id, string>`: posted ledger sums.
- `async loanPositions(qc, personIds, month) → Map<id, [{loan_id, loan_no, due, outstanding}]>`:
  `dueForMonth` over loaded txns and holidays.
- `async inAppAdvancesInMonth(qc, personIds, month) → Map<id, string>`: `given` rows with
  `source='manual'` and `txn_date` in the month.
- `linesHash(line) → string`: sha256 over the engine inputs that decide pay. Pure.
- `async ensureRun(qc, month, userId) → run`: creates a draft with `days_in_month = daysInMonthOf(month)`
  and the policy snapshot from `hr.settings`.
- `async recalcRun(qc, run, {personIds} = {}) → {lines, totals}`. Draft only; throws an
  `Object.assign(new Error('Run is not a draft'), {status:409, code:'RUN_LOCKED'})` otherwise. It
  loads people, setups (`effectiveSetup`), inputs where `include = true`, balances, approved
  adjustments for the month, and the previous finalised line. Then it runs `computeLine`, upserts
  `run_lines` (with breakdown, flags and `inputs_hash`), and writes `runs.totals`.
  - **The engine's `advance_given` is the effective new advance** (spec §9 item 7), computed from
    `run_inputs.advance_mode`:
    - `'extra'` → the Excel figure;
    - `'total'` (default) → `max(0, excel − inAppAdvancesInMonth)`.
  - When Excel is below what's already recorded, add the flag
    `{level:'warn', code:'ADVANCE_BELOW_RECORDED'}` to the line.
- `async finaliseRun(qc, run, req) → run`, all in the caller's tx:
  1. `SELECT … FOR UPDATE` the run; the status must be `approved` (else 409 `RUN_STATE`).
  2. No earlier non-finalised run may exist (409 `PREVIOUS_MONTH_OPEN`).
  3. Recompute in memory. If any line's `payable` or `inputs_hash` differs from the stored line →
     409 `RUN_CHANGED_SINCE_APPROVAL`.
  4. Insert `advance_txns`:
     - `given` = the line's `advance_given` (already net of in-app advances, see `recalcRun`), only
       when > 0;
     - `recovered` = `advance_recovery`, only when > 0.
  5. Insert `loan_txns` `payroll_recovery` per loan recovery.
  6. Set status `finalised` with who and when; `hrAudit`.

- [ ] **Step 1: Write the failing test** `hr-runs.test.js`. `linesHash` must be stable for equal
  inputs and differ when `absent_days` changes:
```js
const a = linesHash({ setup:{base:'1'}, inputs:{absent_days:'1'} }), b = linesHash({ inputs:{absent_days:'1'}, setup:{base:'1'} });
assert.equal(a, b); assert.notEqual(a, linesHash({ setup:{base:'1'}, inputs:{absent_days:'2'} }));
```
  Use canonical JSON with sorted keys.
- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement both files.**
- [ ] **Step 4: Run it again.** PASS. The DB behaviour is proven in Task 13.

---

### Task 8: Salary-workbook loader

**Files:** Create `server/src/hr/workbook-loader.js`. Test `server/src/hr-workbook-loader.test.js`.

**Interfaces**

**Consumes:** Tasks 1, 3, 4 (`readWorkbook`, `normName`, `normCode`).

**Produces:** `async parseSalaryWorkbook(buffer) → Parsed`:
```
{ month, daysInMonth,
  people:[{code, name, display_name, firm, department, worker_type, pay_channel_label,
           legacy:{c_stat, hp, bank_code}, bank:{holder, account, ifsc}|null, esi_applicable}],
  setups:[{code, pay_basis, base, ot_hours_per_day, holiday_mode, holiday_divisor, holiday_multiplier,
           holiday_fixed, review:string[]}],
  openingLoans:[{code, outstanding, instalment, review:string[]}],
  openingAdvances:[{code, amount}],
  monthInputs:[{code, name, ot_hours, absent_days, misc_earning, advance_given, bill_amount,
                paid_separately, loan_instalment}],
  expected:[{code, gross, final}],
  issues:[{level, message}] }
```

- **Where things come from.** FINAL SHEET is found by a header row containing PERSON, CODE NO. and
  OT CRT. Columns are found by normalised header:
  - BASE is the `BASE <year>` with the highest year;
  - OT, AB, ANIK, FINAL PAYMENT, ADV, LOAN, INST, OS, OT CRT, BASIC, MISC., HOLIDAY, TOTAL SAL,
    TRANS MODE, C STAT, HP.
- `month` comes from the cells right of `MONTH` / `DAYS`. Month names map to numbers.
- **Holiday:**
  - a formula containing `/30.5*1.5` → formula 30.5 × 1.5;
  - `/30.5` → formula 30.5 × 1;
  - a typed number > 0 → `fixed`, with review `'typed holiday amount — monthly or one-off?'`;
  - otherwise `none`.
- **Contract:** a BASIC cell that isn't a formula → `pay_basis='contract'`, and that value becomes
  `monthInputs.bill_amount`.
- **Opening loans:** OS > 0. The instalment is INST, or else it is parsed from the GENERAL DATA or
  New data remarks `/(\d+)\s*[xX×]\s*(\d+)/` (count × amount), with a review note.
- **Opening advances:** FINAL PAYMENT < 0 → `amount = −final`.
- **BANK DETAILS:** matched by `normName(NAME)` to FINAL SHEET `normName(PERSON)`. Unmatched rows go
  to `issues`. TYPE Contractor → `worker_type='contractor'`; ESI PAYABLE Yes → `esi_applicable=true`.
- **Month inputs** are the cached values of FINAL SHEET OT, AB, MISC., ADV, ANIK and INST.
  **Expected** values are TOTAL SAL and FINAL PAYMENT.

- [ ] **Step 1: Write the failing tests.**
  - Build a synthetic 3-person workbook with exceljs in the July layout:
    - FINAL SHEET header on row 4, MONTH/DAYS in rows 1–2;
    - formulas with cached `result` values;
    - one typed-BASIC contractor;
    - one negative final;
    - one OS > 0 with INST 0 and a remark `'4X5000 FROM NEXT MONTH'`.
  - Add a BANK DETAILS sheet and a GENERAL DATA sheet.
  - Assert:
    - month `'2026-07'` and 31 days;
    - three people;
    - the contractor's `pay_basis`;
    - holiday modes and review notes;
    - an opening loan with instalment `'5000.00'` and a review note;
    - an opening advance equal to the negative final;
    - bank fields joined by name;
    - `expected` values equal the cached results.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** PASS.

---

### Task 9: Routes — people, setups, settings, access, dashboard

**Files:** Create `server/src/routes/hr.js`. Modify `server/src/app.js` (import and `app.use('/api', hrRouter)` alongside the others). Its tests are in Task 13.

**Interfaces**

**Consumes:** Task 6 (`hrGuard`, `requireHr`, `hrAudit`), Task 2 (`effectiveSetup`), Task 7
(`advanceBalances`, `loanPositions`).

**Produces:** the rows of the API contract from `/hr/me` to `/hr/erp-operators`.

- [ ] **Step 1: Wire the router.** It starts with `r.use('/hr', hrGuard)` and
  `r.use('/hr', (req, _res, next) => { if (req.method === 'GET') markUncacheable(); next(); })`.
- [ ] **Step 2: Implement the endpoints** with validation:
  - **Codes:** `normCode`, unique (409 `CODE_EXISTS`).
  - **Setups:** `effective_from` must match `/^\d{4}-\d{2}-01$/`. Required fields per `pay_basis`.
    A setup can't be edited once a finalised run used it; only a new revision can be added.
  - **Lists:** `bank_last4` = last 4 digits of the account. The full account appears only in
    `GET /hr/people/:id` for operator and above.
  - **Access:** `PUT /hr/access/:userId` with `null` removes the row. 409 `LAST_ADMIN` when removing
    the last admin.
  - **Dashboard** figures follow spec §14 for `month` (default: `plantDateStr().slice(0,7)`).
  - **Writes:** each runs in `tx` and calls `hrAudit(qc, req, …)`.
- [ ] **Step 3: Run a smoke check** (no DB): `node -e "import('./src/app.js').then(()=>console.log('ok'))"`
  from `server/`. Expected: `ok`. Then run `node --test src/app-imports.test.js src/mint-routes-join-once.test.js src/plant-date-routes.test.js src/optional-text-guard.test.js`.
  Expected: PASS.

---

### Task 10: Routes — imports, runs, payments

**Files:** Create `server/src/routes/hr-payroll.js`. Modify `server/src/app.js` (mount). Modify
`server/src/notify-categories.js` and `client/src/lib/notificationLink.js` (kinds `hr_run_submitted`
and `hr_run_sent_back`, linking to `/hr?tab=payroll&month=<month>`).

**Interfaces**

**Consumes:** Tasks 3, 4, 6, 7.

**Produces:** the contract rows from `/hr/imports` to `/hr/runs/:month/variance`.

- [ ] **Step 1: Write the import upload.**
  - multer memory with a 4 MB limit (copy the size-error-to-400 wrapper from
    `routes/orders.js:1353-1450`) and an xlsx magic-bytes check (`PK\x03\x04`).
  - sha256 the file; a duplicate for the month that isn't discarded gives 409 `DUPLICATE_FILE` with
    `batch_id`.
  - `readWorkbook`, then `pickSheet`, then the saved `column_maps` for the signature (else `autoMap`),
    then `extractRows`.
  - `matchRow` per row against people and aliases, then `findDuplicates`.
  - Flag rows matching an exited person with `PERSON_EXITED`.
  - `missing` = active people with a setup for the month and no row.
  - Store the batch and its rows.
- [ ] **Step 2: Write the row decisions, re-mapping and apply.**
  - `save_alias:true` inserts `person_aliases` for that row's `normName`.
  - `apply` refuses (409 `IMPORT_UNRESOLVED`) while any row is `conflict | unknown_code | ambiguous | unmatched` without a decision, or rows have error issues, or duplicates remain.
  - It refuses (409 `RUN_LOCKED`) unless the run is a draft.
  - It upserts `run_inputs` (`source='import'`, `source_row_id`, `advance_mode` from the row
    decision) and supersedes the month's earlier applied batch.
  - Any existing `run_inputs` row with `source='manual'` (edited by hand since the last import) is
    returned in `manual_edits_kept` and **not overwritten**, unless its person is listed in
    `overwrite_manual`.
  - Then `recalcRun`.
- [ ] **Step 3: Write runs, inputs and transitions.**
  - A manual input edit sets `source='manual'`, needs a `reason`, and is audited.
  - **Submit** refuses (409 `RUN_BLOCKED`) when any included line has a `block` flag, or any active
    person with a setup has no input row and no explicit exclude.
  - **Approve** records the approver. If the approver equals the submitter and
    `strict_separation=true`, 409 `SAME_PERSON`; otherwise the response includes
    `warning:'approved by the person who submitted'`.
  - **Finalise** calls `finaliseRun` in `tx`.
  - **Send-back** needs a reason.
  - **Notifications** go to approvers on submit and to the preparer on send-back, through
    `notify(ids, {kind, title:\`Payroll ${monthLabel} …\`, link, refTable:'hr.runs', refId}, qc)`.
    No amounts in title or body.
- [ ] **Step 4: Write payments, payslips and variance.**
  - Payments only for finalised runs; a batch per channel marks its included lines paid with
    reference and date.
  - A line's `reversed` status needs approver.
  - The payslips payload carries company name and GSTIN from the existing invoice constants (reuse,
    don't copy). Each slip carries person, components, totals, loan details, advance balance after
    the run, and amount in words (the client computes words).
  - Variance follows spec §12.
- [ ] **Step 5: Run the smoke and scanner tests** as in Task 9, plus `node --test src/notify-categories.test.js`. Expected: PASS.

---

### Task 11: Routes — loans, advances, adjustments, workbook loader

**Files:** Create `server/src/routes/hr-ledgers.js`. Modify `server/src/app.js` (mount). Modify
`client/src/lib/writeOnce.js` (add `'/hr/loans'` to `MINTING_POSTS`, keeping the list's order rules).

**Interfaces**

**Consumes:** Tasks 5, 6, 7, 8.

**Produces:** the contract rows from `/hr/loans` to `/hr/loader/apply`.

- [ ] **Step 1: Write loans.**
  - Create: `nextNumber('CI-LN', 'hr.loans', 'loan_no', oc)` runs first in the tx, then the insert,
    then a `disbursed` txn (`opening` when `is_opening`).
  - `interest_rate` must be 0 (400 `INTEREST_NOT_YET`).
  - Prepay ≤ outstanding.
  - A holiday month must be ≥ the current plant month.
  - An instalment change from a month is audited (the old value goes in the detail).
  - Cancel only when there are no recoveries.
  - The `GET /hr/loans/:id` schedule comes from `projectSchedule`.
- [ ] **Step 2: Write advances and adjustments.**
  - A manual advance posts `given` with `source='manual'` immediately.
  - A waive is ≤ balance and approver only.
  - A recurring adjustment needs `start_month` and `end_month`; a one-time adjustment needs a single
    month in `start_month`.
  - Approve and cancel are audited.
- [ ] **Step 3: Write the workbook loader.**
  - `preview` (multipart) returns `parseSalaryWorkbook` plus a diff against existing people (new,
    changed, same).
  - `apply` (multipart: the same file plus a `decisions` JSON field `{skip:[code], edits:{code:{…}}}`)
    runs in one tx:
    - upserts pay channels from the labels;
    - upserts people by code;
    - inserts setups `effective_from = nextMonth(parsed.month)-01` (skipping an identical current
      setup);
    - creates opening loans (`is_opening`, `first_due_month = nextMonth(month)`);
    - creates opening advances (`opening` txns dated the month end);
    - audits once with counts.
- [ ] **Step 4: Run the smoke and scanner tests**, including `mint-routes-join-once.test.js`.
  Expected: PASS.

---

### Task 12: Client shell, nav, API helpers

**Files:**
- Create `client/src/lib/hr.js` and `client/src/pages/HR.jsx`.
- Modify `client/src/App.jsx` (lazy `HR` at `/hr` and `HRPayslips` at `/hr/payslips/:month`, inside
  the AppLayout block; payslips may sit outside the layout like the other print pages — follow
  `Invoice.jsx` routing).
- Modify `client/src/components/AppLayout.jsx`:
  - a NAV item `{label:'HR & Payroll', to:'/hr', icon: Users, roles:'all', hr:true}` in the Admin
    group;
  - the filter shows `hr:true` items only when the `/api/hr/me` probe says a level exists;
  - the probe runs once after `currentUser()` and treats a 403 as none.

**Interfaces — Produces:**
- `client/src/lib/hr.js`:
  - `hrApi = { me, people, person, savePerson, addSetup, …one fn per contract row }`, wrapping
    `api.get/post/put/del/upload`;
  - `inr2(v)`: `₹` with Indian grouping and 2 dp;
  - `monthLabel('2026-07')` → `'July 2026'`;
  - `HR_TABS = [{key:'overview'}, {key:'payroll'}, {key:'people'}, {key:'loans'}, {key:'reports'}, {key:'settings'}]`
    with labels.
- `HR.jsx`:
  - reads `?tab=` (default `overview`);
  - calls `hrApi.me()`; on 403 renders an "HR & Payroll is private. Ask Anik for access." card;
  - otherwise GroupedTabs (pattern: `pages/Fluence.jsx:77-93,224`) rendering the tab component and
    passing `level`;
  - the Settings tab is visible only for admin.

- [ ] **Step 1: Implement.** Placeholder tab bodies are allowed until Tasks 14–17 replace them.
- [ ] **Step 2: Build.** `npm run build -w client`. Expected: success.

---

### Task 13: DB-backed tests (HR_PG=1)

**Files:** Create `server/src/hr-pg.test.js`. Copy the boot sequence of `batch-gang-pg.test.js` with
the env `HR_PG`.

- [ ] **Step 1: Write the tests.** Setup:
  - users `admin` (role admin, **no** HR access), `op` (`hr.access` operator), `ap` (approver),
    `vw` (viewer), each with a signed JWT;
  - two synthetic people with setups and one opening loan;
  - an xlsx built in-test.

  Tests (name, then assertion):
  - `admin without HR access is refused everywhere`: GET `/api/hr/people`, GET `/api/hr/runs`,
    POST `/api/hr/imports` → 403 `HR_NO_ACCESS`.
  - `viewer cannot write`: POST `/api/hr/people` as `vw` → 403 `HR_LEVEL`.
  - `bank number is masked in lists`: the list has `bank_last4` and no `bank_account`.
  - `import → apply → lines`:
    - apply returns 200;
    - GET `/api/hr/runs/2026-08` shows 2 lines;
    - gross equals the engine on the same inputs.
  - `recalc never touches ledgers`: count `advance_txns` and `loan_txns` before and after two
    recalcs; they're equal.
  - `same file twice` → 409 `DUPLICATE_FILE`.
  - `manual edit survives a corrected file`:
    - edit person A's OT with a reason, upload a changed file, apply;
    - `manual_edits_kept` includes A;
    - A's OT is unchanged;
    - apply with `overwrite_manual:[A]` replaces it.
  - `import refused after submit` → 409 `RUN_LOCKED`.
  - `an exited person in the file is flagged`: mark person B exited, upload; B's row `issues`
    include `PERSON_EXITED`.
  - `submit → approve → finalise posts once`:
    - one `payroll_recovery` per loan;
    - advance rows `given` and `recovered`;
    - a second finalise → 409 `RUN_STATE`.
  - `finalise refuses while an earlier month is open`: a draft for `2026-08` and an approved
    `2026-09` → 409 `PREVIOUS_MONTH_OPEN`.
  - `finalise rolls back whole on failure`: force a unique violation (pre-insert the
    `payroll_recovery` row for that run); finalise → 5xx or 409; zero new advance rows; the run is
    still `approved`.
  - `payments are separate from finalise`: right after finalise every line is `pending`; after
    POST payments for the channel, those lines are `paid`.
  - `every write audited`: `hr.audit_log` has rows for import, apply, submit, approve, finalise and
    payment.
  - `audit log is append-only`: `UPDATE hr.audit_log …` throws.
- [ ] **Step 2: Run them.** `HR_PG=1 node --test src/hr-pg.test.js`. Expected: PASS.
- [ ] **Step 3: Run the full suite.** `npm test -w server`. Expected: only the 2 known failures (HR_PG
  tests skip without the env).

---

### Task 14: People and Settings screens

**Files:** Create `client/src/pages/hr/People.jsx`, `PersonDrawer.jsx`, `Settings.jsx`,
`WorkbookLoader.jsx`.

**Interfaces**

**Consumes:** `hrApi` (Task 12); the routes of Tasks 9 and 11 (loader).

- **People**: a DataTable with columns code, name, department, channel, type, status, current base,
  OT h/day, holiday, bank (last 4). Filters for status, department, channel. "Add person" (operator).
  Export via `exportName`.
- **PersonDrawer** tabs:
  - Details (edit);
  - Pay setup (history newest first, "New revision" form with effective month);
  - Bank (masked, then full for operator+);
  - Aliases (add/remove);
  - Link to ERP operator (picker from `/hr/erp-operators`);
  - Money: advance balance, loans and recent payslip months.
- **Settings** (admin): policy form (the §6 settings keys), pay channels table, access table (user,
  email, role, HR level select), saved column maps (delete), and the WorkbookLoader.
- **WorkbookLoader**: upload, then preview tables:
  - new / changed / same people;
  - setups with review notes highlighted in amber;
  - opening loans; opening advances.

  Then per-row skip, then Apply. A summary toast shows counts.

- [ ] **Step 1: Implement**, following existing patterns (`pages/Masters.jsx` forms,
  `components/ui.jsx` Modal, Field, Select and DataTable).
- [ ] **Step 2: Build.** `npm run build -w client`. Success.

---

### Task 15: Payroll screen (import wizard, register, line drawer, approvals, payments)

**Files:** Create `client/src/pages/hr/Payroll.jsx`, `ImportWizard.jsx`, `RunLineDrawer.jsx`.

**Interfaces**

**Consumes:** `hrApi`; the routes of Task 10.

- **Month bar**: a month picker (default current plant month), a status chip, and a stepper
  (Upload → Review → Check → Submit → Approve → Finalise → Pay) showing who and when per step.
- **ImportWizard** (Modal):
  1. **File**: a 4 MB note; uploads via `api.upload`; a duplicate shows "already uploaded on …,
     open it".
  2. **Columns**: header → field selects, with "blank counts as 0" ticks; changes re-map on the
     server.
  3. **Rows**: a filter chip per status (matched, conflict, ambiguous, unmatched, errors, duplicates).
     - Each unresolved row offers "Pick person" (searchable select with suggestions first) with a
       "save spelling" tick, plus Ignore.
     - Error issues are shown inline.
     - Rows that also have in-app advances this month show both figures and the total/extra switch.
  4. **Missing people**: include or exclude for each.
  5. **Apply**: shows `manual_edits_kept` with an overwrite tick per person.
  6. **Export issues**: through the exporter.
- **Register**: a DataTable, one row per person.
  - Columns: name, department, channel, present, OT h, basic, OT, holiday, misc, gross, advance,
    loan, other, net, payable, flags (amber and red dots).
  - Group by department or channel; totals row; `exportName`.
  - Exceptions panel above the table lists block and warn flags with counts.
- **RunLineDrawer**:
  - the breakdown table (label, qty, rate, formula, amount);
  - the inputs (editable in draft, with a reason box);
  - flags;
  - the previous month's comparison;
  - a link to the payslip.
- **Action buttons** by status and level: Recalculate / Submit (operator, draft); Send back / Approve
  (approver, submitted); Finalise (approver, approved — the confirm dialog lists totals by channel);
  Payments panel (finalised: per channel "Mark paid" with reference and date; per-line status).

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Build.** Success.

---

### Task 16: Loans & Advances, Reports, Overview, payslip print

**Files:** Create `client/src/pages/hr/LoansAdvances.jsx`, `Reports.jsx`, `Overview.jsx`,
`client/src/pages/HRPayslips.jsx`.

- **LoansAdvances**: sub-tabs Loans, Advances and Adjustments.
  - **Loans**: register (number, person, principal, outstanding, instalment, next due, status); a "New
    loan" modal; a loan drawer with statement, schedule (projected rows in grey) and actions (prepay,
    holiday, change instalment, cancel).
  - **Advances**: a balance per person, "Give advance", a statement drawer, and waive (approver).
  - **Adjustments**: list, new, approve, cancel.
- **Reports**: a month picker with these reports, each exporting PDF and Excel through
  `lib/exporter.js` `sections:` specs:
  - Payment sheet (summary by channel, then detail by channel with subtotals, then "not paid this
    month — carried as advance");
  - Bank transfer list per bank channel (Excel; holder, account, IFSC, amount, reference);
  - Payroll register;
  - Variance;
  - Loan register;
  - Advance register.
- **Overview**: KPI tiles and exception list (spec §14), each linking to the filtered tab.
- **HRPayslips** (print):
  - fetches `/api/hr/runs/:month/payslips` with query `person_ids` / `channel`;
  - one A4 slip per person with `print:break-before-page` between slips;
  - layout per spec §13, with `rupeesInWords` (`lib/amountWords.js`);
  - toolbar `no-print` with Print, and `document.title` = `Payslips <Month> <filter>`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Build.** Success.

---

### Task 17: July acceptance (real workbook, outside the repo)

**Files:** Create `server/src/hr-july-acceptance.test.js`, skipped unless `HR_JULY_XLSX` points to a
readable file.

- [ ] **Step 1: Write the test.**
  - **Engine level:** `parseSalaryWorkbook(file)`. For every person, build a setup from `setups`,
    inputs from `monthInputs` (`advance_given = ADV`; loans `[{due: INST, outstanding: INST + OS}]`
    when INST > 0; `paid_separately = ANIK`; `bill_amount` for contractors), and policy
    `rounding:'paise'`. Run `computeLine` and assert
    `|exact.gross − expected.gross| < 0.005` and `|exact.net_before_cap − expected.final| < 0.005`.
    Print only counts and totals, never names.
  - **Import level:** `readWorkbook`, then the input sheet (env `HR_JULY_INPUT_SHEET`, default
    `'GENERAL DATA '`, the sheet FINAL SHEET actually reads) through `autoMap` and `extractRows`.
    Match against `people` built from `parsed.people`. Assert:
    - every `code | exact_name | alias` match is the person whose `monthInputs` carry identical OT,
      absent, misc and advance;
    - every FINAL SHEET person with any non-zero month input is matched by exactly one row.

    Print counts of unmatched, ambiguous and conflict rows. Then run the same pass on `'New data '`
    and print (don't assert) the number of value differences against GENERAL DATA.
- [ ] **Step 2: Run it.**
  `HR_JULY_XLSX=<path to the July workbook, outside the repo> node --test src/hr-july-acceptance.test.js`.
  Expected: PASS, every person, 0 differences.

---

### Task 18: Verification and browser check

- [ ] **Step 1: Run all the checks.**
  - `npm run verify` chains its steps with `&&`, so the 2 known failures stop it before the client
    build. Run its three steps separately:
    - `node scripts/build-baseline.mjs --check` (or the exact script from root `package.json`):
      PASS. Replayed migrations are not in the baseline by design.
    - `npm test -w server`: only the 2 known failures.
    - `npm run build -w client`: success.
  - `HR_PG=1 node --test src/hr-pg.test.js` and Task 17. Expected: PASS.
- [ ] **Step 2: Run the browser check against a local throwaway DB.**
  - Boot embedded Postgres on a free port with a bootstrap script inside `server/` (the
    embedded-postgres resolution rule). Never use :5439.
  - Run API and Vite on free ports, adding an entry to the **session-level**
    `~/Documents/Projects/Colour Imp Production/.claude/launch.json`.
  - Create an admin and grant HR admin.
  - In the browser:
    - load the July workbook (Settings → loader) and check the preview;
    - Payroll for August: upload a synthetic August sheet, resolve one conflict, apply;
    - check the line drawer, submit, approve, finalise, mark a channel paid;
    - open payslips;
    - export the payment sheet.
  - Screenshots of each step.
- [ ] **Step 3: Write a report** (§19 phase table status, decisions, open questions, and the shared
  files touched), then stop.

---

## Self-review notes

- **Spec coverage:** §3 goals 1–9 map to Tasks 9 and 14 (1); 9 and 14 (2); 4, 10 and 15 (3); 2 (4);
  7, 11 and 16 (5); 5, 11 and 16 (6); 7, 10 and 15 (7); 10 and 16 (8); 12, 16, 6 and 13 (9). §15 is
  Tasks 8, 11 and 14. §18 is Tasks 1–5, 8, 13 and 17. §6 is Tasks 6, 9, 12 and 13. §9 items 1–9 are
  in Tasks 4, 3, 10 and 15.
- **Names are consistent across tasks:** `computeLine`, `effectiveSetup`, `daysInMonthOf`,
  `matchRow`, `buildIndex`, `readWorkbook`, `pickSheet`, `autoMap`, `extractRows`, `dueForMonth`,
  `projectSchedule`, `parseSalaryWorkbook`, `hrGuard`, `requireHr`, `hrAudit`, `recalcRun`,
  `finaliseRun`, `hrApi`, `inr2`.
