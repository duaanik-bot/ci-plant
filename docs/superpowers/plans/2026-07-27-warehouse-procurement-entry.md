# Warehouse as a Procurement Entry Point — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Warehouse RM Stock list into a procurement entry point — drop the redundant Adjust column, open a Material 360° drawer on row click, tick one or many boards, and raise a Purchase Requisition with live inventory on every line, feeding the existing PR → PO → GRN lifecycle.

**Architecture:** Replenishment arithmetic lives in one pure module with a client twin (the established `board-math` pattern), so the stock table, the drawer and the PR form can never disagree. `/inventory/stock` gains `reserved`, `incoming` and `suggested`. The New-PR modal is extracted out of `Procurement.jsx` into a self-contained component so Warehouse can raise a PR without routing a storekeeper through a module they cannot access.

**Tech Stack:** Node 20 + Express + node:test (server), React 18 + Vite + Tailwind (client), embedded PostgreSQL locally / Supabase in production.

**Spec:** `docs/superpowers/specs/2026-07-27-warehouse-procurement-entry-design.md`

---

## Before you start

**Read this first — two hazards.**

1. **`client/src/pages/Inventory.jsx` was being edited by a concurrent session** while this plan was written (board-spec columns: grade, GSM, sheet size, kg/sheet, ₹/kg, stock value). Task 9 touches the same columns array. **Re-read the file immediately before editing it** and use exact-string edits. If the anchor strings in Task 9 no longer match, re-read and re-anchor rather than forcing.

2. **Git commits are gated.** `CLAUDE.md` allows git operations "when the user asks for commit, push, release, deploy, or production work." Commit steps are written into this plan, but **ask Anik before the first one.** There is also uncommitted work from the concurrent session in `ProcurementForms.jsx`, `QuickCreateMasters.jsx`, `Inventory.jsx`, `Masters.jsx` and `.gitignore` — **stage only the files named in each commit step**, never `git add -A`.

**Working directory for every command:** `/Users/anikdua/Documents/CI ERP FInal/ci-erp`

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/replenishment.js` | **Create.** Pure replenishment maths: suggested purchase qty, stock-row enrichment, PR purpose vocabulary. No I/O. |
| `client/src/lib/replenishment.js` | **Create.** Verbatim client twin of the above, for live form display. |
| `server/src/replenishment.test.js` | **Create.** Unit tests for both twins. |
| `server/src/db.js` | **Modify.** Three idempotent `ALTER TABLE`s. |
| `supabase/migrations/0005_warehouse_pr.sql` | **Create.** Named production migration. |
| `supabase/migrations/0001_baseline_schema.sql` | **Regenerate** via `npm run db:baseline`. |
| `server/src/routes/inventory.js` | **Modify.** `/inventory/stock` returns `reserved`, `incoming`, `suggested`. |
| `server/src/routes/procurement.js` | **Modify.** Widen `POST /requisitions` role; persist `purpose`. |
| `client/src/pages/Masters.jsx` | **Modify.** Min/Max stock fields on the Boards master. |
| `client/src/components/MasterHistory.jsx` | **Modify.** Optional `actions` prop in the drawer header. |
| `client/src/components/ProcurementForms.jsx` | **Modify.** `PrLineEditor` gains an optional live-inventory strip. |
| `client/src/components/NewRequisitionModal.jsx` | **Create.** Self-contained New-PR modal used by both Procurement and Warehouse. |
| `client/src/pages/Procurement.jsx` | **Modify.** Replace the inline New-PR modal with the shared component. |
| `client/src/pages/Inventory.jsx` | **Modify.** Remove Adjust columns, row click → drawer, selection, Raise-PR action. |

---

## Task 1: Replenishment maths (pure, with client twin)

**Files:**
- Create: `server/src/replenishment.js`
- Create: `client/src/lib/replenishment.js`
- Create: `server/src/replenishment.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/replenishment.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestedQty, enrichStockRow, normalisePurpose, PR_PURPOSES } from './replenishment.js';
import * as twin from '../../client/src/lib/replenishment.js';

// Real plant fixture: Duplex GB · 340 GSM · 20x38, bought 144 sheets to a packet.
const board = { available: 4200, reserved: 6000, incoming: 2000, reorder_level: 1500,
  max_stock: 0, sheets_per_packet: 144 };

// The core rule: buy enough to cover committed jobs AND put the reorder buffer
// back on the shelf, net of what is already on the water.
// 6000 + 1500 - 4200 - 2000 = 1300 → rounded up to 10 packets = 1440.
test('suggestedQty: demand + reorder buffer, net of stock and incoming, rounded to packets', () => {
  assert.equal(suggestedQty(board), 1440);
});

// Stock already covers demand and the buffer → buy nothing. Never negative.
test('suggestedQty: covered position suggests zero', () => {
  assert.equal(suggestedQty({ ...board, available: 99000 }), 0);
});

// Incoming stock counts. An open PO for the full shortfall means no new PR.
test('suggestedQty: open PO quantity removes the need', () => {
  assert.equal(suggestedQty({ ...board, incoming: 3300 }), 0);
});

// max_stock caps the resulting POSITION (available + incoming + suggested),
// not the order size. 5000 - 4200 - 2000 = 0 headroom → nothing to buy.
test('suggestedQty: max_stock caps the resulting position', () => {
  assert.equal(suggestedQty({ ...board, max_stock: 5000 }), 0);
});

// Headroom of 800 caps the 1300 need, then the packet round-up lifts it to 864.
// Overshooting max by less than one packet is correct: you cannot buy 5.5 packets.
test('suggestedQty: cap applies before the packet round-up, which may overshoot max', () => {
  assert.equal(suggestedQty({ ...board, max_stock: 7000 }), 864);
});

// A material with no packet size returns the raw figure, not a rounded guess.
test('suggestedQty: no sheets_per_packet → raw quantity', () => {
  assert.equal(suggestedQty({ ...board, sheets_per_packet: null }), 1300);
});

// A count corrected below zero is real in this plant. It is NOT clamped to 0
// before the formula, so the suggestion grows to refill the hole.
test('suggestedQty: negative available increases the suggestion', () => {
  assert.equal(suggestedQty({ ...board, available: -300, incoming: 0, reorder_level: 0 }), 6336);
});

// A master with nothing set suggests nothing rather than throwing.
test('suggestedQty: empty master → 0', () => {
  assert.equal(suggestedQty({}), 0);
  assert.equal(suggestedQty(null), 0);
});

// enrichStockRow is what the route maps over: it attaches the three derived
// fields and preserves the existing `demand` key and `short` rule verbatim.
test('enrichStockRow: attaches reserved/incoming/suggested and keeps demand + short', () => {
  const row = enrichStockRow(
    { id: 7, name: 'Duplex GB 340 20x38', available: 4200, reorder_level: 1500, sheets_per_packet: 144 },
    { reserved: 6000, incoming: 2000 });
  assert.equal(row.reserved, 6000);
  assert.equal(row.demand, 6000);      // legacy key preserved for existing callers
  assert.equal(row.incoming, 2000);
  assert.equal(row.suggested, 1440);
  assert.equal(row.short, true);       // reorder_level > available
  assert.equal(row.name, 'Duplex GB 340 20x38');
});

