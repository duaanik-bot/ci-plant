'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PR_STAGE_LABEL, dbStatusToUiStage, type PrUiStage } from '@/lib/purchase-requisition-status'
import { PageHeader } from '@/components/shared/PageHeader'
import { consolidatePrs } from '@/lib/pr-consolidation'
import { PrCompactCard, OrderedConsolidatedCard, type PrRow } from '@/components/inventory/PrCard'
import { PrEditDrawer } from '@/components/inventory/PrEditDrawer'
import { GeneratePoDialog, type GeneratePoSelection } from '@/components/inventory/GeneratePoDialog'

type Stage = PrUiStage

const STAGES: Array<{ key: Stage; label: string; accent: string }> = [
  { key: 'draft', label: PR_STAGE_LABEL.draft, accent: 'border-[var(--brand-primary)]/50' },
  { key: 'approved', label: PR_STAGE_LABEL.approved, accent: 'border-[var(--info)]/50' },
  { key: 'ordered', label: PR_STAGE_LABEL.ordered, accent: 'border-[var(--info)]/50' },
  { key: 'received', label: PR_STAGE_LABEL.received, accent: 'border-[var(--success)]/50' },
]

export default function PurchaseRequisitionsPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [editPrId, setEditPrId] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [approvedSel, setApprovedSel] = useState<Set<string>>(new Set())
  const [orderedSel, setOrderedSel] = useState<Set<string>>(new Set())
  const [poDialogOpen, setPoDialogOpen] = useState(false)
  const [poSelection, setPoSelection] = useState<GeneratePoSelection | null>(null)
  const [busy, setBusy] = useState(false)

  const { data: list = [] } = useQuery<PrRow[]>({
    queryKey: ['purchase-requisitions'],
    queryFn: async () => {
      const res = await fetch('/api/purchase-requisitions')
      const data = await res.json()
      return Array.isArray(data) ? data : []
    },
  })

  const refresh = () => void qc.invalidateQueries({ queryKey: ['purchase-requisitions'] })

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = list.filter((r) => {
      if (!q) return true
      return [r.material.materialCode, r.material.description, r.triggerReason, r.sourceJobCardId || '', r.sourcePlanningId || '']
        .join(' ')
        .toLowerCase()
        .includes(q)
    })
    const byStage: Record<Stage, PrRow[]> = { draft: [], approved: [], ordered: [], received: [] }
    for (const row of filtered) byStage[dbStatusToUiStage(row.status)].push(row)
    return byStage
  }, [list, search])

  const ordered = useMemo(() => {
    const rows = grouped.ordered
    const awaiting = rows.filter((r) => r.status === 'ordered')
    const withPo = rows.filter((r) => r.status === 'converted_to_po')
    const groups = consolidatePrs(
      awaiting.map((r) => ({
        id: r.id,
        materialId: r.materialId,
        materialCode: r.material.materialCode,
        boardType: r.boardType,
        gsm: r.gsm,
        sizeLabel: r.sizeLabel,
        qty: Number(r.qtyRequired),
        supplierId: r.supplierId,
        requiredByDate: r.requiredByDate,
      })),
    )
    const poMap = new Map<string, PrRow[]>()
    for (const r of withPo) {
      const key = r.poReference || r.id
      const arr = poMap.get(key) ?? []
      arr.push(r)
      poMap.set(key, arr)
    }
    const poCards = Array.from(poMap.entries()).map(([key, members]) => {
      const codes = Array.from(new Set(members.map((m) => m.material.materialCode)))
      return {
        key,
        materialCode: codes.length === 1 ? codes[0]! : `${codes[0]} +${codes.length - 1}`,
        boardType: members[0]!.boardType,
        gsm: members[0]!.gsm,
        sizeLabel: members[0]!.sizeLabel,
        totalQty: members.reduce((s, m) => s + Number(m.qtyRequired), 0),
        memberCount: members.length,
        monitoring: members[0]!.monitoring ?? null,
        firstId: members[0]!.id,
      }
    })
    return { groups, poCards }
  }, [grouped.ordered])

  async function moveToOrdered(prIds: string[]) {
    if (prIds.length === 0) return
    setBusy(true)
    try {
      for (const id of prIds) {
        const res = await fetch(`/api/purchase-requisitions/${id}/stage`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: 'ordered' }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error((d as { error?: string }).error || 'Move failed')
        }
      }
      setApprovedSel(new Set())
      refresh()
      window.dispatchEvent(new Event('inventory:refresh'))
      window.dispatchEvent(new Event('planning:refresh'))
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Move failed')
    } finally {
      setBusy(false)
    }
  }

  function openGeneratePo() {
    const ids = Array.from(orderedSel)
    if (ids.length === 0) return
    const selectedGroups = ordered.groups.filter((g) => g.members.some((m) => orderedSel.has(m.prId)))
    const summary = selectedGroups.map((g) => ({
      materialCode: g.materialCode,
      boardType: g.boardType,
      gsm: g.gsm,
      sizeLabel: g.sizeLabel,
      totalQty: g.members.filter((m) => orderedSel.has(m.prId)).reduce((s, m) => s + m.qty, 0),
      prCount: g.members.filter((m) => orderedSel.has(m.prId)).length,
    }))
    setPoSelection({ prIds: ids, summary, suggestedVendorId: selectedGroups[0]?.suggestedSupplierId ?? null })
    setPoDialogOpen(true)
  }

  function openEdit(id: string) {
    setEditPrId(id)
    setEditOpen(true)
  }

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        title="Purchase Request Kanban"
        subtitle="Material requisitions by stage: Draft → Approved → Ordered → Received"
      />

      <div className="flex w-full flex-wrap items-center justify-end gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search material / job / reason"
          className="w-full max-w-sm rounded-ds-md border border-ds-line/60 bg-ds-card px-3 py-2 text-sm"
        />
        <button
          type="button"
          disabled={approvedSel.size === 0 || busy}
          onClick={() => void moveToOrdered(Array.from(approvedSel))}
          className="rounded border border-ds-line/50 px-2 py-1 text-xs text-ds-ink hover:bg-ds-main/50 disabled:opacity-40"
        >
          Move Selected → Ordered ({approvedSel.size})
        </button>
        <button
          type="button"
          disabled={orderedSel.size === 0}
          onClick={openGeneratePo}
          className="rounded border border-[var(--success)]/40 bg-[var(--success-bg)] px-2 py-1 text-xs text-[var(--success)] disabled:opacity-40"
        >
          Generate PO ({orderedSel.size})
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        {STAGES.map((stage) => {
          const rows = grouped[stage.key]
          const count = stage.key === 'ordered' ? ordered.groups.length + ordered.poCards.length : rows.length
          return (
            <div key={stage.key} className={`rounded-ds-lg border ${stage.accent} bg-ds-card/30 p-3`}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-ds-ink">{stage.label}</h2>
                <span className="rounded border border-ds-line/40 px-2 py-0.5 text-xs text-ds-ink-muted">{count}</span>
              </div>

              <div className="space-y-2">
                {stage.key === 'ordered' ? (
                  <>
                    {ordered.groups.map((g) => {
                      const allSelected = g.members.every((m) => orderedSel.has(m.prId))
                      return (
                        <OrderedConsolidatedCard
                          key={`og-${g.key}`}
                          materialCode={g.materialCode}
                          boardType={g.boardType}
                          gsm={g.gsm}
                          sizeLabel={g.sizeLabel}
                          totalQty={g.totalQty}
                          memberCount={g.members.length}
                          monitoring={null}
                          selectable
                          selected={allSelected}
                          onToggleSelect={() =>
                            setOrderedSel((prev) => {
                              const next = new Set(prev)
                              const ids = g.members.map((m) => m.prId)
                              const on = !ids.every((id) => next.has(id))
                              for (const id of ids) {
                                if (on) next.add(id)
                                else next.delete(id)
                              }
                              return next
                            })
                          }
                          onOpen={() => openEdit(g.members[0]!.prId)}
                        />
                      )
                    })}
                    {ordered.poCards.map((p) => (
                      <OrderedConsolidatedCard
                        key={`po-${p.key}`}
                        materialCode={p.materialCode}
                        boardType={p.boardType}
                        gsm={p.gsm}
                        sizeLabel={p.sizeLabel}
                        totalQty={p.totalQty}
                        memberCount={p.memberCount}
                        monitoring={p.monitoring}
                        selectable={false}
                        selected={false}
                        onToggleSelect={() => {}}
                        onOpen={() => openEdit(p.firstId)}
                      />
                    ))}
                    {ordered.groups.length === 0 && ordered.poCards.length === 0 ? (
                      <p className="rounded-ds-md border border-dashed border-ds-line/40 p-3 text-center text-xs text-ds-ink-faint">
                        No items in ordered.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <>
                    {rows.map((r) => (
                      <PrCompactCard
                        key={`${stage.key}-${r.id}`}
                        pr={r}
                        selectable={stage.key === 'approved'}
                        selected={approvedSel.has(r.id)}
                        onToggleSelect={
                          stage.key === 'approved'
                            ? () =>
                                setApprovedSel((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(r.id)) next.delete(r.id)
                                  else next.add(r.id)
                                  return next
                                })
                            : undefined
                        }
                        onOpen={() => openEdit(r.id)}
                      />
                    ))}
                    {rows.length === 0 ? (
                      <p className="rounded-ds-md border border-dashed border-ds-line/40 p-3 text-center text-xs text-ds-ink-faint">
                        No items in {stage.label.toLowerCase()}.
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <PrEditDrawer
        prId={editPrId}
        open={editOpen}
        onClose={() => {
          setEditOpen(false)
          setEditPrId(null)
        }}
        onSaved={() => {
          refresh()
          window.dispatchEvent(new Event('inventory:refresh'))
          window.dispatchEvent(new Event('planning:refresh'))
        }}
      />
      <GeneratePoDialog
        open={poDialogOpen}
        selection={poSelection}
        onClose={() => setPoDialogOpen(false)}
        onCreated={() => {
          setOrderedSel(new Set())
          refresh()
          window.dispatchEvent(new Event('inventory:refresh'))
        }}
      />
    </div>
  )
}
