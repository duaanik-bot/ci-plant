import { memo } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import type { PlanningEngineReadiness } from './types'

const nf = new Intl.NumberFormat('en-IN')
const fmt = (n: number | null | undefined) =>
  n != null && Number.isFinite(Number(n)) ? `${nf.format(Math.round(Number(n)))} sh` : '—'

export const SectionWarehouseAvailability = memo(function SectionWarehouseAvailability({
  readiness,
  onOpenWarehouse,
}: {
  readiness: PlanningEngineReadiness | null
  onOpenWarehouse?: () => void
}) {
  const shortage = Number(readiness?.shortageSheets ?? 0)
  const free = Number(readiness?.freeSheets ?? 0)
  const status = !readiness?.materialCode ? 'No board selected' : shortage > 0 ? 'Short' : free > 0 ? 'Available' : 'Reserved'
  return (
    <CardSection
      title="WAREHOUSE STOCK"
      action={
        onOpenWarehouse ? (
          <button
            type="button"
            onClick={onOpenWarehouse}
            className="rounded-ds-sm border border-ds-line/50 bg-ds-elevated px-3 py-1.5 text-xs font-semibold text-ds-ink transition-colors hover:border-ds-brand/50"
          >
            Open warehouse
          </button>
        ) : null
      }
    >
      <div className="overflow-hidden rounded-ds-md border border-ds-line/40 bg-ds-main">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-left">
          <thead className="bg-ds-elevated/70">
            <tr className="border-b border-ds-line/40">
              {['Code', 'Board Size', 'GSM', 'Available', 'Reserved', 'Free', 'Status'].map((head) => (
                <th key={head} scope="col" className="px-3 py-2.5 text-[13px] font-medium text-ds-ink-muted">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-3 py-3 text-[15px] font-semibold text-ds-ink">{readiness?.materialCode || '—'}</td>
              <td className="px-3 py-3 text-[15px] font-semibold text-ds-ink tabular-nums">{readiness?.size || '—'}</td>
              <td className="px-3 py-3 text-[15px] font-semibold text-ds-ink tabular-nums">{readiness?.gsm ?? '—'}</td>
              <td className="px-3 py-3 text-[15px] font-semibold text-ds-ink tabular-nums">{fmt(readiness?.availableSheets)}</td>
              <td className="px-3 py-3 text-[15px] font-semibold text-ds-ink tabular-nums">{fmt(readiness?.reservedSheets)}</td>
              <td className="px-3 py-3 text-[15px] font-semibold text-ds-ink tabular-nums">{fmt(readiness?.freeSheets)}</td>
              <td className="px-3 py-3">
                <span
                  className={[
                    'inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold',
                    shortage > 0
                      ? 'border-amber-500/35 bg-amber-500/10 text-amber-300'
                      : readiness?.materialCode
                        ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                        : 'border-ds-line/45 bg-ds-elevated text-ds-ink-muted',
                  ].join(' ')}
                >
                  {status}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
      <div className={['text-[13px] font-medium', shortage > 0 ? 'text-amber-300' : 'text-ds-ink-muted'].join(' ')}>
        Required {fmt(readiness?.requiredSheets)}{shortage > 0 ? ` · Shortage ${fmt(shortage)}` : ''}
      </div>
    </CardSection>
  )
})
