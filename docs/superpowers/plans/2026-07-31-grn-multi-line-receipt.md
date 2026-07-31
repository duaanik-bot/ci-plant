# GRN Multi-Line Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a GRN from a single-board row into a multi-line priced document — one GRN number covering many boards, each with rate, discount, GST and value — feeding the purchase register and stock valuation.

**Architecture:** `grns` is renamed in place to `grn_headers` (preserving ids, so every existing thread/audit/notification still resolves) and the per-board columns move down into a new `grn_lines` table. All decidable logic lands in a new pure module `server/src/grn-receipt.js`, unit-tested with `node --test` exactly like `helpers.js`; routes stay thin wrappers. The client reuses `PoTotalsPanel`, `TaxKindToggle` and `lib/poTotals.js` verbatim so a GRN and a PO cannot compute money differently.

**Tech Stack:** Node/Express + Postgres (`pg`), React + Vite + Tailwind, `node --test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-07-31-grn-multi-line-receipt-design.md`

---

## Amendment — 2026-07-31, after Task 3

`origin/main` moved twice during execution. Two changes matter:

1. **`c04d258` "Every procurement row can be deleted"** merged a row-level
   procurement delete chain: a new pure module `server/src/procurement-delete.js`
   (`grnReversal`, `planProcurementDelete`) plus `reverseGrnRow()` and
   `deleteContext()` in `routes/procurement.js`. It reads
   `stock_batches.grn_id` and `g.po_line_id` — **both of which migration 0015
   removes.** Task 6 must now adapt that chain rather than the simpler routes
   this plan was written against. The good news: `procurement-delete.js` is
   pure and takes plain objects, so feeding it **one entry per GRN line**
   (a line is exactly what a GRN row used to be) preserves its logic. Only the
   gathering queries in `deleteContext`/`reverseGrnRow` need rewriting.
2. **`scripts/import-grn.mjs`** is a new consumer that replicates the
   direct-GRN insert and QC-accept statement for statement. Task 7 must update
   it or it will silently write to a table that no longer exists.

The migration number also moved from `0014` to `0015`: `0014_comms_shell.sql`
is already on main and applied to production, and a duplicate prefix would be
**silently skipped** by `supabase db push`.

Current route anchors after rebase: `GET /grns` 714, `POST /grns` 728,
`/grns/direct` 763, `/grns/bulk` 796, `PUT /grns/:id` 839, `reverseGrnRow` 882,
`deleteContext` 932, `DELETE /grns/:id` 1013, `rollback` 1038, `qc` 1123.

## Working rules for this repo

Read these before Task 1. They are not optional.

- **This tree is shared with other Claude sessions.** `git status --short --branch` before every commit. `server/src/db.js` and 12 other files already carry another session's uncommitted work. **Never** run `git checkout -- <file>`, `git stash`, or `git restore` — it destroys their work. Edit by exact string match only, and stage only the files named in the task.
- **The branch is `shade-card-simplification`.** Stay on it. Do not merge or rebase.
- **Tests are pure functions.** No test in this repo touches a database. `procurement-rate.test.js` imports pure exports straight from `routes/procurement.js` — follow that precedent.
- **A whole test file failing with zero assertions listed is an import error**, not a logic failure. Run the file directly (`node --test server/src/<file>.test.js`) to see the real `SyntaxError`.
- **Money is two decimals.** Use the `round2` idiom already in `lib/poTotals.js`.
- **Quantity columns are `DOUBLE PRECISION`.** Compare with an epsilon (`EPS = 1e-6`), never `qty > 0` on a derived float.
- Run `npm run verify` from the repo root before any commit that touches `db.js`.

## File structure

| File | Responsibility |
|---|---|
| `server/src/grn-receipt.js` | **New.** Pure GRN document logic: derived status, batch numbering, edit/delete/rollback guards, register value, rate variance. No imports from `db.js`. |
| `server/src/grn-receipt.test.js` | **New.** `node --test` unit tests for the above. |
| `supabase/migrations/0015_grn_multi_line.sql` | **New.** The rename + line extraction + backfills. |
| `server/src/db.js` | Modify `init()` to create the post-migration shape for fresh databases. |
| `server/src/routes/procurement.js` | Rewrite all 25 GRN call sites against the two-table model. |
| `server/src/routes/billing.js` | Add direct receipts to the purchase register. |
| `server/src/routes/inventory.js` | Return `costed_qty` / `costed_value` per material. |
| `server/src/routes/master-history.js`, `routes/timeline.js`, `seed.js` | Follow the schema change (3 files, 4 sites). |
| `client/src/lib/boardMath.js` | Add pure `stockValueOf()`. |
| `client/src/components/GrnForms.jsx` | **New.** `GrnLineEditor` for both tabs. |
| `client/src/components/ProcurementForms.jsx` | Additively export the shared line-card primitives. Nothing rewritten. |
| `client/src/pages/Procurement.jsx` | Create GRN modal + GRN register. |
| `client/src/pages/Inventory.jsx` | Use `stockValueOf()`. |
| `client/src/pages/GrnPrint.jsx` | **New.** A4 receipt, modelled on `POPrint.jsx`. |
| `client/src/components/ui.jsx` | Two new `STATUS_COLOURS` entries. |

**Phase order matters.** Phase 1 is pure additive logic and commits safely on its own. Phase 2 onward changes the schema, at which point `grns` stops existing and the app is broken until Phase 4 lands. **Do not deploy between Task 3 and Task 14.**

---

## Phase 1 — Pure logic (safe, no breakage)

### Task 1: GRN document logic module

