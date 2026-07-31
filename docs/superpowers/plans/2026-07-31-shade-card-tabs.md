# Shade Cards — Seven Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Shade Cards register into seven tabs — one per whoever is
holding the card — and rebuild To Issue so it starts from the sales order book
instead of the card register.

**Architecture:** One new pure function (`issueBand`) in `shade-flow.js` decides
what a live order line needs from the module. One new endpoint
(`GET /shade-cards/to-issue`) fetches order lines and calls it. Three of the
four new tabs are pure client-side filters over rows the page already loads, so
they cost no new queries. Nine navigation tiles collapse to four health tiles.
No migration — no column and no table is added.

**Tech Stack:** Express + node:pg (server), `node --test` for server unit tests,
React 18 + Tailwind + lucide-react (client), Vite. No client test framework —
client tasks verify with `npm run build -w client` plus a check in the real
running app.

**Spec:** [2026-07-31-shade-card-tabs-design.md](../specs/2026-07-31-shade-card-tabs-design.md)

**Repo:** `~/Documents/CI ERP FInal/ci-erp`, branch `shade-card-simplification`

---

## Before you start

This tree is shared with other Claude sessions. Two rules that are not optional:

1. **Never `git checkout -- <file>` and never `git stash`.** Other sessions have
   uncommitted work in `client/src/pages/Section.jsx`, `server/src/db.js`,
   `server/src/helpers.js` and others. Discarding is destructive to their work.
2. **`git add` explicit paths only.** Never `git add -A` or `git add .`. Every
   commit in this plan lists its exact paths — use them verbatim.

Run everything from the repo root unless a step says otherwise.

---

## File Structure

| file | responsibility |
|---|---|
| `server/src/shade-flow.js` | **modify** — add `ISSUE_BANDS` + `issueBand()`. Pure, DB-free, the only new judgement in this work. |
| `server/src/shade-flow.test.js` | **modify** — append `issueBand` cases. |
| `server/src/routes/shadecards.js` | **modify** — add `GET /shade-cards/to-issue` and its `decorateLine` helper. Fetches; does not classify. |
| `client/src/pages/ShadeCards.jsx` | **modify** — 4 tabs → 7, 9 tiles → 4, load `/to-issue`, derive the three status lists. Keeps ownership of loading and the drawer. |
| `client/src/pages/shade-cards/ToSend.jsx` | **create** — draft cards. Presentational: takes `rows`, `onOpen`. |
| `client/src/pages/shade-cards/WithCustomer.jsx` | **create** — sent cards, overdue band on top. Takes `rows`, `onOpen`. |
| `client/src/pages/shade-cards/OnFloor.jsx` | **create** — open custody rows, 7-day band on top. Takes `rows`, `onOpen`. |
| `client/src/pages/shade-cards/ToIssue.jsx` | **rewrite** — order-line-first, banded by action. Takes `rows`, `onOpen`, `onCreate`. |
| `client/src/pages/shade-cards/ShadeCardForm.jsx` | **modify** — one new optional prop `initialLineId`. |

Each new tab file is a single presentational component that takes rows and
callbacks — the same shape `RetireZone.jsx` and today's `ToIssue.jsx` already
use. None of them fetches, and none owns the drawer.

---

## Task 1: `issueBand()` — the only new logic

**Files:**
- Modify: `server/src/shade-flow.js` (append at end of file)
- Test: `server/src/shade-flow.test.js` (append at end of file)

- [ ] **Step 1: Write the failing tests**

Append to `server/src/shade-flow.test.js`:

```js
// ── To Issue bands ───────────────────────────────────────────────────────────
test('band 1: an order line with no card behind it needs one made', () => {
  assert.equal(issueBand(null, null), 1);
});

test('band 1: a soft-deleted card is no card at all', () => {
  assert.equal(issueBand(mk({ status: 'approved', active: 0 }), null), 1);
});

test('band 2: approved and in date is ready to walk to the floor', () => {
  const now = Date.parse('2026-07-31T00:00:00Z');
  assert.equal(issueBand(mk({ status: 'approved', creation_date: '2026-07-01' }), null, now), 2);
});

test('band 2: an UNDATABLE approved card is ready, not expired', () => {
  // 36 cards on production have no creation_date. Treating undatable as expired
  // would hide real work behind a Renew button that fixes nothing.
  assert.equal(issueBand(mk({ status: 'approved', creation_date: null }), null), 2);
});

test('band 3: an approved card past its 365-day life needs renewing', () => {
  const now = Date.parse('2026-07-31T00:00:00Z');
  assert.equal(issueBand(mk({ status: 'approved', creation_date: '2025-01-01' }), null, now), 3);
});

test('band 4: draft, sent and rejected all wait on the approval loop', () => {
  for (const status of ['draft', 'sent', 'rejected'])
    assert.equal(issueBand(mk({ status }), null), 4);
});

test('band 5: custody outranks age — an expired card that is OUT is not renewable', () => {
  // Offering "Renew" for a card nobody can physically hand you is an action
  // that cannot be completed.
  const now = Date.parse('2026-07-31T00:00:00Z');
  assert.equal(
    issueBand(mk({ status: 'approved', creation_date: '2025-01-01' }), openIssue(), now), 5);
});

test('band 5: custody outranks approval state too', () => {
  assert.equal(issueBand(mk({ status: 'draft' }), openIssue()), 5);
});

test('bands: ISSUE_BANDS covers 1-5 with no gaps and no duplicates', () => {
  assert.deepEqual(ISSUE_BANDS.map(b => b.band), [1, 2, 3, 4, 5]);
});
```

Add `ISSUE_BANDS` and `issueBand` to the existing import block at the top of
`server/src/shade-flow.test.js`:

```js
import {
  SHADE_STATUSES, TRANSITIONS, transitionBlocker, labelFor, STATUS_LABEL,
  ageDays, isExpiredByAge, SHADE_CARD_LIFE_DAYS,
  printingEligibility, codeMatch,
  issueBlocker, returnBlocker, holderOf, ageUnknown,
  ISSUE_BANDS, issueBand,
} from './shade-flow.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && node --test server/src/shade-flow.test.js
```

Expected: failures reading `issueBand is not a function`.

**If the whole file fails with zero assertions listed, that is an import error,
not a test failure** — run the file directly and read the real `SyntaxError`.

- [ ] **Step 3: Write the implementation**

Append to `server/src/shade-flow.js`:

