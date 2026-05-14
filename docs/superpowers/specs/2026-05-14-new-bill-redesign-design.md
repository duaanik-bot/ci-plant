# New Bill Page Redesign — Design Document

**Date:** 2026-05-14
**Owner:** Anik Dua
**Status:** Draft — awaiting approval

---

## 1. Problem

The current `New Bill` page ([src/app/(dashboard)/billing/new/page.tsx](../../../src/app/(dashboard)/billing/new/page.tsx)) is a 4-field skeleton:

- Header: Customer + Bill date.
- Lines: free-text Description, Qty, Rate, GST%, Job-card link.
- No live totals, no tax split, no HSN/UOM, no due date, no buyer PO reference, no place-of-supply, no notes/terms, no print.

A GST tax invoice in India legally requires HSN/SAC, CGST/SGST or IGST split, place of supply, GSTIN, and a sequential invoice number. The current page produces a document that wouldn't pass a basic audit, and the operator can't see what they're billing until after `Create bill` is pressed.

By contrast the `New PO` page ([src/app/(dashboard)/orders/purchase-orders/new/page.tsx](../../../src/app/(dashboard)/orders/purchase-orders/new/page.tsx)) is fully built out: sticky header, master-picker line items pulling from `Carton` master, line drawer, audit signals. The bill page should match that polish *and* add the tax-invoice fields that PO doesn't need.

## 2. Goals

- Match the visual and interaction quality of the New PO page.
- Produce a GST-compliant tax invoice (HSN, CGST/SGST/IGST split, place-of-supply logic).
- Show **live** taxable / tax / total values while typing — operator never has to guess.
- Pull line specs from `Carton` master so descriptions, rates, HSN, GST% are consistent across the system.
- Preserve the existing PO-reconciliation flow that runs after save — that part already works.

## 3. Non-goals (v1)

- Generating IRN / e-invoice via GSTN (separate compliance project).
- PDF rendering and email send — scaffolded in UI but actual PDF template lands in P4.
- TDS/TCS deductions, foreign-currency / export invoicing, advance receipt linking. All deferrable.
- Editing existing bills' line items — current detail page is read-only on lines; keep that.

## 4. Scope decision: full carton master with no-PO badge

**Decided with user (2026-05-14):** the line-item item picker shows the customer's **full Carton master**, not only cartons with open POs. When the picked carton has no matching open PO line for this customer, the row shows a neutral badge ("No open PO") — informational, not a block. This supports freight, samples, reprints, and ad-hoc billing while still surfacing the reconciliation signal.

Free-text fallback remains for one-off charges (freight, packing, late fees) that aren't in the master. The fallback is per-row (any row can be a master pick *or* a free-text line), not a separate dedicated row.

