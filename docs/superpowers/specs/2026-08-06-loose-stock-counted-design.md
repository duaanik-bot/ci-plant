# Loose board stock — counted, not inferred

2026-08-06 · decided with Anik · follow-up to `2026-08-06-packet-suggestion-design.md`

## Why

The packet suggestion panel shipped on `main@57c6242` **derives** loose stock rather
than tracking it, because this system stores board as a sheet count only —
`stock_batches.qty` — and packets are a display conversion. Derivation is per
batch, then summed: `loose = Σ(qty mod P)`, `intact = Σ⌊qty ÷ P⌋`.

That is correct only while each batch holds at most one opened packet. It errs
toward suggesting a packet rather than promising loose sheets that are not
there, which is the safe direction, but it is still a guess. This makes it a
count.

## The one fact that shaped the design

**The whole gap is one integer.**

Loose sheets are the ones not in a sealed packet, so `qty − loose = intact × P`,
and therefore

```
loose ≡ qty  (mod P)
```

is **definitional, not an accident**. Today's derivation returns `qty mod P`,
which is the *smallest* value satisfying that congruence. The truth is always
`(qty mod P) + k·P` for some `k ≥ 0`.

So the system already knows loose exactly, modulo the packet size. The only
unknown is **`k`** — how many whole packets' worth of loose sheets are sitting
on the stack. "Counted vs derived" is really "we know k" vs "we assumed k = 0".

Two consequences run through the whole design:

- A confirmed figure can be **validated**: any counted loose that violates the
  congruence is provably wrong, no judgement required.
- Every legitimate movement **preserves** it. An issue of 910 against P=100
  takes 60 loose and opens 9 packets, so `Δqty = −910` and `Δloose = −10`, and
  `−910 ≡ −10 (mod 100)`. A refund of 47 moves both by 47. A GRN of 50 packets
  moves qty by 5,000 and loose by 0. The invariant is a free correctness check
  on every write path.

### Why `k` drifts above zero

`adjustBoardStock` with a negative delta — the cutting **under-cut** refund —
credits board back into the *newest* batch (`helpers.js`), and those sheets are
loose by definition: they came out of a bundle somebody opened. Today they land
in `qty` with no loose signal. A pile at 3,150 (50 loose, 31 intact) taking a
47-sheet return reads as 3,197 → 97 loose, when the shelf holds 97 loose in two
separate part-piles. Add a second return and `k` reaches 1 and the derivation
starts understating.

## Measured on prod, 2026-08-06

| | |
|---|---|
| Available board batches | 108, across 96 materials |
| Materials with exactly **one** available batch | **85** of 96 (10 have two, 1 has three) |
| Batches carrying a remainder | 23 → **1,119** derived loose sheets |
| Batches that have taken **more than one** positive adjustment | **13** |
| Positive board adjustments | 63 opening import · 42 recount · 14 cutting return/variance · 5 manual · 1 write-on |
| Packet size coverage | 100 × 219 · 144 × 108 · 150 × 1 · **none × 4** |

Two of these reshaped the design:

- **A batch is not a sub-pile — it is the board's whole shelf position.** With
  85 of 96 materials on a single batch, "per batch, then summed" is, for 89% of
  boards, simply "on the total" — the exact case the previous spec identified as
  wrong. The failure mode is not an edge case.
- **13 batches have already absorbed more than one addition**, so the drift is
  live, not theoretical.

## Decisions taken (Anik, 2026-08-06)

1. **Loose is an attribute of the pile, not a pile of its own.** Sealed packets
   and loose sheets share one stack — the storeman puts the leftover back on
   top. So: a column on `stock_batches`, not a separate loose batch per
   material. The data model mirrors the shelf.
2. **The warehouse confirms it at issue** — one pre-filled number, "packets
   opened", on the path that already issues the board. Not a periodic count:
   `scripts/import-rm-stock.mjs` records that *"the plant counts board in
   packets, never loose sheets"*, so a count sheet cannot see loose at all.
