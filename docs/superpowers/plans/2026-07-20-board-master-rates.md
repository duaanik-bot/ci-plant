# Board Master, Category Rates & Weight-Aware Procurement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Board is bought by weight. Set one ₹/kg per grade (optionally per vendor) and have every board's ₹/sheet, packet weight, PO totals and warehouse tonnage derive from it automatically.

**Architecture:** Three structured columns on `materials` (`grade`, `gsm`, `sheets_per_packet`) plus a new `board_rates` table keyed on (grade, vendor). All money and weight figures are **derived at read time** by a pure helper module — nothing is cached, so changing a grade's ₹/kg reprices its boards with no backfill. The helper is mirrored client-side and a test asserts the twins agree, following the existing `helpers.childFit` / `WarehousePicker.clientFit` precedent.

**Tech Stack:** Node ESM + Express + embedded Postgres (`:5439/cierp`); React 18 + Vite + Tailwind. Tests are `node --test` over colocated `server/src/*.test.js`.

**Spec:** `docs/superpowers/specs/2026-07-20-board-master-rates-design.md`

---

## ⚠️ Project conventions — read before starting

1. **NEVER run `git commit` in this repo.** Project rule. Every task below ends with a **Verify** step instead of a commit. Do not add commits back in.
2. **Work only in this local `ci-erp`** against embedded Postgres on `:5439/cierp`. Do not touch the look-alike `CI-Production` / Supabase app.
3. **Never run an unscoped `DELETE`/`UPDATE`** on the shared DB. Every migration statement below is either `ADD COLUMN IF NOT EXISTS` or scoped by an explicit `WHERE`.
4. **The running server may not hot-reload.** `npm run dev -w server` uses `node --watch`, but a manually started plain `node` instance will not pick up server edits. To verify server changes, start a temp server on a spare port reusing the live DB (see "Verifying against the app" below).
5. **UI changes must be visibly different at a glance** — Anik judges a UI pass on the before/after. No dark mode.

### Running the test suite

```bash
cd "/Users/anikdua/Documents/Projects/Colour Imp Production/Colour Imp Production/ci-erp"
npm test -w server
```

Runs `node --test src/*.test.js`. A new `src/<module>.test.js` is picked up automatically.

### Verifying against the app

```bash
# temp server on a spare port against the LIVE db
cd "…/ci-erp/server" && PORT=4100 node src/index.js
# client (already proxies to :4000; for a temp port, hit the API directly with curl)
```
Login: `admin@motionci.com` / `admin123`. Full UI verification is done in the real running app at desktop breakpoint — never a mock.

---

## File Structure

**Create:**
| File | Responsibility |
|---|---|
| `server/src/board-math.js` | Pure weight/rate maths + rate resolution. No DB, no Express. |
| `server/src/board-math.test.js` | Unit + golden-value + client-twin parity tests. |
| `server/src/board-code.js` | Composes board `name` and `spec` code from structured fields. |
| `server/src/board-code.test.js` | Composition + collision + round-trip-against-live-data tests. |
| `client/src/lib/boardMath.js` | Verbatim client twin of `board-math.js`. |
| `server/src/routes/board-rates.js` | CRUD for `board_rates`. |
| `server/src/backfill-boards.js` | One-shot idempotent migration of the 303 boards. |

**Modify:**
| File | Change |
|---|---|
| `server/src/db.js` (append at end of migrations, before closing `}` at :1383) | `board_rates` table + 3 `materials` columns |
| `server/src/routes/masters.js:32` | whitelist `grade`, `gsm`, `sheets_per_packet` |
| `server/src/index.js:39` area | mount `/board-rates` router |
| `server/src/routes/procurement.js:235-239, 299-302, 731-781` | rate resolution + pendency weight |
| `server/src/routes/inventory.js:10-37` | warehouse weight |
| `client/src/pages/Masters.jsx:128-163, 265-300, 518-593` | Boards form, Board Rates tab, columns |
| `client/src/components/ProcurementForms.jsx:19-28, 119-123, 137-142, 199-251` | rate fill, weight columns, totals |
| `client/src/pages/POPrint.jsx:93-119` | spec block + weight summary |
| `client/src/pages/Procurement.jsx:699-861` | pending list detail |
| `client/src/pages/Inventory.jsx:199-210, 278-309` | total weight column |

---

# PHASE 1 — Foundation (model, maths, migration)

No user-visible change. Ends with 303 boards carrying real grade/GSM and 4 seeded rates.

---

### Task 1: Board weight & rate maths

**Files:**
- Create: `server/src/board-math.js`
- Create: `server/src/board-math.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/board-math.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kgPerSheet, packetWeight, ratePerSheet, packetRate, totalWeight, packets, resolveRatePerKg } from './board-math.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

// ── kgPerSheet ────────────────────────────────────────────────────────
// gsm × (L×0.0254) × (W×0.0254) / 1000 — the spreadsheet's column J formula.
test('kgPerSheet: golden values from the plant spreadsheet', () => {
  near(kgPerSheet({ gsm: 330, sheet_l: 24.6, sheet_w: 31.2 }), 0.16340715705599998);
  near(kgPerSheet({ gsm: 290, sheet_l: 20, sheet_w: 38 }), 0.14219326399999999);
  near(kgPerSheet({ gsm: 300, sheet_l: 23, sheet_w: 36 }), 0.160257744);
  near(kgPerSheet({ gsm: 205, sheet_l: 22, sheet_w: 28 }), 0.08147080479999998);
});
test('kgPerSheet: missing or zero inputs return null, never 0', () => {
  assert.equal(kgPerSheet({ gsm: null, sheet_l: 20, sheet_w: 30 }), null);
  assert.equal(kgPerSheet({ gsm: 300, sheet_l: 0, sheet_w: 30 }), null);
  assert.equal(kgPerSheet({ gsm: 300, sheet_w: 30 }), null);
  assert.equal(kgPerSheet(null), null);
  assert.equal(kgPerSheet(undefined), null);
});

// ── packetWeight ──────────────────────────────────────────────────────
test('packetWeight: rounds to the spreadsheet 3dp display value', () => {
  assert.equal(+packetWeight({ gsm: 330, sheet_l: 24.6, sheet_w: 31.2, sheets_per_packet: 144 }).toFixed(3), 23.531);
  assert.equal(+packetWeight({ gsm: 290, sheet_l: 20, sheet_w: 38, sheets_per_packet: 100 }).toFixed(3), 14.219);
  assert.equal(+packetWeight({ gsm: 205, sheet_l: 22, sheet_w: 28, sheets_per_packet: 150 }).toFixed(3), 12.221);
});
test('packetWeight: null when sheets_per_packet is unknown', () => {
  assert.equal(packetWeight({ gsm: 300, sheet_l: 23, sheet_w: 36 }), null);
  assert.equal(packetWeight({ gsm: 300, sheet_l: 23, sheet_w: 36, sheets_per_packet: 0 }), null);
});

// ── ratePerSheet / packetRate ─────────────────────────────────────────
test('ratePerSheet: kg/sheet × ₹/kg', () => {
  near(ratePerSheet({ gsm: 300, sheet_l: 23, sheet_w: 36 }, 81), 12.980877264);
  near(ratePerSheet({ gsm: 290, sheet_l: 20, sheet_w: 38 }, 79), 11.233267856);
});
test('packetRate: matches the spreadsheet column K to 2dp', () => {
  const saffire = { gsm: 300, sheet_l: 23, sheet_w: 36, sheets_per_packet: 100 };
  assert.equal(+packetRate(saffire, 81).toFixed(2), 1298.09);
  const duplexGb = { gsm: 330, sheet_l: 24.6, sheet_w: 31.2, sheets_per_packet: 144 };
  assert.equal(+packetRate(duplexGb, 45).toFixed(2), 1058.88);
});
test('rates: a null/zero ₹/kg yields null, not 0 — "no rate" must be visible', () => {
  assert.equal(ratePerSheet({ gsm: 300, sheet_l: 23, sheet_w: 36 }, null), null);
  assert.equal(ratePerSheet({ gsm: 300, sheet_l: 23, sheet_w: 36 }, 0), null);
  assert.equal(packetRate({ gsm: 300, sheet_l: 23, sheet_w: 36, sheets_per_packet: 100 }, null), null);
});

// ── totalWeight / packets ─────────────────────────────────────────────
test('totalWeight: sheets × kg/sheet, and 0 sheets is a real 0', () => {
  near(totalWeight({ gsm: 300, sheet_l: 23, sheet_w: 36 }, 1000), 160.257744);
  assert.equal(totalWeight({ gsm: 300, sheet_l: 23, sheet_w: 36 }, 0), 0);
  assert.equal(totalWeight({ gsm: null, sheet_l: 23, sheet_w: 36 }, 1000), null);
});
test('packets: fractional packets are preserved, never rounded', () => {
  assert.equal(packets({ sheets_per_packet: 100 }, 250), 2.5);
  assert.equal(packets({ sheets_per_packet: 144 }, 144), 1);
  assert.equal(packets({ sheets_per_packet: null }, 250), null);
});

// ── resolveRatePerKg ──────────────────────────────────────────────────
const RATES = [
  { grade: 'Saffire', vendor_id: null, rate_per_kg: 81, active: 1 },
  { grade: 'Saffire', vendor_id: 7, rate_per_kg: 84, active: 1 },
  { grade: 'FBB', vendor_id: null, rate_per_kg: 79, active: 1 },
  { grade: 'Duplex GB', vendor_id: null, rate_per_kg: 45, active: 0 }, // inactive
];

test('resolveRatePerKg: vendor row wins over base', () => {
  assert.deepEqual(resolveRatePerKg(RATES, 'Saffire', 7), { rate_per_kg: 84, source: 'vendor' });
});
test('resolveRatePerKg: falls back to base when the vendor has no row', () => {
  assert.deepEqual(resolveRatePerKg(RATES, 'Saffire', 9), { rate_per_kg: 81, source: 'base' });
  assert.deepEqual(resolveRatePerKg(RATES, 'Saffire', null), { rate_per_kg: 81, source: 'base' });
});
test('resolveRatePerKg: unrated grade returns null — never falls through to a historical price', () => {
  assert.equal(resolveRatePerKg(RATES, 'Paper', 7), null);
  assert.equal(resolveRatePerKg(RATES, 'Duplex GB', 7), null); // inactive row ignored
  assert.equal(resolveRatePerKg(RATES, null, 7), null);
  assert.equal(resolveRatePerKg([], 'Saffire', 7), null);
});
test('resolveRatePerKg: grade match is case- and whitespace-insensitive', () => {
  assert.equal(resolveRatePerKg(RATES, '  saffire ', null).rate_per_kg, 81);
});
test('resolveRatePerKg: vendor_id compares across string/number forms', () => {
  assert.equal(resolveRatePerKg(RATES, 'Saffire', '7').rate_per_kg, 84);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w server`