test('enrichStockRow: healthy row is not short', () => {
  const row = enrichStockRow({ id: 8, available: 9000, reorder_level: 1500 }, { reserved: 100, incoming: 0 });
  assert.equal(row.short, false);
  assert.equal(row.suggested, 0);
});

// Missing aggregates default to 0 rather than undefined leaking into the UI.
test('enrichStockRow: absent aggregates default to zero', () => {
  const row = enrichStockRow({ id: 9, available: 10 }, {});
  assert.equal(row.reserved, 0);
  assert.equal(row.incoming, 0);
  assert.equal(row.suggested, 0);
});

// purpose is a closed vocabulary; anything unknown falls back to 'production'
// so a bad client can never write a value the register cannot render.
test('normalisePurpose: known values pass, unknown falls back to production', () => {
  assert.equal(normalisePurpose('stock_replenishment'), 'stock_replenishment');
  assert.equal(normalisePurpose('reorder_level'), 'reorder_level');
  assert.equal(normalisePurpose('general_inventory'), 'general_inventory');
  assert.equal(normalisePurpose('production'), 'production');
  assert.equal(normalisePurpose('nonsense'), 'production');
  assert.equal(normalisePurpose(''), 'production');
  assert.equal(normalisePurpose(null), 'production');
  assert.equal(normalisePurpose(undefined), 'production');
});

test('PR_PURPOSES is the closed vocabulary', () => {
  assert.deepEqual(PR_PURPOSES,
    ['production', 'stock_replenishment', 'reorder_level', 'general_inventory']);
});

