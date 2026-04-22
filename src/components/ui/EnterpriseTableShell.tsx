import type { ReactNode } from 'react'

export {
  enterpriseTableClass,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseThClass,
  enterpriseTdBase,
  enterpriseTdClass,
  enterpriseTdMonoClass,
  enterpriseTdMutedClass,
  enterpriseTableSubLabelClass,
} from '@/lib/enterprise-table-styles'

/**
 * Standard wrapper for data grids: horizontal scroll, ring, rounded corners, theme-aware.
 */
export function EnterpriseTableShell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`w-full overflow-x-auto overflow-y-hidden shadow-sm ring-1 ring-neutral-200 dark:ring-ds-line/40 sm:rounded-lg ${className}`}
    >
      {children}
    </div>
  )
}
