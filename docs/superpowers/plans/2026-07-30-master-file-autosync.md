# Master File Auto-Sync — Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the master files built in Plan 1 travel with the product through every record the plant creates — shown automatically, promotable from any module via the *Update Master?* prompt, and frozen at lock so a printed job can always be proved against the artwork it actually ran on.

**Architecture:** A live master file is never copied. A record's panel is assembled on read from *(its own attachments) + (its pins) + (the product's active master files)*. Only **pinning** writes a row, and it happens once per record at the moment the record becomes binding. Pure assembly and drift logic lives in `panel-model.js` and the already-tested `master-files.js`, so the read model unit-tests without a database.

**Tech Stack:** Node 20 ESM, Express 4, Postgres (`pg`), React 18 + Vite + Tailwind, `node:test`. No new npm dependencies.

**Depends on:** `docs/superpowers/plans/2026-07-30-master-file-repository.md` — Plan 1 must be complete and deployed. It already builds and tests `shouldPromptMaster` (Task 1) and `driftFor` (Task 2); this plan consumes both.

**Spec:** `docs/superpowers/specs/2026-07-30-master-file-repository-design.md`

---

## Verification surface

Same as Plan 1 — there are **no client-side tests** in this repo:

```bash
npm test -w server        # node:test over server/src/*.test.js
npm run build -w client
npm run verify
```

Client tasks are verified by the build **plus loading the running app** at a desktop breakpoint while signed in. Run `git status --short --branch` before staging: other sessions share this working tree.

---

## Verified facts this plan is built on

Checked against `server/src/db.js` on 2026-07-30 — do not re-derive, but the parity test in Task 1 will catch it if any of this drifts:

| Entity | Reaches `product_id` how |
|---|---|
| `order_line` | `order_lines.product_id` — direct column |
| `job_card` | `job_cards.product_id` — direct column |
| `job_stage` | join `job_cards` via `job_stages.job_card_id` |
| `fg_lot` | `fg_lots.product_id` — direct column |
| `shade_card` | `shade_cards.product_id` — direct column |
| `dispatch` | **no product at all** — `dispatches` hangs off an *order* and carries many `dispatch_lines`, each with its own product. Read-through only (spec §7) |
| `purchase_order`, `requisition`, `grn`, `invoice`, `extra_sheet`, `gang_run` | no `product_id`; own attachments only |

---

## File structure

| File | Responsibility |
|---|---|
| `server/src/product-for-record.js` | **Create.** Entity → how to reach `product_id`. Closed map, mirrors `record-entities.js`. |
| `server/src/product-for-record.test.js` | **Create.** Parity test against `db.js` and `ENTITIES`. |
| `server/src/panel-model.js` | **Create.** Pure assembly of a record's panel from three row sets. |
| `server/src/panel-model.test.js` | **Create.** Tests for the above. |
| `server/src/routes/files.js` | **Modify.** Record panel/attach/detach; the prompt payload on commit. |
| `server/src/pin-files.js` | **Create.** `pinRecordFiles` / `unpinRecordFiles`. |
| `server/src/db.js` | **Modify.** `record_files` + indexes. |
| `server/src/routes/orders.js` | **Modify.** Pin at artwork lock. |
| `server/src/helpers.js` | **Modify.** Pin at job-card finalise; unpin on rollback. |
| `client/src/components/FilePanel.jsx` | **Create.** The panel, mounted by `(entity, id)`. |
| `client/src/components/UpdateMasterPrompt.jsx` | **Create.** The `Sync Master?`-shaped modal. |
| Nine page files | **Modify.** Mount `<FilePanel>`. |

---

## Task 1: The product resolver

**Files:**
- Create: `server/src/product-for-record.js`
- Test: `server/src/product-for-record.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/product-for-record.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { PRODUCT_SOURCES, hasProduct, productSql } from './product-for-record.js';
import { ENTITIES } from './record-entities.js';

// Same trick record-entities.test.js uses: the claims are checked against the
// real schema text, so a rename in db.js breaks this test rather than surfacing
// as a 500 the first time somebody opens a job card's file panel.
const SCHEMA = fs.readFileSync(new URL('./db.js', import.meta.url), 'utf8');

function createBlock(table) {
  const start = SCHEMA.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) return null;
  const end = SCHEMA.indexOf('\n);', start);
  return end < 0 ? null : SCHEMA.slice(start, end);
}
function hasColumn(table, col) {
  const block = createBlock(table);
  if (block && new RegExp(`^\\s*${col}\\s`, 'm').test(block)) return true;
  return new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col}\\b`).test(SCHEMA);
}

// ── the map describes reality ─────────────────────────────────────────
test('every resolvable entity is a real entity in the registry', () => {
  for (const key of Object.keys(PRODUCT_SOURCES)) {
    assert.ok(Object.prototype.hasOwnProperty.call(ENTITIES, key),
      `${key}: not a key in record-entities.js ENTITIES`);
  }
});

test('every table named by a source exists in db.js', () => {
  for (const [key, src] of Object.entries(PRODUCT_SOURCES)) {
    for (const table of src.tables) {
      assert.ok(createBlock(table), `${key}: no CREATE TABLE for '${table}' in db.js`);
    }
  }
});

test('every column named by a source exists on its own table', () => {
  for (const [key, src] of Object.entries(PRODUCT_SOURCES)) {
    for (const [table, col] of src.columns) {
      assert.ok(hasColumn(table, col), `${key}: ${table}.${col} does not exist`);
    }
  }
});

// ── the gate ──────────────────────────────────────────────────────────
test('records that carry a product are resolvable', () => {
  assert.equal(hasProduct('order_line'), true);
  assert.equal(hasProduct('job_card'), true);
  assert.equal(hasProduct('job_stage'), true);
  assert.equal(hasProduct('fg_lot'), true);
  assert.equal(hasProduct('shade_card'), true);
});

