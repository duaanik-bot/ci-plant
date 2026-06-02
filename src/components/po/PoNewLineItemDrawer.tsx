'use client'

import { useCallback, useRef } from 'react'
import { PastingStyle } from '@prisma/client'
import { COATING_TYPES, BOARD_GRADES, PRINTING_TYPES } from '@/lib/constants'
import { PackagingEnumCombobox } from '@/components/ui/PackagingEnumCombobox'
import { PoLinePastingStyleCell } from '@/components/po/PoLinePastingStyleCell'
import { CardSection } from '@/components/design-system/CardSection'
import { SummaryBlock } from '@/components/design-system/SummaryBlock'
import { Drawer } from '@/components/design-system/Drawer'
import { Button } from '@/components/design-system/Button'
import { useMaster } from '@/components/masters/MastersProvider'
import { MASTER } from '@/lib/masters/registry'
import { SpecPackPanel } from '@/components/spec-pack/SpecPackPanel'
import type { SpecPackV1 } from '@/lib/carton-spec-pack'
import type { EditableSpecField, SpecProvenance, SpecOverrides } from '@/lib/po-line-specpack'

type Line = {
  cartonId: string
  cartonName: string
  cartonSize: string
  quantity: string
  artworkCode: string
  backPrint: string
  wastagePct: string
  rate: string
  gstPct: string
  gsm: string
  coatingType: string
  embossingLeafing: string
  paperType: string
  boardGrade: string
  foilType: string
  printingType: string
  numberOfColours: string
  sheetSizeL: string
  sheetSizeW: string
  ups: string
  spotUv: string
  braille: string
  embossing: string
  leafing: string
  remarks: string
  dieMasterId: string
  toolingDieType: string
  toolingDims: string
  toolingUnlinked: boolean
  pastingStyle: string
  masterPastingStyleMissing: boolean
  ghostFromMaster: { size: boolean; gsm: boolean; pasting: boolean; rate: boolean }
  stockCarryForward?: {
    materialId: string
    materialCode: string
    description: string
    qtyFg: number
    unit: string
    estimatedBoxes: number
    boxNumber: string
    boxAgeDays: number | null
    approxValueInr: number
  } | null
  fgReservation?: {
    reservationKey: string
    materialId: string
    materialCode: string
    qtyReserved: number
    unit: string
    movementId: string
    reservedAt: string
  } | null
  useReservedFirst?: boolean
  specPackBase?: SpecPackV1 | null
  specPackLegacy?: boolean
  specOverrides?: SpecOverrides
  specProvenance?: Partial<Record<EditableSpecField, SpecProvenance>>
}

type PoNewLineItemDrawerProps = {
  isOpen: boolean
  onClose: () => void
  lineIndex: number
  line: Line | null
  updateLine: (idx: number, patch: Partial<Line>) => void
  updateLineField?: (idx: number, field: EditableSpecField, value: string) => void
  fieldErrors: Record<string, string>
  inputCls: string
  inputClsGhost: string
  inputErr: string
  poMono: string
  masterPasteSavingLine: number | null
  masterPastePopoverLine: number | null
  setMasterPastePopoverLine: (n: number | null) => void
  onSavePastingToMaster: (lineIndex: number, cartonId: string, style: PastingStyle) => void
  onReserveFg?: (lineIndex: number, qty: number) => Promise<void>
  onUnreserveFg?: (lineIndex: number) => Promise<void>
}

const SECTION_IDS = ['po-sec-material', 'po-sec-print', 'po-sec-cost'] as const

function computeLineMoney(quantity: string, rate: string, gstPct: string) {
  const q = Math.max(0, Number(quantity) || 0)
  const r = Math.max(0, Number(rate) || 0)
  const g = Math.max(0, Number(gstPct) || 0)
  const exGst = q * r
  const gstAmt = exGst * (g / 100)
  return {
    exGst,
    gstAmt,
    lineTotal: exGst + gstAmt,
  }
}

