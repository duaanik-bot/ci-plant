'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Layers, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type SpecOverrides = {
  assignedDesignerId?: string
  customerApprovalPharma?: boolean
  shadeCardQaTextApproval?: boolean
  prePressSentToPlateHubAt?: string
  revisionRequired?: boolean
  [k: string]: unknown
} | null

type Row = {
  id: string
  cartonName: string
  artworkCode?: string | null
  quantity: number
  setNumber: string | null
  planningStatus: string
  specOverrides: SpecOverrides
  readiness: {
    pipelinePhase?: 'finalized' | 'revision' | 'awaiting_client' | 'drafting'
    prePressFinalized?: boolean
    approvalsComplete?: boolean
    artworkStatusLabel?: string
  }
  po: {
    id: string
    poNumber: string
    customer: { name: string }
  }
}

type User = { id: string; name: string }

type Props = {
  groupId: string
  rows: Row[]
  users: User[]
  isOpen: boolean
  onClose: () => void
  onRefresh: () => void
}

function pipelineDot(phase: Row['readiness']['pipelinePhase']) {
  switch (phase) {
    case 'finalized':      return 'bg-emerald-500'
    case 'revision':       return 'bg-rose-500'
    case 'awaiting_client': return 'bg-blue-500'
    default:               return 'bg-ds-ink-faint/50'
  }
}

function pipelineLabel(phase: Row['readiness']['pipelinePhase']) {
  switch (phase) {
    case 'finalized':      return 'Finalized'
    case 'revision':       return 'Revision'
    case 'awaiting_client': return 'Awaiting client'
    default:               return 'Drafting'
  }
}

type ItemState = {
  artworkCode: string
  setNumber: string
  customerApproval: boolean
  qaTextApproval: boolean
}

