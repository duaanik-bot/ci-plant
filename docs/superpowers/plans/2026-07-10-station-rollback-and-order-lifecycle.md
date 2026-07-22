# Station Rollback/Delete + Sales-Order Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every production station (Planning, Artwork, Job Card, Print Planning) a *Rollback to Sales Order* and *Delete Entirely* control that safely unwinds all derived work, and give the Sales Orders module a clean five-state lifecycle (Pending / Hold / Completed / Closed / Cancelled) with status tabs.

**Architecture:** One guarded backend endpoint `POST /order-lines/:id/rollback` (`mode: rollback|delete`) does all cleanup inside a transaction, driven by a pure `rollbackBlockers()` guard. Order status changes go through `POST /orders/:id/status` gated by a pure `orderTransitionError()`. The frontend adds a "Danger zone" to the shared `WorkflowControls` (so it appears on every station) and reworks the Orders page tabs + status buttons.

**Tech Stack:** Node/Express + embedded Postgres (`pg`), `node:test` for pure-function unit tests, React + Vite client, Tailwind. Verification of DB-touching behaviour is done in the real running app per project rule (no DB in the test harness).

**Spec:** `docs/superpowers/specs/2026-07-10-station-rollback-and-order-lifecycle-design.md`

**Project rules (override skill defaults):**
- **Do NOT run `git commit`** at any step — all work stays local (skip every "Commit" step; keep the checkboxes but do not commit).
- The app is at `Colour Imp Production/ci-erp` (note the nested folder). All paths below are relative to that repo root.
- Login for manual verification: `admin@ci.local` / `admin123`.

---

## File Structure

- `server/src/db.js` — MODIFY: add a migration block for `orders.status` (new states + default `pending`, migrate `open`→`pending`) and `requisitions.order_line_id`.
- `server/src/helpers.js` — MODIFY: add pure `orderTransitionError()` and `rollbackBlockers()`; add DB helpers `releaseFgReservation()` and `rollbackLine()`.
- `server/src/order-lifecycle.test.js` — CREATE: unit tests for the two pure functions.
- `server/src/routes/orders.js` — MODIFY: add `POST /orders/:id/status` and `POST /order-lines/:id/rollback`; tag `order_line_id` on `raise-pr`.
- `server/src/routes/dispatch.js` — MODIFY: replace hardcoded `'open'` with `'pending'` and guard auto-status against `hold`/`closed`.
- `client/src/components/ui.jsx` — MODIFY: `STATUS_COLOURS` for `hold` and `closed`.
- `client/src/components/WorkflowControls.jsx` — MODIFY: add Danger-zone buttons + blocker modal; export shared `DangerZone`.
- `client/src/pages/Orders.jsx` — MODIFY: five status tabs, rename owed-items tab to "Pendency", add order status action buttons.
- `client/src/pages/PrintPlanning.jsx` — MODIFY: mount the WorkflowControls danger menu on each card.

---

## Task 1: DB migration — order statuses + requisition→line link

**Files:**
- Modify: `server/src/db.js` (insert a new migration block immediately after the block that ends at the `` `); `` on line 659)

- [ ] **Step 1: Add the migration block**

Find the line `` `); `` that closes the migration `pool.query` block (the one that begins `await pool.query(\`` at ~line 483 and ends at ~line 659, right after the `machine_log_entries` / `tool_events` statements). Immediately **after** that closing `` `); `` insert:

```js
  // Sales-order lifecycle: five distinct states (close ≠ cancel), default pending.
  // Legacy 'open' rows migrate to 'pending'. Requisitions raised from a specific
  // order line carry that link so a line rollback can clean up its own PR.
  await pool.query(`
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
UPDATE orders SET status='pending' WHERE status='open';
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending','hold','completed','closed','cancelled'));
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS order_line_id INTEGER REFERENCES order_lines(id);
CREATE INDEX IF NOT EXISTS idx_reqs_order_line ON requisitions(order_line_id);
`);
```

- [ ] **Step 2: Boot the server to run the migration**

Run: `cd "Colour Imp Production/ci-erp" && npm run dev -w server`
Expected: server starts on port 4000 with no SQL error; log shows the embedded Postgres ready. Stop it with Ctrl-C after confirming a clean boot. (If it was already running via `npm run dev`, the migration runs on restart.)

- [ ] **Step 3: Verify the constraint + column exist**

With the server/embedded PG running, in a second shell:
Run: `cd "Colour Imp Production/ci-erp" && node -e "import('./server/src/db.js').then(async d=>{await d.connect?.();const c=await d.q(\"select conname from pg_constraint where conname='orders_status_check'\");const col=await d.q(\"select column_name from information_schema.columns where table_name='requisitions' and column_name='order_line_id'\");console.log('constraint',c.length,'| order_line_id',col.length);process.exit(0)})"`
Expected: prints `constraint 1 | order_line_id 1`. (If `connect` export differs, boot the app normally and instead confirm via the app that creating an order still works — the constraint is proven by Task 8 verification.)

- [ ] **Step 4: Commit** — SKIP (project rule: no commits).

---

## Task 2: Pure guard functions + unit tests (TDD)

**Files:**
- Create: `server/src/order-lifecycle.test.js`
- Modify: `server/src/helpers.js` (add two exported pure functions near the other pure blocks like `finaliseBlock`)

- [ ] **Step 1: Write the failing tests**

Create `server/src/order-lifecycle.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderTransitionError, rollbackBlockers } from './helpers.js';

