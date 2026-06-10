# Performance Commonisation Phase 3 Implementation Report

Date: 2026-06-10

## Executive summary

Phase 3 was implemented as an incremental table-behavior commonisation pass. The work intentionally avoided a universal table rewrite and preserved existing table markup, row actions, drawers, filters, exports, and workflows.

The main change is a shared table-state utility layer for sort cycling, debounced search, selection sets, visible-row selection, empty/loading rows, pagination metadata, row-action stop-propagation, and detail-loader state. Low-risk tables now consume these helpers where they had duplicated local logic.

No business calculations, permissions, Prisma schema, migrations, billing GST/tax/rounding, GRN costing, planning reservation, production OEE/yield, procurement landed cost, or supplier score logic was intentionally changed.

## Files changed

Shared utility:

- `src/lib/table-state.tsx`

Tables/pages updated:

- `src/app/(dashboard)/orders/purchase-orders/page.tsx`
- `src/app/(dashboard)/inventory/page.tsx`
- `src/app/(dashboard)/production/job-cards/page.tsx`
- `src/app/(dashboard)/production/stages/[stageKey]/page.tsx`
- `src/app/(dashboard)/billing/page.tsx`
- `src/app/(dashboard)/reports/_components/ReportTable.tsx`

Generated/verification artifact:

- `tsconfig.tsbuildinfo` was refreshed by `npm run typecheck`.

## Shared utilities introduced

`src/lib/table-state.tsx` now provides:

- `cycleSort` for repeated sort-header toggles.
- `compareTableValues` for stable string/number comparisons.
- `useDebouncedValue` for repeated search debounce behavior.
- `useSelectionSet` for repeated checkbox selection state.
- `visibleSelectionState` for all/some/visible-id selection math.
- `selectedRows` for deriving selected row objects.
- `paginationMeta` for shared pagination metadata.
- `TableStateRow` for repeated table loading/empty rows.
- `RowActionSlot` for row-action cells that should not trigger row click.
- `useDetailLoader` for future drawer/detail loader state.

## Duplicated logic removed

| Area | Before | After |
|---|---|---|
| Purchase Orders debounce | Page-local `useDebouncedValue` implementation. | Uses shared `useDebouncedValue`. |
| Purchase Orders visible selection | Inline all/some visible checkbox math and row loop. | Uses `visibleSelectionState`. |
| Inventory stock selection | Page-local all-visible checkbox math. | Uses `useSelectionSet` and `visibleSelectionState`. |
| Job Cards selection | Local selected-set toggles, selected-row derivation, all-visible math. | Uses `useSelectionSet`, `selectedRows`, and `visibleSelectionState`. |
| Job Cards sort comparison/toggle | Inline value compare and sort-header direction toggle. | Uses `compareTableValues` and `cycleSort`. |
| Job Cards loading/empty row | Repeated inline `<tr><td colSpan...>` states. | Uses `TableStateRow`. |
| Production Stage visible selection | Inline all-visible and select-current-tab logic. | Uses `visibleSelectionState`. |
| Billing row action | Repeated `stopPropagation` in action cell/button. | Uses `RowActionSlot`. |
| Billing empty row | Inline empty `<tr>` state. | Uses `TableStateRow`. |
| Reports table frame | Local wrapper around report table. | Reuses `EnterpriseTableShell`. |

## Tables migrated

### Purchase Orders table

Migrated behavior:

- Search debounce now uses the shared hook.
- Select-all visible state now uses shared visible-row selection metadata.

Left intact:

- Existing PO table markup.
- Existing action buttons.
- Existing row click and keyboard behavior.
- Existing drawer/detail loading.
- Existing bulk actions and export/PDF buttons.

### Inventory Stock table

Migrated behavior:

- Page-level selection set now uses the shared selection helper.
- Select-all visible rows now uses shared visible-row metadata.

Left intact:

- `StockTab` visual markup.
- Material drawer behavior.
- Reservations panel behavior.
- Stock add/remove/delete actions.

### Job Cards table

Migrated behavior:

- Selection state, selected rows, all-visible state.
- Sort value comparison and sort-header cycling.
- Loading/empty table rows.

Left intact:

- Existing queue table markup.
- Bulk release/archive/assign actions.
- Row action buttons.
- Audit drawer behavior.

### Production Stage Board visible rows

Migrated behavior:

- Visible-row selection and select-current-tab logic now uses shared visible-row selection metadata.

Left intact:

