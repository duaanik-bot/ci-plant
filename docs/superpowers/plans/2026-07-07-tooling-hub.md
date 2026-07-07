# Tooling Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the unified Tooling Hub module (`/tooling`) in ci-erp — one custody lifecycle for dies, plate sets, blocks and shade cards — wired into the existing artwork/readiness gate, per the approved spec at `docs/superpowers/specs/2026-07-07-tooling-hub-design.md`.

**Architecture:** New `tools` + `tool_events` tables replace the flat `dies` master (data migrated in place, `dies` kept dormant). A pure gate module (`server/src/tooling-gate.js`) derives each product's required tooling and is shared by `readiness()`, the new `routes/tooling.js`, the `/artwork` enrichment and the `/track` timeline. One new client page (`Tooling.jsx`) renders a 4-zone Kanban + ledger in the Liquid Glass design system.

**Tech Stack:** Express + pg (embedded Postgres), React 18 + Vite + Tailwind (existing `ui.jsx` kit), `node:test` for pure-function tests (Node v22, no framework installed).

**Gate-semantics refinement vs the spec (approved direction, refined for real data):** the local DB holds real plant data with dies only — no plates/blocks/shade cards exist yet. If all four families hard-blocked the gate, every live line would freeze the moment this ships. So: **die is a HARD requirement** (must exist + be ready — matches today's behaviour), **plate/block/shade card are SOFT** (they block only when a tool is *registered* but not ready; when untracked they inform, never block). `tooling_ok` stays as the absolute manual override. Update the spec's §3 wording to match when this plan lands (Task 12).

**Working conventions for every task:**
- Repo root: `/Users/anikdua/Documents/Projects/Colour Imp Production/Colour Imp Production/ci-erp`
- There is a large pile of PRE-EXISTING uncommitted changes (v6 work). **Never `git add -A`.** Stage only the files each task names.
- Server auto-creates schema on boot (`init()` in `db.js` runs the DDL). To exercise the API: `preview_start` config `ci-erp` (server :4000 + client :5173). Login: `admin@ci.local` / `admin123` → `POST /api/auth/login` returns `{ token }`; pass `Authorization: Bearer <token>`.
- `q(sql, params)` returns rows array; `one(sql, params)` returns first row or undefined; `tx(fn)` gives `(qc, oc)` transaction-bound variants.

---

### Task 1: Pure gate module — `tooling-gate.js` (TDD)

**Files:**
- Create: `server/src/tooling-gate.js`
- Test: `server/src/tooling-gate.test.js`
- Modify: `server/package.json` (add test script)

- [ ] **Step 1: Add the test script**

In `server/package.json`, add to `"scripts"`:

```json
    "test": "node --test src/"
```

- [ ] **Step 2: Write the failing tests**

Create `server/src/tooling-gate.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredFamilies, toolReady, toolingDetail, toolingGateOk, TOOL_FAMILIES, TOOL_ZONES } from './tooling-gate.js';

const mkTool = (over = {}) => ({
  id: 1, family: 'die', code: 'DIE-0001', title: 'Test die', product_id: 10,
  zone: 'in_rack', condition: 'Good', active: 1, ...over,
});

test('requiredFamilies: plain product needs die, plate, shade card — no block', () => {
  assert.deepEqual(requiredFamilies({ special: 'none' }), ['die', 'plate', 'shade_card']);
});

test('requiredFamilies: foil/emboss products also need a block', () => {
  for (const special of ['foil', 'emboss', 'foil_emboss']) {
    assert.ok(requiredFamilies({ special }).includes('block'), special);
  }
});

test('toolReady: ready only when active, healthy and in rack / on floor', () => {
  assert.equal(toolReady(mkTool()), true);
  assert.equal(toolReady(mkTool({ zone: 'on_floor' })), true);
  assert.equal(toolReady(mkTool({ zone: 'making' })), false);
  assert.equal(toolReady(mkTool({ zone: 'incoming' })), false);
  assert.equal(toolReady(mkTool({ condition: 'Poor' })), false);
  assert.equal(toolReady(mkTool({ condition: 'Scrapped' })), false);
  assert.equal(toolReady(mkTool({ active: 0 })), false);
  assert.equal(toolReady(null), false);
});

test('toolingDetail: statuses per family — ready / not_ready / missing', () => {
  const product = { id: 10, special: 'foil', tool_id: 1 };
  const tools = [
    mkTool(),                                                        // die ready
    mkTool({ id: 2, family: 'plate', code: 'PLT-0001', zone: 'making' }), // plate at maker
    // no block, no shade card
  ];
  const d = toolingDetail(product, tools);
  const by = Object.fromEntries(d.map(x => [x.family, x]));
  assert.equal(by.die.status, 'ready');
  assert.equal(by.die.hard, true);
  assert.equal(by.plate.status, 'not_ready');
  assert.equal(by.plate.zone, 'making');
  assert.equal(by.block.status, 'missing');
  assert.equal(by.shade_card.status, 'missing');
  assert.equal(by.die.code, 'DIE-0001');
});

test('toolingDetail: die matched via products.tool_id link, not just product_id', () => {
  // Real migrated dies have product_id NULL — the product points at them.
  const product = { id: 10, special: 'none', tool_id: 7 };
  const d = toolingDetail(product, [mkTool({ id: 7, product_id: null })]);
  assert.equal(d.find(x => x.family === 'die').status, 'ready');
});

test('gate: hard die must be ready; missing soft families never block', () => {
  const product = { id: 10, special: 'none', tool_id: 1 };
  // die ready, plate & shade card untracked → gate passes
  assert.equal(toolingGateOk(toolingDetail(product, [mkTool()]), 0), true);
  // die missing → gate fails
  assert.equal(toolingGateOk(toolingDetail(product, []), 0), false);
  // die at vendor → gate fails
  assert.equal(toolingGateOk(toolingDetail(product, [mkTool({ zone: 'making' })]), 0), false);
});

test('gate: a registered soft tool that is not ready blocks', () => {
  const product = { id: 10, special: 'none', tool_id: 1 };
  const tools = [mkTool(), mkTool({ id: 2, family: 'plate', code: 'PLT-0001', zone: 'making' })];
  assert.equal(toolingGateOk(toolingDetail(product, tools), 0), false);
  // …and passes once the plate reaches the rack
  tools[1].zone = 'in_rack';
  assert.equal(toolingGateOk(toolingDetail(product, tools), 0), true);
});

test('gate: manual tooling_ok override is absolute', () => {
  assert.equal(toolingGateOk(toolingDetail({ id: 10, special: 'none', tool_id: null }, []), 1), true);
});

test('constants: four families with prefixes, four zones', () => {
  assert.deepEqual(Object.keys(TOOL_FAMILIES), ['die', 'plate', 'block', 'shade_card']);
  assert.deepEqual(TOOL_ZONES, ['incoming', 'making', 'in_rack', 'on_floor']);
  assert.equal(TOOL_FAMILIES.plate.prefix, 'PLT-');
});
```

- [ ] **Step 3: Run tests — verify they fail**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module './tooling-gate.js'`

- [ ] **Step 4: Implement the module**

Create `server/src/tooling-gate.js`:

```js
// ─── Tooling gate: pure functions, no DB ─────────────────────────────────────
// Shared by readiness() (job-card gate), routes/tooling.js (needed-for-jobs
// rail + auto-flip) and the /artwork enrichment. Callers fetch the tool rows.
//
// Requirement semantics — chosen so real plant data (dies only, no plates
// registered yet) keeps flowing unchanged:
//   HARD (die)                : must exist AND be ready, exactly like the old
//                               dies gate.
//   SOFT (plate/block/shade)  : block only when a tool is REGISTERED but not
//                               ready (e.g. plate set at the maker). Untracked
//                               soft tools inform (status 'missing') but never
//                               block. line.tooling_ok stays the absolute
//                               manual override.

export const TOOL_FAMILIES = {
  die:        { label: 'Die',        prefix: 'DIE-', hard: true  },
  plate:      { label: 'Plate Set',  prefix: 'PLT-', hard: false },
  block:      { label: 'Block',      prefix: 'BLK-', hard: false },
  shade_card: { label: 'Shade Card', prefix: 'SHD-', hard: false },
};

export const TOOL_ZONES = ['incoming', 'making', 'in_rack', 'on_floor'];
const READY_ZONES = ['in_rack', 'on_floor'];
const BAD_CONDITION = ['Poor', 'Scrapped'];

// Which families this product needs. `special` is the EFFECTIVE value
// (spec_override already merged by the caller where relevant).
export function requiredFamilies(product) {
  const fams = ['die', 'plate'];
  if (['foil', 'emboss', 'foil_emboss'].includes(product?.special)) fams.push('block');
  fams.push('shade_card');
  return fams;
}

export function toolReady(tool) {
  return !!tool
    && tool.active === 1
    && !BAD_CONDITION.includes(tool.condition)
    && READY_ZONES.includes(tool.zone);
}

// Per-family status for one product. `tools` = every tool row linked to the
// product (product_id match) plus the die the product points at (tool_id).
export function toolingDetail(product, tools) {
  return requiredFamilies(product).map(family => {
    const cands = (tools || []).filter(t => t.family === family);
    // Prefer the explicitly linked die, else any ready tool, else the newest.
    const linked = family === 'die' && product.tool_id
      ? cands.find(t => t.id === product.tool_id) : null;
    const tool = linked ?? cands.find(toolReady) ?? cands[cands.length - 1] ?? null;
    const status = !tool ? 'missing' : toolReady(tool) ? 'ready' : 'not_ready';
    return {
      family,
      label: TOOL_FAMILIES[family].label,
      hard: TOOL_FAMILIES[family].hard,
      status,
      tool_id: tool?.id ?? null,
      code: tool?.code ?? null,
      zone: tool?.zone ?? null,
      condition: tool?.condition ?? null,
    };
  });
}

export function toolingGateOk(detail, toolingOkFlag) {
  if (toolingOkFlag) return true;
  return detail.every(d => (d.hard ? d.status === 'ready' : d.status !== 'not_ready'));
}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `cd server && npm test`
Expected: PASS — 8 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add server/src/tooling-gate.js server/src/tooling-gate.test.js server/package.json
git commit -m "feat(tooling): pure gate module — required families, ready check, hard/soft gate"
```

---

### Task 2: DB schema + dies→tools migration

**Files:**
- Modify: `server/src/db.js`

- [ ] **Step 1: Add DDL to the schema template**

In `server/src/db.js`, inside the big `pool.query(\`` DDL template, directly **after** the `product_aliases` table block (the `UNIQUE (customer_id, alias_norm) );` line, before the closing backtick around line 572), add:

```sql
-- ── Tooling Hub ──────────────────────────────────────────────────────────────
-- ONE lifecycle for dies, plate sets, foil/emboss blocks and shade cards:
-- incoming → making → in_rack → on_floor. A healthy tool in rack / on floor
-- satisfies the readiness gate (see tooling-gate.js). The legacy dies table
-- stays dormant one release; everything reads products.tool_id + tools now.
CREATE TABLE IF NOT EXISTS tools (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family TEXT NOT NULL CHECK (family IN ('die','plate','block','shade_card')),
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  zone TEXT NOT NULL DEFAULT 'incoming' CHECK (zone IN ('incoming','making','in_rack','on_floor')),
  zone_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  maker TEXT,
  condition TEXT NOT NULL DEFAULT 'Good' CHECK (condition IN ('Good','Fair','Poor','Scrapped')),
  location TEXT,
  notes TEXT,
  ups INTEGER,
  sheet_size TEXT,
  carton_size TEXT,
  colors INTEGER,
  emboss_type TEXT,
  shade_ref TEXT,
  impression_count INTEGER NOT NULL DEFAULT 0,
  max_impressions INTEGER NOT NULL DEFAULT 500000,
  last_used_date TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tool_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tool_id INTEGER NOT NULL REFERENCES tools(id),
  action TEXT NOT NULL,
  from_zone TEXT,
  to_zone TEXT,
  note TEXT,
  user_name TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS tool_id INTEGER REFERENCES tools(id);
```

- [ ] **Step 2: Add the guarded data copy**

In the same file, **after** the DDL `pool.query` and after the existing `gst_rates` seed query, add:

```js
  // One-time copy of the legacy dies rack into the Tooling Hub. Idempotent:
  // the INSERT only fires while tools has no die rows; the remap only touches
  // products that still point nowhere. Real die numbers are kept verbatim.
  await pool.query(`
INSERT INTO tools (family, code, title, zone, condition, location,
                   ups, sheet_size, carton_size, impression_count,
                   max_impressions, last_used_date, active)
SELECT 'die', d.die_number,
       COALESCE(NULLIF(d.die_type, ''), 'Die ' || d.die_number),
       CASE WHEN d.active = 1 AND d.condition NOT IN ('Poor','Scrapped')
            THEN 'in_rack' ELSE 'incoming' END,
       d.condition, d.location,
       d.ups, d.sheet_size, d.carton_size, d.impression_count,
       d.max_impressions, d.last_used_date, d.active
FROM dies d
WHERE NOT EXISTS (SELECT 1 FROM tools WHERE family = 'die');
`);
  await pool.query(`
UPDATE products p SET tool_id = t.id
FROM dies d JOIN tools t ON t.family = 'die' AND t.code = d.die_number
WHERE p.die_id = d.id AND p.tool_id IS NULL;
`);
```

- [ ] **Step 3: Verify the migration on the live embedded DB**

Start the app (Preview tool, config `ci-erp`) so `init()` runs, then from the repo root:

```bash
cd server && node -e "
import('pg').then(async ({ default: pg }) => {
  const pool = new pg.Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5439/cierp' });
  const t = await pool.query(\"SELECT family, COUNT(*)::int n FROM tools GROUP BY family\");
  const p = await pool.query(\"SELECT COUNT(*)::int n FROM products WHERE die_id IS NOT NULL AND tool_id IS NULL\");
  console.log('tools by family:', t.rows, '| unmapped products:', p.rows[0].n);
  await pool.end();
});"
```

Expected: every legacy die appears under `family: 'die'`; `unmapped products: 0`. Restart the server once more and re-run — counts must not double (idempotency).

- [ ] **Step 4: Commit**

```bash
git add server/src/db.js
git commit -m "feat(tooling): tools + tool_events tables, products.tool_id, idempotent dies migration"
```

---

### Task 3: Wire the gate into `readiness()`

**Files:**
- Modify: `server/src/helpers.js` (imports + the die block inside `readiness()`, currently lines ~250–272)

- [ ] **Step 1: Import the gate module**

At the top of `server/src/helpers.js` (line 2 area):

```js
import { toolingDetail, toolingGateOk } from './tooling-gate.js';
```

- [ ] **Step 2: Replace the die block in `readiness()`**

Replace this existing block:

```js
  // Tooling: a healthy die on the rack satisfies the gate automatically;
  // the manual tooling_ok flag covers products without a linked die.
  let die = null;
  if (product.die_id) die = await oc('SELECT * FROM dies WHERE id=$1', [product.die_id]);
  const dieReady = !!(die && die.active && !['Poor', 'Scrapped'].includes(die.condition));
```

with:

```js
  // Tooling: every physical tool linked to this product (the die also links
  // via products.tool_id). Hard/soft semantics live in tooling-gate.js.
  const toolsRow = await oc(`
    SELECT COALESCE(json_agg(t ORDER BY t.id), '[]'::json) AS list
    FROM tools t WHERE t.product_id = $1 OR t.id = $2`,
    [line.product_id, product.tool_id ?? -1]);
  const toolingList = toolsRow.list;
  const detail = toolingDetail(product, toolingList);
  const dieDetail = detail.find(x => x.family === 'die');
```

- [ ] **Step 3: Update the return object**

In the same function's `return {`, replace:

```js
    tooling: !!line.tooling_ok || dieReady,
    die_number: die?.die_number || null,
    die_condition: die?.condition || null,
```

with:

```js
    tooling: toolingGateOk(detail, line.tooling_ok),
    tooling_detail: detail,
    die_number: dieDetail?.code || null,
    die_condition: dieDetail?.condition || null,
```

- [ ] **Step 4: Verify — tests still green, live gate sane**

Run: `cd server && npm test` → PASS.
Then with the app running and a token (`TOKEN=$(curl -s localhost:4000/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@ci.local","password":"admin123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')`):

```bash
curl -s localhost:4000/api/artwork -H "Authorization: Bearer $TOKEN" | node -pe '
const r = JSON.parse(require("fs").readFileSync(0)); r.length + " lines, first has no crash"'
```

Expected: no 500; lines return. (`tooling_detail` reaches clients in later tasks.)

- [ ] **Step 5: Commit**

```bash
git add server/src/helpers.js
git commit -m "feat(tooling): readiness() reads the tools lifecycle via tooling-gate"
```

---

### Task 4: `routes/tooling.js` + mount

**Files:**
- Create: `server/src/routes/tooling.js`
- Modify: `server/src/index.js` (import + `app.use`)

- [ ] **Step 1: Create the router**

Create `server/src/routes/tooling.js`:

```js
// ─── Tooling Hub API ─────────────────────────────────────────────────────────
// One board call (tools + needed-for-jobs rail), CRUD, zone moves with an
// append-only event log, undo, and the auto-flip: a tool arriving in the rack
// re-checks waiting order lines and promotes planned → ready (same pattern as
// the artwork endpoint).
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { readiness, setLineStatus } from '../helpers.js';
import { requireRole } from '../auth.js';
import { TOOL_FAMILIES, TOOL_ZONES, toolingDetail, toolingGateOk } from '../tooling-gate.js';

const r = Router();
const canManage = requireRole('planner');
const canMove = requireRole('planner', 'production');

const EDIT_COLS = ['title', 'product_id', 'maker', 'condition', 'location', 'notes',
  'ups', 'sheet_size', 'carton_size', 'colors', 'emboss_type', 'shade_ref', 'active'];

const TOOL_VIEW = `
  SELECT t.*, p.name AS product_name, p.code AS product_code, c.name AS customer_name,
         EXTRACT(EPOCH FROM (now() - t.zone_since))::bigint AS zone_seconds,
         le.action AS last_action, le.user_name AS last_user, le.at AS last_at
  FROM tools t
  LEFT JOIN products p ON p.id = t.product_id
  LEFT JOIN customers c ON c.id = p.customer_id
  LEFT JOIN LATERAL (SELECT action, user_name, at FROM tool_events
                     WHERE tool_id = t.id ORDER BY id DESC LIMIT 1) le ON true`;

// Per-family sequential codes (DIE-0001 …). Migrated dies keep their real
// numbers, so we scan only rows that match our own prefix.
async function nextToolCode(family, oc = one) {
  const prefix = TOOL_FAMILIES[family].prefix;
  const row = await oc(
    `SELECT code FROM tools WHERE family=$1 AND code LIKE $2 ORDER BY id DESC LIMIT 1`,
    [family, `${prefix}%`]);
  const m = row?.code?.match(/(\d+)$/);
  return `${prefix}${String(m ? +m[1] + 1 : 1).padStart(4, '0')}`;
}

// A tool reached the rack: promote every planned, artwork-locked line of the
// linked product whose full gate now passes. Returns how many flipped.
async function autoFlip(tool, qc, oc, user) {
  const lines = await qc(`
    SELECT ol.* FROM order_lines ol JOIN products p ON p.id = ol.product_id
    WHERE ol.status = 'planned' AND ol.artwork_locked = 1
      AND (p.id = $1 OR p.tool_id = $2)`,
    [tool.product_id ?? -1, tool.id]);
  let flipped = 0;
  for (const line of lines) {
    const gate = await readiness(line, oc);
    if (gate.artwork && gate.tooling && (gate.material || gate.material_pending)) {
      await setLineStatus(line.id, 'ready', qc, oc, user);
      flipped++;
    }
  }
  return flipped;
}

// ── Board: tools + needed-for-jobs, one call ────────────────────────────────
r.get('/tooling/board', async (_req, res, next) => {
  try {
    const tools = await q(`${TOOL_VIEW} WHERE t.active = 1 ORDER BY t.zone_since DESC`);

    const lines = await q(`
      SELECT ol.id, ol.product_id, ol.tooling_ok, ol.spec_override,
             o.po_number, o.delivery_date, c.name AS customer_name,
             p.name AS product_name, p.code AS product_code, p.special, p.tool_id
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = ol.product_id
      WHERE ol.status IN ('planned','ready') AND ol.artwork_locked = 1
      ORDER BY o.delivery_date NULLS LAST, ol.id`);

    const every = await q('SELECT * FROM tools');
    const needed = [];
    for (const l of lines) {
      const ov = typeof l.spec_override === 'string' ? JSON.parse(l.spec_override) : l.spec_override;
      const product = { id: l.product_id, special: ov?.special ?? l.special, tool_id: l.tool_id };
      const mine = every.filter(t => t.product_id === l.product_id || t.id === l.tool_id);
      const detail = toolingDetail(product, mine);
      if (toolingGateOk(detail, l.tooling_ok)) continue;
      needed.push({
        line_id: l.id, po_number: l.po_number, customer_name: l.customer_name,
        product_id: l.product_id, product_name: l.product_name,
        product_code: l.product_code, delivery_date: l.delivery_date,
        gaps: detail.filter(d => (d.hard ? d.status !== 'ready' : d.status === 'not_ready')),
      });
    }
    res.json({ tools, needed });
  } catch (e) { next(e); }
});

// ── Flat list (ledger, pickers) ─────────────────────────────────────────────
r.get('/tools', async (req, res, next) => {
  try {
    const wh = ['t.active = 1'];
    const params = [];
    if (req.query.family) { params.push(req.query.family); wh.push(`t.family = $${params.length}`); }
    if (req.query.product_id) { params.push(+req.query.product_id); wh.push(`t.product_id = $${params.length}`); }
    res.json(await q(`${TOOL_VIEW} WHERE ${wh.join(' AND ')} ORDER BY t.code`, params));
  } catch (e) { next(e); }
});

r.get('/tools/:id/events', async (req, res, next) => {
  try {
    res.json(await q('SELECT * FROM tool_events WHERE tool_id=$1 ORDER BY id DESC', [req.params.id]));
  } catch (e) { next(e); }
});

// ── Create ──────────────────────────────────────────────────────────────────
r.post('/tools', canManage, async (req, res, next) => {
  try {
    const { family, code, title } = req.body;
    if (!TOOL_FAMILIES[family]) return res.status(400).json({ error: 'Unknown tool family' });
    if (!title?.trim()) return res.status(400).json({ error: 'Tool needs a name' });
    const out = await tx(async (qc, oc) => {
      const finalCode = code?.trim() || await nextToolCode(family, oc);
      const dup = await oc('SELECT id FROM tools WHERE code=$1', [finalCode]);
      if (dup) throw Object.assign(new Error(`Code ${finalCode} already exists`), { status: 409 });
      const [t] = await qc(`
        INSERT INTO tools (family, code, title, product_id, maker, condition, location, notes,
                           ups, sheet_size, carton_size, colors, emboss_type, shade_ref)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [family, finalCode, title.trim(), req.body.product_id || null, req.body.maker || null,
         req.body.condition || 'Good', req.body.location || null, req.body.notes || null,
         req.body.ups || null, req.body.sheet_size || null, req.body.carton_size || null,
         req.body.colors || null, req.body.emboss_type || null, req.body.shade_ref || null]);
      await qc(`INSERT INTO tool_events (tool_id, action, to_zone, user_name)
                VALUES ($1,'created','incoming',$2)`, [t.id, req.user.name]);
      return t;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Edit spec / condition / link ────────────────────────────────────────────
r.put('/tools/:id', canManage, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const t = await oc('SELECT * FROM tools WHERE id=$1', [req.params.id]);
      if (!t) throw Object.assign(new Error('Tool not found'), { status: 404 });
      const cols = EDIT_COLS.filter(c => req.body[c] !== undefined);
      if (!cols.length) return t;
      const sets = cols.map((c, i) => `${c}=$${i + 1}`).join(', ');
      const vals = cols.map(c => req.body[c] === '' ? null : req.body[c]);
      const [fresh] = await qc(`UPDATE tools SET ${sets} WHERE id=$${cols.length + 1} RETURNING *`,
        [...vals, t.id]);
      if (req.body.condition && req.body.condition !== t.condition) {
        await qc(`INSERT INTO tool_events (tool_id, action, note, user_name)
                  VALUES ($1,'condition',$2,$3)`,
          [t.id, `${t.condition} → ${req.body.condition}`, req.user.name]);
      }
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Zone move (the lifecycle) ───────────────────────────────────────────────
r.post('/tools/:id/move', canMove, async (req, res, next) => {
  try {
    const { zone, note } = req.body;
    if (!TOOL_ZONES.includes(zone)) return res.status(400).json({ error: 'Unknown zone' });
    const out = await tx(async (qc, oc) => {
      const t = await oc('SELECT * FROM tools WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!t) throw Object.assign(new Error('Tool not found'), { status: 404 });
      if (t.zone === zone) throw Object.assign(new Error(`Already in ${zone}`), { status: 409 });
      const [fresh] = await qc(
        'UPDATE tools SET zone=$1, zone_since=now() WHERE id=$2 RETURNING *', [zone, t.id]);
      await qc(`INSERT INTO tool_events (tool_id, action, from_zone, to_zone, note, user_name)
                VALUES ($1,'moved',$2,$3,$4,$5)`,
        [t.id, t.zone, zone, note || null, req.user.name]);
      const lines_ready = zone === 'in_rack' ? await autoFlip(fresh, qc, oc, req.user.name) : 0;
      return { ...fresh, lines_ready };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Undo the last move ──────────────────────────────────────────────────────
r.post('/tools/:id/undo', canManage, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const t = await oc('SELECT * FROM tools WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!t) throw Object.assign(new Error('Tool not found'), { status: 404 });
      const ev = await oc(`SELECT * FROM tool_events WHERE tool_id=$1 AND action='moved'
                           ORDER BY id DESC LIMIT 1`, [t.id]);
      if (!ev || t.zone !== ev.to_zone) {
        throw Object.assign(new Error('Nothing to undo'), { status: 409 });
      }
      const [fresh] = await qc(
        'UPDATE tools SET zone=$1, zone_since=now() WHERE id=$2 RETURNING *', [ev.from_zone, t.id]);
      await qc(`INSERT INTO tool_events (tool_id, action, from_zone, to_zone, note, user_name)
                VALUES ($1,'undo',$2,$3,'Reversed last move',$4)`,
        [t.id, ev.to_zone, ev.from_zone, req.user.name]);
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

export default r;
```

- [ ] **Step 2: Mount it**

In `server/src/index.js`: add `import tooling from './routes/tooling.js';` beside the other route imports, and `app.use('/api', tooling);` beside the other mounts (after `gangs`).

- [ ] **Step 3: Verify live**

With the app running and `$TOKEN` from Task 3:

```bash
curl -s localhost:4000/api/tooling/board -H "Authorization: Bearer $TOKEN" | node -pe '
const r = JSON.parse(require("fs").readFileSync(0)); `tools=${r.tools.length} needed=${r.needed.length}`'
# create → move → undo round-trip
curl -s localhost:4000/api/tools -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"family":"plate","title":"Smoke-test plate set","colors":4}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).code'
```

Expected: board returns counts; create returns `PLT-0001` (or next in sequence). Then move it to `in_rack` and undo it via curl — both 200, final zone `incoming`.

- [ ] **Step 4: Deactivate the smoke-test tool**

```bash
curl -s localhost:4000/api/tools/<id> -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"active":0}'
```

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/tooling.js server/src/index.js
git commit -m "feat(tooling): board/CRUD/move/undo API with event log and planned→ready auto-flip"
```

---

### Task 5: Seed demo tools

**Files:**
- Modify: `server/src/seed.js` (inside `seed()`, after the `const prodRow = …` line ~145)

- [ ] **Step 1: Add the tooling seed block**

Directly after `const prodRow = async id => await oc('SELECT * FROM products WHERE id=$1', [id]);` insert:

```js
    // Tooling Hub — dies, plate sets, blocks & shade cards ──────────────────
    const tool = (family, code, title, pid, zone, x = {}) =>
      ins(`INSERT INTO tools (family, code, title, product_id, zone, maker, condition, location,
                              ups, sheet_size, carton_size, colors, emboss_type, shade_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [family, code, title, pid, zone, x.maker ?? null, x.condition ?? 'Good',
         x.location ?? null, x.ups ?? null, x.sheet_size ?? null, x.carton_size ?? null,
         x.colors ?? null, x.emboss_type ?? null, x.shade_ref ?? null]);
    const dieFor = async (pid, code, ups, size, location, zone = 'in_rack', x = {}) => {
      const name = (await prodRow(pid)).name;
      const id = await tool('die', code, `${name} die`, pid, zone, { ups, carton_size: size, location, ...x });
      await qc('UPDATE products SET tool_id=$1 WHERE id=$2', [id, pid]);
    };
    await dieFor(P.azith,   'DIE-0001', 24, '85 x 40 x 22 mm',  'Rack A-01');
    await dieFor(P.paracet, 'DIE-0002', 28, '80 x 35 x 20 mm',  'Rack A-02');
    await dieFor(P.cough,   'DIE-0003', 12, '50 x 50 x 118 mm', 'Rack A-03');
    await dieFor(P.inject,  'DIE-0004', 15, '58 x 42 x 78 mm',  null, 'making', { maker: 'Sharma Die Makers' });
    await dieFor(P.tea,     'DIE-0005',  8, '75 x 65 x 130 mm', 'Rack B-01');
    await dieFor(P.ghee,    'DIE-0006',  6, '95 x 95 x 110 mm', 'Rack B-02');
    await tool('plate', 'PLT-0001', 'Azithro-500 plate set', P.azith, 'in_rack', { colors: 4, location: 'Plate Rack 1' });
    await tool('plate', 'PLT-0002', 'Zencof Syrup plate set', P.cough, 'making', { colors: 5, maker: 'CTP Bureau — Chandigarh' });
    await tool('block', 'BLK-0001', 'Zencof foil block', P.cough, 'in_rack', { emboss_type: 'foil', location: 'Block Drawer 2' });
    await tool('block', 'BLK-0002', 'Novacef foil+emboss block', P.inject, 'making', { emboss_type: 'foil_emboss', maker: 'Precision Engravers' });
    await tool('block', 'BLK-0003', 'Crystal Tea emboss block', P.tea, 'in_rack', { emboss_type: 'emboss', location: 'Block Drawer 1' });
    await tool('shade_card', 'SHD-0001', 'Azithro-500 shade card', P.azith, 'in_rack', { shade_ref: 'Pantone 2935C + 485C', location: 'QC Cabinet' });
    await tool('shade_card', 'SHD-0002', 'Him Ghee shade card', P.ghee, 'incoming', { shade_ref: 'Pantone 1235C' });
```

- [ ] **Step 2: Verify the seed compiles and runs (fresh DB only)**

Do **not** wipe the real local DB. Syntax check only: `cd server && node --check src/seed.js` → no output = OK. (The block only executes on an empty database.)

- [ ] **Step 3: Commit**

```bash
git add server/src/seed.js
git commit -m "feat(tooling): seed demo dies, plates, blocks and shade cards"
```

---

### Task 6: Server-wide switchover — every die read goes through `tools`

**Files:**
- Modify: `server/src/routes/orders.js` (LINE_VIEW, lines ~36 & ~43)
- Modify: `server/src/routes/production.js` (lines ~23 & ~35)
- Modify: `server/src/routes/floor.js` (STAGE_VIEW lines ~269 & ~276)
- Modify: `server/src/routes/masters.js` (MASTERS map, products query, dies branch)

- [ ] **Step 1: orders.js LINE_VIEW**

In the `LINE_VIEW` constant: change `d.die_number, m.name AS machine_name,` to `d.code AS die_number, p.tool_id, m.name AS machine_name,` and change the join `LEFT JOIN dies d ON d.id = p.die_id` to `LEFT JOIN tools d ON d.id = p.tool_id`.

- [ ] **Step 2: production.js**

Change `dd.die_number, dd.condition AS die_condition, dd.location AS die_location,` to `dd.code AS die_number, dd.condition AS die_condition, dd.location AS die_location,` and `LEFT JOIN dies dd ON dd.id = p.die_id` to `LEFT JOIN tools dd ON dd.id = p.tool_id`.

- [ ] **Step 3: floor.js STAGE_VIEW**

Change `dd.die_number, dd.location AS die_location,` to `dd.code AS die_number, dd.location AS die_location,` and `LEFT JOIN dies dd ON dd.id = p.die_id` to `LEFT JOIN tools dd ON dd.id = p.tool_id`.

- [ ] **Step 4: masters.js — retire the dies master**

1. Delete the `dies: [...]` entry from the `MASTERS` map.
2. In the `products` cols array, replace `'die_id'` with `'tool_id'`.
3. In the products GET query, change `d.die_number, d.condition AS die_condition,` to `d.code AS die_number, d.condition AS die_condition,` and `LEFT JOIN dies d ON d.id=p.die_id` to `LEFT JOIN tools d ON d.id=p.tool_id`.
4. Delete the whole `} else if (table === 'dies') { … }` branch.

- [ ] **Step 5: Verify no stale references + live check**

```bash
grep -rn "JOIN dies\|FROM dies" server/src/routes server/src/helpers.js
```
Expected: no matches (only `db.js` may mention `dies` for the migration).
Restart the app; check `/api/products`, `/api/production`, `/api/floor` and one `/api/track/<line id>` return 200 with `die_number` populated for products that had dies.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/orders.js server/src/routes/production.js server/src/routes/floor.js server/src/routes/masters.js
git commit -m "refactor(tooling): all die reads via tools/products.tool_id; retire dies master CRUD"
```

---

### Task 7: `/artwork` enrichment + `/track` tooling milestone

**Files:**
- Modify: `server/src/routes/orders.js` (GET `/artwork`, line ~430; imports)
- Modify: `server/src/routes/floor.js` (`/track/:id` line SELECT ~line 390 and timeline after the artwork event ~line 445; imports)

- [ ] **Step 1: Enrich GET /artwork (batched, no N+1)**

In `orders.js` add to imports: `import { toolingDetail, toolingGateOk } from '../tooling-gate.js';`
Replace the `/artwork` GET handler body:

```js
r.get('/artwork', async (_req, res, next) => {
  try {
    const rows = await q(`${LINE_VIEW}
      WHERE ol.status IN ('planned','ready') ORDER BY ol.artwork_locked, o.delivery_date NULLS LAST`);
    // Tooling chips: ONE query for every product on the page.
    const pids = [...new Set(rows.map(l => l.product_id))];
    const tools = pids.length ? await q(`
      SELECT * FROM tools
      WHERE product_id = ANY($1)
         OR id IN (SELECT tool_id FROM products WHERE id = ANY($1) AND tool_id IS NOT NULL)`,
      [pids]) : [];
    for (const l of rows) {
      const mine = tools.filter(t => t.product_id === l.product_id || t.id === l.tool_id);
      l.tooling = toolingDetail({ id: l.product_id, special: l.special, tool_id: l.tool_id }, mine);
      l.tooling_ready = toolingGateOk(l.tooling, l.tooling_ok);
    }
    res.json(rows);
  } catch (e) { next(e); }
});
```

(`l.special` in LINE_VIEW is already the effective, override-merged value; `p.tool_id` was added in Task 6.)

- [ ] **Step 2: /track — add p.tool_id to the line SELECT**

In `floor.js` `/track/:id`, in the line SELECT change
`p.name AS product_name, p.code AS product_code, p.size, p.colors, p.coating, p.special, p.ups,`
to
`p.name AS product_name, p.code AS product_code, p.size, p.colors, p.coating, p.special, p.ups, p.tool_id,`

- [ ] **Step 3: /track — tooling milestone after the artwork event**

Add to floor.js imports: `import { toolingDetail, toolingGateOk } from '../tooling-gate.js';`
Directly after the artwork `events.push({ … })` block, insert:

```js
    // Tooling — Artwork's sibling gate: physical tools from maker to rack.
    const lineTools = await q(
      'SELECT * FROM tools WHERE product_id=$1 OR id=$2',
      [line.product_id, line.tool_id ?? -1]);
    const tDetail = toolingDetail({ id: line.product_id, special: line.special, tool_id: line.tool_id }, lineTools);
    const tReady = toolingGateOk(tDetail, line.tooling_ok);
    const toolMove = await one(`
      SELECT te.at, te.user_name FROM tool_events te JOIN tools t ON t.id = te.tool_id
      WHERE (t.product_id=$1 OR t.id=$2) AND te.action='moved' AND te.to_zone='in_rack'
      ORDER BY te.id DESC LIMIT 1`, [line.product_id, line.tool_id ?? -1]);
    events.push({
      key: 'tooling', title: 'Tooling ready',
      detail: tReady
        ? (tDetail.filter(d => d.status === 'ready').map(d => `${d.label} ✓`).join(' · ') || 'Manual override ✓')
        : tDetail.filter(d => d.status !== 'ready')
            .map(d => `${d.label} ${d.status === 'missing' ? 'missing' : 'not ready'}`).join(' · '),
      at: tReady ? toolMove?.at ?? null : null, by: toolMove?.user_name,
      state: tReady ? 'done' : 'todo',
    });
```

- [ ] **Step 4: Verify live**

```bash
curl -s localhost:4000/api/artwork -H "Authorization: Bearer $TOKEN" | node -pe '
const r = JSON.parse(require("fs").readFileSync(0));
r.length ? JSON.stringify({ ready: r[0].tooling_ready, chips: r[0].tooling.map(t => t.family + ":" + t.status) }) : "no lines"'
curl -s localhost:4000/api/track/<any line id> -H "Authorization: Bearer $TOKEN" | node -pe '
JSON.parse(require("fs").readFileSync(0)).events.find(e => e.key === "tooling")'
```

Expected: artwork rows carry `tooling` + `tooling_ready`; track timeline contains the `tooling` event between artwork and job card.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/orders.js server/src/routes/floor.js
git commit -m "feat(tooling): artwork rows carry tooling chips; track timeline gains tooling milestone"
```

---

### Task 8: Client — route + nav group

**Files:**
- Modify: `client/src/App.jsx`
- Modify: `client/src/components/AppLayout.jsx`

- [ ] **Step 1: Route**

In `App.jsx`: add `import Tooling from './pages/Tooling.jsx';` with the other page imports and `<Route path="/tooling" element={<Tooling />} />` after the `/masters` route. (The page file arrives in Task 9 — create a placeholder now so the app compiles: `export default function Tooling() { return null; }` in `client/src/pages/Tooling.jsx`.)

- [ ] **Step 2: Nav group — its own group, last in the sidebar**

In `AppLayout.jsx`: add `Wrench` to the lucide-react import list, and append to the `NAV` array **after** the `Admin` group:

```js
  {
    group: 'Tooling',
    items: [
      { label: 'Tooling Hub', to: '/tooling', icon: Wrench, roles: ['admin', 'planner', 'production', 'qc'] },
    ],
  },
```

- [ ] **Step 3: Verify**

Preview: sidebar shows the Tooling group at the bottom; clicking navigates to a blank `/tooling` with no console errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/App.jsx client/src/components/AppLayout.jsx client/src/pages/Tooling.jsx
git commit -m "feat(tooling): /tooling route and sidebar group"
```

---

### Task 9: The Tooling Hub page

**Files:**
- Rewrite: `client/src/pages/Tooling.jsx` (replaces the Task 8 placeholder)

- [ ] **Step 1: Write the full page**

```jsx
// Tooling Hub — ONE lifecycle for the plant's physical tooling: dies, plate
// sets, foil/emboss blocks and shade cards. Incoming → Making → In Rack →
// On Floor. A healthy tool in rack or on the floor satisfies the job-card
// tooling gate automatically — this page is Artwork's sibling station.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmt } from '../api.js';
import {
  Button, DataTable, Field, Input, KpiCard, Modal, PageHeader,
  SearchableSelect, Select, Tabs, Textarea, useToast,
} from '../components/ui.jsx';
import {
  Square, Printer, Stamp, Palette, Factory, Archive, Cog, AlertTriangle,
  Undo2, LayoutGrid, List, Plus, X,
} from 'lucide-react';

const FAMILY_META = {
  die:        { label: 'Die',        plural: 'Dies',        icon: Square,  tint: 'bg-rose-50 text-rose-600' },
  plate:      { label: 'Plate Set',  plural: 'Plates',      icon: Printer, tint: 'bg-sky-50 text-sky-600' },
  block:      { label: 'Block',      plural: 'Blocks',      icon: Stamp,   tint: 'bg-amber-50 text-amber-700' },
  shade_card: { label: 'Shade Card', plural: 'Shade Cards', icon: Palette, tint: 'bg-violet-50 text-violet-600' },
};
const ZONES = [
  { key: 'incoming', label: 'Incoming', desc: 'New & returned — awaiting triage' },
  { key: 'making',   label: 'Making',   desc: 'At vendor / in-house engraving' },
  { key: 'in_rack',  label: 'In Rack',  desc: 'Stored & ready — gate satisfied' },
  { key: 'on_floor', label: 'On Floor', desc: 'Issued to a machine' },
];
const CONDITIONS = ['Good', 'Fair', 'Poor', 'Scrapped'];
const DOT = { Good: 'bg-emerald-500', Fair: 'bg-amber-500', Poor: 'bg-red-500', Scrapped: 'bg-gray-400' };
const STALE = 7 * 86400; // a week stuck in Making = needs attention

const age = s => {
  const d = Math.floor((s ?? 0) / 86400);
  if (d > 0) return `${d}d`;
  const h = Math.floor((s ?? 0) / 3600);
  return h > 0 ? `${h}h` : 'new';
};
const specLine = t =>
  t.family === 'die' ? [t.ups && `${t.ups} ups`, t.carton_size].filter(Boolean).join(' · ')
    : t.family === 'plate' ? (t.colors ? `${t.colors} colours` : '')
    : t.family === 'block' ? (t.emboss_type ? fmt.title(t.emboss_type) : '')
    : (t.shade_ref || '');

// Spec fields per family — drives the create/edit form.
const SPEC_FIELDS = {
  die: [
    { key: 'ups', label: 'UPS', type: 'number' },
    { key: 'sheet_size', label: 'Sheet Size' },
    { key: 'carton_size', label: 'Carton Size' },
  ],
  plate: [{ key: 'colors', label: 'Colours', type: 'number' }],
  block: [{ key: 'emboss_type', label: 'Block Type', select: ['foil', 'emboss', 'foil_emboss'] }],
  shade_card: [{ key: 'shade_ref', label: 'Shade Reference (e.g. Pantone 2935C)' }],
};

// One uniform compact card — every family, every zone, same size.
function ToolCard({ t, onOpen }) {
  const m = FAMILY_META[t.family];
  return (
    <button onClick={() => onOpen(t)}
      className="ci-line-item w-full text-left transition-shadow duration-200 ease-apple hover:shadow-lift">
      <div className="flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${m.tint}`}>
          <m.icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[t.condition]}`} />
            <span className="truncate text-xs font-bold text-[#1D1D1F]">{t.code}</span>
          </span>
          <span className="block truncate text-[11px] text-[#6E6E73]">{t.title}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[10px] font-semibold tabular-nums text-[#86868B]">{age(t.zone_seconds)}</span>
          {specLine(t) && <span className="block max-w-[90px] truncate text-[10px] text-[#AEAEB2]">{specLine(t)}</span>}
        </span>
      </div>
    </button>
  );
}

// Spotlight — full detail, zone moves, condition, event timeline, undo.
function Spotlight({ tool, onClose, onChanged, onEdit }) {
  const toast = useToast();
  const [events, setEvents] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/tools/${tool.id}/events`).then(setEvents).catch(() => {}); }, [tool.id]);
  const m = FAMILY_META[tool.family];

  const move = async zone => {
    setBusy(true);
    try {
      const r = await api.post(`/tools/${tool.id}/move`, { zone, note: note.trim() || undefined });
      toast.success(`${tool.code} → ${ZONES.find(z => z.key === zone).label}` +
        (r.lines_ready ? ` — ${r.lines_ready} job line${r.lines_ready > 1 ? 's' : ''} now ready` : ''));
      onChanged(); onClose();
    } finally { setBusy(false); }
  };
  const setCondition = async condition => {
    if (condition === tool.condition) return;
    await api.put(`/tools/${tool.id}`, { condition });
    toast.success(`${tool.code} marked ${condition}`);
    onChanged(); onClose();
  };
  const undo = async () => {
    await api.post(`/tools/${tool.id}/undo`);
    toast.success('Last move reversed');
    onChanged(); onClose();
  };
  // Only the latest MOVE is reversible — an undo of an undo would 409 server-side.
  const canUndo = events[0]?.action === 'moved';

  return (
    <Modal open onClose={onClose} title={`${tool.code} — ${tool.title}`}
      footer={<>
        <Button variant="ghost" size="sm" onClick={() => onEdit(tool)}>Edit details</Button>
        {canUndo && <Button variant="secondary" size="sm" onClick={undo}><Undo2 size={13} /> Undo last move</Button>}
      </>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${m.tint}`}>
            <m.icon size={12} /> {m.label}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#1D1D1F]/[0.05] px-2.5 py-1 text-xs font-semibold text-[#515154]">
            <span className={`h-1.5 w-1.5 rounded-full ${DOT[tool.condition]}`} /> {tool.condition}
          </span>
          {tool.location && <span className="rounded-full bg-[#1D1D1F]/[0.05] px-2.5 py-1 text-xs text-[#515154]">{tool.location}</span>}
          {tool.maker && <span className="rounded-full bg-[#1D1D1F]/[0.05] px-2.5 py-1 text-xs text-[#515154]">Maker: {tool.maker}</span>}
        </div>

        {tool.product_name && (
          <p className="text-sm text-[#515154]">
            Linked product: <span className="font-semibold text-[#1D1D1F]">{tool.product_name}</span>
            <span className="text-xs text-[#86868B]"> · {tool.product_code}{tool.customer_name ? ` · ${tool.customer_name}` : ''}</span>
          </p>
        )}
        {specLine(tool) && <p className="text-sm text-[#515154]">Spec: <span className="font-semibold text-[#1D1D1F]">{specLine(tool)}</span></p>}

        {/* Zone lifecycle */}
        <div>
          <p className="ci-form-panel-title border-0 pb-0">Move to</p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {ZONES.map(z => (
              <button key={z.key} disabled={busy || z.key === tool.zone} onClick={() => move(z.key)}
                className={`rounded-xl border px-2 py-2 text-xs font-semibold transition-all ${
                  z.key === tool.zone
                    ? 'border-[#0A84FF]/40 bg-[#E1EFFF] text-[#0064D2]'
                    : 'border-[#1D1D1F]/[0.08] bg-white/70 text-[#515154] hover:border-[#0A84FF]/40 hover:text-[#007AFF]'}`}>
                {z.label}{z.key === tool.zone ? ' · now' : ''}
              </button>
            ))}
          </div>
          <Input className="mt-2" placeholder="Note for this move (optional)" value={note} onChange={e => setNote(e.target.value)} />
        </div>

        {/* Condition */}
        <div>
          <p className="ci-form-panel-title border-0 pb-0">Condition</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {CONDITIONS.map(c => (
              <button key={c} onClick={() => setCondition(c)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${
                  c === tool.condition ? 'bg-[#1D1D1F] text-white' : 'bg-[#1D1D1F]/[0.05] text-[#515154] hover:bg-[#1D1D1F]/[0.10]'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${DOT[c]}`} /> {c}
              </button>
            ))}
          </div>
        </div>

        {/* History */}
        <div>
          <p className="ci-form-panel-title border-0 pb-0">History</p>
          <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto">
            {events.length === 0 && <p className="text-xs text-[#AEAEB2]">No events yet.</p>}
            {events.map(e => (
              <div key={e.id} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 tabular-nums text-[#86868B]">{fmt.dt(e.at)}</span>
                <span className="text-[#1D1D1F]">
                  {e.action === 'moved' ? `${e.from_zone ? fmt.title(e.from_zone) + ' → ' : ''}${fmt.title(e.to_zone)}`
                    : e.action === 'created' ? 'Created'
                    : e.action === 'undo' ? `Undo → ${fmt.title(e.to_zone)}`
                    : `Condition: ${e.note}`}
                  {e.note && e.action === 'moved' ? ` — ${e.note}` : ''}
                </span>
                {e.user_name && <span className="text-[#AEAEB2]">· {e.user_name}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Create / edit form — family drives which spec fields show.
function ToolForm({ initial, products, onClose, onSaved }) {
  const toast = useToast();
  const editing = !!initial?.id;
  const [f, setF] = useState({
    family: initial?.family || 'die',
    code: initial?.code || '',
    title: initial?.title || '',
    product_id: initial?.product_id ? String(initial.product_id) : '',
    maker: initial?.maker || '',
    location: initial?.location || '',
    notes: initial?.notes || '',
    ups: initial?.ups ?? '', sheet_size: initial?.sheet_size || '', carton_size: initial?.carton_size || '',
    colors: initial?.colors ?? '', emboss_type: initial?.emboss_type || '', shade_ref: initial?.shade_ref || '',
  });
  const set = p => setF(x => ({ ...x, ...p }));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!f.title.trim()) return toast.error('Give the tool a name');
    setSaving(true);
    try {
      const body = {
        ...f, title: f.title.trim(),
        code: f.code.trim() || undefined,
        product_id: f.product_id ? +f.product_id : null,
        ups: f.ups === '' ? null : +f.ups,
        colors: f.colors === '' ? null : +f.colors,
      };
      if (editing) await api.put(`/tools/${initial.id}`, body);
      else await api.post('/tools', body);
      toast.success(editing ? 'Tool updated' : 'Tool added to Incoming');
      onSaved(); onClose();
    } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={editing ? `Edit ${initial.code}` : 'New Tool'}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={saving}>{editing ? 'Save changes' : 'Add tool'}</Button>
      </>}>
      <div className="ci-form-grid">
        <Field label="Family" required>
          <Select value={f.family} disabled={editing} onChange={e => set({ family: e.target.value })}>
            {Object.entries(FAMILY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </Select>
        </Field>
        <Field label="Code" hint={editing ? undefined : 'Leave empty to auto-number'}>
          <Input value={f.code} disabled={editing} onChange={e => set({ code: e.target.value })}
            placeholder={`${FAMILY_META[f.family].label} code`} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Name" required>
            <Input value={f.title} onChange={e => set({ title: e.target.value })} placeholder="e.g. Azithro-500 die" />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Linked product" hint="Ties this tool to job readiness — leave empty for shared tools">
            <SearchableSelect value={f.product_id} onChange={e => set({ product_id: e.target.value })}
              placeholder="No product link"
              options={[{ value: '', label: 'No product link' },
                ...products.map(p => ({ value: String(p.id), label: `${p.name} · ${p.code}` }))]} />
          </Field>
        </div>
        {SPEC_FIELDS[f.family].map(s => (
          <Field key={s.key} label={s.label}>
            {s.select
              ? <Select value={f[s.key]} onChange={e => set({ [s.key]: e.target.value })}>
                  <option value="">—</option>
                  {s.select.map(o => <option key={o} value={o}>{fmt.title(o)}</option>)}
                </Select>
              : <Input type={s.type || 'text'} value={f[s.key]} onChange={e => set({ [s.key]: e.target.value })} />}
          </Field>
        ))}
        <Field label="Maker" hint="Vendor name, or In-house">
          <Input value={f.maker} onChange={e => set({ maker: e.target.value })} />
        </Field>
        <Field label="Location" hint="Rack / drawer / cabinet">
          <Input value={f.location} onChange={e => set({ location: e.target.value })} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Notes"><Textarea value={f.notes} onChange={e => set({ notes: e.target.value })} /></Field>
        </div>
      </div>
    </Modal>
  );
}

export default function Tooling() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState({ tools: [], needed: [] });
  const [products, setProducts] = useState([]);
  const [tab, setTab] = useState('all');
  const [view, setView] = useState('board');
  const [spot, setSpot] = useState(null);
  const [form, setForm] = useState(null); // null | {} | {family, product_id} | full tool row

  const load = () => api.get('/tooling/board').then(setData);
  useEffect(() => { load(); }, []);
  useEffect(() => { api.get('/products').then(setProducts).catch(() => {}); }, []);

  const productFilter = params.get('product') ? +params.get('product') : null;
  const tools = useMemo(() => data.tools
    .filter(t => tab === 'all' || t.family === tab)
    .filter(t => !productFilter || t.product_id === productFilter),
    [data.tools, tab, productFilter]);

  const kpi = useMemo(() => ({
    making: data.tools.filter(t => t.zone === 'making').length,
    rack: data.tools.filter(t => t.zone === 'in_rack').length,
    floor: data.tools.filter(t => t.zone === 'on_floor').length,
    attention: data.tools.filter(t => ['Poor', 'Scrapped'].includes(t.condition)
      || (t.zone === 'making' && t.zone_seconds > STALE)).length,
  }), [data.tools]);

  const counts = useMemo(() => Object.fromEntries(
    Object.keys(FAMILY_META).map(k => [k, data.tools.filter(t => t.family === k).length])),
    [data.tools]);

  const filterName = productFilter
    ? (data.tools.find(t => t.product_id === productFilter)?.product_name
      ?? products.find(p => p.id === productFilter)?.name ?? `#${productFilter}`)
    : null;

  return (
    <div>
      <PageHeader title="Tooling Hub"
        subtitle="Dies, plates, blocks & shade cards — from maker to rack to machine"
        actions={<Button onClick={() => setForm({})}><Plus size={15} /> New Tool</Button>} />

      {/* KPI strip */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="In Making" value={kpi.making} icon={Factory} chip="bg-sky-50 text-sky-600"
          sub="At vendor or engraving" />
        <KpiCard label="In Rack" value={kpi.rack} icon={Archive} chip="bg-emerald-50 text-emerald-600"
          sub="Ready — gate satisfied" accent="text-emerald-600" />
        <KpiCard label="On Floor" value={kpi.floor} icon={Cog} chip="bg-indigo-50 text-indigo-600"
          sub="Running on a machine" />
        <KpiCard label="Needs Attention" value={kpi.attention} icon={AlertTriangle}
          chip="bg-red-50 text-red-600" accent={kpi.attention ? 'text-red-600' : 'text-slate-900'}
          sub="Poor condition or stuck a week+" />
      </div>

      {/* Needed for jobs — artwork locked, tooling pending */}
      {data.needed.length > 0 && (
        <div className="mb-4">
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#86868B]">
            Needed for jobs — artwork locked, tooling pending
          </p>
          <div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">
            {data.needed.map(n => (
              <div key={n.line_id} className="glass flex shrink-0 items-center gap-3 rounded-2xl px-3.5 py-2.5">
                <button onClick={() => setParams({ product: String(n.product_id) })} className="text-left">
                  <p className="text-xs font-bold text-[#1D1D1F]">{n.po_number} · {n.product_name}</p>
                  <p className="text-[11px] font-medium text-[#FF3B30]">
                    {n.gaps.map(g => `${g.label} ${g.status === 'missing' ? 'missing' : g.zone === 'making' ? 'at maker' : 'not ready'}`).join(' · ')}
                  </p>
                </button>
                {n.gaps.some(g => g.status === 'missing') && (
                  <Button size="sm" variant="secondary"
                    onClick={() => setForm({ family: n.gaps.find(g => g.status === 'missing').family, product_id: n.product_id })}>
                    <Plus size={13} /> Create
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Family tabs + view toggle + active product filter */}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'all', label: 'All', count: data.tools.length },
          ...Object.entries(FAMILY_META).map(([k, m]) => ({ key: k, label: m.plural, count: counts[k] })),
        ]} />
        <div className="mb-4 flex w-fit gap-1 rounded-full border border-white/60 bg-[#1D1D1F]/[0.05] p-1 backdrop-blur-xl">
          {[['board', LayoutGrid, 'Board'], ['ledger', List, 'Ledger']].map(([k, Icon, label]) => (
            <button key={k} onClick={() => setView(k)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all duration-200 ease-apple ${
                view === k ? 'bg-white text-[#1D1D1F] shadow-[0_2px_8px_rgba(29,29,31,0.12)]' : 'text-[#6E6E73] hover:text-[#1D1D1F]'}`}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        {filterName && (
          <button onClick={() => setParams({})}
            className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-[#E1EFFF] px-3 py-1.5 text-xs font-semibold text-[#0064D2] hover:bg-[#D4E8FF]">
            Product: {filterName} <X size={12} />
          </button>
        )}
      </div>

      {view === 'board' ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {ZONES.map(z => {
            const zt = tools.filter(t => t.zone === z.key);
            return (
              <div key={z.key} className="glass flex flex-col rounded-[22px]">
                <div className="border-b border-[#1D1D1F]/[0.06] px-4 py-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#86868B]">{z.label}</p>
                    <span className="rounded-full bg-[#1D1D1F]/[0.06] px-2 text-[11px] font-bold tabular-nums text-[#6E6E73]">{zt.length}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#AEAEB2]">{z.desc}</p>
                </div>
                <div className="flex-1 space-y-2 p-3">
                  {zt.length === 0 && <p className="py-6 text-center text-xs text-[#AEAEB2]">Empty</p>}
                  {zt.map(t => <ToolCard key={t.id} t={t} onOpen={setSpot} />)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <DataTable searchable onRowClick={setSpot}
          columns={[
            { key: 'code', label: 'Code', render: t => {
              const M = FAMILY_META[t.family];
              return (
                <span className="flex items-center gap-2">
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${M.tint}`}><M.icon size={12} /></span>
                  <span className="font-semibold">{t.code}</span>
                </span>);
            } },
            { key: 'title', label: 'Tool' },
            { key: 'product_name', label: 'Product', render: t => t.product_name || <span className="text-gray-300">—</span> },
            { key: 'zone', label: 'Zone', render: t => ZONES.find(z => z.key === t.zone)?.label },
            { key: 'condition', label: 'Condition', render: t => (
              <span className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${DOT[t.condition]}`} />{t.condition}</span>) },
            { key: 'location', label: 'Location', render: t => t.location || '—' },
            { key: 'zone_seconds', label: 'In zone', render: t => age(t.zone_seconds) },
            { key: 'last_action', label: 'Last action', render: t => t.last_action
              ? `${fmt.title(t.last_action)} · ${fmt.dt(t.last_at)}` : '—' },
          ]}
          rows={tools} empty="No tools yet — add your first with New Tool" />
      )}

      {spot && <Spotlight tool={spot} onClose={() => setSpot(null)} onChanged={load}
        onEdit={t => { setSpot(null); setForm(t); }} />}
      {form && <ToolForm initial={form} products={products} onClose={() => setForm(null)} onSaved={load} />}
    </div>
  );
}
```

- [ ] **Step 2: Verify in the preview (full loop)**

With the seeded/real DB running: board shows four zone columns; family tabs filter; New Tool → create a plate → appears in Incoming; open it → move to In Rack (toast; possibly "N lines now ready"); Undo restores; condition pills work; Ledger view lists and searches; needed rail (if any gaps exist) filters by product and Create prefills. Check `preview_console_logs` for errors. Deactivate any test tool via Edit → (or leave — it's a real demo tool).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Tooling.jsx
git commit -m "feat(tooling): Tooling Hub page — KPI strip, needed rail, 4-zone board, ledger, spotlight"
```

---

### Task 10: Artwork chip + Masters/QuickCreate switchover

**Files:**
- Modify: `client/src/pages/Artwork.jsx`
- Modify: `client/src/pages/Masters.jsx`
- Modify: `client/src/components/QuickCreateMasters.jsx`

- [ ] **Step 1: Artwork — tooling chip column**

In `Artwork.jsx`: add `import { useNavigate } from 'react-router-dom';` and define after `Toggle`:

```jsx
// Tooling readiness chip — the Artwork ↔ Tooling Hub bridge. Emerald = gate
// satisfied; amber = registered tooling not ready yet; red = die missing.
function ToolingChip({ line }) {
  const nav = useNavigate();
  const d = line.tooling || [];
  const gaps = d.filter(x => (x.hard ? x.status !== 'ready' : x.status === 'not_ready'));
  const cls = line.tooling_ready ? 'bg-emerald-100 text-emerald-700'
    : gaps.some(g => g.hard && g.status === 'missing') ? 'bg-red-100 text-red-700'
    : 'bg-amber-100 text-amber-700';
  const label = line.tooling_ready ? '✓ Ready'
    : gaps.map(g => `${g.label} ${g.status === 'missing' ? 'missing' : g.zone === 'making' ? 'at maker' : 'not ready'}`).join(' · ');
  return (
    <button title="Open in Tooling Hub"
      onClick={e => { e.stopPropagation(); nav(`/tooling?product=${line.product_id}`); }}
      className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold transition-opacity hover:opacity-75 ${cls}`}>
      {label}
    </button>
  );
}
```

Inside `Artwork()`, add `const nav = useNavigate();` is NOT needed (chip has its own). In the `columns` array insert **after** the `lock` column:

```jsx
          { key: 'tooling', label: 'Tooling', sortable: false, render: l => <ToolingChip line={l} /> },
```

- [ ] **Step 2: Masters — retire the Dies tab, point products at tools**

In `Masters.jsx`:
1. Delete the whole `dies: { … }` config entry (label 'Dies', endpoint '/dies').
2. In the products fields, change `{ key: 'die_id', label: 'Die', type: 'ref', ref: 'dies' }` to `{ key: 'tool_id', label: 'Die', type: 'ref', ref: 'dies' }` (the refs key stays `dies`; only its source changes).
3. Change the refs loader `api.get('/dies').then(d => setRefs(r => ({ ...r, dies: d })));` to `api.get('/tools?family=die').then(d => setRefs(r => ({ ...r, dies: d })));`
4. Update the two ref-option display templates that build `` `Die #${x.die_number}…` `` (lines ~276/290 area): replace `Die #${x.die_number}` with `${x.code}` in both (tools have `code`, not `die_number`; `carton_size`/`condition` fields still exist).
5. In the delete-confirm message, drop the die fallback: change ``deleting?.name ?? (deleting?.die_number ? `Die #${deleting.die_number}` : 'this record')`` to `deleting?.name ?? 'this record'`.

- [ ] **Step 3: QuickCreateMasters — same switchover**

In `QuickCreateMasters.jsx`:
1. Form state key `die_id: ''` → `tool_id: ''`.
2. `api.get('/dies')` → `api.get('/tools?family=die')`.
3. `die_id: num(form.die_id)` → `tool_id: num(form.tool_id)`.
4. The `<Select value={form.die_id} onChange={e => set({ die_id: e.target.value })}>` → `value={form.tool_id}` / `set({ tool_id: e.target.value })`.
5. Option label `` `Die #${d.die_number}${…}` `` → `` `${d.code}${d.carton_size ? ` — ${d.carton_size}` : ''}${d.condition && d.condition !== 'Good' ? ` (${d.condition})` : ''}` ``.

- [ ] **Step 4: Verify in preview**

Artwork page: each row shows a tooling chip; click jumps to `/tooling?product=…` filtered. Masters: no Dies tab; Products form's Die picker lists tools codes and saves (`tool_id` persists after reload). Track page (`/track` → open a line): tooling milestone renders. `preview_console_logs` clean. Also grep the client for leftovers: `grep -rn "die_id\|/dies" client/src` → no matches.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Artwork.jsx client/src/pages/Masters.jsx client/src/components/QuickCreateMasters.jsx
git commit -m "feat(tooling): artwork tooling chips; masters & quick-create read dies from the tools hub"
```

---

### Task 11: End-to-end verification pass

**Files:** none (verification only; fix-forward anything found, committing fixes to the files involved)

- [ ] **Step 1: Server tests green** — `cd server && npm test` → all pass.
- [ ] **Step 2: The water-flow scenario in the preview**
  1. Pick (or create) an order line whose product has its die in `making` — it appears on Artwork.
  2. Approve Customer + QA → artwork locks; the line's tooling chip is amber/red; the line appears in the Tooling Hub "Needed for jobs" rail.
  3. In the hub, move the die to In Rack → toast reports the line flipped to ready; the rail entry disappears; the Artwork chip turns emerald; `/track` shows the tooling milestone done.
  4. Undo the move → chip regresses (line stays `ready` — status never auto-downgrades; that's correct and matches the artwork gate's behaviour).
- [ ] **Step 3: Regression sweep** — Planning (die shows), Production job card print (die number/location), Live Floor section page (die badge), Orders, Masters products CRUD. No console/network errors.
- [ ] **Step 4: Mobile check** — `preview_resize` mobile: board columns stack, rail scrolls horizontally, modals usable.
- [ ] **Step 5: Screenshot proof** — `preview_screenshot` of the Tooling Hub board and the Artwork page with chips; share with Anik.

---

### Task 12: Spec touch-up + docs commit

**Files:**
- Modify: `docs/superpowers/specs/2026-07-07-tooling-hub-design.md` (§3)

- [ ] **Step 1: Record the hard/soft gate refinement**

In §3 of the spec, replace the sentence "`readiness()` in helpers.js changes: the `tooling` gate passes when **every required tool exists, is healthy, and is `in_rack` or `on_floor`**." with:

```
`readiness()` in helpers.js changes: **die is a HARD requirement** (must exist,
be healthy and be `in_rack`/`on_floor` — exactly the old dies gate), while
**plate/block/shade card are SOFT** — they block only when a registered tool is
not ready; untracked soft tools inform but never block. This keeps real plant
data (dies only today) flowing unchanged while new tool records tighten the
gate as they're adopted.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-07-07-tooling-hub-design.md docs/superpowers/plans/2026-07-07-tooling-hub.md
git commit -m "docs(tooling): implementation plan; spec gate semantics refined to hard-die/soft-rest"
```
