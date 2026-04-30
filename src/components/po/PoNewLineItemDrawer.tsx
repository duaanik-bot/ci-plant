'use client'

import { useCallback, useEffect, useRef } from 'react'
import { PastingStyle } from '@prisma/client'
import { COATING_TYPES, EMBOSSING_TYPES, FOIL_TYPES, PAPER_TYPES, BOARD_GRADES } from '@/lib/constants'
import { PackagingEnumCombobox } from '@/components/ui/PackagingEnumCombobox'
import { PoLinePastingStyleCell } from '@/components/po/PoLinePastingStyleCell'
import { CardSection } from '@/components/design-system/CardSection'
import { SummaryBlock } from '@/components/design-system/SummaryBlock'
import { Drawer } from '@/components/design-system/Drawer'
import { Button } from '@/components/design-system/Button'

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
}

type PoNewLineItemDrawerProps = {
  isOpen: boolean
  onClose: () => void
  lineIndex: number
  line: Line | null
  updateLine: (idx: number, patch: Partial<Line>) => void
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

const comboboxControl = 'border-ds-line/80 bg-ds-elevated/50'
const comboboxInput = 'text-sm text-ds-ink'
const comboboxOptionReadable = 'text-sm'

export function PoNewLineItemDrawer({
  isOpen,
  onClose,
  lineIndex,
  line,
  updateLine,
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

  useEffect(() => {
    if (!isOpen) return
    const t = window.setTimeout(() => {
      const first = document.getElementById('po-sec-material')?.querySelector<HTMLInputElement>('input, select')
      first?.focus()
    }, 10)
    return () => clearTimeout(t)
  }, [isOpen, lineIndex])

  if (!isOpen) return null

  const money = line
    ? computeLineMoney(line.quantity, line.rate, line.gstPct)
    : { exGst: 0, gstAmt: 0, lineTotal: 0 }
  const chQty = line ? computeChargeableQty(line.quantity, line.wastagePct) : 0

  return (
    <Drawer
      title={line ? `Line ${lineIndex + 1} — ${line.cartonName.trim() || 'New line'}` : 'Line item'}
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
            <CardSection id="po-sec-material" title="Material">
              {line.stockCarryForward ? (
                <div className="rounded border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300 sm:col-span-3">
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
                <div className="rounded border border-ds-line/50 bg-ds-elevated/30 px-3 py-2 sm:col-span-3">
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
                      className="rounded border-ds-line/60"
                    />
                    Use reserved stock first during planning/job-card generation
                  </label>
                </div>
              ) : null}
              <div>
                <label className={labelSec}>Board</label>
                <div data-skip-po-enter-chain>
                  <PackagingEnumCombobox
                    aria-label="Board grade"
                    options={BOARD_GRADES}
                    value={line.boardGrade || null}
                    onChange={(v) => updateLine(lineIndex, { boardGrade: v ?? '' })}
                    controlClassName={comboboxControl}
                    inputClassName={comboboxInput}
                    optionClassName={comboboxOptionReadable}
                    className="w-full"
                  />
                </div>
              </div>
              <div>
                <label className={labelSec}>GSM</label>
                <input
                  type="number"
                  value={line.gsm}
                  onChange={(e) =>
                    updateLine(lineIndex, {
                      gsm: e.target.value,
                      ghostFromMaster: { ...line.ghostFromMaster, gsm: false },
                    })
                  }
                  className={`w-full ${
                    line.ghostFromMaster.gsm ? inputClsGhost : inputCls
                  } ${poMono} ${inputReadable}`}
                />
              </div>
              <div>
                <label className={labelSec}>Paper</label>
                <div data-skip-po-enter-chain>
                  <PackagingEnumCombobox
                    aria-label="Paper / board type"
                    options={PAPER_TYPES}
                    value={line.paperType || null}
                    onChange={(v) => updateLine(lineIndex, { paperType: v ?? '' })}
                    controlClassName={comboboxControl}
                    inputClassName={comboboxInput}
                    optionClassName={comboboxOptionReadable}
                    className="w-full"
                  />
                </div>
              </div>
            </CardSection>

            <CardSection id="po-sec-print" title="Printing">
              <div>
                <label className={labelSec}>Coating</label>
                <div data-skip-po-enter-chain>
                  <PackagingEnumCombobox
                    aria-label="Coating"
                    options={COATING_TYPES}
                    value={line.coatingType || null}
                    onChange={(v) => updateLine(lineIndex, { coatingType: v ?? '' })}
                    controlClassName={comboboxControl}
                    inputClassName={comboboxInput}
                    optionClassName={comboboxOptionReadable}
                    className="w-full"
                  />
                </div>
              </div>
              <div>
                <label className={labelSec}>Emboss / leafing</label>
                <div data-skip-po-enter-chain>
                  <PackagingEnumCombobox
                    aria-label="Embossing and leafing"
                    options={EMBOSSING_TYPES}
                    value={line.embossingLeafing || null}
                    onChange={(v) => updateLine(lineIndex, { embossingLeafing: v ?? '' })}
                    controlClassName={comboboxControl}
                    inputClassName={comboboxInput}
                    optionClassName={comboboxOptionReadable}
                    className="w-full"
                  />
                </div>
              </div>
              <div>
                <label className={labelSec}>Foil</label>
                <div data-skip-po-enter-chain>
                  <PackagingEnumCombobox
                    aria-label="Foil"
                    options={FOIL_TYPES}
                    value={line.foilType || null}
                    onChange={(v) => updateLine(lineIndex, { foilType: v ?? '' })}
                    controlClassName={comboboxControl}
                    inputClassName={comboboxInput}
                    className="w-full"
                  />
                </div>
              </div>
              <div data-skip-po-enter-chain className="space-y-1.5">
                <label className={labelSec}>Pasting</label>
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
                  onPastingSelectChange={(value) =>
                    updateLine(lineIndex, {
                      pastingStyle: value,
                      ghostFromMaster: { ...line.ghostFromMaster, pasting: false },
                    })
                  }
                  onSaveToMaster={(style) => onSavePastingToMaster(lineIndex, line.cartonId, style)}
                />
              </div>
            </CardSection>

            <CardSection id="po-sec-cost" title="Costing" className="space-y-6">
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
                className={`space-y-1 rounded-ds-md border border-ds-line/60 bg-ds-elevated/30 p-4 ${poMono}`}
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
                <div className="border-t border-ds-line/60 pt-3">
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:items-end sm:justify-between">
                    <span className="text-sm font-medium text-ds-ink-muted">Line total (incl. GST)</span>
                    <span className="text-2xl font-bold tabular-nums tracking-tight text-ds-success">
                      ₹ {money.lineTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-3 border-t border-ds-line/50 pt-4">
                <p className={labelSec}>Additional (optional)</p>
                <div>
                  <label className={labelSec}>Back print</label>
                  <select
                    value={line.backPrint}
                    onChange={(e) => updateLine(lineIndex, { backPrint: e.target.value })}
                    className={`w-full text-sm text-ds-ink-muted ${inputCls} ${inputReadable}`}
                  >
                    <option value="No">No</option>
                    <option value="Yes">Yes</option>
                  </select>
                </div>
                <div>
                  <label className={labelSec}>Artwork code</label>
                  <input
                    type="text"
                    value={line.artworkCode}
                    onChange={(e) => updateLine(lineIndex, { artworkCode: e.target.value })}
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
