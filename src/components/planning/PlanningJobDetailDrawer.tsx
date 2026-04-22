'use client'

import { useCallback, useEffect, useState } from 'react'
import { Layers, PauseCircle, Star } from 'lucide-react'
import { toast } from 'sonner'
import { broadcastIndustrialPriorityChange } from '@/lib/industrial-priority-sync'
import { INDUSTRIAL_PRIORITY_STAR_ICON_CLASS } from '@/lib/industrial-priority-ui'
import {
  MASTER_BOARD_GRADES,
  MASTER_COATINGS_AND_VARNISHES,
  MASTER_EMBOSSING_AND_LEAFING,
} from '@/lib/master-enums'
import { PackagingEnumCombobox } from '@/components/ui/PackagingEnumCombobox'
import { PlanningGridLine, type PlanningLineFieldPatch } from '@/components/planning/PlanningDecisionGrid'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

type Props = {
  line: (PlanningGridLine & { directorPriority?: boolean; directorHold?: boolean; materialQueue?: { boardType?: string | null } | null }) | null
  open: boolean
  onClose: () => void
  onSave: (lineId: string, opts?: { remarks?: string | null }) => Promise<void>
  onSaveLine: (
    lineId: string,
    patch: PlanningLineFieldPatch,
    specSnapshot?: Record<string, unknown> | null,
  ) => Promise<boolean>
  updateRow: (id: string, patch: Record<string, unknown>) => void
  setPlanningSelection: React.Dispatch<React.SetStateAction<Set<string>>>
  /** When linked carton exists, opens product detail (e.g. from planning page). */
  onViewProductDetail?: () => void
}

const mono = 'font-designing-queue tabular-nums tracking-tight'

function specFoil(line: PlanningGridLine): string {
  const s = (line.specOverrides || {}) as Record<string, unknown>
  const f = s.foilType
  return typeof f === 'string' && f.trim() ? f.trim() : ''
}

function specPasting(line: PlanningGridLine): string {
  const s = (line.specOverrides || {}) as Record<string, unknown>
  const t = s.pastingType
  if (typeof t === 'string' && t.trim()) return t.trim()
  const st = s.pastingStyle
  if (typeof st === 'string' && st.trim()) return st.trim()
  return ''
}

