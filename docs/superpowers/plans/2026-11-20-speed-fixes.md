# Speed fixes from the 20 Nov speed test: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Plates screen send about half of what it sends today, and make every API response say where its server time went, so the next fix to Planning and Job Cards is chosen from data instead of guessed.

**Architecture:** Three independent changes on `perf/speed-fixes-nov20`, worktree `~/.config/superpowers/worktrees/ci-erp/speed-fixes-nov20`, cut from `origin/main@7067741e`.
- Task 1 adds a `Server-Timing` header from the per-request ledger that `server/src/data-tables.js` already keeps.
- Tasks 2 and 3 follow the idle-cards precedent. An opt-in query parameter drops rows that are settled history. The answer carries how many were hidden. No parameter gives the legacy answer, so an older bundle still works. The client asks with the parameter and shows a chip that loads the hidden rows on demand.

**Tech Stack:** Node/Express server (`node:test`), React/Vite client, Postgres (Supabase `ylbfeptgefzimcqnwphy`), Vercel `bom1`.

**Spec:** Findings of the 20 Nov speed test (memory `ci-erp-speed-check-2026-10-17-wip-doubled`, section "Speed test 2026-11-20"), plus the measurements made while planning:

| Measured on live data (read-only) | Value |
|---|---|
| `/plates/requirements` | 417 PRs → 3,936 KB raw, **1.31 s** server time |
| PRs with status `returned_to_rack`, card `closed`/`split`, not updated for 14+ days | 135 of 417 |
| PRs with status `ready`, card `closed`/`split`, not updated for 14+ days | 119 more (see the open question) |
| `/plates/warehouse` | 689 rows → 1,633 KB raw, 1.04 s |
| Warehouse rows that are scrapped, lost or damaged | 271 rows, 633 KB (39%) |
| `/job-cards` | 420–660 ms for 407 KB (was 390 ms on 10-27) |
| `/planning` | 270–600 ms for 770 KB (was 224 ms) |
| Station endpoints, first hit | 600–900 ms |
| DB cost of the stage-view queries | 25–66 ms mean. The DB is not the bottleneck; the time goes somewhere unmeasured. |
| Fixed cost of one browser request | ~80 ms |

**Findings that were measured and need no work.** Do not build these:
- **Shell badges.** They load once per app start, not on every page. Six in-app page clicks made 39 calls and zero of them were shell calls.
- **Idle-tab refetches.** These are already answered `304` at 300 B on the wire.
- **The `last_active_at` write.** Already throttled and fire-and-forget (`server/src/auth.js:129`).
- **Orders' 2.2 MB `/products`.** It is a deliberate idle prefetch (`Orders.jsx:418`) and does not delay the table.
- **`/threads/summary` ×6.** It is chunked by design, at 200 ids per URL.

## Global Constraints

- No `git commit`, no `git push`, no deploy, and no migration applied anywhere (project CLAUDE.md). Each task ends with "stop; Anik decides". No migration is needed by this plan.
- Legacy answer unchanged: a GET without the new parameter returns byte-identical JSON to today's answer. Older bundles on plant tablets keep working.
- Never `SET` on the `:6543` pooler (memory `ci-erp-pgbouncer-set-leak`).
- Run tests as `node --test server/src/<file>.test.js`, never `node --test server/src/` (that boots the API).
- Full gate before handing back: `npm run verify`. Known trap: under the `CI ERP FInal` path, 2 section-lean-rows tests fail before the build. Run verify from this worktree, whose path has no spaces.
- Nothing hidden is gone. Every hidden row is one click away. This follows the "no hard blockers, warn" rule.

## Review Focus

1. **A settled PR that still needs action.** A PR on a closed card with a component in `verification_required`, `pr_required` or `replacement_required` must never be hidden. Pinned in Task 2, Step 1.
2. **A realtime wave arriving while "Show settled" is on.** The refetch must keep the hidden rows showing, not snap back to hiding them. Pinned in Task 2, Step 5.
3. **The "Set aside" count before anyone opens it.** The chip must show scrapped + lost + damaged + awaiting from the server count, not 0. Pinned in Task 3, Step 4.
4. **The `Server-Timing` header on a streamed or failed response.** It must never throw and never be set after headers were sent. Pinned in Task 1, Step 1.
5. **An older bundle calling without the parameter.** It must get the identical array. Pinned in Task 2, Step 1 and Task 3, Step 1 (legacy parity).

---

### Task 1: Server-Timing on every API response

**Files:**
- Modify: `server/src/data-tables.js` (`newLedger`, `instrumentQuery`, `ledgerHeaders`, `dataTablesMiddleware`)
- Test: `server/src/data-tables.test.js`

