# Print-Planning Completion System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give printed job cards a visible life on the Print Planning board — turn green when printed, list them in a per-machine Completed tab, let planners click any card into a chooser (view job card / edit the queue entry), and reverse a printed run back to Triage.

**Architecture:** No schema changes. Server extends `GET /print-planning` with a `completed` array, adds `POST /print-planning/reverse` (un-completes the printing stage + returns the card to Triage, gang-aware) and `PUT /print-planning/:jobCardId` (consolidated queue-entry edit). Both new guards are pure functions in `helpers.js`, unit-tested with `node:test` like the existing `rollbackBlockers`. The drag-assign transaction body is extracted into a shared `assignPressTx` helper reused by the edit route. The client (`PrintPlanning.jsx`) gains a Board/Completed tab switch, a solid-green `PrintedCard`, a click chooser modal, and an edit form modal.

**Tech Stack:** Node/Express + `pg` (embedded Postgres :5439), `node:test` for unit tests, React + Vite + Tailwind, `lucide-react` icons, native HTML5 drag & drop.

> **PROJECT RULE — NO GIT COMMITS.** This repo (`ci-erp`) must never be committed to. Every "Checkpoint" step below runs tests / manual verification only. Do **not** run `git commit` / `git add`. All work stays in the working tree.

> **Verify pattern:** the live app may run as a plain `node` process that does not hot-reload. After server edits, verify by booting a throwaway server on a spare port (e.g. `PORT=4999`) that reuses the live embedded PG on :5439, or restart the app. Client (Vite) hot-reloads normally.

---

## File Structure

- `server/src/helpers.js` — **modify**: add two pure guard functions (`printReverseBlockers`, `printQueueEditBlock`).
- `server/src/print-planning.test.js` — **create**: `node:test` unit tests for the two guards.
- `server/src/routes/production.js` — **modify**: import the guards; extract `assignPressTx`; extend `GET /print-planning`; add `POST /print-planning/reverse` and `PUT /print-planning/:jobCardId`.
- `client/src/pages/PrintPlanning.jsx` — **modify**: tabs, `PrintedCard`, `CardChooser`, `EditQueueForm`, board green window, wiring.

---

## Task 1: Pure guard helpers + unit tests

