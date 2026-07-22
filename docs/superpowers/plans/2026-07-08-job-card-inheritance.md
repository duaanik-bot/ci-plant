# Job Card Inheritance & Finalisation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Job Card a read-only, source-traceable manufacturing document that inherits Planning/Artwork/Product-Master data via live joins, adds an explicit Finalise action that unlocks push-to-next-stage from the form, and prints a clean stage-free PDF.

**Architecture:** Additive DB columns only. The job-card SQL view (`JC_VIEW`) is expanded and the detail endpoint attaches the product's Tooling Hub records (artwork source). A new `finalised_at` flag gates editing and reveals the existing `WorkflowControls` inside the form. The print page is rebuilt as a 3-source spec sheet with no stage tables.

**Tech Stack:** Node/Express + embedded Postgres (`pg`), React 18 + Vite + Tailwind, `lucide-react` icons. Existing UI kit in `client/src/components/ui.jsx`.

**Project conventions (IMPORTANT):**
- **No git commits.** Replace every "commit" with a **Checkpoint** (verify, then stop). All work stays local.
- Run the app with the `ci-erp` launch config (plain `npm run dev`, embedded Postgres on 5173). Do **not** pass a hardcoded `DATABASE_URL` — that skips embedded Postgres and causes "DB loading failure".
- Login for manual checks: `admin@ci.local` / `admin123`.
- Migrations live inline in `server/src/db.js` as idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.

---

## File Structure

- `server/src/db.js` — add 3 columns (migrations).
- `server/src/helpers.js` — add two pure guard functions `finaliseBlock`, `reopenBlock`.
- `server/src/production.finalise.test.js` — **new**, unit tests for the guards.
- `server/src/routes/production.js` — expand `JC_VIEW`, attach `jc.tools` in detail endpoints, add finalise/reopen endpoints, guard `PUT`.
- `server/src/routes/tooling.js` — accept `output_no`/`cylinder_no`.
- `client/src/pages/Tooling.jsx` — capture the two new fields.
- `client/src/pages/Production.jsx` — redesign Job Card Form modal (remove stage rail, add inherited panels + Finalise/Reopen + embedded WorkflowControls).
- `client/src/pages/JobCardPrint.jsx` — rebuild as stage-free 3-source spec sheet.

---

## Task 1: Migrations — add the three columns

**Files:**
- Modify: `server/src/db.js` (the `tools` ALTER block near the `ALTER TABLE products ADD COLUMN … tool_id` line, ~633)

- [ ] **Step 1: Add the columns**

In `server/src/db.js`, find the line:

```js
ALTER TABLE products ADD COLUMN IF NOT EXISTS tool_id INTEGER REFERENCES tools(id);
`);
```

Change it to:

```js
ALTER TABLE products ADD COLUMN IF NOT EXISTS tool_id INTEGER REFERENCES tools(id);
ALTER TABLE tools ADD COLUMN IF NOT EXISTS output_no TEXT;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS cylinder_no TEXT;
ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS finalised_at TIMESTAMPTZ;
`);
```

- [ ] **Step 2: Restart the app and verify the columns exist**

Start the `ci-erp` launch config (or `npm run dev`). Wait for the server to log it is listening on 4000, then run:

```bash
cd server && node -e "import('./src/db.js').then(async ({q})=>{const c=await q(\"select column_name from information_schema.columns where table_name in ('tools','job_cards') and column_name in ('output_no','cylinder_no','finalised_at') order by column_name\");console.log(c);process.exit(0)})"
```

Expected: three rows — `cylinder_no`, `finalised_at`, `output_no`.

> If the one-liner cannot connect (embedded PG owns the socket), instead verify by hitting the app: the server boots without error and `GET /api/job-cards` still returns 200. Column creation is guaranteed by the idempotent DDL running at boot.

- [ ] **Step 3: Checkpoint** — server boots clean, columns present. Stop.

---

## Task 2: Guard functions + unit tests (TDD)

**Files:**
- Create: `server/src/production.finalise.test.js`
- Modify: `server/src/helpers.js` (add two exports)

- [ ] **Step 1: Write the failing test**