3. **Sheets a job hands back become loose automatically** — no new field on the
   cutting-variance form. Those sheets came out of an opened bundle, so it is a
   fact rather than a judgement, and it closes the drift in decision 2's own
   feedback loop.
4. **Entry point delegated to me; taking the Start path** (see *Surface*).

## Data model

```sql
ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS loose_sheets DOUBLE PRECISION;
ALTER TABLE stock_batches ADD CONSTRAINT stock_batches_loose_sheets_check
  CHECK (loose_sheets IS NULL OR loose_sheets >= 0);
```

`DOUBLE PRECISION` to match `qty`, so `qty − loose_sheets` needs no cast.

**NULL means never counted, and that is the point of it being nullable.**
`NOT NULL DEFAULT 0` would have every batch read *zero loose* on migration day —
worse than today, which finds 1,119 sheets across 23 batches, and it would read
as counted. NULL keeps `packetPlan` deriving for that pile and keeps the panel's
"derived" label honest.

**No backfill.** Writing the derived remainder into the column would launder the
`k = 0` guess into a counted number, which is the thing this work exists to
stop. Piles become counted when board is next issued off them, or when the
warehouse recounts.

**Deliberately no `loose_sheets <= qty` CHECK.** A two-column CHECK looks
tighter but is a trap: `consumeFifo` issues a bare `UPDATE stock_batches SET
qty=…`, so a stale loose figure would abort that transaction and **hard-block a
machine start over a bookkeeping number**. That inverts the house rule —
physics hard, paperwork soft. The ceiling is clamped in code, where it can flag
instead of refuse.

`server/src/db.js` gets the same `ADD COLUMN IF NOT EXISTS`: init() and the
migration files are separate paths and a fresh local DB never runs the
migrations.

## The write path

One pure function, in the module that already owns packet arithmetic and is
already twinned — `server/src/packet-plan.js` ↔ `client/src/lib/packetPlan.js`:

```js
looseAfter({ looseBefore, packetSize, issued, packetsOpened })
  →  looseBefore + packetsOpened·P − issued
```

`packetsOpened = null` means nobody confirmed, so it derives
`⌈(issued − looseBefore) ÷ P⌉` — the same rule `issueOption` already shows on
the panel. **Confirmed and unconfirmed paths run the identical function**, which
is what stops the two drifting into different answers for the same shelf.

| Path | `qty` | `loose_sheets` |
|---|---|---|
| `consumeFifo` draw — board issued at cutting start | −take | `looseAfter(…)`, confirmation applied to the named batch |
| `issueWithWriteOn` real takes | −take | same |
| `issueWithWriteOn` write-on batch | +n, then 0 | 0 — created and exhausted in the same breath |
| `adjustBoardStock` **negative** — under-cut return | +refund | **+refund**, all of it |
| `adjustBoardStock` **positive** — over-cut | via `issueWithWriteOn` | implied rule, no prompt |
| GRN — new batch | +received | `received mod P` |
| Stocktake / recount adjustment | ±delta | unchanged — whole packets by construction |
| Inventory recount | — | set absolutely |

### The opening balance is derived, and the spec says so

The first time board is issued off a never-counted pile, `looseBefore` is seeded
from `qty mod P` — the `k = 0` lower bound — and the pile is a ledger from then
on.

This is exactly how `qty` itself works: it began at an opening physical count
and has been a ledger ever since. Seeding low is the safe direction — it
*under*-states loose, which suggests a packet break that may not be needed,
which is today's behaviour — and the Inventory recount is how `k` gets
corrected, the same way a stocktake corrects `qty`.

### Two rules that keep it out of the machine's way

- **Clamped, never thrown.** `loose = min(max(0, computed), floor(qtyAfter))`.
  If the clamp bites, that fact goes in the `stock_movements` note. A
  bookkeeping number must never refuse a stage start.
