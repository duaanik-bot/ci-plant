-- Dedicated purchasing and warehouse ledgers for Plates, Dies and Blocks.
-- Job Card tooling requirements act as the requisition; the purchasing chain
-- remains separate from raw-material Procurement so the three warehouses never
-- leak quantities into board stock.

CREATE TABLE IF NOT EXISTS tooling_inventory_items (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('plate','die','block')),
  master_key TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  specification TEXT,
  size TEXT,
  tool_type TEXT,
  unit TEXT NOT NULL DEFAULT 'nos',
  hsn_code TEXT,
  gst_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  std_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  min_stock DOUBLE PRECISION NOT NULL DEFAULT 0,
  preferred_vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tooling_inventory_family ON tooling_inventory_items(family, active, name);
CREATE INDEX IF NOT EXISTS idx_tooling_inventory_product ON tooling_inventory_items(product_id);
CREATE INDEX IF NOT EXISTS idx_tooling_inventory_vendor ON tooling_inventory_items(preferred_vendor_id);

ALTER TABLE tooling_requests ADD COLUMN IF NOT EXISTS inventory_item_id INTEGER REFERENCES tooling_inventory_items(id) ON DELETE SET NULL;
ALTER TABLE tooling_requests ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE tooling_requests ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE tooling_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE tooling_requests ADD COLUMN IF NOT EXISTS rejected_by TEXT;
ALTER TABLE tooling_requests ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE tooling_requests ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE tooling_requests DROP CONSTRAINT IF EXISTS tooling_requests_approval_status_check;
ALTER TABLE tooling_requests ADD CONSTRAINT tooling_requests_approval_status_check
  CHECK (approval_status IN ('pending','approved','converted','rejected','closed'));
