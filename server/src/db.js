// ─── Colour Impressions ERP — Database (PostgreSQL) ─────────────────────────
// Local mode : no DATABASE_URL → an embedded Postgres starts automatically,
//              data persists in server/.pgdata. Zero setup.
// Live mode  : set DATABASE_URL (e.g. Supabase) → connects there instead.
// One stock ledger (stock_movements) is the source of truth for every
// quantity change. Multi-write operations run inside tx().
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// numeric / bigint arrive as JS numbers, not strings
pg.types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));

let pool;

async function startEmbedded() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dataDir = path.join(__dirname, '..', '.pgdata');
  const epg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: 5439,
    persistent: true,
    onError: () => {},
  });
  const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  if (fresh) await epg.initialise();
  try {
    await epg.start();
  } catch (e) {
    // already running from a previous dev session — that's fine.
    // embedded-postgres sometimes rejects with undefined when the lock file
    // exists; the connection test right after will catch a real failure.
    const msg = String(e?.message ?? e ?? 'lock');
    if (!/already|lock|in use|another server/i.test(msg)) throw e;
  }
  if (fresh) await epg.createDatabase('cierp');
  // stop embedded DB with the dev server
  const stop = async () => { try { await epg.stop(); } catch {} process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return 'postgresql://postgres:postgres@localhost:5439/cierp';
}

