# Board shortage panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cluttered three-button board-shortage row with one shared component that confirms before acting, reports what happened, and lets a planner undo or cancel a requisition without leaving the planning engine.

**Architecture:** All decisions — which mode the panel is in, and which controls a given user may see for a given requisition — move into a dependency-free module at `client/src/lib/shortagePanel.js`, tested with `node --test` from `server/src/`. That is the established pattern here: `board-math.test.js`, `board-mix.test.js` and `opening-counter.test.js` all import `../../client/src/lib/*.js`. The JSX component stays thin and renders what the module decides, so no client-side test runner has to be introduced. Both existing copies of the row (`Planning.jsx:2604` and `:3741`) are replaced by the one component.

**Tech Stack:** React 18 + Vite, Tailwind, existing `components/ui.jsx` primitives (`Modal`, `Button`), `node --test` for tests.

**Spec:** `docs/superpowers/specs/2026-08-05-shortage-panel-design.md`

---

## A note on commits

The writing-plans skill mandates a commit step per task. This repository is under a
standing session rule — no `git commit`, no `git push`, no deploy — so **every commit
step is deliberately omitted** and replaced by a verification checkpoint. Work stays on
disk in the `shortage-panel` branch of the worktree. Do not commit unless Anik sanctions
it in the current session.

## Baseline

Before starting, confirm the tree is green:

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && npm test -w server
```

Expected, as measured 2026-08-05: `# pass 1059`, `# fail 0`.

## File structure

| File | Responsibility |
|---|---|
| `client/src/lib/shortagePanel.js` | **Create.** Pure decisions: which mode the panel renders, which PR controls are permitted. No imports. |
| `server/src/shortage-panel.test.js` | **Create.** `node --test` coverage for the above. |
| `client/src/components/ShortagePanel.jsx` | **Create.** The card, the three confirmations, the status strip, the move result. |
| `client/src/pages/Planning.jsx` | **Modify.** Replace both inline rows; add undo/cancel/move-back handlers. |
| `client/src/components/BoardCommitments.jsx` | **Modify, one line.** Pass the `/board/move` response to `onChanged` so the auto-raised PR can be named. |

---

### Task 1: The decision module

Two pure functions. `panelMode` answers what to render; `prControls` answers what a
user may do to a requisition. Keeping both out of JSX is what makes them testable
with the runner this repo already has.

