-- Job-specific tooling demand, separate from reusable rack assets.
CREATE TABLE IF NOT EXISTS tooling_requests (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_number TEXT NOT NULL UNIQUE,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  order_line_id INTEGER REFERENCES order_lines(id) ON DELETE SET NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  family TEXT NOT NULL CHECK (family IN ('plate','die','block','shade_card')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','rack_reserved','in_house','procurement','vendor_assigned','sent_to_vendor',
     'received_from_vendor','grn_completed','ready','issued_to_floor',
     'returned_to_rack','cancelled','replaced','lost_damaged')),
  source TEXT CHECK (source IN ('rack','in_house','vendor','procurement')),
  tool_id INTEGER REFERENCES tools(id),
  shade_card_id INTEGER,
  vendor_id INTEGER REFERENCES vendors(id),
  qty INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  needed_by TEXT,
  specification JSONB,
  rack_location TEXT,
  pr_number TEXT,
  po_number TEXT,
  grn_number TEXT,
  vendor_reference TEXT,
  notes TEXT,
  sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  ready_by TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_card_id, product_id, family)
);

CREATE INDEX IF NOT EXISTS idx_tooling_requests_family_status ON tooling_requests(family, status);
CREATE INDEX IF NOT EXISTS idx_tooling_requests_job ON tooling_requests(job_card_id);
CREATE INDEX IF NOT EXISTS idx_tooling_requests_product ON tooling_requests(product_id);
CREATE INDEX IF NOT EXISTS idx_tooling_requests_order_line ON tooling_requests(order_line_id);
CREATE INDEX IF NOT EXISTS idx_tooling_requests_tool ON tooling_requests(tool_id);
CREATE INDEX IF NOT EXISTS idx_tooling_requests_vendor ON tooling_requests(vendor_id);

CREATE TABLE IF NOT EXISTS tooling_request_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tooling_request_id INTEGER NOT NULL REFERENCES tooling_requests(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  source TEXT,
  tool_id INTEGER REFERENCES tools(id),
  vendor_id INTEGER REFERENCES vendors(id),
  note TEXT,
  user_name TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tooling_request_events_request
  ON tooling_request_events(tooling_request_id, id);
CREATE INDEX IF NOT EXISTS idx_tooling_request_events_tool
  ON tooling_request_events(tool_id);
CREATE INDEX IF NOT EXISTS idx_tooling_request_events_vendor
  ON tooling_request_events(vendor_id);

-- Express owns authorization for this ERP. Keep these tables unavailable to
-- the browser-facing Data API; the server connection and trigger owner retain
-- their normal database access.
ALTER TABLE tooling_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tooling_request_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE tooling_requests, tooling_request_events FROM anon, authenticated;

-- Existing projects have already installed the shared invalidation function,
-- while fresh projects install it in the later realtime migration.
DO $$
DECLARE
  target_table TEXT;
BEGIN
  IF pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') IS NOT NULL THEN
    FOREACH target_table IN ARRAY ARRAY['tooling_requests', 'tooling_request_events'] LOOP
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS ci_erp_realtime_ping ON public.%I', target_table);
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER ci_erp_realtime_ping AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.ci_erp_realtime_ping()',
        target_table
      );
    END LOOP;
  END IF;
END
$$;