CREATE INDEX IF NOT EXISTS idx_tooling_requests_inventory_item ON tooling_requests(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_tooling_requests_approval ON tooling_requests(family, approval_status);

-- Existing local Tooling queues pre-date the item master. Give each physical
-- product requirement the same stable identity used by new Job Card forwards,
-- then link it without changing its operational status.
WITH shaped AS (
  SELECT tr.id, tr.family, tr.product_id, tr.specification, p.name AS product_name,
    CASE tr.family
      WHEN 'plate' THEN lower(concat_ws('|','plate',tr.product_id,COALESCE(NULLIF(tr.specification->>'output_number',''),'standard')))
      WHEN 'die' THEN lower(concat_ws('|','die',tr.product_id,COALESCE(NULLIF(tr.specification->>'die_number',''),'standard')))
      ELSE lower(concat_ws('|','block',tr.product_id,
        COALESCE(NULLIF(tr.specification->>'block_number',''),NULLIF(tr.specification->>'special',''),'standard')))
    END AS master_key,
    row_number() OVER (PARTITION BY tr.family ORDER BY tr.id) AS family_seq
  FROM tooling_requests tr JOIN products p ON p.id=tr.product_id
  WHERE tr.family IN ('plate','die','block') AND tr.inventory_item_id IS NULL
), unique_items AS (
  SELECT DISTINCT ON (master_key) * FROM shaped ORDER BY master_key, id
)
INSERT INTO tooling_inventory_items
  (family,master_key,code,name,product_id,specification,size,tool_type,unit)
SELECT family, master_key,
  'CI-' || CASE family WHEN 'plate' THEN 'PL' WHEN 'die' THEN 'DI' ELSE 'BL' END || '-M-L' || lpad(id::text,5,'0'),
  CASE family WHEN 'plate' THEN product_name || ' printing plates'
              WHEN 'die' THEN product_name || ' die' ELSE product_name || ' block' END,
  product_id,
  CASE family WHEN 'plate' THEN concat_ws(' · ',
      CASE WHEN specification->>'colors' IS NOT NULL THEN (specification->>'colors') || ' colours' END,
      CASE WHEN specification->>'output_number' IS NOT NULL THEN 'Output ' || (specification->>'output_number') END)
    WHEN 'die' THEN concat_ws(' · ', specification->>'die_number',
      CASE WHEN specification->>'ups' IS NOT NULL THEN (specification->>'ups') || ' ups' END)
    ELSE concat_ws(' · ', specification->>'block_number', specification->>'special', specification->>'leafing_colour') END,
  COALESCE(NULLIF(specification->>'size',''),
    CASE WHEN specification->>'child_l' IS NOT NULL AND specification->>'child_w' IS NOT NULL
      THEN (specification->>'child_l') || ' x ' || (specification->>'child_w') END),
  CASE family WHEN 'plate' THEN 'Offset plate' WHEN 'die' THEN 'Cutting die' ELSE 'Emboss / foil block' END,
  'nos'
FROM unique_items
ON CONFLICT (master_key) DO NOTHING;

UPDATE tooling_requests tr SET inventory_item_id=ti.id
FROM tooling_inventory_items ti
WHERE tr.inventory_item_id IS NULL AND tr.family IN ('plate','die','block')
  AND ti.master_key = CASE tr.family
    WHEN 'plate' THEN lower(concat_ws('|','plate',tr.product_id,COALESCE(NULLIF(tr.specification->>'output_number',''),'standard')))
    WHEN 'die' THEN lower(concat_ws('|','die',tr.product_id,COALESCE(NULLIF(tr.specification->>'die_number',''),'standard')))
    ELSE lower(concat_ws('|','block',tr.product_id,
      COALESCE(NULLIF(tr.specification->>'block_number',''),NULLIF(tr.specification->>'special',''),'standard')))
  END;

-- Legacy local fixture requests used one unit for every family. A Plate
-- requirement is one physical plate per printing colour.
UPDATE tooling_requests
SET qty = GREATEST(COALESCE(NULLIF(specification->>'colors','')::integer, 1), 1)
WHERE family='plate' AND qty=1 AND COALESCE(NULLIF(specification->>'colors','')::integer, 1) > 1;

CREATE TABLE IF NOT EXISTS tooling_purchase_orders (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_number TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL CHECK (family IN ('plate','die','block')),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_received','received','closed')),
  expected_date TEXT,
  vendor_notes TEXT,
  payment_terms TEXT,
  delivery_terms TEXT,
  reference TEXT,
  tax_kind TEXT NOT NULL DEFAULT 'intra' CHECK (tax_kind IN ('intra','inter')),
  freight DOUBLE PRECISION NOT NULL DEFAULT 0,
  round_off DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_by TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tooling_po_family_status ON tooling_purchase_orders(family, status);
CREATE INDEX IF NOT EXISTS idx_tooling_po_vendor ON tooling_purchase_orders(vendor_id);

CREATE TABLE IF NOT EXISTS tooling_po_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES tooling_purchase_orders(id) ON DELETE CASCADE,
  tooling_request_id INTEGER REFERENCES tooling_requests(id) ON DELETE SET NULL,
  inventory_item_id INTEGER NOT NULL REFERENCES tooling_inventory_items(id),
  qty DOUBLE PRECISION NOT NULL CHECK (qty > 0),
  received_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  hsn_code TEXT,
  unit TEXT NOT NULL DEFAULT 'nos',
  discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  gst_rate DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tooling_po_lines_po ON tooling_po_lines(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_tooling_po_lines_request ON tooling_po_lines(tooling_request_id);
CREATE INDEX IF NOT EXISTS idx_tooling_po_lines_item ON tooling_po_lines(inventory_item_id);

CREATE TABLE IF NOT EXISTS tooling_grns (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grn_number TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL CHECK (family IN ('plate','die','block')),
  purchase_order_id INTEGER REFERENCES tooling_purchase_orders(id) ON DELETE SET NULL,
  po_line_id INTEGER REFERENCES tooling_po_lines(id) ON DELETE SET NULL,
  tooling_request_id INTEGER REFERENCES tooling_requests(id) ON DELETE SET NULL,
  inventory_item_id INTEGER NOT NULL REFERENCES tooling_inventory_items(id),
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  qty DOUBLE PRECISION NOT NULL CHECK (qty > 0),
  accepted_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  rejected_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  batch_no TEXT,
  status TEXT NOT NULL DEFAULT 'quarantine' CHECK (status IN ('quarantine','accepted','rejected')),
  vehicle_no TEXT,
  supplier_invoice_no TEXT,
  supplier_invoice_date TEXT,
  received_by TEXT,
  remarks TEXT,
  qc_by TEXT,
  qc_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tooling_grns_family_status ON tooling_grns(family, status);
CREATE INDEX IF NOT EXISTS idx_tooling_grns_po ON tooling_grns(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_tooling_grns_po_line ON tooling_grns(po_line_id);
CREATE INDEX IF NOT EXISTS idx_tooling_grns_request ON tooling_grns(tooling_request_id);
CREATE INDEX IF NOT EXISTS idx_tooling_grns_item ON tooling_grns(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_tooling_grns_vendor ON tooling_grns(vendor_id);

CREATE TABLE IF NOT EXISTS tooling_stock_batches (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inventory_item_id INTEGER NOT NULL REFERENCES tooling_inventory_items(id),
  grn_id INTEGER REFERENCES tooling_grns(id) ON DELETE SET NULL,
  batch_no TEXT,
  qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','depleted','blocked')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tooling_batches_item_status ON tooling_stock_batches(inventory_item_id, status);
CREATE INDEX IF NOT EXISTS idx_tooling_batches_grn ON tooling_stock_batches(grn_id);

-- The original Tooling Hub already contains the plant's physical rack masters.
-- Carry those records into each dedicated warehouse instead of making the
-- buyer recreate hundreds of dies, plates and blocks by hand. Product-linked
-- tools use the same stable key as new Job Card requirements; unlinked legacy
-- dies retain a one-to-one key based on their existing tool row.
WITH legacy_tools AS (
  SELECT t.*,
    p.name AS product_name,
    p.output_number, p.die_number, p.block_number, p.special,
    CASE
      WHEN t.product_id IS NULL THEN lower('legacy-tool|' || t.id)
      WHEN t.family='plate' THEN lower(concat_ws('|','plate',t.product_id,
        COALESCE(NULLIF(t.output_no,''),NULLIF(p.output_number,''),'standard')))
      WHEN t.family='die' THEN lower(concat_ws('|','die',t.product_id,
        COALESCE(NULLIF(p.die_number,''),'standard')))
      ELSE lower(concat_ws('|','block',t.product_id,
        COALESCE(NULLIF(p.block_number,''),NULLIF(p.special,''),'standard')))
    END AS inventory_key
  FROM tools t
  LEFT JOIN products p ON p.id=t.product_id
  WHERE t.family IN ('plate','die','block')
)
INSERT INTO tooling_inventory_items
  (family,master_key,code,name,product_id,specification,size,tool_type,unit,active)
SELECT family, inventory_key, code,
  CASE
    WHEN family='plate' AND product_name IS NOT NULL THEN product_name || ' printing plates'
    WHEN family='die' AND die_number IS NOT NULL THEN 'Die ' || die_number
    WHEN family='die' AND title='Cutting Die' THEN title || ' ' || code
    WHEN family='block' AND block_number IS NOT NULL THEN 'Block ' || block_number
    ELSE title
  END,
  product_id,
  concat_ws(' · ',
    CASE WHEN ups IS NOT NULL THEN ups || ' ups' END,
    CASE WHEN colors IS NOT NULL THEN colors || ' colours' END,
    NULLIF(emboss_type,''), NULLIF(shade_ref,''),
    CASE WHEN output_no IS NOT NULL THEN 'Output ' || output_no END),
  COALESCE(NULLIF(sheet_size,''),NULLIF(carton_size,'')),
  CASE family WHEN 'plate' THEN 'Offset plate'
              WHEN 'die' THEN 'Cutting die'
              ELSE COALESCE(NULLIF(emboss_type,''),'Emboss / foil block') END,
  'nos', active
FROM legacy_tools
ON CONFLICT DO NOTHING;

WITH legacy_tools AS (
  SELECT t.*,
    p.output_number, p.die_number, p.block_number, p.special,
    CASE
      WHEN t.product_id IS NULL THEN lower('legacy-tool|' || t.id)
      WHEN t.family='plate' THEN lower(concat_ws('|','plate',t.product_id,
        COALESCE(NULLIF(t.output_no,''),NULLIF(p.output_number,''),'standard')))
      WHEN t.family='die' THEN lower(concat_ws('|','die',t.product_id,
        COALESCE(NULLIF(p.die_number,''),'standard')))
      ELSE lower(concat_ws('|','block',t.product_id,
        COALESCE(NULLIF(p.block_number,''),NULLIF(p.special,''),'standard')))
    END AS inventory_key
  FROM tools t
  LEFT JOIN products p ON p.id=t.product_id
  WHERE t.family IN ('plate','die','block')
)
INSERT INTO tooling_stock_batches (inventory_item_id,batch_no,qty,status,received_at)
SELECT ti.id, 'LEGACY-TOOL-' || lt.id, 1, 'available', COALESCE(lt.zone_since,now())
FROM legacy_tools lt
JOIN tooling_inventory_items ti ON ti.master_key=lt.inventory_key
WHERE lt.active=1 AND lt.zone='in_rack' AND lt.condition IN ('Good','Fair')
  AND NOT EXISTS (
    SELECT 1 FROM tooling_stock_batches b
    WHERE b.inventory_item_id=ti.id AND b.batch_no='LEGACY-TOOL-' || lt.id
  );

CREATE TABLE IF NOT EXISTS tooling_stock_allocations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tooling_request_id INTEGER NOT NULL REFERENCES tooling_requests(id) ON DELETE CASCADE,
  stock_batch_id INTEGER NOT NULL REFERENCES tooling_stock_batches(id) ON DELETE CASCADE,
  qty DOUBLE PRECISION NOT NULL CHECK (qty > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','consumed')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tooling_allocations_request ON tooling_stock_allocations(tooling_request_id, status);
CREATE INDEX IF NOT EXISTS idx_tooling_allocations_batch ON tooling_stock_allocations(stock_batch_id, status);

CREATE TABLE IF NOT EXISTS tooling_stock_movements (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inventory_item_id INTEGER NOT NULL REFERENCES tooling_inventory_items(id),
  stock_batch_id INTEGER REFERENCES tooling_stock_batches(id) ON DELETE SET NULL,
  tooling_request_id INTEGER REFERENCES tooling_requests(id) ON DELETE SET NULL,
  grn_id INTEGER REFERENCES tooling_grns(id) ON DELETE SET NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('receipt','reserve','release','issue','return','adjustment','rejection')),
  qty DOUBLE PRECISION NOT NULL,
  reference TEXT,
  note TEXT,
  user_name TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tooling_movements_item ON tooling_stock_movements(inventory_item_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_tooling_movements_batch ON tooling_stock_movements(stock_batch_id);
CREATE INDEX IF NOT EXISTS idx_tooling_movements_request ON tooling_stock_movements(tooling_request_id);
CREATE INDEX IF NOT EXISTS idx_tooling_movements_grn ON tooling_stock_movements(grn_id);

INSERT INTO tooling_stock_movements
  (inventory_item_id,stock_batch_id,movement_type,qty,reference,note,user_name,at)
SELECT b.inventory_item_id, b.id, 'adjustment', b.qty, 'Legacy rack opening',
  'Imported from the original Tooling Hub rack', 'System', b.received_at
FROM tooling_stock_batches b
WHERE b.batch_no LIKE 'LEGACY-TOOL-%'
  AND NOT EXISTS (
    SELECT 1 FROM tooling_stock_movements m
    WHERE m.stock_batch_id=b.id AND m.movement_type='adjustment'
      AND m.reference='Legacy rack opening'
  );

ALTER TABLE tooling_inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tooling_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE tooling_po_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE tooling_grns ENABLE ROW LEVEL SECURITY;
ALTER TABLE tooling_stock_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE tooling_stock_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tooling_stock_movements ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON TABLE tooling_inventory_items, tooling_purchase_orders, tooling_po_lines,
      tooling_grns, tooling_stock_batches, tooling_stock_allocations, tooling_stock_movements FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON TABLE tooling_inventory_items, tooling_purchase_orders, tooling_po_lines,
      tooling_grns, tooling_stock_batches, tooling_stock_allocations, tooling_stock_movements FROM authenticated;
  END IF;
END
$$;

-- Fresh projects install the shared function later; existing local databases
-- receive triggers immediately when the function is already present.
DO $$
DECLARE
  target_table TEXT;
BEGIN
  IF pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') IS NOT NULL THEN
    FOREACH target_table IN ARRAY ARRAY[
      'tooling_inventory_items','tooling_purchase_orders','tooling_po_lines',
      'tooling_grns','tooling_stock_batches','tooling_stock_allocations','tooling_stock_movements'
    ] LOOP
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS ci_erp_realtime_ping ON public.%I', target_table);
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER ci_erp_realtime_ping AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.ci_erp_realtime_ping()',
        target_table
      );
    END LOOP;
  END IF;
END
$$;
