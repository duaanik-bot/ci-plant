# Inline Master Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone create a complete master record — Product, Board, Customer, Vendor — from inside a sales order or purchase order, using the *same* form the Masters page uses, without leaving the order.

**Architecture:** The master form is extracted out of `Masters.jsx` into a shared `<MasterForm>` component driven by a shared `CONFIGS` table. Masters renders it for its own New/Edit modal, and four new `+` buttons in Sales Orders and Procurement render it too — so there is exactly one master form in the application and drift is impossible. Server-side, the single `requireRole('planner')` guard covering POST/PUT/DELETE is replaced by a pure, tested predicate that opens **POST** to any signed-in user while leaving PUT and DELETE where they are.

**Tech Stack:** React 18 + Vite + Tailwind (client, no test harness), Express + `node:test` (server, pure-module unit tests), PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-07-31-inline-master-creation-design.md`

---

## Before you start

This repository is edited by **several concurrent Claude sessions sharing one working tree**. Three rules that will save you:

1. **Prefer exact-string edits.** Never `git checkout -- <file>` — you will destroy another session's uncommitted work. If you must revert, save `git diff > /tmp/my-patch` first.
2. **Use your own ports.** Do not kill the process on `:5439` (embedded Postgres) — it is a *child* of another session's API server. Check `ps -o ppid=` before killing anything.
3. **`npm run verify` may fail on a stale baseline** left by a parallel session. If `build-baseline.mjs --check` fails and you have made no schema change, that is not your break — this plan makes **no schema change**, so `server/src/db.js` and `supabase/migrations/` must remain untouched.

Confirm the dev server you are looking at is *this* tree — a stale nested clone also serves `:5173`:

```bash
ps -eo pid,command | grep -i "[v]ite" && lsof -ti:5173 | head -1 | xargs -I{} lsof -p {} -a -d cwd -Fn
```

---

## File Structure

| file | responsibility |
|---|---|
| `client/src/lib/masterConfigs.js` | **New.** `CONFIGS` (the twelve master definitions), `MASTER_GROUPS`, `BOARD_VIEWS`, `PACKET_BY_GRADE`, `COATINGS`, `PASTING_TYPES`, `COLOUR_TYPES`, `USER_TEMPLATES`. Pure data — no React, no JSX. |
| `client/src/components/MasterForm.jsx` | **New.** The whole form: field grid, ref/grade/derived renderers, derived preview panels, user-access panel, operator mapping, `validate`, save-body builder. Owns create *and* edit. |
| `client/src/pages/Masters.jsx` | **Modified.** Keeps the list, columns, tabs, delete and active-toggle. Renders `<MasterForm>` for its modal. Loses ~600 lines. |
| `client/src/pages/Orders.jsx` | **Modified.** `+` beside Customer; Product `+` re-pointed at `MasterForm`. |
| `client/src/pages/Procurement.jsx` | **Modified.** `+` beside Vendor ×4; Board `+` ×3 re-pointed at `MasterForm`. |
| `client/src/components/NewRequisitionModal.jsx` | **Modified.** Board `+` re-pointed at `MasterForm`. |
| `client/src/components/QuickCreateMasters.jsx` | **Deleted.** |
| `server/src/master-access.js` | **New.** `canWriteMaster(role, verb)` — the permission rule, pure and testable. |
| `server/src/master-access.test.js` | **New.** Its tests. |
| `server/src/routes/masters.js` | **Modified.** Per-verb guards; `min_stock`/`max_stock` write-list fix; audit origin note. |
| `server/src/routes/board-rates.js` | **Modified.** `POST` guard. |

**Ordering matters.** Tasks 1–3 refactor a live page and must be proven before any new door is wired. Tasks 4–6 are server-side and independently testable. Tasks 7–11 add the doors.

---

## Task 1: Extract CONFIGS into a shared, React-free module

Pure data move. Nothing changes on screen.

**Files:**
- Create: `client/src/lib/masterConfigs.js`
- Modify: `client/src/pages/Masters.jsx:1-53`, `:50-254`, `:293-312`

- [ ] **Step 1: Read the exact block you are moving**

Read `client/src/pages/Masters.jsx` lines 1–312. You are moving these top-level consts **verbatim**, in this order:

| const | current lines |
|---|---|
| `PACKET_BY_GRADE` | 15–17 |
| `USER_TEMPLATES` | 24–31 |
| `COATINGS` | 35–37 |
| `PASTING_TYPES` | 41–43 |
| `COLOUR_TYPES` | 46–48 |
| `CONFIGS` | 50–254 |
| `MASTER_GROUPS` | 297–302 |
| `BOARD_VIEWS` | 309–312 |

Keep every comment. They document plant rules (why Duplex is 144 sheets/packet, why Boards has no separate Materials tab) and are the only record of several decisions.

- [ ] **Step 2: Create the new module**

Create `client/src/lib/masterConfigs.js`. It imports only from `boardCode.js` — **no React, no JSX, no `ui.jsx`**. That constraint is what lets it be imported anywhere without dragging the form in.

```js
// The twelve master definitions — one generic CRUD engine, zero drift.
//
// Pure data. No React, no JSX: this is imported by the Masters page, by
// MasterForm, and by the inline create doors on Sales Orders and Procurement,
// so it must stay free of anything that pulls a component tree with it.
import { boardName, boardCode } from './boardCode.js';

// …PACKET_BY_GRADE, USER_TEMPLATES, COATINGS, PASTING_TYPES, COLOUR_TYPES,
//   CONFIGS, MASTER_GROUPS, BOARD_VIEWS — moved verbatim from Masters.jsx…

