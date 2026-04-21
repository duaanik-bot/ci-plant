/**
 * Shared enterprise data-grid tokens — use with {@link EnterpriseTableShell}.
 * Light: surfaces white, borders slate-200. Dark: slate-950 body, slate-900 headers.
 */

/** Root `<table>` — full width, readable body size */
export const enterpriseTableClass =
  'w-full border-collapse text-left text-sm text-slate-900 dark:text-slate-50'

/** Table header row area */
export const enterpriseTheadClass =
  'border-b border-slate-200 bg-white text-xs font-semibold uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400'

/** Table body — dividers + base row background */
export const enterpriseTbodyClass =
  'divide-y divide-slate-200 bg-white dark:divide-slate-800 dark:bg-slate-950'

/** Body row — hover scan line */
export const enterpriseTrClass =
  'transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50'

/** Header cell */
export const enterpriseThClass =
  'px-4 py-3 text-left font-semibold whitespace-nowrap overflow-hidden text-ellipsis'

/** Data cell padding + type — add ellipsis variant when needed */
export const enterpriseTdBase =
  'px-4 py-3 text-sm font-medium align-middle text-slate-900 dark:text-slate-50'

/** Standard data cell (single-line, clipped) */
export const enterpriseTdClass = `${enterpriseTdBase} whitespace-nowrap overflow-hidden text-ellipsis`

/** PO #, qty, dates, IDs — JetBrains Mono (root variable) */
export const enterpriseTdMonoClass = `${enterpriseTdClass} font-designing-queue tabular-nums tracking-tight`

/** Secondary / muted cell */
export const enterpriseTdMutedClass =
  'px-4 py-3 text-sm text-slate-600 dark:text-slate-400 whitespace-nowrap overflow-hidden text-ellipsis'

/** Sub-label in table context */
export const enterpriseTableSubLabelClass = 'text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400'