**Files:**
- Create: `server/src/grn-receipt.js`
- Test: `server/src/grn-receipt.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/src/grn-receipt.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  grnHeaderStatus, grnBatchNo, grnEditBlockers, grnDeleteBlockers,
  grnRollbackBlockers, grnRegisterValue, rateVariance,
} from './grn-receipt.js';

const line = (status, extra = {}) => ({ status, qty: 100, rate: 10, ...extra });

// ── Derived header status ─────────────────────────────────────────────
// Never stored. "Part QC'd" (work still owed) and "Partly Accepted"
// (settled, some refused) must stay distinct or an outstanding QC
// decision hides behind a finished-looking chip.
test('header status: all quarantine reads In QC', () => {
  assert.equal(grnHeaderStatus([line('quarantine'), line('quarantine')]), 'in_qc');
});

test('header status: all accepted reads accepted', () => {
  assert.equal(grnHeaderStatus([line('accepted'), line('accepted')]), 'accepted');
});

test('header status: all rejected reads rejected', () => {
  assert.equal(grnHeaderStatus([line('rejected'), line('rejected')]), 'rejected');
});

test('header status: some decided, some pending is part_qc not partly_accepted', () => {
  assert.equal(grnHeaderStatus([line('accepted'), line('quarantine')]), 'part_qc');
  assert.equal(grnHeaderStatus([line('rejected'), line('quarantine')]), 'part_qc');
});

test('header status: all decided but mixed is partly_accepted', () => {
  assert.equal(grnHeaderStatus([line('accepted'), line('rejected')]), 'partly_accepted');
});

test('header status: an empty receipt is still in QC, never accepted', () => {
  assert.equal(grnHeaderStatus([]), 'in_qc');
});

// ── Batch numbering ───────────────────────────────────────────────────
// The old single-line code always produced "-B1". Two lines of one GRN
// must not collide on it.
test('batch no: lines of one GRN get distinct suffixes', () => {
  assert.equal(grnBatchNo('CI-GRN-0007', 0), 'CI-GRN-0007-B1');
  assert.equal(grnBatchNo('CI-GRN-0007', 1), 'CI-GRN-0007-B2');
  assert.equal(grnBatchNo('CI-GRN-0007', 2), 'CI-GRN-0007-B3');
});

test('batch no: a supplied supplier batch wins, blank/whitespace does not', () => {
  assert.equal(grnBatchNo('CI-GRN-0007', 0, 'SUP-99'), 'SUP-99');
  assert.equal(grnBatchNo('CI-GRN-0007', 1, '   '), 'CI-GRN-0007-B2');
  assert.equal(grnBatchNo('CI-GRN-0007', 1, null), 'CI-GRN-0007-B2');
});

// ── Guards ────────────────────────────────────────────────────────────
test('edit: allowed only while every line is still in quarantine', () => {
  assert.deepEqual(grnEditBlockers({ lines: [line('quarantine'), line('quarantine')] }), []);
  assert.match(grnEditBlockers({ lines: [line('accepted'), line('quarantine')] })[0], /QC-decided/i);
});

test('delete: refused once any line is accepted, and points at rollback', () => {
  assert.deepEqual(grnDeleteBlockers({ lines: [line('quarantine'), line('rejected')] }), []);
  assert.match(grnDeleteBlockers({ lines: [line('accepted')] })[0], /roll it back/i);
});

test('delete: refused when stock from a line has been used', () => {
  const out = grnDeleteBlockers({ lines: [line('quarantine', { batchConsumed: true })] });
  assert.match(out[0], /already been used/i);
});

test('rollback: refused while any line is still in QC', () => {
  const out = grnRollbackBlockers({ lines: [line('accepted'), line('quarantine')] });
  assert.match(out[0], /finish QC/i);
});

test('rollback: refused when nothing was accepted', () => {
  const out = grnRollbackBlockers({ lines: [line('rejected'), line('rejected')] });
  assert.match(out[0], /delete it instead/i);
});

test('rollback: allowed when every line is decided and one was accepted', () => {
  assert.deepEqual(grnRollbackBlockers({ lines: [line('accepted'), line('rejected')] }), []);
});

test('rollback: refused when accepted stock has been touched', () => {
  const out = grnRollbackBlockers({ lines: [line('accepted', { batchTouched: true, material_name: 'Duplex GB 230' })] });
  assert.match(out[0], /Duplex GB 230/);
  assert.match(out[0], /already been used/i);
});

// ── Purchase-register value ───────────────────────────────────────────
// Rejected board went back to the supplier and is not a purchase.
// Quarantine board HAS arrived and been invoiced, so it counts.
test('register value: excludes rejected lines, counts quarantine ones', () => {
  const lines = [
    line('accepted', { qty: 100, rate: 10 }),    // 1000
    line('quarantine', { qty: 50, rate: 20 }),   // 1000
    line('rejected', { qty: 999, rate: 999 }),   // excluded
  ];
  assert.equal(grnRegisterValue(lines), 2000);
});

test('register value: gross of discount and tax, matching the PO convention', () => {
  // discount_pct / gst_rate present but deliberately ignored — the PO half of
  // the register is SUM(pl.qty * pl.rate), so this half must match.
  assert.equal(grnRegisterValue([line('accepted', { qty: 10, rate: 3.5, discount_pct: 50, gst_rate: 18 })]), 35);
});

test('register value: an empty or all-rejected receipt is worth nothing', () => {
  assert.equal(grnRegisterValue([]), 0);
  assert.equal(grnRegisterValue([line('rejected')]), 0);
});

// ── Rate variance ─────────────────────────────────────────────────────
test('rate variance: null inside money tolerance, signed outside it', () => {
  assert.equal(rateVariance(10, 10), null);
  assert.equal(rateVariance(10.004, 10), null);
  assert.equal(rateVariance(10.5, 10), 0.5);
  assert.equal(rateVariance(9.5, 10), -0.5);
});

test('rate variance: null when there is nothing to compare', () => {
  assert.equal(rateVariance(10, null), null);
  assert.equal(rateVariance('', 10), null);
  assert.equal(rateVariance(null, null), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test server/src/grn-receipt.test.js
```

Expected: FAIL — `Cannot find module '.../grn-receipt.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/grn-receipt.js`:

```js
// GRN document logic — pure, DB-free, so it unit-tests like helpers.js.
// A GRN is a header with priced lines, mirroring a purchase order on the
// receiving side. Everything decidable about that document lives here; the
// routes in routes/procurement.js stay thin wrappers around it.
const round2 = n => Math.round((+n || 0) * 100) / 100;

// ── Derived header status ────────────────────────────────────────────────────
// NEVER stored. Storing it would let it drift from the lines that produce it,
// the same rule this ERP follows for a stage's Received.
//
// 'part_qc' and 'partly_accepted' are deliberately distinct: the first means
// work is still owed, the second means the receipt is settled and some of it
// was refused. One label for both would hide an outstanding QC decision behind
// a finished-looking chip.
export function grnHeaderStatus(lines = []) {
  if (!lines.length) return 'in_qc';
  const n = lines.length;
  const q = lines.filter(l => l.status === 'quarantine').length;
  const a = lines.filter(l => l.status === 'accepted').length;
  const r = lines.filter(l => l.status === 'rejected').length;
  if (q === n) return 'in_qc';
  if (a === n) return 'accepted';
  if (r === n) return 'rejected';
  if (q > 0) return 'part_qc';
  return 'partly_accepted';
}

// ── Batch numbering ──────────────────────────────────────────────────────────
// The supplier's own batch number wins when supplied. Otherwise the line gets
// its own suffix — the single-line code always produced "-B1", which two lines
// of one receipt would collide on.
export function grnBatchNo(grnNumber, index, supplied) {
  const s = String(supplied ?? '').trim();
  return s || `${grnNumber}-B${index + 1}`;
}

// ── Guards ───────────────────────────────────────────────────────────────────
// Each returns a list of human blocker strings; an empty list means safe.
// Same shape as rollbackBlockers / printReverseBlockers in helpers.js.

export function grnEditBlockers({ lines = [] } = {}) {
  const out = [];
  const decided = lines.filter(l => l.status !== 'quarantine').length;
  if (decided > 0)
    out.push(`${decided} line${decided > 1 ? 's have' : ' has'} already been QC-decided — a receipt can only be edited before QC`);
  return out;
}

export function grnDeleteBlockers({ lines = [] } = {}) {
  const out = [];
  if (lines.some(l => l.status === 'accepted'))
    out.push('This GRN has lines accepted into stock — roll it back instead of deleting it');
  const used = lines.filter(l => l.batchConsumed).length;
  if (used > 0)
    out.push(`Stock from ${used} line${used > 1 ? 's' : ''} on this GRN has already been used`);
  return out;
}

// Rollback deletes the whole header, so a receipt still holding an undecided
// line must be refused — otherwise that line is silently discarded.
export function grnRollbackBlockers({ lines = [] } = {}) {
  if (!lines.length) return ['This GRN has no lines to roll back'];
  const out = [];
  const undecided = lines.filter(l => l.status === 'quarantine').length;
  if (undecided > 0)
    out.push(`${undecided} line${undecided > 1 ? 's are' : ' is'} still in QC — finish QC on this receipt before rolling it back`);
  if (!lines.some(l => l.status === 'accepted'))
    out.push('Nothing on this GRN was accepted into stock — delete it instead of rolling it back');
  for (const l of lines.filter(x => x.status === 'accepted' && x.batchTouched))
    out.push(`Stock from ${l.material_name || 'a line on this GRN'} has already been used — it cannot be rolled back`);
  return out;
}

// ── Purchase-register value ──────────────────────────────────────────────────
// Gross of discount and tax, matching the SUM(pl.qty * pl.rate) convention the
// PO half of the register already uses, so the two halves are comparable.
//
// Rejected lines are excluded: that board went back to the supplier and was
// never a purchase. Quarantine lines ARE counted — they have arrived and been
// invoiced, and the register reports what was bought, not what has cleared QC.
export function grnRegisterValue(lines = []) {
  return round2(lines
    .filter(l => l.status !== 'rejected')
    .reduce((s, l) => s + (+l.qty || 0) * (+l.rate || 0), 0));
}

// ── Rate variance ────────────────────────────────────────────────────────────
// What the supplier invoiced minus what the PO ordered. Null when there is
// nothing to compare or the gap is inside money tolerance — the same 0.005 the
// PO form's RateProvenance uses before it calls a rate overridden.
export function rateVariance(received, ordered) {
  if (received == null || received === '' || ordered == null || ordered === '') return null;
  const d = round2(+received - +ordered);
  return Math.abs(d) > 0.005 ? d : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test server/src/grn-receipt.test.js
```

