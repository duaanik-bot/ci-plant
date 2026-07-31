# Inline Master Creation — the complete master form, inside the order

**Date:** 2026-07-31
**Modules:** Sales Orders (`/orders`), Procurement (`/procurement`), Masters (`/masters`)
**Goal:** when the master you need does not exist, create it — the real one, in
full — without leaving the order you are entering. One form, shared with the
Masters page, so a master born on a purchase order is indistinguishable from one
born in Masters.

---

## 1. What is wrong today

Three doors already let you create a master mid-flow. Each is a separate,
hand-written, thinner copy of the real form.

| door | where | fields vs. the real master |
|---|---|---|
| `ProductQuickCreate` | Sales Order line | 16 of the Products master's 31 |
| `MaterialQuickCreate` | PR / PO / Convert / Edit PO line | 6 of the Boards master's 13 |
| `ImportPOWizard` quick-product | PO PDF import | name + code, flagged `spec_incomplete` |

They have already drifted, in ways that produce wrong data rather than merely
incomplete data:

- **`special` is written directly** by the quick-create. The master form *derives*
  it from the Emboss/Leafing toggles (`emb && leaf → foil_emboss`). Downstream
  stage generation and the tooling gate read `products.special`, so a product
  created on a sales order can carry a finish its own Emboss/Leafing fields
  contradict.
- **The master's `defaults` are never applied.** A product created in Masters
  opens with `colour_type: 'CMYK'`, `colors: 4`, `emboss: 0`, `leafing: 0`. One
  created on a sales order gets none of them.
- **Two of the quick-create's sixteen fields write nothing at all.**
  `products.gst_pct` and `products.wastage_pct` exist as columns
  (`db.js:577`, `db.js:204`) but are absent from the generic CRUD's `MASTERS.products`
  write list (`routes/masters.js:36`). The "GST % Override" and "Wastage %" inputs
  on that form have never saved a value.

Two masters have **no inline door at all** — **Vendor** on the purchase order and
**Customer** on the sales order. Both are pickers with no escape hatch.

And the `+` button is **not role-gated in the UI**, while `POST /products` and
`POST /materials` *are* gated server-side by `requireRole('planner')`
(`routes/masters.js:7`). A `production`, `qc`, `dispatch` or `viewer` login sees
the button, fills in the entire form, presses Create — and eats a 403.

### A live defect found on the way

`materials.min_stock` and `materials.max_stock` exist (`db.js:1688-1689`) but are
missing from `MASTERS.materials` (`routes/masters.js:32`). **Minimum Stock and
Maximum Stock are on the Boards master form today and are silently discarded on
save.** This is not a quick-create problem — it is live in Masters. It is fixed
here, because this design puts that same form in front of buyers on a PO.

---

## 2. Architecture — one form, two doors

The master form is ~440 lines living inside `Masters.jsx` (lines 840–1284),
driven by a `CONFIGS` table. It is extracted:

| new file | holds |
|---|---|
| `client/src/lib/masterConfigs.js` | `CONFIGS`, `MASTER_GROUPS`, `BOARD_VIEWS`, `PACKET_BY_GRADE`, `COATINGS`, `PASTING_TYPES`, `COLOUR_TYPES` |
| `client/src/components/MasterForm.jsx` | the field grid, the derived/ref/grade renderers, the derived panels, `validate`, and the save-body builder |

```jsx
<MasterForm
  master="products"              // a CONFIGS key
  record={undefined}             // omitted = create; a row = edit (Masters only)
  seed={{ customer_id }}         // pre-filled; keys named in `lock` are read-only
  lock={['customer_id']}         // the order's own context cannot be typed over
  onSaved={row => …}             // the created row, handed back to the caller
  onCancel={…}
/>
```

It handles **both create and edit** — `record` is what distinguishes them, and
the existing create-vs-edit rules (`createOnly` fields, blank password = unchanged,
derived name/code preserved on an existing row) move with it unchanged. The four
inline doors only ever create; `Masters.jsx` uses both.