```js
// ── The To Issue worklist ────────────────────────────────────────────────────
// What does this SALES ORDER LINE need from the module right now? The register
// cannot answer that: it starts from cards, so it is structurally blind to the
// order lines that have no card at all — the largest backlog in the module.
//
// Five bands, evaluated IN ORDER — a line lands in the first that matches,
// which is what makes them a partition rather than five overlapping filters.
export const ISSUE_BANDS = [
  { band: 1, key: 'no_card',  label: 'No card yet',
    hint: 'Nothing stands behind this order line', action: 'Create card' },
  { band: 2, key: 'ready',    label: 'Ready to issue',
    hint: 'Approved, in date, sitting in the store', action: 'Issue' },
  { band: 3, key: 'expired',  label: 'Expired card',
    hint: 'Past its 365-day life — re-approve before it can run', action: 'Renew' },
  { band: 4, key: 'approval', label: 'Waiting on approval',
    hint: 'The card exists; the customer has not signed it off', action: null },
  { band: 5, key: 'out',      label: 'With printing already',
    hint: 'Issued and not yet returned', action: null },
];

// `card` is null for a line with no card. `openIssue` is the open custody row.
//
// Custody is tested BEFORE age deliberately. An expired card that is out on a
// press is band 5, not band 3: offering "Renew" for a card nobody can
// physically hand you is an action that cannot be completed.
//
// An undatable card falls to band 2, not band 3 — isExpiredByAge() is false for
// it, and that is the intended reading. 36 such cards exist on production and
// parking them under "Renew" would hide real work behind a button that fixes
// nothing. The undatable risk is surfaced by ageUnknown() in the register, not
// here.
export function issueBand(card, openIssue, now = Date.now()) {
  if (!card || card.active === 0) return 1;
  if (openIssue) return 5;
  if (card.status !== 'approved') return 4;
  if (isExpiredByAge(card, now)) return 3;
  return 2;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && node --test server/src/shade-flow.test.js
```

Expected: all pass, `# fail 0`.

- [ ] **Step 5: Run the whole server suite — nothing else may break**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && npm test -w server
```

Expected: `# fail 0`. `issueBand` is additive, so every existing caller of
`shade-flow.js` is unaffected.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && git add server/src/shade-flow.js server/src/shade-flow.test.js && git commit -m "feat(shade): issueBand() — what a live order line needs from the module

Five bands evaluated in order, so a line lands in exactly one. Custody is
tested before age: an expired card out on a press is 'with printing', not
'renew', because Renew is not an action anyone can complete on a card they
cannot hold. An undatable card reads as ready, not expired — 36 exist and
parking them under Renew hides real work behind a button that fixes nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: `GET /shade-cards/to-issue`

**Files:**
- Modify: `server/src/routes/shadecards.js`

There are no route-level tests anywhere in this repo — every server test is
pure logic in `server/src/*.test.js`, and Task 1 already covers the judgement
this route makes. This route is verified by calling it.

- [ ] **Step 1: Extend the shade-flow import**

In `server/src/routes/shadecards.js`, the import block at lines 13-18 becomes:

```js
import {
  SHADE_STATUSES, APPROVAL_METHODS, DEPARTMENTS, RETURN_CONDITIONS,
  transitionBlocker, labelFor, printingEligibility, codeMatch,
  issueBlocker, returnBlocker, holderOf, ageDays, isExpiredByAge, ageUnknown,
  SHADE_CARD_LIFE_DAYS, ISSUE_BANDS, issueBand,
} from '../shade-flow.js';
```

- [ ] **Step 2: Add the route**

Insert immediately **after** the `r.get('/shade-cards/reports', …)` handler ends
and **before** `r.get('/shade-cards/:id(\\d+)', …)` (around line 408).

Placement matters for readability, not for routing — the `:id(\\d+)` constraint
already stops `/to-issue` being swallowed — but keeping the collection routes
together is the file's existing convention.

```js
// ── To Issue: what the ORDER BOOK needs from this module ─────────────────────
// One row per live sales order line, NOT per card. The register cannot answer
// this question: it starts from cards, so it is structurally blind to order
// lines with no card at all — which is the largest backlog in the module.
//
// The lateral picks THE card for the line rather than listing every card on the
// product, because the tab answers "can this order run", not "how many cards
// exist". Approved-wins-then-newest is deliberate: a product carrying one
// expired approved card and one newer draft must read as EXPIRED (renewable)
// rather than WAITING ON APPROVAL (a slower path that ignores the approval it
// already has).
const TO_ISSUE_VIEW = `
  SELECT ol.id AS order_line_id, ol.qty AS order_qty, ol.status AS line_status,
         o.id AS order_id, o.po_number, o.po_date,
         p.id AS product_id, p.code AS product_code, p.name AS product_name,
         c.name AS customer_name,
         card.id AS card_id, card.sc_number, card.status AS card_status,
         card.creation_date, card.active AS card_active,
         card.artwork_no, card.output_no, card.expected_approval_date,
         open_i.id AS open_issue_id, open_i.issued_to, open_i.department,
         open_i.issued_at,
         jc.id AS jc_id, jc.jc_number, jc.queue_pos, jc.machine_id AS jc_machine_id,
         m.name AS press_name
  FROM order_lines ol
  JOIN orders o ON o.id = ol.order_id
  JOIN products p ON p.id = ol.product_id
  LEFT JOIN customers c ON c.id = o.customer_id
  LEFT JOIN LATERAL (
    SELECT * FROM shade_cards sc
    WHERE sc.product_id = ol.product_id AND sc.active = 1
    ORDER BY (sc.status = 'approved') DESC,
             sc.creation_date DESC NULLS LAST, sc.id DESC
    LIMIT 1) card ON true
  LEFT JOIN LATERAL (
    SELECT id, issued_to, department, issued_at FROM shade_card_issues i
    WHERE i.shade_card_id = card.id AND i.returned_at IS NULL LIMIT 1) open_i ON true
  LEFT JOIN job_cards jc ON jc.order_line_id = ol.id AND jc.status <> 'closed'
  LEFT JOIN machines m ON m.id = jc.machine_id
  WHERE ol.status IN ('pending','planned','ready','in_production')`;

// The SQL fetches; issueBand classifies. The judgement lives in shade-flow.js
// where shade-flow.test.js can reach it — a CASE expression buried in a query
// cannot be tested, and this is the one thing here that can mislead the floor.
function decorateLine(row) {
  const card = row.card_id
    ? { id: row.card_id, sc_number: row.sc_number, status: row.card_status,
        creation_date: row.creation_date, active: row.card_active }
    : null;
  const open = row.open_issue_id
    ? { issued_to: row.issued_to, department: row.department, issued_at: row.issued_at }
    : null;
  return {
    ...row,
    band: issueBand(card, open),
    age_days: card ? ageDays(card) : null,
    age_unknown: card ? ageUnknown(card) : false,
    holder: holderOf(open),
    // How far down the print plan THIS LINE has travelled — the same three
    // tiers the register uses, but keyed on the line rather than the product,
    // because a line is what actually gets scheduled onto a press.
    work_tier: row.jc_id ? (row.jc_machine_id ? 1 : 2) : 3,
  };
}

r.get('/shade-cards/to-issue', async (_req, res, next) => {
  try {
    const rows = await q(`${TO_ISSUE_VIEW}
                          ORDER BY o.po_date DESC NULLS LAST, ol.id`);
    res.json({ bands: ISSUE_BANDS, rows: rows.map(decorateLine) });
  } catch (e) { next(e); }
});
```

