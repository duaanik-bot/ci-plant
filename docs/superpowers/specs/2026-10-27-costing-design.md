# Costing module — design

Written 2026-10-27. The owner asked for a Costing module for new-product development: single-product
costing, bulk costing (5–15 products in one go), a historical size library kept apart from the physical
Die Master, comparison with earlier costings, and exports. His one standing note: **it must be simple
enough that a fresher can take out a costing.** He asked for decisions to be made without a round of
questions, so the calls below are the builder's, listed at the end for him to check.

## The method is his sheet, not a generic calculator

Source: the cost sheet workbook in his Drive (`Cost Sheet Anik Final <date>.xlsx`, tabs `Multi costing
sheet`, `Size chart`, `Sizer`, `Single cositng sheet`). The module reproduces the **Multi costing sheet**,
the tab every real costing since Dec 2022 was taken on (3,164 rows).

Per product:

| Step | Sheet column | Rule |
|---|---|---|
| Sheets | AA | quantity ÷ ups + wastage sheets |
| Board | AB | L × W × GSM ÷ 3100 ÷ 5 × ₹/kg ÷ 100 × sheets (L, W = print sheet, inches) |
| Printing | AD | ₹ per 1,000 sheets per colour × colours × sheets ÷ 1000, never under the minimum (₹1,600) |
| Coating | AE | L × W ÷ factor ÷ 100 × sheets — i.e. ₹1 per (factor × 100) sq in; blank = none |
| Die & pasting | AF | ₹ per carton × quantity |
| Process | AG | fixed ₹ for the job |
| P&F | AI | % × subtotal |
| Misc | AJ | % × (subtotal + P&F) |
| Cost per carton | AL | (subtotal + P&F + misc) ÷ quantity + embossing ₹ per carton |
| Quote | AM | cost per carton + ₹0.05 |

The sheet changed its rules twice; each version is kept so an old costing reworks to its own figures:
`SHEET-A` (2022: no embossing, no minimum), `SHEET-B` (2023: embossing added), `CI-1` (2024 on, and
everything made in the ERP: embossing + minimum printing charge). A new rule is a new version; old
versions are never edited (`server/src/costing-engine.js`, `FORMULAS`).

**Validation against the real workbook (counts only, the workbook stays outside the repo):** 3,030 rows
carry both complete inputs and a sheet result; the engine gives the sheet's own cost per carton for
**3,021** of them (to 1 part in a million). The other 9 (sheet rows 1820, 2432, 2745, 2851–2855, 3050)
are rows where the sheet broke its own rule — a cost cell pointing at another row or column (row 3050's
Board cell multiplies by the die & pasting rate instead of the board rate; rows 2851–2855's Coating cell
divides by GSM instead of the coating factor), or the per-carton cell adding die & pasting where
embossing belongs (row 2432). 16 more rows typed a die & pasting rate into a row whose charging cell was
empty, so the sheet charged nothing; those reproduce once that is recorded. None of these is "fixed":
the old record keeps the sheet's figures and carries a note saying where it broke, and the register's
"Sheet figure differs" chip lists them. 12 rows repeat an earlier row exactly; they load once, noted.

**Not adopted, flagged for the owner:** the `Single cositng sheet` tab is a different method (adds 10%
plant cost on everything but board, and 5% profit on a base that counts the subtotal twice —
`=C19*SUM(F9:F13)` where F12 is already the sum of F4:F11). It holds one worked example and no history,
so the module follows the Multi sheet. If the plant still uses the single tab for some quotes, that is
a second formula version to add, not a change to this one.

## Sizes: a library apart from the Die Master

- `costing_sizes` is the **Size Library**: every size the plant has costed — 977 entries from the Size
  chart (980 rows, 3 exact repeats merged) plus 299 layouts found only in costing rows = 1,276, and 11
  more from a later copy of the workbook that holds only the Size chart. It never needs a die to exist.
  The Die Master — the Tooling Hub's die family (`tools`, family `die`), not the legacy `dies` table it
  was copied from — is read, never written.
- One entry = size (L × W × H mm, or L × W for flat work) + pasting style + layout (sheet L × W in, ups).
  Rows agreeing on all of these are merged, every source row kept in `source_refs` for tracing. The same
  size with a different pasting or a different layout stays a separate entry because it costs
  differently; such groups are listed under "Possible duplicates" for a person to retire one, never
  merged automatically (127 same-size/several-layout groups, 50 same-size/different-pasting, 36 sizes
  typed in another L/W/H order).
- Typed sizes are read to one key whatever the spelling (`165X58X73`, `165 x 58 x 73`, `165*58*73`,
  `165×58×73 mm`, `165X58X73R0`). L, W, H order is kept: a different order is a different key.
- Size check (single form and every bulk row): exact library entries, near entries (each side within
  ±2 mm, or the same three numbers in another order), and — shown separately — dies whose carton size
  matches exactly or nearly. A near match raises "Did you mean …?" so a mistyped size is caught.