**Files:**
- Create: `client/src/lib/shortagePanel.js`
- Test: `server/src/shortage-panel.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/shortage-panel.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelMode, prControls } from '../../client/src/lib/shortagePanel.js';

// ── panelMode ───────────────────────────────────────────────────────────────
// The old row rendered only while short > 0, so any action that resolved the
// shortage erased the result along with it. The panel now outlives the shortage.

test('a shortage shows the action card', () => {
  assert.equal(panelMode({ short: 28700, prs: [], lastMove: null }), 'card');
});

test('no shortage and nothing done renders nothing at all', () => {
  assert.equal(panelMode({ short: 0, prs: [], lastMove: null }), null);
});

test('a covered shortage with this job PR shows the PR strip', () => {
  assert.equal(panelMode({ short: 0, prs: [{ id: 1, status: 'pending' }], lastMove: null }), 'pr');
});

test('a completed move shows the move result', () => {
  assert.equal(panelMode({ short: 0, prs: [], lastMove: { qty: 500 } }), 'move');
});

test('a PR outranks a move when both happened — the PR is the one with controls', () => {
  assert.equal(panelMode({ short: 0, prs: [{ id: 1, status: 'pending' }], lastMove: { qty: 500 } }), 'pr');
});

test('a still-short line shows the card even after a partial move', () => {
  assert.equal(panelMode({ short: 200, prs: [{ id: 1, status: 'pending' }], lastMove: { qty: 500 } }), 'card');
});

test('a negative or missing short is not a shortage', () => {
  assert.equal(panelMode({ short: -5, prs: [], lastMove: null }), null);
  assert.equal(panelMode({ prs: [], lastMove: null }), null);
});

// ── prControls ──────────────────────────────────────────────────────────────
// Two gates, both pre-existing. Role: raising is canRaisePr (planner, production,
// qc) but retiring is canBuy (planner) — procurement.js:66. State: DELETE refuses
// a PR on a PO, and close accepts only pending or approved.

test('a planner may undo and cancel a pending PR', () => {
  const c = prControls({ pr: { status: 'pending' }, role: 'planner' });
  assert.equal(c.undo, true);
  assert.equal(c.cancel, true);
  assert.equal(c.blockedReason, null);
});

test('admin passes every role gate, as requireRole does', () => {
  const c = prControls({ pr: { status: 'pending' }, role: 'admin' });
  assert.equal(c.undo, true);
  assert.equal(c.cancel, true);
});

test('production may raise a PR but never retire one', () => {
  const c = prControls({ pr: { status: 'pending' }, role: 'production' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
});

test('qc may not retire a PR either', () => {
  const c = prControls({ pr: { status: 'pending' }, role: 'qc' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
});

test('an approved PR can be cancelled but not undone — undo would unapprove silently', () => {
  const c = prControls({ pr: { status: 'approved' }, role: 'planner' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, true);
});

test('a converted PR offers neither, and says why', () => {
  const c = prControls({ pr: { status: 'converted', po_number: 'PO-0117', pr_number: 'PR-0412' }, role: 'planner' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
  assert.match(c.blockedReason, /PO-0117/);
});

test('a PR carrying a purchase_order_id is blocked even while its status lags', () => {
  const c = prControls({ pr: { status: 'approved', purchase_order_id: 9, pr_number: 'PR-0412' }, role: 'planner' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
  assert.match(c.blockedReason, /purchase order/);
});

test('a rejected or closed PR is already retired — no controls, no alarm', () => {
  for (const status of ['rejected', 'closed']) {
    const c = prControls({ pr: { status }, role: 'planner' });
    assert.equal(c.undo, false, status);
    assert.equal(c.cancel, false, status);
    assert.equal(c.blockedReason, null, status);
  }
});

test('no PR means no controls rather than a crash', () => {
  const c = prControls({ pr: null, role: 'admin' });
  assert.equal(c.undo, false);
  assert.equal(c.cancel, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && node --test server/src/shortage-panel.test.js
```

Expected: FAIL — `Cannot find module .../client/src/lib/shortagePanel.js`.

- [ ] **Step 3: Write the implementation**

Create `client/src/lib/shortagePanel.js`:

```js
// Decisions for the board shortage panel, kept out of JSX so `node --test` can
// reach them — the same arrangement as lib/boardMix.js and lib/received.js.
// Dependency-free on purpose: an extensionless import here would make the module
// unloadable in Node and the tests would die on import rather than on a claim.

// Which face the panel shows. The old inline row rendered only while short > 0,
// so the moment an action worked, the result vanished with the shortage. A live
// shortage still outranks everything — a partial move leaves work to do.
export function panelMode({ short, prs, lastMove } = {}) {
  if (+short > 0) return 'card';
  if (Array.isArray(prs) && prs.length) return 'pr';
  if (lastMove) return 'move';
  return null;
}

// Roles allowed to retire a requisition. Raising is deliberately wider than
// retiring (procurement.js:63-69): production and qc may raise and may not undo.
// requireRole lets admin through every gate, so it is listed here too.
const CAN_BUY = new Set(['planner', 'admin']);

// Statuses from which the server will still accept a change. DELETE refuses a
// PR that is on a PO; close accepts pending or approved only.
const UNDOABLE = new Set(['pending']);
const CANCELLABLE = new Set(['pending', 'approved']);

export function prControls({ pr, role } = {}) {
  const none = { undo: false, cancel: false, blockedReason: null };
  if (!pr) return none;

  // On a PO the server refuses both, and the honest thing is to say so rather
  // than hide the controls silently. Phrased like procurement.js's own 409.
  const onPo = pr.status === 'converted' || pr.purchase_order_id || pr.po_number;
  if (onPo) {
    return { ...none,
      blockedReason: `${pr.pr_number || 'This requisition'} is on ${pr.po_number || 'a purchase order'} — send that PO back to requisition first` };
  }

  // Already retired. Not an obstacle worth explaining.
  if (!CANCELLABLE.has(pr.status)) return none;
  if (!CAN_BUY.has(role)) return none;

  return { undo: UNDOABLE.has(pr.status), cancel: true, blockedReason: null };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && node --test server/src/shortage-panel.test.js
```

