# Tooling Hub — Seamless Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Tooling Hub hard state clarity (scrapped tools leave the live board for an Archive Hub) and a fast, semi-automated shade-card logistics loop (Triage → Control Dock → On Press → auto/one-tap → Vault).

**Architecture:** Additive-only DB columns on `tools`; DB-free guard logic in a new pure module (`shade-dock.js`) that unit-tests like `tooling-gate.js`; three new tooling endpoints + one hook in the stage-completion handler; all UI in the existing `client/src/pages/Tooling.jsx` plus one inline `ShadeDock` component. No new zones (the `zone` CHECK constraint stays intact) — shade-card states map onto the four existing zones via flags.

**Tech Stack:** Node/Express, `pg`, embedded-postgres, `node:test` (pure unit tests only), React + Vite, Tailwind, lucide-react.

**PROJECT RULES (override skill defaults):**
- **No git commits.** Every "Checkpoint" step below is a verification checkpoint, NOT a commit. Do not run `git commit`.
- **Work only in this local `ci-erp`** (embedded PG on :5439 / db `cierp`). Never touch the CI-Production/Supabase app.
- **Never run an unscoped DELETE** on :5439. Any seeded test data uses a `UAT-` marker and cleanup is scoped to that marker.
- The running server may not hot-reload; server routes are verified via a **temporary server on a spare port** reusing live PG :5439.

**Spec:** `docs/superpowers/specs/2026-07-10-tooling-hub-enhancement-design.md`

---

## File Structure

- **Modify** `server/src/db.js` — add 6 `ADD COLUMN IF NOT EXISTS` migrations to the `tools` table (in the existing migrations block ~L480+).
- **Create** `server/src/shade-dock.js` — pure guard functions (`issueBlocker`, `returnBlocker`, `SHADE_ISSUE_ZONES`). DB-free.
- **Create** `server/src/shade-dock.test.js` — `node:test` unit tests for the guards.
- **Modify** `server/src/routes/tooling.js` — extend `TOOL_VIEW` joins; add `POST /tools/:id/issue`, `POST /tools/:id/return-to-vault`, `GET /tooling/print-stations`.
- **Modify** `server/src/routes/production.js` — auto-return hook inside `POST /job-stages/:id/complete` (~L534).
- **Modify** `client/src/pages/Tooling.jsx` — Part A (Archive Hub + scrapped muting/restore) and Part B (shade-card Control Dock, On Press readout, Vault). Includes a new inline `ShadeDock` component defined in this same file (the file already holds `ToolCard`, `Spotlight`, `ToolForm`).

---

## Task 1: Additive DB columns + TOOL_VIEW joins

**Files:**
- Modify: `server/src/db.js` (migrations block, after the last `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` line ~L496)
- Modify: `server/src/routes/tooling.js:20-28` (`TOOL_VIEW`)

- [ ] **Step 1: Add the migrations**

In `server/src/db.js`, find the migrations block (the run of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements that starts near L484). Append these six lines to that same SQL string, alongside the others:

```sql
ALTER TABLE tools ADD COLUMN IF NOT EXISTS issued_machine_id  INTEGER REFERENCES machines(id);
ALTER TABLE tools ADD COLUMN IF NOT EXISTS issued_operator    TEXT;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS issued_job_card_id INTEGER REFERENCES job_cards(id);
ALTER TABLE tools ADD COLUMN IF NOT EXISTS issued_at          TIMESTAMPTZ;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS verified           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS verified_at        TIMESTAMPTZ;
```

- [ ] **Step 2: Extend `TOOL_VIEW` to expose the issued machine + linked job card**

In `server/src/routes/tooling.js`, replace the `TOOL_VIEW` constant (lines 20-28) with:

```js
const TOOL_VIEW = `
  SELECT t.*, p.name AS product_name, p.code AS product_code, c.name AS customer_name,
         EXTRACT(EPOCH FROM (now() - t.zone_since))::bigint AS zone_seconds,
         im.name AS issued_machine_name, ijc.jc_number AS issued_jc_number,
         le.action AS last_action, le.user_name AS last_user, le.at AS last_at
  FROM tools t
  LEFT JOIN products p ON p.id = t.product_id
  LEFT JOIN customers c ON c.id = p.customer_id
  LEFT JOIN machines im ON im.id = t.issued_machine_id
  LEFT JOIN job_cards ijc ON ijc.id = t.issued_job_card_id
  LEFT JOIN LATERAL (SELECT action, user_name, at FROM tool_events
                     WHERE tool_id = t.id ORDER BY id DESC LIMIT 1) le ON true`;
```

- [ ] **Step 3: Verify migrations apply cleanly (temporary server on a spare port)**

The embedded-postgres data dir is shared with the live app; starting the server runs the migrations. Start a throwaway instance on a spare port so the running app is untouched:

Run:
```bash
cd "server" && PORT=4999 node --watch src/index.js
```
Wait for the "listening" / DB-ready log line, then in another shell confirm the columns exist:
```bash
cd "server" && node -e "import('./src/db.js').then(async m => { const r = await m.q(\`SELECT column_name FROM information_schema.columns WHERE table_name='tools' AND column_name IN ('issued_machine_id','issued_operator','issued_job_card_id','issued_at','verified','verified_at') ORDER BY column_name\`); console.log(r.map(x=>x.column_name)); process.exit(0); })"
```
Expected output (order-independent): all six column names printed:
`[ 'issued_at', 'issued_job_card_id', 'issued_machine_id', 'issued_operator', 'verified', 'verified_at' ]`

Stop the throwaway server (Ctrl-C) once confirmed.

- [ ] **Step 4: Checkpoint (no git commit — project rule)**

Migrations + view join are in place. Nothing to commit. Proceed.

---

## Task 2: Pure guard module `shade-dock.js` (TDD)

**Files:**
- Create: `server/src/shade-dock.js`
- Test: `server/src/shade-dock.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/shade-dock.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { issueBlocker, returnBlocker, SHADE_ISSUE_ZONES } from './shade-dock.js';

const mkCard = (over = {}) => ({
  id: 1, family: 'shade_card', code: 'SC-0001', title: 'Test shade card',
  zone: 'incoming', condition: 'Good', active: 1, ...over,
});

test('SHADE_ISSUE_ZONES: a card may be issued from Triage or the Vault', () => {
  assert.deepEqual(SHADE_ISSUE_ZONES, ['incoming', 'in_rack']);
});

test('issueBlocker: allows a healthy shade card in incoming or in_rack', () => {
  assert.equal(issueBlocker(mkCard()), null);
  assert.equal(issueBlocker(mkCard({ zone: 'in_rack' })), null);
});

test('issueBlocker: blocks non-shade families', () => {
  assert.match(issueBlocker(mkCard({ family: 'die' })), /Only shade cards/);
});

test('issueBlocker: blocks a card already on press or in making', () => {
  assert.match(issueBlocker(mkCard({ zone: 'on_floor' })), /cannot be issued/);
  assert.match(issueBlocker(mkCard({ zone: 'making' })), /cannot be issued/);
});

test('issueBlocker: blocks a scrapped card', () => {
  assert.match(issueBlocker(mkCard({ condition: 'Scrapped' })), /Scrapped/);
});

test('issueBlocker: guards a missing tool', () => {
  assert.match(issueBlocker(null), /not found/);
});

test('returnBlocker: allows only an on-press shade card', () => {
  assert.equal(returnBlocker(mkCard({ zone: 'on_floor' })), null);
  assert.match(returnBlocker(mkCard({ zone: 'incoming' })), /on-press/);
  assert.match(returnBlocker(mkCard({ family: 'plate', zone: 'on_floor' })), /Only shade cards/);
  assert.match(returnBlocker(null), /not found/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd "server" && node --test src/shade-dock.test.js
```
Expected: FAIL — cannot find module `./shade-dock.js` (or import error).

- [ ] **Step 3: Write the minimal implementation**

Create `server/src/shade-dock.js`:

```js
// Pure guards for the Shade Card Control Dock logistics loop. DB-free so it
// unit-tests like tooling-gate.js — the routes import these and throw on a
// non-null blocker. States map onto existing zones: Triage=incoming,
// On Press=on_floor, Vault=in_rack.

export const SHADE_ISSUE_ZONES = ['incoming', 'in_rack']; // Triage or Vault → Press

// Returns a human blocker string, or null when issuing to press is allowed.
export function issueBlocker(tool) {
  if (!tool) return 'Tool not found';
  if (tool.family !== 'shade_card') return 'Only shade cards can be issued to print';
  if (tool.condition === 'Scrapped') return 'Scrapped shade cards cannot be issued';
  if (!SHADE_ISSUE_ZONES.includes(tool.zone)) return `A shade card in ${tool.zone} cannot be issued`;
  return null;
}

// Returns a human blocker string, or null when returning to the vault is allowed.
export function returnBlocker(tool) {
  if (!tool) return 'Tool not found';
  if (tool.family !== 'shade_card') return 'Only shade cards return to the vault';
  if (tool.zone !== 'on_floor') return 'Only an on-press shade card can return to the vault';
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd "server" && node --test src/shade-dock.test.js
```
Expected: PASS — all tests pass (8 tests).

- [ ] **Step 5: Run the whole server suite to confirm nothing else broke**

Run:
```bash
cd "server" && npm test
```
Expected: PASS — existing `tooling-gate.test.js`, `order-lifecycle.test.js`, etc., plus the new file, all green.

- [ ] **Step 6: Checkpoint (no git commit — project rule)**

Guards done and tested. Proceed.

---

## Task 3: Issue + return-to-vault endpoints

**Files:**
- Modify: `server/src/routes/tooling.js` (imports at top; add two routes before `export default r;`)

- [ ] **Step 1: Import the guards**

In `server/src/routes/tooling.js`, the existing import from the gate is:
```js
import { TOOL_FAMILIES, TOOL_ZONES, toolingDetail, toolingGateOk } from '../tooling-gate.js';
```
Add directly beneath it:
```js
import { issueBlocker, returnBlocker } from '../shade-dock.js';
```

