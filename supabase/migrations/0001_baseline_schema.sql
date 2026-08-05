-- ============================================================================
-- ci-erp baseline schema — GENERATED FILE, DO NOT EDIT BY HAND
-- ============================================================================
-- Source of truth: server/src/db.js  ->  init()
-- Regenerate with: npm run db:baseline
--
-- This is the complete schema plus the idempotent data backfills that init()
-- applies. Every statement is IF NOT EXISTS / idempotent, so replaying this
-- file against an existing database is a no-op, and replaying it against an
-- empty database reproduces the full ci-erp schema.
--
-- Blocks below appear in the exact order init() executes them.
-- ============================================================================

-- ─── block 01 ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','planner','production','qc','dispatch','viewer')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT, state TEXT, gstin TEXT, contact TEXT, phone TEXT,
  segment TEXT NOT NULL DEFAULT 'pharma' CHECK (segment IN ('pharma','fmcg')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT, contact TEXT, phone TEXT, categories TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('board','ink','foil','adhesive','laminate','other')),
  spec TEXT, unit TEXT NOT NULL DEFAULT 'sheets',
  sheet_l DOUBLE PRECISION, sheet_w DOUBLE PRECISION, -- parent sheet size (inches), boards
  reorder_level DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS machines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cutting','ctp','printing','coating','lamination','foiling','embossing','die_cutting','sorting','pasting')),
  capacity_per_hour DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','idle','maintenance'))
);