Expected: PASS, 16 tests. (The rejected/closed case is one test looping over two
statuses, not two tests — an earlier draft of this plan said 17 and was wrong.)

- [ ] **Step 5: Checkpoint — whole suite still green**

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && npm test -w server
```

Expected: `# fail 0`, and the total risen from 1059 to 1075.

---

### Task 2: The panel component — card mode

Layout A: headline, one full-width primary, hairline, two quiet links. No modals
yet; handlers fire directly so the layout can be seen against live data first.

**Files:**
- Create: `client/src/components/ShortagePanel.jsx`

- [ ] **Step 1: Write the component**

Create `client/src/components/ShortagePanel.jsx`:

```jsx
// The board shortage panel, shared by the single-line engine and the run view.
// Both used to hold their own inline copy of this row; the wording differences
// between them are props now, because a real difference in one term argues for a
// parameter rather than a second reader.
import { useState } from 'react';
import { AlertTriangle, Truck, Check } from 'lucide-react';
import { Button, Modal } from './ui.jsx';
import { fmt } from '../api.js';
import { panelMode, prControls } from '../lib/shortagePanel.js';

export default function ShortagePanel({
  short, fresh, prs = [], lastMove = null, role,
  ownIncoming = 0, neededBy = null, boardName = null, jobLabel = null,
  coverCandidate = null,
  onRaisePr, onTakeBoard, onCoverMix,
  onUndoPr, onCancelPr, onTrackPr, onMoveBack,
  busy = false,
}) {
  const [confirm, setConfirm] = useState(null);
  const mode = panelMode({ short, prs, lastMove });
  if (!mode) return null;

  if (mode === 'card') {
    const tone = fresh
      ? { bg: 'bg-indigo-50', text: 'text-indigo-700', rule: 'border-indigo-200', variant: 'primary' }
      : { bg: 'bg-red-50', text: 'text-red-700', rule: 'border-red-200', variant: 'danger' };
    return (
      <div className={`mt-2.5 rounded-xl px-3 py-2.5 ${tone.bg}`}>
        <div className="flex items-baseline justify-between gap-2">
          <span className={`flex items-center gap-1.5 text-xs font-semibold ${tone.text}`}>
            {fresh ? <Truck size={13} /> : <AlertTriangle size={13} />}
            {fresh
              ? `Buying fresh — ${fmt.num(short)} parent sheets to order`
              : `Short ${fmt.num(short)} parent sheets`}
          </span>
          <span className={`shrink-0 text-[11px] ${tone.text} opacity-70`}>
            {fresh
              ? (ownIncoming > 0 ? `${fmt.num(ownIncoming)} on PR` : 'not yet ordered')
              : 'cutting waits'}
          </span>
        </div>

        <Button size="sm" variant={tone.variant} className="mt-2 w-full" disabled={busy}
          onClick={() => setConfirm('pr')}>
          Raise PR for {fmt.num(short)}
        </Button>

        {(onTakeBoard || onCoverMix) && (
          <div className={`mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 ${tone.rule}`}>
            {onTakeBoard && (
              <button type="button" onClick={() => setConfirm('take')}
                className={`text-[11px] font-semibold underline-offset-2 hover:underline ${tone.text}`}>
                Take from another job
              </button>
            )}
            {onCoverMix && (
              <button type="button" onClick={() => setConfirm('cover')}
                className={`text-[11px] font-semibold underline-offset-2 hover:underline ${tone.text}`}>
                Cover with a board
              </button>
            )}
          </div>
        )}

        <Confirmations kind={confirm} onClose={() => setConfirm(null)}
          short={short} boardName={boardName} jobLabel={jobLabel} neededBy={neededBy}
          coverCandidate={coverCandidate} busy={busy}
          onRaisePr={onRaisePr} onTakeBoard={onTakeBoard} onCoverMix={onCoverMix} />
      </div>
    );
  }

  if (mode === 'pr') {
    const pr = prs[0];
    const c = prControls({ pr, role });
    return (
      <div className="mt-2.5 rounded-xl bg-emerald-50 px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
            <Check size={13} /> {pr.pr_number} raised
          </span>
          <span className="shrink-0 text-[11px] text-emerald-700">
            {pr.status === 'approved' ? 'approved' : 'awaiting approval'}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-emerald-700">
          {fmt.num(pr.qty)} sheets{neededBy ? ` · needed by ${fmt.date(neededBy)}` : ''}
        </p>
        {c.blockedReason && (
          <p className="mt-1 text-[11px] font-medium text-emerald-700 opacity-80">{c.blockedReason}</p>
        )}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-emerald-200 pt-2">
          <button type="button" onClick={() => onTrackPr?.(pr)}
            className="text-[11px] font-semibold text-emerald-800 underline-offset-2 hover:underline">
            Track requisition
          </button>
          {c.undo && (
            <button type="button" disabled={busy} onClick={() => setConfirm('undo')}
              className="text-[11px] font-semibold text-emerald-800 underline-offset-2 hover:underline">
              Undo
            </button>
          )}
          {c.cancel && (
            <button type="button" disabled={busy} onClick={() => setConfirm('cancel')}
              className="text-[11px] font-semibold text-red-700 underline-offset-2 hover:underline">
              Cancel
            </button>
          )}
        </div>
        <PrConfirmations kind={confirm} pr={pr} busy={busy} onClose={() => setConfirm(null)}
          onUndoPr={onUndoPr} onCancelPr={onCancelPr} />
      </div>
    );
  }

  // mode === 'move'
  return (
    <div className="mt-2.5 rounded-xl bg-sky-50 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-sky-800">
          <Check size={13} /> {fmt.num(lastMove.qty)} sheets moved in
        </span>
        {onMoveBack && (
          <button type="button" onClick={() => onMoveBack(lastMove)}
            className="shrink-0 text-[11px] font-semibold text-sky-800 underline-offset-2 hover:underline">
            Move it back
          </button>
        )}
      </div>
      {/* A move can auto-raise a PR for the job it took board from. Naming it is
          the whole point — releasing the hold would leave that PR standing. */}
      {(lastMove.raised || []).length > 0 && (
        <p className="mt-1 text-[11px] text-sky-800">
          Raised {lastMove.raised.map(p => p.pr_number).join(', ')} for the job it came from —
          undo that separately if the move was wrong.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the two confirmation blocks to the same file**

Append to `client/src/components/ShortagePanel.jsx`:

```jsx
// Each modal names what its own action does. A generic "are you sure" would put
// buying board, taking it off another job, and drafting a throwaway mix behind
// identical words, which is exactly the equivalence this redesign removes.
function Confirmations({ kind, onClose, short, boardName, jobLabel, neededBy, coverCandidate, busy, onRaisePr, onTakeBoard, onCoverMix }) {
  const act = fn => () => { onClose(); fn?.(); };
  return (
    <>
      <Modal open={kind === 'pr'} onClose={onClose} title="Raise a requisition?"
        footer={<>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={act(onRaisePr)}>Raise PR</Button>
        </>}>
        <div className="space-y-2 text-sm text-slate-600">
          <p><b className="text-slate-900">{fmt.num(short)} parent sheets</b>{boardName ? <> of <b className="text-slate-900">{boardName}</b></> : null}</p>
          {jobLabel && <p>For {jobLabel}</p>}
          {neededBy && <p>Needed by {fmt.date(neededBy)}</p>}
          <p className="text-[11px] text-slate-400">Goes to Procurement as a pending requisition. You can undo it from here while it is still pending.</p>
        </div>
      </Modal>

      <Modal open={kind === 'take'} onClose={onClose} title="Take board from another job?"
        footer={<>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={act(onTakeBoard)}>Choose a job</Button>
        </>}>
        <div className="space-y-2 text-sm text-slate-600">
          <p>This moves board off another job's hold and onto this one.</p>
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
            A requisition may be raised automatically for the job you take it from, so it is not left short. A move cannot be undone in one step.
          </p>
          <p className="text-[11px] text-slate-400">You pick which job on the next screen.</p>
        </div>
      </Modal>

      <Modal open={kind === 'cover'} onClose={onClose} title="Cover with another board?"
        footer={<>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={act(onCoverMix)}>Draft the mix</Button>
        </>}>
        <div className="space-y-2 text-sm text-slate-600">
          <p>{coverCandidate
            ? <>Covers the {fmt.num(short)} shortfall with <b className="text-slate-900">{coverCandidate}</b>.</>
            : <>Covers the {fmt.num(short)} shortfall with the closest available board.</>}</p>
          <p className="text-[11px] text-slate-400">This only drafts rows in Board Mix on the left. Nothing is committed until you save the plan.</p>
        </div>
      </Modal>
    </>
  );
}

