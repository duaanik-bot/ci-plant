'use client'

export type PrRow = {
  id: string
  materialId: string
  qtyRequired: number
  status: string
  triggerReason: string
  poReference: string | null
  raisedBy: string | null
  boardType: string | null
  gsm: number | null
  sizeLabel: string | null
  requiredByDate: string | null
  remarks: string | null
  supplierId: string | null
  sourceJobCardId?: string | null
  sourcePlanningId?: string | null
  material: { materialCode: string; description: string; unit: string }
  linkedShortages?: Array<{
    jobCardId: string | null
    jobCardNumber: number | null
    requiredByDate: string | null
    pendingShortage: number
    requiredQty: number
  }>
  monitoring?: {
    poNumber: string
    vendorName: string | null
    status: string
    eta: string | null
    orderedQty: number | null
    receivedQty: number | null
    pendingQty: number | null
  } | null
}

function reservationTotals(pr: PrRow) {
  const linked = pr.linkedShortages ?? []
  const required = Number(pr.qtyRequired)
  const purchaseReq = linked.reduce((s, l) => s + Number(l.pendingShortage), 0)
  const reserved = Math.max(0, required - purchaseReq)
  const jobs = new Set(linked.map((l) => l.jobCardId).filter(Boolean) as string[])
  if (pr.sourceJobCardId) jobs.add(pr.sourceJobCardId)
  return { required, reserved, purchaseReq, jobCount: jobs.size }
}

export function PrCompactCard({
  pr,
  selectable,
  selected,
  onToggleSelect,
  onOpen,
}: {
  pr: PrRow
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  onOpen: () => void
}) {
  const t = reservationTotals(pr)
  const urgent = (pr.linkedShortages?.length ?? 0) > 0 && pr.status === 'pending'
  return (
    <div className="rounded-ds-md border border-ds-line/40 bg-background px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        {selectable ? (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            className="h-3.5 w-3.5 shrink-0"
          />
        ) : null}
        <button type="button" onClick={onOpen} className="flex-1 text-left">
          <span className="font-semibold text-ds-ink">{pr.material.materialCode}</span>
          {pr.boardType ? <span className="text-ds-ink-muted"> · {pr.boardType}</span> : null}
          {pr.raisedBy === null ? <span className="ml-1 text-[10px] text-ds-warning">⚡</span> : null}
          <span className={`ml-1 inline-block h-1.5 w-1.5 rounded-full ${urgent ? 'bg-[var(--error)]' : 'bg-[var(--warning)]'}`} />
        </button>
      </div>
      <button type="button" onClick={onOpen} className="mt-1 block w-full text-left text-[11px] text-ds-ink-faint">
        <span>Qty {t.required.toLocaleString('en-IN')}</span>
        <span> · Rsv {t.reserved.toLocaleString('en-IN')}</span>
        <span> · Buy {t.purchaseReq.toLocaleString('en-IN')}</span>
        {pr.requiredByDate ? <span> · {new Date(pr.requiredByDate).toLocaleDateString('en-IN')}</span> : null}
        {t.jobCount > 0 ? <span> · 🔗{t.jobCount}</span> : null}
      </button>
    </div>
  )
}

export function OrderedConsolidatedCard({
  materialCode,
  boardType,
  gsm,
  sizeLabel,
  totalQty,
  memberCount,
  monitoring,
  selectable,
  selected,
  onToggleSelect,
  onOpen,
}: {
  materialCode: string
  boardType: string | null
  gsm: number | null
  sizeLabel: string | null
  totalQty: number
  memberCount: number
  monitoring: PrRow['monitoring']
  selectable: boolean
  selected: boolean
  onToggleSelect: () => void
  onOpen: () => void
}) {
  return (
    <div className="rounded-ds-md border border-ds-line/40 bg-background px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        {monitoring ? null : (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            className="h-3.5 w-3.5 shrink-0"
            disabled={!selectable}
          />
        )}
        <button type="button" onClick={onOpen} className="flex-1 text-left">
          <span className="font-semibold text-ds-ink">{materialCode}</span>
          {boardType ? <span className="text-ds-ink-muted"> · {boardType}</span> : null}
          {gsm ? <span className="text-ds-ink-muted"> · {gsm}g</span> : null}
          {sizeLabel ? <span className="text-ds-ink-muted"> · {sizeLabel}</span> : null}
        </button>
      </div>
      {monitoring ? (
        <button type="button" onClick={onOpen} className="mt-1 block w-full text-left text-[11px] text-ds-ink-faint">
          <span className="font-semibold text-ds-ink">{monitoring.poNumber}</span>
          {monitoring.vendorName ? <span> · {monitoring.vendorName}</span> : null}
          <br />
          <span>Ord {Number(monitoring.orderedQty ?? totalQty).toLocaleString('en-IN')}</span>
          <span> · Rcv {Number(monitoring.receivedQty ?? 0).toLocaleString('en-IN')}</span>
          <span> · Bal {Number(monitoring.pendingQty ?? 0).toLocaleString('en-IN')}</span>
          {monitoring.eta ? <span> · ETA {new Date(monitoring.eta).toLocaleDateString('en-IN')}</span> : null}
        </button>
      ) : (
        <button type="button" onClick={onOpen} className="mt-1 block w-full text-left text-[11px] text-ds-ink-faint">
          <span>Total {totalQty.toLocaleString('en-IN')}</span>
          <span> · {memberCount} PR{memberCount === 1 ? '' : 's'}</span>
          <span className="ml-1 rounded bg-ds-warning/15 px-1 text-ds-warning">Awaiting PO</span>
        </button>
      )}
    </div>
  )
}