// The client twin must agree with the server on every case, or the PR form will
// show a number the server would not have produced.
test('client twin produces identical output', () => {
  const cases = [
    board,
    { ...board, available: 99000 },
    { ...board, incoming: 3300 },
    { ...board, max_stock: 5000 },
    { ...board, max_stock: 7000 },
    { ...board, sheets_per_packet: null },
    { ...board, available: -300, incoming: 0, reorder_level: 0 },
    {},
  ];
  for (const c of cases) assert.equal(twin.suggestedQty(c), suggestedQty(c));
  assert.deepEqual(twin.PR_PURPOSES, PR_PURPOSES);
  assert.equal(twin.normalisePurpose('nonsense'), normalisePurpose('nonsense'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -w server -- --test-name-pattern="suggestedQty"
```

Expected: FAIL — `Cannot find module '.../server/src/replenishment.js'`.

- [ ] **Step 3: Write `server/src/replenishment.js`**

```js
// Replenishment maths — how much of a board to buy, and why a PR was raised.
//
// Mirrored verbatim in client/src/lib/replenishment.js. replenishment.test.js
// asserts the two twins produce identical output — keep them in sync.
//
// Nothing here touches the database. The route supplies the two aggregates
// (committed demand, open-PO quantity) and this decides the number, so the RM
// Stock table, the Material 360° drawer and the PR form can never disagree
// about what a board needs.

// Why a requisition was raised. A closed vocabulary so the register always has
// something to render; unknown input falls back to the job-driven default.
export const PR_PURPOSES = ['production', 'stock_replenishment', 'reorder_level', 'general_inventory'];

export function normalisePurpose(v) {
  const s = String(v ?? '');
  return PR_PURPOSES.includes(s) ? s : 'production';
}

// How many units to buy:
//   need = committed demand + reorder buffer − on hand − already on order
// then capped so the resulting POSITION never exceeds max_stock (when set),
// then rounded UP to a whole packet, because board is bought by the packet.
//
// The round-up runs last and can overshoot max_stock by less than one packet.
// That is deliberate: half a packet is not purchasable.
//
// `available` is NOT clamped before the arithmetic. A count corrected below zero
// is a real position in this plant, and the suggestion should refill the hole.
export function suggestedQty(m) {
  const available = +m?.available || 0;
  const reserved = +m?.reserved || 0;
  const incoming = +m?.incoming || 0;
  const reorder = +m?.reorder_level || 0;
  const max = +m?.max_stock || 0;

  let need = reserved + reorder - available - incoming;
  if (!(need > 0)) return 0;

  // max_stock of 0 means "not set", never "hold no stock".
  if (max > 0) need = Math.min(need, Math.max(0, max - available - incoming));
  if (!(need > 0)) return 0;

  const per = +m?.sheets_per_packet || 0;
  return per > 0 ? Math.ceil(need / per) * per : need;
}

// Attach the derived fields to one raw stock row. `demand` is kept alongside the
// new `reserved` key because existing callers (dashboard, exports, the 360°
// drawer) already read it — renaming it outright would break them silently.
//
// The `short` rule is carried over unchanged from the route it came from.
export function enrichStockRow(m, { reserved = 0, incoming = 0 } = {}) {
  const row = { ...m, reserved: +reserved || 0, demand: +reserved || 0, incoming: +incoming || 0 };
  return {
    ...row,
    suggested: suggestedQty(row),
    short: (+m.reorder_level || 0) > (+m.available || 0) || (+reserved || 0) > (+m.available || 0),
  };
}
```

- [ ] **Step 4: Write the client twin `client/src/lib/replenishment.js`**

Identical body, different header comment:

```js
// Replenishment maths — how much of a board to buy, and why a PR was raised.
//
// Client twin of server/src/replenishment.js — used so the PR form can show a
// live suggestion as the buyer edits, before anything hits the server.
// replenishment.test.js asserts the two twins produce identical output — keep
// them in sync.

export const PR_PURPOSES = ['production', 'stock_replenishment', 'reorder_level', 'general_inventory'];

export function normalisePurpose(v) {
  const s = String(v ?? '');
  return PR_PURPOSES.includes(s) ? s : 'production';
}

// How many units to buy:
//   need = committed demand + reorder buffer − on hand − already on order
// then capped so the resulting POSITION never exceeds max_stock (when set),
// then rounded UP to a whole packet, because board is bought by the packet.
//
// The round-up runs last and can overshoot max_stock by less than one packet.
// That is deliberate: half a packet is not purchasable.
export function suggestedQty(m) {
  const available = +m?.available || 0;
  const reserved = +m?.reserved || 0;
  const incoming = +m?.incoming || 0;
  const reorder = +m?.reorder_level || 0;
  const max = +m?.max_stock || 0;

  let need = reserved + reorder - available - incoming;
  if (!(need > 0)) return 0;

  if (max > 0) need = Math.min(need, Math.max(0, max - available - incoming));
  if (!(need > 0)) return 0;

  const per = +m?.sheets_per_packet || 0;
  return per > 0 ? Math.ceil(need / per) * per : need;
}

// A master field left at 0 means "not set" — the UI shows "—", never a
// confident zero. Same rule boardMath follows for an incomplete board.
export const unset = v => !(+v > 0);
```

Note: `enrichStockRow` is server-only (the route owns row assembly) and is
deliberately absent from the twin. `unset` is client-only display sugar.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test -w server
```

Expected: all tests pass, including the 13 new ones in `replenishment.test.js`.

- [ ] **Step 6: Commit** *(ask Anik first — see "Before you start")*

```bash
git add server/src/replenishment.js server/src/replenishment.test.js client/src/lib/replenishment.js
git commit -m "feat(warehouse): pure replenishment maths with client twin"
```

---

## Task 2: Schema — min_stock, max_stock, purpose

**Files:**
- Modify: `server/src/db.js` (materials ALTERs near line 1507; requisitions ALTERs near line 1037)
- Create: `supabase/migrations/0005_warehouse_pr.sql`
- Regenerate: `supabase/migrations/0001_baseline_schema.sql`

Every statement in `init()` must be idempotent **and ordered after the table it
touches is created**. Both target tables are created near the top of the file, so
appending to the existing ALTER blocks is safe.

- [ ] **Step 1: Add the two materials columns**

In `server/src/db.js`, find this exact block:

```js
ALTER TABLE materials ADD COLUMN IF NOT EXISTS grade TEXT;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS gsm INTEGER;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS sheets_per_packet INTEGER;
```

Append immediately after it:

```js
-- Replenishment band. 0 means "not set" (the UI shows "—"), never "hold no
-- stock", so ~300 existing boards stay valid untouched. reorder_level is the
-- trigger point; min/max are the band a stock-replenishment PR aims to restore.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS min_stock DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS max_stock DOUBLE PRECISION NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Add the requisitions column**

Find this exact line in `server/src/db.js`:

```js
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS reraise_reason TEXT;
```

Append immediately after it:

```js
-- Why the PR was raised. Job-driven buying stays 'production' (the default, so
-- every existing row is correct); Warehouse-raised replenishment records its own
-- intent. Reporting only — it gates nothing.
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'production';
```

- [ ] **Step 3: Regenerate the baseline**

```bash
npm run db:baseline
```

Expected: `supabase/migrations/0001_baseline_schema.sql` is rewritten and now
contains `min_stock`, `max_stock` and `purpose`.

- [ ] **Step 4: Prove the baseline replays into an empty database**

```bash
npm run db:check -- --baseline
```

Expected: passes. A failure here means a statement is out of order — fix the
placement, do not reorder the table definitions.

- [ ] **Step 5: Write the production migration**

Create `supabase/migrations/0005_warehouse_pr.sql`:

```sql
-- Warehouse as a procurement entry point — three additive columns.
--
-- materials.min_stock / max_stock: the replenishment band a stock-replenishment
-- PR aims to restore. Both default to 0, which the app reads as "not set" and
-- renders as "—", so all ~300 existing boards stay valid with no backfill. They
-- are NOT the same as reorder_level, which stays the trigger point.
--
-- requisitions.purpose: why a PR was raised. Defaults to 'production', which is
-- correct for every row that already exists (all of them were job-driven), so
-- no UPDATE is needed. Reporting only — it gates nothing, and the server
-- normalises any unknown value back to 'production'.
--
-- Fully idempotent. Replaying this file is a no-op.

ALTER TABLE materials ADD COLUMN IF NOT EXISTS min_stock DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS max_stock DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'production';
```

- [ ] **Step 6: Verify the whole suite still passes**

```bash
npm run verify
```

Expected: baseline freshness check passes (it will fail if you skipped Step 3),
server tests pass, client build succeeds.

- [ ] **Step 7: Commit** *(ask Anik first)*

```bash
git add server/src/db.js supabase/migrations/0001_baseline_schema.sql supabase/migrations/0005_warehouse_pr.sql
git commit -m "feat(db): min_stock, max_stock on materials; purpose on requisitions"
```

---

## Task 3: `/inventory/stock` returns reserved, incoming, suggested

**Files:**
- Modify: `server/src/routes/inventory.js` (the `r.get('/inventory/stock', …)` handler at the top)

- [ ] **Step 1: Add the incoming-quantity join**

In `server/src/routes/inventory.js`, find this exact line inside the stock query:

```js
      LEFT JOIN (SELECT material_id, MIN(created_at) oldest FROM stock_batches WHERE status='available' AND qty>0 GROUP BY material_id) ag ON ag.material_id=m.id
```

Add a new join immediately after it:

```js
      -- Incoming = still-open quantity on live purchase orders. A 'received' or
      -- 'closed' PO has nothing left to arrive, so only open and part-received
      -- POs count. GREATEST guards an over-receipt from subtracting stock that
      -- is already on the shelf.
      LEFT JOIN (
        SELECT pl.material_id, SUM(GREATEST(pl.qty - pl.received_qty, 0)) q
        FROM po_lines pl JOIN purchase_orders po ON po.id = pl.purchase_order_id
        WHERE po.status IN ('open','partially_received')
        GROUP BY pl.material_id
      ) inc ON inc.material_id = m.id
```

- [ ] **Step 2: Select the incoming column**

Find this exact line in the same SELECT list:

```js
      SELECT m.*, COALESCE(av.q,0) AS available, COALESCE(qr.q,0) AS quarantine,
```

Replace it with:

```js
      SELECT m.*, COALESCE(av.q,0) AS available, COALESCE(qr.q,0) AS quarantine,
             COALESCE(inc.q,0) AS incoming,
```

- [ ] **Step 3: Map rows through `enrichStockRow`**

Find this exact block at the end of the handler:

```js
    const dmap = Object.fromEntries(demand.map(d => [d.material_id, d.q]));
    res.json(rows.map(m => ({
      ...m, demand: dmap[m.id] || 0,
      short: (m.reorder_level > (m.available || 0)) || ((dmap[m.id] || 0) > (m.available || 0)),
    })));
```

Replace it with:

```js
    const dmap = Object.fromEntries(demand.map(d => [d.material_id, d.q]));
    // Row assembly lives in replenishment.js so the number the warehouse shows,
    // the number the 360° drawer shows and the number the PR form seeds are one
    // function. `demand` is preserved alongside `reserved` for existing callers.
    res.json(rows.map(m => enrichStockRow(m, { reserved: dmap[m.id] || 0, incoming: m.incoming })));
```

- [ ] **Step 4: Add the import**

Find this exact line at the top of `server/src/routes/inventory.js`:

```js
import { squash, squashSql } from '../search-key.js';
```

Add immediately after it:

```js
import { enrichStockRow } from '../replenishment.js';
```

- [ ] **Step 5: Verify the endpoint by hand**

Start a temp server on a spare port against the running local Postgres (the
`:4000` dev server may be a plain `node` process that does not hot-reload):

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5439/cierp PORT=4011 node server/src/index.js
```

In another shell, log in and read one row:

```bash
TOKEN=$(curl -sS -X POST localhost:4011/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@motionci.com","password":"admin123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])') && curl -sS localhost:4011/api/inventory/stock -H "Authorization: Bearer $TOKEN" | python3 -c 'import sys,json;r=json.load(sys.stdin)[0];print({k:r[k] for k in ("name","available","reserved","demand","incoming","suggested","short")})'
```

Expected: a dict containing all seven keys, with `reserved == demand`, and
`incoming` and `suggested` present as numbers. Stop the temp server afterwards.

- [ ] **Step 6: Run the suite**

```bash
npm test -w server
```

Expected: PASS.

- [ ] **Step 7: Commit** *(ask Anik first)*

```bash
git add server/src/routes/inventory.js
git commit -m "feat(inventory): stock returns reserved, incoming and suggested qty"
```

---

## Task 4: PR permission + purpose persistence

**Files:**
- Modify: `server/src/routes/procurement.js` (line 9 role constant; `POST /requisitions` near line 178)

- [ ] **Step 1: Add the raise-only role**

Find this exact line near the top of `server/src/routes/procurement.js`:

```js
const canBuy = requireRole('planner');
```

Add immediately after it:

```js
// Raising a requisition is an ASK, not a commitment — the storekeeper who can
// see a board is short should be able to say so without a planner relaying it.
// Approval, edit, convert-to-PO and delete all stay on canBuy, so widening who
// can ask does not widen who can commit spend. `viewer` stays out: it is the
// read-only role by definition. `admin` passes every requireRole already.
const canRaisePr = requireRole('planner', 'production', 'qc');
```

- [ ] **Step 2: Apply it to the create route only**

Find this exact line:

```js
r.post('/requisitions', canBuy, async (req, res, next) => {
```

Replace with:

```js
r.post('/requisitions', canRaisePr, async (req, res, next) => {
```

Leave every other `canBuy` untouched — `PUT /requisitions/:id`, `/close`,
`/approve`, `/reject`, `DELETE` and `/convert` all stay planner+admin.

- [ ] **Step 3: Read purpose off the body**

Find this exact line inside the handler:

```js
    const { needed_by, reason, department, priority, remarks, reraise_of, reraise_reason } = req.body;
```

Replace with:

```js
    const { needed_by, reason, department, priority, remarks, reraise_of, reraise_reason } = req.body;
    const purpose = normalisePurpose(req.body.purpose);
```

- [ ] **Step 4: Persist it**

Find this exact INSERT:

```js
        `INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason,
                                   requested_by, department, priority, remarks, reraise_of, reraise_reason, order_line_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [pr_number, first.material_id, first.qty, needed_by || first.needed_by || null, reason || null,
         req.body.requested_by || req.user.name, department || null, priority || 'normal',
         remarks || null, reraise_of || null, reraise_of ? String(reraise_reason).trim() : null,
         req.body.order_line_id || null]);
```

Replace with:

```js
        `INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason,
                                   requested_by, department, priority, remarks, reraise_of, reraise_reason, order_line_id,
                                   purpose)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [pr_number, first.material_id, first.qty, needed_by || first.needed_by || null, reason || null,
         req.body.requested_by || req.user.name, department || null, priority || 'normal',
         remarks || null, reraise_of || null, reraise_of ? String(reraise_reason).trim() : null,
         req.body.order_line_id || null,
         purpose]);
```

- [ ] **Step 5: Record it in the audit line**

Find this exact block:

```js
      await audit('requisition', pr.id, reraise_of ? 'create_reraise' : 'create',
        reraise_of ? `${pr_number} re-raised over PR #${reraise_of}: ${String(reraise_reason).trim()}`
                   : `${pr_number} · ${lines.length} line(s)`, qc, req.user.name);
```

Replace with:

```js
      const purposeNote = purpose === 'production' ? '' : ` · ${purpose.replace(/_/g, ' ')}`;
      await audit('requisition', pr.id, reraise_of ? 'create_reraise' : 'create',
        reraise_of ? `${pr_number} re-raised over PR #${reraise_of}: ${String(reraise_reason).trim()}`
                   : `${pr_number} · ${lines.length} line(s)${purposeNote}`, qc, req.user.name);
```

- [ ] **Step 6: Add the import**

Find this exact line at the top of `server/src/routes/procurement.js`:

```js
const canBuy = requireRole('planner');
```

Above it, in the import block, add:

```js
import { normalisePurpose } from '../replenishment.js';
```

(Place it with the other `../` imports, not between the role constants.)

- [ ] **Step 7: Verify by hand**

Start the temp server as in Task 3 Step 5, then raise a stock PR:

```bash
curl -sS -X POST localhost:4011/api/requisitions -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"purpose":"stock_replenishment","department":"Stores","lines":[{"material_id":1,"qty":144}]}' | python3 -c 'import sys,json;r=json.load(sys.stdin);print(r["pr_number"], r["purpose"], r["department"])'
```

Expected: `CI-PR-… stock_replenishment Stores`.

Then confirm an unknown purpose falls back rather than erroring:

```bash
curl -sS -X POST localhost:4011/api/requisitions -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"purpose":"nonsense","lines":[{"material_id":1,"qty":144}]}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["purpose"])'
```

Expected: `production`.

**Clean up both test PRs** — delete them by `pr_number` through the Procurement
UI or `DELETE /api/requisitions/:id`. Never leave UAT rows in the shared database.

- [ ] **Step 8: Run the suite**

```bash
npm test -w server
```

Expected: PASS.

- [ ] **Step 9: Commit** *(ask Anik first)*

```bash
git add server/src/routes/procurement.js
git commit -m "feat(procurement): production/QC can raise a PR; PRs record their purpose"
```

---

## Task 5: Min/Max stock on the Boards master

**Files:**
- Modify: `client/src/pages/Masters.jsx` (the `boards` config, `fields` array near line 165)

- [ ] **Step 1: Add the two fields**

In `client/src/pages/Masters.jsx`, find this exact line:

```jsx
      { key: 'reorder_level', label: 'Reorder Level', type: 'number' },
