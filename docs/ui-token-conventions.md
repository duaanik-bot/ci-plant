# UI Token Conventions

Use shared UI token classes for chips and compact actions instead of re-declaring long class strings in feature files.

## Source of truth

Import tokens from:

- `@/components/design-system/tokens`

## Available tokens

- `STATUS_CHIP_BASE` - Base style for compact status chips.
- `PUSHED_CHIP_CLASS` - Standard green "Pushed" chip style.
- `ACTION_PILL_BASE` - Base style for compact text action pills.
- `ACTION_PILL_NEUTRAL` - Neutral variant for action pills.
- `ICON_BUTTON_BASE` - Base style for icon-only buttons.
- `ICON_BUTTON_TIGHT` - Tighter icon button variant for dense rows.
- `ds-typo-kpi` (from `globals.css`) - High-contrast numeric KPI style.

## Usage rules

- Prefer composing tokens with minimal state-specific classes.
- Keep semantic/state colors local (`hover:*`, success/warning variants), but keep geometry/typography in tokens.
- For any new table row action/status chip, start from these tokens first.
- If a new reusable pattern appears in more than one module, add a token in `design-system/tokens.ts` rather than copying class strings.
- Reuse `RowStateLegend` (`@/components/ui/RowStateLegend`) instead of repeating row-state legend markup.

## Validation

- Before shipping UI token changes, run: `docs/ui-visual-regression-checklist.md`.

## Example

```tsx
import { ACTION_PILL_NEUTRAL, PUSHED_CHIP_CLASS, STATUS_CHIP_BASE } from '@/components/design-system/tokens'

<span className={`${STATUS_CHIP_BASE} border-sky-500/40 bg-sky-500/10 text-sky-300`}>Draft</span>
<span className={PUSHED_CHIP_CLASS}>Pushed 12m ago</span>
<button className={`${ACTION_PILL_NEUTRAL} hover:border-ds-warning/50 hover:bg-ds-warning/8`}>Edit</button>
```
