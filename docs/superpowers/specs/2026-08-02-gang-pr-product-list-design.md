# A gang's requisition names the jobs it is buying for

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

The PR modal gains a **Products in this gang** table, under the board line and
only for requisitions raised from a gang. Per member, the buyer's view:

| Column | Source |
|---|---|
| Product | `products.name`, with the internal code beneath |
| Customer / PO | `customers.name` · `orders.po_number` |
| Deliver by | `orders.delivery_date` |
| Pcs | `order_lines.qty` |
| Sheets | this job's share of THIS requisition |

Footer restates the whole: `2 jobs · 7,525 sheets`.

Non-gang requisitions are untouched — no empty table, no extra call.

## Sheets per job

The share comes from `splitGangQty()` — the same pure function that decides what
`syncPrAllocation` books into `board_allocations`. Display and ledger cannot drift
because they are one rule: proportional to each member's parent-sheet need, whole
sheets, largest member absorbing the rounding remainder so the parts sum to the
requisition exactly (3,763 + 3,762 = 7,525).

Members whose plan is not locked yet have no stated need, and share equally. That
is already covered by `splitGangQty`'s own tests.

## Finding the gang

1. `pr.order_line_id → order_lines.gang_run_id`. Every requisition raised by the
   fixed code carries this anchor.
2. Fall back to the gang number in `reason`, for rows raised before the anchor
   existed. CI-PR-0010 on live is exactly this shape.

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