```

Replace with:

```jsx
      { key: 'reorder_level', label: 'Reorder Level', type: 'number', hint: 'Trigger point — below this the board reads SHORT' },
      { key: 'min_stock', label: 'Minimum Stock', type: 'number', newRow: true, hint: 'Leave 0 if not set — the warehouse shows “—”' },
      { key: 'max_stock', label: 'Maximum Stock', type: 'number', hint: 'Caps what a replenishment PR suggests. 0 = no cap' },
```

- [ ] **Step 2: Default them on new boards**

Find this exact line:

```jsx
    defaults: { category: 'board', unit: 'sheets', gst_rate: 18, reorder_level: 0, active: 1 },
```

Replace with:

```jsx
    defaults: { category: 'board', unit: 'sheets', gst_rate: 18, reorder_level: 0, min_stock: 0, max_stock: 0, active: 1 },
```

- [ ] **Step 3: Verify the client builds**

```bash
npm run build -w client
```

Expected: build succeeds.

- [ ] **Step 4: Commit** *(ask Anik first)*

```bash
git add client/src/pages/Masters.jsx
git commit -m "feat(masters): min and max stock on the Boards master"
```

---

## Task 6: `MasterHistory` accepts header actions

**Files:**
- Modify: `client/src/components/MasterHistory.jsx` (signature line 152; header near line 469)

- [ ] **Step 1: Accept the prop**

Find this exact line:

```jsx
export default function MasterHistory({ kind, record, onClose }) {
```

Replace with:

```jsx
// `actions` is an optional node dropped into the drawer header beside Export.
// Warehouse uses it to put Adjust Stock where the material's full history is,
// which is what let the per-row Adjust button leave the stock list.
export default function MasterHistory({ kind, record, onClose, actions }) {
```

- [ ] **Step 2: Render it**

Find this exact line in the header block:

```jsx
            <ExportMenu build={buildExport} />
```

Replace with:

```jsx
            {actions}
            <ExportMenu build={buildExport} />
```

- [ ] **Step 3: Verify the client builds and Masters is unaffected**

```bash
npm run build -w client
```

Expected: build succeeds. `Masters.jsx` passes no `actions`, so it renders
exactly as before.

- [ ] **Step 4: Commit** *(ask Anik first)*

```bash
git add client/src/components/MasterHistory.jsx
git commit -m "feat(master-360): optional header actions slot"
```

---

## Task 7: Live inventory on every PR line

**Files:**
- Modify: `client/src/components/ProcurementForms.jsx` (`PrLineEditor`, from line 78)

- [ ] **Step 1: Add the inventory strip component**

In `client/src/components/ProcurementForms.jsx`, find this exact line:

```jsx
// ── Requisition lines ─────────────────────────────────────────────────────────
```

Insert immediately **above** it:

```jsx
// ── Live inventory on a requisition line ─────────────────────────────────────
// Procurement decisions get made against the position, not from memory. Every
// figure comes from /inventory/stock, so the strip agrees with the warehouse
// list by construction. A master field left at 0 reads "—", never a confident
// zero — same rule boardMath follows for an incomplete board.
const inv = (v, suffix = '') => (unset(v)
  ? <span className="text-slate-300">—</span>
  : <span className="tabular-nums font-semibold text-slate-700">{fmt.num(v)}{suffix}</span>);

function StockStrip({ stock, onUse }) {
  if (!stock) return null;
  const pkt = packets(stock, stock.available);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-slate-50/80 px-2.5 py-1.5 text-[11px] text-slate-500">
      <span>Available {inv(stock.available)}{pkt != null && +stock.available > 0
        ? <span className="ml-1 text-slate-400">({pkt.toLocaleString('en-IN', { maximumFractionDigits: 1 })} pkt)</span> : null}</span>
      <span>Reserved {inv(stock.reserved)}</span>
      <span>Incoming {inv(stock.incoming)}</span>
      <span>Reorder {inv(stock.reorder_level)}</span>
      <span>Min {inv(stock.min_stock)}</span>
      <span>Max {inv(stock.max_stock)}</span>
      <span className="font-semibold text-slate-600">Suggested {inv(stock.suggested)}</span>
      {+stock.suggested > 0 && onUse && (
        <button type="button" onClick={() => onUse(stock.suggested)}
          className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-600 transition-colors hover:bg-brand-100">
          Use
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Import the helpers it needs**

Find this exact line:

```jsx
import { kgPerSheet, packets, totalWeight, ratePerSheet } from '../lib/boardMath.js';
```

Add immediately after it:

```jsx
import { unset } from '../lib/replenishment.js';
```

(`packets` and `fmt` are already imported in this file.)

- [ ] **Step 3: Accept `stockFor` and render the strip**

Find this exact line:

```jsx
export function PrLineEditor({ lines, materials, onChange, onQuickCreate, activePrsFor, rateFor }) {
```

Replace with:

```jsx
// `stockFor(materialId)` is optional. When supplied, every line shows the live
// position under its material picker. Callers that do not pass it (the PR edit
// modal) render exactly as before.
export function PrLineEditor({ lines, materials, onChange, onQuickCreate, activePrsFor, rateFor, stockFor }) {
```

- [ ] **Step 4: Render the strip inside the material cell**

Find this exact block inside the `lines.map`:

```jsx
                    <input placeholder="Item remark (optional)" value={l.remarks || ''}
                      onChange={e => set(i, { remarks: e.target.value })}
                      className={`${miniInput} mt-1 text-xs`} />
```

Replace with:

```jsx
                    {l.material_id && stockFor && (
                      <StockStrip stock={stockFor(l.material_id)}
                        onUse={qty => set(i, { qty: String(qty) })} />
                    )}
                    <input placeholder="Item remark (optional)" value={l.remarks || ''}
                      onChange={e => set(i, { remarks: e.target.value })}
                      className={`${miniInput} mt-1 text-xs`} />
```

- [ ] **Step 5: Show code and spec on the picked material**

Find this exact block (still inside the material cell, just above the dupes check):

```jsx
                    <MaterialPicker value={l.material_id} materials={materials}
                      onQuickCreate={onQuickCreate ? () => onQuickCreate(i) : undefined}
                      onPick={mat => set(i, fillFromMaterialPr(l, mat, rateFor))} />
```

Replace with:

```jsx
                    <MaterialPicker value={l.material_id} materials={materials}
                      onQuickCreate={onQuickCreate ? () => onQuickCreate(i) : undefined}
                      onPick={mat => set(i, fillFromMaterialPr(l, mat, rateFor))} />
                    {/* Code + grade·GSM under the picker: the board name already
                        carries the size, and the plant code is what the floor
                        reads. Together they identify the board without a wider row. */}
                    {(() => {
                      const mat = materials.find(m => String(m.id) === String(l.material_id));
                      if (!mat) return null;
                      const bits = [mat.spec, [mat.grade, mat.gsm ? `${mat.gsm} GSM` : null].filter(Boolean).join(' · ')]
                        .filter(Boolean);
                      return bits.length
                        ? <div className="mt-0.5 font-mono text-[10px] text-slate-400">{bits.join('  ·  ')}</div>
                        : null;
                    })()}
```

- [ ] **Step 6: Verify the client builds**

```bash
npm run build -w client
```

Expected: build succeeds.

- [ ] **Step 7: Commit** *(ask Anik first)*

```bash
git add client/src/components/ProcurementForms.jsx
git commit -m "feat(procurement): live inventory strip on requisition lines"
```

---

## Task 8: Extract the shared New-PR modal

**Files:**
- Create: `client/src/components/NewRequisitionModal.jsx`
- Modify: `client/src/pages/Procurement.jsx`

The component is self-contained — it loads its own materials, board rates, active
PRs and stock — so both callers pass almost nothing. This is what lets a
storekeeper on `production`/`qc`, who has no `procurement` module access, raise a
PR without leaving Warehouse.

- [ ] **Step 1: Create `client/src/components/NewRequisitionModal.jsx`**

```jsx
// New Purchase Requisition — ONE form, several doors.
//
// Procurement and Warehouse both raise PRs, and there is exactly one procurement
// lifecycle behind them (PR → approval → PO → GRN → stock). So this modal is
// self-contained: it loads its own masters, rates, live stock and duplicate
// check, and every caller passes only what makes its door different.
//
// A storekeeper on `production`/`qc` has no Procurement module, so routing them
// there to finish a PR would dead-end. The form comes to them instead.
import { useEffect, useState } from 'react';
import { api, auth, fmt } from '../api.js';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from './ui.jsx';
import { MaterialQuickCreate } from './QuickCreateMasters.jsx';
import { PrLineEditor } from './ProcurementForms.jsx';
import { AlertTriangle } from 'lucide-react';

const blankLine = () => ({ material_id: '', qty: '', est_rate: '', unit: '', remarks: '' });

const PURPOSE_LABELS = [
  ['production', 'Production / Job requirement'],
  ['stock_replenishment', 'Stock replenishment'],
  ['reorder_level', 'Reorder level procurement'],
  ['general_inventory', 'General inventory purchase'],
];

// `defaults` seeds the header (department, purpose). `seedMaterialIds` prefills
// the line list from a warehouse selection, with the quantity already set to the
// server's suggested figure — the user reviews rather than retypes.
export default function NewRequisitionModal({ open, onClose, onRaised, seedMaterialIds = [], defaults = {} }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [stock, setStock] = useState([]);
  const [prs, setPrs] = useState([]);
  const [boardRates, setBoardRates] = useState(new Map());
  const [quickMat, setQuickMat] = useState(null);   // { line: i }
  const [dupPr, setDupPr] = useState(null);         // { dupes, reason }
  const [saving, setSaving] = useState(false);

  // Everything the form needs, loaded when it opens. Failures degrade rather
  // than block: no stock means the strip shows "—", and the form still works.
  useEffect(() => {
    if (!open) { setForm(null); setDupPr(null); setQuickMat(null); return; }
    let live = true;
    (async () => {
      const [ms, st, ps, rates] = await Promise.all([
        api.get('/materials').catch(() => []),
        api.get('/inventory/stock').catch(() => []),
        api.get('/requisitions').catch(() => []),
        api.get('/board-po-rates').catch(() => []),
      ]);
      if (!live) return;
      setMaterials(ms); setStock(st); setPrs(ps);
      setBoardRates(new Map(rates.map(r => [String(r.material_id),
        { rate: r.rate_per_sheet, source: r.source, rate_per_kg: r.rate_per_kg }])));

      const byId = new Map(st.map(s => [String(s.id), s]));
      const seeded = seedMaterialIds
        .map(id => ({ id: String(id), s: byId.get(String(id)), m: ms.find(x => String(x.id) === String(id)) }))
        .filter(x => x.m)
        .map(({ id, s, m }) => ({
          ...blankLine(), material_id: id, unit: m.unit || '',
          qty: s && +s.suggested > 0 ? String(s.suggested) : '',
        }));

      setForm({
        requested_by: auth.user?.name || '', department: '', needed_by: '',
        priority: 'normal', purpose: 'production', reason: '', remarks: '',
        ...defaults,
        lines: seeded.length ? seeded : [blankLine()],
      });
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seedMaterialIds.join(','), JSON.stringify(defaults)]);

  // Board ₹/sheet from the rate master, else the material's std → last rate.
  // Mirrors the server's resolvePoRate precedence so screen and server agree.
  const rateFor = mat => {
    if (!mat) return null;
    const b = boardRates.get(String(mat.id));
    if (b) return { rate: b.rate, source: b.source, rate_per_kg: b.rate_per_kg };
    if (mat.std_rate != null) return { rate: mat.std_rate, source: 'std', rate_per_kg: null };
    if (mat.last_rate != null) return { rate: mat.last_rate, source: 'last', rate_per_kg: null };
    return { rate: null, source: 'none', rate_per_kg: null };
  };

  const stockFor = id => stock.find(s => String(s.id) === String(id)) || null;

  const activePrsFor = materialId => {
    if (!materialId) return [];
    return prs.filter(p => ['pending', 'approved'].includes(p.status)
      && (p.lines || []).some(l => String(l.material_id) === String(materialId)));
  };

  const body = (extra = {}) => ({
    requested_by: form.requested_by || undefined, department: form.department || undefined,
    needed_by: form.needed_by || undefined, priority: form.priority || 'normal',
    purpose: form.purpose || 'production',
    reason: form.reason || undefined, remarks: form.remarks || undefined,
    lines: form.lines.filter(l => l.material_id && +l.qty > 0).map(l => ({
      material_id: +l.material_id, qty: +l.qty,
      est_rate: l.est_rate === '' || l.est_rate == null ? undefined : +l.est_rate,
      remarks: l.remarks || undefined,
    })), ...extra,
  });

  const raise = async payload => {
    setSaving(true);
    try {
      const pr = await api.post('/requisitions', payload);
      toast.success(payload.reraise_of ? 'Requisition re-raised' : `${pr.pr_number || 'Requisition'} raised`);
      setDupPr(null);
      onRaised?.(pr);
      onClose();
    } catch (e) {
      toast.error(e.message || 'Could not raise the requisition');
    } finally { setSaving(false); }
  };

  // Intercept when any item already has an active PR — confirmed with a reason.
  const submit = () => {
    const lines = form.lines.filter(l => l.material_id && +l.qty > 0);
    if (!lines.length) return toast.error('Add at least one item with a quantity');
    const dupes = lines
      .map(l => ({ line: l, existing: activePrsFor(l.material_id) }))
      .filter(d => d.existing.length);
    if (dupes.length) { setDupPr({ dupes, reason: '' }); return; }
    raise(body());
  };

  // A board created on the fly drops onto the line that asked for it.
  const handleCreated = async material => {
    const ms = await api.get('/materials').catch(() => materials);
    setMaterials(ms);
    const i = quickMat?.line ?? 0;
    setForm(f => ({ ...f, lines: f.lines.map((l, j) => (j === i
      ? { ...l, material_id: String(material.id), unit: material.unit || '',
          est_rate: l.est_rate ? l.est_rate : (rateFor(material)?.rate != null ? String(rateFor(material).rate) : '') }
      : l)) }));
    setQuickMat(null);
  };

  return (<>
    <Modal open={open} onClose={() => { if (!quickMat) onClose(); }} title="New Purchase Requisition" wide
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={saving || !form?.lines.some(l => l.material_id && +l.qty > 0)} onClick={submit}>
          {saving ? 'Raising…' : 'Raise PR'}
        </Button>
      </>}>
      {form && <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Requested By"><Input value={form.requested_by} onChange={e => setForm({ ...form, requested_by: e.target.value })} /></Field>
          <Field label="Department"><Input value={form.department} placeholder="e.g. Planning, Stores"
            onChange={e => setForm({ ...form, department: e.target.value })} /></Field>
          <Field label="Needed By"><Input type="date" value={form.needed_by} onChange={e => setForm({ ...form, needed_by: e.target.value })} /></Field>
          <Field label="Priority">
            <Select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
              <option value="low">Low</option><option value="normal">Normal</option><option value="urgent">Urgent</option>
            </Select>
          </Field>
        </div>
        {/* Not every purchase answers a job. Replenishment buying needs no
            product, job card or customer order behind it. */}
        <Field label="Purpose" hint="Replenishment purchases need no order or job linkage">
          <Select value={form.purpose} onChange={e => setForm({ ...form, purpose: e.target.value })}>
            {PURPOSE_LABELS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </Select>
        </Field>
        <PrLineEditor lines={form.lines} materials={materials} activePrsFor={activePrsFor}
          rateFor={rateFor} stockFor={stockFor}
          onChange={lines => setForm({ ...form, lines })}
          onQuickCreate={i => setQuickMat({ line: i })} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Reason"><Textarea value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></Field>
          <Field label="Remarks" hint="Internal note carried through to the PO stage">
            <Textarea value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} />
          </Field>
        </div>
      </div>}
    </Modal>

    {/* ── Duplicate PR confirmation (multi-item) ── */}
    <Modal open={!!dupPr} onClose={() => setDupPr(null)} title="Some items already have active requisitions"
      footer={<>
        <Button variant="secondary" onClick={() => setDupPr(null)}>No, Cancel</Button>
        <Button variant="danger" disabled={saving || !dupPr?.reason.trim()}
          onClick={() => raise(body({
            reraise_of: dupPr.dupes[0].existing[0].id, reraise_reason: dupPr.reason.trim(),
          }))}>
          Raise Anyway
        </Button>
      </>}>
      {dupPr && <div className="space-y-3">
        <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm font-semibold text-amber-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span><b>Warning:</b> {dupPr.dupes.length} item{dupPr.dupes.length > 1 ? 's' : ''} on this requisition
            already {dupPr.dupes.length > 1 ? 'have' : 'has'} an active PR. Confirm with a reason to raise anyway.</span>
        </p>
        <div className="space-y-1.5">
          {dupPr.dupes.map((d, i) => {
            const mat = materials.find(m => String(m.id) === String(d.line.material_id));
            return (
              <div key={i} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs">
                <span className="font-semibold text-slate-700">{mat?.name || `Material #${d.line.material_id}`} · {fmt.num(d.line.qty)}</span>
                <span className="text-slate-500">already on {d.existing.map(p => p.pr_number).join(', ')}</span>
              </div>
            );
          })}
        </div>
        <Field label="Reason for Re-raising" required>
          <Textarea value={dupPr.reason} placeholder="e.g. wastage on press, allocation adjustment, revised order quantity"
            onChange={e => setDupPr({ ...dupPr, reason: e.target.value })} />
        </Field>
      </div>}
    </Modal>

    <MaterialQuickCreate open={!!quickMat} onClose={() => setQuickMat(null)} onCreated={handleCreated} />
  </>);
}
```

- [ ] **Step 2: Point Procurement at the shared component**

In `client/src/pages/Procurement.jsx`, find this exact line:

```jsx
import { PrLineEditor, PoLineEditor, PoTotalsPanel, TaxKindToggle } from '../components/ProcurementForms.jsx';
```

Add immediately after it:

```jsx
import NewRequisitionModal from '../components/NewRequisitionModal.jsx';
```

- [ ] **Step 3: Replace the inline New-PR modal**

Find the whole `{/* ── New PR ── */}` block — from the comment through the
closing `</Modal>` that follows `{newPr && <div className="space-y-3">…</div>}`
(around lines 1000–1028) — and replace it with:

```jsx
      {/* ── New PR ── one shared form; Warehouse opens the same component ── */}
      <NewRequisitionModal
        open={!!newPr}
        onClose={() => setNewPr(null)}
        onRaised={load}
        defaults={{ purpose: 'production' }} />