// ── orderTransitionError ──────────────────────────────────────────────
test('order: pending → hold is allowed', () => {
  assert.equal(orderTransitionError('pending', 'hold', false), null);
});
test('order: pending → completed/closed/cancelled allowed', () => {
  for (const to of ['completed', 'closed', 'cancelled'])
    assert.equal(orderTransitionError('pending', to, false), null);
});
test('order: hold → pending allowed (resume)', () => {
  assert.equal(orderTransitionError('hold', 'pending', false), null);
});
test('order: closed → pending blocked for non-admin', () => {
  assert.match(orderTransitionError('closed', 'pending', false), /admin/i);
});
test('order: closed → pending allowed for admin (reopen)', () => {
  assert.equal(orderTransitionError('closed', 'pending', true), null);
});
test('order: cancelled → completed is never allowed', () => {
  assert.match(orderTransitionError('cancelled', 'completed', true), /cannot/i);
});
test('order: same-status is a no-op error', () => {
  assert.match(orderTransitionError('pending', 'pending', false), /already/i);
});

// ── rollbackBlockers ──────────────────────────────────────────────────
test('rollback: clean line has no blockers', () => {
  assert.deepEqual(rollbackBlockers({}), []);
});
test('rollback: a started stage blocks', () => {
  const out = rollbackBlockers({ stages: [{ stage: 'printing', status: 'in_progress' }] });
  assert.equal(out.length, 1);
  assert.match(out[0], /Printing stage is in progress/);
});
test('rollback: pending stages do NOT block', () => {
  assert.deepEqual(rollbackBlockers({ stages: [{ stage: 'cutting', status: 'pending' }] }), []);
});
test('rollback: a converted PR blocks', () => {
  assert.match(rollbackBlockers({ prLinkedToPo: true })[0], /requisition/i);
});
test('rollback: produced FG blocks', () => {
  assert.match(rollbackBlockers({ fgProduced: true })[0], /Finished goods/i);
});
test('rollback: dispatched qty blocks with the number', () => {
  assert.match(rollbackBlockers({ dispatchedQty: 12000 })[0], /12000 pcs already dispatched/);
});
test('rollback: multiple blockers are all reported', () => {
  const out = rollbackBlockers({
    stages: [{ stage: 'foiling', status: 'hold' }], fgProduced: true, dispatchedQty: 5,
  });
  assert.equal(out.length, 3);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd "Colour Imp Production/ci-erp" && npm test -w server`
Expected: FAIL — `orderTransitionError`/`rollbackBlockers` are not exported (import error or "is not a function").

- [ ] **Step 3: Implement the two pure functions**

In `server/src/helpers.js`, add near `finaliseBlock`/`reopenBlock` (end of file is fine):

```js
// ── Sales-order lifecycle guard (pure) ────────────────────────────────
// Close ≠ Cancel. Both are terminal; only an admin may reopen a terminal
// order back to pending. Returns an error message, or null when allowed.
const ORDER_NEXT = {
  pending:   ['hold', 'completed', 'closed', 'cancelled'],
  hold:      ['pending', 'closed', 'cancelled'],
  completed: ['closed', 'pending'],   // pending = reopen (admin only, see below)
  closed:    ['pending'],             // reopen (admin only)
  cancelled: ['pending'],             // reopen (admin only)
};
const ORDER_ADMIN_ONLY = new Set(['completed→pending', 'closed→pending', 'cancelled→pending']);

export function orderTransitionError(from, to, isAdmin = false) {
  if (from === to) return `Order is already ${to}`;
  if (!ORDER_NEXT[from]?.includes(to)) return `Cannot move an order from ${from} to ${to}`;
  if (ORDER_ADMIN_ONLY.has(`${from}→${to}`) && !isAdmin) return 'Only an admin can reopen this order';
  return null;
}

// ── Rollback / delete guard (pure) ────────────────────────────────────
// Given the gathered downstream state of an order line, list every reason it
// cannot be rolled back or deleted. Empty array = safe to proceed.
export function rollbackBlockers({ stages = [], prLinkedToPo = false, fgProduced = false, dispatchedQty = 0 } = {}) {
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const out = [];
  for (const s of stages.filter(x => x.status !== 'pending')) {
    out.push(`${cap((s.stage || 'A').replace(/_/g, ' '))} stage is ${(s.status || '').replace(/_/g, ' ')} — reverse it first`);
  }
  if (prLinkedToPo) out.push('Board already ordered against this line’s requisition — cancel the purchase order first');
  if (fgProduced) out.push('Finished goods already produced for this job — reverse production first');
  if (dispatchedQty > 0) out.push(`${dispatchedQty} pcs already dispatched — cannot roll back or delete`);
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "Colour Imp Production/ci-erp" && npm test -w server`
Expected: PASS — all tests in `order-lifecycle.test.js` green, and the existing `production.finalise.test.js` / `routing.test.js` / `tooling-gate.test.js` still pass.

- [ ] **Step 5: Commit** — SKIP.

---

## Task 3: DB engine — release FG reservation + rollbackLine

**Files:**
- Modify: `server/src/helpers.js` (add two async DB helpers; these are transaction-aware like `createJobCardForLine`)

No unit test (DB-touching) — proven end-to-end in Task 8.

- [ ] **Step 1: Add `releaseFgReservation`**

In `server/src/helpers.js`, add (it uses the existing `fgMove` above it):

```js
// Undo a planning-time FG reservation on a line: restore each lot's consumed
// qty, post a compensating warehouse ledger entry, drop the consumption rows,
// and zero the line's reserved figure. Safe to call when there is none.
export async function releaseFgReservation(lineId, qc = q, oc = one, user = null) {
  const cons = await qc(
    `SELECT fc.id, fc.qty, fc.fg_lot_id, fl.lot_number, fl.product_id
     FROM fg_consumptions fc JOIN fg_lots fl ON fl.id = fc.fg_lot_id
     WHERE fc.order_line_id = $1`, [lineId]);
  if (!cons.length) return;
  const line = await oc('SELECT order_id FROM order_lines WHERE id=$1', [lineId]);
  const ord = line ? await oc('SELECT customer_id FROM orders WHERE id=$1', [line.order_id]) : null;
  for (const c of cons) {
    await qc(`UPDATE fg_lots
              SET consumed_qty = GREATEST(0, consumed_qty - $1),
                  status = CASE WHEN status='consumed' THEN 'verified' ELSE status END
              WHERE id=$2`, [c.qty, c.fg_lot_id]);
    await fgMove({
      ref_number: c.lot_number, fg_lot_id: c.fg_lot_id, product_id: c.product_id,
      order_line_id: lineId, order_id: line?.order_id, customer_id: ord?.customer_id,
      qty_in: c.qty, movement_type: 'manual_adjustment', source_module: 'planning',
      created_by: user, remarks: 'FG reservation released on rollback/delete',
    }, qc, oc);
  }
  await qc('DELETE FROM fg_consumptions WHERE order_line_id=$1', [lineId]);
  await qc('UPDATE order_lines SET fg_consumed_qty=0 WHERE id=$1', [lineId]);
  await audit('order_line', lineId, 'fg_reservation_released', `${cons.length} lot reservation(s)`, qc, user);
}
```

- [ ] **Step 2: Add `rollbackLine`**

Still in `server/src/helpers.js`, add (uses `releaseFgReservation`, `forceLineStatus`, `rollbackBlockers`, `audit`, all defined in this file):

```js
// Unwind every artifact derived from an order line, guarded. mode 'rollback'
// keeps the line and resets it to 'pending'; mode 'delete' also removes the
// line from the sales order. Throws {status:409, blockers:[...]} if unsafe.
export async function rollbackLine({ lineId, mode = 'rollback', note = null }, qc = q, oc = one, user = null) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [lineId]);
  if (!line) { const e = new Error('Order line not found'); e.status = 404; throw e; }

  const jc = await oc('SELECT * FROM job_cards WHERE order_line_id=$1', [lineId]);
  const stages = jc ? await qc('SELECT stage, status FROM job_stages WHERE job_card_id=$1', [jc.id]) : [];
  const prPo = await oc(
    `SELECT COUNT(*)::int AS n FROM requisitions WHERE order_line_id=$1 AND purchase_order_id IS NOT NULL`, [lineId]);
  const fgProd = jc ? await oc('SELECT COUNT(*)::int AS n FROM fg_lots WHERE job_card_id=$1', [jc.id]) : { n: 0 };

  const blockers = rollbackBlockers({
    stages, prLinkedToPo: prPo.n > 0, fgProduced: fgProd.n > 0, dispatchedQty: +line.dispatched_qty || 0,
  });
  if (blockers.length) { const e = new Error(blockers[0]); e.status = 409; e.blockers = blockers; throw e; }

  // 1. Release any planning-time FG reservation.
  await releaseFgReservation(lineId, qc, oc, user);

  // 2. Delete the (all-pending) job card and its stages.
  if (jc) {
    await qc('DELETE FROM job_stages WHERE job_card_id=$1', [jc.id]);
    await qc('DELETE FROM job_cards WHERE id=$1', [jc.id]);
    await audit('job_card', jc.id, 'deleted_by_rollback', jc.jc_number, qc, user);
  }

  // 3. Delete a line-raised PR that never became a PO.
  await qc('DELETE FROM requisitions WHERE order_line_id=$1 AND purchase_order_id IS NULL', [lineId]);

  // 4. Leave any gang: clear the link and dissolve a gang left with <2 members.
  if (line.gang_run_id) {
    await qc('UPDATE order_lines SET gang_run_id=NULL WHERE id=$1', [lineId]);
    const left = await oc('SELECT COUNT(*)::int AS n FROM order_lines WHERE gang_run_id=$1', [line.gang_run_id]);
    if (left.n < 2) {
      await qc('UPDATE order_lines SET gang_run_id=NULL WHERE gang_run_id=$1', [line.gang_run_id]);
      await qc('DELETE FROM gang_runs WHERE id=$1', [line.gang_run_id]);
    }
  }

  // 5. Reset all planning/artwork/tooling locks on the line.
  await qc(`UPDATE order_lines SET
              machine_id=NULL, planned_date=NULL, sheets_required=NULL, parent_sheets_required=NULL,
              wastage_sheets=NULL, spec_override=NULL, leftover_plan=NULL,
              tooling_ok=0, artwork_customer_ok=0, artwork_qa_ok=0, artwork_locked=0
            WHERE id=$1`, [lineId]);

  if (mode === 'delete') {
    // Null out nullable FK references so the line row can be removed.
    await qc('UPDATE fg_movements SET order_line_id=NULL WHERE order_line_id=$1', [lineId]);
    await qc('UPDATE fg_lots SET order_line_id=NULL WHERE order_line_id=$1', [lineId]);
    await audit('order_line', lineId, 'deleted_entirely', note || `Removed from sales order (was ${line.status})`, qc, user);
    await qc('DELETE FROM order_lines WHERE id=$1', [lineId]);
    return { ok: true, mode, deleted: true, message: 'Item deleted from all stations' };
  }

  await forceLineStatus(lineId, 'pending', note || 'Rolled back to sales order', qc, oc, user);
  await audit('order_line', lineId, 'rolled_back_to_sales_order', note || `was ${line.status}`, qc, user);
  return { ok: true, mode, deleted: false, message: 'Item rolled back to the sales order' };
}
```

- [ ] **Step 3: Sanity-check the module loads**

Run: `cd "Colour Imp Production/ci-erp" && node --check server/src/helpers.js && node -e "import('./server/src/helpers.js').then(m=>console.log(typeof m.rollbackLine, typeof m.releaseFgReservation, typeof m.orderTransitionError))"`
Expected: prints `function function function` with no syntax error.

- [ ] **Step 4: Commit** — SKIP.

---

## Task 4: Backend endpoints — order status + line rollback

**Files:**
- Modify: `server/src/routes/orders.js`

- [ ] **Step 1: Import the new helpers**

In `server/src/routes/orders.js`, extend the existing helpers import (line 4) to include `orderTransitionError` and `rollbackLine`:

```js
import { audit, setLineStatus, sheetsRequired, netProduceQty, readiness, nextNumber, childFit, parentSheetsRequired, leftoverStrips, effectiveParent, fgAvailableForLine, fgMatchPredicate, fgMatchedBy, orderTransitionError, rollbackLine } from '../helpers.js';
```

- [ ] **Step 2: Add `POST /orders/:id/status`**

Insert immediately after the `complete-lines` handler (after its closing `});`, around line 258):

```js
// Sales-order lifecycle: set Pending / Hold / Completed / Closed / Cancelled.
// Guarded by orderTransitionError; reopening a terminal order needs admin.
r.post('/orders/:id/status', canPlan, async (req, res, next) => {
  try {
    const to = String(req.body.status || '').trim();
    const note = (req.body.note || '').trim();
    const isAdmin = req.user?.role === 'admin';
    const result = await tx(async (qc, oc) => {
      const o = await oc('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!o) throw Object.assign(new Error('Order not found'), { status: 404 });
      const err = orderTransitionError(o.status, to, isAdmin);
      if (err) throw Object.assign(new Error(err), { status: 409 });

      // Completing an order requires every non-cancelled line fully dispatched.
      if (to === 'completed') {
        const undone = await oc(
          `SELECT COUNT(*)::int AS n FROM order_lines
           WHERE order_id=$1 AND status<>'cancelled' AND dispatched_qty < qty`, [o.id]);
        if (undone.n > 0) throw Object.assign(new Error('Every item must be fully dispatched before completing the order'), { status: 409 });
      }
      // Cancelling cascades to un-shipped lines (mirrors the old /cancel path).
      if (to === 'cancelled') {
        const openLines = await qc(
          `SELECT id FROM order_lines WHERE order_id=$1 AND status NOT IN ('dispatched','cancelled')`, [o.id]);
        for (const l of openLines) await setLineStatus(l.id, 'cancelled', qc, oc, req.user.name);
      }
      await qc('UPDATE orders SET status=$1 WHERE id=$2', [to, o.id]);
      await audit('order', o.id, `status:${o.status}→${to}`, note || null, qc, req.user.name);
      return { from: o.status, to };
    });
    const out = await one(`SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=$1`, [req.params.id]);
    res.json({ ...out, transition: result });
  } catch (e) { next(e); }
});
```

- [ ] **Step 3: Add `POST /order-lines/:id/rollback`**

Insert after the `POST /order-lines/:id/cancel` handler (around line 201-202):

```js
// Station rollback / delete. mode 'rollback' returns the line to the sales
// order (fresh, pending); mode 'delete' removes it from the order entirely.
// Blocked (409 + { blockers }) when real downstream activity exists.
r.post('/order-lines/:id/rollback', canPlan, async (req, res, next) => {
  try {
    const mode = req.body.mode === 'delete' ? 'delete' : 'rollback';
    const note = (req.body.note || '').trim() || null;
    const result = await tx((qc, oc) => rollbackLine({ lineId: +req.params.id, mode, note }, qc, oc, req.user.name));
    res.json(result);
  } catch (e) {
    if (e.blockers) return res.status(409).json({ error: e.message, blockers: e.blockers });
    next(e);
  }
});
```

- [ ] **Step 4: Tag `order_line_id` when raising a PR from a line**

In the `raise-pr` handler, change the requisition INSERT (around line 776-779) to store the originating line so rollback can clean it up:

```js
    const [pr] = await q(
      `INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason, order_line_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [pr_number, gate.board_material_id, shortage, line.planned_date,
       `Shortage for ${line.product_name} (PO ${line.po_number})`, line.id]);
```

- [ ] **Step 5: Verify the server boots and routes are mounted**

Run: `cd "Colour Imp Production/ci-erp" && node --check server/src/routes/orders.js` then start `npm run dev -w server`.
Expected: `node --check` clean; server boots with no error. Leave it running for Task 8, or stop for now.

- [ ] **Step 6: Commit** — SKIP.

---

## Task 5: Backend — fix dispatch auto-status for the new state set

**Files:**
- Modify: `server/src/routes/dispatch.js`

The dispatch edit path hardcodes the legacy `'open'` status and would drag a `hold`/`closed` order back. Fix both auto-status writes.

- [ ] **Step 1: Fix the dispatch-edit reopen (line ~254)**

Replace:

```js
      await qc(`UPDATE orders SET status=$1 WHERE id=$2 AND status != 'cancelled'`,
        [open.n === 0 ? 'completed' : 'open', d.order_id]);
```

with:

```js
      await qc(`UPDATE orders SET status=$1 WHERE id=$2 AND status NOT IN ('cancelled','hold','closed')`,
        [open.n === 0 ? 'completed' : 'pending', d.order_id]);
```

- [ ] **Step 2: Guard the dispatch-create auto-complete (line ~152)**

Replace:

```js
      if (open.n === 0) await qc(`UPDATE orders SET status='completed' WHERE id=$1`, [order_id]);
```

with:

```js
      if (open.n === 0) await qc(`UPDATE orders SET status='completed' WHERE id=$1 AND status='pending'`, [order_id]);
```

- [ ] **Step 3: Verify**

Run: `cd "Colour Imp Production/ci-erp" && node --check server/src/routes/dispatch.js`
Expected: no syntax error. (Behavioural check happens in Task 8.)

- [ ] **Step 4: Commit** — SKIP.

---

## Task 6: Client — status colours + WorkflowControls Danger zone

**Files:**
- Modify: `client/src/components/ui.jsx`
- Modify: `client/src/components/WorkflowControls.jsx`

- [ ] **Step 1: Add/adjust status colours**

In `client/src/components/ui.jsx`, in the `STATUS_COLOURS` map, add a `hold` entry and change `closed` so it reads distinctly from `completed` (green):

```js
  hold: 'bg-amber-50 text-amber-700',
  closed: 'bg-slate-200 text-slate-600',
```

(Replace the existing `closed: 'bg-emerald-50 text-emerald-700',` line; add the `hold` line next to it.)

- [ ] **Step 2: Add the Danger zone to WorkflowControls**

In `client/src/components/WorkflowControls.jsx`:

(a) Extend the icon import (line 2) to add `Undo2` is already imported; add `RotateCcw` and `Trash2`:

```js
import { ArrowLeftRight, CornerDownLeft, GitBranch, RotateCcw, Send, Trash2, Undo2 } from 'lucide-react';
```

(b) Add a self-contained `DangerZone` component + its confirm modal. Add this **above** the default-export `WorkflowControls` function:

```js
function DangerModal({ open, mode, label, busy, blockers, note, setNote, onClose, onConfirm }) {
  const isDelete = mode === 'delete';
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isDelete ? `Delete entirely — ${label}` : `Roll back to Sales Order — ${label}`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={isDelete ? 'danger' : 'primary'} disabled={busy || blockers.length > 0} onClick={onConfirm}>
          {isDelete ? 'Delete Everywhere' : 'Roll Back'}
        </Button>
      </>}
    >
      <div className="space-y-3">
        {blockers.length > 0 ? (
          <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
            <b>Can’t {isDelete ? 'delete' : 'roll back'} yet:</b>
            <ul className="mt-1 list-disc pl-5">{blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
          </div>
        ) : (
          <div className="ci-summary-panel">
            {isDelete
              ? <><b>{label}</b> and everything derived from it — job card, stages, print-queue slot, any board requisition, tooling & artwork approvals — will be removed, and the item deleted from the sales order. This cannot be undone.</>
              : <><b>{label}</b> returns to the sales order as a fresh Pending item. All planning, artwork, tooling, job card and print-queue work on it is cleared.</>}
          </div>
        )}
        <textarea
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          rows={2} placeholder="Reason (optional — recorded in the timeline)"
          value={note} onChange={e => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

export function DangerZone({ line, jobCard, onDone, asMenu = false }) {
  const toast = useToast();
  const lineId = line?.id || jobCard?.order_line_id;
  const label = line?.product_name || jobCard?.product_name || 'this item';
  const [mode, setMode] = useState(null);          // 'rollback' | 'delete' | null
  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState([]);
  const [note, setNote] = useState('');
  if (!canPlan() || !lineId) return null;

  const open = m => { setBlockers([]); setNote(''); setMode(m); };
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/order-lines/${lineId}/rollback`, { mode, note: note || undefined });
      toast.success(r.message || 'Done');
      setMode(null);
      onDone?.();
    } catch (e) {
      if (e.data?.blockers) setBlockers(e.data.blockers);
      else toast.error(e.message || 'Action failed');
    } finally { setBusy(false); }
  };

  const items = [
    { key: 'rollback', label: 'Roll back to Sales Order', icon: RotateCcw, tone: 'danger', onClick: () => open('rollback') },
    { key: 'delete', label: 'Delete entirely', icon: Trash2, tone: 'danger', onClick: () => open('delete') },
  ];

  return (
    <>
      {asMenu ? (
        <span onClick={e => e.stopPropagation()}><ActionMenu items={items} /></span>
      ) : (
        <div className="flex flex-wrap justify-end gap-1.5" onClick={e => e.stopPropagation()}>
          <Button size="sm" variant="ghost" title="Roll back to Sales Order"
            className="min-h-0 rounded-lg border border-amber-200 bg-amber-50/60 px-1.5 py-0.5 text-[10px] text-amber-700 hover:bg-amber-100"
            onClick={() => open('rollback')}><RotateCcw size={10} /> Rollback</Button>
          <Button size="sm" variant="ghost" title="Delete entirely from all stations"
            className="min-h-0 rounded-lg border border-red-200 bg-red-50/60 px-1.5 py-0.5 text-[10px] text-red-700 hover:bg-red-100"
            onClick={() => open('delete')}><Trash2 size={10} /> Delete</Button>
        </div>
      )}
      <DangerModal open={!!mode} mode={mode} label={label} busy={busy} blockers={blockers}
        note={note} setNote={setNote} onClose={() => setMode(null)} onConfirm={run} />
    </>
  );
}
```

(c) Ensure `ActionMenu`, `Button`, `Modal`, `useToast` are imported (they already are at line 4) and `api` (line 3). `canPlan` is already defined at the top of the file. No further wiring needed here.

- [ ] **Step 3: Verify the client builds**

Run: `cd "Colour Imp Production/ci-erp" && npm run build -w client`
Expected: Vite build succeeds with no import/syntax error. (If the project has no `build` script, run `npx vite build` from `client/`. A dev server for manual check happens in Task 8.)

- [ ] **Step 4: Commit** — SKIP.

---

## Task 7: Client — mount Danger zone on every station

**Files:**
- Modify: `client/src/pages/Planning.jsx`
- Modify: `client/src/pages/Artwork.jsx`
- Modify: `client/src/pages/Production.jsx`
- Modify: `client/src/pages/PrintPlanning.jsx`

- [ ] **Step 1: Planning — add DangerZone to the row menu**

In `client/src/pages/Planning.jsx`, update the WorkflowControls import to also bring in `DangerZone`:

```js
import WorkflowControls, { BulkWorkflowControls, DangerZone } from '../components/WorkflowControls.jsx';
```

Then, at the row that renders `<WorkflowControls line={l} context="planning" onDone={load} asMenu ... />` (line ~523), add a sibling danger menu next to it (wrap both in a fragment if needed):

```jsx
<DangerZone line={l} onDone={load} asMenu />
```

- [ ] **Step 2: Artwork — add DangerZone to the actions column**

In `client/src/pages/Artwork.jsx`, update the import similarly (`, DangerZone`), then in the workflow column render (line ~238) change:

```jsx
{ key: 'workflow', label: '', sortable: false, render: l => (
  <div className="flex items-center justify-end gap-1.5">
    <WorkflowControls line={l} context="artwork" onDone={load} />
    <DangerZone line={l} onDone={load} asMenu />
  </div>
) },
```

- [ ] **Step 3: Production (Job Card) — add DangerZone beside the job-card controls**

In `client/src/pages/Production.jsx`, update the import (`, DangerZone`). At each `<WorkflowControls jobCard={...} context="jobcard" onDone={load} />` (lines ~194 and ~400), add next to it:

```jsx
<DangerZone jobCard={jc} onDone={load} asMenu />
```

(For the line ~400 editor instance use `jobCard={editing}`.)

- [ ] **Step 4: Print Planning — add DangerZone menu to each card**

In `client/src/pages/PrintPlanning.jsx`, add the import at the top:

```js
import { DangerZone } from '../components/WorkflowControls.jsx';
```

The `Card` component (around line 72) receives `card` (which carries `id`, `order_line_id`, `jc_number`). It also needs a refresh callback — the board already reloads via the function that fetches cards; pass it down. Find where `<Card ... card={c} onPress={onPress} theme={theme} />` is rendered (line ~191) and add an `onDone` prop that triggers the existing card reload (the same function used after `assign`, e.g. `load`/`refresh`; use whichever the component already calls after `/print-planning/assign`). Then inside `Card`, next to the `jc_number` span (line ~72), render:

```jsx
<span className="ml-auto" onClick={e => e.stopPropagation()}>
  <DangerZone jobCard={card} onDone={onDone} asMenu />
