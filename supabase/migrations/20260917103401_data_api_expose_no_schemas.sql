-- Data API (PostgREST REST + GraphQL) off, set in the database.
--
-- APPLIED to colour-impressions-prod 2026-09-17 (version 20260917103401) after
-- npm run db:backup. Verified from outside with the public key: /rest/v1/<table> -> PGRST205,
-- /rest/v1/rpc/<fn> -> PGRST202, /graphql/v1 -> PGRST106; motionci.in and Realtime unaffected.
--
-- Nothing uses it: over 2026-09-01..17 the API gateway saw only /realtime/v1, and since
-- pg_stat_statements was reset (2026-08-06) no data query ran as anon/authenticated/service_role.
-- The ERP talks to Postgres directly; the browser uses Realtime only. Leaving REST/GraphQL up
-- only kept a public surface that a future accidental GRANT could open.
--
-- This is Supabase's documented database-side form of "Enable Data API: off": PostgREST
-- keeps running but exposes one empty schema, so no table, view or function is reachable
-- over /rest/v1 or /graphql/v1 with any key. Realtime, Storage, Auth and direct Postgres
-- connections are unaffected. (The dashboard's Data API page may still read "enabled".)
--
-- To turn the Data API back on:
--   alter role authenticator reset pgrst.db_schemas;
--   notify pgrst;
-- (then, optionally, drop schema pgrst_no_exposed_schemas;)
create schema if not exists pgrst_no_exposed_schemas;
revoke all on schema pgrst_no_exposed_schemas from public;
alter role authenticator set pgrst.db_schemas = 'pgrst_no_exposed_schemas';
notify pgrst;
