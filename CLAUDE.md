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

Or run both:

```bash
npm run verify
```

## Database Changes

- Do not commit `server/.pgdata`, dumps, backups, Supabase tokens, or `.env`
  files.
- Schema lives in `server/src/db.js` and is applied by the app on startup.
- For local data changes, verify through the local preview first.
- For production data changes, target only Supabase `colour-impressions-prod`.
- Before destructive production DB work, create a backup and confirm the exact
  target project/ref in the terminal output.
- After DB sync, compare table counts and a deterministic hash/checksum when
  possible before declaring it done.

## Deployment

- Deploy only the Vercel project `ci-plant`.
- Do not deploy or alter any other Vercel project.
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
curl -I -L https://motionci.in
curl -sS https://motionci.in/api/health
```

Expected health body includes `{"ok":true}`.

## Current Known State

- Supabase `colour-impressions-prod` was overwritten from local and verified to
  match local public schema/data on 2026-07-24.
- The last verified combined DB hash was
  `72c784ce0e68570c3e72df9508c1d17d`.
- Vercel production was verified live on `motionci.in` on 2026-07-24.
- The stale old Next.js-looking Vercel deployment
  `dpl_Ai7FEZvbB2EazP1ABS2KV3BTcu7R` was removed on 2026-07-24, and Vercel
  project settings were corrected to Vite / `client/dist`.
- GitHub push still requires valid GitHub credentials on this Mac.
