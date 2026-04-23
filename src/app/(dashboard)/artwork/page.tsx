'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { PLANNING_DESIGNERS, readPlanningCore, readPlanningMeta, type PlanningDesignerKey } from '@/lib/planning-decision-spec'

type ArtworkQueueItem = {
  id: string
  cartonName: string
  artworkCode: string | null
  setNumber: string | null
  planningStatus: string
  cartonSize?: string | null
  paperType?: string | null
  coatingType?: string | null
  specOverrides?: Record<string, unknown> | null
  artworkStatusLabel: string
  approvalsComplete: boolean
  prePressFinalized: boolean
  po: {
    poNumber: string
    customer: { name: string }
    poDate: string | null
  }
}

type BatchType = 'MIXED' | 'STANDARD'

function printTypeForArtworkRow(item: ArtworkQueueItem): string {
  const spec = (item.specOverrides || {}) as Record<string, unknown>
  const raw = spec.printingProcess ?? spec.printType ?? spec.printingType
  if (typeof raw === 'string' && raw.trim()) return raw.trim().toLowerCase()
  const n = spec.numberOfColours
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return `${n}-colour`
  return '—'
}

function boardForArtworkRow(item: ArtworkQueueItem): string {
  const spec = (item.specOverrides || {}) as Record<string, unknown>
  const bg = spec.boardGrade
  if (typeof bg === 'string' && bg.trim()) return bg.trim()
  return String(item.paperType ?? '—')
}

function getBatchType(items: ArtworkQueueItem[]): BatchType {
  if (items.length <= 1) return 'STANDARD'
  const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase()
  const sizes = new Set(items.map((i) => norm(i.cartonSize)))
  const boards = new Set(items.map((i) => boardForArtworkRow(i).toLowerCase()))
  const printTypes = new Set(items.map((i) => printTypeForArtworkRow(i)))
  const coatings = new Set(items.map((i) => norm(i.coatingType)))
  const gsms = new Set(
    items.map((i) => {
      const spec = (i.specOverrides || {}) as Record<string, unknown>
      return String(spec.gsm ?? '')
    }),
  )
  const special = new Set(
    items.map((i) => {
      const s = (i.specOverrides || {}) as Record<string, unknown>
      const foil = typeof s.foilType === 'string' ? s.foilType.trim() : ''
      const emboss = typeof s.embossingLeafing === 'string' ? s.embossingLeafing.trim() : ''
      const spotUv = typeof s.spotUV === 'string' ? s.spotUV.trim().toLowerCase() : ''
      return [foil, emboss, spotUv].filter(Boolean).join('-') || 'none'
    }),
  )
  if (sizes.size > 1 || boards.size > 1 || printTypes.size > 1 || coatings.size > 1 || gsms.size > 1 || special.size > 1) {
    return 'MIXED'
  }
  return 'STANDARD'
}

