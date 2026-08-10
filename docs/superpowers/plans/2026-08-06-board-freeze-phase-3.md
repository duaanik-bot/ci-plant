# Board freeze — Phase 3 (the warehouse screen) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

> **SESSION RULE.** This directory forbids `git commit`, `git push` and any deploy unless sanctioned out loud in the current session. Each task ends with a commit step because a complete plan needs one. **If commits are not sanctioned, skip every commit step and say so — do not do it quietly.**

**Goal:** Rebuild the RM warehouse screen so every number on it is unambiguous, and so the row, the KPI strip, the exports and the drill-down all say the same thing.

**Architecture:** Pure client change. No SQL, no server edit, no dependency on the back-fill. Decision 10 settled that **Frozen means board spoken for by a planned job** — `stockSplit(m).committed`, the figure the screen calls Committed today — so every number this phase renders already arrives on the row.

**Tech Stack:** React, Tailwind, the app's own `DataTable` / `KpiRow` / `useKpiFilter`. `node:test` for the guards.

---

## The rule that governs this whole phase

**Three tasks must land whole.** A half-renamed screen is worse than either end state, because two names for one figure is exactly the confusion this work exists to remove.

- **Task 1** — the row header, the KPI card, the filter-notice label and the export summary are **four separate literals for the same figure**. Shipping any subset is the half-renamed screen.
- **Task 2** — the `+N over` badge must leave the Frozen cell in the same change the Shortfall column arrives, or one number prints twice on one row.
- **Task 4** — the Health cell, the red tint on On Shelf, and the export's Short count are **three readers of one boolean**. Leave any behind and the shelf figure turns red for a reason no visible column explains.

## Before you start