`ISSUE_BANDS` rides along in the payload for the same reason `WORK_TIERS` is
exported: a band whose label drifts between the two ends is a band nobody
trusts.

- [ ] **Step 3: Restart the API and call the route**

Server edits do not always hot-reload. Restart before believing any result.

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && npm run dev
```

Then, in a second shell, log in and call it:

```bash
TOKEN=$(curl -s localhost:4000/api/auth/login -H 'content-type: application/json' -d '{"email":"admin@motionci.com","password":"admin123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token') && curl -s localhost:4000/api/shade-cards/to-issue -H "authorization: Bearer $TOKEN" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); const c={}; for(const r of d.rows) c[r.band]=(c[r.band]||0)+1; JSON.stringify({total:d.rows.length,byBand:c},null,2)'
```

Expected, against the current local mirror:

```json
{
  "total": 99,
  "byBand": { "1": 68, "2": 15, "3": 16 }
}
```

The three counts must sum to 99. If band 4 or 5 appears, that is real data
(somebody created or issued a card since this plan was written), not a bug — but
the total must still equal the live order-line count.

Then prove the `WHERE` clause excludes finished and cancelled work — the route's
one untested property, since there are no route tests:

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp/server && node --input-type=module -e "import pg from 'pg'; const c=new pg.Client('postgresql://postgres:postgres@localhost:5439/cierp'); await c.connect(); const r=await c.query(\"SELECT COUNT(*)::int n FROM order_lines WHERE status IN ('pending','planned','ready','in_production')\"); console.log('live order lines:', r.rows[0].n); await c.end();"
```

Expected: the number printed equals `total` from the previous command. If the
route returns more, a closed or cancelled line is leaking through.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && git add server/src/routes/shadecards.js && git commit -m "feat(shade): GET /shade-cards/to-issue — the order book's view of the module

One row per live sales order line, not per card, which is the only way to
see the 68 lines that have no shade card at all. The lateral picks THE card
for the line, approved-wins-then-newest, so a product holding an expired
approved card and a newer draft reads as expired rather than as unapproved.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Nine tiles become four

**Files:**
- Modify: `client/src/pages/ShadeCards.jsx:42-65` (the `TILES` array)
- Modify: `client/src/pages/ShadeCards.jsx:187-197` (the tile grid)

This task is independent of the tabs and visible on its own, so it lands first.

- [ ] **Step 1: Replace the TILES array**

Replace lines 42-65 of `client/src/pages/ShadeCards.jsx` (the whole `TILES`
const, from the `// The eight tiles…` comment through its closing `];`) with:

```js
// Four tiles, and none of them is navigation any more — the tabs carry that.
// These are HEALTH: one number split three ways, plus the total. Six of the old
// nine are now tabs, and keeping both would give one destination two controls.
//
// They filter on AGE ALONE, never on status. Every card is `approved` today so
// a status clause would be invisibly redundant — and the moment drafts exist it
// would silently stop the three from summing to the total, which is the one
// property that makes this row readable at a glance.
const TILES = [
  { key: 'all',     label: 'Total cards',       icon: SwatchBook,
    filter: () => true },
  { key: 'in_date', label: 'In date',           icon: BadgeCheck,
    chip: 'bg-emerald-50 text-emerald-600',
    filter: r => !r.age_unknown && !r.expired_by_age },
  { key: 'expired', label: 'Expired',           icon: FileClock,
    chip: 'bg-red-50 text-red-600',
    filter: r => r.expired_by_age },
  { key: 'no_date', label: 'No date on record', icon: AlertTriangle,
    chip: 'bg-amber-50 text-amber-600',
    filter: r => r.age_unknown },
];
```

- [ ] **Step 2: Simplify the counts memo**

The `issues` special case counted issue rows for a tile that no longer exists.
Replace the `counts` memo (lines 101-109) with:

```js
  const counts = useMemo(() => {
    const out = {};
    for (const t of TILES) out[t.key] = active.filter(t.filter).length;
    return out;
  }, [active]);
```

- [ ] **Step 3: Simplify the tile grid**

Replace the tile grid block (lines 187-197) with:

```jsx
      {/* Health, not navigation. Each tile filters the Register beneath it. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TILES.map(t => (
          <button key={t.key} onClick={() => { setTile(t.key); setView('register'); }}
            className={`cursor-pointer text-left transition ${
              tile === t.key && view === 'register'
                ? 'ring-2 ring-brand-400 ring-offset-2 rounded-[22px]' : ''}`}>
            <KpiCard label={t.label} value={fmt.num(counts[t.key])} icon={t.icon}
              chip={t.chip} accent={counts[t.key] ? undefined : 'text-slate-400'} />
          </button>))}
      </div>
```

The `disabled={!t.filter}` and `t.view` branches are gone — every tile now
filters, and no tile navigates.

- [ ] **Step 4: Drop the now-unused icon imports**

`Printer`, `Clock4`, `PackageCheck` and `Send` were used only by the retired
tiles. Leave the import line alone for now — Tasks 4-7 re-introduce `Send`,
`Printer` and add `UserCheck` and `Factory` for the tabs. Removing them here
and re-adding them two tasks later is churn.

- [ ] **Step 5: Build**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && npm run build -w client
```

Expected: build succeeds with no errors.

- [ ] **Step 6: Check it in the running app**

With `npm run dev` running, open the app, log in as
`admin@motionci.com` / `admin123`, and go to Shade Cards at a desktop width.

Expected: one row of four tiles reading **Total cards 600 · In date 258 ·
Expired 306 · No date on record 36**. `258 + 306 + 36` must equal `600` — if it
does not, the filters overlap and the partition is broken. Clicking each tile
filters the table beneath it and rings the tile.

- [ ] **Step 7: Commit**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && git add client/src/pages/ShadeCards.jsx && git commit -m "feat(shade): nine navigation tiles become four health tiles

Six of the nine are about to become tabs, and one destination with two
controls is worse than either alone. What is left is the number nobody was
showing: 306 of 600 cards are past their 365-day life and 36 have no date at
all, so only 258 can actually be printed against. The three partition the
register exactly, which is what makes the row readable at a glance.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: To Send tab

**Files:**
- Create: `client/src/pages/shade-cards/ToSend.jsx`
- Modify: `client/src/pages/ShadeCards.jsx`

- [ ] **Step 1: Create the component**

Create `client/src/pages/shade-cards/ToSend.jsx`:

```jsx
// Step 2 of the seven: cards we have made and not yet dispatched. The ball is
// ours, and nothing downstream can happen until it moves.
//
// The row button opens the drawer rather than firing the transition here. The
// drawer already lights exactly one primary button per state, so duplicating
// Dispatch would mean two places that must agree about when it is legal.
import { fmt } from '../../api.js';
import { Button, DataTable } from '../../components/ui.jsx';
import { Send, CheckCircle2 } from 'lucide-react';