Expected: PASS, 20 tests, 0 failures.

- [ ] **Step 5: Run the whole suite to confirm nothing regressed**

```bash
npm test -w server
```

Expected: all files pass. Note the pre-change total so later tasks can compare.

- [ ] **Step 6: Commit**

```bash
git add server/src/grn-receipt.js server/src/grn-receipt.test.js
git commit -m "feat(grn): pure GRN document logic — derived status, batch numbering, guards, register value"
```

---

### Task 2: Per-batch stock valuation

**Files:**
- Modify: `client/src/lib/boardMath.js`
- Modify: `server/src/board-math.js` — **the twin**
- Test: `server/src/board-math.test.js`

> **Twin-module trap.** `board-math.test.js` asserts
> `deepEqual(Object.keys(client).sort(), Object.keys(server).sort())`. Adding
> `stockValueOf` to only one of the two files fails that parity test. Add the
> **identical** function to both — same rule as `searchKey.js` and its twin.

- [ ] **Step 1: Read the existing module and its test**

```bash
sed -n '1,40p' client/src/lib/boardMath.js && grep -n "^import" server/src/board-math.test.js
```

Note the export style and the null-on-incomplete-master convention — `stockValueOf` must follow it.

- [ ] **Step 2: Write the failing tests**

Append to `server/src/board-math.test.js`:

```js
// ── stockValueOf ──────────────────────────────────────────────────────
// Stock value is a PER-BATCH sum, not a blended rate: each batch is worth
// what was actually paid for it, and only quantity whose cost was never
// recorded falls back to the board master rate.
test('stock value: fully costed stock ignores the master rate entirely', () => {
  assert.equal(stockValueOf({ available: 100, costed_qty: 100, costed_value: 640 }, 99), 640);
});

test('stock value: mixes actual cost with the master rate for uncosted qty', () => {
  // 60 sheets cost 400 in reality; the other 40 have no recorded cost and
  // fall back to the master ₹6/sheet.
  assert.equal(stockValueOf({ available: 100, costed_qty: 60, costed_value: 400 }, 6), 640);
});

test('stock value: pre-migration stock with no costs reads exactly as before', () => {
  assert.equal(stockValueOf({ available: 100, costed_qty: 0, costed_value: 0 }, 6), 600);
});

test('stock value: unknown when uncosted qty has no master rate to fall back on', () => {
  assert.equal(stockValueOf({ available: 100, costed_qty: 0, costed_value: 0 }, null), null);
  assert.equal(stockValueOf({ available: 100, costed_qty: 60, costed_value: 400 }, null), null);
});

test('stock value: no stock is worth zero, not unknown', () => {
  assert.equal(stockValueOf({ available: 0, costed_qty: 0, costed_value: 0 }, null), 0);
});

test('stock value: costed qty above available is clamped, never negative', () => {
  assert.equal(stockValueOf({ available: 50, costed_qty: 80, costed_value: 500 }, 6), 500);
});

test('stock value: a missing row is worth zero, not a crash', () => {
  assert.equal(stockValueOf(undefined, 6), 0);
});
```

