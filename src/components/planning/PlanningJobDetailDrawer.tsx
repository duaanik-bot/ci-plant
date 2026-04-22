'use client'

import { useCallback, useEffect, useState } from 'react'
import { X, Layers, Link2, PauseCircle, Star } from 'lucide-react'
import { toast } from 'sonner'
import { broadcastIndustrialPriorityChange } from '@/lib/industrial-priority-sync'
import { INDUSTRIAL_PRIORITY_STAR_ICON_CLASS } from '@/lib/industrial-priority-ui'
import { PlanningGridLine } from '@/components/planning/PlanningDecisionGrid'

export type InterlockSegLite = { key: string; label: string; ok: boolean; na?: boolean; hint?: string }

/** Wider than `PlanningGridLine` to accept full planning queue rows (e.g. PO `status` on `po`). */
export type LineLike = PlanningGridLine & {
  planningLedger?: {
    toolingInterlock: { segments: InterlockSegLite[]; allReady: boolean }
  } | null
  directorPriority?: boolean
  directorHold?: boolean
  materialQueue?: { boardType?: string | null } | null
  jobCard?: { plateSetId: string | null } | null
  readiness?: { platesStatus?: string; dieStatus?: string } | null
}

type Props = {
  /** Full row from planning queue; often includes extra fields on `po` and `specOverrides` vs `PlanningGridLine` only. */
  line: (LineLike & Record<string, unknown>) | null
  open: boolean
  onClose: () => void
  onSave: (lineId: string, opts?: { remarks?: string | null }) => Promise<void>
  updateRow: (id: string, patch: Record<string, unknown>) => void
  setPlanningSelection: React.Dispatch<React.SetStateAction<Set<string>>>
}

const mono = 'font-designing-queue tabular-nums tracking-tight'

function segmentClass(ok: boolean, na?: boolean) {
  if (na) return 'bg-slate-700/50 text-slate-400 border-slate-600'
  if (ok) return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
  return 'bg-amber-500/10 text-amber-200 border-amber-500/35'
}

function stripFromSpec(spec: Record<string, unknown> | null | undefined, key: string) {
  if (!spec || typeof spec !== 'object') return '—'
  const v = spec[key as keyof typeof spec]
  return typeof v === 'string' && v.trim() ? v : '—'
}

const SEG_LABEL: Record<string, string> = {
  pl: 'Plates',
  di: 'Die',
  eb: 'Emboss / block',
  sc: 'Shade / card',
}

function InterlockList({ line }: { line: LineLike }) {
  const segs = line.planningLedger?.toolingInterlock?.segments
  if (segs?.length) {
    return (
      <ul className="space-y-2">
        {segs.map((seg) => (
          <li
            key={seg.key}
            className={`flex items-start justify-between gap-2 rounded-lg border px-2.5 py-2 text-[12px] ${segmentClass(seg.ok, seg.na)}`}
          >
            <span className="font-medium text-slate-200">{SEG_LABEL[seg.key] ?? (seg as InterlockSegLite).label}</span>
            <span className="min-w-0 text-right text-[11px] text-slate-300">
              {seg.hint || (seg.ok ? 'OK' : 'Review')}
            </span>
          </li>
        ))}
      </ul>
    )
  }
  const spec = (line.specOverrides || {}) as Record<string, unknown>
  const r = line.readiness
  return (
    <ul className="space-y-2 text-[12px]">
      <li
        className={`flex justify-between rounded-lg border px-2.5 py-2 ${segmentClass(
          (r?.platesStatus || spec.platesStatus || 'new_required') === 'available',
        )}`}
      >
        <span className="text-slate-200">Plates</span>
        <span className="text-[11px]">{(r?.platesStatus || spec.platesStatus || '—') as string}</span>
      </li>
      <li
        className={`flex justify-between rounded-lg border px-2.5 py-2 ${segmentClass(
          (r?.dieStatus || spec.dieStatus || '') === 'good' || (r?.dieStatus || spec.dieStatus || '') === 'ok',
        )}`}
      >
        <span className="text-slate-200">Die</span>
        <span className="text-[11px]">{String(r?.dieStatus || spec.dieStatus || '—')}</span>
      </li>
      <li
        className={`flex justify-between rounded-lg border px-2.5 py-2 ${segmentClass(
          String(spec.embossStatus || '') === 'ready' || String(spec.embossStatus || '') === 'na',
        )}`}
      >
        <span className="text-slate-200">Emboss</span>
        <span className="text-[11px]">{String(spec.embossStatus || '—')}</span>
      </li>
    </ul>
  )
}