- Stage calculations.
- OEE/yield rendering.
- Spotlight/drawer behavior.
- Bulk stage actions.
- Stage tab workflow.

### Billing list

Migrated behavior:

- Empty table row uses shared helper.
- Row action cell uses shared row-action slot pattern.

Left intact:

- Billing list markup.
- Status actions.
- Drawer behavior.
- GST/tax/rounding display and calculations.

### Reports table shell

Migrated behavior:

- Report table now uses `EnterpriseTableShell`.

Left intact:

- TanStack sorting.
- Report columns/totals.
- Export buttons.
- Preview/chart behavior from Phase 2.

## Tables intentionally left untouched

- Designing/AW queue: complex operational grouping and action state; should be migrated after a dedicated pass.
- Cutting Queue: table is tightly coupled to local production execution meta; Phase 1/2 already reduced payload. Safe next step is selection/empty-row helper only after role-specific behavior is tested.
- Inventory open PO/incoming tables: these components are currently deleted/moved in the active worktree.
- Billing detail/new bill line-entry tables: line math and invoice-entry UX are calculation-sensitive; left visually untouched.
- Plate Hub ledgers: large hub table logic and lane state should be migrated with hub-specific tests.
- Tooling Hub ledgers: same as Plate Hub; table view is large and operationally dense.
- GRN: current route/page state is moved/placeholder in this worktree; full GRN table commonisation should wait until the restored workflow is present.

## Before/after maintainability impact

Before:

- Each table reimplemented debounce, visible-row selection, selected-row derivation, sort cycling, row-action stop propagation, and empty/loading rows independently.
- Small behavior fixes had to be repeated table by table.

After:

- Common behavior has a single helper layer.
- Existing visuals remain stable.
- New table migrations can adopt helpers one behavior at a time.
- The codebase has a safer path toward shared table shells without forcing a visual rewrite.

## Risk assessment

| Risk | Level | Mitigation |
|---|---|---|
| Selection behavior regression in operational tables. | Low-Medium | Migrated only visible-row selection math and kept existing checkbox markup/action flows. |
| Sort behavior change in Job Cards. | Low | `compareTableValues` preserves numeric and string comparisons with stable locale/numeric behavior. |
| Row action click propagation in Billing. | Low | `RowActionSlot` preserves the old stop-propagation behavior. |
| Reports table wrapper visual spacing may differ slightly. | Low | Reused existing `EnterpriseTableShell` already used elsewhere. |
| Generated `tsconfig.tsbuildinfo` changed during verification. | Low | It was produced by the required typecheck and contains no source logic. |

## Verification results

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` | Passed | Initial run hit stale `tsconfig.tsbuildinfo`; after clearing that generated cache, `tsc --noEmit` passed. No source logic change was needed for that. |
| `npx prisma validate` | Passed | Prisma schema is valid. |
| `npx next lint` | Passed with warnings | Existing warning set remains; includes hook dependency/a11y/image warnings outside this Phase 3 scope. |
| `git diff --check` | Passed | No whitespace errors reported. |
| API route import validation | Passed | Imported 360 `src/app/api/**/route.ts` files successfully. |
| `npx next build` | Failed after compile | Direct build compiled successfully, then failed during page-data collection with `Cannot find module './undefined'` from `.next/server/pages/_document.js`. `npm run build` was not used because it runs `prisma migrate deploy`. |
| Browser smoke | Could not run | Browser-control tooling was not exposed in this session. No browser smoke could be performed. |

## Browser smoke coverage status

Requested smoke checks could not be executed because browser tooling was unavailable:

- First render
- Search
- Sort
- Filter
- Pagination
- Row click
- Modal/drawer open
- Action buttons
- Export buttons
- Console errors
- Failed API calls

## Remaining technical debt

- Add real pagination controls to compact/paged operational tables using the existing `Pagination` component and `paginationMeta`.
- Migrate Cutting Queue empty/loading and selection-like behavior after role-specific testing.
- Migrate Designing/AW queue with dedicated grouping and action-state tests.
- Introduce a hub-ledger adapter for Plate Hub and Tooling Hub rather than forcing their ledgers into a generic table.
- Add table-level tests for selection, sort cycle, and row-action propagation.
- Add browser smoke automation once browser tooling is available.
- Continue moving table behavior first and visual shells second, table by table.

## Deployment and git status

- Not deployed.
- Not committed.
- No Prisma migration command was run.
- No database schema change was made.
- No permission/auth change was made.