```

- [ ] **Step 4: Delete the now-dead duplicate-PR modal from Procurement**

The `{/* ── Duplicate PR confirmation (multi-item) ── */}` block moved into the
shared component. Find that whole block in `Procurement.jsx` (from the comment
through its closing `</Modal>`, around lines 1030–1065) and delete it.

- [ ] **Step 5: Simplify `openNewPr`**

Find this exact line:

```jsx
  const openNewPr = async () => { await loadBoardRates(null); setNewPr(newPrForm()); };
```

Replace with:

```jsx
  // The shared modal loads its own masters, rates and stock — this just opens it.
  const openNewPr = () => setNewPr(true);
```

- [ ] **Step 6: Remove the dead state and helpers**

Verified by grep: after Steps 3–5 these have no remaining callers in
`Procurement.jsx`. Delete all six:

- `const blankPrLine = () => ({ … });` (line 92 — only `newPrForm` used it)
- `const newPrForm = () => ({ … });` (lines 94–95)
- `const [dupPr, setDupPr] = useState(null);` (line 120)
- `const raisePr = async (body) => { … };` (lines 142–146 — its only two callers,
  `submitNewPr` and the duplicate modal, are gone)
- `const submitNewPr = () => { … };` (lines 150–158)
- `const activePrsFor = materialId => { … };` (lines 124–128 — the PR **edit**
  modal at line 1105 passes the literal `() => []`, not this function)

**Keep `prBody`** — `savePrEdit` (line 318) still uses it for `PUT /requisitions/:id`.

- [ ] **Step 7: Remove the dead quick-create branch**

`newPr` now holds a boolean, not a form object, so the quick-create handler must
no longer try to splice a line into it. Find this exact line:

```jsx
    if (quickMat?.target === 'pr') setLine(setNewPr, 'pr');