`Masters.jsx` renders the **same component** for its own New/Edit modal. There is
then literally one master form in the application, and drift is impossible by
construction rather than by discipline. `MasterForm` also owns the modal width
rule (`products`, `machines`, `boards` render wide), so that too stops being a
caller's decision.

**Rejected:** sharing only `CONFIGS` and keeping two renderers. The renderer is
where the behaviour lives — derived name/code composition, the grade → packet-size
seeding, the `special` derivation, the number/ref coercion in `save()`. Splitting
config from renderer is exactly how the current drift happened.

**Rejected:** embedding the Masters route in a drawer. It cannot be seeded with
the order's customer and cannot hand the created row back to the line.

---

## 3. The four doors

| module | trigger | master | seeded |
|---|---|---|---|
| Sales Orders | `+` beside **Customer** (new + edit order) | `customers` | — |
| Sales Orders | `+` beside each line's **Product** | `products` | `customer_id` from the order header, locked |
| Procurement | `+` beside **Vendor** (PO, Convert PR→PO, Edit PO, Bulk PO) | `vendors` | — |
| Procurement | `+` beside each line's **Board** | `boards` | — |

On save the created row is selected on that line or header immediately, the
module's ref list reloads, and the order draft is untouched. The existing `+`
button styling on the sales-order line (`Orders.jsx:788`) is the pattern; the
three new buttons match it.

The Board door replaces `MaterialQuickCreate` in all four of its current call
sites — `Procurement.jsx` (PO, convert, edit) and `NewRequisitionModal.jsx`.

---

## 4. Permission — every role, creates only

`routes/masters.js:7` currently uses one constant for all three verbs:

```js
const canEdit = requireRole('planner');   // POST, PUT and DELETE
```

It splits:

| verb | guard | who |
|---|---|---|
| `POST` | none beyond `requireAuth` | any signed-in user |
| `PUT` | `requireRole('planner')` | admin, planner — unchanged |
| `DELETE` | `requireRole('planner')` | admin, planner — unchanged |

`app.js:38` already applies `requireAuth` to everything under `/api`, so removing
the guard from `POST` means "signed in", never "anonymous".

Anyone may **add** a master. Only admin and planner may **change or delete** one.
The `+` button therefore shows for every login, and nobody fills a form only to
be refused at the end.

The same split applies to `POST /board-rates` (`routes/board-rates.js:42`), which
the nested Grade → Rate path needs.

**Accepted consequence, stated once:** `viewer` is no longer strictly read-only —
it can create master records. This was chosen deliberately over a per-login
permission flag. The control moves from the role to the audit trail.

### Accountability replaces the role gate

`audit(table, row.id, 'create', …)` already records the table, the row and the
user's name. The note field gains the origin:

```
created from PO CI-PO-0042        (board created on a purchase order)
created from sales order MED/PO/2610
created in Masters                 (unchanged behaviour, made explicit)
```

so a review in the Master 360 drawer can tell an inline master from a deliberate
one without guessing.

---

## 5. Nesting — stack once, swap after

The Products master **requires** a board; the Boards master requires a grade. So
the inline form can be blocked by the very problem it exists to solve, one level
down. It gets one level of nesting, in two different shapes:

**Level 1 — stack.** The master form opens over the order modal, the pattern the
codebase already uses. `Modal` portals to `<body>` at `z-50`, so the later modal
paints on top.

`Modal` binds Escape to `window` (`ui.jsx:264-268`), so with two modals open
*both* handlers fire. The established fix is a **caller-side guard on the
parent's `onClose`**, and it is already correct at both existing call sites:

```jsx
<Modal open={showNew} onClose={() => { if (!quickProduct) setShowNew(false); }}   // Orders.jsx:735
<Modal open={!!editPo} onClose={() => { if (!quickMat) setEditPo(null); }}        // Procurement.jsx:1341
```

`ui.jsx` is therefore **not** modified. The two *new* doors — Customer on the
sales order, Vendor on the PO — must adopt the same guard, or Escape will drop
the order draft along with the master form. That is the one thing to get right
per door, and it is checked explicitly in verification.

