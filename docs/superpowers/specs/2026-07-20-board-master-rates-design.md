# Board Master, Category Rates & Weight-Aware Procurement — Design

**Date:** 2026-07-20
**Status:** Approved for planning
**Source of truth for rates:** `Materials-Master_2026-07-20.xlsx` (an export of this ERP's Materials master, extended by the plant with rate/weight formulas)

## Problem

Board is bought by weight, but the ERP has no concept of weight at all.

- `materials` has **no `gsm` column**. GSM is regex-scraped out of the free-text name (`smartmatch.js:21`, `orders.js:817`) wherever it is needed.
- `grep -rniE "weight"` over `server/src` and `client/src` returns **zero matches**. No kg is computed anywhere.
- Rates are hand-typed per board. 303 boards, and `std_rate` is set on **none** of them.
- `ProcurementForms.jsx:19-28` fills a PO line's rate from `mat.last_rate`, so picking a board in a Direct PO **silently ignores the rate master** — only the PR-convert and bulk paths honour `std_rate`.

The plant already solved this in Excel: a ₹/kg rate per board family, from which packet weight and packet rate derive. This design moves that model into the ERP.

## Verified current state (2026-07-20)

Queried against the live embedded Postgres (`:5439/cierp`) after the LAUNCH wipe:

| Fact | Value |
|---|---|
| Board materials | 303 |
| Boards with `std_rate` set | **0** |
| Boards with `last_rate` set | 8 |
| `po_lines` rows | **0** |
| Available stock batches | **0** |
| Leftover (`LO-`) boards | 0 |
| Vendors | 19 |

**No PO or stock data exists**, so rate semantics can be defined cleanly with no legacy migration.

Name parse validation across all 303 rows using
`/^\s*(.+?)\s*·\s*(\d{2,4})\s*GSM\s*·\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*$/i`:

- **302 parsed, 1 failed.** The failure is `id 278 'Unspecified board'` — a placeholder with no sheet size.
- **Zero** disagreements between the parsed L×W and the stored `sheet_l`/`sheet_w`. The naming convention is reliable.
- Grades: Saffire 104, FBB 101, Duplex WB 52, Duplex GB 41, Paper 3, Chromo Paper 1.

## Decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | Rate basis | ₹/kg master, **₹/sheet derived**. POs keep ordering in sheets. |
| 2 | Rate key | **Grade + vendor** |
| 3 | Missing vendor rate | **Base rate per grade, vendor rows override it** |
| 4 | Board entry form | **Fully structured; name + code auto-composed** |
| 5 | PO/pending detail | Weight columns · rate provenance · print spec block · pending ageing (all four) |

**Assumption:** ₹/kg is *exclusive* of GST. GST 18% applies on top, as today. The Excel's packet rate carries no tax, which supports this.

## Data model

### New table `board_rates`

```sql
CREATE TABLE IF NOT EXISTS board_rates (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grade TEXT NOT NULL,
  vendor_id INTEGER REFERENCES vendors(id),   -- NULL = base rate, applies to every vendor
  rate_per_kg DOUBLE PRECISION NOT NULL,
  effective_from DATE,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_board_rates_grade_vendor
  ON board_rates(grade, COALESCE(vendor_id, -1));
```

`COALESCE(vendor_id, -1)` is required because Postgres unique indexes do not treat two `NULL`s as equal — without it, duplicate base rates for a grade would be allowed.

**Resolution order:** `(grade, vendor_id = X)` → `(grade, vendor_id IS NULL)` → none (rate-less).

### New columns on `materials`

```sql
ALTER TABLE materials ADD COLUMN IF NOT EXISTS grade TEXT;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS gsm INTEGER;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS sheets_per_packet INTEGER;
```

`sheet_l` / `sheet_w` (inches) already exist (`db.js:126`). All three new columns must be added to the writable whitelist at `masters.js:32`.

### Derived values — computed, never stored

```
kg_per_sheet   = gsm × (sheet_l × 0.0254) × (sheet_w × 0.0254) / 1000
packet_weight  = kg_per_sheet × sheets_per_packet
rate_per_sheet = kg_per_sheet × rate_per_kg
packet_rate    = packet_weight × rate_per_kg
```

These reproduce the spreadsheet's columns J and K exactly. Full precision is kept internally; rounding is display-only (3 dp for weight, 2 dp for money) to avoid compounding error in PO totals.

Because nothing is cached, editing a grade's ₹/kg reprices every board in that grade instantly, with no backfill.

**Implementation:** one helper module on the server with a client twin, following the existing `helpers.childFit` / `WarehousePicker.clientFit` precedent. Both must be covered by tests asserting identical output.

**`std_rate` on boards is superseded** — board ₹/sheet is derived. `std_rate` remains the manual rate for ink / foil / adhesive / laminate, which are bought per kg or litre directly. The Board Rates *tab* at `Masters.jsx:146-163` (today a boards-filtered projection of `/materials`) is replaced by the real rate sub-module described below.

### Leftovers

Leftover boards are `materials` rows with `leftover=1` and `source_material_id` (`db.js:637-638`). They inherit `grade` / `gsm` / `sheets_per_packet` from their source board so their weight computes correctly; only `sheet_l`/`sheet_w` differ. There are zero leftovers today, so this is forward-looking — the inheritance must be applied at creation time in `helpers.js:126-138`.

## Migration

An idempotent, re-runnable backfill that **updates the 303 existing rows in place** — matched by `id`, so no inserts and no duplicate masters.

1. Parse each board name into grade / GSM / L / W. Write `grade`, `gsm`. Leave the verified-correct `sheet_l`/`sheet_w` untouched.
2. Seed `sheets_per_packet` by grade: Duplex GB / Duplex WB → 144; FBB / Saffire / SBS → 100; Chromo Paper → 150. Paper → `NULL`.
3. Seed `board_rates` base rows: Duplex GB 45, Duplex WB 51, Saffire 81, FBB 79. No vendor rows.
4. Generate a `spec` code for the **61 boards that have none**, collision-safe against the 242 codes already in use. Existing codes are never rewritten — they are referenced elsewhere in the plant.
5. Report every unparsed row rather than skipping silently.

**Known rate-less after migration** (all correct, matching the Excel's `—`):
- `Paper` (3 boards) and `Chromo Paper` (1) — no rate in the source spreadsheet.
- `id 278 'Unspecified board'` — placeholder, unparseable, no sheet size. Gets no grade and no weight.

These surface the amber "no rate on file" state until a rate is entered.

## Board master UI

`client/src/pages/Masters.jsx` (826 lines, one generic `CONFIGS`-driven CRUD engine).

### Boards tab — structured form

Fields: **Grade** (dropdown, sourced from `board_rates`) · **GSM** · **Sheet L** · **Sheet W** · **Sheets/Packet** (auto-fills from grade, editable) · HSN · GST % · Reorder Level · Active.

`name` and `spec` are composed live and rendered **read-only**:
- name → `'{Grade} · {GSM} GSM · {L} x {W}'`
- spec → `'{round(L)}{round(W)}{GRADE_CODE}{GSM}'` (e.g. `2531DPGB330`)

Both rules were reverse-engineered from the live data and verified, not invented:

| Grade | Code |
|---|---|
| Duplex GB | `DPGB` |
| Duplex WB | `DPWB` |
| Saffire | `SAFF` |
| FBB | `FBB` |
| Paper | `PAPR` |
| Chromo Paper | `CHRM` (new — the single existing row carries no spec code) |

- The numeric prefix is `round(sheet_l)` concatenated with `round(sheet_w)`, confirmed with **zero mismatches** across every board that has a spec code.
- Codes collide (same grade, GSM and rounded size, different exact size). The existing data resolves this with a `-N` suffix — `DPGB285-1`, `SAFF280-1`, `SAFF320-1`. The generator must reproduce that: on collision, append `-1`, `-2`, … The grade-code map lives in one place and is extended when a new grade is added to `board_rates`.
- **61 boards currently have no spec code at all.** The migration generates codes for them; the generator must therefore be collision-safe against the 242 codes already in use.

A preview strip shows **kg/sheet · packet weight · ₹/kg · ₹/sheet** before saving. Duplicates are rejected on the composed name.

The generic form loop (`Masters.jsx:530-591`) needs a new derived/read-only field type and a live-preview slot; today it only renders `Input` and `Select`. Note the materials tabs render `grid-cols-1`, so existing `newRow` flags are inert — the layout needs `grid-cols-2` for this form to read well.

List columns: Name · Grade · GSM · Sheet Size · Sheets/Pkt · kg/Sheet · Packet kg · ₹/kg · ₹/Sheet · Active.

### Board Rates sub-module

A dedicated rate master, not a filtered material list. One row per grade showing its base ₹/kg, expandable to vendor-specific override rows.

- Each grade row shows its blast radius — *"affects 104 boards"*.
- Saving a change previews the resulting ₹/sheet shift before committing.
- Rate edits are audited automatically: `materials` already carries `history: 'materials'` (the 360° drawer); `board_rates` must be registered with the same audit/timeline mechanism.

New endpoints: `GET/POST/PUT/DELETE /api/board-rates`, following the `masters.js:41-129` generated-route pattern, gated by `requireRole('planner')` as the other masters are.

## Procurement

### Rate resolution fix

`fillFromMaterial` (`ProcurementForms.jsx:19-28`) and `fillFromMaterialPr` (`:119-123`) both read `mat.last_rate`. `PoLineEditor` accepts no injection hook, so `Procurement.jsx:149`'s `matRate` helper is bypassed on the Direct PO, Edit PO and convert-PR forms.

Fix: give the editors a resolver prop so all five paths — Direct PO, Edit PO, convert-PR, bulk PO, quick-create — resolve rate identically. Server-side, the fallback chains at `procurement.js:239` and `:299-301` must resolve through `board_rates` for boards before falling back to `std_rate` / `last_rate` for non-boards.

Changing a PO's **vendor** re-resolves every line's rate, prompting first if any line was hand-edited.

`last_rate` write-back on PO save (`procurement.js:69`, `:449`) is unchanged — it remains reference-only and never writes to the rate master.

### PO line editor and totals

Line columns gain **kg/sheet · packets · total kg** alongside the existing Material · HSN · Qty · UOM · Rate · Disc% · GST% · Amount.

Each line shows a **provenance chip**: `Saffire @ ₹81/kg (base)` · `(vendor)` · amber `(overridden)` when the typed rate differs from the resolved master rate.

`PoTotalsPanel` (`ProcurementForms.jsx:199-251`) gains total sheets / packets / kg beside the existing GST breakup.

Packets are display-derived (`qty ÷ sheets_per_packet`) and may be fractional; the PO still transacts in sheets. Nothing rounds qty to whole packets.

### Print

`client/src/pages/POPrint.jsx` gains a Grade · GSM · parent-size sub-line per item (replacing the bare `spec` line at `:102-119`) and a summary strip totalling sheets / packets / kg / taxable. The A4 single-page print constraints already in place must be preserved.

### Pending list

`GET /procurement/pendency` (`procurement.js:731-781`) and the Pendency tab (`Procurement.jsx:699-861`) gain:

- **Pending kg** per line and in the KPI strip
- **Ageing buckets** 0-7 / 8-15 / 16-30 / 30+ days
- Overdue highlighting against `expected_date`
- **Last GRN date** per line
- **Grade-wise** roll-up (new) and weight added to the existing vendor-wise roll-up. The `by_category` rollup is already computed server-side but never rendered — surface it rather than adding a parallel one.

Existing semantics are preserved: pending is driven by `po_lines.received_qty`, which only increments on **QC acceptance** (`procurement.js:800`), so material in quarantine still reads as pending. This is intentional and must not change.

## Warehouse

`GET /inventory/stock` (`inventory.js:10-37`) and the RM Stock tab (`Inventory.jsx:199-210`) gain a **Total Weight (kg)** column = `available sheets × kg_per_sheet`, plus a total-weight KPI in the header strip.

Boards with no GSM (i.e. `id 278`) render `—` rather than `0`, so a missing master is visibly distinct from genuinely empty stock.

The Leftover sub-tab (`Inventory.jsx:278-309`) gains the same column, working off inherited grade/GSM.

## Build order

Four separable phases, each verifiable against the running app before the next begins:

1. **Model + migration** — `board_rates` table, `materials` columns, shared weight helper + client twin, backfill script.
2. **Board master UI** — structured form, Board Rates sub-module, endpoints.
3. **Procurement** — rate resolution fix, weight columns, provenance, totals, print, pending list.
4. **Warehouse** — total weight columns and KPI.

## Testing

- **Weight helper parity** — server and client twins produce identical output across the full 303-board set.
- **Golden values** — kg/sheet, packet weight and packet rate reconcile against the spreadsheet's computed column J/K values for a sample spanning all four rated grades.
- **Rate resolution** — vendor row wins over base; base applies when no vendor row; rate-less grade returns null and does not fall through to `last_rate` for boards.
- **Migration idempotency** — running the backfill twice produces no row-count change and no value drift.
- **Code generation** — regenerating the name/code for every existing board reproduces its current stored value exactly (for the 242 that have one), proving the composition rule before it is trusted to author new masters.
- **Regression** — `po_lines` totals, GST breakup and the A4 print layout are unchanged for a non-board PO.

## Out of scope

- Per-board rate overrides (decision 2 chose grade + vendor; a single board deviating needs its own vendor row).
- GSM-band pricing.
- Rate effective-dating logic — the `effective_from` column is recorded but not used for time-travel pricing in this pass.
- Any change to how planning, cutting or gang logic consume boards.
- Non-board material rates, which keep the existing manual `std_rate`.

## Notes

- Per project convention, no git commits are made in `ci-erp`; all work stays local.
- Server edits may not hot-reload — verify against a temp server on a spare port reusing the live PG on `:5439`.
