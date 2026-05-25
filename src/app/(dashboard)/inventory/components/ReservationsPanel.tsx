'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { toast } from '@/store/toastStore'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

type ReservationRow = {
  id: string
  jobCardId: string
  jobCardNumber: number
  customerName: string
  jobStatus: string
  requiredSheets: number
  reservedSheets: number
  confirmedQty: number | null
  isReleased: boolean
  isGhost: boolean
  createdAt: string
}

type PanelData = {
  materialId: string
  materialCode: string
  materialSpec: {
    boardType: string | null
    gsm: number | null
    sizeLabel: string | null
    sheetLength: number | null
    sheetWidth: number | null
  }
  totalReserved: number
  ghostCount: number
  reservations: ReservationRow[]
}

export function ReservationsPanel({
  materialId,
  open,
  onClose,
  onRefresh,
}: {
  materialId: string | null
  open: boolean
  onClose: () => void
  onRefresh?: () => void
}) {
  const [data, setData] = useState<PanelData | null>(null)
  const [loading, setLoading] = useState(false)
  const [releasingId, setReleasingId] = useState<string | null>(null)
  const [activeReasonById, setActiveReasonById] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open || !materialId) return
    setLoading(true)
    fetch(`/api/inventory/paper-warehouse/${materialId}/reservations`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => toast.error('Failed to load reservations'))
      .finally(() => setLoading(false))
  }, [open, materialId])

  async function reload() {
    if (!materialId) return
    const r = await fetch(`/api/inventory/paper-warehouse/${materialId}/reservations`)
    setData(await r.json())
    onRefresh?.()
  }

  async function releaseGhost(id: string) {
    setReleasingId(id)
    try {
      const res = await fetch(`/api/inventory/reservations/${id}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'manual_ghost_backfill' }),
      })
      if (!res.ok) throw new Error('Release failed')
      toast.success('Ghost reservation released')
      await reload()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setReleasingId(null)
    }
  }

  async function releaseActive(id: string) {
    const reason = (activeReasonById[id] ?? '').trim()
    if (reason.length < 3) {
      toast.error('Reason must be at least 3 characters')
      return
    }
    setReleasingId(id)
    try {
      const res = await fetch(`/api/inventory/reservations/${id}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      if (!res.ok) throw new Error('Release failed')
      toast.success('Reservation released')
      setActiveReasonById((s) => {
        const { [id]: _, ...rest } = s
        return rest
      })
      await reload()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setReleasingId(null)
    }
  }

  const title = data?.materialCode ?? 'Reservations'
  const specLine = data
    ? [data.materialSpec.boardType, data.materialSpec.gsm ? `${data.materialSpec.gsm}gsm` : null, data.materialSpec.sizeLabel]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <SlideOverPanel
      title={title}
      headerMeta={
        <div className="text-[12px] text-ds-ink-muted">
          {specLine}
          {data && (
            <span className="ml-3">
              <span className="uppercase tracking-wider text-[10px]">Reserved</span>{' '}
              <span className="font-bold tabular-nums">{data.totalReserved}</span>
            </span>
          )}
        </div>
      }
      isOpen={open}
      onClose={onClose}
    >
      {loading && <div className="text-center text-ds-ink-muted py-8">Loading…</div>}

      {data && data.ghostCount > 0 && (
        <div className="mb-3 p-3 rounded bg-ds-danger/10 text-[13px] text-ds-danger flex gap-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            <strong>
              {data.ghostCount} ghost reservation{data.ghostCount === 1 ? '' : 's'}
            </strong>
            <div className="text-[12px] opacity-80">
              Jobs are terminal but reservations weren&apos;t auto-released. Click Release to clean up.
            </div>
          </div>
        </div>
      )}

      {!loading && data && data.reservations.length === 0 && (
        <div className="text-center text-ds-ink-muted py-8">No active reservations on this material</div>
      )}

      <div className="space-y-2">
        {data?.reservations.map((r) => (
          <div
            key={r.id}
            className={`rounded p-3 ${
              r.isGhost
                ? 'bg-ds-danger/5'
                : 'bg-[var(--bg-elevated)]'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="font-semibold text-[var(--text-primary)]">Job #{r.jobCardNumber}</div>
              <a
                href={`/production/job-cards/${r.jobCardId}`}
                className="text-ds-ink-muted hover:text-ds-brand"
                aria-label="Open job card"
              >
                <ExternalLink size={14} />
              </a>
            </div>
            <div className="text-[12px] text-ds-ink-muted">{r.customerName}</div>
            <div className="flex items-center justify-between mt-2">
              <span
                className={`text-[11px] px-2 py-0.5 rounded ${
                  r.isGhost ? 'bg-ds-danger/20 text-ds-danger' : 'bg-[var(--bg-card)] text-ds-ink-muted'
                }`}
              >
                {r.jobStatus}
              </span>
              <span className="text-[12px] tabular-nums">
                {r.reservedSheets} / {r.requiredSheets}
              </span>
            </div>
            {r.isGhost ? (
              <button
                onClick={() => releaseGhost(r.id)}
                disabled={releasingId === r.id}
                className="mt-2 w-full rounded bg-ds-danger text-white text-[12px] py-1.5 font-medium disabled:opacity-50"
              >
                {releasingId === r.id ? 'Releasing…' : 'Release'}
              </button>
            ) : (
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  placeholder="Reallocating to higher-priority job"
                  value={activeReasonById[r.id] ?? ''}
                  onChange={(e) =>
                    setActiveReasonById((s) => ({ ...s, [r.id]: e.target.value }))
                  }
                  className="ds-input h-7 text-[11px] flex-1"
                />
                <button
                  onClick={() => releaseActive(r.id)}
                  disabled={releasingId === r.id}
                  className="rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] text-[12px] px-3 py-1 hover:bg-[var(--bg-elevated)]/80 disabled:opacity-50"
                >
                  Release
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </SlideOverPanel>
  )
}
