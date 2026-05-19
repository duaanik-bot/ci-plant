import { notFound } from 'next/navigation'
import { getReport } from '@/lib/reports/registry'
import { ReportShell } from '../_components/ReportShell'
import { filterFieldsFor } from '../_components/filter-fields'

export const dynamic = 'force-dynamic'

export default function ReportViewerPage({ params }: { params: { reportId: string } }) {
  const mod = getReport(params.reportId)
  if (!mod) notFound()
  return (
    <ReportShell
      reportId={mod.id}
      title={mod.title}
      kpi={mod.kpi}
      filterFields={filterFieldsFor(mod.id)}
    />
  )
}