Add `stockValueOf` to that file's existing import from `boardMath.js`.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
node --test server/src/board-math.test.js
```

Expected: FAIL — `stockValueOf is not a function`.

- [ ] **Step 4: Write the implementation**

Append to `client/src/lib/boardMath.js`:

```js
// Value of the board on the floor. A PER-BATCH sum, not a blended rate: every
// batch is worth what was actually paid for it, and only the quantity whose
// cost was never recorded falls back to the grade's master ₹/sheet.
//
// `costed_qty` / `costed_value` come from /inventory/stock, which sums the
// available batches that carry a rate. Stock received before batch costing
// existed has costed_qty 0 and therefore reads exactly as it did before.
//
// Null (not 0) when uncosted quantity has no master rate to fall back on — an
// unrated board reads as unknown, never as free. Same rule as the rest of
// boardMath.
export function stockValueOf({ available = 0, costed_qty = 0, costed_value = 0 } = {}, ratePerSheetMaster = null) {
  const avail = +available || 0;
  if (avail <= 0) return 0;
  const costedQty = Math.min(Math.max(+costed_qty || 0, 0), avail);
  const uncosted = avail - costedQty;
  if (uncosted > 0 && ratePerSheetMaster == null) return null;
  return (+costed_value || 0) + uncosted * (+ratePerSheetMaster || 0);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --test server/src/board-math.test.js
```

Expected: PASS, including the 7 new tests.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/boardMath.js server/src/board-math.test.js
git commit -m "feat(inventory): stockValueOf — value stock per batch at actual cost, master rate as fallback"
```

---

## Phase 2 — Schema

> From here the app is broken until Task 14. Do not deploy mid-phase.

### Task 3: Migration 0014 and `init()`

**Files:**
- Create: `supabase/migrations/0015_grn_multi_line.sql`
- Modify: `server/src/db.js` (the `grns` CREATE TABLE at ~line 349, its ALTERs at ~1062-1074, the `stock_batches` CREATE TABLE, and the index block at ~1718)

- [ ] **Step 1: Back up the local database before touching it**

```bash
npm run db:backup
```

Expected: a new file under `backups/`. Confirm the target printed is **local**, not Supabase.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/0015_grn_multi_line.sql`:

```sql
-- 0014 — GRN becomes a multi-line priced document.
--
-- `grns` is RENAMED IN PLACE to grn_headers. That is the load-bearing choice:
-- ids are preserved, so every conversations thread, audit entry and
-- notification already pointing at a GRN id still resolves to the right
-- document. Nothing referencing a GRN needs remapping.
--
-- stock_movements are NOT migrated: they carry ref_type='grn', ref_id=<grn id>,
-- and those ids are header ids after the rename, so every existing row stays
-- correct. Line identity remains recoverable through batch_id.
BEGIN;

-- 1. Rename the table. Ids, FKs and sequences all follow it.
ALTER TABLE grns RENAME TO grn_headers;

-- 2. The lines table.
CREATE TABLE IF NOT EXISTS grn_lines (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grn_header_id  INTEGER NOT NULL REFERENCES grn_headers(id),
  po_line_id     INTEGER REFERENCES po_lines(id),
  material_id    INTEGER NOT NULL REFERENCES materials(id),
  qty            DOUBLE PRECISION NOT NULL,
  unit           TEXT,
  rate           DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount_pct   DOUBLE PRECISION NOT NULL DEFAULT 0,
  gst_rate       DOUBLE PRECISION NOT NULL DEFAULT 0,
  hsn_code       TEXT,
  batch_no       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'quarantine'
                 CHECK (status IN ('quarantine','accepted','rejected')),
  qc_at          TIMESTAMPTZ,
  qc_note        TEXT
);

-- 3. Extract exactly one line per existing header.
--    The LEFT JOIN po_lines is deliberate: every historic PO-backed receipt
--    inherits its PO rate and gains a value retroactively. Direct receipts
--    land at rate 0 — honestly unknown, not falsely free.
INSERT INTO grn_lines (grn_header_id, po_line_id, material_id, qty, unit,
                       rate, gst_rate, hsn_code, batch_no, status, qc_at, qc_note)
SELECT h.id, h.po_line_id, h.material_id, h.qty, m.unit,
       COALESCE(pl.rate, 0), COALESCE(m.gst_rate, 0), m.hsn_code,
       h.batch_no, h.status, h.qc_at, h.qc_note
FROM grn_headers h
JOIN materials m ON m.id = h.material_id
LEFT JOIN po_lines pl ON pl.id = h.po_line_id;

-- 4. Repoint stock batches at the line, through the 1:1 mapping step 3 created.
ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS grn_line_id INTEGER REFERENCES grn_lines(id);
UPDATE stock_batches sb
   SET grn_line_id = gl.id
  FROM grn_lines gl
 WHERE gl.grn_header_id = sb.grn_id;

-- 5. Batch landed cost. Backfilled where the line knows a rate; left NULL
--    otherwise, which is what a pre-costing direct batch honestly is.
ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS rate DOUBLE PRECISION;
UPDATE stock_batches sb
   SET rate = gl.rate
  FROM grn_lines gl
 WHERE gl.id = sb.grn_line_id AND gl.rate > 0;

ALTER TABLE stock_batches DROP COLUMN IF EXISTS grn_id;

-- 6. Header gains its document-level money fields and sheds the per-board ones.
ALTER TABLE grn_headers ADD COLUMN IF NOT EXISTS tax_kind TEXT NOT NULL DEFAULT 'intra';
ALTER TABLE grn_headers ADD COLUMN IF NOT EXISTS freight DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE grn_headers ADD COLUMN IF NOT EXISTS round_off DOUBLE PRECISION;

ALTER TABLE grn_headers DROP COLUMN IF EXISTS po_line_id;
ALTER TABLE grn_headers DROP COLUMN IF EXISTS material_id;
ALTER TABLE grn_headers DROP COLUMN IF EXISTS qty;
ALTER TABLE grn_headers DROP COLUMN IF EXISTS batch_no;
ALTER TABLE grn_headers DROP COLUMN IF EXISTS status;
ALTER TABLE grn_headers DROP COLUMN IF EXISTS qc_at;
ALTER TABLE grn_headers DROP COLUMN IF EXISTS qc_note;

-- 7. Indexes.
CREATE INDEX IF NOT EXISTS idx_fk_grn_lines_header_id   ON grn_lines (grn_header_id);
CREATE INDEX IF NOT EXISTS idx_fk_grn_lines_material_id ON grn_lines (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_grn_lines_po_line_id  ON grn_lines (po_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_stock_batches_grn_line_id ON stock_batches (grn_line_id);

COMMIT;
```

- [ ] **Step 3: Update `init()` in `server/src/db.js` to create the final shape**

`init()` builds fresh databases; it must produce what the migration leaves behind, or `npm run db:check -- --baseline` fails. Make these **exact-string** edits — other sessions have this file open.

Replace the `grns` CREATE TABLE block:

```sql
CREATE TABLE IF NOT EXISTS grn_headers (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grn_number TEXT NOT NULL UNIQUE,
  purchase_order_id INTEGER REFERENCES purchase_orders(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grn_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grn_header_id INTEGER NOT NULL REFERENCES grn_headers(id),
  po_line_id INTEGER REFERENCES po_lines(id),
  material_id INTEGER NOT NULL REFERENCES materials(id),
  qty DOUBLE PRECISION NOT NULL,
  unit TEXT,
  rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  gst_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  hsn_code TEXT,
  batch_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'quarantine' CHECK (status IN ('quarantine','accepted','rejected')),
  qc_at TIMESTAMPTZ, qc_note TEXT
);
```

There are nine `ALTER TABLE grns …` statements at ~1062-1074. Rename seven of
them to `ALTER TABLE grn_headers …` (`vehicle_no`, `supplier_invoice_no`,
`supplier_invoice_date`, `received_by`, `remarks`, `vendor_id`, `source`) and
**delete** the two `ALTER COLUMN … DROP NOT NULL` lines for
`purchase_order_id`/`po_line_id` — the new CREATE already allows null, and
`po_line_id` no longer exists on the header. Then add:

```sql
ALTER TABLE grn_headers ADD COLUMN IF NOT EXISTS tax_kind TEXT NOT NULL DEFAULT 'intra';
ALTER TABLE grn_headers ADD COLUMN IF NOT EXISTS freight DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE grn_headers ADD COLUMN IF NOT EXISTS round_off DOUBLE PRECISION;
ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS rate DOUBLE PRECISION;
```

In `stock_batches`, change `grn_id INTEGER` to `grn_line_id INTEGER`. Replace the four `idx_fk_grns_*` indexes at ~1718 with the four from the migration.

**Every statement must be idempotent and ordered after the table it touches** — this repo has been bitten before by `ALTER TABLE tools` running 100 lines before `CREATE TABLE tools`.

- [ ] **Step 4: Prove both paths to the schema converge**

**Do not run `npm run db:check -- --baseline`.** `scripts/db-check.mjs:17`
hardcodes `LOCAL = postgresql://…/cierp` — the *shared* database, which this
work must never touch and which will still hold the pre-migration schema. That
check would report drift for the wrong reason.

The real proof is that the two routes to the final schema agree:

- **Path A** — a fresh database built from the regenerated
  `0001_baseline_schema.sql` (what a new environment gets).
- **Path B** — an existing pre-migration database with `0014` applied (what
  production gets).

Regenerate the baseline, replay Path A into a scratch database, apply Path B to
`cierp_grn`, then diff the two `information_schema` column signatures. They must
be identical. A mismatch means `init()` and the migration have diverged, which
is exactly the bug that would ship a broken production migration.

```bash
npm run db:baseline && node scripts/build-baseline.mjs --check
```

If the replay fails on ordering, move the offending `ALTER` below its `CREATE` —
this repo has been bitten by that before.

- [ ] **Step 5: Apply the migration to the local database and verify the row counts**

Record the pre-migration count first, then apply and compare — `grn_lines` must equal the old `grns` count **exactly**.

```bash
node -e "import('./server/src/db.js').then(async d=>{await d.connect();console.log(await d.q('SELECT (SELECT COUNT(*) FROM grn_headers) headers,(SELECT COUNT(*) FROM grn_lines) lines,(SELECT COUNT(*) FROM stock_batches WHERE grn_line_id IS NOT NULL) batches'));process.exit(0)})"
```

Expected: `headers === lines`, and `batches` equal to the pre-migration count of batches with a `grn_id`.

- [ ] **Step 6: Commit**

```bash
git status --short --branch
git add supabase/migrations/0015_grn_multi_line.sql server/src/db.js supabase/migrations/0001_baseline_schema.sql
git commit -m "feat(grn): migration 0014 — grns becomes grn_headers + grn_lines, batches carry landed cost"
```

Stage nothing else. `db.js` carries another session's changes — confirm the diff you are staging is only yours before committing.

---

## Phase 3 — Server

### Task 4: GRN write paths

**Files:**
- Modify: `server/src/routes/procurement.js:685-791` (`POST /grns`, `/grns/direct`, `/grns/bulk`)

- [ ] **Step 1: Add a shared receipt writer**

Above the routes, add one function all three endpoints call, so there is a single write path:

```js
import { grnBatchNo, grnHeaderStatus, grnEditBlockers, grnDeleteBlockers,
         grnRollbackBlockers } from '../grn-receipt.js';

// Write one receipt: a header, its priced lines, a quarantine batch per line
// and the ledger row for each. Shared by the direct, bulk and single-line
// endpoints so a receipt is created exactly one way.
async function writeReceipt(qc, oc, { source, purchase_order_id = null, vendor_id = null,
                                      tax_kind = 'intra', freight = 0, round_off = null,
                                      vehicle_no, supplier_invoice_no, supplier_invoice_date,
                                      received_by, remarks, lines }, userName) {
  const grn_number = await nextNumber('CI-GRN-', 'grn_headers', 'grn_number', oc);
  const [h] = await qc(
    `INSERT INTO grn_headers (grn_number, purchase_order_id, vendor_id, source, tax_kind,
                              freight, round_off, vehicle_no, supplier_invoice_no,
                              supplier_invoice_date, received_by, remarks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [grn_number, purchase_order_id, vendor_id, source, tax_kind,
     +freight || 0, round_off === '' || round_off == null ? null : +round_off,
     vehicle_no || null, supplier_invoice_no || null, supplier_invoice_date || null,
     received_by || userName, remarks || null]);

  for (const [i, l] of lines.entries()) {
    const mat = await oc('SELECT unit, leftover, name, gst_rate, hsn_code FROM materials WHERE id=$1', [l.material_id]);
    if (!mat) throw Object.assign(new Error('Material not found'), { status: 404 });
    if (mat.leftover) throw Object.assign(new Error(`${mat.name} is a leftover offcut — receive a fresh material`), { status: 409 });
    const bno = grnBatchNo(grn_number, i, l.batch_no);
    const [gl] = await qc(
      `INSERT INTO grn_lines (grn_header_id, po_line_id, material_id, qty, unit, rate,
                              discount_pct, gst_rate, hsn_code, batch_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [h.id, l.po_line_id || null, +l.material_id, +l.qty, l.unit || mat.unit,
       +l.rate || 0, +l.discount_pct || 0,
       l.gst_rate == null || l.gst_rate === '' ? (+mat.gst_rate || 0) : +l.gst_rate,
       l.hsn_code || mat.hsn_code || null, bno]);
    const [b] = await qc(
      `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_line_id, rate)
       VALUES ($1,$2,$3,$3,$4,'quarantine',$5,$6) RETURNING id`,
      [+l.material_id, bno, +l.qty, l.unit || mat.unit, gl.id, +l.rate > 0 ? +l.rate : null]);
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,$2,'grn',$3,'grn',$4,$5)`,
      [+l.material_id, b.id, +l.qty, h.id,
       `GRN ${grn_number}${source === 'direct' ? ' (direct, quarantine)' : ' (quarantine)'}`]);
  }
  await audit('grn', h.id, source === 'direct' ? 'receive_direct' : 'receive',
    `${grn_number} — ${lines.length} line${lines.length > 1 ? 's' : ''}`, qc, userName);
  return h.id;
}
```

`ref_id` is the **header** id, matching every pre-existing `stock_movements` row.

- [ ] **Step 2: Rewrite `POST /grns/direct`**

```js
r.post('/grns/direct', canBuy, async (req, res, next) => {
  try {
    const { vendor_id, tax_kind, freight, round_off, lines, ...meta } = req.body;
    const rows = (lines || []).filter(l => l.material_id && +l.qty > 0);
    if (!rows.length) return res.status(400).json({ error: 'At least one board with a positive quantity is required' });
    const id = await tx((qc, oc) => writeReceipt(qc, oc, {
      source: 'direct', vendor_id: vendor_id ? +vendor_id : null,
      tax_kind: tax_kind || 'intra', freight, round_off, lines: rows, ...meta,
    }, req.user.name));
    res.json(await one('SELECT * FROM grn_headers WHERE id=$1', [id]));
  } catch (e) { next(e); }
});
```

- [ ] **Step 3: Rewrite `POST /grns/bulk`, carrying the editable rate**

```js
r.post('/grns/bulk', canBuy, async (req, res, next) => {
  try {
    const { purchase_order_id, tax_kind, freight, round_off, lines, ...meta } = req.body;
    const rows = (lines || []).filter(l => +l.qty > 0);
    if (!purchase_order_id || !rows.length)
      return res.status(400).json({ error: 'PO and at least one received quantity are required' });
    const id = await tx(async (qc, oc) => {
      const po = await oc('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [purchase_order_id]);
      if (!po) throw Object.assign(new Error('PO not found'), { status: 404 });
      if (po.status === 'closed') throw Object.assign(new Error('PO is closed'), { status: 409 });
      const resolved = [];
      for (const l of rows) {
        const pl = await oc('SELECT * FROM po_lines WHERE id=$1 AND purchase_order_id=$2', [l.po_line_id, po.id]);
        if (!pl) throw Object.assign(new Error('PO line not found on this PO'), { status: 404 });
        // The buyer may override the PO rate at receipt (supplier invoiced
        // differently). The PO keeps its ordered rate; the GRN records what
        // actually arrived. Fall back to the PO rate when nothing was typed.
        resolved.push({ ...l, material_id: pl.material_id, po_line_id: pl.id,
                        rate: l.rate == null || l.rate === '' ? pl.rate : +l.rate });
      }
      return writeReceipt(qc, oc, {
        source: 'po', purchase_order_id: po.id, vendor_id: po.vendor_id,
        tax_kind: tax_kind || 'intra', freight, round_off, lines: resolved, ...meta,
      }, req.user.name);
    });
    res.json({ ok: true, grn_id: id });
  } catch (e) { next(e); }
});
```

- [ ] **Step 4: Reimplement `POST /grns` as a one-line bulk**

```js
// Single PO line — kept for compatibility, one write path underneath.
r.post('/grns', canBuy, async (req, res, next) => {
  try {
    const { po_line_id, qty, batch_no, rate, ...meta } = req.body;
    if (!po_line_id || !qty) return res.status(400).json({ error: 'PO line and quantity are required' });
    const id = await tx(async (qc, oc) => {
      const pl = await oc('SELECT * FROM po_lines WHERE id=$1', [po_line_id]);
      if (!pl) throw Object.assign(new Error('PO line not found'), { status: 404 });
      const po = await oc('SELECT * FROM purchase_orders WHERE id=$1', [pl.purchase_order_id]);
      return writeReceipt(qc, oc, {
        source: 'po', purchase_order_id: pl.purchase_order_id, vendor_id: po?.vendor_id ?? null,
        lines: [{ po_line_id: pl.id, material_id: pl.material_id, qty: +qty, batch_no,
                  rate: rate == null || rate === '' ? pl.rate : +rate }],
        ...meta,
      }, req.user.name);
    });
    res.json(await one('SELECT * FROM grn_headers WHERE id=$1', [id]));
  } catch (e) { next(e); }
});
```

- [ ] **Step 5: Verify the server boots and a 3-line direct receipt writes correctly**

Start the dev server on a spare port (another session may own :4000), POST a 3-line direct GRN, then assert 1 header, 3 lines, 3 batches with `-B1 -B2 -B3`, and 3 movements pointing at the header id.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/procurement.js
git commit -m "feat(grn): one write path for direct, bulk and single-line receipts"
```

---

### Task 5: Per-line QC and Accept All

**Files:**
- Modify: `server/src/routes/procurement.js:958-1014`

- [ ] **Step 1: Extract the QC body into a per-line function**

The existing `/grns/:id/qc` body moves down a level unchanged in substance. `material_id`, `qty` and `po_line_id` now come from the **line**; `purchase_order_id` from its header.

```js
// Decide ONE line. Everything this does is already per-material and therefore
// already per-line — in particular the board_allocations shrink, which is keyed
// on material_id and would over-consume if a multi-board receipt credited
// allocations once for the whole header.
async function qcLine(qc, oc, lineId, accept, note, userName) {
  const l = await oc('SELECT * FROM grn_lines WHERE id=$1 FOR UPDATE', [lineId]);
  if (!l) throw Object.assign(new Error('GRN line not found'), { status: 404 });
  if (l.status !== 'quarantine') throw Object.assign(new Error('This line is already QC-decided'), { status: 409 });
  const h = await oc('SELECT * FROM grn_headers WHERE id=$1', [l.grn_header_id]);
  const batch = await oc('SELECT * FROM stock_batches WHERE grn_line_id=$1', [l.id]);

  if (accept) {
    await qc(`UPDATE stock_batches SET status='available' WHERE id=$1`, [batch.id]);
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,$2,'qc_release',0,'grn',$3,$4)`,
      [l.material_id, batch.id, h.id, note || 'QC accepted — released to stock']);
    if (l.po_line_id) {
      await qc('UPDATE po_lines SET received_qty = received_qty + $1 WHERE id=$2', [l.qty, l.po_line_id]);
      const lines = await qc('SELECT qty, received_qty FROM po_lines WHERE purchase_order_id=$1', [h.purchase_order_id]);
      const full = lines.every(x => x.received_qty >= x.qty);
      const some = lines.some(x => x.received_qty > 0);
      await qc('UPDATE purchase_orders SET status=$1 WHERE id=$2',
        [full ? 'received' : some ? 'partially_received' : 'open', h.purchase_order_id]);
    }
    if (h.purchase_order_id) {
      const alloc = await qc(
        `SELECT a.id, a.qty FROM board_allocations a
         JOIN requisitions rq ON rq.id = a.requisition_id
         WHERE a.status='active' AND a.source='requisition'
           AND a.material_id=$1 AND rq.purchase_order_id=$2
         ORDER BY a.id`, [l.material_id, h.purchase_order_id]);
      let landed = Number(l.qty);
      for (const a of alloc) {
        if (landed <= 0) break;
        const cut = Math.min(Number(a.qty), landed);
        const left = Number(a.qty) - cut;
        if (left > 0) await qc('UPDATE board_allocations SET qty=$1 WHERE id=$2', [left, a.id]);
        else await qc(`UPDATE board_allocations SET status='consumed', released_at=now() WHERE id=$1`, [a.id]);
        landed -= cut;
      }
    }
    await qc(`UPDATE grn_lines SET status='accepted', qc_at=now(), qc_note=$1 WHERE id=$2`, [note || null, l.id]);
  } else {
    await qc(`UPDATE stock_batches SET status='rejected' WHERE id=$1`, [batch.id]);
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,$2,'qc_reject',$3,'grn',$4,$5)`,
      [l.material_id, batch.id, -l.qty, h.id, note || 'QC rejected']);
    await qc(`UPDATE grn_lines SET status='rejected', qc_at=now(), qc_note=$1 WHERE id=$2`, [note || null, l.id]);
  }
  await audit('grn', h.id, accept ? 'qc_accept' : 'qc_reject',
    `${h.grn_number} line ${l.batch_no}: ${note || (accept ? 'accepted' : 'rejected')}`, qc, userName);
}
```

- [ ] **Step 2: Replace the route with the per-line and Accept-All endpoints**

```js
r.post('/grn-lines/:id/qc', canQc, async (req, res, next) => {
  try {
    const { accept, note } = req.body;
    await tx((qc, oc) => qcLine(qc, oc, req.params.id, accept, note, req.user.name));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Accept All — a convenience over the per-line path, not a second
// implementation of it. Already-decided lines are left alone.
r.post('/grns/:id/qc-all', canQc, async (req, res, next) => {
  try {
    const { accept, note } = req.body;
    const n = await tx(async (qc, oc) => {
      const pending = await qc(`SELECT id FROM grn_lines WHERE grn_header_id=$1 AND status='quarantine' ORDER BY id`, [req.params.id]);
      for (const l of pending) await qcLine(qc, oc, l.id, accept, note, req.user.name);
      return pending.length;
    });
    res.json({ ok: true, decided: n });
  } catch (e) { next(e); }
});
```

- [ ] **Step 3: Verify a mixed decision**

On a 3-line receipt: accept line 1, reject line 2, leave line 3. Assert line 1's batch is `available`, line 2's is `rejected`, line 3's is `quarantine`, that only line 1 credited `po_lines.received_qty`, and that `grnHeaderStatus` over the three reads `part_qc`.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/procurement.js
git commit -m "feat(grn): per-line QC with an Accept All shortcut"
```

---

### Task 6: Edit, delete and rollback

**Files:**
- Modify: `server/src/routes/procurement.js:796-884`

> **Defect found in Task 5 — do not reuse the old movement-delete statement.**
> `stock_movements` rows carry `ref_type='grn', ref_id=<header id>` deliberately,
> so that every pre-existing production row stayed correct through the rename.
> That makes
> `DELETE FROM stock_movements WHERE ref_type='grn' AND ref_id=$1`
> **sweep every line's movements on the whole receipt** — catastrophic for a
> per-line reversal. Two lines of the same material on one header are
> indistinguishable in `stock_movements` except by `batch_id`. Per-line
> reversal must therefore delete by `batch_id`, resolved through
> `stock_batches.grn_line_id`. Only a whole-header teardown may delete by
> `ref_id`, and only after every line's batch has been handled.

- [ ] **Step 1: Rewrite the three routes against the guards from Task 1**

Each gathers line state, calls its pure guard, and throws the first blocker as a 409:

```js
// Gather what the guards need: line status plus whether its batch has been
// consumed or otherwise touched.
// Parameter order is (qc, oc) to match tx(fn) everywhere else in this file —
// swapping them silently passes the single-row helper where the many-row one
// is expected, and the SELECT then returns one line instead of all of them.
async function receiptLines(qc, oc, headerId) {
  const lines = await qc(
    `SELECT gl.*, m.name AS material_name, sb.id AS batch_id, sb.status AS batch_status,
            sb.qty AS batch_qty, sb.initial_qty AS batch_initial_qty
     FROM grn_lines gl
     JOIN materials m ON m.id = gl.material_id
     LEFT JOIN stock_batches sb ON sb.grn_line_id = gl.id
     WHERE gl.grn_header_id=$1 ORDER BY gl.id`, [headerId]);
  for (const l of lines) {
    l.batchConsumed = l.batch_id ? await batchConsumed(oc, l.batch_id) : false;
    l.batchTouched = l.batch_id
      ? (l.batch_status !== 'available' || +l.batch_qty !== +l.batch_initial_qty || l.batchConsumed)
      : false;
  }
  return lines;
}
```

`PUT /grns/:id` — header meta plus per-line `qty`, `rate`, `discount_pct`, `gst_rate`, `hsn_code`, `batch_no`. **Lines cannot be added or removed.** Guard with `grnEditBlockers`. Keep each line's batch and movement in step, as the old single-line edit did:

```js
await qc('UPDATE stock_batches SET qty=$1, initial_qty=$1, batch_no=$2, rate=$3 WHERE grn_line_id=$4',
  [newQty, newBatch, +newRate > 0 ? +newRate : null, l.id]);
await qc(`UPDATE stock_movements SET qty=$1 WHERE batch_id=$2 AND type='grn'`, [newQty, l.batch_id]);
```

`DELETE /grns/:id` — guard with `grnDeleteBlockers`, then delete movements, batches, lines, header.

`POST /grns/:id/rollback` — guard with `grnRollbackBlockers`, then per accepted line reverse `received_qty` and drop its released batch; re-derive PO status **once** at the end; delete the header.

- [ ] **Step 2: Verify each guard fires**

Confirm: edit refused once one line is decided; delete refused with an accepted line and the message points at rollback; rollback refused while a line is still in quarantine.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/procurement.js
git commit -m "feat(grn): header-scoped edit, delete and rollback behind pure guards"
```

---

### Task 7: Read paths and the four outside call sites

**Files:**
- Modify: `server/src/routes/procurement.js` (`GET /grns` at 671, and lines 479, 486, 545, 575, 634, 905)
- Modify: `server/src/routes/master-history.js:289,314`
- Modify: `server/src/routes/timeline.js:71`
- Modify: `server/src/seed.js:352`

- [ ] **Step 1: Rewrite `GET /grns` to return one row per line**

```js
r.get('/grns', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT gl.id AS line_id, gl.qty, gl.unit, gl.rate, gl.discount_pct, gl.gst_rate,
             gl.hsn_code, gl.batch_no, gl.status, gl.qc_at, gl.qc_note,
             (gl.qty * gl.rate) AS amount,
             h.id, h.grn_number, h.source, h.received_at, h.received_by, h.remarks,
             h.vehicle_no, h.supplier_invoice_no, h.supplier_invoice_date,
             h.tax_kind, h.freight, h.round_off,
             m.name AS material_name, po.po_number, pl.rate AS po_rate,
             COALESCE(pv.name, dv.name) AS vendor_name
      FROM grn_lines gl
      JOIN grn_headers h ON h.id = gl.grn_header_id
      JOIN materials m ON m.id = gl.material_id
      LEFT JOIN po_lines pl ON pl.id = gl.po_line_id
      LEFT JOIN purchase_orders po ON po.id = h.purchase_order_id
      LEFT JOIN vendors pv ON pv.id = po.vendor_id
      LEFT JOIN vendors dv ON dv.id = h.vendor_id
      ORDER BY h.id DESC, gl.id`));
  } catch (e) { next(e); }
});
```

`h.id` is kept as `id` so the thread column and audit links keep working unchanged.

- [ ] **Step 2: Repoint the six PO sub-selects in `procurement.js`**

Each joins through `grn_lines` now. For example line 575:

```js
const grnRows = await qc(
  `SELECT gl.po_line_id, COALESCE(SUM(gl.qty),0)::float AS grn_qty
   FROM grn_lines gl JOIN grn_headers h ON h.id = gl.grn_header_id
   WHERE h.purchase_order_id=$1 GROUP BY gl.po_line_id`, [po.id]);