Expected: FAIL — `Cannot find module '.../board-math.js'`

- [ ] **Step 3: Write the implementation**

Create `server/src/board-math.js`:

```js
// Board weight + rate maths. Board is bought by weight: the plant sets ONE ₹/kg
// per grade (optionally per vendor) and every board's ₹/sheet derives from its
// own GSM and parent sheet size. Nothing here is stored — change a grade's ₹/kg
// and every board in it reprices instantly, with no backfill.
//
// Mirrored verbatim in client/src/lib/boardMath.js. board-math.test.js asserts
// the two twins produce identical output — keep them in sync.
//
// Every function returns null (never 0) when an input is missing, so the UI can
// show "—" for an incomplete master instead of a confident, wrong zero.

const IN_TO_M = 0.0254;

// gsm × area in m² / 1000 → kg for one parent sheet.
export function kgPerSheet(b) {
  const gsm = +b?.gsm, l = +b?.sheet_l, w = +b?.sheet_w;
  if (!(gsm > 0) || !(l > 0) || !(w > 0)) return null;
  return gsm * (l * IN_TO_M) * (w * IN_TO_M) / 1000;
}

export function packetWeight(b) {
  const k = kgPerSheet(b), n = +b?.sheets_per_packet;
  if (k == null || !(n > 0)) return null;
  return k * n;
}

export function ratePerSheet(b, ratePerKg) {
  const k = kgPerSheet(b), r = +ratePerKg;
  if (k == null || !(r > 0)) return null;
  return k * r;
}

export function packetRate(b, ratePerKg) {
  const p = packetWeight(b), r = +ratePerKg;
  if (p == null || !(r > 0)) return null;
  return p * r;
}

export function totalWeight(b, sheets) {
  const k = kgPerSheet(b), n = +sheets;
  if (k == null || !Number.isFinite(n)) return null;
  return k * n;
}

// Display-only: a PO still transacts in sheets, so fractional packets are kept
// rather than rounded to whole packs.
export function packets(b, sheets) {
  const n = +b?.sheets_per_packet, s = +sheets;
  if (!(n > 0) || !Number.isFinite(s)) return null;
  return s / n;
}

// Vendor-specific rate wins over the grade's base rate. No match → null, so the
// caller shows "no rate on file" rather than silently reaching for last_rate,
// which is exactly the price drift the rate master exists to eliminate.
export function resolveRatePerKg(rates, grade, vendorId) {
  if (!grade) return null;
  const key = String(grade).trim().toLowerCase();
  const live = (rates || []).filter(r =>
    r.active !== 0 && String(r.grade ?? '').trim().toLowerCase() === key);
  const vendor = vendorId == null ? null
    : live.find(r => r.vendor_id != null && String(r.vendor_id) === String(vendorId));
  const base = live.find(r => r.vendor_id == null);
  const hit = vendor || base;
  if (!hit || !(+hit.rate_per_kg > 0)) return null;
  return { rate_per_kg: +hit.rate_per_kg, source: vendor ? 'vendor' : 'base' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w server`
Expected: PASS — all `board-math` tests green, no existing test broken.

- [ ] **Step 5: Create the client twin**

Create `client/src/lib/boardMath.js` with **byte-identical function bodies** to `server/src/board-math.js` (copy the file; adjust only the header comment to say it mirrors the server module).

- [ ] **Step 6: Add the parity test**

Append to `server/src/board-math.test.js`:

```js
// ── client twin parity ────────────────────────────────────────────────
// The client recomputes these figures locally for live form previews, so the two
// implementations must never diverge. Same precedent as helpers.childFit /
// WarehousePicker.clientFit.
import * as client from '../../client/src/lib/boardMath.js';
import * as server from './board-math.js';

test('client twin: exported surface matches the server module', () => {
  assert.deepEqual(Object.keys(client).sort(), Object.keys(server).sort());
});

test('client twin: identical output across a spread of real boards', () => {
  const boards = [
    { gsm: 330, sheet_l: 24.6, sheet_w: 31.2, sheets_per_packet: 144 },
    { gsm: 290, sheet_l: 20, sheet_w: 38, sheets_per_packet: 100 },
    { gsm: 300, sheet_l: 23, sheet_w: 36, sheets_per_packet: 100 },
    { gsm: 230, sheet_l: 20, sheet_w: 37, sheets_per_packet: 144 },
    { gsm: 205, sheet_l: 22, sheet_w: 28, sheets_per_packet: 150 },
    { gsm: null, sheet_l: 20, sheet_w: 30, sheets_per_packet: 100 }, // incomplete master
  ];
  for (const b of boards) {
    assert.equal(client.kgPerSheet(b), server.kgPerSheet(b));
    assert.equal(client.packetWeight(b), server.packetWeight(b));
    assert.equal(client.ratePerSheet(b, 81), server.ratePerSheet(b, 81));
    assert.equal(client.packetRate(b, 81), server.packetRate(b, 81));
    assert.equal(client.totalWeight(b, 1234), server.totalWeight(b, 1234));
    assert.equal(client.packets(b, 250), server.packets(b, 250));
  }
});

test('client twin: identical rate resolution', () => {
  for (const [g, v] of [['Saffire', 7], ['Saffire', 9], ['Paper', 7], ['FBB', null]]) {
    assert.deepEqual(client.resolveRatePerKg(RATES, g, v), server.resolveRatePerKg(RATES, g, v));
  }
});
```

