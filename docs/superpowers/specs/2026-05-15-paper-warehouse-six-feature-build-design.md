# Paper Warehouse + PR Kanban — Six-Feature Build

**Date:** 2026-05-15
**Branch:** po-import-ai-deep-fixes
**Author:** Anik (brainstorm) / Claude (spec)

## Goal

Six related improvements to the paper warehouse inventory page and the purchase requisition kanban, landed as a sequenced single design with one PR per feature:

1. Theme overhaul (Plus Jakarta Sans + IBM Plex Mono + dark token palette)
2. Schema: release-tracking fields on `MaterialReservation`
3. Auto-release reservations when job status becomes terminal (cancelled / completed / on_hold)
4. Clickable Reserved column → slide-in panel listing reservations with ghost-flagging and manual Release
5. Days of Cover column with red/yellow/green thresholds
6. Auto-create Draft PR when shortage > 0 and no open PR exists for that material

## Implementation Sequence

```
1. Schema migration              (foundation — provides isReleased/releasedAt/releasedReason/confirmedQty)
2. Auto-release on status change (uses new fields)
3. Reserved-column slide-in      (reads new fields; needs release endpoint)
4. Days of Cover column          (independent of 1–3)
5. Auto-create Draft PR          (uses recalculated shortage from feature 3)
6. Theme overhaul                (cosmetic, last — least likely to need rework)
```

Each step is its own commit/PR. Steps 1–3 must land in order. 4, 5, 6 can land in any order after 3.

## Decisions Locked In (from brainstorm)

| Question | Decision |
|---|---|
| Project scope | Single design doc, six sequenced implementations |
| JobCard new statuses | Add `cancelled` and `on_hold` as new string values (no enum migration) |
| `archived` status | NOT a releasing status — pre-existing archival is its own concept |
| PR `draft` status | Add `draft` as new string value; dedupe blocks if any of `{draft, pending, approved}` exists for materialId |
| Theme reconcile | Map new tokens INTO existing design system (change values, not names) |
| Days-of-Cover source | `SheetIssueRecord` rows where `jobCard.status='completed'` and `issuedAt` in last 30 days |
| Migration target | `prisma migrate dev` against local DB only; user promotes to Neon |
| Auto-PR trigger | Trigger on every `recalculateMaterialShortage` call, dedupe via existing-PR query |
| `raisedBy` field | Make nullable; render "Auto" in UI when null |
| Manual Release UX | Available on both ghost rows (one-click, red, auto-reason) AND active rows (confirm modal, required reason) |
| Theme hardcoded-color sweep | Only on paper-warehouse + PR-kanban pages this round |

---

## Feature 2: Schema Migration

**File:** `prisma/schema.prisma` (model `MaterialReservation`, lines 2006–2024)

```prisma
model MaterialReservation {
  // existing fields unchanged
  isReleased     Boolean   @default(false) @map("is_released")
  releasedAt     DateTime? @map("released_at")
  releasedReason String?   @map("released_reason") @db.VarChar(120)
  confirmedQty   Int?      @map("confirmed_qty")

  @@index([materialId, isReleased])   // new — fast active-only filtering
}
```

**Migration name:** `reservation_release_fields`
**Command:** `npx prisma migrate dev --name reservation_release_fields`
**Backfill:** none required — existing rows correctly default to `isReleased=false`.

### Also in this PR: `PurchaseRequisition.raisedBy` becomes nullable

```prisma
raisedBy String? @map("raised_by")   // was String — now nullable for auto-created PRs
```

Migration name: same migration file. Existing rows have non-null values; no backfill needed.

### Acceptance

- `npx prisma migrate dev` runs cleanly against local DB
- TypeScript compile passes (`tsc --noEmit`)
- No existing query that does `materialReservation.findMany` accidentally surfaces released rows in production-facing UI (audit grep at PR time)

---

## Feature 3: Auto-Release on Status Change