```

Apply the same shape to 479 (`grn_count`), 486 (`grn_qty`), 545 (quarantine count — now `gl.status='quarantine'`), 634 (delete guard), 905 (`last_grn_at`).

- [ ] **Step 3: Fix the three files outside `procurement.js`**

`master-history.js` — `material_id` lives on the line now, so both the receipt query (289) and the audit join (314) go through `grn_lines`:

```sql
OR (a.entity='grn' AND a.entity_id IN (
      SELECT gl.grn_header_id FROM grn_lines gl WHERE gl.material_id=$1))
```

`timeline.js:71` — the header has no `material_id`; aggregate its line materials:

```js
`SELECT h.id, h.grn_number,
        STRING_AGG(DISTINCT m.name, ', ') AS material_name
 FROM grn_headers h
 JOIN grn_lines gl ON gl.grn_header_id = h.id
 JOIN materials m ON m.id = gl.material_id
 WHERE h.id = ANY($1) GROUP BY h.id`
```

`seed.js:352` — seed a header, then one line, then the batch against `grn_line_id`.

- [ ] **Step 4: Grep for stragglers**

```bash
grep -rn "FROM grns\|INTO grns\|UPDATE grns\|DELETE FROM grns\|JOIN grns\|grn_id" server/src scripts
```

Expected: only route paths (`/grns`) and JS identifiers — **no SQL table references.**

> **Use `grep -rnw "grns"`, not a pattern list of SQL verbs.** A pattern list
> missed a live crash during Task 7: `seed.js:7` carried `'grns'` in a bare
> `TABLES` array used for `TRUNCATE`, with no SQL verb adjacent to match on.
> The seeder died on its first statement. The rename means the build cannot
> catch a miss — a missed site fails at runtime, so the sweep must be the
> word, not the grammar around it.

- [ ] **Step 5: Run the suite and commit**

```bash
npm test -w server
git add server/src/routes/procurement.js server/src/routes/master-history.js server/src/routes/timeline.js server/src/seed.js
git commit -m "feat(grn): read paths and all downstream call sites follow the two-table model"
```

---

### Task 8: Direct receipts in the purchase register

**Files:**
- Modify: `server/src/routes/billing.js:503-533`

- [ ] **Step 1: Add direct receipts to `purchases` and `purchaseMonthly`**

Only `source='direct'` rows are added — PO-backed receipts are already counted through their PO, so nothing double-counts. Rejected lines are excluded; quarantine lines are counted.

```sql
SELECT h.id, h.grn_number AS po_number, h.received_at AS created_at,
       'direct_receipt' AS status,
       v.id AS vendor_id, COALESCE(v.name, 'Unknown supplier') AS vendor_name, v.city,
       COUNT(gl.id)::int AS line_count,
       COALESCE(SUM(gl.qty),0) AS ordered_qty,
       COALESCE(SUM(gl.qty) FILTER (WHERE gl.status='accepted'),0) AS received_qty,
       COALESCE(SUM(gl.qty * gl.rate),0) AS value,
       STRING_AGG(DISTINCT m.category, ', ') AS categories
