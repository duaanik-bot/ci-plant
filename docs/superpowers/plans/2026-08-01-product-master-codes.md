# Product Master Three-Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The product master carries exactly three code fields — Item Code (party), Artwork Code (party), Internal Code (auto-issued from the customer's series, editable) — with the Internal Code prepopulated on every create path, and the existing structural/content duplicates fixed on the local mirror.

**Architecture:** `products.code` survives as the Internal Code (it holds the UNIQUE constraint and the series); `internal_carton_code` becomes a server-kept mirror of it so FG matching never changes. The pure series arithmetic (`product-code.js`) moves to `client/src/lib/productCode.js` and is shared by both sides, exactly as `customerCode.js` already is. A standalone script fixes the data.

**Tech Stack:** Express + pg (server), React + Vite (client), `node --test` (tests). Spec: `docs/superpowers/specs/2026-08-01-product-master-codes-design.md`.

**Session constraints (override the skill template):**
- **NO `git commit`, NO push, NO deploy** — the working agreement for this session. Every "Commit" step in the template is replaced by "leave on disk". Do not commit even the plan.
- Worktree: `/tmp/ci-erp-product-codes`, branch `product-code-fields` off `origin/main@2ece413`. `node_modules` is a symlink to the main tree's.
- The shared embedded PG on `:5439` (db `cierp`) is owned by another session's API server — connect to it, never restart it. UAT writes must be `UAT-*`-named and deleted after.
- Production DB access is **read-only dry-run reporting only**, via the env at `~/.config/ci-erp/live-db.env`.

---

### Task 1: Shared series lib — `client/src/lib/productCode.js`

The pure module moves client-side so the Masters form can prefill without a request. It gains one new function, `nextCodeForRows`, which derives the two code lists from rows a page already holds.

**Files:**
- Create: `client/src/lib/productCode.js` (content = `server/src/product-code.js` + new helper)
- Modify: `server/src/product-code.test.js` (import path + new failing tests)
- Modify: `server/src/routes/masters.js:5` (import path)
- Delete: `server/src/product-code.js`

- [ ] **Step 1: Add failing tests for `nextCodeForRows`**

