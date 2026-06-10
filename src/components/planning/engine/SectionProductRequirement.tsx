import { memo } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import { Badge } from '@/components/design-system/Badge'
import type { PlanningEngineLine, PlanningEngineReadiness } from './types'
import { getPlanningRequirement } from './planningRequirement'

const nf = new Intl.NumberFormat('en-IN')

function Field({
  label,
  value,
  className = '',
  valueClassName = 'truncate',
}: {
  label: string
  value: ReactNode
  className?: string
  valueClassName?: string
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div className={`text-sm font-semibold text-ds-ink mt-0.5 ${valueClassName}`}>{value ?? '—'}</div>
    </div>
  )
}

function DecisionChip({
  label,
  value,
  tone = 'slate',
}: {
  label: string
  value: ReactNode
  tone?: 'blue' | 'green' | 'amber' | 'red' | 'slate'
}) {
  const toneClass =
    tone === 'green'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
      : tone === 'amber'
        ? 'border-amber-200 bg-amber-50 text-amber-950'
        : tone === 'red'
          ? 'border-rose-200 bg-rose-50 text-rose-950'
          : tone === 'blue'
            ? 'border-sky-200 bg-sky-50 text-sky-950'
            : 'border-slate-200 bg-slate-50 text-slate-900'

  return (
    <div className={`min-w-0 rounded-full border px-2.5 py-1 ${toneClass}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">{label}</div>
      <div className="truncate text-xs font-bold leading-snug">{value ?? '—'}</div>
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
  const batchStatusRaw = line.batchDecision?.status
  const batchDecisionLabel = batchStatusRaw === 'Hold' ? 'Hold' : 'Release'
  const batchDecisionTone = batchStatusRaw === 'Hold' ? 'red' : 'green'
  const designerName =
    line.batchDecision?.designerOptions.find((d) => d.id === line.batchDecision?.designerId)?.name ?? 'Not assigned'
  const setNumber = line.batchDecision?.setNumber || 'Auto'
  const materialLabel = readiness?.materialCode || 'No material linked'
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
      className="border border-ds-line/30"
    >
      <div className="space-y-3">
          <div className="space-y-2">
            <Field
              label="Product name"
              value={line.cartonName || '—'}
              valueClassName="whitespace-normal break-words leading-snug max-w-full"
            />
            <div className="grid grid-cols-2 gap-x-5 gap-y-3 md:grid-cols-4 xl:grid-cols-7">
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
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-x-5 gap-y-2">
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

          <div>
            <div className="flex flex-wrap gap-1.5">
              <DecisionChip label="Decision" value={batchDecisionLabel} tone={batchDecisionTone} />
              <DecisionChip label="Layout" value={setType} tone={setType === 'Gang' ? 'blue' : 'green'} />
              <DecisionChip label="Set No." value={setNumber} tone="slate" />
              <DecisionChip label="Designer" value={designerName} tone="blue" />
              <DecisionChip label="Material" value={materialLabel} tone={readiness?.materialId ? 'green' : 'amber'} />
            </div>
          </div>
      </div>
    </CardSection>
  )
})
