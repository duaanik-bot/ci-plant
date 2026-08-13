# PO quantity consolidation — one line per board

**Date:** 2026-08-13
**Branch:** `feat/po-qty-consolidation` off `origin/main@1bd5f25`

## The ask

When several purchase requisitions call for the same board, the purchase order should
carry one line for that board with the quantities added up — not one line per
requisition. Requisitions themselves do not change: they are raised independently by
different modules and users, and they stay exactly as raised.

    PRs                       PO
    A   20 packets            A   30 packets
    B   10 packets     →      B   10 packets
    A   10 packets

## What already worked, and what did not

`origin/main@1bd5f25`:

| Path | Route | Consolidated? |
|---|---|---|
| Multi-select PRs → one PO | `POST /purchase-orders/from-requisitions` | Yes — client groups by `material_id` and shows a "From PRs" column; server re-groups in `byMaterial` |
| Single PR → PO ("Convert") | `POST /requisitions/:id/convert` | **No** — every `requisition_line` became a PO line 1:1 |
| Direct PO | `POST /purchase-orders` | **No** |
| Edit PO | `PUT /purchase-orders/:id` | No — and stays that way, see Non-goals |

A requisition is multi-line (`requisition_lines`), so one PR can name the same board
twice. Converting it produced two PO lines for one board. That is the gap.

## The rule

A pure `consolidate(lines)` groups by `material_id`, sums `qty`, and returns one row
per material carrying `sources` — the input lines that fed it.

It lives once, in `server/src/po-consolidate.js`, with a twin at
`client/src/lib/poConsolidate.js` (the repo convention: `board-math.js`/`boardMath.js`,
`packet-plan.js`/`packetPlan.js`). A twin has misled before — the client plate-rate
twin mispriced against its server original — so a parity test feeds identical fixtures
to both and asserts identical output.

### Rate

Consolidation touches the rate **only when a merge actually happens**:

- material appears once → today's resolution, untouched. On convert the PR's
  `est_rate` still wins; on a direct PO the buyer's typed rate still wins.
- material appears more than once →
  - **convert**: the vendor/master-resolved rate (`resolvePoRate`). Two PR estimates
    that disagree cannot both be right, and the rate master is the tie-break the
    plant already trusts.
  - **direct PO**: the first (top-most) line's rate, with the conflict named in the
    confirmation so the buyer sees which number won and which lost.

The narrowness is deliberate. `/requisitions/:id/convert` prefers `est_rate` on every
line today; switching that wholesale would silently reprice every single-line
conversion in the plant. Out of scope, so it does not happen.

### Quantity

`qty` sums within a material. Grouping by `material_id` means every summed line shares
one unit by construction — there is no unit conversion to get wrong.

## Per path

**Convert (single PR → PO).** Server runs `consolidate()` over the derived lines.
Client `openConvert` runs the twin, so the form opens already showing one row per
board, tagged `merged from 2 requisition lines`.

**Direct PO.** Server consolidates defensively — the route is the door and other
callers reach it. The client shows a confirmation before the PO goes through:

> PGB 300 GSM 28×40 — 2 lines → 1 line, **30 packets** at ₹45.00 *(line 1; line 3 had ₹47.00)*

Cancel returns to the form to fix it; confirm creates the merged PO. Merging on save
rather than while the buyer types keeps rows from vanishing under the cursor
mid-entry.

**Bulk (multi-PR).** Behaviour unchanged; refactored onto the shared helper so all
three paths read one rule instead of three spellings of it.

## Traceability

Derived, not stored. `GET /purchase-orders/:id` returns `source_prs` per line: join
`requisitions` (where `purchase_order_id = po.id`) → `requisition_lines` on the line's
`material_id`, giving each contributing PR number and the quantity it put in
(`CI-PR-0041: 20`, `CI-PR-0043: 10`).

Both conversion paths already set `requisitions.purchase_order_id`, so the link is
present on every PR-sourced PO written to date — including ones created before this
change. Deriving means no live Supabase migration, no backfill, and no second copy of
the truth to drift away from the rows the PR module owns.

A direct PO has no requisitions behind it and returns an empty list, which is the
honest answer.

## Non-goals

- PR generation, approval, and the `requisitions` / `requisition_lines` tables.
- `PUT /purchase-orders/:id` (Edit PO). A line that has goods received against it is
  locked and has GRNs pointing at its `po_line_id`; merging under those is how you
  strand receipt records.
- Merging across materials that are "the same board" under two `material_id`s. That
  is a master-data problem and is not fixed here.

## Tests

`server/src/po-consolidate.test.js`

- A/B/A → A = 30, B = 10, in first-appearance order
- a material appearing once keeps its incoming rate exactly
- a merged material takes the resolved rate, not either estimate
- `sources` quantities sum back to the merged `qty`
- an empty list, and a single line, both pass through untouched

`server/src/po-consolidate-parity.test.js`

- identical fixtures through `server/src/po-consolidate.js` and
  `client/src/lib/poConsolidate.js` produce identical output
