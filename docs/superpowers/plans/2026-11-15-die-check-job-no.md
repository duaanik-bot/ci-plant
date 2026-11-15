# Size check: dies by job number, any size order, one line per die — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The costing size check names each existing die by its job, says where the die is known from, finds dies
whose size is written in another order, and shows a Die Master die once.

**Architecture:** Postgres prefilters `die_register` (written order or sorted, within 3 mm, Die Master copies left
out); pure functions in `server/src/costing-match.js` sort the rows into exact / another order / close; pure
wording in `client/src/lib/die-check.js`; `SizeProposals.jsx` renders it. One new column, `die_register.job_no`.

**Tech Stack:** Node + Express + pg, React (Vite), `node:test`, embedded-postgres for `SIZING_PG=1`.

**Spec:** `docs/superpowers/specs/2026-11-15-die-check-job-no-design.md`

## Global Constraints

- **No git commits, pushes or deploys** (owner rule for this work). Each task ends with `git status --short`
  showing only that task's files instead of a commit.
- Public repo: no real job numbers, die sizes or customer names in code, tests or docs — invented values only.
- Tolerance stays **3 mm** each side for the register; the Die Master keeps `NEAR_MM = 2` via `matchDies`.
- `matchDies` / `sizeRelation` behaviour unchanged (other costing checks use them).
- Wording: plain English, no "Not recorded · ? up" — leave unrecorded facts out.
- Production gets the migration **before** the code (the route selects `job_no`); data fill only on the owner's word.

## Review Focus

- **Decimal sizes** (71.5 × 43.5 × 109): node-pg sends params untyped and `$1 - 3` types `$1` as integer — the
  query must cast (`$1::numeric`) and a test must ask for a decimal size and get its exact die (Task 3).
- **Two equal sides** (50 × 50 × 100): 50 × 50 × 100 is exact once; 50 × 100 × 50 is "another order", never exact (Task 1).
- **Two dies on one job** (`J…/1`, `J…/2`): both must read differently — "Job 12345's die no. 2" (Task 2).
- **Old server, new screen** (response without `reordered`, rows without `job_no`/`source`): the screen defaults
  them and still renders (Task 4, `dieName` fallback in Task 2).
- **Many dies of one common size**: the another-order line lists at most 6 then "+ n more" (Task 4).

---

### Task 1: Classify register rows and split the Die Master's other-order dies

**Files:**
- Modify: `server/src/costing-match.js` (append after `matchDies`)
- Create: `server/src/die-check.test.js`

**Interfaces:**
- Produces: `export const REGISTER_MM = 3`;
  `export function sameNumbers(a, b): boolean` (sorted l, w, h equal; `a`/`b` have numeric `l,w,h`);
  `export function registerMatchesFrom(size, rows, { limit = 8 } = {}): { exact: Row[], reordered: Row[], near: (Row & { other_order: boolean })[] }`;
  `export function dieMasterMatches(size, tools, { limit = 8 } = {}): { exact, reordered, near }` (Die Master `tools` rows by the same rule; replaced `splitReordered` after the final review).

- [ ] **Step 1: Write the failing tests** in `server/src/die-check.test.js` (invented dies):
  - `registerMatchesFrom` with size 92×80×66 and rows A 92/80/66, B 80/92/66, C 90/79/64, D 64/90/79, E 100/80/66:
    `exact` = [A], `reordered` = [B], `near` die_nos = [C, D] with `other_order` [false, true], E absent.
  - size 50×50×100, rows 50/50/100 and 50/100/50 → exact [first], reordered [second].
  - `limit: 1` keeps one near die (nearest first: sum of side differences, the smaller of written / sorted).
  - `dieMasterMatches(92×80×66, [{code:'T1',carton_size:'92X80X66'},{code:'T2',carton_size:'80X92X66'},{code:'T3',carton_size:'95X80X66'},{code:'T4',carton_size:'66X80X93'},{code:'T5',carton_size:'96X80X66'},{code:'T6',carton_size:'150X240'}])`
    → exact [T1], reordered [T2], near [T3].
- [ ] **Step 2: Run** `cd server && node --test src/die-check.test.js` — Expected: FAIL (`registerMatchesFrom` is not exported).
- [ ] **Step 3: Implement** the three functions + constant in `costing-match.js`, and update its header comment
      (the register: exact / another order / close within 3 mm, any order).
- [ ] **Step 4: Run** the same command — Expected: PASS. Then reinstate the bug (make `sameNumbers` compare in written
      order) and watch the reordered assertions fail; restore.
