-- Realtime change feed: one message per table per transaction, a heartbeat, and
-- coverage of every table a screen reads.
--
-- 1. ci_erp_realtime_ping sent one broadcast PER ROW. Measured 2026-09-16 on prod
--    temp tables (rolled back): a 470-row transaction sent 470 messages and spent
--    78.5 ms in the trigger; deduplicated, 1 message and 5.5 ms. Over 72 h the plant
--    sent 3,777 messages for 1,743 (table, transaction) pairs. realtime.send also
--    opens a subtransaction per call, so any transaction writing >64 rows overflowed
--    the per-backend subxid cache and slowed every concurrent snapshot (3 times in
--    72 h, up to 88). Now: the first row of a table in a transaction announces it,
--    the rest see a transaction-local flag and return.
--    The flag is keyed by table OID (a GUC name must be a plain identifier — a
--    name-keyed flag would RAISE and fail the user's write on an odd table name) and
--    compared with the transaction's own id, so a flag can never outlive its
--    transaction. The function's SET clause restores search_path only; NEVER add
--    ci_erp_rt.* to it, or every call would reset the flag and dedup silently stops.
--    The payload no longer carries a row id (nothing read it; realtime.send adds the
--    message's own uuid) — only table names and timings go over the public channel.
--
-- 2. ci_erp_realtime_heartbeat(): the browser answers a repeat GET from memory only
--    while it can PROVE it would have heard of any change. An open websocket does not
--    prove the database-to-Realtime pipe is alive; a heartbeat sent through that pipe
--    does, and it names the tables being announced. At most one per 45 s, however
--    many server instances ask (pg_cron is not installed; the API asks on traffic).
--
-- 3. Triggers on the tables screens read but that never announced changes. users and
--    conversation_members announce everything EXCEPT their presence stamps
--    (last_active_at; last_seen_at, typing_at), which change every few seconds and
--    mean nothing to a list — the server marks any response that reads those columns
--    as never cacheable instead. push_subscriptions stays silent (no screen reads it).
--
-- 4. TRUNCATE announces too, on every announced table (row triggers never see it). The
--    heartbeat vouches only for a table whose ENABLED ping triggers cover insert,
--    update, delete AND truncate, so a disabled or missing trigger takes the table out
--    of every browser's trusted set at the next heartbeat.
--    RUNBOOK: session_replication_role = replica silences these triggers without
--    changing the catalogue. Before any bulk job that uses it (or disables triggers),
--    run `drop function public.ci_erp_realtime_heartbeat();`, wait 150 s (browsers stop
--    trusting their caches), run the job, then re-create the function from this file.
--
-- APPLIED to colour-impressions-prod 2026-09-17 (version 20260917024744) after
-- npm run db:backup: 168 ping triggers on 83 tables (85 row + 83 truncate), heartbeat
-- lists 83. Idempotent — a re-run replaces in place and takes no reader-blocking lock.
--
-- LOCKS: CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE — writers to that table wait
-- until commit, readers never do. (DROP TRIGGER on an existing trigger takes ACCESS
-- EXCLUSIVE and blocks readers too — measured on PG17 — so nothing here drops.)
-- lock_timeout is SET LOCAL: it ends with this transaction and cannot leak into a
-- pooled connection. If a long transaction holds one of these tables, the migration
-- fails within 1 s and rolls back whole; re-run it.
set local lock_timeout = '1s';

create or replace function public.ci_erp_realtime_ping()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  flag constant text := 'ci_erp_rt.t' || TG_RELID::text;
  xact constant text := pg_catalog.pg_current_xact_id()::text;
begin
  if pg_catalog.current_setting(flag, true) is not distinct from xact then
    return null;
  end if;

  perform realtime.send(
    pg_catalog.jsonb_build_object(
      'schema', TG_TABLE_SCHEMA,
      'table', TG_TABLE_NAME,
      'event', TG_OP,
      'changed_at', pg_catalog.statement_timestamp()
    ),
    'db-change',
    'ci-erp:db-changes',
    false
  );

  perform pg_catalog.set_config(flag, xact, true);
  return null;
end;
$$;

revoke all on function public.ci_erp_realtime_ping() from public;
revoke all on function public.ci_erp_realtime_ping() from anon;
revoke all on function public.ci_erp_realtime_ping() from authenticated;

create or replace function public.ci_erp_realtime_heartbeat()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from realtime.messages m
    where m.topic = 'ci-erp:db-changes'
      and m.event = 'db-heartbeat'
      and m.inserted_at > pg_catalog.now() - interval '45 seconds'
  ) then
    return;
  end if;

  perform realtime.send(
    pg_catalog.jsonb_build_object(
      'tracked', coalesce((
        select pg_catalog.jsonb_agg(covered.relname order by covered.relname)
        from (
          select c.relname::text as relname
          from pg_catalog.pg_trigger t
          join pg_catalog.pg_class c on c.oid = t.tgrelid
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where t.tgfoid = 'public.ci_erp_realtime_ping()'::pg_catalog.regprocedure
            and n.nspname = 'public'
            and t.tgenabled in ('O', 'A')
            and not t.tgisinternal
          group by c.relname
          -- tgtype bits: 4 insert, 8 delete, 16 update, 32 truncate
          having (pg_catalog.bit_or(t.tgtype::int) & 60) = 60
        ) covered
      ), '[]'::jsonb),
      'at', pg_catalog.now()
    ),
    'db-heartbeat',
    'ci-erp:db-changes',
    false
  );
end;
$$;

revoke all on function public.ci_erp_realtime_heartbeat() from public;
revoke all on function public.ci_erp_realtime_heartbeat() from anon;
revoke all on function public.ci_erp_realtime_heartbeat() from authenticated;

do $$
declare
  target_table text;
  target_tables text[] := array[
    'audit_log',
    'billing_entities',
    'board_verifications',
    'conversations',
    'gang_template_slots',
    'gang_templates',
    'job_board_mix',
    'mention_targets',
    'message_attachments',
    'message_job_tags',
    'message_mentions',
    'messages',
    'notifications',
    'shade_card_issues',
    'shade_card_legacy_numbers',
    'stage_discrepancies',
    'stock_writeons'
  ];
begin
  foreach target_table in array target_tables loop
    if pg_catalog.to_regclass(pg_catalog.format('public.%I', target_table)) is not null then
      execute pg_catalog.format(
        'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.%I for each row execute function public.ci_erp_realtime_ping()',
        target_table
      );
    end if;
  end loop;
end
$$;

create or replace trigger ci_erp_realtime_ping
  after insert or delete on public.users
  for each row execute function public.ci_erp_realtime_ping();
create or replace trigger ci_erp_realtime_ping_update
  after update on public.users
  for each row
  when ((pg_catalog.to_jsonb(old) - 'last_active_at') is distinct from (pg_catalog.to_jsonb(new) - 'last_active_at'))
  execute function public.ci_erp_realtime_ping();

create or replace trigger ci_erp_realtime_ping
  after insert or delete on public.conversation_members
  for each row execute function public.ci_erp_realtime_ping();
create or replace trigger ci_erp_realtime_ping_update
  after update on public.conversation_members
  for each row
  when ((pg_catalog.to_jsonb(old) - 'last_seen_at' - 'typing_at') is distinct from (pg_catalog.to_jsonb(new) - 'last_seen_at' - 'typing_at'))
  execute function public.ci_erp_realtime_ping();

-- TRUNCATE on every table that announces its rows — the tables above and every table
-- the original feed (20260807100428) bound.
do $$
declare
  target record;
begin
  for target in
    select distinct n.nspname, c.relname
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where t.tgfoid = 'public.ci_erp_realtime_ping()'::pg_catalog.regprocedure
      and not t.tgisinternal
  loop
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping_truncate after truncate on %I.%I for each statement execute function public.ci_erp_realtime_ping()',
      target.nspname, target.relname
    );
  end loop;
end
$$;
