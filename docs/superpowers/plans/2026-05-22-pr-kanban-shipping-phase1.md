# PR Kanban Phase 1 — Ship & Phase 2 Kick-off

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Phase 1 (PR Kanban procurement enhancement) onto `staging-supabase`, then kick off Phase 2 (Paper Warehouse) through its spec cycle.

**Architecture:** Three sequential tracks: (1) apply the hand-written Prisma migration to the live Neon DB, (2) patch the legacy `convert-to-po` route to write `VendorPoRequisitionLink` rows for backward compatibility, (3) create a pull request to merge `feat/pr-kanban-procurement` → `staging-supabase`. Phase 2 is a separate spec-first cycle documented at the end.

**Tech Stack:** Prisma (migrate deploy, NOT migrate dev — Neon is production), Next.js App Router route handlers, `gh` CLI for PR creation.

---

## File Map

| File | Change |
|------|--------|
| `src/app/api/purchase-requisitions/[id]/convert-to-po/route.ts` | Add `VendorPoRequisitionLink` row inside the existing `$transaction` |
| `prisma/migrations/20260522000000_pr_procurement_phase1/migration.sql` | **Read-only reference** — this file already exists; `prisma migrate deploy` applies it |

---

## Task 1: Apply the Prisma migration to the Neon DB

> **IMPORTANT — no `prisma migrate dev` here.** `DATABASE_URL` points to the production Neon database. `prisma migrate deploy` applies pending migrations non-destructively without resetting the DB.

**Files:**
- Run: `npx prisma migrate deploy` (uses `DATABASE_URL` from `.env`)
- Run: `npx prisma generate` (regenerates client so new model types compile)

- [ ] **Step 1: Verify the migration file is present**

  ```bash
  ls prisma/migrations/20260522000000_pr_procurement_phase1/
  ```

  Expected: `migration.sql` is listed.

- [ ] **Step 2: Check which migrations are pending**

  ```bash
  npx prisma migrate status
  ```

  Expected: `20260522000000_pr_procurement_phase1` shows as "Not applied".

- [ ] **Step 3: Apply the migration**

  ```bash
  npx prisma migrate deploy
  ```

  Expected output contains:
  ```
  1 migration found in prisma/migrations
  Applying migration `20260522000000_pr_procurement_phase1`
  The following migration(s) have been applied:
  - 20260522000000_pr_procurement_phase1
  ```

  If it errors with "column already exists" the columns were added manually outside Prisma — resolve by marking the migration applied:
  ```bash
  npx prisma migrate resolve --applied 20260522000000_pr_procurement_phase1
  ```

- [ ] **Step 4: Regenerate the Prisma client**

  ```bash
  npx prisma generate
  ```

  Expected: `✔ Generated Prisma Client` with no errors.

- [ ] **Step 5: Confirm typecheck still passes**

  ```bash
  npm run typecheck
  ```

  Expected: silent (no output means zero errors).

---

## Task 2: Patch legacy `convert-to-po` route to write the join table

> **Why this matters:** After the migration, `vendor_po_requisition_links` exists but the legacy endpoint never writes to it. Any PO created through the old endpoint will be invisible to the new monitoring view (which joins via that table). Fix it while the schema is fresh, before any production traffic creates orphaned rows.

**Files:**
- Modify: `src/app/api/purchase-requisitions/[id]/convert-to-po/route.ts`

- [ ] **Step 1: Open the file and locate the `$transaction` block**

  The `$transaction` already creates `newPo` and updates `updatedPr`. We insert one `VendorPoRequisitionLink` row immediately after the PO is created, still inside the same transaction.

