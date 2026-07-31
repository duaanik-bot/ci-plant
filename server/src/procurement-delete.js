// Procurement row-level delete — what a Delete on a PR / PO / GRN really costs.
//
// Every procurement row can be deleted, but the chain behind it has to be
// unwound in order: a PR sits under a PO, a PO sits under its GRNs, and a GRN
// sits under a stock batch that production may already have eaten into. The
// route layer does the unwinding; this module decides, from plain rows, what
// the unwind WOULD remove and whether anything makes it impossible.
//
// The single hard rule: stock that has already been issued to a job is never
// silently reversed. Deleting the receipt that justified it would drop the
// board out of the warehouse while the job that used it stays on the floor —
// the plant's stock and its job history would disagree, permanently. Anything
// else (a PO in the way, a PR marked converted, an accepted-but-untouched GRN)
// is just sequencing, and the server does it for you.

const n = v => Number(v || 0).toLocaleString('en-IN');

// A GRN can be reversed only while its batch is exactly as it was received.
// Two independent signals, because either one alone can miss a case: the batch
// balance moving off initial_qty catches consumption recorded as a quantity
// change, and a consuming ledger row catches a movement that left the balance
// intact (a same-quantity correction, a dispatch that was later credited back).
export function grnReversal(grn, batch, consumingMovements = 0) {
  const unit = grn.unit || 'units';
  if (!batch) return { grn_number: grn.grn_number, reversible: true, consumed: 0 };

  const initial = Number(batch.initial_qty ?? 0);
  const left = Number(batch.qty ?? 0);
  const consumed = Math.max(0, initial - left);

  if (consumed > 0) {
    return {
      grn_number: grn.grn_number, reversible: false, consumed,
      reason: `${grn.grn_number} — ${n(consumed)} of ${n(initial)} ${unit} already issued to production`,
    };
  }
  if (consumingMovements > 0) {
    return {
      grn_number: grn.grn_number, reversible: false, consumed: 0,
      reason: `${grn.grn_number} — its stock has already been used by a job`,
    };
  }
  return { grn_number: grn.grn_number, reversible: true, consumed: 0 };
}

// What deleting this row removes, and what stops it.
//
// `cascade` is the plain-English list the confirm dialog shows before anything
// is touched. `hard_blockers` being non-empty means the delete is refused —
// the UI still offers the button, but explains precisely which receipt is
// pinned and by how much, so the answer is never just "cannot delete".
//
// Shape expected by callers:
//   entity : 'requisition' | 'purchase_order' | 'grn'
//   pr     : { pr_number } | null           — the requisition being removed
//   po     : { po_number } | null           — the PO in the chain, if any
//   poLines: [{ qty }]                      — lines that go with that PO
//   grns   : [{ grn_number, qty, unit, batch, consuming_movements }]
//   sourcePrs: [{ pr_number }]              — PRs that return to 'approved'
export function planProcurementDelete({
  entity, pr = null, po = null, poLines = [], grns = [], sourcePrs = [],
} = {}) {
  const cascade = [];
  const hard_blockers = [];

  // Receipts are reversed first and block hardest, whichever row was clicked.
  const reversals = grns.map(g => grnReversal(g, g.batch, g.consuming_movements));
  for (const r of reversals) if (!r.reversible) hard_blockers.push(r.reason);

  for (const g of grns) {
    const back = g.batch ? ` — returns ${n(g.batch.initial_qty ?? g.qty)} ${g.unit || 'units'} to the warehouse` : '';
    cascade.push(`Reverses receipt ${g.grn_number}${back}`);
  }

  if (entity === 'grn') {
    // A GRN against a PO reopens that line's balance rather than touching the PO.
    if (po) cascade.push(`Reopens the balance on ${po.po_number}`);
  }

  if (entity === 'purchase_order' || entity === 'requisition') {
    if (po) {
      cascade.push(`Removes ${po.po_number}${poLines.length ? ` and its ${poLines.length} line${poLines.length > 1 ? 's' : ''}` : ''}`);
      for (const s of sourcePrs) {
        // A PR the user did not click is never destroyed as a side effect — it
        // goes back to the approved queue so the demand survives the delete.
        if (!pr || s.pr_number !== pr.pr_number) {
          cascade.push(`Returns ${s.pr_number} to the approved queue`);
        }
      }
    }
  }

  if (entity === 'requisition' && pr) {
    cascade.push(`Removes requisition ${pr.pr_number} and its lines`);
  }

  return { cascade, hard_blockers, reversals };
}
