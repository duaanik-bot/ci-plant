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
import { mergePlanningMetaUps, readPlanningMeta } from '@/lib/planning-decision-spec'
import { PackagingEnumCombobox } from '@/components/ui/PackagingEnumCombobox'
import { PlanningGridLine, type PlanningLineFieldPatch } from '@/components/planning/PlanningDecisionGrid'
import { StandardDrawer } from '@/components/design-system/StandardDrawer'
import { CardSection } from '@/components/design-system/CardSection'
import { Button } from '@/components/design-system/Button'
import { Badge } from '@/components/design-system/Badge'

type Props = {
  line: (PlanningGridLine & {
    directorPriority?: boolean
    directorHold?: boolean
    materialQueue?: { boardType?: string | null; sheetLengthMm?: unknown; sheetWidthMm?: unknown } | null
  }) | null
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

function toPositiveIntString(value: unknown): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  return String(Math.floor(n))
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
  const [sheetLengthMm, setSheetLengthMm] = useState('')
  const [sheetWidthMm, setSheetWidthMm] = useState('')

  useEffect(() => {
    if (!line) {
      setRemarksDraft('')
      return
    }
    setRemarksDraft(line.remarks ?? '')
    setSplitOpen(false)
    setSplitA('')
    const spec = (line.specOverrides || {}) as Record<string, unknown>
    setSheetLengthMm(
      toPositiveIntString(spec.sheetLengthMm) ||
        toPositiveIntString(line.materialQueue?.sheetLengthMm) ||
        toPositiveIntString(line.carton?.blankLength),
    )
    setSheetWidthMm(
      toPositiveIntString(spec.sheetWidthMm) ||
        toPositiveIntString(line.materialQueue?.sheetWidthMm) ||
        toPositiveIntString(line.carton?.blankWidth),
    )
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
    toast.info('Line added to selection. Select more lines, then click Open Group Builder.', { duration: 4000 })
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
      const meta = readPlanningMeta(spec)
      const ups =
        typeof meta.ups === 'number' && Number.isFinite(meta.ups) && meta.ups >= 1
          ? Math.floor(meta.ups)
          : null
      const numberOfColours =
        typeof spec.numberOfColours === 'number' && Number.isFinite(spec.numberOfColours)
          ? Math.floor(spec.numberOfColours)
          : line.carton?.numberOfColours ?? null
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
          blankLength: sheetLengthMm.trim() ? Number(sheetLengthMm.trim()) : undefined,
          blankWidth: sheetWidthMm.trim() ? Number(sheetWidthMm.trim()) : undefined,
          numberOfColours: numberOfColours ?? undefined,
          specialInstructions: JSON.stringify({
            notes: '',
            brailleEnabled: false,
            leafingEnabled: false,
            embossingEnabled: false,
            spotUvEnabled: false,
            ups,
          }),
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
  }, [line, sheetLengthMm, sheetWidthMm])

  if (!line || !open) return null

  const spec = (line.specOverrides || {}) as Record<string, unknown>
  const renderUpsField = true
  const meta = readPlanningMeta(spec)
  const gangUpsStr =
    renderUpsField && meta.ups != null && Number(meta.ups) >= 1
      ? String(Math.floor(Number(meta.ups)))
      : ''
  const boardInput = String(spec.boardGrade || line.materialQueue?.boardType || '').trim()
  const amount = (line.quantity || 0) * (line.rate != null ? Number(line.rate) : 0)

  const totalQty = line.quantity
  const splitB = typeof splitA === 'number' && splitA > 0 && splitA < totalQty ? totalQty - splitA : null

  const fieldInput = 'ds-input mt-0.5 w-full text-sm py-2 [color-scheme:dark]'
  const comboControl = 'border-ds-line/80 bg-ds-elevated/50'
  const comboInput = 'text-sm text-ds-ink'

  return (
    <StandardDrawer
      isOpen={open}
      onClose={onClose}
      title={<span className="truncate text-ds-ink" title={line.cartonName}>{line.cartonName}</span>}
      metadata={
        <div className="space-y-2">
          <p className="text-[12px] text-ds-ink-faint">
            {line.po.poNumber} · {line.planningStatus} · {line.po.customer.name}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {line.po.isPriority ? (
              <Badge
                tone="warning"
                className={`inline-flex items-center gap-0.5 ${INDUSTRIAL_PRIORITY_STAR_ICON_CLASS}`}
              >
                <Star className="h-3 w-3 fill-current" aria-hidden />
                PO
              </Badge>
            ) : null}
            {line.directorPriority ? (
              <Badge tone="brand" className="text-[10px]">
                Line priority
              </Badge>
            ) : null}
            {line.directorHold ? (
              <Badge tone="warning" className="text-[10px]">
                On hold
              </Badge>
            ) : null}
            {line.cartonId && onViewProductDetail ? (
              <button
                type="button"
                onClick={onViewProductDetail}
                className="text-[10px] font-medium text-ds-brand underline-offset-2 transition duration-200 hover:underline"
              >
                Product sheet
              </button>
            ) : null}
          </div>
        </div>
      }
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
      primaryAction={{
        label: 'Save',
        loadingLabel: 'Saving…',
        onClick: () => {
          void handleSave()
        },
        disabled: saving,
        loading: saving,
      }}
    >
      <div className="space-y-5 text-sm text-ds-ink" aria-label="Job detail">
        <CardSection title="Material" id="plan-drawer-material">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="ds-typo-label">Size</p>
              <input
                className={`${fieldInput} ${mono}`}
                value={line.cartonSize ?? ''}
                onChange={(e) => updateRow(line.id, { cartonSize: e.target.value || null })}
                onBlur={(e) => void onSaveLine(line.id, { cartonSize: e.target.value.trim() || null })}
              />
            </div>
            <div>
              <p className="ds-typo-label">Qty</p>
              <input
                type="number"
                min={1}
                className={`${fieldInput} ${mono} font-semibold text-ds-ink tabular-nums`}
                value={line.quantity}
                onChange={(e) => {
                  const n = Math.max(1, parseInt(e.target.value, 10) || 1)
                  updateRow(line.id, { quantity: n })
                }}
                onBlur={() => void onSaveLine(line.id, { quantity: line.quantity })}
              />
            </div>
          </div>
          <label className="mt-1 block">
            <span className="ds-typo-label">Board</span>
            <input
              className={fieldInput + ' ' + mono}
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
            <p className="ds-typo-label">GSM</p>
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
            <p className="ds-typo-label">Paper</p>
            <PackagingEnumCombobox
              aria-label="Paper"
              options={MASTER_BOARD_GRADES}
              value={line.paperType ?? line.carton?.paperType ?? null}
              onChange={(v) => {
                updateRow(line.id, { paperType: v })
                void onSaveLine(line.id, { paperType: v })
              }}
              className="w-full"
              controlClassName={comboControl}
              inputClassName={comboInput}
            />
          </div>
        </CardSection>

        <CardSection title="Printing" id="plan-drawer-printing">
          <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
            <div>
              <p className="ds-typo-label">Coating</p>
              <PackagingEnumCombobox
                aria-label="Coating"
                options={MASTER_COATINGS_AND_VARNISHES}
                value={line.coatingType ?? line.carton?.coatingType ?? null}
                onChange={(v) => {
                  updateRow(line.id, { coatingType: v })
                  void onSaveLine(line.id, { coatingType: v })
                }}
                className="w-full"
                controlClassName={comboControl}
                inputClassName={comboInput}
              />
            </div>
            <div>
              <p className="ds-typo-label">Emboss / leafing</p>
              <PackagingEnumCombobox
                aria-label="Embossing"
                options={MASTER_EMBOSSING_AND_LEAFING}
                value={line.embossingLeafing}
                onChange={(v) => {
                  updateRow(line.id, { embossingLeafing: v })
                  void onSaveLine(line.id, { embossingLeafing: v })
                }}
                className="w-full"
                controlClassName={comboControl}
                inputClassName={comboInput}
              />
            </div>
            <div>
              <p className="ds-typo-label">Laminate</p>
              <PackagingEnumCombobox
                aria-label="Laminate"
                options={MASTER_COATINGS_AND_VARNISHES}
                value={line.otherCoating ?? line.carton?.laminateType ?? null}
                onChange={(v) => {
                  updateRow(line.id, { otherCoating: v })
                  void onSaveLine(line.id, { otherCoating: v })
                }}
                className="w-full"
                controlClassName={comboControl}
                inputClassName={comboInput}
              />
            </div>
            <label className="block">
              <span className="ds-typo-label">Foil</span>
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
            <label className="block">
              <span className="ds-typo-label">Pasting</span>
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
          </div>
        </CardSection>

        <CardSection title="Gang print" id="plan-drawer-gang-ups">
          <div id="placement-ref">
            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="single-sheet-length" className="block text-[12px] font-medium text-ds-ink-muted">
                  Sheet length (mm)
                </label>
                <input
                  id="single-sheet-length"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="e.g. 720"
                  className={fieldInput}
                  value={sheetLengthMm}
                  onChange={(e) => setSheetLengthMm(e.target.value)}
                  onBlur={(e) => {
                    const specNow = (line.specOverrides || {}) as Record<string, unknown>
                    const value = e.target.value.trim()
                    const parsed = value === '' ? null : parseInt(value, 10)
                    const next = { ...specNow } as Record<string, unknown>
                    if (Number.isFinite(parsed) && (parsed as number) > 0) {
                      next.sheetLengthMm = parsed as number
                      setSheetLengthMm(String(parsed))
                    } else {
                      delete next.sheetLengthMm
                      setSheetLengthMm('')
                    }
                    updateRow(line.id, { specOverrides: next })
                    void onSaveLine(line.id, { specOverrides: next })
                  }}
                />
              </div>
              <div>
                <label htmlFor="single-sheet-width" className="block text-[12px] font-medium text-ds-ink-muted">
                  Sheet width (mm)
                </label>
                <input
                  id="single-sheet-width"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="e.g. 1020"
                  className={fieldInput}
                  value={sheetWidthMm}
                  onChange={(e) => setSheetWidthMm(e.target.value)}
                  onBlur={(e) => {
                    const specNow = (line.specOverrides || {}) as Record<string, unknown>
                    const value = e.target.value.trim()
                    const parsed = value === '' ? null : parseInt(value, 10)
                    const next = { ...specNow } as Record<string, unknown>
                    if (Number.isFinite(parsed) && (parsed as number) > 0) {
                      next.sheetWidthMm = parsed as number
                      setSheetWidthMm(String(parsed))
                    } else {
                      delete next.sheetWidthMm
                      setSheetWidthMm('')
                    }
                    updateRow(line.id, { specOverrides: next })
                    void onSaveLine(line.id, { specOverrides: next })
                  }}
                />
              </div>
            </div>
            <div id="fix-ups-render" className="space-y-1.5">
            <label htmlFor="ups-input" id="label" className="block text-[12px] font-medium text-ds-ink-muted">
              Ups (per plate/output)
            </label>
            <div id="fix-ups-save">
              <input
                id="ups-input"
                data-fix-ups-binding
                type="number"
                min={1}
                step={1}
                placeholder="Enter ups"
                className={`${fieldInput} max-w-[8rem] ${gangUpsStr ? 'border-ds-success/50 bg-ds-success/10' : ''}`}
                value={gangUpsStr}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  if (v === '') {
                    const next = mergePlanningMetaUps(spec, null)
                    updateRow(line.id, { specOverrides: next })
                    return
                  }
                  const n = parseInt(v, 10)
                  if (!Number.isFinite(n) || n < 1) return
                  const next = mergePlanningMetaUps(spec, n)
                  updateRow(line.id, { specOverrides: next })
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  const n = v === '' ? null : parseInt(v, 10)
                  const next =
                    Number.isFinite(n) && (n as number) >= 1
                      ? mergePlanningMetaUps(spec, n as number)
                      : mergePlanningMetaUps(spec, null)
                  updateRow(line.id, { specOverrides: next })
                  void onSaveLine(line.id, { specOverrides: next })
                }}
              />
            </div>
            <p id="helper" className="text-[11px] text-ds-ink-faint">
              No. of repeats of this product in one gang layout
            </p>
            </div>
          </div>
        </CardSection>

        <CardSection title="Costing" id="plan-drawer-costing" className="border-ds-success/25 bg-ds-elevated/40">
          <div className="space-y-4">
            <div>
              <p className="ds-typo-label">Rate (per unit, ex-GST)</p>
              <input
                type="number"
                min={0}
                step="0.01"
                className={`${fieldInput} ${mono} text-ds-ink-muted`}
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
            <div className="rounded-ds-md border border-ds-success/30 bg-ds-success/5 p-4 md:p-5">
              <p className="text-[12px] font-medium text-ds-ink-muted">Line amount (ex-GST)</p>
              <p className="mt-2 text-2xl font-bold leading-tight text-ds-success tabular-nums md:text-[26px]">
                ₹ {amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
            {line.cartonId ? (
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={saveMasterBusy}
                onClick={() => void saveToProductMaster()}
              >
                {saveMasterBusy ? 'Saving to master…' : 'Save to product master'}
              </Button>
            ) : null}
            <div>
              <Button type="button" variant="ghost" className="h-auto px-0 py-1 text-xs" onClick={() => setSplitOpen((o) => !o)}>
                {splitOpen ? 'Hide split' : 'Split (intent)'}
              </Button>
              {splitOpen ? (
                <div className="mt-2 space-y-2 rounded-ds-md border border-ds-line/60 bg-ds-elevated/30 p-3">
                  <p className="text-[10px] leading-snug text-ds-ink-faint">Notional split — coordinate with Accounts for PO changes.</p>
                  <label className="ds-typo-label block">First job qty</label>
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
                    className="ds-input w-full text-sm"
                  />
                  {splitB != null ? (
                    <p className={`text-xs text-ds-ink-muted ${mono}`}>
                      Second: <span className="font-medium text-ds-ink">{splitB}</span>
                    </p>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full text-xs"
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
                  >
                    Confirm split intent
                  </Button>
                </div>
              ) : null}
            </div>
            <div>
              <p className="ds-typo-label">Remarks</p>
              <textarea
                value={remarksDraft}
                onChange={(e) => setRemarksDraft(e.target.value)}
                rows={3}
                className="ds-input min-h-[5rem] w-full resize-y text-sm"
                placeholder="Internal notes"
              />
            </div>
          </div>
        </CardSection>

        <div className="space-y-2 border-t border-ds-line/50 pt-6">
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={actionBusy}
            onClick={handleAddToBatch}
          >
            <Layers className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Add to group
          </Button>
          <Button type="button" variant="secondary" className="w-full" disabled={actionBusy} onClick={handleHold}>
            <PauseCircle className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {line.directorHold ? 'Release hold' : 'Hold'}
          </Button>
          <Button type="button" variant="secondary" className="w-full" disabled={actionBusy} onClick={handlePriority}>
            <Star className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {line.directorPriority ? 'Clear priority' : 'Priority'}
          </Button>
        </div>
      </div>
    </StandardDrawer>
  )
}
