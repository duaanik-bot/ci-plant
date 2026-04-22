/**
 * Shared enterprise data-grid tokens — use with {@link EnterpriseTableShell}.
 * Maps to the global `ds` palette; light theme uses neutral surfaces, dark uses premium tokens.
 */

/** Root `<table>` — full width, readable body size */
export const enterpriseTableClass =
  'w-full border-collapse text-left text-sm text-neutral-900 dark:text-ds-ink'

/** Table header row area */
export const enterpriseTheadClass =
  'border-b border-neutral-200 bg-white text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:border-ds-line/50 dark:bg-ds-elevated/80 dark:text-ds-ink-faint'

/** Table body — dividers + base row background */
export const enterpriseTbodyClass =
  'divide-y divide-neutral-200 bg-white dark:divide-ds-line/30 dark:bg-ds-main'

/** Body row — hover scan line */
export const enterpriseTrClass =
  'transition-colors duration-200 hover:bg-neutral-50 dark:hover:bg-ds-elevated/25'

/** Header cell */
export const enterpriseThClass =
  'px-4 py-3 text-left font-semibold whitespace-nowrap overflow-hidden text-ellipsis'

/** Data cell padding + type — add ellipsis variant when needed */
export const enterpriseTdBase =
  'px-4 py-3 text-sm font-medium align-middle text-neutral-900 dark:text-ds-ink'

/** Standard data cell (single-line, clipped) */
export const enterpriseTdClass = `${enterpriseTdBase} whitespace-nowrap overflow-hidden text-ellipsis`

/** PO #, qty, dates, IDs — JetBrains Mono (root variable) */
export const enterpriseTdMonoClass = `${enterpriseTdClass} font-designing-queue tabular-nums tracking-tight`

/** Secondary / muted cell */
export const enterpriseTdMutedClass =
  'px-4 py-3 text-sm text-neutral-600 dark:text-ds-ink-muted whitespace-nowrap overflow-hidden text-ellipsis'

/** Sub-label in table context */
export const enterpriseTableSubLabelClass =
  'text-xs uppercase tracking-wider text-neutral-500 dark:text-ds-ink-faint'
