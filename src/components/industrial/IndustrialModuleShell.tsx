import type { ReactNode } from 'react'

const TABLE_SHELL =
  'overflow-x-auto rounded-lg border border-slate-700/80 bg-card ring-1 ring-ring/20'

export function industrialTableClassName(): string {
  return TABLE_SHELL
}

/** Pure-black industrial shell with optional 4-tile KPI row (glassmorphism). */
export function IndustrialModuleShell({
  title,
  subtitle,
  kpiRow,
  children,
  className = '',
}: {
  title: string
  subtitle?: string
  kpiRow?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`min-h-screen bg-background text-slate-200 ${className}`}>
      <div className="mx-auto max-w-[1800px] space-y-4 p-3 md:p-4 pb-24">
        <header className="space-y-1">
          <h1 className="text-lg md:text-xl font-bold tracking-tight text-amber-400">{title}</h1>
          {subtitle ? <p className="text-[11px] text-slate-500">{subtitle}</p> : null}
        </header>
        {kpiRow ? (
          <div className="grid grid-cols-2 gap-2 md:gap-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-8">
            {kpiRow}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  )
}
