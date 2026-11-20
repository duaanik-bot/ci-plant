# Fewer database round trips on Job Cards, Planning and the stations: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Job Cards' production server time from about 368 ms (and Planning's from 231 ms) by about a third. The way to do it is to stop paying a database round trip per statement, not to make any statement faster.

**Architecture:** Two changes that only pay off together.
1. **Production pool of 3 instead of 1.** Production's pg pool has one connection (`db.js:26`, `PG_POOL_MAX` unset on Vercel), so every `Promise.all` in the API runs one statement after another. Setting `PG_POOL_MAX=3` lets them overlap.
2. **Fewer sequential waves on the shared readiness path.** That path has more one-after-another waves than its data dependencies need:
   - `readinessBatch` makes 5 waves where 2 suffice;
   - `lightForJobCards` makes 3 sequential lookups that are independent of each other;
   - the routes start `stampPlateState` only after board state, although it depends on neither board state nor the readiness gates.

**Tech Stack:** Node/Express on Vercel `bom1`, `pg` pool → Supabase Supavisor, `node:test`.

**Spec (measured 20 Nov 2026, live data, read-only):**

| Fact | Value | Source |
|---|---|---|
| Job Cards on prod | 478 ms total; app 368 ms; 19 statements; db sum 309 ms | Server-Timing in Anik's Chrome |
| Planning on prod | 342 ms total; app 231 ms; 22 statements | Server-Timing |
| Small readiness statements, prod execution time | 0.1–2.2 ms each | `pg_stat_statements` |
| Main queries (stage view, `jc.*`, planning lines), prod execution time | 60–100 ms | `pg_stat_statements` |
| So each small statement costs about 11 ms on prod, nearly all round trip | (309 − ~100) / 18 | derived |
| Job Cards statement waves today | 11 (19 statements) | local trace |
| Planning statement waves today | 15 (22 statements) | local trace |
| Station (coating) statement waves today | 17 (23 statements) | local trace |
| Same local preview, pool 1 → pool 4, app time | Planning 1,083–1,293 → 832–957 ms; Job Cards and Coating within noise | local A/B, 3 runs each |
| DB connections | `max_connections` 60; 30 in use; Supavisor holds 12 | `pg_stat_activity` |

**Expected effect on prod.** With pool 3, a wave costs about one round trip instead of one per statement. The estimates below are not measured.

| Endpoint | Waves after this plan | Estimate |
|---|---|---|
| Job Cards | 19 statements in about 8 waves | about −120 ms of 368 |
| Planning | 22 statements in about 9 waves | about −100 ms of 231 |

- **Code alone, pool still 1:** about 0 ms on prod. The waves still run statement by statement.
- **Pool alone, no code:** about −80 ms on Job Cards, from the existing six-statement `Promise.all`.

Task 4 measures the real numbers.

## Global Constraints

- No `git commit`, `git push`, deploy, or Vercel env change unless Anik says so in the session that does it (project CLAUDE.md). Task 1 Step 4 and Task 4 are gated on that.
- Answers must stay byte-identical for every endpoint touched. This is a pure reordering: the same statements, the same results, the same JSON.
- `readinessBatch(lines, oc, qc)` and `lightForJobCards(cards, oc)` may be called with a transaction's client (one connection). `Promise.all` there must stay correct, which `pg` guarantees by queueing on the client. Never call the module-level `q`/`one` inside them when a client is passed (memory `ci-erp-serverless-pool-one-client-deadlock`).
- Tests: `node --test server/src/<file>.test.js`. The gate is `npm run verify` in this worktree, whose path has no spaces.
- Never `SET` on the `:6543` pooler.

## Review Focus

1. **A `q()`/`one()` escaping a `tx()`.** With pool 1 that is a 10 s deadlock. With pool 3 it silently reads outside the transaction and misses that transaction's own uncommitted writes. Task 1, Step 1 proves there are none today and pins it.
2. **Dependent statements started too early.** The board-mix rows add material ids that wave 2 must fetch: a substitute board's stock (`helpers.js:2805` comment). The parity tests in Task 2 use a fixture where the mix adds a material.
3. **Callers passing a transaction client.** `orders.js:3841` and any `readinessBatch(…, oc, qc)` inside a `tx`: overlapping calls on one client must still return the same ctx. Task 2, Step 4.
4. **The connection budget under concurrency.** Several warm Vercel instances × 3 must stay well under Supavisor's limits. Task 1, Step 3.
5. **A rejected statement inside a `Promise.all`.** It must still reject the request as before, not leave an unhandled rejection. Task 2's error test.