Create `server/src/production.finalise.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finaliseBlock, reopenBlock } from './helpers.js';

test('finaliseBlock: allows an open, artwork-locked, not-yet-finalised card', () => {
  assert.equal(finaliseBlock({ status: 'open', finalised_at: null, artwork_locked: 1 }), null);
});

test('finaliseBlock: blocks when artwork is not locked', () => {
  assert.match(finaliseBlock({ status: 'open', finalised_at: null, artwork_locked: 0 }), /Artwork must be locked/);
});

test('finaliseBlock: blocks a closed card', () => {
  assert.match(finaliseBlock({ status: 'closed', finalised_at: null, artwork_locked: 1 }), /Closed/);
});

test('finaliseBlock: blocks an already-finalised card', () => {
  assert.match(finaliseBlock({ status: 'open', finalised_at: '2026-07-08T00:00:00Z', artwork_locked: 1 }), /already finalised/);
});

test('reopenBlock: allows a finalised card with no started stage', () => {
  assert.equal(reopenBlock({ status: 'open', finalised_at: '2026-07-08T00:00:00Z', started: false }), null);
});

test('reopenBlock: blocks when a stage has started', () => {
  assert.match(reopenBlock({ status: 'in_progress', finalised_at: '2026-07-08T00:00:00Z', started: true }), /stage has already started/);
});

test('reopenBlock: blocks a card that is not finalised', () => {
  assert.match(reopenBlock({ status: 'open', finalised_at: null, started: false }), /not finalised/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && node --test src/production.finalise.test.js`
Expected: FAIL — `finaliseBlock`/`reopenBlock` are not exported (import error / undefined).

- [ ] **Step 3: Implement the guards**

Append to `server/src/helpers.js`:

```js
// Job Card finalisation guards — pure so they are unit-testable and reused by
// the finalise/reopen endpoints. `artwork_locked` and `started` are computed
// from joins/queries by the caller.
export function finaliseBlock({ status, finalised_at, artwork_locked }) {
  if (status === 'closed') return 'Closed job cards cannot be finalised';
  if (finalised_at) return 'Job card is already finalised';
  if (!artwork_locked) return 'Artwork must be locked before the job card can be finalised';
  return null;
}

export function reopenBlock({ status, finalised_at, started }) {
  if (!finalised_at) return 'Job card is not finalised';
  if (status === 'closed') return 'Closed job cards cannot be reopened';
  if (started) return 'A stage has already started — reverse the stage instead of reopening the card';
  return null;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd server && node --test src/production.finalise.test.js`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 5: Checkpoint** — guards green. Stop.

---

## Task 3: Expand `JC_VIEW` and attach `jc.tools`

**Files:**
- Modify: `server/src/routes/production.js` (the `JC_VIEW` constant ~19-50; the two detail endpoints)

- [ ] **Step 1: Add the inherited columns to `JC_VIEW`**

In `server/src/routes/production.js`, in the `JC_VIEW` SELECT list, replace this line:

```js
  SELECT jc.*, p.name AS product_name, p.code AS product_code, p.ups, p.size, p.colors,
         p.child_l, p.child_w,
```

with:

```js
  SELECT jc.*, p.name AS product_name, p.code AS product_code, p.ups, p.size, p.colors,
         p.child_l, p.child_w, p.gsm, p.coating, p.special,
         ol.sheets_required, ol.parent_sheets_required, ol.planned_date,
         ol.artwork_customer_ok, ol.artwork_qa_ok, ol.artwork_locked,
```

(These come from `products p` and `order_lines ol`, both already joined. `jc.*` already carries `finalised_at` after Task 1.)

- [ ] **Step 2: Add a tools-attach helper and use it in both detail endpoints**

In `server/src/routes/production.js`, directly after the `JC_VIEW` template literal (before `r.get('/job-cards'…`), add:

```js
// Artwork source: every active Tooling Hub record linked to the job's product,
// grouped by family (die / plate / block / shade_card). The Job Card reads these
// live — filling/linking tooling in the hub populates the card automatically.
async function attachTools(jc) {
  jc.tools = await q(`
    SELECT family, code, title, shade_ref, output_no, cylinder_no, emboss_type, colors, zone, condition, location
    FROM tools WHERE product_id=$1 AND active=1 ORDER BY family, id`, [jc.product_id]);
  return jc;
}
```

- [ ] **Step 3: Call it in `GET /job-cards/:id`**

In `r.get('/job-cards/:id', …)`, after the `jc.issues = await q(…)` block and before `res.json(jc)`, add:

```js
    await attachTools(jc);
```

- [ ] **Step 4: Call it in `GET /finished-goods/:jobCardId`**

In `r.get('/finished-goods/:jobCardId', …)`, after `jc.lots = await q(…)` and before `res.json(jc)`, add:

```js
    await attachTools(jc);
```

- [ ] **Step 5: Verify via API**

With the app running, obtain a token and read one job card:

