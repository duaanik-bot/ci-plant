// ─── Colour Impressions ERP — Database ───────────────────────────────────────
// Single SQLite file. One stock ledger (stock_movements) is the source of
// truth for every material quantity change. All multi-write operations are
// wrapped in transactions at the route level.
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CI_DB_PATH || path.join(__dirname, '..', 'ci-erp.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT, state TEXT, gstin TEXT, contact TEXT, phone TEXT,
  segment TEXT NOT NULL DEFAULT 'pharma' CHECK (segment IN ('pharma','fmcg')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT, contact TEXT, phone TEXT, categories TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('board','ink','foil','adhesive','laminate','other')),
  spec TEXT, unit TEXT NOT NULL DEFAULT 'sheets',
  reorder_level REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('printing','coating','foiling','embossing','die_cutting','pasting')),
  capacity_per_hour REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','idle','maintenance'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  board_material_id INTEGER NOT NULL REFERENCES materials(id),
  gsm INTEGER, size TEXT,
  ups INTEGER NOT NULL DEFAULT 1,          -- cartons per sheet
  wastage_pct REAL NOT NULL DEFAULT 5,
  colors INTEGER NOT NULL DEFAULT 4,
  coating TEXT NOT NULL DEFAULT 'none' CHECK (coating IN ('none','aqueous','uv','matt_lam','gloss_lam')),
  special TEXT NOT NULL DEFAULT 'none' CHECK (special IN ('none','foil','emboss','foil_emboss','window')),
  rate REAL NOT NULL DEFAULT 0,            -- per carton
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  po_date TEXT NOT NULL,
  delivery_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Order line lifecycle (single state machine, enforced in helpers.js):
-- pending → planned → ready → in_production → produced → dispatched
--         ↘ cancelled (from pending/planned)
CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  rate REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','planned','ready','in_production','produced','dispatched','cancelled')),
  machine_id INTEGER REFERENCES machines(id),
  planned_date TEXT,
  sheets_required INTEGER,
  artwork_customer_ok INTEGER NOT NULL DEFAULT 0,
  artwork_qa_ok INTEGER NOT NULL DEFAULT 0,
  artwork_locked INTEGER NOT NULL DEFAULT 0,   -- the ONE artwork truth
  tooling_ok INTEGER NOT NULL DEFAULT 0,
  dispatched_qty INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS job_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jc_number TEXT NOT NULL UNIQUE,
  order_line_id INTEGER NOT NULL UNIQUE REFERENCES order_lines(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  machine_id INTEGER REFERENCES machines(id),
  qty_planned INTEGER NOT NULL,
  sheets_issued INTEGER NOT NULL,
  qty_produced INTEGER NOT NULL DEFAULT 0,
  qty_scrap INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  closed_at TEXT
);

-- Strictly sequential stages. Only ONE stage may be in_progress per job card.
CREATE TABLE IF NOT EXISTS job_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  seq INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('printing','coating','foiling','embossing','die_cutting','pasting','qc')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
  unit TEXT NOT NULL DEFAULT 'sheets' CHECK (unit IN ('sheets','cartons')),
  qty_in INTEGER, qty_out INTEGER, qty_scrap INTEGER NOT NULL DEFAULT 0,
  operator TEXT,
  started_at TEXT, completed_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  batch_no TEXT NOT NULL,
  qty REAL NOT NULL,
  initial_qty REAL NOT NULL,
  unit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'quarantine' CHECK (status IN ('quarantine','available','rejected','exhausted')),
  grn_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- THE stock ledger. Every quantity change writes a row here, in the same
-- transaction as the change itself.
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER REFERENCES materials(id),
  batch_id INTEGER REFERENCES stock_batches(id),
  product_id INTEGER REFERENCES products(id),
  type TEXT NOT NULL CHECK (type IN ('grn','qc_release','qc_reject','consumption','adjustment','fg_receipt','dispatch')),
  qty REAL NOT NULL,                        -- positive = in, negative = out
  ref_type TEXT, ref_id INTEGER, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS fg_stock (
  product_id INTEGER PRIMARY KEY REFERENCES products(id),
  qty INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requisitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number TEXT NOT NULL UNIQUE,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  qty REAL NOT NULL,
  needed_by TEXT, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','converted','closed','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number TEXT NOT NULL UNIQUE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  requisition_id INTEGER REFERENCES requisitions(id),  -- real FK (old system had none)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_received','received','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  material_id INTEGER NOT NULL REFERENCES materials(id),
  qty REAL NOT NULL, rate REAL NOT NULL DEFAULT 0,
  received_qty REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS grns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_number TEXT NOT NULL UNIQUE,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  po_line_id INTEGER NOT NULL REFERENCES po_lines(id),
  material_id INTEGER NOT NULL REFERENCES materials(id),
  qty REAL NOT NULL, batch_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'quarantine' CHECK (status IN ('quarantine','accepted','rejected')),
  received_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  qc_at TEXT, qc_note TEXT
);

CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challan_number TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  vehicle TEXT, driver TEXT, notes TEXT,
  dispatched_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS dispatch_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id),
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL, entity_id INTEGER,
  action TEXT NOT NULL, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_lines_status ON order_lines(status);
CREATE INDEX IF NOT EXISTS idx_stages_jc ON job_stages(job_card_id);
CREATE INDEX IF NOT EXISTS idx_moves_material ON stock_movements(material_id);
CREATE INDEX IF NOT EXISTS idx_batches_material ON stock_batches(material_id, status);
`);

export default db;
