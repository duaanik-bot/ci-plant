import type { ReactNode } from 'react'

export {
  enterpriseTableClass,
  enterpriseTheadClass,
  enterpriseTbodyClass,
  enterpriseTrClass,
  enterpriseTrSelectedClass,
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
      className={`w-full overflow-x-auto overflow-y-hidden rounded-ds-md border border-[var(--border)] bg-[var(--bg-card)] shadow-ds-depth-sm ${className}`}
    >
      {children}
    </div>
  )
}
