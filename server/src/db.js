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
    // already running from a previous dev session — that's fine
    if (!/already|lock|in use|another server/i.test(String(e.message))) throw e;
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
  reorder_level DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS machines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cutting','printing','coating','lamination','foiling','embossing','die_cutting','sorting','pasting')),
  capacity_per_hour DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','idle','maintenance'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  board_material_id INTEGER NOT NULL REFERENCES materials(id),
  gsm INTEGER, size TEXT,
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
  CHECK (type IN ('grn','qc_release','qc_reject','consumption','adjustment','fg_receipt','dispatch','wastage'));
`);
}
