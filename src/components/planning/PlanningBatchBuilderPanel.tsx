'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Layers, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  boardLabel,
  type PlanningGridLine,
  type PlanningLineFieldPatch,
} from '@/components/planning/PlanningDecisionGrid'
import {
  generateMasterSetId,
  PLANNING_DESIGNERS,
  mergePlanningMetaDesigner,
  mergePlanningMetaUps,
  readPlanningCore,
  readPlanningMeta,
} from '@/lib/planning-decision-spec'
import {
  BATCH_STATUS_BADGE_CLASS,
  BATCH_STATUS_LABEL,
  effectiveBatchStatus,
  type PlanningBatchDecisionAction,
} from '@/lib/planning-batch-decision'
import { SlideOverPanel } from '@/components/ui/SlideOverPanel'

const mono = 'font-designing-queue tabular-nums tracking-tight'

type CompRow = {
  key: string
  /** Full line e.g. "Board: Match (SBS)" */
  text: string
  mixed: boolean
}

function aggregateDisplay(values: string[]): { match: boolean; detail: string } {
  const seen = new Map<string, string>()
  for (const raw of values) {
    const display = raw.trim() || '—'
    const k = display.toLowerCase()
    if (!seen.has(k)) seen.set(k, display)
  }
  const arr = Array.from(seen.values())
  return { match: arr.length <= 1, detail: arr.join(' · ') }
}

function printingLabel(r: PlanningGridLine): string {
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const raw = spec.printingProcess ?? spec.printType ?? spec.printingType
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  const nc = r.planningLedger?.numberOfColours ?? r.carton?.numberOfColours
  if (typeof nc === 'number' && nc > 0) return `${nc}-colour`
  return '—'
}

function coatingLine(r: PlanningGridLine): string {
  const parts = [r.coatingType, r.otherCoating].map((s) => s?.trim()).filter(Boolean) as string[]
  if (parts.length) return parts.join(' + ')
  const c = r.carton?.coatingType?.trim()
  return c || '—'
}

function specialLine(r: PlanningGridLine): string {
  const parts: string[] = []
  const e = r.embossingLeafing?.trim()
  if (e) parts.push(e)
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const foil = typeof spec.foilType === 'string' ? spec.foilType.trim() : ''
  if (foil) parts.push(`Foil ${foil}`)
  return parts.length ? parts.join(', ') : 'None'
}

function plateBucket(r: PlanningGridLine): 'existing' | 'partial' | 'new' | 'unknown' {
  const spec = (r.specOverrides || {}) as Record<string, unknown>
  const ps = spec.platesStatus
  if (ps === 'available') return 'existing'
  if (ps === 'partial') return 'partial'
  if (ps === 'new_required') return 'new'
  return 'unknown'
}

function plateAggregate(lines: PlanningGridLine[]): { match: boolean; detail: string } {
  const counts = { existing: 0, partial: 0, new: 0, unknown: 0 }
  for (const r of lines) {
    counts[plateBucket(r)] += 1
  }
  const parts: string[] = []
  if (counts.existing) parts.push(`${counts.existing} existing`)
  if (counts.partial) parts.push(`${counts.partial} partial`)
  if (counts.new) parts.push(`${counts.new} new`)
  if (counts.unknown) parts.push(`${counts.unknown} unspecified`)
  const active = (['existing', 'partial', 'new', 'unknown'] as const).filter((k) => counts[k] > 0)
  const match = active.length <= 1
  if (match) {
    if (active.length === 0) return { match: true, detail: 'Unspecified' }
    const k = active[0]
    const label = k === 'existing' ? 'Existing' : k === 'partial' ? 'Partial' : k === 'new' ? 'New' : 'Unspecified'
    const n = counts[k]
    return { match: true, detail: `${label} (${n} job${n === 1 ? '' : 's'})` }
  }
  return { match: false, detail: parts.join(' / ') }
}

function dieAggregate(lines: PlanningGridLine[]): { match: boolean; detail: string } {
  const sigs = lines.map((r) => (r.dieMaster ? `Dye ${r.dieMaster.dyeNumber}` : 'None'))
  return aggregateDisplay(sigs)
}