export {
  PACKET_BY_GRADE, USER_TEMPLATES, COATINGS, PASTING_TYPES, COLOUR_TYPES,
  CONFIGS, MASTER_GROUPS, BOARD_VIEWS,
};
```

Prefix each moved const with `const` as it is today and export them in the single block above (or mark each `export const` — either is fine, be consistent).

- [ ] **Step 3: Point Masters.jsx at it**

In `client/src/pages/Masters.jsx`, delete the eight moved consts and add the import beside the existing `boardCode` import:

```js
import {
  PACKET_BY_GRADE, USER_TEMPLATES, COATINGS, PASTING_TYPES, COLOUR_TYPES,
  CONFIGS, MASTER_GROUPS, BOARD_VIEWS,
} from '../lib/masterConfigs.js';
```

`Masters.jsx` no longer needs `boardName` or `boardCode` for the configs, but **still uses `parseBoardName` and `takenCodesFor`** (lines 411, 899). Leave that import line as:

```js
import { parseBoardName, takenCodesFor } from '../lib/boardCode.js';
```

`COATINGS`, `PASTING_TYPES`, `COLOUR_TYPES` and `PACKET_BY_GRADE` are referenced *only* inside `CONFIGS` and the form — if the build complains they are unused in `Masters.jsx` after Task 2, drop them from this import then, not now.

- [ ] **Step 4: Build**

```bash
npm run build -w client
```

Expected: build succeeds. Any `is not defined` error means a const was moved but not imported.

- [ ] **Step 5: Verify the Masters page is unchanged in the running app**

Start the app and sign in (`admin@motionci.com`). If the local DB is empty, `npm run seed` first; the admin password is printed once on first boot.

Open `/masters` and confirm every one of the twelve nav pills still renders and lists rows: Customers, Products, Vendors, Boards, Board Rates, GST Rates, Machines, Sections, Employees, Users, Company.

Expected: identical to before. This task changed no behaviour.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/masterConfigs.js client/src/pages/Masters.jsx
git commit -m "refactor(masters): lift CONFIGS into a shared, React-free module"
```

---

## Task 2: Extract the form into `<MasterForm>`

The one dangerous edit in this plan. It ships alone and is proven against all twelve masters before anything else moves.

**Files:**
- Create: `client/src/components/MasterForm.jsx`
- Modify: `client/src/pages/Masters.jsx` — remove `save()` (680–744) and the modal (840–1284)

- [ ] **Step 1: Read what you are moving**

Read `client/src/pages/Masters.jsx:680-744` (`save`) and `:840-1284` (the `<Modal>`). Note the pieces that must travel together, because each encodes a rule that is invisible from the field list alone:

| behaviour | where today | why it matters |
|---|---|---|
| `defaults` applied only on create | 684–685 | a new Product opens CMYK / 4 colours |
| `derived` fields preserved on edit, composed on create | 695–698 | renaming a board would re-suffix a live code |
| `special` derived from Emboss+Leafing | 713–716 | drives stage generation and the tooling gate |
| board grade → `sheets_per_packet` seeding, blank-check not truthiness | 933–941 | a deliberate `0` must survive a grade change |
| board pick → carries `board_grade` + `gsm` onto the product | 897–911 | a product moved FBB→Saffire cannot keep the old grade |
| `moduleAccess` payload (modules/sections/machine_ids/landing_path + 3 flags) | 719–728 | the Users master |
| `operatorMapping` second PUT | 737–741 | the Machines master |
| `validate` gate | 731–732 | the board duplicate-name guard |

- [ ] **Step 2: Create the component**

Create `client/src/components/MasterForm.jsx`. Move the modal body and `save()` verbatim, parameterised by props. The component owns its own refs, its own `takenCodes`, and its own wide/narrow decision.

```jsx
// The master form — the ONE master form. Rendered by the Masters page for its
// New/Edit modal, and by the inline create doors on Sales Orders and
// Procurement. Every rule that used to live in Masters.jsx travels with it, so
// a master created mid-order is identical to one created in Masters.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, Field, Input, Modal, searchText, Select, ShadeAge, useToast } from './ui.jsx';
import { MODULES, FLOOR_SECTIONS } from '../modules.js';
import { parseBoardName, takenCodesFor } from '../lib/boardCode.js';
import { kgPerSheet, packetWeight, ratePerSheet, resolveRatePerKg } from '../lib/boardMath.js';
import { CONFIGS, PACKET_BY_GRADE, USER_TEMPLATES } from '../lib/masterConfigs.js';

// Masters that need the two-column grid and the wider modal.
const WIDE = new Set(['products', 'machines', 'boards']);

export default function MasterForm({
  master,              // a CONFIGS key
  open,
  record,              // omitted/null = create; a row = edit
  seed,                // pre-filled values on create, e.g. { customer_id }
  lock = [],           // field keys the caller owns and the user may not retype
  origin,              // where this was created from — recorded on the audit row
  onSaved,             // (createdOrUpdatedRow) => void
  onClose,
}) {
  const toast = useToast();
  const cfg = CONFIGS[master];
  const [editing, setEditing] = useState(null);
  const [rows, setRows] = useState([]);        // this master's own rows — validate() needs them
  const [loaded, setLoaded] = useState(false);
  const [refs, setRefs] = useState({});
  const [saving, setSaving] = useState(false);

  // Reset to a clean form every time the modal opens, so a cancelled create
  // never bleeds into the next one.
  //
  // Depend on record?.id, NOT record: `seed` and `record` are object literals
  // built inline by the callers, so a new identity arrives on every parent
  // render. Depending on the objects would re-run this effect continuously and
  // wipe what the user is typing, one keystroke at a time.
  useEffect(() => {
    if (!open) return;
    setEditing(record ? { ...record } : { ...(cfg.defaults || {}), ...(seed || {}) });
    setRows([]); setLoaded(false);
    api.get(cfg.endpoint).then(r => { setRows(r); setLoaded(true); })
      .catch(() => { setRows([]); setLoaded(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, master, record?.id]);

  // Every ref list the field renderers can ask for.
  useEffect(() => {
    if (!open) return;
    const want = [
      ['customers', '/customers'], ['materials', '/materials'], ['dies', '/tools?family=die'],
      ['gst_rates', '/gst_rates'], ['employees', '/employees'], ['sections', '/sections'],
      ['machines', '/machines'], ['vendors', '/vendors'],
      ['board_grades', '/board-grades'], ['board_rates', '/board-rates'],
    ];
    for (const [key, url] of want) {
      api.get(url).then(v => setRefs(r => ({ ...r, [key]: v }))).catch(() => {});
    }
  }, [open]);

  const takenCodes = useMemo(() => takenCodesFor(rows, editing?.id ?? null), [rows, editing?.id]);
  const derivedCtx = { refs, takenCodes };
  // …save() and the field grid, moved verbatim from Masters.jsx…
}
```

**`save()` moves verbatim** from `Masters.jsx:680-744`, with four changes:

1. `cfg` comes from the prop, not module scope.
2. `tab` is gone — every `tab === 'boards'` / `tab === 'board_rates'` test becomes `master === 'boards'` / `master === 'board_rates'`.
3. Wrap the whole body in `try/finally` around `setSaving`, and hand the saved row out:
   ```js
   const saved = editing.id
     ? await api.put(`${cfg.endpoint}/${editing.id}`, body)
     : await api.post(cfg.endpoint, body);
   // …operatorMapping PUT, unchanged…
   toast.success(editing.id ? 'Updated' : 'Created');
   onSaved?.(saved);
   ```
   `onSaved` receives the row. The Masters page ignores it and reloads; the inline doors select it on the line.