export default function ToSend({ rows, onOpen }) {
  if (!rows.length) {
    return (
      <div className="ci-data-panel p-8 text-center">
        <CheckCircle2 size={28} className="mx-auto mb-2 text-emerald-500" />
        <p className="text-sm font-bold text-slate-800">Nothing waiting to be sent</p>
        <p className="mt-1 text-xs text-slate-500">
          New cards land here the moment you create one. The cards already in the
          register arrived as an import and skipped this step entirely.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass rounded-[22px] border border-violet-200/60 bg-violet-50/50 p-4">
        <p className="flex items-center gap-2 text-sm font-extrabold text-violet-900">
          <Send size={15} /> {fmt.num(rows.length)} card{rows.length === 1 ? '' : 's'} waiting on us
        </p>
        <p className="mt-1 text-xs font-medium text-violet-900/80">
          Made but not dispatched. Nothing can be approved until it goes out — open one
          and press Dispatch.
        </p>
      </div>

      <DataTable
        exportName="shade-cards-to-send"
        exportSubtitle="Cards made but not yet dispatched to the customer"
        rows={rows} getRowId={r => r.id} searchable
        onRowClick={r => onOpen(r.id)}
        defaultSort={{ key: 'updated_at', dir: 'asc' }}
        columns={[
          { key: 'sc_number', label: 'Card No',
            render: r => <span className="font-semibold text-slate-900">{r.sc_number}</span> },
          { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
          { key: 'product_name', label: 'Product',
            render: r => (
              <span>{r.product_name || '—'}
                {r.product_code && <span className="ml-1 text-slate-400">{r.product_code}</span>}</span>),
            export: r => `${r.product_name || ''} ${r.product_code || ''}`.trim() || '—' },
          { key: 'artwork_no', label: 'AW / Output',
            render: r => (
              <span className="whitespace-nowrap text-xs">
                {r.artwork_no || '—'}<span className="text-slate-300"> / </span>{r.output_no || '—'}
              </span>),
            export: r => `${r.artwork_no || '—'} / ${r.output_no || '—'}`,
            searchValue: r => `${r.artwork_no || ''} ${r.output_no || ''}` },
          { key: 'creation_date', label: 'Card date',
            render: r => r.creation_date ? fmt.date(r.creation_date) : '—' },
          { key: 'updated_at', label: 'Sitting since', render: r => fmt.dt(r.updated_at) },
          { key: '_act', label: '', sortable: false, export: () => '',
            render: r => (
              <Button size="sm" onClick={e => { e.stopPropagation(); onOpen(r.id); }}>
                <Send size={13} /> Dispatch
              </Button>) },
        ]}
        empty="—"
      />
    </div>
  );
}
```

- [ ] **Step 2: Wire it into ShadeCards.jsx**

Add the import beside the other tab imports (after the `ToIssue` import,
around line 18):

```jsx
import ToSend from './shade-cards/ToSend.jsx';
```

Add `UserCheck` and `Factory` to the `lucide-react` import now, so Tasks 5 and 6
do not touch this line again:

```jsx
import {
  Plus, SwatchBook, Send, BadgeCheck, AlertTriangle, Printer, FileClock,
  Clock4, PackageCheck, Archive, ArrowRight, UserCheck, Factory,
} from 'lucide-react';
```

Add the derived list next to the `counts` memo:

```jsx
  // The three custody/lifecycle queues are pure filters over rows the page has
  // already loaded — no extra request for any of them.
  const toSend = useMemo(() => active.filter(r => r.status === 'draft'), [active]);
```

Add the tab to the `SubTabs` views array (lines 216-221), between Register and
To Issue:

```jsx
          { key: 'to_send', label: 'To Send', icon: Send, count: toSend.length },
```

Render it beside the other views (after the `to_issue` line, around line 242):

```jsx
      {view === 'to_send' && <ToSend rows={toSend} onOpen={setDetailId} />}
```

- [ ] **Step 3: Build**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && npm run build -w client
```

Expected: build succeeds.

- [ ] **Step 4: Check it in the running app**

Open Shade Cards. Expected: a **To Send 0** tab between Register and To Issue.
Click it — the empty state reads "Nothing waiting to be sent", not "No rows".

To prove the populated path, create a card (**+ New Shade Card**, pick any sales
order line, save). It is created as `draft`, so the tab count becomes 1 and the
row appears with a Dispatch button. Open it, press Dispatch, and confirm the row
leaves this tab.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && git add client/src/pages/shade-cards/ToSend.jsx client/src/pages/ShadeCards.jsx && git commit -m "feat(shade): a To Send tab — the cards the customer has not seen yet

Draft cards were surfaced nowhere: no tile, no tab, no alert. The row button
opens the drawer rather than firing the transition, so the rule about when
Dispatch is legal stays in one place.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: With Customer tab

**Files:**
- Create: `client/src/pages/shade-cards/WithCustomer.jsx`
- Modify: `client/src/pages/ShadeCards.jsx`

- [ ] **Step 1: Create the component**

Create `client/src/pages/shade-cards/WithCustomer.jsx`:

```jsx
// Step 3 of the seven: dispatched, and the customer is holding it. Nothing here
// is ours to do except chase.
//
// Overdue rows get their own band at the top rather than a colour on a column.
// This is the "Approval overdue" alarm, and putting it here places it directly
// above the rows causing it — which is the whole reason the Overdue tile could
// be retired.
import { useMemo } from 'react';
import { fmt } from '../../api.js';
import { Button, DataTable } from '../../components/ui.jsx';
import { UserCheck, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { today } from './lifecycle.js';

const daysSince = d => {
  const t = Date.parse(d || '');
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
};

const columns = onOpen => [
  { key: 'sc_number', label: 'Card No',
    render: r => <span className="font-semibold text-slate-900">{r.sc_number}</span> },
  { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
  { key: 'product_name', label: 'Product',
    render: r => (
      <span>{r.product_name || '—'}
        {r.product_code && <span className="ml-1 text-slate-400">{r.product_code}</span>}</span>),
    export: r => `${r.product_name || ''} ${r.product_code || ''}`.trim() || '—' },
  { key: 'sent_to_customer_date', label: 'Sent on',
    render: r => r.sent_to_customer_date ? fmt.date(r.sent_to_customer_date) : '—' },
  { key: 'expected_approval_date', label: 'Expected back',
    render: r => r.expected_approval_date
      ? <span className={r.expected_approval_date < today() ? 'font-semibold text-red-600' : ''}>
          {fmt.date(r.expected_approval_date)}</span>
      : <span className="text-slate-300">not set</span> },
  { key: '_waiting', label: 'Waiting', align: 'right',
    sortValue: r => daysSince(r.sent_to_customer_date) ?? -1,
    render: r => {
      const d = daysSince(r.sent_to_customer_date);
      return d == null ? '—'
        : <span className={`font-semibold tabular-nums ${d >= 14 ? 'text-red-600' : d >= 7 ? 'text-amber-600' : 'text-slate-600'}`}>{d}d</span>;
    },
    export: r => { const d = daysSince(r.sent_to_customer_date); return d == null ? '—' : `${d}d`; } },
  { key: '_act', label: '', sortable: false, export: () => '',
    render: r => (
      <Button size="sm" onClick={e => { e.stopPropagation(); onOpen(r.id); }}>
        <UserCheck size={13} /> Record verdict
      </Button>) },
];

export default function WithCustomer({ rows, onOpen }) {
  const { overdue, waiting } = useMemo(() => {
    const isOverdue = r => !!r.expected_approval_date && r.expected_approval_date < today();
    return {
      overdue: rows.filter(isOverdue),
      waiting: rows.filter(r => !isOverdue(r)),
    };
  }, [rows]);

  if (!rows.length) {
    return (
      <div className="ci-data-panel p-8 text-center">
        <CheckCircle2 size={28} className="mx-auto mb-2 text-emerald-500" />
        <p className="text-sm font-bold text-slate-800">No cards are out for approval</p>
        <p className="mt-1 text-xs text-slate-500">
          Dispatch one from To Send and it sits here until the customer's verdict is recorded.
        </p>
      </div>
    );
  }

  const cols = columns(onOpen);

  return (
    <div className="space-y-4">
      {overdue.length > 0 && (
        <section className="rounded-[22px] border border-red-300 bg-red-50/60 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            <span className="rounded-full bg-red-600 px-2.5 py-0.5 text-[11px] font-extrabold text-white">
              {overdue.length}
            </span>
            <span className="text-sm font-extrabold text-slate-800">Overdue</span>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
              <AlertTriangle size={12} /> past the date the customer was expected to come back
            </span>
          </div>
          <DataTable exportName="shade-cards-approval-overdue"
            exportSubtitle="Sent to the customer and past the expected approval date"
            rows={overdue} columns={cols} getRowId={r => r.id}
            onRowClick={r => onOpen(r.id)} empty="—" />
        </section>
      )}

      {waiting.length > 0 && (
        <section className="rounded-[22px] border border-slate-200 bg-slate-50/60 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            <span className="rounded-full bg-slate-500 px-2.5 py-0.5 text-[11px] font-extrabold text-white">
              {waiting.length}
            </span>
            <span className="text-sm font-extrabold text-slate-800">Still in hand</span>
            <span className="text-xs font-medium text-slate-500">
              within the expected window, or no date was set
            </span>
          </div>
          <DataTable exportName="shade-cards-with-customer"
            exportSubtitle="Out for approval, not yet overdue"
            rows={waiting} columns={cols} getRowId={r => r.id}
            onRowClick={r => onOpen(r.id)} empty="—" />
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire it into ShadeCards.jsx**

Import beside the others:

```jsx
import WithCustomer from './shade-cards/WithCustomer.jsx';
```

Derived list, beside `toSend`:

```jsx
  const withCustomer = useMemo(() => active.filter(r => r.status === 'sent'), [active]);
```

Tab, after To Send:

```jsx
          { key: 'with_customer', label: 'With Customer', icon: UserCheck, count: withCustomer.length },
```

Render, beside the others:

```jsx
      {view === 'with_customer' && <WithCustomer rows={withCustomer} onOpen={setDetailId} />}
```

- [ ] **Step 3: Build**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && npm run build -w client
```

Expected: build succeeds.

- [ ] **Step 4: Check it in the running app**

Expected: a **With Customer 0** tab with the "No cards are out for approval"
empty state.

To prove the populated path and the overdue band: create a card, set its
**Expected approval date** to a date in the past, Dispatch it. It appears in the
red **Overdue** band. Edit the expected date to a future date and it moves to
**Still in hand**.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && git add client/src/pages/shade-cards/WithCustomer.jsx client/src/pages/ShadeCards.jsx && git commit -m "feat(shade): a With Customer tab, with the overdue alarm sitting on the rows

The Approval overdue alarm existed as a tile that showed a number somewhere
other than the rows causing it. It is now a red band at the top of the tab
that owns those rows, which is what let the Overdue tile be retired.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: On Floor tab

**Files:**
- Create: `client/src/pages/shade-cards/OnFloor.jsx`
- Modify: `client/src/pages/ShadeCards.jsx`

- [ ] **Step 1: Create the component**

Create `client/src/pages/shade-cards/OnFloor.jsx`:

```jsx
// Step 6-7 of the seven: printing is holding the card and has not given it back.
// The custody loop's open half.
//
// The 7-day band is the "long-pending return" alarm the previous spec defined
// and nothing surfaced. A card that has been out a fortnight is either lost or
// sitting on a press that finished days ago, and both are worth a phone call.
import { useMemo } from 'react';
import { fmt } from '../../api.js';
import { Button, DataTable } from '../../components/ui.jsx';
import { PackageCheck, AlertTriangle, CheckCircle2 } from 'lucide-react';

const LONG_PENDING_DAYS = 7;

const daysOut = r => {
  const t = Date.parse(r.issued_at || '');
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
};

const columns = onOpen => [
  { key: 'sc_number', label: 'Card No',
    render: r => <span className="font-semibold text-slate-900">{r.sc_number}</span> },
  { key: 'product_name', label: 'Product',
    render: r => (
      <span>{r.product_name || '—'}
        {r.product_code && <span className="ml-1 text-slate-400">{r.product_code}</span>}</span>),
    export: r => `${r.product_name || ''} ${r.product_code || ''}`.trim() || '—' },
  { key: 'issued_to', label: 'Held by',
    render: r => (
      <span className="whitespace-nowrap text-xs font-semibold text-blue-700">
        {r.issued_to}<span className="ml-1 font-normal text-slate-400">· {fmt.title(r.department)}</span>
      </span>),
    export: r => `${r.issued_to} (${r.department})`,
    searchValue: r => `${r.issued_to} ${r.department}` },
  { key: 'issued_machine_name', label: 'Press / Job',
    sortValue: r => r.issued_machine_name || '',
    render: r => r.issued_machine_name || r.issued_jc_number
      ? <span className="whitespace-nowrap text-xs font-semibold text-slate-700">
          {r.issued_machine_name || '—'}
          {r.issued_jc_number && <span className="ml-1 font-normal text-slate-400">{r.issued_jc_number}</span>}
        </span>
      : <span className="text-xs text-slate-400">not recorded</span>,
    export: r => `${r.issued_machine_name || '—'} ${r.issued_jc_number || ''}`.trim() },
  { key: 'issued_at', label: 'Issued on', render: r => fmt.dt(r.issued_at) },
  { key: '_out', label: 'Days out', align: 'right',
    sortValue: r => daysOut(r) ?? -1,
    render: r => {
      const d = daysOut(r);
      return d == null ? '—'
        : <span className={`font-semibold tabular-nums ${d >= LONG_PENDING_DAYS ? 'text-red-600' : 'text-slate-600'}`}>{d}d</span>;
    },
    export: r => { const d = daysOut(r); return d == null ? '—' : `${d}d`; } },
  { key: '_act', label: '', sortable: false, export: () => '',
    render: r => (
      <Button size="sm" onClick={e => { e.stopPropagation(); onOpen(r.id); }}>
        <PackageCheck size={13} /> Record return
      </Button>) },
];

export default function OnFloor({ rows, onOpen }) {
  const { late, recent } = useMemo(() => ({
    late: rows.filter(r => (daysOut(r) ?? 0) >= LONG_PENDING_DAYS),
    recent: rows.filter(r => (daysOut(r) ?? 0) < LONG_PENDING_DAYS),
  }), [rows]);

  if (!rows.length) {
    return (
      <div className="ci-data-panel p-8 text-center">
        <CheckCircle2 size={28} className="mx-auto mb-2 text-emerald-500" />
        <p className="text-sm font-bold text-slate-800">Every card is in the store</p>
        <p className="mt-1 text-xs text-slate-500">
          Cards appear here while printing is holding them, and leave when the return is recorded.
        </p>
      </div>
    );
  }

  const cols = columns(onOpen);

  return (
    <div className="space-y-4">
      {late.length > 0 && (
        <section className="rounded-[22px] border border-red-300 bg-red-50/60 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            <span className="rounded-full bg-red-600 px-2.5 py-0.5 text-[11px] font-extrabold text-white">
              {late.length}
            </span>
            <span className="text-sm font-extrabold text-slate-800">Out more than {LONG_PENDING_DAYS} days</span>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
              <AlertTriangle size={12} /> chase these — a card this long out is lost or forgotten
            </span>
          </div>
          <DataTable exportName="shade-cards-long-pending-return"
            exportSubtitle={`Issued more than ${LONG_PENDING_DAYS} days ago and not returned`}
            rows={late} columns={cols} getRowId={r => r.id}
            onRowClick={r => onOpen(r.id)} empty="—" />
        </section>
      )}

      {recent.length > 0 && (
        <section className="rounded-[22px] border border-blue-200 bg-blue-50/50 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            <span className="rounded-full bg-blue-600 px-2.5 py-0.5 text-[11px] font-extrabold text-white">
              {recent.length}
            </span>
            <span className="text-sm font-extrabold text-slate-800">Out with printing</span>
            <span className="text-xs font-medium text-slate-500">issued recently, running normally</span>
          </div>
          <DataTable exportName="shade-cards-on-floor"
            exportSubtitle="Currently issued and not yet returned"
            rows={recent} columns={cols} getRowId={r => r.id}
            onRowClick={r => onOpen(r.id)} empty="—" />
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire it into ShadeCards.jsx**

Import:

```jsx
import OnFloor from './shade-cards/OnFloor.jsx';
```

Derived list:

```jsx
  const onFloor = useMemo(() => active.filter(r => r.with_printing), [active]);
```

Tab — after To Issue, so the strip reads in journey order (Register, To Send,
With Customer, To Issue, On Floor, Reports, Retired):

```jsx
          { key: 'on_floor', label: 'On Floor', icon: Factory, count: onFloor.length },
```

Render:

```jsx
      {view === 'on_floor' && <OnFloor rows={onFloor} onOpen={setDetailId} />}
```

- [ ] **Step 3: Build**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && npm run build -w client
```

Expected: build succeeds.

- [ ] **Step 4: Check it in the running app**

Expected: an **On Floor 0** tab reading "Every card is in the store".

To prove the populated path: open any approved, in-date card and issue it to
printing. It appears in the blue **Out with printing** band with `0d`. Record the
return and it disappears.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && git add client/src/pages/shade-cards/OnFloor.jsx client/src/pages/ShadeCards.jsx && git commit -m "feat(shade): an On Floor tab that surfaces the long-pending return alarm

The custody loop's open half had a tile and no screen, and the 7-day
long-pending-return alarm was specified but rendered nowhere. Both now live
on the tab that owns the rows.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: To Issue, rebuilt sales-order-first

**Files:**
- Rewrite: `client/src/pages/shade-cards/ToIssue.jsx`
- Modify: `client/src/pages/shade-cards/ShadeCardForm.jsx`
- Modify: `client/src/pages/ShadeCards.jsx`

- [ ] **Step 1: Let the create form be seeded with an order line**

In `client/src/pages/shade-cards/ShadeCardForm.jsx`, change the signature on
line 16 and the `lineId` state on line 18:

```jsx
export default function ShadeCardForm({ meta, onClose, onCreated, toast, initialLineId = '' }) {
  const [lines, setLines] = useState([]);
  const [lineId, setLineId] = useState(String(initialLineId || ''));
```

Nothing else changes. The existing `useEffect` on `[lineId]` fires on mount for
a seeded id, so `/prefill` runs and the read-only panel fills exactly as it does
after a manual pick.

- [ ] **Step 2: Rewrite ToIssue.jsx**

Replace the whole of `client/src/pages/shade-cards/ToIssue.jsx` with:

```jsx
// "What does the order book need from this module right now?" — one row per
// LIVE SALES ORDER LINE, not per card.
//
// The old version started from approved cards and asked whether work was
// waiting. That inverts the plant's question and is structurally blind to the
// order lines that have no card at all, which is the biggest backlog here.
//
// Banded by ACTION NEEDED rather than by press proximity. Press proximity is
// the right axis once Print Planning is running, but with no job cards raised
// every line lands in one tier and the banding says nothing. Urgency survives
// as the sort inside each band, so tier-1 rows float up automatically the
// moment planning fills in.
import { useMemo } from 'react';
import { fmt } from '../../api.js';
import { Button, DataTable } from '../../components/ui.jsx';
import { Printer, Plus, RefreshCw, AlertTriangle, CheckCircle2, ArrowRight } from 'lucide-react';

// Mirrors ISSUE_BANDS in server/src/shade-flow.js, which the endpoint also
// returns as `bands`. Kept in the same order and wording so a band never reads
// differently at the two ends.
const BAND_STYLE = {
  1: { cls: 'border-red-300 bg-red-50/60',       pill: 'bg-red-600 text-white' },
  2: { cls: 'border-emerald-300 bg-emerald-50/50', pill: 'bg-emerald-600 text-white' },
  3: { cls: 'border-amber-300 bg-amber-50/50',   pill: 'bg-amber-500 text-white' },
  4: { cls: 'border-violet-200 bg-violet-50/50', pill: 'bg-violet-500 text-white' },
  5: { cls: 'border-slate-200 bg-slate-50/60',   pill: 'bg-slate-500 text-white' },
};

// 85 distinct products sit behind the 99 live lines, so one card can clear
// several rows at once. Saying "68 lines" alone reads as "68 cards to make",
// which overstates the work by a third and is the kind of number that stops
// somebody starting.
const distinctProducts = rows => new Set(rows.map(r => r.product_id)).size;

// Where this LINE has reached in the print plan. Same three tiers the register
// uses; the server computes `work_tier` per line.
function WhereItIs({ row }) {
  if (row.work_tier === 1)
    return (
      <span className="whitespace-nowrap text-xs font-bold text-red-700">
        {row.press_name}
        {row.queue_pos != null && <span className="ml-1 font-medium text-slate-400">#{row.queue_pos}</span>}
      </span>);
  if (row.work_tier === 2)
    return <span className="whitespace-nowrap text-xs font-semibold text-amber-700">{row.jc_number} · triage</span>;
  return <span className="text-xs text-slate-400">not planned yet</span>;
}

function CardCell({ row }) {
  if (!row.card_id) return <span className="text-xs font-semibold text-red-600">no card</span>;
  return (
    <span className="whitespace-nowrap text-xs">
      <span className="font-semibold text-slate-900">{row.sc_number}</span>
      {row.age_unknown
        ? <span className="ml-1 font-semibold text-amber-600" title="No date on record — this card's age cannot be checked">no date</span>
        : row.age_days != null && (
            <span className={`ml-1 font-semibold tabular-nums ${row.age_days >= 365 ? 'text-red-600' : row.age_days >= 335 ? 'text-amber-600' : 'text-slate-400'}`}>
              {row.age_days}d</span>)}
    </span>);
}

export default function ToIssue({ rows, bands, onOpen, onCreate }) {
  const banded = useMemo(() => bands.map(b => ({
    ...b,
    ...BAND_STYLE[b.band],
    rows: rows.filter(r => r.band === b.band)
      // Urgency inside the band: on a press, then triage, then order-only, then
      // the press's own running order. Matches what the Live Floor shows rather
      // than inventing a second opinion about what runs next.
      .sort((a, c) => (a.work_tier - c.work_tier)
        || ((a.queue_pos ?? 1e9) - (c.queue_pos ?? 1e9))
        || String(a.po_number).localeCompare(String(c.po_number))),
  })), [rows, bands]);

  const actionable = rows.filter(r => r.band <= 3).length;

  const columns = band => [
    { key: 'po_number', label: 'Sales Order',
      render: r => <span className="font-medium text-brand-600">{r.po_number}</span> },
    { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
    { key: 'product_name', label: 'Product',
      render: r => (
        <span>{r.product_name || '—'}
          {r.product_code && <span className="ml-1 text-slate-400">{r.product_code}</span>}</span>),
      export: r => `${r.product_name || ''} ${r.product_code || ''}`.trim() || '—' },
    { key: 'order_qty', label: 'Qty', align: 'right',
      render: r => <span className="tabular-nums">{fmt.num(r.order_qty)}</span> },
    { key: '_where', label: 'Where the job is', sortValue: r => r.work_tier,
      render: r => <WhereItIs row={r} />,
      export: r => r.press_name || r.jc_number || 'not planned yet' },
    { key: 'sc_number', label: 'Shade card', sortValue: r => r.sc_number || '',
      render: r => <CardCell row={r} />,
      export: r => r.sc_number || 'no card' },
    { key: '_holder', label: 'Held by', sortValue: r => r.issued_to || '',
      render: r => r.holder
        ? <span className="whitespace-nowrap text-xs font-semibold text-blue-700">
            {r.holder.issued_to}<span className="ml-1 font-normal text-slate-400">· {fmt.title(r.holder.department)}</span></span>
        : <span className="text-xs text-slate-400">in store</span>,
      export: r => r.holder ? `${r.holder.issued_to} (${r.holder.department})` : 'in store' },
    { key: '_act', label: '', sortable: false, export: () => '',
      render: r => {
        // The label is the server's ISSUE_BANDS[].action, never a string typed
        // here. Bands 4 and 5 carry action: null and render nothing.
        if (!band.action) return null;
        if (band.band === 1)
          return (
            <Button size="sm" onClick={e => { e.stopPropagation(); onCreate(r.order_line_id); }}>
              <Plus size={13} /> {band.action}
            </Button>);
        if (band.band === 2)
          return (
            <Button size="sm" onClick={e => { e.stopPropagation(); onOpen(r.card_id); }}>
              <Printer size={13} /> {band.action}
            </Button>);
        return (
          <Button size="sm" variant="secondary" onClick={e => { e.stopPropagation(); onOpen(r.card_id); }}>
            <RefreshCw size={13} /> {band.action}
          </Button>);
      } },
  ];

  if (!rows.length) {
    return (
      <div className="ci-data-panel p-8 text-center">
        <CheckCircle2 size={28} className="mx-auto mb-2 text-emerald-500" />
        <p className="text-sm font-bold text-slate-800">The order book needs nothing from this module</p>
        <p className="mt-1 text-xs text-slate-500">
          Every live sales order has an approved shade card in printing's hands.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass rounded-[22px] border border-blue-200/60 bg-blue-50/50 p-4">
        <p className="flex items-center gap-2 text-sm font-extrabold text-blue-900">
          <Printer size={15} /> {fmt.num(actionable)} of {fmt.num(rows.length)} live order line{rows.length === 1 ? '' : 's'} need something
        </p>
        <p className="mt-1 text-xs font-medium text-blue-900/80">
          One row per sales order line still owed to a customer, grouped by what it needs
          from this module. Inside each group the most urgent job is first.
        </p>
      </div>

      {banded.map(b => b.rows.length > 0 && (
        <section key={b.band} className={`rounded-[22px] border p-3 ${b.cls}`}>
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-extrabold ${b.pill}`}>
              {b.rows.length}
            </span>
            <span className="text-sm font-extrabold text-slate-800">{b.label}</span>
            <ArrowRight size={12} className="text-slate-300" />
            <span className="text-xs font-medium text-slate-500">{b.hint}</span>
            {b.band === 1 && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-red-700">
                <AlertTriangle size={12} />
                {distinctProducts(b.rows)} card{distinctProducts(b.rows) === 1 ? '' : 's'} would clear all {b.rows.length}
              </span>)}
          </div>
          <DataTable
            exportName={`shade-cards-to-issue-${b.key}`}
            exportSubtitle={`${b.label} — ${b.hint}`}
            rows={b.rows} columns={columns(b)} getRowId={r => r.order_line_id}
            onRowClick={r => r.card_id ? onOpen(r.card_id) : onCreate(r.order_line_id)}
            empty="—"
          />
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Wire the new payload into ShadeCards.jsx**