function gsmLine(r: PlanningGridLine): string {
  const g = r.gsm ?? r.carton?.gsm
  if (g == null || Number.isNaN(Number(g))) return '—'
  return String(g)
}

function buildCompatibilityRows(lines: PlanningGridLine[]): CompRow[] {
  if (lines.length < 2) return []

  const boardVals = lines.map((r) => boardLabel(r))
  const board = aggregateDisplay(boardVals)
  const sizeVals = lines.map((r) => String(r.cartonSize ?? '').trim() || '—')
  const size = aggregateDisplay(sizeVals)
  const printVals = lines.map((r) => printingLabel(r))
  const print = aggregateDisplay(printVals)
  const coatVals = lines.map((r) => coatingLine(r))
  const coat = aggregateDisplay(coatVals)
  const specVals = lines.map((r) => specialLine(r))
  const spec = aggregateDisplay(specVals)
  const gsmVals = lines.map((r) => gsmLine(r))
  const gsm = aggregateDisplay(gsmVals)
  const plate = plateAggregate(lines)
  const die = dieAggregate(lines)

  const row = (key: string, label: string, match: boolean, detail: string): CompRow => ({
    key,
    mixed: !match,
    text: `${label}: ${match ? 'Match' : 'Mixed'} (${detail})`,
  })

  return [
    row('board', 'Board', board.match, board.detail),
    row('size', 'Size', size.match, size.detail),
    row('printing', 'Printing', print.match, print.detail),
    row('coating', 'Coating / finish', coat.match, coat.detail),
    row('special', 'Special processes', spec.match, spec.detail),
    row('tool-plate', 'Plate (planning)', plate.match, plate.detail),
    row('tool-die', 'Die', die.match, die.detail),
    row('gsm', 'GSM', gsm.match, gsm.detail),
  ]
}

type Props = {
  isOpen: boolean
  lines: PlanningGridLine[]
  onCreateBatch: () => void
  updateRow: (lineId: string, patch: Partial<PlanningGridLine>) => void
  onSaveLine: (lineId: string, patch: PlanningLineFieldPatch) => void | Promise<boolean | void>
  onBatchDecision: (
    lineIds: string[],
    action: PlanningBatchDecisionAction,
    holdReason?: string,
    opts?: { suppressToast?: boolean },
  ) => Promise<boolean | void>
  onMakeProcessingBatch: (lineIds: string[], opts?: { suppressToast?: boolean }) => Promise<boolean>
  onRemoveFromSelection: (lineId: string) => void
  onClearSelection: () => void
  onRestoreSelection: (lineIds: string[]) => void
  onClose: () => void
}