// Undo removes the row outright and needs no reason. Cancel keeps it as `closed`
// with a reason, which the server requires — POST /close 400s on a blank one.
function PrConfirmations({ kind, pr, busy, onClose, onUndoPr, onCancelPr }) {
  const [reason, setReason] = useState('');
  return (
    <>
      <Modal open={kind === 'undo'} onClose={onClose} title={`Undo ${pr.pr_number}?`}
        footer={<>
          <Button variant="secondary" onClick={onClose}>Keep it</Button>
          <Button variant="danger" disabled={busy} onClick={() => { onClose(); onUndoPr?.(pr); }}>Undo it</Button>
        </>}>
        <p className="text-sm text-slate-600">
          Removes {pr.pr_number} completely, as though it were never raised. The shortage comes back.
        </p>
      </Modal>

      <Modal open={kind === 'cancel'} onClose={onClose} title={`Cancel ${pr.pr_number}?`}
        footer={<>
          <Button variant="secondary" onClick={onClose}>Keep it</Button>
          <Button variant="danger" disabled={busy || !reason.trim()}
            onClick={() => { onClose(); onCancelPr?.(pr, reason.trim()); setReason(''); }}>
            Cancel the PR
          </Button>
        </>}>
        <div className="space-y-2">
          <p className="text-sm text-slate-600">
            Keeps {pr.pr_number} on record as closed, with your reason against it. Use this when the decision changed — use Undo for a mistake.
          </p>
          <input value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Why is it being cancelled?"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </div>
      </Modal>
    </>
  );
}
```

- [ ] **Step 3: Confirm the imports resolve**

Verified 2026-08-05: `fmt` lives in `client/src/api.js` (there is no
`lib/format.js` — an earlier draft of this plan had that wrong), `Button` and
`Modal` are exported from `components/ui.jsx`, `Button` accepts and spreads
`className` (`ui.jsx:10`), and icons come from `lucide-react`. Re-confirm nothing
has moved:

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && grep -n "export const fmt\|export function fmt" client/src/api.js && grep -n "export function Button\|export function Modal" client/src/components/ui.jsx
```

