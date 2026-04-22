import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

/** Class bundles for a minimal SaaS data table (no heavy borders, hover + selection via row class). */
export const dataTable = {
  wrap: 'min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-ds-md',
  table: 'w-full table-fixed border-separate border-spacing-0 text-left',
  thead: 'sticky top-0 z-20 border-b border-ds-line/50 bg-ds-elevated/80 backdrop-blur-sm',
  th: 'px-3 py-2.5 text-left text-[12px] font-semibold uppercase tracking-wider text-ds-ink-muted min-h-[50px] transition-colors duration-200',
  thSortBtn:
    'inline-flex w-full min-w-0 items-center gap-0.5 text-left text-[12px] font-semibold uppercase tracking-wider text-ds-ink-muted transition hover:text-ds-ink',
    thSticky:
    'sticky left-0 z-30 w-10 border-r border-ds-line/50 bg-ds-elevated shadow-[2px_0_12px_rgba(0,0,0,0.2)]',
  filter: {
    input:
      'w-full min-w-0 border-0 border-b border-ds-line/80 bg-transparent py-1.5 text-[13px] text-ds-ink placeholder:text-ds-ink-faint focus:border-b-2 focus:border-ds-brand focus:outline-none focus:ring-0',
  },
  tr: {
    body: 'border-b border-ds-line/25 transition-[background,box-shadow] duration-200 ease-out',
    hover: 'hover:bg-ds-elevated/35',
    selected:
      'bg-ds-brand/10 ring-1 ring-inset ring-ds-brand/25 shadow-[inset_0_0_0_1px_rgba(99,102,241,0.1)]',
  },
  td: {
    base: 'align-middle px-3 py-3 min-h-[50px] text-[13px] text-ds-ink',
    /** Primary emphasis — carton, qty, amounts */
    primary: 'text-[15px] font-semibold text-ds-ink',
    secondary: 'text-[13px] font-medium text-ds-ink-muted',
    tertiary: 'text-[11px] text-ds-ink-faint',
    money: 'text-right tabular-nums text-ds-success',
  },
  empty: 'px-4 py-6 text-center text-sm text-ds-ink-muted',
} as const

export function DataTableFrame({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-ds-md border border-ds-line/40 shadow-[0_1px_0_rgba(0,0,0,0.12)]',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}