Append to `server/src/product-code.test.js` (and change its import line to the new path — the file won't resolve until Step 3, which IS the failure):

```js
// import line at top becomes:
import { dominantPrefix, nextNumber, formatCode, nextCodeFrom, nextCodeForRows } from '../../client/src/lib/productCode.js';
```

```js
test('nextCodeForRows: derives both lists from loaded rows — the form-side entry point', () => {
  const rows = [
    { code: 'SW-001', customer_id: 5 }, { code: 'SW-767', customer_id: 5 },
    { code: 'SGB-335', customer_id: 4 },
  ];
  assert.equal(nextCodeForRows({ rows, customerId: 5, customerName: 'Swiss Garnier Life Sciences' }), 'SW-768');
});

test('nextCodeForRows: the number scans the PREFIX globally, not the customer', () => {
  // A foreign row already sitting in the prefix must push the number up —
  // products.code is globally unique, so colliding with it would 409.
  const rows = [
    { code: 'SW-010', customer_id: 5 },
    { code: 'SW-900', customer_id: 99 }, // stray foreign row in the same series
  ];
  assert.equal(nextCodeForRows({ rows, customerId: 5, customerName: 'Swiss' }), 'SW-901');
});

test('nextCodeForRows: a brand-new customer starts at initials-001', () => {
  assert.equal(nextCodeForRows({ rows: [], customerId: 7, customerName: 'Galpha Laboratories Ltd' }), 'GL-001');
});

test('nextCodeForRows: string/number customer ids compare loosely — form selects hand back strings', () => {
  const rows = [{ code: 'PF-048', customer_id: 2 }];
  assert.equal(nextCodeForRows({ rows, customerId: '2', customerName: 'Pureflix' }), 'PF-049');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /tmp/ci-erp-product-codes && node --test server/src/product-code.test.js`
Expected: FAIL — `Cannot find module .../client/src/lib/productCode.js`

- [ ] **Step 3: Create `client/src/lib/productCode.js`**

Copy the whole of `server/src/product-code.js`, change the `customerInitials` import to `'./customerCode.js'`, append the new helper:

```js
// (existing header comment and dominantPrefix / nextNumber / formatCode /
//  nextCodeFrom stay byte-identical, except:)
import { customerInitials } from './customerCode.js';

// ...existing exports unchanged...

// Form-side entry point: derive both code lists from rows a page already has
// loaded (Masters and Orders both hold the full product list), so prefilling
// the Internal Code costs no request. Loose id compare — form selects hand
// back strings.
export function nextCodeForRows({ rows, customerId, customerName }) {
  const customerCodes = (rows || [])
    .filter(r => String(r.customer_id) === String(customerId))
    .map(r => r.code).filter(Boolean);
  const prefix = dominantPrefix(customerCodes) || customerInitials(customerName);
  const head = `${prefix.toUpperCase()}-`;
  const allCodesInPrefix = (rows || [])
    .map(r => r.code).filter(c => String(c || '').toUpperCase().startsWith(head));
  return formatCode(prefix, nextNumber(allCodesInPrefix, prefix));
}
```

- [ ] **Step 4: Repoint the server import and delete the old module**

`server/src/routes/masters.js:5`:

```js
import { dominantPrefix, nextNumber, formatCode } from '../../../client/src/lib/productCode.js';
```

Then: `rm server/src/product-code.js`

- [ ] **Step 5: Run the moved tests plus the import guard**

Run: `node --test server/src/product-code.test.js server/src/app-imports.test.js`
Expected: PASS both. `app-imports.test.js` is the guard against the "route imports a deleted export, every endpoint 500s while verify stays green" trap — it must run in the same breath as the deletion.

---

### Task 2: Server — blank code assigns from the series; `internal_carton_code` mirrors; readable 409

**Files:**
- Modify: `server/src/helpers.js` (new exported `nextProductCode`)
- Modify: `server/src/routes/masters.js` (POST/PUT for products, migrate-customer, local `nextProductCode` removed)

- [ ] **Step 1: Move `nextProductCode` into `helpers.js`**

`import.js` needs it too (Task 3), and helpers.js is where shared server logic lives (`audit`, `fgMatchPredicate`). Add to `server/src/helpers.js` (it already imports `{ q, one }` from `./db.js` — verify and extend that import if `q` is missing):

```js
import { dominantPrefix, nextNumber, formatCode } from '../../client/src/lib/productCode.js';
import { customerInitials } from '../../client/src/lib/customerCode.js';

// The next code in a customer's series, read off the data (SW-001..767 style
// dense series; see productCode.js). Number is derived over EVERY code in the
// prefix — products.code is globally unique, so this cannot collide with an
// inactive or foreign row. Two simultaneous creates could still race to the
// same number; the unique index rejects the loser, and at one-planner scale
// that is a retry, not a design problem.
export async function nextProductCode(customerId) {
  const cust = await one('SELECT name FROM customers WHERE id=$1', [customerId]);
  const customerCodes = (await q('SELECT code FROM products WHERE customer_id=$1 AND code IS NOT NULL', [customerId])).map(x => x.code);
  const prefix = dominantPrefix(customerCodes) || customerInitials(cust?.name || '');
  const allCodesInPrefix = (await q("SELECT code FROM products WHERE code LIKE $1 || '-%'", [prefix])).map(x => x.code);
  return formatCode(prefix, nextNumber(allCodesInPrefix, prefix));
}
```

Delete the local `nextProductCode` from `masters.js` (lines ~245-258) and import it: add `nextProductCode` to the existing `import { audit } from '../helpers.js'` line. Drop masters.js's now-unused `dominantPrefix/nextNumber/formatCode/customerInitials` imports.

- [ ] **Step 2: POST `/products` — assign blank code, mirror, 409**

In the generic POST handler in `masters.js` (after the `syncProductBoardName` line):

```js
if (table === 'products') {
  await syncProductBoardName(req.body, null);
  // Internal Code: blank means "issue the next code in this customer's
  // series" — the client normally prefills it, but the server is the
  // authority so a bare API create is never born code-less.
  if (!req.body.code || !String(req.body.code).trim()) {
    req.body.code = await nextProductCode(+req.body.customer_id);
  }
  // internal_carton_code is a server-kept mirror of code (the FG-matching
  // key) — the form no longer carries it.
  req.body.internal_carton_code = req.body.code;
}
```

And extend the catch to translate the unique violation (POST and PUT both):

```js
} catch (e) {
  if (table === 'products' && e.code === '23505' && e.constraint === 'products_code_key') {
    e.status = 409;
    e.message = `Internal Code ${req.body.code} is already taken — clear the field to take the next code in the series.`;
  }
  next(e);
}
```

- [ ] **Step 3: PUT `/products/:id` — mirror follows every code write**

In the PUT handler, directly after the existing customer-change regeneration block (which sets `req.body.code`), add:

```js
// Whatever code this row ends up with, the mirror follows it.
if (table === 'products' && req.body.code != null && String(req.body.code).trim()) {
  req.body.internal_carton_code = String(req.body.code).trim();
}
```

Note `internal_carton_code` is already in `MASTERS.products`, so the generic column filter writes it.

- [ ] **Step 4: migrate-customer keeps the mirror**

In `r.post('/products/:id/migrate-customer')`, the UPDATE becomes:

```js
const [updated] = await qc('UPDATE products SET customer_id=$1, code=$2, internal_carton_code=$2 WHERE id=$3 RETURNING *', [target, code, req.params.id]);
```

- [ ] **Step 5: Run the suite**

Run: `npm test -w server`
Expected: PASS (these are route-file changes; `app-imports.test.js` re-proves every route still imports).

---

### Task 3: PO-import quick-create is born in the series

**Files:**
- Modify: `server/src/routes/import.js` (the `/orders/import/quick-product` handler, ~line 172)

- [ ] **Step 1: Replace the `NEW-` stamp**

Add `nextProductCode` to import.js's existing helpers import. Then in the handler, replace:

```js
const seq = await one('SELECT COALESCE(MAX(id),0)+1 AS n FROM products');
const code = `NEW-${String(seq.n).padStart(4, '0')}`;
```

with:

```js
// Born in the customer's real series (SW-768, not NEW-0042) — same authority
// the Masters form and customer migration use.
const code = await nextProductCode(+customer_id);
```

and make the INSERT carry the mirror — column list gains `internal_carton_code`, values gain a second `$3` reference. Full statement:

```js
const [p] = await q(`
  INSERT INTO products (customer_id, name, code, internal_carton_code, board_material_id, board_grade, gsm, ups, rate, product_type, gst_pct, spec_incomplete, active)
  VALUES ($1,$2,$3,$3,$4,$5,$6,1,$7,$8,$9,1,1) RETURNING *`,
  [customer_id, name.trim(), code, board.id, board_grade?.trim() || null,
   gsm != null && gsm !== '' ? Math.round(+gsm) : null, rate ?? 0, product_type || null, gst_pct ?? null]);
```

- [ ] **Step 2: Run the suite**

Run: `npm test -w server`
Expected: PASS.

---

### Task 4: Masters form — three codes, Customer first, seed on pick

**Files:**
- Modify: `client/src/pages/Masters.jsx` (products `fields`, ref-onChange engine branch, products `validate`, default-Input branch for mono)

- [ ] **Step 1: Rewrite the identity block of the products config**

Import at top of Masters.jsx: `import { nextCodeForRows } from '../lib/productCode.js';`

Replace the current five identity entries (`name`, `code`, `internal_carton_code`, `party_item_code`, `party_artwork_code`, `output_number`, `customer_id`) with:

```js
// Identity & codes — exactly three codes live here. Internal Code is OURS
// (auto-issued from the customer's series the moment the customer is picked,
// still editable); Item Code and Artwork Code are the PARTY's. The old
// Internal Carton Code field is gone: the column survives as a server-kept
// mirror of code, so FG matching is untouched.
{ key: 'name', label: 'Name', required: true },
{ key: 'customer_id', label: 'Customer', type: 'ref', ref: 'customers', required: true },
{ key: 'code', label: 'Internal Code', mono: true, newRow: true, hint: 'Auto-issued from the customer\'s series (e.g. SW-768). Editable — clear it to take the next code.' },
{ key: 'party_item_code', label: 'Item Code', hint: 'The customer\'s own item / SKU code' },
{ key: 'party_artwork_code', label: 'Artwork Code', newRow: true, hint: 'The customer\'s artwork code' },
{ key: 'output_number', label: 'Output Number', hint: 'Print set number — auto-populates single-run plans in the Planning Engine' },
```

(The board block that used to follow `customer_id` keeps its existing `newRow` shape — `board_material_id` already opens its own row.) Note `code` loses `required: true` — blank now legitimately means "server issues it". The products-list column header follows the field label automatically via `f?.label` at Masters.jsx:456.

- [ ] **Step 2: Seed on customer pick — the engine's `ref` branch**

Mirror the `graderef` precedent (grade pick seeds packet size). The `ref` Select's onChange becomes:

```js
onChange={e => {
  const v = e.target.value;
  // Picking the customer on a NEW product issues the next Internal Code in
  // that customer's series. A hand-typed code survives a customer change —
  // only a blank field or our own previous suggestion is overwritten
  // (same blank-check philosophy as the grade → packet-size seed).
  if (tab === 'products' && f.key === 'customer_id' && !editing.id) {
    const cust = (refs.customers || []).find(x => String(x.id) === String(v));
    const cur = editing.code ?? '';
    if (v && cust && (cur === '' || cur === editing._autoCode)) {
      const next = nextCodeForRows({ rows, customerId: v, customerName: cust.name });
      return setEditing({ ...editing, [f.key]: v, code: next, _autoCode: next });
    }
  }
  setEditing({ ...editing, [f.key]: v });
}}
```

`_autoCode` rides on `editing` only — `save()` builds the body from `cfg.fields`, so a non-field key never reaches the server.

- [ ] **Step 3: Mono rendering for the code field**

In the engine's final default branch (the plain `<Input>`), thread the flag:

```js
<Input value={editing[f.key] ?? ''} className={f.mono ? 'font-mono' : undefined}
  onChange={e => setEditing({ ...editing, [f.key]: e.target.value })} />
```

(Check `Input` in `components/ui.jsx` merges `className`; if it doesn't, extend it the way other ui.jsx components merge theirs.)

- [ ] **Step 4: Duplicate-code validate on the products config**

Add to the products config, after `columns` (shape copied from the boards validate):

```js
// The Internal Code is editable, so a typed duplicate must be caught here
// with a name, not surface as a raw unique-key 500. Blank passes — the
// server issues the next code in the series.
validate: (body, { rows, editing }) => {
  const typed = String(body.code ?? '').trim().toLowerCase();
  if (!typed) return null;
  const clash = rows.find(r => String(r.id) !== String(editing.id ?? '')
    && String(r.code ?? '').trim().toLowerCase() === typed);
  return clash ? `${clash.code} already belongs to ${clash.name}. Clear the field to take the next code in the series.` : null;
},
```

- [ ] **Step 5: Build**

Run: `npm run build -w client`
Expected: clean build, no unresolved imports.

---

### Task 5: SO quick-create prefills; Orders passes the seed

**Files:**
- Modify: `client/src/components/QuickCreateMasters.jsx` (ProductQuickCreate)
- Modify: `client/src/pages/Orders.jsx:1229-1231` (pass `suggestedCode`)

- [ ] **Step 1: ProductQuickCreate takes and seeds `suggestedCode`**

Signature becomes `({ open, onClose, customerId, customerName, suggestedCode, onCreated })`. In the open-effect, seed the form:

```js
useEffect(() => {
  if (!open) return;
  // Internal Code arrives pre-issued from the customer's series (computed by
  // the caller from its already-loaded product list). Editable; blank still
  // works — the server issues the code on save.
  setForm({ ...PRODUCT_BLANK, code: suggestedCode || '' });
  ...existing refs load unchanged...
}, [open, suggestedCode]);
```

The code field relabels and stops gating Save:

```js
const ready = form.name && form.board_material_id && form.ups && form.rate;
```

```js
<Field label="Internal Code" hint="Auto-issued — clear to take the next code on save">
  <Input className="font-mono" value={form.code} onChange={e => set({ code: e.target.value })} />
</Field>
```

- [ ] **Step 2: Orders computes the seed**

`client/src/pages/Orders.jsx` — import `nextCodeForRows` from `../lib/productCode.js`, and the ProductQuickCreate call site (~line 1229) gains:

```js
suggestedCode={quickCustomerId ? nextCodeForRows({
  rows: products, customerId: quickCustomerId,
  customerName: customers.find(c => String(c.id) === String(quickCustomerId))?.name,
}) : ''}
```

(`products` is Orders' full product list, loaded at line 251.)

- [ ] **Step 3: Build**

Run: `npm run build -w client`
Expected: clean.

---

### Task 6: Artwork read-only panel — one code, not two

**Files:**
- Modify: `client/src/pages/Artwork.jsx:602-607`

- [ ] **Step 1: Collapse the twin fields**

The panel currently shows "Internal Carton Code" and "Carton (Product) Code" — the same value twice under the new invariant. Replace both Fields with one:

```jsx
<Field label="Internal Code">
  <Input value={editing.product_code || '—'} disabled readOnly />
</Field>
```

- [ ] **Step 2: Build**

Run: `npm run build -w client`
Expected: clean.

---

### Task 7: `scripts/fix-product-codes.mjs` — mirror cleanup + reports

**Files:**
- Create: `scripts/fix-product-codes.mjs`

- [ ] **Step 1: Write the script**

Follow the house pattern (`import-grn.mjs`: `DEFAULT_LOCAL`, `--apply`, JSON backup, one `BEGIN/COMMIT`). Dry-run is **pure SELECT — zero writes by construction**, so pointing it at prod is safe. Full script:

```js
// Product-code cleanup — the data half of the three-codes design
// (docs/superpowers/specs/2026-08-01-product-master-codes-design.md).
//
//   node scripts/fix-product-codes.mjs            dry run (pure SELECT — safe anywhere)
//   node scripts/fix-product-codes.mjs --apply    write, one transaction, backup first
//
// CHANGES (apply mode):
//   1. internal_carton_code := code where NULL or '' — closes the FG
//      cross-match: helpers.js gates on IS NOT NULL, so the three ''-rows
//      (SGB-325/327/328, three different ZIKDUCE cartons) currently match each
//      other's finished-goods lots.
//   2. party_artwork_code := NULL on the 14 rows holding a DATE — an old
//      import sliced "SALE - 11/25" off the name into the artwork field. The
//      name still carries it; nothing is lost.
//
// REPORTED, NEVER CHANGED:
//   - within-customer artwork duplicates (CSV) — a data call for Anik;
//   - codes outside every series (PCSG493) — legal now the field is editable;
//   - R0–R5 revision markers (Anik, 2026-08-01: leave them; they go inert for
//     FG matching once every row's internal_carton_code = code).
//
// INVARIANT asserted after apply, transaction refuses to commit without it:
//   every product has internal_carton_code = code, none NULL, none ''.
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCAL = 'postgresql://postgres:postgres@localhost:5439/cierp';
const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL || DEFAULT_LOCAL;
const c = new pg.Client({ connectionString: url });
await c.connect();
const where = /supabase|pooler|amazonaws/.test(url) ? 'REMOTE/PROD' : 'local mirror';
console.log(`fix-product-codes — ${APPLY ? 'APPLY' : 'dry run'} against ${where}`);
if (APPLY && where !== 'local mirror') { console.error('Refusing to --apply anywhere but the local mirror.'); process.exit(1); }

const mirrorBad = (await c.query(`SELECT id, code, internal_carton_code, name FROM products
  WHERE internal_carton_code IS NULL OR trim(internal_carton_code) = '' OR internal_carton_code <> code ORDER BY id`)).rows;
const dateJunk = (await c.query(`SELECT id, code, name, party_artwork_code FROM products
  WHERE party_artwork_code ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' ORDER BY id`)).rows;
const artworkDups = (await c.query(`SELECT p.customer_id, cu.name AS customer, upper(trim(p.party_artwork_code)) AS artwork_code,
    count(*) AS n, string_agg(p.code, ', ' ORDER BY p.code) AS codes
  FROM products p LEFT JOIN customers cu ON cu.id = p.customer_id
  WHERE p.party_artwork_code IS NOT NULL AND trim(p.party_artwork_code) <> ''
    AND p.party_artwork_code !~* '^R[0-9]+$' AND p.party_artwork_code !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
  GROUP BY 1, 2, 3 HAVING count(*) > 1 ORDER BY n DESC, 1`)).rows;
const offSeries = (await c.query(`SELECT id, code, name FROM products WHERE code !~ '^[A-Z]+-[0-9]+$' ORDER BY id`)).rows;

console.log(`\nmirror fix (internal_carton_code := code): ${mirrorBad.length} rows`);
for (const r of mirrorBad) console.log(`  #${r.id} ${r.code}  icc=${JSON.stringify(r.internal_carton_code)}  ${r.name}`);
console.log(`\nartwork date-junk → NULL: ${dateJunk.length} rows`);
for (const r of dateJunk) console.log(`  #${r.id} ${r.code}  "${r.party_artwork_code}"  ${r.name}`);
console.log(`\nREPORT ONLY — within-customer artwork duplicates: ${artworkDups.length} groups`);
console.log(`REPORT ONLY — codes outside every series: ${offSeries.map(r => r.code).join(', ') || 'none'}`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const csv = ['customer,artwork_code,n,codes',
  ...artworkDups.map(g => `"${g.customer}","${g.artwork_code}",${g.n},"${g.codes}"`)].join('\n');
fs.writeFileSync(path.join(root, `artwork-dup-report-${stamp}.csv`), csv);
console.log(`\nartwork duplicate CSV → artwork-dup-report-${stamp}.csv`);

if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); await c.end(); process.exit(0); }

const backup = { when: new Date().toISOString(), url: 'local mirror', mirrorBad, dateJunk };
const bpath = path.join(root, `PRODUCT-CODES-BACKUP-${stamp}.json`);
fs.writeFileSync(bpath, JSON.stringify(backup, null, 2));
console.log(`backup → ${bpath}`);

try {
  await c.query('BEGIN');
  const m = await c.query(`UPDATE products SET internal_carton_code = code
    WHERE internal_carton_code IS NULL OR trim(internal_carton_code) = '' OR internal_carton_code <> code`);
  const d = await c.query(`UPDATE products SET party_artwork_code = NULL
    WHERE party_artwork_code ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'`);
  const bad = await c.query(`SELECT count(*)::int AS n FROM products
    WHERE internal_carton_code IS DISTINCT FROM code OR internal_carton_code IS NULL OR trim(internal_carton_code) = ''`);
  if (bad.rows[0].n !== 0) throw new Error(`invariant failed: ${bad.rows[0].n} rows where internal_carton_code != code`);
  await c.query('COMMIT');
  console.log(`\nAPPLIED: mirror fixed on ${m.rowCount}, dates cleared on ${d.rowCount}. Invariant holds on every row.`);
} catch (e) {
  await c.query('ROLLBACK');
  console.error('ROLLED BACK:', e.message);
  process.exit(1);
} finally { await c.end(); }
```

- [ ] **Step 2: Dry-run on the mirror**

Run: `node scripts/fix-product-codes.mjs`
Expected: `mirror fix: 4 rows` (ids 486, 488, 489, 1631), `date-junk: 14 rows`, `27 groups` in the CSV, `PCSG493` flagged, "Dry run — nothing written."

- [ ] **Step 3: Apply on the mirror**

Run: `node scripts/fix-product-codes.mjs --apply`
Expected: backup JSON written; `APPLIED: mirror fixed on 4, dates cleared on 14. Invariant holds on every row.`

- [ ] **Step 4: Prod dry-run report**

Run: `set -a; source ~/.config/ci-erp/live-db.env; set +a; DATABASE_URL="$LIVE_DATABASE_URL" node scripts/fix-product-codes.mjs`
(Check the env file's actual variable name first.) Expected: the same four sections against prod data, nothing written (pure SELECT). Save the output for Anik.

---

### Task 8: Full verify + UAT in the running app

**Files:**
- Create: `/Users/anikdua/Documents/Projects/Colour Imp Production/.claude/launch.json` (session project dir — preview_start reads it from there)

- [ ] **Step 1: The whole suite in the clean worktree**

Run: `cd /tmp/ci-erp-product-codes && npm run verify`
Expected: baseline check OK (clean worktree — the `--check` regenerates-then-compares trap only bites on a dirty parallel tree), server tests all pass, client builds.

- [ ] **Step 2: Launch API + client on this session's own ports**

launch.json in the session project dir:

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "codes-api", "runtimeExecutable": "bash",
      "runtimeArgs": ["-lc", "cd /tmp/ci-erp-product-codes/server && DATABASE_URL=postgresql://postgres:postgres@localhost:5439/cierp PORT=4790 node src/index.js"],
      "port": 4790 },
    { "name": "codes-web", "runtimeExecutable": "bash",
      "runtimeArgs": ["-lc", "cd /tmp/ci-erp-product-codes/client && VITE_API_TARGET=http://localhost:4790 npx vite --port 5790 --strictPort"],
      "port": 5790 }
  ]
}
```

Start `codes-api`, then `codes-web`, then browse `http://localhost:5790`. Login `admin@motionci.com` / `admin123`.

- [ ] **Step 3: UAT — Masters create path**

Masters ▸ Products ▸ New Product: confirm the identity block reads Name | Customer, Internal Code | Item Code, Artwork Code | Output Number, and **no Product Code / Internal Carton Code fields**. Pick customer Pureflix → Internal Code seeds `PF-049` (mono). Switch customer to Herboveda → reseeds `HRB-004`. Type `SW-001` → Save → the named-clash validate blocks. Clear code, fill required fields, name `UAT-CODES-MASTERS`, Save → row lands with a `HRB-` code, and (via SQL) `internal_carton_code = code`.

- [ ] **Step 4: UAT — SO quick-create path**

Orders ▸ New Customer Order ▸ pick customer ▸ quick-create product: Internal Code arrives prefilled from the series; save as `UAT-CODES-SO`; confirm code + mirror via SQL.

- [ ] **Step 5: UAT — PO-import quick-create (API probe)**

The wizard path needs a PDF; probe the route directly with a login token against `:4790`:

```bash
TOK=$(curl -s localhost:4790/api/auth/login -H 'content-type: application/json' -d '{"email":"admin@motionci.com","password":"admin123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s localhost:4790/api/orders/import/quick-product -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"customer_id":1,"name":"UAT-CODES-PO","rate":1}'
```

Expected: response `code` is `HRB-00x` (Herboveda's series — one past whatever UAT-CODES-MASTERS took), **not** `NEW-…`, and `internal_carton_code` equals it.

- [ ] **Step 6: Screenshots + cleanup**

Screenshot the new-product modal (seeded code) and the clash message for Anik. Then delete every UAT row:

```sql
DELETE FROM products WHERE name LIKE 'UAT-CODES%';
```

and re-run the invariant check (0 bad rows). Report done — **no commit** (working agreement).

---

## Self-review

- **Spec coverage:** form restructure → Task 4; shared derivation → Task 1; server authority + mirror + 409 → Task 2; SO prepopulation → Tasks 3 & 5 (both quick-create doors); Artwork twin display → Task 6; cleanup + reports → Task 7; verification-in-real-app → Task 8. Out-of-scope items (PCSG493 renumber, artwork merges, R-markers, prod writes) appear only as reports.
- **Placeholder scan:** every code step carries the code; no TBDs.
- **Type consistency:** `nextCodeForRows({ rows, customerId, customerName })` identical at all three call sites; `nextProductCode(customerId)` identical at all three server call sites; `_autoCode` only in Task 4.
