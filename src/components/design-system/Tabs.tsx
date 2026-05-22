'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type TabItem = { id: string; label: ReactNode }

type TabsProps = {
  tabs: TabItem[]
  activeId: string
  onChange: (id: string) => void
  className?: string
}

/** App-standard underline tab strip — token-driven, no raw colors. */
export function Tabs({ tabs, activeId, onChange, className }: TabsProps) {
  return (
    <div role="tablist" className={cn('flex items-center gap-1 border-b border-[var(--border)]', className)}>
      {tabs.map((t) => {
        const active = t.id === activeId
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'border-[var(--brand-primary)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