FROM grn_headers h
JOIN grn_lines gl ON gl.grn_header_id = h.id AND gl.status <> 'rejected'
JOIN materials m ON m.id = gl.material_id
LEFT JOIN vendors v ON v.id = h.vendor_id
WHERE h.source = 'direct'
  AND ($1::date IS NULL OR h.received_at::date >= $1::date)
  AND ($2::date IS NULL OR h.received_at::date <= $2::date)
GROUP BY h.id, v.id
```

UNION this with the existing PO query and keep `ORDER BY created_at DESC`. Give `purchaseMonthly` the same treatment, grouping on `to_char(h.received_at,'YYYY-MM')`.

- [ ] **Step 2: Label direct rows in Accounts**

In the purchases table, render `status === 'direct_receipt'` as an amber `Direct · No PO` chip, matching the badge the GRN register already uses.

- [ ] **Step 3: Verify no double-count**

Create a PO, receive it fully, and confirm the register total moves by the PO's value **once**. Then create a direct receipt and confirm it moves by that receipt's value.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/billing.js client/src/pages/Accounts.jsx
git commit -m "feat(accounts): direct GRN receipts count as purchases in the register"
```

---

### Task 9: Costed quantity on `/inventory/stock`

**Files:**
- Modify: `server/src/routes/inventory.js:12-41`

