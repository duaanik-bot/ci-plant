# PO Import — Sales Order PDF → mapped order in one click

**Date:** 2026-07-07 · **Status:** Approved by Anik (design conversation, 2026-07-07)

## Goal

Upload a customer purchase-order PDF on the Sales Orders page, have every line auto-mapped
to the product masters, and create the sales order in one click. Unmatched items prompt a
quick-create of a new product master. Everything stays editable before the order is created.
Matching accuracy converges to exact over time via learned per-customer aliases.

## Decisions (from design conversation)

- **Input:** digital (text-selectable) PDFs. Scanned PDFs are rejected with a clear message;
  OCR is out of scope for now.
- **Engine:** Node-native — `pdfjs-dist` text extraction inside the Express server. No Python,
  no external API. (pdfplumber and LLM extraction were considered and rejected: Python runtime
  dependency / not free respectively.)
- **New masters:** quick create + finish later. Name/rate/GST from the PDF, placeholder board
  and spec, product flagged `spec_incomplete`. Planning readiness gates already block
  incomplete products from production.
- No sample PDFs available yet; parser is built against generic pharma-PO layouts and a
  synthetic test corpus, refined when real uploads arrive.

## Architecture

### Server

- **`server/src/routes/import.js`** — `POST /orders/import/parse` (role: canPlan).
  Multer memory upload (PDF only, size-capped). Pipeline:
  1. Extract positioned text per page with `pdfjs-dist` (legacy build, Node).
  2. Reject when no meaningful text layer → `422 { error: 'scanned' }` with friendly message.
  3. Header parse: customer detection (name/GSTIN fuzzy match against `customers`),
     PO number (labelled patterns: "PO No", "Order No", etc.), PO date, delivery date.
  4. Item-table detection: group text items into rows by Y coordinate; a row is a candidate
     line when it contains a qty-like number and description text; rate/amount recognized by
     column position and ₹/decimal patterns.
  5. Each extracted line is matched via `pomatch.js` against the detected customer's products.
  6. Response: `{ customer: {id?, candidates[]}, po_number, po_date, delivery_date,
     lines: [{ raw_text, qty, rate, match: {status: matched|suggested|none, product_id?,
     confidence, suggestions[]} }], warnings[] }`. **Parse never writes to the DB.**

- **`server/src/pomatch.js`** — matcher, pure functions:
  1. Normalize text (uppercase, strip punctuation/units/pack-size noise, collapse spaces).
  2. Exact alias hit (`product_aliases`) → confidence 1.0.
  3. Exact product code or normalized-name hit → 0.95.
  4. Fuzzy token-set score (Dice coefficient over word tokens + bigrams) against name+code.
     Thresholds: ≥0.85 matched (green), ≥0.5 suggested (amber, top 3), else none (red).

- **Rematch** — `POST /orders/import/rematch { customer_id, lines: [raw_text...] }` re-runs
  `pomatch.js` only (no PDF re-parse) when the user changes the customer in the wizard.

- **Alias learning** — `POST /orders/import/alias { customer_id, alias_text, product_id }`
  called by the wizard whenever the user confirms an amber suggestion, corrects a mapping, or
  creates a master from a red row. Upsert on `(customer_id, alias_norm)`.

- **Quick-create master** — reuses the existing generic `POST /products` (masters.js CRUD;
  add `spec_incomplete` to its column allow-list) with `spec_incomplete=1`,
  auto-generated unique code, placeholder board (first board material), and type-defaulted GST.

- **Order creation** — the wizard posts to the existing `POST /orders`; tolerance snapshot,
  GST resolution, and audit remain unchanged.

### Database (idempotent migration in db.js, matching existing pattern)

```sql
CREATE TABLE IF NOT EXISTS product_aliases (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  alias_norm TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, alias_norm)
);
ALTER TABLE products ADD COLUMN IF NOT EXISTS spec_incomplete INTEGER NOT NULL DEFAULT 0;
```

### Client

- **Sales Orders page:** new **Import PO** button (Upload icon) beside "New Order".
- **`client/src/components/ImportPOWizard.jsx`** — modal in the existing design language
  (glass, `ci-form-panel`, capsule buttons):
  - **Step 1 — Upload:** drag-drop zone / file picker; posts to parse endpoint; spinner;
    friendly errors (not a PDF, scanned, unreadable).
  - **Step 2 — Review & map** (single screen):
    - Header panel: customer Select (pre-selected when detected, candidates listed first),
      PO number, PO date, delivery date — all editable Inputs.
    - Lines panel: one row per extracted line, visually matching the manual line editor
      (clone/delete included). Row status chip: green "Matched", amber "Suggested" (dropdown
      of top-3 + full product picker), red "No match" (raw PDF text + **Create master**
      button). Qty/rate/GST editable; when the PDF rate differs from the master rate an amber
      chip shows both values. Changing the customer re-runs matching (client resubmits parse
      result lines to a light `POST /orders/import/rematch` with the new customer id).
    - Totals: reuse the existing `OrderTotals` component.
    - Footer: **Create Order** (disabled until every kept line has a product + qty).
  - **Create-master inline modal:** name (from PDF, editable), rate (from PDF, editable),
    product type Select (drives GST default), customer fixed; board + technical spec take
    placeholders; saved with `spec_incomplete=1`.
  - On Create Order: save aliases for all user-confirmed/corrected rows, then post the order,
    toast, close, refresh list.
- **Masters page:** products list shows an amber "Spec incomplete" chip; product edit form
  clears the flag when a real board is chosen (checkbox mirrors server value).

## Error handling

- Non-PDF / oversized / corrupt file → 4xx with reason, shown as toast.
- Scanned PDF (no text layer) → 422 with the "scanned copy" message.
- No item table found → parse still returns header fields + empty `lines` with a warning; the
  wizard opens for manual line entry, nothing lost.
- Customer not detected → wizard opens with customer Select empty; matching runs after pick.
- Parse endpoint is read-only; only Create Order (and explicit master/alias creation) writes.

## Testing

`scratchpad/uat-po-import.mjs` (same style as uat.mjs etc., run against real migrated data):

1. Generate synthetic PO PDFs (pdfkit or raw PDF strings) in 2–3 layouts using real customer
   and product names from the DB.
2. Parse → assert customer detection, PO number/date, line extraction counts.
3. Matching: exact-name line → green; perturbed name ("MOXIKIND-CV 625 CTN") → amber with the
   right suggestion; junk line → red.
4. Alias round-trip: correct a mapping, save alias, re-parse the same PDF → line is green 1.0.
5. Quick-create master → product exists with `spec_incomplete=1`, appears in the customer's
   product list, wired into the line.
6. One-click create → order exists with correct lines/rates/GST/tolerance snapshot; parse
   endpoint made no writes before that.
7. Negative: text-free PDF → 422 scanned; non-PDF upload → 4xx.

## Dependencies

`server`: `pdfjs-dist`, `multer` (+ `pdfkit` as a devDependency for the test corpus).

## Out of scope (deliberate)

- OCR for scans (add tesseract later if scans actually arrive).
- LLM-assisted extraction (possible future fallback; costs money).
- Vendor-PO import on the procurement side (same machinery could be reused later).
