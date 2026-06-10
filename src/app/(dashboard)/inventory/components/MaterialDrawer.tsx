'use client'

import { useEffect, useState } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
import { cn } from '@/lib/cn'
import type { PaperWarehouseRow } from '../page'

type Reservation = {
  id: string
  jobCardNumber: number
  productName: string
  reservedSheets: number
  requiredByDate: string | null
}

type HistoryPayload = {
  logs?: Array<{
    id: string
    movementType: string
    qty: number
    refType: string | null
    refId: string | null
    createdAt: string
  }>
}

type Tab = 'overview' | 'reservations' | 'history'
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'reservations', label: 'Reservations' },
  { id: 'history', label: 'History' },
]

const nf = new Intl.NumberFormat('en-IN')
const PROCUREMENT_MOVED_MESSAGE =
  'Procurement workflow moved to new Procurement module. New PR/PO/GRN flow will be enabled in next phase.'

export type MaterialDrawerProps = {
  row: PaperWarehouseRow | null
  isOpen: boolean
  onClose: () => void
}

export function MaterialDrawer({ row, isOpen, onClose }: MaterialDrawerProps) {
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [history, setHistory] = useState<HistoryPayload | null>(null)
  const rowId = row?.material_id ?? null

  useEffect(() => {
    if (!rowId) return
    setActiveTab('overview')
    setReservations([])
    setHistory(null)
  }, [rowId])

  useEffect(() => {
    if (!rowId || !isOpen) return
    if (activeTab === 'reservations' && reservations.length === 0) {
      fetch(`/api/inventory/paper-warehouse/${rowId}/reservations`)
        .then((r) => r.json())
        .then((d) => setReservations(d.reservations ?? d ?? []))
        .catch(() => setReservations([]))
    }
    if (activeTab === 'history' && !history) {
      fetch(`/api/inventory/paper-warehouse/${rowId}/details`)
        .then((r) => r.json())
        .then(setHistory)
        .catch(() => setHistory({ logs: [] }))
    }
  }, [activeTab, history, isOpen, reservations.length, rowId])

  if (!row) return null

  const free = Math.max(0, Number(row.available_sheets) - Number(row.reserved_sheets))
  const statusClass =
    Number(row.shortage_sheets) > 0
      ? 'bg-[var(--error-bg)] text-[var(--error)]'
      : free <= Number(row.reorder_level)
        ? 'bg-ds-warning/10 text-ds-warning'
        : 'bg-[var(--success-bg)] text-[var(--success)]'

  return (
    <GlobalPopoutModal
      isOpen={isOpen}
      onClose={onClose}
      title={row.material_code}
      metadata={[row.board_type_id, row.gsm ? `${row.gsm} gsm` : null, row.size_display].filter(Boolean).join(' · ')}
      mode="preview"
      size="lg"
    >
      <div className="-mx-4 mb-4 flex gap-0 px-4 md:-mx-6 md:px-6">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            className={cn(
              'pb-2 pr-4 text-sm font-medium transition-colors',
              activeTab === t.id
                ? 'border-b-2 border-ds-primary text-ds-ink'
                : 'text-ds-ink-muted hover:text-ds-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', statusClass)}>
              {row.status}
            </span>
            <span className="text-xs text-ds-ink-muted">
              Stock, reorder, reservation, and shortage visibility only.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {[
              { label: 'Available', value: `${nf.format(row.available_sheets)} sh` },
              { label: 'Reserved', value: `${nf.format(row.reserved_sheets)} sh` },
              { label: 'Free', value: `${nf.format(free)} sh` },
              { label: 'Shortage', value: `${nf.format(Number(row.shortage_sheets))} sh` },
              { label: 'Days of Cover', value: row.daysOfCover != null ? `${row.daysOfCover}d` : '-' },
              { label: 'Reorder Level', value: `${nf.format(row.reorder_level)} sh` },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-ds-md bg-ds-elevated/60 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
                <div className="mt-0.5 font-semibold tabular-nums text-ds-ink">{value}</div>
              </div>
            ))}
          </div>
          <div className="rounded-ds-md border border-ds-line/40 bg-ds-elevated/35 px-3 py-2 text-xs text-ds-ink-muted">
            {PROCUREMENT_MOVED_MESSAGE}
          </div>
        </div>
      )}

      {activeTab === 'reservations' && (
        <div className="flex flex-col gap-2">
          {reservations.length === 0 ? (
            <p className="text-sm text-ds-ink-muted">No reservations.</p>
          ) : (
            reservations.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-ds-md px-3 py-2 text-sm">
                <div>
                  <span className="font-medium text-ds-ink">JC-{r.jobCardNumber}</span>
                  {r.productName && <span className="ml-2 text-ds-ink-muted">{r.productName}</span>}
                </div>
                <div className="tabular-nums text-ds-ink">{nf.format(Number(r.reservedSheets))} sh</div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'history' && (
        <div className="flex flex-col gap-2">
          {!history ? (
            <p className="text-sm text-ds-ink-muted">Loading...</p>
          ) : !history.logs?.length ? (
            <p className="text-sm text-ds-ink-muted">No stock logs found.</p>
          ) : (
            history.logs.slice(0, 30).map((log) => (
              <div key={log.id} className="rounded-ds-md px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-ds-ink">{log.movementType}</span>
                  <span className="tabular-nums text-ds-ink">{nf.format(Number(log.qty))}</span>
                </div>
                <p className="mt-1 text-xs text-ds-ink-muted">
                  {new Date(log.createdAt).toLocaleString()} · {log.refType ?? '-'} {log.refId ? `· ${log.refId.slice(0, 8)}` : ''}
                </p>
              </div>
            ))
          )}
        </div>
      )}
    </GlobalPopoutModal>
  )
}
