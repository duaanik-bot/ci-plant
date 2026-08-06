# Dispatch shortage — the process model

**Date:** 2026-08-06 · **Status:** built, deployed

Every finished line leaves the plant with a variance. Excess already had a home
(dispatch within tolerance, or bank it as a numbered leftover box). Short did
not — the line simply sat in Ready to Dispatch forever, because there was no
question the screen knew how to ask.

## The one rule everything rests on

> A line is **short** only when production is **over** and it still cannot be filled.

```
        (ordered − dispatched) > finished goods available
                          AND
                  job card status = 'closed'
```

The second half is the whole model. Mid-run *every* line looks short — nothing
has been made yet. Offering "close this line" or "re-plan this" while the batch
is still on the floor would abandon a job that is running. So a line the pool
cannot fill **right now** shows `−N` in the S/E column, but only a line whose
card has **closed** reaches the Shortage chip and gets asked the question.

`server/src/shortage.js` — pure, so the distinction is provable without a
database. `shortage.test.js` asserts an `open` / `in_progress` / `split` card is
never a shortage no matter how large the gap.

## The flow

```
Ready to Dispatch ─────────────────────────────────────────────┐
   every produced line with finished goods on hand             │
                                                               │
   S/E Qty column          ┌── +N excess → dispatch within tolerance,
   −N / +N / even          │              bank the rest as CI-BOX lots
                           │
                           └── −N short ─┐
                                         │  production still running?
                                         │       └── yes → nothing to decide, wait
                                         │
                                         ▼  card closed → [ Shortage ] chip
                                            (a COPY of the row — it stays in
                                             the main list, the chip just
                                             narrows to lines needing a call)
                                                       │
                                   ┌───────────────────┴───────────────────┐
                                   ▼                                       ▼
                          Send to Planning                          Close short
                  line → 'planned', re-enters the         dispatch the finished goods
                  planner's queue. netProduceQty()        that exist, force the line to
                  nets dispatched_qty so the new          'dispatched', accept the gap,
                  job card is raised for the              and complete the sales order
                  BALANCE, not the whole order            if it was the last open line
```

Both decisions require a typed reason and are audited
(`shortage:replan` / `shortage:close`).

## The trap this was built around

`netProduceQty()` was `qty − fg_consumed_qty`. It did **not** subtract what had
already shipped. Sending a short line back to Planning would therefore have
raised a job card for the **full original order**:

> ordered 10,000 · made and shipped 9,000 · short 1,000
> → Planning re-plans **10,000**

A 10× over-production, silently. `netProduceQty()` now nets `dispatched_qty`.
For every other line in the system `dispatched_qty` is 0, so nothing else moves —
but the function is mirrored in `merge-rules.js` (kept local so that module
never imports through `db.js`) and **both were changed together**; they drift
otherwise.

## Selection totals

The bulk bar reads what the selection amounts to on the loading dock: **cartons
going out and the boxes they fill**. Boxes are summed per line from each
product's own packing, never by dividing a total by one box size — a mixed
selection has as many box sizes as it has products, and two of the nine live
products have no box size on record at all.

## What is deliberately NOT here

- **No new status.** A short line closes as `dispatched` (the gap lives in the
  audit trail and in `dispatched_qty` vs `qty`) or returns to `planned`. Adding
  a `short` state would mean teaching every queue, KPI and report about it for
  no gain the audit trail does not already give.
- **No bulk resolve.** Each shortage is a commercial decision about one
  customer's order — closing five POs short in one click is not a convenience,
  it is an accident waiting to happen. The chip gathers them; the decision stays
  per line.
- **No automatic re-plan.** Nothing decides on the plant's behalf.

## Verification

`npm test -w server` — 1392 pass, 0 fail (8 new in `shortage.test.js`, 11 in
`ready-annotate.test.js`). Live today: **0 lines qualify** — all 9 ready lines
have finished goods ≥ what they owe — so this is proved on constructed cases,
not on production data.
