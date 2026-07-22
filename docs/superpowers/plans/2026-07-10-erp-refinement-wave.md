# CI ERP Refinement Wave — Implementation Plan (2026-07-10)

> **For agentic workers:** Executed inline in this session. No git commits (project rule).

**Goal:** Six workstreams — pendency/fulfillment views, procurement form enrichment, planning UI controls, UI standardization, shade-card expiry engine, artwork/output-number mapping.

**Architecture:** Additive `ALTER TABLE IF NOT EXISTS` migrations in `server/src/db.js`; endpoint extensions in existing route files; shared UI primitives (`SubTabs`, `FulfillmentBar`) in `client/src/components/ui.jsx`; page-level changes reuse the app's master-update-philosophy prompt pattern.

**Tech stack:** Express + pg (embedded Postgres :5439), React + react-router + Tailwind, lucide icons.

---

## Task 0: DB migrations (`server/src/db.js`, append new pool.query block)

- requisitions: `requested_by, department, priority (default 'normal'), remarks, reraise_of INT REFERENCES requisitions(id), reraise_reason`
- purchase_orders: `vendor_notes, payment_terms, delivery_terms, reference, created_by`
- grns: `vehicle_no, supplier_invoice_no, supplier_invoice_date, received_by, remarks`
- products: `output_number TEXT`
- tools: `creation_date TEXT, approval_date TEXT` (shade-card lifecycle)

## Task 1: S1 — Pendency tabs + fulfillment bars

Files: `server/src/routes/orders.js`, `client/src/components/ui.jsx`, `client/src/pages/Orders.jsx`, `client/src/pages/Procurement.jsx`

- **Bug fix:** `/sales/pendency` `WHERE o.status='open'` → `IN ('pending','hold')`.
- `/orders` list: add `ordered_qty`, `dispatched_qty` sums → client computes fulfillment %.
- `ui.jsx`: add `FulfillmentBar({ pct, label })` (PureFlix port: h-1.5 rounded bar, emerald ≥100 / blue >0 / slate-300) and `SubTabs({ views, active, onChange })` pill switcher.
- Orders.jsx Pendency: replace roll-up toggle with SubTabs **Customer-wise / Item-wise / Line Detail**; add fulfillment bar column to orders table + pendency line table (`dispatched/ordered`).
- Procurement.jsx: pendency views via SubTabs, label `parties` → **Vendor-wise Pendency**; PO cards get header + per-line fulfillment bars (received/ordered).

## Task 2: S2 — PR/PO/GRN form enrichment + cascade

Files: `server/src/routes/procurement.js`, `client/src/pages/Procurement.jsx`

- POST/PUT `/requisitions`: accept + store new metadata; `GET /requisitions/:id` added for inline tracking.
- PO create endpoints (convert / from-requisitions / direct / edit): accept `vendor_notes, payment_terms, delivery_terms, reference`; stamp `created_by = req.user.name`.
- GRN create (single + bulk) and edit: accept `vehicle_no, supplier_invoice_no, supplier_invoice_date, received_by (default user), remarks`.
- Forms: PR modal gains Requested By (prefilled), Department, Priority, Remarks; PO modals gain terms/notes; GRN modals gain transport/invoice fields. All auto-populated downstream (PR→PO lines & date already cascade; GRN pre-fills receiver) and stay editable.

## Task 3: S3 — Planning module controls

Files: `client/src/pages/Planning.jsx`, `client/src/components/WarehousePicker.jsx`, `server/src/routes/inventory.js`, `server/src/routes/procurement.js`

- Tabs: `To Plan / Planned / All` (All = pending+planned+ready concurrently); ready rows keep Job Card action.
- PR wire-up: PR chips in Board Position become buttons → PR tracker modal (status, qty, needed-by, PO link, "Open Procurement" in new tab so engine state survives).
- Duplicate-PR alert: `raisePrInline` intercepted when `ctx.incoming.prs` has an active PR for the board → warning modal requiring **Additional Quantity Required** + **Reason for Re-raising**; POST carries `reraise_of`/`reraise_reason`.
- WarehousePicker: three checkboxes (Fits Child / In Stock / In Leftover) all default **checked**; "In Leftover" = include-toggle → unchecked sends `exclude_leftover=1` (new server param `m.leftover=0`); `leftover_only` param kept for compat.

## Task 4: S4 — UI standardization

Files: `client/src/components/ui.jsx`, pages above + `client/src/pages/Tooling.jsx`

- One `SubTabs` primitive replaces the three ad-hoc pill switchers (Procurement pendency, Orders pendency, Tooling board/ledger) → same dimensions, padding, radii, tokens everywhere.
- Status colours stay on the single `STATUS_COLOURS` map; new UI uses existing `ci-*` panel classes only.

## Task 5: S5 — Tooling Hub + shade-card expiry engine

Files: `client/src/pages/Tooling.jsx`, `server/src/routes/tooling.js`, `server/src/routes/orders.js` (planning ctx), `server/src/routes/billing.js`, `client/src/pages/Planning.jsx`, `client/src/pages/Invoices.jsx`

- Remove `All` tab; family tabs in order **Plates → Dies → Blocks → Shade Cards**; default `plate`.
- Shade-card form: `Creation Date` + `Approval Date` date inputs (tools.creation_date/approval_date via EDIT_COLS + POST insert); age (months/days) chip on card + spotlight, red at ≥365d.
- Expiry engine: helper `shadeCardFor(product_ids)` → planning context returns `shade_card {code, age_days, expired}`; Planning Engine shows Critical Alert banner. `/billing/uninvoiced` rows carry `shade_expired, shade_age_days` → New Invoice modal shows Critical Alert for selected expired lines.

## Task 6: S6 — Artwork form + Output Number mapping + master sync

Files: `server/src/routes/orders.js`, `server/src/routes/masters.js`, `client/src/pages/Artwork.jsx`, `client/src/pages/Planning.jsx`, `client/src/pages/Masters.jsx` (product form)

- masters products cols += `output_number`.
- LINE_VIEW: expose effective `party_artwork_code` + `output_number` (spec_override-aware COALESCE).
- Plan endpoint SPEC_FIELDS/TEXT_SPEC += `party_artwork_code`, `output_number` → existing master-update prompt = the "Sync Master?" interceptor.
- Planning Engine (single sets only, `gang_run_id == null`): Artwork Code + Output Number fields auto-populated from master, editable, wired into `changedSpec`; gang lines bypass.
- Artwork form: new "Codes & technical spec" section (Party Artwork Code, Output Number editable; internal carton code, board, GSM, size, colours, die read-only). Save intercepts changes → **Sync Master?** modal (Update Carton Product Master vs This job only → spec_override). PUT `/order-lines/:id/artwork` extended with `spec` + `update_master`.
- Verify/fix artwork form open bug in live app.

## Task 7: Verification (live app)

- Start server per `Start CI ERP.command` / launch.json (embedded PG :5439; do NOT set DATABASE_URL); login admin@ci.local/admin123, desktop viewport.
- Walk: Orders pendency tabs + bars → Procurement forms + pendency → Planning All tab, duplicate PR, warehouse defaults, artwork/output fields → Tooling tabs + shade card ages → expired-shade warnings in Planning + Invoicing.
- Screenshot proof per section. Node syntax check (`node --check`) + Vite build for lint safety.