test('a dispatch has no single product — a challan spans many lines', () => {
  assert.equal(hasProduct('dispatch'), false);
});

test('procurement and billing records have no product, and that is correct', () => {
  assert.equal(hasProduct('purchase_order'), false);
  assert.equal(hasProduct('requisition'), false);
  assert.equal(hasProduct('grn'), false);
  assert.equal(hasProduct('invoice'), false);
  assert.equal(hasProduct('customer'), false);
  assert.equal(hasProduct('machine'), false);
});

test('junk and prototype keys never resolve', () => {
  assert.equal(hasProduct('constructor'), false);
  assert.equal(hasProduct('__proto__'), false);
  assert.equal(hasProduct(''), false);
  assert.equal(hasProduct(null), false);
});

test('productSql returns null rather than throwing for an unresolvable entity', () => {
  assert.equal(productSql('purchase_order'), null);
  assert.equal(productSql('constructor'), null);
  assert.match(productSql('order_line'), /SELECT product_id FROM order_lines/);
});

test('the job_stage source joins rather than inventing a column', () => {
  assert.match(productSql('job_stage'), /JOIN job_cards/);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -w server
```
Expected: `Cannot find module './product-for-record.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/product-for-record.js`:

```js
// ─── How a record reaches its product ────────────────────────────────────────
// Master files hang off a PRODUCT, so a record's panel needs to know which
// product it is about. THIS FILE is the closed list of what can answer that.
//
// An entity missing from this map has no product, and that is a fact about the
// plant rather than a gap: a board purchase order buys board, a challan spans
// many lines each with its own product, a machine is a machine. Those records
// show their own attachments and no master files.
//
// `tables` and `columns` exist so product-for-record.test.js can check every
// claim against db.js — a rename there must break the test, not the panel.
export const PRODUCT_SOURCES = {
  order_line: {
    sql: 'SELECT product_id FROM order_lines WHERE id = $1',
    tables: ['order_lines'], columns: [['order_lines', 'product_id']],
  },
  job_card: {
    sql: 'SELECT product_id FROM job_cards WHERE id = $1',
    tables: ['job_cards'], columns: [['job_cards', 'product_id']],
  },
  job_stage: {
    // job_stages carries no product of its own — it is a stage OF a job card.
    sql: `SELECT jc.product_id FROM job_stages js
          JOIN job_cards jc ON jc.id = js.job_card_id WHERE js.id = $1`,
    tables: ['job_stages', 'job_cards'],
    columns: [['job_stages', 'job_card_id'], ['job_cards', 'product_id']],
  },
  fg_lot: {
    sql: 'SELECT product_id FROM fg_lots WHERE id = $1',
    tables: ['fg_lots'], columns: [['fg_lots', 'product_id']],
  },
  shade_card: {
    sql: 'SELECT product_id FROM shade_cards WHERE id = $1',
    tables: ['shade_cards'], columns: [['shade_cards', 'product_id']],
  },
};

for (const spec of Object.values(PRODUCT_SOURCES)) Object.freeze(spec);
Object.freeze(PRODUCT_SOURCES);

// hasOwnProperty, never a bare lookup — the same guard record-entities.js uses,
// for the same reason: 'constructor' must not hand back a function that then
// gets interpolated into SQL.
export function hasProduct(entity) {
  return typeof entity === 'string'
    && Object.prototype.hasOwnProperty.call(PRODUCT_SOURCES, entity);
}

// null, not a throw: "this record has no product" is an ordinary answer that
// the panel renders as "own attachments only".
export function productSql(entity) {
  return hasProduct(entity) ? PRODUCT_SOURCES[entity].sql : null;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test -w server
```
Expected: all `product-for-record` tests pass. If the parity test fails on a table or column, **fix the map, not the test** — the test is reading the real schema.

- [ ] **Step 5: Commit**

```bash
git add server/src/product-for-record.js server/src/product-for-record.test.js
git commit -m "feat(files): how a record reaches its product, checked against the schema"
```

---

## Task 2: `record_files` schema

**Files:**
- Modify: `server/src/db.js`

- [ ] **Step 1: Add the table**

Append at the **end** of `init()` in `server/src/db.js`, after the Plan 1 block:

```js
  // ── What a NON-product record carries (2026-07-30) ──────────────────────────
  // Either its own attachment (file_id) or a PIN to a master version
  // (product_file_id). Never both, never neither.
  //
  // A LIVE master file is deliberately not a row here. A record's panel is
  // assembled on read as (own attachments) + (pins) + (the product's active
  // master files). That is what makes "the latest approved file travels with
  // every new record" cost zero writes and never drift — there is no copy to go
  // stale. Pinning is the only thing that writes, once, at lock.
  await pool.query(`
CREATE TABLE IF NOT EXISTS record_files (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  file_id INTEGER REFERENCES files(id),
  product_file_id INTEGER REFERENCES product_files(id) ON DELETE RESTRICT,
  category TEXT,
  note TEXT,
  pinned_at TIMESTAMPTZ,
  pinned_reason TEXT,
  uploaded_by TEXT,
  uploaded_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT,
  CHECK ((file_id IS NULL) <> (product_file_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_record_files_rec
  ON record_files (entity, entity_id) WHERE deleted_at IS NULL;

-- Backstop for double-pinning; the real idempotency is in pinRecordFiles().
CREATE UNIQUE INDEX IF NOT EXISTS ux_record_files_pin
  ON record_files (entity, entity_id, product_file_id)
  WHERE product_file_id IS NOT NULL AND deleted_at IS NULL;
`);
```

Note the `ON DELETE RESTRICT`: deleting a product whose artwork a record pinned is **refused**, which is correct for traceability. Products are deactivated (`active=0`) in this ERP, not deleted.

- [ ] **Step 2: Rebuild the baseline and replay it**

```bash
npm run db:baseline
npm run db:check -- --baseline
npm run verify
```
Expected: all green. `record_files` references `files` and `product_files`, both created by the Plan 1 block above it — a failure here means the block was inserted in the wrong place.

- [ ] **Step 3: Commit**

```bash
git status --short --branch
git add server/src/db.js supabase/migrations/0001_baseline_schema.sql
git commit -m "feat(files): record_files — attachments and pins on any record"
```

---

## Task 3: The panel read model

**Files:**
- Create: `server/src/panel-model.js`
- Test: `server/src/panel-model.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/panel-model.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemblePanel } from './panel-model.js';

const att = (id, name) => ({ id, file_id: 900 + id, file_name: name, category: 'supporting' });
const pin = (id, pfId, cat, ver) => ({
  id, product_file_id: pfId, category: cat, version_no: ver,
  file_id: 700 + pfId, file_name: `v${ver}.pdf`, pinned_reason: 'artwork_locked',
});
const master = (pfId, cat, ver) => ({
  id: pfId, category: cat, version_no: ver, file_id: 700 + pfId, file_name: `v${ver}.pdf`,
});

test('an unpinned record shows the master live — nothing was copied', () => {
  const p = assemblePanel({
    attachments: [], pins: [], activeMasters: [master(1, 'approved_artwork', 2)],
  });
  assert.equal(p.master.length, 1);
  assert.equal(p.master[0].version_no, 2);
  assert.equal(p.master[0].added_after_lock, false);
  assert.equal(p.pinned.length, 0);
});

test('a pinned record whose master has not moved shows no drift', () => {
  const p = assemblePanel({
    attachments: [], pins: [pin(1, 5, 'approved_artwork', 3)],
    activeMasters: [master(5, 'approved_artwork', 3)],
  });
  assert.equal(p.pinned[0].drift, null);
  assert.equal(p.master.length, 0, 'the pinned slot is not repeated as a live master');
});

test('a pinned record whose master moved on is flagged, never swapped', () => {
  const p = assemblePanel({
    attachments: [], pins: [pin(1, 5, 'approved_artwork', 2)],
    activeMasters: [master(6, 'approved_artwork', 3)],
  });
  assert.equal(p.pinned[0].version_no, 2, 'still reports what the job ran');
  assert.deepEqual(p.pinned[0].drift, { kind: 'moved', master_version: 3 });
  assert.equal(p.master.length, 0);
});

test('a slot filled after the lock is shown muted, not as drift', () => {
  const p = assemblePanel({
    attachments: [], pins: [pin(1, 5, 'approved_artwork', 2)],
    activeMasters: [master(5, 'approved_artwork', 2), master(9, 'output_file', 1)],
  });
  assert.equal(p.pinned.length, 1);
  assert.equal(p.master.length, 1);
  assert.equal(p.master[0].category, 'output_file');
  assert.equal(p.master[0].added_after_lock, true);
});

test('before any pin, a live master is not "added after lock"', () => {
  const p = assemblePanel({
    attachments: [], pins: [], activeMasters: [master(9, 'output_file', 1)],
  });
  assert.equal(p.master[0].added_after_lock, false);
});

test('own attachments pass through untouched', () => {
  const p = assemblePanel({
    attachments: [att(1, 'press-note.jpg')], pins: [], activeMasters: [],
  });
  assert.equal(p.attachments.length, 1);
  assert.equal(p.attachments[0].file_name, 'press-note.jpg');
});

test('a record with no product shows only its own attachments', () => {
  const p = assemblePanel({ attachments: [att(1, 'quote.pdf')], pins: [], activeMasters: null });
  assert.equal(p.attachments.length, 1);
  assert.deepEqual(p.master, []);
  assert.deepEqual(p.pinned, []);
});

test('the supporting drawer can hold several live masters at once', () => {
  const p = assemblePanel({
    attachments: [], pins: [],
    activeMasters: [master(1, 'supporting', 1), master(2, 'supporting', 2)],
  });
  assert.equal(p.master.length, 2);
});

test('is_pinned tells the client whether this record is frozen at all', () => {
  assert.equal(assemblePanel({ attachments: [], pins: [], activeMasters: [] }).is_pinned, false);
  assert.equal(
    assemblePanel({ attachments: [], pins: [pin(1, 5, 'approved_artwork', 1)], activeMasters: [] }).is_pinned,
    true);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -w server
```
Expected: `Cannot find module './panel-model.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/panel-model.js`:

```js
// ─── A record's file panel, assembled ────────────────────────────────────────
// Rows in, panel out. Spec §7's one rule: SHOW THE PIN, AND SHOW HOW THE MASTER
// DIFFERS FROM IT. A pinned slot is never replaced by a newer master — it is
// reported as what the job actually ran, with the newer version flagged beside
// it. That is the difference between a traceable plant and a system that
// silently rewrites finished work.
import { driftFor } from './master-files.js';

export function assemblePanel({ attachments = [], pins = [], activeMasters = null }) {
  const masters = activeMasters ?? [];
  const isPinned = pins.length > 0;

  // Slots this record froze. Each keeps its own version and gains a drift note
  // when the master has since moved past it.
  const pinnedBySlot = new Map();
  for (const p of pins) pinnedBySlot.set(p.category, p);

  const pinned = pins.map(p => {
    const active = masters.find(m => m.category === p.category);
    return { ...p, drift: driftFor({
      pinnedVersionNo: p.version_no, activeVersionNo: active?.version_no ?? null,
    }) };
  });

  // Live master files: only slots this record has NOT pinned. Once a record is
  // pinned at all, anything still live arrived after the lock and is labelled
  // so nobody mistakes it for what the job ran on.
  const master = masters
    .filter(m => !pinnedBySlot.has(m.category))
    .map(m => ({ ...m, added_after_lock: isPinned }));

  return { attachments, pinned, master, is_pinned: isPinned };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test -w server
```

- [ ] **Step 5: Commit**

```bash
git add server/src/panel-model.js server/src/panel-model.test.js
git commit -m "feat(files): assemble a record's panel — show the pin, flag the drift"
```

---

## Task 4: Record endpoints

**Files:**
- Modify: `server/src/routes/files.js`

- [ ] **Step 1: Add the endpoints**

Append to `server/src/routes/files.js`, before `export default r;`:

```js
// ── A record's file panel ────────────────────────────────────────────────────
import { entityOr400 } from '../record-entities.js';
import { productSql, hasProduct } from '../product-for-record.js';
import { assemblePanel } from '../panel-model.js';

// The SQL is chosen by the closed map in product-for-record.js and never comes
// from the request, so an entity key is not a place a caller can inject.
export async function productIdFor(entity, id) {
  const sql = productSql(entity);
  if (!sql) return null;
  const row = await one(sql, [id]);
  return row?.product_id ?? null;
}

r.get('/records/:entity/:id(\\d+)/files', async (req, res, next) => {
  try {
    const { entity, id } = req.params;
    entityOr400(entity);   // 400 before anything reaches SQL

    const attachments = await q(`
      SELECT rf.id, rf.category, rf.note, rf.uploaded_by, rf.created_at,
             f.id AS file_id, f.file_name, f.mime, f.size_bytes
      FROM record_files rf JOIN files f ON f.id = rf.file_id
      WHERE rf.entity=$1 AND rf.entity_id=$2 AND rf.deleted_at IS NULL
        AND rf.file_id IS NOT NULL
      ORDER BY rf.created_at DESC`, [entity, id]);

    const pins = await q(`
      SELECT rf.id, rf.product_file_id, rf.pinned_at, rf.pinned_reason,
             pf.category, pf.version_no, pf.created_by, pf.created_at,
             f.id AS file_id, f.file_name, f.mime, f.size_bytes
      FROM record_files rf
      JOIN product_files pf ON pf.id = rf.product_file_id
      JOIN files f ON f.id = pf.file_id
      WHERE rf.entity=$1 AND rf.entity_id=$2 AND rf.deleted_at IS NULL
        AND rf.product_file_id IS NOT NULL
      ORDER BY pf.category`, [entity, id]);

    const productId = await productIdFor(entity, id);
    const activeMasters = productId === null ? null : await q(`
      SELECT pf.id, pf.category, pf.version_no, pf.created_by, pf.created_at,
             f.id AS file_id, f.file_name, f.mime, f.size_bytes, f.checksum
      FROM product_files pf JOIN files f ON f.id = pf.file_id
      WHERE pf.product_id=$1 AND pf.status='active'
      ORDER BY pf.category`, [productId]);

    res.json({ ...assemblePanel({ attachments, pins, activeMasters }), product_id: productId });
  } catch (e) { next(e); }
});

// Attach a committed file to a record. Tier 1 — any signed-in user.
r.post('/records/:entity/:id(\\d+)/files', async (req, res, next) => {
  try {
    const { entity, id } = req.params;
    entityOr400(entity);
    const { file_id, category = 'supporting', note = null } = req.body ?? {};
    const catErr = categoryError(category);
    if (catErr) throw bad(catErr);

    const file = await one('SELECT id, status, file_name FROM files WHERE id=$1', [file_id]);
    if (!file) throw bad('That file is no longer available', 404);
    if (file.status !== 'ready') throw bad('That upload has not finished yet');

    const row = await one(`
      INSERT INTO record_files (entity, entity_id, file_id, category, note,
                                uploaded_by, uploaded_by_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [entity, id, file_id, category, note, req.user.name, req.user.id]);

    await q(`INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
             VALUES ($1,$2,'file_attached',$3,$4)`,
      [entity, id, `${CATEGORIES[category].label} — ${file.file_name}`, req.user.name]);

    res.json({ record_file: row });
  } catch (e) { next(e); }
});

// Soft delete. Own attachment within the 10-minute window the messenger already
// uses (chat-rules.REMOVAL_WINDOW_MS), or any attachment for a master_files
// holder. A PIN is never removable — it is the record of what the job ran on.
r.delete('/record-files/:id(\\d+)', async (req, res, next) => {
  try {
    const rf = await one('SELECT * FROM record_files WHERE id=$1 AND deleted_at IS NULL',
      [req.params.id]);
    if (!rf) throw bad('That file is no longer attached', 404);
    if (rf.product_file_id) {
      throw bad('This is the master file this record was locked against and cannot be removed', 409);
    }
    const mine = +rf.uploaded_by_id === +req.user.id;
    const fresh = Date.now() - new Date(rf.created_at).getTime() < REMOVAL_WINDOW_MS;
    if (!(+req.user.master_files === 1 || (mine && fresh))) {
      throw bad('Attachments can only be removed by the person who added them, within 10 minutes', 403);
    }
    await q(`UPDATE record_files SET deleted_at=now(), deleted_by=$2 WHERE id=$1`,
      [rf.id, req.user.name]);
    await q(`INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
             VALUES ($1,$2,'file_removed',$3,$4)`,
      [rf.entity, rf.entity_id, `record_file ${rf.id}`, req.user.name]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
```

Add the `REMOVAL_WINDOW_MS` import at the top of the file, beside the others:

```js
import { REMOVAL_WINDOW_MS } from '../chat-rules.js';
```

- [ ] **Step 2: Verify**

```bash
npm test -w server && npm run build -w client
```

- [ ] **Step 3: Prove the panel by hand**

With the dev server running, a product that has a promoted master file, and an order line for that product:

```bash
curl -sS localhost:4000/api/records/order_line/1/files -H "authorization: Bearer $T"
```
Expected: `master` holds the active version with `"added_after_lock":false`, `pinned` is `[]`, `is_pinned` is `false`. Then:

```bash
curl -sS localhost:4000/api/records/purchase_order/1/files -H "authorization: Bearer $T"
```
Expected: `"product_id":null`, `master` and `pinned` both `[]` — correct, a board PO has no product.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/files.js
git commit -m "feat(files): every record can show its files, master ones included"
```

---

## Task 5: The prompt payload

**Files:**
- Modify: `server/src/routes/files.js`

- [ ] **Step 1: Return the prompt from commit**

In the commit handler written in Plan 1 Task 6, replace the final `res.json({ file: ready })` with the block below. `shouldPromptMaster` is already built and tested in Plan 1 Task 1.

```js
    // Spec §6 — ask only when all four conditions hold. Deliberately states
    // FACTS about the current master rather than inferring that this file is
    // "newer": one wrong "this is newer" teaches the plant to click through the
    // prompt without reading it.
    const productId = req.body?.entity
      ? await productIdFor(req.body.entity, req.body.entity_id)
      : (req.body?.product_id ?? null);

    const active = productId && CATEGORIES[req.body?.category]?.slot
      ? await one(`
          SELECT pf.id, pf.version_no, pf.created_by, pf.created_at,
                 f.file_name, f.checksum
          FROM product_files pf JOIN files f ON f.id = pf.file_id
          WHERE pf.product_id=$1 AND pf.category=$2 AND pf.status='active'`,
          [productId, req.body.category])
      : null;

    const prompt = shouldPromptMaster({
      productId,
      category: req.body?.category,
      canMaster: +req.user.master_files === 1,
      activeChecksum: active?.checksum ?? null,
      checksum: ready.checksum,
    })
      ? {
          product_id: productId,
          category: req.body.category,
          category_label: CATEGORIES[req.body.category].label,
          current: active && {
            version_no: active.version_no, file_name: active.file_name,
            created_by: active.created_by, created_at: active.created_at,
          },
          next_version: (active?.version_no ?? 0) + 1,
        }
      : null;

    // Identical bytes are already the master — link that version rather than
    // storing a second copy of the same file.
    const same = active && ready.checksum && active.checksum === ready.checksum
      ? { product_file_id: active.id, version_no: active.version_no } : null;

    res.json({ file: ready, prompt, same_as_master: same });
```

Add `shouldPromptMaster` to the existing `file-rules.js` import at the top of the file.

- [ ] **Step 2: Verify**

```bash
npm test -w server
```

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/files.js
git commit -m "feat(files): commit answers whether to ask about the master"
```

---

## Task 6: Pinning

**Files:**
- Create: `server/src/pin-files.js`
- Modify: `server/src/routes/orders.js`, `server/src/helpers.js`

- [ ] **Step 1: Write the pin module**

Create `server/src/pin-files.js`:

```js
// ─── Freezing a record's master files ────────────────────────────────────────
// A record shows the LATEST master while it is still open, and freezes the
// exact versions the moment it becomes binding. After that a newer master is
// flagged beside the pin, never swapped in — so a job card that printed 40,000
// pieces against v2 keeps saying v2 forever.
//
// Only TWO things pin: artwork lock and job-card finalise. A dispatch does not:
// `dispatches` has no product_id (a challan spans many lines, each with its own
// product), and every dispatch_line points at an order_line that was already
// pinned at artwork lock — so the chain challan → line → pin already proves
// what was shipped. See spec §7.
import { q, one } from './db.js';
import { productIdFor } from './routes/files.js';

// Idempotent by design: a record that already carries a pin is left alone, so
// re-locking never double-pins and never re-points a job at a newer master.
export async function pinRecordFiles(entity, entityId, reason, userName = null) {
  const existing = await one(
    `SELECT 1 FROM record_files
     WHERE entity=$1 AND entity_id=$2 AND product_file_id IS NOT NULL
       AND deleted_at IS NULL LIMIT 1`, [entity, entityId]);
  if (existing) return { pinned: 0, already: true };

  const productId = await productIdFor(entity, entityId);
  if (!productId) return { pinned: 0, already: false };

  const res = await q(`
    INSERT INTO record_files (entity, entity_id, product_file_id, pinned_at,
                              pinned_reason, uploaded_by)
    SELECT $1, $2, pf.id, now(), $3, $4
    FROM product_files pf
    WHERE pf.product_id = $5 AND pf.status = 'active'
    ON CONFLICT DO NOTHING
    RETURNING id`, [entity, entityId, reason, userName, productId]);

  if (res.length) {
    await q(`INSERT INTO audit_log (entity, entity_id, action, detail, user_name)
             VALUES ($1,$2,'files_pinned',$3,$4)`,
      [entity, entityId, `${res.length} master file(s) — ${reason}`, userName]);
  }
  return { pinned: res.length, already: false };
}

// Rollback genuinely reopens the record, so its pins go with it. Hard delete,
// not a tombstone: these rows recorded a lock that no longer happened.
export async function unpinRecordFiles(entity, entityId) {
  await q(`DELETE FROM record_files
           WHERE entity=$1 AND entity_id=$2 AND product_file_id IS NOT NULL`,
    [entity, entityId]);
}
```

- [ ] **Step 2: Pin at artwork lock**

Find where `artwork_locked` is set to 1 in `server/src/routes/orders.js`:

```bash
grep -n "artwork_locked" server/src/routes/orders.js
```

After the UPDATE that sets `artwork_locked=1` succeeds, add:

```js
    await pinRecordFiles('order_line', line.id, 'artwork_locked', req.user.name);
```

with the import at the top:

```js
import { pinRecordFiles } from '../pin-files.js';
```

- [ ] **Step 3: Pin at job-card finalise**

Find the finalise endpoint that uses `finaliseBlock`:

```bash
grep -rn "finaliseBlock" server/src/routes server/src/helpers.js
```

After a successful finalise, add the same call for the job card:

```js
    await pinRecordFiles('job_card', jc.id, 'jc_finalised', req.user.name);
```

- [ ] **Step 4: Unpin on rollback**

Find where `artwork_locked` is reset to 0 — `helpers.js` line ~1238 already resets the planning/artwork locks during the force-unwind:

```bash
grep -n "artwork_locked=0" server/src/helpers.js
```

Add beside it:

```js
  await unpinRecordFiles('order_line', line.id);
```

Check whether that function has a transaction-scoped query helper in scope; if it does, use it rather than the module-level `q`, so the unwind stays atomic.

- [ ] **Step 5: Verify the whole flow in the running app**

```bash
npm run dev
```
1. Promote an approved artwork on a product (Masters → Products).
2. Open a line for that product in Artwork — the panel shows `MASTER · v1`, no pin.
3. Lock artwork — the panel now shows the same file as pinned.
4. Promote a **replacement** artwork on the product as v2.
5. Reopen the locked line — it still shows **v1**, now with `Master moved to v2 · this job ran v1` in amber.

That fifth step is the whole point of the feature. If it swaps to v2, stop and fix before continuing.

- [ ] **Step 6: Verify and commit**

```bash
npm test -w server && npm run build -w client
git add server/src/pin-files.js server/src/routes/orders.js server/src/helpers.js
git commit -m "feat(files): freeze the master files a record was locked against"
```

---

## Task 7: The panel component

**Files:**
- Create: `client/src/components/FilePanel.jsx`

- [ ] **Step 1: Write it**

Create `client/src/components/FilePanel.jsx`:

```jsx
// ─── A record's files ────────────────────────────────────────────────────────
// Mounted by (entity, id), the same way ThreadCell mounts on 13 surfaces.
// Master files are visually distinct from this record's own attachments — an
// operator must never confuse "the approved artwork" with "a photo somebody
// stapled to this job".
import { useCallback, useEffect, useState } from 'react';
import { Upload, Eye, Download, Trash2, Loader2, AlertTriangle } from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { Button, Select } from './ui.jsx';
import FileViewer from './FileViewer.jsx';
import UpdateMasterPrompt from './UpdateMasterPrompt.jsx';
import { uploadFile, pickError, CATEGORY_LABEL } from '../lib/upload.js';

const mb = n => (n / (1024 * 1024)).toFixed(1);
const CATEGORIES = Object.keys(CATEGORY_LABEL);

export default function FilePanel({ entity, id, readOnly = false, title = 'Files' }) {
  const [panel, setPanel] = useState(null);
  const [category, setCategory] = useState('supporting');
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [prompt, setPrompt] = useState(null);   // { prompt, file }

  const load = useCallback(async () => {
    setPanel(await api.get(`/records/${entity}/${id}/files`));
  }, [entity, id]);

  useEffect(() => { if (entity && id) load(); }, [entity, id, load]);

  async function onPick(file) {
    setErr(null);
    const e = pickError(category, file);
    if (e) return setErr(e);
    setBusy(true); setPct(0);
    try {
      const res = await uploadFile({
        file, category, productId: panel?.product_id ?? null,
        entity, entityId: id, onProgress: setPct,
      });
      // The server decides whether the master question is worth asking.
      if (res.prompt) return setPrompt({ prompt: res.prompt, file: res.file });
      await api.post(`/records/${entity}/${id}/files`, { file_id: res.file.id, category });
      await load();
    } catch (e2) {
      setErr(e2.message || 'Upload failed');
    } finally { setBusy(false); setPct(0); }
  }

  if (!panel) return null;

  const Row = ({ f, chip, tint, drift, muted, onDelete }) => (
    <div className={`mt-2 flex flex-wrap items-center gap-2 text-xs ${muted ? 'opacity-60' : ''}`}>
      {chip && <span className={`rounded-full px-2 py-0.5 font-semibold ${tint}`}>{chip}</span>}
      <span className="font-medium text-[#1D1D1F]">{f.file_name}</span>
      <span className="text-[#1D1D1F]/50">{mb(f.size_bytes)} MB</span>
      <span className="text-[#1D1D1F]/50">
        {f.created_by || f.uploaded_by} · {fmt.dt(f.created_at)}
      </span>
      {drift && (
        <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">
          <AlertTriangle className="h-3 w-3" />
          Master moved to v{drift.master_version} · this job ran v{f.version_no}
        </span>
      )}
      <div className="flex-1" />
      <Button variant="secondary" onClick={() => setViewing(f)}><Eye className="h-4 w-4" /></Button>
      <a href={api.url(`/files/${f.file_id}/download?entity=${entity}&entity_id=${id}`)}>
        <Button variant="secondary"><Download className="h-4 w-4" /></Button>
      </a>
      {onDelete && <Button variant="secondary" onClick={onDelete}><Trash2 className="h-4 w-4" /></Button>}
    </div>
  );

  return (
    <div className="ci-line-item">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-[#1D1D1F]">{title}</div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            <Select value={category} onChange={e => setCategory(e.target.value)}
              options={CATEGORIES.map(c => ({ value: c, label: CATEGORY_LABEL[c] }))} />
            <label>
              <input type="file" className="hidden" disabled={busy}
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f); }} />
              <Button as="span" disabled={busy}>
                {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> {Math.round(pct * 100)}%</>
                      : <><Upload className="h-4 w-4" /> Add file</>}
              </Button>
            </label>
          </div>
        )}
      </div>

      {err && <div className="mt-2 text-xs text-rose-600">{err}</div>}

      {/* Pinned master versions — what this record was locked against. */}
      {panel.pinned.map(f => (
        <Row key={`p${f.id}`} f={f} drift={f.drift}
          chip={`MASTER · v${f.version_no}`} tint="bg-indigo-50 text-indigo-600" />
      ))}

      {/* Live master files, straight from the Product Master. */}
      {panel.master.map(f => (
        <Row key={`m${f.id}`} f={f} muted={f.added_after_lock}
          chip={f.added_after_lock
            ? `MASTER · v${f.version_no} · added after lock`
            : `MASTER · v${f.version_no}`}
          tint="bg-indigo-50 text-indigo-600" />
      ))}

      {/* This record's own attachments. */}
      {panel.attachments.map(f => (
        <Row key={`a${f.id}`} f={f}
          chip={CATEGORY_LABEL[f.category] ?? 'File'} tint="bg-slate-100 text-slate-600"
          onDelete={readOnly ? null : async () => {
            await api.del(`/record-files/${f.id}`); await load();
          }} />
      ))}

      {!panel.pinned.length && !panel.master.length && !panel.attachments.length && (
        <div className="mt-2 text-xs text-[#1D1D1F]/50">No files yet</div>
      )}

      <FileViewer file={viewing} open={!!viewing} onClose={() => setViewing(null)} />
      <UpdateMasterPrompt
        open={!!prompt} data={prompt?.prompt} file={prompt?.file}
        entity={entity} entityId={id}
        onDone={async () => { setPrompt(null); await load(); }}
        onCancel={() => setPrompt(null)}
      />
    </div>
  );
}
```

- [ ] **Step 2: Pass `entity`/`entityId` through the upload helper**

`uploadFile` in `client/src/lib/upload.js` (Plan 1 Task 8) must forward `entity` and `entity_id` to the **commit** call so the server can resolve the product for the prompt:

```js
export async function uploadFile({ file, category, productId = null, entity = null, entityId = null, onProgress }) {
```
and in the commit call:

```js
  return api.post(`/files/${signed.file_id}/commit`, {
    entity, entity_id: entityId, product_id: productId, category,
  });
}
```

- [ ] **Step 3: Verify the build**

```bash
npm run build -w client
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/FilePanel.jsx client/src/lib/upload.js
git commit -m "feat(files): the file panel any record can mount"
```

---

## Task 8: The Update Master? prompt

**Files:**
- Create: `client/src/components/UpdateMasterPrompt.jsx`

- [ ] **Step 1: Match the existing modal first**

This must read like the question the plant already answers. Open the existing one and copy its shape and wording:

```bash
sed -n '715,750p' client/src/pages/Artwork.jsx
```

- [ ] **Step 2: Write it**

Create `client/src/components/UpdateMasterPrompt.jsx`:

```jsx
// ─── Update Master? ──────────────────────────────────────────────────────────
// The same fork the plant already answers for artwork codes and output numbers
// (Artwork.jsx "Sync Master?"), applied to files. Deliberately states FACTS —
// which version the master holds, who promoted it, when, and both filenames —
// rather than claiming this file "appears to be newer". The system cannot know
// that, and one wrong claim teaches people to click through without reading.
import { useState } from 'react';
import { api, fmt } from '../api.js';
import { Modal, Button, Input } from './ui.jsx';

export default function UpdateMasterPrompt({
  open, data, file, entity, entityId, onDone, onCancel,
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!data || !file) return null;

  const run = async fn => {
    setBusy(true); setErr(null);
    try { await fn(); await onDone(); }
    catch (e) { setErr(e.message || 'Something went wrong'); }
    finally { setBusy(false); }
  };

  const updateMaster = () => run(async () => {
    await api.post(`/products/${data.product_id}/files/promote`, {
      file_id: file.id, category: data.category, reason: reason || null,
      from: { entity, entity_id: entityId },
    });
  });

  const thisJobOnly = () => run(async () => {
    await api.post(`/records/${entity}/${entityId}/files`, {
      file_id: file.id, category: data.category,
    });
  });

  const cancel = () => run(async () => {
    await api.del(`/files/${file.id}`);
    onCancel();
  });

  return (
    <Modal open={open} onClose={cancel} title="Update Master?"
      footer={
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={cancel} disabled={busy}>Cancel</Button>
          <Button variant="secondary" onClick={thisJobOnly} disabled={busy}>This Job Only</Button>
          <Button onClick={updateMaster} disabled={busy}>Update Master</Button>
        </div>
      }>
      <div className="flex flex-col gap-3 text-sm">
        {data.current ? (
          <div>
            The Product Master holds <b>{data.category_label} v{data.current.version_no}</b>,
            promoted {fmt.dt(data.current.created_at)} by {data.current.created_by} —{' '}
            <span className="font-mono text-xs">{data.current.file_name}</span>.
            <div className="mt-1">
              Replace it with <span className="font-mono text-xs">{file.file_name}</span>{' '}
              as <b>v{data.next_version}</b>?
            </div>
          </div>
        ) : (
          <div>
            Save this as the <b>{data.category_label}</b> in the Product Master?
            It will then travel with every future job for this product.
          </div>
        )}

        <Input label="Reason for replacement (optional)" value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="e.g. customer revised the barcode panel" />

        <div className="text-xs text-[#1D1D1F]/60">
          “This Job Only” keeps the file on this record; the Product Master keeps its
          current version. Records already locked against an older version are never
          changed — they are flagged instead.
        </div>

        {err && <div className="text-xs text-rose-600">{err}</div>}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 3: Verify in the running app**

```bash
npm run dev
```
As a user **with** `master_files`, upload an approved artwork from the Artwork page for a product that already has one. Confirm:
- the modal says which version the master holds, who promoted it and when, and shows **both** filenames
- it never says the words "appears to be newer"
- **Update Master** creates v2 and the Masters → Products history shows the reason and `(from order_line)`
- **This Job Only** leaves the master at v1 and attaches the file to the line
- **Cancel** leaves neither — reload and confirm the file is gone

As a user **without** `master_files`, the same upload attaches silently with no modal.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/UpdateMasterPrompt.jsx
git commit -m "feat(files): the Update Master? fork, on the plant's own wording"
```

---

## Task 9: Mount the panel

**Files:** nine page files

- [ ] **Step 1: Mount, one surface at a time**

Each is the same one-line mount. Do them in this order and check the app after each — a panel on the wrong entity is worse than no panel.

| # | File | Mount | Notes |
|---|---|---|---|
| 1 | `client/src/pages/Artwork.jsx` | `<FilePanel entity="order_line" id={line.id} />` | The most important one — do it first and verify fully |
| 2 | `client/src/pages/Planning.jsx` | `<FilePanel entity="order_line" id={line.id} />` | |
| 3 | `client/src/pages/Orders.jsx` | `<FilePanel entity="order_line" id={line.id} />` | Per line, not per order |
| 4 | `client/src/pages/Production.jsx` | `<FilePanel entity="job_card" id={jc.id} />` | |
| 5 | `client/src/pages/PrintPlanning.jsx` | `<FilePanel entity="job_card" id={jc.id} />` | |
| 6 | `client/src/pages/Section.jsx` | `<FilePanel entity="job_card" id={jc.id} readOnly />` | Operators view, never promote |
| 7 | `client/src/pages/Floor.jsx` | `<FilePanel entity="job_card" id={jc.id} readOnly />` | |
| 8 | `client/src/pages/Procurement.jsx` | `<FilePanel entity="purchase_order" id={po.id} />` | No product — own attachments only, by design |
| 9 | `client/src/pages/Dispatch.jsx` | `<FilePanel entity="dispatch" id={d.id} readOnly />` | Read-through; a challan pins nothing (spec §7) |

Import in each:

```jsx
import FilePanel from '../components/FilePanel.jsx';
```

Find the right place in each page — inside the detail drawer or expanded row, near the existing `<ThreadCell>` where there is one:

```bash
grep -rn "ThreadCell" client/src/pages | head -20
```

- [ ] **Step 2: Add it to the Job Card print**

`client/src/pages/JobCardPrint.jsx` should list the pinned master files by name and version — **not** the panel, which has buttons. A printed job card naming "Approved Artwork v2" is what makes the pin useful on the floor.

- [ ] **Step 3: Verify each surface in the running app**

For each of the nine, sign in and confirm the panel appears, lists the right files, and that Procurement shows only its own attachments with no master section.

- [ ] **Step 4: Commit**

```bash
npm run build -w client
git status --short --branch
git add client/src/pages
git commit -m "feat(files): master files travel to every module that needs them"
```

---

## Task 10: Verify and deploy

- [ ] **Step 1: Full verification**

```bash
npm run verify
```
Expected: baseline fresh, all server tests pass, client builds.

- [ ] **Step 2: The end-to-end rehearsal, locally**

This is the acceptance test for the whole two-plan feature:

1. Promote an approved artwork and an output file on a product.
2. Create an order line for that product → both appear in Planning, live, with no upload.
3. Lock artwork → both pin.
4. Create and finalise a job card → it pins too.
5. Promote a **new** approved artwork (v2) from the Artwork page via *Update Master*.
6. The locked line and the finalised job card **still show v1**, flagged amber.
7. A **new** order line for the same product shows v2 live.
8. Masters → Products history shows v1 archived with its reason and `(from order_line)`.

Step 6 is the one that matters. If anything silently shows v2, stop.

- [ ] **Step 3: Deploy**

Following `DEPLOYMENT.md` §3:

```bash
npm run db:backup
npm run db:check
```
Create `supabase/migrations/0011_record_files.sql` from the Task 2 SQL block, confirm the target project ref in the output, and apply. Then deploy and verify:

```bash
npm run deploy:prod
curl -I -L https://motionci.in
curl -sS https://motionci.in/api/health
```

- [ ] **Step 4: Verify on production**

Sign in to `motionci.in` and repeat the rehearsal from Step 2 on a real product, including one upload over 10 MB.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0011_record_files.sql
git commit -m "feat(files): auto-sync migration for production"
```

---

## Self-review notes

Checked against the spec:

| Spec section | Covered by |
|---|---|
| §3 `record_files`, `ON DELETE RESTRICT` | Task 2 |
| §5 commit returns the prompt | Task 5 |
| §6 the *Update Master?* prompt, all three outcomes, the no-prompt-when-identical case | Tasks 5, 8 |
| §7 pinning at two triggers, idempotency, rollback | Task 6 |
| §7 drift: moved / added-after-lock / no silent swap | Tasks 3, 7 |
| §7 dispatch is read-through, not a third pin | Task 1 (`hasProduct('dispatch') === false`), Task 9 row 9 |
| §8 record endpoints and the panel read model | Task 4 |
| §9 `<FilePanel>`, the two visual groups, nine mount points | Tasks 7, 9 |
| §10 tier 1 attach; pins never removable; 10-minute own-attachment window | Task 4 |
| §11 audit `file_attached` / `file_removed` / `files_pinned` | Tasks 4, 6 |
| §13 `product-for-record` parity test, pin idempotency | Tasks 1, 6 |

**Correction carried into this plan.** The spec originally named "dispatch created" as a third pin trigger. `dispatches` has no `product_id` — a challan hangs off an order and spans many `dispatch_lines`, each with its own product — so it was unbuildable, and redundant besides, since every dispatch line points at an already-pinned `order_line`. The spec was corrected on 2026-07-30 (§7, "Dispatch is read-through, not a third pin") and this plan implements the corrected design.

**Assumptions to check on contact with the code**, each with a `grep` step immediately before it: the `artwork_locked=1` and `finaliseBlock` call sites (Task 6), the transaction helper in scope during the force-unwind (Task 6 Step 4), `api.del`/`api.url`/`Select` props (Tasks 4, 7), and where each page holds its record id (Task 9).