```bash
TOKEN=$(curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@ci.local","password":"admin123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
ID=$(curl -s localhost:4000/api/job-cards -H "authorization: Bearer $TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].id')
curl -s "localhost:4000/api/job-cards/$ID" -H "authorization: Bearer $TOKEN" \
  | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); JSON.stringify({gsm:j.gsm,coating:j.coating,special:j.special,sheets_required:j.sheets_required,planned_date:j.planned_date,artwork_locked:j.artwork_locked,finalised_at:j.finalised_at,tools:j.tools},null,2)'
```

Expected: JSON showing the new keys present (values may be null where masters are empty) and a `tools` array (possibly empty if the product has no linked tooling).

- [ ] **Step 6: Checkpoint** — detail payload carries inherited fields + tools. Stop.

---

## Task 4: Finalise / Reopen endpoints + PUT guard

**Files:**
- Modify: `server/src/routes/production.js` (import guards; add two endpoints; guard `PUT /job-cards/:id`)

- [ ] **Step 1: Import the guards**

In `server/src/routes/production.js`, extend the helpers import. Change:

```js
import { audit, setLineStatus, consumeFifo, fgReceipt, createJobCardForLine, splitGangParentJob, findOrCreateLeftoverMaster } from '../helpers.js';
```

to add `finaliseBlock, reopenBlock`:

```js
import { audit, setLineStatus, consumeFifo, fgReceipt, createJobCardForLine, splitGangParentJob, findOrCreateLeftoverMaster, finaliseBlock, reopenBlock } from '../helpers.js';
```

- [ ] **Step 2: Guard `PUT /job-cards/:id` against edits after finalise**

In `r.put('/job-cards/:id', …)`, inside the `tx` callback, immediately after the existing closed-status check:

```js
      if (jc.status === 'closed') throw Object.assign(new Error('Closed job cards cannot be edited'), { status: 409 });
```

add:

```js
      if (jc.finalised_at) throw Object.assign(new Error('This job card is finalised. Reopen it before editing the fields.'), { status: 409 });
```

- [ ] **Step 3: Add the finalise and reopen endpoints**

In `server/src/routes/production.js`, add these two routes immediately after the `PUT /job-cards/:id` handler (after its closing `});`):

```js
// Finalise — the operator confirms the inherited data is correct and commits the
// editable fields. Requires artwork locked; the card becomes a read-only
// document and can be routed onward. Live join means specs still reflect masters.
r.post('/job-cards/:id/finalise', canPlan, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const jc = await oc(`
        SELECT jc.status, jc.finalised_at, ol.artwork_locked
        FROM job_cards jc JOIN order_lines ol ON ol.id = jc.order_line_id
        WHERE jc.id=$1 FOR UPDATE OF jc`, [req.params.id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      const block = finaliseBlock(jc);
      if (block) throw Object.assign(new Error(block), { status: 409 });
      await qc('UPDATE job_cards SET finalised_at=now() WHERE id=$1', [req.params.id]);
      await audit('job_card', +req.params.id, 'finalised', 'Job card finalised', qc, req.user.name);
    });
    const jc = await one(`${JC_VIEW} WHERE jc.id=$1`, [req.params.id]);
    jc.stages = await q(`SELECT js.*, m.name AS stage_machine_name FROM job_stages js
      LEFT JOIN machines m ON m.id=js.machine_id WHERE js.job_card_id=$1 ORDER BY js.seq`, [jc.id]);
    res.json(jc);
  } catch (e) { next(e); }
});

// Reopen — reverts finalisation so the editable fields can be corrected. Only
// while no stage has started and the card is not closed.
r.post('/job-cards/:id/reopen', canPlan, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const jc = await oc('SELECT status, finalised_at FROM job_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      const started = await oc(`
        SELECT 1 FROM job_stages WHERE job_card_id=$1 AND status IN ('in_progress','hold','completed') LIMIT 1`, [req.params.id]);
      const block = reopenBlock({ ...jc, started: !!started });
      if (block) throw Object.assign(new Error(block), { status: 409 });
      await qc('UPDATE job_cards SET finalised_at=NULL WHERE id=$1', [req.params.id]);
      await audit('job_card', +req.params.id, 'reopened', 'Job card reopened for editing', qc, req.user.name);
    });
    const jc = await one(`${JC_VIEW} WHERE jc.id=$1`, [req.params.id]);
    jc.stages = await q(`SELECT js.*, m.name AS stage_machine_name FROM job_stages js
      LEFT JOIN machines m ON m.id=js.machine_id WHERE js.job_card_id=$1 ORDER BY js.seq`, [jc.id]);
    res.json(jc);
  } catch (e) { next(e); }
});
```