`ToIssue` no longer reads the card rows, so it needs its own state, its own
fetch, and a create handler.

Add state beside the others (around line 78):

```jsx
  const [toIssue, setToIssue] = useState({ bands: [], rows: [] });
  const [createLineId, setCreateLineId] = useState(null);
```

Add the fetch to the existing `load()` Promise.all (around line 82):

```jsx
  const load = () => Promise.all([
    api.get('/shade-cards?all=1').then(rs => {
      setRows(rs);
      threadSummary('shade_card', rs.map(r => r.id)).then(setThreads).catch(() => {});
    }),
    api.get('/shade-cards/alerts').then(setAlerts),
    api.get('/shade-cards/to-issue').then(setToIssue),
  ]).then(() => setLoadError(false)).catch(() => setLoadError(true));
```

Add the count memo beside the other derived lists:

```jsx
  // Bands 4 and 5 need nothing from this screen — the count is work to do, not
  // rows on display.
  const toIssueCount = useMemo(
    () => toIssue.rows.filter(r => r.band <= 3).length, [toIssue]);
```

Change the To Issue tab entry to read the new count:

```jsx
          { key: 'to_issue', label: 'To Issue', icon: Printer, count: toIssueCount },
```

Change the render line:

```jsx
      {view === 'to_issue' && (
        <ToIssue rows={toIssue.rows} bands={toIssue.bands}
          onOpen={setDetailId} onCreate={setCreateLineId} />)}
```

