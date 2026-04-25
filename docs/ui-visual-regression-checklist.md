# UI Visual Regression Checklist

Use this quick checklist when changing queue table UI in:

- Planning
- Artwork Queue
- Customer PO

## Chips and badges

- Status chips keep shared token geometry (`STATUS_CHIP_BASE`).
- Pushed badge uses `PUSHED_CHIP_CLASS`.
- Badge text size/weight remains aligned (`text-[9px]` style family).
- Shared row-state legend uses `RowStateLegend` component and helper tooltip text remains meaningful.

## Action controls

- Text action pills compose from `ACTION_PILL_BASE` / `ACTION_PILL_NEUTRAL`.
- Icon-only actions compose from `ICON_BUTTON_BASE` / `ICON_BUTTON_TIGHT`.
- Hover states remain visible in both light and dark themes.

## Row state UX

- `Pushed` rows remain interactive.
- `Pushed` rows are visually tinted and sorted to the end.
- Row-state legend is visible and includes help tooltip text.

## Filters and empty states

- Applied filter chips render correctly.
- `Clear all` resets module filters without page reload.
- Empty-state wording is consistent:
  - No filtered rows: `No rows match current view or filters. Clear filters to see all rows.`
  - No queue items: `No rows in this queue yet.`

## Contrast and readability

- High contrast mode (`ci-high-contrast`) remains readable and does not break layout.
- Focus rings are clearly visible on dark surfaces.
- Numeric KPI emphasis uses `ds-typo-kpi` for key totals.

## Time labels

- `Pushed X ago` labels use `formatShortTimeAgo()` from `src/lib/time-ago.ts`.
- Time strings are consistent across Planning, AW Queue, and Customer PO.