export function PlanningJobDetailDrawer({
  line,
  open,
  onClose,
  onSave,
  updateRow,
  setPlanningSelection,
}: Props) {
  const [remarksDraft, setRemarksDraft] = useState('')
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitA, setSplitA] = useState<number | ''>('')
  const [saving, setSaving] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)

  useEffect(() => {
    if (!line) {
      setRemarksDraft('')
      return
    }
    setRemarksDraft(line.remarks ?? '')
    setSplitOpen(false)
    setSplitA('')
  }, [line?.id, line?.remarks])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

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
    toast.info('Line added to selection. Pick another row if you need a mix-set, then use Link as mix set in the toolbar.', {
      duration: 4000,
    })
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

  if (!line || !open) return null

  const spec = (line.specOverrides || {}) as Record<string, unknown>
  const board = line.materialQueue?.boardType?.trim() || '—'
  const size = line.cartonSize || '—'
  const gsm = line.gsm ?? line.carton?.gsm ?? '—'
  const paper = line.paperType || line.carton?.paperType || '—'
  const pastingRaw = stripFromSpec(spec, 'pastingType')
  const pasting = pastingRaw !== '—' ? pastingRaw : stripFromSpec(spec, 'pastingStyle')
  const foil = stripFromSpec(spec, 'foilType')

  const totalQty = line.quantity
  const splitB = typeof splitA === 'number' && splitA > 0 && splitA < totalQty ? totalQty - splitA : null

  return (
    <aside
      className="flex h-full min-h-0 w-[min(38vw,32rem)] shrink-0 flex-col border-l border-slate-600/80 bg-[#0b1222] shadow-[-8px_0_24px_rgba(0,0,0,0.25)] transition-[box-shadow,transform] duration-200 ease-out"
      aria-label="Job detail"
    >
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-slate-700/90 bg-[#0c1424] px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold text-amber-300/95" title={line.cartonName}>
            {line.cartonName}
          </h2>
          <p className={`mt-0.5 text-[12px] text-slate-400 ${mono}`}>
            {line.po.poNumber} · {line.planningStatus}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
            {line.planningLedger?.toolingInterlock?.allReady ? (
              <span className="text-[10px] font-medium text-emerald-400/90">Tooling interlock OK</span>
            ) : (
              <span className="text-[10px] font-medium text-amber-400/90">Tooling: review</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
        <section className="space-y-2">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Quantity</h3>
          <input
            type="number"
            readOnly
            value={totalQty}
            className="w-full cursor-not-allowed rounded-md border border-slate-600/80 bg-slate-900/50 px-2 py-1.5 text-[13px] text-slate-200"
            title="Quantity comes from the PO line."
          />
          <p className="text-[10px] text-slate-500">Update on the purchase order; refresh planning to see changes.</p>
          <div className="pt-0.5">
            <button
              type="button"
              onClick={() => setSplitOpen((o) => !o)}
              className="text-[12px] font-medium text-sky-400/90 underline-offset-2 hover:underline"
            >
              {splitOpen ? 'Hide split' : 'Split (planner intent)'}
            </button>
            {splitOpen ? (
              <div className="mt-2 space-y-2 rounded-lg border border-slate-600/60 bg-slate-900/30 p-2">
                <p className="text-[10px] leading-snug text-slate-500">
                  Enter units for a notional &quot;first job&quot; — remainder becomes the second. This does not create
                  extra rows in the database; use it to align with Accounts on the PO.
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
                  className="w-full rounded border border-slate-600 bg-slate-800/80 px-2 py-1 text-[13px] text-slate-100"
                />
                {splitB != null ? (
                  <p className={`text-[12px] text-slate-300 ${mono}`}>
                    Second notional job: <span className="text-amber-200">{splitB}</span>
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
                      `Split intent: ${splitA} + ${splitB} = ${totalQty}. Follow up in Accounts to duplicate the PO line if a second job is required.`,
                    )
                    setSplitOpen(false)
                    setSplitA('')
                  }}
                  className="w-full rounded-md border border-slate-500/50 bg-slate-800/80 py-1.5 text-[11px] font-semibold text-slate-200 hover:bg-slate-700/80"
                >
                  Confirm split intent
                </button>
              </div>
            ) : null}
          </div>
        </section>

        <section className="mt-5 space-y-2">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Specifications</h3>
          <dl className="space-y-1.5 text-[12px] text-slate-200">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Board</dt>
              <dd className="min-w-0 text-right text-slate-200">{board}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Size</dt>
              <dd className={`min-w-0 text-right text-slate-200 ${mono}`}>{size}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">GSM</dt>
              <dd className={`min-w-0 text-right text-slate-200 ${mono}`}>{gsm}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Paper</dt>
              <dd className="min-w-0 text-right text-slate-200">{paper}</dd>
            </div>
          </dl>
        </section>

        <section className="mt-5 space-y-2">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Printing &amp; finishing</h3>
          <dl className="space-y-1.5 text-[12px] text-slate-200">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Coating</dt>
              <dd className="min-w-0 text-right text-slate-200">{line.coatingType || '—'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Emboss</dt>
              <dd className="min-w-0 text-right text-slate-200">{line.embossingLeafing || '—'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Foil</dt>
              <dd className="min-w-0 text-right text-slate-200">{foil}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">Pasting</dt>
              <dd className="min-w-0 text-right text-slate-200">{pasting}</dd>
            </div>
          </dl>
        </section>

        <section className="mt-5 space-y-2">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Tooling status</h3>
          <InterlockList line={line} />
        </section>

        <section className="mt-5 space-y-2">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Actions</h3>
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              disabled={actionBusy}
              onClick={handleAddToBatch}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-500/50 bg-slate-800/60 py-2 text-[12px] font-medium text-slate-100 hover:bg-slate-700/60 disabled:opacity-50"
            >
              <Layers className="h-3.5 w-3.5" aria-hidden />
              Add to batch
            </button>
            <p className="text-[10px] leading-snug text-slate-500">
              <Link2 className="mb-0.5 mr-0.5 inline h-3 w-3 align-middle opacity-60" aria-hidden />
              For mix-sets, add two or more lines to the selection, then use <strong>Link as mix set</strong> in the
              toolbar above the grid.
            </p>
            <button
              type="button"
              disabled={actionBusy}
              onClick={handleHold}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-500/35 bg-amber-950/25 py-2 text-[12px] font-medium text-amber-100 hover:bg-amber-900/30 disabled:opacity-50"
            >
              <PauseCircle className="h-3.5 w-3.5" aria-hidden />
              {line.directorHold ? 'Release hold' : 'Hold job'}
            </button>
            <button
              type="button"
              disabled={actionBusy}
              onClick={handlePriority}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-violet-500/35 bg-violet-950/20 py-2 text-[12px] font-medium text-violet-100 hover:bg-violet-900/25 disabled:opacity-50"
            >
              <Star className="h-3.5 w-3.5" aria-hidden />
              {line.directorPriority ? 'Clear line priority' : 'Mark as priority (line)'}
            </button>
          </div>
        </section>

        <section className="mt-5 space-y-1.5">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Line remarks</h3>
          <textarea
            value={remarksDraft}
            onChange={(e) => setRemarksDraft(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-slate-600/80 bg-slate-900/50 px-2 py-1.5 text-[12px] text-slate-200 placeholder:text-slate-600"
            placeholder="Internal planning notes (saved with Save changes)"
          />
        </section>
      </div>

      <div className="flex shrink-0 gap-2 border-t border-slate-700/90 bg-[#0c1424] px-3 py-2.5">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-lg border border-slate-500/50 py-2 text-[12px] font-medium text-slate-300 hover:bg-slate-800/80"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={handleSave}
          className="flex-1 rounded-lg bg-amber-600 py-2 text-[12px] font-bold text-white shadow hover:bg-amber-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </aside>
  )
}