Expected: `fmt` exported from `api.js`; both `Button` and `Modal` exported from
`ui.jsx`.

Note the lib module in Task 1 stays dependency-free deliberately. `api.js` is
fine to import from JSX, but an extensionless or browser-only import inside
`lib/shortagePanel.js` would make it unloadable under `node --test` and the suite
would die on import rather than on a claim.

- [ ] **Step 4: Checkpoint — prove the new file actually compiles**

`npm run build -w client` is **not** sufficient here and an earlier draft of this
plan was wrong to rely on it. Nothing imports `ShortagePanel.jsx` until Task 3, and
Rollup only bundles modules reachable from the entry point — so the build passes
without ever reading the new file. Bundle it directly instead:

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview/client" && ../node_modules/.bin/esbuild src/components/ShortagePanel.jsx --bundle --format=esm --jsx=automatic --outfile=/dev/null
```

Expected: no errors. This forces real resolution of `./ui.jsx`, `../api.js`,
`../lib/shortagePanel.js` and `lucide-react`, and parses the JSX.

Then run the ordinary build too, to confirm nothing else regressed:

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && npm run build -w client
```

From Task 3 onward the plain build **does** cover this file, because Planning.jsx
imports it.

---

### Task 3: Wire the single-line engine

Replace the inline row at `Planning.jsx:2604` (and the fresh variant just above at
`:2588`) with the component, and add the undo/cancel handlers.

