# Planning Engine Redesign Report

## Summary
- Reworked the Planning Engine modal into a clearer desktop-first workspace without changing APIs, reservations, routes, permissions, or persisted workflow behavior.
- Replaced the top dense product card with an order KPI ribbon showing Customer, Product, AW Code, PO Number, Order Qty, Required Sheets, Delivery, and Status.
- Replaced the left vertical wizard with a horizontal stepper: Board, Match, Cut Plan, Warehouse, Review, Lock.
- Moved Smart Match into the main workspace and rendered ranked suggestions as a comparison table with Rank, Board Size, GSM, Yield, Waste %, Free Stock, Reserved Stock, Match Score, Preview, and Select.
- Reworked Warehouse Availability as a stock table and kept the existing Open warehouse action.
- Preserved the corrected planning requirement calculation: PO quantity / units per sheet + wastage.
- Fixed cut-plan preview and planning summary parent-size resolution so unlinked suggested stock size is not treated as the parent sheet. For PO 00870, the visible calculation resolves to 20 in x 38 in, 2 pcs/sheet, 20,000 base sheets, 150 wastage sheets, and 20,150 total sheets.

## Files Changed
- `src/components/planning/engine/PlanningEngineBody.tsx`
- `src/components/planning/engine/PlanningStepNav.tsx`
- `src/components/planning/engine/SectionProductRequirement.tsx`
- `src/components/planning/engine/SectionSmartMatch.tsx`
- `src/components/planning/engine/SectionWarehouseAvailability.tsx`
- `src/components/planning/engine/SectionCutPlanBalance.tsx`
- `src/components/planning/engine/SectionPlanningSummary.tsx`

## Helpers / Components Added
- Added horizontal mode support to `PlanningStepNav`.
- Added `MatchTable` inside `SectionSmartMatch` for central ranked parent-sheet comparison.
- Added local final decision summary bar in `PlanningEngineBody`.
- Added parent-size derivation guards in `SectionPlanningSummary`.
- Added `preferredParentSize` guard in `SectionCutPlanBalance` so unlinked readiness size is not trusted as selected parent material.

## Pages / Areas Migrated
- Planning Engine modal on `/orders/planning`.
- Main affected row smoke target: PO `00870`, product `NICODUCE 5 TABLET INNER CARTONSALE-AC22541a`.

## What Was Intentionally Not Changed
- No route changes.
- No backend API contract changes.
- No database or Prisma schema changes.
- No permission/auth changes.
- No reservation, release, PR, lock, or save workflow rewrites.
- No CSS framework/theme rewrite.
- No deployment or commit.

## Verification Commands Run
- `npm run typecheck` - passed.
- `npx vitest run src/components/planning/engine/SectionCutPlanBalance.test.tsx src/components/planning/engine/SectionBoardAllocation.test.tsx src/components/planning/engine/SectionSmartMatch.test.tsx src/lib/smart-match-parent-sheets.test.ts` - passed, 58 tests.
- `git diff --check` - passed.

## Browser Smoke Test
- Opened `/orders/planning` in the in-app browser.
- Opened PO `00870` Planning Engine modal.
- Confirmed modal transform is `none` and width is 1680px.
- Confirmed no browser console errors during modal inspection.
- Confirmed order header, horizontal stepper, warehouse stock table, and Smart Match table render in the modal.
- Confirmed corrected calculation in the Cut Plan section: `20 in x 38 in`, yield `2`, base sheets `20,000 sh`, wastage `150 sh`, total required `20,150 sh`.
- Browser note: the final post-refresh click attempt landed back on the grid after a page reload, so the last screenshot is the grid. Prior modal DOM inspection after readiness resolution confirmed the corrected Cut Plan values and no console errors.

## Remaining Safe Opportunities
- Add dedicated tests for `SectionPlanningSummary` parent-size fallback so stale `meta.parentSize` cannot reintroduce invalid summary text.
- Add a visual regression snapshot for the Planning Engine modal at desktop width.
- Consider extracting shared planning parent-size/yield resolution into a single helper used by Board Allocation, Cut Plan, Smart Match, and Planning Summary.