function computeChargeableQty(quantity: string, wastagePct: string) {
  const q = Math.max(0, Number(quantity) || 0)
  const w = Math.max(0, Number(wastagePct) || 0)
  if (q <= 0) return 0
  return q * (1 + w / 100)
}

const labelSec =
  'ds-typo-label mb-1.5 block font-semibold uppercase tracking-wider text-ds-ink-muted'
const labelKey = 'ds-typo-label mb-1.5 block text-sm font-semibold text-ds-ink'

const inputReadable = '[&::placeholder]:text-ds-ink-muted/90 [&::placeholder]:opacity-100 text-ds-ink'

const comboboxControl = 'bg-ds-elevated/50'
const comboboxInput = 'text-sm text-ds-ink'
const comboboxOptionReadable = 'text-sm'

function ProvBadge({ p }: { p?: SpecProvenance }) {
  if (!p) return null
  const label: Record<SpecProvenance, string> = {
    spec: 'Spec pack', master: 'Master', override: 'Overridden', user: 'Overridden',
    history: 'Last PO',
  }
  const tone =
    p === 'spec'
      ? 'bg-ds-success/10 text-ds-success'
      : p === 'master' || p === 'history'
        ? 'bg-ds-elevated/40 text-ds-ink-faint'
        : 'bg-ds-warning/10 text-ds-warning'
  return (
    <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}>
      {label[p]}
    </span>
  )
}