**Interfaces:**
- Produces: the ledger gains `{ dbMs: number, dbCount: number, startedAt: number }`. `ledgerHeaders(ledger, { method, status, now })` additionally returns `'Server-Timing': 'db;dur=<dbMs 1dp>;desc="<dbCount> q", app;dur=<now-startedAt 1dp>'`. The header is on every request that has a ledger, whatever the method or status.

- [ ] **Step 1: Write the failing tests** in `data-tables.test.js`:
  - `test('server-timing sums query time and counts statements')`. Run two instrumented fake queries that resolve after a fake clock advances 30 and 50 ms. Assert `ledger.dbCount === 2` and `ledger.dbMs === 80`. Assert the header matches `/^db;dur=80\.0;desc="2 q", app;dur=\d+\.\d$/`.
  - `test('a failed query still counts its time')`. A rejecting fake query adds to `dbMs`, and `cacheable` stays false as today.
  - `test('server-timing is not set once headers were sent')`. A response with `headersSent=true` gets no `setHeader` call. This is review focus 4.
  - `test('a request with no queries reports db;dur=0.0')`.
- [ ] **Step 2: Run** `node --test server/src/data-tables.test.js`. Expected: the 4 new tests FAIL, the old ones pass.
- [ ] **Step 3: Implement.**
  - Time each promise-returning call in `instrumentQuery` with `performance.now()` from `node:perf_hooks`. Add the elapsed time on settle, success or failure. The callback path does the same inside the bound callback.
  - `dataTablesMiddleware` stamps `startedAt` and passes `now: performance.now()` in its `res.end` hook.
  - Sum, not wall time: parallel queries overlap, so `db` can exceed `app`. That is intended and visible.
- [ ] **Step 4: Run** `node --test server/src/server/src/data-tables.test.js server/src/data-tables-pool.test.js`. Expected: PASS.
- [ ] **Step 5: Check it locally.** Use the read-only live preview: `JWT_SECRET=verify-only-local PORT=4978 node live-preview-server.mjs`, with a token minted per memory `ci-erp-verify-ui-without-a-password`. Then run `curl -sD- -o/dev/null -H "Authorization: Bearer $T" localhost:4978/api/job-cards?scope=live\&idle=hide | grep -i server-timing`. Expected: one `Server-Timing` line. Record `db` and `app` for `/job-cards`, `/planning?scope=queue` and `/floor/coating` in the hand-back note. Whatever `app` minus `db` turns out to be is the next fix's target.
- [ ] **Step 6: Stop.** Do not commit. Anik decides.

### Task 2: Plates PR list hides settled history

**Files:**
- Modify: `server/src/routes/plates.js` (`requirementRows` at :327, route at :566)
- Modify: `client/src/components/PlatesLifecycle.jsx` (`load` at :1437, `reqGroups` at :1503, the requirement view chips at :2432)
- Test: `server/src/plates-settled-pg.test.js` (new, pure-SQL-builder and route tests, styled after `idle-cards.test.js`); client pin in `server/src/plate-lifecycle-wiring.test.js`

**Interfaces:**
- Produces: `GET /plates/requirements?settled=hide` returns `{ rows: Requirement[], settled_hidden: number }`.
  - With no parameter it returns `Requirement[]`, exactly as today.
  - `?settled=only` returns `Requirement[]` of the settled ones.
- Produces: `export const SETTLED_PR_SQL` in `server/src/routes/plates.js`. It is a boolean SQL expression over aliases `tr` and `jc`. It is true when ALL of these hold:
  - `tr.status = 'returned_to_rack'`;
  - `jc.status IN ('closed','split')`;
  - `tr.updated_at < now() - interval '14 days'`;
  - NOT EXISTS a `plate_request_components` row of that request with status in `('verification_required','pr_required','replacement_required')`.

- [ ] **Step 1: Write the failing tests:**
  - `settled=hide drops a returned PR on a closed card idle 14 days`. Create a fixture PR and assert it is absent and `settled_hidden === 1`.
  - `a settled-looking PR with a verification_required component is kept` (review focus 1).
  - `a returned PR on an in_progress card is kept`.
  - `13 days is kept, 14 is hidden`.
  - `no parameter returns the identical array` (review focus 5). Compare `JSON.stringify` of the legacy call before and after the change.
  - `hide ∪ only === legacy, disjoint`. The ids of `settled=hide` rows plus `settled=only` rows equal the legacy ids, with none in both.
- [ ] **Step 2: Run** `node --test server/src/plates-settled-pg.test.js`. Expected: FAIL, because `SETTLED_PR_SQL` is not defined.
- [ ] **Step 3: Implement.**
  - `requirementRows(id = null, { settled = 'all' } = {})` adds `AND NOT (${SETTLED_PR_SQL})` for `'hide'` and `AND (${SETTLED_PR_SQL})` for `'only'`.
  - The route counts the hidden rows with one `SELECT COUNT(*)` over the same `FROM`/`WHERE`.
  - Validate the param: only `hide` and `only` are accepted; anything else means `all`.