</span>
```

Wire the reload: locate the cards-fetching function near the top of the component (the one called after assignment) and pass it as `onDone={<thatFn>}` where `<Card>` is rendered. If the fetch is inline, extract it into a named `const reloadCards = () => api.get('/print-planning').then(...)` and reuse it for both the initial load and `onDone`.

- [ ] **Step 5: Verify the client builds**

Run: `cd "Colour Imp Production/ci-erp" && npm run build -w client`
Expected: build succeeds; no unresolved import of `DangerZone` on any page.

- [ ] **Step 6: Commit** — SKIP.

---

## Task 8: Client — Sales Orders tabs + status actions

**Files:**
- Modify: `client/src/pages/Orders.jsx`

- [ ] **Step 1: Rework the status filter buckets + tabs**

In `client/src/pages/Orders.jsx`:

(a) Default the active tab to `pending` (line ~179): `const [tab, setTab] = useState('pending');` — but note `pending` is now an ORDER status tab; the owed-items view moves to key `pendency` (see below).

(b) Replace the three bucket filters (lines ~209-212) with five, plus keep a helper for the owed-items view:

```js
  const byStatus = s => orders.filter(o => o.status === s);
  const ordersForTab = {
    pending: byStatus('pending'),
    hold: byStatus('hold'),
    completed: byStatus('completed'),
    closed: byStatus('closed'),
    cancelled: byStatus('cancelled'),
  };