**Files:**
- Modify: `client/src/pages/Planning.jsx`

- [ ] **Step 1: Add the handlers next to the existing `raisePrInline`**

Insert immediately after `raisePrInline`'s closing brace (currently line 1448):

```js
  // Undo — the PR was a mistake. DELETE removes the row outright; the server
  // refuses if it has reached a PO and says which one, so surface that verbatim
  // rather than inventing a friendlier lie.
  const undoPr = async pr => {
    setPrBusy(true);
    try {
      await api.del(`/requisitions/${pr.id}`);
      toast.success(`${pr.pr_number} undone`);
      setCtx(await loadCtx(planLine, boardSel.id));
      load();
    } finally { setPrBusy(false); }
  };

  // Cancel — the PR was real and the decision changed. close() keeps the row with
  // the reason against it, and the server rejects a blank reason with a 400.
  const cancelPr = async (pr, reason) => {
    setPrBusy(true);
    try {
      await api.post(`/requisitions/${pr.id}/close`, { reason });
      toast.success(`${pr.pr_number} cancelled`);
      setCtx(await loadCtx(planLine, boardSel.id));
      load();
    } finally { setPrBusy(false); }
  };
```

- [ ] **Step 2: Add the seed-mix handler, lifted from the old inline button**

The `Cover with another board` onClick at `:2620-2646` becomes a named function so
the component can call it. Insert after `cancelPr`:

```js
  // Was the inline onClick of "Cover with another board". Unchanged behaviour:
  // the planned board keeps only what it can still give — seeding a zero-sheet
  // row balances on screen but fails plan-save's `sheets > 0` check every time.
  const seedCoverMix = () => {
    const c = (ctx?.mix?.candidates || [])[0];
    if (!c) return;
    const plannedSheets = Math.max(0, calc.parent - position.short);
    setMixRows(rows => rows.length ? rows : [
      ...(plannedSheets > 0 ? [{ material_id: ctx.mix.planned_board_id,
        board_name: boardSel?.name, ups: ctx.mix.planned_ups,
        sheets: plannedSheets, stock_batch_id: null, reason: '', severity: 'none' }] : []),
      { material_id: c.id, board_name: c.name, ups: c.ups, sheets: position.short,
        stock_batch_id: null, reason: DEFAULT_MIX_REASON, severity: c.severity,
        gsm_delta: c.gsm_delta, ups_differ: c.ups_differ,
        size_differs: c.size_differs, available: c.available },
    ]);
  };
```

- [ ] **Step 3: Replace both inline blocks with the component**

Delete the JSX from the opening of `{position.fresh && position.short > 0 && (`
(line 2588) through the closing `)}` of the `{!position.fresh && position.short > 0 && (`
block (line 2652) — both blocks go. Leave the `own_incoming` "Full quantity on
order" paragraph at `:2599-2603` in place. Put this in their stead:

```jsx
                      <ShortagePanel
                        short={position.short}
                        fresh={position.fresh}
                        ownIncoming={position.own_incoming}
                        prs={(ctx?.incoming?.prs || []).filter(p =>
                          (p.product_id != null && p.product_id === planLine.product_id)
                          || (planLine.gang_run_id != null && p.gang_run_id === planLine.gang_run_id))}
                        lastMove={lastMove}
                        role={auth.user?.role}
                        neededBy={planLine.delivery_date}
                        boardName={boardSel?.name}
                        jobLabel={`${planLine.product_name} (PO ${planLine.po_number})`}
                        coverCandidate={(ctx?.mix?.candidates || [])[0]?.name}
                        busy={prBusy}
                        onRaisePr={onRaisePr}
                        onTakeBoard={() => setBoardPanel(true)}
                        onCoverMix={ctx?.gang ? undefined : seedCoverMix}
                        onUndoPr={undoPr}
                        onCancelPr={cancelPr}
                        onTrackPr={openPrTracker}
                        onMoveBack={() => setBoardPanel(true)}
                      />
```

`onCoverMix` is `undefined` on a gang, which is what hides the button — a gang
shares one board across every member and the server 409s a mix sent for it.

- [ ] **Step 4: Add the import and the `lastMove` state**

Add to the imports at the top of `Planning.jsx`:

```js
import ShortagePanel from '../components/ShortagePanel.jsx';
```

Add beside the other `useState` declarations near line 337:

```js
  // The result of a board move, held only for this session. board_allocations
  // has no 'move' source (db.js:1914), so a moved-in hold is indistinguishable
  // from ordinary stock after a reload — better to forget than to guess wrong.
  const [lastMove, setLastMove] = useState(null);
```

- [ ] **Step 5: Let the board panel hand its move result upward**

`BoardCommitments` currently calls `onChanged?.()` with no argument from two
places — after a move (`BoardCommitments.jsx:68`) and after a repoint (`:85`).
The move response is the only place the auto-raised PRs appear, so pass it up.

In `client/src/components/BoardCommitments.jsx`, change line 68 only:

```js
      onChanged?.(out);
```

Leave `:85` as `onChanged?.()` — a repoint is not a move and must not produce a
move result.

Then in `Planning.jsx`, the `BoardCommitments` element at `:4185-4190` takes the
argument. Replace its `onChanged` with:

```jsx
        onChanged={async moved => {
          // Only a move passes a payload; a repoint calls this with nothing.
          if (moved) setLastMove(moved);
          if (planLine && boardSel) setCtx(await loadCtx(planLine, boardSel.id));
        }} />
```

`auth` is already imported in `Planning.jsx:8`
(`import { api, auth, fmt } from '../api.js'`), so `auth.user?.role` needs no new
import.

- [ ] **Step 6: Checkpoint — build and full suite**

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && npm run build -w client && npm test -w server
```

Expected: build succeeds; `# fail 0`, total 1075.

---

### Task 4: Wire the run view

The gang/run copy at `Planning.jsx:3741` gets the same component. It has no
"take board" route and hides the mix seed on the conditions it already uses.

**Files:**
- Modify: `client/src/pages/Planning.jsx`

- [ ] **Step 1: Extract the run's mix seed first**

The onClick at `:3759-3775` becomes a named function so the component can call it:

```js
  // The run's own one-click seed. Same shape as seedCoverMix, over the run's
  // figures: the planned board keeps only what it can still give.
  const seedGangCoverMix = () => {
    const c = gangView.mix.candidates[0];
    const plannedSheets = Math.max(0, issueNow - short);
    setGangMixRows([
      ...(plannedSheets > 0 ? [{ material_id: gangView.mix.planned_board_id,
        board_name: gangView.mix.planned_board_name, ups: gangView.mix.planned_ups,
        sheets: plannedSheets, stock_batch_id: null, reason: '', severity: 'none' }] : []),
      { material_id: c.id, board_name: c.name, ups: c.ups, sheets: short,
        stock_batch_id: null, reason: DEFAULT_MIX_REASON, severity: c.severity,
        gsm_delta: c.gsm_delta, ups_differ: c.ups_differ,
        size_differs: c.size_differs, available: c.available },
    ]);
  };
```