- [ ] **Step 7: Verify**

Run: `npm test -w server`
Expected: PASS, including the three parity tests.

---

### Task 2: Board name & code composition

**Files:**
- Create: `server/src/board-code.js`
- Create: `server/src/board-code.test.js`

Both rules were reverse-engineered from live data and verified: the numeric prefix is `round(sheet_l)` + `round(sheet_w)` with **zero mismatches** across all 242 boards that carry a code.

- [ ] **Step 1: Write the failing test**

Create `server/src/board-code.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRADE_CODES, gradeCode, boardName, boardCode, parseBoardName } from './board-code.js';

// ── boardName ─────────────────────────────────────────────────────────
test('boardName: matches the stored plant convention exactly', () => {
  assert.equal(boardName({ grade: 'Duplex GB', gsm: 330, sheet_l: 24.6, sheet_w: 31.2 }),
    'Duplex GB · 330 GSM · 24.6 x 31.2');
  assert.equal(boardName({ grade: 'FBB', gsm: 290, sheet_l: 20, sheet_w: 38 }),
    'FBB · 290 GSM · 20 x 38');
});
test('boardName: trailing zeros are trimmed, so 20.0 renders as 20', () => {
  assert.equal(boardName({ grade: 'FBB', gsm: 290, sheet_l: 20.0, sheet_w: 38.00 }),
    'FBB · 290 GSM · 20 x 38');
});
test('boardName: incomplete input returns null rather than a half-built name', () => {
  assert.equal(boardName({ grade: 'FBB', gsm: null, sheet_l: 20, sheet_w: 38 }), null);
  assert.equal(boardName({ grade: '', gsm: 290, sheet_l: 20, sheet_w: 38 }), null);
});

// ── parseBoardName (round-trip) ───────────────────────────────────────
test('parseBoardName: round-trips a composed name', () => {
  assert.deepEqual(parseBoardName('Duplex GB · 330 GSM · 24.6 x 31.2'),
    { grade: 'Duplex GB', gsm: 330, sheet_l: 24.6, sheet_w: 31.2 });
});
test('parseBoardName: accepts the × separator as well as x', () => {
  assert.deepEqual(parseBoardName('Saffire · 300 GSM · 23 × 36'),
    { grade: 'Saffire', gsm: 300, sheet_l: 23, sheet_w: 36 });
});
test('parseBoardName: unparseable names return null', () => {
  assert.equal(parseBoardName('Unspecified board'), null);
  assert.equal(parseBoardName(''), null);
  assert.equal(parseBoardName(null), null);
});

// ── gradeCode ─────────────────────────────────────────────────────────
test('gradeCode: known grades map to their stored 3-4 letter codes', () => {
  assert.equal(gradeCode('Duplex GB'), 'DPGB');
  assert.equal(gradeCode('Duplex WB'), 'DPWB');
  assert.equal(gradeCode('Saffire'), 'SAFF');
  assert.equal(gradeCode('FBB'), 'FBB');
  assert.equal(gradeCode('Paper'), 'PAPR');
  assert.equal(gradeCode('Chromo Paper'), 'CHRM');
});
test('gradeCode: an unknown grade degrades to its first 4 alnum chars, uppercased', () => {
  assert.equal(gradeCode('Kraft Liner'), 'KRAF');
  assert.equal(gradeCode('sbs'), 'SBS');
});

// ── boardCode ─────────────────────────────────────────────────────────
test('boardCode: reproduces stored codes — round(L)+round(W)+GRADE+GSM', () => {
  assert.equal(boardCode({ grade: 'Duplex GB', gsm: 330, sheet_l: 24.6, sheet_w: 31.2 }), '2531DPGB330');
  assert.equal(boardCode({ grade: 'FBB', gsm: 290, sheet_l: 20, sheet_w: 38 }), '2038FBB290');
  assert.equal(boardCode({ grade: 'Saffire', gsm: 300, sheet_l: 23, sheet_w: 36 }), '2336SAFF300');
  assert.equal(boardCode({ grade: 'Saffire', gsm: 280, sheet_l: 22, sheet_w: 28 }), '2228SAFF280');
});
test('boardCode: collisions take a -N suffix, matching the existing data', () => {
  const taken = new Set(['2228SAFF280']);
  assert.equal(boardCode({ grade: 'Saffire', gsm: 280, sheet_l: 22.4, sheet_w: 28.1 }, taken), '2228SAFF280-1');
  taken.add('2228SAFF280-1');
  assert.equal(boardCode({ grade: 'Saffire', gsm: 280, sheet_l: 22.3, sheet_w: 27.6 }, taken), '2228SAFF280-2');
});
test('boardCode: incomplete input returns null', () => {
  assert.equal(boardCode({ grade: 'FBB', gsm: null, sheet_l: 20, sheet_w: 38 }), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w server`
Expected: FAIL — `Cannot find module '.../board-code.js'`

- [ ] **Step 3: Write the implementation**

Create `server/src/board-code.js`:

```js
// Composes a board's display name and short code from its structured fields, so
// 'Saffire · 300 GSM · 23 x 36' / '2336SAFF300' are generated rather than typed.
// Both rules were reverse-engineered from the live master and verified against
// every existing row: the numeric prefix is round(L)+round(W) with zero
// mismatches across the 242 boards that carry a code.

export const GRADE_CODES = {
  'Duplex GB': 'DPGB',
  'Duplex WB': 'DPWB',
  'Saffire': 'SAFF',
  'FBB': 'FBB',
  'Paper': 'PAPR',
  'Chromo Paper': 'CHRM', // new — the single existing row carries no code
};

// Unknown grades degrade to their first 4 alphanumerics so a newly added grade
// still produces a usable code without a code-change.
export function gradeCode(grade) {
  const g = String(grade ?? '').trim();
  if (!g) return null;
  const hit = Object.keys(GRADE_CODES).find(k => k.toLowerCase() === g.toLowerCase());
  if (hit) return GRADE_CODES[hit];
  return g.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || null;
}

// 20.0 → '20', 24.60 → '24.6' — matches how sizes are stored in the names today.
const dim = n => String(+(+n).toFixed(2));

export function boardName({ grade, gsm, sheet_l, sheet_w } = {}) {
  const g = String(grade ?? '').trim();
  if (!g || !(+gsm > 0) || !(+sheet_l > 0) || !(+sheet_w > 0)) return null;
  return `${g} · ${+gsm} GSM · ${dim(sheet_l)} x ${dim(sheet_w)}`;
}

// Accepts both 'x' and '×'. Tolerates extra whitespace.
const NAME_RE = /^\s*(.+?)\s*·\s*(\d{2,4})\s*GSM\s*·\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*$/i;

export function parseBoardName(name) {
  const m = NAME_RE.exec(String(name ?? ''));
  if (!m) return null;
  return { grade: m[1].trim(), gsm: +m[2], sheet_l: +m[3], sheet_w: +m[4] };
}

// `taken` is the set of codes already in use. On collision the existing data
// appends -1, -2, … (DPGB285-1, SAFF280-1) — reproduce that rather than invent
// a new scheme.
export function boardCode({ grade, gsm, sheet_l, sheet_w } = {}, taken = new Set()) {
  const gc = gradeCode(grade);
  if (!gc || !(+gsm > 0) || !(+sheet_l > 0) || !(+sheet_w > 0)) return null;
  const base = `${Math.round(+sheet_l)}${Math.round(+sheet_w)}${gc}${+gsm}`;
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w server`
Expected: PASS

- [ ] **Step 5: Verify the rules against every live board**

This proves the composition rule before it is trusted to author new masters. Create a throwaway script at the repo root (it needs the `pg` dependency resolvable from the workspace) and delete it afterwards:

