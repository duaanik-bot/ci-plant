'use client'

import { useCallback, useEffect, useState } from 'react'
import { PlateHubColourSwatchStrip } from '@/components/hub/PlateHubColourSwatch'
import { HUB_PLATE_SIZE_OPTIONS, type HubPlateSize } from '@/lib/plate-size'
import { safeJsonParse } from '@/lib/safe-json'

export type PlateHubAuditContext = {
  entity: 'requirement' | 'plate'
  id: string
  zoneLabel: string
  cartonName: string
  artworkCode: string | null
  displayCode: string
  poLineId?: string | null
  plateSize?: HubPlateSize | null
  plateColours: string[]
  coloursRequired: number
  platesInRackCount?: number | null
  statusLabel?: string
}

type TimelineEntry = {
  id?: string
  timeLabel: string
  action: string
  detail: string
  performedBy: string | null
}

export function JobAuditModal({
  context,
  onClose,
}: {
  context: PlateHubAuditContext | null
  onClose: () => void
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!context) return
    setLoading(true)
    setError(null)
    try {
      const q =
        context.entity === 'requirement'
          ? `requirementId=${encodeURIComponent(context.id)}`
          : `plateStoreId=${encodeURIComponent(context.id)}`
      const r = await fetch(`/api/plate-hub/job-events?${q}`)
      const t = await r.text()
      const j = safeJsonParse<{ entries?: TimelineEntry[]; error?: string }>(t, {})
      if (!r.ok) {
        setError(j.error ?? 'Failed to load history')
        setEntries([])
        return
      }
      setEntries(Array.isArray(j.entries) ? j.entries : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history')
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [context])

  useEffect(() => {
    if (!context) {
      setEntries([])
      return
    }
    void load()
  }, [context, load])

  useEffect(() => {
    if (!context) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [context, onClose])

  if (!context) return null

  const sizeMm =
    context.plateSize != null
      ? HUB_PLATE_SIZE_OPTIONS.find((o) => o.value === context.plateSize)?.mm ?? context.plateSize
      : '—'

  const inRack =
    context.platesInRackCount != null && context.platesInRackCount >= 0
      ? String(context.platesInRackCount)
      : '—'

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/85 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="presentation"
    >
      <div
        className="w-full max-w-lg max-h-[90vh] rounded-xl border border-ds-line/50 bg-ds-main shadow-2xl flex flex-col"
        role="dialog"
        aria-labelledby="job-audit-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-ds-line/40 shrink-0">
          <div className="flex justify-between gap-2 items-start">
            <div className="min-w-0">
              <h2 id="job-audit-title" className="text-lg font-semibold text-foreground">
                Job details &amp; history
              </h2>
              <p className="text-sm font-bold leading-snug tracking-tight text-blue-400 mt-1 break-words whitespace-normal">
                {context.cartonName}
              </p>
              <p className="text-xs font-medium text-gray-300 opacity-90 mt-0.5 break-words whitespace-normal leading-snug">
                AW: {context.artworkCode?.trim() || '—'} · {context.displayCode}
              </p>
              {context.poLineId ? (
                <p
                  className="text-xs font-medium text-gray-300 opacity-90 font-mono mt-0.5 break-all whitespace-normal"
                  title={context.poLineId}
                >
                  PO line: {context.poLineId}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 px-2 py-1 rounded border border-ds-line/50 text-neutral-400 text-xs hover:bg-ds-elevated"
            >
              Close
            </button>
          </div>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-4">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">
              Current specs
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-lg border border-ds-line/40 bg-background/50 p-3">
              <div>
                <p className="text-xs text-neutral-500 uppercase">Plate size</p>
                <p className="text-sm text-ds-ink font-medium">{sizeMm}</p>
              </div>
              <div>
                <p className="text-xs text-neutral-500 uppercase">Zone</p>
                <p className="text-sm text-ds-ink font-medium">{context.zoneLabel}</p>
              </div>
              <div>
                <p className="text-xs text-neutral-500 uppercase">Colours required</p>
                <p className="text-sm text-ds-ink font-medium tabular-nums">{context.coloursRequired}</p>
              </div>
              <div>
                <p className="text-xs text-neutral-500 uppercase">In rack / matched</p>
                <p className="text-sm text-ds-ink font-medium tabular-nums">{inRack}</p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs text-neutral-500 uppercase mb-1">Colour channels</p>
                <PlateHubColourSwatchStrip labels={context.plateColours} />
              </div>
              {context.statusLabel ? (
                <div className="sm:col-span-2">
                  <p className="text-xs text-neutral-500 uppercase">Status</p>
                  <p className="text-sm text-ds-ink capitalize">{context.statusLabel}</p>
                </div>
              ) : null}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">
              Hub event timeline
            </h3>
            {loading ? (
              <p className="text-sm text-neutral-500">Loading history…</p>
            ) : error ? (
              <p className="text-sm text-rose-400">{error}</p>
            ) : entries.length === 0 ? (
              <p className="text-sm text-neutral-500">No hub events recorded yet for this job.</p>
            ) : (
              <ul className="relative border-l border-ds-line/50 pl-4 space-y-4 ml-1.5">
                {entries.map((e, i) => (
                  <li key={e.id ?? `${e.timeLabel}-${i}`} className="relative">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-ds-warning ring-4 ring-ds-main" />
                    <p className="text-xs text-neutral-500 font-mono">{e.timeLabel}</p>
                    <p className="text-sm font-bold text-ds-ink mt-0.5">{e.action}</p>
                    <p className="text-xs text-neutral-500 mt-1 leading-snug">{e.detail}</p>
                    {e.performedBy ? (
                      <p className="text-xs text-neutral-600 mt-1">By {e.performedBy}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