- [ ] **Step 2: Add the join-table insert**

  Inside the `result = await db.$transaction(async (tx) => { ... })` block, add after `const newPo = await tx.vendorMaterialPurchaseOrder.create(...)`:

  ```typescript
  await tx.vendorPoRequisitionLink.create({
    data: {
      vendorPoId: newPo.id,
      purchaseRequisitionId: pr.id,
      allocatedQty: pr.qtyRequired,
    },
  })
  ```

  The full block now reads:

  ```typescript
  const result = await db.$transaction(async (tx) => {
    const now = new Date()
    const yyyymmdd =
      `${now.getFullYear()}` +
      `${String(now.getMonth() + 1).padStart(2, '0')}` +
      `${String(now.getDate()).padStart(2, '0')}`
    const prefix = `PO-${yyyymmdd}-`
    const sameDayCount = await tx.vendorMaterialPurchaseOrder.count({
      where: { poNumber: { startsWith: prefix } },
    })
    const poNumber = `${prefix}${String(sameDayCount + 1).padStart(3, '0')}`

    const newPo = await tx.vendorMaterialPurchaseOrder.create({
      data: {
        poNumber,
        supplierId,
        purchaseRequisitionId: pr.id,
        requiredDeliveryDate: expectedDelivery,
        createdBy: user!.id,
        lines: {
          create: [
            {
              boardGrade: pr.boardType!,
              gsm: pr.gsm!,
              totalSheets: 0,
              totalWeightKg: pr.qtyRequired,
              linkedPoLineIds: [],
            },
          ],
        },
      },
    })

    // Write join-table row so the new monitoring view can find this PO via the link.
    await tx.vendorPoRequisitionLink.create({
      data: {
        vendorPoId: newPo.id,
        purchaseRequisitionId: pr.id,
        allocatedQty: pr.qtyRequired,
      },
    })

    const updatedPr = await tx.purchaseRequisition.update({
      where: { id: pr.id },
      data: {
        status: 'converted_to_po',
        poReference: newPo.id,
        expectedDelivery,
      },
    })

    return { newPo, updatedPr }
  })
  ```

- [ ] **Step 3: Run typecheck**

  ```bash
  npm run typecheck
  ```

  Expected: no errors. (`vendorPoRequisitionLink` is now in the Prisma client after Task 1 Step 4.)

- [ ] **Step 4: Run the test suite**

  ```bash
  npm test
  ```

  Expected: 260 passed, 0 failed.

- [ ] **Step 5: Commit**

  ```bash
  git add "src/app/api/purchase-requisitions/[id]/convert-to-po/route.ts"
  git commit -m "fix(pr): legacy convert-to-po writes VendorPoRequisitionLink for monitoring compatibility"
  ```

---

## Task 3: Browser verification of the live PR Kanban

> Do this against the dev server pointed at the Neon DB (i.e., with `DATABASE_URL` in `.env` set to production). Read-only checks only — do not delete or irreversibly mutate real data.

**Pre-condition:** Tasks 1 and 2 are complete; dev server is running.

- [ ] **Step 1: Start the dev server**

  ```bash
  npm run dev
  ```

  Then open `http://localhost:3000/inventory/purchase-requisitions`.

- [ ] **Step 2: Verify compact cards render in Draft/Approved/Ordered/Received columns**

  Each card should show two lines:
  - Line 1: `Material Code · Board Type · priority dot`
  - Line 2: `Qty · Due date · linked jobs count`

  No oversized checkbox row. No "Delete card" button visible at rest.

- [ ] **Step 3: Open a Draft card's edit drawer**

  Click a card in the Draft column. The `GlobalPopoutModal` slide-in should appear with:
  - Editable fields: Board Type, GSM, Sheet Size, Required Qty, Required Date, Vendor Preference, Procurement Remarks
  - Buttons at bottom: **Save Draft**, **Approve**, **Delete**

  Change one field, click **Save Draft** — verify the toast/success appears and the card updates.

- [ ] **Step 4: Approve a Draft and confirm field lock**

  Open a Draft card, click **Approve**. Close and reopen — all fields should be `disabled` (read-only). A Revision History section should appear showing the field changes you made in Step 3.

- [ ] **Step 5: Move Approved → Ordered (no popup)**

  Drag an Approved card to the Ordered column **or** click the "Move → Ordered" action. Confirm:
  - No dialog appears
  - The card lands in the Ordered column, grouped with other PRs sharing the same Material + Board Type + GSM + Sheet Size
  - The card shows a **select checkbox** and an "Awaiting PO" badge

- [ ] **Step 6: Generate a PO from the Ordered column**

  Check the checkbox on one Awaiting-PO card. The **Generate PO** toolbar button should enable. Click it:
  - Dialog opens showing Vendor, Delivery Date, Payment Terms, Transport Terms, Remarks
  - Consolidated qty and linked PR count are shown
  - Select a vendor and click **Generate PO**
  - Card flips to a monitoring card showing PO Number, vendor name, Ordered/Received/Pending qty

- [ ] **Step 7: Verify monitoring card numbers**

  The PO monitoring card should show:
  - `Ordered qty` = sum of `qtyRequired` across linked PRs
  - `Received qty` = 0 (no GRN yet) or the live GRN total if receipts already exist
  - `Pending qty` = Ordered − Received