**New file:** `src/lib/reservation-release.ts`

```ts
export const TERMINAL_RELEASING_STATUSES = ['cancelled', 'completed', 'on_hold'] as const
export const ACTIVE_RESERVATION_STATUSES = [
  'design_ready', 'ready', 'pending_artwork', 'artwork_approved',
  'in_production', 'folding', 'final_qc', 'packing',
] as const
// 'archived' is excluded from BOTH sets — pre-existing archival concept, no auto-release

export type ReleaseReason =
  | `job_cancelled` | `job_completed` | `job_on_hold`
  | `manual_planner` | `manual_ghost_backfill`

export async function releaseReservationsForJob(
  jobCardId: string,
  newStatus: typeof TERMINAL_RELEASING_STATUSES[number],
  tx: Prisma.TransactionClient,
): Promise<{ releasedCount: number; materialIds: string[] }> {
  // 1. Find unreleased reservations for this jobCard
  // 2. Update them: isReleased=true, releasedAt=now(), releasedReason=`job_${newStatus}`
  // 3. Return distinct materialIds for downstream recalc
}

export async function recalculateMaterialShortage(
  materialId: string,
  tx: Prisma.TransactionClient,
): Promise<{ shortage: number; prCreated: boolean }> {
  // Aggregate active reservations only:
  //   shortage = SUM(requiredSheets - reservedSheets)
  //     WHERE materialId=X
  //       AND isReleased=false
  //       AND jobCard.status IN ACTIVE_RESERVATION_STATUSES
  // Persist on MaterialShortage table (existing model, line 2026)
  // Then call maybeCreateDraftPrForShortage (feature 6) inside same tx
}
```

### Wiring strategy: explicit calls + middleware backstop

**Primary:** at every `productionJobCard.update({ where, data: { status } })` site, wrap in a transaction that calls `releaseReservationsForJob` and then `recalculateMaterialShortage` for each returned materialId, when `data.status ∈ TERMINAL_RELEASING_STATUSES`.

Expected sites (verified by grep at implementation time):
- `src/app/api/job-cards/[id]/route.ts` (PATCH handler)
- `src/app/api/job-cards/clear-queue/route.ts`
- `src/app/api/designing/po-lines/[id]/recall-job/route.ts`
- Any other write site discovered during implementation

**Backstop:** Prisma `$extends` middleware in `src/lib/prisma.ts` (or sibling file) that triggers `releaseReservationsForJob` automatically on any `productionJobCard.update` / `updateMany` where the data sets status to a terminal value AND the explicit caller hasn't already handled it (idempotent via the `isReleased` flag — middleware just calls the helper; the helper's WHERE clause filters to unreleased rows, so a second call is a no-op).

Trade-off: middleware adds slight complexity and an extra DB call per status-write. Accepted because the explicit-call discipline is fragile across a growing codebase.

### Acceptance

- Test: create a job card with reservations → update status to `cancelled` → assert all reservations `isReleased=true` with `releasedReason='job_cancelled'`
- Test: same flow for `completed` and `on_hold`
- Test: update status to `archived` → assert reservations are NOT auto-released (pre-existing behavior preserved)
- Test: middleware backstop fires when an unexpected call site forgets to wrap in tx
- Test: shortage recalc excludes released reservations AND reservations on non-active job statuses
- Test: idempotent — calling release twice for same job is a no-op on the second call

---

## Feature 4: Clickable Reserved Column → Slide-in Panel

**Page changed:** `src/app/(dashboard)/inventory/page.tsx`

### New API: list reservations for a material

`GET /api/inventory/paper-warehouse/[materialId]/reservations`