## 5. Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│ Sticky PageHeader (title + Draft badge + Save / Cancel)      │
├──────────────────────────────────────────────────────────────┤
│ Header card                                                  │
│  Row 1: Customer (autocomplete, shows GSTIN/state in meta)   │
│         Invoice # (auto preview, override field)             │
│         Invoice date                                         │
│  Row 2: Due date (auto = inv date + customer.paymentTermsDays)│
│         Payment terms (Net N / Advance / COD; from customer) │
│         Place of supply (state dropdown; default cust.state) │
│  Row 3: Buyer's PO # + PO date (autocomplete of cust's POs)  │
│         DC # + DC date                                       │
│         Reverse charge toggle                                │
│  Row 4 (collapsible "Transport"):                            │
│         E-way bill # | Transporter | Vehicle #               │
├──────────────────────────────────────────────────────────────┤
│ Line items table                                             │
│  S.No │ Item (master picker) │ HSN │ UOM │ Qty │ Rate │     │
│       │ Disc% │ Taxable │ GST% │ CGST │ SGST/IGST │ Total   │
│       │ ⋯ (dup / delete / link job-card)                     │
│  Free-text fallback row for ad-hoc charges                   │
├──────────────────────────────────────────────────────────────┤
│ Notes (left)            │ Totals panel (right, sticky)       │
│  • Customer notes       │  Subtotal (taxable)                │
│  • Terms & conditions   │  Total discount                    │
│    (defaultable)        │  CGST OR IGST                      │
│                         │  SGST (if intra-state)             │
│                         │  Round-off                         │
│                         │  Grand total (bold)                │
│                         │  Amount in words                   │
├──────────────────────────────────────────────────────────────┤
│ Footer actions: Cancel · Save as draft · Save & reconcile   │
└──────────────────────────────────────────────────────────────┘
```

## 6. Component / unit breakdown

Each unit has one purpose, communicates through props, can be edited and tested independently.

### `BillHeaderCard`
Renders the four-row header. Owns customer autocomplete, invoice-number preview, due-date derivation, place-of-supply default. Emits `BillHeaderValues` on every change.

### `BillLineItemsTable`
Owns the array of line items, the master picker, taxable / tax / total per-row math, row actions (dup / delete / link job-card). Emits `LineItem[]` and per-row validation state.

### `BillItemMasterPicker`
Reuses `MasterSearchSelect`. Calls `GET /api/customers/:id/cartons` (already in place, used by PO). On select, returns the full `Carton` row so the table can fill HSN, UOM, rate, GST%. Side-by-side, calls `GET /api/customers/:id/open-po-lines?cartonId=…` (new) to set the "No open PO" badge.

### `BillTotalsPanel`
Pure derivation from `LineItem[] + placeOfSupply + customer.stateCode`. Decides intra-state (CGST+SGST) vs inter-state (IGST). Returns `{subtotal, discountTotal, cgst, sgst, igst, roundOff, grandTotal, amountInWords}`.

### `useBillFormState`
Single state hook coordinating header + lines + totals. Exposes `submit()` that POSTs to `/api/bills` with the v2 payload.

### `amount-in-words.ts` (lib)
₹ → Indian-style words ("One lakh twenty-three thousand four hundred and fifty-six rupees only"). Pure function, easy to test.

### `place-of-supply.ts` (lib)
Maps GSTIN's first 2 digits → state code → state name. Pure, table-driven.

## 7. Data model changes

All additive — no migrations of existing rows other than backfill defaults. Existing bills stay readable.

### `Bill`
```
+ dueDate            DateTime?  @db.Date
+ paymentTerms       String?    @db.VarChar(40)        // "Net 30" | "Advance" | "COD" | custom
+ placeOfSupplyCode  String?    @db.VarChar(2)         // GST state code
+ buyerPoNumber      String?    @db.VarChar(80)
+ buyerPoDate        DateTime?  @db.Date
+ dcNumber           String?    @db.VarChar(80)
+ dcDate             DateTime?  @db.Date
+ reverseCharge      Boolean    @default(false)
+ ewayBillNumber     String?    @db.VarChar(20)
+ transporter        String?    @db.VarChar(120)
+ vehicleNumber      String?    @db.VarChar(40)
+ notes              String?    @db.Text
+ terms              String?    @db.Text
+ cgstAmount         Decimal    @default(0) @db.Decimal(12, 2)
+ sgstAmount         Decimal    @default(0) @db.Decimal(12, 2)
+ igstAmount         Decimal    @default(0) @db.Decimal(12, 2)
+ discountTotal      Decimal    @default(0) @db.Decimal(12, 2)
+ roundOff           Decimal    @default(0) @db.Decimal(8, 2)
```
The existing `gstAmount` becomes a *legacy* aggregate. New writes still fill it = cgst + sgst + igst, so the detail page and totals on the list page keep working. We do not drop it in v1.

### `BillLineItem`
```
+ cartonId        String?    // FK Carton, nullable for ad-hoc
+ hsnCode         String?    @db.VarChar(8)
+ uom             String?    @db.VarChar(20)            // Pcs | Sheets | Kg | Box | Set
+ discountPct     Decimal    @default(0) @db.Decimal(5, 2)
+ taxableAmount   Decimal    @default(0) @db.Decimal(12, 2)
+ cgstAmount      Decimal    @default(0) @db.Decimal(12, 2)
+ sgstAmount      Decimal    @default(0) @db.Decimal(12, 2)
+ igstAmount      Decimal    @default(0) @db.Decimal(12, 2)
```

### `Carton`
```
+ hsnCode  String?  @db.VarChar(8)   // default '48191010' seeded for pharma cartons
+ uom      String?  @db.VarChar(20)  // default 'Pcs'
```

### `Customer`
```
+ stateCode          String?  @db.VarChar(2)   // derived from GSTIN[0..2] on save
+ paymentTermsDays   Int      @default(0)      // 0 = COD / advance
+ defaultPaymentTerms String? @db.VarChar(40)  // "Net 30" / "Advance" / custom
```

A one-shot backfill script derives `stateCode` for existing customers from `gstNumber`. Customers without a GSTIN keep `stateCode = null`; UI falls back to a free state dropdown.

## 8. API changes

### `POST /api/bills` (extend existing route at [src/app/api/bills/route.ts](../../../src/app/api/bills/route.ts))

Schema additions to zod validator. Server still computes amounts (never trust client math) but accepts header fields and `placeOfSupplyCode` to drive the CGST/SGST vs IGST decision.

Server logic per line:
```
taxable = qty * rate * (1 - discountPct/100)
if placeOfSupplyCode === customer.stateCode:
   cgst = taxable * gstPct / 200
   sgst = taxable * gstPct / 200
   igst = 0