```

Delete it. The `'po'`, `'editpo'` and `'convertpo'` branches below it stay —
`quickMat` is still live for every PO path, and the shared modal owns its own
quick-create for the PR path.

- [ ] **Step 8: Verify the client builds with no unused-import errors**

```bash
npm run build -w client
```

Expected: build succeeds. `AlertTriangle` is now used only by the extracted
component — confirm with `grep -n "AlertTriangle" client/src/pages/Procurement.jsx`
and drop it from that file's lucide import if it has no remaining uses.

- [ ] **Step 9: Verify the Procurement door still works**

Open the running app, go to **Procurement → New Requisition**, add a board, and
raise it. Expected: the PR appears in the register, the inventory strip shows
live numbers under the material, and a duplicate raises the confirmation modal.
Then open an existing PR and **Edit** it — the edit modal still uses
`PrLineEditor` without `stockFor`, so it must render exactly as before.

- [ ] **Step 10: Commit** *(ask Anik first)*

```bash
git add client/src/components/NewRequisitionModal.jsx client/src/pages/Procurement.jsx
git commit -m "refactor(procurement): extract the New-PR modal into a shared component"
```

---

## Task 9: Warehouse — drawer, selection, Raise PR

**Files:**
- Modify: `client/src/pages/Inventory.jsx`

> **Re-read this file before editing.** A concurrent session was modifying the
> same columns array. If an anchor string below does not match, re-read and
> re-anchor — do not force the edit.

- [ ] **Step 1: Add the imports**

Find this exact line:

```jsx
import { api, fmt } from '../api.js';
```

Replace with:

```jsx
import { api, auth, fmt } from '../api.js';
```

Find this exact line:

```jsx
import { Plus, Minus } from 'lucide-react';
```

Replace with:

```jsx
import { Plus, Minus, ShoppingBag } from 'lucide-react';
import MasterHistory from '../components/MasterHistory.jsx';
import NewRequisitionModal from '../components/NewRequisitionModal.jsx';
```

- [ ] **Step 2: Add the new state**

Find this exact line:

```jsx
  const [adj, setAdj] = useState({ material_id: '', mode: 'add', qty: '', actual: '', batch_no: '', note: '' });
