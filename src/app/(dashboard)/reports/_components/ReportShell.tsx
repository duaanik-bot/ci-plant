'use client'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { useState } from 'react'
import type { ReportResult } from '@/lib/reports/types'
import { FilterBar, type FilterField } from './FilterBar'
import { KpiCards } from './KpiCards'
import { ReportChart } from './ReportChart'
import { ReportTable } from './ReportTable'
import { ExportButtons } from './ExportButtons'

export function ReportShell({
  reportId, title, kpi, filterFields,
}: { reportId: string; title: string; kpi: string; filterFields: FilterField[] }) {
  const sp = useSearchParams()
  const [view, setView] = useState<string | null>(null)
  const baseQuery = sp.toString()
  const query = view ? `${baseQuery}${baseQuery ? '&' : ''}view=${view}` : baseQuery

  const { data, isLoading, isError, refetch } = useQuery<ReportResult>({
    queryKey: ['report', reportId, query],
    queryFn: async () => {
      const res = await fetch(`/api/reports/${reportId}?${query}`)
      if (!res.ok) throw new Error('failed')
      return res.json()
    },
  })

  return (
    <section className="p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-sm text-ds-ink-muted">{kpi}</p>
        </div>
        <ExportButtons reportId={reportId} query={query} />
      </div>

      <FilterBar fields={filterFields} />

      {data?.views && (
        <div className="flex gap-2">
          {data.views.map((v) => (
            <button key={v.id} onClick={() => setView(v.id)}
              className={`rounded-md px-3 py-1 text-sm ${
                (view ?? data.views![0].id) === v.id
                  ? 'bg-[var(--info)] text-white' : ''}`}>
              {v.label}
            </button>
          ))}
        </div>
      )}

      {isLoading && <div className="text-sm text-ds-ink-muted">Loading…</div>}
      {isError && (
        <div className="text-sm text-[var(--danger)]">
          Could not load report.{' '}
          <button onClick={() => refetch()} className="underline">Retry</button>
        </div>
      )}
      {data && data.rows.length === 0 && (
        <div className="text-sm text-ds-ink-muted">No data for the selected filters.</div>
      )}
      {data && data.rows.length > 0 && (
        <>
          <KpiCards cards={data.summary} />
          <ReportChart chart={data.chart} />
          <ReportTable result={data} />
        </>
      )}
    </section>
  )
}
