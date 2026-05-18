import Link from 'next/link'
import { listReports } from '@/lib/reports/registry'

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
    <section className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Reports</h1>
      {groups.map((g) => (
        <div key={g} className="space-y-2">
          <h2 className="text-sm font-semibold text-ds-ink-muted">{GROUP_LABEL[g] ?? g}</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {reports.filter((r) => r.group === g).map((r) => (
              <Link key={r.id} href={`/reports/${r.id}`}
                className="rounded-lg border border-ds-border p-4 hover:border-[var(--info)]">
                <div className="font-medium">{r.title}</div>
                <div className="text-xs text-ds-ink-muted mt-1">{r.kpi}</div>
              </Link>
            ))}
          </div>
        </div>
      ))}
      {reports.length === 0 && (
        <p className="text-sm text-ds-ink-muted">No reports registered yet.</p>
      )}
    </section>
  )
}