```

(c) Replace the pendency fetch trigger (line ~197) so it keys off the renamed tab:

```js
    if (tab === 'pendency') api.get('/sales/pendency').then(setPendency).catch(() => {});
```

(d) Replace the `<Tabs ... />` block (lines ~348-354) with:

```jsx
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'pending', label: 'Pending', count: ordersForTab.pending.length },
        { key: 'hold', label: 'Hold', count: ordersForTab.hold.length },
        { key: 'completed', label: 'Completed', count: ordersForTab.completed.length },
        { key: 'closed', label: 'Closed', count: ordersForTab.closed.length },
        { key: 'cancelled', label: 'Cancelled', count: ordersForTab.cancelled.length },
        { key: 'pendency', label: 'Pendency' },
      ]} />
```

(e) Update the two `tab !== 'pending'` / `tab === 'pending'` conditionals (lines ~355 and ~379) that currently gate the orders table vs the pendency view — change them to gate on `pendency`:

```jsx
      {tab !== 'pendency' && (
        <DataTable searchable
          /* ...unchanged columns... */
          rows={ordersForTab[tab] || ordersForTab.pending}
          onRowClick={openDetail}
          empty={{
            pending: 'No pending orders — create your first one',
            hold: 'No orders on hold',
            completed: 'No completed orders yet',
            closed: 'No closed orders',
            cancelled: 'No cancelled orders',
          }[tab]}
          /* ...unchanged... */
        />
      )}