```

Add immediately after it:

```jsx
  const [viewing, setViewing] = useState(null);        // material row → 360° drawer
  const [picked, setPicked] = useState([]);            // selected material ids → PR
  const [prOpen, setPrOpen] = useState(false);

  // Raising a PR is an ask, not a commitment, so the storekeeper who sees the
  // shortage can raise it. Mirrors canRaisePr on the server — keep the two in
  // step, and never show a control that would 403.
  const canRaisePr = ['admin', 'planner', 'production', 'qc'].includes(auth.user?.role);
```

- [ ] **Step 3: Add the Raise PR header action**

Find this exact block:

```jsx
      <PageHeader title="Warehouse" subtitle="Raw material and finished goods, live — every change is a ledger entry"
        actions={<Button variant="secondary" onClick={() => openAdjust(null)}><Plus size={15} /> Adjustment</Button>} />
```

Replace with:

```jsx
      <PageHeader title="Warehouse" subtitle="Raw material and finished goods, live — every change is a ledger entry"
        actions={<>
          <Button variant="secondary" onClick={() => openAdjust(null)}><Plus size={15} /> Adjustment</Button>
          {canRaisePr && (
            <Button onClick={() => setPrOpen(true)}><ShoppingBag size={15} /> Raise Purchase Requisition</Button>
          )}
        </>} />
```

- [ ] **Step 4: Add the selection bar above the RM Stock table**

Find this exact line:

```jsx
        <AgeBar items={inStock.map(m => m.age_days)} unit="materials" />