export function PoNewLineItemDrawer({
  isOpen,
  onClose,
  lineIndex,
  line,
  updateLine,
  updateLineField,
  fieldErrors,
  inputCls,
  inputClsGhost,
  inputErr,
  poMono,
  masterPasteSavingLine,
  masterPastePopoverLine,
  setMasterPastePopoverLine,
  onSavePastingToMaster,
  onReserveFg,
  onUnreserveFg,
}: PoNewLineItemDrawerProps) {
  // Sourced from the cached master registry. These dropdowns store the
  // human label (legacy PO/carton records store labels, not codes), so we
  // map registry options to labels and fall back to the static constants
  // when a category has no values yet.
  const boardTypeMaster = useMaster(MASTER.BOARD_TYPE)
  const coatingMaster = useMaster(MASTER.COATING)
  // Board Classification is folded into Board Type (legacy behaviour).
  const boardGradeOptions = boardTypeMaster.options.length
    ? boardTypeMaster.options.map((o) => o.label)
    : (BOARD_GRADES as unknown as string[])
  const coatingOptions = coatingMaster.options.length
    ? coatingMaster.options.map((o) => o.label)
    : (COATING_TYPES as unknown as string[])

  const editField =
    updateLineField ??
    ((idx: number, field: EditableSpecField, value: string) =>
      updateLine(idx, { [field]: value } as never))

  const panelRootRef = useRef<HTMLDivElement | null>(null)
  const reserveQtyRef = useRef<HTMLInputElement | null>(null)

  const moveFocus = useCallback(
    (dir: 'next' | 'prev' | 'sectionNext') => {
      const root = panelRootRef.current
      if (!root) return
      if (dir === 'sectionNext') {
        const active = document.activeElement as HTMLElement | null
        const sectionFromEl = (el: Element | null) => {
          if (!el) return -1
          const p = (el as HTMLElement).closest('section') as HTMLElement | null
          if (!p?.id) return -1
          return SECTION_IDS.indexOf(p.id as (typeof SECTION_IDS)[number])
        }
        const cur = sectionFromEl(active) >= 0 ? sectionFromEl(active) : 0
        const next = (cur + 1) % SECTION_IDS.length
        const first = document
          .getElementById(SECTION_IDS[next])
          ?.querySelector<HTMLElement>('input, select, textarea')
        first?.focus()
        return
      }
      const candidates = root.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
      )
      const list = Array.from(candidates).filter(
        (el) => (el.offsetParent !== null || el.getClientRects().length > 0) && el.tabIndex >= -1,
      )
      if (list.length === 0) return
      const active = document.activeElement as HTMLElement
      const idx = list.indexOf(active)
      if (idx < 0) {
        list[0]?.focus()
        return
      }
      if (dir === 'next') {
        if (idx < list.length - 1) list[idx + 1].focus()
        else list[0].focus()
      } else {
        if (idx > 0) list[idx - 1].focus()
        else list[list.length - 1].focus()
      }
    },
    [],
  )

  const onPanelKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!panelRootRef.current?.contains(e.target as Node)) return
      if (e.ctrlKey && (e.key === 'Enter' || e.code === 'Enter')) {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.ctrlKey && (e.key === 'ArrowRight' || e.key === 'Right')) {
        e.preventDefault()
        e.stopPropagation()
        moveFocus('sectionNext')
        return
      }
      if (e.key !== 'Enter' || (e.target as HTMLElement).tagName === 'TEXTAREA') return
      if ((e.target as HTMLElement).closest('[data-skip-po-enter-chain]')) return
      if (e.defaultPrevented) return
      if ((e.target as HTMLElement).getAttribute('type') === 'button') return
      e.preventDefault()
      moveFocus('next')
    },
    [moveFocus, onClose],
  )

  if (!isOpen) return null

  const money = line
    ? computeLineMoney(line.quantity, line.rate, line.gstPct)
    : { exGst: 0, gstAmt: 0, lineTotal: 0 }
  const chQty = line ? computeChargeableQty(line.quantity, line.wastagePct) : 0

  return (
    <Drawer
      title={line ? `Engineering specs · Line ${lineIndex + 1}` : 'Engineering specs'}
      isOpen={isOpen}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div
        ref={panelRootRef}
        onKeyDown={onPanelKeyDown}
        tabIndex={-1}
        className="space-y-6 text-sm"
        data-po-line-drawer
        role="dialog"
        aria-modal="true"
        aria-label="Line item details"
      >
        {line == null ? (
          <p className="text-sm text-ds-ink-faint">No line selected.</p>
        ) : (
          <>
            <CardSection id="po-sec-material" title="Material Specs">
              {line.stockCarryForward ? (
                <div className="rounded bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300 sm:col-span-3">
                  FG stock available: {line.stockCarryForward.qtyFg.toLocaleString('en-IN')} {line.stockCarryForward.unit}
                  {' · '}Box {line.stockCarryForward.boxNumber}
                  {' · '}Age {line.stockCarryForward.boxAgeDays ?? '—'} days
                  {line.fgReservation ? (
                    <span>
                      {' · '}Reserved {line.fgReservation.qtyReserved.toLocaleString('en-IN')} {line.fgReservation.unit}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {line.stockCarryForward ? (
                <div className="rounded bg-ds-elevated/30 px-3 py-2 sm:col-span-3">
                  <p className="mb-2 text-xs uppercase tracking-wide text-ds-warning">Reserve from FG stock</p>
                  <p className="mb-2 text-xs text-ds-ink-faint">
                    Fresh demand after reserve:{' '}
                    <span className="text-ds-ink">
                      {Math.max(
                        0,
                        (Number(line.quantity) || 0) - (line.fgReservation?.qtyReserved ?? 0),
                      ).toLocaleString('en-IN')}
                    </span>
                  </p>
                  {line.fgReservation ? (
                    <div className="flex flex-wrap items-end gap-2">
                      <p className="text-xs text-emerald-300">
                        Reserved {line.fgReservation.qtyReserved.toLocaleString('en-IN')} {line.fgReservation.unit} from{' '}
                        {line.fgReservation.materialCode} · {new Date(line.fgReservation.reservedAt).toLocaleString()}
                      </p>
                      {onUnreserveFg ? (
                        <Button type="button" variant="secondary" onClick={() => void onUnreserveFg(lineIndex)}>
                          Unreserve
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="block text-xs text-ds-ink-faint">
                        Reserve qty
                        <input
                          ref={reserveQtyRef}
                          type="number"
                          min={1}
                          max={Math.max(1, line.stockCarryForward.qtyFg)}
                          className={`mt-1 w-28 ${inputCls}`}
                          placeholder="Qty"
                        />
                      </label>
                      {onReserveFg ? (
                        <Button
                          type="button"
                          onClick={async () => {
                            const raw = reserveQtyRef.current?.value ?? ''
                            const qty = Number(raw)
                            await onReserveFg(lineIndex, qty)
                          }}
                        >
                          Reserve from FG
                        </Button>
                      ) : null}
                    </div>
                  )}
                  <label className="mt-2 flex items-center gap-2 text-xs text-ds-ink-faint">
                    <input
                      type="checkbox"
                      checked={line.useReservedFirst !== false}
                      onChange={(e) => updateLine(lineIndex, { useReservedFirst: e.target.checked })}
                      className="rounded"
                    />
                    Use reserved stock first during planning/job-card generation
                  </label>
                </div>
              ) : null}
              {line.cartonId && !line.specPackBase ? (
                <div className="rounded border border-ds-line/50 bg-ds-elevated/30 px-3 py-2 text-xs text-ds-ink-muted sm:col-span-3">
                  Warehouse verification pending
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className={labelSec}>Board grade<ProvBadge p={line.specProvenance?.boardGrade} /></label>
                  <div data-skip-po-enter-chain>
                    <PackagingEnumCombobox
                      aria-label="Board grade"
                      options={boardGradeOptions}
                      value={line.boardGrade || null}
                      onChange={(v) => editField(lineIndex, 'boardGrade', v ?? '')}
                      controlClassName={comboboxControl}
                      inputClassName={comboboxInput}
                      optionClassName={comboboxOptionReadable}
                      className="w-full"
                    />
                  </div>
                </div>
                <div>
                  <label className={labelSec}>GSM<ProvBadge p={line.specProvenance?.gsm} /></label>
                  <input
                    type="number"
                    value={line.gsm}
                    onChange={(e) => {
                      if (line.ghostFromMaster.gsm) {
                        updateLine(lineIndex, {
                          ghostFromMaster: { ...line.ghostFromMaster, gsm: false },
                        })
                      }
                      editField(lineIndex, 'gsm', e.target.value)
                    }}
                    className={`w-full ${
                      line.ghostFromMaster.gsm ? inputClsGhost : inputCls
                    } ${poMono} ${inputReadable}`}
                  />
                </div>
                <div>
                  <label className={labelSec}>Printing type<ProvBadge p={line.specProvenance?.printingType} /></label>
                  <div data-skip-po-enter-chain>
                    <PackagingEnumCombobox
                      aria-label="Printing type"
                      options={PRINTING_TYPES as unknown as string[]}
                      value={line.printingType || null}
                      onChange={(v) => editField(lineIndex, 'printingType', v ?? '')}
                      controlClassName={comboboxControl}
                      inputClassName={comboboxInput}
                      optionClassName={comboboxOptionReadable}
                      className="w-full"
                    />
                  </div>
                </div>
                <div>
                  <label className={labelSec}>Coating spec<ProvBadge p={line.specProvenance?.coatingType} /></label>
                  <div data-skip-po-enter-chain>
                    <PackagingEnumCombobox
                      aria-label="Coating"
                      options={coatingOptions}
                      value={line.coatingType || null}
                      onChange={(v) => editField(lineIndex, 'coatingType', v ?? '')}
                      controlClassName={comboboxControl}
                      inputClassName={comboboxInput}
                      optionClassName={comboboxOptionReadable}
                      className="w-full"
                    />
                  </div>
                </div>
                <div>
                  <label className={labelSec}>Colours<ProvBadge p={line.specProvenance?.numberOfColours} /></label>
                  <input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={line.numberOfColours}
                    placeholder="e.g. 4"
                    onChange={(e) => editField(lineIndex, 'numberOfColours', e.target.value)}
                    className={`w-full ${inputCls} ${poMono} ${inputReadable}`}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className={labelSec}>Sheet size (L × W mm)</label>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      min={1}
                      inputMode="numeric"
                      value={line.sheetSizeL}
                      placeholder="Length"
                      onChange={(e) => editField(lineIndex, 'sheetSizeL', e.target.value)}
                      className={`w-full ${inputCls} ${poMono} ${inputReadable}`}
                    />
                    <input
                      type="number"
                      min={1}
                      inputMode="numeric"
                      value={line.sheetSizeW}
                      placeholder="Width"
                      onChange={(e) => editField(lineIndex, 'sheetSizeW', e.target.value)}
                      className={`w-full ${inputCls} ${poMono} ${inputReadable}`}
                    />
                  </div>
                </div>
                <div>
                  <label className={labelSec}>UPS<ProvBadge p={line.specProvenance?.ups} /></label>
                  <input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    value={line.ups}
                    placeholder="e.g. 6"
                    onChange={(e) => editField(lineIndex, 'ups', e.target.value)}
                    className={`w-full ${inputCls} ${poMono} ${inputReadable}`}
                  />
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-ds-ink-muted">
                {([
                  ['embossing', 'Embossing'],
                  ['leafing', 'Leafing'],
                  ['spotUv', 'Spot UV'],
                  ['braille', 'Braille'],
                ] as const).map(([field, label]) => (
                  <label key={field} className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={line[field] === 'Yes'}
                      onChange={(e) => editField(lineIndex, field, e.target.checked ? 'Yes' : 'No')}
                      className="rounded"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </CardSection>

            <CardSection id="po-sec-locked" title="General Specs">
              {line.specPackBase ? (
                <SpecPackPanel specPack={line.specPackBase} specOverrides={line.specOverrides ?? null} />
              ) : line.specPackLegacy ? (
                <SpecPackPanel specPack={null} specOverrides={null} />
              ) : (
                <p className="text-xs text-ds-ink-faint">Loading spec…</p>
              )}
            </CardSection>

            <CardSection id="po-sec-print" title="Finishing Specs">
              <div data-skip-po-enter-chain className="space-y-1.5">
                <label className={labelSec}>Pasting style<ProvBadge p={line.specProvenance?.pastingStyle} /></label>
                <PoLinePastingStyleCell
                  lineIndex={lineIndex}
                  cartonId={line.cartonId}
                  pastingStyle={line.pastingStyle}
                  masterPastingStyleMissing={line.masterPastingStyleMissing}
                  ghostFromMaster={line.ghostFromMaster.pasting}
                  pasteErr={fieldErrors[`line${lineIndex}_pasting`]}
                  inputCls={inputCls}
                  inputErr={inputErr}
                  savingToMaster={masterPasteSavingLine === lineIndex}
                  popoverOpenForLine={masterPastePopoverLine}
                  setPopoverOpenForLine={setMasterPastePopoverLine}
                  onPastingSelectChange={(value) => {
                    if (line.ghostFromMaster.pasting) {
                      updateLine(lineIndex, {
                        ghostFromMaster: { ...line.ghostFromMaster, pasting: false },
                      })
                    }
                    editField(lineIndex, 'pastingStyle', value)
                  }}
                  onSaveToMaster={(style) => onSavePastingToMaster(lineIndex, line.cartonId, style)}
                />
              </div>
            </CardSection>

            <CardSection id="po-sec-cost" title="Warehouse Specs" className="space-y-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelKey}>Quantity</label>
                  <input
                    type="number"
                    min={1}
                    value={line.quantity}
                    onChange={(e) => updateLine(lineIndex, { quantity: e.target.value })}
                    className={`w-full !text-base !font-semibold tabular-nums !text-ds-ink ${inputCls} ${poMono} ${inputReadable}`}
                  />
                </div>
                <div>
                  <label className={labelKey}>
                    Rate <span className="text-xs font-normal text-ds-ink-faint">(per unit, ex-GST)</span>
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={line.rate}
                    onChange={(e) =>
                      updateLine(lineIndex, {
                        rate: e.target.value,
                        ghostFromMaster: { ...line.ghostFromMaster, rate: false },
                      })
                    }
                    className={`w-full !text-base !font-semibold tabular-nums ${
                      line.ghostFromMaster.rate ? `${inputClsGhost} !text-ds-ink-muted` : `${inputCls} !text-ds-ink`
                    } ${poMono} ${inputReadable} ${fieldErrors[`line${lineIndex}_rate`] ? inputErr : ''}`}
                    title={line.ghostFromMaster.rate ? 'From Product Master — edit to override' : undefined}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelSec}>Wastage %</label>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={line.wastagePct}
                    onChange={(e) => updateLine(lineIndex, { wastagePct: e.target.value })}
                    className={`w-full text-sm text-ds-ink-muted ${inputCls} ${poMono} ${inputReadable}`}
                  />
                  {chQty > 0 && (Number(line.wastagePct) || 0) > 0 ? (
                    <p className="mt-1.5 text-xs text-ds-ink-faint">
                      Chargeable qty (incl. waste):{' '}
                      <span className={`${poMono} text-ds-ink-muted`}>
                        {chQty.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                      </span>
                    </p>
                  ) : null}
                </div>
                <div>
                  <label className={labelSec}>GST %</label>
                  <input
                    type="number"
                    min={0}
                    max={28}
                    value={line.gstPct}
                    onChange={(e) => updateLine(lineIndex, { gstPct: e.target.value })}
                    className={`w-full text-sm text-ds-ink-muted ${inputCls} ${poMono} ${inputReadable}`}
                  />
                </div>
              </div>

              <div
                className={`space-y-1 rounded-ds-md bg-ds-elevated/30 p-4 ${poMono}`}
              >
                <SummaryBlock
                  label="Line amount (ex-GST)"
                  value={`₹ ${money.exGst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}
                />
                <SummaryBlock
                  className="!border-t-0 !pt-0"
                  label="GST"
                  value={`₹ ${money.gstAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}
                />
                <div className="pt-3">
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:items-end sm:justify-between">
                    <span className="text-sm font-medium text-ds-ink-muted">Line total (incl. GST)</span>
                    <span className="text-2xl font-bold tabular-nums tracking-tight text-ds-success">
                      ₹ {money.lineTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              </div>

              <div className="rounded-ds-md border border-ds-line/40 bg-ds-card/60 p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ds-ink-faint">
                  Audit Trail
                </div>
                <div className="grid gap-2 text-xs text-ds-ink-muted sm:grid-cols-2">
                  <span>Carton selected: current operator · {new Date().toLocaleString()}</span>
                  <span>Rate source: {line.ghostFromMaster.rate ? 'Master' : 'Manual Entry'}</span>
                  <span>Board/GSM source: {line.specProvenance?.boardGrade ?? 'Master'}</span>
                  <span>Warehouse override: {line.specOverrides ? 'Line override' : 'None'}</span>
                </div>
              </div>

              <div className="space-y-3 pt-4">
                <p className={labelSec}>Additional (optional)</p>
                <div>
                  <label className={labelSec}>Back print<ProvBadge p={line.specProvenance?.backPrint} /></label>
                  <select
                    value={line.backPrint}
                    onChange={(e) => editField(lineIndex, 'backPrint', e.target.value)}
                    className={`w-full text-sm text-ds-ink-muted ${inputCls} ${inputReadable}`}
                  >
                    <option value="No">No</option>
                    <option value="Yes">Yes</option>
                  </select>
                </div>
                <div>
                  <label className={labelSec}>Artwork code<ProvBadge p={line.specProvenance?.artworkCode} /></label>
                  <input
                    type="text"
                    value={line.artworkCode}
                    onChange={(e) => editField(lineIndex, 'artworkCode', e.target.value)}
                    className={`w-full font-mono text-xs text-ds-ink-muted ${inputCls} ${inputReadable}`}
                  />
                </div>
                <div>
                  <label className={labelSec}>Line remarks</label>
                  <textarea
                    rows={3}
                    value={line.remarks}
                    onChange={(e) => updateLine(lineIndex, { remarks: e.target.value })}
                    className={`w-full min-h-[5rem] resize-y text-sm text-ds-ink ${inputCls} ${inputReadable}`}
                  />
                </div>
              </div>
            </CardSection>
          </>
        )}
      </div>
    </Drawer>
  )
}