---

### Task 1: Prove no statement escapes a transaction, then choose the pool size

**Files:**
- Create: `server/src/no-pool-escape-in-tx.test.js`
- Create: `docs/perf/2026-11-20-pool-size.md` (the decision record, one page)

**Interfaces:** none produced in code.

- [ ] **Step 1: Write the guard test.** `test('no function that is handed a transaction client calls the module-level q/one')`.
  - Walk `server/src/**/*.js` (not `*.test.js`).
  - For every function whose parameter list names `qc`, `oc` or `client`, extract its body by brace matching, not up to the next `function`. Arrow handlers bleed into each other otherwise.
  - Assert the body has no `await q(`, `await one(`, ` q(\`` or ` one(\``.
  - An allow-list with a reason per entry is permitted only for functions that use `q`/`one` behind an explicit `qc === q` default. The failing message names file:function.
- [ ] **Step 2: Run it.** `node --test server/src/no-pool-escape-in-tx.test.js`.
  - Expected: PASS today. The memory records the two known escapes fixed on 2026-08-10.
  - Then prove it can fail: temporarily add `await one('SELECT 1')` inside `readinessBatch` and see it FAIL naming `helpers.js:readinessBatch`, then remove it. Record both runs in the ledger.
- [ ] **Step 3: Check the connection budget.** Write `docs/perf/2026-11-20-pool-size.md` with:
  - `max_connections` 60, 30 in use, Supavisor 12 (the numbers above);
  - the Supavisor mode and `pool_size` for project `ylbfeptgefzimcqnwphy`, read from Supabase → Database → Connection pooling (Anik reads it; a Claude session cannot);
  - peak concurrent Vercel instances, from Vercel → Observability, or "unknown";
  - the decision `PG_POOL_MAX=3`, with this rule: 3 × peak instances must stay at or below half of Supavisor's client limit.
- [ ] **Step 4 (gated: Anik, out loud):** set `PG_POOL_MAX=3` for Production in Vercel, then redeploy. Shipping is Task 4.

### Task 2: `readinessBatch` in two waves

**Files:**
- Modify: `server/src/helpers.js` (`readinessBatch`, at about :2786–2892)
- Test: `server/src/readiness-batch-waves.test.js` (new)

**Interfaces:**
- Unchanged: `readinessBatch(lines, oc = one, qc = q) → ctx`, the same keys and Map contents.
- New shape:
  - **Wave A:** `Promise.all([products, plateRows, mixAll])`. All three are keyed by `productIds` or `lineIds`, which are known on entry.
  - **Wave B:** `Promise.all([materials, batches, tools, shades, incoming, fg, holdRows])`. All seven are keyed by `materialIds`, `toolIds` and `productIds`, which are complete after Wave A once the mix adds its materials.

- [ ] **Step 1: Write the failing tests** with a fake `qc` that records `{sql head, startedWhileOthersPending}`, resolves on `setImmediate`, and serves fixture rows. The fixture has 2 lines, 2 products and one mix row naming material 77, which is not either product's board.
  - `test('products, plate counts and the board mix start together')`. Assert the three statements start before any of them resolves.
  - `test('allocations start with the other material lookups')`. Assert the `board_allocations` statement starts before the `materials` statement resolves.
  - `test('a material the mix adds is fetched in wave B')`. Material 77 is in the `materials`, `stock_batches`, `incoming` and `board_allocations` params. This is review focus 2.
  - `test('the ctx is identical to the sequential version')`. Copy today's function verbatim into the test file as `sequentialReference`. Run both on the same fixture and `assert.deepEqual` every Map as `[...map]`.
  - `test('a failing statement rejects readinessBatch')`. The fake rejects `tools`, and `readinessBatch` rejects with that error. This is review focus 5.
- [ ] **Step 2: Run.** `node --test server/src/readiness-batch-waves.test.js`. Expected: the first two FAIL (sequential today); parity, mix and error PASS.
- [ ] **Step 3: Implement the two waves.**
  - Keep every SQL string byte-identical, so `pg_stat_statements` and the data-tables ledger see the same statements.
  - `materialIds` is built from `effective` plus `mixAll` before Wave B, exactly as today.
  - The early return `if (!productIds.length) return ctx;` stays first.