else:
   cgst = 0; sgst = 0
   igst = taxable * gstPct / 100
```

Bill totals = sum across lines; `gstAmount = cgst + sgst + igst` (legacy field); `roundOff = round(grand) - grand`; `totalAmount = round(grand)`.

### `GET /api/customers/:id/open-po-lines` *(new)*
Returns open PO line items for this customer, optionally filtered by `cartonId`. Used by `BillItemMasterPicker` for the "No open PO" badge.

### `PUT /api/bills/:id`
Already exists for status changes. Not extended in v1 — line-item editing on saved bills stays out of scope.

## 9. UI behaviours

- **Live totals:** every keystroke recomputes the totals panel via `BillTotalsPanel`. No round-trip.
- **Place-of-supply default:** when customer is selected, fill `placeOfSupplyCode` from `customer.stateCode`. Operator can override (rare — branch transfer).
- **Auto due date:** when invoice date changes or customer changes, set due date = invoiceDate + customer.paymentTermsDays, unless the user has manually edited the due-date field (`dueDateCustom` flag, same pattern PO page uses for `deliveryByCustom`).
- **Auto invoice number:** preview shows `CI-BILL-YYYY-####` (current behavior). Optional override input. Server resolves final number on save.
- **HSN tooltip:** show "Default 4819 — paperboard cartons" when ad-hoc line and HSN is empty, so user knows what to type.
- **"No open PO" badge:** neutral grey badge, not red. Click → opens a tiny popover listing this customer's open PO lines (none for this carton).
- **Job-card link:** moved off the visible row into a row-action popover. Auto-suggested when a buyer PO ref is set and the picked carton matches a PO line.
- **After save:** reconciliation panel (already built) runs. Add `Print preview` button next to `Done` — scaffold only, opens a placeholder route.
- **Print preview route:** `/billing/[id]/print` — scaffolded as a stub page in v1, real template in P4.

## 10. Phasing

| Phase | Deliverable | Schema changes | Risk |
|---|---|---|---|
| **P1 — Visual + live totals** | New page shell, table layout, sticky totals panel with live subtotal/GST/total, amount-in-words. Header card in P1 renders only fields the **existing** schema already persists (Customer, Invoice date). New header fields (due date, place-of-supply, buyer PO ref, DC ref, transport, notes, terms) appear in P2/P3 along with their schema additions. | None | Low — pure UI |
| **P2 — Tax correctness** | Place-of-supply, CGST/SGST/IGST split server-side, HSN/UOM on line items, Carton master HSN seed. | Bill, BillLineItem, Carton, Customer (additive) | Med — touches API and schema; covered by unit tests for the split logic |
| **P3 — Commercial fields** | Due date / payment terms / buyer PO ref / DC ref / notes / terms; auto-due-date logic; reverse-charge toggle. | (already added in P2) | Low |
| **P4 — Print + e-way + email** | PDF template, Print preview route filled in, transport fields wired, email-send action. | None | Med — PDF template work |

