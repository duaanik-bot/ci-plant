# Claude Operating Notes

## Project Scope

- Work only in this project unless the user explicitly says otherwise:
  `/Users/anikdua/Documents/CI ERP FInal/ci-erp`
- Do not touch other Colour Impressions, CI, Vercel, GitHub, or Supabase projects.
- This app is the live Colour Impressions Plant ERP behind `motionci.in`.

## Source of Truth

- Local application source: this repository.
- Treat this repository as the single source of truth for Codex and Claude work.
  Ignore stale clones, old Next.js deployments, and older branches unless the
  user explicitly asks to inspect them.
- Local database: embedded PostgreSQL at `server/.pgdata`, connection
  `postgresql://postgres:postgres@localhost:5439/cierp`.
- Production database: Supabase project `colour-impressions-prod`
  (`ylbfeptgefzimcqnwphy`).
- Production Vercel project: `ci-plant`.
- Production domains: `motionci.in` and `www.motionci.in`.

## Git Rules

- Git operations are allowed for this repository when the user asks for commit,
  push, release, deploy, or production work.
- Always run `git status --short --branch` before staging.
- Stage only files that belong to the requested change.
- Commit after verification passes.
- Fetch before pushing:
  `git fetch origin main`.
- If local and remote have both moved, rebase or stop and explain the conflict.
- Never overwrite remote work silently. Use `--force-with-lease` only when the
  user explicitly asks to overwrite and the expected remote SHA is known.
- The intended remote is `origin`:
  `https://github.com/duaanik-bot/ci-plant.git`.
- Current local branch may be `master`; publish to GitHub `main` unless the user
  asks for a different branch.

## Verification

Run the relevant checks before deploy:

```bash
npm test -w server
npm run build -w client
```

Or run all of it — baseline freshness, tests, and client build:

```bash
npm run verify
```

Schema drift against a real environment (needs `DATABASE_URL` for that
environment):

```bash
npm run db:check
```

## Database Changes

- **Full procedure: `DEPLOYMENT.md` §3.** Follow it rather than improvising.
- Do not commit `server/.pgdata`, dumps, backups, Supabase tokens, or `.env`
  files. Backups belong in `backups/` (gitignored).
- Schema lives in `server/src/db.js` → `init()`, and is applied by the app on
  startup **in local development only**. The Vercel function calls `connect()`
  and never `init()`, so editing it does not change production. Production is
  migrated deliberately, as a named Supabase migration.
- `supabase/migrations/0001_baseline_schema.sql` is generated from `init()` by
  `npm run db:baseline`. Commit it alongside any `init()` change — `npm run
  verify` fails when it is stale.
- Every statement in `init()` must be idempotent **and ordered after the table it
  touches is created**. Prove it with `npm run db:check -- --baseline`, which
  replays the baseline into an empty database.
- `init()` refuses to run against a non-localhost database. Deliberate remote
  schema work sets `ALLOW_REMOTE_SCHEMA_SYNC=yes`.
- For local data changes, verify through the local preview first.
- For production data changes, target only Supabase `colour-impressions-prod`.
- Before destructive production DB work, create a backup and confirm the exact
  target project/ref in the terminal output.
- After DB sync, compare table counts and a deterministic hash/checksum when
  possible before declaring it done.

## Deployment

- Deploy only the Vercel project `ci-plant`.
- Do not deploy or alter any other Vercel project.
- Vercel Git auto-deploy is connected to `duaanik-bot/ci-plant`; GitHub `main`
  and this local repository are aligned again. CLI deployment from this local
  repo is still acceptable for urgent production releases.
- Deploy command:

```bash
npm run deploy:prod
```

- If `VERCEL_TOKEN` is available, use:

```bash
vercel deploy --prod --yes --token "$VERCEL_TOKEN"
```

- After deployment, verify:

```bash
npm run verify:prod
```

This checks the app shell, every asset it references, the stale-asset 404, a
deep link, and `/api/health` (expected `{"ok":true}`), retrying while the
production alias moves. `npm run deploy:prod` runs it automatically; a Git
auto-deploy is covered by the `smoke` job in CI instead.

**Do not replace it with a bare `curl -I https://motionci.in`.** A 200 on the
shell is not evidence the app works: on 2026-08-26 every response was a 200
while the floor looked at Live Floor with real figures and no stylesheet at
all — the SPA catch-all was answering missing `/assets/` files with index.html.
`server/src/deploy-static-assets.test.js` pins the config that fixed it.

## Current Known State (updated 2026-07-26)

- Workflow audit completed. `DEPLOYMENT.md` is the runbook for everything below.
- **Production holds real data that local does not.** Two orders were entered
  through `motionci.in` on 2026-07-25 (PO `01732`, PO `12345`). Never copy local
  over production wholesale. `migrate-local-to-supabase.mjs` was deleted for
  exactly this reason; `backup-ci-prod-supabase.mjs` was deleted as obsolete and
  replaced by `scripts/backup-prod.mjs` (`npm run db:backup`).
- Schema verified identical across baseline `.sql` → fresh DB → local → Supabase
  prod (50 tables) on 2026-07-26.
- Fixed a latent bug: six `ALTER TABLE tools` statements ran ~100 lines before
  `CREATE TABLE tools`, so any database built from empty crashed on first start.
- Guards added: `init()` refuses non-local databases; a deployment refuses to
  fall back to embedded Postgres.
- GitHub Actions CI (`.github/workflows/ci.yml`) gates `main` on `npm run verify`
  plus a committed-secret scan.
- Vercel: removed 10 dead/stale env vars, including the Preview `DATABASE_URL`
  that pointed at a dead Neon database. Production keeps only `JWT_SECRET`,
  `DATABASE_URL` and the four unused `COMPANY_*` values.
- Dropped `users_password_backup_20260725` from prod (old email + password_hash
  copy) after backing it up.

## Earlier State

- Supabase `colour-impressions-prod` was overwritten from local and verified to
  match local public schema/data on 2026-07-24.
- The last verified combined DB hash was
  `72c784ce0e68570c3e72df9508c1d17d`.
- Vercel production was verified live on `motionci.in` on 2026-07-24.
- The stale old Next.js-looking Vercel deployment
  `dpl_Ai7FEZvbB2EazP1ABS2KV3BTcu7R` was removed on 2026-07-24, and Vercel
  project settings were corrected to Vite / `client/dist`.
- Vercel Git integration was reconnected to `duaanik-bot/ci-plant` on
  2026-07-25 after GitHub `main` was aligned with this source.
- GitHub SSH push works on this Mac for `duaanik-bot/ci-plant`.
