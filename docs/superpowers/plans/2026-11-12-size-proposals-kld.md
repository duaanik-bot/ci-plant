# Size proposals and KLDs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new carton size in a costing gets a die check across both die lists, ranked layout proposals on stocked sheets, and — once one is picked — a KLD saved with the Size Library entry, downloadable as a 1:1 PDF and saved to Drive shared with the company account.

**Architecture:** Pure engine + geometry in `client/src/lib/` (imported by the server too, as `enquiry-cloud.js` already imports `client/src/lib/avs.js`); a `routes/sizing.js` router behind the Costing tick; pdf-lib for the PDF; Drive v3 over the existing encrypted Google link with the extra `drive.file` scope.

**Tech Stack:** Node 20 ESM, Express, pg, pdf-lib, React + Tailwind (Vite), node:test.

**Spec:** `docs/superpowers/specs/2026-11-12-size-proposals-kld-design.md`

## Global Constraints

- No `git commit`, no push, no deploy, no prod migration (project CLAUDE.md). Commit steps below are skipped.
- Public repo: no customer names, prices or real die-register data in code, fixtures or docs; tests invent values.
- Schema: one idempotent dated migration `supabase/migrations/20261112160000_size_kld.sql`, loaded by one line in `server/src/db.js` init().
- Tests: `node --test src/<file>.test.js` from `server/` (never `node --test src/`); PG tests opt-in with `SIZING_PG=1`.
- The Gmail side stays draft-only: nothing new may call Gmail `/send` (gmail-link.test.js guard stays green).
- Units: carton sizes in mm, sheets in inches (25.4 mm), as everywhere else in costing.

## Review Focus

1. A size typed in any order (`100x40x65` vs `65x40x100`) or with a style the engine does not draw (LIT, CUP, NONE) — the panel must say "no proposal for this style" rather than draw a wrong carton. Test in Task 1 (`proposals(...)` returns `{ unsupported: true }` for LIT) and Task 5 (panel text).
2. A size too big for every sheet — proposals come back empty with the reason ("larger than the press window"), never a 0-up card. Task 1.
3. A Google link connected before the Drive permission — "Save to Drive" must answer 409 "connect Google again to allow Drive", not 502. Task 4.
4. Redrawing a KLD after the first save bumps `rev` and keeps the Drive link of the old file visible as superseded; a second Drive save uploads a new file (no overwrite). Task 3 + Task 4.
5. A board row with no grain recorded — proposals must say "grain not recorded" rather than claim it fits. Task 1.

---

### Task 1: Sizing engine (`client/src/lib/sizing.js`)

**Files:** Create `client/src/lib/sizing.js`; Test `server/src/sizing.test.js`

