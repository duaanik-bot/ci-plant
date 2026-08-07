-- Send small invalidation messages only; clients reload authorized data through
-- the Express API instead of receiving business rows over Realtime.
create or replace function public.ci_erp_realtime_ping()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_id text;
begin
  row_id := coalesce(pg_catalog.to_jsonb(new)->>'id', pg_catalog.to_jsonb(old)->>'id');

  perform realtime.send(
    pg_catalog.jsonb_build_object(
      'schema', TG_TABLE_SCHEMA,
      'table', TG_TABLE_NAME,
      'event', TG_OP,
      'id', row_id,
      'changed_at', pg_catalog.statement_timestamp()
    ),
    'db-change',
    'ci-erp:db-changes',
    false
  );

  return null;
end;
$$;

revoke all on function public.ci_erp_realtime_ping() from public;
revoke all on function public.ci_erp_realtime_ping() from anon;
revoke all on function public.ci_erp_realtime_ping() from authenticated;

do $$
declare
  target_table text;
  target_tables text[] := array[
    'approval_requests',
    'board_allocations',
    'board_rates',
    'coas',
    'company_profile',
    'customers',
    'cutting_discrepancies',
    'dies',
    'dispatch_lines',
    'dispatches',
    'employees',
    'extra_sheet_requests',
    'fg_consumptions',
    'fg_lots',
    'fg_movements',
    'fg_stock',
    'gang_runs',
    'grns',
    'gst_rates',
    'invoice_lines',
    'invoices',
    'job_cards',
    'job_stages',
    'machine_log_entries',
    'machine_operators',
    'machines',
    'materials',
    'order_lines',
    'orders',
    'packing_lines',
    'pasting_rows',
    'payments',
    'po_lines',
    'product_aliases',
    'products',
    'purchase_orders',
    'requisition_lines',
    'requisitions',
    'sections',
    'shade_card_docs',
    'shade_card_events',
    'shade_card_orders',
    'shade_card_revisions',
    'shade_cards',
    'stage_runs',
    'stock_batches',
    'stock_movements',
    'tool_events',
    'tools',
    'vendors'
  ];
begin
  foreach target_table in array target_tables loop
    if pg_catalog.to_regclass(pg_catalog.format('public.%I', target_table)) is not null then
      execute pg_catalog.format('drop trigger if exists ci_erp_realtime_ping on public.%I', target_table);
      execute pg_catalog.format(
        'create trigger ci_erp_realtime_ping after insert or update or delete on public.%I for each row execute function public.ci_erp_realtime_ping()',
        target_table
      );
    end if;
  end loop;
end
$$;