export function AwGroupEditDrawer({ groupId, rows, users, isOpen, onClose, onRefresh }: Props) {
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>(() => {
    const s: Record<string, ItemState> = {}
    for (const r of rows) {
      const spec = r.specOverrides || {}
      s[r.id] = {
        artworkCode: r.artworkCode ?? '',
        setNumber: r.setNumber ?? '',
        customerApproval: !!(spec.customerApprovalPharma),
        qaTextApproval: !!(spec.shadeCardQaTextApproval),
      }
    }
    return s
  })

  const totalQty = rows.reduce((s, r) => s + r.quantity, 0)

  function updateItem(id: string, patch: Partial<ItemState>) {
    setItemStates((prev) => ({ ...prev, [id]: { ...prev[id]!, ...patch } }))
  }

  async function saveItem(r: Row) {
    const st = itemStates[r.id]
    if (!st) return
    setSaving((prev) => { const n = new Set(prev); n.add(r.id); return n })
    try {
      const specOverrides = {
        ...(r.specOverrides || {}),
        customerApprovalPharma: st.customerApproval,
        shadeCardQaTextApproval: st.qaTextApproval,
      }
      const res = await fetch(`/api/planning/po-lines/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artworkCode: st.artworkCode || null,
          setNumber: st.setNumber || null,
          specOverrides,
        }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || 'Save failed')
      }
      toast.success(`Saved ${r.cartonName}`)
      onRefresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving((prev) => {
        const next = new Set(prev)
        next.delete(r.id)
        return next
      })
    }
  }

  const userById = Object.fromEntries(users.map((u) => [u.id, u]))

  return (
    <SlideOverPanel
      isOpen={isOpen}
      onClose={onClose}
      widthClass="w-[min(100%,clamp(560px,55vw,860px))]"
      title={
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-bold text-sky-700 dark:text-sky-300">
            <Layers className="h-3 w-3 shrink-0" aria-hidden />
            GANG
          </span>
          <span className="text-base font-semibold text-ds-ink">Gang Print Group</span>
        </div>
      }
      headerMeta={
        <div className="flex flex-wrap items-center gap-3 text-[12px]">
          <span className="text-ds-ink-faint">
            Group: <span className={`${mono} text-ds-ink-muted`}>{groupId.slice(0, 8)}</span>
          </span>
          <span className="text-ds-ink-faint">
            {rows.length} items ·{' '}
            <span className={`font-semibold text-ds-brand ${mono}`}>{totalQty.toLocaleString('en-IN')}</span>{' '}
            pcs combined
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Qty summary bar */}
        <div className="rounded-ds-md border border-ds-line/50 bg-ds-elevated/20 p-3">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ds-ink-faint">Quantity breakdown</p>
          <div className="flex flex-wrap gap-2">
            {rows.map((r) => (
              <div key={r.id} className="flex flex-col rounded-ds-sm border border-ds-line/40 bg-ds-elevated/30 px-3 py-2 text-center min-w-[110px]">
                <span className="truncate text-[11px] font-medium text-ds-ink-muted" title={r.cartonName}>
                  {r.cartonName.length > 16 ? r.cartonName.slice(0, 15) + '…' : r.cartonName}
                </span>
                <span className="text-[10px] text-ds-ink-faint">{r.po.poNumber}</span>
                <span className={`mt-1 text-[18px] font-bold leading-none text-ds-brand ${mono}`}>
                  {r.quantity.toLocaleString('en-IN')}
                </span>
                <span className="text-[9px] text-ds-ink-faint">pcs</span>
              </div>
            ))}
          </div>
        </div>

        {/* Per-item edit panels */}
        <div className="flex flex-col gap-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-ds-ink-faint">Individual job details</p>

          {rows.map((r, idx) => {
            const st = itemStates[r.id] ?? {
              artworkCode: r.artworkCode ?? '',
              setNumber: r.setNumber ?? '',
              customerApproval: !!(r.specOverrides?.customerApprovalPharma),
              qaTextApproval: !!(r.specOverrides?.shadeCardQaTextApproval),
            }
            const isSaving = saving.has(r.id)
            const phase = r.readiness?.pipelinePhase ?? 'drafting'
            const finalized = !!r.readiness?.prePressFinalized
            const spec = r.specOverrides || {}
            const designerId = spec.assignedDesignerId as string | undefined
            const designerName = designerId ? (userById[designerId]?.name ?? '—') : 'Unassigned'

            return (
              <div
                key={r.id}
                className="rounded-ds-md border border-ds-line/50 bg-ds-elevated/10 overflow-hidden"
              >
                {/* Item header */}
                <div className="flex items-center justify-between gap-3 border-b border-ds-line/30 bg-ds-elevated/30 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-[10px] font-bold text-sky-700 dark:text-sky-300 ${mono}`}>
                      {idx + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-ds-ink" title={r.cartonName}>
                        {r.cartonName}
                      </p>
                      <p className={`text-[11px] text-ds-warning ${mono}`}>{r.po.poNumber} · {r.po.customer.name}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="flex items-center gap-1">
                      <span className={`h-2 w-2 rounded-full ${pipelineDot(phase)}`} />
                      <span className="text-[11px] text-ds-ink-faint">{pipelineLabel(phase)}</span>
                    </div>
                    {finalized && (
                      <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                        Finalized
                      </span>
                    )}
                    <Link
                      href={`/orders/designing/${r.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded border border-ds-line/50 bg-ds-elevated/20 px-2 py-0.5 text-[11px] text-ds-ink-muted hover:border-ds-warning/40 hover:text-ds-warning transition-colors"
                      title="Open full edit page"
                    >
                      <ExternalLink className="h-3 w-3" aria-hidden />
                      Full edit
                    </Link>
                  </div>
                </div>

                {/* Editable fields */}
                <div className="px-3 py-3">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {/* Qty — read-only */}
                    <div>
                      <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">
                        Qty
                      </label>
                      <div className={`rounded-ds-sm border border-ds-line/30 bg-ds-elevated/40 px-2.5 py-1.5 text-[13px] font-bold text-ds-brand ${mono}`}>
                        {r.quantity.toLocaleString('en-IN')}
                      </div>
                    </div>

                    {/* Set # */}
                    <div>
                      <label htmlFor={`set-${r.id}`} className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">
                        Set #
                      </label>
                      <input
                        id={`set-${r.id}`}
                        type="text"
                        value={st.setNumber}
                        onChange={(e) => updateItem(r.id, { setNumber: e.target.value })}
                        placeholder="e.g. 1"
                        className={`w-full rounded-ds-sm border border-ds-line/50 bg-ds-elevated/30 px-2.5 py-1.5 text-[13px] text-ds-ink outline-none transition focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30 ${mono}`}
                      />
                    </div>

                    {/* Artwork code */}
                    <div className="col-span-2">
                      <label htmlFor={`aw-${r.id}`} className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-ds-ink-faint">
                        Artwork code
                      </label>
                      <input
                        id={`aw-${r.id}`}
                        type="text"
                        value={st.artworkCode}
                        onChange={(e) => updateItem(r.id, { artworkCode: e.target.value })}
                        placeholder="e.g. AW-2024-001"
                        className={`w-full rounded-ds-sm border border-ds-line/50 bg-ds-elevated/30 px-2.5 py-1.5 text-[13px] text-ds-ink outline-none transition focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30 ${mono}`}
                      />
                    </div>
                  </div>

                  {/* Approvals row */}
                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    <label className="flex cursor-pointer items-center gap-2 select-none">
                      <input
                        type="checkbox"
                        checked={st.customerApproval}
                        onChange={(e) => updateItem(r.id, { customerApproval: e.target.checked })}
                        className="h-4 w-4 rounded border-ds-line accent-ds-brand"
                      />
                      <span className="text-[12px] text-ds-ink-muted">Customer approval (pharma)</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 select-none">
                      <input
                        type="checkbox"
                        checked={st.qaTextApproval}
                        onChange={(e) => updateItem(r.id, { qaTextApproval: e.target.checked })}
                        className="h-4 w-4 rounded border-ds-line accent-ds-brand"
                      />
                      <span className="text-[12px] text-ds-ink-muted">QA text / shade card approval</span>
                    </label>
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-[11px] text-ds-ink-faint">Designer: {designerName}</span>
                      <button
                        type="button"
                        disabled={isSaving}
                        onClick={() => void saveItem(r)}
                        className="inline-flex items-center gap-1 rounded-ds-sm border border-ds-brand/40 bg-ds-brand/10 px-3 py-1 text-[12px] font-semibold text-ds-brand transition hover:bg-ds-brand/20 disabled:opacity-40"
                      >
                        <Pencil className="h-3 w-3" aria-hidden />
                        {isSaving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer note */}
        <p className="text-center text-[11px] text-ds-ink-faint">
          All items above belong to the same gang print group. Use "Full edit" to access advanced options per item.
        </p>
      </div>
    </SlideOverPanel>
  )
}
