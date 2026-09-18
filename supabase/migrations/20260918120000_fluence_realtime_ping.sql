-- The Fluence tables announce their changes on the realtime feed, like every other
-- table a screen reads (20260917024744_realtime_once_per_transaction.sql).
--
-- 20260917120000_fluence_prescription_kits.sql created the fluence_* tables without
-- the ping triggers. The heartbeat vouches only for a table whose ping triggers cover
-- insert, update, delete AND truncate, so no browser ever trusted a Fluence answer:
-- every Fluence GET — /fluence/scope runs on every module page — went back to the
-- server, and one person's edit never reached another person's open screen. Fail-safe,
-- but not what the feed is for.
--
-- Guarded: a database without the realtime function (every local one) skips it all.
--
-- APPLIED to colour-impressions-prod 2026-09-18 as the named migration
-- `fluence_realtime_ping`, the same day as the tables.
--
-- LOCKS: CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on each Fluence table —
-- writers to that table wait until commit, readers never do; nothing here drops.
-- lock_timeout is SET LOCAL, so it ends with this transaction.
set local lock_timeout = '1s';

do $$
declare
  target_table text;
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  foreach target_table in array array[
    'fluence_customers',
    'fluence_inner_products',
    'fluence_kits',
    'fluence_kit_components',
    'fluence_prescriptions',
    'fluence_prescription_lines',
    'fluence_master_revisions',
    'fluence_part_cartons'
  ] loop
    if pg_catalog.to_regclass(pg_catalog.format('public.%I', target_table)) is not null then
      execute pg_catalog.format(
        'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.%I for each row execute function public.ci_erp_realtime_ping()',
        target_table
      );
      execute pg_catalog.format(
        'create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.%I for each statement execute function public.ci_erp_realtime_ping()',
        target_table
      );
    end if;
  end loop;
end
$$;
