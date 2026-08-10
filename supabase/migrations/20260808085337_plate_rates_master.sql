-- Controlled purchase rates for printing plates. A base row prices a plate
-- size for every vendor; a vendor-specific row overrides it without creating
-- another plate SKU.
CREATE TABLE plate_rates (
  id SERIAL PRIMARY KEY,
  plate_master_id INTEGER NOT NULL REFERENCES plate_masters(id) ON DELETE CASCADE,
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE CASCADE,
  rate_per_plate NUMERIC(12,2) NOT NULL CHECK (rate_per_plate > 0),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX plate_rates_master_vendor_unique
  ON plate_rates (plate_master_id, COALESCE(vendor_id, 0));
CREATE INDEX plate_rates_lookup
  ON plate_rates (plate_master_id, vendor_id, active, effective_from DESC);

-- Both standard sizes start at the requested Rs 200/plate. The UI groups these
-- under Plate Rates; individual CMYK/Pantone components still remain assets.
INSERT INTO plate_rates (plate_master_id, vendor_id, rate_per_plate, effective_from, active)
SELECT pm.id, NULL, 200, CURRENT_DATE, 1
FROM plate_masters pm
WHERE pm.active=1
  AND NOT EXISTS (
    SELECT 1 FROM plate_rates pr
    WHERE pr.plate_master_id=pm.id AND pr.vendor_id IS NULL
  );

ALTER TABLE plate_rates ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON TABLE plate_rates FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON TABLE plate_rates FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ci_local_preview') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE plate_rates TO ci_local_preview;
    GRANT USAGE,SELECT ON SEQUENCE plate_rates_id_seq TO ci_local_preview;
  END IF;
END
$$;

DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS ci_erp_realtime_ping ON public.plate_rates;
    CREATE TRIGGER ci_erp_realtime_ping
      AFTER INSERT OR UPDATE OR DELETE ON public.plate_rates
      FOR EACH ROW EXECUTE FUNCTION public.ci_erp_realtime_ping();
  END IF;
END
$$;
