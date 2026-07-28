# Purchase-order form redesign — line cards and a findable board picker

**Date:** 2026-07-28
**Status:** approved

## The problem

Two complaints, one root cause.

### The board dropdown looks broken

It isn't. `MaterialPicker` already passes `searchText(m)` as `data-search`, and
`SearchableSelect` already squash-normalizes the haystack, so typing `2228`
genuinely does resolve a board stored as `Chromo Paper · 205 GSM · 22 x 28`. The
mechanism works. You cannot *use* it:

- `PoLineEditor`'s table is `min-w-[980px]` across twelve columns inside a
  `max-w-5xl` modal (1024px, less 40px of padding = 984px). Eleven of those
  columns carry an explicit width; `Board` does not, so it collapses to whatever
  is left — roughly 70px. The type-ahead input *is* that width, so you cannot
  see what you type.
- The portal menu is positioned `width: rect.width` (`ui.jsx`), i.e. the width
  of the trigger. A 70px menu plus `break-words` wraps every label
  character-by-character: `Chro / mo / Pape / r · 20`.
- The option row prints only `m.name`. The spec code that caused the match is
  never shown, so a hit reads as arbitrary — the opposite of the warehouse
  list, where the spec code is a visible column.

### The form does not separate what you type from what it computes

Twelve identical grey cells. `kg/Sheet`, `Packets` and `Total kg` are *derived*
and sit at the same visual weight as `HSN`, `Qty` and `Rate`, which are *typed*.
On an empty line all three print `—`, so a third of the row is noise. The whole
form reads as one undifferentiated wash and scrolls sideways.

## Design

### 1. Line cards

Both line editors drop their tables for `.ci-line-item` cards, following the
Sales Order pattern already established at `Orders.jsx:919` — same wrapper, same
line-number badge, same `bg-slate-50` amount box, same icon-button cluster.

A PO line carries six typed fields to a sales-order line's three, so one row
would re-create the squeeze. The PO card is therefore **two tiers**:

```
┌────┬─────────────────────────────────────────────────┬─────────┐
│ 01 │ [Chromo Paper · 205 GSM · 22x28        ▾] [🔍][+]│  ⧉   🗑  │
│    │ 2228205CHRM · HSN 48102900                      │         │
├────┴──────┬───────┬────────┬────────┬───────┬────────┴─────────┤
│    HSN    │  Qty  │  UOM   │ Rate ₹ │ Disc% │ GST%  │  Amount  │
│  [48102…] │[2,000]│[sheets]│[18.40] │  [0]  │ [18]  │ ₹43,424  │
│           │       │        │ Saffire @ ₹92/kg (vendor)         │
│  4.2 pkt · 0.0412 kg/sheet · 82.4 kg                           │
└────────────────────────────────────────────────────────────────┘
```

- **Tier 1** — line number, board picker (with magnifier and quick-create),
  amount, actions. The picker gets ~600px instead of 70px. Spec code and HSN sit
  underneath in the `ProductSpec` idiom.
- **Tier 2** — a labelled grid. Every number gets a real `<label>`, not a
  placeholder that disappears the moment you type into it. `RateProvenance`
  stays under the rate.
- **Derived strip** — packets, kg/sheet, total kg. Renders **only** when
  `qty > 0` and the board has a computable weight. An empty line stays short,
  and a board with no GSM prints nothing rather than three em-dashes. This
  matches how `StockStrip` and the `PoTotalsPanel` weight roll-up already behave.
- **Clone line** button added. PO lines have no clone today and near-identical
  board lines are common.

`lockFn` behaviour is unchanged: a line with `committed_qty > 0` disables the
picker, disables removal, and keeps its amber "received/in-QC — locked" note.

`PrLineEditor` converts to the same card, one tier — it has no HSN/GST fields.
It keeps `StockStrip`, the per-line remark input, and the `activePrsFor`
duplicate-PR warning.

### 2. Dropdown

**Global fix (`ui.jsx`).** The portal menu stops inheriting the trigger width:

```
width: Math.min(Math.max(rect.width, 460), window.innerWidth - 24)
```

with `left` pulled back when the menu would overflow the right edge. This is
deliberately global — it repairs every dropdown in the app that sits in a narrow
cell, not only this one. It touches the popup geometry of all 46 option sites;
none of their contents change.

**Local.** A new optional `renderOption` prop on `SearchableSelect`. When absent,
rendering is byte-identical to today, so no existing call site changes.
`MaterialPicker` passes one:

