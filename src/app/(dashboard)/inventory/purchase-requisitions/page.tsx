'use client'

import { useMemo, useState, useEffect } from 'react'
import { PR_STAGE_LABEL, dbStatusToUiStage, type PrUiStage } from '@/lib/purchase-requisition-status'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

type PR = {
  id: string
  materialId: string
  qtyRequired: number
  triggerReason: string
  status: string
  raisedBy: string | null
  poReference: string | null
  expectedDelivery: string | null
  sourceJobCardId?: string | null
  sourcePlanningId?: string | null
  material: { materialCode: string; description: string; unit: string }
  linkedShortages?: Array<{
    jobCardId: string
    jobCardNumber: number | null
    planningId: string | null
    requiredByDate: string | null
    pendingShortage: number
    requiredQty: number
  }>
}

type Stage = PrUiStage

type TraceabilityPayload = {
  pr: {
    id: string
    status: string
    totalQty: number
    priority: string
    requiredByDate: string | null
    poReference: string | null
  }
  material: {
    materialCode: string
    boardType: string
    classification: string
    size: string
    gsm: number | null
  }
  linkedJobs: Array<{
    shortageId: string
    product: string
    customer: string
    poRef: string
    jobCardNo: number | null
    requiredSheets: number
    shortageSheets: number
    prStatus: string
    requiredByDate: string | null
  }>
  stock: {
    available: number
    reserved: number
    incoming: number
    shortage: number
    receivedViaGrn: number
  }
  timeline: Array<{ at: string; event: string; detail: string }>
}

type GroupedCard = {
  key: string
  materialCode: string
  description: string
  unit: string
  totalQty: number
  jobs: Set<string>
  rows: PR[]
  requiredDates: string[]
  priority: 'urgent' | 'normal'
}

const STAGES: Array<{ key: Stage; label: string; accent: string }> = [
  { key: 'draft', label: PR_STAGE_LABEL.draft, accent: 'border-orange-400/50' },
  { key: 'approved', label: PR_STAGE_LABEL.approved, accent: 'border-[var(--info)]/50' },
  { key: 'ordered', label: PR_STAGE_LABEL.ordered, accent: 'border-[var(--info)]/50' },
  { key: 'received', label: PR_STAGE_LABEL.received, accent: 'border-[var(--success)]/50' },
]