- [ ] **Step 5:** `git status --short` shows only these two files (plus the plan/spec).

### Task 2: Die wording

**Files:**
- Create: `client/src/lib/die-check.js`
- Test: `server/src/die-check.test.js` (append)

**Interfaces:**
- Consumes: `styleLabel` from `client/src/lib/costing.js`.
- Produces: `export function dieName(d): string`, `export function dieFrom(d): string`,
  `export function dieFacts(d): string[]`, `export function dieSize(d): string` ('L × W × H', en-IN, ≤ 1 dp), where
  `d` = `{ die_no, l, w, h, style, ups, source, job_no }`.

- [ ] **Step 1: Write the failing tests:**
  - `dieName({ die_no: '7', job_no: '12345', source: 'DIE DATA 2024' })` = `"Job 12345's die"`;
    `dieFrom(same)` = `'2024 die list no. 7'`.
  - no job: `dieName({ die_no: '7', source: 'DIE DATA 2024' })` = `'2024 die list no. 7'`; `dieFrom` = `'no job no. recorded'`.
  - `dieName({ die_no: 'J12345/2', job_no: '12345', source: 'DRIVE NEW DIE' })` = `"Job 12345's die no. 2"`.
  - `dieFrom` for `DRIVE NEW DIE` / `DRIVE DIE LINE` / `DRIVE OLD DIE USE` = `'new-die drawing in Drive'` /
    `'die line in Drive'` / `'old-die job file in Drive'`; unknown source → `'in the die list'`; unknown source and no
    job → `dieName` = `'Die X-1'`.
  - `dieFacts({ style: 'LOCK', ups: 2 })` = `['Lock bottom', '2 up']`; `dieFacts({})` = `[]`.
  - `dieSize({ l: 71.5, w: 43.5, h: 109 })` = `'71.5 × 43.5 × 109'`.