**Files:**
- Modify: `server/src/helpers.js` (append near `rollbackBlockers`, around line 657)
- Test: `server/src/print-planning.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/src/print-planning.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printReverseBlockers, printQueueEditBlock } from './helpers.js';

// ── printReverseBlockers ──────────────────────────────────────────────
test('printReverse: completed run with only pending downstream is clean', () => {
  assert.deepEqual(
    printReverseBlockers({
      printingStatus: 'completed', jcStatus: 'in_progress',
      downstreamStages: [{ stage: 'coating', status: 'pending' }],
    }),
    []);
});
test('printReverse: a non-completed printing stage cannot be reversed', () => {
  const b = printReverseBlockers({ printingStatus: 'in_progress', jcStatus: 'in_progress' });
  assert.match(b[0], /completed/i);
});
test('printReverse: a started downstream stage blocks and names it', () => {
  const b = printReverseBlockers({
    printingStatus: 'completed', jcStatus: 'in_progress',
    downstreamStages: [{ stage: 'die_cutting', status: 'in_progress' }],
  });
  assert.match(b.join(' '), /Die cutting is already in progress/);
});
test('printReverse: a closed/split job is blocked', () => {
  assert.match(printReverseBlockers({ printingStatus: 'completed', jcStatus: 'closed' }).join(' '), /closed/i);
});

// ── printQueueEditBlock ───────────────────────────────────────────────
test('printQueueEdit: a pending (queued) run is editable', () => {
  assert.equal(printQueueEditBlock({ printingStatus: 'pending', jcStatus: 'in_progress' }), null);
});
test('printQueueEdit: an in-progress run blocks with a reverse hint', () => {
  assert.match(printQueueEditBlock({ printingStatus: 'in_progress', jcStatus: 'in_progress' }), /Reverse this run/i);
});
test('printQueueEdit: a completed run blocks with a reverse hint', () => {
  assert.match(printQueueEditBlock({ printingStatus: 'completed', jcStatus: 'in_progress' }), /Reverse this run/i);
});
test('printQueueEdit: a finalised card blocks', () => {
  assert.match(printQueueEditBlock({ printingStatus: 'pending', jcStatus: 'open', finalised: true }), /finalised/i);
});
test('printQueueEdit: a closed card blocks', () => {
  assert.match(printQueueEditBlock({ printingStatus: 'pending', jcStatus: 'closed' }), /Closed/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `printReverseBlockers is not a function` / `printQueueEditBlock is not a function` (the other existing tests still pass).

- [ ] **Step 3: Add the two guard functions**

In `server/src/helpers.js`, immediately after the `rollbackBlockers` function (after its closing `}` near line 657), add:

```js
// Guard for reversing a printed (completed) printing run back to Triage. Pure —
// mirrors rollbackBlockers so it is unit-testable without a DB. Returns a list
// of human blocker strings; an empty list means the reverse is safe.
export function printReverseBlockers({ printingStatus, jcStatus, downstreamStages = [] } = {}) {
  const cap = s => (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
  const out = [];
  if (printingStatus !== 'completed') out.push('Only a printed (completed) run can be reversed');
  if (['closed', 'split'].includes(jcStatus))
    out.push('This job is already closed/split — correct it via FG/job correction instead');
  for (const s of downstreamStages.filter(x => x.status && x.status !== 'pending')) {
    out.push(`Cannot reverse: ${cap((s.stage || '').replace(/_/g, ' '))} is already ${(s.status || '').replace(/_/g, ' ')}`);
  }
  return out;
}

// Guard for editing a print-planning queue entry in place. Pure. Returns an
// error string when editing is not allowed, else null. Editing is only safe
// while the printing stage has not started and the card is open + not finalised
// — the same rule PUT /job-cards enforces.
export function printQueueEditBlock({ printingStatus, jcStatus, finalised = false } = {}) {
  if (jcStatus === 'closed') return 'Closed job cards cannot be edited';
  if (finalised) return 'This job card is finalised. Reopen it before editing.';
  if (['in_progress', 'hold', 'completed'].includes(printingStatus))
    return 'Reverse this run to edit — printing has already started.';
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npm test`
Expected: PASS — all new tests green, existing tests still green.

- [ ] **Step 5: Checkpoint (no commit)**

Confirm `npm test` is fully green. Do not commit.

---

## Task 2: Extract `assignPressTx` (no behavior change)

**Files:**
- Modify: `server/src/routes/production.js:328-377` (the existing `POST /print-planning/assign`)

- [ ] **Step 1: Add the shared helper above the print-planning routes**

In `server/src/routes/production.js`, directly above the `// ── Print planning (kanban) ──` comment (around line 281), insert:

```js
// Core of a print-planning move — shared by the drag-assign route and the
// consolidated queue-edit route. Carries a whole gang to the press (or back to
// triage), hands the run to that press's crew (its first active operator), and
// re-sequences the destination lane top-to-bottom. Runs inside a caller tx.
async function assignPressTx(qc, oc, { job_card_id, machine_id, ordered_ids, user }) {
  const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [job_card_id]);
  if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
  const printing = await oc(`SELECT status FROM job_stages WHERE job_card_id=$1 AND stage='printing'`, [job_card_id]);
  if (printing?.status === 'completed')
    throw Object.assign(new Error('Printing already completed for this job'), { status: 409 });
  if (machine_id) {
    const m = await oc('SELECT * FROM machines WHERE id=$1', [machine_id]);
    if (!m || m.type !== 'printing') throw Object.assign(new Error('Not a printing machine'), { status: 400 });
  }
  const gangJcIds = jc.gang_run_id
    ? (await qc(`
        SELECT jc2.id, jc2.order_line_id FROM job_cards jc2
        JOIN job_stages js2 ON js2.job_card_id = jc2.id AND js2.stage='printing'
        WHERE jc2.gang_run_id=$1 AND jc2.status IN ('open','in_progress') AND js2.status != 'completed'`,
        [jc.gang_run_id]))
    : [{ id: jc.id, order_line_id: jc.order_line_id }];
  const crew = machine_id
    ? await oc(`
        SELECT e.name FROM machine_operators mo JOIN employees e ON e.id=mo.employee_id
        WHERE mo.machine_id=$1 AND e.active=1 ORDER BY e.name LIMIT 1`, [machine_id])
    : null;
  for (const g of gangJcIds) {
    await qc('UPDATE job_cards SET machine_id=$1 WHERE id=$2', [machine_id || null, g.id]);
    if (g.order_line_id) await qc('UPDATE order_lines SET machine_id=$1 WHERE id=$2', [machine_id || null, g.order_line_id]);
    else await qc('UPDATE order_lines SET machine_id=$1 WHERE gang_run_id=$2', [machine_id || null, jc.gang_run_id]);
    await qc(`UPDATE job_stages SET machine_id=$1, operator=$2
              WHERE job_card_id=$3 AND stage='printing' AND status != 'completed'`,
      [machine_id || null, crew?.name || null, g.id]);
  }
  for (let i = 0; i < (ordered_ids || []).length; i++) {
    await qc('UPDATE job_cards SET queue_pos=$1 WHERE id=$2', [i + 1, ordered_ids[i]]);
  }
  if (!ordered_ids?.length) await qc('UPDATE job_cards SET queue_pos=NULL WHERE id=$1', [job_card_id]);
  await audit('job_card', job_card_id, 'print_plan',
    machine_id ? `assigned press ${machine_id}` : 'moved to triage', qc, user);
  return jc;
}
```

- [ ] **Step 2: Replace the assign route body to call the helper**

Replace the existing `r.post('/print-planning/assign', ...)` handler (lines ~328-377) with:

```js
// Persist a drag: which press lane, and the full order of that lane.
r.post('/print-planning/assign', canPlan, async (req, res, next) => {
  try {
    const { job_card_id, machine_id, ordered_ids } = req.body;
    await tx(async (qc, oc) => {
      await assignPressTx(qc, oc, { job_card_id, machine_id, ordered_ids, user: req.user.name });
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
```

- [ ] **Step 3: Verify existing behavior unchanged**

Run: `cd server && npm test`
Expected: PASS (no test targets this DB route, but nothing should break).

Then boot a spare-port server and smoke-test the drag path:
Run: `cd server && PORT=4999 node src/index.js` (in a background shell), then in another shell:
`curl -s localhost:4999/api/print-planning | head -c 200`
Expected: JSON with `cards` and `presses` keys (auth may be required — if so, verify via the running app UI drag instead). Stop the spare server afterwards.

- [ ] **Step 4: Checkpoint (no commit)**

Board drag-to-press still works in the app. Do not commit.

---

## Task 3: Extend `GET /print-planning` with a `completed` array

**Files:**
- Modify: `server/src/routes/production.js` (the `GET /print-planning` handler, ~line 283-325)

- [ ] **Step 1: Add the completed query and include it in the response**

In the `GET /print-planning` handler, after the `presses` query and before `res.json(...)`, insert the `completed` query, then change the response line. Replace:

```js
    res.json({ cards, presses });
```

with:

```js
    // Printed runs — printing stage completed within the last 60 days. Grouped
    // per press on the client (by the press it actually printed on). Feeds both
    // the board's end-of-day green cards and the Completed tab.
    const completed = await q(`
      SELECT jc.id, jc.jc_number, jc.order_line_id, jc.sheets_issued, jc.qty_planned,
             COALESCE(js.machine_id, jc.machine_id) AS machine_id,
             js.status AS printing_status, js.operator AS printing_operator,
             js.qty_out AS printed_sheets, js.completed_at,
             p.name AS product_name, p.code AS product_code, p.colors, p.coating,
             c.name AS customer_name, o.po_number, o.delivery_date,
             COALESCE(ol.gang_run_id, jc.gang_run_id) AS gang_run_id, gg.gang_number
      FROM job_cards jc
      JOIN job_stages js ON js.job_card_id = jc.id AND js.stage='printing'
      JOIN products p ON p.id = jc.product_id
      LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
      LEFT JOIN LATERAL (
        SELECT ol2.* FROM order_lines ol2
        WHERE ol2.gang_run_id=jc.gang_run_id ORDER BY ol2.id LIMIT 1
      ) gol ON jc.order_line_id IS NULL
      LEFT JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN gang_runs gg ON gg.id = COALESCE(ol.gang_run_id, jc.gang_run_id)
      WHERE js.status='completed' AND js.completed_at > now() - interval '60 days'
      ORDER BY COALESCE(js.machine_id, jc.machine_id) NULLS LAST, js.completed_at DESC, jc.id`);
    res.json({ cards, presses, completed });
```

- [ ] **Step 2: Verify the response shape**

Restart the app (or boot spare-port `PORT=4999 node src/index.js`). In the running app, open Print Planning, then in the browser devtools Network tab inspect the `/api/print-planning` response.
Expected: it now has three keys — `cards`, `presses`, `completed`. `completed` is an array (may be empty if no run has been printed in 60 days).

- [ ] **Step 3: Checkpoint (no commit)**

`completed` present in the API payload. Do not commit.

---

## Task 4: `POST /print-planning/reverse`

**Files:**
- Modify: `server/src/routes/production.js:9` (import guards); add the new route after `POST /print-planning/assign`.

- [ ] **Step 1: Import the guards**

On `server/src/routes/production.js` line 9, add `printReverseBlockers` and `printQueueEditBlock` to the existing import from `'../helpers.js'`. The line currently is:

```js
import { audit, setLineStatus, consumeFifo, fgReceipt, createJobCardForLine, splitGangParentJob, findOrCreateLeftoverMaster, finaliseBlock, reopenBlock } from '../helpers.js';
```

Change it to:

```js
import { audit, setLineStatus, consumeFifo, fgReceipt, createJobCardForLine, splitGangParentJob, findOrCreateLeftoverMaster, finaliseBlock, reopenBlock, printReverseBlockers, printQueueEditBlock } from '../helpers.js';
```

- [ ] **Step 2: Add the reverse route**

Immediately after the `POST /print-planning/assign` handler, add:

```js
// Reverse a printed run: un-complete the printing stage and send the card back
// to Triage, ready to edit. Gang-aware — the whole gang reverses together.
// Guarded by printReverseBlockers (downstream stages must be untouched).
r.post('/print-planning/reverse', canPlan, async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to reverse a printed run' });
    await tx(async (qc, oc) => {
      const st = await oc(`
        SELECT js.*, jc.status AS jc_status, jc.gang_run_id, jc.product_id, jc.jc_number
        FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id
        WHERE js.job_card_id=$1 AND js.stage='printing' FOR UPDATE OF js`, [req.body.job_card_id]);
      if (!st) throw Object.assign(new Error('Printing stage not found'), { status: 404 });

      const downstream = await qc(`
        SELECT stage, status FROM job_stages
        WHERE job_card_id=$1 AND seq>$2 AND status != 'pending'`, [st.job_card_id, st.seq]);
      const blockers = printReverseBlockers({
        printingStatus: st.status, jcStatus: st.jc_status, downstreamStages: downstream,
      });
      if (blockers.length) { const e = new Error(blockers[0]); e.status = 409; e.blockers = blockers; throw e; }

      // Whole gang reverses together — same member resolution as assign.
      const members = st.gang_run_id
        ? (await qc(`
            SELECT jc2.id, jc2.order_line_id, jc2.product_id, js2.id AS stage_id, js2.qty_scrap
            FROM job_cards jc2
            JOIN job_stages js2 ON js2.job_card_id=jc2.id AND js2.stage='printing'
            WHERE jc2.gang_run_id=$1 AND js2.status='completed'`, [st.gang_run_id]))
        : [{ id: st.job_card_id, order_line_id: null, product_id: st.product_id, stage_id: st.id, qty_scrap: st.qty_scrap }];

      for (const m of members) {
        // Mirror the generic stage-reverse stock hygiene: return spoiled sheets.
        if ((m.qty_scrap || 0) > 0) {
          await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
                    VALUES ($1,'wastage_reversal',$2,'job_stage',$3,$4)`,
            [m.product_id, m.qty_scrap, m.stage_id, `printing reversed — ${reason}`]);
        }
        await qc(`UPDATE job_stages SET status='pending', qty_out=NULL, qty_scrap=0,
                  scrap_reason=NULL, completed_at=NULL, operator=NULL, machine_id=NULL
                  WHERE job_card_id=$1 AND stage='printing'`, [m.id]);
        await qc('UPDATE job_cards SET machine_id=NULL, queue_pos=NULL WHERE id=$1', [m.id]);
        const olId = m.order_line_id ?? (await oc('SELECT order_line_id FROM job_cards WHERE id=$1', [m.id]))?.order_line_id;
        if (olId) await qc('UPDATE order_lines SET machine_id=NULL WHERE id=$1', [olId]);
        await audit('job_card', m.id, 'print_reverse', `Printed run reversed to Triage — ${reason}`, qc, req.user.name);
      }
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
```

- [ ] **Step 3: Verify guard wiring with existing tests**

Run: `cd server && npm test`
Expected: PASS (Task 1 tests cover the guard logic this route depends on).

- [ ] **Step 4: Manual smoke test**

In the running app: print a run (complete its printing stage on the Floor), confirm it appears in `completed` (Network payload). Then `curl -s -X POST localhost:PORT/api/print-planning/reverse -H 'Content-Type: application/json' -d '{"job_card_id":<id>,"reason":"test"}'` **or** use the UI (Task 8). Confirm the printing stage returns to `pending` and `machine_id`/`queue_pos` are null (card back in Triage). Try reversing a run whose next stage has started → expect a 409 with the blocker message.

- [ ] **Step 5: Checkpoint (no commit)**

Reverse works and is guarded. Do not commit.

---

## Task 5: `PUT /print-planning/:jobCardId`

**Files:**
- Modify: `server/src/routes/production.js` (add route after the reverse route)

- [ ] **Step 1: Add the consolidated edit route**

After the `POST /print-planning/reverse` handler, add:

```js
// Consolidated queue-entry edit — quantity/sheets (job_cards), operator
// (printing stage), planned_date (order line), delivery_date (whole order), and
// press + queue order (via assignPressTx). Only while printing has not started.
// Pass machine_id + ordered_ids together when changing the press so the new
// lane order is set; omit both to leave placement untouched.
r.put('/print-planning/:jobCardId', canPlan, async (req, res, next) => {
  try {
    const id = +req.params.jobCardId;
    const { qty_planned, sheets_issued, operator, planned_date, delivery_date, machine_id, ordered_ids } = req.body;
    await tx(async (qc, oc) => {
      const jc = await oc(`
        SELECT jc.*, js.status AS printing_status
        FROM job_cards jc
        LEFT JOIN job_stages js ON js.job_card_id=jc.id AND js.stage='printing'
        WHERE jc.id=$1 FOR UPDATE OF jc`, [id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      const block = printQueueEditBlock({
        printingStatus: jc.printing_status, jcStatus: jc.status, finalised: !!jc.finalised_at,
      });
      if (block) throw Object.assign(new Error(block), { status: 409 });

      if (qty_planned !== undefined) {
        const n = Number(qty_planned);
        if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error('Planned quantity must be greater than zero'), { status: 400 });
        await qc('UPDATE job_cards SET qty_planned=$1 WHERE id=$2', [Math.round(n), id]);
      }
      if (sheets_issued !== undefined) {
        const n = Number(sheets_issued);
        if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('Issued sheets cannot be negative'), { status: 400 });
        await qc('UPDATE job_cards SET sheets_issued=$1 WHERE id=$2', [Math.round(n), id]);
      }
      if (operator !== undefined)
        await qc(`UPDATE job_stages SET operator=$1 WHERE job_card_id=$2 AND stage='printing'`, [operator || null, id]);
      if (planned_date !== undefined && jc.order_line_id)
        await qc('UPDATE order_lines SET planned_date=$1 WHERE id=$2', [planned_date || null, jc.order_line_id]);
      if (delivery_date !== undefined && jc.order_line_id) {
        const ol = await oc('SELECT order_id FROM order_lines WHERE id=$1', [jc.order_line_id]);
        if (ol?.order_id) await qc('UPDATE orders SET delivery_date=$1 WHERE id=$2', [delivery_date || null, ol.order_id]);
      }
      if (machine_id !== undefined || ordered_ids !== undefined)
        await assignPressTx(qc, oc, {
          job_card_id: id, machine_id: machine_id === undefined ? jc.machine_id : machine_id,
          ordered_ids: ordered_ids || [], user: req.user.name,
        });
      await audit('job_card', id, 'print_queue_edited', 'Print queue entry edited', qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
```

- [ ] **Step 2: Verify guard wiring**

Run: `cd server && npm test`
Expected: PASS (Task 1 covers `printQueueEditBlock`).

- [ ] **Step 3: Manual smoke test**

In the app, pick a queued (not-started) card. `curl -s -X PUT localhost:PORT/api/print-planning/<id> -H 'Content-Type: application/json' -d '{"qty_planned":500,"operator":"Test Op"}'` → 200; confirm the card's qty/operator changed. Try the same on a printing/printed card → expect 409 "Reverse this run to edit."

- [ ] **Step 4: Checkpoint (no commit)**

Edit endpoint works and is guarded. Do not commit.

---

## Task 6: Client — tabs + `PrintedCard` + Completed tab

**Files:**
- Modify: `client/src/pages/PrintPlanning.jsx`

- [ ] **Step 1: Extend imports, state, and load**

At the top, add `useNavigate` and a couple of icons. Change the react-router import line:

```js
import { Link, useNavigate } from 'react-router-dom';
```

Add icons to the existing `lucide-react` import (append `LayoutGrid, RotateCcw, X, Pencil, FileText`):

```js
import { Inbox, Printer, GripVertical, Radio, Link2, AlertTriangle, User, MousePointer2, CheckCircle2, ArrowDown, LayoutGrid, RotateCcw, X, Pencil, FileText } from 'lucide-react';
```

Inside `export default function PrintPlanning()`, add state below the existing `useState` lines:

```js
  const [completed, setCompleted] = useState([]);
  const [tab, setTab] = useState('board');        // 'board' | 'completed'
  const [chooser, setChooser] = useState(null);   // { card, done } | null
  const [editCard, setEditCard] = useState(null); // card being edited | null
  const navigate = useNavigate();
```

Update `load` to capture `completed`:

```js
  const load = () => api.get('/print-planning').then(d => { setCards(d.cards); setPresses(d.presses); setCompleted(d.completed || []); });
```

- [ ] **Step 2: Add the `PrintedCard` component**

Above `export default function PrintPlanning`, add:

```jsx
// A printed run — a SOLID green card, deliberately distinct from a white queued
// card sitting on the emerald press. Non-draggable; clicking opens the chooser.
function PrintedCard({ card, onClick }) {
  return (
    <div onClick={onClick}
      className="cursor-pointer rounded-xl border border-emerald-600 bg-emerald-600 px-3.5 py-2.5 text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-extrabold tracking-tight">
          <CheckCircle2 size={13} className="shrink-0 text-emerald-100" />
          <span className="truncate">{card.jc_number}</span>
        </span>
        <span className="shrink-0 text-[10px] font-bold text-emerald-100">PRINTED</span>
      </div>
      <div className="mt-1 truncate text-xs font-semibold text-emerald-50">{card.product_name}</div>
      <div className="mt-0.5 truncate text-xs text-emerald-100/80">{card.customer_name}</div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
        <span className="shrink-0 rounded-full bg-emerald-500/60 px-2 py-0.5 font-semibold tabular-nums">
          {fmt.num(card.printed_sheets ?? card.sheets_issued)} sh printed
        </span>
        <span className="shrink-0 font-semibold tabular-nums text-emerald-100/90">{fmt.date(card.completed_at)}</span>
      </div>
      {card.printing_operator && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] font-semibold text-emerald-100/90">
          <User size={11} className="text-emerald-200" /> {card.printing_operator}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add per-press grouping for completed + today's printed**

Inside the component, after the `lanes` useMemo, add:

```js
  const isToday = ts => ts && new Date(ts).toDateString() === new Date().toDateString();
  // Completed runs grouped by the press they printed on (unassigned bucket last).
  const completedByPress = useMemo(() => {
    const by = { unassigned: [] };
    for (const p of presses) by[p.id] = [];
    for (const c of completed) {
      const k = c.machine_id && by[c.machine_id] ? c.machine_id : 'unassigned';
      by[k].push(c);
    }
    return by;
  }, [completed, presses]);
  // Runs printed TODAY, pinned green at the foot of their live press lane.
  const printedToday = useMemo(() => {
    const by = {};
    for (const p of presses) by[p.id] = completed.filter(c => c.machine_id === p.id && isToday(c.completed_at));
    return by;
  }, [completed, presses]);
```

- [ ] **Step 4: Add the tab switcher above the grid**

Replace the opening of the how-to bar block. Find the `{/* How-to + colour key ... */}` comment and insert a tab switcher immediately before it:

```jsx
      {/* Board / Completed tab switch */}
      <div className="mb-4 inline-flex rounded-full border border-white/70 bg-white/60 p-1 shadow-card backdrop-blur-xl">
        {[['board', 'Board', LayoutGrid], ['completed', 'Completed', CheckCircle2]].map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition-all ${
              tab === key ? 'bg-white text-[#007AFF] shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            <Icon size={14} /> {label}
            {key === 'completed' && completed.length > 0 && (
              <span className="ml-1 rounded-full bg-emerald-100 px-1.5 text-[10px] font-bold text-emerald-700">{completed.length}</span>
            )}
          </button>
        ))}
      </div>
```

- [ ] **Step 5: Gate the board vs completed view**

Wrap the existing how-to bar + `<div className="grid ...">...</div>` board block so it only shows on the board tab, and add the Completed view. Change the how-to bar's wrapper so it renders only when `tab === 'board'` (wrap it in `{tab === 'board' && ( ... )}`), and wrap the main board `grid` div likewise. Then, after the board grid's closing `</div>`, add the Completed panel:

```jsx
      {tab === 'completed' && (
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${presses.length}, minmax(0, 1fr))` }}>
          {presses.map((p, idx) => {
            const list = completedByPress[p.id] || [];
            const theme = pressTheme(idx);
            return (
              <div key={p.id} className="flex flex-col">
                <div className="mb-2 flex min-h-[3.25rem] items-start justify-between gap-2 px-1">
                  <span className="flex items-center gap-1.5 truncate text-sm font-extrabold text-slate-900">
                    <Printer size={14} className={theme.icon} /> {p.name}
                  </span>
                  <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold tabular-nums text-emerald-700">
                    {list.length} printed
                  </span>
                </div>
                <div className="flex min-h-[300px] flex-1 flex-col gap-1.5 rounded-2xl border border-emerald-100 bg-emerald-50/40 p-2.5 shadow-card">
                  {list.map(c => <PrintedCard key={c.id} card={c} onClick={() => setChooser({ card: c, done: true })} />)}
                  {list.length === 0 && (
                    <div className="flex flex-col items-center gap-1.5 py-12 text-center text-slate-300">
                      <CheckCircle2 size={20} className="text-emerald-200" />
                      <span className="text-xs font-semibold text-slate-400">No printed runs</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
```

- [ ] **Step 6: Pin today's printed cards at the foot of each live press lane**

In the board's press-lane render (the `presses.map(...)` inside the `grid`), inside the `laneShell` div, after the `groupLane(lane).map(...)` block and before the empty-state `{lane.length === 0 && (...)}`, add:

```jsx
                {printedToday[p.id]?.length > 0 && (
                  <div className="mt-1 border-t border-dashed border-emerald-200 pt-1.5">
                    {printedToday[p.id].map(c => (
                      <div key={`done-${c.id}`} className="mb-1.5">
                        <PrintedCard card={c} onClick={() => setChooser({ card: c, done: true })} />
                      </div>
                    ))}
                  </div>
                )}
```

- [ ] **Step 7: Verify in the app (Vite hot-reload)**

Open Print Planning. Expected: a Board/Completed tab switch appears. Completed tab shows per-press columns (empty if nothing printed in 60 days). If a run was printed today it appears green at the foot of its press lane on the Board tab. No console errors.

- [ ] **Step 8: Checkpoint (no commit)**

Tabs + green cards render. Do not commit.

---

## Task 7: Client — click chooser modal + navigation + reverse

**Files:**
- Modify: `client/src/pages/PrintPlanning.jsx`

- [ ] **Step 1: Add the chooser + reverse handlers inside the component**

After the `moveGroup` function, add:

```js
  const openJobCard = card => { setChooser(null); navigate(`/production/jobcard/${card.id}`); };
  const reverseRun = async card => {
    const reason = window.prompt('Reason for reversing this printed run back to Triage?');
    if (!reason) return;
    try { await api.post('/print-planning/reverse', { job_card_id: card.id, reason }); setChooser(null); load(); }
    catch (e) { alert(e?.message || 'Could not reverse this run'); }
  };
```

- [ ] **Step 2: Make live cards open the chooser on click**

In `renderGroup`, on the single-card wrapper `<div>` (the one with `{...groupProps(group, laneKey)}`), add an `onClick` that opens the chooser. Change that wrapper to:

```jsx
      return (
        <div key={group.key} {...groupProps(group, laneKey)}
          onClick={() => setChooser({ card: group.cards[0], done: false })}
          className={draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}>
          <Card card={group.cards[0]} grip={draggable} onPress={onPress} theme={theme} onDone={load} />
        </div>
      );
```

(Native HTML5 drag does not emit a `click` after a drop, so drag-to-reorder and click-to-open don't conflict. The `DangerZone` span already calls `stopPropagation`.)

- [ ] **Step 3: Add the chooser modal at the end of the returned JSX**

Just before the final closing `</div>` of the component's returned tree, add:

```jsx
      {chooser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setChooser(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-white/70 bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-extrabold text-slate-900">{chooser.card.jc_number}</span>
              <button onClick={() => setChooser(null)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
            </div>
            <div className="mb-4 truncate text-xs text-slate-500">{chooser.card.product_name} · {chooser.card.customer_name}</div>
            <div className="flex flex-col gap-2">
              <button onClick={() => openJobCard(chooser.card)}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                <FileText size={15} className="text-slate-400" /> View Job Card
              </button>
              {!chooser.done && canPlan() && (
                <button onClick={() => { setEditCard(chooser.card); setChooser(null); }}
                  className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold text-blue-700 hover:bg-blue-100">
                  <Pencil size={15} /> Printing Queue — Edit
                </button>
              )}
              {chooser.done && canPlan() && (
                <button onClick={() => reverseRun(chooser.card)}
                  className="inline-flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-700 hover:bg-amber-100">
                  <RotateCcw size={15} /> Reverse to Triage
                </button>
              )}
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 4: Verify in the app**

Click a queued card → chooser shows "View Job Card" + "Printing Queue — Edit". Click a printed (green) card → chooser shows "View Job Card" + "Reverse to Triage". "View Job Card" navigates to the job card. "Reverse to Triage" prompts for a reason and, on confirm, returns the card to Triage (it disappears from Completed and reappears in Triage after reload). Reversing a run whose next stage started → alert with the blocker message.

- [ ] **Step 5: Checkpoint (no commit)**

Chooser + reverse work end-to-end. Do not commit.

---

## Task 8: Client — edit form modal ("Printing Queue")

**Files:**
- Modify: `client/src/pages/PrintPlanning.jsx`

- [ ] **Step 1: Add the `EditQueueForm` component**

Above `export default function PrintPlanning`, add:

```jsx
// Edit a queued run in place — quantity, sheets, operator, press + position,
// and dates. Backed by PUT /print-planning/:id. Press change is sent as
// machine_id + the destination lane's new ordered_ids (this card appended).
function EditQueueForm({ card, presses, lanes, onClose, onSaved }) {
  const [form, setForm] = useState({
    qty_planned: card.qty_planned ?? '',
    sheets_issued: card.sheets_issued ?? '',
    operator: card.printing_operator ?? '',
    machine_id: card.machine_id ?? '',
    planned_date: card.planned_date ? String(card.planned_date).slice(0, 10) : '',
    delivery_date: card.delivery_date ? String(card.delivery_date).slice(0, 10) : '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    const body = {
      qty_planned: Number(form.qty_planned),
      sheets_issued: Number(form.sheets_issued),
      operator: form.operator || null,
      planned_date: form.planned_date || null,
      delivery_date: form.delivery_date || null,
    };
    const newMachine = form.machine_id ? Number(form.machine_id) : null;
    if (newMachine !== (card.machine_id ?? null)) {
      body.machine_id = newMachine;
      // Destination lane order: existing lane ids (minus this card) + this card.
      const dest = (lanes[newMachine] || []).map(c => c.id).filter(i => i !== card.id);
      body.ordered_ids = newMachine ? [...dest, card.id] : [];
    }
    try { await api.put(`/print-planning/${card.id}`, body); onSaved(); }
    catch (e) { alert(e?.message || 'Could not save changes'); }
    finally { setBusy(false); }
  };

  const field = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-white/70 bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-extrabold text-slate-900">Edit — {card.jc_number}</span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-semibold text-slate-500">Planned qty
            <input type="number" className={field} value={form.qty_planned} onChange={e => set('qty_planned', e.target.value)} />
          </label>
          <label className="text-xs font-semibold text-slate-500">Sheets issued
            <input type="number" className={field} value={form.sheets_issued} onChange={e => set('sheets_issued', e.target.value)} />
          </label>
          <label className="col-span-2 text-xs font-semibold text-slate-500">Operator
            <input className={field} value={form.operator} onChange={e => set('operator', e.target.value)} />
          </label>
          <label className="col-span-2 text-xs font-semibold text-slate-500">Press
            <select className={field} value={form.machine_id} onChange={e => set('machine_id', e.target.value)}>
              <option value="">Triage (unassigned)</option>
              {presses.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-500">Planned date
            <input type="date" className={field} value={form.planned_date} onChange={e => set('planned_date', e.target.value)} />
          </label>
          <label className="text-xs font-semibold text-slate-500">Delivery date
            <input type="date" className={field} value={form.delivery_date} onChange={e => set('delivery_date', e.target.value)} />
          </label>
        </div>
        <p className="mt-2 text-[11px] text-amber-600">Delivery date changes the whole order, not just this line.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700">Cancel</button>
          <button onClick={save} disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render the edit form when `editCard` is set**

Just before the final closing `</div>` of the component's returned tree (next to the chooser modal from Task 7), add:

```jsx
      {editCard && (
        <EditQueueForm card={editCard} presses={presses} lanes={lanes}
          onClose={() => setEditCard(null)}
          onSaved={() => { setEditCard(null); load(); }} />
      )}
```

- [ ] **Step 3: Verify in the app**

On a queued card, open the chooser → "Printing Queue — Edit" → change qty and operator → Save → the card reflects the change after reload. Change the Press dropdown → card moves to the chosen lane. Set a planned date → persists. Confirm a printed card offers Reverse (not Edit), matching Task 7.

- [ ] **Step 4: Full flow verification (spare-port + UI)**

Walk the whole story once: queue a job on a press → edit its qty/operator/date → complete its printing on the Floor → it shows green at the foot of its lane (Board) and under its press (Completed) → open its chooser → Reverse to Triage with a reason → it returns to Triage, printing `pending`, editable again. Confirm no console/server errors throughout.

- [ ] **Step 5: Checkpoint (no commit)**

Entire feature works end-to-end. Do not commit.

---

## Self-Review Notes

- **Spec coverage:** tabs (T6) ✓, green PRINTED treatment (T6) ✓, per-machine Completed (T6) ✓, board green window / end-of-day (T6 `printedToday`) ✓, click chooser (T7) ✓, view job card (T7) ✓, edit form with all four field groups (T8) ✓, reverse to Triage gang-aware (T4/T7) ✓, consolidated edit endpoint (T5) ✓, `completed` array (T3) ✓, pure guards + tests (T1) ✓, shared assign core (T2) ✓, permissions `canPlan` (all routes) ✓, tests mirror `order-lifecycle.test.js` (T1) ✓.
- **Type/name consistency:** `assignPressTx({ job_card_id, machine_id, ordered_ids, user })` used identically in T2/T5; `printReverseBlockers`/`printQueueEditBlock` signatures identical in T1 defs, T1 tests, T4/T5 call sites; client `chooser` shape `{ card, done }` consistent across T6/T7; `PrintedCard`, `EditQueueForm` props consistent across T6/T8.
- **No placeholders:** every step carries real code/commands.
- **Commit rule:** all checkpoints are test/verify only — no git commits anywhere (ci-erp project rule).
