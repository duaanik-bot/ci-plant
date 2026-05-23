'use client'

import { useState, useEffect } from 'react'
import { GlobalPopoutModal } from '@/components/design-system/GlobalPopoutModal'
import { cn } from '@/lib/cn'
import { computeRag, ragDotClass } from '@/lib/procurement-rag'
import { computeSuggestion } from '@/lib/procurement-suggestions'
import { DirectPoDialog } from './DirectPoDialog'
import type { PaperWarehouseRow } from '../page'

type OpenPo = {
  id: string; poNumber: string; vendorName: string
  orderedKg: number; receivedKg: number; pendingKg: number
  requiredDeliveryDate: string | null; status: string; logisticsStatus: string | null
}

type Pr = {
  id: string; status: string; qtyRequired: number; requiredByDate: string | null
}

type Reservation = {
  id: string; jobCardNumber: number; productName: string; reservedSheets: number; requiredByDate: string | null
}

type Tab = 'overview' | 'reservations' | 'open-prs' | 'open-pos' | 'history'
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'reservations', label: 'Reservations' },
  { id: 'open-prs', label: 'Open PRs' },
  { id: 'open-pos', label: 'Open POs' },
  { id: 'history', label: 'History' },
]

const nf = new Intl.NumberFormat('en-IN')

export type MaterialDrawerProps = {
  row: PaperWarehouseRow | null
  isOpen: boolean
  onClose: () => void
  onPrCreated: () => void
  onPoCreated: () => void
}

