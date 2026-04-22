# Pre-deploy: Planning (Phase 1)

Controlled rollout document for **PO → Planning → Batching**. Use this for training, QA, and sign-off before wider team access.

---

## Current scope

| Area | What is in scope |
|------|------------------|
| **PO → Planning** | Release a **confirmed or approved** PO to Planning; line items already exist on the PO. Release stamps metadata on each line, sets PO status to **Sent to Planning**, and restricts further PO edits per product rules. |
| **Planning workspace** | Filtered list of PO lines, decision grid (UPS, specs, remarks, batch status), row detail drawer, suggested batches (when used), batch decision workflow. |
| **Batching** | **Manual:** select lines → link as mix-set (shared `masterSetId` / `mixSetMemberIds`). **Auto:** suggestions are hints only; user accepts, modifies selection, or dismisses. Set / output numbering uses planning save rules (auto `SET-xxx` or manual per mode). |

Out of scope for Phase 1: **system-driven line split** (see below).

---

## Known limitation: split is not system-driven

- There is **no** parent–child PO line relationship in the app for planner “splits.”
- There is **no** automatic reconciliation of quantities between a “parent” job and child jobs in planning.
- The planning UI may record **split intent** (e.g. planner notes / split intent in the job drawer) as a **signal only**; it does **not** create or link child lines.

**Operational rule (Phase 1):** treating a line as two (or more) separate jobs is a **controlled manual process owned by Accounts** (e.g. duplicate or adjust PO lines in the source of truth). Planning then works off the **actual** line items present on the PO.

Do **not** assume totals in planning match a notional split until Accounts has updated the PO.

---

## Basic user flow (Planning team)

1. **Incoming work** — PO appears in planning after **Release to Planning** from a valid PO (and lines meet release validation).
2. **Review lines** — Open the grid; use customer filter and pending/processed view as needed.
3. **Line detail** — Click a row to open the drawer; review qty, tooling/readiness, remarks; adjust UPS/spec where allowed; save.
4. **Batching** — Select compatible lines → **Group as mix-set** (or follow a suggested batch); complete UPS/designer/set rules; use **Batch decisions** (draft → ready → artwork / production steps) per process.
5. **Handoff** — Use **Save planning** / **Make processing** per your org’s procedure after batch and line rules are satisfied.

---

## Manual test script (Phase 1)

Run in **staging (or production pilot)** with **real POs** when possible. Record pass/fail and who ran the test.

### A. PO Release

| Step | Action | Expected |
|------|--------|----------|
| A1 | Open a PO that is **not** Confirmed/Approved | **Release to Planning** is blocked or errors with a clear message. |
| A2 | Open a **Confirmed** (or **Approved**) PO with valid lines (product, qty &gt; 0, required header fields) | Release succeeds; PO status becomes **Sent to Planning**. |
| A3 | Release the same PO again | Idempotent behavior: should not create duplicate planning “release” state (e.g. error if already released). |
| A4 | Count lines on PO vs lines visible in Planning for that PO | **Same count**; no surprise extra rows unless PO was edited elsewhere. |

### B. Planning drawer — open / edit / save

| Step | Action | Expected |
|------|--------|----------|
| B1 | Click a row | Drawer opens quickly; data matches the row (PO, item, qty). |
| B2 | Edit a field that is allowed (e.g. remarks), save | Success feedback; grid/drawer reflect the change after refresh or state update. |
| B3 | Edit UPS or other locked fields after planning handoff is saved | Behavior matches lock rules (blocked or revision path per role). |

### C. Batch creation — output number and mapping

| Step | Action | Expected |
|------|--------|----------|
| C1 | Select two or more compatible lines → **Group as mix-set** | All selected lines share one **Master Set ID**; `mixSetMemberIds` includes all members. |
| C2 | Save planning (or your set-number path) with auto set ID | New set numbers follow your expected pattern (e.g. `SET-001` style) without collisions on the same PO context. |
| C3 | Inspect each line in the batch | Each line references the **same** batch / mix identity; batch decision status is consistent across members after an action. |

**Stability check:** repeat C1–C3 on a second PO; no server errors; rows remain consistent after page reload.

### D. No job in two batches (validation)

| Step | Action | Expected |
|------|--------|----------|
| D1 | With line L in mix-set A, attempt to add L to another mix-set in the same session | Process should make this **hard** (e.g. only one active grouping per line in practice). If the UI allows overlap, **document as defect** and avoid relying on it in Phase 1. |
| D2 | After planning save, re-open Planning for that PO | Each line still appears **once** in the list; mix-set membership is coherent. |

*Phase 1 relies on process discipline. A future hard guard may enforce uniqueness; until then, D1 is a **manual** check.*

### E. Split — manual process (no engine)

| Step | Action | Expected |
|------|--------|----------|
| E1 | In the drawer, use any **split / split intent** control | No second line is auto-created; **no** parent–child link appears in the system. |
| E2 | **Validation step:** If the business needs two jobs, confirm with **Accounts** that the PO was updated (extra line or adjusted qty) | Planning shows the **new** line items after PO refresh / re-fetch. |
| E3 | Totals | Sums in planning should match **PO line items** after Accounts changes—not a notional split. |

---

## Consistency and stability (Phase 1 goals)

- **PO ↔ Planning:** One `po_line_item` row per planning row for that id; release updates lines in place. Validate A4 on every new integration change.
- **No duplicate job across batches:** Enforced operationally in Phase 1; verify **Section D** each release.
- **Batch creation:** Stays **stable** if users avoid overlapping mix-sets and follow save handoff rules; re-run **Section C** after any planning deploy.

---

## Next phase (not Phase 1)

- **Split engine:** parent–child (or equivalent), qty reconciliation, and system-enforced rules—**explicitly deferred** until a separate design and build cycle.

---

*Document version: Phase 1 controlled deployment. Update when split or batch enforcement changes.*