4. A field named in `lock` renders disabled. In the field grid, the `disabled` prop on every input/select becomes:
   ```js
   disabled={(!!editing.id && f.createOnly) || lock.includes(f.key)}
   ```

**The field grid, the derived panels, the user-access panel and the operator panel move verbatim**, with `tab` → `master` and `editing`/`setEditing` unchanged. Wrap it all in the same `<Modal>`, with:

```jsx
<Modal open={open} onClose={onClose} wide={WIDE.has(master)}
  title={`${record?.id ? 'Edit' : 'New'} ${cfg.label.replace(/s$/, '')}`}
  footer={<>
    <Button variant="secondary" onClick={onClose}>Cancel</Button>
    <Button onClick={save} disabled={saving || cfg.fields.some(f => {
      if (editing?.id && (f.createOnly || f.type === 'password')) return false;
      if (!editing?.id && f.type === 'password' && master === 'users') return !editing?.[f.key];
      return f.required && !editing?.[f.key] && editing?.[f.key] !== 0;
    })}>{saving ? 'Saving…' : 'Save'}</Button>
  </>}>
```

Note `cfg.label.replace(/s$/, '')` rather than the old `slice(0, -1)` — `slice` mangles labels that do not end in `s` (`GST Rates` → fine, but it is brittle). Both give "Product", "Board", "Customer", "Vendor".

- [ ] **Step 3: Render it from Masters.jsx**

In `Masters.jsx`, delete `save()` (680–744) and the entire `{cfg && <Modal …>…</Modal>}` block (840–1284). Replace the modal with:

```jsx
{cfg && (
  <MasterForm master={tab} open={!!editing} record={editing?.id ? editing : null}
    seed={editing?.id ? undefined : editing}
    onSaved={() => { setEditing(null); load(); }}
    onClose={() => setEditing(null)} />
)}
```

`editing` is already `{...cfg.defaults}` for a new record and the full row for an edit — so `record` for edits and `seed` for creates reads it correctly, including the "New Board Rate pre-filled with a grade" path from `openRateFor` (line 359).

Add the import and remove what is now unused from `Masters.jsx`: `MODULES`/`FLOOR_SECTIONS`, `USER_TEMPLATES`, `PACKET_BY_GRADE`, `parseBoardName`, `kgPerSheet`, `packetWeight`, and `Field`/`Input`/`Modal` **if** nothing else on the page uses them. `resolveRatePerKg` and `ratePerSheet` are still used by the Boards *columns* (lines 476, 526) — keep those. Let the build tell you.

- [ ] **Step 4: Build**

```bash
npm run build -w client
```

Expected: build succeeds with no unused-import or undefined-symbol errors.

- [ ] **Step 5: Verify all twelve masters, create AND edit**

There is no client test harness — this is the verification. In the running app at `/masters`, for each master below, create one record and edit one record:

| master | on create, confirm | on edit, confirm |
|---|---|---|
| Customers | saves with segment + tolerance | tolerance change sticks |
| **Products** | opens with **Colour Type CMYK, Total Colours 4, Emboss No, Leafing No** | set Emboss=Yes, Leafing=Yes → saved row's `special` is `foil_emboss` |
| Vendors | saves with GSTIN + state code | — |
| **Boards** | Board Name + Code preview compose live; picking grade "FBB" fills Sheets/Packet **100**; typing `0` then changing grade **keeps 0** | editing reorder level does **not** change the stored name or code |
| Board Rates | grade + ₹/kg saves; blast-radius panel counts boards | rate change reprices the Boards tab on reload |
| GST Rates | saves | — |
| **Machines** | assign two operators → both persist | remove one → persists |
| Sections | blank Code auto-slugs from the name | — |
| Employees | section picker lists from the Sections master | — |
| **Users** | password required; module/station/press panel saves; the three approval checkboxes save | blank password leaves it unchanged |
| Company | profile saves | — |

Also confirm the **duplicate-board guard**: try to create a board whose grade+GSM+size matches an existing one. Expected: a red toast — *"…already exists in the board master — edit that board instead of creating a second one."*