export function MaterialDrawer({ row, isOpen, onClose, onPrCreated, onPoCreated }: MaterialDrawerProps) {
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [openPos, setOpenPos] = useState<OpenPo[]>([])
  const [openPrs, setOpenPrs] = useState<Pr[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [history, setHistory] = useState<unknown>(null)
  const [directPoTarget, setDirectPoTarget] = useState<{ prId?: string; prefillQty?: number; mode: 'direct' | 'from-pr' } | null>(null)

  // Reset on row change
  useEffect(() => {
    if (!row) return
    setActiveTab('overview')
    setOpenPos([])
    setOpenPrs([])
    setReservations([])
    setHistory(null)
  }, [row?.material_id])

  // Lazy fetch per tab
  useEffect(() => {
    if (!row || !isOpen) return
    const id = row.material_id
    if (activeTab === 'open-pos' && openPos.length === 0) {
      fetch(`/api/inventory/paper-warehouse/${id}/open-pos`)
        .then((r) => r.json()).then(setOpenPos).catch(() => {})
    }
    if (activeTab === 'open-prs' && openPrs.length === 0) {
      fetch(`/api/purchase-requisitions?materialId=${id}&status=pending,approved,ordered`)
        .then((r) => r.json()).then((d) => setOpenPrs(d.items ?? d ?? [])).catch(() => {})
    }
    if (activeTab === 'reservations' && reservations.length === 0) {
      fetch(`/api/inventory/paper-warehouse/${id}/reservations`)
        .then((r) => r.json()).then((d) => setReservations(d.reservations ?? d ?? [])).catch(() => {})
    }
    if (activeTab === 'history' && !history) {
      fetch(`/api/inventory/paper-warehouse/${id}/details`)
        .then((r) => r.json()).then(setHistory).catch(() => {})
    }
  }, [row?.material_id, activeTab, isOpen])

  if (!row) return null

  const rag = computeRag({
    shortage_sheets: Number(row.shortage_sheets),
    open_pr_id: row.open_pr_id ?? null,
    open_pr_status: row.open_pr_status ?? null,
    hasOpenPo: row.hasOpenPo ?? false,
  })

  const suggestion = computeSuggestion({
    shortage_sheets: Number(row.shortage_sheets),
    incoming_sheets: Number(row.incoming_sheets),
    reorder_level: Number(row.reorder_level),
    daysOfCover: row.daysOfCover,
    packet_weight: Number(row.packet_weight),
  })

  return (
    <>
      <GlobalPopoutModal
        isOpen={isOpen}
        onClose={onClose}
        title={row.material_code}
        metadata={[row.board_type_id, row.gsm ? `${row.gsm} gsm` : null, row.size_display].filter(Boolean).join(' · ')}
        mode="preview"
        size="lg"
      >
        {/* Tab bar */}
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

        {/* Overview tab */}
        {activeTab === 'overview' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <span className={cn('h-3 w-3 rounded-full', ragDotClass(rag))} />
              <span className="text-xs text-ds-ink-muted capitalize">{rag === 'green' ? 'Stock OK' : rag === 'amber' ? 'Shortage — being handled' : 'Shortage — action needed'}</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Available', value: nf.format(row.available_sheets) + ' sh' },
                { label: 'Reserved', value: nf.format(row.reserved_sheets) + ' sh' },
                { label: 'Incoming', value: nf.format(row.incoming_sheets) + ' sh' },
                { label: 'Shortage', value: nf.format(Number(row.shortage_sheets)) + ' sh' },
                { label: 'Days of Cover', value: row.daysOfCover != null ? `${row.daysOfCover}d` : '—' },
                { label: 'Reorder Level', value: nf.format(row.reorder_level) + ' sh' },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-ds-md bg-ds-elevated/60 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-ds-ink-faint">{label}</div>
                  <div className="mt-0.5 font-semibold tabular-nums text-ds-ink">{value}</div>
                </div>
              ))}
            </div>
            {suggestion && (
              <div className="flex items-center justify-between rounded-ds-md bg-ds-warning/5 px-4 py-3">
                <div>
                  <span className="mr-2 text-ds-warning">⚡</span>
                  <span className="text-sm font-medium text-ds-ink">
                    Suggested reorder: {nf.format(Math.round(suggestion.suggestedKg))} kg
                  </span>
                  <span className="ml-2 text-xs text-ds-ink-muted">(covers ~{suggestion.coversDays} days)</span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      await fetch(`/api/inventory/paper-warehouse/${row.material_id}/create-pr`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ qty: suggestion.suggestedKg }),
                      })
                      onPrCreated()
                    }}
                    className="rounded-ds-sm bg-ds-elevated px-3 py-1 text-xs font-medium text-ds-ink hover:bg-ds-elevated/80"
                  >
                    Create PR
                  </button>
                  <button
                    type="button"
                    onClick={() => setDirectPoTarget({ mode: 'direct', prefillQty: suggestion.suggestedKg })}
                    className="rounded-ds-sm bg-ds-primary px-3 py-1 text-xs font-medium text-white hover:opacity-90"
                  >
                    Fast-track PO →
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Reservations tab */}
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

        {/* Open PRs tab */}
        {activeTab === 'open-prs' && (
          <div className="flex flex-col gap-2">
            {openPrs.length === 0 ? (
              <p className="text-sm text-ds-ink-muted">No open purchase requisitions.</p>
            ) : (
              openPrs.map((pr) => (
                <div key={pr.id} className="flex items-center justify-between rounded-ds-md bg-ds-elevated/40 px-3 py-2 text-sm">
                  <div>
                    <span className="rounded-full bg-ds-elevated px-2 py-0.5 text-xs font-medium text-ds-ink-muted capitalize">{pr.status}</span>
                    <span className="ml-2 tabular-nums text-ds-ink">{nf.format(Number(pr.qtyRequired))} kg</span>
                    {pr.requiredByDate && (
                      <span className="ml-2 text-ds-ink-muted">{new Date(pr.requiredByDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                    )}
                  </div>
                  {(pr.status === 'approved' || pr.status === 'ordered') && (
                    <button
                      type="button"
                      onClick={() => setDirectPoTarget({ mode: 'from-pr', prId: pr.id, prefillQty: Number(pr.qtyRequired) })}
                      className="rounded-ds-sm bg-ds-primary px-3 py-1 text-xs font-medium text-white hover:opacity-90"
                    >
                      Generate PO →
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Open POs tab */}
        {activeTab === 'open-pos' && (
          <div className="flex flex-col gap-2">
            {openPos.length === 0 ? (
              <p className="text-sm text-ds-ink-muted">No open purchase orders.</p>
            ) : (
              openPos.map((po) => {
                const pct = po.orderedKg > 0 ? (po.receivedKg / po.orderedKg) * 100 : 0
                return (
                  <div key={po.id} className="rounded-ds-md px-3 py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-ds-ink">{po.poNumber}</span>
                      <span className="text-ds-ink-muted">{po.vendorName}</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ds-line/30">
                      <div
                        className={cn('h-full rounded-full', pct >= 100 ? 'bg-ds-success' : 'bg-ds-warning')}
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-xs text-ds-ink-muted">
                      <span>{nf.format(Math.round(po.receivedKg))} / {nf.format(Math.round(po.orderedKg))} kg received</span>
                      {po.requiredDeliveryDate && <span>ETA {new Date(po.requiredDeliveryDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        )}

        {/* History tab */}
        {activeTab === 'history' && (
          <div className="text-sm text-ds-ink-muted">
            {!history ? 'Loading…' : <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(history, null, 2)}</pre>}
          </div>
        )}
      </GlobalPopoutModal>

      {directPoTarget && (
        <DirectPoDialog
          isOpen={!!directPoTarget}
          onClose={() => setDirectPoTarget(null)}
          onSuccess={() => { setDirectPoTarget(null); onPoCreated() }}
          materialId={row.material_id}
          materialCode={row.material_code}
          boardType={row.board_type_id}
          gsm={row.gsm}
          mode={directPoTarget.mode}
          prId={directPoTarget.prId}
          prefillQty={directPoTarget.prefillQty}
        />
      )}
    </>
  )
}