- left: board name, then spec code and HSN in mono
- right: live available stock (sheets and packets) and the resolved ₹/sheet for
  the selected vendor
- zero or negative stock renders amber

You can now see why a row matched and whether it is worth ordering.

### 3. Board picker modal

New `client/src/components/BoardPicker.jsx`, opened by a magnifier beside the
inline picker. Shell mirrors `WarehousePicker` — `Modal wide`, `SearchInput`,
tick filters — but filtering is **client-side** via `rowMatches`. Procurement
already holds all 303 boards from `/materials`, so server-side search and
pagination would be plumbing for no gain at this row count.

Columns: Board · Spec code · Grade/GSM · Sheet size · Available · ₹/sheet ·
Select. Ticks: "In stock only", "Active only".

`MaterialPicker` moves into this file. It is shared by both line editors, and
`ProcurementForms.jsx` is already 378 lines.

### 4. Plumbing

`Procurement.jsx` loads `/inventory/stock` alongside `/materials`, with the same
`.catch(() => [])` and the same `stockFor` shape `NewRequisitionModal.jsx:88`
already uses. One array feeds both the option row and the picker modal.

The PR modal at `Procurement.jsx:1019` currently omits `stockFor` entirely, so
its live-inventory strip never renders despite `PrLineEditor` supporting it.
Fixed in this pass.

## Scope

`PoLineEditor` is shared by four paths — Direct PO, Edit PO, convert-from-PR,
and bulk-from-selection. All four get the card layout. `MaterialPicker` is shared
with `PrLineEditor`, so the requisition form gets the rich dropdown and the
magnifier too. This is deliberate: a Direct PO that looks unlike an Edit PO is
worse than either one.

Out of scope: the vendor dropdown, `PoTotalsPanel`, `PoMetaFields`, the PO print
template, and every server route. This is a client-side presentation change —
no schema change, no new endpoint, no migration.

## Decided during implementation

Three things the wider layout exposed, all fixed in this pass:

1. **Derived rates printed as raw floats.** A board's ₹/sheet is
   `kgPerSheet × ₹/kg`, so `/board-po-rates` returns `6.404212998`. The old 70px
   rate cell truncated it out of sight; a full-width field does not. The resolved
   rate is now rounded to 2dp as it enters the input (`money()` in
   `ProcurementForms.jsx`). This lands inside the 0.005 tolerance
   `RateProvenance` already uses before calling a rate overridden, so provenance
   still reads "(base)" rather than flipping to "Overridden". A rate the buyer
   typed is never rounded. Server-side rate math is untouched.
2. **`BoardSpec` repeated the board name.** It printed spec code *and*
   `grade · GSM`, but the name two lines above already reads
   `Duplex GB · 230 GSM · 20x38`. HSN takes that slot instead — it drives the
   line's tax and is otherwise invisible until you look at the HSN field. The
   browse table lost the same duplicate subtitle.
3. **The PR card stacked amount over its own action buttons** in one 76px
   column. Amount and actions are now sibling columns, matching the PO card.

## Verification

Done, on 2026-07-28:

- `npm run build -w client` — clean. `node scripts/build-baseline.mjs --check` —
  baseline unchanged, correct for a client-only change. `npm test -w server` —
  301/301 pass.
- Live app at 1280×720 (API 4310, client 5310, against local PG 5439), logged in
  as admin. Confirmed: card layout with no horizontal scroll; `2038` resolves
  boards stored as `20x38`; `saff 3242` ANDs grade against code; exact spec code
  `3242300SAFF` resolves one board; the dropdown row shows spec code, live stock
  (80 pkt / 8,000 sheets) and ₹20.49/sheet with amber for zero stock and no rate;
  the magnifier modal lists 327 boards with both filters; the derived strip
  appears only once a qty is entered (16.67 pkt · 0.1423 kg/sheet · 341.56 kg)
  and agrees with the `PoTotalsPanel` roll-up; a fresh pick rates at `20.49`
  while a pre-existing rate is left alone; the PR card shows the same rich
  dropdown plus its live `StockStrip`. Console clean throughout. No records
  were created.

Not exercised, because the launch wipe left no purchase order to open: the Edit
PO locked-line path (`lockFn` → disabled picker, disabled remove, amber
"received/in-QC" note). Its wiring is carried over unchanged, but it has not been
seen on screen.