```bash
cd "…/ci-erp" && cat > ./verify-codes.cjs <<'EOF'
const { Client } = require('pg');
(async () => {
  const { parseBoardName, boardName, boardCode } = await import('./server/src/board-code.js');
  const c = new Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5439/cierp' });
  await c.connect();
  const { rows } = await c.query("SELECT id,name,spec,sheet_l,sheet_w FROM materials WHERE category='board'");
  let nameOk = 0, codeOk = 0, nameBad = [], codeBad = [];
  const taken = new Set(rows.map(r => r.spec).filter(Boolean));
  for (const r of rows) {
    const p = parseBoardName(r.name);
    if (!p) { nameBad.push(r.name); continue; }
    boardName(p) === r.name ? nameOk++ : nameBad.push(`${r.name} -> ${boardName(p)}`);
    if (!r.spec) continue;
    const t = new Set(taken); t.delete(r.spec);
    boardCode(p, t) === r.spec ? codeOk++ : codeBad.push(`${r.spec} -> ${boardCode(p, t)}`);
  }
  console.log('name round-trip ok:', nameOk, 'bad:', nameBad.length, nameBad.slice(0, 5));
  console.log('code round-trip ok:', codeOk, 'bad:', codeBad.length, codeBad.slice(0, 5));
  await c.end();
})();
EOF
node ./verify-codes.cjs; rm -f ./verify-codes.cjs
```

Expected: `name round-trip ok: 302 bad: 1` (the one bad entry is `Unspecified board`), and `code round-trip ok: 242 bad: 0`.

**If `codeBad` is non-empty, stop and report** — the composition rule is wrong and Task 4 must not run.

---

### Task 3: Schema migration

**Files:**
- Modify: `server/src/db.js` (append a new block immediately before the closing `}` at line 1383)
- Modify: `server/src/routes/masters.js:32`

- [ ] **Step 1: Add the migration block**

In `server/src/db.js`, immediately before the final `}` of the migration function, append:

```js
  await pool.query(`
-- Board rates & weight ------------------------------------------------------
-- Board is bought by weight. ONE ₹/kg per grade drives every board in it; a row
-- naming a vendor overrides the base row for that vendor only. Everything else
-- (₹/sheet, packet weight, PO tonnage) is derived at read time by board-math.js
-- and never stored, so editing a rate reprices its boards with no backfill.
CREATE TABLE IF NOT EXISTS board_rates (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grade          TEXT NOT NULL,
  vendor_id      INTEGER REFERENCES vendors(id),  -- NULL = base rate, all vendors
  rate_per_kg    DOUBLE PRECISION NOT NULL,
  effective_from DATE,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ DEFAULT now()
);
-- COALESCE is required: Postgres does not treat two NULLs as equal, so a plain
-- UNIQUE(grade, vendor_id) would allow duplicate base rates for a grade.
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_rates_grade_vendor
  ON board_rates(grade, COALESCE(vendor_id, -1));

-- Structured board identity. Until now GSM was regex-scraped out of the free-text
-- name at every call site (smartmatch.js, orders.js); it is real data from here on.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS grade TEXT;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS gsm INTEGER;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS sheets_per_packet INTEGER;
`);
```

- [ ] **Step 2: Whitelist the new columns**

In `server/src/routes/masters.js:32`, replace the `materials` line with:

```js
  materials: ['name', 'category', 'spec', 'unit', 'sheet_l', 'sheet_w', 'reorder_level', 'hsn_code', 'gst_rate', 'std_rate', 'last_rate', 'active', 'grade', 'gsm', 'sheets_per_packet'],
```

- [ ] **Step 3: Run the migration and verify the schema**

```bash
cd "…/ci-erp/server" && PORT=4100 node src/index.js
# wait for startup, then Ctrl-C
```

Then confirm (create `./chk.cjs` at the repo root, run, delete):

```js
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5439/cierp' });
  await c.connect();
  console.table((await c.query(`SELECT column_name,data_type FROM information_schema.columns
    WHERE table_name='materials' AND column_name IN ('grade','gsm','sheets_per_packet')`)).rows);
  console.table((await c.query(`SELECT column_name,data_type FROM information_schema.columns
    WHERE table_name='board_rates' ORDER BY ordinal_position`)).rows);
  await c.end();
})();
```

Expected: 3 material columns (`text`, `integer`, `integer`) and 7 `board_rates` columns.

- [ ] **Step 4: Verify idempotency**

Start the temp server a second time. Expected: starts cleanly, no error — every statement is `IF NOT EXISTS`.

---

### Task 4: Backfill the 303 boards

**Files:**
- Create: `server/src/backfill-boards.js`

- [ ] **Step 1: Write the backfill script**

Create `server/src/backfill-boards.js`:

```js
// One-shot, idempotent backfill: gives the existing 303 board masters their
// structured grade / GSM / sheets-per-packet, generates a spec code for the 61
// that have none, and seeds the base ₹/kg rates from the plant spreadsheet.
//
// Updates rows in place matched by id — no inserts into materials, so it cannot
// create duplicate masters. Existing spec codes are NEVER rewritten; they are
// referenced elsewhere in the plant.
//
// Run: node src/backfill-boards.js         (dry run — prints what it would do)
//      node src/backfill-boards.js --apply (writes)

import { pool } from './db.js';
import { parseBoardName, boardCode } from './board-code.js';

// From the plant spreadsheet: Duplex packs 144 sheets, FBB/Saffire/SBS 100.
const SHEETS_PER_PACKET = {
  'Duplex GB': 144, 'Duplex WB': 144,
  'FBB': 100, 'Saffire': 100, 'SBS': 100,
  'Chromo Paper': 150,
  // 'Paper' deliberately absent — unknown packing, left NULL.
};

// Base ₹/kg, exclusive of GST. Paper and Chromo Paper show "—" in the
// spreadsheet and stay unrated until the buyer sets a rate.
const BASE_RATES = { 'Duplex GB': 45, 'Duplex WB': 51, 'Saffire': 81, 'FBB': 79 };

export async function backfillBoards({ apply = false } = {}) {
  const { rows } = await pool.query(
    "SELECT id, name, spec, sheet_l, sheet_w FROM materials WHERE category='board' ORDER BY id");
  const taken = new Set(rows.map(r => r.spec).filter(Boolean));
  const updates = [], skipped = [];

  for (const m of rows) {
    const p = parseBoardName(m.name);
    if (!p) { skipped.push({ id: m.id, name: m.name, why: 'name does not parse' }); continue; }
    const spp = SHEETS_PER_PACKET[p.grade] ?? null;
    let spec = m.spec;
    if (!spec) {                        // only ever fill a blank code
      spec = boardCode(p, taken);
      if (spec) taken.add(spec);
    }
    updates.push({ id: m.id, grade: p.grade, gsm: p.gsm, sheets_per_packet: spp, spec });
  }

  if (apply) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of updates) {
        await client.query(
          `UPDATE materials SET grade=$1, gsm=$2, sheets_per_packet=$3, spec=$4 WHERE id=$5`,
          [u.grade, u.gsm, u.sheets_per_packet, u.spec, u.id]);
      }
      for (const [grade, rate] of Object.entries(BASE_RATES)) {
        // Idempotent: re-running does not clobber a rate the buyer has since edited.
        await client.query(
          `INSERT INTO board_rates (grade, vendor_id, rate_per_kg, active)
           VALUES ($1, NULL, $2, 1)
           ON CONFLICT (grade, COALESCE(vendor_id, -1)) DO NOTHING`, [grade, rate]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }

  return { total: rows.length, updated: updates.length, skipped };
}

// Run directly (not when imported by a test).
if (process.argv[1]?.endsWith('backfill-boards.js')) {
  const apply = process.argv.includes('--apply');
  backfillBoards({ apply }).then(r => {
    console.log(`${apply ? 'APPLIED' : 'DRY RUN'} — ${r.updated}/${r.total} boards`);
    if (r.skipped.length) console.log('skipped:', r.skipped);
    return pool.end();
  }).catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 2: Dry run**

Run: `cd "…/ci-erp/server" && node src/backfill-boards.js`
Expected: `DRY RUN — 302/303 boards` and one skipped entry: `{ id: 278, name: 'Unspecified board', why: 'name does not parse' }`

- [ ] **Step 3: Apply**

Run: `cd "…/ci-erp/server" && node src/backfill-boards.js --apply`
Expected: `APPLIED — 302/303 boards`

- [ ] **Step 4: Verify the result**

Run a check script confirming:
```sql
SELECT grade, count(*), min(gsm), max(gsm), max(sheets_per_packet) FROM materials WHERE category='board' GROUP BY grade ORDER BY 2 DESC;
SELECT * FROM board_rates ORDER BY grade;
SELECT count(*) FROM materials WHERE category='board' AND (spec IS NULL OR spec='');
```
Expected:
- Grades: Saffire 104, FBB 101, Duplex WB 52, Duplex GB 41, Paper 3, Chromo Paper 1, and one NULL-grade row (id 278).
- 4 `board_rates` rows: Duplex GB 45, Duplex WB 51, FBB 79, Saffire 81, all `vendor_id` NULL.
- **0** boards without a spec code.

- [ ] **Step 5: Verify idempotency**

Run `node src/backfill-boards.js --apply` a **second** time, then re-run the checks from Step 4.
Expected: identical output — same grade counts, still 4 rate rows, still 0 missing codes. No value drift, no duplicate rate rows.

---

# PHASE 2 — Board master UI

Ends with a structured board form and a working category-rate sub-module.

---

### Task 5: `/board-rates` API

**Files:**
- Create: `server/src/routes/board-rates.js`
- Modify: `server/src/index.js` (near the existing route mounts at :39)

- [ ] **Step 1: Write the router**

Create `server/src/routes/board-rates.js`:

```js
import { Router } from 'express';
import { q, one } from '../db.js';
import { audit } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canEdit = requireRole('planner'); // admin implied

