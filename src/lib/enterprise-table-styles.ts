/**
 * Shared enterprise data-grid tokens — use with {@link EnterpriseTableShell}.
 * Uses global DS CSS variables so light/dark/high-contrast themes all work
 * without any dark: prefix overrides here.
 */

/** Root `<table>` — full width, readable body size */
export const enterpriseTableClass =
  'w-full border-collapse text-left text-sm text-[var(--text-primary)]'

/** Table header row area */
export const enterpriseTheadClass =
  'border-b border-[var(--border)] bg-[var(--bg-elevated)] text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]'

/** Table body — dividers + base row background */
export const enterpriseTbodyClass =
  'divide-y divide-[var(--border)] bg-[var(--bg-card)]'

/** Body row — hover scan line */
export const enterpriseTrClass =
  'transition-[background-color,box-shadow] duration-150 ease-out hover:bg-[var(--bg-elevated)]'

/** Selected / active row — left brand rail (use on `<tr>`) */
export const enterpriseTrSelectedClass =
  'bg-[var(--brand-bg-soft)] shadow-[inset_3px_0_0_0_var(--brand-primary)] ring-1 ring-inset ring-[var(--brand-primary)]/20'

/** Header cell */
export const enterpriseThClass =
  'px-4 py-3 text-left font-semibold whitespace-nowrap overflow-hidden text-ellipsis'

/** Data cell padding + type — add ellipsis variant when needed */
export const enterpriseTdBase =
  'px-4 py-3 text-sm font-medium align-middle text-[var(--text-primary)]'

/** Standard data cell (single-line, clipped) */
export const enterpriseTdClass = `${enterpriseTdBase} whitespace-nowrap overflow-hidden text-ellipsis`

/** PO #, qty, dates, IDs — monospace (JetBrains Mono loaded globally) */
export const enterpriseTdMonoClass = `${enterpriseTdClass} font-[var(--font-mono-code,var(--font-sans))] tabular-nums tracking-tight`

/** Secondary / muted cell */
export const enterpriseTdMutedClass =
  'px-4 py-3 text-sm text-[var(--text-secondary)] whitespace-nowrap overflow-hidden text-ellipsis'

/** Sub-label in table context */
export const enterpriseTableSubLabelClass =
  'text-xs uppercase tracking-wider text-[var(--text-secondary)]'