- The `Sizer` tab is ported as the **Size helper** (blank L = ((L+W)×2 + 10 mm flap)/25.4 × across;
  blank W = (((W/2+10)+H+W+12)×2 − W − 12)/25.4 × down; ups = across × down × 2). Tested against the
  980 real layouts it is a guide only (half the real layouts are larger than it proposes, a sixth
  smaller), so it fills a starting point for a new size and **never warns** about a chosen layout.

## Screens (one top-level module, "Costing")

1. **New costing** — one page, top to bottom, plain words and units on every field, typical values as
   hints, defaults pre-filled from current practice (wastage 250, 4 colours, ₹400 printing, ₹1,600
   minimum, ₹2,000 process, ₹0.30 die & pasting, 5% P&F, ₹0.05 margin). Board grade picks the ₹/kg from
   the ERP's Board Rates; coating is a required choice ("No coating" is a choice). The result card
   updates as you type: cost per carton, quote, order value, and a "How it was worked out" table with
   one line per cost item in words and numbers. Below it: past costings of the same size with the
   difference and the inputs that caused it.
2. **Bulk costing** — a batch is a table, one row per product. Paste product / size / quantity rows
   straight from Excel; each row's sheet layout fills from the Size Library (the most used layout of
   that size) when the row has none. Common settings carry into the rows that still follow them (the
   box is blank or holds the common value as it was); a row given its own value keeps it, and only the
   ↓ button beside a setting copies it over every row. Each row keeps its own complete inputs, and on
   save only a row whose inputs changed gets a new revision. Rows show status (Ready / Needs …),
   earlier costings and dies of the size, notes; the folder button opens the full single-costing view
   for one row. Save, reopen, export (internal breakdown, or a quotation sheet for the customer).