- [ ] **Step 4: Run** the new test plus `readiness-light.test.js`, `readiness-station.test.js`, `ready-annotate.test.js`, `planning-payload.test.js` and `job-cards-payload.test.js`. Expected: PASS.
  - Add `test('a single transaction client gives the same ctx')`. A fake client serialises calls (one at a time, FIFO), and the ctx deep-equals the parallel run (review focus 3).
- [ ] **Step 5: Stop.** Do not commit.

### Task 3: The light's three lookups together, and plate state alongside readiness

**Files:**
- Modify: `server/src/readiness-light.js` (`lightForJobCards`, at :276)
- Modify the call sites:
  - `server/src/routes/production.js`: about :581–600 (Job Cards live) and about :1912–1940 (Print Planning);
  - `server/src/routes/floor.js`: about :550–560 and about :1210–1255;
  - `server/src/routes/orders.js`: about :1861–1915 and about :3502–3520.
- Test: `server/src/readiness-light-waves.test.js` (new)

**Interfaces:**
- `lightForJobCards(cards, oc)` is unchanged and returns the same `Map`. Its `cut`, `shade` and `spec` statements start together.
- At each call site, three steps now start together once `anchors` and `cards` are known:
  - `readinessBatch(anchors)`;
  - `lightForJobCards(cards, …)`;
  - `stampPlateState(cards, …)`.
- Then the gates are built, then `stampBoardState`, in that order, because `stampBoardState` needs the gates.
- Safe because `stampPlateState` writes only `plate_state`, `plate_counts`, `plate_wear*` and `plate_wear_replace`, and reads none of the fields the others write. The test pins that.

- [ ] **Step 1: Write the failing tests:**
  - `test('the light's cut, shade and spec lookups start together')`, using the same fake as Task 2.
  - `test('lightForJobCards returns the same map as the sequential version')`, using a verbatim reference copy.
  - `test('stampPlateState touches only plate fields')`. Run it on a fixture row and assert the set of changed keys equals `['plate_counts','plate_state','plate_wear','plate_wear_replace','plate_wear_runs']`.
  - A wiring pin per call site: a regex over each route file asserting `Promise.all([` encloses both `readinessBatch(` (or `readyBatch(`) and `stampPlateState(`.
- [ ] **Step 2: Run.** Expected: the "together" test and the wiring pins FAIL; parity and fields PASS.
- [ ] **Step 3: Implement** with `Promise.all` in `lightForJobCards` and at each call site. Keep the result variable names the code below already reads (`rctx`, `lightExtras`, and so on).
- [ ] **Step 4: Payload parity on live data.**
  - Use the read-only preview with `PG_POOL_MAX=3` (memory `ci-erp-verify-ui-without-a-password`).
  - Fetch these 4 endpoints before the change (main) and after (this branch): `/job-cards?scope=live&idle=hide`, `/planning?scope=queue`, `/floor/coating`, `/print-planning`.
  - Expected: byte-identical bodies.
  - With the statement tracer (`scratchpad/trace-launch.mjs` pattern), record the wave counts. Expected: Job Cards 11 → 8 or fewer, Planning 15 → 9 or fewer, Coating 17 → 11 or fewer.
- [ ] **Step 5: Run `npm run verify`.** Expected: 0 fail, build OK. Stop; do not commit.

### Task 4 (gated: Anik, out loud): Ship and measure

- [ ] **Step 1: Baseline.** Before anything ships, record 5 loads each of Job Cards and Planning on prod, reading `serverTiming` in Chrome: app ms and statement count.
- [ ] **Step 2:** Once Anik says so, make the env change from Task 1 Step 4, then commit, rebase, run `npm run verify`, and `git push origin HEAD:main`.
- [ ] **Step 3: Proof and result.**
  - Proof of deploy: the new statement order shows in the local trace, and production `app` time drops.
  - Repeat Step 1's 5 loads.
  - Put the before/after table in the speed-check memory.
  - If Job Cards `app` is not at least 60 ms lower, say so plainly and do not claim the win.

## Not in this plan (measured, deliberately left)

- **The 60–100 ms main queries.** They need `EXPLAIN (ANALYZE, BUFFERS)` on prod first. That is a separate investigation.
- **Merging several statements into one SQL via `json_agg`.** It would work even with pool 1, but it changes value types (timestamps become strings) inside readiness logic, which is too risky for the size of the gain.
