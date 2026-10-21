-- COA REGISTER — the Certificates of Analysis the plant has issued, as filed in
-- the mppchd Google Drive (COLOUR IMPRESSION/COA), mirrored into CI Plant.
--
-- APPLIED to colour-impressions-prod 2026-10-21 as the named migration `coa_register`
-- (owner's go-ahead: "commit push and deploy"). Written 2026-10-17.
--
-- Free of the ERP's own data on purpose: no foreign key leaves these tables, and
-- nothing in the plant reads them. The Drive register (COA Register.xlsx) is the
-- source; scripts/coa-register-sync.mjs reads it and the PDFs beside it and
-- replaces what is here. Values are kept as the register writes them (invoice
-- and PO numbers, job card, status) — this is a register, not a ledger.
--
--   coa_register        one row per COA No. in the register
--   coa_register_files  the COA's PDF, as filed in Drive (kept apart so a list
--                       of the register never reads a byte of PDF)
--   users.coa_download  the right to download a COA PDF. Opening the COA
--                       Register module lets a login see the list and view a
--                       COA on screen; downloading needs this tick as well.
--                       Admins always may. Edited in Masters → Users.
CREATE TABLE IF NOT EXISTS coa_register (
  coa_no          text PRIMARY KEY,
  company         text,
  customer        text,
  invoice_no      text,
  invoice_date    date,
  line_no         integer,
  product         text,
  party_item_code text,
  po_no           text,
  po_date         date,
  job_card        text,
  qty             numeric(14,2),
  std_gsm         numeric(10,2),
  status          text,
  rows_on_hold    text,
  qc_signed       text,
  remarks         text,
  file_name       text,
  folder          text,
  date_generated  date,
  date_approved   date,
  -- Where the PDF was found in Drive (relative to the COA folder), or NULL when
  -- the register names a file that is not there.
  pdf_path        text,
  synced_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coa_register_customer ON coa_register (customer);
CREATE INDEX IF NOT EXISTS coa_register_invoice ON coa_register (invoice_no);

CREATE TABLE IF NOT EXISTS coa_register_files (
  coa_no      text PRIMARY KEY REFERENCES coa_register(coa_no) ON DELETE CASCADE,
  file_name   text NOT NULL,
  bytes       bytea NOT NULL,
  size_bytes  integer NOT NULL,
  sha256      text NOT NULL,
  synced_at   timestamptz NOT NULL DEFAULT now()
);
-- PDFs are compressed already: kept as they are, out of line.
ALTER TABLE coa_register_files ALTER COLUMN bytes SET STORAGE EXTERNAL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS coa_download INTEGER NOT NULL DEFAULT 0;

-- Same lock-down as the other private tables: the server connects as owner.
ALTER TABLE coa_register ENABLE ROW LEVEL SECURITY;
ALTER TABLE coa_register_files ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON coa_register, coa_register_files FROM anon, authenticated;
  END IF;
END $$;

-- The register announces its changes on the realtime feed like every table a
-- screen reads (20260918120000_fluence_realtime_ping.sql is the template), so a
-- sync shows on an open COA Register screen at once. Guarded: a database without
-- the realtime function (every local one) skips it.
set local lock_timeout = '1s';
do $$
declare
  target_table text;
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  foreach target_table in array array['coa_register', 'coa_register_files'] loop
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.%I for each row execute function public.ci_erp_realtime_ping()',
      target_table);
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.%I for each statement execute function public.ci_erp_realtime_ping()',
      target_table);
  end loop;
end
$$;
