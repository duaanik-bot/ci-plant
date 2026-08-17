# A Plate GRN is taken against the PO, and a plate line says what it is

**Date:** 2026-08-17
**Status:** design, approved

## The problem

Two complaints, one root cause: a **plate PO line has an identity nobody renders**, and the
GRN form never let the warehouse choose which of those lines it was receiving.

### The GRN form receives whatever line it feels like

`PlateGrnModal` is opened from the PO register row with a line the *row* picked:

```js
const line = row.lines.find(item => Number(item.received_qty) < Number(item.qty));
… <Button onClick={() => setGrnModal({ po: row, line })}>GRN</Button>
```

A plate PO carries **several plate sets** — the register column even says so
("A PO can carry several plate sets, so its Output is a SET of numbers"). So on a PO with
three sets, the GRN button always opens the **first outstanding** one. The warehouse cannot
say "the Fluence set arrived, the NEO set did not". It receives set one, reopens, receives
set two, reopens again — and at no point chooses.

Inside the modal the plates are a flat checkbox list of `component_label` — "Cyan",
"Magenta". No plate size, no output number, no Pantone code, no product. Nothing that
identifies **which** Cyan out of the three Cyans on that PO.

### A plate PO line does not say what it is

`platePoRows()` returns, per line: `product_name`, `product_code`, `output_number`,
`plate_size`, `request_number`, `jc_number`, `is_gang`, `gang_members`, and a
`components[]` of `{id, component_label, status, pantone_code}`.

Almost none of it is rendered:

| Surface | What it renders | What is wrong |
|---|---|---|
| **PO Edit modal** | ``line.item_name \|\| line.plate_size \|\| `Line ${line.id}` `` | `item_name` is **never returned by the server**. Every line falls through to a bare size ("1030x800") or literally "Line 42". |
| **PO register row** | product names joined, output numbers | no ink detail, no plate size |
| **POPrint** — *the document the vendor receives* | `ti.name` → "Plate 1030x800" | `product_name`, `jc_number`, `request_number` are **fetched by `poRows()` and never rendered**. Components are not fetched at all. The vendor is sent a PO that does not say which artwork or which colours. |

The boards procurement PO is the counter-example and the reference: it prints
`grade · GSM · sheet size · sheets/packet` under the board name, and its GRN form is a
whole-PO table of every line with a per-line receive quantity and a **Fill Full Balance**
button.

## Design

### 1. One shared plate vocabulary, extracted

`ComponentStrip`, `groupedComponents`, `componentKey`, `PlateProductIdentity` and the
component `TONE`/`statusLabel`/`StatusChip` are module-private inside `PlatesLifecycle.jsx`
(2265 lines). The ink strip **already exists**; the three other screens that need it cannot
reach it, which is why each grew its own thinner version or none at all.

Extract to **`client/src/components/plateIdentity.jsx`**. `PlatesLifecycle.jsx` imports them
back — no behaviour change there, and the file sheds ~60 lines.

Add one new export:

```jsx
<PlateLineIdentity line={line} />   // and a `print` variant
```

rendering, in order:

1. product — gang-aware, via `PlateProductIdentity`
2. `request_number · jc_number`
3. `Output NNNNN · 1030x800`
4. the ink strip: component labels with Pantone codes

This is the **one spelling** of a plate line. Four surfaces render it; none of them
reimplements it.

### 2. The server carries what the screens render

- `platePoRows()` (`routes/plates.js`) adds **`component_type`** to its components JSON.
  Needed to order inks CMYK-first and to tell a process plate from a spot plate.
- `poRows()` (`routes/tooling-procurement.js`) gains a **plate-only** `LEFT JOIN LATERAL`
  supplying `components[]` and `output_number`. This is the query POPrint reads; without it
  the vendor document cannot print inks. Family-generic behaviour for die/block is unchanged
  — the lateral yields `'[]'::json` for them.

### 3. The GRN form is taken against the PO

`PlateGrnModal` takes the **PO**, not a line.

- Every line on the PO renders as a group, headed by `PlateLineIdentity`.
- **Line-level checkbox** — tri-state: ticks/unticks every outstanding plate under it,
  indeterminate on a partial selection.
- **Per-plate checkboxes** underneath, each showing its `component_label` and Pantone code.
  A vendor can deliver 3 of a 4-plate set, so per-plate stays.
- **Header controls**: `Select all` / `Deselect all`, and a live `n of m plates` count.
  `Deselect all` keeps the plant's existing wording — `plate-lifecycle-wiring.test.js`
  asserts that literal string.
- **All outstanding plates pre-ticked on open.** The common case is that the full delivery
  arrived; untick what did not.
- A **fully-received line stays visible**, greyed, with a `Received` chip and nothing
  tickable. The form mirrors the PO rather than hiding half of it.
- Receipt context (`rack_location`, `condition`, batch, vehicle, invoice, remarks) stays a
  single panel applying to the whole receipt — as boards' `GrnMetaFields` does.

### 4. `POST /plates/grns/bulk`

Mirrors boards' `POST /grns/bulk`: **one transaction, one GRN per PO line.**

Several GRNs is not a compromise, it is required — a plate GRN row is keyed to one
`tooling_request` / product / plate size (`GET /plates/grns` groups on exactly that), so a
receipt spanning three lines *is* three GRNs. Boards behaves identically, down to the button
label `Create GRN{s}`.

Body:

```json
{ "purchase_order_id": 31,
  "lines": [ { "po_line_id": 88, "component_ids": [201,202,203] },
             { "po_line_id": 89, "component_ids": [211,212] } ],
  "rack_location": "Fresh Plates Rack", "condition": "Good",
  "batch_no": "", "vehicle_no": "", "supplier_invoice_no": "",
  "supplier_invoice_date": null, "remarks": "" }
```

Returns the created GRNs. Per line it runs the **existing** `POST /plates/grns` body of
work — row locks, `plate_assets` creation, `plate_asset_movements`, `received_qty` bump,
`toolingPoStatus` recompute, `syncPlateRequest`, audit — factored into one internal
`receivePlateLine(qc, oc, …)` so the two endpoints can never drift.

Why bulk rather than a loop of per-line POSTs from the client: a mid-way failure would leave
the PO half received with no way to tell which half, and `toolingPoStatus` would have been
recomputed against a state nobody chose.

`POST /plates/grns` **stays** — it is the single-line path and `plate-lifecycle.test.js`
covers it.

## Testing

Each guard is written to **fail first** against the current code, per the house rule.

| Test | Asserts |
|---|---|
| bulk across two lines | two GRNs created, both lines' components move to `available`, both `received_qty` bumped |
| bulk on a fully-received line | refused, **nothing** written (no partial GRN) |
| over-selection | components exceeding a line's pending qty refused |
| `platePoRows()` | components carry `component_type` |
| `poRows('plate')` | lines carry `components[]` and `output_number`; die/block unaffected |
| `plate-lifecycle-wiring` | "Deselect all" literal still present |

Client: `npm run build` plus the existing suite. The GRN modal is `.jsx` and cannot be
`node --test`'d — its selection arithmetic (`selectedCount`, tri-state resolution) goes to
`client/src/lib/plateGrnSelection.js` and is tested there, per the standing rule.

## Out of scope

- No change to plate rates, PR raising, the rack picker or QC.
- No new plate PO **creation** behaviour — that form already carries product, output,
  `ComponentStrip`, size, HSN and totals. It only switches to the shared `PlateLineIdentity`
  so all four surfaces read alike.
- `POST /plates/grns` single-line endpoint unchanged.