export function PlanningBatchBuilderPanel({
  isOpen,
  lines,
  onCreateBatch,
  updateRow,
  onSaveLine,
  onBatchDecision,
  onMakeProcessingBatch,
  onRemoveFromSelection,
  onClearSelection,
  onRestoreSelection,
  onClose,
}: Props) {
  const compatRows = useMemo(() => buildCompatibilityRows(lines), [lines])
  const hasAnyMixed = compatRows.some((r) => r.mixed)
  const [designer, setDesigner] = useState('')
  const [sheetLengthMm, setSheetLengthMm] = useState('')
  const [sheetWidthMm, setSheetWidthMm] = useState('')
  const [specialRemarks, setSpecialRemarks] = useState('')
  const [sendingToArtwork, setSendingToArtwork] = useState(false)
  const [makingProcessing, setMakingProcessing] = useState(false)
  const [breakSelection, setBreakSelection] = useState<Set<string>>(new Set())

  useEffect(() => {
    const choices = new Set<string>()
    for (const li of lines) {
      const spec = (li.specOverrides || {}) as Record<string, unknown>
      const meta = readPlanningMeta(spec)
      const md = typeof meta.designer === 'string' ? meta.designer.trim() : ''
      if (md) choices.add(md)
    }
    setDesigner(choices.size === 1 ? Array.from(choices)[0]! : '')
  }, [lines])

  useEffect(() => {
    setBreakSelection(new Set(lines.map((l) => l.id)))
  }, [lines])

  useEffect(() => {
    const lenVals = new Set<string>()
    const widVals = new Set<string>()
    const remarkVals = new Set<string>()
    for (const li of lines) {
      const spec = (li.specOverrides || {}) as Record<string, unknown>
      const l = Number(spec.sheetLengthMm)
      const w = Number(spec.sheetWidthMm)
      const sr = typeof spec.specialRemarks === 'string' ? spec.specialRemarks.trim() : ''
      if (Number.isFinite(l) && l > 0) lenVals.add(String(Math.floor(l)))
      if (Number.isFinite(w) && w > 0) widVals.add(String(Math.floor(w)))
      if (sr) remarkVals.add(sr)
    }
    setSheetLengthMm(lenVals.size === 1 ? Array.from(lenVals)[0]! : '')
    setSheetWidthMm(widVals.size === 1 ? Array.from(widVals)[0]! : '')
    setSpecialRemarks(remarkVals.size === 1 ? Array.from(remarkVals)[0]! : '')
  }, [lines])

  const totalQty = useMemo(
    () => lines.reduce((s, r) => s + (r.quantity || 0), 0),
    [lines],
  )

  if (!isOpen) return null
  if (lines.length < 1) return null

  const renderUpsField = true

  const ensureBatchPackageTag = async () => {
    if (lines.length < 2) return null
    const ids = lines.map((l) => l.id)
    const existing = new Set<string>()
    for (const li of lines) {
      const c = readPlanningCore((li.specOverrides || {}) as Record<string, unknown>)
      if (c.masterSetId?.trim()) existing.add(c.masterSetId.trim())
    }
    const packageId = existing.size === 1 ? Array.from(existing)[0]! : generateMasterSetId()
    for (const li of lines) {
      const spec = (li.specOverrides || {}) as Record<string, unknown>
      const prevCore = readPlanningCore(spec)
      const planningCore = {
        ...prevCore,
        masterSetId: packageId,
        mixSetMemberIds: ids,
        layoutType: 'gang' as const,
        batchStatus: prevCore.batchStatus ?? 'draft',
      }
      const next = { ...spec, planningCore } as Record<string, unknown>
      updateRow(li.id, { specOverrides: next })
      await onSaveLine(li.id, { specOverrides: next })
    }
    return packageId
  }

  const applyDesignerToBatch = async (name: string) => {
    const n = name.trim()
    setDesigner(n)
    for (const li of lines) {
      const spec = (li.specOverrides || {}) as Record<string, unknown>
      const withMeta = mergePlanningMetaDesigner(spec, n || null)
      updateRow(li.id, { specOverrides: withMeta })
      await onSaveLine(li.id, { specOverrides: withMeta })
    }
  }

  const applyDrawerLevelFieldsToBatch = async () => {
    const lengthVal = sheetLengthMm.trim()
    const widthVal = sheetWidthMm.trim()
    const remarksVal = specialRemarks.trim()
    for (const li of lines) {
      const spec = (li.specOverrides || {}) as Record<string, unknown>
      const next = { ...spec } as Record<string, unknown>
      const l = lengthVal === '' ? null : parseInt(lengthVal, 10)
      const w = widthVal === '' ? null : parseInt(widthVal, 10)
      if (Number.isFinite(l) && (l as number) > 0) next.sheetLengthMm = l as number
      else delete next.sheetLengthMm
      if (Number.isFinite(w) && (w as number) > 0) next.sheetWidthMm = w as number
      else delete next.sheetWidthMm
      if (remarksVal) next.specialRemarks = remarksVal
      else delete next.specialRemarks

      const patch: PlanningLineFieldPatch = {
        specOverrides: next,
        remarks: remarksVal || null,
      }
      updateRow(li.id, { specOverrides: next, remarks: remarksVal || null })
      await onSaveLine(li.id, patch)
    }
  }

  const handleSendToArtwork = async () => {
    if (lines.length === 0) return
    setSendingToArtwork(true)
    try {
      await ensureBatchPackageTag()
      const designerName = designer.trim()
      if (designerName) await applyDesignerToBatch(designerName)
      await applyDrawerLevelFieldsToBatch()
      const withLatest = lines.map((li) => {
        const spec = (li.specOverrides || {}) as Record<string, unknown>
        const meta = readPlanningMeta(spec)
        const ups = typeof meta.ups === 'number' && Number.isFinite(meta.ups) && meta.ups >= 1 ? meta.ups : null
        const md = typeof meta.designer === 'string' ? meta.designer.trim() : designerName
        return { id: li.id, ups, designer: md }
      })
      const hasUps = withLatest.every((x) => x.ups != null)
      const hasDesigner = withLatest.every((x) => !!x.designer)
      if (!hasDesigner || !hasUps) {
        toast.warning('Designer or Ups not set. Proceeding may cause rework.')
      }
      let success = 0
      let failed = 0
      for (const li of withLatest) {
        const ok = (await onBatchDecision([li.id], 'send_to_artwork', undefined, { suppressToast: true })) !== false
        if (ok) success += 1
        else failed += 1
      }
      toast.success(`Sent to Artwork • ${success} items${failed ? ` • ${failed} failed` : ''}`)
    } finally {
      setSendingToArtwork(false)
    }
  }

  const handleMakeProcessingBatch = async () => {
    if (lines.length === 0) return
    setMakingProcessing(true)
    try {
      const designerName = designer.trim()
      if (designerName) await applyDesignerToBatch(designerName)
      await applyDrawerLevelFieldsToBatch()
      const withLatest = lines.map((li) => {
        const spec = (li.specOverrides || {}) as Record<string, unknown>
        const meta = readPlanningMeta(spec)
        const ups = typeof meta.ups === 'number' && Number.isFinite(meta.ups) && meta.ups >= 1 ? meta.ups : null
        const md = typeof meta.designer === 'string' ? meta.designer.trim() : designerName
        return { ups, designer: md }
      })
      if (withLatest.some((x) => !x.designer || x.ups == null)) {
        toast.warning('Designer or Ups missing. Proceeding may cause rework.')
      }
      const ok = await onMakeProcessingBatch(
        lines.map((l) => l.id),
        { suppressToast: true },
      )
      if (ok) toast.success(`Sent to Processing • ${lines.length} items`)
    } finally {
      setMakingProcessing(false)
    }
  }

  const handleBreakGroupAsIs = async () => {
    const selectedIds = lines.filter((l) => breakSelection.has(l.id)).map((l) => l.id)
    if (selectedIds.length === 0) {
      toast.error('Select at least one item to break from group')
      return
    }

    const byMaster = new Map<string, PlanningGridLine[]>()
    for (const li of lines) {
      const core = readPlanningCore((li.specOverrides || {}) as Record<string, unknown>)
      const mid = (core.masterSetId || '').trim()
      if (!mid) continue
      const bucket = byMaster.get(mid) || []
      bucket.push(li)
      byMaster.set(mid, bucket)
    }

    let changed = 0
    for (const li of lines) {
      const spec = (li.specOverrides || {}) as Record<string, unknown>
      const prevCore = readPlanningCore(spec)
      const mid = (prevCore.masterSetId || '').trim()
      const selected = selectedIds.includes(li.id)
      let nextCore = prevCore

      if (!mid) {
        if (!selected) continue
        nextCore = {
          ...prevCore,
          layoutType: 'single',
          masterSetId: null,
          mixSetMemberIds: null,
          batchStatus: 'draft',
          batchHoldReason: null,
          batchStatusBeforeHold: null,
        }
      } else {
        const groupLines = byMaster.get(mid) || []
        const groupIds = groupLines.map((g) => g.id)
        const selectedInGroup = groupIds.filter((id) => selectedIds.includes(id))
        const remaining = groupIds.filter((id) => !selectedIds.includes(id))

        if (selectedInGroup.length === 0) continue

        if (selectedInGroup.includes(li.id)) {
          nextCore = {
            ...prevCore,
            layoutType: 'single',
            masterSetId: null,
            mixSetMemberIds: null,
            batchStatus: 'draft',
            batchHoldReason: null,
            batchStatusBeforeHold: null,
          }
        } else if (remaining.length >= 2) {
          nextCore = {
            ...prevCore,
            layoutType: 'gang',
            masterSetId: mid,
            mixSetMemberIds: remaining,
          }
        } else if (remaining.length === 1 && remaining[0] === li.id) {
          nextCore = {
            ...prevCore,
            layoutType: 'single',
            masterSetId: null,
            mixSetMemberIds: null,
            batchStatus: 'draft',
            batchHoldReason: null,
            batchStatusBeforeHold: null,
          }
        } else {
          continue
        }
      }

      const next = { ...spec, planningCore: nextCore } as Record<string, unknown>
      updateRow(li.id, { specOverrides: next })
      await onSaveLine(li.id, { specOverrides: next })
      changed += 1
    }

    if (changed > 0) {
      toast.success(`Group break applied • ${selectedIds.length} selected item${selectedIds.length > 1 ? 's' : ''}`)
    } else {
      toast.info('No grouped items were changed')
    }
  }

  return (
    <SlideOverPanel
      isOpen={isOpen}
      onClose={onClose}
      title="Group builder"
      backdropClassName="bg-ds-main/50 backdrop-blur-[1.5px]"
      panelClassName="border-l border-ds-line/80 bg-ds-card text-ds-ink shadow-2xl"
      zIndexClass="z-[60]"
      footer={
        <div className="space-y-2">
          {hasAnyMixed ? (
            <p className={`flex gap-1.5 text-xs leading-snug text-ds-warning ${mono}`}>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                Mixed configurations detected. This group may require mixed tooling and additional setup.
              </span>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void handleBreakGroupAsIs()}
            disabled={breakSelection.size === 0}
            className="w-full rounded-lg border border-rose-500/45 bg-rose-500/8 px-3 py-2 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-500/12 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/15 disabled:opacity-50"
          >
            Break group (as-is) for selected
          </button>
          <button
            type="button"
            onClick={async () => {
              const previous = lines.map((l) => l.id)
              await ensureBatchPackageTag()
              await applyDrawerLevelFieldsToBatch()
              onCreateBatch()
              toast.success('Group tagged as one package')
              toast.message('Applied to selected group', {
                action: {
                  label: 'Undo',
                  onClick: () => onRestoreSelection(previous),
                },
              })
            }}
            disabled={lines.length < 2}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-ds-warning px-3 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-ds-warning/90"
          >
            <Plus className="h-4 w-4" aria-hidden />
            {lines.length < 2 ? 'Create group (select 2+)' : 'Create group'}
          </button>
          <button
            type="button"
            onClick={() => void handleSendToArtwork()}
            disabled={sendingToArtwork}
            className="h-8 w-full rounded-lg bg-ds-brand px-3 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-ds-brand/90 disabled:opacity-60"
          >
            {sendingToArtwork ? 'Sending…' : 'Send to Artwork'}
          </button>
          <button
            type="button"
            onClick={() => void handleMakeProcessingBatch()}
            disabled={makingProcessing}
            className="h-8 w-full rounded-lg border border-ds-line bg-ds-elevated px-3 text-xs font-semibold text-ds-ink transition-colors hover:bg-ds-main disabled:opacity-60"
          >
            {makingProcessing ? 'Sending…' : 'Make Processing'}
          </button>
          <button
            type="button"
            onClick={() => {
              const previous = lines.map((l) => l.id)
              onClearSelection()
              toast.message('Selection cleared', {
                action: {
                  label: 'Undo',
                  onClick: () => onRestoreSelection(previous),
                },
              })
            }}
            className="h-8 w-full rounded-lg border border-input bg-background px-3 text-xs text-muted-foreground transition-colors hover:bg-accent/10"
          >
            Clear selection
          </button>
        </div>
      }
    >
      <div className="space-y-4 text-sm text-foreground" aria-label="Group builder">
        <div className="flex items-center gap-2 text-ds-warning">
          <Layers className="h-4 w-4 shrink-0" aria-hidden />
          <p className={`text-xs text-ds-ink-faint ${mono}`}>
            {lines.length} job(s) selected · total qty {totalQty.toLocaleString('en-IN')}
          </p>
        </div>

        <div className="rounded-md border border-ds-line/40 bg-ds-elevated/25 px-3 py-3 text-xs">
          <p className="text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">Compatibility</p>
          <p className={`mt-1 text-xs text-ds-ink-muted ${mono}`}>
            All parameters for the selected jobs — Match means a single value; Mixed means variation (advisory only).
          </p>
          <ul className="mt-2 space-y-1.5">
            {compatRows.map((r) => (
              <li
                key={r.key}
                className={`leading-snug ${r.mixed ? 'text-ds-warning' : 'text-ds-success'}`}
              >
                {r.text}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-md border border-ds-line/40 bg-ds-elevated/20 px-3 py-3">
          <label htmlFor="batch-designer" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">
            Designer assignment
          </label>
          <select
            id="batch-designer"
            className="h-10 w-full rounded-md border border-ds-line/50 bg-ds-elevated/40 px-3 text-sm leading-6 font-medium text-ds-ink outline-none transition focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30"
            value={designer}
            onChange={(e) => {
              void applyDesignerToBatch(e.target.value)
            }}
          >
            <option value="">Select designer…</option>
            <option value={PLANNING_DESIGNERS.avneet_singh}>{PLANNING_DESIGNERS.avneet_singh}</option>
            <option value={PLANNING_DESIGNERS.shamsher_inder}>{PLANNING_DESIGNERS.shamsher_inder}</option>
          </select>
          <p className={`mt-1 text-xs text-ds-ink-faint ${mono}`}>Designer is applied across all selected jobs.</p>
        </div>

        <div className="rounded-md border border-ds-line/40 bg-ds-elevated/20 px-3 py-3">
          <p className="mb-2 block text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">
            Drawer-level carry forward
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor="batch-sheet-length" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">
                Sheet length (mm)
              </label>
              <input
                id="batch-sheet-length"
                type="number"
                min={1}
                step={1}
                value={sheetLengthMm}
                onChange={(e) => setSheetLengthMm(e.target.value)}
                placeholder="e.g. 720"
                className="h-8 w-full rounded-md border border-ds-line/50 bg-ds-elevated/40 px-2.5 text-sm text-ds-ink outline-none transition focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30"
              />
            </div>
            <div>
              <label htmlFor="batch-sheet-width" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">
                Sheet width (mm)
              </label>
              <input
                id="batch-sheet-width"
                type="number"
                min={1}
                step={1}
                value={sheetWidthMm}
                onChange={(e) => setSheetWidthMm(e.target.value)}
                placeholder="e.g. 1020"
                className="h-8 w-full rounded-md border border-ds-line/50 bg-ds-elevated/40 px-2.5 text-sm text-ds-ink outline-none transition focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30"
              />
            </div>
          </div>
          <div className="mt-2">
            <label htmlFor="batch-special-remarks" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">
              Special remarks (carry forward)
            </label>
            <textarea
              id="batch-special-remarks"
              value={specialRemarks}
              onChange={(e) => setSpecialRemarks(e.target.value)}
              placeholder="Enter special manufacturing/planning remarks..."
              rows={3}
              className="w-full resize-y rounded-md border border-ds-line/50 bg-ds-elevated/40 px-2.5 py-2 text-sm text-ds-ink outline-none transition focus:border-ds-brand/60 focus:ring-1 focus:ring-ds-brand/30"
            />
          </div>
          <p className={`mt-1 text-xs text-ds-ink-faint ${mono}`}>
            Saved to selected lines on Create group / Send to Artwork / Make Processing.
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ds-ink-faint">Selected jobs</p>
          <ul className="max-h-[min(40vh,20rem)] space-y-2 overflow-y-auto overflow-x-hidden pr-0.5">
            {lines.map((r) => {
              const spec = (r.specOverrides || {}) as Record<string, unknown>
              const planCore = readPlanningCore(spec)
              const b = effectiveBatchStatus(planCore)
              const hasBatch = !!(planCore.masterSetId && planCore.mixSetMemberIds && planCore.mixSetMemberIds.length > 0)
              const meta = readPlanningMeta(spec)
              const rawUps = renderUpsField ? meta.ups : undefined
              const gangUpsStr =
                rawUps != null && Number(rawUps) >= 1 ? String(Math.floor(Number(rawUps))) : ''
              return (
                <li
                  key={r.id}
                  className="group flex items-start justify-between gap-2 rounded-md border border-ds-line/40 bg-background px-3 py-2"
                >
                  <label className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-ds-ink-muted">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-ds-brand"
                      checked={breakSelection.has(r.id)}
                      onChange={(e) => {
                        const checked = e.target.checked
                        setBreakSelection((prev) => {
                          const next = new Set(prev)
                          if (checked) next.add(r.id)
                          else next.delete(r.id)
                          return next
                        })
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                    Break
                  </label>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="truncate text-xs font-medium text-foreground" title={r.cartonName}>
                      {r.cartonName}
                    </p>
                    <p className={`truncate text-xs text-ds-ink-faint ${mono}`}>
                      {r.po.poNumber} · {r.quantity.toLocaleString('en-IN')} · {boardLabel(r)}
                    </p>
                    <div id={r.id === lines[0]?.id ? 'placement-ref' : undefined}>
                      <div id={r.id === lines[0]?.id ? 'fix-ups-render' : undefined}>
                      <label htmlFor={`ups-input-${r.id}`} id={r.id === lines[0]?.id ? 'label' : undefined} className="block text-xs font-medium text-ds-ink-muted">
                        Ups (per plate/output)
                      </label>
                      <div id={r.id === lines[0]?.id ? 'fix-ups-save' : undefined}>
                      <input
                        id={`ups-input-${r.id}`}
                        data-fix-ups-binding
                        type="number"
                        min={1}
                        step={1}
                        placeholder="Enter ups"
                        className={`ds-input mt-0.5 h-8 w-full max-w-[7rem] py-1.5 text-sm ${gangUpsStr ? 'border-ds-success/50 bg-ds-success/10' : ''}`}
                        value={gangUpsStr}
                        onChange={(e) => {
                          const v = e.target.value.trim()
                          if (v === '') {
                            const next = mergePlanningMetaUps(spec, null)
                            updateRow(r.id, { specOverrides: next })
                            return
                          }
                          const n = parseInt(v, 10)
                          if (!Number.isFinite(n) || n < 1) return
                          const next = mergePlanningMetaUps(spec, n)
                          updateRow(r.id, { specOverrides: next })
                        }}
                        onBlur={(e) => {
                          const v = e.target.value.trim()
                          const n = v === '' ? null : parseInt(v, 10)
                          const next =
                            Number.isFinite(n) && (n as number) >= 1
                              ? mergePlanningMetaUps(spec, n as number)
                              : mergePlanningMetaUps(spec, null)
                          updateRow(r.id, { specOverrides: next })
                          void onSaveLine(r.id, { specOverrides: next })
                        }}
                      />
                      </div>
                      <p id={r.id === lines[0]?.id ? 'helper' : undefined} className="text-xs text-ds-ink-faint">
                        No. of repeats of this product in one gang layout
                      </p>
                      </div>
                    </div>
                    {hasBatch ? (
                      <span
                        className={`mt-0.5 inline-block rounded border px-1 py-0.5 text-xs font-bold ${
                          BATCH_STATUS_BADGE_CLASS[b]
                        }`}
                      >
                        {BATCH_STATUS_LABEL[b]}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      const previous = lines.map((l) => l.id)
                      onRemoveFromSelection(r.id)
                      toast.message('Removed from selection', {
                        action: {
                          label: 'Undo',
                          onClick: () => onRestoreSelection(previous),
                        },
                      })
                    }}
                    className="shrink-0 rounded p-0.5 text-ds-ink-faint transition-colors hover:bg-accent/20 hover:text-rose-300"
                    title="Remove from selection"
                    aria-label="Remove from selection"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </SlideOverPanel>
  )
}