If any row above fails, fix it before continuing. Nothing else in this plan is safe until this passes.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/MasterForm.jsx client/src/pages/Masters.jsx
git commit -m "refactor(masters): extract the master form into one shared component"
```

---

## Task 3: Fix the silently-dropped Boards columns

`materials.min_stock` and `materials.max_stock` exist (`db.js:1688-1689`) and are on the Boards form today, but are missing from the server's write list — so they are discarded on save. Now that this form is about to appear in front of buyers on a PO, fix it.

**Files:**
- Modify: `server/src/routes/masters.js:32`
- Create: `server/src/master-columns.test.js`

- [ ] **Step 1: Export the column map so it can be tested**

In `server/src/routes/masters.js`, change line 29 from `const MASTERS = {` to:

```js
// Exported for master-columns.test.js — a form field with no column here is
// silently discarded on save, which is exactly how min_stock/max_stock were lost.
export const MASTERS = {
```

- [ ] **Step 2: Write the failing test**

Create `server/src/master-columns.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASTERS } from './routes/masters.js';

// A column that exists on the table but is absent here is written as nothing —
// the generic INSERT/UPDATE only touches the columns named in this map. The
// Boards master carried Minimum/Maximum Stock inputs for months that saved
// nothing at all, because materials was missing both.
test('materials writes the stock band the Boards master collects', () => {
  for (const col of ['min_stock', 'max_stock', 'reorder_level']) {
    assert.ok(MASTERS.materials.includes(col),
      `materials is missing ${col} — the Boards form collects it and it would be discarded`);
  }
});

test('materials still writes the identity and pricing columns', () => {
  for (const col of ['name', 'category', 'spec', 'grade', 'gsm', 'sheet_l', 'sheet_w',
                     'sheets_per_packet', 'hsn_code', 'gst_rate', 'active']) {
    assert.ok(MASTERS.materials.includes(col), `materials is missing ${col}`);
  }
});

test('products writes every column the master form can set', () => {
  for (const col of ['name', 'code', 'customer_id', 'board_material_id', 'board_grade', 'gsm',
                     'child_l', 'child_w', 'parent_l', 'parent_w', 'ups', 'colors', 'colour_type',
                     'coating', 'special', 'pasting_type', 'emboss', 'leafing', 'leafing_colour',
                     'die_number', 'block_number', 'tool_id', 'product_type', 'rate', 'mrp',
                     'spec_incomplete', 'active']) {
    assert.ok(MASTERS.products.includes(col), `products is missing ${col}`);
  }
});
```

- [ ] **Step 3: Run it and watch the first test fail**

```bash
npm test -w server -- --test-name-pattern="stock band"
```

Expected: FAIL — `materials is missing min_stock — the Boards form collects it and it would be discarded`.

If `node --test` rejects the pattern flag on this version, just run `npm test -w server` and read the failure.

- [ ] **Step 4: Add the two columns**

In `server/src/routes/masters.js`, line 32:

```js
  materials: ['name', 'category', 'spec', 'unit', 'sheet_l', 'sheet_w', 'reorder_level', 'min_stock', 'max_stock', 'hsn_code', 'gst_rate', 'std_rate', 'last_rate', 'active', 'grade', 'gsm', 'sheets_per_packet'],
```

- [ ] **Step 5: Run the tests**

```bash
npm test -w server
```

Expected: PASS, all three new tests plus every existing test.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/masters.js server/src/master-columns.test.js
git commit -m "fix(masters): min_stock and max_stock were collected by the form and discarded on save"
```

---

## Task 4: The write rule as a pure, tested predicate

**Files:**
- Create: `server/src/master-access.js`
- Create: `server/src/master-access.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/master-access.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canWriteMaster } from './master-access.js';

const ROLES = ['admin', 'planner', 'production', 'qc', 'dispatch', 'viewer'];

// Creating a master is open to every signed-in login. The point is the plant:
// a buyer blocked mid-PO by a missing board should add it and carry on, rather
// than abandon the PO and walk to Masters. Accountability moves to the audit
// trail, which records who created what and from where.
test('every signed-in role may create a master', () => {
  for (const role of ROLES) {
    assert.equal(canWriteMaster(role, 'POST'), true, `${role} should be able to create`);
  }
});

// Changing and deleting stay where they were: admin and planner only. Opening
// creation must not quietly open destruction.
test('only admin and planner may update or delete a master', () => {
  for (const verb of ['PUT', 'DELETE']) {
    assert.equal(canWriteMaster('admin', verb), true);
    assert.equal(canWriteMaster('planner', verb), true);
    for (const role of ['production', 'qc', 'dispatch', 'viewer']) {
      assert.equal(canWriteMaster(role, verb), false, `${role} must not ${verb}`);
    }
  }
});

// A request with no role attached is not a request from a trusted caller.
// requireAuth runs first, so this is belt-and-braces, not the main gate.
test('a missing or unknown role can create but never update or delete', () => {
  assert.equal(canWriteMaster(undefined, 'POST'), true);
  assert.equal(canWriteMaster(null, 'PUT'), false);
  assert.equal(canWriteMaster('nonsense', 'DELETE'), false);
});

test('the verb is matched case-insensitively', () => {
  assert.equal(canWriteMaster('viewer', 'post'), true);
  assert.equal(canWriteMaster('viewer', 'delete'), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test -w server
```

Expected: FAIL — `Cannot find module './master-access.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `server/src/master-access.js`:

```js
// ─── Who may write a master record ──────────────────────────────────────────
// One rule, in one place, so the answer is the same for every master table.
//
// CREATE is open to every signed-in user. Masters are created from inside the
// work — a board on a purchase order, a product on a sales order — and a buyer
// who cannot add the board they are trying to buy abandons the PO instead.
// Everything under /api already passes requireAuth (app.js), so "open" means
// "signed in", never "anonymous".
//
// UPDATE and DELETE are unchanged: admin and planner only. Widening creation
// must not widen destruction — a wrong new row is noise, a deleted customer
// master is damage.
//
// The control on creation is the audit trail, not the role: every insert
// records the table, the row, the user, and where it was created from.
const EDIT_ROLES = new Set(['admin', 'planner']);

export function canWriteMaster(role, verb) {
  if (String(verb).toUpperCase() === 'POST') return true;
  return EDIT_ROLES.has(role);
}

// Express guard built on the rule above.
export function requireMasterWrite(req, res, next) {
  if (canWriteMaster(req.user?.role, req.method)) return next();
  return res.status(403).json({
    error: `Your role (${req.user?.role}) can add master records but not change or delete them`,
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -w server
```

Expected: PASS — all four new tests, plus everything that passed before.

- [ ] **Step 5: Commit**

```bash
git add server/src/master-access.js server/src/master-access.test.js
git commit -m "feat(masters): the master write rule as a pure, tested predicate"
```

---

## Task 5: Apply the rule to the master routes

**Files:**
- Modify: `server/src/routes/masters.js:4,7,120,137,162,183,202`
- Modify: `server/src/routes/board-rates.js:9,12,42`

- [ ] **Step 1: Swap the guard in masters.js**

Replace line 4's import and line 7's constant:

```js
import { requireRole } from '../auth.js';
import { requireMasterWrite } from '../master-access.js';

const r = Router();
// POST is open to any signed-in user; PUT and DELETE stay admin/planner.
// See master-access.js for why.
const canWrite = requireMasterWrite;
const canEdit = requireRole('planner'); // admin implied — non-CRUD writes below
```

Then change the three generic CRUD routes to use `canWrite`:

- line 120: `r.post(`/${table}`, canWrite, async (req, res, next) => {`
- line 137: `r.put(`/${table}/:id`, canWrite, async (req, res, next) => {`
- line 162: `r.delete(`/${table}/:id`, canWrite, async (req, res, next) => {`

`requireMasterWrite` reads `req.method`, so one guard covers all three verbs and each is decided correctly.

**Leave `canEdit` on the two non-CRUD routes** — `PUT /company-profile` (183) and `PUT /machines/:id/operators` (202). Neither is a create, and neither is reachable from an order.

- [ ] **Step 2: Swap the guard in board-rates.js**

The nested Grade → Rate path needs `POST /board-rates` open. Add the import at line 9 and change **only** the POST:

```js
import { requireRole } from '../auth.js';
import { requireMasterWrite } from '../master-access.js';

const r = Router();
const canEdit = requireRole('planner'); // admin implied — PUT/DELETE below
```

Line 42: `r.post('/board-rates', requireMasterWrite, async (req, res, next) => {`

Leave every `PUT`/`DELETE` in that file on `canEdit`.

- [ ] **Step 3: Verify no other route lost its guard**

```bash
grep -n "canEdit\|canWrite\|requireMasterWrite\|requireRole" server/src/routes/masters.js server/src/routes/board-rates.js
```

Expected: in `masters.js`, `canWrite` on the three CRUD routes and `canEdit` on exactly two (`/company-profile`, `/machines/:id/operators`). In `board-rates.js`, `requireMasterWrite` on POST only.

- [ ] **Step 4: Run the tests and build**

```bash
npm test -w server && npm run build -w client
```

Expected: PASS.

- [ ] **Step 5: Verify the 403 is gone, and that delete is still refused**

Sign in as a non-planner (create a `dispatch` user in Masters → Users if none exists), then from that session:

```bash
TOKEN="<paste the token from localStorage 'token' in the browser devtools>"
# Create — expected: 200 with the new row
curl -s -X POST localhost:4000/api/vendors -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"UAT-GUARD-VENDOR","active":1}'
# Delete — expected: 403
curl -s -X DELETE localhost:4000/api/vendors/<id-from-above> -H "Authorization: Bearer $TOKEN"
```

Expected: the POST returns the row; the DELETE returns `{"error":"Your role (dispatch) can add master records but not change or delete them"}`.

Then clean up the probe row **scoped to the marker** — never an unscoped delete on the shared database:

```bash
psql "postgresql://postgres:postgres@localhost:5439/cierp" -c "DELETE FROM vendors WHERE name = 'UAT-GUARD-VENDOR';"
```

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/masters.js server/src/routes/board-rates.js
git commit -m "feat(masters): open master creation to every signed-in role, leave edit and delete alone"
```

---

## Task 6: Record where a master was created

Replaces the role gate with accountability: the audit note says whether a master was born in Masters or inside an order.

**Files:**
- Modify: `server/src/routes/masters.js:120-135`

- [ ] **Step 1: Accept an origin on the create**

In the `r.post` handler, before the INSERT, read an optional origin off the body and keep it out of the column values:

```js
  r.post(`/${table}`, canWrite, async (req, res, next) => {
    try {
      // Where this master was created from — "PO CI-PO-0042", "sales order
      // MED/PO/2610", or absent for the Masters page. Recorded on the audit
      // row, never stored as a column: creation is open to every role, so the
      // trail is what makes an inline master reviewable afterwards.
      const origin = String(req.body._origin ?? '').trim().slice(0, 120) || null;
      if (table === 'sections') await fillSectionDefaults(req.body);
```

Then change the audit call (line 131) from:

```js
      await audit(table, row.id, 'create', null, q, req.user.name);
```

to:

```js
      await audit(table, row.id, 'create',
        origin ? `created from ${origin}` : 'created in Masters', q, req.user.name);
```

`_origin` is not in any `MASTERS` column list, so `cols.map(c => req.body[c] ?? null)` never picks it up — it cannot reach a table.

- [ ] **Step 2: Verify it cannot leak into a column**

```bash
grep -n "_origin" server/src/routes/masters.js
```

Expected: exactly two hits, both inside the POST handler. If `_origin` appears in the `MASTERS` map, remove it — that would try to insert into a column that does not exist.

- [ ] **Step 3: Run tests and confirm the audit row**

```bash
npm test -w server
```

Expected: PASS.

Then create a vendor from `/masters` in the running app and check the trail:

```bash
psql "postgresql://postgres:postgres@localhost:5439/cierp" \
  -c "SELECT entity, action, detail, user_name FROM audit_log WHERE entity='vendors' ORDER BY id DESC LIMIT 1;"
```

Expected: `detail` reads `created in Masters`.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/masters.js
git commit -m "feat(masters): the audit trail records where a master was created"
```

---

## Task 7: Product door — swap the sales order's quick-create for the real form

**Files:**
- Modify: `client/src/pages/Orders.jsx:5,193,262-272,1089-1093`

- [ ] **Step 1: Swap the import**

Line 5, replace:

```js
import { ProductQuickCreate } from '../components/QuickCreateMasters.jsx';
```

with:

```js
import MasterForm from '../components/MasterForm.jsx';
```

- [ ] **Step 2: Render MasterForm instead**

Replace the block at lines 1089–1093:

```jsx
      {/* Create a product without leaving the order — the real Products master
          form, seeded with this order's customer. */}
      <MasterForm master="products" open={!!quickProduct}
        seed={{ customer_id: quickCustomerId }}
        lock={['customer_id']}
        origin={orderOrigin}
        onSaved={handleProductCreated}
        onClose={() => setQuickProduct(null)} />
```

- [ ] **Step 3: Add the origin string**

Beside `quickCustomerId` (line 272), add:

```js
  // Shown in the master's audit trail — which order this product was created from.
  const orderOrigin = quickProduct?.mode === 'edit'
    ? (detail?.po_number ? `sales order ${detail.po_number}` : 'a sales order')
    : (form.po_number ? `sales order ${form.po_number}` : 'a sales order');
```

- [ ] **Step 4: Send the origin from MasterForm**

`origin` is already a prop (Task 2). Use it in `save()` — it rides on the create only, never on an update:

```js
    const saved = editing.id
      ? await api.put(`${cfg.endpoint}/${editing.id}`, body)
      : await api.post(cfg.endpoint, { ...body, ...(origin ? { _origin: origin } : {}) });
```

- [ ] **Step 5: Confirm handleProductCreated still fits**

Read `Orders.jsx:262-272`. It already takes the created product, selects it on the line and refreshes the list — `onSaved` hands it the same row `onCreated` did. Confirm it does not read a field only the old quick-create sent (it should not: the old form posted a *subset*). If it references `wastage_pct` or `gst_pct`, delete those references — neither was ever saved.

- [ ] **Step 6: Build and verify in the app**

```bash
npm run build -w client
```

Then in the running app, at `/orders` → **New Order**:

1. Pick a customer, then press `+` beside a line's product.
2. Expected: the **full** Products form opens — 31 fields including Party Item Code, Parent Sheet L/W, Colour Type, Pasting Type, Emboss, Leafing, Block Number, MRP.
3. Confirm **Customer is pre-filled and disabled**.
4. Confirm it opens with **Colour Type = CMYK, Total Colours = 4, Emboss = No, Leafing = No**.
5. Set Emboss = Yes and Leafing = Yes, fill Name/Code/Board/Ups/Rate, Save.
6. Expected: the product is selected on the line, its rate populates, and the order draft is intact.
7. Press **Escape** while the product form is open. Expected: **only the product form closes** — the New Order modal and everything typed in it survive.
8. In `/masters` → Products, open that product. Expected: `special` = `foil_emboss`, and every field you typed is there.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/Orders.jsx client/src/components/MasterForm.jsx
git commit -m "feat(orders): the full Products master opens on the order line"
```

---

## Task 8: Customer door on the sales order

**Files:**
- Modify: `client/src/pages/Orders.jsx:748-757` (new order), and the matching customer picker in the edit-order modal

- [ ] **Step 1: Add the state**

Beside `quickProduct` (line 193):

```js
  const [quickCustomer, setQuickCustomer] = useState(null); // { mode: 'new' | 'edit' }
```

- [ ] **Step 2: Add the + beside the customer picker**

At lines 748–757, wrap the `<Select>` so the button sits beside it, matching the product line's button exactly:

```jsx
              <Field label="Customer" required
                hint={(() => {
                  const c = customers.find(x => String(x.id) === String(form.customer_id));
                  return c ? `Dispatch tolerance ±${c.tolerance_pct || 0}% — snapshotted on this order` : undefined;
                })()}>
                <div className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    <Select value={form.customer_id} onChange={e => setForm({ ...form, customer_id: e.target.value, lines: [{ ...emptyLine }] })}>
                      <option value="">Select customer…</option>
                      {customers.filter(c => c.active).map(c => <option key={c.id} value={c.id} data-search={searchText(c)}>{c.name}{c.tolerance_pct ? ` (±${c.tolerance_pct}%)` : ''}</option>)}
                    </Select>
                  </div>
                  <button type="button" title="Create a new customer"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 text-slate-400 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-600"
                    onClick={() => setQuickCustomer({ mode: 'new' })}>
                    <Plus size={15} />
                  </button>
                </div>
              </Field>
```

Do the same for the customer picker inside the **edit-order** modal, with `onClick={() => setQuickCustomer({ mode: 'edit' })}` and `setEditForm` in place of `setForm`.

- [ ] **Step 3: Guard both parent modals**

This is the step that loses the order draft if skipped. Line 735 becomes:

```jsx
      <Modal open={showNew} onClose={() => { if (!quickProduct && !quickCustomer) setShowNew(false); }} title="New Customer Order" wide
```

Line 830 becomes:

```jsx
      <Modal open={!!detail} onClose={() => { if (!quickProduct && !quickCustomer) closeDetail(); }} title={detail ? `${detail.po_number} — ${detail.customer_name}` : ''} wide
```

- [ ] **Step 4: Render the form**

Beside the product `MasterForm`:

```jsx
      {/* Create a customer without leaving the order. */}
      <MasterForm master="customers" open={!!quickCustomer}
        origin={orderOrigin}
        onSaved={c => {
          setCustomers(cs => [...cs, c].sort((a, b) => a.name.localeCompare(b.name)));
          if (quickCustomer.mode === 'edit') setEditForm(f => ({ ...f, customer_id: String(c.id), lines: [{ ...emptyLine }] }));
          else setForm(f => ({ ...f, customer_id: String(c.id), lines: [{ ...emptyLine }] }));
          setQuickCustomer(null);
        }}
        onClose={() => setQuickCustomer(null)} />
```

Resetting `lines` on selection matches what the existing customer `onChange` does — products are customer-scoped, so a stale line would point at another customer's product.

- [ ] **Step 5: Build and verify**

```bash
npm run build -w client
```

At `/orders` → New Order:

1. Press `+` beside Customer. Expected: the full Customers form (Name, Segment, City, State, GSTIN, Contact, Phone, Dispatch Tolerance %, Active).
2. Create one. Expected: it is selected in the picker and its tolerance shows in the hint.
3. Press **Escape** with the customer form open. Expected: only the customer form closes; the New Order modal survives.
4. Add a product line for that customer and save the order.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Orders.jsx
git commit -m "feat(orders): create a customer from the order header"
```

---

## Task 9: Board door — swap the procurement quick-create for the real form

**Files:**
- Modify: `client/src/pages/Procurement.jsx:10,1205,1316,1347,1571`
- Modify: `client/src/components/NewRequisitionModal.jsx:13,178,223`

- [ ] **Step 1: Swap the import in Procurement.jsx**

Line 10, replace `import { MaterialQuickCreate } from '../components/QuickCreateMasters.jsx';` with:

```js
import MasterForm from '../components/MasterForm.jsx';
```

- [ ] **Step 2: Replace the render at line 1571**

```jsx
      {/* Create a board without leaving the PR/PO — the real Boards master form. */}
      <MasterForm master="boards" open={!!quickMat}
        origin={quickMatOrigin}
        onSaved={handleMaterialCreated}
        onClose={() => setQuickMat(null)} />
```

- [ ] **Step 3: Add the origin string**

Beside the `quickMat` state declaration:

```js
  // Shown in the board's audit trail — which document it was created from.
  const quickMatOrigin = quickMat?.target === 'po' ? (directPo?.po_number ? `PO ${directPo.po_number}` : 'a purchase order')
    : quickMat?.target === 'editpo' ? (editPo?.po_number ? `PO ${editPo.po_number}` : 'a purchase order')
    : quickMat?.target === 'convertpo' ? (convertPr?.pr?.pr_number ? `PR ${convertPr.pr.pr_number}` : 'a requisition')
    : 'procurement';
```

- [ ] **Step 4: Confirm handleMaterialCreated still fits**

Read it. It takes the created material and selects it on `quickMat.line` of the right document. `onSaved` hands over the same row shape `/materials` returned before — the Boards master posts a **superset** of what `MaterialQuickCreate` posted, so nothing it reads has gone away.

- [ ] **Step 5: Same swap in NewRequisitionModal.jsx**

Line 13 becomes `import MasterForm from './MasterForm.jsx';`. Line 223 becomes:

```jsx
    <MasterForm master="boards" open={!!quickMat} origin="a purchase requisition"
      onSaved={handleCreated} onClose={() => setQuickMat(null)} />
```

- [ ] **Step 6: Build and verify**

```bash
npm run build -w client
```

At `/procurement` → **New PO**:

1. Press `+` on a line's board picker. Expected: the full Boards form — Grade, GSM, Parent L/W, Sheets/Packet, **HSN Code, GST %, Reorder Level, Minimum Stock, Maximum Stock**, plus the live Board Name/Code preview and the violet derived panel (kg/sheet, packet weight, ₹/kg, ₹/sheet).
2. Pick grade **FBB**. Expected: Sheets/Packet auto-fills **100**.
3. Fill GSM and both sheet sizes. Expected: the Board Name composes live, e.g. `FBB · 300 GSM · 23x36`, with the code beside it.
4. Set **Maximum Stock = 500**, save.
5. Expected: the board is selected on the PO line and priced from its grade's ₹/kg.
6. Open that board in `/masters` → Boards. Expected: **Maximum Stock reads 500** (this is the Task 3 fix proving itself end to end).
7. Try creating a board that duplicates an existing grade+GSM+size. Expected: the red duplicate toast, and no row created.
8. Press **Escape** with the board form open. Expected: only it closes; the PO draft survives (`Procurement.jsx` already guards on `quickMat` — confirm all three PO modals do).

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/Procurement.jsx client/src/components/NewRequisitionModal.jsx
git commit -m "feat(procurement): the full Boards master opens on the PR/PO line"
```

---

## Task 10: Vendor door on all four purchase-order forms

**Files:**
- Modify: `client/src/pages/Procurement.jsx:1206, 1236, 1315, 1347` and the four parent `<Modal onClose>` guards

- [ ] **Step 1: Add the state**

```js
  const [quickVendor, setQuickVendor] = useState(null); // { target: 'convertpo' | 'bulkpo' | 'po' | 'editpo' }
```

- [ ] **Step 2: Add the + to each of the four vendor pickers**

For each of lines 1206 (convert PR→PO), 1236 (bulk PO), 1315 (direct PO), 1347 (edit PO), wrap the existing `<Select>` — keeping its `key`, `value` and `onChange` **exactly as they are**, because `changePoVendor` reprices the lines and the `key` is what resyncs the label on a cancel-restore:

```jsx
                <div className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    {/* the existing <Select key={`ven-…`} …>…</Select>, untouched */}
                  </div>
                  <button type="button" title="Create a new vendor"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 text-slate-400 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-600"
                    onClick={() => setQuickVendor({ target: 'convertpo' })}>
                    <Plus size={15} />
                  </button>
                </div>
```

Use the matching `target` per site: `'convertpo'`, `'bulkpo'`, `'po'`, `'editpo'`. Leave the GSTIN hint line below each Select where it is.

`Plus` is already imported in this file (used by the line editors) — confirm with `grep -n "Plus" client/src/pages/Procurement.jsx`.

- [ ] **Step 3: Guard the four parent modals**

Each already guards on `quickMat`; add `quickVendor`. For example the edit-PO modal at line 1341:

```jsx
      <Modal open={!!editPo} onClose={() => { if (!quickMat && !quickVendor) setEditPo(null); }} title={editPo ? `Edit ${editPo.po_number}` : ''} wide
```

Do the same for the convert-PR, bulk-PO and direct-PO modals. Find them with:

```bash
grep -n "if (!quickMat)" client/src/pages/Procurement.jsx
```

Every hit must become `if (!quickMat && !quickVendor)`.

- [ ] **Step 4: Render the form**

```jsx
      {/* Create a vendor without leaving the PO. Selecting it runs the same
          vendor-change path a manual pick does, so tax kind and line rates
          reprice exactly as they would have. */}
      <MasterForm master="vendors" open={!!quickVendor} origin="a purchase order"
        onSaved={v => {
          setVendors(vs => [...vs, v].sort((a, b) => a.name.localeCompare(b.name)));
          const pick = {
            convertpo: [convertPr, setConvertPr],
            po: [directPo, setDirectPo],
            editpo: [editPo, setEditPo],
          }[quickVendor.target];
          if (pick) changePoVendor(pick[0], pick[1], String(v.id));
          else setBulkPo(s => ({ ...s, vendor_id: String(v.id) }));
          setQuickVendor(null);
        }}
        onClose={() => setQuickVendor(null)} />
```

Routing through `changePoVendor` rather than setting `vendor_id` directly is deliberate: it is what decides intra vs inter-state GST from the vendor's state code and reprices every line. Bulk PO has no such path and takes the plain set.

- [ ] **Step 5: Build and verify**

```bash
npm run build -w client
```

For **each** of the four forms (New PO, Edit PO, Convert PR→PO, Bulk PO):

1. Press `+` beside Vendor. Expected: the full Vendors form — Name, GSTIN, Address, City, State, **State Code**, Contact, Phone, Email, Supplies.
2. Create a vendor with **State Code 03** (Punjab, the company's home state). Expected: it is selected, and Tax Type shows **intra** (CGST/SGST).
3. Create another with **State Code 07** (Delhi). Expected: Tax Type flips to **inter** (IGST) and the totals panel recalculates.
4. Press **Escape** with the vendor form open. Expected: only the vendor form closes; the PO draft survives.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Procurement.jsx
git commit -m "feat(procurement): create a vendor from any purchase-order form"
```

---

## Task 11: Nested creation — swap in place, one level down

The Products master requires a Board; the Boards master requires a Grade. Without this, the inline form dead-ends on exactly the problem it exists to solve.

**Files:**
- Modify: `client/src/components/MasterForm.jsx`

- [ ] **Step 1: Add the nesting state**

Inside `MasterForm`, above the return:

```js
  // One level of nesting, as a SWAP rather than a stack: the Products form
  // needs a board, the Boards form needs a grade, and stacking a third modal
  // over an order modal is unusable on a tablet. The parent form's typed state
  // is held in `editing` and is never unmounted, so it is all still there when
  // the child closes.
  const [nested, setNested] = useState(null);   // 'boards' | 'board_rates'

  // Which field, on which master, can create the thing it points at.
  const NESTS = { products: { field: 'board_material_id', child: 'boards' },
                  boards:   { field: 'grade',             child: 'board_rates' } };
  const nest = NESTS[master];
```

- [ ] **Step 2: Add the + to the nestable field**

In the field grid, after the `<Select>` for a `ref` or `graderef` field, wrap it when `nest?.field === f.key`:

```jsx
                {nest?.field === f.key ? (
                  <div className="flex items-start gap-1.5">
                    <div className="min-w-0 flex-1">{control}</div>
                    <button type="button"
                      title={nest.child === 'boards' ? 'Create a new board' : 'Create a new board grade + rate'}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 text-slate-400 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-600"
                      onClick={() => setNested(nest.child)}>
                      <Plus size={15} />
                    </button>
                  </div>
                ) : control}
```

where `control` is the `<Select>` element you already build for that field. Refactor the field renderer so each branch assigns to a `control` variable and the `<Field>` renders it — that keeps this wrapper in one place rather than duplicated across the `ref` and `graderef` branches. Import `Plus` from `lucide-react`.

- [ ] **Step 3: Hide the parent while the child is open**

The swap. Change the parent `<Modal>`'s `open` so the parent is not on screen while the child is:

```jsx
    <Modal open={open && !nested} onClose={onClose} wide={WIDE.has(master)} …>
```

`editing` lives in state and the component never unmounts, so everything typed is still there when `nested` clears.

- [ ] **Step 4: Render the child and take its result**

After the parent `</Modal>`:

```jsx
      {/* The child form, in place of the parent — not on top of it. On save the
          new row is selected on the field that opened it and the ref list is
          refreshed, so the parent comes back ready to continue. */}
      {nested && (
        <MasterForm master={nested} open origin={origin}
          onSaved={row => {
            if (nested === 'boards') {
              setRefs(r => ({ ...r, materials: [...(r.materials || []), row] }));
              setEditing(ed => ({
                ...ed,
                board_material_id: String(row.id),
                ...(row.grade ? { board_grade: row.grade } : {}),
                ...(row.gsm != null ? { gsm: row.gsm } : {}),
              }));
            } else {
              // A new Board Rate is what makes a new grade selectable at all —
              // /board-grades is derived from rates plus grades already in use.
              setRefs(r => ({ ...r, board_grades: [...(r.board_grades || []), { grade: row.grade }] }));
              setEditing(ed => ({
                ...ed,
                grade: row.grade,
                sheets_per_packet: (ed.sheets_per_packet ?? '') !== ''
                  ? ed.sheets_per_packet : (PACKET_BY_GRADE[row.grade] ?? ''),
              }));
            }
            setNested(null);
          }}
          onClose={() => setNested(null)} />
      )}
```

Selecting a board also carries its grade and GSM onto the product — the same rule the Board picker's `onChange` applies (`Masters.jsx:897-911`), so a product cannot be saved claiming a grade its board contradicts. The `sheets_per_packet` blank-check mirrors the grade picker's own rule: a deliberately typed `0` survives.

- [ ] **Step 5: Build**

```bash
npm run build -w client
```

Expected: succeeds. A "Maximum update depth" or "too much recursion" error at runtime means the child is rendering unconditionally — check `{nested && …}`.

- [ ] **Step 6: Verify the full chain in the app**

At `/orders` → New Order → pick a customer → `+` on a product line:

1. In the Products form, type a Name and Code, then press `+` beside **Board**.
2. Expected: the Products form is **replaced** by the Boards form. Only two layers on screen (order modal + board form), never three.
3. In the Boards form, press `+` beside **Grade**.
4. Expected: the Boards form is replaced by the Board Rate form. Create grade `UAT-NEST` at ₹80/kg.
5. Expected: you are back on the **Boards** form with Grade = `UAT-NEST` selected.
6. Fill GSM 300, sheet 23 × 36. Save.
7. Expected: you are back on the **Products** form, Board selected, **and the Name and Code you typed in step 1 are still there**. Board Grade and GSM have been carried across.
8. Finish the product and save. Expected: back on the order line with the product selected.
9. Clean up the probe rows, scoped to the marker:

```bash
psql "postgresql://postgres:postgres@localhost:5439/cierp" -c \
  "DELETE FROM board_rates WHERE grade = 'UAT-NEST'; DELETE FROM materials WHERE grade = 'UAT-NEST';"
```

- [ ] **Step 7: Commit**

```bash
git add client/src/components/MasterForm.jsx
git commit -m "feat(masters): a master can create the master it depends on, one level down"
```

---

## Task 12: Delete the quick-create forms

**Files:**
- Delete: `client/src/components/QuickCreateMasters.jsx`

- [ ] **Step 1: Confirm nothing imports it**

```bash
grep -rn "QuickCreateMasters\|ProductQuickCreate\|MaterialQuickCreate" client/src
```

Expected: **no output**. Any hit is a call site Tasks 7–9 missed — fix it before deleting.

- [ ] **Step 2: Delete the file**

```bash
git rm client/src/components/QuickCreateMasters.jsx
```

- [ ] **Step 3: Build**

```bash
npm run build -w client
```

Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: delete the quick-create forms — the real master form replaces them"
```

---

## Task 13: Full verification

- [ ] **Step 1: Run the whole gate**

```bash
npm run verify
```

Expected: baseline check, `npm test -w server`, and `npm run build -w client` all pass.

If `build-baseline.mjs --check` fails: this plan makes **no schema change**, so confirm with `git status --short server/src/db.js supabase/` that neither is modified. If they are clean, the stale baseline is another session's and not yours to fix.

- [ ] **Step 2: Confirm the import wizard still works**

`ImportPOWizard`'s name+code quick-product is deliberately unchanged. At `/orders` → Import PO, upload a PO PDF and quick-create a product from an unmatched line.

Expected: the small name+code form (not the full master form), the toast *"…spec incomplete, finish it in Masters"*, and the product showing a **Spec incomplete** chip in `/masters` → Products.

- [ ] **Step 3: Confirm the four doors one last time, end to end**

| door | check |
|---|---|
| Sales order → Product | full form, customer locked, CMYK/4 defaults, Escape keeps the draft |
| Sales order → Customer | full form, selected on save, lines reset |
| PO → Board | full form incl. Max Stock, name/code compose live, duplicate guard fires |
| PO → Vendor | full form, state code flips intra/inter and reprices |

- [ ] **Step 4: Confirm the audit trail tells the two apart**

```bash
psql "postgresql://postgres:postgres@localhost:5439/cierp" -c \
  "SELECT entity, detail, user_name, created_at FROM audit_log WHERE action='create' AND entity IN ('products','materials','vendors','customers') ORDER BY id DESC LIMIT 10;"
```

Expected: rows created from an order read `created from PO …` / `created from sales order …`; rows created in Masters read `created in Masters`.

- [ ] **Step 5: Final commit if anything moved**

```bash
git status --short --branch
```

Expected: clean, or only files this plan named.

---

## Done means

- One master form exists in the application. `grep -rn "PRODUCT_BLANK\|MATERIAL_BLANK" client/src` returns nothing.
- Four `+` buttons open it: Product and Customer on the sales order, Board and Vendor on the purchase order.
- Any signed-in role can create a master; only admin and planner can change or delete one.
- The Boards master's Minimum/Maximum Stock save — they did not before.
- A product created on an order carries the same defaults, the same derived `special`, and the same 31 fields as one created in Masters.
- The audit trail says which door each master came through.
- `npm run verify` passes.