**Level 2 — swap, in place.** Inside the Product form, the Board picker gets its
own `+` that **replaces** the panel with the Board form. Saving returns to the
Product form with the new board selected and **everything already typed
preserved**.

The Board form's **Grade** picker gets the same treatment. `/board-grades` is
derived — it lists grades that have a rate, plus grades already used by a board
(`routes/board-rates.js:30`) — so a genuinely new grade only becomes selectable
once a Board Rate exists for it. Its `+` swaps to the Board Rate form and returns
with the grade selected. This is the rarest path (a new grade means a new board
brand, not a new size or GSM), but without it the chain still dead-ends.

Two layers on screen, never three. This matters on the iPad.

---

## 6. Deliberately unchanged

- **`ImportPOWizard`'s name+code quick-product stays.** It is the bulk path —
  twenty lines off one PDF — where the full form twenty times is worse than a
  stub. It keeps flagging `spec_incomplete`.
- **`ProductQuickCreate` and `MaterialQuickCreate` are deleted**, not kept
  alongside. Keeping them is keeping the drift.
- **Masters *module* access is untouched.** These doors do not require the
  Masters nav item, and granting them does not reveal it.
- **The Boards master's own guards come along for free.** The duplicate-name
  `validate` (`Masters.jsx:180`) and the live "No rate on file for *grade* — set
  one in Board Rates" warning both apply inside the PO, so a board added mid-PO
  can neither duplicate an existing one nor silently price at zero.
- `spec_incomplete` is **not** set by these doors. The form is complete, so the
  row is complete. Only the import wizard's stub keeps the flag.

---

## 7. Files touched

**New**
- `client/src/lib/masterConfigs.js`
- `client/src/components/MasterForm.jsx`
- `server/src/master-access.js` + `server/src/master-access.test.js` — the write rule as a pure, tested predicate

**Changed**
- `client/src/pages/Masters.jsx` — imports the extracted config + form; ~440 lines removed
- `client/src/pages/Orders.jsx` — Customer `+`, Product `+` swapped to `MasterForm`
- `client/src/pages/Procurement.jsx` — Vendor `+`, Board `+` swapped to `MasterForm`
- `client/src/components/NewRequisitionModal.jsx` — Board `+` swapped to `MasterForm`
- `server/src/routes/masters.js` — use `master-access.js`; add `min_stock`, `max_stock` to `MASTERS.materials`; audit origin note
- `server/src/routes/board-rates.js` — use `master-access.js` on `POST`

`client/src/components/ui.jsx` is **not** touched — see §5.

**Deleted**
- `client/src/components/QuickCreateMasters.jsx`

No schema change. No migration. `min_stock`/`max_stock` already exist on
`materials`; only the write list is wrong.

---

## 8. Verification

```bash
npm run verify          # server tests + client build
```

Because the Masters page is live and this refactors its core, the extraction is
verified **before** any new door is wired:

1. Extract `CONFIGS` and the form verbatim; point `Masters.jsx` at `<MasterForm>`.
2. In the running app, create **and** edit one record in each of the twelve
   masters, confirming the derived board name/code, the grade → packet seeding,
   the Emboss/Leafing → `special` derivation, and the user access panel all still
   behave.
3. Only then wire the four doors.

Then, per door: create the master from inside the order, confirm it is selected
on the line, confirm the order still saves, and confirm the row in Masters is
identical to one created there directly.

Verify in a clean worktree — a parallel session's stale baseline fails
`npm run verify`.

---

## 9. Risks

| risk | mitigation |
|---|---|
| Masters.jsx is live; extracting its form is the one dangerous edit | It ships as its own step, verified against all twelve masters before a single new door is wired |
| Two masters saving into one `materials` table (Boards inline + Boards in Masters) | Same endpoint, same `validate`, same derived code — the duplicate-name guard is shared, not re-implemented |
| Stacked modals losing the order draft to Escape | The caller-side parent-`onClose` guard already used at both existing call sites; the two new doors adopt it, and it is a named verification step per door |
| Widened `POST` reaching a master this design never intended | The split is per-verb, not per-table, and is stated as such: every master becomes creatable by any login. Accepted above. |