- [ ] **Step 2: Add the `issue` endpoint**

In `server/src/routes/tooling.js`, immediately before `export default r;`, add:

```js
// ── Shade Card: Direct Issue to Print ───────────────────────────────────────
// Fast-track a shade card from Triage (or the Vault) straight onto a press with
// an operator, optionally attached to a running job card so it can auto-return
// when that printing stage completes. On-press = on_floor + issued_* set.
r.post('/tools/:id/issue', canMove, async (req, res, next) => {
  try {
    const { machine_id, operator, job_card_id } = req.body;
    if (!machine_id) return res.status(400).json({ error: 'Select a target machine' });
    if (!operator?.trim()) return res.status(400).json({ error: 'Select an operator' });
    const out = await tx(async (qc, oc) => {
      const t = await oc('SELECT * FROM tools WHERE id=$1 FOR UPDATE', [req.params.id]);
      const blk = issueBlocker(t);
      if (blk) throw Object.assign(new Error(blk), { status: t ? 409 : 404 });
      const mach = await oc('SELECT name FROM machines WHERE id=$1', [machine_id]);
      if (!mach) throw Object.assign(new Error('Machine not found'), { status: 404 });
      const [fresh] = await qc(`
        UPDATE tools SET zone='on_floor', zone_since=now(),
          issued_machine_id=$1, issued_operator=$2, issued_job_card_id=$3,
          issued_at=now(), verified=0, verified_at=NULL
        WHERE id=$4 RETURNING *`,
        [machine_id, operator.trim(), job_card_id || null, t.id]);
      await qc(`INSERT INTO tool_events (tool_id, action, from_zone, to_zone, note, user_name)
                VALUES ($1,'issued',$2,'on_floor',$3,$4)`,
        [t.id, t.zone, `${mach.name} · ${operator.trim()}`, req.user.name]);
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Shade Card: Return to Vault (one-tap after a press run) ──────────────────
// On-press → Vault (in_rack) marked Verified / In-Storage; issued_* cleared.
r.post('/tools/:id/return-to-vault', canMove, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const t = await oc('SELECT * FROM tools WHERE id=$1 FOR UPDATE', [req.params.id]);
      const blk = returnBlocker(t);
      if (blk) throw Object.assign(new Error(blk), { status: t ? 409 : 404 });
      const [fresh] = await qc(`
        UPDATE tools SET zone='in_rack', zone_since=now(),
          verified=1, verified_at=now(),
          issued_machine_id=NULL, issued_operator=NULL, issued_job_card_id=NULL
        WHERE id=$1 RETURNING *`, [t.id]);
      await qc(`INSERT INTO tool_events (tool_id, action, from_zone, to_zone, note, user_name)
                VALUES ($1,'returned','on_floor','in_rack','Run complete — verified & stored',$2)`,
        [t.id, req.user.name]);
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});
```

- [ ] **Step 3: Verify against live PG on a spare port (scoped UAT card)**

Start the throwaway server: `cd "server" && PORT=4999 node --watch src/index.js`.

In another shell, seed a scoped UAT shade card, issue it, return it, and confirm state — all against a `UAT-` marker so no real data is touched:

```bash
cd "server" && node -e "
import('./src/db.js').then(async m => {
  const { q, one } = m;
  await q(\"DELETE FROM tool_events WHERE tool_id IN (SELECT id FROM tools WHERE code LIKE 'UAT-%')\");
  await q(\"DELETE FROM tools WHERE code LIKE 'UAT-%'\");
  const t = await one(\"INSERT INTO tools (family, code, title, zone, condition) VALUES ('shade_card','UAT-SC-1','UAT dock card','incoming','Good') RETURNING *\");
  const mach = await one(\"SELECT id, name FROM machines WHERE type='printing' AND COALESCE(active,1)=1 ORDER BY id LIMIT 1\");
  console.log('seeded tool', t.id, 'machine', mach && mach.name);
  process.exit(0);
});
"
```

Then exercise the endpoints (auth: login as admin@ci.local / admin123 to get a token). Use the app's existing login route to obtain a JWT, then:
```bash
# Replace <TOKEN>, <TOOL_ID>, <MACHINE_ID> from the seed output / login.
curl -s -X POST localhost:4999/api/tools/<TOOL_ID>/issue \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"machine_id":<MACHINE_ID>,"operator":"UAT Operator"}' | head -c 400; echo
curl -s -X POST localhost:4999/api/tools/<TOOL_ID>/return-to-vault \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" -d '{}' | head -c 400; echo
```
Expected: first call returns the tool with `"zone":"on_floor"`, `issued_operator":"UAT Operator"`, `issued_machine_id` set; second returns `"zone":"in_rack"`, `"verified":1`, `issued_machine_id":null`.

- [ ] **Step 4: Clean up the UAT card (scoped)**

```bash
cd "server" && node -e "import('./src/db.js').then(async m => { await m.q(\"DELETE FROM tool_events WHERE tool_id IN (SELECT id FROM tools WHERE code LIKE 'UAT-%')\"); await m.q(\"DELETE FROM tools WHERE code LIKE 'UAT-%'\"); console.log('cleaned'); process.exit(0); })"
```
Stop the throwaway server.