- [ ] **Step 4: Run** the Step 1 tests plus `plate-lifecycle.test.js`, `plates.test.js` and `plate-state.test.js`. Expected: PASS.
- [ ] **Step 5: Client.**
  - `load()` asks `/plates/requirements?settled=hide`, unless `showSettledRef.current` is true; then it uses the legacy URL. A realtime wave keeps the reader's choice (review focus 2).
  - Store `settledHidden`.
  - Under the requirement view chips, render `{n} settled PRs (returned, card closed, 14+ days) hidden · Show` when `settledHidden > 0` and the view is `converted`, `ready` or `all`. Clicking it sets the ref and calls `load()`.
  - `counts` and `reqGroups.open` are unaffected, because Step 3's rule never hides a row with an action status.
  - Add a pin in `plate-lifecycle-wiring.test.js` asserting the `?settled=hide` URL and the chip copy.
- [ ] **Step 6: Check it locally** on the read-only live preview and the client dev server.
  - Size: `curl` both URLs. Expected: `?settled=hide` is about 2.6 MB versus 3.9 MB, and `settled_hidden` is about 135.
  - Parity: the hide and only ids together equal the legacy ids.
  - UI: open Tooling › Plates, see the chip, click Show, and the counts match the legacy screen. Screenshot it.
- [ ] **Step 7: Stop.** Do not commit.

### Task 3: Plates Warehouse loads retired plates on demand

**Files:**
- Modify: `server/src/routes/plates.js` (route at :1795)
- Modify: `client/src/components/PlatesLifecycle.jsx` (`load` at :1440, `ASIDE_STATUSES` and `asideRows` at :1583, the "Set aside" chip at :2724)
- Test: `server/src/plate-warehouse-retired-pg.test.js` (new); pin in `plate-lifecycle-wiring.test.js`

**Interfaces:**
- Produces: `GET /plates/warehouse?retired=hide` returns `{ rows: PlateSet[], retired_count: number }`.
  - Retired means `pa.status IN ('scrapped','lost','damaged')`, filtered in SQL before `groupPlateSets`.
  - `?retired=only` returns `PlateSet[]` of retired plates only.
  - With no parameter the route returns the legacy array.
- `retired_count` counts plate sets after grouping, so the chip matches the rows the Aside view will show.

- [ ] **Step 1: Write the failing tests:**
  - `retired=hide leaves no scrapped/lost/damaged set`.
  - `returned_pending_verification stays in hide`.
  - `hide ∪ only === legacy`, compared as sorted JSON.
  - `retired_count equals only.length`.
  - `no parameter is the identical array` (review focus 5).
- [ ] **Step 2: Run** `node --test server/src/plate-warehouse-retired-pg.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the param in the route, with the same validation rule as Task 2.
- [ ] **Step 4: Client.**
  - `load()` asks `?retired=hide` and stores `retiredCount`.
  - The "Set aside" chip count becomes the number of aside rows still loaded (awaiting verification) plus `retiredCount`, so it is right before anyone opens it (review focus 3).
  - Choosing the aside view fetches `?retired=only` once and keeps it in state. The next realtime wave refetches it only while the aside view is open.
  - The warehouse stage count (`status === 'available'`) is unaffected.
  - Add a pin in the wiring test.
- [ ] **Step 5: Check it locally.**
  - Size: about 1.0 MB versus 1.63 MB.
  - The Set aside chip shows the same number as the legacy screen before it is clicked, and the same rows after.
  - Screenshot it.
- [ ] **Step 6: Stop.** Do not commit.

### Task 4: Hand-back

- [ ] **Step 1:** In this worktree, run `npm run verify`. Expected: all server tests pass and the client build succeeds.
- [ ] **Step 2:** Put the Task 1 Step 5 table (db versus app for Job Cards, Planning and coating) in the hand-back. It decides the Planning/Job Cards fix, which is deliberately not in this plan.
- [ ] **Step 3:** Stop. Shipping (commit, push to `main` and the deploy that follows) is Anik's call, said in-session.

## Open question for Anik (default chosen; change before Task 2 if wrong)

119 more Plate PRs sit at `ready` on a closed or split card with no update for 14+ days.
- **Default: they stay visible.** `ready` on a closed card may mean the plates were never returned to the rack, and stores may want to see that.
- **If those are just old history,** add `'ready'` to `SETTLED_PR_SQL`. That hides 254 of 417 instead of 135, so the list drops to about 1.6 MB instead of 2.6 MB.