// Board rates drive every board's ₹/sheet, so each row reports how many boards
// it affects — the buyer sees the blast radius before changing a number.
r.get('/board-rates', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT br.*, v.name AS vendor_name,
             (SELECT count(*) FROM materials m
               WHERE m.category='board' AND m.active=1 AND m.grade = br.grade)::int AS board_count
      FROM board_rates br
      LEFT JOIN vendors v ON v.id = br.vendor_id
      ORDER BY br.grade, (br.vendor_id IS NOT NULL), v.name`));
  } catch (e) { next(e); }
});

// The grade list the board form's dropdown is built from — every grade that has
// a rate, plus any grade already in use on a board (so an unrated grade is still
// selectable and simply shows "no rate on file").
r.get('/board-grades', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT grade FROM board_rates WHERE active=1
      UNION
      SELECT grade FROM materials WHERE category='board' AND grade IS NOT NULL AND grade <> ''
      ORDER BY 1`));
  } catch (e) { next(e); }
});

r.post('/board-rates', canEdit, async (req, res, next) => {
  try {
    const { grade, vendor_id, rate_per_kg, effective_from, active } = req.body;
    if (!String(grade || '').trim()) return res.status(400).json({ error: 'Grade is required' });
    if (!(+rate_per_kg > 0)) return res.status(400).json({ error: 'Rate must be greater than zero' });
    const [row] = await q(
      `INSERT INTO board_rates (grade, vendor_id, rate_per_kg, effective_from, active)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [String(grade).trim(), vendor_id || null, +rate_per_kg, effective_from || null, active ?? 1]);
    await audit(req, 'board_rates', row.id, 'create',
      `${row.grade} @ ₹${row.rate_per_kg}/kg${row.vendor_id ? ` (vendor ${row.vendor_id})` : ' (base)'}`);
    res.json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A rate already exists for this grade and vendor. Edit that row instead.' });
    next(e);
  }
});

r.put('/board-rates/:id', canEdit, async (req, res, next) => {
  try {
    const before = await one('SELECT * FROM board_rates WHERE id=$1', [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Not found' });
    const { rate_per_kg, effective_from, active } = req.body;
    if (rate_per_kg != null && !(+rate_per_kg > 0)) return res.status(400).json({ error: 'Rate must be greater than zero' });
    const [row] = await q(
      `UPDATE board_rates SET rate_per_kg=COALESCE($1, rate_per_kg),
              effective_from=COALESCE($2, effective_from), active=COALESCE($3, active)
       WHERE id=$4 RETURNING *`,
      [rate_per_kg != null ? +rate_per_kg : null, effective_from || null, active ?? null, req.params.id]);
    if (+before.rate_per_kg !== +row.rate_per_kg) {
      await audit(req, 'board_rates', row.id, 'update',
        `${row.grade} rate ₹${before.rate_per_kg} → ₹${row.rate_per_kg}/kg`);
    }
    res.json(row);
  } catch (e) { next(e); }
});

r.delete('/board-rates/:id', canEdit, async (req, res, next) => {
  try {
    const row = await one('SELECT * FROM board_rates WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await q('DELETE FROM board_rates WHERE id=$1', [req.params.id]);
    await audit(req, 'board_rates', row.id, 'delete', `${row.grade} @ ₹${row.rate_per_kg}/kg`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
```

**Before implementing:** open `server/src/routes/masters.js:1-10` and confirm the exact import names and the `audit(...)` signature; match them rather than the sketch above if they differ.

- [ ] **Step 2: Mount the router**

In `server/src/index.js`, alongside the existing route mounts (~line 39), add the import and `app.use('/api', boardRates)` following the established pattern exactly.

- [ ] **Step 3: Verify**

```bash
cd "…/ci-erp/server" && PORT=4100 node src/index.js &
# authenticate the way the other routes require, then:
curl -s localhost:4100/api/board-rates -H "Authorization: Bearer <token>" | head
```
Expected: 4 rows, each with `board_count` — Saffire 104, FBB 101, Duplex WB 52, Duplex GB 41.

Also confirm the duplicate guard returns 409:
`POST /api/board-rates {"grade":"Saffire","rate_per_kg":90}` → **409** "A rate already exists…".

---

### Task 6: Structured Boards form

**Files:**
- Modify: `client/src/pages/Masters.jsx:128-163` (CONFIGS), `:265-300` (columns), `:518-593` (form modal)

- [ ] **Step 1: Add the derived-field support to the form renderer**

The generic form loop at `Masters.jsx:530-591` renders only `Input` and `Select`. Add a `type: 'derived'` branch that renders a read-only value computed by `f.compute(editing)`, placed **before** the final `Input` fallback:

```jsx
) : f.type === 'derived' ? (
  <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
    {f.compute(editing, refs) ?? <span className="text-slate-400">—</span>}
  </div>
) : (
```

- [ ] **Step 2: Replace the `board_rates` CONFIGS entry with a structured `boards` tab**

Replace the whole `board_rates` block (`Masters.jsx:146-163`) with:

```js
  // Boards — the plant's board master. Grade / GSM / size are structured fields;
  // the name and code are composed from them (board-code.js) so they can never
  // drift apart, and kg/sheet + ₹/sheet preview live from the grade's ₹/kg.
  boards: {
    label: 'Boards', endpoint: '/materials', activeToggle: true, history: 'materials',
    rowFilter: r => r.category === 'board' && !r.leftover,
    defaults: { category: 'board', unit: 'sheets', gst_rate: 18, reorder_level: 0, active: 1 },
    fields: [
      { key: 'grade', label: 'Grade', type: 'graderef', required: true, hint: 'Drives the ₹/kg this board is bought at — managed in Board Rates' },
      { key: 'gsm', label: 'GSM', type: 'number', required: true },
      { key: 'sheet_l', label: 'Parent Sheet Length (in)', type: 'number', newRow: true, required: true },
      { key: 'sheet_w', label: 'Parent Sheet Width (in)', type: 'number', required: true },
      { key: 'sheets_per_packet', label: 'Sheets / Packet', type: 'number', newRow: true, hint: 'Auto-filled from the grade — Duplex 144, FBB/Saffire 100' },
      { key: 'hsn_code', label: 'HSN Code' },
      { key: 'gst_rate', label: 'GST %', type: 'number', newRow: true, hint: 'Plant default 18 for board' },
      { key: 'reorder_level', label: 'Reorder Level', type: 'number' },
      { key: 'name', label: 'Board Name', type: 'derived', newRow: true, compute: b => boardName(b) },
      { key: 'spec', label: 'Code', type: 'derived', compute: b => boardCode(b) },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0], newRow: true },
    ],
    columns: ['name', 'grade', 'gsm', 'sheet_size', 'sheets_per_packet', 'kg_per_sheet', 'packet_kg', 'rate_per_kg', 'rate_per_sheet', 'active'],
  },
```

Import at the top of `Masters.jsx`:
```js
import { boardName, boardCode } from '../lib/boardCode.js';
import { kgPerSheet, packetWeight, ratePerSheet, resolveRatePerKg } from '../lib/boardMath.js';
```

Create `client/src/lib/boardCode.js` as a verbatim client twin of `server/src/board-code.js` (same approach as `boardMath.js`; add it to the parity test in Task 1 Step 6 alongside the math twin).

- [ ] **Step 3: Auto-fill sheets/packet when the grade changes**

Add a `graderef` branch to the form renderer that, on change, also seeds `sheets_per_packet` when it is empty:

```jsx
) : f.type === 'graderef' ? (
  <Select value={editing[f.key] ?? ''} onChange={e => {
    const grade = e.target.value;
    const spp = { 'Duplex GB': 144, 'Duplex WB': 144, 'FBB': 100, 'Saffire': 100, 'SBS': 100, 'Chromo Paper': 150 }[grade];
    setEditing({
      ...editing, grade,
      // Only seed a blank — never overwrite a value the user has set.
      sheets_per_packet: editing.sheets_per_packet || spp || '',
    });
  }}>
    <option value="">Select…</option>
    {(refs.board_grades || []).map(g => <option key={g.grade} value={g.grade}>{g.grade}</option>)}
  </Select>
```

Load the grades alongside the other refs in the `useEffect` at `Masters.jsx:265-273`:
```js
    api.get('/board-grades').then(g => setRefs(r => ({ ...r, board_grades: g })));
    api.get('/board-rates').then(b => setRefs(r => ({ ...r, board_rates: b })));
```

- [ ] **Step 4: Add the live preview strip**

Inside the form modal, immediately after the field grid (`Masters.jsx:~592`), render for the boards tab only:

```jsx
{editing && tab === 'boards' && (() => {
  const rk = resolveRatePerKg(refs.board_rates || [], editing.grade, null);
  const k = kgPerSheet(editing), pw = packetWeight(editing);
  const rs = rk ? ratePerSheet(editing, rk.rate_per_kg) : null;
  const cell = (label, val) => (
    <div key={label}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-base font-semibold text-slate-900">{val ?? '—'}</div>
    </div>
  );
  return (
    <div className="mt-4 grid grid-cols-4 gap-4 rounded-lg border border-violet-200 bg-violet-50 p-4">
      {cell('kg / Sheet', k != null ? k.toFixed(4) : null)}
      {cell('Packet Weight', pw != null ? `${pw.toFixed(3)} kg` : null)}
      {cell('₹ / kg', rk ? `₹${rk.rate_per_kg}` : null)}
      {cell('₹ / Sheet', rs != null ? `₹${rs.toFixed(2)}` : null)}
      {!rk && editing.grade && (
        <div className="col-span-4 text-xs font-medium text-amber-700">
          No rate on file for {editing.grade} — set one in Board Rates.
        </div>
      )}
    </div>
  );
})()}
```

- [ ] **Step 5: Add the derived list columns**

In the column builder (`Masters.jsx:275-421`), add renderers for the four new virtual columns, next to the existing `sheet_size` renderer at `:317`:

```jsx
k === 'kg_per_sheet' ? (r => { const v = kgPerSheet(r); return v == null ? '—' : v.toFixed(4); })
: k === 'packet_kg' ? (r => { const v = packetWeight(r); return v == null ? '—' : `${v.toFixed(3)} kg`; })
: k === 'rate_per_kg' ? (r => { const x = resolveRatePerKg(refs.board_rates || [], r.grade, null); return x ? `₹${x.rate_per_kg}` : '—'; })
: k === 'rate_per_sheet' ? (r => {
    const x = resolveRatePerKg(refs.board_rates || [], r.grade, null);
    const v = x ? ratePerSheet(r, x.rate_per_kg) : null;
    return v == null ? '—' : `₹${v.toFixed(2)}`;
  })
```

Match the existing renderer's exact shape (the file uses a `cell`/`render` key — follow whatever `sheet_size` at `:317` does).

- [ ] **Step 6: Verify in the running app**

Start the app, log in, go to **Masters → Boards**.
Confirm at a glance:
1. The list shows Grade, GSM, kg/Sheet, Packet kg, ₹/kg, ₹/Sheet with real numbers — Saffire rows show ₹81/kg.
2. **New Board** → pick Saffire, GSM 300, 23 × 36. Sheets/Packet auto-fills **100**. The name reads `Saffire · 300 GSM · 23 x 36`, code `2336SAFF300`, and the preview shows kg/Sheet **0.1603**, Packet **16.026 kg**, ₹/kg **₹81**, ₹/Sheet **₹12.98**.
3. Pick **Paper** → the amber "No rate on file" line appears.
4. Save the board, reopen it, confirm the values persisted.
5. Screenshot the before/after of the Boards list for the change summary.

---

### Task 7: Board Rates sub-module

**Files:**
- Modify: `client/src/pages/Masters.jsx` (new `board_rates` tab over `/board-rates`)

- [ ] **Step 1: Add the tab**

Add a new CONFIGS entry. This one talks to `/board-rates`, not `/materials`:

```js
  // Board Rates — the category rate master. One base ₹/kg per grade drives every
  // board in that grade; add a vendor row only where a mill quotes differently.
  // Changing one number here reprices its whole board list.
  board_rates: {
    label: 'Board Rates', endpoint: '/board-rates', activeToggle: true,
    defaults: { active: 1 },
    fields: [
      { key: 'grade', label: 'Grade', type: 'graderef', required: true, createOnly: true },
      { key: 'vendor_id', label: 'Vendor', type: 'ref', ref: 'vendors', createOnly: true,
        hint: 'Leave blank for the base rate that applies to every vendor' },
      { key: 'rate_per_kg', label: 'Rate ₹ / kg', type: 'number', required: true, newRow: true,
        hint: 'Exclusive of GST' },
      { key: 'effective_from', label: 'Effective From', type: 'date' },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0], newRow: true },
    ],
    columns: ['grade', 'vendor_name', 'rate_per_kg', 'board_count', 'effective_from', 'active'],
  },
```

Load vendors into refs in the `useEffect` at `:265-273`:
```js
    api.get('/vendors').then(v => setRefs(r => ({ ...r, vendors: v })));
```

Column renderers:
```jsx
k === 'vendor_name' ? (r => r.vendor_name || <span className="text-slate-400">Base — all vendors</span>)
: k === 'rate_per_kg' ? (r => <span className="font-semibold">₹{r.rate_per_kg}/kg</span>)
: k === 'board_count' ? (r => `${r.board_count} boards`)
```

- [ ] **Step 2: Add the blast-radius preview to the edit form**

After the field grid, for the `board_rates` tab only:

```jsx
{editing && tab === 'board_rates' && editing.grade && (() => {
  const boards = (refs.materials || []).filter(m =>
    m.category === 'board' && m.active && m.grade === editing.grade);
  const rate = +editing.rate_per_kg || 0;
  const sample = boards.slice(0, 3).map(b => ({ name: b.name, rs: ratePerSheet(b, rate) }));
  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="text-sm font-semibold text-amber-900">
        This rate prices {boards.length} board{boards.length === 1 ? '' : 's'}
        {editing.vendor_id ? ' for this vendor' : ' across every vendor'}.
      </div>
      <div className="mt-2 space-y-1">
        {sample.map(s => (
          <div key={s.name} className="flex justify-between text-xs text-amber-900">
            <span>{s.name}</span>
            <span className="font-semibold">{s.rs == null ? '—' : `₹${s.rs.toFixed(2)}/sheet`}</span>
          </div>
        ))}
        {boards.length > 3 && <div className="text-xs text-amber-700">+{boards.length - 3} more</div>}
      </div>
    </div>
  );
})()}
```

- [ ] **Step 3: Verify in the running app**

**Masters → Board Rates.** Confirm:
1. Four rows: Duplex GB ₹45/kg (41 boards), Duplex WB ₹51/kg (52), FBB ₹79/kg (101), Saffire ₹81/kg (104), each showing "Base — all vendors".
2. Edit Saffire to **84** → the amber panel updates the sample ₹/sheet live (₹12.98 → ₹13.46 for `Saffire · 300 GSM · 23 x 36`). Save.
3. Go to **Masters → Boards** → all 104 Saffire rows now show ₹84/kg and a repriced ₹/sheet, with **no** migration run.
4. **Set Saffire back to 81.**
5. Add a vendor row: Saffire + any vendor @ ₹84 → saves. Try adding a second Saffire base row → **409** with the "already exists" message.
6. Screenshot the Board Rates tab.

---

# PHASE 3 — Weight-aware procurement

---

### Task 8: Server-side rate resolution

**Files:**
- Modify: `server/src/routes/procurement.js:235-239, 299-302`

- [ ] **Step 1: Add a rate-resolution helper**

Near the top of `procurement.js`, after the existing imports:

```js
import { resolveRatePerKg, ratePerSheet } from '../board-math.js';

// A board's PO rate is derived: the grade's ₹/kg (vendor row beating the base
// row) × that board's kg/sheet. Non-board materials keep the manual std_rate,
// then last_rate. A board with no rate on file returns null so the buyer sees
// "no rate" rather than a silently stale historical price.
async function resolvePoRate(material, vendorId, rates) {
  if (material?.category !== 'board') {
    return { rate: +material?.std_rate || +material?.last_rate || 0, source: material?.std_rate ? 'std' : 'last' };
  }
  const rk = resolveRatePerKg(rates, material.grade, vendorId);
  if (!rk) return { rate: null, source: 'none' };
  const rs = ratePerSheet(material, rk.rate_per_kg);
  return rs == null
    ? { rate: null, source: 'none' }
    : { rate: rs, rate_per_kg: rk.rate_per_kg, source: rk.source };
}
```

- [ ] **Step 2: Use it in the PR→PO convert path**

At `procurement.js:235-239`, the query already selects `m.std_rate, m.last_rate`. Extend the select to include `m.category, m.grade, m.gsm, m.sheet_l, m.sheet_w, m.sheets_per_packet`, load the rate rows once (`SELECT * FROM board_rates WHERE active=1`), and replace the mapping:

```js
lines = await Promise.all(rls.map(async l => ({
  ...l,
  // The requisition's estimated rate still wins — the buyer put it there on purpose.
  rate: l.est_rate || (await resolvePoRate(l, vendorId, rates)).rate || 0,
})));
```

- [ ] **Step 3: Use it in the bulk PO path**

At `procurement.js:299-302`, extend the material select with the same columns and replace the rate expression:

```js
const resolved = await resolvePoRate(m, vendorId, rates);
await insertPoLines(qc, po.id, [{ …, rate: +rates[materialId] || resolved.rate || 0, … }]);
```

- [ ] **Step 4: Expose resolved rates to the client**

Add an endpoint so the PO form can resolve rates for the selected vendor without re-implementing the lookup:

```js
// Resolved ₹/sheet for every board, for the vendor the PO is being raised on.
r.get('/board-po-rates', async (req, res, next) => {
  try {
    const vendorId = req.query.vendor_id || null;
    const rates = await q('SELECT * FROM board_rates WHERE active=1');
    const mats = await q("SELECT * FROM materials WHERE category='board' AND active=1");
    res.json(mats.map(m => {
      const r0 = resolveRatePerKg(rates, m.grade, vendorId);
      return {
        material_id: m.id,
        rate_per_kg: r0?.rate_per_kg ?? null,
        source: r0?.source ?? 'none',
        rate_per_sheet: r0 ? ratePerSheet(m, r0.rate_per_kg) : null,
      };
    }));
  } catch (e) { next(e); }
});
```

- [ ] **Step 5: Verify**

With a temp server on :4100:
```bash
curl -s "localhost:4100/api/board-po-rates" -H "Authorization: Bearer <token>" | head -3
```
Expected: Saffire boards carry `rate_per_kg: 81, source: "base"` and a `rate_per_sheet` matching Task 1's golden values. Then repeat with `?vendor_id=<the vendor given ₹84 in Task 7 Step 5>` and confirm those rows flip to `84 / "vendor"`.

---

### Task 9: PO line editor — weight columns & provenance

**Files:**
- Modify: `client/src/components/ProcurementForms.jsx:19-28, 119-123, 137-142, 199-251`
- Modify: `client/src/pages/Procurement.jsx` (pass the resolver + vendor into the editors)

- [ ] **Step 1: Fix the rate fill bug**

`fillFromMaterial` at `:19-28` reads `mat.last_rate`, which is why picking a board in a Direct PO **ignores the rate master today**. Give the function an injected resolver:

```js
// rateFor(mat) resolves the controlled rate for the PO's selected vendor. It is
// injected rather than imported so every PO path — Direct, Edit, convert-PR,
// bulk, quick-create — resolves a rate identically.
function fillFromMaterial(line, mat, rateFor) {
  if (!mat) return { material_id: '' };
  const resolved = rateFor?.(mat);
  return {
    material_id: String(mat.id),
    unit: mat.unit || line.unit || '',
    hsn_code: line.hsn_code || mat.hsn_code || '',
    gst_rate: line.gst_rate ? line.gst_rate : (mat.gst_rate ?? ''),
    // Never clobber a rate the buyer already typed on this line.
    rate: line.rate ? line.rate : (resolved?.rate != null ? String(resolved.rate) : ''),
    rate_source: resolved?.source ?? 'none',
    rate_per_kg: resolved?.rate_per_kg ?? null,
  };
}
```

Apply the identical change to `fillFromMaterialPr` at `:119-123`. Thread `rateFor` through `PoLineEditor`/`PrLineEditor` props and pass it at each call site in `Procurement.jsx` (the convert, bulk, direct and edit modals), built from `/board-po-rates` for the currently selected vendor.

- [ ] **Step 2: Add the weight columns**

Extend the header at `:137-142` to **Material · HSN · Qty · UOM · kg/Sheet · Packets · Total kg · Rate ₹ · Disc % · GST % · Amount ₹**, and render per line:

```jsx
const mat = materials.find(m => String(m.id) === String(l.material_id));
const kps = mat ? kgPerSheet(mat) : null;
const pkts = mat ? packets(mat, +l.qty || 0) : null;
const tot  = mat ? totalWeight(mat, +l.qty || 0) : null;
…
<td className="text-right tabular-nums">{kps == null ? '—' : kps.toFixed(4)}</td>
<td className="text-right tabular-nums">{pkts == null ? '—' : pkts.toFixed(2)}</td>
<td className="text-right tabular-nums font-medium">{tot == null ? '—' : `${tot.toFixed(2)} kg`}</td>
```

- [ ] **Step 3: Add the provenance chip**

Under the rate input on each line:

```jsx
{(() => {
  const off = l.rate_per_kg != null && mat && Math.abs(+l.rate - (ratePerSheet(mat, l.rate_per_kg) ?? 0)) > 0.005;
  if (l.rate_source === 'none') return <span className="text-[11px] font-medium text-amber-700">No rate on file</span>;
  if (off) return <span className="text-[11px] font-medium text-amber-700">Overridden — master ₹{ratePerSheet(mat, l.rate_per_kg).toFixed(2)}</span>;
  return <span className="text-[11px] text-slate-500">{mat?.grade} @ ₹{l.rate_per_kg}/kg ({l.rate_source})</span>;
})()}
```

- [ ] **Step 4: Add weight to the totals panel**

In `PoTotalsPanel` (`:199-251`), add a row above the existing tax breakup showing **Total Sheets · Total Packets · Total Weight**, summed across lines with the same helpers. Lines whose material has no GSM contribute nothing and are counted in a "n items without weight" note, so a missing master is never silently absorbed into the total.

- [ ] **Step 5: Re-resolve on vendor change**

In the PO modal in `Procurement.jsx`, when `vendor_id` changes: refetch `/board-po-rates?vendor_id=…`, then update each line's rate. If any line was hand-edited (its rate differs from the previously resolved value), confirm first:

> "Changing the vendor will reprice N line(s) from the new vendor's rates. M line(s) you edited manually will be overwritten. Continue?"

- [ ] **Step 6: Verify in the running app**

Procurement → **New Direct PO**. Confirm:
1. Pick a vendor, add a Saffire board → the rate auto-fills **₹12.98/sheet** (not a stale `last_rate`), chip reads `Saffire @ ₹81/kg (base)`.
2. Qty 1000 → kg/Sheet **0.1603**, Packets **10.00**, Total **160.26 kg**. Totals panel shows 1000 sheets / 10 packets / 160.26 kg.
3. Type `14` into rate → chip turns amber "Overridden — master ₹12.98".
4. Switch to the ₹84 vendor → confirm dialog appears, rate becomes **₹13.46**, chip reads `(vendor)`.
5. Add a **Paper** board → rate blank, amber "No rate on file".
6. Save the PO, reopen it, confirm everything persisted.
7. Screenshot the line editor.

---

### Task 10: PO print

**Files:**
- Modify: `client/src/pages/POPrint.jsx:93-119`

- [ ] **Step 1: Add the board spec sub-line**

Replace the `material_name` + `spec` cell body (`:102-119`) so a board renders its structured identity:

```jsx
<td>
  <div className="font-medium">{l.material_name}</div>
  {l.grade ? (
    <div className="text-[10px] text-slate-600">
      {l.grade} · {l.gsm} GSM · {l.sheet_l} × {l.sheet_w}"
      {l.sheets_per_packet ? ` · ${l.sheets_per_packet} sheets/packet` : ''}
    </div>
  ) : l.spec ? <div className="text-[10px] text-slate-600">{l.spec}</div> : null}
</td>
```

This requires `GET /purchase-orders/:id` (`procurement.js:337-355`) to also select `m.grade, m.gsm, m.sheet_l, m.sheet_w, m.sheets_per_packet` onto each line.

- [ ] **Step 2: Add the weight summary strip**

Extend the existing totals strip row (after the line body) with total sheets / packets / kg alongside the taxable value, using the same helpers.

- [ ] **Step 3: Verify**

Open `/procurement/po/<id>` for the PO from Task 9 and print-preview it. Confirm:
1. Each board line shows `Saffire · 300 GSM · 23 × 36" · 100 sheets/packet`.
2. The summary strip totals 1000 sheets / 10 packets / 160.26 kg.
3. **It still fits one A4 page** and the existing GST breakup, amount-in-words, terms and signature blocks are unchanged.
4. Screenshot the print preview.

---

### Task 11: Detailed pending list

**Files:**
- Modify: `server/src/routes/procurement.js:731-781`
- Modify: `client/src/pages/Procurement.jsx:699-861`

- [ ] **Step 1: Extend the pendency query**

In the `SELECT` at `:733-748`, add the board columns and last-GRN date, keeping the existing `WHERE`/`ORDER BY` untouched:

```sql
       m.grade, m.gsm, m.sheet_l, m.sheet_w, m.sheets_per_packet,
       (SELECT max(g.created_at) FROM grns g WHERE g.po_line_id = pl.id) AS last_grn_at,
       CASE
         WHEN GREATEST(0,(now()::date - po.created_at::date)) <= 7  THEN '0-7'
         WHEN GREATEST(0,(now()::date - po.created_at::date)) <= 15 THEN '8-15'
         WHEN GREATEST(0,(now()::date - po.created_at::date)) <= 30 THEN '16-30'
         ELSE '30+'
       END AS age_bucket,
```

**Confirm the GRN→line linkage first** — check whether `grns` carries `po_line_id` or only `purchase_order_id` (`db.js:310-320`), and adjust the subquery to match the real schema.

Add `pending_weight` to the response by computing it in JS from the returned board fields (via `totalWeight`) rather than duplicating the formula in SQL, and add a `by_grade` rollup beside the existing `by_vendor` / `by_material`, plus `pending_weight` on each rollup.

- [ ] **Step 2: Surface it in the UI**

In the Pendency tab:
- Add **Pending kg** to the line table and to the KPI strip (`:722-726`).
- Add **Last GRN** and **Age Bucket** columns.
- Colour overdue rows amber against `expected_date` (`overdue_days > 0` is already returned).
- Add a **Grade-wise** sub-view beside the existing Item/Party views, and surface the already-computed-but-never-rendered `by_category` rollup rather than adding a parallel one.
- Add pending weight to the export column builders at `:735-758` and `:819-831`.

- [ ] **Step 3: Verify**

Procurement → **Pendency**. With the open PO from Task 9:
1. The line shows Pending 1000 sheets and **160.26 kg**; the KPI strip totals pending kg.
2. Age bucket reads `0-7`.
3. The Grade-wise view groups the Saffire pending weight.
4. Set the PO's expected date to yesterday → the row highlights amber.
5. Export to PDF/XLSX → pending kg is present in the file.
6. Screenshot the Pendency tab.

**Do not change** the pending definition: it is driven by `po_lines.received_qty`, which only increments on QC acceptance (`procurement.js:800`), so quarantined material correctly still reads as pending.

---

# PHASE 4 — Warehouse

---

### Task 12: Total weight in the warehouse

**Files:**
- Modify: `server/src/routes/inventory.js:10-37`
- Modify: `client/src/pages/Inventory.jsx:199-210, 278-309`

- [ ] **Step 1: Return the board fields from the stock endpoint**

In the `GET /inventory/stock` query (`inventory.js:10-37`), add `m.grade, m.gsm, m.sheet_l, m.sheet_w, m.sheets_per_packet` to the select list. For leftovers, fall back to the source board so an offcut still has a GSM:

```sql
       COALESCE(m.grade, src.grade) AS grade,
       COALESCE(m.gsm, src.gsm)     AS gsm,
       m.sheet_l, m.sheet_w,        -- the strip's own size, never the parent's
       COALESCE(m.sheets_per_packet, src.sheets_per_packet) AS sheets_per_packet
  … LEFT JOIN materials src ON src.id = m.source_material_id
```

- [ ] **Step 2: Add the column and KPI**

In `Inventory.jsx:199-210`, add a **Total Weight** column after Available:

```jsx
{ key: 'total_weight', label: 'Total Weight',
  cell: r => { const v = totalWeight(r, r.available); return v == null ? '—' : `${v.toFixed(1)} kg`; } },
```

Add a total-weight figure to the header strip, summing only rows where the weight is computable, with a muted "n items without GSM" note beside it so a missing master stays visible rather than being absorbed as zero.

Apply the same column to the Leftover sub-tab (`:278-309`).

- [ ] **Step 3: Verify**

The DB currently has **zero** stock, so seed a receipt to test: raise a PO for a Saffire board, create a GRN, and pass QC so the batch becomes `available`. Then in **Warehouse → RM Stock**:
1. The Saffire row shows Available 1000 sheets and Total Weight **160.3 kg**.
2. The header shows the plant's total board tonnage.
3. `Unspecified board` (id 278) shows **—**, not `0`.
4. Screenshot the warehouse list.

**Clean up any test data using the `UAT-` marker convention, scoped by that marker only.** Never run an unscoped delete on this DB.

---

## Final verification

- [ ] `npm test -w server` — full suite green, no pre-existing test broken.
- [ ] The four phase screenshots are captured for the change summary.
- [ ] `git status` shows the expected files changed — **and nothing is committed**.

---

## Self-review notes

Checked against the spec:
- Every spec section maps to a task: model → T3, weight helper → T1, code composition → T2 (added after the spec review surfaced the undefined `GRADE_CODE`), migration → T4, board form → T6, rate sub-module → T5/T7, rate-resolution bug → T8/T9, PO weight + provenance → T9, print → T10, pending → T11, warehouse → T12.
- Naming is consistent across tasks: `kgPerSheet`, `packetWeight`, `ratePerSheet`, `packetRate`, `totalWeight`, `packets`, `resolveRatePerKg`, `boardName`, `boardCode`, `parseBoardName`, `gradeCode`.
- Two places carry a **verify-before-you-code** instruction rather than an assumption: the `audit()` signature in T5 Step 1, and the `grns` → `po_line_id` linkage in T11 Step 1. Both are real unknowns; confirm against the code rather than trusting the sketch.
- Spec items deliberately not implemented (listed as out of scope in the spec): per-board rate overrides, GSM-band pricing, effective-date time-travel pricing.