- [ ] **Step 4: Verify the endpoints**

With the app running and `$TOKEN`/`$ID` from Task 3 (pick a card whose `artwork_locked` is truthy; if none, lock one in the Artwork page first):

```bash
curl -s -X POST "localhost:4000/api/job-cards/$ID/finalise" -H "authorization: Bearer $TOKEN" \
  | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.finalised_at ? "FINALISED "+j.finalised_at : "ERR "+JSON.stringify(j)'
curl -s -X POST "localhost:4000/api/job-cards/$ID/reopen" -H "authorization: Bearer $TOKEN" \
  | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.finalised_at===null ? "REOPENED" : "ERR "+JSON.stringify(j)'
```

Expected: first prints `FINALISED <timestamp>`, second prints `REOPENED`.
Also confirm the guard: finalise the card again, then `PUT` it — expect HTTP 409 with the "finalised" message:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X PUT "localhost:4000/api/job-cards/$ID" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"qty_planned":9999}'
```

Expected (after re-finalising): `409`. Reopen it again to leave clean state.

- [ ] **Step 5: Checkpoint** — endpoints + guard behave. Stop.

---

## Task 5: Tooling Hub — capture `output_no` / `cylinder_no`

**Files:**
- Modify: `server/src/routes/tooling.js` (the `FIELDS` array ~17; the `INSERT` in `POST /tools`; the `PUT /tools/:id` update)
- Modify: `client/src/pages/Tooling.jsx` (tool create/edit form)

- [ ] **Step 1: Allow the fields server-side (PUT)**

In `server/src/routes/tooling.js`, the `FIELDS` array currently is:

```js
  'ups', 'sheet_size', 'carton_size', 'colors', 'emboss_type', 'shade_ref', 'active'];
```

Change to:

```js
  'ups', 'sheet_size', 'carton_size', 'colors', 'emboss_type', 'shade_ref', 'output_no', 'cylinder_no', 'active'];
```

- [ ] **Step 2: Allow the fields on create (POST /tools)**

In `POST /tools`, extend the INSERT. Change the column list + values (around lines 122-128) from:

```js
        INSERT INTO tools (family, code, title, product_id, maker, condition, location, notes,
                           ups, sheet_size, carton_size, colors, emboss_type, shade_ref)
```

Locate the `VALUES ($1 … )` and the trailing value expressions; append two params. Concretely, change the INSERT column list to end with `… emboss_type, shade_ref, output_no, cylinder_no)`, extend the `VALUES` placeholder list by two (`$15, $16`), and append to the params array (after `req.body.shade_ref || null`):

```js
         req.body.output_no || null, req.body.cylinder_no || null]);
```

Verify the placeholder count matches the params array length after the edit.

- [ ] **Step 3: Add the inputs to the Tooling form**

In `client/src/pages/Tooling.jsx`, find the tool create/edit form state and its field grid. Add `output_no` and `cylinder_no` to the form's initial state (default `''`), and render two `Field`/`Input`s in the same grid, shown for the artwork families:

```jsx
{['plate', 'block', 'shade_card', 'die'].includes(form.family) && (
  <>
    <Field label="Output / Positive No">
      <Input value={form.output_no || ''} onChange={e => setForm({ ...form, output_no: e.target.value })} />
    </Field>
    <Field label="Dye / Cylinder No">
      <Input value={form.cylinder_no || ''} onChange={e => setForm({ ...form, cylinder_no: e.target.value })} />
    </Field>
  </>
)}
```

Ensure these fields are included in the payload sent by the form's create and update handlers (add `output_no: form.output_no, cylinder_no: form.cylinder_no` to the POST/PUT body if the handler enumerates fields explicitly).

- [ ] **Step 4: Verify**

Open `/tooling`, edit a shade-card (or plate) record, set Output No + Cylinder No, save, reopen — the values persist. Or via API:

```bash
TID=$(curl -s "localhost:4000/api/tools?family=shade_card" -H "authorization: Bearer $TOKEN" | node -pe 'const a=JSON.parse(require("fs").readFileSync(0)); (a[0]&&a[0].id)||""')
curl -s -X PUT "localhost:4000/api/tools/$TID" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"output_no":"OUT-123","cylinder_no":"CYL-9"}' | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.output_no+" / "+j.cylinder_no'
```

Expected: `OUT-123 / CYL-9` (skip if no shade_card tool exists — create one in the UI first).

- [ ] **Step 5: Checkpoint** — tooling captures the artwork numbers. Stop.

---

## Task 6: Job Card Form modal — inherited panels, Finalise, no stage rail

**Files:**
- Modify: `client/src/pages/Production.jsx` (imports; `saveJobForm` area — add finalise/reopen; the `editing` Modal ~259-317)

- [ ] **Step 1: Add finalise/reopen handlers and helpers**

In `client/src/pages/Production.jsx`, add near the other handlers (after `saveJobForm`):

```jsx
  const finalise = async () => {
    if (!editing) return;
    try {
      const updated = await api.post(`/job-cards/${editing.id}/finalise`, {});
      setEditing(updated);
      toast.success(`${updated.jc_number} finalised`);
      load();
    } catch (e) { toast.error(e.message || 'Could not finalise'); }
  };
  const reopen = async () => {
    if (!editing) return;
    try {
      const updated = await api.post(`/job-cards/${editing.id}/reopen`, {});
      setEditing(updated);
      toast.info(`${updated.jc_number} reopened`);
      load();
    } catch (e) { toast.error(e.message || 'Could not reopen'); }
  };