- [ ] **Step 5: Checkpoint (no git commit — project rule)**

---

## Task 4: `GET /tooling/print-stations` endpoint

**Files:**
- Modify: `server/src/routes/tooling.js` (add route before `export default r;`)

- [ ] **Step 1: Add the endpoint**

In `server/src/routes/tooling.js`, before `export default r;`, add:

```js
// ── Print stations for the Control Dock ─────────────────────────────────────
// Printing machines with their crew, plus the printing job cards currently
// queued/running on each press (attaching one enables shade-card auto-return).
r.get('/tooling/print-stations', async (_req, res, next) => {
  try {
    const machines = await q(`
      SELECT m.id, m.name, m.status,
             COALESCE(ops.operators, '[]'::json) AS operators
      FROM machines m
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY e.name) AS operators
        FROM machine_operators mo JOIN employees e ON e.id = mo.employee_id
        WHERE mo.machine_id = m.id AND e.active = 1) ops ON true
      WHERE m.type = 'printing' AND COALESCE(m.active, 1) = 1
      ORDER BY m.name`);

    const jobs = await q(`
      SELECT js.job_card_id, jc.jc_number, p.name AS product_name,
             COALESCE(js.machine_id, jc.machine_id) AS machine_id
      FROM job_stages js
      JOIN job_cards jc ON jc.id = js.job_card_id
      JOIN products p ON p.id = jc.product_id
      WHERE js.stage = 'printing' AND js.status IN ('pending','in_progress')
        AND COALESCE(js.machine_id, jc.machine_id) IS NOT NULL
      ORDER BY jc.jc_number`);

    res.json({ machines, jobs });
  } catch (e) { next(e); }
});
```

- [ ] **Step 2: Verify shape on the spare-port server**

Start `cd "server" && PORT=4999 node --watch src/index.js`, then:
```bash
curl -s localhost:4999/api/tooling/print-stations | head -c 600; echo
```
Expected: JSON `{ "machines": [ { "id":…, "name":…, "operators":[…] } … ], "jobs": [ … ] }`. `machines` should list the printing presses (CI-1/CI-2/CI-3); `operators` may be `[]` if none assigned. Stop the server.

- [ ] **Step 3: Checkpoint (no git commit — project rule)**

---

## Task 5: Auto-return hook on printing-stage completion

**Files:**
- Modify: `server/src/routes/production.js` inside `POST /job-stages/:id/complete` (~L534), within the existing `tx`.

- [ ] **Step 1: Locate the insertion point**

In `server/src/routes/production.js`, the completion handler updates the stage to `completed` at:
```js
await qc(`UPDATE job_stages SET status='completed', qty_out=$1, qty_scrap=$2, scrap_reason=$3,
```
(around L612). Find that `UPDATE job_stages SET status='completed'...` statement and the lines just after it that finish writing stage results.

- [ ] **Step 2: Add the auto-return block**

Immediately after the stage is marked `completed` (after the `UPDATE job_stages SET status='completed' ...` statement and its awaited call), still inside the same `tx` callback, insert:

```js
      // Auto-return: any shade card issued against THIS job card and still on
      // the press returns to the Vault, Verified, when the printing stage ends.
      if (st.stage === 'printing') {
        const returned = await qc(`
          UPDATE tools SET zone='in_rack', zone_since=now(), verified=1, verified_at=now(),
            issued_machine_id=NULL, issued_operator=NULL, issued_job_card_id=NULL
          WHERE family='shade_card' AND zone='on_floor' AND issued_job_card_id=$1
          RETURNING id`, [st.job_card_id]);
        for (const row of returned) {
          await qc(`INSERT INTO tool_events (tool_id, action, from_zone, to_zone, note, user_name)
                    VALUES ($1,'returned','on_floor','in_rack','Print run completed — auto-returned & verified',$2)`,
            [row.id, req.user.name]);
        }
      }