- [ ] **Step 1: Add the costed roll-up**

Add a LEFT JOIN beside the existing `av` aggregate. Only available batches that carry a rate contribute:

```sql
LEFT JOIN (
  SELECT material_id,
         SUM(qty) AS q,
         SUM(qty * rate) AS v
  FROM stock_batches
  WHERE status='available' AND rate IS NOT NULL
  GROUP BY material_id
) cost ON cost.material_id = m.id
```

and select `COALESCE(cost.q,0) AS costed_qty, COALESCE(cost.v,0) AS costed_value`.

- [ ] **Step 2: Verify the shape**

`GET /inventory/stock` returns `costed_qty` and `costed_value` on every row, both 0 for material received before this feature.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/inventory.js
git commit -m "feat(inventory): expose costed batch quantity and value per material"
```

---

## Phase 4 — Client

### Task 10: `GrnLineEditor`

**Files:**
- Create: `client/src/components/GrnForms.jsx`
- Modify: `client/src/components/ProcurementForms.jsx` (add exports only)

- [ ] **Step 1: Export the shared line-card primitives**

In `ProcurementForms.jsx` add `export` to `LineNo`, `NumField`, `IconBtn`, `BoardSpec`, `RateProvenance`, `StockStrip`, `miniInput` and `fillFromMaterial`. **Change nothing else in that file** — it is under concurrent edit.

- [ ] **Step 2: Write `GrnForms.jsx`**

One editor, two modes, built from `PoLineEditor`'s two-tier card so both documents read identically.

- **`mode="direct"`** — `MaterialPicker`, then HSN / Qty / UOM / Rate / Disc % / GST % / Batch No. Add line, Clone, Remove, and the derived packets / kg-per-sheet / total-kg strip exactly as a PO line has.
- **`mode="po"`** — board fixed from the PO line and not pickable; Ordered and Balance read-only; `Receive Now` in place of Qty; the PO's rate pre-filled and **editable**; Disc % / GST % / Batch No.

The variance chip uses the same pure function the server does:

```jsx
import { rateVariance } from '../../../server/src/grn-receipt.js';
// …
{mode === 'po' && rateVariance(l.rate, l.po_rate) != null && (
  <div className="mt-0.5 text-[10px] font-semibold text-amber-600">
    PO rate ₹{(+l.po_rate).toFixed(2)}
  </div>
)}
```

If that cross-package import is awkward under Vite, copy `rateVariance` into `client/src/lib/poTotals.js` and import it from there in **both** places — one definition, never two.

- [ ] **Step 3: Verify in the running app**

Open Create GRN, add three lines on the Direct tab, confirm each line's Amount and the totals panel agree with the PO form's arithmetic.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/GrnForms.jsx client/src/components/ProcurementForms.jsx
git commit -m "feat(grn): GrnLineEditor — priced receipt lines for both tabs"
```

---

### Task 11: Create GRN modal

**Files:**
- Modify: `client/src/pages/Procurement.jsx:1431-1522` and `createNewGrn` at 496-515

- [ ] **Step 1: Replace both tab bodies**

Each tab becomes: `GrnLineEditor` → `PoTotalsPanel` → `TaxKindToggle` → `GrnMetaFields`. `PoTotalsPanel`, `TaxKindToggle` and `lib/poTotals.js` are used **verbatim and unmodified**.

The blank form gains lines and document money:

```js
const blankGrnLine = () => ({ material_id: '', qty: '', rate: '', hsn_code: '',
  unit: '', discount_pct: '', gst_rate: '', batch_no: '' });
const newGrnForm = () => ({ mode: 'direct', po_id: '', vendor_id: '',
  tax_kind: 'intra', freight: '', round_off: '', lines: [blankGrnLine()],
  vehicle_no: '', supplier_invoice_no: '', supplier_invoice_date: '',
  received_by: auth.user()?.name || '', remarks: '' });
```

Default `tax_kind` from `taxKindFor(company, vendor)` when a supplier is picked, exactly as the PO forms do.