export async function connect() {
  if (pool) return pool;
  let url = process.env.DATABASE_URL;
  if (!url) {
    console.log('No DATABASE_URL — starting embedded local Postgres…');
    url = await startEmbedded();
  }
  pool = new pg.Pool({
    connectionString: url,
    max: 5,
    ssl: /supabase|amazonaws|render|neon/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  await pool.query('SELECT 1');
  return pool;
}

// query → rows
export async function q(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}
export async function one(text, params = []) {
  return (await q(text, params))[0] ?? null;
}

// Serialised transaction helper: fn receives (query, one) bound to the tx client.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const qc = async (text, params = []) => (await client.query(text, params)).rows;
    const oc = async (text, params = []) => ((await client.query(text, params)).rows[0] ?? null);
    const result = await fn(qc, oc);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function init() {
  await connect();
  await pool.query(`
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
  type TEXT NOT NULL CHECK (type IN ('cutting','printing','coating','lamination','foiling','embossing','die_cutting','sorting','pasting')),
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
  gsm INTEGER, size TEXT,
  child_l DOUBLE PRECISION, child_w DOUBLE PRECISION, -- print (child) sheet size in inches
  ups INTEGER NOT NULL DEFAULT 1,
  wastage_pct DOUBLE PRECISION NOT NULL DEFAULT 5,
  colors INTEGER NOT NULL DEFAULT 4,
  coating TEXT NOT NULL DEFAULT 'none' CHECK (coating IN ('none','aqueous','uv','matt_lam','gloss_lam')),
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
`);

  // Migrations for databases created before the CI-Production section port:
  // new sections (cutting / lamination / sorting), hold status, per-stage
  // machine + scrap reason + packing manifest, and wastage in the ledger.
  await pool.query(`
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS queue_pos INTEGER;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS children_per_parent INTEGER;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS sheet_l DOUBLE PRECISION;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS sheet_w DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS child_l DOUBLE PRECISION;
ALTER TABLE products ADD COLUMN IF NOT EXISTS child_w DOUBLE PRECISION;
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
ALTER TABLE job_stages DROP CONSTRAINT IF EXISTS job_stages_stage_check;
ALTER TABLE job_stages ADD CONSTRAINT job_stages_stage_check
  CHECK (stage IN ('cutting','printing','coating','lamination','foiling','embossing','die_cutting','sorting','pasting','qc'));
ALTER TABLE job_stages DROP CONSTRAINT IF EXISTS job_stages_status_check;
ALTER TABLE job_stages ADD CONSTRAINT job_stages_status_check
  CHECK (status IN ('pending','in_progress','hold','completed'));
ALTER TABLE machines DROP CONSTRAINT IF EXISTS machines_type_check;
ALTER TABLE machines ADD CONSTRAINT machines_type_check
  CHECK (type IN ('cutting','printing','coating','lamination','foiling','embossing','die_cutting','sorting','pasting'));
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_section_check;
ALTER TABLE employees ADD CONSTRAINT employees_section_check
  CHECK (section IN ('cutting','printing','coating','lamination','foiling','embossing','die_cutting','sorting','pasting','qc'));
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_type_check
  CHECK (type IN ('grn','qc_release','qc_reject','consumption','adjustment','fg_receipt','dispatch','wastage','leftover_in'));
-- Customer-wise dispatch tolerance: master % + per-line snapshot taken at SO
-- creation so later master edits never silently change old orders.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tolerance_pct DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS tolerance_pct DOUBLE PRECISION;
-- Verified FG consumed against the line — production plans the balance.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS fg_consumed_qty INTEGER NOT NULL DEFAULT 0;
-- Planning wastage captured in absolute child sheets (plant default 150);
-- the product-master percentage stays only as the pre-plan fallback.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS wastage_sheets INTEGER;
-- Machines can be retired without breaking history.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1;
-- Vendor promise date on the PO — drives pendency ageing.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_date TEXT;
-- Reason recorded when a requisition is closed/cancelled.
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS status_reason TEXT;
-- Which PO a requisition was converted into (several PRs can share one PO).
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS purchase_order_id INTEGER REFERENCES purchase_orders(id);
-- Gang printing: the gang run this line belongs to (NULL = prints alone).
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS gang_run_id INTEGER REFERENCES gang_runs(id);
-- Press designation shown on the Print Planning board (e.g. Komori Lithrone 5-Colour).
ALTER TABLE machines ADD COLUMN IF NOT EXISTS model TEXT;
-- Per-user module access: JSON array of module keys, NULL = all modules the
-- user's role allows (the pre-existing behaviour). Admins always see everything.
ALTER TABLE users ADD COLUMN IF NOT EXISTS modules JSONB;
-- Leftover offcut stock: a leftover is a board material carved from a parent
-- board. One master per (source board, strip size); code LO-<srcId>-<L>X<W>.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS code TEXT;
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
`);

  // Default GST rates per product type — seeded once, then owned by Masters.
  await pool.query(`
INSERT INTO gst_rates (product_type, label, rate) VALUES
  ('carton', 'Carton', 5),
  ('label', 'Labels', 18),
  ('leaflet', 'Leaflets', 18),
  ('shipper_label', 'Shipper Labels', 18)
ON CONFLICT (product_type) DO NOTHING;
`);

  // One-time copy of the legacy dies rack into the Tooling Hub. Idempotent:
  // the INSERT only fires while tools has no die rows; the remap only touches
  // products that still point nowhere. Real die numbers are kept verbatim.
  // zone_since deliberately resets to migration time — legacy dies carry no
  // dwell history, so "time in zone" starts counting from this migration.
  await pool.query(`
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
`);
  await pool.query(`
UPDATE products p SET tool_id = t.id
FROM dies d JOIN tools t ON t.family = 'die' AND t.code = d.die_number
WHERE p.die_id = d.id AND p.tool_id IS NULL;
`);

  // One-time classification of legacy products so GST follows the type master.
  // Only touches rows never classified — deliberate overrides set later survive.
  await pool.query(`
UPDATE products SET
  product_type = CASE
    WHEN UPPER(name) LIKE '%SHIPPER%'                                  THEN 'shipper_label'
    WHEN UPPER(name) LIKE '%LEAFLET%' OR UPPER(name) LIKE '%INSERT%'   THEN 'leaflet'
    WHEN UPPER(name) LIKE '%LABEL%'   OR UPPER(name) LIKE '%STICKER%'  THEN 'label'
    ELSE 'carton' END,
  gst_pct = NULL
WHERE product_type IS NULL;
`);
}
