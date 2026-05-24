'use client'

import { useSearchParams } from 'next/navigation'
import { PrintPlanningKanban } from '@/components/production/print-planning/PrintPlanningKanban'
import { PageHeader } from '@/components/shared/PageHeader'

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
        <PageHeader
          title={`${plannerLabel} Planning`}
          subtitle={`Production · ${plannerLabel} planner — Drag cards to assign a press; order within a column is saved on the job card.`}
        />

        <PrintPlanningKanban />
      </div>
    </div>
  )
}