export default function PurchaseRequisitionsPage() {
  const [list, setList] = useState<PR[]>([])
  const [loading, setLoading] = useState(true)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set())
  const [traceOpen, setTraceOpen] = useState(false)
  const [traceLoading, setTraceLoading] = useState(false)
  const [traceData, setTraceData] = useState<TraceabilityPayload | null>(null)

  const fetchList = () => {
    fetch('/api/purchase-requisitions')
      .then((r) => r.json())
      .then((data) => setList(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchList()
  }, [])

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = list.filter((r) => {
      if (!q) return true
      return [
        r.material.materialCode,
        r.material.description,
        r.triggerReason,
        r.sourceJobCardId || '',
        r.sourcePlanningId || '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(q)
    })

    const byStage: Record<Stage, PR[]> = {
      draft: [],
      approved: [],
      ordered: [],
      received: [],
    }

    for (const row of filtered) {
      byStage[dbStatusToUiStage(row.status)].push(row)
    }

    return byStage
  }, [list, search])

  const cardsByStage = useMemo(() => {
    const result: Record<Stage, GroupedCard[]> = {
      draft: [],
      approved: [],
      ordered: [],
      received: [],
    }

    for (const stage of STAGES) {
      const rows = grouped[stage.key]
      const groupedByMaterial = Object.values(
        rows.reduce<Record<string, GroupedCard>>((acc, r) => {
          const key = r.materialId
          if (!acc[key]) {
            acc[key] = {
              key,
              materialCode: r.material.materialCode,
              description: r.material.description,
              unit: r.material.unit,
              totalQty: 0,
              jobs: new Set<string>(),
              rows: [],
              requiredDates: [],
              priority: 'normal',
            }
          }
          acc[key].totalQty += Number(r.qtyRequired)
          if (r.sourceJobCardId) acc[key].jobs.add(r.sourceJobCardId)
          const linked = Array.isArray(r.linkedShortages) ? r.linkedShortages : []
          for (const l of linked) {
            if (l.jobCardId) acc[key].jobs.add(l.jobCardId)
            if (l.requiredByDate) acc[key].requiredDates.push(l.requiredByDate)
          }
          const hasIncoming = stage.key !== 'draft'
          if (linked.length > 0 && !hasIncoming) acc[key].priority = 'urgent'
          acc[key].rows.push(r)
          return acc
        }, {}),
      )
      result[stage.key] = groupedByMaterial
    }

    return result
  }, [grouped])

  async function moveStage(pr: PR, stage: Stage) {
    setMovingId(pr.id)
    try {
      const body: Record<string, unknown> = { stage }
      if (stage === 'ordered' && !pr.poReference) {
        body.poReference = `AUTO-${new Date().toISOString().slice(0, 10)}-${pr.material.materialCode}`
      }
      const res = await fetch(`/api/purchase-requisitions/${pr.id}/stage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Failed to move stage')
      fetchList()
      window.dispatchEvent(new Event('inventory:refresh'))
      window.dispatchEvent(new Event('planning:refresh'))
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to move stage')
    } finally {
      setMovingId(null)
    }
  }

  async function deleteCard(prId: string) {
    if (!window.confirm('Delete this PR card?')) return
    setMovingId(prId)
    try {
      const res = await fetch(`/api/purchase-requisitions/${prId}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Failed to delete card')
      fetchList()
      setSelectedCardIds((prev) => {
        const next = new Set(prev)
        next.delete(prId)
        return next
      })
      window.dispatchEvent(new Event('inventory:refresh'))
      window.dispatchEvent(new Event('planning:refresh'))
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete card')
    } finally {
      setMovingId(null)
    }
  }

  async function bulkMoveSelected(stage: Stage) {
    if (selectedCardIds.size === 0) return
    const selected = list.filter((r) => selectedCardIds.has(r.id))
    setBulkBusy(true)
    try {
      for (const pr of selected) {
        const body: Record<string, unknown> = { stage }
        if (stage === 'ordered' && !pr.poReference) {
          body.poReference = `AUTO-${new Date().toISOString().slice(0, 10)}-${pr.material.materialCode}`
        }
        const res = await fetch(`/api/purchase-requisitions/${pr.id}/stage`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error((data as { error?: string }).error || `Failed moving ${pr.material.materialCode}`)
        }
      }
      fetchList()
      setSelectedCardIds(new Set())
      window.dispatchEvent(new Event('inventory:refresh'))
      window.dispatchEvent(new Event('planning:refresh'))
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Bulk move failed')
    } finally {
      setBulkBusy(false)
    }
  }

  async function bulkDeleteSelected() {
    if (selectedCardIds.size === 0) return
    if (!window.confirm(`Delete ${selectedCardIds.size} selected PR card(s)?`)) return
    const selected = list.filter((r) => selectedCardIds.has(r.id))
    setBulkBusy(true)
    try {
      for (const pr of selected) {
        const res = await fetch(`/api/purchase-requisitions/${pr.id}`, { method: 'DELETE' })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error((data as { error?: string }).error || `Failed deleting ${pr.material.materialCode}`)
        }
      }
      fetchList()
      setSelectedCardIds(new Set())
      window.dispatchEvent(new Event('inventory:refresh'))
      window.dispatchEvent(new Event('planning:refresh'))
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Bulk delete failed')
    } finally {
      setBulkBusy(false)
    }
  }

  async function openTraceability(prId: string) {
    setTraceOpen(true)
    setTraceLoading(true)
    setTraceData(null)
    try {
      const res = await fetch(`/api/purchase-requests/${prId}/traceability`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Failed to load traceability')
      setTraceData(data as TraceabilityPayload)
    } catch {
      setTraceData(null)
    } finally {
      setTraceLoading(false)
    }
  }

  if (loading) return <div className="p-4 text-ds-ink-muted">Loading…</div>

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-ds-warning">Purchase Request Kanban</h1>
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search material / job / reason"
            className="w-full max-w-sm rounded-ds-md border border-ds-line/60 bg-ds-card px-3 py-2 text-sm"
          />
          <span className="text-xs text-ds-ink-muted">{selectedCardIds.size} selected</span>
          <button
            type="button"
            disabled={selectedCardIds.size === 0 || bulkBusy}
            onClick={() => void bulkMoveSelected('ordered')}
            className="rounded border border-ds-line/50 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/50 disabled:opacity-40"
          >
            Move Selected → Ordered
          </button>
          <button
            type="button"
            disabled={selectedCardIds.size === 0 || bulkBusy}
            onClick={() => void bulkMoveSelected('received')}
            className="rounded border border-ds-line/50 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/50 disabled:opacity-40"
          >
            Move Selected → Received
          </button>
          <button
            type="button"
            disabled={selectedCardIds.size === 0 || bulkBusy}
            onClick={() => void bulkDeleteSelected()}
            className="rounded border border-[var(--error)]/35 bg-[var(--error-bg)] px-2 py-1 text-xs text-[var(--error)] hover:bg-[var(--error-bg)] disabled:opacity-40"
          >
            Delete Selected
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        {STAGES.map((stage) => {
          const rows = grouped[stage.key]
          const groupedByMaterial = cardsByStage[stage.key]
          return (
            <div key={stage.key} className={`rounded-ds-lg border ${stage.accent} bg-ds-card/30 p-3`}>
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={groupedByMaterial.length > 0 && groupedByMaterial.every((g) => selectedCardIds.has(g.rows[0]!.id))}
                    onChange={(e) => {
                      setSelectedCardIds((prev) => {
                        const next = new Set(prev)
                        for (const g of groupedByMaterial) {
                          const id = g.rows[0]!.id
                          if (e.target.checked) next.add(id)
                          else next.delete(id)
                        }
                        return next
                      })
                    }}
                    className="h-4 w-4"
                  />
                  <h2 className="text-sm font-semibold text-ds-ink">{stage.label}</h2>
                </div>
                <span className="rounded border border-ds-line/40 px-2 py-0.5 text-xs text-ds-ink-muted">{rows.length}</span>
              </div>

              <div className="space-y-2">
                {groupedByMaterial.map((g) => (
                  <div key={`${stage.key}-${g.key}`} className="rounded-ds-md border border-ds-line/40 bg-background p-2">
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <label className="mt-0.5 inline-flex items-center">
                        <input
                          type="checkbox"
                          checked={selectedCardIds.has(g.rows[0]!.id)}
                          onChange={(e) => {
                            const id = g.rows[0]!.id
                            setSelectedCardIds((prev) => {
                              const next = new Set(prev)
                              if (e.target.checked) next.add(id)
                              else next.delete(id)
                              return next
                            })
                          }}
                          className="h-4 w-4"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={movingId != null || bulkBusy}
                        onClick={() => void deleteCard(g.rows[0]!.id)}
                        className="rounded border border-[var(--error)]/35 bg-[var(--error-bg)] px-2 py-1 text-xs text-[var(--error)] hover:bg-[var(--error-bg)] disabled:opacity-40"
                      >
                        Delete card
                      </button>
                    </div>

                    <button
                      type="button"
                      className="text-left text-sm font-semibold text-ds-ink underline-offset-2 hover:underline"
                      onClick={() => void openTraceability(g.rows[0]!.id)}
                    >
                      {g.materialCode}
                    </button>
                    {g.rows.some((r) => r.raisedBy === null) && (
                      <span
                        className="ml-2 inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-ds-warning/15 text-ds-warning font-semibold uppercase"
                        title="Auto-created from material shortage"
                      >
                        ⚡ Auto
                      </span>
                    )}
                    <p className="text-xs text-ds-ink-faint line-clamp-2">{g.description}</p>
                    <p className="mt-1 text-xs text-ds-ink-muted">
                      Total: <span className="font-semibold text-ds-ink">{g.totalQty.toLocaleString('en-IN')} {g.unit}</span>
                    </p>
                    <p className="text-xs text-ds-ink-faint">
                      Linked jobs:{' '}
                      {g.jobs.size === 0
                        ? '-'
                        : Array.from(g.jobs).slice(0, 3).join(', ') + (g.jobs.size > 3 ? ` +${g.jobs.size - 3} more` : '')}
                    </p>
                    <p className="text-xs text-ds-ink-faint">
                      Required date:{' '}
                      {g.requiredDates.length > 0
                        ? new Date(
                            g.requiredDates.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0]!,
                          ).toLocaleDateString('en-IN')
                        : '-'}
                    </p>
                    <p className={g.priority === 'urgent' ? 'text-[var(--error)] text-xs' : 'text-[var(--warning)] text-xs'}>
                      Priority: {g.priority === 'urgent' ? 'Urgent' : 'Normal'}
                    </p>

                    <div className="mt-2 flex flex-wrap gap-1">
                      {STAGES.filter((s) => s.key !== stage.key).map((to) => (
                        <button
                          key={to.key}
                          type="button"
                          disabled={movingId != null || bulkBusy}
                          onClick={() => void moveStage(g.rows[0]!, to.key)}
                          className="rounded border border-ds-line/50 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/50 disabled:opacity-40"
                        >
                          Move → {to.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {groupedByMaterial.length === 0 ? (
                  <p className="rounded-ds-md border border-dashed border-ds-line/40 p-3 text-center text-xs text-ds-ink-faint">
                    No items in {stage.label.toLowerCase()}.
                  </p>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <TraceabilityDrawer
        open={traceOpen}
        loading={traceLoading}
        data={traceData}
        onClose={() => {
          setTraceOpen(false)
          setTraceData(null)
        }}
      />
    </div>
  )
}

function TraceabilityDrawer({
  open,
  loading,
  data,
  onClose,
}: {
  open: boolean
  loading: boolean
  data: TraceabilityPayload | null
  onClose: () => void
}) {
  return (
    <SlideOverPanel
      title="PR Traceability"
      isOpen={open}
      onClose={onClose}
      widthClass="max-w-2xl"
      backdropClassName="bg-background/60"
      panelClassName="border-l border-ds-line/40 bg-background shadow-2xl"
    >
      <div className="space-y-4 px-4 py-3 text-xs text-ds-ink-muted">
        {loading ? (
          <p>Loading…</p>
        ) : !data ? (
          <p>Legacy / reference missing</p>
        ) : (
          <>
            <section className="rounded border border-ds-line/40 p-3">
              <p className="text-ds-ink font-semibold">PR Summary</p>
              <p>PR ID: {data.pr.id}</p>
              <p>Status: {data.pr.status}</p>
              <p>Total qty: {Number(data.pr.totalQty).toLocaleString('en-IN')}</p>
              <p>Priority: {data.pr.priority}</p>
              <p>Required by: {data.pr.requiredByDate ? new Date(data.pr.requiredByDate).toLocaleDateString('en-IN') : '-'}</p>
            </section>
            <section className="rounded border border-ds-line/40 p-3">
              <p className="text-ds-ink font-semibold">Material</p>
              <p>Code: {data.material.materialCode || '-'}</p>
              <p>Board Type: {data.material.boardType || '-'}</p>
              <p>Classification: {data.material.classification || '-'}</p>
              <p>Size: {data.material.size || '-'}</p>
              <p>GSM: {data.material.gsm ?? '-'}</p>
            </section>
            <section className="rounded border border-ds-line/40 p-3">
              <p className="text-ds-ink font-semibold">Linked Products / Cartons</p>
              {(data.linkedJobs || []).length === 0 ? (
                <p>Legacy / reference missing</p>
              ) : (
                <ul className="space-y-1">
                  {data.linkedJobs.map((j) => (
                    <li key={j.shortageId} className="rounded border border-ds-line/30 px-2 py-1">
                      {j.product || 'Legacy / reference missing'} · {j.customer || 'Legacy / reference missing'} · {j.poRef || 'Legacy / reference missing'} · JC#{j.jobCardNo ?? '-'} · Req {Number(j.requiredSheets).toLocaleString('en-IN')} · Short {Number(j.shortageSheets).toLocaleString('en-IN')}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="rounded border border-ds-line/40 p-3">
              <p className="text-ds-ink font-semibold">Stock / Fulfillment</p>
              <p>Available: {Number(data.stock.available).toLocaleString('en-IN')}</p>
              <p>Reserved: {Number(data.stock.reserved).toLocaleString('en-IN')}</p>
              <p>Incoming: {Number(data.stock.incoming).toLocaleString('en-IN')}</p>
              <p>Received via GRN: {Number(data.stock.receivedViaGrn).toLocaleString('en-IN')}</p>
              <p>Remaining shortage: {Number(data.stock.shortage).toLocaleString('en-IN')}</p>
            </section>
            <section className="rounded border border-ds-line/40 p-3">
              <p className="text-ds-ink font-semibold">Timeline / Logs</p>
              {(data.timeline || []).length === 0 ? (
                <p>Legacy / reference missing</p>
              ) : (
                <ul className="space-y-1">
                  {data.timeline.map((t, i) => (
                    <li key={`${t.at}-${i}`} className="rounded border border-ds-line/30 px-2 py-1">
                      {new Date(t.at).toLocaleString('en-IN')} · {t.event} · {t.detail}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </SlideOverPanel>
  )
}