3. **Saved costings** — every costing (ERP-made `CST-0001…`, and the old sheet's rows as `OLD-<row>`),
   searchable by customer, product, size, date; filters for no size reference / big difference; each
   one opens with its breakdown and its revision history.
4. **Size library** — the entries with times costed, last costed, die match; "Possible duplicates" view.
5. **Rates** — the defaults above, coating factors (name them), and the difference alert (15%).

Exports (Excel or PDF through the app's export engine): a single costing's internal breakdown, a
bulk batch's internal breakdown, and for either a quotation sheet for the customer (product, size,
quantity, price — no board, rates, margins or internal cost); the saved-costings list and the Size
Library as tables.

Not built (left for a later round): a report across ALL costings of where the cost of the same carton
moved by more than the alert %, and costing in more than one quantity at once (the sheet costs one
quantity per row; a second quantity is a copied row).

## Data

New tables only (`supabase/migrations/20261027120000_costing.sql`): `costing_sizes`,
`costing_batches`, `costings`, `costing_versions` (append-only revision history: inputs, formula
version, result, note, who, when), `costing_settings` (one row). No foreign key leaves the costing
tables: customer, product and user are kept as id + name snapshot, so plant masters can be edited or
deleted without touching a quotation record (and the dev seed's `TRUNCATE … CASCADE` cannot wipe it).
Old sheet rows are loaded by `scripts/costing-import-sheet.mjs` (dry run by default; `--apply`),
which reads the workbook from outside the repo.

## Access

Module key `costing`, ticked per user in Masters → Users like every module. The server checks the tick
on reads as well as writes for `/api/costing/*` — quotation prices are commercial data.

## Calls made by the builder (for the owner to check)

1. Multi sheet adopted as THE method; single-sheet method flagged, not built.
2. Coating factors are kept as numbers and shown as "₹1 per 600 sq in" etc. The sheet never names them
   and ERP product coatings do not line up one-to-one with factors, so naming them (e.g. "6 = aqueous
   varnish") is left to the owner on the Rates tab.
3. Pasting codes shown with a gloss: LOCK "Lock bottom", SIDE "Side pasting", LIT "Leaflet". HS and CC
   are shown as typed (meaning unknown).
4. Historical party names are kept as typed and not linked to ERP customers (271 rows carry a number in
   the Party column instead of a name; they are flagged).
5. The Size helper never blocks or warns (see above).
6. Difference alert at ±15% against the most comparable earlier costing (same size and pasting, GSM
   within ±10, newest first, then nearest quantity).

---

# Upgrade, 2026-10-30 — an estimating engine that fills itself in

The owner's second brief: make the costing model intelligent, automated and much simpler on screen,
simplify coating, rework bulk costing around quantities, and make the one engine the centre of single,
bulk and quotation work. Nobody had saved a costing in production yet, so the screens could be reshaped.

## Audit of what was live (main@8d024ef7)

| Brief asks | What was there |
|---|---|
| Auto-fill from the ERP | Optional "start from a product" search; Size Library "Use" buttons; board rate by grade. Nothing chosen automatically, no sign of where a value came from. |
| Simple screen | Five steps, ~22 boxes all open at once. |
| Simple coating | A factor dropdown ("₹1 per 600 sq in (factor 6)"). No way to say how many sheets get coated. |
| Bulk by quantity | Bulk = many products in one table. No way to compare quantities; set-up and running cost not separated. |
| Approval + quotation | Customer quotation export only; no approval. |

## Benchmark (vendor material on carton / print estimating)

What the estimating tools have in common and fits the plant's method: quantity breaks with set-up cost
amortised over the run and shown apart from running cost; make-ready (set-up) waste as a per-job
allowance; automatic choice of the most efficient layout with the alternatives and their cost still
visible; templates from the product record; an approval step before a quote goes out. Not adopted:
machine-hour cost centres — the plant's sheet has no machine rates, and inventing them would change the
method.

## What the history says (3,152 old costings, read-only study)

- **Wastage does not grow with run length**: median 300 sheets in every run band from <500 to 20,000+
  sheets. It is a fixed set-up allowance; the quantity comparison keeps it fixed.
- **Die & pasting follows the pasting style**: Lock bottom ₹0.30, Side ₹0.20, Leaflet ₹0.15 (medians, 2024 on).
- **Process charge ≈ ₹500 a colour** (2 → ₹1,000, 4 → ₹2,000, 8 → ₹4,000–5,000).
- **Embossing when used**: ₹0.10 / ₹0.15 / ₹0.20 (median ₹0.15).
- **Coating factor does NOT follow the Product Master's coating name** (Aqueous jobs were costed at
  factor 6, 2 and 3; Drip Off at 2, 6 and 3), so coating is never guessed from the name: it comes from the
  same product's or the same size's last costing.

These "typical" figures are worked out live from the costings table, so they move with practice.

## The upgrade

1. **One engine** (`computeCosting`) for single costing, bulk rows, quantity breaks and quotations.
   - New, optional coating inputs: `coat_rate` (₹ per 100 sq in — the factor's plain form, 1 ÷ factor)
     and `coat_sheets` (sheets to coat; blank = every sheet). Without them every costing works out
     exactly as before (CI-1 unchanged; all 3,021 reproduced rows still reproduce).
   - Every result splits **set-up (fixed)** — wastage sheets' board, printing and coating, the process
     charge, a minimum printing charge — from **running (variable)** cost; P&F and misc follow each part.
     Set-up + running = the total, to the paisa.
   - `quantityBreaks()` reprices the same costing at other quantities: the per-carton fall shows
     economies of scale from the set-up cost spreading.
2. **Recommendations with a visible source.** Pick a product → size, pasting (LOCK BOTTOM → Lock, BSO →
   Side), print sheet and ups, GSM, colours, board grade → today's ₹/kg, and embossing come from the
   Product Master; the sheet layout from the Size Library (most used; the others listed with their
   cost a carton, cheapest marked); coating and die & pasting from the last costing of the product or
   size, else typical for the style; process from colours. Every box shows where its value came from —
   Product, Size Library, Board Rates, Past costing, Typical, Default — or Edited once typed. A typed
   value is never overwritten.
3. **A short screen.** Product · customer · quantity, then Carton and Print & finish; the rate boxes
   (wastage, printing rate, minimum, die & pasting, process, P&F, misc, margin, target) sit under
   "More settings", closed. The working is a click away.
4. **Coating in plain words**: choose a rate (₹ per 100 sq in, the plant's usual three as buttons) or
   none; sheets to coat fill themselves (editable); the screen shows ₹ a sheet and the coating total.
5. **Bulk**: pasted product names that match the Product Master fill their specs; die & pasting follows
   each row's style unless set in common; "Also price at" quantities add per-carton columns; the
   quotation sheet carries a price column per quantity.
6. **Approval**: a logged-in user with the Management right approves a complete costing (or every ready
   row of a batch); changing its figures sends it back to Draft. The quotation export of an unapproved
   costing is stamped DRAFT. Migration `20261030120000_costing_approval.sql`.
7. **Coating factors** (owner's ask): 5, 4, 2.5, 1 and 0.5 join the sheet's 6, 3 and 2 as buttons, cheapest
   first, each showing its factor under its rate. An old costing's factor that is not a button gets one
   while it is the choice in force. Migration `20261030130000_costing_coating_factors.sql` (starting list
   only; an edited list is left alone).
8. **A new size joins the library on a yes** (owner's ask), no longer silently on saving. Typing a size +
   pasting + layout the library has not seen raises the question in the form (Yes, save it · Not now);
   left unanswered, saving asks. "No" saves the costing without an entry (`save_size: false`), and it
   shows under "No size in library" in Saved costings; a different layout is a new question. Bulk asks
   once on saving, listing the new sizes.