**Interfaces — Produces:**
- `HOUSE_RULES` = `{ glue(w), tuck(w), dust(w,t), lock(w), margin: { gripper: 0, other: 0 }, press: { maxLong: 28, maxShort: 20, minLong: 12, minShort: 10 } }`
- `readings(style, size) → Array<{ key: 'side-open'|'top-open'|'lock', construction: 'RTE'|'LOCK', tube, face, w }>` (SIDE → both readings, LOCK → one, other styles → [])
- `cartonPlan(reading, rules?) → { across, glue, tuck, dust, lock|null, along(n), blank: { across, along } }`
- `layoutOn(plan, sheetLong, sheetShort, acrossOn) → { ups, m, n, spareAcross, spareAlong, needRow, needUp }`
- `sheetLadder(boards) → Array<{ long, short, mill: { id?, long, short, grain|null }, pieces, use, grainSide|null }>` (`grainSide` = which child side carries the grain when the mill's grain is known)
- `proposals({ style, size, boards, gsm, rules? }) → { unsupported?, reason?, readings: [{ reading, plan, options: Array<Option> }] }` where `Option = { sheet: {long, short}, mill, pieces, ups, m, n, acrossOn, sqInPerCarton, gramsPerCarton, spareAcross, spareAlong, grainNeeded: 'long'|'short', grain: 'ok'|'wrong'|'unknown', note }`
- `layoutBlocks(plan, reading, option) → Array<{ x, y, w, h, kind: 'body'|'glue'|'flap' }>` in mm on the sheet (for the picture)

- [ ] **Step 1: Write the failing tests** — `known dies: the plan gives the real ups` (invented-free: sizes only) for these 12 rows, best over readings × orientations: LOCK 131×70×57 on 18×23 → 4; SIDE 85×37×50 on 18×23 → 9; SIDE 75×35×48 on 14×22 → 8; LOCK 120×62×70 on 15×25 → 4; LOCK 85×85×70 on 14×22 → 3; LOCK 158×85×93 on 15.75×20.75 → 2; SIDE 65×40×100 on 19×26 → 8 (top-open); LOCK 135×83×80 on 18×23 → 3; SIDE 125×15×80 on 16×25 → 8; SIDE 165×15×95 on 18×25 → 6; LOCK 165×55×100 on 13.5×18 → 2 (assert `>= real`). Plus: `ladder: 18x23 is half of 23x36 at 100%`; `proposals rank least board first and 92x80x66 LOCK proposes 15x25 4-up`; `85x63x78 LOCK reports the 12x25 near miss (needs about 1.2 mm)`; `LIT is unsupported`; `a 400x300x300 carton has no option and says why`; `grain: mill 23x36 long-grain gives an 18x23 child with grain on the 18 side; unknown grain says unknown`.
- [ ] **Step 2: Run** `cd server && node --test src/sizing.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** from the scratch prototype rules in the spec (pitches exactly as stated there).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — skipped (no commits).

### Task 2: KLD geometry and SVG (`client/src/lib/kld.js`)

**Files:** Create `client/src/lib/kld.js`; Test `server/src/kld.test.js`

**Interfaces — Consumes:** `HOUSE_RULES`, `readings` from Task 1. **Produces:**
- `kldBlank({ construction: 'RTE'|'LOCK', tube, face, w, rules? }) → { width, height, cut: string[], crease: string[], glue: string, dims: Array<{ x1,y1,x2,y2,label,side }>, grain: {x1,y1,x2,y2} }` — SVG path strings in mm, y down, origin at the blank's top-left.
- `kldSvg(blank, { title }) → string` (cut solid, crease dashed, glue hatched, dimensions, legend).

- [ ] **Step 1: Failing tests** — `RTE blank is 2·face + 2·w + glue across and tube + 2(w + tuck) along` (65×40×100 top-open → 220 × 204); `LOCK blank is 2L + 2W + glue across and lock + H + W + tuck along` (92×80×66 → 359 × 205); `every panel crease is drawn` (RTE: 4 body creases + 2 hinge + 2 tuck creases); `the SVG has a viewBox in mm and a cut and a crease layer`.
- [ ] **Step 2: Run** `node --test src/kld.test.js` → FAIL.
- [ ] **Step 3: Implement** (RTE from the scratch prototype; LOCK: crash-lock flaps on L panels W/2+5 deep with a 45° lead, glue tabs on W panels with the diagonal crease, tuck top as RTE).
- [ ] **Step 4: Run** → PASS.

### Task 3: Schema, die register, routes, PDF

**Files:** Create `supabase/migrations/20261112160000_size_kld.sql`, `server/src/routes/sizing.js`, `server/src/kld-pdf.js`, `scripts/load-die-register.mjs`; Modify `server/src/db.js` (one migration line), `server/src/app.js` (mount), `server/src/routes/masters.js:67` (allow `grain`); Test `server/src/kld-pdf.test.js`, `server/src/sizing-pg.test.js`

**Migration:** `costing_sizes.kld jsonb`; `materials.grain text` + CHECK in ('long','short'); `die_register (die_no text PK, l_mm, w_mm, h_mm numeric, style text, ups int, size_text text, source text, loaded_at timestamptz default now())`.

**Routes (all behind `mayCost`):**
- `GET /costing/sizing/proposals?size=&style=&gsm=` → `{ size, dies: { master: {exact, near}, register: {exact, near} }, ...proposals() }` (boards = active board materials with sheet + grain).
- `PUT /costing/sizing/kld` body `{ size_text, style, sheet_l, sheet_w, ups, reading, option }` → upserts the Size Library entry (source 'manual'), stores `kld = { v: 1, rev, construction, reading, tube, face, w, rules, layout, drawn_at, drawn_by, drive: [] }` (rev + 1 when a KLD was there) → `{ size_id, kld }`.
- `GET /costing/sizes/:id/kld` → `{ kld }`; `GET /costing/sizes/:id/kld.pdf` → `application/pdf`.
- Size-check rows carry `has_kld`.

**PDF:** `kldPdf({ blank, kld, title, entity }) → Uint8Array` — page = blank + 30 mm margins (min A4), drawn at 1:1 (1 mm = 72/25.4 pt) with `drawSvgPath`, title block (size, construction, glue/tuck/lock, sheet + ups, rev, date), second page = sheet layout from `layoutBlocks`.

- [ ] **Step 1: Failing tests** — kld-pdf: `starts with %PDF and the first page is at least the blank plus margins`; PG: `proposals list both die lists`, `PUT kld creates the library entry once and bumps rev on redraw`, `the PDF route needs the Costing tick`, `masters saves a board's grain and refuses 'sideways'`.
- [ ] **Step 2: Run** `node --test src/kld-pdf.test.js` and `SIZING_PG=1 node --test src/sizing-pg.test.js` → FAIL.
- [ ] **Step 3: Implement.** Load script: `node scripts/load-die-register.mjs <rows.json> [--apply]` (dry run prints counts; `--apply` upserts via DATABASE_URL); never run against prod without the owner's OK.
- [ ] **Step 4: Run** → PASS.

### Task 4: Drive save and share

**Files:** Create `server/src/gdrive.js`; Modify `server/src/gmail.js` (consent asks Gmail + drive.file; `exchangeCode` still requires only the Gmail scopes), `server/src/routes/sizing.js`, `server/src/gmail-link.test.js:30`; Test add to `server/src/sizing-pg.test.js` with a fake Google (`GDRIVE_API_BASE`, `GDRIVE_UPLOAD_BASE`, `GOOGLE_TOKEN_URL`).

**Interfaces — Produces:** `DRIVE_SCOPE`; `driveAllowed(link) → boolean`; `saveKldToDrive({ link, token, folderName, fileName, bytes, shareWith }) → { file_id, link, folder_id }` (find-or-create folder by name with `appProperties.ciplant='kld'`, multipart upload, permission `reader` for `shareWith`); route `POST /costing/sizes/:id/kld/drive` → appends `{ rev, file_id, link, shared_with, saved_at, saved_by }` to `kld.drive`.

- [ ] **Step 1: Failing tests** — `Save to Drive uploads into the KLD folder and shares with the business mailbox only`; `a link without drive.file gets 409 connect again`; `consent asks for Gmail and Drive`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (and `node --test src/gmail-link.test.js` still green).

### Task 5: Costing screen

**Files:** Create `client/src/pages/costing/SizeProposals.jsx`, `client/src/pages/costing/KldPanel.jsx`; Modify `client/src/pages/costing/CostingEditor.jsx` (replace `SizeHelper` at line ~383 with `SizeProposals`; `pickLayout` also ticks `new_die` when the option says so; show `KldPanel` under the layout when the chosen library entry has a KLD or a proposal was just picked).

- `SizeProposals({ value, size, onPick })` — fetches proposals; die matches first (both lists); per reading up to 4 cards: block picture (SVG from `layoutBlocks`), sheet + mill pieces, ups m × n, board a carton, spare, grain chip (ok / wrong / not recorded), "Use this layout" → `onPick({ sheet_l, sheet_w, ups, style, new_die: true, kld: { reading, option } })`.
- `KldPanel({ value, sizeId, pending })` — preview (`kldSvg`), "Make KLD" (PUT), "Download PDF" (fetch with bearer → blob URL, as QuotationPanel does), "Save to Drive" (POST; shows link, or the connect-again message).
- [ ] **Step 1:** `npm run build -w client` passes; **Step 2:** run the app locally and check the panel on a new size (Task 7).

### Task 6: Board master grain

**Files:** Modify `client/src/pages/Masters.jsx` Boards fields (+ `{ key: 'grain', label: 'Grain runs along', type: 'select', options: ['', 'long', 'short'] }` with readable labels) and its columns.

- [ ] **Step 1:** build passes; saving a board with grain round-trips (covered by Task 3's PG test).

### Task 7: Verify

- [ ] `cd server && node --test src/sizing.test.js src/kld.test.js src/kld-pdf.test.js src/gmail-link.test.js` → all pass.
- [ ] `SIZING_PG=1 node --test src/sizing-pg.test.js` and `ENQUIRY_PG=1 node --test src/enquiry-pg.test.js` → pass.
- [ ] `npm test -w server` → only the 2 known path-space failures; `npm run build -w client` ✓.
- [ ] Local app: costing with a new size shows die matches + proposals; Use this layout fills sheet/ups/New die; Make KLD shows the drawing; Download PDF opens a 1:1 PDF.