- [ ] **Step 8: Confirm legacy PRs at `converted_to_po` with no real PO degrade gracefully**

  If any legacy `converted_to_po` rows exist (from before Phase 1, with fake `AUTO-...` poReferences), their cards should render as "legacy / no PO" rather than crashing. The board should load fully.

---

## Task 4: Create pull request to merge Phase 1

- [ ] **Step 1: Confirm branch is clean and green**

  ```bash
  git status
  npm test
  npm run typecheck
  ```

  Expected: no unstaged changes, 260 passed, 0 typecheck errors.

- [ ] **Step 2: Push the branch**

  ```bash
  git push -u origin feat/pr-kanban-procurement
  ```

- [ ] **Step 3: Create the PR**

  ```bash
  gh pr create \
    --base staging-supabase \
    --head feat/pr-kanban-procurement \
    --title "feat(pr): PR Kanban procurement enhancement — Phase 1" \
    --body "$(cat <<'EOF'
  ## Summary

  - **Draft editing**: Click any Draft card to open an edit drawer; all procurement fields are editable. Fields lock after Approve. Revision history tracks field-level changes via AuditLog.
  - **Silent Approved→Ordered**: Moving a card to Ordered no longer shows any dialog. Cards auto-consolidate by Material + Board Type + GSM + Sheet Size.
  - **Explicit PO generation**: Select one or more Awaiting-PO cards in the Ordered column; click **Generate PO** to create a real `VendorMaterialPurchaseOrder`. PRs are linked via the new `VendorPoRequisitionLink` join table with per-PR `allocatedQty`.
  - **Live monitoring cards**: PO-backed Ordered cards show live Ordered/Received/Pending quantities sourced from GRN rollups — no data written from the board.
  - **Compact cards**: ~40-50% shorter; no persistent checkbox row; move/delete actions in the drawer.
  - **Incoming-stock fix**: `ordered` stage move no longer bumps `Inventory.qtyQuarantine`; incoming derives from real open POs.
  - **New DB objects**: `remarks` + `required_by_date` on `purchase_requisitions`; `payment_terms` + `transport_terms` on `vendor_material_purchase_orders`; new `vendor_po_requisition_links` join table.

  ## Migration

  Migration file: `prisma/migrations/20260522000000_pr_procurement_phase1/migration.sql`
  Applied via `prisma migrate deploy` before this PR is merged.

  ## Test plan

  - [ ] `npm test` → 260 passed, 0 failed
  - [ ] `npm run typecheck` → clean
  - [ ] Draft edit drawer: edit fields, save, approve, confirm lock + revision history
  - [ ] Approved→Ordered: no popup; card consolidates in Ordered column
  - [ ] Single + bulk Generate PO flow: dialog, vendor selection, PO created, card flips to monitoring
  - [ ] Monitoring card numbers match GRN rollups
  - [ ] Legacy `converted_to_po` rows without real POs render gracefully

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

---

## Phase 2 Roadmap — Paper Warehouse (Sections 9–17)

> Phase 2 follows the same **spec → plan → build** cycle as Phase 1. The implementation plan will be written only after the spec design is approved. The items below are the Phase 2 scope from the master prompt — **not tasks to execute now**.

**Scope (master-prompt Sections 9–17):**

| Section | Feature |
|---------|---------|
| 9 | Direct PO creation directly from the Paper Warehouse view |
| 10 | Open-PO list with live GRN progress per PO |
| 11 | Incoming Deliveries view (POs with expected delivery dates) |
| 12 | Procurement status color system (material-level RAG signal) |
| 13 | Material drawer — stock context + PR + PO linkage in one panel |
| 14 | Smart procurement suggestions (auto-suggest reorder quantities) |
| 15 | KPI strip on the warehouse header |
| 16 | Procurement reporting hub |
| 17 | Cross-module "required from planning" rollup |

**When to start Phase 2:**
1. Phase 1 PR is merged and verified on `staging-supabase`.
2. The Neon DB migration is applied and stable.
3. Kick off a new brainstorming session with the master-prompt Sections 9–17 to produce a Phase 2 spec doc (`docs/superpowers/specs/2026-05-22-paper-warehouse-procurement-design.md`).
4. Then write the Phase 2 implementation plan following `superpowers:writing-plans`.

**Phase 3 (Sections 18–19):** Unified cross-module stock-math service + full audit hardening. Depends on Phase 2 data model being stable.
