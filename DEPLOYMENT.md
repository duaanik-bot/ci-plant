# Deploying CI ERP

The live plant runs on this. Read the everyday workflow once; use the rest as
reference when something goes wrong.

---

## 1. The map — what runs where

| Piece | Where it lives | Notes |
|---|---|---|
| Source of truth | this repo, branch `master` → GitHub `main` | remote: `duaanik-bot/ci-plant` |
| Local database | embedded PostgreSQL, `server/.pgdata`, port **5439** | starts itself; no setup |
| Live site | Vercel project **`ci-plant`** | `motionci.in`, `www.motionci.in` |
| Live database | Supabase **`colour-impressions-prod`** (`ylbfeptgefzimcqnwphy`) | region `ap-south-1` |
| API | one serverless function, `api/index.js`, region `bom1` | close to the Supabase region |

**Local development never touches the live database.** With no `DATABASE_URL`
set, the server starts its own PostgreSQL. That is the normal, intended setup.

**The live site never reads your laptop.** It reads Supabase, via the
transaction-mode pooler, from `DATABASE_URL` set on the Vercel project.

---

## 2. Everyday workflow — change something and ship it

```bash
npm run dev
```
Open http://localhost:5173, make your change, and check it in the running app.

```bash
npm run verify
```
This must pass before anything ships. It regenerates-and-compares the schema
baseline, runs the 184 server tests, and builds the client.

```bash
git status --short --branch
git add <only the files you changed>
git commit -m "what changed and why"
git fetch origin main
git push origin master:main
```

Pushing to GitHub `main` is what deploys. Vercel builds automatically and
promotes to `motionci.in`. There is no separate deploy step.

Then verify it actually went live — see §5.

> Urgent releases can bypass GitHub with `npm run deploy:prod`, but the commit
> should still be pushed afterwards or the repo and the live site drift apart.

---

## 3. Changing the database schema

The schema lives in **`server/src/db.js` → `init()`**. That function is the
source of truth; `supabase/migrations/0001_baseline_schema.sql` is generated
from it and committed so the schema is version-controlled and replayable.

`init()` runs **only in local development**. It never runs on Vercel, so
editing it does *not* change the live database. Production must be migrated
deliberately.

**Procedure**

1. Edit `init()` in `server/src/db.js`. Every statement must be idempotent
   (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, …) and must come
   **after** the table it touches is created. Restart `npm run dev` to apply it
   locally.

2. Regenerate and prove the baseline still rebuilds from empty:
   ```bash
   npm run db:baseline
   npm run db:check -- --baseline
   ```
   `--baseline` replays the committed `.sql` into a throwaway database and
   compares it to your working local one. It must say **OK — schemas match**.

3. Apply the same change to production as a *named migration*, so Supabase keeps
   a history of it. Write just the delta (the new columns/tables), not the whole
   baseline.

4. Confirm local and production now agree:
   ```bash
   vercel env pull .env.prod --environment production
   DATABASE_URL="$(grep '^DATABASE_URL=' .env.prod | cut -d= -f2-)" npm run db:check
   rm .env.prod
   ```
   It must say **OK — schemas match**.

5. Commit `server/src/db.js` *and* the regenerated
   `supabase/migrations/0001_baseline_schema.sql` together. CI fails if the
   baseline is stale.

---

## 4. Safety rails — why a wrong-database accident cannot happen quietly

These are enforced in code, not by convention:

- **`init()` refuses a non-local database.** Running `npm run dev` with
  `DATABASE_URL` pointed at Supabase throws immediately, naming the host, rather
  than creating tables and seeding demo data into the live plant. Deliberate
  remote schema work sets `ALLOW_REMOTE_SCHEMA_SYNC=yes`.
- **A deployment refuses to fall back to embedded PostgreSQL.** If a deploy has
  no `DATABASE_URL`, it fails fast with that exact message instead of trying to
  boot a database inside the function.
- **`JWT_SECRET` is mandatory in production.** The server will not start without
  it (`server/src/auth.js`).
- **Preview deployments have no database configured at all.** The old Preview
  wiring pointed at a dead Neon database and was removed; nothing can silently
  deploy against a stale environment.
- **CI blocks committed secrets** — `.env` files and any JWT / Supabase key /
  Anthropic key / password-bearing Postgres URL.

---

## 5. Verifying a deploy

```bash
curl -I -L https://motionci.in
curl -sS https://motionci.in/api/health
```

Expected: `HTTP/2 200`, and `{"ok":true}`.

Then confirm auth is intact — this proves the database and `JWT_SECRET` are both
wired correctly:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://motionci.in/api/orders
```

Expected: **401** (not 500). A 401 means the app booted, reached the database and
rejected an unauthenticated request. A 500 means the function is broken.

Finally, open the site and confirm your change is visible.

---

## 6. When a deploy fails — diagnose, don't guess

Work down this list; each step distinguishes a specific cause.

1. **Did the build fail, or the runtime?** Check the deployment in Vercel. A red
   build never went live and the previous version is still serving.
2. **Build failed** → reproduce locally with `npm run verify`. It runs the same
   test suite and client build the CI gate does.
3. **Build passed, site returns 500** → the function is failing at runtime. Check
   the function logs. The two failure modes with explicit messages are
   `DATABASE_URL is not set for this deployment` and the `JWT_SECRET` boot check.
4. **`/api/health` is 200 but pages are empty** → the API is up but queries are
   failing or returning nothing. Compare schemas: `npm run db:check` (§3 step 4).
   Schema drift between local and production is the usual cause.
5. **Everything looks right but the change isn't there** → confirm what is
   actually deployed. Check that the commit SHA in the Vercel deployment matches
   `git rev-parse HEAD`, and that you pushed to `main`, not just `master`.

---

## 7. Rolling back

Vercel keeps every previous production build. Promote the last known-good
deployment from the project's Deployments tab — this is instant and needs no
rebuild.

Roll back if any of these are true after a release:

- `/api/health` is not `{"ok":true}`
- `/api/orders` returns 500 instead of 401
- the plant cannot log in
- any production stage or dispatch flow errors on a normal action

**A code rollback does not undo a database migration.** If the release included
a schema change, reverse that separately — which is why migrations should only
ever add things, never drop or rename a column that the previous release reads.

---

## 8. Protecting production data

Back up before any destructive production work — no exceptions:

```bash
vercel env pull .env.prod --environment production
DATABASE_URL="$(grep '^DATABASE_URL=' .env.prod | cut -d= -f2-)" npm run db:backup
rm .env.prod
```

Writes a timestamped JSON of every table to `backups/` (gitignored, never
deployed).

**The live database now contains real plant data that your local copy does
not.** Orders are entered through `motionci.in` directly. Never copy local over
production wholesale — the one-time migration script that did that has been
deleted precisely because re-running it would destroy live orders.

---

## 9. Known gaps

- **`init()` mixes schema with one-off data backfills** (legacy die import, GST
  seed rows, section self-heal). They are idempotent and safe to replay, but a
  future cleanup should separate "schema" from "seed".
- **Only one baseline migration exists.** Future schema changes should be added
  as separate numbered files under `supabase/migrations/` rather than folded
  into the baseline.
- **Eight `COMPANY_*` environment variables remain on Vercel** and are read by
  nothing (the company profile comes from the `company_profile` table). They are
  harmless, non-secret, and were left in place rather than removed without need.
- **No automated test covers a deploy end-to-end.** §5 is manual.