`issueNow`, `short`, `gangView` and `gangMixRows` are scoped inside the IIFE that
renders the run card. Keep this function in that same scope — do not hoist those
variables out to reach it.

- [ ] **Step 2: Replace the inline block**

Delete the JSX from `{short > 0 && (` at line 3741 through its closing `)}` at
line 3786, and put in its place:

```jsx
                  <ShortagePanel
                    short={short}
                    fresh={freshRun}
                    prs={prs}
                    role={auth.user?.role}
                    busy={gangPrBusy}
                    onRaisePr={() => gangRaisePr()}
                    onCoverMix={
                      !freshRun && (gangView.mix?.candidates || []).length > 0 && gangMixRows.length === 0
                        ? seedGangCoverMix
                        : undefined}
                    onUndoPr={undoPr}
                    onCancelPr={cancelPr}
                    onTrackPr={openPrTracker}
                  />
```

`onTakeBoard` is omitted, so that button does not render here — the run view never
offered it.

- [ ] **Step 3: Confirm the old wording is gone**

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && grep -n "Cover with another board\|Take board from another job\|Raise for the balance\|Raise ONE PR" client/src/pages/Planning.jsx
```

Expected: only the comment at `:1060` referring to the handler by name. Any
surviving JSX match means a copy was missed.

- [ ] **Step 4: Checkpoint — build and full suite**

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && npm run build -w client && npm test -w server
```

Expected: build succeeds; `# fail 0`, total 1075.

---

### Task 5: Verify against a writable database

The live preview on :5915 is read-only, so it proves the layout and the modals but
refuses every write. Raise, undo and cancel get exercised on the embedded database.

**Files:** none — verification only.

- [ ] **Step 1: Start a writable instance**

Add to `.claude/launch.json` in the session directory and start it via
`preview_start`, so a shortage line can actually be acted on:

```
sh -c "cd '/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview' && npx concurrently -k \"PORT=4925 JWT_SECRET=local-dev-only-not-a-production-secret node server/src/index.js\" \"VITE_API_TARGET=http://localhost:4925 npm run dev -w client -- --port 5925 --strictPort\""
```

No `DATABASE_URL`, so the embedded Postgres boots on :5439. Note that a fresh seed
prints a random admin password to the server log.

- [ ] **Step 2: Walk the five states and confirm each**

On a line with a short board:

1. Card shows one primary and two quiet links; `Raise PR` opens the modal naming board, quantity and job.
2. Confirm it — the strip replaces the card, showing the PR number and `awaiting approval`.
3. `Undo` removes the PR and the shortage returns.
4. Raise again, then `Cancel` with a reason — the strip clears and the PR reads `closed` in Procurement.
5. Approve the PR in Procurement, return — `Undo` is gone, `Cancel` remains.

- [ ] **Step 3: Confirm the role gate with a non-planner**

Sign in as a `production` account. The strip shows the PR and its status, with
neither `Undo` nor `Cancel`. This is the pre-existing split at `procurement.js:66`,
not a new rule.

- [ ] **Step 4: Confirm the read-only live preview still shows the layout**

Reload :5915. The card and all three modals render against live figures;
confirming a PR fails with the read-only error rather than changing the plant.

- [ ] **Step 5: Final checkpoint**

```bash
cd "/Users/anikdua/.config/superpowers/worktrees/ci-erp/live-preview" && npm test -w server && npm run build -w client
```

Expected: `# fail 0`, total 1075; build succeeds.

Do **not** run `npm run verify` from the repo root — it invokes
`build-baseline.mjs --check`, which writes the baseline and dirties every worktree
sharing this repository.