**Re-pin the ref.** `origin/main` moved ~40 commits during this project and went stale under it three times.

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp && git fetch && git log --oneline -3 origin/main
```

Written against `65343f6`. If it has moved, re-read `client/src/pages/Inventory.jsx` before trusting a line number. **Match on quoted text, never on line number alone.**

**Work from** `~/.config/superpowers/worktrees/ci-erp/board-freeze` (contains Phases 1/2a/2b, uncommitted). Baseline: **1410 tests, 1410 pass, 0 fail**. Never `npm install`; never `npm run verify` (`--check` writes the baseline here).

**Visual verification is required for this phase** and is not optional — every task changes something a person reads. See the Verification section at the end before you start Task 1.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `client/src/pages/Inventory.jsx` | the RM Stock row, KPI strip, exports, leftover list | modify |
| `client/src/components/BoardHealth.jsx` | the Health vocabulary, its own module | create |
| `client/src/components/MasterHistory.jsx` | the Material 360 Demand tab | modify |
| `server/src/routes/inventory.js` | leftover list aggregates; demand-tab scalars | modify |
| `server/src/rm-screen-vocabulary.test.js` | guards for the one-name rule | create |

Two server touches, both **additive SELECTs on read paths** (Tasks 5 and 6). No write path is opened, and no stored quantity changes.

---

## Task 1: The stock trio, renamed whole

**Files:** `client/src/pages/Inventory.jsx`, `server/src/rm-screen-vocabulary.test.js` (create)

- [ ] **Step 1: Write the failing guard**

Create `server/src/rm-screen-vocabulary.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ONE FIGURE, ONE NAME, EVERYWHERE IT IS PRINTED.
//
// The RM warehouse screen prints each stock figure in FOUR places, each a
// separate string literal: the row's column header, the KPI card above it, the
// filter notice when that card is clicked, and the PDF/XLSX summary. They are
// not derived from one another. Renaming three of the four is not a smaller
// version of this change — it is the failure mode, because the screen then uses
// two words for one number, which is the confusion the rebuild exists to end.
//
// So the old words are banned outright. A guard that greps for their absence
// cannot be satisfied by a partial rename.
const inv = readFileSync(new URL('../../client/src/pages/Inventory.jsx', import.meta.url), 'utf8');
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the retired stock vocabulary appears nowhere on the RM screen', () => {
  const src = code(inv);
  for (const [dead, alive] of [
    ['Available (Packets / Sheets)', 'On Shelf'],
    ['Committed (Planned)', 'Frozen'],
    ['Net Stock', 'Free to Promise'],
    ['Gross stock', 'On shelf'],
    ['Committed demand', 'Frozen for jobs'],
  ]) {
    assert.ok(!src.includes(dead),
      `"${dead}" is still on the screen — it must read "${alive}". Renaming some of the four `
      + 'places a figure is printed (row header, KPI card, filter notice, export summary) and '
      + 'not the others is the half-renamed screen this guard exists to prevent.');
  }
  for (const alive of ['On Shelf', 'Frozen', 'Free to Promise']) {
    assert.ok(src.includes(alive), `the new column label "${alive}" is missing`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/rm-screen-vocabulary.test.js
```

Expected: FAIL on `"Available (Packets / Sheets)" is still on the screen`.

- [ ] **Step 3: Rename the three row columns**

In `client/src/pages/Inventory.jsx`, in the RM Stock `columns` array:

Find `label: 'Available (Packets / Sheets)'` and replace that label with `label: 'On Shelf'`. Leave the `key`, the render and the export exactly as they are — the key is a sort/filter identity, not a label, and changing it would silently break the KPI filter.

Find `label: 'Committed (Planned)'` and replace with `label: 'Frozen'`.

Then replace the whole `net` column:

```javascript
            { key: 'net', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'Net Stock', align: 'right',
              render: m => {
                const s = stockSplit(m);
                return <span className={`tabular-nums ${s.net > 0 ? 'font-semibold text-emerald-700' : 'text-slate-300'}`}>{fmt.num(Math.round(s.net))}</span>;
              },
              export: m => Math.round(stockSplit(m).net) },
```

with:

```javascript
            // Free to Promise is the one-glance answer to "can I give this board
            // to a new job?", so it renders in the same two units as every other
            // quantity on the row. It was the only one of the three in bare
            // sheets, sitting between two packets-over-sheets columns — a
            // storekeeper comparing them was converting one of the pair in his
            // head. Its export was a bare number for the same reason and moves
            // with it.
            { key: 'net', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'Free to Promise', align: 'right',
              render: m => <UnitCell m={m} sheets={stockSplit(m).net} tone="text-emerald-700" />,
              export: m => stockText(m, Math.round(stockSplit(m).net)) },
```

- [ ] **Step 4: Add the job count to Frozen**

The row already carries `committed_lines`. Inside the `committed` column's render, immediately after the `<UnitCell ... tone="text-amber-700" />` line, add:

```javascript
                    {+m.committed_lines > 0 && (
                      <div className="text-[10px] text-slate-400">{fmt.num(+m.committed_lines)} job{+m.committed_lines === 1 ? '' : 's'}</div>
                    )}
```

- [ ] **Step 5: Rename KPI cards 1–3**

Find the three KPI card labels and change them: `'Gross stock'` → `'On shelf'`, `'Committed demand'` → `'Frozen for jobs'`, `'Net stock'` → `'Free to promise'`. Change only the visible label strings; leave every `rmKpi.toggle('…')` key untouched.

- [ ] **Step 6: Rewrite `RM_KPI_LABEL`**

Replace:

```javascript
const RM_KPI_LABEL = {
  committed: 'boards planning has locked stock on',
  net: 'boards with net stock still free',
  pr: 'boards with a PR raised and no PO yet',
  incoming: 'boards with stock on an open PO',
  reorder: 'boards whose net stock is below the reorder line',
};
```

with:

```javascript
const RM_KPI_LABEL = {
  committed: 'boards with stock frozen for a job',
  net: 'boards with stock still free to promise',
  pr: 'boards with a PR raised and no PO yet',
  incoming: 'boards with stock on an open PO',
  reorder: 'boards whose free stock is below the buy line',
  // `over` was missing entirely, so the ONE fault card on this strip produced
  // the nameless notice "the selected KPI". Task 2 renames the card; the key it
  // filters on stays `over`, and it needs a sentence like every other.
  over: 'boards short of what their jobs need',
};
```

- [ ] **Step 7: Rename the export summary labels**

Search the file for the export summary rows carrying the words `Gross`, `Committed` and `Net`. Rename each to `On shelf`, `Frozen` and `Free to promise` respectively, matching the KPI card wording exactly.

- [ ] **Step 8: Run the guard and the suite**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/rm-screen-vocabulary.test.js
```

Expected: PASS.

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)" && npm run build -w client 2>&1 | tail -3
```

Expected: **1411 pass, 0 fail**, and the client build succeeds. The build is the real check here — a JSX typo does not fail a server test.

- [ ] **Step 9: Verify visually** — see the Verification section. Do not skip.

- [ ] **Step 10: Commit** *(skip if this session forbids commits)*

```bash
git add client/src/pages/Inventory.jsx server/src/rm-screen-vocabulary.test.js && git commit -m "feat(warehouse): on shelf, frozen, free to promise — one name each"
```

---

## Task 2: Shortfall column, and the badge moves out

**Files:** `client/src/pages/Inventory.jsx`, `server/src/rm-screen-vocabulary.test.js`

- [ ] **Step 1: Write the failing guard**

Append to `server/src/rm-screen-vocabulary.test.js`:

```javascript

// SHORTFALL GETS A COLUMN, AND STOPS BEING A BADGE.
//
// Today the red "+N over" span lives INSIDE the Frozen cell. The moment
// Shortfall becomes its own column, that span is the same number printed twice
// on one row — and the two would sit two columns apart, inviting the reader to
// add them. The badge must go in the same change the column arrives.
test('shortfall is a column, not a badge inside Frozen', () => {
  const src = code(inv);
  assert.ok(src.includes("label: 'Shortfall'"), 'the Shortfall column is missing');
  assert.ok(!/over<\/span>|\} over/.test(src),
    'the "+N over" badge is still rendered — with a Shortfall column present it prints the '
    + 'same figure twice on one row, two columns apart');
  assert.ok(!src.includes('short</span>'),
    'the red "+N short" suffix is still on the Frozen KPI card sub-line — same duplication');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/rm-screen-vocabulary.test.js
```

Expected: FAIL on `the Shortfall column is missing`.

- [ ] **Step 3: Strip the badge out of Frozen**

In the `committed` column's render, delete the badge block:

```javascript
                    {/* Locked beyond the shelf is a fault to reconcile, not
                        stock — shown beside the figure, never folded into it. */}
                    {s.over_committed > 0 && (
                      <span className="text-[11px] font-semibold text-red-500">+{fmt.num(Math.round(s.over_committed))} over</span>
                    )}
```

- [ ] **Step 4: Add the Shortfall column**

Immediately **after** the `net` (Free to Promise) column and **before** `pr_qty`, insert:

```javascript
            // Shortfall sits OUTSIDE the On Shelf = Frozen + Free to Promise
            // trio, deliberately. Those three divide up board that EXISTS.
            // This is demand with no board behind it — the only figure on the
            // row that may exceed the shelf, and the only one that is not stock.
            //
            // It replaces the red "+N over" badge that used to live inside the
            // Frozen cell. That badge was the only thing on a row saying "this
            // board is the bottleneck", and once over-commitment stops happening
            // on the planning path it would read zero — leaving a board at Free
            // to Promise 0 WITH a PR raised looking identical to one with
            // nothing behind it. On Order sits next to it for exactly that
            // reason: "short 7,893 · 12,240 on order" is one sentence.
            { key: 'over', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'Shortfall', align: 'right',
              render: m => {
                const s = stockSplit(m);
                return s.over_committed > 0
                  ? <UnitCell m={m} sheets={s.over_committed} tone="text-red-600" />
                  : <span className="text-xs text-slate-300">—</span>;
              },
              export: m => stockText(m, Math.round(stockSplit(m).over_committed)) },
```

- [ ] **Step 5: Rename the fault card and drop its duplicate suffix**

Find the KPI card whose `onClick` is `rmKpi.toggle('over')` and change its label from `'Over commit'` to `'To arrange'`. Keep the same slot, the same `ShieldAlert` icon and the same open/answered sub-line.

Then find the Frozen card's sub-line and delete the red `+{n} short` suffix — the Shortfall card now carries that figure.

- [ ] **Step 6: Run the guard, the suite and the build**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/rm-screen-vocabulary.test.js
```

Expected: PASS, 2 tests.

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)" && npm run build -w client 2>&1 | tail -3
```

Expected: **1411 pass, 0 fail**, build succeeds.

- [ ] **Step 7: Verify visually** — confirm the number moved rather than being duplicated.

- [ ] **Step 8: Commit** *(skip if forbidden)*

```bash
git add client/src/pages/Inventory.jsx server/src/rm-screen-vocabulary.test.js && git commit -m "feat(warehouse): shortfall gets its own column beside what answers it"
```

---

## Task 3: On Order merge, Buy Line, drop Total Weight, six-card strip

**Files:** `client/src/pages/Inventory.jsx`

- [ ] **Step 1: Merge PR Raised and Incoming into On Order**

Replace both the `pr_qty` and `incoming` columns with one:

```javascript
            // PO over PR in one cell. They answer one question — "is anything
            // coming?" — and asking it in two columns cost width the row needs
            // for Shortfall. The export keeps them SEPARATE: a workbook is
            // filtered and pivoted, and the summary block already emits distinct
            // PR and PO totals that a merged column would contradict.
            { key: 'on_order', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'On Order', align: 'right',
              sortKey: m => (+m.incoming || 0) + (+m.pr_qty || 0),
              render: m => {
                const po = +m.incoming || 0, pr = +m.pr_qty || 0;
                if (!po && !pr) return <span className="text-xs text-slate-300">—</span>;
                return (
                  <div>
                    {po > 0 && <UnitCell m={m} sheets={po} tone="text-sky-700" />}
                    {pr > 0 && <div className="text-[10px] font-semibold text-violet-700">{pktText(packetsOf(m, pr))} PKT on PR</div>}
                  </div>
                );
              } },
```

Then add an `exportColumns` prop to this DataTable keeping the two figures apart in the workbook:

```javascript
          exportColumns={[
            { key: 'pr_qty', label: 'PR Raised', value: m => stockText(m, Math.round(+m.pr_qty || 0)) },
            { key: 'incoming', label: 'Incoming (PO)', value: m => stockText(m, Math.round(+m.incoming || 0)) },
          ]}
```

`DataTable` supports this — `exportColumns` is a documented prop (`client/src/components/ui.jsx`, `columns: exportColumns || columns`), and its own comment describes precisely this case: a column merged so the screen fits, kept apart in the PDF and the workbook. Verified, not assumed.

- [ ] **Step 2: Buy Line**

Replace the `reorder_level` column:

```javascript
            { key: 'reorder_level', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Reorder Level', align: 'right', render: m => fmt.num(m.reorder_level) },
```

with:

```javascript
            // Packets over sheets, because the number it is compared against —
            // Free to Promise — is now in those units. Bare sheets beside a
            // packets figure is the conversion this rebuild removes.
            { key: 'reorder_level', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Buy Line', align: 'right',
              render: m => +m.reorder_level > 0
                ? <UnitCell m={m} sheets={+m.reorder_level} tone="text-slate-600" />
                : <span className="text-xs text-slate-300">—</span>,
              export: m => stockText(m, Math.round(+m.reorder_level || 0)) },
```

- [ ] **Step 3: Remove Total Weight**

Delete the whole `weight` column object. **Keep** the kg summary row and the tonnage KPI headlines — the figure is not being retired, only the per-row column, whose two inputs (`On Shelf` and `Kg / Sheet`) are already columns two apart.

- [ ] **Step 4: Merge KPI cards 4 and 5**

Replace the two cards toggling `'pr'` and `'incoming'` with one card labelled `'On order'`, value = PO + PR total, sub-line `X on PO · Y on PR`. Give it a new predicate key:

```javascript
            on_order: m => (+m.pr_qty || 0) > 0 || (+m.incoming || 0) > 0,
```

added to the predicate map, and an entry in `RM_KPI_LABEL`:

```javascript
  on_order: 'boards with board on a PR or a PO',
```

Then set the strip to six columns. **Check how `KpiRow` takes its column count before editing** — if it uses a literal Tailwind class per count, use the literal, never an interpolated class name.

- [ ] **Step 5: Delete the dead reorder check**

In the position reducer, find `if (m.reorderHit) a.reorderBoards++;`. Nothing in the tree ever sets `reorderHit`; it survives only because the total is recomputed below. Delete the line.

- [ ] **Step 6: Verify**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)" && npm run build -w client 2>&1 | tail -3
```

Expected: **1411 pass, 0 fail**, build succeeds. Then verify visually, including at tablet width.

- [ ] **Step 7: Commit** *(skip if forbidden)*

```bash
git add client/src/pages/Inventory.jsx && git commit -m "feat(warehouse): one On Order cell, a Buy Line in packets, six cards"
```

---

## Task 4: Health, as its own vocabulary

**Files:** `client/src/components/BoardHealth.jsx` (create), `client/src/pages/Inventory.jsx`

- [ ] **Step 1: Create the module**

```javascript
// What this board master needs from a person — the RM screen's own verdict.
//
// DELIBERATELY NOT BoardStatus.jsx. That module answers "can this job run
// today?" for a JOB. This answers "does this BOARD need someone to do
// something?" One word carrying two meanings across two screens is the exact
// failure BoardStatus.jsx was extracted to prevent, so this shares its SHAPE
// and none of its STRINGS.
//
// A FIRST-MATCH LADDER, not four exclusive states. They nest: a board with no
// free stock is also below any buy line worth setting. The order IS the
// semantics — it answers "what would a person do about this board first?"
//
//   RECOUNT    the book and the shelf disagree. Nothing else can be trusted
//              until someone counts, so it outranks everything.
//   FROZEN OUT every sheet is spoken for. Not a fault — the plant is working —
//              but nothing here can be promised. Requires Frozen > 0, so an
//              EMPTY board is never called frozen out.
//   BELOW LINE free stock is under the buy line. A buying decision, not a
//              floor one. Only when a buy line is actually set.
//   OK
export const HEALTH = {
  recount:   { label: 'RECOUNT',    tone: 'text-amber-600',   hint: 'The book and the shelf disagree — count this board' },
  frozen_out:{ label: 'FROZEN OUT', tone: 'text-slate-500',   hint: 'Every sheet is frozen for a job — nothing free to promise' },
  below_line:{ label: 'BELOW LINE', tone: 'text-red-600',     hint: 'Free stock is under the buy line' },
  ok:        { label: 'OK',         tone: 'text-emerald-600', hint: 'Free stock is above the buy line' },
};

export function healthOf({ openWriteOn = 0, frozen = 0, free = 0, buyLine = 0 } = {}) {
  if (+openWriteOn > 0) return 'recount';
  if (+free <= 0 && +frozen > 0) return 'frozen_out';
  if (+buyLine > 0 && +free < +buyLine) return 'below_line';
  return 'ok';
}

export function HealthBadge({ state }) {
  const h = HEALTH[state] || HEALTH.ok;
  return <span className={`text-xs font-semibold ${h.tone}`} title={h.hint}>{h.label}</span>;
}
```

- [ ] **Step 2: Use it, and retire all three readers of `short` together**

Replace the `short` column with:

```javascript
            { key: 'short', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'Health', card: 'status',
              render: m => {
                const s = stockSplit(m);
                return <HealthBadge state={healthOf({
                  openWriteOn: m.open_writeon_qty, frozen: s.committed, free: s.net, buyLine: m.reorder_level,
                })} />;
              },
              export: m => {
                const s = stockSplit(m);
                return HEALTH[healthOf({
                  openWriteOn: m.open_writeon_qty, frozen: s.committed, free: s.net, buyLine: m.reorder_level,
                })].label;
              } },
```

Import `HEALTH`, `healthOf`, `HealthBadge` from `'../components/BoardHealth.jsx'`.

**In the same change**, find the `On Shelf` column's `<StockCell m={m} sheets={m.available} short={m.short} />` and drop the `short` prop — the red tint on the shelf figure was driven by the same boolean and would otherwise turn red for a reason no visible column explains. Then find the export summary's `Short` count and replace it with a count of rows whose health is not `ok`.

`m.short` stays on the payload — this phase stops rendering it, it does not remove it.

- [ ] **Step 3: Verify**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)" && npm run build -w client 2>&1 | tail -3
```

Then verify visually on phone width too — `card: 'status'` keeps Health out of the Details fold.

- [ ] **Step 4: Commit** *(skip if forbidden)*

```bash
git add client/src/components/BoardHealth.jsx client/src/pages/Inventory.jsx && git commit -m "feat(warehouse): health says what the board needs from a person"
```

---

## Task 5: Leftover list parity

A banked offcut reads **100% free by construction** today — `GET /inventory/leftovers` never goes through `enrichStockRow`, so a strip a job has already frozen looks available to promise. That is the double-promise the freeze exists to stop.

**Files:** `server/src/routes/inventory.js`, `client/src/pages/Inventory.jsx`

- [ ] **Step 1: Add the aggregates server-side**

In `GET /inventory/leftovers`, route the rows through `enrichStockRow` exactly as `/inventory/stock` does, so each leftover master carries `committed_qty`, `pr_qty` and `incoming`. **Additive SELECTs only — do not open a write path.**

- [ ] **Step 2: Add the three columns client-side**

In the leftover list's columns, rename its own `'Available (Packets / Sheets)'` to `'On Shelf'` and add `Frozen`, `Free to Promise` and `Health` using the **same** helpers and the same `BoardHealth` module. Do not write a second rendering of these figures.

- [ ] **Step 3: Verify**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)" && npm run build -w client 2>&1 | tail -3
```

- [ ] **Step 4: Commit** *(skip if forbidden)*

```bash
git add server/src/routes/inventory.js client/src/pages/Inventory.jsx && git commit -m "feat(warehouse): leftover strips show what is frozen on them"
```

---

## Task 6: Material 360 Demand tab

`GET /inventory/demand/:materialId` computes its own scalars, and its `shortfall` is total nominal demand minus **gross** shelf — a different figure that can print a confident "Shortfall 0" one click from a row reading "Shortfall 3,000". The endpoint's own comment says the aggregate and the breakdown must reconcile exactly.

**Files:** `server/src/routes/inventory.js`, `client/src/components/MasterHistory.jsx`

- [ ] **Step 1: Re-source the scalars**

Compute the drawer's three figures from the **same** split the row uses, so `Frozen + Shortfall` reconciles with the row it was opened from.

- [ ] **Step 2: Rename in the drawer**

`Available` → `On Shelf`, `Committed` → `Frozen`, and keep `Shortfall`. Update the drawer's PDF/XLSX meta line in the same change. **Keep the per-line table** — it is the only place the jobs behind the number are named. Flag each line as frozen or not.

- [ ] **Step 3: Verify**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)" && npm run build -w client 2>&1 | tail -3
```

Then open a row with a non-zero Shortfall and confirm the drawer agrees with it.

- [ ] **Step 4: Commit** *(skip if forbidden)*

```bash
git add server/src/routes/inventory.js client/src/components/MasterHistory.jsx && git commit -m "feat(warehouse): the 360 drawer quotes the row it was opened from"
```

---

## Verification — required, and there is a known trap

Every task in this phase changes something a person reads, so green tests are not sufficient evidence.

**The trap:** this repo has a documented failure where the browser preview pane serves **stale screenshot frames** and can report `innerWidth 0`, so the app renders its phone cards and the desktop table appears not to exist at all. Before trusting any screenshot, confirm the viewport:

```javascript
// via the preview's javascript tool
({ w: window.innerWidth, h: window.innerHeight })
```

If `w` is 0, the pane is lying — resize it and re-check before concluding anything about the layout.

**Also:** another session's dev server may already be running in this folder. Start your own preview rather than assuming you are looking at your build.

For each task: load the RM Stock tab, confirm the renamed columns read as intended, click each KPI card and confirm the filter notice names it in words, and check tablet-landscape width for the row fitting. For Task 4, check phone width — Health must not fall into the Details fold.

## Done criteria

- [ ] `npm test -w server` → **1411 pass, 0 fail**; `npm run build -w client` succeeds
- [ ] The retired words appear nowhere: `Available (Packets / Sheets)`, `Committed (Planned)`, `Net Stock`, `Gross stock`, `Committed demand`
- [ ] Every KPI card produces a **named** filter notice — including the fault card
- [ ] `On Shelf = Frozen + Free to Promise` reads true on every row
- [ ] Shortfall appears once per row, never twice
- [ ] The 360 drawer agrees with the row it was opened from
- [ ] No stored quantity changed — the two server touches are additive read-path SELECTs

## Deferred, and to be said out loud when this ships

- **`suggestedQty`** (decision 11) — the PR quantity still comes from the old demand definition and can seed a blank line on a fully-frozen board. Deferred because a partial fix returns the same wrong answer with every test green, and it feeds a purchase document.
- **The dashboard** runs a demand definition that omits `in_production`, ignores `spec_override` and compares against gross stock. From day one it will call a board fine while the RM row says it is short.
- **The PR form's StockStrip** will still say "Reserved" and "Suggested" one click from a row that has stopped using either word.
