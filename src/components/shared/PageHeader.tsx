import type { ReactNode } from 'react'

/**
 * PageHeader
 * ───────────
 * Consistent title + optional subtitle + optional action slot
 * at the top of every module page.
 *
 * Usage:
 *   <PageHeader
 *     title="Customers"
 *     subtitle="Manage your customer master"
 *     action={<Button icon={Plus} onClick={() => setShowForm(true)}>Add Customer</Button>}
 *   />
 */
interface PageHeaderProps {
  title: string
  subtitle?: string
  action?: ReactNode
}

export function PageHeader({ title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        <h1 className="text-xl font-bold text-ds-ink leading-tight">{title}</h1>
        {subtitle && (
          <p className="text-sm text-ds-ink-muted mt-0.5">{subtitle}</p>
        )}
      </div>
      {action && <div className="ml-4 shrink-0">{action}</div>}
    </div>
  )
}

export default PageHeader
