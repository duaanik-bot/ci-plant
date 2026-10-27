# Idle job cards load on demand — Job Cards register + Live Floor

Status: planned 2026-10-17, building locally on `perf/idle-cards`. No commit, no deploy.

## Why

On live prod, the Job Cards register's live half (`/job-cards?scope=live`) went from 601 KB / 251 ms on
2026-09-18 to 1,071 KB / 604–781 ms. The Live Floor (`/floor?lights=ref`) went from 711 KB / 218–308 ms to
1,044 KB / about 510 ms. Live Floor refetches every 30 s and on every realtime ping.

Both endpoints send every live card. Live job cards doubled, from 129 (09-20) to 277 (10-17), and 111 of
them have had no activity for 14+ days.

## Planning is left out, on purpose

Planning's default tab (`?scope=queue`) holds order lines that are not yet on a job card. It holds no job
cards. 99 of its 207 lines were entered this week, and only 27 are older than 30 days. Hiding old lines
there would hide the planner's own to-do list and save little. Planning's growth comes from real new
orders. Its fix is a separate job: slim the 119-column row.

## The idle rule — one spelling, `server/src/idle-cards.js`

A live card (`open` or `in_progress`) is **idle** when all of these hold:

1. Its last activity is at least `IDLE_DAYS = 14` days ago. Last activity is the greatest of:
   - card `created_at` and `finalised_at`;
   - every stage's `started_at`, `completed_at` and `inspected_at`;
   - every day-wise count (`stage_runs.created_at`).
2. None of its stages is `in_progress`, `partially_completed` or `hold`. Anything on a machine or on hold
   stays visible however old it is.
3. **The run rule:** for a gang or combined card, every other live card of the same `gang_run_id` is
   idle too. Board and plate verdicts collapse a run to its weakest member over the set they are given,
   so a run is never split between the two halves. This is the same reason `planning-scope.js` splits by
   run.

SQL returns one row per live card: `{id, gang_run_id, last_at, working}`. A pure JS function decides
idleness, so the rule is unit-tested without a database. Prototype on live data: 277 live, 111 idle.

## API — opt-in, old bundles get byte-identical answers

Plant tablets run old bundles for days, so the new behaviour applies only when the new parameter is sent.

- `GET /job-cards?scope=live&idle=hide`
  - Idle cards are dropped before the stages query, the readiness pass and the board/plate stamping.
  - Rung counts are still counted over every card, so the tab badges do not change.
  - The response gains `counts.idle` (a number) and `idle_ids` (an id list). The loader uses `idle_ids`
    to tell "went idle" from "closed".
- `GET /floor?lights=ref&idle=hide`
  - Idle cards are excluded from the stage query.
  - The response gains `idle: { cards, sections: { cutting: n, … } }`.
  - Section counts use the same `frontierState`/`countsTowardBadge` rule as `/floor/counts`.
- No `idle` parameter: the response is exactly today's.

## UI

Job Cards and Live Floor each get a chip, shown only when the count is above zero:
"**N idle 14+ days** · Show".

- Clicking it makes the page poll the full URL (today's request) until clicked off.
- The choice is remembered per browser in `localStorage`, wrapped in try/catch.
- Default: hidden.
- Job Cards: the tab badges keep counting every card. A line under the tabs says how many are hidden, so
  the badge and the list never silently disagree.
- Live Floor: each band shows "+n idle" when it has idle work.

## Tests

- `idle-cards.test.js` covers the pure rule:
  - the age threshold, measured from each timestamp source;
  - a working stage keeps a card active;
  - the run rule, both ways;
  - nulls;
  - a card created today.
- `jobCardRegister('live', deps, {hideIdle})` over the existing fake-query fixture:
  - with no idle cards, the output equals today's;
  - hidden cards never reach the stages query;
  - `counts` are unchanged.
- The floor response is unchanged without `idle`.
- The loader treats `idle_ids` as not closed, so the history is not refetched.
- Each guard must fail first ([[ci-erp-guard-must-fail-first]]).

## Parity on live data (read-only)

Run old and new against the live DB through `live-preview-server.mjs`:

1. Every card in `idle=hide` must be byte-identical to the same card in the full response.
2. `full − hidden` must equal `idle_ids` exactly.
3. Measure KB and ms both ways.
