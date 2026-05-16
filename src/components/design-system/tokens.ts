/**
 * Class-string tokens for chips, pills, and icon buttons.
 *
 * Palette hexes (brand orange #f5820d, success green #22c55e, warning #eab308,
 * info #3b82f6, error #ef4444, bg #0f1117 / #181c27, text #e5e7eb) live in
 * `src/styles/design-tokens.css` and are consumed here via CSS variables
 * (`var(--success)`, `var(--border)`, `var(--text-primary)`, …), so every
 * constant below picks up the dark palette automatically — no JS-side hex
 * constants to mirror.
 */
export const STATUS_CHIP_BASE =
  'inline-flex items-center rounded-ds-sm border px-1.5 py-px text-xs font-semibold uppercase tracking-wide leading-none'

export const PUSHED_CHIP_CLASS =
  `${STATUS_CHIP_BASE} border-[var(--success)]/35 bg-[var(--success-bg)] text-[var(--success)]`

export const ACTION_PILL_BASE =
  'inline-flex min-w-[80px] items-center justify-center gap-1 rounded-ds-sm border px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-40'

export const ACTION_PILL_NEUTRAL =
  `${ACTION_PILL_BASE} border-[var(--border)] bg-transparent text-[var(--text-primary)]`

export const ICON_BUTTON_BASE =
  'inline-flex items-center justify-center rounded-ds-sm p-1 transition-colors disabled:opacity-40'

export const ICON_BUTTON_TIGHT =
  'inline-flex items-center justify-center rounded-ds-sm p-0.5 transition-colors disabled:opacity-40'
