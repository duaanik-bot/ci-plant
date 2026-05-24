import { memo } from 'react'
import { CardSection } from '@/components/design-system/CardSection'
import type { PlanningEngineReadiness } from './types'

const nf = new Intl.NumberFormat('en-IN')
const fmt = (n: number | null | undefined) =>
  n != null && Number.isFinite(Number(n)) ? `${nf.format(Math.round(Number(n)))} sh` : '—'

function Tile({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="bg-ds-elevated rounded-ds-md border border-ds-line/40 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
      <div
        className={`text-base font-semibold leading-tight mt-1 tabular-nums ${danger ? 'text-red-300' : 'text-ds-ink'}`}
      >
        {value}
      </div>
    </div>
  )
}

export const SectionWarehouseAvailability = memo(function SectionWarehouseAvailability({
  readiness,
  onOpenWarehouse,
}: {
  readiness: PlanningEngineReadiness | null
  onOpenWarehouse?: () => void
}) {
  const shortage = Number(readiness?.shortageSheets ?? 0)
  return (
    <CardSection title="WAREHOUSE AVAILABILITY">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Available" value={fmt(readiness?.availableSheets)} />
        <Tile label="Reserved" value={fmt(readiness?.reservedSheets)} />
        <Tile label="Free" value={fmt(readiness?.freeSheets)} />
        <Tile label="Shortage" value={fmt(shortage)} danger={shortage > 0} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="text-xs text-ds-ink-faint truncate">
          {readiness?.materialCode ? (
            <>
              Selected board:{' '}
              <span className="text-ds-ink font-semibold">{readiness.materialCode}</span>
            </>
          ) : (
            'No board selected'
          )}
        </div>
        {onOpenWarehouse ? (
          <button
            type="button"
            onClick={onOpenWarehouse}
            className="shrink-0 rounded-full border border-ds-line/40 bg-ds-elevated px-3 py-1 text-xs font-semibold text-ds-ink hover:border-ds-brand/50 transition-colors"
          >
            Open warehouse
          </button>
        ) : null}
      </div>
    </CardSection>
  )
})
