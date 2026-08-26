-- Line-level "no more receipts": a buyer can close individual PO lines short
-- instead of closing the whole order. The unreceived balance is waived, the
-- line leaves Pendency and every on-order figure, and GRNs against it are
-- refused until it is reopened. Applies to the board register (po_lines) and
-- all three tooling families (tooling_po_lines: plate / die / block).

ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS closed_short BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS closed_reason TEXT;
ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS closed_by TEXT;
ALTER TABLE po_lines ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

ALTER TABLE tooling_po_lines ADD COLUMN IF NOT EXISTS closed_short BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tooling_po_lines ADD COLUMN IF NOT EXISTS closed_reason TEXT;
ALTER TABLE tooling_po_lines ADD COLUMN IF NOT EXISTS closed_by TEXT;
ALTER TABLE tooling_po_lines ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
