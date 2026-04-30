'use client'

import { useSearchParams } from 'next/navigation'
import { PrintPlanningKanban } from '@/components/production/print-planning/PrintPlanningKanban'

const mono = 'font-designing-queue tabular-nums tracking-tight'

export default function PrintPlanningPage() {
  const searchParams = useSearchParams()
  const planner = (searchParams.get('planner') || 'print').toLowerCase()
  const plannerLabel =
    planner === 'coating'
      ? 'Coating'
      : planner === 'die'
        ? 'Die'
        : planner === 'pasting'
          ? 'Pasting'
          : 'Print'

  return (
    <div className="min-h-screen bg-background text-ds-ink pb-10">
      <div className="max-w-[100rem] mx-auto px-3 py-4 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ds-ink-faint">
              Production · {plannerLabel} planner
            </p>
            <h1 className={`text-xl font-bold text-ds-warning ${mono}`}>{plannerLabel} planning</h1>
            <p className="text-sm text-ds-ink-muted mt-1 max-w-2xl">
              Triage and the first three presses (by machine code). Drag cards to assign a press; order within a
              column is saved on the job card.
            </p>
          </div>
        </div>

        <PrintPlanningKanban />
      </div>
    </div>
  )
}