export default function ArtworkApprovalsPage() {
  const [items, setItems] = useState<ArtworkQueueItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/designing/po-lines')
      .then((r) => r.json())
      .then((data: unknown) => {
        if (Array.isArray(data)) setItems(data as ArtworkQueueItem[])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const batchSummaryByLineId = useMemo(() => {
    const byBatch = new Map<string, ArtworkQueueItem[]>()
    for (const item of items) {
      const spec = (item.specOverrides || {}) as Record<string, unknown>
      const core = readPlanningCore(spec)
      const batchId =
        core.masterSetId && core.masterSetId.trim()
          ? `batch:${core.masterSetId.trim()}`
          : `line:${item.id}`
      const list = byBatch.get(batchId) ?? []
      list.push(item)
      byBatch.set(batchId, list)
    }
    const byLine = new Map<string, { designer: string; ups: number | null; batchType: BatchType; itemCount: number }>()
    for (const group of Array.from(byBatch.values())) {
      const type = getBatchType(group)
      for (const item of group) {
        const spec = (item.specOverrides || {}) as Record<string, unknown>
        const core = readPlanningCore(spec)
        const meta = readPlanningMeta(spec)
        const fromMetaDesigner = typeof meta.designer === 'string' ? meta.designer.trim() : ''
        const designerDisplay =
          typeof spec.planningDesignerDisplayName === 'string'
            ? spec.planningDesignerDisplayName.trim()
            : core.designerKey
              ? PLANNING_DESIGNERS[core.designerKey as PlanningDesignerKey]
              : fromMetaDesigner
        const rawUps = meta.ups
        const ups = typeof rawUps === 'number' && Number.isFinite(rawUps) && rawUps >= 1 ? Math.floor(rawUps) : null
        byLine.set(item.id, {
          designer: designerDisplay,
          ups,
          batchType: type,
          itemCount: group.length,
        })
      }
    }
    return byLine
  }, [items])

  const statusBadge = (item: ArtworkQueueItem) => {
    if (item.prePressFinalized) {
      return (
        <span className="px-2 py-0.5 rounded text-xs bg-emerald-900/50 text-emerald-300">
          Sent to Plate Hub ✓
        </span>
      )
    }
    if (item.approvalsComplete) {
      return (
        <span className="px-2 py-0.5 rounded text-xs bg-blue-900/50 text-blue-300">
          Approved — ready to finalize
        </span>
      )
    }
    return (
      <span className="px-2 py-0.5 rounded text-xs bg-ds-warning/12 text-ds-warning">
        {item.artworkStatusLabel || 'Awaiting approval'}
      </span>
    )
  }

  return (
    <section className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ds-warning">Artwork Gate</h1>
          <p className="text-sm text-ds-ink-muted">
            Review artwork locks and push finalized jobs to the Plate Hub.
          </p>
        </div>
        <Link
          href="/orders/designing"
          className="rounded-md bg-blue-600 px-3 py-2 text-sm text-primary-foreground hover:bg-blue-500"
        >
          Full Designing Queue
        </Link>
      </div>

      {loading ? (
        <div className="text-ds-ink-muted py-8 text-center">Loading artwork queue…</div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-ds-line/40 bg-ds-main/40 p-8 text-center text-ds-ink-muted text-sm">
          No items in the artwork queue.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-ds-line/50">
          <table className="w-full text-sm">
            <thead className="bg-ds-elevated text-left">
              <tr>
                <th className="px-4 py-2 font-medium">PO #</th>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Carton / Product</th>
                <th className="px-4 py-2 font-medium">AW Code</th>
                <th className="px-4 py-2 font-medium">Set #</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">PO Date</th>
                <th className="px-4 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ds-line/40">
              {items.map((item) => {
                const summary = batchSummaryByLineId.get(item.id)
                return (
                <tr key={item.id} className="hover:bg-ds-elevated/40">
                  <td className="px-4 py-2 font-mono text-ds-warning whitespace-nowrap">
                    {item.po.poNumber}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">{item.po.customer.name}</td>
                  <td className="px-4 py-2">
                    <p>{item.cartonName}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ds-ink-muted">
                      {summary?.designer ? <span>👤 {summary.designer}</span> : null}
                      {summary?.ups != null ? <span>Ups: {summary.ups}</span> : null}
                      {summary ? (
                        <span className={summary.batchType === 'MIXED' ? 'text-ds-warning' : 'text-ds-success'}>
                          {summary.batchType === 'MIXED' ? 'Mixed Batch' : 'Standard'}
                        </span>
                      ) : null}
                      {summary ? <span>{summary.itemCount} items</span> : null}
                      {summary?.designer && summary.ups != null ? <span className="text-ds-success">Ready</span> : null}
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{item.artworkCode || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs">{item.setNumber || '—'}</td>
                  <td className="px-4 py-2">{statusBadge(item)}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-ds-ink-muted text-xs">
                    {item.po.poDate ? format(new Date(item.po.poDate), 'dd MMM yyyy') : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/orders/designing/${item.id}`}
                      className="text-ds-warning hover:underline text-sm font-medium"
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