Change the create-form render (around line 246) so both entry points share one
form. `creating` is the header button (no seed); `createLineId` is a To Issue
row (seeded):

```jsx
      {(creating || createLineId) && (
        <ShadeCardForm meta={meta} toast={toast}
          initialLineId={createLineId || ''}
          onClose={() => { setCreating(false); setCreateLineId(null); }}
          onCreated={async id => {
            setCreating(false); setCreateLineId(null);
            await load(); setDetailId(id);
          }} />)}
```

- [ ] **Step 4: Build**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && npm run build -w client
```

Expected: build succeeds.

- [ ] **Step 5: Check it in the running app**

Open Shade Cards → **To Issue**. Expected against the current local mirror:

- the tab count reads **99**
- the banner reads "99 of 99 live order lines need something"
- three bands: **No card yet 68**, **Ready to issue 15**, **Expired card 16**
- band counts sum to 99

Then check the two actions that are new:

1. On a **No card yet** row, press **Create card**. The form opens with the
   sales order line **already picked** and the read-only panel filled. Save it.
   The row moves to a different band and the To Issue count drops.
2. On a **Ready to issue** row, press **Issue**. The drawer opens on that card
   with Issue to Printing lit. Issue it. The row moves to **With printing
   already**, and the **On Floor** tab count goes up by one.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && git add client/src/pages/shade-cards/ToIssue.jsx client/src/pages/shade-cards/ShadeCardForm.jsx client/src/pages/ShadeCards.jsx && git commit -m "feat(shade): To Issue starts from the order book, not the card register

Starting from approved cards made the list structurally blind to the 68 live
order lines that have no shade card at all. One row per line, banded by what
it needs — create, issue, or renew — with press proximity kept as the sort
inside each band because no job cards exist yet to band by.

Create card on a band-1 row opens the existing form seeded with that order
line, so there is still exactly one create path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Full verification

**Files:** none — this task only runs checks.

- [ ] **Step 1: Confirm the working tree holds only this work**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && git status --short
```

