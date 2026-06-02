import { memo } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'
import { getPlanningRequirement } from './planningRequirement'

const nf = new Intl.NumberFormat('en-IN')

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div className="text-sm font-semibold text-ds-ink mt-0.5 truncate">{value ?? '—'}</div>
    </div>
  )
}

function statusTone(status: string | null | undefined): ComponentProps<typeof Badge>['tone'] {
  const s = String(status ?? '').toLowerCase()
  if (['stock ready', 'ready', 'reserved', 'released', 'completed'].some((x) => s.includes(x))) return 'success'
  if (s.includes('planning')) return 'info'
  if (s.includes('draft') || s.includes('pending')) return 'brand'
  if (s.includes('hold') || s.includes('short')) return 'warning'
  return 'neutral'
}

function displayDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
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
  const status = readiness?.status === 'green'
    ? 'Stock ready'
    : readiness?.status === 'yellow'
      ? 'Partially covered'
      : readiness?.status === 'red'
        ? 'Shortage'
        : line.planningStatus || 'Draft'
  const setType = line.batchDecision?.layoutType ?? 'Single'
  const unit = line.sheetSpec?.unit === 'inch' ? 'inch' : 'mm'
  const requirement = getPlanningRequirement(line)
  const totalPoQty = requirement.totalPoQty > 0 ? `${nf.format(Math.round(requirement.totalPoQty))} pcs` : '—'
  const requiredSheets = requirement.totalRequired != null
    ? `${nf.format(Math.round(requirement.totalRequired))} sheets`
    : readiness?.requiredSheets && readiness.requiredSheets > 0
      ? `${nf.format(Math.round(readiness.requiredSheets))} sheets`
      : '—'

  return (
    <CardSection
      title="PRODUCT / JOB INFO"
      className="sticky top-0 z-20 border border-ds-line/30"
    >
      <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-4">
        <div className="flex h-[72px] w-[88px] items-center justify-center rounded-ds-md border border-ds-line/30 bg-ds-elevated/70 overflow-hidden">
          <div className="relative h-10 w-14 rounded-sm border border-ds-line/50 bg-ds-main shadow-sm">
            <div className="absolute inset-x-1 top-2 h-1 rounded-full bg-ds-line/50" />
            <div className="absolute inset-x-1 top-5 h-1 rounded-full bg-ds-line/35" />
            <div className="absolute right-1 top-1 bottom-1 w-3 rounded-sm bg-ds-brand/15" />
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-x-5 gap-y-3">
            <Field label="Product name" value={line.cartonName || '—'} />
            <Field label="AW code" value={line.artworkCode || '—'} />
            <Field label="Customer" value={line.po?.customer?.name || '—'} />
            <Field label="PO number" value={line.po?.poNumber || '—'} />
            <Field label="Total PO qty" value={totalPoQty} />
            <Field label="Required qty" value={requiredSheets} />
            <Field label="Delivery date" value={displayDate(line.po?.poDate)} />
            <Field
              label="Status"
              value={<Badge tone={statusTone(status)} className="normal-case tracking-normal">{status}</Badge>}
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-x-5 gap-y-3">
            <Field label="Board type" value={boardType || '—'} />
            <Field label="GSM" value={gsm != null ? String(gsm) : '—'} />
            <Field label="Carton size" value={line.cartonSize || '—'} />
            <Field label="Unit" value={unit} />
            <Field
              label="Set type"
              value={<Badge tone={setType === 'Gang' ? 'info' : 'success'} className="normal-case tracking-normal">{setType}</Badge>}
            />
            <Field
              label="Planning status"
              value={<Badge tone={statusTone(line.planningStatus)} className="normal-case tracking-normal">{line.planningStatus || 'Draft'}</Badge>}
            />
          </div>
        </div>
      </div>
    </CardSection>
  )
})