- [ ] **Step 2: Rewrite `createNewGrn` to post the new shapes**

Both modes now send `lines` plus `tax_kind`, `freight`, `round_off`. Enable the footer button when any line has a material and a positive qty (direct), or any line has a positive `receive_qty` (PO).

> **Contract changes made in Task 4 — the old client calls will break:**
> - `POST /grns/direct` now **requires** `{ lines: [...] }`. The old
>   `{ material_id, qty, batch_no }` body returns 400.
> - `POST /grns/bulk` now returns `{ ok: true, grn_id: N }` — a single id.
>   It used to return `{ ok: true, grn_ids: [...] }`. Any caller reading
>   `grn_ids` gets `undefined`.
> - Only `vehicle_no`, `supplier_invoice_no`, `supplier_invoice_date`,
>   `received_by` and `remarks` are accepted from the body. `source`,
>   `purchase_order_id`, `vendor_id` and `lines` are server-derived and
>   silently ignored if sent — do not try to set them from the form.

- [ ] **Step 3: Verify end to end**

Book a 3-board direct receipt and confirm one GRN number appears in the register with three lines under it. Book a PO receipt with an edited rate and confirm the PO's own rate is unchanged.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Procurement.jsx
git commit -m "feat(grn): multi-line Create GRN modal with rates, tax and totals"
```

---

### Task 12: GRN register and QC UI

**Files:**
- Modify: `client/src/pages/Procurement.jsx` (GRN tab, ~line 800-850)
- Modify: `client/src/components/ui.jsx` (`STATUS_COLOURS`, ~line 312-334)

- [ ] **Step 1: Add the two new status tones**

```js
  part_qc: 'bg-amber-50 text-amber-700',
  partly_accepted: 'bg-orange-100 text-orange-700',
```

- [ ] **Step 2: Group line rows under their GRN**

```jsx
<DataTable searchable groupBy={g => g.grn_number} … />
```

Add Rate and Amount columns. The Qty column keeps `fmt.num(g.qty)` + unit. The status column shows the **line** status; the group's header row shows `grnHeaderStatus` of its lines.

- [ ] **Step 3: Wire the QC actions**

QC Decision per `quarantine` line → `POST /grn-lines/:line_id/qc`. In the GRN's `ActionMenu`: **Accept All** → `POST /grns/:id/qc-all`, plus Print, Edit, Roll back and Delete, each enabled per the guards from Task 6.

- [ ] **Step 4: Verify and commit**

Confirm a mixed receipt shows three line rows under one GRN number with the right chips, and Accept All decides only the pending ones.

```bash
git add client/src/pages/Procurement.jsx client/src/components/ui.jsx
git commit -m "feat(grn): register groups lines under their GRN, per-line QC plus Accept All"
```

---

### Task 13: Warehouse stock value

**Files:**
- Modify: `client/src/pages/Inventory.jsx:80-85,116-119`

- [ ] **Step 1: Use the pure function from Task 2**

```js
import { kgPerSheet, packets, packetWeight, ratePerSheet, stockValueOf } from '../lib/boardMath.js';

const stockValue = (m, rates) => stockValueOf(m, ratePerSheet(m, rateKgOf(m, rates)));
```

The `stock_value` column body is unchanged — it already renders `null` as an em-dash.

- [ ] **Step 2: Verify**

A board with only pre-migration batches must show **exactly** the value it showed before. A board received through the new form shows its actual paid value.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Inventory.jsx
git commit -m "feat(inventory): stock value uses actual batch cost with master-rate fallback"
```

---

### Task 14: GRN receipt print

**Files:**
- Create: `client/src/pages/GrnPrint.jsx`
- Modify: the router (wherever `POPrint` is registered) to add `/grn/:id/print`

- [ ] **Step 1: Read `POPrint.jsx` end to end**

```bash
sed -n '1,257p' client/src/pages/POPrint.jsx
```

Copy its structure, its A4 `@page` print CSS and its company-header block. Do not invent a second print style.

- [ ] **Step 2: Write `GrnPrint.jsx`**

Company header · GRN number and received date · supplier with GSTIN · vehicle, supplier invoice no/date · line table (HSN / board / qty / unit / rate / disc % / GST % / amount) · GST breakup, freight, round-off, grand total from `poTotals` · `rupeesInWords` · received-by signature block. Against-PO receipts also print their PO number.

- [ ] **Step 3: Verify and commit**

Print a 3-line receipt; confirm the grand total matches the modal exactly and it fits one A4 page.

```bash
git add client/src/pages/GrnPrint.jsx client/src/App.jsx
git commit -m "feat(grn): printable A4 goods-receipt document"
```

---

## Phase 5 — Verification and release

### Task 15: Full verification

- [ ] **Step 1: Run the gate**

```bash
npm run verify
```

Expected: baseline fresh, all server tests pass, client builds. A stale baseline fails here — rerun `npm run db:baseline` if so.

- [ ] **Step 2: Replay the baseline into an empty database**

```bash
npm run db:check -- --baseline
```

- [ ] **Step 3: Exercise the whole Procurement page against the migrated local database**

Every path, because the rename means the build cannot catch a missed call site: PR → PO → the PO register → Create GRN on both tabs → per-line QC → Accept All → Edit → Delete → Roll back → Pendency → the GRN thread drawer → the timeline drawer → Accounts registers → Warehouse stock value → the print.

- [ ] **Step 4: Confirm the straggler grep is still clean**

```bash
grep -rnw "grns" server/src client/src scripts
```

Expected: no matches.

- [ ] **Step 5: Verify in a clean worktree**

A parallel session's uncommitted work can mask a broken baseline. Verify the commit, not the working tree — check out this branch's HEAD into a detached worktree and run `npm run verify` there.

---

### Task 16: Production migration and deploy

> **Do not start this task without Anik's explicit go-ahead.** It rewrites production data.

- [ ] **Step 1: Back up production**

```bash
npm run db:backup
```

Confirm the printed target is `colour-impressions-prod` (`ylbfeptgefzimcqnwphy`) and the backup file exists before continuing.

- [ ] **Step 2: Record the pre-migration count**

Count `grns` rows and `stock_batches` with a non-null `grn_id`. Write both numbers down — Step 4 compares against them.

- [ ] **Step 3: Apply migration 0014 to Supabase production**

Follow `DEPLOYMENT.md` §3. `init()` does **not** migrate production; the named migration does.

- [ ] **Step 4: Verify the migration landed exactly**

`grn_lines` count must equal the pre-migration `grns` count **exactly**, `grn_headers` must equal it too, and `stock_batches.grn_line_id` non-null must equal the old `grn_id` non-null count. Any mismatch means stop and restore from the backup.

- [ ] **Step 5: Check for schema drift**

```bash
npm run db:check
```

- [ ] **Step 6: Deploy and verify live**

```bash
npm run deploy:prod
```

```bash
curl -I -L https://motionci.in && curl -sS https://motionci.in/api/health
```

Expected: health body includes `{"ok":true}`. Then open Procurement on the live site and confirm the GRN register renders with real data.

---

## Self-review notes

**Spec coverage.** Every section maps to a task: data model → 3; migration → 3; write paths → 4; per-line QC and Accept All → 5; edit/delete/rollback → 6; read paths and the four outside call sites → 7; purchase register → 8; `/inventory/stock` → 9; `GrnLineEditor` → 10; Create GRN modal → 11; register and QC UI → 12; stock value → 13; print → 14; testing → 1, 2, 15.

**One deliberate refinement from the spec.** The spec said `/inventory/stock` would return a finished `stock_value`. It instead returns `costed_qty` and `costed_value`, and the master-rate fallback stays in `boardMath.js` where `ratePerSheet` and the rate master already live. Same result, one definition of the fallback rather than two, and the arithmetic becomes unit-testable (Task 2) rather than needing a database.

**Known gap, deliberately deferred.** `PoTotalsPanel`'s heading reads "PO items" / "Tax & totals". On a GRN "PO items" is wrong. Task 10 should pass a `title` prop rather than fork the component — a one-line additive change to `ProcurementForms.jsx`.
