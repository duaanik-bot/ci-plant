-- Material readiness integration layer
ALTER TABLE purchase_requisitions
  ADD COLUMN IF NOT EXISTS board_type VARCHAR(120),
  ADD COLUMN IF NOT EXISTS size_label VARCHAR(80),
  ADD COLUMN IF NOT EXISTS gsm INTEGER,
  ADD COLUMN IF NOT EXISTS shortage_id TEXT,
  ADD COLUMN IF NOT EXISTS source_job_card_id TEXT,
  ADD COLUMN IF NOT EXISTS source_planning_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_requisitions_shortage_id_key
  ON purchase_requisitions(shortage_id)
  WHERE shortage_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS material_reservations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  material_id TEXT NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  job_card_id TEXT NOT NULL REFERENCES production_job_cards(id) ON DELETE CASCADE,
  planning_id TEXT,
  required_sheets NUMERIC(12,3) NOT NULL,
  reserved_sheets NUMERIC(12,3) NOT NULL DEFAULT 0,
  shortage_sheets NUMERIC(12,3) NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(material_id, job_card_id)
);

CREATE INDEX IF NOT EXISTS material_reservations_job_card_id_idx ON material_reservations(job_card_id);

CREATE TABLE IF NOT EXISTS material_shortages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  material_id TEXT NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  job_card_id TEXT NOT NULL REFERENCES production_job_cards(id) ON DELETE CASCADE,
  planning_id TEXT,
  shortage_qty NUMERIC(12,3) NOT NULL,
  allocated_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
  remaining_qty NUMERIC(12,3) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  purchase_req_id TEXT,
  required_by_date DATE,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS material_shortages_material_status_idx ON material_shortages(material_id, status);
CREATE INDEX IF NOT EXISTS material_shortages_job_status_idx ON material_shortages(job_card_id, status);

CREATE TABLE IF NOT EXISTS grn_shortage_allocations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  grn_id TEXT NOT NULL,
  shortage_id TEXT NOT NULL,
  material_id TEXT NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  allocated_qty NUMERIC(12,3) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(grn_id, shortage_id)
);

CREATE INDEX IF NOT EXISTS grn_shortage_allocations_shortage_id_idx ON grn_shortage_allocations(shortage_id);