Expected: the seven files from Tasks 1-7 are all **committed** (absent from the
output). Other sessions' modified files will still be listed — leave them alone.

- [ ] **Step 2: Verify in a detached worktree, not the shared tree**

`npm run verify` checks a schema baseline, and a parallel session's uncommitted
`db.js` edits in the shared tree fail it for reasons unrelated to this work.
Verify the commits in isolation:

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && git worktree add /tmp/ci-verify-shade-tabs HEAD --detach && cd /tmp/ci-verify-shade-tabs && npm install --silent && npm run verify
```

Expected: baseline check passes, `# fail 0` from the server suite, client build
succeeds.

- [ ] **Step 3: Remove the worktree**

```bash
cd ~/Documents/"CI ERP FInal"/ci-erp && git worktree remove /tmp/ci-verify-shade-tabs --force
```

- [ ] **Step 4: Final visual pass in the running app**

At a desktop breakpoint, logged in, on the real app — never a mock:

- Seven tabs read left to right: **Register 600 · To Send · With Customer ·
  To Issue 99 · On Floor · Reports · Retired**
- Four tiles read **Total cards 600 · In date 258 · Expired 306 · No date on
  record 36**, and `258 + 306 + 36 = 600`
- Every tab renders without a console error, including the empty ones
- Each empty tab explains its emptiness rather than saying "No rows"
- Clicking a tile filters the Register and rings that tile

Then narrow the browser below `lg`. The tab strip must scroll horizontally
rather than wrap or clip — `SubTabs` already handles this, so this is a check,
not a change.

- [ ] **Step 5: Report**

State plainly what passed and what did not. If any check failed, say so with the
output rather than reporting completion.

---

## Out of scope — do not build these

- Bulk dispatch or bulk issue. Single-row actions only.
- A compliance view of floor jobs running without a valid card.
- Renewing the 306 expired cards. This work makes the number visible; renewing
  them is plant work, one card at a time.
- Any change to the four statuses, the custody loop, `readiness-light.js`,
  `db.js`, or the drawer.
- Any migration. This plan adds no column and no table.