```

Replace with:

```jsx
        <AgeBar items={inStock.map(m => m.age_days)} unit="materials" />
        {picked.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/70 bg-white/70 px-4 py-2.5 shadow-card backdrop-blur-xl animate-fadeIn">
            <span className="text-sm font-semibold text-slate-700">
              {picked.length} board{picked.length > 1 ? 's' : ''} selected
              <span className="ml-2 text-xs font-semibold text-slate-500">
                · {fmt.num(stock.filter(m => picked.includes(m.id)).reduce((s, m) => s + (+m.suggested || 0), 0))} sheets suggested
              </span>
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPicked([])}>Clear</Button>
              {canRaisePr && (
                <Button size="sm" onClick={() => setPrOpen(true)}>
                  Raise Purchase Requisition
                </Button>
              )}
            </div>
          </div>
        )}
```

- [ ] **Step 5: Make the RM Stock table selectable and remove its Adjust column**

Find this exact block:

```jsx
        <DataTable
          searchable
          dense
          columns={[
```

Replace with:

```jsx
        <DataTable
          searchable
          dense
          selectable={canRaisePr}
          selectedIds={picked}
          onToggleRow={(row, checked) => setPicked(ids => checked
            ? [...new Set([...ids, row.id])]
            : ids.filter(id => id !== row.id))}
          onToggleAll={(visible, checked) => {
            // Select All follows DataTable's contract: the CURRENTLY VISIBLE
            // (searched + sorted) rows, not the whole board master.
            const ids = visible.map(r => r.id);
            setPicked(cur => checked ? [...new Set([...cur, ...ids])] : cur.filter(id => !ids.includes(id)));
          }}
          columns={[
```

Then find and **delete** this exact block from the same columns array:

```jsx
            { key: 'adjust', label: '', align: 'right', render: m => (
                <Button size="sm" variant="secondary" onClick={() => openAdjust(m)}>Adjust…</Button>) },
```

- [ ] **Step 6: Point the RM Stock row click at the drawer**

Find this exact line (immediately after the RM Stock `columns={[…]}` array):

```jsx
          onRowClick={openAdjust}
          rows={rows}
          exportName="RM Stock Position"
```

Replace with:

```jsx
          onRowClick={setViewing}
          rows={rows}
          exportName="RM Stock Position"
```

- [ ] **Step 7: Do the same on the Leftover table**

Find this exact block:

```jsx
              { key: 'adjust', label: '', align: 'right', render: m => (
                  <Button size="sm" variant="secondary" onClick={() => openAdjust(m)}>Adjust…</Button>) },
            ]}
            onRowClick={openAdjust}
            rows={leftovers?.masters || []} empty="No leftover stock banked yet — plan a job on an odd board and push its offcut here"
```

Replace with:

```jsx
            ]}
            onRowClick={setViewing}
            rows={leftovers?.masters || []} empty="No leftover stock banked yet — plan a job on an odd board and push its offcut here"
```

Leftover rows get **no checkbox**: `assertPurchasable` rejects offcuts
server-side, so ticking one could only ever produce a 409.

- [ ] **Step 8: Render the drawer and the PR modal**

Find this exact four-line block at the **end of the file** — the FG-movement
modal's close tag followed by the page wrapper's close. Match all four lines
together; `</div>` alone appears dozens of times:

```jsx
      </Modal>
    </div>
  );
}
```

Replace with:

```jsx
      </Modal>

      {/* ── Material 360° — where an adjustment now lives ── */}
      {viewing && (
        <MasterHistory kind="materials" record={viewing} onClose={() => setViewing(null)}
          actions={
            <Button size="sm" variant="secondary"
              onClick={() => { const m = viewing; setViewing(null); openAdjust(m); }}>
              Adjust Stock
            </Button>
          } />
      )}

      {/* ── Warehouse door into the ONE procurement lifecycle ── */}
      <NewRequisitionModal
        open={prOpen}
        onClose={() => setPrOpen(false)}
        onRaised={() => { setPicked([]); load(); }}
        seedMaterialIds={picked}
        defaults={{ department: 'Stores', purpose: 'stock_replenishment' }} />
    </div>
  );
}
```

- [ ] **Step 9: Verify the client builds**

```bash
npm run build -w client
```

Expected: build succeeds.

- [ ] **Step 10: Commit** *(ask Anik first)*

```bash
git add client/src/pages/Inventory.jsx
git commit -m "feat(warehouse): 360 drawer on row click, row selection, raise PR from stock"
```

---

## Task 10: Full verification

**Files:** none — verification only.

- [ ] **Step 1: Run the full gate**

```bash
npm run verify
```

Expected: baseline freshness passes, all server tests pass, client build
succeeds. Do not proceed past a failure.

- [ ] **Step 2: Confirm production schema drift**

```bash
npm run db:check
```

Run with `DATABASE_URL` pointed at Supabase `colour-impressions-prod`. Expected:
it reports `min_stock`, `max_stock` and `purpose` as **missing in production** —
that is correct and expected until `0005_warehouse_pr.sql` is applied. Editing
`init()` does not migrate production.

- [ ] **Step 3: Walk the feature in the real running app**

Log in at a desktop breakpoint (not a mock, not a narrow viewport) and confirm
each of these:

1. **Warehouse → RM Stock → In Stock** has **no Adjust column**.
2. Clicking a row opens the **Material 360° drawer**, not the adjust modal.
3. **Adjust Stock** inside the drawer opens the adjustment modal with that board
   already selected; saving it updates the position and adds a ledger row.
4. A **checkbox** sits at the start of every row, with **Select All** in the header.
5. Search for `2038`, tick a board, clear the search, tick another — **both stay
   ticked** (selection is by id, not by visible row).
6. The **selection bar** shows the count and the summed suggested sheets.
7. **Raise Purchase Requisition** opens the PR form with **both boards
   pre-filled**, quantities seeded from `suggested`, unit and estimated rate
   resolved, and code · grade · GSM under each picker.
8. Every line shows **Available / Reserved / Incoming / Reorder / Min / Max /
   Suggested**, with `—` for unset masters, and **Use** fills the quantity.
9. **Purpose** defaults to *Stock replenishment* and **Department** to *Stores*.
10. Raising it lands the PR in **Procurement → Requisitions**, and approving,
    converting to a PO and receiving a GRN all still work — one lifecycle.
11. **RM Stock → Leftover** has no Adjust column, no checkboxes, and row click
    opens the drawer.
12. **Masters → Boards** shows Minimum Stock and Maximum Stock, and setting a max
    reduces the suggested quantity on the next warehouse load.

- [ ] **Step 4: Clean up test data**

Delete every PR raised during the walkthrough. Scope deletions to the exact
`pr_number` values you created — **never** an unscoped `DELETE` on the shared
database.

- [ ] **Step 5: Report**

Summarise for Anik: what shipped, what `db:check` says about production, and the
fact that `0005_warehouse_pr.sql` still needs applying before deploy. Do not
deploy without being asked.

---

## Deferred — do not build

- Auto-raising PRs when stock crosses the reorder level. Every PR here is a
  deliberate human action.
- Vendor selection or rate negotiation at PR stage — that stays a PO concern.
- Backfilling `min_stock` / `max_stock` on the ~300 existing boards.
- FG Stock, RM Batches and Movement Ledger tabs.