```

Then refine the edit-guards to also respect finalisation. Replace:

```jsx
  const canSaveEditing = editing && canEditJobCard && editing.status !== 'closed' && !jobHasStarted(editing);
```

with:

```jsx
  const canSaveEditing = editing && canEditJobCard && editing.status !== 'closed' && !jobHasStarted(editing) && !editing.finalised_at;
  const canFinalise = editing && canEditJobCard && !editing.finalised_at && editing.status !== 'closed' && editing.artwork_locked;
  const canReopen = editing && canEditJobCard && !!editing.finalised_at && !jobHasStarted(editing) && editing.status !== 'closed';
```

- [ ] **Step 2: Add a small read-only spec helper component**

At the top of `client/src/pages/Production.jsx` (after imports, before `export default function Production`), add:

```jsx
// Read-only inherited spec cell — label over value, used across the three
// source panels. Inherited data is never editable from the Job Card.
function Spec({ label, children }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-sm font-semibold text-gray-900">{children ?? '—'}</div>
    </div>
  );
}
// Colours read as CMYK for 4-colour process, else N-colour spot.
const colorMode = n => (n === 4 ? 'CMYK' : n ? `${n}C` : '—');
```

- [ ] **Step 3: Import `WorkflowControls` usage inside the modal**

`WorkflowControls` is already imported at the top of `Production.jsx`. No new import needed.

- [ ] **Step 4: Replace the `editing` Modal body**

Replace the entire `<Modal open={!!editing} …> … </Modal>` block (currently ~259-317, the one titled `Job Card Form — …`) with:

```jsx
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing ? `Job Card Form — ${editing.jc_number}` : ''} wide
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>Close</Button>
          {editing && !editing.finalised_at && canEditJobCard &&
            <Button variant="secondary" onClick={saveJobForm} disabled={!canSaveEditing}>Save Changes</Button>}
          {canReopen && <Button variant="secondary" onClick={reopen}>Reopen</Button>}
          {!editing?.finalised_at
            ? <Button onClick={finalise} disabled={!canFinalise}>Finalise Job Card</Button>
            : <Link to={`/production/jobcard/${editing.id}`}><Button><Printer size={14} /> Print</Button></Link>}
        </>}>
        {editing && (() => {
          const t = (fam) => (editing.tools || []).filter(x => x.family === fam);
          const shade = t('shade_card')[0]; const block = t('block')[0]; const plate = t('plate')[0];
          const yieldTxt = editing.children_per_parent > 1 ? `${editing.children_per_parent} print / parent` : '1:1';
          return (
          <div className="space-y-4">
            <div className="ci-summary-panel text-xs">
              {editing.product_name} · {editing.customer_name} · PO {editing.po_number} · delivery {fmt.date(editing.delivery_date)}
            </div>

            {editing.finalised_at
              ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
                  Finalised {fmt.date(editing.finalised_at)} — inherited data is read-only. Reopen to edit fields.
                </div>
              : !editing.artwork_locked
                ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                    Artwork is not locked yet — finalise once customer + QA approvals are in.
                  </div>
                : null}

            {/* Editable fields */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Editable job fields</span><span>{fmt.title(editing.status)}</span></div>
              <div className="ci-form-grid">
                <Field label="Planned Quantity">
                  <Input type="number" min="1" value={jobForm.qty_planned} disabled={!canSaveEditing}
                    onChange={e => setJobForm({ ...jobForm, qty_planned: e.target.value })} />
                </Field>
                <Field label="Sheets Issued">
                  <Input type="number" min="0" value={jobForm.sheets_issued} disabled={!canSaveEditing}
                    onChange={e => setJobForm({ ...jobForm, sheets_issued: e.target.value })} />
                </Field>
                <Field label="Press / Machine">
                  <Select value={jobForm.machine_id} disabled={!canSaveEditing}
                    onChange={e => setJobForm({ ...jobForm, machine_id: e.target.value })}>
                    <option value="">No press assigned</option>
                    {machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </Select>
                </Field>
                <Field label="Job Status">
                  <Input value={fmt.title(editing.status)} disabled readOnly />
                </Field>
              </div>
            </section>

            {/* Inherited — Planning */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Planning Engine</span><span className="text-gray-400">Plan {fmt.date(editing.planned_date) || '—'}</span></div>
              <div className="ci-form-grid">
                <Spec label="Ordered Qty">{fmt.num(editing.line_qty)} cartons</Spec>
                <Spec label="Sheets Required">{editing.sheets_required != null ? fmt.num(editing.sheets_required) : '—'}</Spec>
                <Spec label="Parent Sheets Issued">{fmt.num(editing.sheets_issued)}</Spec>
                <Spec label="Print Sheets / Parent">{yieldTxt}</Spec>
                <Spec label="Press">{editing.machine_name || '—'}</Spec>
                <Spec label="Delivery">{fmt.date(editing.delivery_date)}</Spec>
              </div>
            </section>

            {/* Inherited — Artwork */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Artwork Module</span>
                <span className={editing.artwork_locked ? 'text-emerald-600' : 'text-gray-400'}>{editing.artwork_locked ? 'Locked' : 'Open'}</span></div>
              <div className="ci-form-grid">
                <Spec label="Customer Approval">{editing.artwork_customer_ok ? '✓ Approved' : 'Pending'}</Spec>
                <Spec label="QA Approval">{editing.artwork_qa_ok ? '✓ Approved' : 'Pending'}</Spec>
                <Spec label="Colours">{colorMode(editing.colors)}</Spec>
                <Spec label="Shade Card No">{shade?.code || '—'}</Spec>
                <Spec label="Shade Ref">{shade?.shade_ref || '—'}</Spec>
                <Spec label="Block No">{block?.code || '—'}</Spec>
                <Spec label="Output No">{plate?.output_no || shade?.output_no || '—'}</Spec>
                <Spec label="Cylinder No">{plate?.cylinder_no || block?.cylinder_no || '—'}</Spec>
                <Spec label="Special Finish">{editing.special && editing.special !== 'none' ? fmt.title(editing.special) : '—'}</Spec>
              </div>
            </section>

            {/* Inherited — Product Master */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Product Master</span><span className="text-gray-400">{editing.product_code}</span></div>
              <div className="ci-form-grid">
                <Spec label="Board">{editing.board_name}{editing.gsm ? ` · ${editing.gsm} GSM` : ''}</Spec>
                <Spec label="Parent Sheet">{editing.sheet_l ? `${editing.sheet_l}×${editing.sheet_w}"` : '—'}</Spec>
                <Spec label="Print Sheet">{editing.child_l ? `${editing.child_l}×${editing.child_w}"` : '—'}</Spec>
                <Spec label="Carton Size">{editing.size || '—'}</Spec>
                <Spec label="Coating / Lam">{editing.coating && editing.coating !== 'none' ? fmt.title(editing.coating) : 'None'}</Spec>
                <Spec label="Die">{editing.die_number ? `#${editing.die_number}${editing.die_location ? ` · ${editing.die_location}` : ''}` : '—'}</Spec>
                <Spec label="UPS">{editing.ups}</Spec>
              </div>
            </section>

            {/* Push to next stages — only once finalised */}
            {editing.finalised_at && editing.status !== 'closed' && (
              <section className="ci-form-panel">
                <div className="ci-form-panel-title"><span>Route to production</span><span className="text-gray-400">Finalised</span></div>
                <div className="flex justify-end">
                  <WorkflowControls jobCard={editing} context="jobcard" onDone={load} />
                </div>
              </section>
            )}
          </div>
          );
        })()}
      </Modal>
```

Note: `editing` must be the full detail object (with `tools`). Update `openJobForm` to fetch the detail so `tools`/inherited fields are present — change:

```jsx
  const openJobForm = jc => {
    setEditing(jc);
    setJobForm({
      qty_planned: jc.qty_planned ?? '',
      sheets_issued: jc.sheets_issued ?? '',
      machine_id: jc.machine_id || '',
    });
  };
```

to:

```jsx
  const openJobForm = async jc => {
    const full = await api.get(`/job-cards/${jc.id}`).catch(() => jc);
    setEditing(full);
    setJobForm({
      qty_planned: full.qty_planned ?? '',
      sheets_issued: full.sheets_issued ?? '',
      machine_id: full.machine_id || '',
    });
  };
```

- [ ] **Step 5: Verify in the preview**

Start the `ci-erp` server (preview_start `ci-erp`), open `/production`, click a job card row. Confirm:
- Three inherited panels render (Planning / Artwork / Product Master), all read-only.
- **No stage rail** in the modal.
- A locked-artwork card shows an enabled **Finalise Job Card** button; clicking it flips the card to the emerald "Finalised" banner, locks the editable fields, reveals **Route to production** with the WorkflowControls buttons, and shows **Reopen** + **Print**.
- **Reopen** returns it to editable.
- Check `preview_console_logs` for errors (expect none).

- [ ] **Step 6: Checkpoint** — modal behaves end-to-end. Stop.

---

## Task 7: Clean stage-free PDF (`JobCardPrint.jsx`)

**Files:**
- Modify: `client/src/pages/JobCardPrint.jsx` (full rebuild of the document body)

- [ ] **Step 1: Replace the component body**

Replace the whole return/JSX of `client/src/pages/JobCardPrint.jsx` with a stage-free, 3-source layout. Replace everything from `const spec = [` through the end of the component with:

```jsx
  const t = (fam) => (jc.tools || []).filter(x => x.family === fam);
  const shade = t('shade_card')[0]; const block = t('block')[0]; const plate = t('plate')[0];
  const colorMode = jc.colors === 4 ? 'CMYK' : jc.colors ? `${jc.colors}C` : '—';
  const yieldTxt = jc.children_per_parent > 1 ? `${jc.children_per_parent} print sheets / parent` : '1:1';

  const planning = [
    ['Ordered Qty', `${fmt.num(jc.line_qty)} cartons`],
    ['Planned Qty', fmt.num(jc.qty_planned)],
    ['Parent Sheets Issued', fmt.num(jc.sheets_issued)],
    ['Sheets Required', jc.sheets_required != null ? fmt.num(jc.sheets_required) : '—'],
    ['Print Sheets / Parent', yieldTxt],
    ['Press', jc.machine_name || '—'],
    ['Planned Date', fmt.date(jc.planned_date) || '—'],
    ['Delivery', fmt.date(jc.delivery_date)],
  ];
  const artwork = [
    ['Customer Approval', jc.artwork_customer_ok ? 'Approved' : 'Pending'],
    ['QA Approval', jc.artwork_qa_ok ? 'Approved' : 'Pending'],
    ['Lock', jc.artwork_locked ? 'Locked' : 'Open'],
    ['Colours', colorMode],
    ['Shade Card No', shade?.code || '—'],
    ['Shade Ref', shade?.shade_ref || '—'],
    ['Block No', block?.code || '—'],
    ['Output No', plate?.output_no || shade?.output_no || '—'],
    ['Cylinder No', plate?.cylinder_no || block?.cylinder_no || '—'],
    ['Special Finish', jc.special && jc.special !== 'none' ? fmt.title(jc.special) : '—'],
  ];
  const product = [
    ['Product Code', jc.product_code],
    ['Board', `${jc.board_name}${jc.gsm ? ` · ${jc.gsm} GSM` : ''}`],
    ['Parent Sheet', jc.sheet_l ? `${jc.sheet_l}×${jc.sheet_w}"` : '—'],
    ['Print Sheet', jc.child_l ? `${jc.child_l}×${jc.child_w}"` : '—'],
    ['Carton Size', jc.size || '—'],
    ['Coating / Lamination', jc.coating && jc.coating !== 'none' ? fmt.title(jc.coating) : 'None'],
    ['Die', jc.die_number ? `#${jc.die_number}${jc.die_location ? ` · ${jc.die_location}` : ''}` : '—'],
    ['Ups / Print Sheet', jc.ups],
  ];

  const Block = ({ title, caption, rows }) => (
    <div className="mt-5">
      <div className="mb-2 flex items-baseline justify-between border-b border-gray-200 pb-1">
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-brand-600">{title}</div>
        <div className="text-[10px] text-gray-400">{caption}</div>
      </div>
      <div className="grid grid-cols-4 gap-x-6 gap-y-2.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k}>
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{k}</div>
            <div className="font-semibold text-gray-900">{v ?? '—'}</div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex justify-between">
        <Link to="/production"><Button variant="secondary"><ArrowLeft size={14} /> Back</Button></Link>
        <Button onClick={() => window.print()}><Printer size={14} /> Print Job Card</Button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-card print:border-0 print:shadow-none">
        {/* Header */}
        <div className="flex items-start justify-between border-b-2 border-ink-900 pb-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand-600">Production Job Card</div>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink-900">{jc.jc_number}</h1>
            <p className="mt-0.5 text-sm text-gray-600">{jc.product_name}</p>
          </div>
          <div className="text-right text-xs text-gray-600">
            <div className="text-sm font-extrabold text-ink-900">COLOUR IMPRESSIONS</div>
            <div>Customer: <b>{jc.customer_name}</b></div>
            <div>PO: <b>{jc.po_number}</b> · Released {fmt.date(jc.created_at)}</div>
            <div className="mt-1 inline-flex gap-1.5">
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold uppercase">{jc.status}</span>
              {jc.finalised_at && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">Finalised</span>}
            </div>
          </div>
        </div>

        <Block title="Planning Engine" caption={`Plan ${fmt.date(jc.planned_date) || '—'}`} rows={planning} />
        <Block title="Artwork Module" caption={jc.artwork_locked ? 'Locked' : 'Open'} rows={artwork} />
        <Block title="Product Master" caption={`Source #${jc.product_id}`} rows={product} />

        {/* Material Issued — compact traceability strip */}
        {jc.issues?.length > 0 && (
          <div className="mt-5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">Material Issued (FIFO)</div>
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-200 text-left text-[10px] font-bold uppercase text-gray-400">
                <th className="py-1">Material</th><th className="py-1">Batch</th>
                <th className="py-1 text-right">Qty</th><th className="py-1 text-right">Issued On</th>
              </tr></thead>
              <tbody>
                {jc.issues.map((i, n) => (
                  <tr key={n} className="border-b border-gray-50">
                    <td className="py-1.5">{i.material_name}</td>
                    <td className="py-1.5 font-mono">{i.batch_no || '—'}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt.num(Math.abs(i.qty))} {i.unit}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt.date(i.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Sign-off */}
        <div className="mt-10 grid grid-cols-3 gap-8 text-center text-xs text-gray-500">
          <div className="border-t border-gray-300 pt-2">Planned By</div>
          <div className="border-t border-gray-300 pt-2">Finalised By</div>
          <div className="border-t border-gray-300 pt-2">QA Release</div>
        </div>
      </div>
    </div>
  );
}
```

(The `GET /job-cards/:id` fetch at the top of the component already provides `jc.tools`, `jc.issues`, and the new inherited fields from Task 3. No import changes — `useEffect`, `api`, `fmt`, `Button`, `Printer`, `ArrowLeft`, `Link` are already imported.)

- [ ] **Step 2: Verify in the preview**

Open `/production/jobcard/<id>` for a finalised card. Confirm:
- Header shows the **Finalised** chip.
- Three source blocks render; **no stages table, no per-stage sign-off grid**.
- Material Issued strip appears only when the job has issues.
- `preview_console_logs` clean; the print button opens the browser print dialog (A4).

- [ ] **Step 3: Checkpoint** — clean PDF renders. Stop.

---

## Self-Review

**Spec coverage:**
- Auto-populate Planning / Artwork / Product Master → Tasks 3, 6, 7 (three source blocks in both modal and PDF). ✓
- Light artwork fields (output/cylinder) captured in Tooling → Tasks 1, 5. ✓
- Live read-only join (no snapshot) → Task 3 (`JC_VIEW` + `attachTools`), all fields render read-only. ✓
- Read-only integrity (no write-back from card) → Task 6 (inherited panels are display-only; PUT guarded). ✓
- Finalise action gating edits + revealing push → Tasks 4, 6. ✓
- Push to next stages at form level → Task 6 (embedded `WorkflowControls`, finalised-only). ✓
- Clean PDF, no stages → Task 7. ✓
- Remove stage rail from form → Task 6. ✓
- Source/version traceability → panel/block captions in Tasks 6, 7. ✓

**Placeholder scan:** none — all steps carry concrete code/commands.

**Type consistency:** `finaliseBlock`/`reopenBlock` signatures match between Task 2 (definition/tests) and Task 4 (callers). `attachTools` returns `jc.tools` used identically in Tasks 6 & 7. `editing.finalised_at` / `artwork_locked` / `tools` come from the Task 3 payload consumed in Task 6. Field names (`output_no`, `cylinder_no`) consistent across Tasks 1, 5, 6, 7.

**Note on no-commits:** every "Checkpoint" replaces a commit per project rule; nothing is committed.