Response:
```ts
{
  materialId: string,
  materialCode: string,
  materialSpec: { boardType, gsm, sizeLabel, grainDirection },
  totalReserved: number,
  ghostCount: number,
  reservations: Array<{
    id: string
    jobCardId: string
    jobCardNumber: number
    customerName: string
    jobStatus: string
    requiredSheets: number
    reservedSheets: number
    confirmedQty: number | null
    isReleased: boolean
    releasedAt: string | null
    releasedReason: string | null
    isGhost: boolean   // jobStatus ∈ terminal AND isReleased=false
    createdAt: string
  }>
}
```

Sort: ghosts first (by createdAt asc — oldest ghosts at top), then active (by createdAt desc).

Released reservations are NOT returned by default. Add `?includeReleased=true` query param if a future use case needs the audit trail.

### New API: manual release

`POST /api/inventory/reservations/[id]/release`

Body:
```ts
{ reason: string }   // required, min 3 chars
```

Action (in transaction):
1. Verify reservation exists and `isReleased=false`
2. Mark `isReleased=true`, `releasedAt=now()`, `releasedReason=reason`
3. Call `recalculateMaterialShortage(materialId, tx)`
4. Return updated reservation row

Auth: same role gate as `src/app/api/planning/po-lines/[id]/reservation-control/route.ts` — reuse the existing pattern.

### New component: `ReservationsPanel`

**File:** `src/app/(dashboard)/inventory/components/ReservationsPanel.tsx`

Layout:
- Slide-in from right, ~480px wide
- Use existing `Sheet`/`Drawer` component (grep at implementation time — `src/components/ui/sheet.tsx` is likely)
- Header: material code + spec line + total reserved KPI
- Banner (only when ghostCount > 0): red callout "⚠ N ghost reservations — these should have auto-released. Click Release to clean up."
- Body: list of reservation cards
  - Ghost row: red left-border, prominent red "Release" button (one-click, auto-reason `manual_ghost_backfill`)
  - Active row: gray left-border, secondary outlined "Release" button (opens confirm modal with required reason text field, default placeholder "Reallocating to higher-priority job")
  - Each card shows: job#, customer, status badge, qty (required / reserved), createdAt
  - Eye icon on every row linking to job card detail (`/production/job-cards/[id]`)
- Empty state: "No active reservations on this material"

### Cell change

Paper-warehouse table, lines ~1163–1200, the `qtyReserved` `<td>`:
- Wrap value in a `<button>` with `cursor-pointer`, underline-on-hover, `ChevronRight` icon
- Disable button when `qtyReserved === 0`
- Click handler sets `materialDrawerRow` state (already exists on the page — reuse) and opens panel
- Rerender panel content based on selected materialId

### Acceptance

- Click Reserved cell → panel opens, shows reservations
- Ghost rows (if any exist post-feature-3, expected zero) flagged red with one-click release
- Manual release on active row requires reason
- After release, panel refreshes; shortage on parent row recalculates
- Released reservation no longer appears in panel (unless includeReleased query param)
- a11y: panel traps focus, ESC closes

---

## Feature 5: Days of Cover Column

**API extended:** `GET /api/inventory/paper-warehouse` row response gains `daysOfCover: number | null`

**Service:** `src/lib/material-readiness-service.ts` (existing file)

Add function:
```ts
async function computeAvgDailyConsumption(
  materialIds: string[],
): Promise<Map<string, number>> {
  const thirtyDaysAgo = subDays(new Date(), 30)
  // Single grouped query for all materials on the page:
  const rows = await prisma.sheetIssueRecord.groupBy({
    by: ['jobCardId'],
    where: {
      issuedAt: { gte: thirtyDaysAgo },
      jobCard: {
        status: 'completed',
        allocatedPaperWarehouseId: { not: null },
      },
    },
    _sum: { qtyRequested: true },
  })
  // For each row, resolve jobCard → allocatedPaperWarehouse → materialId
  // Group sums by materialId, divide by 30
  // (Implementation detail: pre-fetch jobCard → materialId map in one query
  //  to avoid N+1, then aggregate in memory)
}
```

