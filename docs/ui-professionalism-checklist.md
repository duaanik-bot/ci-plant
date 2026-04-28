# UI Professionalism Checklist

Use this checklist before shipping UI changes in:

- Customer PO
- Planning
- Artwork Queue

## 1) Structure and hierarchy

- Every page uses a consistent top pattern: title/context, primary controls, primary action.
- Search is visibly primary and does not get visually buried by secondary controls.
- Secondary controls (filters/columns/presets) are grouped and optionally collapsible.

## 2) Spacing and rhythm

- Use consistent spacing rhythm (4/8px family) for paddings, gaps, and control heights.
- Avoid mixing too many radii on one screen; prefer one base radius and one large-card radius.
- Table header and body cell vertical rhythm are aligned (no jitter between columns).

## 3) Typography and readability

- Body text and helper text use a small, consistent scale (avoid ad-hoc font sizes).
- Placeholder and muted text remain readable on dark backgrounds.
- Numeric KPI emphasis uses `ds-typo-kpi` for consistency.

## 4) Control clarity

- Inputs/selects have enough height so text is not clipped.
- Action labels are concise and stable (`Apply`, `Confirm`, `Save`, etc.).
- Avoid dense metadata in list rows; move secondary details to tooltip/drawer/popover.

## 5) Action hierarchy

- Primary action: solid/highest emphasis.
- Secondary action: outlined/subtle.
- Destructive action: red treatment only for destructive outcomes.

## 6) Row state semantics

- Priority, pushed, closed, and selected states are visually distinct and non-conflicting.
- Pushed/finalized rows remain interactive unless intentionally locked by business rules.
- Row tinting is subtle enough to preserve text readability.

## 7) Empty/loading/error quality

- Loading state is explicit (skeleton/text) and visually consistent.
- Empty-state copy is contextual and actionable.
- Error states use concise language and recovery guidance where possible.

## 8) Accessibility and keyboard

- Focus rings are clearly visible on all interactive controls.
- Tab order follows visual order.
- Escape closes overlays.
- Keyboard shortcuts do not interfere with typing in input fields.
- Color contrast is acceptable in normal and high-contrast modes.

## 9) Data density and responsiveness

- Dense/comfortable view exists where row-heavy screens need it.
- Critical controls remain usable on laptop width without horizontal overflow chaos.
- Sticky regions (toolbar/header/action column) do not block content interaction.

## 10) Release gate (quick pass)

Before merge/deploy:

1. Check at laptop viewport (13"-14") and one larger display.
2. Verify no clipped text in selects/inputs/chips.
3. Verify table scanability with and without filters.
4. Verify top-level actions, shortcuts, and drawer open/close flow.
5. Run typecheck and lints.

---

## Suggested command sequence

```bash
npx tsc --noEmit
```

Then run module smoke checks manually for:

- Customer PO
- Planning
- Artwork Queue