- **Multi-batch draws.** A confirmation applies to the batch it names; any
  further batch the FIFO fall-through touches uses the implied rule. With 85 of
  96 materials on a single batch this is the rare path, and it degrades to
  today's behaviour rather than to a wrong number.

### GRN is the one place a fresh pile may be born counted

A receipt is unambiguous — vendors ship sealed packets, so a fractional receipt
is one broken packet — where an aged pile that has absorbed returns is not.
`loose_sheets = received mod P` at insert, no UI. This also keeps the congruence
intact when stock arrives, which a NULL would not.

## The read path

`packetPlan` stops deriving and starts preferring, per lot:

```
looseOf(lot) = lot.loose_sheets ?? (⌊lot.qty⌋ mod P)
intact       = ⌊(⌊qty⌋ − looseOf(lot)) ÷ P⌋
```

One new field on the return value, `loose_source: 'counted' | 'derived' |
'mixed'`, so the panel can label the figure rather than asserting it.

**Callers that pass no `loose_sheets` get byte-identical output.** The existing
19 tests in `packet-plan.test.js` must pass untouched — that is the regression
check on this whole change.

### The impossible-count guard

Because the congruence is definitional, a counted figure violating it is
provably wrong. Snap **down** to the largest congruent value at or below it, and
set `suspect: true` on the returned plan — true when **any** lot's counted
figure had to be snapped — so the panel can ask for a recount.

Down, never up: rounding up would promise sheets that are not on the shelf,
which is the one direction the original design was careful to avoid. A counted
150 against a shelf whose total says `loose ≡ 30 (mod 100)` becomes 130, not
230.

## Surface

Three touches, and deliberately **not** a change to `BoardIssue`'s render gate.
That component's three-state fail-closed fetch guards a machine start; a
bookkeeping field does not belong inside that risk, and its gate reaches only
jobs with a planned mix (11 rows on prod).

- A small shared **"packets opened"** control, pre-filled from `packetPlan`'s
  recommended option. Rendered inside `BoardIssue`'s rows where a mix exists,
  and standalone in the same start modal where it does not. **Start stays one
  tap** — leaving the field alone accepts the computed figure, which is today's
  behaviour plus a record.
- `PacketAdvice.jsx` labels the loose figure counted / derived / part-counted,
  and shows the recount nudge when `suspect`.
- `Inventory.jsx` gains a loose column and the recount field, **per batch** —
  the column lives on the batch, and a material's two piles can differ. This is
  the deliberate, rare correction of `k`.

Gang and merge run cards take the implied rule with no field, matching where the
packet advice itself already sits: on the run panel against the combined
requirement, not per member, because the run draws one pile for every member.

The 4 boards with no `sheets_per_packet` keep degrading to *"no packet size on
this board master"*. `packetPlan` still returns null for them, and no loose is
written against a board whose packet size is unknown — there is no `P` to be
congruent to.

## Verification

- Twin parity on `looseAfter`, the convention `packet-plan.test.js` already runs
  for `packetPlan`.
- The congruence `loose ≡ qty (mod P)` preserved across every movement type in
  the table above.
- `counted ≥ derived` always, since counted is `derived + k·P` with `k ≥ 0`.
- The snap-down guard, including that it never rounds up.
- NULL loose producing today's exact output — the existing 19 tests, unchanged.
- Server tests on the three write paths: issue, under-cut return, GRN.

## Rollout

Migration **0033**, re-checked against `git ls-tree origin/main
supabase/migrations/` at write time because migration numbers race between
sessions.

**Migration to prod first, code push second.** The column is additive and
nullable, so the running app ignores it and the new code needs it; that ordering
is safe in both directions and leaves no window where prod runs code against a
column it lacks.

## Out of scope

- Printing the loose figure on the job card traveler.
- Changing what a job is issued or consumes. The cutting gate is untouched and
  stays zero-tolerance.
- Per-member confirmation on gang runs.
- Correcting the 1,119 sheets already on the shelf. They stay derived until each
  pile is next issued off or recounted.