```

and

```jsx
      {tab === 'pendency' && (
        /* ...existing pendency block unchanged... */
      )}
```

Also update the empty-pendency copy (line ~382) if it says "open order" — change to "pending order" for consistency (cosmetic).

- [ ] **Step 2: Add order status action buttons in the detail modal**

Find where the order detail modal renders its header/actions (near `startEdit`, the "Edit"/"Close order" buttons — the current `cancelOrder`/`setCloseOrderModal` usage around lines 249-258). Add a status action helper and a button row.

(a) Add the handler near `cancelOrder` (line ~251):

```js
  const setOrderStatus = async (status) => {
    try {
      const updated = await api.post(`/orders/${detail.id}/status`, { status });
      toast.success(`Order marked ${status}`);
      setDetail(d => ({ ...d, status: updated.status }));
      load();
    } catch (e) { toast.error(e.message || `Could not set ${status}`); }
  };
```

(b) In the detail modal action area, render buttons driven by the current status (only show valid transitions; admins can reopen). Place this next to the existing Edit control:

```jsx
  {detail && (() => {
    const isAdmin = auth.user?.role === 'admin';
    const s = detail.status;
    const B = ({ to, children, variant = 'secondary' }) => (
      <Button size="sm" variant={variant} onClick={() => setOrderStatus(to)}>{children}</Button>
    );
    return (
      <div className="flex flex-wrap gap-1.5">
        {s === 'hold' && <B to="pending" variant="primary">Resume (Pending)</B>}
        {s === 'pending' && <B to="hold">Hold</B>}
        {s === 'pending' && <B to="completed" variant="primary">Complete</B>}
        {(s === 'pending' || s === 'hold') && <B to="closed">Close</B>}
        {(s === 'pending' || s === 'hold') && <B to="cancelled" variant="danger">Cancel</B>}
        {['completed','closed','cancelled'].includes(s) && isAdmin && <B to="pending">Reopen</B>}
      </div>
    );
  })()}
