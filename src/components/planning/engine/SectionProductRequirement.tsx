import { memo } from 'react'
import type { ReactNode } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'

const nf = new Intl.NumberFormat('en-IN')

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div className="text-sm font-semibold text-ds-ink mt-0.5 truncate">{value ?? '—'}</div>
    </div>
  )
}

export const SectionProductRequirement = memo(function SectionProductRequirement({
  line,
  readiness,
}: {
  line: PlanningEngineLine
  readiness: PlanningEngineReadiness | null
}) {
  const boardType = readiness?.boardType ?? line.paperType ?? null
  const gsm = readiness?.gsm ?? line.gsm ?? null
  return (
    <CardSection title="PRODUCT REQUIREMENT">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Field label="Customer PO" value={line.po?.poNumber || '—'} />
        <Field label="Product" value={line.cartonName || '—'} />
        <Field label="Product / AW code" value={line.artworkCode || '—'} />
        <Field label="Customer" value={line.po?.customer?.name || '—'} />
        <Field label="Board type" value={boardType || '—'} />
        <Field label="GSM" value={gsm != null ? String(gsm) : '—'} />
        <Field label="Final carton size" value={line.cartonSize || '—'} />
        <Field label="Required qty" value={line.quantity != null ? nf.format(line.quantity) : '—'} />
        <Field label="Status" value={line.planningStatus || '—'} />
      </div>
    </CardSection>
  )
})
