'use client'
import type { SummaryCard } from '@/lib/reports/types'

const tone: Record<string, string> = {
  good: 'text-[var(--success)]',
  bad: 'text-[var(--danger)]',
  neutral: 'text-ds-ink',
}

export function KpiCards({ cards }: { cards: SummaryCard[] }) {
  if (!cards.length) return null
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c, i) => (
        <div key={i} className="rounded-lg border border-ds-border p-3">
          <div className="text-xs text-ds-ink-muted">{c.label}</div>
          <div className={`text-xl font-semibold ${tone[c.tone ?? 'neutral']}`}>{c.value}</div>
        </div>
      ))}
    </div>
  )
}