- [ ] **Step 2: Run** `cd server && node --test src/die-check.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `client/src/lib/die-check.js` (pure, no imports beyond `./costing.js`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5:** `git status --short` shows only this task's files added.

### Task 3: Schema + route

**Files:**
- Create: `supabase/migrations/20261115120000_die_register_job_no.sql` — `ALTER TABLE die_register ADD COLUMN IF NOT EXISTS job_no text;` with a header comment (what job_no means, filled outside the repo).
- Modify: `server/src/db.js` — `await pool.query(migration('20261115120000_die_register_job_no.sql'));` right after the `size_kld` line, with a one-line comment.
- Modify: `server/src/routes/sizing.js` — `registerMatches(size)` and the proposals handler; header comment.
- Test: `server/src/sizing-pg.test.js`

**Interfaces:**
- Consumes: `registerMatchesFrom`, `dieMasterMatches` (Task 1).
- Produces: `GET /costing/sizing/proposals` → `dies.master` = `{ exact, reordered, near }`,
  `dies.register` = `{ exact, reordered, near }`; register rows carry `die_no, l, w, h, style, ups, size_text, source, job_no` (+ `other_order` on near).

- [ ] **Step 1: Write the failing test** — extend the `before` seed with invented rows (`job_no` set):
  `('R-57', 71.5, 43.5, 109, 'LOCK', 2, …, 'DIE DATA 2024', '10001')`, `('R-58', 88, 76, 152, 'SIDE', 4, …, 'DIE DATA 2024', NULL)`, `('J10002', 152, 88, 76, NULL, NULL, …, 'DRIVE NEW DIE', '10002')`,
  `('DM-T-901', 92, 80, 66, NULL, NULL, …, 'CI PLANT DIE MASTER', NULL)`; new test
  "the die list: job numbers, any order, Die Master copies left out":
  - `size=71.5x43.5x109` → `register.exact` die_nos `['R-57']`, `job_no` `'10001'`, `source` `'DIE DATA 2024'`.
  - `size=92x80x66` → `register.exact` has no `DM-T-901`; `register.near` die_nos include `R-55`;
    `master.exact` codes `['T-901']`.
  - `size=88x76x152` → `register.exact` `['R-58']`, `register.reordered` `['J10002']`.
  - `size=80x92x66` → `master.reordered` codes `['T-901']`.
  Update the first test's register assertion to the new shape if needed.
- [ ] **Step 2: Run** `cd server && SIZING_PG=1 node --test src/sizing-pg.test.js` — Expected: FAIL (column
      `job_no` missing / shape). Note whether the decimal size errors on the OLD query (proves the Review Focus item).
- [ ] **Step 3: Implement:** migration + db.js line; `registerMatches` SQL with `$n::numeric` casts, the sorted-size
      OR branch (`LEAST`, middle = sum − least − greatest, `GREATEST`), `source IS DISTINCT FROM 'CI PLANT DIE MASTER'`,
      returning through `registerMatchesFrom`; handler uses `dieMasterMatches(size, tools)`.
- [ ] **Step 4: Run** the same command — Expected: PASS (all sizing-pg tests). Then
      `node scripts/build-baseline.mjs --check` from the repo root — Expected: baseline unchanged/OK.
- [ ] **Step 5:** `git status --short` shows only this task's files.

### Task 4: The screen

**Files:**
- Modify: `client/src/pages/costing/SizeProposals.jsx` — `DieCheck` and the header comment.

**Interfaces:**
- Consumes: `dieName`, `dieFrom`, `dieFacts`, `dieSize` (Task 2); the response shape (Task 3).

- [ ] **Step 1:** `DieCheck` defaults `reordered` to `[]` on both lists. Register exact line:
      `<b>{dieName(d)}</b> is this size · {[...dieFacts(d), dieFrom(d)].join(' · ')}. Check it is still in the rack.`
      New amber line when any reordered: `<b>Same numbers, written another way</b> — check it opens the same way:`
      then Die Master `die {code} {size}` and register `{dieName(d)} {dieSize(d)}` items, at most 6, then `+ {n} more`.
      Close dies: register items `{dieName(d)} {dieSize(d)}` + facts in brackets, `(another order)` when `other_order`.
      No-die sentence: `No die of this size or within 3 mm, in any order, in the Die Master or the die list — a new die is needed.`
- [ ] **Step 2: Run** `npm run build -w client` — Expected: build OK.
- [ ] **Step 3: See it:** render `DieCheck` with invented dies (exact with job / without job / Drive die, two
      reordered, near with `other_order`) on a TEMP-VERIFY page, screenshot, then delete the page.
- [ ] **Step 4:** `git status --short` shows only `SizeProposals.jsx` changed by this task (TEMP page gone).

### Task 5: Production job-number fill, prepared (not applied)

**Files (outside the repo):** `~/Documents/Projects/Colour Imp Production/die-register-job-no-2026-11-15/`
`dryrun.sql`, `apply.sql`, `undo.sql`, `jobs.json`; generator in the session scratchpad.

- [ ] **Step 1:** Generate rows: register `die_no` = aligned 2021-sheet job (1,021), `J…` rows = own number (181).
- [ ] **Step 2:** `dryrun.sql` (read-only, works before the column exists): per source, rows found by `die_no`,
      rows whose `size_text` differs from the sheet's size, missing die_nos. Run it on `ylbfeptgefzimcqnwphy` —
      Expected: 1,202 found, 0 size differences, 0 missing.
- [ ] **Step 3:** `apply.sql` = one `UPDATE … FROM (VALUES …) WHERE job_no IS NULL` returning counts by source;
      `undo.sql` = `job_no = NULL` for exactly those die_nos. Not run.

### Task 6: Whole check

- [ ] `cd server && node --test src/*.test.js` — Expected: all pass except any failures already on `origin/main`
      (compare by running the same files on a clean `origin/main` checkout if any fail).
- [ ] `cd server && SIZING_PG=1 node --test src/sizing-pg.test.js` — PASS.
- [ ] `npm run build -w client` — OK; `node scripts/build-baseline.mjs --check` — OK.
- [ ] `git status --short` — only the files named in Tasks 1–4 plus the spec and plan.

## After the final review (15 Nov 2026)

- Test sizes are invented and checked against every real die size (none matches in any order); the new tests had used
  real sizes (one decimal die, and the 90 × 80 × 65 family), now replaced. Seed R-55 (on main since 12 Nov) stays.
- `splitReordered` is replaced by `dieMasterMatches`: on this screen the Die Master follows the die list's rule (exact /
  another order / within 3 mm either order), so hiding the `DM-` copies loses nothing; `matchDies` is unchanged.
- `registerMatches` reads `to_jsonb(d) ->> 'job_no'`, so the size check works before the migration reaches a database
  (new sizing-pg test drops the column and asks again).
- `listed`, `masterItem`, `listItem` (`LISTED = 6`) live in `client/src/lib/die-check.js`, unit-tested.