export function PlanningJobDetailDrawer({
  line,
  open,
  onClose,
  onSave,
  onSaveLine,
  updateRow,
  setPlanningSelection,
  onViewProductDetail,
}: Props) {
  const [remarksDraft, setRemarksDraft] = useState('')
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitA, setSplitA] = useState<number | ''>('')
  const [saving, setSaving] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [saveMasterBusy, setSaveMasterBusy] = useState(false)

  useEffect(() => {
    if (!line) {
      setRemarksDraft('')
      return
    }
    setRemarksDraft(line.remarks ?? '')
    setSplitOpen(false)
    setSplitA('')
  }, [line?.id, line?.remarks])

  const handleSave = useCallback(async () => {
    if (!line) return
    setSaving(true)
    try {
      const nextRemarks = remarksDraft.trim() || null
      updateRow(line.id, { remarks: nextRemarks })
      await onSave(line.id, { remarks: nextRemarks })
      onClose()
    } catch {
      /* parent toasts */
    } finally {
      setSaving(false)
    }
  }, [line, remarksDraft, onSave, onClose, updateRow])

  const handleAddToBatch = useCallback(() => {
    if (!line) return
    setPlanningSelection((prev) => {
      const next = new Set(prev)
      next.add(line.id)
      return next
    })
    toast.info('Line added to selection. Select one more line to open the Batch builder drawer.', { duration: 4000 })
  }, [line, setPlanningSelection])

  const handlePriority = useCallback(async () => {
    if (!line) return
    setActionBusy(true)
    try {
      const next = line.directorPriority !== true
      const res = await fetch(`/api/director-command-center/lines/${line.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directorPriority: next }),
      })
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(j.error || 'Update failed')
      updateRow(line.id, { directorPriority: next })
      broadcastIndustrialPriorityChange({ source: 'line_director_priority', at: new Date().toISOString() })
      toast.success(next ? 'Line marked priority' : 'Priority cleared for line')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setActionBusy(false)
    }
  }, [line, updateRow])

  const handleHold = useCallback(async () => {
    if (!line) return
    setActionBusy(true)
    try {
      const next = line.directorHold !== true
      const res = await fetch(`/api/planning/po-lines/${line.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directorHold: next, planningDecisionRevision: true }),
      })
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(j.error || 'Update failed')
      updateRow(line.id, { directorHold: next })
      toast.success(next ? 'Job on hold' : 'Hold released')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setActionBusy(false)
    }
  }, [line, updateRow])

  const saveToProductMaster = useCallback(async () => {
    if (!line?.cartonId) {
      toast.error('No product (carton) linked to this line')
      return
    }
    setSaveMasterBusy(true)
    try {
      const spec = (line.specOverrides || {}) as Record<string, unknown>
      const res = await fetch(`/api/masters/cartons/${line.cartonId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardGrade: typeof spec.boardGrade === 'string' ? spec.boardGrade : undefined,
          gsm: line.gsm ?? line.carton?.gsm ?? undefined,
          paperType: line.paperType ?? line.carton?.paperType,
          coatingType: line.coatingType ?? line.carton?.coatingType,
          laminateType: line.otherCoating ?? line.carton?.laminateType,
          embossingLeafing: line.embossingLeafing,
          pastingType: specPasting(line) || undefined,
        }),
      })
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      if (res.status === 403) {
        toast.error('Requires Operations Head or MD to update the product master')
        return
      }
      if (!res.ok) throw new Error(j.error || 'Could not update master')
      toast.success('Product master updated')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setSaveMasterBusy(false)
    }
  }, [line])

  if (!line || !open) return null

  const spec = (line.specOverrides || {}) as Record<string, unknown>
  const boardInput = String(spec.boardGrade || line.materialQueue?.boardType || '').trim()
  const amount = (line.quantity || 0) * (line.rate != null ? Number(line.rate) : 0)

  const totalQty = line.quantity
  const splitB = typeof splitA === 'number' && splitA > 0 && splitA < totalQty ? totalQty - splitA : null

  const fieldInput =
    'mt-0.5 w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs text-foreground'

  return (
    <SlideOverPanel
      isOpen={open}
      onClose={onClose}
      title={<span className="truncate" title={line.cartonName}>{line.cartonName}</span>}
      widthClass="max-w-lg"
      backdropClassName="bg-background/60"
      panelClassName="border-l border-border bg-card text-card-foreground shadow-2xl"
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-input bg-background py-2 text-xs font-medium text-foreground hover:bg-accent/10"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="flex-1 rounded-lg bg-amber-600 py-2 text-xs font-bold text-white shadow hover:bg-amber-500 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <div className="space-y-4 text-sm text-foreground" aria-label="Job detail">
        <p className="text-xs text-slate-500">
          {line.po.poNumber} · {line.planningStatus} · {line.po.customer.name}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {line.po.isPriority ? (
            <span
              className={`inline-flex items-center gap-0.5 rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-200 ring-1 ring-amber-500/35 ${INDUSTRIAL_PRIORITY_STAR_ICON_CLASS}`}
            >
              <Star className="h-3 w-3 fill-amber-400/90" aria-hidden />
              PO
            </span>
          ) : null}
          {line.directorPriority ? (
            <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-bold text-violet-200 ring-1 ring-violet-500/35">
              Line priority
            </span>
          ) : null}
          {line.directorHold ? (
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-100 ring-1 ring-amber-500/30">
              On hold
            </span>
          ) : null}
          {line.cartonId && onViewProductDetail ? (
            <button
              type="button"
              onClick={onViewProductDetail}
              className="text-[10px] font-medium text-amber-400/90 underline-offset-2 hover:underline"
            >
              Product sheet
            </button>
          ) : null}
        </div>

        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Line</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-slate-500">Size</div>
              <input
                className={fieldInput + ' ' + mono}
                value={line.cartonSize ?? ''}
                onChange={(e) => updateRow(line.id, { cartonSize: e.target.value || null })}
                onBlur={(e) => void onSaveLine(line.id, { cartonSize: e.target.value.trim() || null })}
              />
            </div>
            <div>
              <div className="text-xs text-slate-500">Qty</div>
              <input
                type="number"
                min={1}
                className={fieldInput + ' tabular-nums text-amber-200/90 ' + mono}
                value={line.quantity}
                onChange={(e) => {
                  const n = Math.max(1, parseInt(e.target.value, 10) || 1)
                  updateRow(line.id, { quantity: n })
                }}
                onBlur={() => void onSaveLine(line.id, { quantity: line.quantity })}
              />
            </div>
          </div>
        </div>

        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Material</div>
          <div className="space-y-2">
            <label className="block text-xs text-slate-500">
              Board
              <input
                className={fieldInput}
                value={boardInput}
                placeholder="e.g. kraft, virgin"
                onChange={(e) => {
                  const v = e.target.value
                  const next = { ...spec, boardGrade: v || null } as Record<string, unknown>
                  updateRow(line.id, { specOverrides: next })
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  const next = { ...spec, boardGrade: v || null } as Record<string, unknown>
                  void onSaveLine(line.id, {}, next)
                }}
              />
            </label>
            <div>
              <p className="text-xs text-slate-500">GSM</p>
              <input
                type="number"
                className={fieldInput + ' ' + mono}
                value={line.gsm ?? line.carton?.gsm ?? ''}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10)
                  updateRow(line.id, { gsm: Number.isFinite(n) ? n : null })
                }}
                onBlur={(e) => {
                  const n = parseInt(e.target.value, 10)
                  const g = Number.isFinite(n) ? n : null
                  void onSaveLine(line.id, { gsm: g })
                }}
              />
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <p className="text-xs text-slate-500">Paper</p>
              <PackagingEnumCombobox
                aria-label="Paper"
                options={MASTER_BOARD_GRADES}
                value={line.paperType ?? line.carton?.paperType ?? null}
                onChange={(v) => {
                  updateRow(line.id, { paperType: v })
                  void onSaveLine(line.id, { paperType: v })
                }}
                className="w-full"
              />
            </div>
          </div>
        </div>

        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Printing</div>
          <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
            <div>
              <p className="text-xs text-slate-500">Coating</p>
              <PackagingEnumCombobox
                aria-label="Coating"
                options={MASTER_COATINGS_AND_VARNISHES}
                value={line.coatingType ?? line.carton?.coatingType ?? null}
                onChange={(v) => {
                  updateRow(line.id, { coatingType: v })
                  void onSaveLine(line.id, { coatingType: v })
                }}
                className="w-full"
              />
            </div>
            <div>
              <p className="text-xs text-slate-500">Emboss / leafing</p>
              <PackagingEnumCombobox
                aria-label="Embossing"
                options={MASTER_EMBOSSING_AND_LEAFING}
                value={line.embossingLeafing}
                onChange={(v) => {
                  updateRow(line.id, { embossingLeafing: v })
                  void onSaveLine(line.id, { embossingLeafing: v })
                }}
                className="w-full"
              />
            </div>
            <label className="block text-xs text-slate-500">
              Foil (if applicable)
              <input
                className={fieldInput}
                value={specFoil(line)}
                onChange={(e) => {
                  const v = e.target.value
                  const next = { ...spec, foilType: v || null } as Record<string, unknown>
                  updateRow(line.id, { specOverrides: next })
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  const next = { ...spec, foilType: v || null } as Record<string, unknown>
                  void onSaveLine(line.id, {}, next)
                }}
              />
            </label>
          </div>
        </div>

        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Actions</div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={actionBusy}
              onClick={handleAddToBatch}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-800/90 bg-background py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent/10 disabled:opacity-50"
            >
              <Layers className="h-3.5 w-3.5" aria-hidden />
              Add to batch
            </button>
            <button
              type="button"
              disabled={actionBusy}
              onClick={handleHold}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-950/20 py-2 text-xs font-medium text-amber-100 hover:bg-amber-950/35 disabled:opacity-50"
            >
              <PauseCircle className="h-3.5 w-3.5" aria-hidden />
              {line.directorHold ? 'Release hold' : 'Hold'}
            </button>
            <button
              type="button"
              disabled={actionBusy}
              onClick={handlePriority}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-violet-500/30 bg-violet-950/20 py-2 text-xs font-medium text-violet-100 hover:bg-violet-950/35 disabled:opacity-50"
            >
              <Star className="h-3.5 w-3.5" aria-hidden />
              {line.directorPriority ? 'Clear priority' : 'Priority'}
            </button>
          </div>
        </div>

        <details className="group rounded-md border border-slate-800/90 bg-background/60">
          <summary className="cursor-pointer list-none px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            <span className="group-open:hidden">More — rate, laminate, pasting, split, remarks</span>
            <span className="hidden group-open:inline">Hide details</span>
          </summary>
          <div className="space-y-3 border-t border-slate-800/90 px-2 pb-3 pt-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-xs text-slate-500">Rate</div>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  className={fieldInput + ' ' + mono}
                  value={line.rate != null ? String(line.rate) : ''}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === '') {
                      updateRow(line.id, { rate: null })
                      return
                    }
                    const n = parseFloat(v)
                    if (Number.isFinite(n)) updateRow(line.id, { rate: n })
                  }}
                  onBlur={() => void onSaveLine(line.id, { rate: line.rate ?? null })}
                />
              </div>
              <p className={`self-end text-xs text-slate-400 ${mono}`}>
                Amount: ₹{amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <p className="text-xs text-slate-500">Secondary / laminate</p>
              <PackagingEnumCombobox
                aria-label="Laminate"
                options={MASTER_COATINGS_AND_VARNISHES}
                value={line.otherCoating ?? line.carton?.laminateType ?? null}
                onChange={(v) => {
                  updateRow(line.id, { otherCoating: v })
                  void onSaveLine(line.id, { otherCoating: v })
                }}
                className="w-full"
              />
            </div>
            <label className="block text-xs text-slate-500">
              Pasting
              <input
                className={fieldInput}
                value={specPasting(line)}
                onChange={(e) => {
                  const v = e.target.value
                  const next = { ...spec, pastingType: v || null } as Record<string, unknown>
                  updateRow(line.id, { specOverrides: next })
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  const next = { ...spec, pastingType: v || null } as Record<string, unknown>
                  void onSaveLine(line.id, {}, next)
                }}
              />
            </label>

            {line.cartonId ? (
              <div>
                <button
                  type="button"
                  disabled={saveMasterBusy}
                  onClick={() => void saveToProductMaster()}
                  className="w-full rounded-lg border border-sky-500/35 bg-sky-950/25 py-2 text-xs font-medium text-sky-100 hover:bg-sky-950/40 disabled:opacity-50"
                >
                  {saveMasterBusy ? 'Saving to master…' : 'Save to product master'}
                </button>
                <p className="mt-1 text-[10px] text-slate-500">
                  Pushes the values to the linked carton (permission may be required).
                </p>
              </div>
            ) : null}

            <div>
              <button
                type="button"
                onClick={() => setSplitOpen((o) => !o)}
                className="text-xs font-medium text-amber-400/90 underline-offset-2 hover:underline"
              >
                {splitOpen ? 'Hide' : 'Split (intent)'}
              </button>
              {splitOpen ? (
                <div className="mt-2 space-y-2 rounded-md border border-slate-800/90 bg-background p-2">
                  <p className="text-[10px] leading-snug text-slate-500">
                    Notional split. For real extra jobs, work with Accounts on the PO.
                  </p>
                  <label className="block text-[10px] text-slate-500">First job qty</label>
                  <input
                    type="number"
                    min={1}
                    max={Math.max(0, totalQty - 1)}
                    value={splitA === '' ? '' : splitA}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '') {
                        setSplitA('')
                        return
                      }
                      const n = parseInt(v, 10)
                      if (Number.isFinite(n)) setSplitA(n)
                    }}
                    className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
                  />
                  {splitB != null ? (
                    <p className={`text-xs text-slate-300 ${mono}`}>
                      Second: <span className="text-amber-200/90">{splitB}</span>
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      if (splitB == null || typeof splitA !== 'number') {
                        toast.error('Enter a valid split (1 … total − 1).')
                        return
                      }
                      toast.success(
                        `Intent: ${splitA} + ${splitB} = ${totalQty}. Follow up in Accounts to adjust the PO if needed.`,
                      )
                      setSplitOpen(false)
                      setSplitA('')
                    }}
                    className="w-full rounded-md border border-slate-800 py-1.5 text-[10px] font-semibold text-foreground hover:bg-accent/10"
                  >
                    Confirm split intent
                  </button>
                </div>
              ) : null}
            </div>

            <div>
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Remarks</p>
              <textarea
                value={remarksDraft}
                onChange={(e) => setRemarksDraft(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs text-foreground"
                placeholder="Internal notes"
              />
            </div>
          </div>
        </details>
      </div>
    </SlideOverPanel>
  )
}
