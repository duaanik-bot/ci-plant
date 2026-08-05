# GRN board substitution — receiving the board you actually got

**Date:** 2026-08-06
**Branch:** `grn-board-substitution` off `origin/main` @ 9f31ea7

## The problem

You raise a PR for `2336300FBB` — 100 packets — to cover Nikos 5. The paper mill
delivers `2336290FBB`, 110 packets. Same grade, same 23×36 sheet, one step down
the GSM ladder. This happens constantly and the ERP has no way to say it.

Today `POST /grns` receives strictly against `po_lines.material_id`. The
storekeeper's only options are to lie (book 110 packets of 300gsm that do not
exist in the building) or to go around the system (direct GRN for the 290gsm,
leaving a 300gsm PO open forever and Nikos 5 still reading as short).

## What a substitution is, and what it is not

A substitution is **the same board at a different GSM**: identical grade,
identical sheet size, a different `gsm`. That is the only case handled here.

A different grade or a different sheet size is refused outright. It is not a
substitution — it changes ups, cutting and the whole plan, and it belongs in
Planning. Refusing is a feature: a warning would get clicked through.

The substitute must already exist in the board master. Live data says it
effectively always does — FBB 23×36 alone carries 210/250/280/**290**/**300**/
315/320/340/350, and every grade+size family is a dense ladder. No inline master
creation; if it is genuinely missing, the picker says so and you add it in
Masters → Boards.

Boards are stored in **sheets**. `sheets_per_packet` (100 or 144) never varies
within a grade+size family, verified across the whole master, so packets are a
safe display unit on both sides of a substitution and the form keeps taking
sheets exactly as it does today.

## Flow

In **Create GRN → against a PO**, each line carries a "Received a different
board" control. It opens a picker restricted to that board's own GSM ladder.
Choosing one expands the approval panel:

- **Ordered vs received** — code, GSM, sheets, and the packet equivalent of each.
- **Rate impact** — the board rate is derived (grade ₹/kg × kg/sheet), so a
  lighter sheet is genuinely worth less. The delta is shown, never stored and
  never written back to `po_lines.rate`: the vendor holds that document and the
  buyer settles it on the invoice.
- **Bought for this job** — order lines this PR/PO was buying for, via
  `board_allocations` with `source='requisition'`. Pre-ticked.
- **Other jobs waiting on the ordered board** — every other open line whose
  effective board is the ordered material. Shown, **not** ticked, so the surplus
  can be redirected deliberately rather than by accident.
- **Ineligible rows** greyed with the reason.

## Eligibility

A job can be re-boarded while it is planned, ready, or job-carded **with no
board yet issued or cut against it**. Past that the physical 300gsm is already
on the machine; swapping the record would put the book and the floor into a
disagreement that never reconciles.

## What moves, per ticked job

Atomically, or not at all:

1. `order_lines.spec_override.board_material_id` → the received material.
   This is the effective board (`helpers.js` `EFF_BOARD_ID`); every readiness,
   shortage and floor query resolves through it.
2. Active `board_allocations` rows for that line repointed from ordered →
   received material.
3. An audit row on the order line naming the GRN and both boards.

The receipt books its quarantine batch and ledger row against the **received**
material, like any other GRN.

### Why the allocation repoint is the load-bearing step

`POST /grns/:id/qc` burns the requisition allocation down when stock lands:

```sql
WHERE a.status='active' AND a.source='requisition'
  AND a.material_id=$1 AND rq.purchase_order_id=$2   -- $1 = g.material_id
```

If the GRN carries the 290gsm while the allocation still points at the 300gsm,
**that predicate matches nothing**. The allocation never burns down and the job
is credited twice — once as real stock on the shelf, once as still incoming.
Repointing at substitution time is precisely what lets the QC path stay
untouched. No change is made to QC, by design.

## The honesty rule

An un-ticked job on this PO line, once the receipt closes that line's balance,
is waiting for board that will never arrive. Its requisition allocation is
**released**, and its shortage returns to the Planning panel with a reason
recorded.

If the receipt is short and the PO line stays open, the allocation stands — that
job is still legitimately expecting board.

Nothing in this feature nets a shortage away. A green all-clear over a job that
cannot run is the lie the readiness rules exist to stop.

## PO balance

The substituted receipt consumes the PO line's balance by the sheets actually
received, and the line closes when the balance is met — the existing partial-
receipt arithmetic, unchanged. A short substituted receipt leaves the remainder
open for the rest of the order.

## Schema

Migration `0032_grn_substitution.sql`, mirrored into `db.js`. Two nullable
columns, neither with a `DEFAULT` (a defaulted `ADD COLUMN` backfills every
existing row):

```sql
ALTER TABLE grns ADD COLUMN IF NOT EXISTS
  substituted_for_material_id INTEGER REFERENCES materials(id);
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS
  substituted_to_material_id INTEGER REFERENCES materials(id);
```

`grns.substituted_for_material_id` records what was ordered while `material_id`
records what arrived, so the register reads truthfully from either side.

`requisitions.substituted_to_material_id` exists because `syncPrAllocation`
rebuilds allocations from `pr.material_id`, and `'converted'` is in its open
list — editing that PR afterwards would **resurrect an allocation on the board
you already substituted away**. The helper becomes
`COALESCE(substituted_to_material_id, material_id)`. The PR itself keeps saying
what was actually ordered; the paper trail is not rewritten.

## Code

| File | Role |
|---|---|
| `server/src/grn-substitution.js` | **Pure** — `isSubstitutable`, `packetsOf`, `eligibilityOf`, `planSubstitution({...}) → {ok, blockers, effects}`. No pg, no await. Same idiom as `planMove` in `board-allocation.js`: the dialog renders `effects`, so the preview cannot drift from the commit. |
| `server/src/grn-substitution.test.js` | Unit tests, `node --test`. |
| `server/src/routes/procurement.js` | `GET /grns/substitution-preview`, `POST /grns/substitute`. `/grns`, `/grns/bulk`, `/grns/direct`, `/qc` and rollback untouched. |
| `client/src/components/GrnSubstitutionPanel.jsx` | New file — `Procurement.jsx` is already 1,607 lines. |

## Testing

Pure-module unit tests for substitutability, packet conversion, eligibility, and
every branch of `planSubstitution` including the released-allocation case.

Backend UAT on a **private Postgres on its own port** with an in-process
`app.listen(0)` — not the production database. Its own UAT board pair, product,
order line, PR and PO; run the substitution; assert the effective board moved,
the allocation repointed, the un-ticked job's allocation released, and the QC
burn-down landing on zero; then reverse and delete strictly by the ids created.
