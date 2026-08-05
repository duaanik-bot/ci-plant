// Who may retire a purchase requisition, and from which statuses. Shared by the
// board shortage panel (components/ShortagePanel.jsx) and the full PR register
// (pages/Procurement.jsx) — two screens that used to answer this question
// separately and could hand the same user two different answers about the same
// row, one of them offering buttons the server would only 403.
//
// Dependency-free on purpose: this module is loaded by `node --test` through
// server/src/requisition-controls.test.js, and a browser-only or extensionless
// import here would make it unloadable in Node — the suite would die on import
// rather than on a claim.

// Roles allowed to retire a requisition: approve, reject, un-approve, close,
// convert, edit or delete one. Mirrors procurement.js's `canBuy`
// (server/src/routes/procurement.js:63), which every one of those endpoints sits
// behind. Raising is deliberately wider (`canRaisePr`, :69 — planner, production,
// qc): the storekeeper who can see a board is short may say so, and may not undo
// the saying. requireRole (server/src/auth.js:125) lets admin through every gate,
// so it is listed here too.
const CAN_BUY = new Set(['planner', 'admin']);

export function canRetireRequisitions(role) {
  return CAN_BUY.has(role);
}

// Statuses from which the server will still accept a change. DELETE itself has
// no status check beyond "not on a PO" — it would happily delete an approved
// PR. Narrowing UNDOABLE to 'pending' is a deliberate UX choice on top of that,
// not a mirror of a server rule: once a PR is approved, undoing it here would
// unapprove it silently, reverting a decision the planner already made. Close
// accepts pending or approved, so CANCELLABLE follows that gate directly.
//
// The role half of this rule is now one fact in one place — Procurement.jsx's
// row menu gates on canRetireRequisitions above, so both screens agree about
// who. The status half stays deliberately different, and these sets do not
// govern it. The register's Delete is a previewed, cascade-aware, force-capable
// buyer tool: it asks /procurement/delete-preview what the delete would unwind,
// refuses on hard blockers, shows the cascade, then sends `{ force: true }`. It
// is right for it to stay offered at a status a compact inline panel — which
// shows no cascade and cannot refuse anything — should not offer. Its
// un-approve check reads `po_number` alone, which is enough there because GET
// /requisitions COALESCEs the PO joined on purchase_order_id into that column.
// Changing the sets here does not change the register's status conditions.
const UNDOABLE = new Set(['pending']);
const CANCELLABLE = new Set(['pending', 'approved']);

export function prControls({ pr, role } = {}) {
  const none = { undo: false, cancel: false, blockedReason: null };
  if (!pr) return none;

  // DELETE refuses on status==='converted' OR purchase_order_id OR a linked PO
  // row; CLOSE checks only pr.status. The two can't disagree today because
  // procurement.js's convert/revert paths always write status='converted' and
  // purchase_order_id together, and clear both together on revert — but that's
  // a convention upheld elsewhere, not something enforced in this module.
  // Either way, the honest thing here is to say so rather than hide the
  // controls silently. Phrased like procurement.js's own 409.
  const onPo = pr.status === 'converted' || pr.purchase_order_id || pr.po_number;
  if (onPo) {
    return { ...none,
      blockedReason: `${pr.pr_number || 'This requisition'} is on ${pr.po_number || 'a purchase order'} — send that PO back to requisition first` };
  }

  // Already retired. Not an obstacle worth explaining.
  if (!CANCELLABLE.has(pr.status)) return none;
  if (!canRetireRequisitions(role)) return none;

  return { undo: UNDOABLE.has(pr.status), cancel: true, blockedReason: null };
}
