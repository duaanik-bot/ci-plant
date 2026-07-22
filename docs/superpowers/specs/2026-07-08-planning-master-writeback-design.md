# Planning ↔ Product Master write-back + carton-master backfill

**Date:** 2026-07-08
**Status:** Approved (design) — pending spec review → implementation plan

## Goal

Make the Product Master the single source of truth for product specs, kept
current from two directions:

1. **Seed it now** — backfill child (print) sheet size, ups, GSM and colours
   into the master from the real plant carton master, so existing products
   stop showing blank specs.
2. **Keep it current going forward** — when a planner changes a master-driven
   spec in the planning engine, offer to write the change back to the master
   (already largely built); extend that to **Rate** and **GSM**.

Board name is already derived from the child (print) sheet, not the mother
sheet (shipped in the prior wave). Parent/mother size = the board the planner
picks; that already writes back on Lock. See memory
`ci-erp-board-name-carton-source`.

## Context — what ALREADY exists (do not rebuild)

`client/src/pages/Planning.jsx` + `server/src/routes/orders.js`:

- Opening an order line **auto-fills the spec from the product master**.
- Planner can edit `ups`, `colors`, `coating`, `special`, `child_l`, `child_w`
  and the **board** (`board_material_id`). Fields differing from the master
  show an amber "edited" marker (`<Edited />` / `FieldMark`).
- `changedSpec()` (client) collects fields that differ from what the line
  opened with; on **Lock** (`onLock`), if anything changed it opens the
  `masterPrompt` popup asking the "update the master?" question.
- `savePlan({ spec, update_master })` → `POST /order-lines/:id/plan`. Server
  `SPEC_FIELDS` = `['ups','wastage_pct','colors','coating','special','child_l','child_w','board_material_id']`.
  On `update_master:true` it runs `UPDATE products SET … WHERE id`, clears the
  matching job override, and audits `product … master_update`. On false it
  stores the change as a job-only `spec_override`.

So the popup, the write-back, the auto-populate, and the job-vs-master split
already work. This spec only **seeds data** and **adds two fields** to the
existing mechanism.

## Part 1 — One-time carton-master backfill (data)

**Source of truth:** CI-Production Supabase `cartons` table, reached via
`CI-Production/.env` `DIRECT_URL` (project `ylbfeptgefzimcqnwphy`;
`ssl:{rejectUnauthorized:false}`). Relevant columns: `carton_name`,
`sheet_size_l`, `sheet_size_w` (child print sheet, **inches**), `ups`, `gsm`,
`number_of_colours`.

**Target:** ci-erp embedded Postgres `products`
(`postgresql://postgres:postgres@localhost:5439/cierp`).

**Match key:** normalized carton name (uppercase, non-alphanumerics → single
space, trimmed). Validated counts: 1372 products / 1368 cartons →
872 matched with a child sheet, 496 matched but source has no child sheet,
4 unmatched (demo/placeholder), 134 name collisions (one name → several source
rows — revisions).

**Write rule (child-blank gate, never clobber):** `ups` and `colors` are
`NOT NULL` with schema defaults (1 and 4), so an unset default is
indistinguishable from a real value — filling them blindly could clobber a real
1-up / 4-colour product. To stay safe, a product is only backfilled at all when
its **child sheet is blank** (`child_l IS NULL OR child_w IS NULL`) — i.e. a
genuinely incomplete spec. For those incomplete products, and only where the
source has a value:
- `child_l`, `child_w` — set from source (this is the primary fix).
- `ups` — set from source.
- `gsm` — set from source when current `gsm IS NULL`.
- `colors` — set from source.

A product that **already** has a child sheet is treated as specified and left
entirely untouched; if the source differs, record it in a conflicts report
(never overwrite). `rate` is never touched here (commercial; handled via
Part 2). Products where the source has no child sheet stay blank (filled later
via planning). The `spec_incomplete` flag is left as-is (board may still be a
placeholder) — out of scope for this pass.

**Safety / reversibility (no git — project rule):**
- Before writing, snapshot `{id, child_l, child_w, ups, gsm, colors}` for every
  product to `docs/superpowers/backfill-backup-<timestamp>.json`.
- Wrap all updates in a single transaction.
- Audit each product with a `master_backfill` entry listing the fields set.
- Emit a report: filled per field, skipped-as-conflict (with old→source), the
  134 collisions, and the 4 unmatched.

**Explicitly skipped:** 134 collisions (ambiguous — need code/artwork
tiebreaker, deferred), 4 unmatched, and any field where ci-erp already holds a
value that differs from source (reported, not overwritten).

**Delivery:** a standalone Node script run once (not wired into the app),
committed to `scripts/` for repeatability, plus the printed report. Dry-run
mode first (default) that writes nothing and prints the report; `--apply`
performs the transactional write after the snapshot.

## Part 2 — Add Rate + GSM to the planning write-back

**Server — `server/src/routes/orders.js`:**
- Add `'rate'` and `'gsm'` to `SPEC_FIELDS`.
- Add `'gsm'` to `INT_SPEC` (rounded int). `rate` is a float — ensure the
  numeric coercion path handles a non-INT, non-TEXT field as `+spec[f]`
  (already the else branch). Confirm `products.rate` / `products.gsm` are the
  target columns (they are).
- No new endpoint, no popup change — the existing `update_master` branch writes
  and audits these two automatically.

**Client — `client/src/pages/Planning.jsx`:**
- Add `rate: ''` and `gsm: ''` to `form` state and to the `setForm({…})` in the
  line-open handler (seed from `l.rate` / `l.gsm` — confirm the planning line
  query returns them; if not, add to the select in the planning context/list
  query).
- Add two `<Field>` inputs in the spec panel next to the others, each with the
  `{'rate' in edited && <Edited />}` / `{'gsm' in edited && <Edited />}` marker:
  - Rate — `type=number step=0.01 min=0`, label "Rate ₹/carton".
  - GSM — `type=number min=0`, label "GSM".
- Extend `changedSpec()` with `cmp('rate', form.rate, true)` and
  `cmp('gsm', form.gsm, true)` so they flow into `masterPrompt` and `savePlan`.
- The existing Lock → "update master?" popup automatically lists them.

**Note:** rate/gsm are optional planner edits — leaving them at the master
value produces no diff and no prompt, so the floor flow is unchanged unless a
planner deliberately edits them.

## Part 3 — Parent-sheet label clarity (cosmetic)

The board-selection section in Planning.jsx already decides the parent/mother
sheet and writes it back via `board_material_id`. Only change: relabel that
section/stat so "Parent sheet" reads explicitly to the planner. No logic.

## Out of scope

- Resolving the 134 name-collisions and 8 genuine grade conflicts (separate
  follow-up; needs code/artwork tiebreaker).
- Bulk-importing rate from source.
- Any change to the board-name derivation (already shipped).

## Testing

- Part 1: run the script in dry-run against a copy; assert fill-blanks-only
  (a product with an existing child size is untouched and reported), assert
  collision/unmatched exclusion, assert the backup file round-trips.
- Part 2: unit — `changedSpec()` returns `rate`/`gsm` when edited; server
  `/plan` with `update_master:true` updates `products.rate`/`gsm` and audits;
  with false stores a `spec_override`. Manual — edit rate+gsm in the engine,
  confirm amber markers, Lock, confirm popup lists them, confirm master row
  updated and audit entry present; re-open a fresh line and confirm the new
  master value auto-populates.