-- Dies (cutting tools) — simplified from CI-Production's Die Hub.
-- A die belongs in the rack; products reference the die that blanks them.
CREATE TABLE IF NOT EXISTS dies (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  die_number TEXT NOT NULL UNIQUE,
  die_type TEXT,
  ups INTEGER,
  sheet_size TEXT,
  carton_size TEXT,
  location TEXT,
  condition TEXT NOT NULL DEFAULT 'Good' CHECK (condition IN ('Good','Fair','Poor','Scrapped')),
  impression_count INTEGER NOT NULL DEFAULT 0,
  max_impressions INTEGER NOT NULL DEFAULT 500000,
  last_used_date TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  board_material_id INTEGER NOT NULL REFERENCES materials(id),
  board_name TEXT, -- explicit board name from the plant master (grade + gsm + parent), e.g. "Saffire 330 GSM 26 × 30"; NULL = blank
  gsm INTEGER, size TEXT,
  child_l DOUBLE PRECISION, child_w DOUBLE PRECISION, -- print (child) sheet size in inches
  ups INTEGER NOT NULL DEFAULT 1,
  wastage_pct DOUBLE PRECISION NOT NULL DEFAULT 5,
  colors INTEGER NOT NULL DEFAULT 4,
  coating TEXT, -- real finish label from the plant master (e.g. "Aqueous Varnish (Gloss)"); NULL/blank = none
  parent_l DOUBLE PRECISION, parent_w DOUBLE PRECISION, -- parent (mill) sheet size (inches), explicit per product
  special TEXT NOT NULL DEFAULT 'none' CHECK (special IN ('none','foil','emboss','foil_emboss','window')),
  rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_number TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  po_date TEXT NOT NULL,
  delivery_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  rate DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','planned','ready','in_production','produced','dispatched','cancelled')),
  machine_id INTEGER REFERENCES machines(id),
  planned_date TEXT,
  sheets_required INTEGER,
  parent_sheets_required INTEGER,
  artwork_customer_ok INTEGER NOT NULL DEFAULT 0,
  artwork_qa_ok INTEGER NOT NULL DEFAULT 0,
  artwork_locked INTEGER NOT NULL DEFAULT 0,
  tooling_ok INTEGER NOT NULL DEFAULT 0,
  dispatched_qty INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS job_cards (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jc_number TEXT NOT NULL UNIQUE,
  order_line_id INTEGER NOT NULL UNIQUE REFERENCES order_lines(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  machine_id INTEGER REFERENCES machines(id),
  qty_planned INTEGER NOT NULL,
  sheets_issued INTEGER NOT NULL,
  qty_produced INTEGER NOT NULL DEFAULT 0,
  qty_scrap INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','closed')),
  children_per_parent INTEGER,
  queue_pos INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS job_stages (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  seq INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('cutting','printing','coating','lamination','foiling','embossing','die_cutting','sorting','pasting','qc')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','hold','completed')),
  unit TEXT NOT NULL DEFAULT 'sheets' CHECK (unit IN ('sheets','cartons')),
  qty_in INTEGER, qty_out INTEGER, qty_scrap INTEGER NOT NULL DEFAULT 0,
  scrap_reason TEXT, hold_reason TEXT,
  machine_id INTEGER REFERENCES machines(id),
  pack_boxes INTEGER, pack_qty_per_box INTEGER,
  operator TEXT,
  started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stock_batches (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  batch_no TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL,
  initial_qty DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'quarantine' CHECK (status IN ('quarantine','available','rejected','exhausted')),
  grn_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  material_id INTEGER REFERENCES materials(id),
  batch_id INTEGER REFERENCES stock_batches(id),
  product_id INTEGER REFERENCES products(id),
  type TEXT NOT NULL CHECK (type IN ('grn','qc_release','qc_reject','consumption','adjustment','fg_receipt','dispatch','wastage')),
  qty DOUBLE PRECISION NOT NULL,
  ref_type TEXT, ref_id INTEGER, note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fg_stock (
  product_id INTEGER PRIMARY KEY REFERENCES products(id),
  qty INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cutting_discrepancies (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  job_stage_id INTEGER NOT NULL REFERENCES job_stages(id),
  cpp INTEGER NOT NULL,
  planned_parents INTEGER NOT NULL,
  actual_parents INTEGER NOT NULL,
  parent_delta INTEGER NOT NULL,
  planned_children INTEGER NOT NULL,
  actual_children INTEGER NOT NULL,
  board_material_id INTEGER REFERENCES materials(id),
  board_available_before DOUBLE PRECISION,
  reason_code TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A write-on is the system admitting its own book was wrong: more board left
-- the warehouse than the book said existed. We record it rather than let the
-- balance go negative, because no shelf holds minus one hundred and fifty
-- sheets and every number derived from SUM(qty) inherits the lie.
CREATE TABLE IF NOT EXISTS stock_writeons (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  qty DOUBLE PRECISION NOT NULL CHECK (qty > 0),
  book_before DOUBLE PRECISION NOT NULL,
  issued_qty DOUBLE PRECISION NOT NULL,
  batch_id INTEGER REFERENCES stock_batches(id),
  ref_type TEXT NOT NULL,
  ref_id INTEGER,
  reason TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_at TIMESTAMPTZ,
  reconciled_by TEXT,
  counted_qty DOUBLE PRECISION,
  reconcile_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_writeons_open ON stock_writeons (material_id) WHERE reconciled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_writeons_ref ON stock_writeons (ref_type, ref_id);

CREATE TABLE IF NOT EXISTS requisitions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pr_number TEXT NOT NULL UNIQUE,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  qty DOUBLE PRECISION NOT NULL,
  needed_by TEXT, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','converted','closed','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_number TEXT NOT NULL UNIQUE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  requisition_id INTEGER REFERENCES requisitions(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_received','received','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  material_id INTEGER NOT NULL REFERENCES materials(id),
  qty DOUBLE PRECISION NOT NULL, rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  received_qty DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS grns (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grn_number TEXT NOT NULL UNIQUE,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  po_line_id INTEGER NOT NULL REFERENCES po_lines(id),
  material_id INTEGER NOT NULL REFERENCES materials(id),
  qty DOUBLE PRECISION NOT NULL, batch_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'quarantine' CHECK (status IN ('quarantine','accepted','rejected')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  qc_at TIMESTAMPTZ, qc_note TEXT
);

CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  challan_number TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  vehicle TEXT, driver TEXT, notes TEXT,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dispatch_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('operator','supervisor','qc_inspector','helper')),
  section TEXT CHECK (section IN ('cutting','printing','coating','lamination','foiling','embossing','die_cutting','sorting','pasting','qc')),
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  invoice_date TEXT NOT NULL,
  subtotal DOUBLE PRECISION NOT NULL,
  cgst DOUBLE PRECISION NOT NULL DEFAULT 0,
  sgst DOUBLE PRECISION NOT NULL DEFAULT 0,
  igst DOUBLE PRECISION NOT NULL DEFAULT 0,
  round_off DOUBLE PRECISION NOT NULL DEFAULT 0,
  total DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','cancelled')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  dispatch_line_id INTEGER NOT NULL UNIQUE REFERENCES dispatch_lines(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  rate DOUBLE PRECISION NOT NULL,
  amount DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  invoice_id INTEGER REFERENCES invoices(id),
  amount DOUBLE PRECISION NOT NULL,
  mode TEXT NOT NULL DEFAULT 'neft' CHECK (mode IN ('neft','rtgs','upi','cheque','cash')),
  reference TEXT, notes TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GST rate master — default tax % per product type, editable from Masters.
CREATE TABLE IF NOT EXISTS gst_rates (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_type TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  rate INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- Operators assigned to a machine — production entry shows only these.
CREATE TABLE IF NOT EXISTS machine_operators (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  UNIQUE (machine_id, employee_id)
);

-- Packing manifest lines — real factory packing: N full boxes of X, plus a
-- loose box / loose pieces. Captured on pasting completion, totals drive dispatch.
CREATE TABLE IF NOT EXISTS packing_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_stage_id INTEGER NOT NULL REFERENCES job_stages(id) ON DELETE CASCADE,
  boxes INTEGER NOT NULL DEFAULT 0,
  qty_per_box INTEGER NOT NULL DEFAULT 0,
  loose_qty INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FG lots — labelled excess stock in the Finished Goods warehouse.
-- A lot is carved out of a closed job card's excess, must pass physical
-- verification, and can then be consumed against a future sales order line.
CREATE TABLE IF NOT EXISTS fg_lots (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_number TEXT NOT NULL UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  job_card_id INTEGER REFERENCES job_cards(id),
  order_line_id INTEGER REFERENCES order_lines(id),
  qty INTEGER NOT NULL,
  box_count INTEGER,
  qty_per_box INTEGER,
  loose_qty INTEGER,
  source TEXT NOT NULL DEFAULT 'dispatch_excess'
    CHECK (source IN ('dispatch_excess','packing_excess','manual')),
  status TEXT NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification','verified','rejected','consumed')),
  consumed_qty INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  note TEXT,
  verified_by TEXT, verified_at TIMESTAMPTZ, verification_note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FG consumption against an order line (the planning engine's reservation).
CREATE TABLE IF NOT EXISTS fg_consumptions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fg_lot_id INTEGER NOT NULL REFERENCES fg_lots(id),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  qty INTEGER NOT NULL,
  user_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Gang runs — several order lines printed together on one press run.
-- Deliberately tiny: a gang is just a numbered group. It has no status of its
-- own — each member line keeps moving through the normal workflow, and the
-- gang simply keeps them together on the press and in procurement.
CREATE TABLE IF NOT EXISTS gang_runs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gang_number TEXT NOT NULL UNIQUE,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Planner's manual override of the parent sheets to ISSUE for the whole gang.
-- NULL = follow the calculated total; a number = the planner decided the issue
-- (distributed across members on Lock so downstream board math still sums right).
ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS issue_parent_sheets INT;
-- A run is a numbered group of order lines that go to press together. Two
-- kinds, and the difference is the whole point:
--   'gang'  — DIFFERENT products on one shared sheet. Splits into one child
--             job card per product after die cutting (splitGangParentJob).
--   'merge' — a COMBINED RUN: the SAME product on several sales orders. It
--             NEVER splits — one pile of identical cartons runs the entire
--             route as one CI-JC- card, and the output is allocated back to
--             each sales order at dispatch (POST /fg/move already cascades by
--             delivery date within each order's tolerance).
-- Existing rows are gangs — that is what every row was before this column.
ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'gang';
ALTER TABLE gang_runs DROP CONSTRAINT IF EXISTS gang_runs_kind_check;
ALTER TABLE gang_runs ADD CONSTRAINT gang_runs_kind_check CHECK (kind IN ('gang','merge'));
-- The product a COMBINED RUN is a run of. NULL for a gang (a gang is many
-- products by definition). Stored rather than derived so eligibility ("can
-- this line join?") is one indexed lookup instead of an aggregate.
ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id);
CREATE INDEX IF NOT EXISTS idx_fk_gang_runs_product_id ON gang_runs (product_id);
-- HOW a gang's members occupy the sheet:
--   'separate' — today's model and the default: each member has its OWN child
--                sheets; the gang shares the board and the press run, and the
--                run's total is the SUM of member sheets.
--   'shared'   — a CO-PRINTED layout: every member nests on ONE child sheet
--                (Job A 2-up beside Job B 1-up beside Job C 3-up), so the
--                run's sheets are the MAX any member needs, and each member's
--                stored figures are its PROPORTIONAL SHARE of that one count
--                (largest-remainder, summing exactly) — every downstream
--                reader (demand, PR, consumption, variance) keeps reading the
--                same per-line columns without knowing co-printing exists.
-- Until a shared-layout gang's final child size is entered it is LAYOUT
-- PENDING — derived, never stored: planning, Smart Match and the job card
-- wait for the size the designer settles.
ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS layout_mode TEXT NOT NULL DEFAULT 'separate';
ALTER TABLE gang_runs DROP CONSTRAINT IF EXISTS gang_runs_layout_mode_check;
ALTER TABLE gang_runs ADD CONSTRAINT gang_runs_layout_mode_check CHECK (layout_mode IN ('separate','shared'));

-- THE RUN'S OWN output and die number. A gang of mixed products is a NEW
-- layout every time: its plate set and its die exist for this run and no
-- other, so neither can be fetched from any product master — the planner
-- types them, and they then travel with the gang number and the product
-- names to every station the run passes. Free text, like the master fields
-- they override; blank means "not given yet".
--
-- Gangs only. A COMBINED RUN (kind='merge') is ONE product printed from its
-- own master plate and die, so it keeps reading the master and these stay
-- NULL — enforced in the route rather than by a constraint, so a gang that
-- is later converted to a merge keeps its history instead of failing.
ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS output_number TEXT;
ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS die_number TEXT;

-- A run draws from ONE pile, so book-the-shelf vs buy-fresh is decided once
-- for the whole run and stamped onto every member line (the demand engine
-- only ever reads order_lines.stock_booking).
ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS stock_booking TEXT NOT NULL DEFAULT 'book';
ALTER TABLE gang_runs DROP CONSTRAINT IF EXISTS gang_runs_stock_booking_check;
ALTER TABLE gang_runs ADD CONSTRAINT gang_runs_stock_booking_check CHECK (stock_booking IN ('book','fresh_pr'));

-- Fixed gang templates — the plant's PERMANENT co-printed layouts ("Niko
-- Standard": one 19x20 sheet, 12 ups, Niko 1 taking 8 and Niko 2 taking 4;
-- the die never changes, only order quantities do). A template is its OWN
-- master: its ups and sheet size live HERE and are stamped onto a new run's
-- spec_override at creation. It NEVER writes the Product Master, and editing
-- it never reaches back into runs already created from it.
CREATE TABLE IF NOT EXISTS gang_templates (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  child_l DOUBLE PRECISION NOT NULL,
  child_w DOUBLE PRECISION NOT NULL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gang_template_slots (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES gang_templates(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  ups INTEGER NOT NULL CHECK (ups > 0)
);
CREATE INDEX IF NOT EXISTS idx_gang_template_slots_template ON gang_template_slots(template_id);
CREATE INDEX IF NOT EXISTS idx_fk_gang_template_slots_product ON gang_template_slots(product_id);
-- The RECOGNITION key: the gang's product set, sorted and joined ("15-17").
-- When a planner gangs a combination whose fingerprint is on file, the die is
-- applied automatically; when a new combination's layout is locked at plan,
-- it is remembered here — the system learns the plant's dies case by case.
ALTER TABLE gang_templates ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE gang_templates ADD COLUMN IF NOT EXISTS last_gang_number TEXT;
ALTER TABLE gang_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gang_templates_fingerprint ON gang_templates(fingerprint) WHERE fingerprint IS NOT NULL AND active = 1;

-- Extra sheet requests — controlled re-issue of board when a stage runs short
-- (printing wastage beyond plan, sheet damage…). The operator raises it from
-- the running stage; the job card issuer approves; the warehouse issues.
-- Nobody walks to cutting and takes sheets off the pile any more.
CREATE TABLE IF NOT EXISTS extra_sheet_requests (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  xs_number TEXT NOT NULL UNIQUE,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  job_stage_id INTEGER NOT NULL REFERENCES job_stages(id),
  stage TEXT NOT NULL,
  qty INTEGER NOT NULL,               -- parent sheets from the warehouse
  reason TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','issued','rejected','cancelled')),
  requested_by TEXT, requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by TEXT, approved_at TIMESTAMPTZ, approval_note TEXT,
  issued_by TEXT, issued_at TIMESTAMPTZ,
  rejected_by TEXT, rejected_at TIMESTAMPTZ, reject_reason TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity TEXT NOT NULL, entity_id INTEGER,
  action TEXT NOT NULL, detail TEXT, user_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lines_status ON order_lines(status);
CREATE INDEX IF NOT EXISTS idx_stages_jc ON job_stages(job_card_id);
CREATE INDEX IF NOT EXISTS idx_moves_material ON stock_movements(material_id);
CREATE INDEX IF NOT EXISTS idx_batches_material ON stock_batches(material_id, status);
-- Universal timeline reads the audit ledger by date and by entity.
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

-- ─── block 02 ──────────────────────────────────────────────────

ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS queue_pos INTEGER;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS children_per_parent INTEGER;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS sheet_l DOUBLE PRECISION;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS sheet_w DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS child_l DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS child_w DOUBLE PRECISION;
-- Parent (mill) sheet size derived from the child size — see parentSheetFor().
-- Stored so the whole planning/cutting/procurement chain reads one authoritative
-- parent regardless of which board grade happens to be linked.
ALTER TABLE products ADD COLUMN IF NOT EXISTS parent_l DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS parent_w DOUBLE PRECISION;
-- Explicit board name from the plant master (grade + gsm + parent size).
ALTER TABLE products ADD COLUMN IF NOT EXISTS board_name TEXT;
-- Board grade / brand only (e.g. "Saffire", "FBB"), separate from the full
-- board material which carries GSM + parent size. Planning fetches & shows both.
ALTER TABLE products ADD COLUMN IF NOT EXISTS board_grade TEXT;
-- Coating now holds the plant's real finish label (free text), not a fixed enum.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_coating_check;
ALTER TABLE products ALTER COLUMN coating DROP NOT NULL;
ALTER TABLE products ALTER COLUMN coating DROP DEFAULT;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS parent_sheets_required INTEGER;
-- Per-job spec overrides (master-update philosophy: "save for this job only")
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS spec_override JSONB;
-- Rich QC capture + finished-goods location
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS qty_accepted INTEGER;
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS qty_rejected INTEGER;
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS qty_rework INTEGER;
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS inspector TEXT;
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS remarks TEXT;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS fg_location TEXT;
-- Dies + real per-product GST (cartons carry 5% or 12%, not a flat rate)
ALTER TABLE products ADD COLUMN IF NOT EXISTS die_id INTEGER REFERENCES dies(id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_pct INTEGER;
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS gst_pct INTEGER;
-- Type-driven GST defaults: products carry a type, order lines capture the rate
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS gst_pct INTEGER;
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS scrap_reason TEXT;
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS hold_reason TEXT;
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS machine_id INTEGER REFERENCES machines(id);
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS pack_boxes INTEGER;
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS pack_qty_per_box INTEGER;
-- The Live Floor's own queue order, set by the up/down arrows on the board.
-- Separate from job_cards.queue_pos, which belongs to Print Planning: one
-- number per job shared by every section. NULL means "never reordered here".
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS floor_pos INTEGER;
-- Status Sheet: coordination fields on the pending-orders list.
-- is_p1 = manual priority; wip = the CUSTOMER's WIP flag (not our
-- floor); printed_override lets sales force Printed Y/N over the derived signal.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_p1 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS wip BOOLEAN;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS printed_override BOOLEAN;
-- When the customer's list said so: the date a line was marked Customer-WIP,
-- taken from the uploaded WIP sheet when it carries one (today otherwise).
-- Cleared when the flag is taken off — a date with no flag is a stale claim.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS wip_date TEXT;
-- P1 moved from the order to the product LINE (2026-07-27): the star marks one
-- product, not the whole PO. The DO block backfills the old order-level flag
-- onto its lines exactly once (only when the column is first created), so a
-- later per-line clear is never re-overwritten by a replayed init().
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='order_lines' AND column_name='is_p1') THEN
    ALTER TABLE order_lines ADD COLUMN is_p1 INTEGER NOT NULL DEFAULT 0;
    UPDATE order_lines ol SET is_p1=1 FROM orders o WHERE o.id=ol.order_id AND o.is_p1=1;
  END IF;
END $$;
ALTER TABLE job_stages DROP CONSTRAINT IF EXISTS job_stages_stage_check;
ALTER TABLE job_stages ADD CONSTRAINT job_stages_stage_check
  CHECK (stage IN ('cutting','printing','coating','lamination','foiling','embossing','die_cutting','sorting','pasting','qc'));
ALTER TABLE job_stages DROP CONSTRAINT IF EXISTS job_stages_status_check;
-- Must match the final definition below (which re-adds it with
-- 'partially_completed'): init() replays on every boot, and an intermediate
-- ADD that excludes a status a live row already holds crashes the start.
ALTER TABLE job_stages ADD CONSTRAINT job_stages_status_check
  CHECK (status IN ('pending','in_progress','partially_completed','hold','completed'));
ALTER TABLE machines DROP CONSTRAINT IF EXISTS machines_type_check;
ALTER TABLE machines ADD CONSTRAINT machines_type_check
  CHECK (type IN ('cutting','ctp','printing','coating','lamination','foiling','embossing','die_cutting','sorting','pasting'));
-- Employee section is now governed by the Sections master (Masters → Sections),
-- so the fixed enum CHECK is dropped — any section added there is usable at once.
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_section_check;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_type_check
  CHECK (type IN ('grn','qc_release','qc_reject','consumption','adjustment','fg_receipt','dispatch','wastage','wastage_reversal','leftover_in'));
-- Customer-wise dispatch tolerance: master % + per-line snapshot taken at SO
-- creation so later master edits never silently change old orders.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tolerance_pct DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS tolerance_pct DOUBLE PRECISION;
-- Verified FG consumed against the line — production plans the balance.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS fg_consumed_qty INTEGER NOT NULL DEFAULT 0;
-- Planning wastage captured in absolute child sheets (plant default 200);
-- the product-master percentage stays only as the pre-plan fallback.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS wastage_sheets INTEGER;
-- Whose stock this plan runs on, chosen in the Planning Engine:
--   'book'     — free shelf stock counts toward the plan; PR only the balance.
--   'fresh_pr' — buy the FULL requirement; the claim on the shelf is fenced
--                to the plan's own incoming PR so the shelf stays free for
--                other jobs (claim = need − own undelivered PR qty, returning
--                as the PR lands). A run's choice is stamped on every member.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS stock_booking TEXT NOT NULL DEFAULT 'book';
ALTER TABLE order_lines DROP CONSTRAINT IF EXISTS order_lines_stock_booking_check;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_stock_booking_check CHECK (stock_booking IN ('book','fresh_pr'));
-- Machines can be retired without breaking history.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1;
-- Vendor promise date on the PO — drives pendency ageing.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_date TEXT;
-- Reason recorded when a requisition is closed/cancelled.
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS status_reason TEXT;
-- Deliberate "item fulfilled → marked complete" flag, set at invoicing time.
-- An order rolls up to 'completed' once all its non-cancelled lines carry this.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
-- Which PO a requisition was converted into (several PRs can share one PO).
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS purchase_order_id INTEGER REFERENCES purchase_orders(id);
-- Gang printing: the gang run this line belongs to (NULL = prints alone).
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS gang_run_id INTEGER REFERENCES gang_runs(id);
-- Unified gang job card. A gang now runs as ONE physical job card through the
-- shared sheet stages (cutting → printing → coating → foiling/embossing →
-- die cutting), then SPLITS into one child job card per product for sorting →
-- pasting → QC. So a job card can now be:
--   • a normal single-line card  (order_line_id set, gang_run_id NULL)
--   • a gang PARENT card          (order_line_id NULL, gang_run_id set, parent NULL)
--   • a gang CHILD card           (order_line_id set, gang_run_id set, parent set)
ALTER TABLE job_cards ALTER COLUMN order_line_id DROP NOT NULL;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS gang_run_id INTEGER REFERENCES gang_runs(id);
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS parent_job_card_id INTEGER REFERENCES job_cards(id);
-- Total child print sheets planned across the whole gang (the parent card's
-- cutting output cap; each member's share is carved from this at the split).
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS child_sheets_planned INTEGER;
-- Manual "Ready to Run". A supervisor can declare a job runnable when the
-- computed readiness light is still amber — the plant knows things the ERP
-- does not. It is a SIGNAL, never a gate: no readiness fact is rewritten, the
-- checklist keeps showing the truth underneath, and every flip is audited with
-- its reason. It lives on the job card because a card is what an operator
-- runs — for a gang that is the parent, and overriding the parent is exactly
-- the statement "this press run may start".
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS ready_override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS ready_override_by TEXT;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS ready_override_at TIMESTAMPTZ;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS ready_override_reason TEXT;
-- 'split' = a gang parent that has finished die cutting and handed its blanks
-- to the per-product child cards; it is done but not a finished-goods batch.
ALTER TABLE job_cards DROP CONSTRAINT IF EXISTS job_cards_status_check;
ALTER TABLE job_cards ADD CONSTRAINT job_cards_status_check
  CHECK (status IN ('open','in_progress','split','closed'));
-- Press designation shown on the Print Planning board (e.g. Komori Lithrone 5-Colour).
ALTER TABLE machines ADD COLUMN IF NOT EXISTS model TEXT;
-- Per-user module access: JSON array of module keys, NULL = all modules the
-- user's role allows (the pre-existing behaviour). Admins always see everything.
ALTER TABLE users ADD COLUMN IF NOT EXISTS modules JSONB;
-- Floor-station & machine scoping for dedicated station logins. NULL = all.
--   sections    : JSON array of Live Floor section keys the user may see
--                 (cutting … qc). Filters /floor, the machine board and
--                 /floor/:section server-side (view filter, not a write gate).
--   machine_ids : JSON array of machine ids the printing queue is limited to
--                 (one press per operator, e.g. Shiv → press 13).
--   landing_path: where the user lands after login (NULL = first allowed page).
ALTER TABLE users ADD COLUMN IF NOT EXISTS sections JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS machine_ids JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS landing_path TEXT;
-- Leftover offcut stock: a leftover is a board material carved from a parent
-- board. One master per (source board, strip size); code LO-<srcId>-<L>X<W>.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS code TEXT;
-- Active flag so materials that can't be deleted (in use elsewhere) can be
-- retired by deactivating instead — mirrors machines/employees.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS leftover INTEGER NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS source_material_id INTEGER REFERENCES materials(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_materials_code ON materials(code) WHERE code IS NOT NULL;
-- Planner's push-to-warehouse decision, taken once in the Planning Engine.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS leftover_plan JSONB;
-- The cutting-stage booking guard looks batches up by number (LO-<jc>).
CREATE INDEX IF NOT EXISTS idx_batches_batch_no ON stock_batches(batch_no);
-- Line clearance record captured when a stage starts (cutting → pasting):
-- the checklist confirmed, by whom and when.
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS line_clearance JSONB;
-- PO import: quick-created masters carry placeholder board/spec until completed.
ALTER TABLE products ADD COLUMN IF NOT EXISTS spec_incomplete INTEGER NOT NULL DEFAULT 0;
-- PO import: learned per-customer mappings from PDF item text to a product.
-- Every manual confirmation in the import wizard lands here, so matching
-- converges to exact for repeat items.
CREATE TABLE IF NOT EXISTS product_aliases (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  alias_norm TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, alias_norm)
);

-- ── Tooling Hub ──────────────────────────────────────────────────────────────
-- ONE lifecycle for dies, plate sets, foil/emboss blocks and shade cards:
-- incoming → making → in_rack → on_floor. A healthy tool in rack / on floor
-- satisfies the readiness gate (see tooling-gate.js). The legacy dies table
-- stays dormant one release; everything reads products.tool_id + tools now.
CREATE TABLE IF NOT EXISTS tools (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('die','plate','block','shade_card')),
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  zone TEXT NOT NULL DEFAULT 'incoming' CHECK (zone IN ('incoming','making','in_rack','on_floor')),
  zone_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  maker TEXT,
  condition TEXT NOT NULL DEFAULT 'Good' CHECK (condition IN ('Good','Fair','Poor','Scrapped')),
  location TEXT,
  notes TEXT,
  ups INTEGER,
  sheet_size TEXT,
  carton_size TEXT,
  colors INTEGER,
  emboss_type TEXT,
  shade_ref TEXT,
  impression_count INTEGER NOT NULL DEFAULT 0,
  max_impressions INTEGER NOT NULL DEFAULT 500000,
  last_used_date TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tool_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool_id INTEGER NOT NULL REFERENCES tools(id),
  action TEXT NOT NULL,
  from_zone TEXT,
  to_zone TEXT,
  note TEXT,
  user_name TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS tool_id INTEGER REFERENCES tools(id);
ALTER TABLE tools ADD COLUMN IF NOT EXISTS output_no TEXT;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS cylinder_no TEXT;
-- Tooling Hub: issue tracking (machine/operator/job card) + verification flag.
-- These must stay below CREATE TABLE tools — they used to sit ~100 lines above
-- it, which worked on databases that already had the table but crashed any
-- database built from empty.
ALTER TABLE tools ADD COLUMN IF NOT EXISTS issued_machine_id  INTEGER REFERENCES machines(id);
ALTER TABLE tools ADD COLUMN IF NOT EXISTS issued_operator    TEXT;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS issued_job_card_id INTEGER REFERENCES job_cards(id);
ALTER TABLE tools ADD COLUMN IF NOT EXISTS issued_at          TIMESTAMPTZ;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS verified           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS verified_at        TIMESTAMPTZ;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS finalised_at TIMESTAMPTZ;
-- Machine code (CI-01, CI-02…) kept as its own column, separate from the name.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS code TEXT;

-- ─── block 03 ──────────────────────────────────────────────────

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
UPDATE orders SET status='pending' WHERE status='open';
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending','hold','completed','closed','cancelled'));
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS order_line_id INTEGER REFERENCES order_lines(id);
CREATE INDEX IF NOT EXISTS idx_reqs_order_line ON requisitions(order_line_id);

-- ─── block 04 ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS machine_log_entries (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  time_from TEXT,
  time_to TEXT,
  entry_type TEXT NOT NULL DEFAULT 'remark' CHECK
    (entry_type IN ('production','setup','maintenance','breakdown','idle','remark')),
  description TEXT NOT NULL,
  operator TEXT,
  qty INTEGER,
  remarks TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mlog_machine_date ON machine_log_entries(machine_id, log_date);

-- ─── block 05 ──────────────────────────────────────────────────

ALTER TABLE products ADD COLUMN IF NOT EXISTS internal_carton_code TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS party_artwork_code TEXT;
CREATE INDEX IF NOT EXISTS idx_products_carton_code ON products(internal_carton_code) WHERE internal_carton_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_artwork_code ON products(party_artwork_code) WHERE party_artwork_code IS NOT NULL;
-- Finishing flags on the Product Master. Emboss / Leafing are simple Yes(1)/No(0)
-- toggles; when leafing is on, leafing_colour names the foil shade (gold, silver,
-- red, green, blue, magenta, special). Both default to No so existing rows read
-- as "no finish" until set.
ALTER TABLE products ADD COLUMN IF NOT EXISTS emboss INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS leafing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS leafing_colour TEXT;
-- Carton pasting/gluing style (straight line, auto bottom, 4/6 corner, none).
-- Free text on the server; a fixed picker on the client keeps entry consistent.
ALTER TABLE products ADD COLUMN IF NOT EXISTS pasting_type TEXT;
-- Wastage % is no longer captured on the product form — new rows default to 0
-- (planners set absolute wastage sheets per order). Existing values are kept.
ALTER TABLE products ALTER COLUMN wastage_pct SET DEFAULT 0;
-- MRP is a print-only attribute (nothing drives off it) — the value we sometimes
-- print on the product. Nullable; no calculations reference it.
ALTER TABLE products ADD COLUMN IF NOT EXISTS mrp NUMERIC(12,2);
-- Product Master import columns:
--   party_item_code — the customer's own item/SKU code (sheet "Party Item Code")
--   die_number      — the plant's raw die number as printed on the master; kept
--                     as text and NOT linked to the Tooling Hub (tool_id) here.
--   colour_type     — CMYK / Pantone / CMYK + Pantone; defaults to CMYK.
-- the "colors" column already exists as the Total Colours count (DB default 4).
ALTER TABLE products ADD COLUMN IF NOT EXISTS party_item_code TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS die_number TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS colour_type TEXT DEFAULT 'CMYK';
-- The planner may leave a note when consuming FG against an order.
ALTER TABLE fg_consumptions ADD COLUMN IF NOT EXISTS remarks TEXT;

-- FG Warehouse Movement Ledger — one row per stock movement against a stock
-- reference (the FG lot number CI-FG-####). Never write to a lot's balance
-- without a row here: this is the audit trail the warehouse reads back.
--   ref_number   the Stock Reference Number = fg_lots.lot_number
--   parent_ref   links excess re-produced for the same product back to the
--                stock reference it was originally consumed against
--   balance      running remaining balance of THIS reference after the move
CREATE TABLE IF NOT EXISTS fg_movements (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ref_number TEXT NOT NULL,
  parent_ref TEXT,
  fg_lot_id INTEGER REFERENCES fg_lots(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  order_line_id INTEGER REFERENCES order_lines(id),
  order_id INTEGER REFERENCES orders(id),
  customer_id INTEGER REFERENCES customers(id),
  qty_in INTEGER NOT NULL DEFAULT 0,
  qty_out INTEGER NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0,
  movement_type TEXT NOT NULL CHECK (movement_type IN
    ('opening_stock','production_receipt','stock_consumption','excess_stock','manual_adjustment')),
  source_module TEXT NOT NULL DEFAULT 'warehouse' CHECK (source_module IN
    ('planning','production','warehouse','invoice','manual')),
  created_by TEXT,
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fgmove_ref ON fg_movements(ref_number, id);
CREATE INDEX IF NOT EXISTS idx_fgmove_product ON fg_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_fgmove_lot ON fg_movements(fg_lot_id);

-- ─── block 06 ──────────────────────────────────────────────────

INSERT INTO fg_movements (ref_number, fg_lot_id, product_id, order_line_id, order_id,
                          customer_id, qty_in, qty_out, balance, movement_type, source_module,
                          created_by, remarks, created_at)
SELECT fl.lot_number, fl.id, fl.product_id, fl.order_line_id, sol.order_id,
       p.customer_id, fl.qty, 0, fl.qty, 'opening_stock', 'warehouse',
       fl.created_by, 'Opening balance (ledger back-fill)', fl.created_at
FROM fg_lots fl
JOIN products p ON p.id = fl.product_id
LEFT JOIN order_lines sol ON sol.id = fl.order_line_id
WHERE NOT EXISTS (SELECT 1 FROM fg_movements m WHERE m.fg_lot_id = fl.id);

-- ─── block 07 ──────────────────────────────────────────────────

INSERT INTO fg_movements (ref_number, fg_lot_id, product_id, order_line_id, order_id,
                          customer_id, qty_in, qty_out, balance, movement_type, source_module,
                          created_by, remarks, created_at)
SELECT fl.lot_number, fl.id, fl.product_id, fc.order_line_id, ol.order_id,
       p.customer_id, 0, fc.qty,
       fl.qty - (SELECT COALESCE(SUM(fc2.qty),0) FROM fg_consumptions fc2
                 WHERE fc2.fg_lot_id = fc.fg_lot_id AND fc2.id <= fc.id),
       'stock_consumption', 'planning', fc.user_name,
       COALESCE(fc.remarks, 'Consumed (ledger back-fill)'), fc.created_at
FROM fg_consumptions fc
JOIN fg_lots fl ON fl.id = fc.fg_lot_id
JOIN products p ON p.id = fl.product_id
LEFT JOIN order_lines ol ON ol.id = fc.order_line_id
WHERE NOT EXISTS (
  SELECT 1 FROM fg_movements m
  WHERE m.fg_lot_id = fc.fg_lot_id AND m.movement_type = 'stock_consumption'
    AND m.order_line_id IS NOT DISTINCT FROM fc.order_line_id AND m.qty_out = fc.qty);

-- ─── block 08 ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coas (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coa_number TEXT NOT NULL UNIQUE,
  dispatch_line_id INTEGER NOT NULL UNIQUE REFERENCES dispatch_lines(id),
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  job_card_id INTEGER REFERENCES job_cards(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  invoice_id INTEGER REFERENCES invoices(id),
  qty INTEGER NOT NULL,
  batch_no TEXT,
  mfg_date TEXT,
  po_number TEXT,
  params JSONB NOT NULL DEFAULT '[]'::jsonb,
  sampling JSONB,
  remarks TEXT,
  inspected_by TEXT,
  approved_by TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued')),
  issued_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coas_invoice ON coas(invoice_id);
CREATE INDEX IF NOT EXISTS idx_coas_dispatch ON coas(dispatch_id);

-- ─── block 09 ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);
INSERT INTO sections (code, name, sort_order) VALUES
  ('cutting','Cutting',10),
  ('printing','Printing',20),
  ('coating','Coating',30),
  ('lamination','Lamination',40),
  ('foiling','Foiling',50),
  ('embossing','Embossing',60),
  ('die_cutting','Die Cutting',70),
  ('sorting','Sorting',80),
  ('pasting','Pasting',90),
  ('qc','QC',100)
ON CONFLICT (code) DO NOTHING;

-- ─── block 10 ──────────────────────────────────────────────────

INSERT INTO sections (code, name, sort_order)
SELECT src.section,
       initcap(replace(src.section, '_', ' ')),
       (SELECT COALESCE(MAX(sort_order), 0) FROM sections)
         + 10 * row_number() OVER (ORDER BY src.section)
FROM (
  SELECT DISTINCT section FROM employees
  WHERE section IS NOT NULL AND btrim(section) <> ''
) src
WHERE NOT EXISTS (SELECT 1 FROM sections s WHERE s.code = src.section)
ON CONFLICT (code) DO NOTHING;

-- ─── block 11 ──────────────────────────────────────────────────

INSERT INTO gst_rates (product_type, label, rate) VALUES
  ('carton', 'Carton', 5),
  ('label', 'Labels', 18),
  ('leaflet', 'Leaflets', 18),
  ('shipper_label', 'Shipper Labels', 18)
ON CONFLICT (product_type) DO NOTHING;

-- ─── block 12 ──────────────────────────────────────────────────

INSERT INTO tools (family, code, title, zone, condition, location,
                   ups, sheet_size, carton_size, impression_count,
                   max_impressions, last_used_date, active)
SELECT 'die', d.die_number,
       COALESCE(NULLIF(d.die_type, ''), 'Die ' || d.die_number),
       CASE WHEN d.active = 1 AND d.condition NOT IN ('Poor','Scrapped')
            THEN 'in_rack' ELSE 'incoming' END,
       d.condition, d.location,
       d.ups, d.sheet_size, d.carton_size, d.impression_count,
       d.max_impressions, d.last_used_date, d.active
FROM dies d
WHERE NOT EXISTS (SELECT 1 FROM tools WHERE family = 'die');

-- ─── block 13 ──────────────────────────────────────────────────

UPDATE products p SET tool_id = t.id
FROM dies d JOIN tools t ON t.family = 'die' AND t.code = d.die_number
WHERE p.die_id = d.id AND p.tool_id IS NULL;

-- ─── block 14 ──────────────────────────────────────────────────

ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS requested_by TEXT;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS remarks TEXT;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS reraise_of INTEGER REFERENCES requisitions(id);
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS reraise_reason TEXT;
-- Why the PR was raised. Job-driven buying stays 'production' (the default, so
-- every existing row is correct); Warehouse-raised replenishment records its own
-- intent. Reporting only — it gates nothing.
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'production';
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vendor_notes TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS payment_terms TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_terms TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS reference TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS vehicle_no TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS supplier_invoice_no TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS supplier_invoice_date TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS received_by TEXT;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS remarks TEXT;
-- Direct (non-PO) goods receipt: material received without a purchase order
-- (samples, urgent buys, stock corrections). The PO link becomes optional and an
-- optional vendor_id records the supplier when known. source marks the origin so
-- direct receipts are unmistakable in the register. Existing rows stay 'po'.
ALTER TABLE grns ALTER COLUMN purchase_order_id DROP NOT NULL;
ALTER TABLE grns ALTER COLUMN po_line_id DROP NOT NULL;
ALTER TABLE grns ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES vendors(id);
ALTER TABLE grns ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'po';
-- Print Set / Output Number on the Carton Product Master. Mapped together with
-- code + internal_carton_code + party_artwork_code; auto-populates the Planning
-- Engine for single (non-gang) runs.
ALTER TABLE products ADD COLUMN IF NOT EXISTS output_number TEXT;
-- Shade card lifecycle: creation + approval dates drive the 1-year expiry
-- engine (age >= 365 days → renewal warning at Planning and Invoicing).
ALTER TABLE tools ADD COLUMN IF NOT EXISTS creation_date TEXT;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS approval_date TEXT;
-- Shade Card Number + Date on the Carton Product Master. Follows the same
-- master-update philosophy as output_number: editable on the master form and
-- from Planning/Artwork (Sync Master? / This Job Only). The date drives the
-- shade-card age shown at Planning, Artwork, Job Card and the Products table,
-- and feeds the 1-year expiry engine when no Tooling Hub card carries a date.
ALTER TABLE products ADD COLUMN IF NOT EXISTS shade_card_number TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shade_card_date TEXT;
-- Block Number on the Carton Product Master (2026-07-27). Same philosophy as
-- output_number / shade_card_number: editable from Planning, Artwork and the
-- Job Card with the Sync Master? / This Job Only fork. Free text — the Tooling
-- Hub block's auto code (BLK-…) stays the display fallback when this is empty,
-- and editing this text never renames the hub tool.
ALTER TABLE products ADD COLUMN IF NOT EXISTS block_number TEXT;

-- ─── block 15 ──────────────────────────────────────────────────

UPDATE products SET
  product_type = CASE
    WHEN UPPER(name) LIKE '%SHIPPER%'                                  THEN 'shipper_label'
    WHEN UPPER(name) LIKE '%LEAFLET%' OR UPPER(name) LIKE '%INSERT%'   THEN 'leaflet'
    WHEN UPPER(name) LIKE '%LABEL%'   OR UPPER(name) LIKE '%STICKER%'  THEN 'label'
    ELSE 'carton' END,
  gst_pct = NULL
WHERE product_type IS NULL;

-- ─── block 16 ──────────────────────────────────────────────────

UPDATE products p SET board_grade = NULLIF(
    split_part(COALESCE(NULLIF(p.board_name,''), (SELECT m.name FROM materials m WHERE m.id = p.board_material_id), ''), ' ', 1),
  '')
WHERE (p.board_grade IS NULL OR p.board_grade = '');

-- ─── block 17 ──────────────────────────────────────────────────

ALTER TABLE machines ADD COLUMN IF NOT EXISTS is_manual INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS pasting_rows (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_stage_id INTEGER NOT NULL REFERENCES job_stages(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  input_qty INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('machine','manual','machine_manual','split')),
  auto_qty INTEGER NOT NULL DEFAULT 0,
  manual_qty INTEGER NOT NULL DEFAULT 0,
  auto_machine_id INTEGER REFERENCES machines(id),
  waste_qty INTEGER NOT NULL DEFAULT 0,
  waste_reason TEXT,
  good_qty INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pasting_rows_stage ON pasting_rows(job_stage_id);

-- Third pasting workstation. Idempotent: one Manual Pasting bench per plant,
-- added without a reseed so live databases pick it up on the next boot.
INSERT INTO machines (name, type, capacity_per_hour, status, is_manual)
SELECT 'Manual Pasting', 'pasting', 0, 'running', 1
WHERE NOT EXISTS (SELECT 1 FROM machines WHERE type='pasting' AND is_manual=1);

-- ─── block 18 ──────────────────────────────────────────────────

-- Master enrichment ---------------------------------------------------------
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS gstin TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS state_code TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS email TEXT;

ALTER TABLE materials ADD COLUMN IF NOT EXISTS hsn_code TEXT;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS gst_rate DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS last_rate DOUBLE PRECISION;
-- Controlled standard purchase rate, set from Masters → Board Rates. Distinct
-- from last_rate (which drifts to the latest PO): std_rate is authoritative and
-- auto-fills new PO lines, so procurement never has to re-type the board rate.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS std_rate DOUBLE PRECISION;
-- Plant default: boards attract 18% GST. Fill boards that were left at 0/NULL
-- (the old column default); a board deliberately set to some other rate is kept.
UPDATE materials SET gst_rate=18 WHERE category='board' AND (gst_rate IS NULL OR gst_rate=0);

-- Board sizes are written closed up: 'Duplex GB · 296 GSM · 20x38', not
-- '… 20 x 38'. The size is one spoken token on the floor, and the composer
-- (board-code.js boardName) now emits it that way — this brings the stored
-- master into line so the two cannot disagree.
--
-- BOTH columns must move together. products.board_name is a denormalised copy of
-- materials.name, and gang compatibility buckets jobs by that string
-- (routes/gangs.js). Migrating one and not the other would split a single board
-- into two gangs. Applying the SAME expression to both is what guarantees it:
-- any product↔board pair that matched before still matches after, and any pair
-- that did not, still does not.
--
-- Global rather than end-anchored on purpose: a leftover offcut's name embeds its
-- parent's ('Leftover — Duplex GB · 296 GSM · 20 x 38 · 12×20"'), so an anchored
-- rewrite would leave the embedded copy spaced and drifting from the parent.
-- Scoped to boards, where a digit-separator-digit pair is always a sheet size.
--
-- The separator is an ALTERNATION, never a bracket expression, and that is load
-- bearing. '×' (U+00D7) is two bytes in UTF-8; local is a SQL_ASCII database
-- while Supabase is UTF8, and under SQL_ASCII a bracket expression is a set of
-- single BYTES — '[xX×]' then matches only half of '×' and the pattern never
-- completes, so the migration would silently no-op locally and apply in
-- production. products.board_name stores '20 × 38' almost exclusively, so this
-- is the difference between migrating 992 rows and migrating none.
--
-- Idempotent: re-running rewrites an already-closed name to itself, and the
-- WHERE means the second run updates nothing at all.
UPDATE materials SET name = regexp_replace(name, '([0-9.]+)[[:space:]]*(?:x|X|×|\\*)[[:space:]]*([0-9.]+)', '\\1x\\2', 'g')
 WHERE category='board' AND name IS NOT NULL
   AND name <> regexp_replace(name, '([0-9.]+)[[:space:]]*(?:x|X|×|\\*)[[:space:]]*([0-9.]+)', '\\1x\\2', 'g');
UPDATE products SET board_name = regexp_replace(board_name, '([0-9.]+)[[:space:]]*(?:x|X|×|\\*)[[:space:]]*([0-9.]+)', '\\1x\\2', 'g')
 WHERE board_name IS NOT NULL
   AND board_name <> regexp_replace(board_name, '([0-9.]+)[[:space:]]*(?:x|X|×|\\*)[[:space:]]*([0-9.]+)', '\\1x\\2', 'g');

-- Full-GST purchase order ---------------------------------------------------
ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS hsn_code TEXT;
ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS gst_rate DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS tax_kind TEXT NOT NULL DEFAULT 'intra';
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS freight DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS round_off DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Multi-item requisition lines ----------------------------------------------
CREATE TABLE IF NOT EXISTS requisition_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requisition_id INTEGER NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  qty DOUBLE PRECISION NOT NULL,
  est_rate DOUBLE PRECISION,
  needed_by TEXT,
  remarks TEXT
);
CREATE INDEX IF NOT EXISTS idx_req_lines_req ON requisition_lines(requisition_id);

-- Backfill one line per legacy single-material requisition lacking lines.
INSERT INTO requisition_lines (requisition_id, material_id, qty, needed_by)
SELECT pr.id, pr.material_id, pr.qty, pr.needed_by
FROM requisitions pr
WHERE pr.material_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM requisition_lines rl WHERE rl.requisition_id = pr.id);

-- Company profile: buyer block + home state for the intra/inter-state split.
CREATE TABLE IF NOT EXISTS company_profile (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  gstin TEXT, address TEXT, city TEXT, state TEXT, state_code TEXT,
  phone TEXT, email TEXT
);
INSERT INTO company_profile (name, address, city, state, state_code)
SELECT 'Colour Impressions', '', 'Patiala', 'Punjab', '03'
WHERE NOT EXISTS (SELECT 1 FROM company_profile);
-- The profile was originally seeded as "Colour Imp Production", which is the
-- folder name, not the business. It prints on POs, COAs and every export, so
-- correct it in place on existing databases too. Idempotent by design.
UPDATE company_profile SET name = 'Colour Impressions'
WHERE name = 'Colour Imp Production';

-- ─── block 19 ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shade_cards (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sc_number TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  customer_id INTEGER REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','sent','approved','rejected')),
  revision_no INTEGER NOT NULL DEFAULT 0,
  print_process TEXT,
  colour_system TEXT,
  num_colours INTEGER,
  artwork_no TEXT,
  artwork_rev TEXT,
  print_reference TEXT,
  colour_details TEXT,
  approval_requirement TEXT NOT NULL DEFAULT 'customer'
    CHECK (approval_requirement IN ('customer','internal')),
  sent_to_customer_date TEXT,
  expected_approval_date TEXT,
  approval_received_date TEXT,
  approval_received_by TEXT,
  approval_method TEXT,
  approval_remarks TEXT,
  customer_stamp INTEGER NOT NULL DEFAULT 0,
  customer_signature INTEGER NOT NULL DEFAULT 0,
  customer_contact_name TEXT,
  customer_designation TEXT,
  customer_company TEXT,
  internal_qc_stamp INTEGER NOT NULL DEFAULT 0,
  internal_signatory TEXT,
  internal_approval_date TEXT,
  creation_date TEXT,
  superseded_by INTEGER REFERENCES shade_cards(id),
  dock_zone TEXT NOT NULL DEFAULT 'triage' CHECK (dock_zone IN ('triage','vault','on_press')),
  dock_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_machine_id INTEGER REFERENCES machines(id),
  issued_operator TEXT,
  issued_job_card_id INTEGER REFERENCES job_cards(id),
  issued_at TIMESTAMPTZ,
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at TIMESTAMPTZ,
  location TEXT,
  remarks TEXT,
  legacy_tool_id INTEGER REFERENCES tools(id),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_shade_cards_product ON shade_cards(product_id);
CREATE INDEX IF NOT EXISTS idx_shade_cards_customer ON shade_cards(customer_id);
CREATE INDEX IF NOT EXISTS idx_shade_cards_status ON shade_cards(status);

CREATE TABLE IF NOT EXISTS shade_card_orders (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shade_card_id INTEGER NOT NULL REFERENCES shade_cards(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shade_card_id, order_id)
);

CREATE TABLE IF NOT EXISTS shade_card_revisions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shade_card_id INTEGER NOT NULL REFERENCES shade_cards(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  reason TEXT,
  requested_by TEXT,
  approved_by TEXT,
  snapshot JSONB,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sc_revisions_card ON shade_card_revisions(shade_card_id);

CREATE TABLE IF NOT EXISTS shade_card_docs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shade_card_id INTEGER NOT NULL REFERENCES shade_cards(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL DEFAULT 0,
  doc_type TEXT NOT NULL DEFAULT 'other' CHECK (doc_type IN
    ('shade_card_pdf','artwork','signed_scan','approval_email','whatsapp','digital_approval',
     'note','revision_doc','other')),
  title TEXT,
  file_name TEXT,
  mime TEXT,
  size_bytes INTEGER,
  data BYTEA,
  note TEXT,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sc_docs_card ON shade_card_docs(shade_card_id);

CREATE TABLE IF NOT EXISTS shade_card_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shade_card_id INTEGER NOT NULL REFERENCES shade_cards(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  user_name TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sc_events_card ON shade_card_events(shade_card_id, id);

-- ── 2026-07-30 Shade Card simplification ─────────────────────────────────────
-- The card's Sales Order link and Output Code. order_line_id (not order_id) is
-- the anchor because every field the form auto-populates — order quantity,
-- product, board, print specs, artwork code, output code — is line-level. The
-- order is reached by join, so navigation works in both directions.
-- Nullable: the 599 cards bulk-imported in July 2026 predate any SO link.
ALTER TABLE shade_cards ADD COLUMN IF NOT EXISTS order_line_id INTEGER REFERENCES order_lines(id);
ALTER TABLE shade_cards ADD COLUMN IF NOT EXISTS output_no TEXT;
CREATE INDEX IF NOT EXISTS idx_fk_shade_cards_order_line_id ON shade_cards (order_line_id);

-- The custody register: who physically holds the card, and every hand-off it
-- has ever been through. Deliberately NOT a column on shade_cards — a card is
-- issued and returned many times over its 365-day life while its approval
-- state never moves, so custody is a log, not a flag.
CREATE TABLE IF NOT EXISTS shade_card_issues (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shade_card_id INTEGER NOT NULL REFERENCES shade_cards(id) ON DELETE CASCADE,
  issued_to     TEXT NOT NULL,
  department    TEXT NOT NULL DEFAULT 'printing',
  issued_by     TEXT,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  job_card_id   INTEGER REFERENCES job_cards(id),
  machine_id    INTEGER REFERENCES machines(id),
  returned_by   TEXT,
  received_by   TEXT,
  returned_at   TIMESTAMPTZ,
  condition     TEXT CHECK (condition IN ('good','soiled','damaged','lost')),
  remarks       TEXT
);
-- One open issue per card, enforced by the database rather than by a code check
-- somebody can forget. This is what makes "where is this card?" a single row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_issues_open
  ON shade_card_issues (shade_card_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sc_issues_card ON shade_card_issues (shade_card_id, id);
CREATE INDEX IF NOT EXISTS idx_fk_sc_issues_job_card_id ON shade_card_issues (job_card_id);
CREATE INDEX IF NOT EXISTS idx_fk_sc_issues_machine_id ON shade_card_issues (machine_id);

-- The retire zone for the free-text shade card numbers that used to be typed
-- onto the product master. Retiring moves the value here and clears the product
-- columns; restoring puts it back. Nothing is ever deleted, and an orphan
-- number can be promoted into a real card (promoted_to).
CREATE TABLE IF NOT EXISTS shade_card_legacy_numbers (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  sc_number   TEXT,
  sc_date     TEXT,
  promoted_to INTEGER REFERENCES shade_cards(id),
  retired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_by  TEXT,
  restored_at TIMESTAMPTZ,
  restored_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_fk_sc_legacy_product_id ON shade_card_legacy_numbers (product_id);
CREATE INDEX IF NOT EXISTS idx_fk_sc_legacy_promoted_to ON shade_card_legacy_numbers (promoted_to);

-- Existing databases carry the twelve-value constraint. Remap the rows FROM THE
-- DATES ON THEM, then swap the constraint — in this statement order so the new
-- constraint never sees an old value.
--
-- The goal is to PRESERVE today's gate behaviour while never inventing an
-- approval that was never asserted. Those are two different requirements, and
-- an earlier draft of this migration satisfied the second while violating the
-- first, in a plant-stopping way.
--
-- Three old statuses ARE the plant's record of a customer verdict, so they
-- carry across directly. This is not "trusting a name": 'customer_approved'
-- means the customer approved, and such a card clears the printing gate TODAY.
-- Sending it anywhere else would change behaviour, not preserve it.
--   Every one of the 599 live cards on production is 'customer_approved' with
--   a NULL approval_received_date — the bulk import never populated the dates.
--   A purely date-derived remap therefore sent all 599 to 'draft', which under
--   the new one-rule gate hard-blocks printing on every shade-carded product
--   in the plant. Verified against prod, not assumed.
--
-- 'expired' is the mapping that genuinely needs care, because it asserts a
-- LAPSED approval rather than a live one. Carrying it to 'approved' is safe
-- only when creation_date exists, because isExpiredByAge() then blocks it
-- independently — the gate tests status AND age. With no date there is nothing
-- to expire against, so it would clear for ever; fall back to 'draft'.
--
-- internal_review, internal_approved and revised assert no customer approval
-- at all, so they get an explicit 'draft' arm rather than falling through to
-- the date checks below — a stray approval_received_date on one of these rows
-- must never promote it. internal_approved tightening is intended: internal
-- approval is being removed as a concept. draft and any other unrecognised
-- value still fall through to the date checks and default to 'draft'.
ALTER TABLE shade_cards DROP CONSTRAINT IF EXISTS shade_cards_status_check;
UPDATE shade_cards SET active = 0 WHERE status IN ('superseded','archived');
UPDATE shade_cards SET status = CASE
    WHEN status = 'customer_approved'                            THEN 'approved'
    WHEN status IN ('rejected','revision_requested')             THEN 'rejected'
    WHEN status IN ('sent_to_customer','customer_reviewing')     THEN 'sent'
    -- Explicit, not left to the date fallback: these three assert no customer
    -- verdict at all, so a stray approval_received_date must never promote them.
    WHEN status IN ('internal_review','internal_approved','revised') THEN 'draft'
    WHEN status = 'expired' AND COALESCE(creation_date,'') <> '' THEN 'approved'
    WHEN COALESCE(approval_received_date,'') <> ''               THEN 'approved'
    WHEN COALESCE(sent_to_customer_date,'')  <> ''               THEN 'sent'
    ELSE 'draft'
  END
  WHERE status NOT IN ('draft','sent','approved','rejected');
ALTER TABLE shade_cards ADD CONSTRAINT shade_cards_status_check
  CHECK (status IN ('draft','sent','approved','rejected'));

-- Any card physically out on press becomes an OPEN issue row so custody
-- survives the change. issued_operator is nullable and issued_to is NOT NULL,
-- so the COALESCE is load-bearing: a null would abort this statement.
INSERT INTO shade_card_issues (shade_card_id, issued_to, department, issued_by,
                               issued_at, job_card_id, machine_id)
SELECT sc.id, COALESCE(NULLIF(TRIM(sc.issued_operator), ''), 'unknown (migrated)'),
       'printing', 'migration', COALESCE(sc.issued_at, sc.dock_since, now()),
       sc.issued_job_card_id, sc.issued_machine_id
FROM shade_cards sc
WHERE sc.dock_zone = 'on_press'
  -- "never had ANY issue row", not "has no OPEN row". dock_zone is deprecated
  -- and never cleared, so it stays 'on_press' for ever; an open-row guard
  -- re-arms the moment the card is legitimately returned, and the next restart
  -- would insert a second open row claiming it is still out.
  AND NOT EXISTS (SELECT 1 FROM shade_card_issues i WHERE i.shade_card_id = sc.id);

-- products.shade_card_number/date become a DERIVED cache of the module, never a
-- source. Back-filling from the newest active card fixes the 12 products whose
-- hand-typed date disagreed with the card's.
UPDATE products p SET shade_card_number = s.sc_number,
                      shade_card_date   = COALESCE(s.creation_date, p.shade_card_date)
FROM (SELECT DISTINCT ON (product_id) product_id, sc_number, creation_date
      FROM shade_cards WHERE active = 1 ORDER BY product_id, id DESC) s
WHERE s.product_id = p.id
  -- A retired number must STAY retired. Without this, every server restart
  -- re-derives the product's mirrored columns from the still-active card and
  -- silently undoes the retire — no error, just quiet reversion on next boot.
  -- promoted_to IS NULL matters: shade_card_legacy_numbers holds two different
  -- kinds of row. A retire says "stop mirroring this product". A promotion is
  -- provenance — the orphan number a real card was built from — and that card
  -- SHOULD keep mirroring. Without this clause a promoted product is excluded
  -- for ever, so its master goes stale the first time the card is renewed.
  AND NOT EXISTS (SELECT 1 FROM shade_card_legacy_numbers l
                  WHERE l.product_id = p.id AND l.restored_at IS NULL
                    AND l.promoted_to IS NULL)
  AND (COALESCE(p.shade_card_number,'') <> COALESCE(s.sc_number,'')
    OR COALESCE(p.shade_card_date,'')   <> COALESCE(s.creation_date, p.shade_card_date, ''));

-- Seed the card's own Output Code from the product master where it is blank.
UPDATE shade_cards sc SET output_no = p.output_number
FROM products p
WHERE p.id = sc.product_id
  AND COALESCE(sc.output_no,'') = '' AND COALESCE(p.output_number,'') <> '';

-- Production-control configuration. NULL = fall through (product → customer →
-- 'customer', the safe default: customer approval gates printing).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS shade_approval_requirement TEXT
  CHECK (shade_approval_requirement IN ('customer','internal'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS shade_approval_requirement TEXT
  CHECK (shade_approval_requirement IN ('customer','internal'));

-- One-time migration: lift every live shade card out of the Tooling Hub.
-- Codes (SHD-xxxx) are preserved as the card number so nothing printed or
-- remembered breaks; the physical zone maps onto the dock loop; a card with an
-- approval date on record arrives as customer-approved, one already stored in
-- the vault/on-press as internally approved, the rest as draft. The source
-- tools row is retired (active=0) so the Tooling Hub board no longer shows it,
-- and legacy_tool_id keeps the bridge for the event-history copy below.
INSERT INTO shade_cards (sc_number, title, product_id, customer_id, status,
  creation_date, approval_received_date, internal_approval_date, internal_qc_stamp,
  print_reference, location, remarks, dock_zone, dock_since,
  issued_machine_id, issued_operator, issued_job_card_id, issued_at,
  verified, verified_at, legacy_tool_id, created_by)
SELECT t.code, t.title, t.product_id, p.customer_id,
  CASE WHEN COALESCE(t.approval_date,'') <> '' THEN 'customer_approved'
       WHEN t.zone IN ('in_rack','on_floor') THEN 'internal_approved'
       ELSE 'draft' END,
  NULLIF(t.creation_date,''), NULLIF(t.approval_date,''),
  CASE WHEN t.zone IN ('in_rack','on_floor') THEN NULLIF(t.creation_date,'') END,
  CASE WHEN t.zone IN ('in_rack','on_floor') THEN 1 ELSE 0 END,
  t.shade_ref, t.location, t.notes,
  CASE t.zone WHEN 'on_floor' THEN 'on_press' WHEN 'in_rack' THEN 'vault' ELSE 'triage' END,
  t.zone_since,
  t.issued_machine_id, t.issued_operator, t.issued_job_card_id, t.issued_at,
  COALESCE(t.verified,0), t.verified_at, t.id, 'migration'
FROM tools t LEFT JOIN products p ON p.id = t.product_id
WHERE t.family = 'shade_card' AND t.active = 1
  AND NOT EXISTS (SELECT 1 FROM shade_cards sc WHERE sc.legacy_tool_id = t.id);

-- Carry the Tooling-Hub event history across so the audit trail stays whole.
INSERT INTO shade_card_events (shade_card_id, action, from_status, to_status, note, user_name, at)
SELECT sc.id, 'tooling:' || te.action, te.from_zone, te.to_zone, te.note, te.user_name, te.at
FROM shade_cards sc JOIN tool_events te ON te.tool_id = sc.legacy_tool_id
WHERE NOT EXISTS (SELECT 1 FROM shade_card_events e
                  WHERE e.shade_card_id = sc.id AND e.action LIKE 'tooling:%');

UPDATE tools SET active = 0 WHERE family = 'shade_card' AND active = 1;

-- ── Phase 2: Unified QC + Finished Goods ──────────────────────────────────
-- QC inspector sign-off timestamp (inspector name already exists).
ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS inspected_at TIMESTAMPTZ;
-- FG lots become physical, numbered leftover boxes. box_number is auto-assigned
-- (CI-BOX-####) and editable; kind separates ordinary FG excess from finished
-- goods deliberately boxed as re-usable Leftover stock.
ALTER TABLE fg_lots ADD COLUMN IF NOT EXISTS box_number TEXT;
ALTER TABLE fg_lots ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'fg_excess';
ALTER TABLE fg_lots ADD COLUMN IF NOT EXISTS dispatch_id INTEGER REFERENCES dispatches(id);
-- Widen the source enum so a box can be created straight off the FG list.
ALTER TABLE fg_lots DROP CONSTRAINT IF EXISTS fg_lots_source_check;
ALTER TABLE fg_lots ADD CONSTRAINT fg_lots_source_check
  CHECK (source IN ('dispatch_excess','packing_excess','manual','fg_leftover'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_fg_lots_box_number ON fg_lots(box_number) WHERE box_number IS NOT NULL;

-- ── 2026-07-20: day-wise production runs ──────────────────────────────────
-- Every stage becomes a run log. A single-shot completion writes exactly one
-- run; a five-day pasting job writes five. job_stages.qty_out / qty_scrap stay
-- put as a cached rollup so every downstream reader is unaffected.
CREATE TABLE IF NOT EXISTS stage_runs (
  id            SERIAL PRIMARY KEY,
  job_stage_id  INTEGER NOT NULL REFERENCES job_stages(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  run_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  shift         TEXT,
  qty_good      INTEGER NOT NULL DEFAULT 0,
  qty_scrap     INTEGER NOT NULL DEFAULT 0,
  scrap_reason  TEXT,
  machine_id    INTEGER REFERENCES machines(id),
  operator      TEXT,
  up_printing_operator TEXT,
  up_die_operator      TEXT,
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stage_runs_stage ON stage_runs(job_stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_runs_date  ON stage_runs(run_date);

-- A stage that has output but is not finished sits between in_progress and
-- completed. Downstream stages read qty_out, which is already correct for it.
ALTER TABLE job_stages DROP CONSTRAINT IF EXISTS job_stages_status_check;
ALTER TABLE job_stages ADD CONSTRAINT job_stages_status_check
  CHECK (status IN ('pending','in_progress','partially_completed','hold','completed'));

-- Operator's fulfilment decision at the last carton stage.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS production_fulfilled_at TIMESTAMPTZ;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS production_fulfilled_by TEXT;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS short_close_reason TEXT;

-- Backfill: every already-completed stage becomes a one-run log, so the rollup
-- is consistent from day one and history is queryable in the same shape.
INSERT INTO stage_runs (job_stage_id, seq, run_date, qty_good, qty_scrap,
                        scrap_reason, machine_id, operator, note, created_by)
SELECT js.id, 1, COALESCE(js.completed_at::date, CURRENT_DATE),
       COALESCE(js.qty_out, 0), COALESCE(js.qty_scrap, 0),
       js.scrap_reason, js.machine_id, js.operator, 'backfill', 'migration'
FROM job_stages js
WHERE js.status = 'completed' AND js.qty_out IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM stage_runs sr WHERE sr.job_stage_id = js.id);

-- ─── block 20 ──────────────────────────────────────────────────

-- Board rates & weight ------------------------------------------------------
-- Board is bought by weight. ONE ₹/kg per grade drives every board in it; a row
-- naming a vendor overrides the base row for that vendor only. Everything else
-- (₹/sheet, packet weight, PO tonnage) is derived at read time by board-math.js
-- and never stored, so editing a rate reprices its boards with no backfill.
CREATE TABLE IF NOT EXISTS board_rates (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grade          TEXT NOT NULL,
  vendor_id      INTEGER REFERENCES vendors(id),  -- NULL = base rate, all vendors
  rate_per_kg    DOUBLE PRECISION NOT NULL,
  effective_from DATE,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ DEFAULT now()
);
-- COALESCE is required: Postgres does not treat two NULLs as equal, so a plain
-- UNIQUE(grade, vendor_id) would allow duplicate base rates for a grade.
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_rates_grade_vendor
  ON board_rates(grade, COALESCE(vendor_id, -1));

-- Structured board identity. Until now GSM was regex-scraped out of the free-text
-- name at every call site (smartmatch.js, orders.js); it is real data from here on.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS grade TEXT;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS gsm INTEGER;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS sheets_per_packet INTEGER;

-- Replenishment band. 0 means "not set" (the UI shows "—"), never "hold no
-- stock", so ~300 existing boards stay valid untouched. reorder_level is the
-- trigger point; min/max are the band a stock-replenishment PR aims to restore.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS min_stock DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS max_stock DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Covering indexes for every foreign key (mirrors the add_fk_covering_indexes
-- migration applied to Supabase prod). Joins/lookups stay index-backed as the
-- plant's data grows.
CREATE INDEX IF NOT EXISTS idx_fk_board_rates_vendor_id ON board_rates (vendor_id);
CREATE INDEX IF NOT EXISTS idx_fk_coas_customer_id ON coas (customer_id);
CREATE INDEX IF NOT EXISTS idx_fk_coas_job_card_id ON coas (job_card_id);
CREATE INDEX IF NOT EXISTS idx_fk_coas_order_line_id ON coas (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_coas_product_id ON coas (product_id);
CREATE INDEX IF NOT EXISTS idx_fk_cutting_discrepancies_board_material_id ON cutting_discrepancies (board_material_id);
CREATE INDEX IF NOT EXISTS idx_fk_cutting_discrepancies_job_card_id ON cutting_discrepancies (job_card_id);
CREATE INDEX IF NOT EXISTS idx_fk_cutting_discrepancies_job_stage_id ON cutting_discrepancies (job_stage_id);
CREATE INDEX IF NOT EXISTS idx_fk_dispatch_lines_dispatch_id ON dispatch_lines (dispatch_id);
CREATE INDEX IF NOT EXISTS idx_fk_dispatch_lines_order_line_id ON dispatch_lines (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_dispatch_lines_product_id ON dispatch_lines (product_id);
CREATE INDEX IF NOT EXISTS idx_fk_dispatches_customer_id ON dispatches (customer_id);
CREATE INDEX IF NOT EXISTS idx_fk_dispatches_order_id ON dispatches (order_id);
CREATE INDEX IF NOT EXISTS idx_fk_extra_sheet_requests_job_card_id ON extra_sheet_requests (job_card_id);
CREATE INDEX IF NOT EXISTS idx_fk_extra_sheet_requests_job_stage_id ON extra_sheet_requests (job_stage_id);
CREATE INDEX IF NOT EXISTS idx_fk_fg_consumptions_fg_lot_id ON fg_consumptions (fg_lot_id);
CREATE INDEX IF NOT EXISTS idx_fk_fg_consumptions_order_line_id ON fg_consumptions (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_fg_lots_dispatch_id ON fg_lots (dispatch_id);
CREATE INDEX IF NOT EXISTS idx_fk_fg_lots_job_card_id ON fg_lots (job_card_id);
CREATE INDEX IF NOT EXISTS idx_fk_fg_lots_order_line_id ON fg_lots (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_fg_lots_product_id ON fg_lots (product_id);
CREATE INDEX IF NOT EXISTS idx_fk_fg_movements_customer_id ON fg_movements (customer_id);
CREATE INDEX IF NOT EXISTS idx_fk_fg_movements_order_id ON fg_movements (order_id);
CREATE INDEX IF NOT EXISTS idx_fk_fg_movements_order_line_id ON fg_movements (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_grns_material_id ON grns (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_grns_po_line_id ON grns (po_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_grns_purchase_order_id ON grns (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_fk_grns_vendor_id ON grns (vendor_id);
CREATE INDEX IF NOT EXISTS idx_fk_invoice_lines_invoice_id ON invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS idx_fk_invoice_lines_product_id ON invoice_lines (product_id);
CREATE INDEX IF NOT EXISTS idx_fk_invoices_customer_id ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_cards_gang_run_id ON job_cards (gang_run_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_cards_machine_id ON job_cards (machine_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_cards_parent_job_card_id ON job_cards (parent_job_card_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_cards_product_id ON job_cards (product_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_stages_machine_id ON job_stages (machine_id);
CREATE INDEX IF NOT EXISTS idx_fk_machine_operators_employee_id ON machine_operators (employee_id);
CREATE INDEX IF NOT EXISTS idx_fk_materials_source_material_id ON materials (source_material_id);
CREATE INDEX IF NOT EXISTS idx_fk_order_lines_gang_run_id ON order_lines (gang_run_id);
CREATE INDEX IF NOT EXISTS idx_fk_order_lines_machine_id ON order_lines (machine_id);
CREATE INDEX IF NOT EXISTS idx_fk_order_lines_order_id ON order_lines (order_id);
CREATE INDEX IF NOT EXISTS idx_fk_order_lines_product_id ON order_lines (product_id);
CREATE INDEX IF NOT EXISTS idx_fk_orders_customer_id ON orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_fk_packing_lines_job_stage_id ON packing_lines (job_stage_id);
CREATE INDEX IF NOT EXISTS idx_fk_pasting_rows_auto_machine_id ON pasting_rows (auto_machine_id);
CREATE INDEX IF NOT EXISTS idx_fk_payments_customer_id ON payments (customer_id);
CREATE INDEX IF NOT EXISTS idx_fk_payments_invoice_id ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_fk_po_lines_material_id ON po_lines (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_po_lines_purchase_order_id ON po_lines (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_fk_product_aliases_product_id ON product_aliases (product_id);
CREATE INDEX IF NOT EXISTS idx_fk_products_board_material_id ON products (board_material_id);
CREATE INDEX IF NOT EXISTS idx_fk_products_customer_id ON products (customer_id);
CREATE INDEX IF NOT EXISTS idx_fk_products_die_id ON products (die_id);
CREATE INDEX IF NOT EXISTS idx_fk_products_tool_id ON products (tool_id);
CREATE INDEX IF NOT EXISTS idx_fk_purchase_orders_requisition_id ON purchase_orders (requisition_id);
CREATE INDEX IF NOT EXISTS idx_fk_purchase_orders_vendor_id ON purchase_orders (vendor_id);
CREATE INDEX IF NOT EXISTS idx_fk_requisition_lines_material_id ON requisition_lines (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_requisitions_material_id ON requisitions (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_requisitions_purchase_order_id ON requisitions (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_fk_requisitions_reraise_of ON requisitions (reraise_of);
CREATE INDEX IF NOT EXISTS idx_fk_shade_card_orders_order_id ON shade_card_orders (order_id);
CREATE INDEX IF NOT EXISTS idx_fk_shade_cards_issued_job_card_id ON shade_cards (issued_job_card_id);
CREATE INDEX IF NOT EXISTS idx_fk_shade_cards_issued_machine_id ON shade_cards (issued_machine_id);
CREATE INDEX IF NOT EXISTS idx_fk_shade_cards_legacy_tool_id ON shade_cards (legacy_tool_id);
CREATE INDEX IF NOT EXISTS idx_fk_shade_cards_superseded_by ON shade_cards (superseded_by);
CREATE INDEX IF NOT EXISTS idx_fk_stage_runs_machine_id ON stage_runs (machine_id);
CREATE INDEX IF NOT EXISTS idx_fk_stock_movements_batch_id ON stock_movements (batch_id);
CREATE INDEX IF NOT EXISTS idx_fk_stock_movements_product_id ON stock_movements (product_id);
CREATE INDEX IF NOT EXISTS idx_fk_tool_events_tool_id ON tool_events (tool_id);
CREATE INDEX IF NOT EXISTS idx_fk_tools_issued_job_card_id ON tools (issued_job_card_id);
CREATE INDEX IF NOT EXISTS idx_fk_tools_issued_machine_id ON tools (issued_machine_id);
CREATE INDEX IF NOT EXISTS idx_fk_tools_product_id ON tools (product_id);

-- KPI time windows (mirrors the add_kpi_time_range_indexes migration on prod).
-- The dashboard filters these columns by half-open range — see plant-calendar.js
-- — so a plain b-tree on the timestamp is what the planner needs.
CREATE INDEX IF NOT EXISTS idx_job_cards_closed_at ON job_cards (closed_at) WHERE status = 'closed';
CREATE INDEX IF NOT EXISTS idx_job_stages_completed_at ON job_stages (completed_at);
CREATE INDEX IF NOT EXISTS idx_job_stages_machine_completed ON job_stages (machine_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_dispatches_dispatched_at ON dispatches (dispatched_at);
CREATE INDEX IF NOT EXISTS idx_orders_open_delivery ON orders (delivery_date) WHERE status = 'open';

-- Board allocation --------------------------------------------------------
-- Until now "committed" was a live SUM over planned order lines — nobody could
-- HOLD board, so whichever job reached cutting first consumed the pile. A row
-- here is an explicit claim: N parent sheets of this board are earmarked for
-- this job, either from warehouse stock or from an incoming requisition.
-- board-allocation.js turns these rows into the planning engine's numbers; with
-- no rows it returns exactly what the old formula returned.
CREATE TABLE IF NOT EXISTS board_allocations (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  material_id     INTEGER NOT NULL REFERENCES materials(id),
  order_line_id   INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  qty             DOUBLE PRECISION NOT NULL CHECK (qty > 0),
  source          TEXT NOT NULL CHECK (source IN ('stock','requisition')),
  requisition_id  INTEGER REFERENCES requisitions(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','released','consumed')),
  reason          TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by     TEXT,
  released_at     TIMESTAMPTZ,
  release_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_alloc_material_active
  ON board_allocations (material_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_fk_board_allocations_order_line_id
  ON board_allocations (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_board_allocations_requisition_id
  ON board_allocations (requisition_id);

-- Multi-board consumption ---------------------------------------------------
-- A job is PLANNED against one board and that never changes. What changes is
-- what it actually eats: 4,000 sheets of 300 GSM is routinely finished as 2,500
-- of 300 plus 1,500 of 290, because that is what the warehouse holds. Until
-- now the only ways to record it were to edit the product master for a decision
-- lasting one job, or to let the ledger lie.
--
-- A row is "N parent sheets of THIS board against this job". covers restates
-- that in the PLANNED board's units so a balance can be struck against one
-- requirement. phase='plan' rows come from the Planning Engine; phase='issued'
-- rows are written at Cutting Start and are the truth. Both survive — the
-- deviation between them is the point.
--
-- A job with NO rows here behaves exactly as it did before this table existed.
CREATE TABLE IF NOT EXISTS job_board_mix (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_line_id   INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  material_id     INTEGER NOT NULL REFERENCES materials(id),
  stock_batch_id  INTEGER REFERENCES stock_batches(id) ON DELETE SET NULL,
  sheets          DOUBLE PRECISION NOT NULL CHECK (sheets > 0),
  ups             INTEGER NOT NULL CHECK (ups > 0),
  covers          DOUBLE PRECISION NOT NULL CHECK (covers > 0),
  role            TEXT NOT NULL CHECK (role IN ('planned','substitute')),
  phase           TEXT NOT NULL CHECK (phase IN ('plan','issued')),
  reason          TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_order_line_id
  ON job_board_mix (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_material_id
  ON job_board_mix (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_stock_batch_id
  ON job_board_mix (stock_batch_id);
CREATE INDEX IF NOT EXISTS idx_job_board_mix_line_phase
  ON job_board_mix (order_line_id, phase);

-- A source='stock' board_allocations row is otherwise indistinguishable from a
-- hand-placed hold made in the board hold/move panel (routes/board.js's POST
-- /board/move) — both carry material_id/order_line_id/qty/source='stock'/
-- status='active' and nothing else. helpers.js's releaseMixHolds/
-- consumeMixHolds, scoped only by order_line_id, would therefore also release
-- or consume a planner's own hand-placed hold. job_board_mix_id closes that
-- gap, symmetric with requisition_id above: NULL means "not mine, leave it
-- alone"; set means "mine, until job_board_mix deletes the row it points at,
-- at which point ON DELETE SET NULL returns this to NULL too" — harmless,
-- because a mix row is only ever deleted after its hold has already been
-- released or consumed (helpers.js's release-then-delete order).
-- Declared as an ALTER, not inline on board_allocations above: job_board_mix is
-- declared AFTER board_allocations in this file, so the FK target does not
-- exist yet at that point. This block is the first point where both do.
ALTER TABLE board_allocations ADD COLUMN IF NOT EXISTS job_board_mix_id INTEGER;
ALTER TABLE board_allocations DROP CONSTRAINT IF EXISTS board_allocations_job_board_mix_id_fkey;
ALTER TABLE board_allocations ADD CONSTRAINT board_allocations_job_board_mix_id_fkey
  FOREIGN KEY (job_board_mix_id) REFERENCES job_board_mix(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_fk_board_allocations_job_board_mix_id
  ON board_allocations (job_board_mix_id);

-- In-app notifications -----------------------------------------------------
-- One row = one message for one signed-in user, surfaced by the bell in the
-- app shell. Producers write through notify() in helpers.js; the bell polls
-- /notifications and lists unread first. read_at is the only mutable field.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- xs_request | xs_decision | mgt_request | mgt_decision
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,                     -- in-app route the row navigates to
  ref_table TEXT, ref_id INTEGER,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);

-- Management approval requests ---------------------------------------------
-- A planner flags a planned job for management sign-off — advisory, for the
-- selective job where something looks off (rate, quantity, board, date…).
-- NOTHING downstream is blocked by a pending or rejected request: it is a
-- question to management, not a gate on production.
CREATE TABLE IF NOT EXISTS approval_requests (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ar_number TEXT NOT NULL UNIQUE,             -- CI-MA-0001
  kind TEXT NOT NULL DEFAULT 'planning' CHECK (kind IN ('planning')),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  note TEXT NOT NULL,                         -- what should management look at
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by TEXT, requested_by_id INTEGER,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by TEXT, decided_at TIMESTAMPTZ, decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_fk_approval_requests_order_line_id ON approval_requests (order_line_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending ON approval_requests (status) WHERE status = 'pending';

-- Who may act on what. xs_approver: ONLY these users can approve or reject an
-- extra-sheet request (the plant head — Dharminder, on the Plant login). A
-- per-user flag, deliberately NOT a role: several plant logins carry
-- role=admin, and a role-admin bypass would hand the approval back to all of
-- them. is_management: receives "management approval" asks from Planning and
-- may decide them. Both flags are edited in Masters → Users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS xs_approver INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_management INTEGER NOT NULL DEFAULT 0;
-- reverse_approver: may send a job back when doing so MOVES STOCK or takes the
-- job off the floor entirely (see reverseNeedsApprover). Handing work back one
-- station is not gated — that is ordinary floor traffic. Same reasoning as
-- xs_approver: a flag, not a role, so a role=admin plant login does not inherit it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reverse_approver INTEGER NOT NULL DEFAULT 0;
-- Route the approve/reject decision back to the requester's bell. The display
-- name column stays (it prints on the request card); the id targets the
-- notification.
ALTER TABLE extra_sheet_requests ADD COLUMN IF NOT EXISTS requested_by_id INTEGER;

-- Seed once, never override a later choice made in Masters → Users: MD and the
-- Plant login (the plant head's seat) hold both grants — they approve extra
-- sheets and they decide Planning's management asks. Every other login starts
-- with neither, which is the point of the flags: several plant seats are
-- role=admin and must not inherit either decision.
UPDATE users SET xs_approver = 1
WHERE email IN ('md@motionci.com', 'plant@motionci.com')
  AND NOT EXISTS (SELECT 1 FROM users WHERE xs_approver = 1);
UPDATE users SET is_management = 1
WHERE email IN ('md@motionci.com', 'plant@motionci.com')
  AND NOT EXISTS (SELECT 1 FROM users WHERE is_management = 1);

-- A flag, not a role, matching xs_approver / reverse_approver: an admin plant
-- login must not silently inherit the warehouse's recount queue.
ALTER TABLE users ADD COLUMN IF NOT EXISTS warehouse_notify INTEGER NOT NULL DEFAULT 0;
UPDATE users SET warehouse_notify = 1
WHERE role = 'admin'
  AND NOT EXISTS (SELECT 1 FROM users WHERE warehouse_notify = 1);

-- CI Messenger ------------------------------------------------------------
-- In-app chat: DMs, group rooms, and one thread per job card, so plant talk
-- about a job lives NEXT TO the job. Attachments (photos, files, voice notes)
-- are BYTEA in Postgres — zero extra infrastructure, identical on the local
-- embedded PG and Supabase prod; the client compresses images before upload
-- so blobs stay small. Access rule enforced on every chat endpoint:
-- job threads are open to every signed-in user; dm/group need a member row.
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dm','group','job')),
  name TEXT,                          -- groups & job threads; a DM's label is the other user
  dm_key TEXT UNIQUE,                 -- 'dm:<lowId>:<highId>' — one DM per user pair
  job_card_id INTEGER UNIQUE REFERENCES job_cards(id) ON DELETE CASCADE,
  auto_add INTEGER NOT NULL DEFAULT 0, -- new users join automatically (Plant Floor)
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  last_read_message_id INTEGER,       -- read pointer: unread counts + "Seen"
  last_seen_at TIMESTAMPTZ,           -- last thread fetch: a watcher's bell stays quiet
  typing_at TIMESTAMPTZ,
  muted INTEGER NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE and not bare: deleting a user must neither erase a
  -- thread's history nor 500 the existing Delete User flow. sender_name is
  -- denormalized right beside it, so the words keep their author's name.
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','voice','file','system')),
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ              -- tombstone: senders may remove within 10 minutes
);
-- Heal databases created before sender_id became nullable SET NULL.
ALTER TABLE messages ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages (conversation_id, id);
CREATE TABLE IF NOT EXISTS message_attachments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  duration_secs DOUBLE PRECISION,     -- voice notes only
  data BYTEA NOT NULL                 -- never selected in list queries
);
CREATE INDEX IF NOT EXISTS idx_fk_message_attachments_message_id ON message_attachments (message_id);
CREATE TABLE IF NOT EXISTS message_job_tags (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, job_card_id)
);
CREATE INDEX IF NOT EXISTS idx_fk_message_job_tags_job_card_id ON message_job_tags (job_card_id);

-- Seed the two standing rooms once. Plant Floor takes every active user and
-- auto-adds future ones; Management mirrors the is_management grant. Member
-- INSERTs are idempotent, so a local restart heals membership drift without
-- ever re-creating a room the plant renamed or reorganised.
INSERT INTO conversations (kind, name, auto_add)
SELECT 'group', 'Plant Floor', 1
WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE kind='group' AND name='Plant Floor');
INSERT INTO conversation_members (conversation_id, user_id, role)
SELECT c.id, u.id, CASE WHEN u.role='admin' THEN 'admin' ELSE 'member' END
FROM conversations c, users u
WHERE c.kind='group' AND c.name='Plant Floor' AND u.active=1
ON CONFLICT DO NOTHING;
INSERT INTO conversations (kind, name, auto_add)
SELECT 'group', 'Management', 0
WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE kind='group' AND name='Management');
INSERT INTO conversation_members (conversation_id, user_id, role)
SELECT c.id, u.id, 'admin'
FROM conversations c, users u
WHERE c.kind='group' AND c.name='Management' AND u.active=1 AND u.is_management=1
ON CONFLICT DO NOTHING;

-- Threads on every record --------------------------------------------------
-- A conversation was addressable only as a job card, which is the sole reason
-- Job Cards had a Discuss button and no other module did. Addressing it as
-- (entity, entity_id) lets any record in the ERP carry a thread and inherit
-- everything the messenger already does — attachments, voice notes, read
-- pointers, tombstones, bell notifications — with no new plumbing.
--
-- job_card_id STAYS, but only so its FK cascade keeps deleting a job's thread
-- with the job. It must never be a second way to ADDRESS a thread: a job
-- thread created through the generic path without it set would be invisible to
-- the legacy lookup, which would then create a second thread for the same job.
-- The resolver always writes both, and record-threads.test.js asserts one
-- record can never hold two conversations.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entity TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entity_id INTEGER;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check
  CHECK (kind IN ('dm','group','job','record'));
-- The job threads that already exist move into the new addressing. 'job' is
-- kept as a legacy synonym of 'record' — same access rule, so a synonym can
-- never disagree with the word it stands for.
UPDATE conversations SET entity='job_card', entity_id=job_card_id
WHERE job_card_id IS NOT NULL AND entity IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_entity
  ON conversations (entity, entity_id) WHERE entity IS NOT NULL;

-- @mentions. Users and teams share one namespace so the composer's picker and
-- the fan-out do not need two code paths.
--
-- user_id is SET NULL with handle/label denormalized beside it — the same
-- choice messages.sender_id makes, and for the same reason: an employee
-- leaving must not erase every mention that ever named them.
CREATE TABLE IF NOT EXISTS mention_targets (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user','team')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handle TEXT NOT NULL UNIQUE,        -- 'anik', 'planning'
  label TEXT NOT NULL,                -- 'Anik Dua (MD)', 'Planning Team'
  member_ids JSONB,                   -- teams: the truth, editable; NOT derived at read time
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS message_mentions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target_id INTEGER REFERENCES mention_targets(id) ON DELETE SET NULL,
  handle TEXT NOT NULL,               -- survives the target being deleted
  user_id INTEGER,                    -- expanded recipient; a team fans out to many rows
  PRIMARY KEY (message_id, handle, user_id)
);
-- The unread-mention check filters by VIEWER, so user_id must lead the index.
CREATE INDEX IF NOT EXISTS idx_message_mentions_user ON message_mentions (user_id, message_id);

-- "Delivered" needs a signal that is not "opened this thread" — that is the
-- same act as reading, so the two ticks would collapse into one. Written at
-- most once every two minutes (see requireAuth): a write per request would be
-- a continuous UPDATE stream on a table every request already reads.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

-- Teams seeded from the grants that ACTUALLY exist. There is no 'procurement'
-- or 'accounts' role, so those teams are not invented here — an admin creates
-- them with explicit membership if the plant wants them.
INSERT INTO mention_targets (kind, handle, label, member_ids)
SELECT 'team', t.handle, t.label,
       (SELECT COALESCE(json_agg(u.id), '[]'::json) FROM users u
        WHERE u.active=1 AND (
          (t.handle='planning'   AND u.role='planner') OR
          (t.handle='production' AND u.role='production') OR
          (t.handle='quality'    AND u.role='qc') OR
          (t.handle='dispatch'   AND u.role='dispatch') OR
          (t.handle='management' AND u.is_management=1)))::jsonb
FROM (VALUES ('planning','Planning Team'), ('production','Production Team'),
             ('quality','Quality Team'), ('dispatch','Dispatch Team'),
             ('management','Management')) AS t(handle, label)
WHERE NOT EXISTS (SELECT 1 FROM mention_targets m WHERE m.handle = t.handle);
-- One mention target per active user, handle derived from the email local part.
INSERT INTO mention_targets (kind, user_id, handle, label)
SELECT 'user', u.id, split_part(u.email, '@', 1), u.name
FROM users u
WHERE u.active=1
  AND NOT EXISTS (SELECT 1 FROM mention_targets m WHERE m.handle = split_part(u.email, '@', 1));

-- Comms shell ---------------------------------------------------------------
-- Archiving is PERSONAL filing, so it lives on the membership row, not the
-- conversation: one person tidying their inbox must never take a live
-- discussion off everyone else's board.
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_members_archived
  ON conversation_members (user_id) WHERE archived_at IS NOT NULL;

-- ─── block 21 ──────────────────────────────────────────────────

ALTER TABLE machines ADD COLUMN IF NOT EXISTS is_default INTEGER NOT NULL DEFAULT 0;

-- Board cutting is the normal path for cartons, so it is the plant's cutting
-- default. Guarded on "no default yet in this category" so it seeds once and
-- never overrides a later choice made in Masters → Machines.
UPDATE machines SET is_default = 1
WHERE type = 'cutting' AND name = 'Board Cutting Machine'
  AND NOT EXISTS (SELECT 1 FROM machines WHERE type = 'cutting' AND is_default = 1);

-- ─── block 22 ──────────────────────────────────────────────────

UPDATE products p SET board_name = m.name
  FROM materials m
 WHERE m.id = p.board_material_id
   AND btrim(COALESCE(p.board_name,'')) <> ''
   AND m.name ~ ' · [0-9]{2,4} GSM · '
   AND lower(split_part(btrim(p.board_name), ' ', 1))
       IS DISTINCT FROM lower(split_part(btrim(m.name), ' ', 1));