Each phase ships independently and leaves the page in a usable state.

## 11. Validation & edge cases

- **Customer with no GSTIN:** `stateCode` is null. Place-of-supply becomes a required manual dropdown. Default GST treatment is intra-state if `placeOfSupplyCode === <seller-state>` (Colour Impressions' own state, from settings).
- **Mixed-rate cart:** different lines can have different GST%. CGST/SGST/IGST sums are computed line by line, not on the subtotal.
- **Discount math:** discountPct applies pre-tax (Indian invoice standard). `taxable = qty*rate*(1-disc/100)`.
- **Round-off:** `Math.round(grand)` — the difference goes into `roundOff`. Capped at ±₹0.99; outside that, treat as a math bug and log.
- **Reverse charge:** if toggled on, tax is shown on the invoice but not added to grand total. P3 detail — flagged in UI as "Tax payable by recipient under RCM" with no addition.
- **Ad-hoc line with no carton:** `cartonId = null`, HSN typed manually, UOM defaults to "Pcs" (override), "No open PO" badge not shown (irrelevant).
- **Carton picked has no matching open PO:** badge shown, save still proceeds. The post-save reconciliation panel simply has no row for that line (same as today).
- **Same carton on two lines:** allowed — common for split lots. Reconciliation matches by jobCardId, not cartonId.

## 12. Testing

- **Pure functions** (`amount-in-words`, `place-of-supply`, line math, totals derivation): unit tests with fixtures including edge cases (zero-GST, mixed-rate, intra vs inter state, reverse charge, round-off boundaries).
- **API:** integration test for `POST /api/bills` v2 payload — verify CGST/SGST split when customer & POS state match, IGST when they don't, legacy `gstAmount` field still populated.
- **UI:** the user is the integration test for visual quality. Smoke test of `Create bill` flow end-to-end after P1 and after P2.

## 13. Files touched

| Path | Action |
|---|---|
| `src/app/(dashboard)/billing/new/page.tsx` | Major rewrite — page shell + state hook |
| `src/components/billing/BillHeaderCard.tsx` | New |
| `src/components/billing/BillLineItemsTable.tsx` | New |
| `src/components/billing/BillItemMasterPicker.tsx` | New |
| `src/components/billing/BillTotalsPanel.tsx` | New |
| `src/lib/amount-in-words.ts` | New |
| `src/lib/place-of-supply.ts` | New |
| `src/lib/bill-math.ts` | New — pure line/total math |
| `src/hooks/useBillFormState.ts` | New |
| `src/app/api/bills/route.ts` | Extend zod schema + server math (P2) |
| `src/app/api/customers/[id]/open-po-lines/route.ts` | New (P2) |
| `prisma/schema.prisma` | Additive fields on Bill, BillLineItem, Carton, Customer (P2) |
| `prisma/migrations/<ts>_bill_invoice_fields/migration.sql` | Auto-generated by Prisma |
| `scripts/backfill-customer-state-codes.ts` | New, one-shot (P2) |
| `src/app/(dashboard)/billing/[id]/print/page.tsx` | Stub (P1), filled (P4) |

## 14. Open questions (for future phases, not blocking v1)

- Should reverse-charge bills auto-create a corresponding RCM journal entry? (Out of scope for v1.)
- E-invoice (IRN) generation — which provider? Defer to compliance project.
- Multi-currency / export invoicing (LUT vs Bond) — defer.
- Customer-specific T&C templates vs single global default — start with global, allow customer-level override in P3+.
