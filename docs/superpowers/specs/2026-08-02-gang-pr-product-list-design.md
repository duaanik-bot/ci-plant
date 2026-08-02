# A requisition names the jobs it is buying for

**Status:** built

## The problem

CI-PR-0006 asks a buyer to commit 7,525 sheets of Duplex WB 300 GSM. The modal
tells them the board, the quantity, and one line of prose:

> Combined shortage for gang CI-GANG-0007 (2 jobs on Duplex WB · 300 GSM · 23x38)

Two jobs — but not *which* two. The buyer approving the spend cannot see what the
board is for, whose order it serves, or when it is due, without leaving the screen
and reconstructing the gang from Planning. A combined requisition is the one PR
shape where that context is not optional: it is the only thing explaining why the
quantity is what it is.

## What it does

The PR modal gains a jobs table under the board line — **Products in this gang**
for a combined requisition, **This requisition is for** when it buys for a single
job. One shape, because the buyer's question is the same either way. Per job:

| Column | Source |
|---|---|
| Product | `products.name`, with the internal code beneath |
| Customer / PO | `customers.name` · `orders.po_number` |
| Deliver by | `orders.delivery_date` |
| Pcs | `order_lines.qty` |
| Sheets | this job's share of THIS requisition |

Footer restates the whole. A gang splits by need; a lone job carries all of it,
so its Sheets column ties out to the board row directly above.

A requisition naming no job at all — a plain stock top-up, or a legacy row raised
before the anchor existed — shows no table. Not an empty one: none.

## Sheets per job

The share comes from `splitGangQty()` — the same pure function that decides what
`syncPrAllocation` books into `board_allocations`. Display and ledger cannot drift
because they are one rule: proportional to each member's parent-sheet need, whole
sheets, largest member absorbing the rounding remainder so the parts sum to the
requisition exactly (3,763 + 3,762 = 7,525).

Members whose plan is not locked yet have no stated need, and share equally. That
is already covered by `splitGangQty`'s own tests.

## Finding the jobs

1. `pr.order_line_id → order_lines.gang_run_id`. If it names a gang, every member.
2. No gang but an anchor line — that one job.
3. No anchor at all — fall back to the gang number in `reason`, for rows raised
   before the anchor existed. CI-PR-0010 on live is exactly this shape.
4. Nothing matches — no table.

The trailing space in `'Combined shortage for gang ' || gang_number || ' %'`
matters: without it CI-GANG-0001 would also match CI-GANG-00010 the day the series
passes four digits.

## Also fixed

`status_reason` renders under a hardcoded `Closed:` label, so a **pending** PR
carrying a note reads "Closed: Re-opened: …" — which is what CI-PR-0006 shows
today. The label now follows the row's actual status.

## Out of scope

Per-job production status and job-card number (the buyer's view was chosen over
the fuller one). No change to how the split is stored — this is display only, one
read endpoint and one panel.