```

Note: `st` (the stage row, with `st.stage` and `st.job_card_id`) and `qc` / `req.user.name` are already in scope in this handler — confirm by reading the surrounding code before inserting.

- [ ] **Step 3: Verify the hook end-to-end on the spare-port server (scoped UAT)**

Start `cd "server" && PORT=4999 node --watch src/index.js`. This test needs a job card with an in-progress printing stage. Rather than fabricate a full job, drive the SQL directly to prove the hook query is correct against real schema:

```bash
cd "server" && node -e "
import('./src/db.js').then(async m => {
  const { q, one } = m;
  // pick any existing job card to borrow its id for the link
  const jc = await one(\"SELECT id FROM job_cards ORDER BY id LIMIT 1\");
  if (!jc) { console.log('no job cards — create one via the app first'); process.exit(0); }
  await q(\"DELETE FROM tool_events WHERE tool_id IN (SELECT id FROM tools WHERE code LIKE 'UAT-%')\");
  await q(\"DELETE FROM tools WHERE code LIKE 'UAT-%'\");
  const t = await one(\"INSERT INTO tools (family, code, title, zone, condition, issued_job_card_id) VALUES ('shade_card','UAT-SC-2','UAT auto card','on_floor','Good',\$1) RETURNING *\", [jc.id]);
  // run the exact hook query
  const returned = await q(\"UPDATE tools SET zone='in_rack', verified=1, verified_at=now(), issued_job_card_id=NULL WHERE family='shade_card' AND zone='on_floor' AND issued_job_card_id=\$1 RETURNING id, zone, verified\", [jc.id]);
  console.log('returned', returned);
  await q(\"DELETE FROM tool_events WHERE tool_id=\$1\", [t.id]);
  await q(\"DELETE FROM tools WHERE id=\$1\", [t.id]);
  console.log('cleaned'); process.exit(0);
});
"
```
Expected: `returned [ { id: …, zone: 'in_rack', verified: 1 } ]` then `cleaned`. This proves the UPDATE matches on the real schema. (Full click-through of a printing stage completion is exercised in Task 8.) Stop the server.

- [ ] **Step 4: Run the server suite (nothing pure changed, but confirm no syntax break)**

Run: `cd "server" && npm test`
Expected: PASS.

- [ ] **Step 5: Checkpoint (no git commit — project rule)**

---

## Task 6: Client Part A — Scrapped → Archive Hub

**Files:**
- Modify: `client/src/pages/Tooling.jsx`

- [ ] **Step 1: Exclude scrapped from the live board/ledger and compute the scrapped set**

In `client/src/pages/Tooling.jsx`, the `tools` memo (lines ~391-394) currently filters by family + product. Replace it with a version that drops scrapped from the live views, and add a separate `scrapped` memo:

```js
  const isArchive = tab === '__archive';
  const tools = useMemo(() => data.tools
    .filter(t => t.family === tab)
    .filter(t => t.condition !== 'Scrapped')
    .filter(t => !productFilter || t.product_id === productFilter || t.id === linkedToolId),
    [data.tools, tab, productFilter, linkedToolId]);
  const scrapped = useMemo(() =>
    data.tools.filter(t => t.condition === 'Scrapped'), [data.tools]);
```

- [ ] **Step 2: Drop Scrapped from "Needs Attention" (it now has the Archive home)**

In the `kpi` memo (lines ~396-402), change the `attention` line from:
```js
    attention: data.tools.filter(t => ['Poor', 'Scrapped'].includes(t.condition)
      || (t.zone === 'making' && t.zone_seconds > STALE)).length,
```
to:
```js
    attention: data.tools.filter(t => t.condition === 'Poor'
      || (t.zone === 'making' && t.zone_seconds > STALE)).length,
```

- [ ] **Step 3: Add the Archive tab to the family tab strip**

The family `Tabs` is rendered (lines ~461-463) from `FAMILY_META`. Replace that `<Tabs .../>` call with one that appends an Archive tab carrying the scrapped count:

```js
        <Tabs active={tab} onChange={setTab} tabs={[
          ...Object.entries(FAMILY_META).map(([k, m]) => ({ key: k, label: m.plural, count: counts[k] })),
          { key: '__archive', label: 'Archive', count: scrapped.length },
        ]} />
```

- [ ] **Step 4: Add the muted `ScrappedCard` component**

Near the other card components (after `ToolCard`, ~line 129), add:

```jsx
// A retired tool — muted, struck through, no production affordances. Lives only
// in the Archive Hub. Click opens the (read-only) Spotlight with Restore.
function ScrappedCard({ t, onOpen }) {
  const m = FAMILY_META[t.family];
  return (
    <button onClick={() => onOpen(t)}
      className="ci-line-item w-full text-left opacity-50 transition-opacity hover:opacity-80">
      <div className="flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${m.tint}`}>
          <m.icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-bold text-[#1D1D1F] line-through">{t.code}</span>
            <span className="ml-auto shrink-0 rounded-full bg-red-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-red-700">Scrapped</span>
          </span>
          <span className="block truncate text-[11px] leading-4 text-[#86868B] line-through">{t.title}</span>
        </span>
      </div>
    </button>
  );
}
```

- [ ] **Step 5: Render the Archive Hub when the Archive tab is active**

The content region currently branches `view === 'board' ? (...board...) : (...ledger...)` (lines ~476-525). Wrap it so Archive takes priority. Replace the opening `{view === 'board' ? (` with:

```jsx
      {isArchive ? (
        <div className="space-y-5">
          {scrapped.length === 0 && (
            <p className="glass rounded-[22px] py-12 text-center text-sm text-[#AEAEB2]">
              Nothing scrapped — the Archive is empty.
            </p>
          )}
          {Object.entries(FAMILY_META).map(([fam, m]) => {
            const rows = scrapped.filter(t => t.family === fam);
            if (!rows.length) return null;
            return (
              <div key={fam}>
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#86868B]">
                  <m.icon size={13} /> {m.plural} <span className="text-[#C7C7CC]">· {rows.length}</span>
                </p>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {rows.map(t => <ScrappedCard key={t.id} t={t} onOpen={setSpot} />)}
                </div>
              </div>
            );
          })}
        </div>
      ) : view === 'board' ? (
```

Leave the existing board and ledger branches as the remaining `: (...)` arms (the final ternary structure becomes `isArchive ? (...) : view === 'board' ? (...) : (...)`). Verify the closing parens/braces still balance after the edit.

- [ ] **Step 6: Hide the view toggle + product filter chip while in Archive**

The row holding `<SubTabs ... />` and the product-filter chip (lines ~464-473) should not show in Archive. Wrap the `SubTabs` (and keep the family `Tabs` always visible) so the toggle only renders off-Archive. Change:
```jsx
        <SubTabs className="mb-4" active={view} onChange={setView} views={[
          { key: 'board', label: 'Board', icon: LayoutGrid },
          { key: 'ledger', label: 'Ledger', icon: List },
        ]} />
```
to:
```jsx
        {!isArchive && <SubTabs className="mb-4" active={view} onChange={setView} views={[
          { key: 'board', label: 'Board', icon: LayoutGrid },
          { key: 'ledger', label: 'Ledger', icon: List },
        ]} />}
```

- [ ] **Step 7: In the Spotlight, disable production actions + add Restore for scrapped tools**

In `Spotlight` (lines ~132-262), add a `scrapped` flag and a `restore` handler at the top of the component body (after `const m = FAMILY_META[tool.family];`):

```js
  const scrapped = tool.condition === 'Scrapped';
  const restore = async () => {
    await api.put(`/tools/${tool.id}`, { condition: 'Fair' });
    toast.success(`${tool.code} restored to the board`);
    onChanged(); onClose();
  };
```

Add a red banner + Restore button at the very top of the modal body (just inside `<div className="space-y-4">`):

```jsx
        {scrapped && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-red-50 px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs font-bold text-red-700">
              <AlertTriangle size={14} /> Scrapped — retired from the floor. Production actions are locked.
            </p>
            <Button size="sm" variant="secondary" onClick={restore}><Undo2 size={13} /> Restore</Button>
          </div>
        )}
```

Disable the zone "Move to" buttons for scrapped tools — change the zone button `disabled` prop (line ~213) from:
```jsx
              <button key={z.key} disabled={busy || z.key === tool.zone} onClick={() => move(z.key)}
```
to:
```jsx
              <button key={z.key} disabled={busy || scrapped || z.key === tool.zone} onClick={() => move(z.key)}
```

- [ ] **Step 8: Render the new event actions (`issued` / `returned`) in history**

In the Spotlight history render (lines ~247-252), the action switch ends with `` : `Condition: ${e.note}` ``. Extend it so issue/return/delete read cleanly:

```jsx
                  {e.action === 'moved' ? `${e.from_zone ? fmt.title(e.from_zone) + ' → ' : ''}${fmt.title(e.to_zone)}`
                    : e.action === 'created' ? 'Created'
                    : e.action === 'undo' ? `Undo → ${fmt.title(e.to_zone)}`
                    : e.action === 'issued' ? `Issued to press${e.note ? ` — ${e.note}` : ''}`
                    : e.action === 'returned' ? `Returned to Vault${e.note ? ` — ${e.note}` : ''}`
                    : e.action === 'deleted' ? 'Deleted'
                    : `Condition: ${e.note}`}
```

- [ ] **Step 9: Verify Part A in the running app**

Ensure the dev servers are running (`npm run dev` from the repo root, per `Start CI ERP.command`). If a preview server config exists, use it; otherwise open the app, log in (admin@ci.local / admin123), and go to Tooling Hub. Verify:
- Marking any tool **Scrapped** (Spotlight → Condition → Scrapped) removes it from its zone column and the Archive tab count increments.
- The **Archive** tab shows the tool as a muted, struck-through card with a red SCRAPPED pill; the Board/Ledger toggle is hidden there.
- Opening a scrapped card shows the red banner, the zone "Move to" buttons are disabled, and **Restore** returns it to the live board (condition Fair).

Take a screenshot of the Archive tab for the record.

- [ ] **Step 10: Checkpoint (no git commit — project rule)**

---

## Task 7: Client Part B — Shade Card Control Dock & Vault

**Files:**
- Modify: `client/src/pages/Tooling.jsx`

- [ ] **Step 1: Add icon imports + fetch print stations**

At the top `lucide-react` import (lines ~12-15), add `Zap, CheckCircle2, ArrowRight` to the imported set (used by the dock UI). Then in the `Tooling` component, add state + a fetch that loads once the shade-card tab is opened:

```js
  const [stations, setStations] = useState({ machines: [], jobs: [] });
  useEffect(() => {
    if (tab === 'shade_card') api.get('/tooling/print-stations').then(setStations).catch(() => {});
  }, [tab]);
```

- [ ] **Step 2: Add shade-card zone labels**

Near the top-level constants (after `ZONES`, ~line 29), add a per-family zone-label override for shade cards:

```js
// Shade cards ride the same zones but read as a logistics loop.
const SHADE_ZONE_LABEL = { incoming: 'Triage', making: 'Making', in_rack: 'Vault', on_floor: 'On Press' };
```

- [ ] **Step 3: Build the inline `ShadeDock` component**

After the `ScrappedCard` component (from Task 6), add the Control Dock. It renders three shapes depending on the card's zone: a Triage fast-track (expandable assignment drawer), an On-Press readout with one-tap return, and a Vault verified badge. Machines/jobs come from the `stations` prop.

```jsx
// Control Dock — the shade-card fast lane. Triage: expand an inline assignment
// drawer (machine + operator + optional running job) and issue straight to
// press. On Press: dense readout + one-tap return. Vault: Verified badge.
function ShadeDock({ t, stations, onChanged }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [machineId, setMachineId] = useState('');
  const [operator, setOperator] = useState('');
  const [jobId, setJobId] = useState('');
  const [busy, setBusy] = useState(false);

  const machine = stations.machines.find(m => String(m.id) === String(machineId));
  const crew = machine?.operators || [];
  const machineJobs = stations.jobs.filter(j => String(j.machine_id) === String(machineId));

  const issue = async () => {
    if (!machineId) return toast.error('Pick a target machine');
    if (!operator) return toast.error('Pick an operator');
    setBusy(true);
    try {
      await api.post(`/tools/${t.id}/issue`, {
        machine_id: +machineId, operator,
        job_card_id: jobId ? +jobId : undefined,
      });
      toast.success(`${t.code} issued to ${machine.name}`);
      setOpen(false); onChanged();
    } catch (e) { toast.error(e.message || 'Could not issue'); }
    finally { setBusy(false); }
  };
  const returnToVault = async () => {
    setBusy(true);
    try {
      await api.post(`/tools/${t.id}/return-to-vault`, { verified: true });
      toast.success(`${t.code} returned to the Vault`);
      onChanged();
    } catch (e) { toast.error(e.message || 'Could not return'); }
    finally { setBusy(false); }
  };

  if (t.zone === 'on_floor') {
    return (
      <div className="mt-2 rounded-xl border border-indigo-100 bg-indigo-50/60 px-2.5 py-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-indigo-700">
          <Zap size={12} /> {t.issued_machine_name || 'Press'}{t.issued_operator ? ` · ${t.issued_operator}` : ''}
        </p>
        {t.issued_jc_number && (
          <p className="mt-0.5 text-[10px] text-indigo-500">Job {t.issued_jc_number} · auto-returns on print completion</p>
        )}
        <Button size="sm" variant="secondary" className="mt-1.5 w-full" disabled={busy} onClick={returnToVault}>
          <CheckCircle2 size={13} /> Run complete → Vault
        </Button>
      </div>
    );
  }

  if (t.zone === 'in_rack') {
    return (
      <div className="mt-2 flex items-center justify-between gap-2">
        {t.verified
          ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-px text-[10px] font-bold text-emerald-700"><CheckCircle2 size={11} /> Verified · In-Storage</span>
          : <span className="text-[10px] text-[#AEAEB2]">In Vault</span>}
        <button onClick={() => setOpen(o => !o)} className="text-[11px] font-semibold text-[#007AFF] hover:underline">Re-issue</button>
      </div>
    );
  }

  // Triage (incoming) — the fast-track
  return (
    <div className="mt-2">
      {!open ? (
        <Button size="sm" className="w-full" onClick={() => setOpen(true)}>
          <Zap size={13} /> Direct Issue to Print
        </Button>
      ) : (
        <div className="space-y-1.5 rounded-xl border border-[#0A84FF]/20 bg-[#F5F9FF] p-2">
          <Select value={machineId} onChange={e => { setMachineId(e.target.value); setOperator(''); setJobId(''); }}>
            <option value="">Target machine…</option>
            {stations.machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
          <Select value={operator} onChange={e => setOperator(e.target.value)} disabled={!machineId}>
            <option value="">{machineId ? 'Operator…' : 'Pick machine first'}</option>
            {crew.map(o => <option key={o.id} value={o.name}>{o.name}</option>)}
          </Select>
          <Select value={jobId} onChange={e => setJobId(e.target.value)} disabled={!machineId}>
            <option value="">Attach running job (optional)</option>
            {machineJobs.map(j => <option key={j.job_card_id} value={j.job_card_id}>{j.jc_number} · {j.product_name}</option>)}
          </Select>
          <div className="flex gap-1.5">
            <Button size="sm" className="flex-1" disabled={busy} onClick={issue}><ArrowRight size={13} /> Issue</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Relabel shade-card zone columns and mount the dock on each card**

In the board render (lines ~476-496), the zone loop builds each column with `z.label` and maps `zt` to `<ToolCard>`. Make the label shade-aware and, for shade cards, render the `ShadeDock` under each card. Replace the board's zone-map block:

```jsx
          {ZONES.map(z => {
            const zt = tools.filter(t => t.zone === z.key);
            const label = tab === 'shade_card' ? SHADE_ZONE_LABEL[z.key] : z.label;
            return (
              <div key={z.key} className="glass flex flex-col rounded-[22px]">
                <div className="border-b border-[#1D1D1F]/[0.06] px-4 py-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#86868B]">{label}</p>
                    <span className="rounded-full bg-[#1D1D1F]/[0.06] px-2 text-[11px] font-bold tabular-nums text-[#6E6E73]">{zt.length}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#AEAEB2]">{z.desc}</p>
                </div>
                <div className="flex-1 space-y-2 p-3">
                  {zt.length === 0 && <p className="py-6 text-center text-xs text-[#AEAEB2]">Empty</p>}
                  {zt.map(t => (
                    <div key={t.id}>
                      <ToolCard t={t} onOpen={setSpot} onDelete={setDel} />
                      {tab === 'shade_card' && <ShadeDock t={t} stations={stations} onChanged={load} />}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
```

- [ ] **Step 5: Show the verified badge + verified date in the shade-card Spotlight**

In `Spotlight`, the shade-card detail block (lines ~187-205) shows created/approved dates. Add a Verified line when `tool.verified`. Inside that block's `<div className="flex flex-wrap items-center gap-2 ...">`, after the Approved span, add:

```jsx
                {tool.verified === 1 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-px text-[11px] font-bold text-emerald-700">
                    <CheckCircle2 size={11} /> Verified · In-Storage{tool.verified_at ? ` · ${fmt.date(tool.verified_at)}` : ''}
                  </span>
                )}
```

(Ensure `CheckCircle2` is imported per Step 1.)

- [ ] **Step 6: Verify Part B in the running app (scoped UAT)**

With dev servers running, log in and open Tooling Hub → **Shade Cards**. The columns should read **Triage / Making / Vault / On Press**. Create a New Tool (family Shade Card, name `UAT Dock Card`) — it lands in Triage. Then:
- Click **Direct Issue to Print** on its card → the inline drawer expands. Pick a press, an operator, leave the job blank → **Issue**. Card moves to **On Press** and shows the machine · operator readout.
- Click **Run complete → Vault** → card moves to **Vault** with a green **Verified · In-Storage** badge.
- Open the card's Spotlight → History lists `Issued to press …` then `Returned to Vault …`; the Verified badge shows.
- Delete the UAT card when done (Spotlight is not needed — use the card's hover trash on the Vault card, confirm).

Take a screenshot of the shade-card board mid-flow (a card On Press) for the record.

- [ ] **Step 7: Checkpoint (no git commit — project rule)**

---

## Task 8: Full auto-return click-through + regression sweep

**Files:** none (verification only)

- [ ] **Step 1: Exercise the auto-return via a real printing stage**

With dev servers running, use the app to drive a job that has a printing stage to completion, having first issued a UAT shade card **attached to that job card**:
1. In Tooling → Shade Cards, create `UAT Auto Card`, **Direct Issue to Print**, pick the press, operator, and in **Attach running job** select the job card whose printing stage is queued/running on that press → Issue. Card shows "Job … · auto-returns on print completion".
2. On the Floor (printing station), complete that job's **printing** stage as normal.
3. Return to Tooling → Shade Cards: the UAT card should now be in the **Vault**, **Verified**, without anyone tapping "Run complete". Its Spotlight history shows `Returned to Vault — Print run completed — auto-returned & verified`.
4. Delete the UAT card (scoped) when done.

- [ ] **Step 2: Confirm unlinked cards are NOT auto-returned**

Issue a second UAT card to the **same press but with NO job attached**. Complete a printing stage. Verify this card stays **On Press** (only the job-linked one returned). Then tap its **Run complete → Vault** to confirm the manual path still works. Delete it.

- [ ] **Step 3: Regression — the die/plate/block flow is unchanged**

On the Plates/Dies/Blocks tabs, confirm the board still shows four zones with their original labels, zone moves + undo work, and the "Needed for jobs" rail and auto-flip are unaffected. Mark a die Scrapped and confirm it lands in Archive (shared Part-A behaviour), then Restore it.

- [ ] **Step 4: Run the full server test suite one last time**

Run: `cd "server" && npm test`
Expected: PASS — all suites green.

- [ ] **Step 5: Final checkpoint (no git commit — project rule)**

Feature complete: Archive Hub with hard scrapped enforcement, and the shade-card Control Dock loop (issue → on-press → auto/one-tap → verified Vault).

---

## Self-Review notes (author)

- **Spec coverage:** Part A visual muting + SCRAPPED badge + disabled actions (Task 6 Steps 4,7), dedicated Archive tab (Task 6 Steps 3,5), scrapped-only scope (Step 1 filter). Part B Direct Issue to Print + inline assignment drawer (Task 7 Step 3), machine+operator mapping (print-stations Task 4 + dock), auto-return on completion + one-tap fallback (Task 5 + dock On-Press), Vault In-Storage/Verified (Task 7 Steps 3,5). All spec sections map to a task.
- **Type/name consistency:** guard fns `issueBlocker`/`returnBlocker`/`SHADE_ISSUE_ZONES` defined in Task 2 and imported in Task 3; view fields `issued_machine_name`/`issued_jc_number`/`verified`/`verified_at` defined in Task 1 and consumed in Task 7; event actions `issued`/`returned` written in Tasks 3/5 and rendered in Task 6 Step 8. Consistent.
- **No placeholders:** every code step carries full code; verification steps give exact commands + expected output.