Then in the paper-warehouse list endpoint:
```ts
const consumption = await computeAvgDailyConsumption(materialIds)
rows.forEach(r => {
  const avg = consumption.get(r.material_id) ?? 0
  r.daysOfCover = avg > 0 ? Math.floor(r.freeStock / avg) : null
})
```

**Performance:** single grouped query per page render. Cache for 60s in-memory using the existing pattern in `src/lib/cache.ts` (or inline with `unstable_cache` if that file doesn't exist).

**UI:** new column "Days of Cover" inserted after the existing "Free Stock" column in `src/app/(dashboard)/inventory/page.tsx`. Cell renders:
- `null` → em-dash (`—`), gray, tooltip "No completed-job consumption in last 30 days"
- `< 7` → red badge with number + "d" suffix (e.g. "3d")
- `< 30` → yellow badge
- `≥ 30` → green badge

KPI strip: optionally add a "Avg DoC" KPI alongside existing KPIs (line ~1065). Out of scope for this PR — track as follow-up if useful.

### Acceptance

- Column renders with correct color thresholds
- `null` case rendered as em-dash with tooltip
- Calculation matches: pick a known material, hand-verify days-of-cover with sql
- Page load not noticeably slower (single grouped query, not N+1)
- Cache invalidates correctly when new SheetIssueRecord rows are written (or staleness within 60s is acceptable)

---

## Feature 6: Auto-Create Draft PR on Shortage

**Helper:** `src/lib/auto-pr-from-shortage.ts`

```ts
export async function maybeCreateDraftPrForShortage(
  materialId: string,
  shortage: number,
  tx: Prisma.TransactionClient,
): Promise<PurchaseRequisition | null> {
  if (shortage <= 0) return null

  // Dedupe — block if any "open" PR already exists for this material
  const existing = await tx.purchaseRequisition.findFirst({
    where: {
      materialId,
      status: { in: ['draft', 'pending', 'approved'] },
    },
    select: { id: true },
  })
  if (existing) return null

  const material = await tx.inventory.findUnique({
    where: { id: materialId },
    select: { code: true, boardType: true, gsm: true, sizeLabel: true, lastRate: true },
  })
  if (!material) return null

  return tx.purchaseRequisition.create({
    data: {
      materialId,
      qtyRequired: shortage,
      estimatedValue: shortage * (Number(material.lastRate) || 0),
      triggerReason: 'auto_shortage',
      status: 'draft',
      raisedBy: null,                    // nullable now — UI renders "Auto"
      boardType: material.boardType,
      sizeLabel: material.sizeLabel,
      gsm: material.gsm,
    },
  })
}
```

**Call site:** `recalculateMaterialShortage` (feature 3) calls `maybeCreateDraftPrForShortage` after computing shortage, inside the same transaction.

**PR kanban page:** `src/app/(dashboard)/inventory/purchase-requisitions/page.tsx`
- Add a "Draft" column to the kanban as the leftmost lane
- Drafts get a small "⚡ Auto" badge when `raisedBy === null`
- "Promote to Pending" button on each draft card (existing PATCH endpoint, just adds support for `draft → pending` transition)
- Existing `status` filter dropdown gains a "Draft" option

### Acceptance

- Status change → recalc → shortage > 0 → exactly one draft PR created
- Calling recalc again with same shortage → no second PR (dedupe works)
- Draft PR shows on kanban under new "Draft" lane with "⚡ Auto" badge
- Promoting Draft → Pending works via existing status-transition UI
- Released reservation that drives shortage to 0 → no new PR created (and existing draft PR is NOT auto-removed — manual cleanup is acceptable; track as follow-up if it becomes a problem)

---

## Feature 1: Theme Overhaul

### Token mapping strategy

Modify `src/styles/design-tokens.css` (the file imported by `globals.css` line 1) — change values of existing tokens to match the new palette. Do NOT introduce parallel tokens.

```css
:root {
  /* New base palette */
  --bg-app: #0f1117;
  --bg-card: #181c27;
  --bg-elevated: #1f2433;  /* derived: card + slight lift */

  /* New brand & semantic colors */
  --ds-brand: #f5820d;
  --ds-success: #22c55e;
  --ds-danger: #ef4444;
  --ds-warning: #eab308;
  --ds-info: #3b82f6;

  /* Derived line / ink */
  --ds-line: rgba(255, 255, 255, 0.08);
  --ds-ink: #e5e7eb;
  --ds-ink-muted: #9ca3af;
  --ds-ink-faint: #6b7280;

  /* Fonts */
  --font-body: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
  --font-heading: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
  --font-label: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', monospace;
}
```

### Files touched

| File | Change |
|---|---|
| `src/styles/design-tokens.css` | Token values updated as above |
| `src/app/globals.css` (lines 64–84) | HSL shadcn vars updated to match (dark theme) |
| `src/app/globals.css` (lines 17–22) | `.ds-input-num` and `.ds-typo-total` / `.ds-typo-kpi` get `font-family: var(--font-mono)` so every number is IBM Plex Mono |
| `src/app/layout.tsx` | Load `Plus_Jakarta_Sans` + `IBM_Plex_Mono` via `next/font/google`, set as CSS vars on `<html>` |
| `src/components/design-system/tokens.ts` | Update any hardcoded hex constants to match palette |

### Hardcoded-color sweep (scoped to two pages)

After token-map lands, grep these two files for hardcoded tailwind color classes:
- `src/app/(dashboard)/inventory/page.tsx`
- `src/app/(dashboard)/inventory/purchase-requisitions/page.tsx`

Patterns: `bg-(red|green|yellow|blue|orange)-\d{3}`, `text-(red|green|yellow|blue|orange)-\d{3}`, `border-(red|green|yellow|blue|orange)-\d{3}`. Replace with semantic token classes (`bg-ds-danger`, `text-ds-success`, etc.) where the color choice is semantic, not decorative.

Skip Plate Hub colors (CMYK channel swatches, line 57 comment) — those are intentionally hardcoded.

### Acceptance

- Both pages render with dark theme + orange accent + new semantic colors
- All numeric cells render in IBM Plex Mono
- Text renders in Plus Jakarta Sans
- No visual regressions on Plate Hub (CMYK swatches preserved)
- Rest of app picks up new theme via tokens but is not hand-tuned this PR

---

## Cross-cutting concerns

### Testing

- Feature 2 (schema): migration applies cleanly, prisma generate works
- Feature 3 (auto-release): unit tests for `releaseReservationsForJob` and `recalculateMaterialShortage`, integration test through API route
- Feature 4 (panel): component test for ghost flagging, manual test for slide-in
- Feature 5 (DoC): unit test for `computeAvgDailyConsumption` with seeded data
- Feature 6 (auto-PR): unit test for dedupe and shortage=0 short-circuit
- Feature 1 (theme): visual smoke check, no automated test

### Rollback

- Feature 2: `prisma migrate resolve --rolled-back <name>` + manual revert SQL (drop 4 columns, restore raisedBy NOT NULL)
- Features 3, 5, 6: revert PR, no data cleanup needed (released reservations stay released, that's fine)
- Feature 4: revert PR — no data side-effects
- Feature 1: revert PR — pure cosmetic

### Open follow-ups (NOT in scope)

- Auto-remove draft PR when shortage drops to 0 (manual cleanup acceptable for v1)
- DoC KPI in the strip above the table
- Theme sweep across remaining 50+ pages
- Reservation audit log table (today, `releasedReason` is the only audit trail — consider full append-only log later)

---

## Non-goals

- Reservation versioning / undo
- Multi-material PR consolidation (one shortage = one PR per material)
- Notification when auto-PR is created (UI badge is enough for v1)
- Custom theming per user
