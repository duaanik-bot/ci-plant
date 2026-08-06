# Intact & loose packet suggestion — planning engine

2026-08-06 · decided with Anik · single-line, gang/merge run, and per board in a mix

## Why

Board is bought, stored and handed over in PACKETS — 100 sheets on 219 boards,
144 on 108, 150 on one — but the plan asks for a raw sheet count. The storeman
bridges that gap in his head, so a job needing 910 sheets gets 10 sealed packets
opened when 60 loose sheets were already sitting on the shelf from a previous
job. Loose stock ages, packets get broken that needn't be, and nobody sees the
spare that comes back.

## The one fact that shaped the design

This system stores board as a **sheet count only**. Packets are a display
conversion and deliberately fractional — `ci-erp-packets-warehouse` records the
reason: *"rounding would invent stock."* Nothing tracks intact vs loose.

So loose is DERIVED, and derived **per batch, then summed**:

```
loose  = Σ (batch.qty mod packetSize)
intact = Σ ⌊batch.qty ÷ packetSize⌋
```

Per batch, not on the total, because each batch is a physical pile and its own
remainder IS its opened packet. Three part-open packets holding 50 each read
correctly as 150 loose / 0 intact, where a remainder-of-the-total would have
said 50 loose / 1 intact.

Measured on prod: of 109 available board batches, 86 divide exactly into packets
and 23 carry a remainder — those 23 are the live loose pool.

The panel labels the figure as derived, so nobody reads it as counted. Real
loose tracking is a sanctioned follow-up, not part of this.

## Decisions taken (Anik, 2026-08-06)

1. **A picking hint only.** The plan's requirement and its issued figure stay at
   910. The suggestion never rounds what the job holds.
2. **Both leading options shown**, planner picks per job.
3. **Derive now**; real loose tracking follows as its own work.

### Why the hint must not change the issued figure

Rounding the issue up to whole packets would hand the job 1,000 sheets for a 910
requirement. Cutting completion then reports 910 cut against 1,000 issued, and
the cutting gate is **zero-tolerance** — every such job would raise a variance
demanding a written reason, and the Cutting Variances register would fill with
noise that means nothing. The spare instead stays on the shelf, which is exactly
where the next job's loose figure comes from: the loop feeds itself with no new
bookkeeping.

## The maths

One pure function, twinned (`client/src/lib/packetPlan.js` ↔
`server/src/packet-plan.js`) so the same numbers can reach a job card later
without a second implementation:

```js
packetPlan({ required, packetSize, lots })
```

Returns `{ packetSize, required, loose_available, intact_available, options[], recommended }`.
Each option carries every figure the panel must show:
`{ key, loose_used, remaining, packets, total_issue, excess }`.

Four options, matching the four choices Anik listed:

| key | rule |
|---|---|
| `clear_loose` | `loose_used = min(loose, required)`, then whole packets for the rest |
| `least_excess` | least excess, then **MOST** loose. Corrected 2026-08-06: this table first said "smallest `loose_used`", which contradicts the objective. `excess(x) = (x − required) mod P` is a sawtooth, so when zero excess is reachable there are several roots a packet apart, all issuing exactly `required`. Taking the LARGEST clears more shelf AND breaks fewer sealed packets — at required 910 with 160 loose it is 110 loose + 8 packets, against 10 loose + 9 packets. Strictly better on both counts. Neither of Anik's examples reaches a second root (loose 60 < 100), so this was a free choice, not a change to anything he stated |
| `packets_only` | `loose_used = 0`, `packets = ⌈required ÷ P⌉` |
| `exact` | issue exactly `required`; the operational override, no packet arithmetic |

`recommended` is `clear_loose` — Anik's Example 2 — because clearing opened
packets is the warehouse objective; `least_excess` sits beside it with its own
totals so the trade is visible rather than decided for him.

Worked, against his own examples:

- **No loose.** 910, P=100, loose 0 → `packets_only`: 10 packets, 1,000 issued,
  90 spare. ✓ his Example 1.
- **Loose 60.** `clear_loose`: 60 loose + 9 packets = 960, 50 spare ✓ his
  Example 2. `least_excess`: 10 loose + 9 packets = 910, 0 spare.

Guards: no packet size, or a packet size ≤ 0 → return null and the panel says
the board master has no packet size rather than assuming 100. `required ≤ 0` →
null. Fractional batch quantities round down into loose, never up, so the
suggestion can never promise a sheet that is not there.

## Where it appears

One component, `client/src/components/PacketAdvice.jsx`, three placements:

- **Single product** — under the cut plan's "N parent sheets to issue".
- **Mixed board** — inside EACH Board Mix row, against that row's own sheets and
  that board's own packet size and lots. This is Anik's "separate
  recommendations for each board allocation".
- **Gang / merge run** — per board on the run panel, against the run's combined
  requirement.

No new server data — but **not for the reason this spec first gave.** Corrected
during implementation:

- `ctx.mix.lots` does carry every batch per board, on both the line context and
  `gangMixContext`. ✓
- Mix CANDIDATES are `SELECT m.*`, so a substitute's `sheets_per_packet` rides
  along. ✓
- **`ctx.board` is NOT a full materials row** — the planning route hand-builds
  it as `{id, name, sheet_l, sheet_w}`, and `boardSel` carries the same four
  fields. Neither has a packet size. The run's context has no board row at all,
  and `MEMBER_VIEW` selects only the board's name and dimensions.

So the PLANNED board's packet size comes from `GET /materials` (`SELECT *`),
which Planning.jsx already fetches for the Board Identity picker — the same
`materials` column, not a substitute figure. A `boardFor(material_id)` resolver
is passed into the panel rather than a field on the rows, because only the
caller's own master list can answer it. Still no new server data.

One correctness point found while wiring: the single-product advice is
suppressed on a line that prints in a GANG, for the same reason BoardMix
refuses a mix there — the run draws one pile for every member, so per-member
advice would have several jobs each proposing to open packets out of the same
pile. The run panel carries it against the combined requirement instead.

## Choosing an option

Selecting one is a planner note, not a stock movement — nothing is issued at
plan time. The chosen key rides on the plan as a hint so the job card and the
warehouse pick see the same intent. Stored in the existing
`order_lines.spec_override` JSON (or the mix row's own record for a per-board
choice) — no DDL, consistent with how this wave has kept every addition.

## Out of scope

- Real loose/intact tracking with a warehouse step — the agreed follow-up.
- Changing what a job is issued or consumes; the cutting gate is untouched.
- Printing the advice on the job card traveler — a natural next step, deliberately
  not bundled.

## Verification

Pure-function tests cover both of Anik's examples exactly, the option
ordering, the multi-part-packet derivation, the missing-packet-size guard, and
the boundary where `required` is an exact multiple of the packet size (using
loose there ADDS excess, so `least_excess` must return zero loose used).
Panel behaviour is checked on a seeded sandbox across all three placements.