```

Ensure `auth` is imported in Orders.jsx (it imports from `../api.js`; add `auth` to that import if missing).

(c) The legacy "Close order" modal (`cancelOrder` / `setCloseOrderModal`) is now superseded by the Cancel button above. Leave the old modal code in place if other UI references it, but the new Cancel button is the primary path. (Do not delete unless the modal is only opened from the row you are replacing — check for other `setCloseOrderModal(` callers first with a quick grep; if none besides the detail header, remove the dead modal.)

- [ ] **Step 3: Build the client**

Run: `cd "Colour Imp Production/ci-erp" && npm run build -w client`
Expected: build succeeds.

- [ ] **Step 4: Commit** — SKIP.

---

## Task 9: End-to-end verification in the real app

**Files:** none (manual/driven verification per project rule — verify in the REAL running app, login + desktop breakpoint, never a mock).

- [ ] **Step 1: Start the full app**

Run: `cd "Colour Imp Production/ci-erp" && npm run dev`
Expected: server (4000) + client (Vite) both up. Open the client URL, log in as `admin@ci.local` / `admin123`.

- [ ] **Step 2: Seed a walkable line**

Create (or reuse) a Sales Order with one line for a real customer/product. Lock Planning, approve Artwork, push to Job Card, send to Print Planning (do **not** start any stage).

- [ ] **Step 3: Rollback from Print Planning**

On the Print Planning card, open the danger menu → **Roll back to Sales Order** → confirm.
Expected: toast "Item rolled back to the sales order"; the card disappears from Print Planning; the job card is gone from Production; on the Sales Order the line reads **Pending** with planning/artwork cleared. Check the universal Timeline shows `rolled_back_to_sales_order`.

- [ ] **Step 4: Re-advance, then Delete Entirely**

Re-plan the line through to Job Card, then use **Delete entirely** from the Job Card station.
Expected: toast "Item deleted from all stations"; the line is gone from the Sales Order, Planning, Artwork, Production, Print Planning. Timeline shows `deleted_entirely`.

- [ ] **Step 5: Guardrail check**

Take another line to Job Card, **start** its first stage (cutting) on the Floor. Return to any station and try **Roll back** and **Delete**.
Expected: both are blocked; the modal lists the blocker (e.g. "Cutting stage is in progress — reverse it first"); the confirm button is disabled. No data changes.

- [ ] **Step 6: FG reservation release**

On a fresh planned line, use "Use FG Stock" to reserve some finished goods, then Roll back the line.
Expected: rollback succeeds; the FG lot's available balance is restored (check Finished Goods — `consumed_qty` drops back, lot status returns to `verified` if it had flipped to `consumed`); a `manual_adjustment` movement appears in the FG ledger with remark "FG reservation released on rollback/delete".

- [ ] **Step 7: Order lifecycle tabs + transitions**

On Sales Orders: confirm the tabs **Pending · Hold · Completed · Closed · Cancelled · Pendency** all render with correct counts. Open a pending order → **Hold** (moves to Hold tab) → **Resume** (back to Pending) → **Close** (Closed tab) → as admin **Reopen** (back to Pending). Create a separate order and **Cancel** it (Cancelled tab; its un-shipped lines show cancelled). Confirm **Complete** is refused unless all lines are fully dispatched.

- [ ] **Step 8: Regression — normal dispatch still completes**

Fully dispatch every line of a pending order and confirm the order auto-rolls to **Completed** (Task 5 guard) and does not disturb a held/closed order.

- [ ] **Step 9: Commit** — SKIP. Report results to the user with screenshots of the danger modal, a blocked guardrail, and the five order tabs.

---

## Notes for the implementer
- **No git commits** anywhere — the "Commit" steps are intentionally skipped per the project's standing rule.
- Keep the existing `WorkflowControls` reverse actions intact; the Danger zone is additive.
- The pure functions (`orderTransitionError`, `rollbackBlockers`) are the only unit-tested pieces; everything DB-touching is proven in Task 9 against the live app because the test harness has no database.
- If `PrintPlanning.jsx`'s card reload function is hard to thread through, an acceptable fallback is `onDone={() => window.location.reload()}` for that station only — but prefer the in-place reload.
