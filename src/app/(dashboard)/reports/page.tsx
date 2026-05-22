import Link from 'next/link'
import { listReports } from '@/lib/reports/registry'
import { PageHeader } from '@/components/shared/PageHeader'

const GROUP_LABEL: Record<string, string> = {
  production: 'Production & Efficiency',
  quality: 'Quality',
  delivery: 'Delivery',
  material: 'Material & Waste',
  procurement: 'Procurement',
  maintenance: 'Maintenance',
}

export default function ReportsIndexPage() {
  const reports = listReports()
  const groups = Array.from(new Set(reports.map((r) => r.group)))
  return (
    <div className="p-4 max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Reports"
        subtitle="Analytics, KPIs, and operational summaries"
      />
      {groups.map((g) => (
        <div key={g} className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-ds-ink-muted">
            {GROUP_LABEL[g] ?? g}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {reports.filter((r) => r.group === g).map((r) => (
              <Link
                key={r.id}
                href={`/reports/${r.id}`}
                className="rounded-ds-lg border border-ds-line/50 bg-ds-card p-4 hover:border-ds-warning/60 hover:bg-ds-elevated/50 transition-colors"
              >
                <p className="text-sm font-semibold text-ds-ink">{r.title}</p>
                <p className="text-xs text-ds-ink-muted mt-1">{r.kpi}</p>
              </Link>
            ))}
          </div>
        </div>
      ))}
      {reports.length === 0 && (
        <p className="text-sm text-ds-ink-muted">No reports registered yet.</p>
      )}
    </div>
  )
}
